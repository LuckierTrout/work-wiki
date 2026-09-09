import { ownerTenantHandle } from "@/lib/owner";
import { NextRequest, NextResponse } from "next/server";
import { readLedger, type LedgerEntry } from "@/lib/ingest";
import { getPrincipal } from "@/lib/auth";
import {
  deleteWikiPage,
  listWikiPages,
  readWikiPageWithFrontmatter,
} from "@/lib/wiki";
import {
  canReadEntry,
  canReadFrontmatter,
  canWriteFrontmatter,
  type Reader,
} from "@/lib/authz";
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

/**
 * Cap on the ids one `DELETE` batch accepts — and the value
 * `MAX_ORPHAN_PROBES` below borrows for the per-request probe budget. It bounds
 * two things, so changing it moves both; if they ever need to differ, give the
 * probe budget its own literal here rather than re-typing 50 at one of the two
 * use sites.
 *
 * SINCE DW-704 THE TWO BOUNDS ARE RELATED, not merely equal. `DELETE` probes
 * on the same budget it caps its batch with, and that is exactly why the budget
 * cannot bite there: `parseIdList` caps each field at this number and the
 * handler also refuses `ingestIds.length + jobIds.length > MAX_BULK_DELETE`, so
 * one batch names at most 50 ids and therefore at most 50 DISTINCT slugs, while
 * the prober memoizes per slug. They are still SEPARABLE — the listing's budget
 * bounds work per request, not per selection, and nothing forces the two
 * numbers to move together — which is why the budget is threaded through
 * `DELETE` anyway: if they ever diverge, it fails closed rather than probing
 * without a bound.
 */
const MAX_BULK_DELETE = 50;

/**
 * How many index-missing slugs ONE REQUEST will probe on disk (DW-432 for
 * `GET`; DW-704 extended the same ladder, and this same budget, to `DELETE`).
 * Aliased rather than re-stated: the human decision names
 * `MAX_BULK_DELETE` as the cap, so that stays the single source of the VALUE,
 * while the probe budget gets to read as its own concept at its use sites — a
 * bound on how much DISK WORK one request may do, which is a different question
 * from how many ids a batch may name even now that `DELETE` is subject to
 * both.
 *
 * NOT EXPORTED, and not by choice: a Next.js route module may export only the
 * HTTP handlers and the framework's own config names, so `export`ing this is a
 * type error against the generated route types. The suite therefore restates
 * the number behind this same name — the identical arrangement, and the
 * identical reason, as `SELECTION_NOT_FOUND` below. The copy is self-policing:
 * lowering the budget here without touching the suite turns its read-count
 * assertions red rather than letting them agree with a number that moved.
 */
const MAX_ORPHAN_PROBES = MAX_BULK_DELETE;

/**
 * The one sentence this route answers for "that is not a selection you can
 * make" — a missing ledger entry, an entry with no `primary_slug`, an entry
 * whose slug the selection ladder does not admit (since DW-704 that is the same
 * ladder `GET` lists by, not the page index alone), a job that does not exist,
 * a job that is not yours, and (since DW-270) a job whose page you may not
 * read.
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

/** The bytes one probe read, when it read any. */
type ProbedPage = NonNullable<
  Awaited<ReturnType<typeof readWikiPageWithFrontmatter>>
>;

