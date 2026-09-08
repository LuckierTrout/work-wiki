import {
  listReadableWikiPages,
  rawRelPath,
  readWikiPageWithFrontmatter,
} from "@/lib/wiki";
import { getStorage } from "@/lib/storage";
import { isEnoent } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getPrincipal } from "@/lib/auth";
import { canReadFrontmatter } from "@/lib/authz";
import { buildKnowledgeTree, workbenchSlugGate } from "@/lib/workbench-tree";
import { rawPathAllowed } from "@/lib/workbench-files";

/**
 * GET /api/assets/[...path]
 *
 * Serves a binary asset (image) that was stored during ingest. Stored images
 * (e.g. single-image ingests via `storeImageBytes` / `ingestImage`, and baked
 * yoyo illustrations) live at the storage key `raw/assets/{slug}/{file}` and are
 * referenced in markdown by the relative path `assets/{slug}/{file}`. This route
 * maps a request path back to that storage key and streams the bytes.
 *
 * Read-only, and gated TWICE, because the two gates cover disjoint holes
 * (DW-536):
 *
 * 1. Visibility. The first path segment is the page slug; if that page exists
 *    and is `visibility: private`, only the owner may read the asset.
 * 2. The WORKBENCH slug gate — `listReadableWikiPages` → `buildKnowledgeTree` →
 *    `workbenchSlugGate` → {@link rawPathAllowed}, derived exactly as every
 *    `/api/workbench/*` and `/api/v1` file door derives it. This route serves
 *    the same per-page binary tree those doors list: it reads the SHARED flat
 *    `raw/assets/<slug>/<file>` keys, and they resolve the per-tenant copy
 *    `syncSiloForPage` mirrors to `tenants/<tenant>/raw/assets/<slug>/<file>` —
 *    two roots, one content. So a narrower gate here is a hole in theirs: an
 *    AGENT-SCOPED page needs no `visibility: private` to be hidden — the
 *    knowledge tree drops it — and the Files tab withheld its asset while a
 *    plain unauthenticated GET still served it.
 *
 * Neither gate subsumes the other. `hiddenSlugs` is derived from entries the
 * principal can READ, so a private page an anonymous caller cannot read is
 * absent from that set entirely and only the visibility check refuses it;
 * conversely an agent-scoped page is readable-but-dropped, so only the slug gate
 * refuses it.
 *
 * The route stays NO-AUTH: an anonymous request for a slug the gate admits
 * still gets the bytes. What it no longer does is skip principal resolution —
 * the gate has to be derived for the caller to be derived at all. Every refusal
 * is a bodyless 404 (not 403), indistinguishable from an absent file, so the
 * door is not an existence oracle.
 */

/** Map a file extension to a Content-Type. */
const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

function contentTypeFor(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** Reject a path segment that could escape the assets dir. */
function isUnsafeSegment(seg: string): boolean {
  return (
    seg.length === 0 ||
    seg === "." ||
    seg === ".." ||
    seg.includes("/") ||
    seg.includes("\\") ||
    seg.includes("\0")
  );
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path: segments } = await params;

  // Traversal guard: the filesystem provider resolves keys with path.resolve,
  // so a `..` segment could otherwise escape the data dir. 404 (not 400) to
  // avoid leaking which paths exist.
  if (!segments?.length || segments.some(isUnsafeSegment)) {
    return new Response(null, { status: 404 });
  }

  // Resolved ONCE, up front: both gates below need it. This is what the route
  // used to skip for public pages, and skipping it is precisely what left an
  // agent-scoped page's asset served to anyone (DW-536) — that page is hidden
  // without ever being `visibility: private`, so the visibility check alone
  // never asked the question.
  const principal = await getPrincipal();

  // Gate 1 — visibility. The first segment is the page slug: if the page exists
  // and is private, only the owner may read the asset.
  const slug = segments[0];
  const page = await readWikiPageWithFrontmatter(slug);
  if (page && page.frontmatter.visibility === "private") {
    if (!canReadFrontmatter(page.frontmatter, principal)) {
      return new Response(null, { status: 404 });
    }
  }

  // Gate 2 — the Workbench slug gate, derived the ONE way every other file door
  // derives it. The entries are hoisted because the gate comes from the PAIR
  // `(entries, knowledge)`: `hiddenSlugs` is what the index named and the
  // knowledge tree dropped, so neither half alone produces it.
  //
  // Applied to the WORKBENCH DISPLAY path (`raw/assets/<segments>`), not to the
  // storage key below — `rawRelPath` may rewrite that under a `RAW_DIR`
  // override, and the gate speaks display paths.
  //
  // FAIL CLOSED. A gate that could not be derived is not an admitting gate:
  // the page-index read behind it can fail (storage outage, binding failure),
  // and falling through to the bytes on that path would reopen the disclosure
  // exactly when the system is least able to notice. So the failure is logged
  // and answered 500 — the same shape `readAsset` below already keeps for a
  // real incident, rather than the unlogged framework 500 an escaping throw
  // would produce.
  let hiddenSlugs: ReadonlySet<string>;
  try {
    const entries = await listReadableWikiPages(principal);
    ({ hiddenSlugs } = workbenchSlugGate(entries, buildKnowledgeTree(entries)));
  } catch (err) {
    logger.error("assets", "slug gate derivation failed", err);
    return new Response(null, { status: 500 });
  }
  if (!rawPathAllowed(`raw/assets/${segments.join("/")}`, hiddenSlugs)) {
    return new Response(null, { status: 404 });
  }

  // markdown ref `assets/<...>` → storage key `raw/assets/<...>` (rawRelPath is
  // the single source of truth used by the writer, so a RAW_DIR override stays
  // consistent).
  const storageKey = rawRelPath(`assets/${segments.join("/")}`);

  let bytes: ArrayBuffer;
  try {
    bytes = await getStorage().readAsset(storageKey);
  } catch (err) {
    // A genuinely missing asset is a 404; anything else (R2 outage, binding
    // failure) is a real incident — surface it as 500 + log so it isn't
    // indistinguishable from "file not found".
    if (isEnoent(err)) return new Response(null, { status: 404 });
    logger.error("assets", `readAsset failed for ${storageKey}`, err);
    return new Response(null, { status: 500 });
  }

  const name = segments[segments.length - 1];
  const contentType = contentTypeFor(name);
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Length": String(bytes.byteLength),
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  };
  // SVGs are served same-origin and can carry inline script — sandbox + a
  // restrictive CSP let them render as images without executing anything.
  if (contentType === "image/svg+xml") {
    headers["Content-Security-Policy"] =
      "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    headers["Content-Disposition"] = "inline";
  }

  return new Response(bytes, { status: 200, headers });
}
