import { NextRequest, NextResponse } from "next/server";
import { reingest } from "@/lib/ingest";
import { readWikiPageWithFrontmatter } from "@/lib/wiki";
import { getPrincipal, getServicePrincipal } from "@/lib/auth";
import { canReadFrontmatter, canWriteFrontmatter } from "@/lib/authz";
import { getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { isReadOnly } from "@/lib/config";
import { READ_ONLY_REFUSAL, isReadOnlyError } from "@/lib/read-only";

export async function POST(request: NextRequest) {
  try {
    const principal = (await getPrincipal()) ?? getServicePrincipal(request);
    if (!principal) {
      return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    }

    // Deployment read-only (DW-187). Answered here — AFTER the 401 and before
    // the page is read — so an unauthenticated caller still learns it is
    // unauthenticated, which is the ordering `DELETE /api/ingest/history` and
    // every `/api/ingest/*` door use. The property that matters is unchanged:
    // this lands before `reingest()` re-fetches the source URL and runs its two
    // LLM calls. The kernel writer would refuse the write at the end of all that
    // anyway; a fetch or model failure along the way would answer 500 in place
    // of the refusal, and the calls would have been paid for either way. It is
    // still ahead of the page read, so it is no existence oracle.
    if (isReadOnly()) {
      return NextResponse.json(
        { error: READ_ONLY_REFUSAL.reingest },
        { status: 403 },
      );
    }
    const body = await request.json();
    const { slug } = body;

    if (!slug || typeof slug !== "string" || slug.trim().length === 0) {
      return NextResponse.json(
        { error: "slug is required and must be a non-empty string" },
        { status: 400 },
      );
    }

    const trimmedSlug = slug.trim();

    // Check if page exists
    const page = await readWikiPageWithFrontmatter(trimmedSlug);
    if (!page) {
      return NextResponse.json(
        { error: `Page "${trimmedSlug}" not found` },
        { status: 404 },
      );
    }

    // Realm-aware write ACL: re-ingest rewrites the page. Denied → cloak: a
    // private page the caller can't read is 404 (no existence oracle); a
    // readable-but-unwritable page is 403.
    if (!canWriteFrontmatter(page.frontmatter, principal, "body")) {
      return canReadFrontmatter(page.frontmatter, principal)
        ? NextResponse.json(
            { error: "You don't have permission to re-ingest this page." },
            { status: 403 },
          )
        : NextResponse.json(
            { error: `Page "${trimmedSlug}" not found` },
            { status: 404 },
          );
    }

    // Check if page has a source_url
    const sourceUrl = page.frontmatter.source_url;
    if (typeof sourceUrl !== "string" || sourceUrl.trim() === "") {
      return NextResponse.json(
        { error: "Cannot re-ingest: no source URL recorded on this page" },
        { status: 422 },
      );
    }

    // Re-synthesize directly (admin/low-traffic — kept synchronous).
    const result = await reingest(trimmedSlug, {
      author: principal.handle,
      triggeredBy: principal.handle,
    });
    return NextResponse.json(result);
  } catch (error) {
    // Backstop for a flag that flipped mid-request: the kernel writer's refusal
    // is a 403, not a server error.
    if (isReadOnlyError(error)) {
      return NextResponse.json(
        { error: getErrorMessage(error) },
        { status: 403 },
      );
    }
    logger.error("ingest", "Re-ingest error", error);
    return NextResponse.json(
      { error: getErrorMessage(error) },
      { status: 500 },
    );
  }
}
