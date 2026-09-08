/**
 * Pure, client-safe helpers for recognizing agent handles. Split out of
 * `agents.ts` (which pulls in the server storage layer) so client components
 * — e.g. `UserLink` — can tell an agent author from a human without bundling
 * the server. `agents.ts` re-exports these for existing server importers.
 */

/** The default agent name every user gets (the canonical "yoyo"). */
export const DEFAULT_AGENT_NAME = "yoyo";

/**
 * True when an author/actor handle denotes an agent rather than a human.
 * Agents appear as the composite id `<owner>--<name>` (e.g. `yuanhao--yoyo`)
 * or, in some legacy attributions, as the bare agent name (`yoyo`). Used to
 * mark agent contributions distinctly across the UI — never to fold agents
 * into the human contributor list (or to link them to a `/u/<handle>` profile).
 */
export function isAgentHandle(handle: string | null | undefined): boolean {
  if (!handle) return false;
  return (
    handle.includes("--") ||
    handle === DEFAULT_AGENT_NAME ||
    handle.endsWith(`--${DEFAULT_AGENT_NAME}`)
  );
}

/**
 * Non-human automation authors: the seed/system placeholder, the auto-linter,
 * and the platform seed identity. They aren't people and shouldn't appear as
 * their own contributors — their edits are part of the agent's autonomous
 * upkeep, so {@link normalizeActor} folds them into the agent ("yoyo").
 */
const AUTOMATION_ACTORS = new Set(["system", "lint-fix", "yopedia"]);

/** True when a handle is a non-human automation actor (seed/system/linter). */
export function isAutomationActor(handle: string | null | undefined): boolean {
  return !!handle && AUTOMATION_ACTORS.has(handle.trim().toLowerCase());
}

/**
 * Normalize an author/actor for attribution: automation actors (system, the
 * linter, the platform seed) are credited to the agent ("yoyo") so the
 * contributor list reads as the real people plus the agent, not a scatter of
 * one-off system handles. Real human/agent handles pass through unchanged.
 */
export function normalizeActor(handle: string): string {
  return isAutomationActor(handle) ? DEFAULT_AGENT_NAME : handle;
}

/**
 * Reduce a handle to the HUMAN behind it: an agent id `<user>--<name>`
 * collapses to `<user>`; a plain human handle passes through unchanged.
 *
 * Answers "which HUMAN is this?" — the question workspace GUIDANCE asks, since
 * a Workspace Purpose and a Names & Terms dictionary belong to a person, not to
 * each of that person's agents. `ownerToTenant` (`links.ts`) answers the
 * different question "which STORAGE SILO is this?" and deliberately keeps the
 * `--<agent>` suffix, so an agent's pages, dedup guards and attribution stay
 * exactly where they are written today.
 *
 * PURE and handle-level: the result is the raw human SEGMENT, NOT slugified —
 * downstream addressing (`ownerToTenant`/`tenantForOwner`) does its own
 * normalization, and slugifying here would repoint guidance for handles that
 * resolve correctly today (`alice_smith` → `alice-smith`, a non-CJK unicode
 * handle → `""`). Callers that want a COMPARISON key (e.g. `sameHumanOwner`)
 * slugify at their own comparison site.
 *
 * A handle with no USABLE human prefix passes through WHOLE rather than
 * reducing. That covers two shapes:
 *
 *  - Nothing before the first `--`, or nothing but whitespace (`--yoyo`,
 *    `" --yoyo"`, `--`). Reducing would yield an empty or blank principal, and
 *    `ownerToTenant` collapses both onto the DEFAULT tenant — silently
 *    handing the DEFAULT silo's Purpose and dictionary to a caller that named
 *    no human at all. Passing the handle through keeps it addressing its own
 *    tenant, exactly as it does today. Blank is checked, not just empty,
 *    precisely because `ownerToTenant` trims before it decides.
 *  - No `--` at all — which includes a bare legacy agent handle (`"yoyo"`) and
 *    an automation actor (`"system"`, `"lint-fix"`, `"yopedia"`). Neither
 *    carries a recoverable human: `"yoyo"` names an agent without saying
 *    whose, and {@link normalizeActor} mints it from automation actors that
 *    have no person behind them. They are returned unchanged and address their
 *    own tenant, exactly as they do today — deliberately, since inventing a
 *    human for them is not possible.
 *
 * This is why {@link isAgentHandle} and this function recognize DIFFERENT sets:
 * `isAgentHandle` asks "is this an agent?" and so accepts all three agent
 * spellings (`<user>--<name>`, the bare `yoyo`, `*--yoyo`), while this function
 * asks the narrower "which human owns it?" and can only answer for the first.
 */
export function humanOwnerOf(handle: string): string {
  const i = handle.indexOf("--");
  if (i <= 0) return handle;
  const human = handle.slice(0, i);
  return human.trim() === "" ? handle : human;
}
