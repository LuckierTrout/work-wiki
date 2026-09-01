import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  DELETE_PAGE_READ_ONLY_COPY,
  DeletePageButton,
} from "@/components/DeletePageButton";
import {
  EDIT_PAGE_READ_ONLY_COPY,
  partialSaveMessage,
  WikiEditor,
} from "@/components/WikiEditor";
import {
  REINGEST_READ_ONLY_COPY,
  ReingestButton,
} from "@/components/ReingestButton";
import {
  REVERT_READ_ONLY_COPY,
  RevisionHistory,
} from "@/components/RevisionHistory";
import { READ_ONLY_REFUSAL } from "@/lib/read-only";
import {
  WRITE_CONFLICT_COPY,
  WRITE_PRECONDITION_REQUIRED_COPY,
} from "@/lib/write-precondition";

/**
 * The page-write affordances OUTSIDE the Workbench shell, mounted
 * (DW-37, DW-149, DW-187).
 *
 * `PUT`/`PATCH`/`DELETE /api/wiki/[slug]`, `POST /api/ingest/reingest` and
 * `POST /api/wiki/[slug]/revisions {action:"revert"}` all refuse on a read-only
 * deployment. Before these gates existed every one of these surfaces succeeded,
 * so none had a reason to ask — and adding the gates without them is precisely
 * the harm DW-149 names: the owner accepts "Delete this page? This cannot be
 * undone.", rewrites an entire page, or answers a revert dialog, and meets the
 * 403 only afterwards.
 *
 * Every assertion is made on the outermost surface: what is on screen, whether
 * `window.confirm` was ever raised, and what requests were issued. A component
 * that kept the prop but wired it past the confirm fails here.
 */

