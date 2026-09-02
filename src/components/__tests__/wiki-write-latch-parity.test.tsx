import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WikiWorkbench } from "@/components/WikiWorkbench";
import { WikiSwitcher } from "@/components/workbench/WikiSwitcher";
import {
  WorkbenchDataProvider,
  type WorkbenchData,
} from "@/components/workbench/WorkbenchData";
import { WIKI_SCOPE_COPY } from "@/lib/workbench-tree";
import type { WikiRecord } from "@/lib/wikis";

/**
 * BOTH wiki surfaces, mounted together (DW-515, DW-516, DW-517).
 *
 * `create-wiki-flow.test.tsx` mounts the canvas card alone and
 * `wiki-switcher-lifecycle.test.tsx` mounts the header switcher BARE, and each
 * suite stayed green through the whole defect: the card's `awaitingCreate` and
 * the switcher's `awaitingWrite` were independent `useState` flags, so a create
 * whose outcome nobody knew shut one surface's controls and left the other's
 * fully live. `page.tsx` renders both under one `WorkbenchDataProvider` — the
 * card inside `Workbench`, the switcher in `.wb-left-head` — and both open
 * `CreateWikiDialog` onto the same `POST /api/wikis`. Nothing enforces unique
 * wiki names, so the second frame standing open is a second wiki and every
 * prompt moved onto its template.
 *
 * So this suite composes them the way the shell does and asserts the thing
 * neither single-surface suite can see: one latch, one sentence, one release.
 * The switcher takes props rather than reading the context, exactly as
 * `Workbench.tsx` hands them down.
 */

