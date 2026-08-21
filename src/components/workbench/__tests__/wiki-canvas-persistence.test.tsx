import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WikiWorkbench } from "@/components/WikiWorkbench";
import { Workbench } from "@/components/workbench/Workbench";
import {
  WorkbenchDataProvider,
  type WorkbenchData,
} from "@/components/workbench/WorkbenchData";
import type { WikiRecord } from "@/lib/wikis";

/**
 * The Wiki canvas SURVIVES a mode switch (DW-26), MOUNTED.
 *
 * `ModeCanvas` used to return the Wiki subtree OR a stub subtree, so clicking
 * Chat destroyed `WikiWorkbench` — and with it an open Create Wiki dialog, the
 * name the owner had typed into it and the error it was showing. Coming back
 * built an empty card. Nothing a source scan can see: the defect is what React
 * does to a subtree that stops being rendered, so every assertion here is made
 * on the live document across a real rail click.
 *
 * Hiding is not closing, and that distinction is the whole design.
 * `CreateWikiDialog` resets its fields when `open` goes false, so flipping
 * `open` to hide the dialog would discard the very draft this preserves — the
 * subtree stays open and goes behind `hidden` instead.
 *
 * COVERAGE LIMIT: jsdom has no layout engine and applies no user-agent
 * stylesheet, so `hidden` here is an ATTRIBUTE and nothing more — nothing in
 * this file can observe pixels. What it can observe is the contract the
 * attribute carries (the a11y tree, via testing-library's `hidden`-aware
 * queries) and the document state a hidden dialog must not be holding
 * (`document.body.style.overflow`, the Tab trap), which is precisely the half
 * `hidden` does NOT deliver on its own. The `display: none` rule that backs it
 * is pinned in `globals.css` and read there by the assertion at the end.
 */

// ONE stable router object: several components in this shell key effects on the
// router identity, and a fresh literal per call would rebuild them on every
// re-render.
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

/** An id percent-encoding CHANGES, matching the other Wiki suites. */
const WIKI: WikiRecord = {
  id: "wiki 1/2",
  name: "Acme",
  scenario: "business",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  router.refresh.mockClear();
  window.localStorage.clear();
  // jsdom's session history outlives `cleanup()`, and `selectMode` writes
  // `?mode=` into it — so each test starts on a bare `/` rather than on
  // whatever mode the last one left in the URL, which `initialMode` would
  // otherwise restore.
  window.history.pushState(null, "", "/");
  window.history.replaceState(null, "", "/");
  // `useSidecarStatus` probes the loopback port at mount; the card's create
  // POSTs. One stub answers both, and no assertion here reads it.
  fetchMock = vi.fn(
    async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response,
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's own `cleanup()` lands after this block. Unmounting here tears
  // the tree down while `fetch` is still stubbed.
  cleanup();
  vi.unstubAllGlobals();
  document.body.style.overflow = "";
});

/** The assembled shell, exactly as `page.tsx` composes it. */
async function renderShell(data: WorkbenchData = DATA) {
  const view = render(
    <WorkbenchDataProvider value={data}>
      <Workbench>
        <WikiWorkbench />
      </Workbench>
    </WorkbenchDataProvider>,
  );
  // Flush the sidecar probe's promise chain before any assertion runs.
  await act(async () => {});
  return view;
}

/** A rail control, by its accessible name. */
function rail(label: string): HTMLButtonElement {
  return screen.getByRole("button", { name: label }) as HTMLButtonElement;
}

/**
 * The Create Wiki dialog's name field, found WITHOUT the a11y tree.
 *
 * `getByLabelText` skips `hidden` subtrees, which is exactly what the visible
 * cases below rely on — so the hidden cases have to reach the node another way
 * or they could not tell "removed from the a11y tree" apart from "unmounted",
 * which is the one distinction this file exists for.
 */
function nameFieldNode(): HTMLInputElement | null {
  const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
  return dialog?.querySelector("input") ?? null;
}

/**
 * Open Create Wiki from the empty state and type a name into it.
 *
 * The opener is FOCUSED before it is clicked, which is what a pointer or
 * keyboard activation actually does — `fireEvent.click` alone leaves
 * `document.activeElement` on `<body>`, so `useDialogA11y` would record the
 * body as the opener and every focus-restore assertion below would be about
 * nothing.
 */
function openCreateWith(name: string): HTMLButtonElement {
  const opener = screen.getByRole("button", { name: "Create Wiki" }) as HTMLButtonElement;
  opener.focus();
  fireEvent.click(opener);
  fireEvent.change(screen.getByLabelText("Wiki name"), { target: { value: name } });
  return opener;
}