const { router, clerk } = vi.hoisted(() => ({
  router: { refresh: vi.fn(), push: vi.fn() },
  clerk: {
    current: { isLoaded: true, isSignedIn: true, user: null } as {
      isLoaded: boolean;
      isSignedIn: boolean;
      user: { username?: string } | null;
    },
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
// `RevisionHistory` reads the Clerk session for the identity half of its Revert
// gate: the site owner keeps the door on a realm page, and since DW-392 a
// signed-out viewer has no Revert button at all — the route resolves a
// principal or refuses, so an anonymous browser POST never lands.
//
// SIGNED IN by default, therefore, and deliberately so: these cases are about
// the deployment's read-only state, not about who is looking, and with the mock
// signed out the Revert button would be absent for the identity reason and
// every read-only assertion below would pass vacuously. No username, so the
// viewer is NOT the site owner — the read-only refusal is what has to be
// visible, not an admin's extra door. Mutable (rather than a frozen literal) so
// the one case that IS about the signed-out viewer can say so.
vi.mock("@clerk/nextjs", () => ({ useUser: () => clerk.current }));

/** The default session every case starts from — see the mock above. */
const SIGNED_IN_READER = { isLoaded: true, isSignedIn: true, user: null };

let fetchMock: ReturnType<typeof vi.fn>;
let confirmMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clerk.current = { ...SIGNED_IN_READER };
  router.refresh.mockClear();
  router.push.mockClear();
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response);
  // Defaults to ACCEPTING, so a missing gate shows up as a request rather than
  // as a dialog nobody answered.
  confirmMock = vi.fn(() => true);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("confirm", confirmMock);
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's `cleanup()` lands after this one. Unmounting here tears the
  // tree down while the globals are still stubbed.
  cleanup();
  vi.unstubAllGlobals();
});

describe("Delete page, on a read-only deployment", () => {
  it("refuses before the confirm, and says why", () => {
    render(<DeletePageButton slug="alpha" readOnly />);
    const button = screen.getByRole("button", { name: "Delete this wiki page" });

    // `disabled` would take the control out of the tab order, so the owner
    // could neither reach it nor be told why it will not run.
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    button.focus();
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);

    // The dialog is the harm: answering it changes nothing, and its wording
    // ("This cannot be undone") is a promise the deployment cannot keep.
    expect(confirmMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();

    const note = screen.getByText(DELETE_PAGE_READ_ONLY_COPY);
    expect(note.getAttribute("role")).toBeNull();
    expect(document.getElementById(button.getAttribute("aria-describedby")!)).toBe(note);
  });

  it("deletes as before on a writable deployment", async () => {
    render(<DeletePageButton slug="alpha" />);
    const button = screen.getByRole("button", { name: "Delete this wiki page" });
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    expect(screen.queryByText(DELETE_PAGE_READ_ONLY_COPY)).toBeNull();

    fireEvent.click(button);

    expect(confirmMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/wiki/alpha");
    expect(init.method).toBe("DELETE");
  });

  it("still asks, and still writes nothing, when the owner declines", () => {
    // The pre-existing behaviour, pinned so the new early return cannot be
    // mistaken for the one that already handled a cancelled confirm.
    confirmMock.mockReturnValue(false);
    render(<DeletePageButton slug="alpha" />);

    fireEvent.click(screen.getByRole("button", { name: "Delete this wiki page" }));

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * The version the edit page derives from the WHOLE stored file and threads in.
 * A literal, not `contentVersion(...)`: what these cases pin is that whatever
 * the server computed reaches the wire unchanged, and re-deriving it here would
 * pass even if the component sent a version of its own making.
 */
const SEEDED_VERSION = "w1:2b-0123456789abcdeffedcba9876543210";

describe("Edit page, on a read-only deployment", () => {
  function mountEditor(
    props: { readOnly?: boolean; initialVersion?: string } = {},
  ) {
    return render(
      <WikiEditor
        slug="alpha"
        tenant="alice"
        initialContent={"# Alpha\n\noriginal body\n"}
        initialVersion={SEEDED_VERSION}
        {...props}
      />,
    );
  }

  function save(): HTMLButtonElement {
    return screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
  }

  it("says so before the owner starts typing, not after they finish", () => {
    mountEditor({ readOnly: true });
    const note = screen.getByText(EDIT_PAGE_READ_ONLY_COPY);
    // ABOVE the fields: the harm is a whole page rewritten before the refusal
    // arrives, so meeting it beside a dimmed Save at the bottom is too late.
    const textarea = screen.getByLabelText(/Markdown/);
    expect(
      note.compareDocumentPosition(textarea) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(note.getAttribute("role")).toBeNull();
  });

  it("keeps Save focusable before a single keystroke", () => {
    // The state an owner who reads the sentence and types nothing stays in.
    // `disabled={busy || !dirty}` would hold here, taking the button out of
    // the tab order and making its `aria-describedby` unreachable — the DW-65
    // defect, on the control whose refusal the sentence explains.
    mountEditor({ readOnly: true });
    const button = save();
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(document.getElementById(button.getAttribute("aria-describedby")!)).toBe(
      screen.getByText(EDIT_PAGE_READ_ONLY_COPY),
    );
  });

  it("still disables Save on an untouched writable page", () => {
    // The transient guard the read-only branch must not have loosened.
    mountEditor();
    expect(save().hasAttribute("disabled")).toBe(true);
  });

  it("keeps Save focusable, marks it aria-disabled, and issues no request", async () => {
    mountEditor({ readOnly: true });
    const textarea = screen.getByLabelText(/Markdown/);
    fireEvent.change(textarea, { target: { value: "# Alpha\n\nrewritten\n" } });

    const button = save();
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(document.getElementById(button.getAttribute("aria-describedby")!)).toBe(
      screen.getByText(EDIT_PAGE_READ_ONLY_COPY),
    );

    fireEvent.click(button);

    // Neither the PUT nor the PATCH.
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
    expect(router.push).not.toHaveBeenCalled();
  });

  it("refuses a submit that reaches past the button, as Enter in a field does", async () => {
    // `aria-disabled` does not stop a form submitting, which is exactly why the
    // guard lives in the handler rather than only on the control.
    const { container } = mountEditor({ readOnly: true });
    fireEvent.change(screen.getByLabelText(/Markdown/), {
      target: { value: "# Alpha\n\nrewritten\n" },
    });

    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });

  it("saves as before on a writable deployment", async () => {
    mountEditor();
    expect(screen.queryByText(EDIT_PAGE_READ_ONLY_COPY)).toBeNull();
    expect(save().hasAttribute("aria-disabled")).toBe(false);

    fireEvent.change(screen.getByLabelText(/Markdown/), {
      target: { value: "# Alpha\n\nrewritten\n" },
    });
    fireEvent.click(save());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/wiki/alpha");
    expect(init.method).toBe("PUT");
  });
});

// ---------------------------------------------------------------------------
// The write precondition on the edit page (DW-38, DW-51)
// ---------------------------------------------------------------------------
//
// `PUT /api/wiki/[slug]` REQUIRES `If-Match` and answers 428 without one, so
// "the form issued a PUT" is no longer enough: a PUT with no header is a save
// that cannot land. Only a mount can see the header, because the seam between
// the server component's `contentVersion` and the request is one prop and one
// spread — a node suite reading the source could be satisfied by either being
// deleted.

describe("Edit page — the write precondition", () => {
  const METADATA = {
    confidence: null,
    disputed: false,
    tags: [],
    aliases: [],
    expiry: "",
    valid_from: "",
    supersedes: "",
  };

  function mountEditor(initialVersion = SEEDED_VERSION) {
    return render(
      <WikiEditor
        slug="alpha"
        tenant="alice"
        initialContent={"# Alpha\n\noriginal body\n"}
        initialVersion={initialVersion}
        initialMetadata={METADATA}
      />,
    );
  }

  function save(): HTMLButtonElement {
    return screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
  }

  function rewriteBody(text = "# Alpha\n\nrewritten\n") {
    fireEvent.change(screen.getByLabelText(/Markdown/), { target: { value: text } });
  }

  /** Make the metadata leg fire too — the PATCH must stay ungated. */
  function touchMetadata() {
    fireEvent.click(screen.getByRole("switch", { name: /Disputed/i }));
  }

  function headersOf(call: number): Record<string, string> {
    const [, init] = fetchMock.mock.calls[call] as [string, RequestInit];
    return (init.headers ?? {}) as Record<string, string>;
  }

  it("sends the seeded version on the PUT, and nothing of the sort on the PATCH", async () => {
    mountEditor();
    rewriteBody();
    touchMetadata();

    fireEvent.click(save());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, put] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [, patch] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(put.method).toBe("PUT");
    expect(headersOf(0)["If-Match"]).toBe(`"${SEEDED_VERSION}"`);
    // The metadata leg is deliberately NOT gated by this story — a header here
    // would be a precondition on a route nothing checks it against.
    expect(patch.method).toBe("PATCH");
    expect(headersOf(1)["If-Match"]).toBeUndefined();
  });

  it("retries on the version the LANDED save answered, not the one it superseded", async () => {
    // A PUT that lands followed by a PATCH that fails leaves the form open with
    // the body still dirty. Re-sending the original version there would be
    // refused 412 — "changed somewhere else while you were editing" — about the
    // owner's own save, with no way out but a reload.
    const LANDED = "w1:2c-aaaaaaaabbbbbbbbccccccccdddddddd";
    fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ slug: "alpha", version: LANDED }),
        } as unknown as Response;
      }
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: "confidence must be a number" }),
      } as unknown as Response;
    });

    mountEditor();
    rewriteBody();
    touchMetadata();
    fireEvent.click(save());

    // The PATCH failed, so the form stayed open and said why — and since the
    // PUT had already landed, said which half of the save survived (DW-428).
    await waitFor(() =>
      expect(
        screen.getByText(partialSaveMessage("confidence must be a number")),
      ).toBeTruthy(),
    );
    expect(router.push).not.toHaveBeenCalled();
    expect(headersOf(0)["If-Match"]).toBe(`"${SEEDED_VERSION}"`);

    // The owner presses Save again without reloading.
    fireEvent.click(save());
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3));

    // THE bug: the retry must carry the version the first PUT answered with.
    expect(headersOf(2)["If-Match"]).toBe(`"${LANDED}"`);
    expect(headersOf(2)["If-Match"]).not.toBe(`"${SEEDED_VERSION}"`);
  });

  it("keeps the seeded version when a landed save answers no version at all", async () => {
    // The next save is then refused rather than blind, which is the safe
    // direction — and the form must not have crashed on the unparseable body.
    //
    // It is also the ONLY case anywhere that pins how "landed" is read for the
    // DW-428 sentence: `bodyLanded` is set on the `PUT`'s `res.ok` alone, one
    // line BEFORE its body is read, so a 200 whose payload will not parse still
    // reports "Your text was saved" below. That is deliberate — `res.ok` is
    // already what lets the `PATCH` fire at all, and a stricter notion used only
    // by the sentence would let one save be landed for the version it holds and
    // not landed for what it tells the owner. Move the assignment after the
    // parse and this case is what fails.
    fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token <");
          },
        } as unknown as Response;
      }
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: "nope" }),
      } as unknown as Response;
    });

    mountEditor();
    rewriteBody();
    touchMetadata();
    fireEvent.click(save());
    await waitFor(() =>
      expect(screen.getByText(partialSaveMessage("nope"))).toBeTruthy(),
    );

    fireEvent.click(save());
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(headersOf(2)["If-Match"]).toBe(`"${SEEDED_VERSION}"`);
  });

  /**
   * A REFUSED save, on the one surface where the draft is a whole page.
   *
   * The three sibling surfaces each pin this — `preview-dirty-guard` for the
   * Preview, `settings-read-only` for the canvas, `useSettings.test` for
   * `/settings`. This is the edit page's, and it is the surface where losing
   * the draft costs the most: the owner may have retyped the entire article.
   *
   * `WikiEditor` reaches its message through `throw new Error(body.error ?? …)`
   * and `getErrorMessage`, so the SERVER's sentence and a generic
   * `body save failed (412)` are one `??` term apart. Nothing else fails if
   * that term goes: the route suites never mount this component, the other
   * cases here all answer `ok: true`, and `write-precondition.test.ts` only
   * asserts the sentence is not TYPED in this file.
   */
  function refuseThePut(status: number, error: string) {
    fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return {
          ok: false,
          status,
          json: async () => ({ error }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
      } as unknown as Response;
    });
  }

  const REWRITTEN = "# Alpha\n\nan entire page, retyped\n";

  it("keeps the owner's whole draft and shows the SERVER's sentence on a 412", async () => {
    refuseThePut(412, WRITE_CONFLICT_COPY);

    mountEditor();
    rewriteBody(REWRITTEN);
    fireEvent.click(save());

    await waitFor(() => expect(screen.getByText(WRITE_CONFLICT_COPY)).toBeTruthy());

    // The draft survived the refusal, on screen and unedited.
    expect((screen.getByLabelText(/Markdown/) as HTMLTextAreaElement).value).toBe(
      REWRITTEN,
    );
    // Nothing navigated away from the text it is still holding.
    expect(router.push).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
    // …and Save is pressable again, so reloading is the owner's choice and not
    // the only way out of a form that latched.
    expect(save().disabled).toBe(false);
  });

  it("relays the 428 sentence too, rather than a status code", async () => {
    // Reachable whenever the seeded version did not survive to the wire — the
    // page was served before this story shipped, or a proxy dropped the header.
    refuseThePut(428, WRITE_PRECONDITION_REQUIRED_COPY);

    mountEditor();
    rewriteBody(REWRITTEN);
    fireEvent.click(save());

    await waitFor(() =>
      expect(screen.getByText(WRITE_PRECONDITION_REQUIRED_COPY)).toBeTruthy(),
    );
    expect((screen.getByLabelText(/Markdown/) as HTMLTextAreaElement).value).toBe(
      REWRITTEN,
    );
    expect(screen.queryByText(/428/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Which half of a two-leg save survived (DW-428)
// ---------------------------------------------------------------------------
//
// Save is TWO writes — `PUT` for the body, then `PATCH` for the metadata — and
// before this it reported only the served sentence of whichever leg failed.
// Every `PATCH` refusal is worded as "nothing was changed", so a save whose
// body was already stored read as a save that did nothing, and the owner's
// natural response — retype, or reload — throws away the body that landed.
//
// Only this form knows there were two writes, so the assertions are made on
// what the owner reads, through the component's own helper rather than a second
// copy of the wording.

describe("Edit page — a save that half landed", () => {
  const METADATA = {
    confidence: null,
    disputed: false,
    tags: [],
    aliases: [],
    expiry: "",
    valid_from: "",
    supersedes: "",
  };

  const REWRITTEN = "# Alpha\n\nan entire page, retyped\n";

  function mountEditor() {
    return render(
      <WikiEditor
        slug="alpha"
        tenant="alice"
        initialContent={"# Alpha\n\noriginal body\n"}
        initialVersion={SEEDED_VERSION}
        initialMetadata={METADATA}
      />,
    );
  }

  function save(): HTMLButtonElement {
    return screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
  }

  function rewriteBody(text = REWRITTEN) {
    fireEvent.change(screen.getByLabelText(/Markdown/), { target: { value: text } });
  }

  function touchMetadata() {
    fireEvent.click(screen.getByRole("switch", { name: /Disputed/i }));
  }

  /** The `PUT` lands; the `PATCH` is refused with a served sentence. */
  function landThePutRefuseThePatch(
    status: number,
    patchBody: () => Promise<{ error?: string }>,
  ) {
    fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ slug: "alpha", version: SEEDED_VERSION }),
        } as unknown as Response;
      }
      return { ok: false, status, json: patchBody } as unknown as Response;
    });
  }

  /**
   * The error alert as an ELEMENT rather than as its text.
   *
   * `Alert variant="error"` renders a plain styled `div` with no ARIA role, so
   * `queryByRole("alert")` would be null whether or not a sentence is on
   * screen — an absence assertion that can never fail. Matching the node lets
   * "no alert at all" be asserted without re-typing a fragment of the wording,
   * and it is used in BOTH directions below, so a selector that stopped
   * matching fails the cases expecting a sentence instead of quietly excusing
   * the ones expecting none.
   */
  function errorAlert(container: HTMLElement): HTMLElement | null {
    return container.querySelector<HTMLElement>(".bg-red-50");
  }

  /**
   * The composed sentence, typed out ONCE — the only literal of it anywhere.
   *
   * Every other assertion in this block builds its expectation by calling
   * `partialSaveMessage`, which compares the helper against itself: a helper
   * rewritten to drop the `served` relay, or reworded outright, would leave all
   * of them green. This is the fixed point they are anchored to. The server's
   * half is the imported constant rather than a second copy of server copy, so
   * only the client-owned prefix is spelled here.
   */
  const PREFIXED_READ_ONLY =
    "Your text was saved; the metadata change was not — " +
    READ_ONLY_REFUSAL.pageMetadata;

  it("says nothing at all when both legs land", async () => {
    // The default mock answers every call `ok: true`, so this is the shape the
    // prefix must stay off: two writes, both applied, and the owner sent to the
    // page rather than left reading about halves.
    const { container } = mountEditor();
    rewriteBody();
    touchMetadata();
    fireEvent.click(save());

    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/u/alice/alpha"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(router.refresh).toHaveBeenCalled();
    // No alert of any kind — not the prefix, and not a bare served sentence.
    // Asserted on the NODE, so a bare served sentence fails here too.
    expect(errorAlert(container)).toBeNull();
  });

  it("names both legs, relays the server's sentence, and keeps the draft", async () => {
    // The read-only 403 is the sharpest case: its own wording says metadata
    // "cannot be changed", which is true — and says nothing about the body this
    // deployment nonetheless stored a moment earlier.
    landThePutRefuseThePatch(403, async () => ({
      error: READ_ONLY_REFUSAL.pageMetadata,
    }));

    const { container } = mountEditor();
    rewriteBody();
    touchMetadata();
    fireEvent.click(save());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // The second leg went where it was meant to. `landThePutRefuseThePatch`
    // refuses everything that is not a `PUT`, so without this a save whose
    // metadata leg used the wrong verb or the wrong route would still be
    // reported as a metadata refusal.
    const [patchUrl, patchInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(patchUrl).toBe("/api/wiki/alpha");
    expect(patchInit.method).toBe("PATCH");

    // THE anchor, and the only assertion here that does not route through the
    // helper: the sentence on screen equals the literal above, character for
    // character. A reworded prefix fails, and so does a helper that stopped
    // relaying `served`.
    await waitFor(() => expect(errorAlert(container)).not.toBeNull());
    const alert = errorAlert(container)!;
    expect(alert.textContent).toBe(PREFIXED_READ_ONLY);
    // …and the server's own sentence is the TAIL of it, verbatim — the half
    // this form must relay untouched rather than paraphrase.
    expect(alert.textContent!.endsWith(READ_ONLY_REFUSAL.pageMetadata)).toBe(true);
    // The helper is what composes it, so it has to agree with the literal. This
    // is the tie that lets every other case here call the helper instead of
    // typing the sentence again.
    expect(partialSaveMessage(READ_ONLY_REFUSAL.pageMetadata)).toBe(
      PREFIXED_READ_ONLY,
    );

    // Nothing else about the refused-save path moved: the whole draft is still
    // on screen, the form is still open, and nothing navigated away.
    expect((screen.getByLabelText(/Markdown/) as HTMLTextAreaElement).value).toBe(
      REWRITTEN,
    );
    expect(router.push).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(save().disabled).toBe(false);
  });

  it("prefixes the status fallback too, when the refusal body will not parse", async () => {
    // The fallback still proves the metadata was not applied, so the same two
    // facts hold — and the owner is no less likely to retype over a landed body
    // because the server's sentence went missing.
    landThePutRefuseThePatch(500, async () => {
      throw new SyntaxError("Unexpected token <");
    });

    mountEditor();
    rewriteBody();
    touchMetadata();
    fireEvent.click(save());

    await waitFor(() =>
      expect(
        screen.getByText(partialSaveMessage("metadata save failed (500)")),
      ).toBeTruthy(),
    );
  });

  it("falls back to the status when the served error is an empty string", async () => {
    // The refusal body PARSES here, so the `??` that used to pick `served`
    // accepted `""` and composed a sentence ending in a dangling dash — the
    // owner learns their body was saved and is then told nothing at all about
    // why the metadata was not. The status line is what is left to say.
    landThePutRefuseThePatch(400, async () => ({ error: "" }));

    mountEditor();
    rewriteBody();
    touchMetadata();
    fireEvent.click(save());

    await waitFor(() =>
      expect(
        screen.getByText(partialSaveMessage("metadata save failed (400)")),
      ).toBeTruthy(),
    );
  });

  it("says nothing of the sort when only the metadata leg ran", async () => {
    // Body clean: there is no landed body to reassure anyone about, and a
    // prefix here would be a plain lie about text this save never sent.
    const SERVED = "confidence must be a number";
    fetchMock.mockImplementation(
      async () =>
        ({ ok: false, status: 400, json: async () => ({ error: SERVED }) }) as
          unknown as Response,
    );

    mountEditor();
    touchMetadata();
    fireEvent.click(save());

    await waitFor(() => expect(screen.getByText(SERVED)).toBeTruthy());
    expect(screen.queryByText(partialSaveMessage(SERVED))).toBeNull();
    // One request: the `PATCH`. No `PUT` fired, which is why nothing landed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("PATCH");
  });

  it("says nothing of the sort when the body leg itself was refused", async () => {
    fetchMock.mockImplementation(
      async () =>
        ({
          ok: false,
          status: 412,
          json: async () => ({ error: WRITE_CONFLICT_COPY }),
        }) as unknown as Response,
    );

    mountEditor();
    rewriteBody();
    touchMetadata();
    fireEvent.click(save());

    await waitFor(() => expect(screen.getByText(WRITE_CONFLICT_COPY)).toBeTruthy());
    expect(screen.queryByText(partialSaveMessage(WRITE_CONFLICT_COPY))).toBeNull();
    // The `PUT` short-circuits, so the `PATCH` never fired — which is what makes
    // "the body leg landed" unambiguous at the prefix site.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("PUT");
  });

  it("makes no claim about a metadata leg whose fetch never came back", async () => {
    // A dropped connection leaves the metadata outcome UNKNOWN. "the metadata
    // change was not" would be a claim nobody is in a position to make, so this
    // branch keeps the thrown message alone.
    const DROPPED = "Failed to fetch";
    fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ slug: "alpha", version: SEEDED_VERSION }),
        } as unknown as Response;
      }
      throw new TypeError(DROPPED);
    });

    mountEditor();
    rewriteBody();
    touchMetadata();
    fireEvent.click(save());

    await waitFor(() => expect(screen.getByText(DROPPED)).toBeTruthy());
    expect(screen.queryByText(partialSaveMessage(DROPPED))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Re-ingest (DW-187)
// ---------------------------------------------------------------------------

describe("Re-ingest, on a read-only deployment", () => {
  const label = "Re-ingest source content";

  it("issues no request, and says why", () => {
    render(<ReingestButton slug="alpha" readOnly />);
    const button = screen.getByRole("button", { name: label });

    // `disabled` would take the control out of the tab order, so the owner
    // could neither reach it nor be told why it will not run.
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    button.focus();
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);

    // The route answers 403 before it fetches the source or calls the model, so
    // an issued request would buy the owner a wait and a red error string in
    // place of a sentence that was available before they pressed.
    expect(fetchMock).not.toHaveBeenCalled();

    const note = screen.getByText(REINGEST_READ_ONLY_COPY);
    expect(note.getAttribute("role")).toBeNull();
    expect(document.getElementById(button.getAttribute("aria-describedby")!)).toBe(note);
  });

  it("re-ingests as before on a writable deployment", async () => {
    render(<ReingestButton slug="alpha" />);
    const button = screen.getByRole("button", { name: label });
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    expect(screen.queryByText(REINGEST_READ_ONLY_COPY)).toBeNull();

    fireEvent.click(button);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/ingest/reingest");
    expect(init.method).toBe("POST");
  });
});

