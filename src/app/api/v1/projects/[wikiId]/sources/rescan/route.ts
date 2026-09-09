import { ownerTenantHandle } from "@/lib/owner";
import { NextResponse } from "next/server";
import { isReadOnly } from "@/lib/config";
import { getErrorMessage } from "@/lib/errors";
import { isReadOnlyError, READ_ONLY_REFUSAL } from "@/lib/read-only";
import { RESCAN_MAX_SOURCES, rescanSources } from "@/lib/source-rescan";
import {
  V1_FILE_OUT_OF_SCOPE_ERROR,
  V1_INVALID_INPUT_ERROR,
  V1_TOO_MANY_PATHS_ERROR,
  isV1FileInScope,
} from "@/lib/v1-contract";
import { readV1JsonBody, resolveV1Caller, v1SlugGate } from "@/lib/v1-route";

interface RouteContext {
  params: Promise<{ wikiId: string }>;
}

/**
 * `POST /api/v1/projects/{id}/sources/rescan` — compile stored Sources again
 * (Story 8.2).
 *
 * THE ONE WRITE-ISH VERB on the Sources side of this façade, and it writes no
 * Source: it enqueues compiles for bytes that already landed. Ingest is what
 * writes pages, and it dedupes, so a rescan of an unchanged Source costs a queue
 * message and answers `deduped` from the pipeline.
 *
 * A `paths` LIST IS VALIDATED HERE, before anything is read: every entry must be
 * in scope and under `raw/`, and one bad entry fails the whole call rather than
 * being dropped. Silently ignoring a path would tell a caller its rescan
 * succeeded for a Source that was never touched.
 *
 * Read-only refuses. A rescan's whole purpose is to cause writes downstream, and
 * a deployment that refuses writes must refuse the thing that schedules them
 * rather than filling a queue nothing will drain.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { wikiId } = await params;
  const caller = await resolveV1Caller(wikiId, request);
  if (!caller.ok) {
    return NextResponse.json({ error: caller.error }, { status: caller.status });
  }
  if (isReadOnly()) {
    return NextResponse.json(
      { error: READ_ONLY_REFUSAL.ingest },
      { status: 403 },
    );
  }
  try {
    const parsed = await readV1JsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as {
      paths?: unknown;
      limit?: unknown;
      cursor?: unknown;
    };
    let paths: string[] | undefined;
    if (body.paths !== undefined) {
      if (
        !Array.isArray(body.paths) ||
        body.paths.some((path) => typeof path !== "string")
      ) {
        // Token first, sentence in `detail` — the shape
        // `../../reviews/route.ts` and `/api/v1/web-search` already answer
        // with. `too_many_paths` three branches down is the sibling TOKEN in
        // this same `if` block (it carries `limit`, not a `detail`), and this
        // refusal used to be the one place inside the block where `error` was
        // an English sentence instead of a machine word.
        return NextResponse.json(
          {
            error: V1_INVALID_INPUT_ERROR,
            detail: "paths must be an array of strings.",
          },
          { status: 400 },
        );
      }
      paths = body.paths.map((path) => (path as string).trim());
      const bad = paths.find(
        (path) => !isV1FileInScope(path) || !path.startsWith("raw/sources/"),
      );
      if (bad !== undefined) {
        return NextResponse.json(
          { error: V1_FILE_OUT_OF_SCOPE_ERROR, path: bad },
          { status: 403 },
        );
      }
      if (paths.length > RESCAN_MAX_SOURCES) {
        // REFUSED, not silently trimmed: a caller that named forty paths and got
        // twenty-five compiles would have no way to know which fifteen it still
        // owes. `remaining` covers the unnamed case; this one is a mistake.
        //
        // The token now comes from `v1-contract.ts` (DW-748), value unchanged
        // and still the published one — the hoist buys it an owner, not a new
        // spelling. It sits there beside `limit_reached`, the WORKSPACE-STATE
        // half of the same capacity family, which THIS DOOR NEVER EMITS: a
        // rescan cap is request-shaped and the caller clears it by naming fewer
        // paths, while `limit_reached` (the `deep_research` door) is cleared
        // only by deleting a project. Both differ from `invalid_input` above,
        // which is a genuinely malformed body.
        return NextResponse.json(
          { error: V1_TOO_MANY_PATHS_ERROR, limit: RESCAN_MAX_SOURCES },
          { status: 400 },
        );
      }
    }
    const slugGate = await v1SlugGate(caller.principal);
    const result = await rescanSources({
      owner: ownerTenantHandle(caller.principal),
      wikiId: caller.wikiId,
      ...slugGate,
      ...(paths ? { paths } : {}),
      ...(typeof body.limit === "number" ? { limit: body.limit } : {}),
      ...(typeof body.cursor === "number" ? { cursor: body.cursor } : {}),
    });
    const queued = result.results.filter((row) => row.queued).length;
    const payload = {
      wikiId: caller.requested,
      ...result,
      queued,
      queue: queued,
      changedTasks: result.results
        .filter((row) => row.queued && row.jobId)
        .map((row) => ({ path: row.path, jobId: row.jobId })),
    };
    // A sticky 200 + nextCursor would let a drain loop the same offset
    // forever. 503 + null cursor is terminal: try again later, do not page.
    return NextResponse.json(payload, {
      status: result.reason === "listing_unavailable" ? 503 : 200,
    });
  } catch (error) {
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
    }
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
