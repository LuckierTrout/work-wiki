import { NextRequest, NextResponse } from "next/server";
import { readLedger, type LedgerEntry } from "@/lib/ingest";
import { getPrincipal } from "@/lib/auth";
import {
  deleteWikiPage,
  listReadableWikiPages,
  readWikiPageWithFrontmatter,
} from "@/lib/wiki";
import { canWriteFrontmatter } from "@/lib/authz";
import { resolveWriteDenial } from "@/lib/write-denial";
import {
  deleteIngestJob,
  getIngestJob,
  type IngestJob,
} from "@/lib/ingest-jobs";
import { getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { isReadOnly } from "@/lib/config";
import { READ_ONLY_REFUSAL, isReadOnlyError } from "@/lib/read-only";

const MAX_BULK_DELETE = 50;

/**
 * The one sentence this route answers for "that is not a selection you can
 * make" — a missing ledger entry, an entry with no `primary_slug`, an entry
 * whose page is outside `listReadableWikiPages`, a job that does not exist, a
 * job that is not yours, and (since DW-270) a job whose page you may not read.
 *
 * ONE CONSTANT BECAUSE ALL OF THEM MUST BE INDISTINGUISHABLE. The read gate's
 * whole job is to make an unreadable page look like an unselectable one;
 * hand-typed literals could drift a word apart and turn the refusal back into
 * the existence oracle it exists to prevent. Deliberately vague about WHY a
 * selection failed — naming the reason would answer the question the cloak is
 * refusing.
 *
 * PER-ENTRY SINCE DW-393, NOT A WHOLE-BATCH 404. Each of these reasons is
 * recorded against the offending id in the response's `failed[]` array and the
 * rest of the batch still deletes; the handler answers 200 because the batch
 * EVALUATION succeeded, which is the same shape the route already used when
 * `deleteWikiPage` threw for one slug. An all-or-nothing 404 let a single
 * orphan page — on disk but absent from the page index — make its ledger row
 * permanently undeletable AND veto every other selected item.
 *
 * ECHOING THE ID BACK IS NOT A LEAK. The id in `failed[]` is one the CALLER
 * just submitted, so it tells them nothing they did not already have.
 * Distinguishing WHY it failed is the leak, and that is what this single
 * sentence prevents.
 *
 * THE OTHER TWO REFUSALS STAY WHOLE-BATCH. The delete-ACL 403 (which may name a
 * readable page's realm) and the queued/processing 409 are stable, actionable
 * refusals about items the caller can SEE and deselect, and both already fire
 * before any mutation — so atomicity costs them nothing. Only the not-found
 * family, which is exactly the family a caller cannot act on, became per-entry.
 */
const SELECTION_NOT_FOUND = "One or more selected ingests were not found.";

function parseIdList(
  value: unknown,
  field: "ingestIds" | "jobIds",
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of ids`);
  }
  if (value.length > MAX_BULK_DELETE) {
    throw new Error(`no more than ${MAX_BULK_DELETE} items can be deleted at once`);
  }

  const maxLength = field === "jobIds" ? 64 : 512;
  const ids = value.map((id) => {
    if (typeof id !== "string" || id.trim() === "" || id.length > maxLength) {
      throw new Error(`${field} contains an invalid id`);
    }
    if (field === "jobIds" && !/^[a-zA-Z0-9-]+$/.test(id)) {
      throw new Error(`${field} contains an invalid id`);
    }
    return id;
  });
  return [...new Set(ids)];
}

/**
 * GET /api/ingest/history?limit=50
 *
 * Recent ingest ledger entries, most recent first — SCOPED to pages the caller
 * can read. The ledger is one GLOBAL append-only JSONL with no owner field, so
 * without this filter any signed-in viewer would see every user's ingest source
 * URLs + resulting slugs, including private-vault ingests. We drop entries whose
 * resulting page the caller can't read: commons provenance is already public on
 * the page itself, and private pages are hidden from non-owners. (A stricter
 * "my ingests only" view would persist an owner on each ledger entry — a larger
 * change; readability-scoping closes the leak without a ledger migration.)
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await getPrincipal();
    if (!principal) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const limitParam = searchParams.get("limit");
    const limit = limitParam ? parseInt(limitParam, 10) : undefined;

    if (limit !== undefined && (isNaN(limit) || limit < 1)) {
      return NextResponse.json(
        { error: "limit must be a positive integer" },
        { status: 400 },
      );
    }

    // Only surface entries whose resulting page the caller can read (O(1) page
    // index + in-memory canReadEntry). Drops other users' private-page ingests.
    const readable = new Set(
      (await listReadableWikiPages(principal)).map((p) => p.slug),
    );
    const entries = (await readLedger())
      .filter((e) => e.primary_slug && readable.has(e.primary_slug))
      .slice(0, limit ?? 50);

    // The deployment fact, carried on the answer the surface already asks for
    // (DW-265). `/ingest` is a `"use client"` page all the way down, so
    // `isReadOnly()` — which reads `process.env` — cannot be evaluated where
    // `RecentIngests` renders, and no prop can reach it from a server component.
    // Riding along on the GET the list already makes is the same seam
    // `/api/workspace-profile` gives `WorkspacePurposeSettings`: no extra
    // request, and the fact arrives from the very route whose DELETE would
    // refuse.
    return NextResponse.json({ entries, readOnly: isReadOnly() });
  } catch (error) {
    logger.error("ingest", "Ingest history GET error", error);
    return NextResponse.json(
      { error: getErrorMessage(error) },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/ingest/history
 *
 * Bulk-remove completed ingests selected in the owner UI. Completed ledger
 * entries delete their generated primary wiki page through the full lifecycle
 * cleanup (indexes, backlinks, embeddings, vault references, revisions, and
 * discussions). Terminal async/email jobs are also cleared; if a completed job
 * has a slug, its page is deleted through the same lifecycle.
 *
 * Raw source snapshots and the append-only ingest ledger are intentionally
 * retained for provenance and recovery. Once a page is gone, GET no longer
 * returns its ledger entries because the readability filter excludes it.
 */
export async function DELETE(request: NextRequest) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Deployment read-only (DW-187), answered BEFORE any mutation — and this is
  // the one door where the kernel's own refusal arrives too late to be correct.
  // `deleteWikiPage` failures are swallowed per-slug into `failed` below and the
  // handler still returns 200, and `deleteIngestJob` is NOT a kernel writer, so
  // a kernel-only refusal would clear every selected ingest job and answer 200
  // with a `failed` list. An early refusal is what keeps the batch atomic.
  if (isReadOnly()) {
    return NextResponse.json(
      { error: READ_ONLY_REFUSAL.bulkPageDelete },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { error: "request body must be an object" },
      { status: 400 },
    );
  }

  let ingestIds: string[];
  let jobIds: string[];
  try {
    const record = body as Record<string, unknown>;
    ingestIds = parseIdList(record.ingestIds, "ingestIds");
    jobIds = parseIdList(record.jobIds, "jobIds");
    if (ingestIds.length + jobIds.length === 0) {
      throw new Error("select at least one completed ingest");
    }
    if (ingestIds.length + jobIds.length > MAX_BULK_DELETE) {
      throw new Error(`no more than ${MAX_BULK_DELETE} items can be deleted at once`);
    }
  } catch (error) {
    return NextResponse.json(
      { error: getErrorMessage(error) },
      { status: 400 },
    );
  }

  try {
    // Preflight the full batch before mutating anything: every job must be
    // theirs + terminal, and every existing page must pass the normal per-page
    // delete ACL. A selection the caller cannot make at all is DROPPED from the
    // batch here (DW-393) and reported against its own id in `failed[]` below,
    // so one unselectable item no longer vetoes the ones beside it.
    const ledger = await readLedger();
    const readable = new Set(
      (await listReadableWikiPages(principal)).map((page) => page.slug),
    );
    const ledgerById = new Map(ledger.map((entry) => [entry.ingest_id, entry]));
    const refusedIngestIds = new Set<string>();
    const selectedEntries: LedgerEntry[] = [];
    for (const id of ingestIds) {
      const entry = ledgerById.get(id);
      if (!entry || !entry.primary_slug || !readable.has(entry.primary_slug)) {
        // Absent, slugless, or outside the page index (the orphan case) — one
        // sentence for all three, and its slug never reaches `slugs`, so
        // nothing is read, deleted, or attributed for it.
        refusedIngestIds.add(id);
        continue;
      }
      selectedEntries.push(entry);
    }

    const refusedJobIds = new Set<string>();
    const selectedJobs: IngestJob[] = [];
    for (const jobId of jobIds) {
      const job = await getIngestJob(jobId);
      if (!job || job.owner !== principal.handle) {
        refusedJobIds.add(jobId);
        continue;
      }
      // STILL WHOLE-BATCH. A queued or processing job is a selection the caller
      // can see and deselect, and clearing its record would not cancel the work
      // — so the batch is refused outright rather than half-applied.
      if (job.status !== "done" && job.status !== "failed") {
        return NextResponse.json(
          { error: "Queued or processing ingests cannot be deleted." },
          { status: 409 },
        );
      }
      selectedJobs.push(job);
    }

    const slugs = new Set<string>();
    for (const entry of selectedEntries) slugs.add(entry.primary_slug);
    for (const job of selectedJobs) {
      if (job.status === "done" && job.slug) slugs.add(job.slug);
    }

    // Hoisted above the ACL loop (DW-393) because the read gate now RECORDS a
    // per-slug failure here instead of returning. Everything downstream —
    // `removedSlugs`, `deletedIngestIds`, the delete-loop skip and the
    // per-entry attribution — already reads this map, so the gate needs no new
    // machinery to keep an unreadable page out of every one of them.
    const failedSlugs = new Map<string, string>();
    const existingSlugs = new Set<string>();
    for (const slug of slugs) {
      const page = await readWikiPageWithFrontmatter(slug);
      if (!page) continue; // Already gone: clear its terminal UI record below.
      // THE READ CLOAK, and it lands HERE for two reasons (DW-270).
      //
      // WHY IT WAS NEEDED. `ingestIds` were already safe: the preflight above
      // refuses any entry whose page is outside `listReadableWikiPages`.
      // `jobIds` were not — the only gate they pass is
      // `job.owner !== principal.handle`,
      // a check on the JOB record, so a caller who owned a job whose page they
      // may not read reached the ACL below holding that page. This route was
      // the one deny site in the app that could describe a page the caller was
      // never allowed to learn existed.
      //
      // WHY IN THIS LOOP RATHER THAN IN THE `jobIds` PREFLIGHT. The loop
      // already reads each page, so the check costs nothing and covers BOTH
      // selection paths in one place — "everything that reaches the delete ACL
      // is readable" is now true for either way a slug got here. And it sits
      // AFTER `if (!page) continue`, which preserves the already-gone cleanup
      // that only the `jobIds` path exercises: a done job whose page has since
      // been deleted is not readable, and a flat gate up in the preflight would
      // refuse exactly those records instead of clearing them.
      //
      // The sentence is `SELECTION_NOT_FOUND`, the same constant both preflights
      // use — an unreadable page must look like an unselectable one, not like
      // a permission the caller lacks. Since DW-393 it is RECORDED against this
      // slug rather than returned: the job holding it lands in `failed[]` with
      // that one sentence, its page is never deleted, its job record is never
      // cleared, and the rest of the batch proceeds.
      //
      // WHAT THIS ORDERING KNOWINGLY LEAVES BEHIND. Because the gate sits after
      // `if (!page) continue`, a `jobIds` selection whose page EXISTS but is
      // unreadable lands in `failed[]`, while one whose page is already GONE is
      // cleared — so a caller who owns the job can still tell those two apart.
      // That is a deliberate trade, not an oversight: the only way to close it
      // is to gate before the cleanup branch, which would refuse every
      // already-gone record instead of clearing it and break the one repair
      // this route exists to perform. The residue is narrow — it leaks "a page
      // still exists at this slug" to someone who already holds a job record
      // naming that slug, and nothing about the page's owner, realm or
      // contents.
      if (!readable.has(slug)) {
        failedSlugs.set(slug, SELECTION_NOT_FOUND);
        continue;
      }
      if (!canWriteFrontmatter(page.frontmatter, principal, "delete")) {
        // Read-cloaked above, so the resolver may name this page's realm: a
        // readable page that the delete ACL still refuses is a realm page, and
        // the resolver re-derives that from the frontmatter rather than
        // inheriting it from this comment.
        return NextResponse.json(
          {
            error: resolveWriteDenial("bulkDelete", page.frontmatter, "delete"),
          },
          { status: 403 },
        );
      }
      existingSlugs.add(slug);
    }

    const deletedPageSlugs: string[] = [];
    for (const slug of slugs) {
      if (!existingSlugs.has(slug)) continue;
      try {
        await deleteWikiPage(slug, principal.handle);
        deletedPageSlugs.push(slug);
      } catch (error) {
        const message = getErrorMessage(error);
        failedSlugs.set(slug, message);
        logger.error("ingest", `Bulk ingest delete failed for ${slug}`, error);
      }
    }

    const removedSlugs = new Set(
      [...slugs].filter((slug) => !failedSlugs.has(slug)),
    );
    // Return every ledger id for a successfully removed page, not just the ids
    // submitted. Multiple dedup ingests can point at the same canonical page;
    // the UI must remove all now-stale rows for that slug.
    //
    // MINUS THE ONES WE REFUSED (DW-393). `removedSlugs` is `slugs` less the
    // FAILED ones, and a slug whose page was already gone never enters
    // `failedSlugs` — so if a JOB in the same batch contributes a slug that a
    // refused `ingestIds` entry also names, that refused id would otherwise be
    // reported as deleted AND as failed in the same answer. Only the ids the
    // caller submitted and we refused are subtracted, so the "other ledger rows
    // for the same slug" sweep above survives intact.
    const deletedIngestIds = ledger
      .filter((entry) => removedSlugs.has(entry.primary_slug))
      .map((entry) => entry.ingest_id)
      .filter((id) => !refusedIngestIds.has(id));

    // `failed[]` is walked in SUBMISSION order — every `ingestIds` entry, then
    // every `jobIds` entry — over the ids the caller actually sent, so a
    // refused id (dropped from `selectedEntries`/`selectedJobs` in the
    // preflight) still gets its own row rather than vanishing from the answer.
    const entriesByIngestId = new Map(
      selectedEntries.map((entry) => [entry.ingest_id, entry]),
    );
    const jobsById = new Map(selectedJobs.map((job) => [job.jobId, job]));

    const deletedJobIds: string[] = [];
    const failed: { id: string; kind: "ingest" | "job"; error: string }[] = [];
    for (const id of ingestIds) {
      if (refusedIngestIds.has(id)) {
        failed.push({ id, kind: "ingest", error: SELECTION_NOT_FOUND });
        continue;
      }
      const entry = entriesByIngestId.get(id);
      if (!entry) continue;
      const failure = failedSlugs.get(entry.primary_slug);
      if (failure) failed.push({ id, kind: "ingest", error: failure });
    }
    for (const jobId of jobIds) {
      if (refusedJobIds.has(jobId)) {
        failed.push({ id: jobId, kind: "job", error: SELECTION_NOT_FOUND });
        continue;
      }
      const job = jobsById.get(jobId);
      if (!job) continue;
      // Covers both a `deleteWikiPage` throw and the read gate above: either
      // way the page is still there, so the job record that points at it must
      // stay too.
      const failure = job.slug ? failedSlugs.get(job.slug) : undefined;
      if (failure) {
        failed.push({ id: jobId, kind: "job", error: failure });
        continue;
      }
      try {
        await deleteIngestJob(jobId, principal.handle);
        deletedJobIds.push(jobId);
      } catch (error) {
        const message = getErrorMessage(error);
        failed.push({ id: jobId, kind: "job", error: message });
        logger.error("ingest", `Bulk ingest job delete failed for ${jobId}`, error);
      }
    }

    return NextResponse.json({
      deletedIngestIds,
      deletedJobIds,
      deletedPageSlugs,
      failed,
      rawSourcesRetained: true,
    });
  } catch (error) {
    // The flag can only have flipped mid-request to reach here, but the answer
    // still belongs at 403 rather than 500 — the outer catch is the only thing
    // standing between the kernel's refusal and a server-error page.
    if (isReadOnlyError(error)) {
      return NextResponse.json(
        { error: getErrorMessage(error) },
        { status: 403 },
      );
    }
    logger.error("ingest", "Bulk ingest delete failed", error);
    return NextResponse.json(
      { error: getErrorMessage(error) },
      { status: 500 },
    );
  }
}
