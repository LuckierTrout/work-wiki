import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TreePanel, type TreePanelProps } from "@/components/workbench/TreePanel";
import {
  TREE_TABS,
  buildFileTree,
  type KnowledgeGroup,
} from "@/lib/workbench-tree";

/**
 * The left column's keyboard surface, MOUNTED (DW-469) — the decision
 * `TreePanel`'s docblock argues for, executed.
 *
 * That docblock chooses platform semantics over the ARIA tree pattern: nested
 * `<ul>`s of native `<button>` rows in document order, `aria-expanded`
 * disclosures, `aria-current` on the selection, and NO roving `tabindex` and no
 * arrow-key handling — because the half of a real ARIA tree that matters is
 * what a screen reader ANNOUNCES as you arrow through it, and no suite in this
 * repo can ask that question. What the docblock also concedes is that the OTHER
 * half is executable, and nothing executed it: every claim it makes about focus
 * — both tabs in the tab order, every row natively focusable, the panel itself
 * focusable, the arrows left to the page — was held by prose alone.
 *
 * So this file pins the ABSENCE. Adding `tabIndex={-1}` to the rows, or an
 * `onKeyDown` that collapses a disclosure on ArrowLeft, is a small,
 * plausible-looking first step toward a real ARIA tree: focus machinery with
 * nothing driving it, and the second tab reachable by nothing at all. Every
 * case below goes red on exactly that edit, and none of them can be satisfied
 * by a source scan — an attribute that is not written is not a string a grep
 * can find.
 *
 * It is NOT a licence to add the missing half. The docblock's decision stands;
 * these cases record it.
 *
 * TWO things are asserted of every key press, because either alone is
 * satisfied by an interception. `preventDefault` is what would kill the
 * BROWSER's own response (a caret move, a scroll), and `stopPropagation` is
 * what would kill the PAGE's — a shortcut listening at `document` — just as
 * dead while leaving `defaultPrevented` false. So the sweep watches from
 * `document` and asserts the event both arrived there and arrived uncancelled.
 *
 * The panel is mounted DIRECTLY rather than through the shell, because the
 * question is the component's own and the shell would only supply state the
 * assertions then have to reach around. The tab inventory comes from
 * `TREE_TABS` so a renamed tab cannot leave the sweeps below looping over
 * nothing.
 */

const KNOWLEDGE: readonly KnowledgeGroup[] = [
  {
    id: "note",
    label: "Notes",
    count: 2,
    pages: [
      { slug: "alpha", title: "Alpha", type: "note" },
      { slug: "beta", title: "Beta", type: "note" },
    ],
  },
  {
    id: "meeting",
    label: "Meetings",
    count: 1,
    pages: [{ slug: "standup", title: "Standup", type: "meeting" }],
  },
];

/**
 * A NESTED tree, not a flat list: depth is where a roving `tabindex` would
 * first have somewhere to rove to. `raw/` is empty on purpose — an empty
 * directory renders a static `<span>` rather than a control, so it is the one
 * row that is legitimately not focusable and must still carry no `tabindex`.
 */
const FILES = buildFileTree(["wiki/alpha.md", "wiki/deep/inner.md", "raw/"]);

const BASE: TreePanelProps = {
  tab: "knowledge",
  onTabChange: () => {},
  knowledge: KNOWLEDGE,
  files: FILES,
  hasWiki: true,
  selection: null,
  onSelect: () => {},
};

/**
 * Every key an ARIA tree or a tablist would claim. Home and End are in the set
 * because they are the pattern's "first / last node" pair, and a component that
 * left the arrows alone but swallowed those would still have taken keys the
 * page's own scrolling owns.
 */
const NAVIGATION_KEYS = [
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
] as const;

afterEach(() => {
  // FIRST, as every mounted suite here does: the setup file's own `cleanup()`
  // runs last (vitest reverses `afterEach` registration), so unmounting here
  // tears the tree down inside the environment it actually ran in.
  cleanup();
});

function mountTree(overrides: Partial<TreePanelProps> = {}) {
  const view = render(<TreePanel {...BASE} {...overrides} />);
  return { ...view, panel: screen.getByRole("tabpanel") };
}

/** Every row the tree renders — buttons and the static empty-directory span. */
function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".wb-tree-row"));
}

/**
 * A row by the text in its label span, rather than by accessible name: a group
 * row's name also carries its count and a chevron, and a query that spelled
 * those out would fail for a reason that has nothing to do with focus.
 */
function rowByLabel(text: string): HTMLElement {
  const match = rows().find(
    (row) => row.querySelector(".wb-tree-label")?.textContent === text,
  );
  expect(match, `no tree row labelled "${text}"`).toBeDefined();
  return match as HTMLElement;
}

/** Is there a row with this label at all? (Used for "the closed list is gone".) */
function hasRow(text: string): boolean {
  return rows().some(
    (row) => row.querySelector(".wb-tree-label")?.textContent === text,
  );
}

