import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WikiSwitcher } from "@/components/workbench/WikiSwitcher";
import { WIKI_READ_ONLY_COPY, WIKI_SCOPE_COPY } from "@/lib/workbench-tree";
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

/**
 * The switch requests only. Filtered by URL rather than counted off the whole
 * spy, so a suite that also creates or renames cannot make a re-entry claim on
 * the strength of somebody else's POST.
 */
function currentWrites(): Array<[string, RequestInit]> {
  return fetchMock.mock.calls.filter(
    ([url]) => url === "/api/wikis/current",
  ) as Array<[string, RequestInit]>;
}

function mount(wikis: readonly WikiRecord[] = [CURRENT, OTHER]) {
  return render(<WikiSwitcher wikis={wikis} currentWikiId={CURRENT.id} />);
}

/**
 * Arm a `fetch` this test resolves BY HAND, so a second press lands while the
 * first request is still in flight. `mockImplementationOnce`, so a later call
 * falls back to the settling default and a missing gate shows up as a second
 * call rather than as a hang.
 */
function deferNextRequest(): (value: Response) => void {
  let release!: (value: Response) => void;
  fetchMock.mockImplementationOnce(
    () => new Promise<Response>((resolve) => (release = resolve)),
  );
  return (value) => release(value);
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
    // The deadline, observed at the COMPONENT boundary rather than only in the
    // helper's own unit test (DW-175). A rewrite that dropped `send` for a bare
    // `fetch` would keep the URL, the method and the body exactly as asserted
    // above — the signal is the only thing that would go, and with it the one
    // thing that can end a request that never settles.
    expect(init.signal).toBeInstanceOf(AbortSignal);
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

  it("issues exactly ONE PATCH when the confirm is pressed twice (DW-255)", async () => {
    // Two PATCHes can settle out of order, leaving the registry on whichever
    // answer happened to land last. Both ways into this dialog are pressed —
    // the confirm button and the input's Enter.
    //
    // What this OBSERVES is the outermost surface: one request, whatever
    // refused the second press. It cannot attribute the refusal to `rename()`'s
    // own `if (busy) return`, because the button is `disabled` (React
    // dispatches no click) and the Enter path is stopped by the input's own
    // guard first. The handler guard is defence in depth behind both, and only
    // a source scan can see that it is still there —
    // `workbench-left-column.test.ts` holds that pin.
    const release = deferNextRequest();
    mount();
    fireEvent.click(button("Rename Wiki"));
    const input = screen.getByLabelText("Wiki name");
    fireEvent.change(input, { target: { value: "Q4 plan" } });
    fireEvent.click(button("Rename"));

    // The confirm's accessible NAME changes while busy, so re-querying
    // "Rename" would throw instead of asserting.
    const confirm = button("Working…");
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    fireEvent.keyDown(input, { key: "Enter" });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      release(answer({ wiki: CURRENT }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("guards a 2xx whose body carries no wiki at all (DW-256)", async () => {
    // The one failure a green request makes look like success: closing the
    // dialog and refreshing on this would show the OLD name back as though the
    // rename had landed, with nothing on screen saying it had not.
    fetchMock.mockResolvedValueOnce(answer({}));
    mount();
    fireEvent.click(button("Rename Wiki"));
    fireEvent.change(screen.getByLabelText("Wiki name"), {
      target: { value: "Q4 plan" },
    });

    fireEvent.click(button("Rename"));

    const alert = await screen.findByRole("alert");
    // This operation's OWN sentence — not create's, and not delete's.
    expect(alert.textContent).toBe("Couldn’t rename the wiki.");
    expect(screen.getByRole("dialog", { name: "Rename Wiki" }).contains(alert)).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
    // …and the confirm is pressable again rather than stranded on "Working…".
    expect(button("Rename").disabled).toBe(false);
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

  it("issues exactly ONE DELETE when the confirm is pressed twice (DW-255)", async () => {
    // A second DELETE behind the first answers 404 and paints a failure over an
    // operation that in fact succeeded — on the one control here that cannot be
    // undone. One request is the claim; which of the two guards refused the
    // second press is not observable from out here (see the rename case above).
    const release = deferNextRequest();
    mount();
    fireEvent.click(button("Delete Wiki"));
    fireEvent.click(button("Delete"));

    const confirm = button("Working…");
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/wikis/${OTHER_ENCODED}`);

    await act(async () => {
      release(answer({ wiki: OTHER }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("guards a 2xx whose body carries no wiki at all (DW-256)", async () => {
    // Closing on this would take the row off screen and refresh, so the owner
    // reads a delete that never happened — and the wiki reappears on the next
    // load with no explanation.
    fetchMock.mockResolvedValueOnce(answer({}));
    mount();
    fireEvent.click(button("Delete Wiki"));

    fireEvent.click(button("Delete"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Couldn’t delete the wiki.");
    expect(screen.getByRole("dialog", { name: "Delete Wiki" }).contains(alert)).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
    // Nothing left the list behind the overlay.
    const picker = screen.getByLabelText("Wiki to delete") as HTMLSelectElement;
    expect([...picker.options].map((option) => option.value)).toEqual([OTHER.id]);
    expect(
      [...(screen.getByLabelText("Active wiki") as HTMLSelectElement).options],
    ).toHaveLength(2);
    expect(button("Delete").disabled).toBe(false);
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

  it("starts exactly ONE PUT, and takes the next switch once that one settles", async () => {
    // `switchWiki`'s `if (switching) return`. A second PUT started here could
    // settle out of ORDER, leaving the shell on a wiki the owner had already
    // left — and `router.refresh()` would then refetch the tree for it.
    const THIRD: WikiRecord = { ...OTHER, id: "wiki 5/6", name: "Third" };
    let settle!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (settle = resolve)),
    );
    render(
      <WikiSwitcher wikis={[CURRENT, OTHER, THIRD]} currentWikiId={CURRENT.id} />,
    );
    const select = screen.getByLabelText("Active wiki") as HTMLSelectElement;

    fireEvent.change(select, { target: { value: OTHER.id } });
    // A DIFFERENT wiki, so the picker's value really moves and React really
    // fires a second change — re-picking the value it already holds would be a
    // no-op event and the guard would never be asked anything.
    fireEvent.change(select, { target: { value: THIRD.id } });

    expect(currentWrites()).toHaveLength(1);
    expect(JSON.parse(String(currentWrites()[0][1].body))).toEqual({ id: OTHER.id });

    settle(answer({}));
    await waitFor(() => expect(select.disabled).toBe(false));

    // Refused while one was in flight, taken the moment it is not — the guard
    // is a queue of one, not a control that stays shut.
    fireEvent.change(select, { target: { value: THIRD.id } });

    await waitFor(() => expect(currentWrites()).toHaveLength(2));
    expect(JSON.parse(String(currentWrites()[1][1].body))).toEqual({ id: THIRD.id });
  });

  /**
   * `send` arms `AbortSignal.timeout`, and BOTH abort flavours reach the catch
   * as an error whose `name` is the whole signal: the message names the
   * mechanism ("signal timed out", "This operation was aborted") rather than
   * the thing the owner was trying to do. One line in `writeFailure` maps the
   * pair, so both are driven here.
   *
   * And the deadline fires on THIS side (DW-283): the PUT left, nothing came
   * back, and the active wiki may already have moved. `Couldn’t switch wiki.`
   * would be a claim about the server the client cannot make — and this is the
   * write where believing it costs most, because the active wiki decides which
   * `schema.md` every prompt on the shell executes. So the sentence names the
   * unknown outcome and the switcher refreshes to find out.
   *
   * Built with `Object.assign(new Error(...), { name })` and NOT with a real
   * `DOMException`: jsdom's DOMException does not inherit from Error, so
   * `writeFailure`'s `cause instanceof Error` would be false and the sentence
   * below would arrive from the function's last line whatever the abort branch
   * did — a test that passes for the wrong reason.
   */
  const ABORTS: ReadonlyArray<readonly [string, string]> = [
    ["TimeoutError", "signal timed out"],
    ["AbortError", "This operation was aborted"],
  ];

  for (const [name, mechanismMessage] of ABORTS) {
    it(`reports the switch's outcome as unknown, and reconciles, on a ${name}`, async () => {
      fetchMock.mockRejectedValueOnce(
        Object.assign(new Error(mechanismMessage), { name }),
      );
      mount();

      fireEvent.change(screen.getByLabelText("Active wiki"), {
        target: { value: OTHER.id },
      });

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).not.toBe("Couldn’t switch wiki.");
      expect(alert.textContent).not.toContain(mechanismMessage);
      expect(alert.textContent).toContain("switch wiki");
      expect(alert.textContent).toContain("unknown");
      // The screen is reconciled rather than left describing a wiki that may no
      // longer be the live one.
      await waitFor(() => expect(refresh).toHaveBeenCalled());
      // The optimistic pick is rolled back, so the control names the wiki the
      // server last CONFIRMED rather than the one the owner may or may not have
      // reached — the refresh above is what settles which.
      await waitFor(() =>
        expect((screen.getByLabelText("Active wiki") as HTMLSelectElement).value).toBe(
          CURRENT.id,
        ),
      );
    });
  }

  it("tells a stated refusal apart from an unknown one, and refreshes on neither but the second", async () => {
    // The other half of the verdict, on the same control: a route that answered
    // with a reason ANSWERED. Nothing is unknown, nothing is stale, and a
    // refresh would be a round trip for nothing.
    fetchMock.mockResolvedValueOnce(
      answer({ error: "That wiki no longer exists." }, { ok: false, status: 404 }),
    );
    mount();

    fireEvent.change(screen.getByLabelText("Active wiki"), {
      target: { value: OTHER.id },
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("That wiki no longer exists.");
    await waitFor(() =>
      expect((screen.getByLabelText("Active wiki") as HTMLSelectElement).value).toBe(
        CURRENT.id,
      ),
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("every write here reports an unknown outcome, not a failure (DW-283)", () => {
  /**
   * The switch case above drives one of FOUR writes. `create`, `rename` and
   * `remove` carry the same catch, and the same `if (unconfirmed)
   * router.refresh()` — and none of them was observable from this file: their
   * existing failure cases feed a server-stated refusal or a malformed 2xx,
   * both of which are KNOWN outcomes that correctly refresh nothing. Deleting
   * the refresh from all three left this suite green.
   *
   * The abort is delivered rather than waited for, and built with
   * `Object.assign(new Error(...), { name })` rather than a real
   * `DOMException`, for the reasons the switch case states in full.
   */
  const ABORTS: ReadonlyArray<readonly [string, string]> = [
    ["TimeoutError", "signal timed out"],
    ["AbortError", "This operation was aborted"],
  ];

  /**
   * Each write, with the phrase `writeFailure` composes its sentences from and
   * the clicks that reach it. The phrase is asserted rather than the whole
   * sentence: the wording has one owner in `workbench-request.ts`, and
   * `workbench-request.test.ts` executes it — what this file is for is that the
   * right ACTION reached it and that the refresh fired.
   */
  const WRITES: ReadonlyArray<{
    readonly label: string;
    readonly action: string;
    readonly open: () => void;
    readonly confirm: string;
    readonly dialog: string;
  }> = [
    {
      label: "New Wiki",
      action: "create the wiki",
      open: () => fireEvent.click(button("New Wiki")),
      confirm: "Create",
      dialog: "Create Wiki",
    },
    {
      label: "Rename",
      action: "rename the wiki",
      open: () => {
        fireEvent.click(button("Rename Wiki"));
        fireEvent.change(screen.getByLabelText("Wiki name"), {
          target: { value: "Q4 plan" },
        });
      },
      confirm: "Rename",
      dialog: "Rename Wiki",
    },
    {
      label: "Delete",
      action: "delete the wiki",
      open: () => fireEvent.click(button("Delete Wiki")),
      confirm: "Delete",
      dialog: "Delete Wiki",
    },
  ];

  for (const [name, mechanismMessage] of ABORTS) {
    for (const write of WRITES) {
      it(`${write.label} reports an unknown outcome and reconciles on a ${name}`, async () => {
        fetchMock.mockRejectedValueOnce(
          Object.assign(new Error(mechanismMessage), { name }),
        );
        mount();
        write.open();

        fireEvent.click(button(write.confirm));

        const alert = await screen.findByRole("alert");
        expect(alert.textContent).not.toBe(`Couldn’t ${write.action}.`);
        expect(alert.textContent).not.toContain(mechanismMessage);
        expect(alert.textContent).toContain(write.action);
        expect(alert.textContent).toContain("unknown");
        // Into the dialog, which stays OPEN: its backdrop covers the column
        // behind it, so a message painted on the section would be invisible.
        expect(
          screen.getByRole("dialog", { name: write.dialog }).contains(alert),
        ).toBe(true);
        // THE assertion this suite was missing. The request was abandoned on
        // this side, so the registry may already hold the new wiki, the new
        // name, or one wiki fewer — and every one of those is on screen here.
        await waitFor(() => expect(refresh).toHaveBeenCalled());
        // …and the busy state clears rather than stranding on "Working…" — the
        // LATCH, not `busy`, is what holds the confirm down from here (DW-375),
        // which the suite below is about.
        await waitFor(() => expect(button("Cancel").disabled).toBe(false));
      });
    }
  }
});

/**
 * DW-375: what the owner can PRESS once a write's outcome is unknown.
 *
 * None of the three dialogs closes on that path — the message is inside the
 * overlay, so it has to stay open — and until this change all three stayed open
 * with a LIVE confirm over a write that may already have landed. A second press
 * seeds a duplicate wiki, renames twice, or paints a repeat DELETE's 404 over a
 * delete that succeeded.
 *
 * Every assertion is on the button, not on a flag: `confirmDisabled` is the
 * whole deliverable, and it has to be the confirm ALONE — `busy` would take
 * Cancel and Esc with it and leave the owner behind a modal they were just told
 * to look past.
 */
describe("an unconfirmed write latches the confirm until a server render (DW-375)", () => {
  const abort = () =>
    Object.assign(new Error("signal timed out"), { name: "TimeoutError" });

  /** The same three writes, plus the request each one must not issue twice. */
  const WRITES: ReadonlyArray<{
    readonly label: string;
    readonly open: () => void;
    readonly confirm: string;
    readonly dialog: string;
    readonly url: string;
  }> = [
    {
      label: "create",
      open: () => fireEvent.click(button("New Wiki")),
      confirm: "Create",
      dialog: "Create Wiki",
      url: "/api/wikis",
    },
    {
      label: "rename",
      open: () => {
        fireEvent.click(button("Rename Wiki"));
        fireEvent.change(screen.getByLabelText("Wiki name"), {
          target: { value: "Q4 plan" },
        });
      },
      confirm: "Rename",
      dialog: "Rename Wiki",
      url: `/api/wikis/${CURRENT_ENCODED}`,
    },
    {
      label: "delete",
      open: () => fireEvent.click(button("Delete Wiki")),
      confirm: "Delete",
      dialog: "Delete Wiki",
      url: `/api/wikis/${OTHER_ENCODED}`,
    },
  ];

  for (const write of WRITES) {
    it(`shuts ${write.label}'s confirm while leaving Cancel and Esc live`, async () => {
      fetchMock.mockRejectedValueOnce(abort());
      mount();
      write.open();
      fireEvent.click(button(write.confirm));
      await screen.findByRole("alert");

      // The dialog is still there — the sentence lives inside it.
      expect(screen.getByRole("dialog", { name: write.dialog })).toBeTruthy();
      // …and the one control that could repeat the write is dead.
      await waitFor(() => expect(button(write.confirm).disabled).toBe(true));
      // Every way OUT is still open. The message tells the owner to go and look
      // at the screen, and a modal they cannot dismiss is not a screen.
      expect(button("Cancel").disabled).toBe(false);

      // Pressing the dead button writes nothing — asserted on the SPY, not on
      // the attribute, because `disabled` is the affordance and the handler's
      // early return is the refusal.
      const before = fetchMock.mock.calls.length;
      fireEvent.click(button(write.confirm));
      expect(fetchMock.mock.calls.length).toBe(before);
      expect(
        fetchMock.mock.calls.filter(([url]) => url === write.url),
      ).toHaveLength(1);

      // Esc still dismisses, which is the half `busy` would have taken away.
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it(`gives ${write.label}'s confirm back once a server render arrives`, async () => {
      fetchMock.mockRejectedValueOnce(abort());
      const view = mount();
      write.open();
      fireEvent.click(button(write.confirm));
      await screen.findByRole("alert");
      await waitFor(() => expect(button(write.confirm).disabled).toBe(true));

      // A fresh array is what a server render IS — `page.tsx` reads the registry
      // every time. Deliberately answering the SAME two wikis: a refresh that
      // says nothing changed must still give the owner their button back, or the
      // control is dead with no explanation and no way to revive it.
      view.rerender(
        <WikiSwitcher wikis={[CURRENT, OTHER]} currentWikiId={CURRENT.id} />,
      );

      await waitFor(() => expect(button(write.confirm).disabled).toBe(false));
    });
  }

  it("leaves the rename field LIVE and editable, with only its Enter path shut", async () => {
    // The latch is the confirm's and nothing else's. A disabled input would drop
    // out of the tab order, so a keyboard owner could not reach — let alone
    // correct — the name they were about to submit, and the sentence they have
    // just read tells them to go and look at what is on screen.
    //
    // That makes this the delicate half: the field accepts keystrokes, so a
    // GUARD is the only thing between Enter and a second PATCH. Two carry it —
    // the keydown handler and `rename`'s own early return — and each is
    // unreachable behind the other, so this case can only observe that the pair
    // refuses. `workbench-left-column.test.ts` pins each line individually, for
    // exactly the reason it states about unreachable guards.
    fetchMock.mockRejectedValueOnce(abort());
    mount();
    fireEvent.click(button("Rename Wiki"));
    const input = screen.getByLabelText("Wiki name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Q4 plan" } });
    fireEvent.click(button("Rename"));
    await screen.findByRole("alert");
    await waitFor(() => expect(button("Rename").disabled).toBe(true));

    // The owner's text is still on screen — a failed write must never be the
    // thing that loses it — and the field is still a field.
    expect(input.value).toBe("Q4 plan");
    expect(input.disabled).toBe(false);

    // It still TAKES the keystroke: the owner can correct the name while the
    // confirm is down. Asserted rather than assumed, because a test that only
    // pressed Enter at a disabled input would prove nothing about the guard.
    fireEvent.change(input, { target: { value: "Q4 roadmap" } });
    expect(input.value).toBe("Q4 roadmap");

    // …and Enter into that live field writes NOTHING. The spy is the assertion,
    // not the attribute: the handler's early return IS the refusal here.
    const before = fetchMock.mock.calls.length;
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fetchMock.mock.calls.length).toBe(before);
    expect(
      fetchMock.mock.calls.filter(([url]) => url === `/api/wikis/${CURRENT_ENCODED}`),
    ).toHaveLength(1);
  });

  for (const write of WRITES) {
    it(`keeps ${write.label}'s sentence when the owner dismisses and reopens`, async () => {
      // The exact move the message invites: "check what the screen shows before
      // trying again" means dismiss this dialog and look. The openers all clear
      // their error unconditionally, so before this fix that round trip
      // presented a DEAD confirm with nothing on screen explaining why — the
      // worst of both, since the owner can neither act nor find out why not.
      fetchMock.mockRejectedValueOnce(abort());
      mount();
      write.open();
      fireEvent.click(button(write.confirm));
      const alert = await screen.findByRole("alert");
      const sentence = alert.textContent ?? "";
      expect(sentence).toContain("unknown");
      await waitFor(() => expect(button(write.confirm).disabled).toBe(true));

      // Out…
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

      // …and back in. Nothing has arrived from the server in between, so both
      // facts must still hold: the door is shut, and the reason is on screen.
      write.open();
      expect(screen.getByRole("dialog", { name: write.dialog })).toBeTruthy();
      expect(button(write.confirm).disabled).toBe(true);
      const reopened = await screen.findByRole("alert");
      expect(reopened.textContent).toBe(sentence);
      expect(
        screen.getByRole("dialog", { name: write.dialog }).contains(reopened),
      ).toBe(true);
    });
  }

  it("clears a stale sentence on the NEXT open once the latch has been released", async () => {
    // The other side of it: the message is kept only while it is still the
    // reason the confirm is down. Once a server render has arrived the owner has
    // been told what is actually there, and reopening starts clean rather than
    // showing them an answer to a question that has been settled.
    fetchMock.mockRejectedValueOnce(abort());
    const view = mount();
    fireEvent.click(button("New Wiki"));
    fireEvent.click(button("Create"));
    await screen.findByRole("alert");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    view.rerender(<WikiSwitcher wikis={[CURRENT, OTHER]} currentWikiId={CURRENT.id} />);

    fireEvent.click(button("New Wiki"));
    expect(button("Create").disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("leaves a STATED refusal's confirm alone — that outcome is known", async () => {
    // The other edge of the rule. A route that answered with a reason answered:
    // nothing landed, so the owner may fix the name and press Rename again
    // immediately. Latching here would strand them behind a dead button waiting
    // for a refresh that is never issued.
    fetchMock.mockResolvedValueOnce(
      answer({ error: "Wiki name is required." }, { ok: false, status: 400 }),
    );
    mount();
    fireEvent.click(button("Rename Wiki"));
    fireEvent.change(screen.getByLabelText("Wiki name"), { target: { value: "Q4" } });
    fireEvent.click(button("Rename"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Wiki name is required.");
    await waitFor(() => expect(button("Rename").disabled).toBe(false));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("latches on a 502 too — the widened classifier reaches every write here", async () => {
    // DW-374 and DW-375 meeting: the switcher composes no verdict of its own, so
    // widening `writeFailure` is what puts a gateway on this path at all.
    fetchMock.mockResolvedValueOnce(
      answer({ error: "Bad Gateway" }, { ok: false, status: 502 }),
    );
    mount();
    fireEvent.click(button("New Wiki"));
    fireEvent.click(button("Create"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("unknown");
    expect(alert.textContent).toContain("create the wiki");
    expect(alert.textContent).not.toContain("502");
    expect(alert.textContent).not.toContain("Bad Gateway");
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await waitFor(() => expect(button("Create").disabled).toBe(true));
    expect(button("Cancel").disabled).toBe(false);
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

describe("the Wiki-scope sentence", () => {
  /**
   * A Wiki is a LENS, not a partition: Pages and Sources stay in the one tenant
   * silo, so a switch changes only `purpose.md` and Schema while the Knowledge
   * and Files trees keep showing the same rows (DW-30). Unsaid, that reads as a
   * broken switcher. Asserted against the imported constant, never a retyped
   * string — the wording has one owner.
   */
  it("tells the owner what a switch changes, beneath the switcher", () => {
    mount();
    const note = screen.getByText(WIKI_SCOPE_COPY);
    expect(note.tagName).toBe("P");
    // Not an alert: nothing failed, and the switcher's real error owns that
    // channel. A `role="alert"` here would interrupt on every mount.
    expect(note.getAttribute("role")).toBeNull();
    // It describes the control directly above it, so it must follow the row
    // that holds it rather than float somewhere else in the header.
    const row = document.querySelector(".wb-wiki-switch-row");
    expect(row).not.toBeNull();
    expect(
      row!.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // FOLLOWING alone is also set for a CONTAINED node (the mask is 20), and
    // the row is `display: flex` — so folding the <p> back inside it would put
    // the sentence on the same LINE as the <select> and leave the check above
    // green. It must be the row's next sibling, outside it.
    expect(row!.contains(note)).toBe(false);
    expect(row!.nextElementSibling).toBe(note);
  });

  it("points the switcher at the sentence for a user who cannot see it sits below", () => {
    // Visual proximity is the whole affordance for a sighted owner and nothing
    // at all here: without this the control announces as "Active wiki,
    // combobox" and the scope note is never reached.
    mount();
    const select = screen.getByLabelText("Active wiki");
    const described = select.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    // Resolves to a real element, and that element is the one holding the copy.
    const target = document.getElementById(described!);
    expect(target).not.toBeNull();
    expect(target!.textContent).toBe(WIKI_SCOPE_COPY);
    expect(target).toBe(screen.getByText(WIKI_SCOPE_COPY));
  });

  it("claims nothing about wikis the registry could not read", () => {
    // The component cannot say what a switch does when it could not load the
    // list to switch between — only the failure sentence renders.
    render(<WikiSwitcher wikis={[]} currentWikiId={null} unavailable />);
    expect(screen.queryByText(WIKI_SCOPE_COPY)).toBeNull();
    expect(screen.queryByLabelText("Active wiki")).toBeNull();
  });

  it("stays away before the first wiki exists", () => {
    // No switcher, so nothing to explain: `New Wiki` stands alone.
    render(<WikiSwitcher wikis={[]} currentWikiId={null} />);
    expect(screen.queryByText(WIKI_SCOPE_COPY)).toBeNull();
    expect(screen.queryByLabelText("Active wiki")).toBeNull();
    expect(screen.getByRole("button", { name: "New Wiki" })).toBeTruthy();
  });

  it("stays put while a switch is in flight", async () => {
    // Only controls are disabled mid-switch. The sentence is a statement of
    // design, not of progress, so it must not flicker away and back.
    let settle!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (settle = resolve)),
    );
    mount();
    fireEvent.change(screen.getByLabelText("Active wiki"), {
      target: { value: OTHER.id },
    });

    await waitFor(() => expect(button("Rename Wiki").disabled).toBe(true));
    expect(screen.getByText(WIKI_SCOPE_COPY)).toBeTruthy();

    settle(answer({ wiki: OTHER }));
    await waitFor(() => expect(button("Rename Wiki").disabled).toBe(false));
    expect(screen.getByText(WIKI_SCOPE_COPY)).toBeTruthy();
  });
});

describe("a read-only deployment (DW-37)", () => {
  /**
   * `POST /api/wikis`, `PUT /api/wikis/current` and `PATCH`/`DELETE
   * /api/wikis/[id]` all answer 403 while `YOPEDIA_READONLY=1`, so every control
   * here is an affordance in front of a refusal. The convention is
   * `aria-disabled` plus a handler that returns early, NEVER `disabled`:
   * read-only means read-only, not hidden — a keyboard user must still be able
   * to reach the switcher and read which Wiki is active.
   */
  function mountReadOnly(wikis: readonly WikiRecord[] = [CURRENT, OTHER]) {
    return render(
      <WikiSwitcher wikis={wikis} currentWikiId={CURRENT.id} readOnly />,
    );
  }

  it("keeps every control reachable and marks it aria-disabled, never disabled", () => {
    mountReadOnly();
    const select = screen.getByLabelText("Active wiki") as HTMLSelectElement;
    const controls: HTMLElement[] = [
      select,
      button("New Wiki"),
      button("Rename Wiki"),
      button("Delete Wiki"),
    ];
    for (const control of controls) {
      // `disabled` would take it out of the tab order, which is the whole bug:
      // the owner could neither focus it nor read what it holds.
      expect((control as HTMLButtonElement | HTMLSelectElement).disabled).toBe(false);
      expect(control.hasAttribute("disabled")).toBe(false);
      expect(control.getAttribute("aria-disabled")).toBe("true");
      // Focusable in fact, not just in theory.
      control.focus();
      expect(document.activeElement).toBe(control);
    }
    // And it still REPORTS the active Wiki rather than going blank.
    expect(select.value).toBe(CURRENT.id);
  });

  it("issues no request and opens no dialog from New, Rename or Delete", () => {
    mountReadOnly();
    for (const name of ["New Wiki", "Rename Wiki", "Delete Wiki"]) {
      fireEvent.click(button(name));
      // The dialog is the harm: Delete's confirm reads "for good" and the
      // server was never going to run it.
      expect(screen.queryByRole("dialog")).toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refuses a switch and puts the picker back on the active wiki", async () => {
    mountReadOnly();
    const select = screen.getByLabelText("Active wiki") as HTMLSelectElement;

    fireEvent.change(select, { target: { value: OTHER.id } });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    // The observable that matters: the control still names the active Wiki. The
    // handler commits nothing and React re-applies the controlled value, so a
    // refused pick never leaves the picker on "Shelf" while the app is on
    // "Acme".
    await waitFor(() => expect(select.value).toBe(CURRENT.id));
    expect(select.value).not.toBe(OTHER.id);
  });

  it("says why, from the module that owns the sentence", () => {
    mountReadOnly();
    const note = screen.getByText(WIKI_READ_ONLY_COPY);
    expect(note.tagName).toBe("P");
    // Not an alert: nothing failed, this is the deployment's standing state.
    expect(note.getAttribute("role")).toBeNull();
    // The controls carry no `disabled` reason of their own, so the sentence is
    // wired as their description — an `aria-disabled` control otherwise
    // announces "dimmed" and nothing about why.
    for (const name of ["New Wiki", "Rename Wiki", "Delete Wiki"]) {
      expect(document.getElementById(button(name).getAttribute("aria-describedby")!)).toBe(
        note,
      );
    }
    // The <select> included — and it is the one that most needs it, because
    // WIKI_READ_ONLY_COPY says wikis cannot be SWITCHED. It already describes
    // itself with the scope sentence, so the read-only sentence is APPENDED:
    // `aria-describedby` is a space-separated list, and both are true at once.
    const select = screen.getByLabelText("Active wiki");
    const described = (select.getAttribute("aria-describedby") ?? "").split(/\s+/);
    expect(described).toHaveLength(2);
    const announced = described.map((id) => document.getElementById(id));
    expect(announced.every((element) => element !== null)).toBe(true);
    expect(announced.map((element) => element!.textContent)).toEqual([
      WIKI_SCOPE_COPY,
      WIKI_READ_ONLY_COPY,
    ]);
  });

  it("explains the New Wiki button even before the first wiki exists", () => {
    // `New Wiki` renders with no switcher above it, so the sentence cannot be
    // gated on `wikis.length` — it would leave the one visible control refusing
    // silently.
    render(<WikiSwitcher wikis={[]} currentWikiId={null} readOnly />);
    expect(screen.getByText(WIKI_READ_ONLY_COPY)).toBeTruthy();
    expect(button("New Wiki").getAttribute("aria-disabled")).toBe("true");
  });

  it("stays away on a writable deployment", () => {
    mount();
    expect(screen.queryByText(WIKI_READ_ONLY_COPY)).toBeNull();
    // No stray `aria-disabled="false"`: the hover face keys off the attribute's
    // presence, so a writable deployment must not carry it at all.
    for (const control of [
      screen.getByLabelText("Active wiki"),
      button("New Wiki"),
      button("Rename Wiki"),
      button("Delete Wiki"),
    ]) {
      expect(control.hasAttribute("aria-disabled")).toBe(false);
    }
    // …and the switcher's description is the scope sentence ALONE, so the id
    // list never names a paragraph that is not on screen.
    const select = screen.getByLabelText("Active wiki");
    expect(select.getAttribute("aria-describedby")).not.toContain(" ");
    expect(document.getElementById(select.getAttribute("aria-describedby")!)?.textContent)
      .toBe(WIKI_SCOPE_COPY);
  });
});

describe("the option labels (DW-148)", () => {
  /**
   * Nothing enforces unique Wiki names, so two rows spelled `Acme` are a state
   * the registry really reaches — and one of the two pickers below fronts an
   * IRREVERSIBLE delete. Same name, different template, different day,
   * different id: the label has to separate them on the strength of the three
   * facts that are not the name.
   */
  const TWIN_A: WikiRecord = {
    id: "wiki 7/8",
    name: "Acme",
    scenario: "research",
    createdAt: "2026-03-03T00:00:00.000Z",
    updatedAt: "2026-03-03T00:00:00.000Z",
  };
  const TWIN_B: WikiRecord = {
    id: "wiki 9/0",
    name: "Acme",
    scenario: "reading",
    createdAt: "2026-04-04T00:00:00.000Z",
    updatedAt: "2026-04-04T00:00:00.000Z",
  };

  function textsOf(select: HTMLSelectElement): string[] {
    return [...select.options].map((option) => option.textContent ?? "");
  }

  it("distinguishes two same-named wikis in the switcher", () => {
    mount([CURRENT, TWIN_A, TWIN_B]);

    const texts = textsOf(screen.getByLabelText("Active wiki") as HTMLSelectElement);
    expect(new Set(texts).size).toBe(texts.length);
    for (const wiki of [CURRENT, TWIN_A, TWIN_B]) {
      const text = texts[[CURRENT, TWIN_A, TWIN_B].indexOf(wiki)];
      expect(text).toContain(wiki.name);
      // The head of the UUID — the one discriminator nothing else on screen
      // repeats, and the reason two wikis made from one template on one day
      // still differ.
      expect(text).toContain(wiki.id.slice(0, 8));
      expect(text).toContain(wiki.createdAt.slice(0, 10));
    }
  });

  it("distinguishes them in the delete picker too, from the same helper", () => {
    // The picker that matters: both twins are deletable here (neither is
    // active), so bare names would make an irreversible choice a coin flip.
    mount([CURRENT, TWIN_A, TWIN_B]);
    fireEvent.click(button("Delete Wiki"));

    const picker = screen.getByLabelText("Wiki to delete") as HTMLSelectElement;
    const texts = textsOf(picker);
    expect([...picker.options].map((option) => option.value)).toEqual([
      TWIN_A.id,
      TWIN_B.id,
    ]);
    expect(new Set(texts).size).toBe(texts.length);

    // ONE spelling for both pickers: the delete row reads exactly as the
    // switcher row for the same wiki, so the owner is not asked to match two
    // different renderings of the same registry.
    const switcherTexts = textsOf(
      screen.getByLabelText("Active wiki") as HTMLSelectElement,
    );
    expect(texts).toEqual([switcherTexts[1], switcherTexts[2]]);
  });
});
