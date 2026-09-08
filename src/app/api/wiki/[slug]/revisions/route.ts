import { NextResponse } from "next/server";
import { readWikiPage, readWikiPageWithFrontmatter, writeWikiPageWithSideEffects } from "@/lib/wiki";
import { listRevisions, readRevision, readRevisionMeta } from "@/lib/revisions";
import { extractSummary } from "@/lib/ingest";
import { serializeFrontmatter } from "@/lib/frontmatter";
import { getPrincipal, getServicePrincipal } from "@/lib/auth";
import { canReadSlug, canWriteFrontmatter, canReadFrontmatter } from "@/lib/authz";
import { resolveWriteDenial } from "@/lib/write-denial";
import { getErrorMessage } from "@/lib/errors";
import { isReadOnlyError } from "@/lib/read-only";

type RouteParams = { params: Promise<{ slug: string }> };

/**
 * GET /api/wiki/[slug]/revisions
 *
 * Without query params: returns `{ revisions: Revision[] }`.
 * With `?timestamp=<ms>`: returns `{ content: string, revision: Revision }` for
 * a specific revision.
 *
 * 404 if the page doesn't exist.
 * 200 with empty array if the page exists but has no revisions.
 */
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { slug } = await params;

    // Check the page exists first. FRESH+STRICT (DW-497). This is the read a
    // human actually hits, and the 404 below is the only thing it can say —
    // so both halves are here to make that 404 mean exactly one thing:
    // nothing is stored at this slug.
    //
    // FRESH. Not the sibling `POST`'s reason — that read seeds a merge base
    // and this one seeds nothing. `pageCache` caches NEGATIVE entries too
    // (`src/lib/wiki.ts` does `pageCache.set(slug, null)` on a true global
    // miss), and the cache is module-global and ref-counted around bulk scans,
    // so a scan that looked this slug up BEFORE the page existed can still be
    // holding that `null` open when this request arrives. It would manufacture
    // the very `page not found` this conversion exists to remove — a reader
    // told their page has no history because an unrelated scan is mid-flight.
    //
    // STRICT. Without it a non-ENOENT storage blip flattens to `null` and the
    // 404 tells the reader `page not found` about history that is still there.
    // Strict rethrows to the catch at the bottom, which answers 500 for
    // anything but `invalid slug`.
    //
    // AND STRICT REACHES FURTHER THAN THE PAGE FILE, deliberately: it forwards
    // into `getPageIndex({ strict })`, so an unreadable or unparseable
    // `derived-indexes/pages.json` now 500s this surface instead of degrading
    // to the scan fallback. That is the trade taken on purpose — an index
    // fault is a fault, and a 404 must not stand in for one. (The sibling
    // `POST` at the bottom of this file has said the same since DW-379.)
    const page = await readWikiPage(slug, { fresh: true, strict: true });
    if (!page) {
      return NextResponse.json(
        { error: `page not found: ${slug}` },
        { status: 404 },
      );
    }

    // A private page's revision history is owner-only (404 otherwise).
    if (!(await canReadSlug(slug, await getPrincipal()))) {
      return NextResponse.json(
        { error: `page not found: ${slug}` },
        { status: 404 },
      );
    }

    const url = new URL(req.url);
    const timestampParam = url.searchParams.get("timestamp");

    if (timestampParam !== null) {
      // Fetch a specific revision's content.
      const timestamp = Number(timestampParam);
      if (!Number.isFinite(timestamp) || timestamp <= 0) {
        return NextResponse.json(
          { error: "timestamp must be a positive number" },
          { status: 400 },
        );
      }

      const content = await readRevision(slug, timestamp);
      if (content === null) {
        return NextResponse.json(
          { error: `revision not found: ${timestamp}` },
          { status: 404 },
        );
      }

      // Read optional author/reason sidecar.
      const meta = await readRevisionMeta(slug, timestamp);

      return NextResponse.json({
        content,
        revision: {
          timestamp,
          date: new Date(timestamp).toISOString(),
          slug,
          sizeBytes: Buffer.byteLength(content, "utf-8"),
          ...(meta?.author !== undefined && { author: meta.author }),
          ...(meta?.reason !== undefined && { reason: meta.reason }),
        },
      });
    }

    // List all revisions.
    const revisions = await listRevisions(slug);
    return NextResponse.json({ revisions });
  } catch (err) {
    const message = getErrorMessage(err);
    const status = message.toLowerCase().startsWith("invalid slug") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

/**
 * POST /api/wiki/[slug]/revisions
 *
 * Body: `{ action: "revert", timestamp: number }`
 *
 * Reverts the page to the content from the given revision. Uses
 * `writeWikiPageWithSideEffects` so index, cross-refs, and log stay consistent.
 */
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { slug } = await params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "invalid JSON body" },
        { status: 400 },
      );
    }

    if (
      !body ||
      typeof body !== "object" ||
      !("action" in body) ||
      (body as { action: unknown }).action !== "revert"
    ) {
      return NextResponse.json(
        { error: 'action must be "revert"' },
        { status: 400 },
      );
    }

    const timestamp = (body as { timestamp?: unknown }).timestamp;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) {
      return NextResponse.json(
        { error: "timestamp must be a positive number" },
        { status: 400 },
      );
    }

    // Ensure the page exists. FRESH+STRICT (DW-379): `existing.content` is the
    // revert's merge base below, so it must be the stored file — not a
    // superseded `pageCache` entry an open bulk scan is holding — and a storage
    // failure must reach the catch as a 500 rather than pose as a 404.
    const existing = await readWikiPageWithFrontmatter(slug, {
      fresh: true,
      strict: true,
    });
    if (!existing) {
      return NextResponse.json(
        { error: `page not found: ${slug}` },
        { status: 404 },
      );
    }

    // Realm-aware write ACL. A revert is a write — use the same cloak pattern
    // as PUT: private page non-reader → 404, readable-but-unwritable → 403.
    const principal = (await getPrincipal()) ?? getServicePrincipal(req);
    if (!canWriteFrontmatter(existing.frontmatter, principal, "body")) {
      return canReadFrontmatter(existing.frontmatter, principal)
        ? NextResponse.json(
            {
              // Readable (the cloak ran first); the resolver adds the realm
              // explanation only when the realm gate is what refused.
              error: resolveWriteDenial("revert", existing.frontmatter, "body"),
            },
            { status: 403 },
          )
        : NextResponse.json(
            { error: `page not found: ${slug}` },
            { status: 404 },
          );
    }

    // Load the revision content.
    const revisionContent = await readRevision(slug, timestamp);
    if (revisionContent === null) {
      return NextResponse.json(
        { error: `revision not found: ${timestamp}` },
        { status: 404 },
      );
    }

    // Derive title from the revision content's first H1, falling back to
    // the existing page title.
    const titleMatch = revisionContent.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : existing.title;

    // Strip the leading H1 before deriving the summary.
    const bodyForSummary = revisionContent.replace(/^#\s+.+$/m, "").trim();
    const summary = extractSummary(bodyForSummary);

    // Merge frontmatter: use the existing page's frontmatter but bump the
    // `updated` date to today so the timeline reflects the revert.
    const today = new Date().toISOString().slice(0, 10);
    const mergedFrontmatter = { ...existing.frontmatter };
    if (
      typeof mergedFrontmatter.created !== "string" ||
      mergedFrontmatter.created === ""
    ) {
      mergedFrontmatter.created = today;
    }
    mergedFrontmatter.updated = today;

    // If the revision content already has its own frontmatter block we use
    // it as-is (the old snapshot is the full page including YAML). Otherwise
    // we prepend the merged frontmatter.
    const hasYamlBlock = revisionContent.trimStart().startsWith("---");
    const finalContent = hasYamlBlock
      ? revisionContent
      : serializeFrontmatter(mergedFrontmatter, revisionContent);

    const result = await writeWikiPageWithSideEffects({
      slug,
      title,
      content: finalContent,
      summary,
      logOp: "edit",
      crossRefSource: revisionContent,
      author: principal?.handle,
      expectedContent: existing.content,
      validateNewLinkTargets: true,
      logDetails: (ctx) =>
        `reverted to revision ${new Date(timestamp).toISOString()} · updated ${ctx.updatedSlugs.length} cross-ref(s)`,
    });

    return NextResponse.json(result);
  } catch (err) {
    // Deployment read-only (DW-187). A revert is a full body rewrite behind a
    // confirm; `writeWikiPageWithSideEffects` refuses it, and this is what turns
    // that refusal into the 403 the caller can act on. The 404s above still win
    // — a missing page and a missing revision are reads the flag does not
    // change.
    if (isReadOnlyError(err)) {
      return NextResponse.json({ error: getErrorMessage(err) }, { status: 403 });
    }
    const message = getErrorMessage(err);
    const status = message.toLowerCase().startsWith("invalid slug") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
