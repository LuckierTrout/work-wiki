import { getPrincipal } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { listReadableWikiPages } from "@/lib/wiki";
import { getWikiRegistry } from "@/lib/wikis";
import { readWorkbenchFileBytes } from "@/lib/workbench-files";
import { intakeMediaContentType } from "@/lib/workbench-intake";
import { isPreviewMediaFormat, previewFileKind } from "@/lib/workbench-preview";
import {
  buildKnowledgeTree,
  readableSlugsFromKnowledge,
} from "@/lib/workbench-tree";

/**
 * GET /api/workbench/media?path=<display path> — the BYTES behind a media
 * Source, streamed undecoded (Story 7.7).
 *
 * The Preview route answers a media selection with a payload that names the
 * file and carries no body, because `readFile` decodes UTF-8 and a decoded PNG
 * is not a PNG. This is where the bytes actually come from: `<img src>`,
 * `<video src>` and `<audio src>` all point here, so the browser fetches them
 * with its own range/streaming machinery instead of the column reading a
 * base64 string into a React state.
 *
 * ITS OWN DOOR RATHER THAN `/api/assets/`. That route is keyed on
 * `raw/assets/<slug>/<file>` and gates on the PAGE's visibility; a media Source
 * lives under `raw/sources/` and is gated by the Workbench file tree. Pointing
 * media at it would have meant widening a route that skips principal
 * resolution for public pages to cover the entire raw silo.
 *
 * THE GATE IS THE PREVIEW'S GATE, RE-DERIVED, NEVER TRUSTED FROM THE CLIENT —
 * same two functions over the same principal, and the same
 * `resolveWorkbenchFile` underneath via {@link readWorkbenchFileBytes}. So this
 * door's reach equals the tree's by construction. A `?path=` naming something
 * outside it is a 404 with an empty body, indistinguishable from absent,
 * unreadable and non-media: no existence oracle, the rule the Preview route
 * documents at length.
 */

/** Per-principal and gated, so cacheable by nobody. */
const NO_STORE = "private, no-store";

function refuse(status: number) {
  return new Response(null, { status, headers: { "Cache-Control": NO_STORE } });
}

export async function GET(request: Request): Promise<Response> {
  try {
    return await handle(request);
  } catch (error) {
    logger.error("workbench-media", "media read failed", error);
    // A body would be the one answer this route's 404s do not have; keep the
    // failure shape uniform and put the detail in the log.
    logger.error("workbench-media", getErrorMessage(error));
    return refuse(500);
  }
}

async function handle(request: Request): Promise<Response> {
  const principal = await getPrincipal();
  if (!principal) return refuse(401);

  const displayPath = new URL(request.url).searchParams.get("path");
  if (!displayPath) return refuse(404);

  // Format FIRST, from the name alone: this door serves media and nothing
  // else. Without this check it would be a general byte-exfiltration door for
  // every `.md` in the silo — same reach as the Preview, but skipping the
  // frontmatter strip, the body cap and the disputed flag.
  const format = previewFileKind(displayPath);
  if (!isPreviewMediaFormat(format)) return refuse(404);

  let currentId: string | null = null;
  try {
    currentId = (await getWikiRegistry(principal.handle)).currentId;
  } catch {
    currentId = null;
  }

  const knowledge = buildKnowledgeTree(await listReadableWikiPages(principal));
  const readableSlugs = readableSlugsFromKnowledge(knowledge);

  const bytes = await readWorkbenchFileBytes(
    principal.handle,
    currentId,
    displayPath,
    { readableSlugs },
  );
  if (!bytes) return refuse(404);

  const name = displayPath.slice(displayPath.lastIndexOf("/") + 1);
  const contentType = intakeMediaContentType(name);
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Length": String(bytes.byteLength),
    "Cache-Control": NO_STORE,
    // The bytes are owner-supplied, so the browser must not be allowed to
    // decide they are something more interesting than what we labelled them.
    "X-Content-Type-Options": "nosniff",
    // `inline` so the column can render it; the filename is the Source's own.
    "Content-Disposition": `inline; filename="${encodeURIComponent(name)}"`,
  };
  // An SVG is a document, not an image: served same-origin it can carry inline
  // script. The same sandbox + CSP `/api/assets/` applies, for the same reason.
  if (contentType === "image/svg+xml") {
    headers["Content-Security-Policy"] =
      "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  }

  // RANGE, for the players. Safari will not play an `<audio>` or `<video>`
  // source at all unless the server advertises range support, and every
  // browser needs it to seek: without a 206 the scrub bar either does nothing
  // or restarts the download from byte zero. `Accept-Ranges` is advertised on
  // every response, because a client asks only after being told it may.
  headers["Accept-Ranges"] = "bytes";
  const requested = parseRange(request.headers.get("range"), bytes.byteLength);
  if (requested === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: {
        "Cache-Control": NO_STORE,
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes */${bytes.byteLength}`,
      },
    });
  }
  if (requested) {
    const slice = bytes.slice(requested.start, requested.end + 1);
    return new Response(slice, {
      status: 206,
      headers: {
        ...headers,
        "Content-Length": String(slice.byteLength),
        "Content-Range": `bytes ${requested.start}-${requested.end}/${bytes.byteLength}`,
      },
    });
  }

  return new Response(bytes, { status: 200, headers });
}

/**
 * The one byte range a `Range:` header asks for, or `null` for "send it all".
 *
 * ONE RANGE ONLY. Multi-range requests exist in the RFC and no media element
 * sends them; answering the whole entity is a legal response to a range the
 * server will not satisfy, and it is a much smaller thing to get right than a
 * `multipart/byteranges` body. Anything malformed is treated the same way,
 * which is what the RFC requires: an unparseable `Range` is ignored, not an
 * error.
 */
function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;
  if (size === 0) return "unsatisfiable";

  // `bytes=-500` is the LAST 500 bytes, not "from 0 to 500" — the suffix form
  // is how a player reads a trailing index (an MP4 `moov` atom at the end).
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= size) return "unsatisfiable";
  const end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1;
  if (!Number.isFinite(end) || end < start) return "unsatisfiable";
  return { start, end };
}
