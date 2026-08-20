import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  LintFilterControls,
  checkTypeLabels,
} from "@/components/LintFilterControls";
import { LintIssueCard } from "@/components/LintIssueCard";
import {
  ALL_CHECK_TYPES,
  AUTO_FIXABLE_CHECK_TYPES,
} from "@/lib/lint-types";
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
 * Named on its own, rather than left to the roster-wide assertions below,
 * because the REASON matters: clearing `disputed` asserts a human reconciled the
 * conflicting claims, so this card must stay button-less even though every
 * mechanism around it makes adding a fix easy.
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

/**
 * Fixability parity between `fixLintIssue` and the card, MOUNTED.
 *
 * `LintIssueCard` used to decide fixability from its OWN nine-entry
 * `fixableTypes` set. `supersedes-dangling` became auto-fixable in
 * `@/lib/lint-fix` (`fixSupersededDangling`) and the copy never learned it, so
 * that issue rendered with no Fix button at all and the only way to clear a
 * dangling reference was to call the API by hand (DW-229). Nothing observed it,
 * for the same reason DW-75 went unobserved: a missing button and a check nobody
 * can fix look identical.
 *
 * Both halves now read `AUTO_FIXABLE_CHECK_TYPES` and `tsc` closes the
 * dispatcher against it — but a const import is not a button, exactly as a total
 * label map was not a toggle. So the assertion is again against the rendered
 * tree: one button per fixable type, zero for the rest, iterated from the
 * library's lists rather than any literal restated here.
 */

const HUMAN_ONLY_CHECK_TYPES = ALL_CHECK_TYPES.filter(
  (type) => !(AUTO_FIXABLE_CHECK_TYPES as readonly string[]).includes(type),
);

function renderIssue(overrides: Partial<LintIssue> & Pick<LintIssue, "type">) {
  const issue: LintIssue = {
    slug: "some-page",
    severity: "warning",
    // Satisfies `missing-concept-page`'s message precondition; every other type
    // ignores the message when deciding fixability.
    message: 'Concept "Widgets" is mentioned in some-page but has no dedicated page.',
    target: "other-page",
    ...overrides,
  };
  return {
    issue,
    onFix: (() => {
      const onFix = vi.fn();
      render(
        <ul>
          <LintIssueCard
            issue={issue}
            isFixing={false}
            fixMessage={null}
            onFix={onFix}
            hrefForSlug={(slug) => `/u/yopedia/${slug}`}
          />
        </ul>,
      );
      return onFix;
    })(),
  };
}

describe("lint fixability parity", () => {
  it.each(AUTO_FIXABLE_CHECK_TYPES)(
    "offers a Fix button that reaches onFix: %s",
    (type) => {
      const { issue, onFix } = renderIssue({ type });

      const button = screen.getByRole("button");
      fireEvent.click(button);

      expect(onFix).toHaveBeenCalledWith(issue, "other-page");
      // That each label is the type's OWN — not the generic "Fix" fallback a
      // missing entry would produce — is the distinctness case three tests
      // down. Asserting `textContent` is truthy here would not show it: "Fix"
      // is truthy, and so is every other string the button could hold.
    },
  );

  it.each(HUMAN_ONLY_CHECK_TYPES)(
    "renders no button at all, so no auto-fix can be triggered: %s",
    (type) => {
      renderIssue({ type });

      expect(screen.queryAllByRole("button")).toHaveLength(0);
    },
  );

  it("draws every fixable type a distinct, non-generic label", () => {
    const labels = AUTO_FIXABLE_CHECK_TYPES.map((type) => {
      renderIssue({ type });
      const text = screen.getByRole("button").textContent;
      cleanup();
      return text;
    });

    // A type whose label were missing would fall back to "Fix", which
    // `missing-crossref` legitimately uses — so the tell is a DUPLICATE, not the
    // word itself.
    expect(new Set(labels).size).toBe(AUTO_FIXABLE_CHECK_TYPES.length);
  });

  /**
   * The card's extra preconditions (`LintIssueCard.tsx`), which are NOT part of
   * the fixable set: three types need a `target` and one needs a parseable
   * message, because `POST /api/lint/fix` would 400 without them. Pinned here so
   * deriving the set from `AUTO_FIXABLE_CHECK_TYPES` cannot quietly drop them.
   */
  it.each(["missing-crossref", "contradiction", "broken-link"] as const)(
    "withholds the button when the target it would post is absent: %s",
    (type) => {
      renderIssue({ type, target: undefined });

      expect(screen.queryAllByRole("button")).toHaveLength(0);
    },
  );

  it("withholds the button when a missing-concept-page message is unparseable", () => {
    renderIssue({
      type: "missing-concept-page",
      message: "Coverage looks thin around widgets.",
    });

    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
