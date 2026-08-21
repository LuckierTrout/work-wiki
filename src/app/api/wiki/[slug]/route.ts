import { NextResponse } from "next/server";
import { decodeSlug } from "@/lib/slugify";
import {
  deleteWikiPage,
  readWikiPageWithFrontmatter,
  serializeFrontmatter,
  writeWikiPageWithSideEffects,
  type Frontmatter,
} from "@/lib/wiki";
import { extractSummary } from "@/lib/ingest";
import { getPrincipal, getServicePrincipal } from "@/lib/auth";
import { canReadFrontmatter, canWriteFrontmatter } from "@/lib/authz";
import { resolveWriteDenial } from "@/lib/write-denial";
import { isReadOnly } from "@/lib/config";
import { READ_ONLY_REFUSAL, isReadOnlyError } from "@/lib/read-only";
import { getErrorMessage } from "@/lib/errors";
import { patchMetadata } from "@/lib/patch-metadata";
import {
  IF_MATCH_HEADER,
  checkWritePrecondition,
  contentVersion,
} from "@/lib/write-precondition";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug: encodedSlug } = await params;
    const slug = decodeSlug(encodedSlug);

    // Deployment read-only, answered BEFORE anything is read. The answer is the
    // same for every slug, so it is not an existence oracle — and it keeps the
    // refusal cheap. The realm-aware 404-cloak below is untouched.
    if (isReadOnly()) {
      return NextResponse.json(
        { error: READ_ONLY_REFUSAL.pageDelete },
        { status: 403 },
      );
    }

    // Realm-aware write ACL: a private page may be deleted only by its owner
    // (or their agents / the service principal); public commons pages stay
    // collectively manageable. (The middleware already blocks unauthenticated
    // mutations; this is the per-page check on top.)
    const principal = (await getPrincipal()) ?? getServicePrincipal(req);
    const existing = await readWikiPageWithFrontmatter(slug);
    if (!existing) {
      return NextResponse.json(
        { error: `page not found: ${slug}` },
        { status: 404 },
      );
    }
    // Realm-aware write ACL. When the write is denied, CLOAK: a private page the
    // caller can't even read is 404 (no existence oracle, matching reads); a
    // readable-but-unwritable page is 403.
    if (!canWriteFrontmatter(existing.frontmatter, principal, "delete")) {
      return canReadFrontmatter(existing.frontmatter, principal)
        ? NextResponse.json(
            {
              // The cloak above already ran, so this page is readable — the
              // resolver names its realm only when the realm gate is what
              // denied the delete.
              error: resolveWriteDenial("delete", existing.frontmatter, "delete"),
            },
            { status: 403 },
          )
        : NextResponse.json(
            { error: `page not found: ${slug}` },
            { status: 404 },
          );
    }

    const result = await deleteWikiPage(slug, principal?.handle);
    return NextResponse.json(result);
  } catch (err) {
    // The gate above already answered for a deployment that was read-only when
    // the request arrived; this is the flag flipping mid-request, where
    // `deleteWikiPage`'s refusal surfaces here instead. Without the branch the
    // fall-through below calls it a 400 — a refusal naming read-only, reported
    // as the caller's malformed request.
    if (isReadOnlyError(err)) {
      return NextResponse.json({ error: getErrorMessage(err) }, { status: 403 });
    }
    const message = getErrorMessage(err);
    const status = message.startsWith("page not found") ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

/**
 * PUT /api/wiki/[slug]
 *
 * Replace the body of an existing wiki page. Returns 404 when the slug
 * doesn't exist — edit is strictly an update operation, use the ingest flow
 * (or a future create endpoint) to add new pages.
 *
 * Body: `{ content: string }` — the new markdown **body** (no YAML
 * frontmatter). The editor never exposes the YAML block to users; the
 * server owns frontmatter end-to-end.
 *
 * On save the route:
 *   1. Reads the existing page's parsed frontmatter.
 *   2. Bumps `updated` to today (YYYY-MM-DD), backfilling `created` for
 *      legacy pages that were written before frontmatter existed.
 *   3. Preserves every other key (`source_count`, `tags`, and any extras).
 *   4. Re-serializes `frontmatter + body` via {@link serializeFrontmatter}
 *      and writes through {@link writeWikiPageWithSideEffects} so the
 *      index, cross-references, and activity log all stay consistent.
 *
 * THE WIRE CONTRACT, FOR EVERY CALLER INCLUDING THE SERVICE TOKEN (DW-194).
 * `If-Match` is REQUIRED. It carries the version of the WHOLE stored file —
 * YAML frontmatter block included, not just the body this request sends —
 * quoted as a strong validator, exactly as `formatIfMatch` produces it:
 *
 *     If-Match: "w1:1a-0f3c…"
 *
 * The version is what `GET /api/workbench/preview` serves and what a previous
 * successful `PUT` answered with. Three outcomes:
 *
 *   - absent, `*`, unquoted, weak, or a list → 428, `{ error }` carrying
 *     `WRITE_PRECONDITION_REQUIRED_COPY`; nothing is written.
 *   - present but not the stored file's version → 412, `{ error }` carrying
 *     `WRITE_CONFLICT_COPY`; nothing is written.
 *   - matching → the write and all its side effects run, and the response
 *     carries the NEW version, so a caller can save again without a re-read.
 *
 * THIS HANDLER HAS NO UNCONDITIONAL PATH — and the claim stops there. A machine
 * caller holding the service bearer token gets the same three answers from THIS
 * verb on THIS route that a browser does, because a guard a caller opts out of
 * by omitting a header is not a guard; so an automated writer that wants to
 * `PUT` a body must read the page (or keep the version its last write answered)
 * before it saves. It is NOT a claim about what that caller can do elsewhere:
 * the same token still rewrites this page's frontmatter through {@link PATCH}
 * below with no header at all, and its body through the MCP tools, which call
 * `writeWikiPageWithSideEffects` and `patchMetadata` directly. DW-194 gated one
 * verb on one path; the rest is unchanged and is listed in `src/middleware.ts`.
 *
 * `/api/wiki/<slug>` authenticates IN-ROUTE rather than at the middleware gate,
 * which is why that file states the requirement beside the exemption too: the
 * list of in-route-auth paths is where a non-browser caller looks first.
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug: encodedSlug } = await params;
    const slug = decodeSlug(encodedSlug);

    // Deployment read-only, answered BEFORE the body is parsed and before the
    // page is read. Identical for every slug, so it leaks nothing about what
    // exists. The Preview route consults the SAME `isReadOnly()` when it decides
    // `editable`, so the owner is never offered `Edit` for a page this refuses.
    if (isReadOnly()) {
      return NextResponse.json(
        { error: READ_ONLY_REFUSAL.pageEdit },
        { status: 403 },
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "invalid JSON body" },
        { status: 400 },
      );
    }

    const newBody =
      body && typeof body === "object" && "content" in body
        ? (body as { content: unknown }).content
        : undefined;

    if (typeof newBody !== "string" || newBody.trim().length === 0) {
      return NextResponse.json(
        { error: "content must be a non-empty string" },
        { status: 400 },
      );
    }

    // Attribution comes from the authenticated session, never the body.
    const principal = (await getPrincipal()) ?? getServicePrincipal(req);
    const authorStr = principal?.handle;

    // FRESH (DW-195). These bytes are the merge base AND the precondition's
    // left-hand side. `pageCache` is module-global and ref-counted around bulk
    // scans, so a concurrent scan can hold a superseded entry open — checking
    // `If-Match` against that entry would refuse a save that matches the stored
    // file, or accept one against bytes that are already gone. A fresh read
    // neither consults nor mutates the cache.
    const existing = await readWikiPageWithFrontmatter(slug, { fresh: true });
    if (!existing) {
      return NextResponse.json(
        { error: `page not found: ${slug}` },
        { status: 404 },
      );
    }

    // Realm-aware write ACL. Denied → cloak: a private page the caller can't
    // read is 404 (no existence oracle); readable-but-unwritable is 403.
    if (!canWriteFrontmatter(existing.frontmatter, principal, "body")) {
      return canReadFrontmatter(existing.frontmatter, principal)
        ? NextResponse.json(
            {
              // Readable (the cloak ran first), so the resolver may state the
              // realm — and states it only where the realm gate applies.
              error: resolveWriteDenial("edit", existing.frontmatter, "body"),
            },
            { status: 403 },
          )
        : NextResponse.json(
            { error: `page not found: ${slug}` },
            { status: 404 },
          );
    }

    // THE WRITE PRECONDITION (DW-38, DW-51), against the bytes this route
    // ALREADY READ for its own frontmatter merge — no second read, no lock, no
    // new lock ordering. It sits AFTER the ACL cloak deliberately: a caller who
    // may not write this page must not learn its version, or whether it exists,
    // by comparing a 412 against a 404.
    //
    // The whole stored file is the merge base, YAML block included, which is
    // what `GET /api/workbench/preview` and the edit page both hash. That makes
    // a metadata-only `PATCH` by another actor refuse this body save too —
    // conservative by design: the frontmatter this request is about to merge is
    // exactly the frontmatter that changed underneath it.
    const precondition = checkWritePrecondition(
      req.headers.get(IF_MATCH_HEADER),
      contentVersion(existing.content),
    );
    if (!precondition.ok) {
      return NextResponse.json(
        { error: precondition.error },
        { status: precondition.status },
      );
    }

    // Derive title from the new body's first H1, falling back to the old title.
    const titleMatch = newBody.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : existing.title;

    // Strip the leading H1 (if present) before deriving the summary so the
    // heading text doesn't end up as the summary line.
    const bodyForSummary = newBody.replace(/^#\s+.+$/m, "").trim();
    const summary = extractSummary(bodyForSummary);

    // Merge frontmatter: preserve everything the existing page had, then
    // bump `updated` (and backfill `created` for legacy pages that predate
    // frontmatter entirely). Also append the editor to `contributors` if not
    // already present.
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const mergedFrontmatter: Frontmatter = { ...existing.frontmatter };
    if (
      typeof mergedFrontmatter.created !== "string" ||
      mergedFrontmatter.created === ""
    ) {
      mergedFrontmatter.created = today;
    }
    mergedFrontmatter.updated = today;

    // Track contributors: append the editor if they're not already listed.
    if (authorStr) {
      const existingContributors = Array.isArray(mergedFrontmatter.contributors)
        ? (mergedFrontmatter.contributors as string[])
        : [];
      if (!existingContributors.includes(authorStr)) {
        mergedFrontmatter.contributors = [...existingContributors, authorStr];
      }
    }

    const mergedContent = serializeFrontmatter(mergedFrontmatter, newBody);

    const result = await writeWikiPageWithSideEffects({
      slug,
      title,
      content: mergedContent,
      summary,
      logOp: "edit",
      // Use the user-visible body as the cross-ref signal so the YAML
      // block doesn't bias related-page matching.
      crossRefSource: newBody,
      author: authorStr,
      logDetails: (ctx) =>
        `edited · updated ${ctx.updatedSlugs.length} cross-ref(s)`,
    });

    // The version of what LANDED, so a surface that stays open can save again
    // without a reload. `mergedContent` is written verbatim by the lifecycle
    // pipeline (`writeWikiPage(slug, op.content, …)`) and the cross-ref step
    // touches OTHER pages, never this one — so this is the file's new content,
    // not a prediction of it.
    return NextResponse.json({
      ...result,
      version: contentVersion(mergedContent),
    });
  } catch (err) {
    // The gate above already answered for a deployment that was read-only when
    // the request arrived; this is the flag flipping mid-request, where the
    // kernel writer's refusal surfaces here instead. Without the branch the
    // `invalid slug` classifier below decides it, and a refusal naming
    // read-only would be answered as a 400 about the slug.
    if (isReadOnlyError(err)) {
      return NextResponse.json({ error: getErrorMessage(err) }, { status: 403 });
    }
    const message = getErrorMessage(err);
    const status = message.toLowerCase().startsWith("invalid slug") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

/**
 * PATCH /api/wiki/[slug]
 *
 * Update a wiki page's frontmatter metadata without replacing its body.
 * Accepts `{ metadata: Partial<Frontmatter>, author?: string }`.
 *
 * Allowed metadata keys: confidence, disputed, tags, aliases, expiry,
 * valid_from, supersedes. Lifecycle-managed keys (created, authors, sources)
 * are rejected with 400.
 *
 * On every successful PATCH the `updated` field is bumped to today. If an
 * `author` string is provided it is appended to `contributors` (deduplicated).
 *
 * Delegates to {@link patchMetadata} for the core logic.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug: encodedSlug } = await params;
    const slug = decodeSlug(encodedSlug);

    // Deployment read-only, answered before the body is parsed and before
    // `patchMetadata` reads the page. Same answer for every slug — no oracle.
    if (isReadOnly()) {
      return NextResponse.json(
        { error: READ_ONLY_REFUSAL.pageMetadata },
        { status: 403 },
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "invalid JSON body" },
        { status: 400 },
      );
    }

    if (!body || typeof body !== "object" || !("metadata" in body)) {
      return NextResponse.json(
        { error: "request body must contain a metadata object" },
        { status: 400 },
      );
    }

    const metadata = (body as { metadata: unknown }).metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return NextResponse.json(
        { error: "metadata must be a non-null object" },
        { status: 400 },
      );
    }

    // Attribution comes from the authenticated session, never the body.
    const principal = (await getPrincipal()) ?? getServicePrincipal(req);

    const result = await patchMetadata({
      slug,
      metadata: metadata as Record<string, unknown>,
      author: principal?.handle,
      principal,
    });

    return NextResponse.json(result);
  } catch (err) {
    // Mid-request flag flip: `patchMetadata` refuses at its top, and its error
    // carries no `code`, so the ladder below would answer 500.
    if (isReadOnlyError(err)) {
      return NextResponse.json({ error: getErrorMessage(err) }, { status: 403 });
    }
    const message = getErrorMessage(err);
    const code = (err as NodeJS.ErrnoException).code;
    let status = 500;
    if (code === "LIFECYCLE_FIELD") status = 400;
    else if (code === "NOT_OWNER") status = 403;
    else if (code === "NOT_FOUND") status = 404;
    else if (message.toLowerCase().startsWith("invalid slug")) status = 400;
    return NextResponse.json({ error: message }, { status });
  }
}
