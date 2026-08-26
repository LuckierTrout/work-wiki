import { NextResponse } from "next/server";
import { isReadOnly } from "@/lib/config";
import { getErrorMessage } from "@/lib/errors";
import { isReadOnlyError, READ_ONLY_REFUSAL } from "@/lib/read-only";
import { RESCAN_MAX_SOURCES, rescanSources } from "@/lib/source-rescan";
import { V1_FILE_OUT_OF_SCOPE_ERROR, isV1FileInScope } from "@/lib/v1-contract";
import { resolveV1Caller, v1ReadableSlugs } from "@/lib/v1-route";

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
    const body = (await request.json().catch(() => ({}))) as {
      paths?: unknown;
      limit?: unknown;
    };
    let paths: string[] | undefined;
    if (body.paths !== undefined) {
      if (
        !Array.isArray(body.paths) ||
        body.paths.some((path) => typeof path !== "string")
      ) {
        return NextResponse.json(
          { error: "paths must be an array of strings." },
          { status: 400 },
        );
      }
      paths = body.paths.map((path) => (path as string).trim());
      const bad = paths.find(
        (path) => !isV1FileInScope(path) || !path.startsWith("raw/"),
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
        return NextResponse.json(
          { error: "too_many_paths", limit: RESCAN_MAX_SOURCES },
          { status: 400 },
        );
      }
    }
    const readableSlugs = await v1ReadableSlugs(caller.principal);
    const result = await rescanSources({
      owner: caller.principal.handle,
      wikiId: caller.wikiId,
      readableSlugs,
      ...(paths ? { paths } : {}),
      ...(typeof body.limit === "number" ? { limit: body.limit } : {}),
    });
    return NextResponse.json({
      wikiId: caller.requested,
      ...result,
      queued: result.results.filter((row) => row.queued).length,
    });
  } catch (error) {
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
    }
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