/** What one orphan probe learned about one slug. */
interface ProbeResult {
  /** True only when a page exists at this slug AND the caller may read it. */
  readable: boolean;
  /**
   * True ONLY when the read definitively answered "nothing is stored here" —
   * a `null` page, no throw. Distinct from `!readable`, which also covers a
   * page that exists and is hidden, and from `failed`, which covers a read that
   * could not answer at all. `DELETE` needs the distinction: an absent page is
   * the already-gone record it exists to CLEAN UP, while a hidden or
   * unanswerable one must be refused. Fails closed in both other directions.
   */
  absent: boolean;
  /**
   * True when the read THREW, as distinct from answering "no page here" or
   * "not readable by you". Reported out rather than logged in place so the walk
   * can emit exactly ONE warn per request: a systemic storage fault makes every
   * probe throw, and `MAX_ORPHAN_PROBES` identical lines buries the first one
   * instead of reporting it.
   */
  failed: boolean;
  /** The thrown value, carried out for that one warn. */
  error?: unknown;
  /**
   * The page the probe read — carried out ONLY when `readable`, so no caller
   * can end up holding bytes the gate just hid.
   *
   * `DELETE` re-uses these bytes for its delete ACL instead of reading again
   * (DW-704). The second read would be UNHINTED, and a silo-only orphan — the
   * case the probe's `owner` hint exists for — answers `null` to it; the ACL
   * loop reads that `null` as "already gone, clear the record", so the owner
   * would be told the row was deleted while `GET` kept listing it. Carrying the
   * page removes both the wrong answer and the extra read.
   */
  page: ProbedPage | null;
}

/**
 * Probes ONE slug the page index does not know at all — the bottom rung of
 * {@link createOrphanProber}'s ladder, which `GET` (DW-432) and `DELETE`
 * (DW-704) both run. The predicate is stated once, here, by delegating to
 * `canReadFrontmatter` — the exact per-page counterpart of the `canReadEntry`
 * the index path applies (both call `canReadPage`) — so re-deriving it by hand
 * is what would let the two answers drift apart.
 *
 * WHAT THIS PROVES, EXACTLY. "A page exists at this slug that this caller may
 * read." That is SLUG-scoped, not provenance-scoped: it does NOT prove the page
 * read is the page this ledger row produced. Nothing is lost by that, because
 * it is the same question the index path has always answered — the ledger
 * carries no owner field, so this route has only ever scoped by slug — and the
 * fallback neither widens nor narrows the question. It only stops the answer
 * from depending on whether the index happens to still know the slug.
 *
 * WHAT THIS KNOWINGLY LEAVES BEHIND. `owner` makes the resolution
 * CALLER-RELATIVE, and slug scope plus caller-relative resolution has a
 * residue: a caller holding their OWN crash-left silo file at slug `s` — with
 * `s` absent from the page index AND from the flat path — surfaces ANOTHER
 * user's ledger row for `s`, meaning its `source_url`, timestamps and ids,
 * though never that other user's bytes, which this hint cannot reach. That is a
 * deliberate trade, not an oversight. `ReadWikiPageOptions.owner`
 * (`src/lib/wiki.ts:392-398`) is documented for precisely this crash-recovery
 * use and can never displace another owner's committed same-slug Page, so the
 * residue exists only in the window where NO committed Page owns the slug at
 * all; and closing it would mean persisting an owner on every ledger entry —
 * the migration this route's GET doc comment already scopes out as the larger
 * change it is not making.
 *
 * THE SAME HINT COSTS SOMETHING TOO. Being caller-relative, it is not a
 * privilege: an ADMIN does not see another owner's silo-only orphan here, even
 * though `canReadPage` would admit them to the page itself, because the hint
 * only ever opens the ADMIN's own silo. The fallback under-reports for admins
 * rather than over-reporting to them.
 *
 * READ MODE MATCHES THE INDEX'S OWN AUTHORITATIVE READ. `listWikiPages`
 * re-reads every dirty slug with `{ fresh: true, strict: true }` and, when that
 * read throws or returns null, forces `visibility: "private"` — "missing/
 * unreadable authoritative bytes are not permission to expose a stale public
 * row". A plain cached read can SUCCEED where that hardening failed, because
 * `pageCache` is module-global and ref-counted across bulk scans; probing that
 * way would list a row the index deliberately hid. So the probe reads exactly
 * as the index does.
 *
 * FAILS CLOSED BOTH WAYS: a missing page (`null`) and a throwing read both
 * answer `readable: false`, the same direction `listWikiPages` takes.
 *
 * @see canReadSlug (`src/lib/authz.ts:145`) — near-identical body, deliberately
 * NOT reused. Its missing-page polarity is the opposite of what is needed here:
 * it returns `true` for an absent page so the caller's own 404 may speak, while
 * an absent page here must HIDE the row. And it passes no owner hint, so it
 * cannot see the crash-left silo that is this fallback's whole reason to exist.
 */
