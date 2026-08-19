import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  LintFilterControls,
  checkTypeLabels,
} from "@/components/LintFilterControls";
import { LintIssueCard } from "@/components/LintIssueCard";
import { ALL_CHECK_TYPES } from "@/lib/lint-types";
import type { LintIssue } from "@/lib/types";

/**
 * Check-type parity between the lint library and the lint UI, MOUNTED.
 *
 * `LintFilterControls` used to declare its OWN `ALL_CHECK_TYPES` — a hand-copy
 * that fell three entries behind the library's list, so `uncited-claims`,
 * `supersedes-dangling` and `incomplete-coverage` existed as checks, shipped in
 * the API's Zod enum, and could never be toggled from the lint page (DW-75).
 * Nothing observed that: both halves compiled, and a missing toggle looks the
 * same as a check nobody wanted.
 *
 * The type union alone does not close this. `Record<LintIssue["type"], string>`
 * makes the LABEL map total at compile time, but a label is not a button — the
 * old component had all fourteen labels while rendering eleven toggles, because
 * what it MAPPED OVER was the short copy. So the assertion here is against the
 * rendered accessibility tree: one toggle actually in the document per entry of
 * the library's list, found by the accessible name a user would click.
 *
 * Mounted rather than a source scan for the same reason: a scan would pin that
 * the component imports the const, not that every entry reaches the DOM.
 */

afterEach(() => {
  cleanup();
});

/**
 * The three types the hand-copied list actually dropped (DW-75).
 *
 * Named individually, rather than folded into the roster-wide assertions above,
 * so a regression report says WHICH checks went dark instead of only that a
 * count moved.
 */
const HISTORICALLY_DROPPED: LintIssue["type"][] = [
  "uncited-claims",
  "supersedes-dangling",
  "incomplete-coverage",
];

/**
 * The type added by DW-76.
 *
 * Kept apart from `HISTORICALLY_DROPPED` because it was never in the hand-copy
 * to be dropped from — it did not exist. Conflating them would tell a future
 * reader that `disputed-page` was one of the checks the drift hid, which is a
 * different (and false) story about why this file exists.
 */
const NEWLY_ADDED: LintIssue["type"][] = ["disputed-page"];

function renderControls(enabled: Set<LintIssue["type"]> = new Set(ALL_CHECK_TYPES)) {
  return render(
    <LintFilterControls
      enabledChecks={enabled}
      onToggleCheck={vi.fn()}
      onSelectAll={vi.fn()}
      onClearAll={vi.fn()}
      severityFilter="all"
      onSeverityChange={vi.fn()}
      onRunLint={vi.fn()}
      loading={false}
    />,
  );
}

describe("lint check-type parity", () => {
  it("renders one labelled toggle per ALL_CHECK_TYPES entry", () => {
    renderControls();

    // `queryByRole`, not `getByRole`: the getter THROWS on a miss, so it would
    // never reach `expect` and the custom message naming the missing type could
    // not print. The whole point of asserting per-type is the diagnostic.
    const missing = ALL_CHECK_TYPES.filter(
      (type) =>
        screen.queryByRole("button", {
          name: `Toggle ${checkTypeLabels[type]} check`,
        }) === null,
    );

    expect(missing, `check types with no rendered toggle: ${missing.join(", ")}`)
      .toEqual([]);
  });

  it("renders no toggle that ALL_CHECK_TYPES does not name", () => {
    renderControls();

    // Matched on the toggle row's own `Toggle … check` aria-label shape rather
    // than on `aria-pressed`. `aria-pressed` happens to be unique to the check
    // toggles today, but it is the generic attribute for ANY toggle button — a
    // future "Show fixed issues" or "Group by page" control in this panel would
    // join the count and turn an extra-toggle regression into a pass.
    const rendered = screen
      .getAllByRole("button", { name: /^Toggle .+ check$/ })
      .map((button) => button.getAttribute("aria-label"));

    const expected = ALL_CHECK_TYPES.map(
      (type) => `Toggle ${checkTypeLabels[type]} check`,
    );
    expect([...rendered].sort()).toEqual([...expected].sort());
  });

  it.each([
    ...HISTORICALLY_DROPPED.map((type) => ["dropped by the hand-copy", type] as const),
    ...NEWLY_ADDED.map((type) => ["added by DW-76", type] as const),
  ])("is toggleable and on by default: %s — %s", (_origin, type) => {
    renderControls();

    expect(ALL_CHECK_TYPES).toContain(type);
    const toggle = screen.getByRole("button", {
      name: `Toggle ${checkTypeLabels[type]} check`,
    });
    // Enabled by default, i.e. a default lint run includes it.
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("reflects the enabled set, so a deselected check is visibly off", () => {
    renderControls(new Set(["disputed-page"]));

    expect(
      screen
        .getByRole("button", { name: "Toggle Disputed pages check" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Toggle Orphan pages check" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });
});

/**
 * `disputed-page` is human-resolved.
 *
 * `LintIssueCard` decides fixability from its own `fixableTypes` set, which is
 * NOT derived from `ALL_CHECK_TYPES` — so a new check type lands there as a
 * non-fixable issue by omission, silently. That default is the intended one
 * here (clearing `disputed` asserts a human reconciled the claims), but an
 * intended-by-omission behaviour is one careless `fixableTypes.add` away from
 * shipping a button that would call an endpoint guaranteed to 400.
 */
describe("a disputed-page issue offers no Fix button", () => {
  function renderCard() {
    return render(
      <ul>
        <LintIssueCard
          issue={{
            type: "disputed-page",
            slug: "contested-page",
            message: "Page is flagged disputed",
            severity: "warning",
            suggestion: "Clear the Disputed toggle in the page editor",
          }}
          isFixing={false}
          fixMessage={null}
          onFix={vi.fn()}
          hrefForSlug={(slug) => `/u/yopedia/${slug}`}
        />
      </ul>,
    );
  }

  it("links the slug so an owner can go and review the page", () => {
    renderCard();

    expect(
      screen.getByRole("link", { name: "contested-page" }).getAttribute("href"),
    ).toBe("/u/yopedia/contested-page");
  });

  it("renders no button at all, so no auto-fix can be triggered", () => {
    renderCard();

    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
