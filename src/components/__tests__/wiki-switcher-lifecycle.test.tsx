import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WikiSwitcher } from "@/components/workbench/WikiSwitcher";
import type { WikiRecord } from "@/lib/wikis";

/**
 * The left column's Wiki lifecycle controls, MOUNTED (DW-18).
 *
 * `workbench-left-column.test.ts` reads this component's source, which is the
 * right tool for "does it still import the shared create dialog" and the wrong
 * one for "does Cancel write nothing". Every assertion below is made on the
 * outermost surface instead: what is on screen, and what requests were issued.
 * A rewrite that keeps `rename`/`remove` but wires `onConfirm` past the dialog,
 * or that aims Delete at the active Wiki, leaves the source scan green and
 * fails here.
 */

const { router } = vi.hoisted(() => ({ router: { refresh: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const refresh = router.refresh;

/**
 * Ids that percent-encoding CHANGES. The component builds its URLs with
 * `encodeURIComponent(wiki.id)`, and against a tidy `wiki-1` that call could be
 * deleted with every assertion still green — while a real id carrying a slash
 * would silently address a different route.
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

const CURRENT_ENCODED = "wiki%201%2F2";
const OTHER_ENCODED = "wiki%203%2F4";

/** The subset of `Response` the component's `send` reads — `status` included. */
function answer(body: unknown, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  refresh.mockClear();
  fetchMock = vi.fn(async () => answer({ wiki: CURRENT }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's `cleanup()` lands after this one. Unmounting here tears the
  // tree down while `fetch` is still stubbed.
  cleanup();
  vi.unstubAllGlobals();
});

function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function mount(wikis: readonly WikiRecord[] = [CURRENT, OTHER]) {
  return render(<WikiSwitcher wikis={wikis} currentWikiId={CURRENT.id} />);
}

/**
 * Switch to `id` and let the request settle, WITHOUT the server tree catching
 * up — `router.refresh()` is a spy here, so `currentWikiId` stays on the old
 * Wiki exactly as it does for the length of a real round trip. This is the
 * window in which the optimistic `<select>` value and the prop disagree.
 */
async function switchTo(id: string) {
  fireEvent.change(screen.getByLabelText("Active wiki"), { target: { value: id } });
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  fetchMock.mockClear();
}

describe("Rename", () => {
  it("writes NOTHING when the confirm is cancelled", () => {
    mount();
    fireEvent.click(button("Rename Wiki"));
    expect(screen.getByRole("dialog", { name: "Rename Wiki" })).toBeTruthy();

    fireEvent.click(button("Cancel"));

    // The claim is that no request was issued, so the observation is the spy's
    // call count — not a state flag the component happens to expose.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens on the active wiki's current name and blocks a blank one", () => {
    mount();
    fireEvent.click(button("Rename Wiki"));

    const input = screen.getByLabelText("Wiki name") as HTMLInputElement;
    expect(input.value).toBe(CURRENT.name);
    expect(button("Rename").disabled).toBe(false);

    fireEvent.change(input, { target: { value: "   " } });
    expect(button("Rename").disabled).toBe(true);
  });

  it("PATCHes the new name to the encoded active-wiki route and refreshes", async () => {
    mount();
    fireEvent.click(button("Rename Wiki"));
    fireEvent.change(screen.getByLabelText("Wiki name"), {
      target: { value: "Q4 plan" },
    });

    fireEvent.click(button("Rename"));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/wikis/${CURRENT_ENCODED}`);
    expect(url).not.toContain(CURRENT.id);
    expect(init.method).toBe("PATCH");
    // Not because `Request.json()` needs it — it ignores the header entirely —
    // but because this request crosses the network as a declared JSON body, and
    // proxies, logs and any future body-parsing middleware read the label.
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ name: "Q4 plan" });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("submits on Enter, the whole keyboard path through a one-field dialog", async () => {
    mount();
    fireEvent.click(button("Rename Wiki"));
    const input = screen.getByLabelText("Wiki name");
    fireEvent.change(input, { target: { value: "Q4 plan" } });

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/wikis/${CURRENT_ENCODED}`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ name: "Q4 plan" });
  });

  it("ignores the Enter that commits an IME composition", () => {
    // Typing a CJK name commits each candidate with Enter, and that keystroke
    // reaches this handler too. Submitting on it would rename the wiki to
    // whatever was half-composed at the time.
    mount();
    fireEvent.click(button("Rename Wiki"));
    const input = screen.getByLabelText("Wiki name");
    fireEvent.change(input, { target: { value: "計画" } });

    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Rename Wiki" })).toBeTruthy();
  });

  it("does not let Enter reach past the disabled confirm", () => {
    mount();
    fireEvent.click(button("Rename Wiki"));
    const input = screen.getByLabelText("Wiki name");
    fireEvent.change(input, { target: { value: "   " } });

    fireEvent.keyDown(input, { key: "Enter" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Rename Wiki" })).toBeTruthy();
  });

  it("keeps the dialog open and shows the failure inside it", async () => {
    fetchMock.mockResolvedValueOnce(
      answer({ error: "Wiki name is required." }, { ok: false, status: 400 }),
    );
    mount();
    fireEvent.click(button("Rename Wiki"));
    fireEvent.click(button("Rename"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Wiki name is required.");
    // Inside the overlay — the backdrop covers everything rendered behind it.
    expect(screen.getByRole("dialog", { name: "Rename Wiki" }).contains(alert)).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("Delete", () => {
  it("is not offered when there is only one wiki", () => {
    mount([CURRENT]);
    expect(screen.queryByRole("button", { name: "Delete Wiki" })).toBeNull();
    // Rename still is: it acts on the wiki that exists.
    expect(screen.getByRole("button", { name: "Rename Wiki" })).toBeTruthy();
  });

  it("offers only the NON-active wikis as targets", () => {
    mount();
    fireEvent.click(button("Delete Wiki"));

    const picker = screen.getByLabelText("Wiki to delete") as HTMLSelectElement;
    // The server refuses to delete the active wiki, so a picker that offered it
    // would be a control whose every use is a 400.
    expect([...picker.options].map((option) => option.value)).toEqual([OTHER.id]);
    expect(picker.value).toBe(OTHER.id);
  });

  it("writes NOTHING when the confirm is cancelled", () => {
    mount();
    fireEvent.click(button("Delete Wiki"));
    fireEvent.click(button("Cancel"));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("DELETEs the chosen wiki's encoded route and refreshes", async () => {
    fetchMock.mockResolvedValueOnce(answer({ wiki: OTHER }));
    mount();
    fireEvent.click(button("Delete Wiki"));

    fireEvent.click(button("Delete"));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // The TARGET's id, not the active one — the whole point of the picker.
    expect(url).toBe(`/api/wikis/${OTHER_ENCODED}`);
    expect(url).not.toBe(`/api/wikis/${CURRENT_ENCODED}`);
    expect(url).not.toContain(OTHER.id);
    expect(init.method).toBe("DELETE");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("lands the keyboard on New Wiki once the deleted wiki leaves the list", async () => {
    // `useDialogA11y` restores focus to the OPENER, and on a delete that opener
    // is still mounted at close time — so the fallback branch never fires. It
    // unmounts a moment later, when the refreshed `wikis` list drops below two
    // and the gate on the Delete control closes, which would leave the keyboard
    // user on <body> with no dialog left to explain it.
    fetchMock.mockResolvedValueOnce(answer({ wiki: OTHER }));
    const view = mount();
    fireEvent.click(button("Delete Wiki"));
    fireEvent.click(button("Delete"));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // What `router.refresh()` delivers: the server tree without the deleted
    // wiki, which is what takes the Delete button away.
    view.rerender(<WikiSwitcher wikis={[CURRENT]} currentWikiId={CURRENT.id} />);

    expect(screen.queryByRole("button", { name: "Delete Wiki" })).toBeNull();
    expect(document.activeElement).toBe(button("New Wiki"));
  });

  it("leaves focus on the Delete button when it survives the delete", async () => {
    // The mirror of the test above: with a third wiki the control is still
    // gated in (`wikis.length > 1`) after the refresh, so `useDialogA11y`'s
    // own restore is the correct one and the post-delete refocus must NOT run
    // — it would move the keyboard to a button the owner never navigated to.
    const third: WikiRecord = { ...OTHER, id: "wiki 5/6", name: "Third" };
    fetchMock.mockResolvedValueOnce(answer({ wiki: OTHER }));
    const view = render(
      <WikiSwitcher wikis={[CURRENT, OTHER, third]} currentWikiId={CURRENT.id} />,
    );
    // `fireEvent.click` does not focus in jsdom, and the dialog restores to
    // whatever had focus when it opened — so a keyboard user has to be staged
    // explicitly for "restored to the opener" to mean anything.
    button("Delete Wiki").focus();
    fireEvent.click(button("Delete Wiki"));
    fireEvent.click(button("Delete"));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    view.rerender(
      <WikiSwitcher wikis={[CURRENT, third]} currentWikiId={CURRENT.id} />,
    );

    expect(document.activeElement).toBe(button("Delete Wiki"));
  });

  it("keeps the dialog open and shows the server's refusal inside it", async () => {
    fetchMock.mockResolvedValueOnce(
      answer(
        { error: "Switch to a different wiki before deleting this one." },
        { ok: false, status: 400 },
      ),
    );
    mount();
    fireEvent.click(button("Delete Wiki"));
    fireEvent.click(button("Delete"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Switch to a different wiki before deleting this one.",
    );
    expect(screen.getByRole("dialog", { name: "Delete Wiki" }).contains(alert)).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("an in-flight switch", () => {
  it("aims Rename at the newly selected wiki, not the one being left", async () => {
    // `currentWikiId` only catches up once `router.refresh()` lands, so between
    // the switch and the refresh the <select> shows OTHER while the prop still
    // says CURRENT. Deriving the target from the prop would prefill the dialog
    // with the previous wiki's name and rename THAT one.
    mount();
    await switchTo(OTHER.id);

    fireEvent.click(button("Rename Wiki"));
    expect((screen.getByLabelText("Wiki name") as HTMLInputElement).value).toBe(
      OTHER.name,
    );

    fireEvent.click(button("Rename"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/wikis/${OTHER_ENCODED}`);
    expect(url).not.toBe(`/api/wikis/${CURRENT_ENCODED}`);
    expect(JSON.parse(String(init.body))).toEqual({ name: OTHER.name });
  });

  it("offers the wiki being LEFT as the delete target, never the one selected", async () => {
    mount();
    await switchTo(OTHER.id);

    fireEvent.click(button("Delete Wiki"));

    const picker = screen.getByLabelText("Wiki to delete") as HTMLSelectElement;
    expect([...picker.options].map((option) => option.value)).toEqual([CURRENT.id]);
  });

  it("locks both controls while the switch is still in flight", async () => {
    let settle!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (settle = resolve)),
    );
    mount();
    fireEvent.change(screen.getByLabelText("Active wiki"), {
      target: { value: OTHER.id },
    });

    // A dialog opened here would act on a selection the server has not
    // confirmed — and could still be open when the switch fails and rolls back.
    await waitFor(() => expect(button("Rename Wiki").disabled).toBe(true));
    expect(button("Delete Wiki").disabled).toBe(true);

    settle(answer({ wiki: OTHER }));
    await waitFor(() => expect(button("Rename Wiki").disabled).toBe(false));
    expect(button("Delete Wiki").disabled).toBe(false);
  });
});

describe("the controls' gates", () => {
  it("offers neither control when the registry could not be read", () => {
    // "Rename this wiki" is a claim about the registry the server could not
    // make, and Delete would aim at a list that may be stale or empty.
    render(<WikiSwitcher wikis={[]} currentWikiId={null} unavailable />);
    expect(screen.queryByRole("button", { name: "Rename Wiki" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete Wiki" })).toBeNull();
  });

  it("offers neither control before the first wiki exists", () => {
    render(<WikiSwitcher wikis={[]} currentWikiId={null} />);
    expect(screen.queryByRole("button", { name: "Rename Wiki" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete Wiki" })).toBeNull();
    // New Wiki is the one control that ends that state, so it stays.
    expect(screen.getByRole("button", { name: "New Wiki" })).toBeTruthy();
  });
});
