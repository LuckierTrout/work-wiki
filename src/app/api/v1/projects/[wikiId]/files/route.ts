import { ownerTenantHandle } from "@/lib/owner";
import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import {
  V1_MAX_TREE_NODES,
  V1_TREE_TOO_LARGE_ERROR,
  normalizeFileRoot,
} from "@/lib/v1-contract";
import { resolveV1Caller, v1SlugGate } from "@/lib/v1-route";
import { listWorkbenchFilePaths } from "@/lib/workbench-files";

interface RouteContext {
  params: Promise<{ wikiId: string }>;
}

/**
 * `GET /api/v1/projects/{id}/files` — the readable tree, as paths (Story 8.2).
 *
 * ONE LISTER, shared with the Workbench's own tree: `listWorkbenchFilePaths`
 * with the same slug gate. A second walker here would be a second
 * answer to "what may this caller see", and the external door is the wrong place
 * to be the more generous of the two.
 *
 * `root` FILTERS, it does not re-root. The paths returned are always
 * tree-relative (`wiki/foo.md`, `raw/sources/…`), because `files/content` takes
 * exactly these strings back — a `root=wiki` listing that stripped the prefix
 * would hand the caller paths its sibling route refuses.
 *
 * A tree above {@link V1_MAX_TREE_NODES} is a 413, NOT a truncated list. The
 * lister's own cap already reports `truncated`, and an agent that received a
 * silent partial tree would conclude the missing pages do not exist.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { wikiId } = await params;
  const caller = await resolveV1Caller(wikiId, request);
  if (!caller.ok) {
    return NextResponse.json({ error: caller.error }, { status: caller.status });
  }
  try {
    const root = normalizeFileRoot(
      new URL(request.url).searchParams.get("root") ?? undefined,
    );
    const slugGate = await v1SlugGate(caller.principal);
    const listing = await listWorkbenchFilePaths(
      ownerTenantHandle(caller.principal),
      caller.wikiId,
      { ...slugGate, limit: V1_MAX_TREE_NODES },
    );
    if (listing.truncated) {
      return NextResponse.json(
        { error: V1_TREE_TOO_LARGE_ERROR, limit: V1_MAX_TREE_NODES },
        { status: 413 },
      );
    }
    const paths =
      root === "all"
        ? listing.paths
        : listing.paths.filter((path) => path.startsWith(`${root}/`));
    return NextResponse.json({
      wikiId: caller.requested,
      root,
      // Directory markers are dropped: `files/content` cannot read one, and a
      // caller walking this list should not have to strip trailing slashes to
      // know which entries are addressable.
      files: paths.filter((path) => !path.endsWith("/")),
      truncated: false,
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
