import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { WikiWorkbench } from "@/components/WikiWorkbench";
import { Workbench } from "@/components/workbench/Workbench";
import {
  WorkbenchDataProvider,
  type WorkbenchData,
} from "@/components/workbench/WorkbenchData";
import { PREVIEW_UNSELECTED_COPY } from "@/lib/workbench-preview";
import type { WikiRecord } from "@/lib/wikis";

/**
 * One Wiki switcher and one preview surface per viewport, MOUNTED (DW-33, DW-39).
 *
 * `create-wiki-ui.test.ts` reads the two components as text, which is the right
 * tool for "has the card's `<select>` come back" and the wrong one for "does the
 * assembled shell put two of them on screen at once" — the header and the canvas
 * are different files, so no single-file scan can see the duplication the owner
 * saw. Both claims here are made on the rendered document: how many controls
 * carry each accessible name, and what the stylesheet's own rule computes to.
 */

// ONE stable router object: several components in this shell key effects on the
// router identity, and a fresh literal per call would rebuild them on every
// re-render.
const { router } = vi.hoisted(() => ({ router: { refresh: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const refresh = router.refresh;

/**
 * Ids that percent-encoding CHANGES, matching the other Wiki suites: a tidy
 * `wiki-1` would let an unencoded URL pass unnoticed.
 */
const CURRENT: WikiRecord = {
  id: "wiki 1/2",
  name: "Acme",
  scenario: "business",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const OTHER: WikiRecord = {
  id: "wiki 3/4",
  name: "Shelf",
  scenario: "reading",
  createdAt: "2026-01-02T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

/**
 * Sourced from the module that owns it, never restated: a literal here would go
 * on matching the card after the sentence was reworded, and this file's four
 * DW-39 assertions would all pass against text nobody renders any more.
 */
const PREVIEW_SENTENCE = PREVIEW_UNSELECTED_COPY;
const PREVIEW_NOTE_SELECTOR = '.wb-shell[data-preview="true"] .wb-canvas-preview-note';

/**
 * The DW-39 rule, sliced out of the REAL stylesheet rather than restated here.
 *
 * A literal copy would keep passing after the stylesheet's own rule was renamed
 * or deleted — the test would be asserting against itself. Only this one block
 * is injected because jsdom's CSS parser cannot take the whole Tailwind v4 file.
 *
 * Slicing loses the rule's CASCADE CONTEXT, which is the whole risk: injected
 * bare, a rule wrapped in `@media (min-width: 900px)` would apply at every width
 * in jsdom, so the narrow layout — where the Preview stacks as a fourth ROW
 * beside this sentence — would go on passing. So the brace depth ahead of the
 * rule is checked, and a nested rule is reported rather than silently unwrapped.
 * `throw` rather than `expect`, so the failure names this helper wherever it is
 * called from.
 */
function previewNoteRule(): string {
  const css = readFileSync(
    path.resolve(__dirname, "../../../app/globals.css"),
    "utf8",
  );
  const start = css.indexOf(`${PREVIEW_NOTE_SELECTOR} {`);
  if (start === -1) {
    throw new Error(`globals.css no longer declares ${PREVIEW_NOTE_SELECTOR}`);
  }
  // Comments are stripped BEFORE the braces are counted: `globals.css` explains
  // several rules by quoting them, so a comment holding one unbalanced brace
  // would otherwise skew the depth and make this helper report an `@media`
  // wrapper that is not there — a false diagnosis that takes every DW-39 case
  // down with it.
  const before = css.slice(0, start).replace(/\/\*[\s\S]*?\*\//g, "");
  const depth =
    (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length;
  if (depth !== 0) {
    throw new Error(
      `${PREVIEW_NOTE_SELECTOR} is nested ${depth} block(s) deep (an @media or ` +
        `@supports wrapper), so it no longer applies unconditionally — the ` +
        `Preview and this sentence would both show wherever the wrapper misses.`,
    );
  }
  // Walk to the MATCHING brace rather than the first one: Tailwind v4 allows
  // native nesting, and `css.indexOf("}")` would slice a nested rule off
  // mid-block and hand jsdom something it drops silently.
  let end = -1;
  let open = 0;
  for (let i = start; i < css.length; i += 1) {
    if (css[i] === "{") open += 1;
    else if (css[i] === "}") {
      open -= 1;
      if (open === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error(`${PREVIEW_NOTE_SELECTOR} block is unterminated`);
  return css.slice(start, end + 1);
}

/**
 * One Knowledge row, so a test can actually DOCK the Preview. Without a row in
 * the tree there is nothing to pick, and `data-preview="true"` could only ever
 * be asserted against a hand-written host.
 */
const KNOWLEDGE = [
  { id: "note", label: "Note", count: 1, pages: [{ slug: "acme/plan", title: "Plan" }] },
];

function data(
  wikis: readonly WikiRecord[],
  currentWikiId: string | null,
  knowledge: WorkbenchData["knowledge"] = [],
  registryUnavailable = false,
): WorkbenchData {
  return {
    wikis,
    currentWikiId,
    registryUnavailable,
    knowledge,
    knowledgeUnavailable: false,
    files: [],
    filesUnavailable: false,
    filesTruncated: false,
    dataVersion: 0,
    readOnly: false,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
let styleEl: HTMLStyleElement;

beforeEach(() => {
  refresh.mockClear();
  window.localStorage.clear();
  // `useSidecarStatus` probes the loopback port at mount, and the header's
  // switch PUTs. One stub answers both; the assertions filter by URL, so the
  // probe cannot be mistaken for a write.
  fetchMock = vi.fn(
    async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response,
  );
  vi.stubGlobal("fetch", fetchMock);
  // jsdom loads no stylesheet at all, so the DW-39 rule has to be handed to it
  // explicitly for `getComputedStyle` to have anything to resolve.
  styleEl = document.createElement("style");
  styleEl.textContent = previewNoteRule();
  document.head.append(styleEl);
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's own `cleanup()` lands after this block. Unmounting here tears
  // the tree down while `fetch` is still stubbed.
  cleanup();
  styleEl.remove();
  vi.unstubAllGlobals();
});

/** The subset of `Response` both components' `send` helpers read. */
function answer(body: unknown, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body } as unknown as Response;
}

/**
 * Route the active-wiki PUT somewhere specific while leaving the sidecar probe
 * answering, so a stalled or failed switch can be observed without also taking
 * the rail's status dot down.
 */
function answerCurrentWriteWith(response: () => Promise<Response> | Response) {
  fetchMock.mockImplementation(async (url: unknown) =>
    String(url).includes("/api/wikis/current") ? response() : answer({}),
  );
}

/** The assembled shell, exactly as `page.tsx` composes it. */
async function renderShell(
  wikis: readonly WikiRecord[],
  currentWikiId: string | null,
  knowledge: WorkbenchData["knowledge"] = [],
) {
  const view = render(
    <WorkbenchDataProvider value={data(wikis, currentWikiId, knowledge)}>
      <Workbench>
        <WikiWorkbench />
      </Workbench>
    </WorkbenchDataProvider>,
  );
  // Flush the sidecar probe's promise chain before any assertion runs.
  await act(async () => {});
  return view;
}

/** Every `fetch` aimed at the active-wiki write, ignoring the sidecar probe. */
function currentWikiWrites(): unknown[][] {
  return fetchMock.mock.calls.filter((call) =>
    String(call[0]).includes("/api/wikis/current"),
  );
}

/**
 * The shell exactly as `page.tsx` builds it — the canvas card BARE, with no key
 * and no props, reading the provider the header switcher reads (DW-174).
 *
 * The key it used to carry was a workaround for state this card no longer has:
 * `initialCurrentId` seeded a `useState`, so only a remount could move it. A
 * key on the wiki id could carry a SWITCH and never a RENAME, which is why the
 * heading went on naming the old wiki until a reload. Re-rendering this helper
 * with a new provider value is now the whole seam.
 */
function providerShell(wikis: readonly WikiRecord[], currentWikiId: string | null) {
  return (
    <WorkbenchDataProvider value={data(wikis, currentWikiId)}>
      <Workbench>
        <WikiWorkbench />
      </Workbench>
    </WorkbenchDataProvider>
  );
}

/** Dismiss whatever overlay is open, if any, without caring which one it is. */
function closeAnyDialog() {
  const dialog = screen.queryByRole("dialog");
  if (!dialog) return;
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
}

describe("one Wiki switcher and one create control per viewport (DW-33)", () => {
  it("puts exactly one of each Wiki control on screen with two wikis", async () => {
    await renderShell([CURRENT, OTHER], CURRENT.id);

    // The header owns switching and creating; the canvas card owns the template
    // control. Two of any of these is the defect this suite exists for.
    //
    // Names are matched by REGEX, not by exact string: the control this diff
    // deleted was spelled `New wiki` and the survivor is `New Wiki`, so a
    // case-sensitive count would go green against a restored duplicate.
    expect(screen.getAllByLabelText(/active wiki/i)).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /new wiki/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /change template/i })).toHaveLength(1);
    expect(screen.getAllByText(PREVIEW_SENTENCE)).toHaveLength(1);
    // Exactly one combobox anywhere: a relabelled switcher would slip past the
    // name query above but not past this.
    expect(document.querySelectorAll("select")).toHaveLength(1);
  });

  it("has no canvas control that opens the create flow, whatever it is called", async () => {
    // Label-proof. The counts above pin the spellings that exist today; this
    // asks the only question that survives a rename — can anything on the canvas
    // still open `CreateWikiDialog`? Every canvas button is pressed and the
    // overlay it produces (if any) is identified by the dialog's accessible
    // name, not by the button's.
    const { container } = await renderShell([CURRENT, OTHER], CURRENT.id);
    const canvas = container.querySelector(".wb-canvas") as HTMLElement;
    const buttons = Array.from(canvas.querySelectorAll("button"));
    // Guard the guard: zero buttons would make the loop below vacuous.
    expect(buttons.length).toBeGreaterThan(0);

    for (const button of buttons) {
      fireEvent.click(button);
      // Case-insensitive for the same reason the counts above are: this is the
      // assertion that is supposed to survive a rename, so it must not be the
      // one control in the file still pinned to an exact spelling.
      expect(screen.queryByRole("dialog", { name: /create wiki/i })).toBeNull();
      closeAnyDialog();
    }
    // …and nothing was written on the way through.
    expect(currentWikiWrites()).toHaveLength(0);

    // Positive control for the query itself: a negative that can never resolve
    // — a mistyped role, a dialog whose accessible name stopped resolving —
    // would pass the loop above while proving nothing. The header's own create
    // control is on the same document, so this shows the query DOES find the
    // dialog when one is open.
    fireEvent.click(screen.getByRole("button", { name: /new wiki/i }));
    expect(screen.getByRole("dialog", { name: /create wiki/i })).toBeTruthy();
  });

  it("keeps the switcher in the left column header, not in the canvas", async () => {
    const { container } = await renderShell([CURRENT, OTHER], CURRENT.id);

    const select = screen.getByLabelText("Active wiki");
    const header = container.querySelector(".wb-left-head");
    const canvas = container.querySelector(".wb-canvas");
    expect(header).not.toBeNull();
    expect(canvas).not.toBeNull();
    expect(header?.contains(select)).toBe(true);
    expect(canvas?.contains(select)).toBe(false);
    // The card is still there — it just has one control left.
    expect(
      canvas?.contains(screen.getByRole("button", { name: "Change template" })),
    ).toBe(true);
  });

  it("issues exactly one active-wiki write when the header switches", async () => {
    await renderShell([CURRENT, OTHER], CURRENT.id);

    fireEvent.change(screen.getByLabelText("Active wiki"), {
      target: { value: OTHER.id },
    });
    await act(async () => {});

    // Two switchers meant two PUTs racing each other; one owner means one write.
    const writes = currentWikiWrites();
    expect(writes).toHaveLength(1);
    expect((writes[0][1] as RequestInit).method).toBe("PUT");
    expect(JSON.parse(String((writes[0][1] as RequestInit).body))).toEqual({
      id: OTHER.id,
    });
  });

  it("still keeps one of each with a single wiki, where the card never had a select", async () => {
    // The card's old `<select>` was gated on `wikis.length > 1`, so this is the
    // width at which the duplication was invisible — and therefore the one where
    // a reintroduced card switcher would be easiest to miss. The header's own
    // control is gated on `wikis.length > 0` and is present here.
    const { container } = await renderShell([CURRENT], CURRENT.id);

    expect(screen.getAllByLabelText(/active wiki/i)).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /new wiki/i })).toHaveLength(1);
    const canvas = container.querySelector(".wb-canvas") as HTMLElement;
    expect(within(canvas).queryByLabelText(/active wiki/i)).toBeNull();
    expect(canvas.querySelector("select")).toBeNull();
  });

  it("keeps the canvas empty state and the header create control with no wiki", async () => {
    const { container } = await renderShell([], null);

    // Scoped to the canvas: the left column's tree shows its own
    // `TREE_NO_WIKI_COPY` sentence, which is that panel's empty state and not a
    // duplicate of this one.
    const canvas = container.querySelector(".wb-canvas") as HTMLElement;
    expect(canvas).not.toBeNull();
    // The canvas's AC-quoted empty state names the next step; it is not a second
    // copy of the header's persistent chrome control.
    expect(within(canvas).getByText("No wiki yet.")).toBeTruthy();
    const create = screen.getByRole("button", { name: "Create Wiki" });
    expect(create.className).toContain("btn primary");
    expect(container.querySelectorAll(".btn.primary")).toHaveLength(1);
    // The header still offers creating, and no switcher for a registry of none.
    expect(screen.getAllByRole("button", { name: /new wiki/i })).toHaveLength(1);
    expect(screen.queryByLabelText(/active wiki/i)).toBeNull();
  });

  it("locks the one switcher while its own write is in flight", async () => {
    // The race guard `create-wiki-ui.test.ts` retargeted onto `WikiSwitcher.tsx`,
    // EXECUTED. That file spells `disabled={switching}` three times — the select,
    // Rename and Delete — so a source scan is satisfied by the two buttons while
    // the select's own guard is gone. With switching concentrated in one owner
    // (DW-33) this is the only control the race can happen at.
    let release: (value: Response) => void = () => {};
    answerCurrentWriteWith(() => new Promise<Response>((resolve) => (release = resolve)));
    await renderShell([CURRENT, OTHER], CURRENT.id);
    const select = screen.getByLabelText(/active wiki/i) as HTMLSelectElement;

    fireEvent.change(select, { target: { value: OTHER.id } });
    await act(async () => {});

    expect(select.disabled).toBe(true);
    // …and a second pick starts no second PUT, whose answer could settle out of
    // order and leave the shell on a wiki the owner had already left.
    fireEvent.change(select, { target: { value: CURRENT.id } });
    await act(async () => {});
    expect(currentWikiWrites()).toHaveLength(1);

    await act(async () => {
      release(answer({}));
    });
    expect(select.disabled).toBe(false);
  });

  it("reports a failed switch at the switcher and keeps the live wiki selected", async () => {
    // The I/O matrix's "failure renders in the header's own alert" row. The
    // canvas card's section-level alert went with its switcher, so this is now
    // the only place a failed switch can be told.
    answerCurrentWriteWith(() =>
      answer({ error: "Couldn’t switch wiki." }, { ok: false, status: 500 }),
    );
    const { container } = await renderShell([CURRENT, OTHER], CURRENT.id);
    const switcher = container.querySelector(".wb-wiki-switch") as HTMLElement;
    const select = screen.getByLabelText(/active wiki/i) as HTMLSelectElement;

    fireEvent.change(select, { target: { value: OTHER.id } });
    const alert = await within(switcher).findByRole("alert");

    expect(alert.textContent).toBe("Couldn’t switch wiki.");
    // The optimistic pick is dropped, so the control names the wiki that is
    // still live rather than one the server refused to move to.
    expect(select.value).toBe(CURRENT.id);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("follows a header switch onto the new wiki through the provider (DW-174)", async () => {
    // End to end across the seam the retirement made load-bearing: switch from
    // the header, deliver what `router.refresh()` would (the server render with
    // the new live wiki), and check the canvas both NAMES that wiki and aims its
    // one remaining write at it. Reading the id off the provider is what makes
    // that true; the card that seeded `useState` from props needed a remount and
    // would otherwise have overwritten the wiki the owner just left.
    const { rerender, container } = render(providerShell([CURRENT, OTHER], CURRENT.id));
    await act(async () => {});
    expect(
      within(container.querySelector(".wb-canvas") as HTMLElement).getByText(CURRENT.name),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/active wiki/i), {
      target: { value: OTHER.id },
    });
    await act(async () => {});
    expect(refresh).toHaveBeenCalledTimes(1);

    rerender(providerShell([CURRENT, OTHER], OTHER.id));
    await act(async () => {});

    const canvas = container.querySelector(".wb-canvas") as HTMLElement;
    expect(within(canvas).getByText(OTHER.name)).toBeTruthy();
    expect(within(canvas).queryByText(CURRENT.name)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /change template/i }));
    fireEvent.change(screen.getByLabelText("Scenario Template"), {
      target: { value: "research" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));
    await act(async () => {});

    const template = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("/template"),
    );
    expect(String(template?.[0])).toBe(
      `/api/wikis/${encodeURIComponent(OTHER.id)}/template`,
    );
  });

  it("drops an open template confirm when the active wiki moves under it", async () => {
    // The state reset the remount key used to provide for free. `current` is
    // derived live from context now, but `templateOpen` and `pendingScenario`
    // are not — so a confirm opened against CURRENT, correctly dead because it
    // still names CURRENT's own template, would come ALIVE the moment a header
    // switch moved `current` to OTHER (a `reading` wiki) and `confirmDisabled`
    // started comparing `research` to `reading`. Overwrite would then rewrite
    // the purpose.md, Schema and Workspace Purpose of a wiki the owner never
    // opened this dialog for.
    const { rerender } = render(providerShell([CURRENT, OTHER], CURRENT.id));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /change template/i }));
    fireEvent.change(screen.getByLabelText("Scenario Template"), {
      target: { value: "research" },
    });
    expect(screen.getByRole("dialog", { name: "Change Scenario Template" })).toBeTruthy();

    // What `router.refresh()` delivers after a header switch.
    rerender(providerShell([CURRENT, OTHER], OTHER.id));
    await act(async () => {});

    // Gone, not merely re-aimed: the owner picked a template for a wiki they
    // are no longer on, and re-aiming it would be the same overwrite with a
    // different explanation.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]).includes("/template")),
    ).toHaveLength(0);

    // …and reopening starts from the NEW wiki's own template, so the confirm is
    // dead again rather than inheriting the old pick.
    fireEvent.click(screen.getByRole("button", { name: /change template/i }));
    expect(
      (screen.getByLabelText("Scenario Template") as HTMLSelectElement).value,
    ).toBe(OTHER.scenario);
    expect((screen.getByRole("button", { name: "Overwrite" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("closes the template confirm when the wiki goes away under the id", async () => {
    // `applyTemplate` returns early with no `current`, so a dialog left open
    // over a vanished record answers its own confirm with silence — a button
    // that neither writes nor says why. The record can go without the id going:
    // a refresh that answers a shorter list is enough.
    const { rerender } = render(providerShell([CURRENT, OTHER], CURRENT.id));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /change template/i }));
    expect(screen.getByRole("dialog", { name: "Change Scenario Template" })).toBeTruthy();

    rerender(providerShell([OTHER], CURRENT.id));
    await act(async () => {});

    expect(screen.queryByRole("dialog")).toBeNull();
    // The card fell back to the empty state rather than rendering half a card.
    expect(screen.getByText("No wiki yet.")).toBeTruthy();
    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]).includes("/template")),
    ).toHaveLength(0);
  });

  it("renames in place when the provider re-renders the SAME wiki id (DW-174)", async () => {
    // The case no key could ever carry, and the defect that retired it: a header
    // Rename moves the record's `name` and leaves `currentId` exactly where it
    // was, so `key={currentId}` does not change and the card never remounts.
    // With the props gone there is nothing left to go stale — this is a plain
    // re-render with a new provider value, and no remount happens at all.
    const { rerender, container } = render(providerShell([CURRENT, OTHER], CURRENT.id));
    await act(async () => {});
    const canvas = container.querySelector(".wb-canvas") as HTMLElement;
    const heading = within(canvas).getByText(CURRENT.name);

    const renamed: WikiRecord = { ...CURRENT, name: "Acme Renamed" };
    rerender(providerShell([renamed, OTHER], CURRENT.id));
    await act(async () => {});

    expect(within(canvas).getByText("Acme Renamed")).toBeTruthy();
    expect(within(canvas).queryByText(CURRENT.name)).toBeNull();
    // The SAME node carries the new text: a remount would have replaced it, and
    // "no remount" is the half of this claim a text query cannot see.
    expect(heading.isConnected).toBe(true);
    expect(heading.textContent).toBe("Acme Renamed");
  });

  it("keeps the read-failure branch a claim-free alert with no create action", async () => {
    // Untouched by DW-33, and the row most easily broken by deleting controls
    // from this card: "No wiki yet." is a claim about the registry that a failed
    // read cannot make, and its primary action would seed a duplicate wiki on a
    // transient error.
    // One flag, one wire: the card reads the provider's `registryUnavailable`
    // rather than a prop of its own (DW-174), so the header and the canvas
    // cannot disagree about whether the registry was read — the document where
    // New Wiki sits beside a canvas saying the read failed is now unbuildable.
    const { container } = render(
      <WorkbenchDataProvider value={data([], null, [], true)}>
        <Workbench>
          <WikiWorkbench />
        </Workbench>
      </WorkbenchDataProvider>,
    );
    await act(async () => {});

    const canvas = container.querySelector(".wb-canvas") as HTMLElement;
    const alert = within(canvas).getByRole("alert");
    expect(alert.textContent).toBe("Your wikis couldn’t be loaded. Reload to try again.");
    expect(within(canvas).queryByText("No wiki yet.")).toBeNull();
    expect(within(canvas).queryByRole("button", { name: "Create Wiki" })).toBeNull();
    // Document-wide, not canvas-scoped: a failed read flattens to no create
    // action anywhere, so the owner cannot seed a duplicate wiki on what may be
    // a transient error.
    expect(screen.queryByRole("button", { name: /new wiki/i })).toBeNull();
    expect(screen.queryByLabelText(/active wiki/i)).toBeNull();
  });
});

