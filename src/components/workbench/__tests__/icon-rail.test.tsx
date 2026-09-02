import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { IconRail, type IconRailProps } from "@/components/workbench/IconRail";
import { Workbench } from "@/components/workbench/Workbench";
import {
  WorkbenchDataProvider,
  type WorkbenchData,
} from "@/components/workbench/WorkbenchData";
import {
  BADGE_MODE_NOUNS,
  WORKBENCH_MODES,
  badgeAccessibleName,
} from "@/lib/workbench-modes";
import type { SidecarStatus } from "@/lib/sidecar";

/**
 * The 48px icon rail, MOUNTED (DW-109) — the component whose OWN rules nothing
 * asserted. `workbench-sheet.test.tsx` and `workbench-mode-url.test.tsx` both
 * reach the rail's output as part of the shell they drive (its tab cycle, its
 * mode buttons), but neither asks anything about the badge, the status dot or
 * the chevron's labels, which is what this file is for.
 *
 * Three of those rules are invisible to a source scan and to the eye alike: a
 * badge's accessible NAME (not its digit) is what a screen-reader user gets, a
 * live region announces CONTENT rather than an `aria-label`, and the collapse
 * chevron's `aria-controls` has to resolve to the column it actually moves.
 * Each is asserted on the rendered DOM here, and the last one against the real
 * shell, because only the shell owns `data-collapsed`.
 *
 * The mode INVENTORY comes from `workbench-modes` — which modes exist, their
 * labels, and which of them carry a badge noun — so a mode renamed or a noun
 * moved cannot leave a loop here quietly asserting nothing. The expected
 * accessible names are then spelled out as literals beside those imports on
 * purpose: deriving them from `badgeAccessibleName` alone would only assert
 * that the component calls the same function this file does. The three sidecar
 * sentences are literals because they have no module to import from — they are
 * written inline in `IconRail.tsx` itself, so pinning them here is the only
 * place they are held at all.
 *
 * The rail's THREE remaining rules were added later (DW-257). Every case above
 * mounts `settingsActive: false`, and every one of them leaves `onSelect` and
 * `onToggleSettings` as `BASE`'s inert stubs (the chevron case drives its own
 * `onToggleCollapsed` spy, and that control alone): "exactly one control is
 * ever `aria-current`" had no mount that could see the suppression, the ten
 * `onSelect` wirings reported to a stub that remembered nothing, and UX-DR3's
 * order was asserted only as an array in `workbench-modes.test.ts` — never as
 * the sequence the rail actually renders.
 */

