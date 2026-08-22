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
import {
  PAGE_UNREADABLE_COPY,
  PAGE_UNREADABLE_STATUS,
  isPageUnreadableError,
} from "@/lib/page-read-failure";

/**
 * POST /api/lint/fix — auto-fix a lint issue.
 *
 * Supported issue types:
 * - `orphan-page`: adds the page to the wiki index. Reads `slug`.
 * - `stale-index`: removes a stale entry from the wiki index. Reads `slug`.
 * - `empty-page`: deletes an empty page entirely. Reads `slug`.
 * - `missing-crossref`: appends a cross-reference link to the source page. Reads `slug`, `targetSlug`.
 * - `broken-link`: removes the dead link to the target from the page, keeping its text. Reads `slug`, `targetSlug`.
 * - `contradiction`: rewrites the source page via LLM to resolve a conflict with the target. Reads `slug`, `targetSlug`, `message`.
 * - `missing-concept-page`: creates a stub page for the concept the message names, via LLM when a key is configured. Reads `message` ALONE — no `slug`, no `targetSlug`.
 * - `stale-page`: bumps the page's `expiry` forward and refreshes `valid_from`. Reads `slug`.
 * - `unmigrated-page`: fills in the missing work-wiki frontmatter defaults, overwriting nothing. Reads `slug`.
 * - `supersedes-dangling`: clears a `supersedes` pointer whose target is re-verified missing. Reads `slug`.
 *
 * That is the whole of `AUTO_FIXABLE_CHECK_TYPES` (`@/lib/lint-types`), and
 * `prose-inventory-parity.test.ts` reads this bullet list back and fails when
 * the two disagree — it was five entries long for a while, and it never named
 * `supersedes-dangling`, the very type DW-229 was about (DW-346). Every other
 * type in `ALL_CHECK_TYPES` is refused with an explanation from
 * `NOT_AUTO_FIXABLE`.
 *
 * The per-type arguments live in those bullets on purpose: stated down here
 * instead, they would be a second hand-copied inventory of the same ten types,
 * sitting outside the pin — which is the drift DW-346 filed, not a fix for it.
 *
 * Request body: `type` plus those fields. `slug` is the page being fixed,
 * `targetSlug` the page on the other end of the link or conflict, and `message`
 * the issue's own `message` string from the lint report — `missing-concept-page`
 * PARSES that string, so it must arrive verbatim in the `Concept "…" is
 * mentioned in …` form `checkMissingConceptPages` emits, or the fix answers 400.
 * Fields a type does not read are ignored.
 * ```json
 * { "type": "…", "slug": "source-page" }
 * { "type": "…", "slug": "source-page", "targetSlug": "target-page" }
 * { "type": "…", "message": "Concept \"vector search\" is mentioned in ingest, retrieval but has no dedicated page. Both describe it at length." }
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
    // A fix's page read is fresh since DW-379, so a non-ENOENT storage failure
    // now arrives here as a refusal rather than as `null` → `FixNotFoundError`.
    // Above the two error-class branches for the same reason the read-only one
    // is: it is neither bad input nor a missing page. 503 with the sentence the
    // wiki doors already answer — the page is not known to be absent, and the
    // fault is usually temporary. A genuinely absent page is still 404 below.
    if (isPageUnreadableError(error)) {
      return NextResponse.json(
        { error: PAGE_UNREADABLE_COPY },
        { status: PAGE_UNREADABLE_STATUS },
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