async function readableOnDisk(
  slug: string,
  // Non-null, and true for BOTH callers: `GET` 401s long before its walk and
  // `DELETE` 401s before its preflight, so by the time either reaches the
  // prober's bottom rung the hint is always available. Typed that way so a
  // future caller passing `null` is a compile error rather than a silent probe
  // that quietly loses the silo branch.
  principal: NonNullable<Reader>,
): Promise<ProbeResult> {
  try {
    const page = await readWikiPageWithFrontmatter(slug, {
      fresh: true,
      strict: true,
      owner: ownerTenantHandle(principal),
    });
    const readable = page
      ? canReadFrontmatter(page.frontmatter, principal)
      : false;
    return {
      readable,
      absent: page === null,
      failed: false,
      // Only ever the bytes the caller may read.
      page: readable ? page : null,
    };
  } catch (error) {
    // A read that could not answer is NOT "absent": treating it as such would
    // let a storage blip clear a ledger row whose page is still on disk.
    return { readable: false, absent: false, failed: true, error, page: null };
  }
}

/** One slug's answer from the three-step ladder below. */
interface SelectionVerdict {
  /** May this caller select/list this slug at all? */
  readable: boolean;
  /**
   * True when rung 2 refused: the page INDEX knows this slug and has already
   * answered "not for you", so no probe ran and none may.
   *
   * `DELETE` needs it named because the index's claim that a page exists here
   * is the one claim this ladder never verifies, and the already-gone cleanup
   * below turns on whether a page is really there. See its use site.
   */
  hidden: boolean;
  /** See {@link ProbeResult.absent} — definitively nothing stored here. */
  absent: boolean;
  /** The probed bytes, when the DISK FALLBACK is what admitted the slug. */
  page: ProbedPage | null;
}

/**
 * The per-request ladder BOTH handlers run, with one memo and one budget
 * (DW-432 built it for `GET`; DW-704 made it shared).
 *
 * THE LADDER, IN THIS ORDER AND NO OTHER:
 *   1. in `readable` → admitted, no read at all;
 *   2. in `indexed` but not `readable` → refused with NO DISK READ. The index
 *      already answered "hidden" for this slug, and no disk read may overturn
 *      that: `listWikiPages` forces `visibility: private` on a dirty slug whose
 *      authoritative read failed, on purpose. Probing this rung would also
 *      spend a read on every indexed page the caller may not read — the busiest
 *      multi-user path — and starve the budget for the orphans it is for;
 *   3. otherwise (the index does not know this slug AT ALL) → one
 *      {@link readableOnDisk} probe.
 *
 * ONE MEMO AND ONE BUDGET PER REQUEST, shared across every gate that asks.
 * BOTH verdicts are memoized — a slug two ledger rows share, or that `DELETE`'s
 * preflight and its ACL loop both ask about, costs exactly ONE read whether the
 * answer was yes or no. An exhausted budget FAILS CLOSED: the slug is neither
 * admitted nor called absent, so `GET` hides the row and `DELETE` refuses it.
 *
 * Extracted rather than copied because copying is how the two answers drift:
 * before DW-704, `DELETE` gated on the index-backed `readable` set alone, so an
 * owner could see a row in the listing whose delete always answered "not
 * found".
 */