const { router } = vi.hoisted(() => ({ router: { refresh: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const refresh = router.refresh;

/** Ids that percent-encoding CHANGES — both components build URLs with it. */
const WIKI: WikiRecord = {
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

const ENCODED_ID = "wiki%201%2F2";

function data(wikis: readonly WikiRecord[], currentWikiId: string | null): WorkbenchData {
  return {
    wikis,
    currentWikiId,
    registryUnavailable: false,
    knowledge: [],
    knowledgeUnavailable: false,
    files: [],
    filesUnavailable: false,
    filesTruncated: false,
    dataVersion: 0,
    readOnly: false,
  };
}

/**
 * The two surfaces under ONE provider, as the shell composes them. The latch
 * provider is nested inside `WorkbenchDataProvider`, so this is also what puts
 * a shared latch above both of them.
 */
function tree(wikis: readonly WikiRecord[], currentWikiId: string | null) {
  return (
    <WorkbenchDataProvider value={data(wikis, currentWikiId)}>
      <WikiSwitcher wikis={wikis} currentWikiId={currentWikiId} />
      <WikiWorkbench />
    </WorkbenchDataProvider>
  );
}

function mount(wikis: readonly WikiRecord[], currentWikiId: string | null) {
  return render(tree(wikis, currentWikiId));
}

/** The subset of `Response` the shared `send` helper reads — `status` included. */
function answer(body: unknown, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body } as unknown as Response;
}

const abort = () => Object.assign(new Error("signal timed out"), { name: "TimeoutError" });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  refresh.mockClear();
  fetchMock = vi.fn(async () => answer({ wiki: WIKI }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's `cleanup()` lands after this one.
  cleanup();
  vi.unstubAllGlobals();
});

function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

/** Resolved through the DOM: an id nothing renders describes nothing. */
function describedByText(element: Element): string {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
    .join(" ");
}

/** The create POSTs only, so a switch or a re-template cannot inflate the count. */
function creates(): unknown[] {
  return fetchMock.mock.calls.filter(([url]) => url === "/api/wikis");
}

describe("one unconfirmed-write latch across both wiki surfaces (DW-516)", () => {
  it("shuts the HEADER's create when the CARD's create is unconfirmed", async () => {
    fetchMock.mockRejectedValueOnce(abort());
    const view = mount([], null);

    // The card's empty state, which is the surface that offers `Create Wiki`.
    fireEvent.click(button("Create Wiki"));
    fireEvent.click(button("Create"));
    const sentence = (await screen.findByRole("alert")).textContent ?? "";
    expect(sentence).toContain("create the wiki");
    expect(sentence).toContain("unknown");
    await waitFor(() => expect(button("Create").disabled).toBe(true));
    expect(creates()).toHaveLength(1);

    // Out of the card's dialog — the exact move the sentence invites.
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // …and into the HEADER's create, which before DW-516 was fully live over a
    // POST that may already have seeded a wiki. It still OPENS: refusing to
    // open would leave the owner a control that does nothing and says nothing.
    fireEvent.click(button("New Wiki"));
    const dialog = screen.getByRole("dialog", { name: "Create Wiki" });
    expect(button("Create").disabled).toBe(true);
    // And it carries the CARD's sentence — the shared latch holds the message,
    // not just a flag, so a control dimmed by the other surface's write can say
    // which write is in doubt. Asserted by containment, since the card's own
    // copy of the sentence is still in the DOM behind the backdrop.
    const inDialog = await within(dialog).findByRole("alert");
    expect(inDialog.textContent).toBe(sentence);

    // No second `POST /api/wikis` from either surface. The spy is the
    // assertion, not the attribute.
    fireEvent.click(button("Create"));
    expect(creates()).toHaveLength(1);

    // One server render releases BOTH — `release()` is idempotent, so whichever
    // holder's effect runs first drops it and the other's is a no-op.
    view.rerender(tree([], null));
    await waitFor(() => expect(button("Create").disabled).toBe(false));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(sentence)).toBeNull();
  });

  it("shuts the CARD's create when the HEADER's create is unconfirmed", async () => {
    fetchMock.mockRejectedValueOnce(abort());
    const view = mount([], null);

    fireEvent.click(button("New Wiki"));
    fireEvent.click(button("Create"));
    const sentence = (await screen.findByRole("alert")).textContent ?? "";
    expect(sentence).toContain("unknown");
    await waitFor(() => expect(button("Create").disabled).toBe(true));

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // The card's empty-state opener. `disabled` and NOT `aria-disabled`: the
    // latch is transient, like `switching` in the header, and the read-only
    // convention is the opposite case (DW-430's rule, now for somebody else's
    // write).
    const opener = button("Create Wiki");
    expect(opener.disabled).toBe(true);
    expect(opener.hasAttribute("aria-disabled")).toBe(false);
    // Resolved through the DOM, so an id pointing at nothing fails here.
    expect(describedByText(opener)).toBe(sentence);
    // NOT a second alert anywhere: the dialog that raised it owned that channel
    // and has been dismissed; announcing it again would say it twice.
    expect(screen.queryByRole("alert")).toBeNull();

    // The opener opens nothing and writes nothing while it is down.
    fireEvent.click(opener);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(creates()).toHaveLength(1);

    view.rerender(tree([], null));
    await waitFor(() => expect(button("Create Wiki").disabled).toBe(false));
    expect(button("Create Wiki").getAttribute("aria-describedby")).toBeNull();
    expect(screen.queryByText(sentence)).toBeNull();
  });

  it("carries the CARD's sentence into the rename and delete overlays", async () => {
    // The switcher's other two dialogs fall back to the shared message for the
    // same reason its create one does, and it is newly reachable across the
    // seam: the latch may have been raised on the canvas card, in which case
    // `renameError`/`deleteError` are null and the overlay's `fixed inset-0`
    // backdrop covers every sentence on the page that could explain the dead
    // confirm — including the switcher's own latch note. It matters most for
    // Delete, which names an irreversible action: a dead button with nothing in
    // the overlay reads as the delete having been refused.
    fetchMock.mockRejectedValueOnce(abort());
    mount([WIKI, OTHER], WIKI.id);

    fireEvent.click(button("Change template"));
    fireEvent.change(screen.getByLabelText("Scenario Template"), {
      target: { value: "research" },
    });
    fireEvent.click(button("Overwrite"));
    const sentence = (await screen.findByRole("alert")).textContent ?? "";
    expect(sentence).toContain("apply the template");
    await waitFor(() => expect(button("Overwrite").disabled).toBe(true));

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    for (const [opener, confirm] of [
      ["Rename Wiki", "Rename"],
      ["Delete Wiki", "Delete"],
    ] as const) {
      fireEvent.click(button(opener));
      const dialog = screen.getByRole("dialog", { name: opener });
      expect(button(confirm).disabled).toBe(true);
      // By CONTAINMENT, not by text: the switcher's own copy of the sentence is
      // still in the DOM behind the backdrop, and that copy is exactly the one
      // a sighted owner cannot see and a screen-reader owner cannot reach.
      const inDialog = await within(dialog).findByRole("alert");
      expect(inDialog.textContent).toBe(sentence);

      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
  });
});

describe("the picker announces a latch it did not raise (DW-515, DW-517)", () => {
  it("dims and describes the <select> for a re-template nobody can account for", async () => {
    fetchMock.mockRejectedValueOnce(abort());
    const view = mount([WIKI, OTHER], WIKI.id);
    const select = () => screen.getByLabelText("Active wiki") as HTMLSelectElement;

    // The card's re-template, which before DW-515 raised no latch at all.
    fireEvent.click(button("Change template"));
    fireEvent.change(screen.getByLabelText("Scenario Template"), {
      target: { value: "research" },
    });
    fireEvent.click(button("Overwrite"));

    const sentence = (await screen.findByRole("alert")).textContent ?? "";
    expect(sentence).toContain("apply the template");
    await waitFor(() => expect(button("Overwrite").disabled).toBe(true));

    // DW-517. `aria-disabled` and NEVER `disabled`: a keyboard owner must still
    // reach the control and read which wiki is active — which is exactly what
    // the sentence has just sent them to do.
    await waitFor(() => expect(select().getAttribute("aria-disabled")).toBe("true"));
    expect(select().disabled).toBe(false);
    // The scope sentence PLUS the latch's — `aria-describedby` is a list, and
    // both are true at once.
    const described = (select().getAttribute("aria-describedby") ?? "").split(/\s+/);
    expect(described).toHaveLength(2);
    expect(described.map((id) => document.getElementById(id)?.textContent)).toEqual([
      WIKI_SCOPE_COPY,
      sentence,
    ]);
    // ONE alert on the page, and it is the dialog's. The switcher renders the
    // same sentence — the description has to resolve to something on screen —
    // but as a plain note: the overlay that raised the latch is already
    // announcing those words, and a second live region would say them twice
    // and break every `findByRole("alert")` that expects one.
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    const dialog = screen.getByRole("dialog", { name: "Change Scenario Template" });
    expect(dialog.contains(alerts[0])).toBe(true);
    const note = document.getElementById(described[1]);
    expect(note?.getAttribute("role")).toBeNull();
    expect(dialog.contains(note)).toBe(false);

    // …and the refusal itself still holds: no `PUT /api/wikis/current` leaves.
    fireEvent.change(select(), { target: { value: OTHER.id } });
    expect(
      fetchMock.mock.calls.filter(([url]) => url === "/api/wikis/current"),
    ).toHaveLength(0);
    await waitFor(() => expect(select().value).toBe(WIKI.id));

    // The render the sentence sent the owner to look at takes all of it away.
    view.rerender(tree([WIKI, OTHER], WIKI.id));
    await waitFor(() => expect(select().hasAttribute("aria-disabled")).toBe(false));
    // Compared as a resolved LIST rather than inferred from the absence of a
    // space: an attribute that had gone missing entirely would pass "contains
    // no space" while describing nothing at all.
    expect(
      (select().getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent ?? ""),
    ).toEqual([WIKI_SCOPE_COPY]);
    expect(screen.queryByText(sentence)).toBeNull();
    expect(button("Overwrite").disabled).toBe(false);
    // The re-template POST really was the only one issued.
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith(`/api/wikis/${ENCODED_ID}/template`),
      ),
    ).toHaveLength(1);
  });

  it("renders NO latch note when there is no picker to describe", async () => {
    // The note's `wikis.length > 0` gate. It exists to describe the `<select>`,
    // and with no wikis yet there is no `<select>` at all — while the surface
    // that IS refusing, the card's empty-state `Create Wiki`, already renders
    // this same sentence beside itself (DW-430). Without the gate the owner
    // would meet the sentence twice, once beside the control it explains and
    // once under a header row that holds only `New Wiki`.
    fetchMock.mockRejectedValueOnce(abort());
    mount([], null);

    fireEvent.click(button("New Wiki"));
    fireEvent.click(button("Create"));
    const sentence = (await screen.findByRole("alert")).textContent ?? "";
    expect(sentence).toContain("unknown");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // EXACTLY once on screen, and the one copy is the card's — the note that
    // the dimmed `Create Wiki` points its description at.
    expect(screen.queryAllByText(sentence)).toHaveLength(1);
    expect(describedByText(button("Create Wiki"))).toBe(sentence);
    expect(screen.queryByLabelText("Active wiki")).toBeNull();
  });

  it("describes the picker with the LATCH's sentence, not an answered refusal", async () => {
    // Both can stand at once and be about DIFFERENT writes. The route ANSWERED
    // the switch — nothing landed, nothing is unknown, and that sentence keeps
    // its own alert node — while the card's re-template is what actually dims
    // the picker. Describing the dimming with the answered 404 would name the
    // wrong write, which is why the description follows the LATCH rather than
    // whichever sentence happens to be under the row.
    fetchMock.mockResolvedValueOnce(
      answer({ error: "That wiki no longer exists." }, { ok: false, status: 404 }),
    );
    mount([WIKI, OTHER], WIKI.id);
    const select = () => screen.getByLabelText("Active wiki") as HTMLSelectElement;

    fireEvent.change(select(), { target: { value: OTHER.id } });
    const stated = await screen.findByRole("alert");
    expect(stated.textContent).toBe("That wiki no longer exists.");
    // A stated refusal raises no latch, so the picker is live and — the other
    // half of the rule — describes itself with the scope sentence ALONE.
    expect(select().hasAttribute("aria-disabled")).toBe(false);
    expect(
      (select().getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent ?? ""),
    ).toEqual([WIKI_SCOPE_COPY]);

    // Now the CARD raises one.
    fetchMock.mockRejectedValueOnce(abort());
    fireEvent.click(button("Change template"));
    fireEvent.change(screen.getByLabelText("Scenario Template"), {
      target: { value: "research" },
    });
    fireEvent.click(button("Overwrite"));
    const dialog = screen.getByRole("dialog", { name: "Change Scenario Template" });
    const sentence = (await within(dialog).findByRole("alert")).textContent ?? "";
    expect(sentence).toContain("apply the template");
    expect(sentence).not.toBe("That wiki no longer exists.");

    await waitFor(() => expect(select().getAttribute("aria-disabled")).toBe("true"));
    const described = (select().getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter(Boolean);
    expect(described.map((id) => document.getElementById(id)?.textContent ?? "")).toEqual(
      [WIKI_SCOPE_COPY, sentence],
    );

    // …and the answered 404 is untouched, in its own alert node, which is NOT
    // the one describing the picker. Two nodes rather than one is what makes
    // both true at the same time.
    const statedNode = screen.getByText("That wiki no longer exists.");
    expect(statedNode.getAttribute("role")).toBe("alert");
    expect(described).not.toContain(statedNode.id);
  });
});

describe("a shared release clears only the surface that raised it", () => {
  it("leaves the switcher's STATED refusal standing when the card's latch releases", async () => {
    // The negative, and the reason the release effects stay per surface with a
    // private "I raised it" ref rather than moving into the provider. "That
    // wiki no longer exists." is an answer the route GAVE: nothing landed, and
    // it is not made untrue by the card's re-template resolving. A provider-level
    // release could not tell whose errors to drop, and dropping this one would
    // leave the owner a live picker and no idea what the last change did wrong.
    fetchMock.mockResolvedValueOnce(
      answer({ error: "That wiki no longer exists." }, { ok: false, status: 404 }),
    );
    const view = mount([WIKI, OTHER], WIKI.id);

    fireEvent.change(screen.getByLabelText("Active wiki"), {
      target: { value: OTHER.id },
    });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That wiki no longer exists.",
    );
    // A stated refusal raises no latch, so nothing was reconciled.
    expect(refresh).not.toHaveBeenCalled();

    // Now the CARD raises one, on a write of its own.
    fetchMock.mockRejectedValueOnce(abort());
    fireEvent.click(button("Change template"));
    fireEvent.change(screen.getByLabelText("Scenario Template"), {
      target: { value: "research" },
    });
    fireEvent.click(button("Overwrite"));
    await waitFor(() => expect(button("Overwrite").disabled).toBe(true));
    await waitFor(() => expect(refresh).toHaveBeenCalled());

    // The render arrives. The card's release effect fires, drops the shared
    // latch and clears the CARD's sentences…
    view.rerender(tree([WIKI, OTHER], WIKI.id));
    await waitFor(() => expect(button("Overwrite").disabled).toBe(false));

    // …and the switcher's stated refusal is untouched, because its own raise
    // ref says it never put this latch up.
    expect(screen.getByText("That wiki no longer exists.")).toBeTruthy();
  });
});