/** Focus a rail control and click it, the way an owner switching surfaces does. */
function clickRail(label: string): HTMLButtonElement {
  const control = rail(label);
  control.focus();
  fireEvent.click(control);
  return control;
}

describe("an open Create Wiki dialog survives a mode switch (DW-26)", () => {
  it("keeps the typed name and the shown error across Chat and back", async () => {
    // The error has to be REAL — set by a refused create rather than typed into
    // a prop — because it lives in `WikiWorkbench`'s state and the name lives in
    // `CreateWikiDialog`'s. A fixture that only checked the name would pass
    // against a card that was rebuilt from scratch with the dialog reopened.
    // Routed by URL, not queued with `mockResolvedValueOnce`: `useSidecarStatus`
    // probes the loopback port at mount, so a one-shot answer is spent on the
    // probe and the create sees the default `{}` — which fails for a different
    // reason and would let this pass against the wrong sentence.
    fetchMock.mockImplementation(async (url: unknown) =>
      String(url) === "/api/wikis"
        ? ({
            ok: false,
            status: 409,
            json: async () => ({ error: "A wiki with that name already exists." }),
          } as unknown as Response)
        : ({ ok: true, status: 200, json: async () => ({}) } as unknown as Response),
    );
    await renderShell();
    openCreateWith("Quarterly review");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toBe(
      "A wiki with that name already exists.",
    );

    fireEvent.click(rail("Chat"));
    await act(async () => {});
    fireEvent.click(rail("Wiki"));
    await act(async () => {});

    // Same dialog, same draft, same failure — not a fresh one seeded with the
    // template's default name.
    expect(screen.getByRole("dialog", { name: "Create Wiki" })).toBeTruthy();
    expect((screen.getByLabelText("Wiki name") as HTMLInputElement).value).toBe(
      "Quarterly review",
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "A wiki with that name already exists.",
    );
  });

  it("is HIDDEN rather than unmounted while another mode is showing", async () => {
    await renderShell();
    openCreateWith("Quarterly review");

    fireEvent.click(rail("Chat"));
    await act(async () => {});

    // Out of the accessibility tree: testing-library's default queries respect
    // `hidden`, so a dialog behind it is unreachable by role and by label — the
    // same thing a screen reader and a Tab press see.
    expect(screen.queryByRole("dialog", { name: "Create Wiki" })).toBeNull();
    // By ROLE, not by label: `queryByLabelText` walks the DOM and knows nothing
    // about the accessibility tree, so it finds a hidden field and would report
    // this as a failure whichever way the fix went. The role queries are the
    // ones that resolve `hidden` up the ancestor chain.
    expect(screen.queryByRole("textbox", { name: "Wiki name" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Wiki" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
    // …but still in the DOCUMENT, holding the draft. This is what tells hiding
    // apart from the unmount that was the defect: an unmounted dialog has no
    // node to find at all.
    expect(nameFieldNode()?.value).toBe("Quarterly review");
    // And the attribute that does it, on the wrapper the stylesheet's rule
    // names — not on the dialog, which must stay `open`.
    const wrapper = document.querySelector(".wb-canvas-mode");
    expect(wrapper?.hasAttribute("hidden")).toBe(true);
    expect(wrapper?.contains(nameFieldNode())).toBe(true);
  });

  it("holds neither the body scroll lock nor the Tab trap while hidden", async () => {
    await renderShell();
    openCreateWith("Quarterly review");
    // The lock is real while the dialog is on screen — a positive control, so
    // the negative below cannot pass because the lock was never taken.
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.click(rail("Chat"));
    await act(async () => {});

    // `hidden` removes the pixels and the a11y tree entry, and NOTHING that the
    // dialog did to the document: the scroll lock and the capture-phase Tab
    // listener both outlive it unless the hook stands down.
    expect(document.body.style.overflow).toBe("");

    // Tab is not trapped. The trap is a capture-phase listener that calls
    // `preventDefault` and pulls focus back into the dialog; with it armed over
    // a hidden surface, the keyboard user is stuck on a canvas they cannot see.
    const railButton = rail("Graph");
    railButton.focus();
    const tab = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    railButton.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(railButton);

    // …and coming back re-arms both.
    fireEvent.click(rail("Wiki"));
    await act(async () => {});
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("keeps the opener across the hide, so closing lands where the owner left it", async () => {
    // The focus round trip, end to end. The hook re-arms when the surface comes
    // back, and its arming branch reads `document.activeElement` — which at that
    // moment is the rail control the owner just clicked, not the button that
    // opened the dialog. Recapturing there is silent: the dialog looks right,
    // the draft is intact, and closing it drops the keyboard on the rail.
    await renderShell();
    const opener = openCreateWith("Quarterly review");
    const dialog = screen.getByRole("dialog", { name: "Create Wiki" });
    // Opening focuses the dialog container, so the title is announced before
    // the button cluster.
    expect(document.activeElement).toBe(dialog);

    // HIDING must not move focus. The owner put it on the rail themselves, and
    // the recorded opener is inside the subtree that just went off screen —
    // "restoring" to it would push the keyboard into hidden content.
    const chat = clickRail("Chat");
    await act(async () => {});
    expect(document.activeElement).toBe(chat);

    // RE-SHOWING focuses the dialog again, exactly as opening it did.
    clickRail("Wiki");
    await act(async () => {});
    expect(document.activeElement).toBe(
      screen.getByRole("dialog", { name: "Create Wiki" }),
    );

    // …and CLOSING returns focus to the control that opened the dialog — still
    // mounted, because this card is not optimistic — rather than to the rail
    // button that merely hid it.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => {});
    expect(screen.queryByRole("dialog", { name: "Create Wiki" })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("never puts a second #wb-canvas on the page, in any mode", async () => {
    // `CANVAS_ID` is the skip link's target (`SiteChrome` renders
    // `<a href="#wb-canvas">`), and rendering the Wiki subtree in every mode is
    // exactly the change that could have grown a second section to hold it —
    // which would give the link two targets and leave the browser to pick.
    const { container } = await renderShell();

    for (const mode of ["Wiki", "Chat", "Graph", "Wiki"]) {
      fireEvent.click(rail(mode));
      await act(async () => {});
      expect(container.querySelectorAll("#wb-canvas")).toHaveLength(1);
      expect(container.querySelectorAll(".wb-canvas")).toHaveLength(1);
    }
  });

  it("shows exactly one surface heading at a time", async () => {
    // The stub subtree stays UNMOUNTED under Wiki: it holds no state to lose,
    // and rendering it would put a second "Wiki" heading in the document beside
    // the card's own — the reason only one of the two branches is conditional.
    await renderShell({ ...DATA, wikis: [WIKI], currentWikiId: WIKI.id });

    expect(screen.getAllByRole("heading", { name: "Wiki" })).toHaveLength(1);

    fireEvent.click(rail("Chat"));
    await act(async () => {});
    // The Wiki heading went off screen with its subtree; Chat's is the only one
    // a reader can reach.
    expect(screen.queryByRole("heading", { name: "Wiki" })).toBeNull();
    expect(screen.getAllByRole("heading", { name: "Chat" })).toHaveLength(1);
  });

  it("backs the attribute with a stylesheet rule the layout cannot defeat", async () => {
    // jsdom loads no stylesheet and applies no user-agent sheet, so nothing
    // ABOVE can see a pixel — `hidden` is an attribute here and the a11y-tree
    // half is all the mounted assertions reach. The `display: none` that makes
    // it a visual withdrawal is a UA default that ANY author rule setting
    // `display` on the same element beats, and this wrapper sits deep inside a
    // grid where such a rule is one restyle away. So the rule is stated in
    // `globals.css`, with the attribute in its selector, and read here from the
    // real file rather than restated.
    const css = await readFile(
      path.resolve(__dirname, "../../../app/globals.css"),
      "utf8",
    );
    expect(css).toMatch(/\.wb-canvas-mode\[hidden\] \{\s*display: none;\s*\}/);
    // Outside every media query: the subtree is withdrawn at all three widths.
    // A rule wrapped in `@media (min-width: …)` would put the hidden canvas —
    // dialog, draft and all — back on screen wherever the wrapper missed.
    const before = css
      .slice(0, css.indexOf(".wb-canvas-mode[hidden] {"))
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const depth =
      (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length;
    expect(depth).toBe(0);
  });

  it("labels the canvas with whichever heading is actually on screen", async () => {
    // `aria-labelledby` pointing at a hidden node names the section after
    // something no reader can reach. It has to move with the branch.
    const { container } = await renderShell();
    const canvas = () => container.querySelector("#wb-canvas") as HTMLElement;

    expect(canvas().getAttribute("aria-labelledby")).toBe("wiki-workbench-heading");

    fireEvent.click(rail("Chat"));
    await act(async () => {});
    const labelledBy = canvas().getAttribute("aria-labelledby");
    expect(labelledBy).not.toBe("wiki-workbench-heading");
    expect(document.getElementById(labelledBy ?? "")?.textContent).toBe("Chat");
  });
});
