/**
 * Shared Graph + Chat internal-link fixture. Both surfaces must normalize
 * these spellings through `extractAllInternalTargets`.
 */
export const INTERNAL_LINK_FIXTURE =
  "See [[Foo Bar]] and [Leaf](leaf.md) and [[old-name#section]].";

export const INTERNAL_LINK_TARGETS = ["leaf", "foo-bar", "old-name"] as const;
