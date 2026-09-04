// ---------------------------------------------------------------------------
// SourceBadge — shows where a setting value came from (env / config / default)
// ---------------------------------------------------------------------------

type SettingSource = "env" | "config" | "default" | "none";

/**
 * The rendered badges, by source — the ONLY place a source kind is described.
 *
 * A table rather than a branch per kind so the separator below can be written
 * exactly once (DW-714). Three `return (<>{" "}<span …>)` branches render the
 * same thing this does, but each carries its own copy of the space: deleting
 * one leaves the other two — and every suite — green, and a fourth source kind
 * added later starts with no separator at all. One separator, one span, and
 * the only thing a new kind supplies is its text and its classes.
 *
 * `"none"` has no entry: a source nobody can attribute renders nothing, and
 * contributes nothing to the label's accessible name either.
 */
const BADGES: Record<Exclude<SettingSource, "none">, { text: string; className: string }> = {
  env: {
    text: "from environment",
    className:
      "ml-2 inline-flex items-center rounded-full bg-blue-500/15 px-2 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-400",
  },
  config: {
    text: "from config",
    className:
      "ml-2 inline-flex items-center rounded-full bg-foreground/10 px-2 py-0.5 text-xs font-medium text-foreground/50",
  },
  default: {
    text: "default",
    className:
      "ml-2 inline-flex items-center rounded-full bg-foreground/10 px-2 py-0.5 text-xs font-medium text-foreground/40",
  },
};

/**
 * The badge opens with a REAL whitespace text node (DW-714).
 *
 * `ml-2` is visual spacing only: the accessible-name computation concatenates
 * the label's text nodes with nothing between them, so without the `{" "}` a
 * `SourceBadge`-bearing label on `/settings` is named "Modelfrom environment"
 * — one word to every screen reader, and unmatchable by the name a sighted
 * user would read out. The separator lives HERE rather than at the three call
 * sites in `ProviderForm` so that no present or future caller can omit it,
 * and it lives ONCE rather than once per branch so that no future source kind
 * can be added without it.
 */
export function SourceBadge({ source }: { source: SettingSource }) {
  const badge = source === "none" ? undefined : BADGES[source];
  if (!badge) return null;
  return (
    <>
      {" "}
      <span className={badge.className}>{badge.text}</span>
    </>
  );
}