// ONE stable router object: several components in this shell key effects on the
// router identity, and a fresh literal per call would rebuild them.
const { router } = vi.hoisted(() => ({ router: { refresh: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const RAIL_ID = "icon-rail-under-test";
const LEFT_ID = "left-column-under-test";

const BASE: IconRailProps = {
  id: RAIL_ID,
  leftColumnId: LEFT_ID,
  mode: "wiki",
  onSelect: () => {},
  onToggleSettings: () => {},
  settingsActive: false,
  collapsed: false,
  onToggleCollapsed: () => {},
  sidecar: "unknown",
};

beforeEach(() => {
  window.localStorage.clear();
  // `useSidecarStatus` probes the loopback port at mount (shell tests only). An
  // affirmative answer keeps the probe off the network and lets the resulting
  // setState settle inside `act`, so nothing here reports an act(...) warning.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true }) as unknown as Response),
  );
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's own `cleanup()` lands after this block. Unmounting here tears
  // the tree down while `fetch` is still stubbed.
  cleanup();
  vi.unstubAllGlobals();
});

function mountRail(overrides: Partial<IconRailProps> = {}) {
  const view = render(<IconRail {...BASE} {...overrides} />);
  return { ...view, rail: screen.getByRole("navigation", { name: "Modes" }) };
}

/** The badge pill a mode button renders, or `null` when it renders none. */
function badgeOf(button: HTMLElement): HTMLElement | null {
  return button.querySelector<HTMLElement>(".wb-rail-badge");
}

describe("the count badge", () => {
  it("shows no pill and the plain label while the counted set is empty", () => {
    // DESIGN.md `badge-count`: a zero pill is noise, and its accessible name
    // would announce a set the owner has no reason to open.
    const { rail } = mountRail({ todoCount: 0, reviewCount: 0 });

    for (const [id, noun] of Object.entries(BADGE_MODE_NOUNS)) {
      const mode = WORKBENCH_MODES.find((item) => item.id === id);
      expect(mode).toBeTruthy();
      const control = screen.getByRole("button", { name: mode!.label });
      expect(badgeOf(control)).toBeNull();
      // …and the name is the bare label, with nothing said about `noun`.
      expect(control.getAttribute("aria-label")).toBe(mode!.label);
      expect(control.getAttribute("aria-label")).not.toContain(noun);
    }
    expect(rail.querySelectorAll(".wb-rail-badge")).toHaveLength(0);
  });

  it("names the count and its noun once the set is not empty", () => {
    const { rail } = mountRail({ todoCount: 3, reviewCount: 62 });

    const todos = screen.getByRole("button", {
      name: badgeAccessibleName("Todos", 3, BADGE_MODE_NOUNS.todos!),
    });
    const review = screen.getByRole("button", {
      name: badgeAccessibleName("Review", 62, BADGE_MODE_NOUNS.review!),
    });
    // UX-DR21: never colour-and-digit alone — the count reaches a screen reader
    // through the button's own name.
    expect(todos.getAttribute("aria-label")).toBe("Todos, 3 todo candidates");
    expect(review.getAttribute("aria-label")).toBe("Review, 62 pending reviews");

    // The pill itself is decorative: the name above already carries the number,
    // and an unhidden pill would announce the digit a second time.
    const pill = badgeOf(todos);
    expect(pill).not.toBeNull();
    expect(pill!.textContent).toBe("3");
    expect(pill!.getAttribute("aria-hidden")).toBe("true");
    expect(badgeOf(review)!.textContent).toBe("62");
    // Exactly the two badge modes carry one.
    expect(rail.querySelectorAll(".wb-rail-badge")).toHaveLength(2);
  });

  it("leaves every un-badged mode without a pill, whatever the counts are", () => {
    // `COUNTS` is keyed by mode id, so a mode with no counted set has nothing to
    // read — and must not borrow another mode's number.
    mountRail({ todoCount: 3, reviewCount: 62 });

    for (const mode of WORKBENCH_MODES) {
      if (BADGE_MODE_NOUNS[mode.id]) continue;
      const control = screen.getByRole("button", { name: mode.label });
      expect(badgeOf(control)).toBeNull();
      expect(control.getAttribute("aria-label")).toBe(mode.label);
    }
    // The un-badged case named in the matrix, spelled out rather than only
    // swept: Sources sits directly beneath a badge mode in the rail.
    expect(badgeOf(screen.getByRole("button", { name: "Sources" }))).toBeNull();
  });
});

describe("the sidecar dot", () => {
  const CASES: ReadonlyArray<[SidecarStatus, string, boolean]> = [
    ["unknown", "Checking sidecar", false],
    ["up", "Sidecar running", true],
    ["down", "Sidecar not running", false],
  ];

  for (const [sidecar, label, live] of CASES) {
    it(`announces "${label}" as CONTENT when the probe says ${sidecar}`, () => {
      mountRail({ sidecar });

      const status = screen.getByRole("status");
      // A live region announces content mutations, not attribute changes: an
      // empty span whose only text is an `aria-label` says nothing at all when
      // the sidecar comes up. So the sentence must be real (clipped) text.
      expect(status.textContent).toBe(label);
      expect(status.getAttribute("title")).toBe(label);
      expect(status.getAttribute("aria-label")).toBeNull();
      // "unknown" is not "up": the dot goes live only on an affirmative probe,
      // so it never promises a sidecar that has not answered.
      expect(status.classList.contains("wb-status--live")).toBe(live);
    });
  }
});

describe("the collapse chevron", () => {
  it("says it will collapse, and names the column, while the column is open", () => {
    mountRail({ collapsed: false });

    const chevron = screen.getByRole("button", { name: "Collapse left column" });
    expect(chevron.getAttribute("title")).toBe("Collapse left column");
    expect(chevron.getAttribute("aria-expanded")).toBe("true");
    // `aria-expanded` with nothing named is a state without a subject.
    expect(chevron.getAttribute("aria-controls")).toBe(LEFT_ID);
  });

  it("flips both labels and aria-expanded once the column is collapsed", () => {
    mountRail({ collapsed: true });

    const chevron = screen.getByRole("button", { name: "Expand left column" });
    expect(chevron.getAttribute("title")).toBe("Expand left column");
    expect(chevron.getAttribute("aria-expanded")).toBe("false");
    expect(chevron.getAttribute("aria-controls")).toBe(LEFT_ID);
    expect(screen.queryByRole("button", { name: "Collapse left column" })).toBeNull();
  });

  it("asks its owner to toggle, exactly once per press", () => {
    const onToggleCollapsed = vi.fn();
    mountRail({ onToggleCollapsed });

    fireEvent.click(screen.getByRole("button", { name: "Collapse left column" }));

    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });
});

describe("the one current control (DW-257)", () => {
  it("marks Settings, and un-marks the mode, while Settings is showing", () => {
    // Asserted as a COUNT over the whole rail rather than as two independent
    // attribute checks: a rail that marked BOTH a mode and Settings is exactly
    // the state two separate `toBe("page")` assertions would let through, and
    // two current controls describe two surfaces the owner cannot both be
    // looking at.
    const { rail } = mountRail({ settingsActive: true, mode: "wiki" });

    const current = rail.querySelectorAll("[aria-current]");
    expect(current).toHaveLength(1);
    const settings = screen.getByRole("button", { name: "Settings" });
    expect(current[0]).toBe(settings);
    // The count is queried value-agnostically ABOVE, which is what catches a
    // second current control; the VALUE is pinned here, because `page` is the
    // literal other suites in this repo select the current rail control by.
    expect(settings.getAttribute("aria-current")).toBe("page");
    // And the class goes with the attribute, because colour is the other half
    // of the same claim: Settings announcing itself current with no active wash
    // also loses its forced-colours outline.
    expect(settings.classList.contains("wb-rail-item--active")).toBe(true);

    // The mode, meanwhile, is remembered but not SHOWING — neither half.
    const wiki = screen.getByRole("button", { name: "Wiki" });
    expect(wiki.getAttribute("aria-current")).toBeNull();
    expect(wiki.classList.contains("wb-rail-item--active")).toBe(false);
  });

  it("marks the mode, and only the mode, while Settings is closed", () => {
    // Deliberately NOT the first mode: `BASE` mounts `mode: "wiki"`, which is
    // also `WORKBENCH_MODES[0]`, so a rail that marked the first button
    // whatever `mode` said would pass on this file's fixture alone.
    const { rail } = mountRail({ settingsActive: false, mode: "graph" });

    const current = rail.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    const graph = screen.getByRole("button", { name: "Graph" });
    expect(current[0]).toBe(graph);
    expect(graph.classList.contains("wb-rail-item--active")).toBe(true);
    // Nothing else in the rail carries the attribute in ANY value — Settings
    // included, which is the direction the case above cannot see.
    expect(rail.querySelectorAll("[aria-current]")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Settings" }).getAttribute("aria-current"),
    ).toBeNull();
  });
});

describe("what each control reports to its owner (DW-257)", () => {
  it("reports each mode's OWN id, once per press", () => {
    // Ten buttons wired `onSelect(item.id)` from inside one `.map` all break
    // the same way — a hoisted `item`, a stale closure, an id read from the
    // wrong end of the row — and they break for NINE of the ten while the
    // fixture's own mode still looks right. So every button is pressed and the
    // ids are read back as a sequence, sourced from `WORKBENCH_MODES` so a
    // renamed mode cannot leave this loop asserting nothing.
    const onSelect = vi.fn();
    const onToggleSettings = vi.fn();
    const onToggleCollapsed = vi.fn();
    mountRail({ onSelect, onToggleSettings, onToggleCollapsed });

    for (const mode of WORKBENCH_MODES) {
      fireEvent.click(screen.getByRole("button", { name: mode.label }));
    }

    expect(onSelect).toHaveBeenCalledTimes(WORKBENCH_MODES.length);
    expect(onSelect.mock.calls.map(([id]) => id)).toEqual(
      WORKBENCH_MODES.map((mode) => mode.id),
    );
    // …and a mode press reaches the mode router ONLY. The three callbacks are
    // adjacent props of one component, so every case in this describe asserts
    // both directions: what the control called, and what it left alone.
    expect(onToggleSettings).not.toHaveBeenCalled();
    expect(onToggleCollapsed).not.toHaveBeenCalled();
  });

  it("toggles Settings without selecting a mode", () => {
    const onSelect = vi.fn();
    const onToggleSettings = vi.fn();
    const onToggleCollapsed = vi.fn();
    mountRail({ onSelect, onToggleSettings, onToggleCollapsed });

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(onToggleSettings).toHaveBeenCalledTimes(1);
    // Settings is deliberately NOT a mode — `WORKBENCH_MODES` is the rail's ten
    // — so a press of it must never reach the mode router, which would push a
    // mode into the URL for a surface that is not one.
    expect(onSelect).not.toHaveBeenCalled();
    expect(onToggleCollapsed).not.toHaveBeenCalled();
  });

  it("collapses the column without selecting or toggling Settings", () => {
    // The chevron's own count is pinned in "the collapse chevron" above; what
    // is pinned HERE is that it is not cross-wired to either neighbour. It sits
    // directly beneath Settings in the same `wb-rail-item` family, so a handler
    // attached to the wrong button is a one-line edit that leaves the rendered
    // rail identical.
    const onSelect = vi.fn();
    const onToggleSettings = vi.fn();
    const onToggleCollapsed = vi.fn();
    mountRail({ onSelect, onToggleSettings, onToggleCollapsed });

    fireEvent.click(screen.getByRole("button", { name: "Collapse left column" }));

    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onToggleSettings).not.toHaveBeenCalled();
  });
});

describe("the rail's order (UX-DR3)", () => {
  it("stacks ten modes, the spacer, the dot, Settings and the chevron, in that order", () => {
    // UX-DR3 in full: "ten modes above a flexible spacer, then the sidecar
    // status dot, Settings, and the left-column collapse chevron".
    //
    // Read off `rail.children` rather than off `.wb-rail-item`, because the
    // spacer is what PUTS the tail controls at the bottom of the column and it
    // carries no `wb-rail-item` class — queried by that class, a spacer moved
    // below Settings (or deleted outright, which pins all four tail controls to
    // the top of the rail) leaves the sequence identical. Every child is
    // therefore named, by whatever it is: the two non-buttons by role, the rest
    // by the accessible name they already publish.
    const { rail } = mountRail();

    const order = Array.from(rail.children).map((child) =>
      child.classList.contains("wb-rail-spacer")
        ? "(spacer)"
        : child.getAttribute("role") === "status"
          ? "(sidecar dot)"
          : child.getAttribute("aria-label"),
    );

    // `workbench-modes.test.ts` pins what the mode order IS; this pins that the
    // rendered rail is in it — invisible to a source scan, since a `.map` over
    // a re-sorted array changes nothing a grep can see.
    expect(order).toEqual([
      ...WORKBENCH_MODES.map((mode) => mode.label),
      "(spacer)",
      "(sidecar dot)",
      "Settings",
      "Collapse left column",
    ]);
  });
});

describe("the chevron against the real shell", () => {
  const DATA: WorkbenchData = {
    wikis: [],
    currentWikiId: null,
    registryUnavailable: false,
    knowledge: [],
    knowledgeUnavailable: false,
    files: [],
    filesUnavailable: false,
    filesTruncated: false,
    dataVersion: 0,
    readOnly: false,
  };

  async function renderShell() {
    const view = render(
      <WorkbenchDataProvider value={DATA}>
        <Workbench>
          <p>canvas</p>
        </Workbench>
      </WorkbenchDataProvider>,
    );
    // Flush the sidecar probe's promise chain before any assertion runs.
    await act(async () => {});
    return view;
  }

  it("moves the shell's data-collapsed and points at the column it moved", async () => {
    // The rail owns the control and the shell owns the state, so "the chevron
    // collapses the left column" is a claim neither file can answer alone.
    const { container } = await renderShell();
    const shell = container.querySelector(".wb-shell") as HTMLElement;
    expect(shell.getAttribute("data-collapsed")).toBe("false");

    const chevron = screen.getByRole("button", { name: "Collapse left column" });
    // The id resolves to the real column, not to a name nothing answers to.
    const column = document.getElementById(chevron.getAttribute("aria-controls")!);
    expect(column).not.toBeNull();
    expect(column!.classList.contains("wb-left")).toBe(true);

    fireEvent.click(chevron);

    expect(shell.getAttribute("data-collapsed")).toBe("true");
    // The same control now offers the way back, and says so.
    const expand = screen.getByRole("button", { name: "Expand left column" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(expand);

    expect(shell.getAttribute("data-collapsed")).toBe("false");
  });
});
