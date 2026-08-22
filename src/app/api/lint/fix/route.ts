import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  autoFixRefusal,
  fixLintIssue,
  FixValidationError,
  FixNotFoundError,
} from "@/lib/lint-fix";
import { AUTO_FIXABLE_CHECK_TYPES } from "@/lib/lint-types";
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
 * The request contract. `type` is the fixable set, not `ALL_CHECK_TYPES`: the
 * five other check types have no handler, and refusing them here is the whole
 * point of the gate.
 *
 * `slug` is OPTIONAL because `missing-concept-page` reads `message` alone (see
 * the route's own bullet for it below), and every handler that does need a slug already answers
 * "Missing required field: slug" for an absent one — a message far more useful
 * than a schema's. `targetSlug`/`message` are optional for the same reason.
 * Unknown keys are stripped rather than rejected, so an older client sending an
 * extra field is not broken by this gate.
 */
const LINT_FIX_REQUEST = z.object({
  type: z.enum(AUTO_FIXABLE_CHECK_TYPES),
  slug: z.string().optional(),
  targetSlug: z.string().optional(),
  message: z.string().optional(),
});

/** Name the field the schema tripped on, so a caller can fix its own request. */
function fieldMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  const field = issue?.path.join(".");
  return field
    ? `Invalid request field \`${field}\`: ${issue.message}`
    : "Invalid request body: expected a JSON object";
}

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
 *
 * The body is SCHEMA-CHECKED before any of it reaches `fixLintIssue` (DW-348).
 * This door used to destructure `await req.json()` and hand the pieces straight
 * to the dispatcher, so `type` was whatever JSON the caller sent and
 * `lint-fix.ts`'s `ownEntry` — an own-property lookup with a `typeof` guard —
 * was the only thing between a POST and the handler table. It held, but it is a
 * defense of last resort in a module the door does not own; the door now states
 * its own contract, and a `type` outside `AUTO_FIXABLE_CHECK_TYPES` never
 * reaches the dispatcher at all.
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

    // Parsed AFTER both gates above: a non-owner is told "Forbidden" and a
    // read-only deployment its refusal, neither of which depends on the body
    // being well-formed.
    //
    // `.catch(() => null)` because `req.json()` throws on a body that is not
    // JSON at all, and that is a 400 like any other malformed request — the
    // generic catch below would have logged it and answered 500.
    const raw: unknown = await req.json().catch(() => null);
    const parsed = LINT_FIX_REQUEST.safeParse(raw);
    if (!parsed.success) {
      // Let the raw `type` explain itself where it can. A recognized-but-not-
      // fixable type has an explanation written for a human ("Disputed pages
      // cannot be auto-fixed. Reconcile … PATCH /api/wiki/<slug> …"), and that
      // sentence is the reason this route existed to answer 400 in the first
      // place — a schema message naming `type` would be a regression on the
      // wire. `autoFixRefusal` answers `null` only for a FIXABLE type, i.e.
      // when some other field is what failed, which is exactly when the
      // schema's own message is the useful one.
      const record =
        typeof raw === "object" && raw !== null
          ? (raw as Record<string, unknown>)
          : null;
      const rawSlug = record?.slug;
      const refusal =
        record?.type === undefined
          ? null
          : autoFixRefusal(
              record.type,
              typeof rawSlug === "string" ? rawSlug : "",
            );

      return NextResponse.json(
        { error: refusal ?? fieldMessage(parsed.error) },
        { status: 400 },
      );
    }

    const { type, slug, targetSlug, message } = parsed.data;
    const result = await fixLintIssue(type, slug ?? "", targetSlug, message);
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
