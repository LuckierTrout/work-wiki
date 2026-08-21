import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  DELETE_PAGE_READ_ONLY_COPY,
  DeletePageButton,
} from "@/components/DeletePageButton";
import { EDIT_PAGE_READ_ONLY_COPY, WikiEditor } from "@/components/WikiEditor";
import {
  REINGEST_READ_ONLY_COPY,
  ReingestButton,
} from "@/components/ReingestButton";
import {
  REVERT_READ_ONLY_COPY,
  RevisionHistory,
} from "@/components/RevisionHistory";
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

const { router } = vi.hoisted(() => ({
  router: { refresh: vi.fn(), push: vi.fn() },
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
// `RevisionHistory` reads the Clerk session for the identity half of its Revert
// gate: the site owner keeps the door on a realm page, and since DW-392 being
// SIGNED IN at all is a term — an anonymous viewer is offered no Restore button,
// because `POST /api/wiki/[slug]/revisions` is a write the middleware 401s.
//
// So this session is signed in, and NOT as the site owner. These cases are about
// the deployment's read-only refusal, which is the only thing that may hide or
// annotate the control here; a signed-out session would remove the button for an
// unrelated reason and make every "raises no dialog" assertion vacuous. The
// session gate has its own suite in `revision-revert-session-gate.test.tsx`.
//
// "NOT the site owner" is ENFORCED below, not assumed: `yuanhao` is the handle
// `.env.example` ships as `NEXT_PUBLIC_OWNER_HANDLE`, and `isOwnerHandle` reads
// that var at call time — so on any machine where it is exported this viewer
// would silently become the site owner and the premise here would be void. The
// `beforeEach` deletes it, mirroring the guard the session suite uses.
vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({
    isLoaded: true,
    isSignedIn: true,
    user: { username: "yuanhao" },
  }),
}));

let fetchMock: ReturnType<typeof vi.fn>;
let confirmMock: ReturnType<typeof vi.fn>;

let originalOwnerHandle: string | undefined;

beforeEach(() => {
  router.refresh.mockClear();
  router.push.mockClear();
  // See the Clerk mock above: this keeps the signed-in viewer a NON-owner
  // regardless of what is exported in the shell running the suite.
  originalOwnerHandle = process.env.NEXT_PUBLIC_OWNER_HANDLE;
  delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
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
  if (originalOwnerHandle === undefined) delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
  else process.env.NEXT_PUBLIC_OWNER_HANDLE = originalOwnerHandle;
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

    // The PATCH failed, so the form stayed open and said why.
    await waitFor(() =>
      expect(screen.getByText("confidence must be a number")).toBeTruthy(),
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
    await waitFor(() => expect(screen.getByText("nope")).toBeTruthy());

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

  /** The history panel loads its rows on expand, so every case starts there. */
  async function openHistory(readOnly: boolean) {
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
    // `realmDeniesRevert={false}` — this suite is about the READ-ONLY refusal,
    // so the realm must not be what hides the button (that gate has its own
    // suite in `article-actions-delete-gate.test.tsx`). A page outside the
    // commons realm is what the server-computed prop would carry here.
    render(
      <RevisionHistory slug="alpha" realmDeniesRevert={false} readOnly={readOnly} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /History/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: REVERT_LABEL })).toBeTruthy(),
    );
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
});