/** Every disclosure's state, as one comparable value. */
function disclosures(): Array<[string, string | null]> {
  return Array.from(document.querySelectorAll<HTMLElement>("[aria-expanded]")).map(
    (element) => [
      element.querySelector(".wb-tree-label")?.textContent ?? "",
      element.getAttribute("aria-expanded"),
    ],
  );
}

/** Every tab's selected state, as one comparable value. */
function selectedStates(): Array<string | null> {
  return screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-selected"));
}

function unselectedTab(): HTMLElement {
  const match = screen
    .getAllByRole("tab")
    .find((tab) => tab.getAttribute("aria-selected") === "false");
  expect(match).toBeDefined();
  return match as HTMLElement;
}

/**
 * Press every navigation key on `target` and report what the DOCUMENT saw.
 *
 * The listener is the point. `fireEvent`'s own return value only reports
 * `preventDefault`, so a row that called `stopPropagation()` — which kills a
 * page-level shortcut exactly as dead — would look untouched. `reached` is what
 * actually bubbled out of the tree; `prevented` is what was cancelled on the
 * way. Both are compared against the full key set by the callers.
 */
function pressNavigationKeys(target: HTMLElement): {
  reached: string[];
  prevented: string[];
} {
  const reached: string[] = [];
  const prevented: string[] = [];
  const watch = (event: Event) => reached.push((event as KeyboardEvent).key);
  document.addEventListener("keydown", watch);
  try {
    for (const key of NAVIGATION_KEYS) {
      if (!fireEvent.keyDown(target, { key })) prevented.push(key);
    }
  } finally {
    document.removeEventListener("keydown", watch);
  }
  return { reached, prevented };
}

/**
 * The whole assertion, run against one element: the keys reach the page
 * uncancelled, focus stays where it was, and no disclosure moved.
 */
function expectKeysPassThrough(target: HTMLElement): void {
  target.focus();
  expect(document.activeElement).toBe(target);
  const openBefore = disclosures();
  const selectedBefore = selectedStates();

  const { reached, prevented } = pressNavigationKeys(target);

  expect(reached).toEqual([...NAVIGATION_KEYS]);
  expect(prevented).toEqual([]);
  // Nothing re-focused, nothing disclosed, nothing re-selected: in an ARIA tree
  // or an automatic-activation tablist, each of those is what the same press
  // would have done.
  expect(document.activeElement).toBe(target);
  expect(disclosures()).toEqual(openBefore);
  expect(selectedStates()).toEqual(selectedBefore);
}

describe("both tabs stay in the tab order", () => {
  it("renders them as native buttons carrying no tabindex at all", () => {
    mountTree({ tab: "knowledge" });

    const tablist = screen.getByRole("tablist", { name: "Left column trees" });
    const controls = screen.getAllByRole("tab");
    expect(controls.map((tab) => tab.textContent)).toEqual(
      TREE_TABS.map((entry) => entry.label),
    );

    for (const control of controls) {
      expect(tablist.contains(control)).toBe(true);
      // A real `<button>`, so the browser gives it the keyboard behaviour this
      // component never writes: Enter, Space and a place in the tab order.
      expect(control.tagName).toBe("BUTTON");
      // The tablist pattern would put `tabindex="-1"` on the unselected tab and
      // rove it with the arrow keys. There is no arrow-key handling here on
      // purpose, so a roving index would leave the second tab reachable by
      // nothing at all — which is the docblock's stated reason for this.
      expect(control.hasAttribute("tabindex")).toBe(false);
    }

    // …and the UNSELECTED tab really does take focus, which a missing attribute
    // on its own does not prove.
    const unselected = unselectedTab();
    unselected.focus();
    expect(document.activeElement).toBe(unselected);
  });
});

describe("no roving tabindex anywhere in the tree", () => {
  for (const entry of TREE_TABS) {
    it(`leaves every row on the ${entry.id} tab natively focusable`, () => {
      const { panel } = mountTree({ tab: entry.id });

      const treeRows = rows();
      // The fixture has to actually put rows on this tab, or the sweep below
      // asserts nothing against an empty-state paragraph.
      expect(treeRows.length).toBeGreaterThan(2);

      for (const element of [...treeRows, ...screen.getAllByRole("tab")]) {
        expect(element.hasAttribute("tabindex")).toBe(false);
      }

      // The one `tabindex` this component DOES write: the scroll container is
      // focusable so a keyboard user can scroll a long tree without first
      // landing on a row inside it. Asserted the same way as everything else
      // here — the attribute AND the focus, since a missing attribute on its
      // own does not prove the other direction either.
      expect(panel.getAttribute("tabindex")).toBe("0");
      panel.focus();
      expect(document.activeElement).toBe(panel);

      // Each button row takes focus by itself, in document order — which is the
      // order the browser's own Tab already walks, and the whole of the
      // navigation this component ships.
      const buttons = treeRows.filter((row) => row.tagName === "BUTTON");
      expect(buttons.length).toBeGreaterThan(0);
      for (const button of buttons) {
        button.focus();
        expect(document.activeElement).toBe(button);
      }
    });
  }
});

