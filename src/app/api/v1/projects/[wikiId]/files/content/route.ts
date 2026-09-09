import { ownerTenantHandle } from "@/lib/owner";
import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import {
  V1_FILE_BINARY_ERROR,
  V1_FILE_OUT_OF_SCOPE_ERROR,
  V1_FILE_TOO_LARGE_ERROR,
  V1_MAX_FILE_BYTES,
  isV1FileInScope,
  isV1TextPath,
} from "@/lib/v1-contract";
import { resolveV1Caller, v1SlugGate } from "@/lib/v1-route";
import { readWorkbenchFile } from "@/lib/workbench-files";

interface RouteContext {
  params: Promise<{ wikiId: string }>;
}

/**
 * `GET /api/v1/projects/{id}/files/content?path=…` — one file, as text
 * (Story 8.2).
 *
 * THREE REFUSALS, IN THIS ORDER, and the order is the point:
 *
 *  1. `out_of_scope` (403) — the path names somewhere the door does not reach at
 *     all. Checked FIRST, on the string, before any storage call, so a traversal
 *     attempt never becomes a read.
 *  2. `unsupported_media_type` (415) — in scope, but not text. Decided by
 *     EXTENSION rather than by sniffing bytes, so a PDF is refused without being
 *     buffered and the caller is never handed decoded mojibake.
 *  3. `too_large` (413) — text, in scope, and bigger than the door will carry.
 *
 * A 404 means the gate allowed the path and the file is not there. That
 * distinction is deliberate: "you may not read this" and "this does not exist"
 * lead an agent to different next actions, and collapsing them into one status
 * would have it retry a permission problem forever.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { wikiId } = await params;
  const caller = await resolveV1Caller(wikiId, request);
  if (!caller.ok) {
    return NextResponse.json({ error: caller.error }, { status: caller.status });
  }
  try {
    const path = (new URL(request.url).searchParams.get("path") ?? "").trim();
    if (!isV1FileInScope(path)) {
      return NextResponse.json(
        { error: V1_FILE_OUT_OF_SCOPE_ERROR },
        { status: 403 },
      );
    }
    if (!isV1TextPath(path)) {
      return NextResponse.json(
        { error: V1_FILE_BINARY_ERROR },
        { status: 415 },
      );
    }
    const slugGate = await v1SlugGate(caller.principal);
    const file = await readWorkbenchFile(
      ownerTenantHandle(caller.principal),
      caller.wikiId,
      path,
      slugGate,
    );
    if (!file) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    // Measured in BYTES, not characters: the cap is about what crosses the wire,
    // and a page of CJK is three times its character count.
    const bytes = new TextEncoder().encode(file.content).length;
    if (bytes > V1_MAX_FILE_BYTES) {
      return NextResponse.json(
        { error: V1_FILE_TOO_LARGE_ERROR, bytes, limit: V1_MAX_FILE_BYTES },
        { status: 413 },
      );
    }
    return NextResponse.json({
      wikiId: caller.requested,
      path,
      content: file.content,
      bytes,
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
