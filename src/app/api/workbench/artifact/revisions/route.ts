import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { READ_ONLY_REFUSAL, isReadOnlyError } from "@/lib/read-only";
import { ClientInputError, getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { isOwnerHandle } from "@/lib/owner";
import { PAGE_CONVENTIONS_REQUIRED_COPY, hasPageConventions } from "@/lib/schema-source";
import {
  listWikiArtifactRevisions,
  readWikiArtifactRevision,
  readWikiArtifactRevisionMeta,
} from "@/lib/wiki-artifact-revisions";
import { isEditableArtifactFile, type EditableArtifactFile } from "@/lib/wiki-scenarios";
import { getWikiRegistry, writeWikiArtifact } from "@/lib/wikis";
import { scopedContentVersion } from "@/lib/write-precondition";

/**
 * GET/POST /api/workbench/artifact/revisions?path=schema.md — artifact history
 * (DW-59).
 *
 * The recovery half of Story 1.8's Schema editor. `PUT /api/workbench/artifact`
 * overwrites the one executable artifact an owner may change; since DW-59 that
 * write snapshots what it replaces, and this route is how those snapshots are
 * listed, read and restored.
 *
 * A CHILD OF THE ARTIFACT ROUTE, NOT MORE VERBS ON IT. The model is
 * `GET/POST /api/wiki/[slug]/revisions` — list, `?timestamp=` for one, and
 * `POST {action:"revert",timestamp}` — so an artifact's history reads the same
 * way a page's does. `?path=` stays the target selector, which means BOTH halves
 * share the one `EDITABLE_ARTIFACT_FILES` allowlist rather than each holding
 * its own idea of what may be written.
 *
 * WHICH OF THE PARENT'S GATES THIS CARRIES. Verbatim: `getPrincipal()` → 401,
 * `isOwnerHandle` → 403, `isReadOnly()` → 403 (on the POST — see below), `?path=`
 * → the same single {@link NOT_EDITABLE} 400 that discloses nothing about which
 * file it was, the Wiki re-derived from the registry's `currentId`, and
 * `hasPageConventions` → 400 with the parent's own copy. The browser can address
 * neither a tenant, nor a Wiki, nor a storage key here any more than it can
 * there.
 *
 * THREE OF THE PARENT PUT'S GUARDS ARE DELIBERATELY ABSENT, and saying so is the
 * point — a reader who assumes the ladder is identical would be wrong in exactly
 * these places:
 *
 *   - NO `If-Match` / `checkWritePrecondition` (DW-56). The parent PUT carries
 *     it because an editor can hold a draft for minutes while an ingest or a
 *     second tab moves `schema.md` underneath it, and an unconditional save
 *     would silently replace the newer bytes with a stale draft. A revert has no
 *     draft: its payload is a stored revision, not something the caller typed,
 *     so there is nothing to go stale. The page revert this mirrors carries no
 *     precondition either, and — because the revert is itself snapshotted before
 *     it writes — a revert that lands on top of someone else's change is
 *     undoable rather than lost. Adding one here is a UI decision (which version
 *     the button held), not a correctness one, so it is not invented in the
 *     route.
 *   - NO non-empty check and NO `PREVIEW_MAX_CHARS` cap. Both are structurally
 *     satisfied rather than skipped: every byte this route can write came out of
 *     `saveWikiArtifactRevision`, and a revision is only ever a snapshot of what
 *     was already at the artifact path — i.e. either template seed bytes or the
 *     content of a write that ALREADY passed the parent's non-empty and length
 *     checks. There is no input path by which an empty or oversized body reaches
 *     `writeWikiArtifact` from here. `hasPageConventions` is re-run anyway, and
 *     the asymmetry is the reason why: unlike the other two, it can be FALSE for
 *     a legitimately-stored revision, because a snapshot may predate the guard.
 *
 * THE LISTING IS RETENTION-BOUNDED, NOT PAGINATED (DW-215). `{ revisions }` is
 * the newest `MAX_ARTIFACT_REVISIONS` snapshots. Usually that IS the whole
 * history, because `saveWikiArtifactRevision` prunes to the same cap — but not
 * always, and the difference matters to anyone reading this route: a directory
 * that predates retention, or one a fail-soft prune could not trim, holds more
 * than this answers, and the extra entries stay unreachable HERE until the next
 * save prunes them. Nothing on this path trims anything; a GET is a read.
 *
 * That gap is the bound doing its job rather than a defect it hides — the
 * alternative is stat-ing an unbounded backlog on every GET, which is what this
 * replaced. And there is deliberately no `?limit=` and no cursor: how deep the
 * history goes is the silo's decision, and a knob here would only let a caller
 * ask for revisions retention is in the business of removing.
 *
 * READ-ONLY REFUSES THE REVERT ONLY. A read-only deployment still answers the
 * listing: history is a read, and hiding it would tell the owner nothing except
 * that they cannot look. Only the POST, which writes, is refused.
 *
 * REVERT GOES THROUGH `writeWikiArtifact`, so it is an edit like any other — it
 * snapshots the bytes it replaces (a revert is undoable), and it fires the same
 * activity-log line and `dataVersion` bump. It also RE-RUNS
 * `hasPageConventions` on the revision content: a snapshot can predate that
 * guard, and a revert that skipped it would be a door around the check the
 * direct write enforces, landing an inert Schema the owner was told succeeded.
 */

/**
 * Per-principal and gated, like every answer in this tree — no shared cache and
 * no browser back/forward store may hold one.
 */
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/**
 * ONE body for every path that is not the editable artifact — the parent
 * route's copy, unchanged. Says nothing about which file it was, and names none.
 */
const NOT_EDITABLE = {
  error: "That file can’t be edited here.",
} as const;

/**
 * The gate ladder both verbs share, up to and including the target and the
 * current Wiki. Returns either the refusal to send or the resolved pair, so the
 * two handlers cannot drift onto different gates — the failure mode that would
 * make the GET a wider door onto the same bytes than the POST.
 *
 * `readOnly` is a PARAMETER rather than a fixed step: it is the one gate the two
 * verbs legitimately differ on.
 */
async function gate(
  request: Request,
  options: { refuseWhenReadOnly: boolean },
): Promise<
  | { ok: false; response: NextResponse }
  | { ok: true; owner: string; wikiId: string; file: EditableArtifactFile }
> {
  const principal = await getPrincipal();
  if (!principal) {
    return { ok: false, response: json({ error: "Sign in required." }, 401) };
  }
  if (!isOwnerHandle(principal.handle)) {
    return {
      ok: false,
      response: json({ error: "Only the workspace owner can edit the Schema." }, 403),
    };
  }
  if (options.refuseWhenReadOnly && isReadOnly()) {
    return {
      ok: false,
      response: json(
        { error: READ_ONLY_REFUSAL.artifactEdit },
        403,
      ),
    };
  }

  const target = new URL(request.url).searchParams.get("path");
  if (!isEditableArtifactFile(target)) {
    return { ok: false, response: json(NOT_EDITABLE, 400) };
  }

  const { currentId } = await getWikiRegistry(principal.handle);
  if (!currentId) {
    return { ok: false, response: json({ error: "Wiki not found." }, 404) };
  }

  return { ok: true, owner: principal.handle, wikiId: currentId, file: target };
}

/**
 * One rule for what counts as a revision id, shared so the two verbs refuse the
 * same values with the same status: a POSITIVE SAFE INTEGER. `null` is the
 * refusal — "absent" is handled by the callers, and only the GET treats it as a
 * valid request (it lists instead).
 *
 * SAFE INTEGER, not merely finite, so this rule and `canonicalStem`'s (in
 * `wiki-artifact-revisions.ts`) admit the same set. Every id this route hands
 * out came from a stem that round-trips through `String(n)`; a value that could
 * not have been one — `12.5`, or anything past 2^53 where distinct milliseconds
 * collapse onto one float — is MALFORMED, and answering it 400 says so, rather
 * than 404 "revision not found", which claims the id was well-formed and merely
 * missing.
 *
 * The GET hands it the raw query STRING (`Number("abc")` is `NaN`, which this
 * refuses); the POST hands it a JSON value and so must already have a number —
 * mirroring the page route, where a quoted timestamp in a JSON body is a
 * malformed body, not a lenient one.
 */
function parseTimestamp(value: number | string): number | null {
  const timestamp = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return null;
  return timestamp;
}

/**
 * A `ClientInputError` is the caller's input — `wikis.ts` throws it for an
 * unparseable owner or Wiki id — and everything else is ours. Without this wrap
 * a throw escapes as a framework 500 whose body is not `{ error }`.
 */
function fail(error: unknown, where: string) {
  // Mid-request flag flip: `gate` already answered for a deployment that was
  // read-only when the POST arrived, so a `ReadOnlyError` here came from
  // `writeWikiArtifact`. It is the owner's refusal, not a server fault — and
  // both verbs share this helper, so it is stated once.
  if (isReadOnlyError(error)) {
    return json({ error: getErrorMessage(error) }, 403);
  }
  const status = error instanceof ClientInputError ? 400 : 500;
  if (status === 500) {
    logger.error("workbench-artifact-revisions", where, error);
  }
  return json({ error: getErrorMessage(error) }, status);
}

export async function GET(request: Request) {
  try {
    const gated = await gate(request, { refuseWhenReadOnly: false });
    if (!gated.ok) return gated.response;
    const { owner, wikiId, file } = gated;

    const timestampParam = new URL(request.url).searchParams.get("timestamp");
    if (timestampParam !== null) {
      const timestamp = parseTimestamp(timestampParam);
      if (timestamp === null) {
        return json({ error: "timestamp must be a positive number" }, 400);
      }

      const content = await readWikiArtifactRevision(owner, wikiId, file, timestamp);
      if (content === null) {
        return json({ error: `revision not found: ${timestamp}` }, 404);
      }
      const meta = await readWikiArtifactRevisionMeta(owner, wikiId, file, timestamp);
      return json({
        content,
        revision: {
          timestamp,
          date: new Date(timestamp).toISOString(),
          file,
          sizeBytes: Buffer.byteLength(content, "utf-8"),
          ...(meta?.author !== undefined && { author: meta.author }),
          ...(meta?.reason !== undefined && { reason: meta.reason }),
        },
      });
    }

    return json({ revisions: await listWikiArtifactRevisions(owner, wikiId, file) });
  } catch (error) {
    return fail(error, "listing artifact revisions failed");
  }
}

export async function POST(request: Request) {
  try {
    const gated = await gate(request, { refuseWhenReadOnly: true });
    if (!gated.ok) return gated.response;
    const { owner, wikiId, file } = gated;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body." }, 400);
    }
    if (
      !body ||
      typeof body !== "object" ||
      (body as { action?: unknown }).action !== "revert"
    ) {
      return json({ error: 'action must be "revert"' }, 400);
    }
    const rawTimestamp = (body as { timestamp?: unknown }).timestamp;
    const timestamp =
      typeof rawTimestamp === "number" ? parseTimestamp(rawTimestamp) : null;
    if (timestamp === null) {
      return json({ error: "timestamp must be a positive number" }, 400);
    }

    const content = await readWikiArtifactRevision(owner, wikiId, file, timestamp);
    if (content === null) {
      return json({ error: `revision not found: ${timestamp}` }, 404);
    }
    // The guard the direct write enforces, re-run on bytes that may predate it.
    // Refused ABOVE the writer, so nothing is written: no snapshot, no log line,
    // no `dataVersion` bump.
    if (!hasPageConventions(content)) {
      return json({ error: PAGE_CONVENTIONS_REQUIRED_COPY }, 400);
    }

    // One writer, and it owns the tail. The `reason` is what the activity log
    // shows instead of a bare edit, and it is also recorded in the sidecar of
    // the snapshot this revert takes of the bytes it is replacing — so the
    // history says which entry undid what.
    // UNGATED, deliberately: no `expectedVersion` is passed. A revert names the
    // revision it is restoring, and the caller that picked it from the list was
    // never seeded with the CURRENT bytes — there is no version for it to hold.
    // The `reason` rides the options object beside it, where the two named
    // fields cannot be transposed (DW-193).
    await writeWikiArtifact(owner, wikiId, file, content, {
      reason: `reverted to revision ${new Date(timestamp).toISOString()}`,
    });
    // The version of what landed — `content` is stored verbatim — so an editor
    // holding this file open can save again without a reload. SCOPED by the
    // Wiki this route already gated on (DW-200), so it is the same token the
    // Preview serves and the artifact `PUT` compares; an unscoped one would
    // match another Wiki's byte-identical artifact.
    return json({ ok: true, version: scopedContentVersion(wikiId, content) });
  } catch (error) {
    return fail(error, "reverting an artifact failed");
  }
}
