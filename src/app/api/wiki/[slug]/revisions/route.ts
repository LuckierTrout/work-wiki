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
import {
  PAGE_UNREADABLE_COPY,
  PAGE_UNREADABLE_STATUS,
  isPageUnreadableError,
} from "@/lib/page-read-failure";

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

    // Check the page exists first.
    const page = await readWikiPage(slug);
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

    // Ensure the page exists. FRESH (DW-379): this read is the revert's MERGE
    // BASE — its frontmatter is what the reverted content is re-serialized
    // under, and its title is the fallback when the revision has no H1.
    // `pageCache` is module-global and ref-counted around bulk scans, so one
    // can be holding a superseded entry open when this request arrives;
    // merging into that entry would write back frontmatter that is no longer
    // stored. (The `GET` existence check above feeds no write and stays
    // cached.)
    const existing = await readWikiPageWithFrontmatter(slug, { fresh: true });
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
    // The fresh read above FAILED rather than found nothing (DW-379, inheriting
    // DW-378/DW-380). Before `fresh` that failure arrived as `null` and was
    // answered `page not found: <slug>`; unclassified it would now be a 500.
    // Neither is true: the page may well exist and the fault is transient. Same
    // status and same sentence `PUT /api/wiki/[slug]` already answers, imported
    // from the one module that owns them. Above the `invalid slug` ladder
    // because that classifier string-matches a message and would otherwise
    // decide this one.
    //
    // It lands BELOW the realm-aware ACL cloak above, so an existing-but-
    // unreadable page answers 503 where a cloaked one answers 404 — the same
    // residual `PUT`'s branch documents and accepts, for the same reason: the
    // cloak needs `existing.frontmatter`, which is exactly what the failed read
    // did not produce, so there is nothing to cloak WITH. No caller can induce
    // the failure reliably or selectively for a slug they choose, and on a
    // single-owner private deployment that is accepted deliberately.
    if (isPageUnreadableError(err)) {
      return NextResponse.json(
        { error: PAGE_UNREADABLE_COPY },
        { status: PAGE_UNREADABLE_STATUS },
      );
    }
    const message = getErrorMessage(err);
    const status = message.toLowerCase().startsWith("invalid slug") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