// ---------------------------------------------------------------------------
// Revert a revision (DW-187, DW-149)
// ---------------------------------------------------------------------------

describe("Revert, on a read-only deployment", () => {
  const TIMESTAMP = 1_700_000_000_000;
  const REVERT_LABEL = `Restore revision from ${new Date(TIMESTAMP).toLocaleString()}`;

  /**
   * Mount the panel and expand it. `realmDeniesRevert={false}` — this suite is
   * about the READ-ONLY refusal, so the realm must not be what hides the button
   * (that gate has its own suite in `article-actions-delete-gate.test.tsx`). A
   * page outside the commons realm is what the server-computed prop would carry
   * here.
   *
   * Waits on View rather than on Revert: View is ungated, so it is the row
   * marker that is still there in the one case below where Revert is not.
   */
  async function renderHistory(readOnly: boolean) {
    fetchMock.mockImplementation(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            revisions: [
              {
                timestamp: TIMESTAMP,
                date: new Date(TIMESTAMP).toISOString(),
                slug: "alpha",
                sizeBytes: 2048,
                author: "yuanhao",
              },
            ],
          }),
        }) as unknown as Response,
    );
    render(
      <RevisionHistory slug="alpha" realmDeniesRevert={false} readOnly={readOnly} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /History/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^View revision from/ })).toBeTruthy(),
    );
  }

  /** The history panel loads its rows on expand, so every case starts there. */
  async function openHistory(readOnly: boolean) {
    await renderHistory(readOnly);
    return screen.getByRole("button", { name: REVERT_LABEL });
  }

  it("raises no dialog and issues no revert request", async () => {
    const button = await openHistory(true);

    // `disabled` is reserved for the transient `reverting` state; the standing
    // refusal has to leave the control reachable so its reason is announceable.
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    button.focus();
    expect(document.activeElement).toBe(button);

    const note = screen.getByText(REVERT_READ_ONLY_COPY);
    expect(note.getAttribute("role")).toBeNull();
    expect(document.getElementById(button.getAttribute("aria-describedby")!)).toBe(note);

    // One call so far: the GET that loaded the list. Reading history is not a
    // write and stays available on a read-only deployment.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(button);

    // The dialog is the harm — "The current content will be saved as a revision
    // first" is a promise the deployment cannot keep.
    expect(confirmMock).not.toHaveBeenCalled();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("reverts as before on a writable deployment", async () => {
    const button = await openHistory(false);
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    expect(screen.queryByText(REVERT_READ_ONLY_COPY)).toBeNull();

    fireEvent.click(button);

    expect(confirmMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/wiki/alpha/revisions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      action: "revert",
      timestamp: TIMESTAMP,
    });
  });

  it("shows a SIGNED-OUT viewer neither the button nor the note about it (DW-392)", async () => {
    // The read-only sentence is rendered only when `canRevert` is true, because
    // the Revert button's `aria-describedby` is its ONLY referrer. Since DW-392
    // `canRevert` also carries the signed-in term, so an anonymous viewer must
    // lose both together — a refusal shown to a reader who was never offered
    // the action, with nothing pointing at its id, is the orphan that gating
    // exists to prevent.
    clerk.current = { isLoaded: true, isSignedIn: false, user: null };
    await renderHistory(true);

    expect(screen.queryByRole("button", { name: REVERT_LABEL })).toBeNull();
    expect(screen.queryByText(REVERT_READ_ONLY_COPY)).toBeNull();
    // The dialog is the harm, so absence of the control is asserted at the
    // outermost surface too: nothing this viewer can reach raises the confirm.
    fireEvent.click(screen.getByRole("button", { name: /^View revision from/ }));
    expect(confirmMock).not.toHaveBeenCalled();
    // Reading an old revision is not a write: View survives the identity gate
    // exactly as it survives the read-only one.
    expect(screen.getByRole("button", { name: /^View revision from/ })).toBeTruthy();
  });
});
