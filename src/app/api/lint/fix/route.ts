import { NextRequest, NextResponse } from "next/server";
import {
  fixLintIssue,
  FixValidationError,
  FixNotFoundError,
} from "@/lib/lint-fix";
import { getErrorMessage } from "@/lib/errors";
import { getPrincipal } from "@/lib/auth";
import { isOwnerHandle } from "@/lib/owner";
import { logger } from "@/lib/logger";
import { isReadOnly } from "@/lib/config";
import { READ_ONLY_REFUSAL, isReadOnlyError } from "@/lib/read-only";

/**
 * POST /api/lint/fix — auto-fix a lint issue.
 *
 * Supported issue types:
 * - `missing-crossref`: appends a cross-reference link to the source page.
 * - `orphan-page`: adds the page to the wiki index.
 * - `stale-index`: removes a stale entry from the wiki index.
 * - `empty-page`: deletes an empty page entirely.
 * - `contradiction`: rewrites the source page via LLM to resolve a conflict.
 *
 * Request body:
 * ```json
 * { "type": "missing-crossref", "slug": "source-page", "targetSlug": "target-page" }
 * { "type": "orphan-page", "slug": "page-slug" }
 * { "type": "stale-index", "slug": "page-slug" }
 * { "type": "empty-page", "slug": "page-slug" }
 * { "type": "contradiction", "slug": "page-a", "targetSlug": "page-b", "message": "..." }
 * ```
 */
export async function POST(req: NextRequest) {
  try {
    // Lint fixes mutate pages — owner-only.
    const principal = await getPrincipal();
    if (!isOwnerHandle(principal?.handle)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Deployment read-only (DW-187). Answered after the owner gate and before
    // `fixLintIssue`, because this door meets the rule's SECOND half:
    // `fixContradiction` and `fixMissingConceptPage` each run a `callLLM`
    // rewrite before touching the page, so a kernel-only refusal would pay for
    // a model call whose output is then thrown away — and an LLM failure would
    // answer 500 in place of the refusal. (The first half does not apply: no
    // fix commits an irreversible side effect ahead of its write.)
    if (isReadOnly()) {
      return NextResponse.json(
        { error: READ_ONLY_REFUSAL.lintFix },
        { status: 403 },
      );
    }

    const body = await req.json();
    const { type, slug, targetSlug, message } = body;

    const result = await fixLintIssue(type, slug, targetSlug, message);
    return NextResponse.json(result);
  } catch (error) {
    // Mid-request flag flip. Ordered above the two error-class branches: a
    // `ReadOnlyError` is neither the caller's bad input nor a missing page.
    if (isReadOnlyError(error)) {
      return NextResponse.json(
        { error: getErrorMessage(error) },
        { status: 403 },
      );
    }
    if (error instanceof FixValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof FixNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    logger.error("lint", "Lint fix error", error);
    return NextResponse.json(
      {
        error: getErrorMessage(error),
      },
      { status: 500 },
    );
  }
}
