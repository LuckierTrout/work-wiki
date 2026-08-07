import { NextRequest, NextResponse } from "next/server";
import { readLedger } from "@/lib/ingest";
import { getPrincipal } from "@/lib/auth";
import {
  deleteWikiPage,
  listReadableWikiPages,
  readWikiPageWithFrontmatter,
} from "@/lib/wiki";
import { canWriteFrontmatter } from "@/lib/authz";
import {
  deleteIngestJob,
  getIngestJob,
  type IngestJob,
} from "@/lib/ingest-jobs";
import { getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";

const MAX_BULK_DELETE = 50;

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

    return NextResponse.json({ entries });
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
    // Preflight the full batch before mutating anything: every ledger entry must
    // be visible to the caller, every job must be theirs + terminal, and every
    // existing page must pass the normal per-page delete ACL.
    const ledger = await readLedger();
    const readable = new Set(
      (await listReadableWikiPages(principal)).map((page) => page.slug),
    );
    const ledgerById = new Map(ledger.map((entry) => [entry.ingest_id, entry]));
    const selectedEntries = ingestIds.map((id) => ledgerById.get(id));
    if (
      selectedEntries.some(
        (entry) => !entry || !entry.primary_slug || !readable.has(entry.primary_slug),
      )
    ) {
      return NextResponse.json(
        { error: "One or more selected ingests were not found." },
        { status: 404 },
      );
    }

    const selectedJobs: IngestJob[] = [];
    for (const jobId of jobIds) {
      const job = await getIngestJob(jobId);
      if (!job || job.owner !== principal.handle) {
        return NextResponse.json(
          { error: "One or more selected ingests were not found." },
          { status: 404 },
        );
      }
      if (job.status !== "done" && job.status !== "failed") {
        return NextResponse.json(
          { error: "Queued or processing ingests cannot be deleted." },
          { status: 409 },
        );
      }
      selectedJobs.push(job);
    }

    const slugs = new Set<string>();
    for (const entry of selectedEntries) slugs.add(entry!.primary_slug);
    for (const job of selectedJobs) {
      if (job.status === "done" && job.slug) slugs.add(job.slug);
    }

    const existingSlugs = new Set<string>();
    for (const slug of slugs) {
      const page = await readWikiPageWithFrontmatter(slug);
      if (!page) continue; // Already gone: clear its terminal UI record below.
      if (!canWriteFrontmatter(page.frontmatter, principal, "delete")) {
        return NextResponse.json(
          { error: "You don't have permission to delete one or more selected pages." },
          { status: 403 },
        );
      }
      existingSlugs.add(slug);
    }

    const deletedPageSlugs: string[] = [];
    const failedSlugs = new Map<string, string>();
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
    const deletedIngestIds = ledger
      .filter((entry) => removedSlugs.has(entry.primary_slug))
      .map((entry) => entry.ingest_id);

    const deletedJobIds: string[] = [];
    const failed: { id: string; kind: "ingest" | "job"; error: string }[] = [];
    for (const entry of selectedEntries) {
      const failure = failedSlugs.get(entry!.primary_slug);
      if (failure) failed.push({ id: entry!.ingest_id, kind: "ingest", error: failure });
    }
    for (const job of selectedJobs) {
      const failure = job.slug ? failedSlugs.get(job.slug) : undefined;
      if (failure) {
        failed.push({ id: job.jobId, kind: "job", error: failure });
        continue;
      }
      try {
        await deleteIngestJob(job.jobId, principal.handle);
        deletedJobIds.push(job.jobId);
      } catch (error) {
        const message = getErrorMessage(error);
        failed.push({ id: job.jobId, kind: "job", error: message });
        logger.error("ingest", `Bulk ingest job delete failed for ${job.jobId}`, error);
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
    logger.error("ingest", "Bulk ingest delete failed", error);
    return NextResponse.json(
      { error: getErrorMessage(error) },
      { status: 500 },
    );
  }
}