describe("exactly one preview surface at a time (DW-39)", () => {
  it("hides the canvas sentence under a host that says the Preview is docked", () => {
    render(
      <WorkbenchDataProvider value={data([CURRENT, OTHER], CURRENT.id)}>
        <div className="wb-shell" data-preview="true">
          <WikiWorkbench />
        </div>
      </WorkbenchDataProvider>,
    );

    const note = screen.getByText(PREVIEW_SENTENCE).closest(".wb-canvas-preview-note");
    expect(note).not.toBeNull();
    expect(window.getComputedStyle(note as Element).display).toBe("none");
  });

  it("leaves it on screen while nothing is docked", () => {
    render(
      <WorkbenchDataProvider value={data([CURRENT, OTHER], CURRENT.id)}>
        <div className="wb-shell" data-preview="false">
          <WikiWorkbench />
        </div>
      </WorkbenchDataProvider>,
    );

    // The control case: without it, a rule that matched EVERY `.wb-shell`
    // descendant would satisfy the assertion above and delete the sentence.
    const note = screen.getByText(PREVIEW_SENTENCE).closest(".wb-canvas-preview-note");
    expect(window.getComputedStyle(note as Element).display).not.toBe("none");
  });

  it("has the real shell publish data-preview=false with no row picked", async () => {
    const { container } = await renderShell([CURRENT, OTHER], CURRENT.id);

    // The attribute is the seam the rule above reads, so the two halves are
    // pinned against the same shell rather than against a hand-written host.
    const shell = container.querySelector(".wb-shell");
    expect(shell?.getAttribute("data-preview")).toBe("false");
    const note = screen.getByText(PREVIEW_SENTENCE).closest(".wb-canvas-preview-note");
    expect(window.getComputedStyle(note as Element).display).not.toBe("none");
  });

  it("hides the sentence once a real tree pick docks the Preview", async () => {
    // The whole of DW-39 end to end: a row is picked on the assembled shell, the
    // shell flips its own attribute, and the stylesheet's own rule takes the
    // sentence off screen. Neither half is stood in for here.
    const { container } = await renderShell([CURRENT, OTHER], CURRENT.id, KNOWLEDGE);

    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    await act(async () => {});

    expect(container.querySelector(".wb-shell")?.getAttribute("data-preview")).toBe(
      "true",
    );
    const note = screen.getByText(PREVIEW_SENTENCE).closest(".wb-canvas-preview-note");
    expect(window.getComputedStyle(note as Element).display).toBe("none");
  });
});