describe("the navigation keys are the page's, not the tree's", () => {
  it("passes every key through from a knowledge disclosure, a page row and the panel", () => {
    const onSelect = vi.fn();
    const onTabChange = vi.fn();
    const { panel } = mountTree({ onSelect, onTabChange });

    // A DISCLOSURE row, because collapsing on ArrowLeft / expanding on
    // ArrowRight is the first step every ARIA-tree implementation takes and the
    // one a page-row-only sweep cannot see. A page row, because that is where a
    // roving focus move would land. And the PANEL itself, because it is the
    // sole `tabindex` holder — a container-level `onKeyDown` on `.wb-tree-body`
    // would swallow keys for everything inside it at once.
    expectKeysPassThrough(rowByLabel("Notes"));
    expectKeysPassThrough(rowByLabel("Alpha"));
    expectKeysPassThrough(panel);

    expect(onSelect).not.toHaveBeenCalled();
    expect(onTabChange).not.toHaveBeenCalled();
  });

  it("passes every key through from a Files-tab directory row and file row", () => {
    // The other tab renders through `FileRows`, a different component with its
    // own disclosure and its own rows: nothing the knowledge sweep asserts
    // reaches it.
    const onSelect = vi.fn();
    const { panel } = mountTree({ tab: "files", onSelect });

    expectKeysPassThrough(rowByLabel("wiki/"));
    expectKeysPassThrough(rowByLabel("inner.md"));
    expectKeysPassThrough(panel);

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("passes every key through from a focused tab", () => {
    const onTabChange = vi.fn();
    mountTree({ onTabChange });

    expectKeysPassThrough(unselectedTab());

    // An automatic-activation tablist would have selected the tab the arrow
    // landed on; `expectKeysPassThrough` has already checked that neither tab's
    // `aria-selected` moved, and this is the same claim from the owner's side.
    expect(onTabChange).not.toHaveBeenCalled();
  });
});

describe("click is what activates", () => {
  it("switches tabs on click, reporting the tab's OWN id", () => {
    // The positive half of the negative every case above asserts: with no
    // `onTabChange` call anywhere in this file, a tab whose `onClick` had been
    // dropped entirely would satisfy all of them.
    const onTabChange = vi.fn();
    mountTree({ onTabChange });

    const other = TREE_TABS.find((entry) => entry.id !== BASE.tab);
    expect(other).toBeDefined();

    fireEvent.click(screen.getByRole("tab", { name: other!.label }));

    expect(onTabChange).toHaveBeenCalledTimes(1);
    expect(onTabChange).toHaveBeenCalledWith(other!.id);
  });

  it("toggles a knowledge disclosure and selects a page", () => {
    const onSelect = vi.fn();
    mountTree({ onSelect });

    const group = rowByLabel("Notes");
    expect(group.getAttribute("aria-expanded")).toBe("true");
    const listId = group.getAttribute("aria-controls");
    expect(listId).not.toBeNull();
    expect(document.getElementById(listId!)).not.toBeNull();

    fireEvent.click(group);

    expect(group.getAttribute("aria-expanded")).toBe("false");
    // Closed means GONE rather than merely marked, so the reference goes with
    // the list: a dangling `aria-controls` is reported as a broken relationship
    // rather than a closed one.
    expect(group.getAttribute("aria-controls")).toBeNull();
    expect(hasRow("Alpha")).toBe(false);
    // The sibling group is untouched — `closed` is keyed per row, not a single
    // "the tree is collapsed" flag.
    expect(rowByLabel("Meetings").getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(group);

    expect(group.getAttribute("aria-expanded")).toBe("true");
    expect(hasRow("Alpha")).toBe(true);

    fireEvent.click(rowByLabel("Alpha"));

    // Its OWN payload: every page row in the group is wired from inside one
    // `.map`, so a row reporting a sibling's slug is the failure this catches.
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith({ kind: "page", slug: "alpha" });
  });

  it("toggles a nested directory disclosure and selects a file", () => {
    const onSelect = vi.fn();
    mountTree({ tab: "files", onSelect });

    const dir = rowByLabel("deep/");
    expect(dir.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(dir);

    expect(dir.getAttribute("aria-expanded")).toBe("false");
    expect(hasRow("inner.md")).toBe(false);
    // The directory ABOVE it stays open: the ids are chained through the parent
    // list, and closing a child must not fold its ancestor.
    expect(rowByLabel("wiki/").getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(dir);

    fireEvent.click(rowByLabel("inner.md"));

    // The full path, not the name the row shows — the Preview reads bytes by
    // path, and two files named `inner.md` in different directories are the
    // reason the payload cannot be the label.
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith({
      kind: "file",
      path: "wiki/deep/inner.md",
    });

    // An empty directory gets no control at all — a disclosure that expands to
    // nothing is a button with no effect to observe — so it is the one row here
    // that is legitimately not focusable, and it carries no `tabindex` to make
    // it one either.
    const empty = rowByLabel("raw/");
    expect(empty.tagName).toBe("SPAN");
    expect(empty.hasAttribute("tabindex")).toBe(false);
  });
});
