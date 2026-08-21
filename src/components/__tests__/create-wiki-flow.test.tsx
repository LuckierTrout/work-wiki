import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WikiWorkbench } from "@/components/WikiWorkbench";
import {
  WorkbenchDataProvider,
  type WorkbenchData,
} from "@/components/workbench/WorkbenchData";
import { PREVIEW_UNSELECTED_COPY } from "@/lib/workbench-preview";
import type { WikiRecord } from "@/lib/wikis";

/**
 * The Wiki canvas, MOUNTED (DW-15).
 *
 * `create-wiki-ui.test.ts` reads this component's source and counts literals in
 * it, which is the right tool for "does the file still enumerate five scenarios"
 * and the wrong one for "does Cancel write nothing". Every assertion below is
 * made on the outermost surface instead: what is on screen, and what requests
 * were issued. A rewrite that keeps `applyTemplate` but wires `onConfirm` past
 * the dialog, or that drops `confirmDisabled`, leaves the source scan green and
 * fails here.
 *
 * The card takes no props (DW-174): every render below hands it its wikis
 * through a `WorkbenchDataProvider`, the same seam `page.tsx` uses.
 */

const { router } = vi.hoisted(() => ({ router: { refresh: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const refresh = router.refresh;

/**
 * The id is deliberately one that percent-encoding CHANGES. `applyTemplate`
 * builds its URL with `encodeURIComponent(current.id)`, and against a tidy
 * `wiki-1` that call could be deleted with every assertion still green — while
 * a real id carrying a slash would silently address a different route.
 */
const WIKI: WikiRecord = {
  id: "wiki 1/2",
  name: "Acme",
  scenario: "business",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const ENCODED_ID = "wiki%201%2F2";

/** The card's whole data input, defaulted to "nothing else loaded". */
function data(
  wikis: readonly WikiRecord[],
  currentWikiId: string | null,
  registryUnavailable = false,
): WorkbenchData {
  return {
    wikis,
    currentWikiId,
    registryUnavailable,
    knowledge: [],
    knowledgeUnavailable: false,
    files: [],
    filesUnavailable: false,
    filesTruncated: false,
    dataVersion: 0,
    readOnly: false,
  };
}

/** The card under the provider, exactly as `page.tsx` composes it. */
function mount(
  wikis: readonly WikiRecord[],
  currentWikiId: string | null,
  registryUnavailable = false,
) {
  return render(
    <WorkbenchDataProvider value={data(wikis, currentWikiId, registryUnavailable)}>
      <WikiWorkbench />
    </WorkbenchDataProvider>,
  );
}

/**
 * The subset of `Response` the shared `send` helper reads — `status` included,
 * because its failure fallback interpolates it and a fake without one renders
 * "Request failed (undefined)" at the owner with no test the wiser.
 */
function answer(body: unknown, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  refresh.mockClear();
  fetchMock = vi.fn(async () => answer({ wiki: WIKI }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's `cleanup()` lands after this one. Unmounting here tears the
  // tree down while `fetch` is still stubbed.
  cleanup();
  vi.unstubAllGlobals();
});

/** `toBeDisabled` is a jest-dom matcher and this repo installs no jest-dom. */
function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function openTemplateDialog() {
  mount([WIKI], WIKI.id);
  fireEvent.click(screen.getByRole("button", { name: "Change template" }));
  return screen.getByRole("dialog", { name: "Change Scenario Template" });
}

describe("Change template confirm gate", () => {
  it("disables Overwrite while the dialog still shows the wiki's own scenario", () => {
    openTemplateDialog();

    expect(button("Overwrite").disabled).toBe(true);
    expect(
      screen.getByText("Pick a different template to overwrite this wiki."),
    ).toBeTruthy();
  });

  it("enables Overwrite once a different scenario is picked", () => {
    openTemplateDialog();

    fireEvent.change(screen.getByLabelText("Scenario Template"), {
      target: { value: "research" },
    });

    expect(button("Overwrite").disabled).toBe(false);
  });

  it("writes NOTHING when the confirm is cancelled", () => {
    openTemplateDialog();
    fireEvent.change(screen.getByLabelText("Scenario Template"), {
      target: { value: "research" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // The claim is that no request was issued, so the observation is the spy's
    // call count — not a state flag the component happens to expose.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("posts the picked scenario to the wiki's template route on confirm", async () => {
    openTemplateDialog();
    fireEvent.change(screen.getByLabelText("Scenario Template"), {
      target: { value: "research" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/wikis/${ENCODED_ID}/template`);
    expect(url).not.toContain(WIKI.id);
    expect(init.method).toBe("POST");
    // The route parses the body as JSON; without this header it does not.
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    // Asserted at the COMPONENT boundary, not only in the helper's own unit
    // test: what is under test here is that this card still goes through
    // `send` (DW-175). Swapping it for a bare `fetch` keeps the URL, the method
    // and the body identical — the signal is the only thing that disappears,
    // and with it the deadline that stops a hung overwrite stranding `busy`.
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({ scenario: "research" });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("reports a gateway that gave up as an unknown outcome, never as a status code", async () => {
    // The ordinary shape of a route that dies before it can answer: an HTML
    // error page. `send` reads the body with `.json().catch(() => ({}))`, and
    // without that catch this rejects with a SyntaxError that reaches nobody —
    // the dialog would sit on "Working…" with no message.
    //
    // It used to read `Request failed (502)`: a string in no Copy table, naming
    // the transport rather than the thing that failed, and — worse — reported as
    // a FAILURE. A 502 comes from a proxy that either never reached this route
    // or never got its verdict, so the template may in fact have been applied
    // (DW-374). This card composes no verdict of its own; widening the shared
    // classifier is what put the honest sentence here.
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError("Unexpected token '<'");
      },
    } as unknown as Response);
    openTemplateDialog();
    fireEvent.change(screen.getByLabelText("Scenario Template"), {
      target: { value: "research" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("apply the template");
    expect(alert.textContent).toContain("unknown");
    expect(alert.textContent).not.toContain("502");
    expect(alert.textContent).not.toContain("Request failed");
    expect(
      screen.getByRole("dialog", { name: "Change Scenario Template" }).contains(alert),
    ).toBe(true);
    // …and the screen is reconciled rather than left describing a template that
    // may already have been overwritten.
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("keeps the dialog open and shows the failure inside it", async () => {
    fetchMock.mockResolvedValueOnce(
      answer({ error: "Template write failed." }, { ok: false, status: 409 }),
    );
    openTemplateDialog();
    fireEvent.change(screen.getByLabelText("Scenario Template"), {
      target: { value: "reading" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Template write failed.");
    // Inside the overlay — the backdrop covers everything rendered behind it.
    expect(
      screen.getByRole("dialog", { name: "Change Scenario Template" }).contains(alert),
    ).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("names the status code when the failure body carries no message", async () => {
    // A route that dies before it can shape a body is the ordinary 500, and the
    // owner still has to be told something other than "undefined".
    fetchMock.mockResolvedValueOnce(answer({}, { ok: false, status: 500 }));
    openTemplateDialog();
    fireEvent.change(screen.getByLabelText("Scenario Template"), {
      target: { value: "general" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Request failed (500)");
    expect(
      screen.getByRole("dialog", { name: "Change Scenario Template" }).contains(alert),
    ).toBe(true);
  });

  it("guards a 2xx whose body carries no wiki at all (DW-256)", async () => {
    // The one failure a green request makes look like success. Closing the
    // dialog and refreshing on this would paint the OLD template back as if the
    // overwrite had landed, with nothing on screen saying it had not.
    fetchMock.mockResolvedValueOnce(answer({}));
    openTemplateDialog();
    fireEvent.change(screen.getByLabelText("Scenario Template"), {
      target: { value: "research" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));

    const alert = await screen.findByRole("alert");
    // The operation's OWN sentence, not create's and not rename's.
    expect(alert.textContent).toBe("Couldn’t apply the template.");
    const dialog = screen.getByRole("dialog", { name: "Change Scenario Template" });
    expect(dialog.contains(alert)).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
    // The card behind it is intact — no blank render.
    expect(screen.getByText(WIKI.name)).toBeTruthy();
    // …and the confirm is pressable again rather than stranded on "Working…".
    expect(button("Overwrite").disabled).toBe(false);
  });
});

describe("Create Wiki", () => {
  it("writes NOTHING when the dialog is cancelled from the empty state", () => {
    mount([], null);
    fireEvent.click(screen.getByRole("button", { name: "Create Wiki" }));
    expect(screen.getByRole("dialog", { name: "Create Wiki" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("No wiki yet.")).toBeTruthy();
  });

  it("posts the picked scenario and asks for the server render that carries it", async () => {
    mount([], null);
    fireEvent.click(screen.getByRole("button", { name: "Create Wiki" }));

    fireEvent.click(screen.getByRole("button", { name: /Research/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/wikis");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    // The deadline, observed where the component hands it over — see the
    // re-template test above for why the URL and body cannot stand in for it.
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({
      name: "Research",
      scenario: "research",
    });
    // Deliberately NOT optimistic (DW-174): the provider is the card's single
    // source, so the new record reaches it only through the server render
    // `router.refresh()` asks for. Until then the empty state is still the
    // truth, exactly as `WikiSwitcher.create` already documents for the header.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText("No wiki yet.")).toBeTruthy();
    expect(screen.queryByText(WIKI.name)).toBeNull();
  });

  it("shuts its own door until the server render lands", async () => {
    // The card is not optimistic, so on success `No wiki yet.` and its primary
    // action are STILL on screen for the length of the refresh — and the
    // sentence is already false. Nothing enforces unique wiki names, so a
    // second press there seeds a SECOND wiki and makes it active, moving every
    // prompt onto its template.
    const view = render(
      <WorkbenchDataProvider value={data([], null)}>
        <WikiWorkbench />
      </WorkbenchDataProvider>,
    );
    fireEvent.click(button("Create Wiki"));
    fireEvent.click(button("Create"));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const opener = button("Create Wiki");
    expect(opener.disabled).toBe(true);

    // Pressed anyway — no dialog, and no second POST.
    fireEvent.click(opener);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A server render LANDING is what reopens it, whatever it says. This one
    // answers without the new wiki — a refresh that lost the race — and the
    // owner still gets their button back rather than a control dead forever.
    view.rerender(
      <WorkbenchDataProvider value={data([], null)}>
        <WikiWorkbench />
      </WorkbenchDataProvider>,
    );
    await waitFor(() => expect(button("Create Wiki").disabled).toBe(false));
  });

  it("lands the keyboard on the card heading once the empty state goes", async () => {
    // `useDialogA11y` only reaches `fallbackFocusRef` when the opener is
    // already detached at close time, and with optimism gone it is NOT: the
    // dialog closes over a `Create Wiki` button that is still mounted, focus is
    // restored to it, and only then does the arriving server render take it
    // away — dropping the keyboard user on <body> with no dialog left to blame.
    render(
      <WorkbenchDataProvider value={data([], null)}>
        <WikiWorkbench />
      </WorkbenchDataProvider>,
    );
    const opener = button("Create Wiki");
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(button("Create"));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const heading = screen.getByRole("heading", { name: "Wiki" });
    // The move is an effect that runs after the dialog's own focus restore, so
    // it is waited for rather than read immediately.
    await waitFor(() => expect(document.activeElement).toBe(heading));
    // Not the opener the refresh is about to unmount.
    expect(document.activeElement).not.toBe(opener);
  });

  it("keeps the dialog open and shows the failure inside it", async () => {
    // `create()`'s catch. The overlay's backdrop covers everything this
    // component renders behind it, so a message put anywhere else is a message
    // the owner cannot read — they would see the spinner stop and nothing else.
    fetchMock.mockResolvedValueOnce(
      answer({ error: "A wiki with that name already exists." }, { ok: false, status: 409 }),
    );
    mount([], null);
    fireEvent.click(screen.getByRole("button", { name: "Create Wiki" }));

    fireEvent.click(button("Create"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("A wiki with that name already exists.");
    expect(screen.getByRole("dialog", { name: "Create Wiki" }).contains(alert)).toBe(true);
    // Nothing was seeded, so the empty state is still the truth behind it.
    expect(screen.getByText("No wiki yet.")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("guards a 2xx whose body carries no wiki at all", async () => {
    // Pushing `undefined` into `wikis` here crashes the very next render on
    // `wiki.id`, which is a BLANK PAGE rather than the message below — the one
    // failure mode a green request makes look like success.
    fetchMock.mockResolvedValueOnce(answer({}));
    mount([], null);
    fireEvent.click(screen.getByRole("button", { name: "Create Wiki" }));

    fireEvent.click(button("Create"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Couldn’t create the wiki.");
    expect(screen.getByRole("dialog", { name: "Create Wiki" }).contains(alert)).toBe(true);
    // The canvas behind it is intact: no blank render, no wiki card.
    expect(screen.getByText("No wiki yet.")).toBeTruthy();
    expect(screen.queryByText(WIKI.name)).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("a request that never settles (DW-175, DW-283)", () => {
  /**
   * The card's `send` had no deadline at all: a hung create or re-template left
   * `busy` true for the rest of the session, both dialogs locked, and nothing
   * on screen saying why. The shared helper arms `AbortSignal.timeout`, and
   * BOTH abort flavours reach the catch as an error whose `name` is the whole
   * signal — the message names the MECHANISM ("signal timed out", "This
   * operation was aborted") rather than the thing the owner was trying to do.
   *
   * WHAT THE MESSAGE MAY CLAIM is the second half (DW-283). The deadline fires
   * on THIS side: the request left, and nothing came back. `Couldn’t create the
   * wiki.` is therefore a statement about the server that the client is in no
   * position to make — and the owner who believes it presses Create again and
   * seeds a second wiki, or presses Overwrite again over a template that was
   * already rewritten. So the sentence names the unknown outcome, and the card
   * refreshes so the screen can answer what the message cannot.
   *
   * The abort is delivered rather than waited for: a real 15s deadline is not
   * something a suite can sit through, and what is under test is what the card
   * does with it. Built with `Object.assign(new Error(...), { name })` and NOT
   * with a real `DOMException`, because jsdom's DOMException does not inherit
   * from Error — `writeFailure`'s `cause instanceof Error` would be false and
   * the sentence below would arrive from its last line whatever the abort
   * branch did.
   */
  const ABORTS: ReadonlyArray<readonly [string, string]> = [
    ["TimeoutError", "signal timed out"],
    ["AbortError", "This operation was aborted"],
  ];

  for (const [name, mechanism] of ABORTS) {
    it(`reports a re-template's outcome as unknown, and reconciles, on a ${name}`, async () => {
      fetchMock.mockRejectedValueOnce(Object.assign(new Error(mechanism), { name }));
      openTemplateDialog();
      fireEvent.change(screen.getByLabelText("Scenario Template"), {
        target: { value: "research" },
      });

      fireEvent.click(button("Overwrite"));

      const alert = await screen.findByRole("alert");
      // Not the flat failure, and not the mechanism either.
      expect(alert.textContent).not.toBe("Couldn’t apply the template.");
      expect(alert.textContent).not.toContain(mechanism);
      expect(alert.textContent).toContain("apply the template");
      expect(alert.textContent).toContain("unknown");
      expect(
        screen.getByRole("dialog", { name: "Change Scenario Template" }).contains(alert),
      ).toBe(true);
      // The overwrite may have landed, so the card cannot go on rendering the
      // template it was showing before as though nothing had happened.
      await waitFor(() => expect(refresh).toHaveBeenCalled());
      // The confirm comes back rather than staying on "Working…" forever — the
      // whole point of the deadline, since `finally` cannot rescue a promise
      // that never resolves.
      await waitFor(() => expect(button("Overwrite").disabled).toBe(false));
      expect(button("Cancel").disabled).toBe(false);
    });

    it(`reports a create's outcome as unknown, and shuts the door, on a ${name}`, async () => {
      fetchMock.mockRejectedValueOnce(Object.assign(new Error(mechanism), { name }));
      mount([], null);
      fireEvent.click(button("Create Wiki"));

      fireEvent.click(button("Create"));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).not.toBe("Couldn’t create the wiki.");
      expect(alert.textContent).not.toContain(mechanism);
      expect(alert.textContent).toContain("create the wiki");
      expect(alert.textContent).toContain("unknown");
      expect(screen.getByRole("dialog", { name: "Create Wiki" }).contains(alert)).toBe(
        true,
      );
      await waitFor(() => expect(refresh).toHaveBeenCalled());
      // The dialog is pressable again, so the owner can retry deliberately…
      await waitFor(() => expect(button("Create").disabled).toBe(false));
      // …but the empty state behind it does NOT offer a second way in. The POST
      // may have seeded a wiki; `router.refresh()` is a spy here, so the server
      // render never lands and the door stays shut exactly as it does for the
      // length of a real round trip. Nothing enforces unique wiki names, so an
      // enabled button here is a duplicate wiki and every prompt moved onto its
      // template.
      expect(screen.getByText("No wiki yet.")).toBeTruthy();
      expect(button("Create Wiki").disabled).toBe(true);
    });
  }
});

describe("the read-failure branch", () => {
  it("says the read failed even when it was handed wikis and a current id", () => {
    // The degraded render's hard case. The provider's `wikis` is a PLACEHOLDER
    // when `registryUnavailable` is up, not an observation — so a card built
    // from it would describe a wiki the server never confirmed, and the flag has
    // to outrank the whole `current` branch rather than merely stand in for an
    // empty list.
    mount([WIKI], WIKI.id, true);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Your wikis couldn’t be loaded. Reload to try again.");
    // Not the empty state: "No wiki yet." is a claim about the registry this
    // render cannot make, and its Create Wiki button would seed a duplicate
    // wiki and move every prompt onto its template on a transient read error.
    expect(screen.queryByText("No wiki yet.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create Wiki" })).toBeNull();
    // …and not the wiki card either, which is the half an empty-list render
    // cannot ask about at all.
    expect(screen.queryByText(WIKI.name)).toBeNull();
    expect(screen.queryByRole("button", { name: "Change template" })).toBeNull();
    expect(screen.queryByText(PREVIEW_UNSELECTED_COPY)).toBeNull();
  });
});