function createOrphanProber(
  indexed: Set<string>,
  readable: Set<string>,
  principal: NonNullable<Reader>,
  // Which door built this prober. Both handlers emit the same budget warn now,
  // and an operator reading it in isolation could not otherwise tell a listing
  // that hid rows from a batch that refused selections.
  door: "GET" | "DELETE",
) {
  const probed = new Map<string, ProbeResult>();
  let budget = MAX_ORPHAN_PROBES;
  // Both counted so this request can say ONE thing about each: the first
  // storage fault, and the drift the budget could not cover. Silence on the
  // second is what makes a deployment whose budget is spent on every request
  // — the very drift this fallback exists to surface — look identical to one
  // with no orphans at all.
  let faultReported = false;
  let unprobed = 0;

  return {
    async verdict(slug: string): Promise<SelectionVerdict> {
      if (readable.has(slug))
        return { readable: true, hidden: false, absent: false, page: null };
      if (indexed.has(slug))
        return { readable: false, hidden: true, absent: false, page: null };
      let probe = probed.get(slug);
      if (probe === undefined) {
        if (budget <= 0) {
          unprobed += 1;
          return { readable: false, hidden: false, absent: false, page: null };
        }
        budget -= 1;
        probe = await readableOnDisk(slug, principal);
        if (probe.failed && !faultReported) {
          // Once per request, not once per slug: a storage fault fails every
          // probe, and MAX_ORPHAN_PROBES copies of this line would bury it.
          faultReported = true;
          logger.warn(
            "ingest",
            `orphan probe failed for "${slug}"; hiding it (further probe failures this request are not logged)`,
            probe.error,
          );
        }
        probed.set(slug, probe);
      }
      return {
        readable: probe.readable,
        hidden: false,
        absent: probe.absent,
        page: probe.page,
      };
    },

    /**
     * The one signal that the index has drifted further than a single request
     * can cover. Not an error — those slugs stay hidden (`GET`) or refused
     * (`DELETE`), exactly as they did before the fallback existed — but it must
     * not be silent, and it must say which door it came from: the two doors
     * count different things (ledger rows walked vs. selections evaluated) and
     * answer differently.
     */
    reportExhaustedBudget() {
      if (unprobed > 0) {
        logger.warn(
          "ingest",
          `orphan probe budget (${MAX_ORPHAN_PROBES}) exhausted in ${door} /api/ingest/history; ${unprobed} further index-missing slug(s) went unprobed and were ${door === "GET" ? "hidden" : "refused"}`,
        );
      }
    },
  };
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
 *
 * ORPHAN FALLBACK (DW-432). The page INDEX is not the same set as "pages that
 * exist". A page on disk but absent from the index — the drift
 * `checkOrphanPages` exists for, and what a crash-left ingest silo looks like —
 * used to have its ledger row silently dropped here, so its owner never saw the
 * row at all. For a slug the index does not know AT ALL we now fall back to a
 * single per-page read and admit the row only when the page exists and the
 * caller may read its frontmatter ({@link readableOnDisk}).
 *
 * THE READ SCOPE IS UNCHANGED. `canReadFrontmatter` and `canReadEntry` both
 * delegate to `canReadPage`, so the fallback re-derives the SAME predicate from
 * frontmatter that the index path derives from an index entry, over the same
 * authoritative bytes. A slug the index DOES know keeps the index's answer with
 * zero extra reads — including when that answer is "hidden", which is both why
 * the common multi-user request costs exactly what it costs today and why a
 * dirty slug the index forced private stays hidden. What the probe establishes
 * is slug-scoped rather than provenance-scoped, and the owner hint makes it
 * caller-relative; {@link readableOnDisk} states both precisely, along with the
 * narrow cross-silo residue that follows from them.
 *
 * BOUNDED WORK. At most `MAX_ORPHAN_PROBES` reads per request, counted over
 * DISTINCT slugs; `limit` bounds the ANSWER, not the WORK, so a page of rows
 * that all turn out unlistable still spends the full budget. Index-missing rows
 * left over after the budget is spent stay hidden — exactly today's outcome for
 * them, never an error — and the walk keeps going, because a readable INDEXED
 * row further down the ledger must still list.
 *
 * `DELETE` RUNS THE SAME LADDER NOW (DW-704). DW-432 scoped the fallback to the
 * listing path because DW-393 had shipped the opposite constraint for the
 * delete path ("do not add a disk fallback for orphan slugs"), which left an
 * owner looking at a listed row whose delete always answered "not found". The
 * recorded 2026-09-03 decision SUPERSEDES that DW-393 clause, and both handlers
 * now share {@link createOrphanProber} — one ladder, one memo, one budget per
 * request — so neither can drift from the other's answer. Nothing about THIS
 * handler's observable behaviour changed with it: same listing set, same read
 * counts, same one-warn-per-request rules.
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

    // TWO sets, from ONE index listing. `indexed` is every slug the index
    // knows; `readable` is the subset this caller may read. Keeping them apart
    // is the whole safety of the fallback below: a slug missing from `readable`
    // ALONE is an indexed page the caller may not read — the exact population
    // this scoping exists to hide — and probing those would cost a disk read
    // per hidden row on the busiest multi-user path while starving the budget
    // for the orphans it is actually for.
    const all = await listWikiPages();
    const indexed = new Set(all.map((p) => p.slug));
    const readable = new Set(
      all.filter((e) => canReadEntry(e, principal)).map((e) => e.slug),
    );
    const prober = createOrphanProber(indexed, readable, principal, "GET");

    const wanted = limit ?? 50;
    const entries: LedgerEntry[] = [];
    for (const entry of await readLedger()) {
      if (entries.length >= wanted) break;
      const slug = entry.primary_slug;
      if (!slug) continue;
      // The ladder decides; the walk never `break`s on a spent budget, because
      // the budget bounds the READS, not the walk — a readable INDEXED row
      // after this point costs nothing and must still list.
      if ((await prober.verdict(slug)).readable) entries.push(entry);
    }

    prober.reportExhaustedBudget();

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
 * returns its ledger entries — but since DW-432 that conclusion takes BOTH
 * halves rather than the index alone: GET falls back to a per-page read for a
 * slug the index does not know, so a row leaves the listing only when its slug
 * is absent from the page index AND no readable page answers on disk. A real
 * delete satisfies both.
 *
 * SELECTION NOW ASKS THE SAME QUESTION THE LISTING ASKS (DW-704). Both gates
 * below — the `ingestIds` preflight and the DW-270 read gate in the ACL loop —
 * used to consult the index-backed readable set ALONE, so an orphan the index
 * had merely lost listed for its owner and then answered `SELECTION_NOT_FOUND`
 * to every delete: a row they could see and could never clear. Both now run
 * {@link createOrphanProber}'s ladder, the same one `GET` walks, under ONE memo
 * and ONE budget per request.
 *
 * THIS EXPLICITLY SUPERSEDES DW-393's DELETE-PATH CONSTRAINT. `spec-dw-393`
 * shipped "do not add a disk fallback for orphan slugs" as a Never clause, and
 * its suite pinned it with an assertion that an orphan's page is never read
 * here. The recorded 2026-09-03 decision overturns exactly that clause and
 * nothing else beside it: the DW-187 read-only 403, the whole-batch delete-ACL
 * 403, the whole-batch queued/processing 409, the one `SELECTION_NOT_FOUND`
 * sentence and `failed[]`'s shape and submission order are all unchanged.
 *
 * WHAT THE LADDER KNOWINGLY LEAVES BEHIND: THE SILO-ONLY ORPHAN. The ladder
 * ADMITS one — that is the shape the probe's `owner` hint exists for — but the
 * delete cannot finish it. `deleteWikiPage` re-reads the page itself, as
 * `readWikiPage(slug, { fresh: true, strict: true })` with NO `owner`
 * (`src/lib/lifecycle.ts`), and `readWikiPage` consults the caller's silo only
 * when `options.owner !== undefined` (`src/lib/wiki.ts`) — so a page that
 * exists ONLY at `tenants/<t>/wiki/<slug>.md`, with no flat copy and no index
 * row, is invisible to that second read and the kernel throws
 * `page not found: <slug>`. The route's pre-existing delete-throw path catches
 * it, so the row lands in `failed[]` carrying the KERNEL's message, its page is
 * not deleted, its ledger id stays out of `deletedIngestIds`, and nothing else
 * in the batch is vetoed. That is a worse answer than a clean delete but a
 * HONEST one — and it is not a `SELECTION_NOT_FOUND` violation: a delete-time
 * throw has always been its own failure family with its own message, distinct
 * from the not-found SELECTION family the one sentence covers.
 *
 * The FLAT orphan — `wiki/<slug>.md` present, absent from the page index, which
 * is `checkOrphanPages`' own drift and the common shape — deletes end to end,
 * because an ordinary unhinted read resolves it. Closing the silo-only residue
 * means giving the lifecycle delete the same owner-hinted resolution the probe
 * uses, which is a change to the kernel rather than to these two gates, and
 * this change deliberately does not make it.
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
    // TWO sets from ONE listing, derived exactly as `GET` derives them — the
    // same one-listing arrangement, since `listReadableWikiPages` is itself
    // `listWikiPages()` plus this filter. Both are needed because the ladder's
    // middle rung has to tell "the index HID this slug" (refuse, no disk read)
    // apart from "the index does not know this slug at all" (probe it).
    const all = await listWikiPages();
    const indexed = new Set(all.map((page) => page.slug));
    const readable = new Set(
      all.filter((entry) => canReadEntry(entry, principal)).map((e) => e.slug),
    );
    const prober = createOrphanProber(indexed, readable, principal, "DELETE");
    const ledgerById = new Map(ledger.map((entry) => [entry.ingest_id, entry]));
    const refusedIngestIds = new Set<string>();
    const selectedEntries: LedgerEntry[] = [];
    for (const id of ingestIds) {
      const entry = ledgerById.get(id);
      if (!entry || !entry.primary_slug) {
        // Absent or slugless — one sentence for both, and no slug ever reaches
        // `slugs`, so nothing is read, deleted, or attributed for them.
        refusedIngestIds.add(id);
        continue;
      }
      // The ladder, not the index alone (DW-704). A slug the index lost but
      // whose page this caller can read on disk is exactly the row `GET` lists
      // through its own fallback, so refusing it here is what made that row
      // undeletable. Everything the ladder still refuses — an indexed page the
      // caller may not read, an orphan that is not readable on disk, a probe
      // that could not answer, a spent budget — keeps the same one sentence.
      if (!(await prober.verdict(entry.primary_slug)).readable) {
        refusedIngestIds.add(id);
        continue;
      }
      selectedEntries.push(entry);
    }

    const refusedJobIds = new Set<string>();
    const selectedJobs: IngestJob[] = [];
    for (const jobId of jobIds) {
      const job = await getIngestJob(jobId);
      if (!job || job.owner !== ownerTenantHandle(principal)) {
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
      // THE LADDER, run once per slug and MEMOIZED with the preflight's
      // (DW-704). A slug both gates ask about costs exactly one disk read.
      const verdict = await prober.verdict(slug);
      if (!verdict.readable) {
        // "NOTHING IS STORED HERE" IS THE ONE SILENT EXIT, and it is the
        // already-gone cleanup this route exists to perform: a done job whose
        // page has since been deleted clears its record rather than landing in
        // `failed[]` forever. Every other refusal — an orphan on disk that is
        // not theirs, a probe that threw, a spent budget — fails CLOSED to the
        // one selection sentence.
        //
        // TWO WAYS TO ESTABLISH IT, because the ladder's two refusing rungs
        // know different things. Rung 3 (the probe) already looked, so
        // `verdict.absent` is its answer. Rung 2 (`hidden`) never looked: the
        // INDEX said a page is here and not for you, and the index's claim that
        // the page EXISTS is the one claim this ladder does not verify. So a
        // hidden slug takes the same plain read this loop always took for it
        // before DW-704 — no new cost, and no way to be admitted by it, since
        // its only outcome is `null` → clear, or a page → refuse. Without this
        // read a done job pointing at a slug whose index entry outlived its
        // page would be stuck in `failed[]` forever: the very "row that can
        // never be cleared" shape DW-704 exists to remove.
        const goneOnDisk = verdict.hidden
          ? (await readWikiPageWithFrontmatter(slug)) === null
          : verdict.absent;
        if (!goneOnDisk) failedSlugs.set(slug, SELECTION_NOT_FOUND);
        continue;
      }
      // A slug the DISK FALLBACK admitted is judged and deleted against the
      // bytes the probe already read (DW-704). The read below is UNHINTED, and
      // a silo-only orphan — the case the probe's `owner` hint exists for —
      // answers `null` to it; that `null` would fall into the already-gone
      // branch and report the row as deleted while `GET` kept listing it. An
      // INDEXED-readable slug takes the plain read, exactly as before.
      const page = verdict.page ?? (await readWikiPageWithFrontmatter(slug));
      if (!page) continue; // Already gone: clear its terminal UI record below.
      //
      // THE READ CLOAK (DW-270), now the ladder's own verdict above.
      //
      // WHY IT WAS NEEDED. `ingestIds` are preflighted, so the ones that reach
      // here arrive selectable. `jobIds` were not — the only gate they pass is
      // `job.owner !== ownerTenantHandle(principal)`, a check on the JOB record, so a
      // caller who owned a job whose page they may not read reached the ACL
      // below holding that page. This route was the one deny site in the app
      // that could describe a page the caller was never allowed to learn
      // existed.
      //
      // WHY IN THIS LOOP RATHER THAN IN THE `jobIds` PREFLIGHT. The check
      // covers BOTH selection paths in one place — "everything that reaches the
      // delete ACL is selectable" is now true for either way a slug got here —
      // and it keeps the already-gone cleanup that only the `jobIds` path
      // exercises: a flat gate up in the preflight would refuse exactly those
      // records instead of clearing them.
      //
      // The sentence is `SELECTION_NOT_FOUND`, the same constant both
      // preflights use — an unreadable page must look like an unselectable one,
      // not like a permission the caller lacks. Since DW-393 it is RECORDED
      // against this slug rather than returned: the job holding it lands in
      // `failed[]` with that one sentence, its page is never deleted, its job
      // record is never cleared, and the rest of the batch proceeds.
      //
      // WHAT THIS ORDERING KNOWINGLY LEAVES BEHIND. Because "nothing is stored
      // here" clears rather than refuses, a `jobIds` selection whose page EXISTS
      // but is unselectable lands in `failed[]`, while one whose page is already
      // GONE is cleared — so a caller who owns the job can still tell those two
      // apart. That is a deliberate trade, not an oversight: the only way to
      // close it is to refuse the absent case too, which would break the one
      // repair this route exists to perform. The residue is narrow — it leaks
      // "a page still exists at this slug" to someone who already holds a job
      // record naming that slug, and nothing about the page's owner, realm or
      // contents.
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
    // Both gates have asked everything they will ask, so the shared budget's
    // verdict is final. It cannot bite while `MAX_BULK_DELETE` and
    // `MAX_ORPHAN_PROBES` are the same number (see their doc comments), but if
    // they ever diverge this is the signal that a batch outran the probes.
    prober.reportExhaustedBudget();

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
        await deleteIngestJob(jobId, ownerTenantHandle(principal));
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
