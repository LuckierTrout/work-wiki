import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Workbench } from "@/components/workbench/Workbench";
import {
  WorkbenchDataProvider,
  type WorkbenchData,
} from "@/components/workbench/WorkbenchData";
import { SPLIT_WIDE_QUERY } from "@/lib/workbench-split";
import { setMediaQuery } from "../../../../vitest.setup.dom";

/**
 * The Workbench shell's off-canvas sheet, MOUNTED (DW-24).
 *
 * `workbench-chrome.test.ts` reads this component's source, so it can see that
 * an `aria-expanded` attribute is spelled and cannot see whether pressing the
 * trigger moves it — nor whether Esc returns focus, nor whether widening past
 * the breakpoint closes the sheet without stealing focus. Those are the four
 * behaviours here, all observed on the rendered DOM and `document.activeElement`.
 */

// ONE stable router object: several components in this shell key effects on
// the router identity, and a fresh literal per call would rebuild them on
// every re-render.
const { router } = vi.hoisted(() => ({ router: { refresh: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

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

beforeEach(() => {
  window.localStorage.clear();
  // `useSidecarStatus` probes the loopback port at mount. An affirmative answer
  // keeps the probe off the network and lets the resulting setState settle
  // inside `act`, so no suite here reports an act(...) warning.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true }) as unknown as Response),
  );
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's own `cleanup()` lands after this block. Unmounting here tears
  // the tree down while `fetch` is still stubbed, rather than against a
  // half-restored environment.
  cleanup();
  vi.unstubAllGlobals();
});

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
  const trigger = screen.getByRole("button", { name: "Modes" }) as HTMLButtonElement;
  const rail = screen.getByRole("navigation", { name: "Modes" });
  return { ...view, trigger, rail };
}

/**
 * The rail controls a browser would put in the tab order.
 *
 * The visibility question is asked of the DOM (`getClientRects()`), not
 * restated as a list of expected buttons — so a control the shell filters OUT
 * is one this helper also drops, and the wrap-point assertions below are about
 * the shell's cycle rather than about a hard-coded rail inventory.
 */
function railControls(rail: HTMLElement): HTMLElement[] {
  return Array.from(
    rail.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]"),
  ).filter((item) => item.getClientRects().length > 0);
}

/**
 * Press Tab, and report whether the shell PREVENTED the browser's own move.
 *
 * Where focus lands is only half the cycle. jsdom moves focus for nobody on a
 * synthetic keydown, so an assertion about `document.activeElement` is
 * satisfied by the handler's explicit `focus()` call alone — with or without
 * the `preventDefault()` beside it. A real browser, given an unprevented
 * press, honours that `focus()` and then walks on to the NEXT control in
 * source order: out of the rail, onto the canvas the backdrop has made
 * unclickable. That is the exact strand this cycle exists to prevent, and
 * `fireEvent`'s return value (`false` when a cancelable event was prevented)
 * is the only place it is observable here.
 */
function pressTab({ shiftKey = false } = {}): { prevented: boolean } {
  return { prevented: !fireEvent.keyDown(document, { key: "Tab", shiftKey }) };
}

/** Open the sheet and confirm the precondition the test then acts on. */
async function openSheet() {
  const shell = await renderShell();
  fireEvent.click(shell.trigger);
  expect(shell.trigger.getAttribute("aria-expanded")).toBe("true");
  // Opening moves focus into the rail, so a keyboard user is not left behind
  // the backdrop on controls they can no longer click.
  expect(shell.rail.contains(document.activeElement)).toBe(true);
  return shell;
}

describe("Workbench sheet", () => {
  it("starts closed and names the rail it controls", async () => {
    const { trigger, rail } = await renderShell();

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-controls")).toBe(rail.id);
    expect(document.activeElement).toBe(document.body);
  });

  it("closes on Esc and returns focus to the trigger", async () => {
    const { trigger } = await openSheet();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("closes when the backdrop is clicked", async () => {
    const { trigger, container } = await openSheet();

    const backdrop = container.querySelector(".wb-backdrop");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop as Element);

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".wb-backdrop")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes when the viewport widens past the breakpoint, without moving focus", async () => {
    const { trigger, rail } = await openSheet();
    const focused = document.activeElement;

    act(() => setMediaQuery(SPLIT_WIDE_QUERY, true));

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    // The trigger is `display: none` above the breakpoint, so restoring focus
    // to it would drop the keyboard user on <body>. Focus stays put.
    expect(document.activeElement).toBe(focused);
    expect(rail.contains(document.activeElement)).toBe(true);
  });

  it("pulls Tab back into the rail while the sheet is open", async () => {
    const { rail } = await openSheet();
    (document.activeElement as HTMLElement).blur();
    expect(rail.contains(document.activeElement)).toBe(false);

    const { prevented } = pressTab();

    // The open sheet's backdrop makes everything else unclickable, so focus
    // cycles inside the rail rather than walking out onto it.
    expect(rail.contains(document.activeElement)).toBe(true);
    expect(prevented).toBe(true);
  });

  it("wraps Tab off the LAST rail control round to the first", async () => {
    const { rail } = await openSheet();
    const items = railControls(rail);
    expect(items.length).toBeGreaterThan(1);
    items[items.length - 1].focus();

    const { prevented } = pressTab();

    // Not prevented, this walks onto the canvas the backdrop has made
    // unclickable — a keyboard user stranded on controls they cannot operate.
    expect(document.activeElement).toBe(items[0]);
    expect(prevented).toBe(true);
  });

  it("wraps Shift+Tab off the FIRST rail control round to the last", async () => {
    const { rail } = await openSheet();
    const items = railControls(rail);
    expect(items.length).toBeGreaterThan(1);
    items[0].focus();

    const { prevented } = pressTab({ shiftKey: true });

    expect(document.activeElement).toBe(items[items.length - 1]);
    expect(prevented).toBe(true);
  });

  it("does not let a hidden rail control become the wrap point", async () => {
    const { rail } = await openSheet();
    // The collapse chevron is the rail's last child and is hidden below 900px —
    // the only width at which the sheet exists at all. jsdom loads no
    // stylesheet, so the test hides it the one way the setup file's shim can
    // observe; the shell's own filter is `getClientRects().length > 0`.
    const buttons = Array.from(rail.querySelectorAll<HTMLElement>("button"));
    expect(buttons.length).toBeGreaterThan(1);
    const chevron = buttons[buttons.length - 1];
    expect(chevron.className).toContain("wb-rail-chevron");
    chevron.hidden = true;

    const visible = railControls(rail);
    expect(visible).not.toContain(chevron);
    const last = visible[visible.length - 1];
    last.focus();

    const { prevented } = pressTab();

    // Taken unfiltered, the hidden chevron would be `last`, this press would
    // match nothing, and focus would walk straight out of the rail.
    expect(document.activeElement).toBe(visible[0]);
    expect(prevented).toBe(true);
  });

  it("leaves focus alone when the trigger is no longer in the layout", async () => {
    const { trigger, rail } = await openSheet();
    const focused = document.activeElement;
    // Above the breakpoint the trigger is `display: none`. Focusing one is a
    // silent no-op in a browser that drops the keyboard user on <body>, so the
    // shell checks `offsetParent` before restoring.
    trigger.style.display = "none";

    fireEvent.keyDown(document, { key: "Escape" });

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(focused);
    expect(rail.contains(document.activeElement)).toBe(true);
  });

  it("closes and restores focus when a mode is chosen from the sheet", async () => {
    const { trigger, rail } = await openSheet();

    const mode = rail.querySelector<HTMLButtonElement>("button:not([aria-current])");
    // Guarded, so a rail that stops rendering an unselected mode fails HERE
    // rather than throwing on `click(null)` two lines down.
    expect(mode).not.toBeNull();
    fireEvent.click(mode as HTMLButtonElement);

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });
});
