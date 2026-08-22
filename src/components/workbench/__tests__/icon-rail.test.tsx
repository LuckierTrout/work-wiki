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
