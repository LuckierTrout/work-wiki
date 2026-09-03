import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NamesTermsSettings } from "@/components/NamesTermsSettings";
import { unconfirmedWriteMessage } from "@/lib/workbench-request";

/**
 * The unconfirmed-write gate AT AN ADOPTING SITE, mounted (DW-717).
 *
 * `workbench-request.test.ts` proves `readJsonBody` in isolation: a 2xx read
 * that dies rethrows, a 2xx that merely fails to parse resolves `{}`, a non-2xx
 * is left alone. What it cannot say is whether any of the eighteen surfaces
 * that adopted it actually TURNS that into the behaviour the matrix promises —
 * the sentence in front of the owner, the reconciliation, and the absence of a
 * failure claim. Every one of those sites keeps its own `fetch`, its own
 * helper and its own catch, so the gate landing correctly in the library says
 * nothing about the surface.
 *
 * `NamesTermsSettings` stands in for the eighteen. It is the smallest of them
 * that has all three parts — a local `request` helper over its own `fetch`, a
 * write catch reporting through `writeFailure`, and a `load()` to reconcile
 * through — and it already has a harness to steal
 * (`names-terms-read-only.test.tsx`). Everything here is asserted on the
 * OUTERMOST surface: what is on screen, and what requests went out.
 *
 * The three rows executed here are the matrix's first, fourth and fifth:
 *
 *   - a 2xx whose body read DIES mid-stream — the cause reaches the catch, the
 *     owner is told the outcome is unknown, and the list is refetched;
 *   - a GATEWAY status (502) on the same write — the same sentence and the same
 *     refetch. This one is what carrying the STATUS on the thrown error buys:
 *     with a bare `Error` the message `Request failed (502)` is all that
 *     survives, `unconfirmedCause` cannot read a status out of a sentence, and
 *     the owner is told a hand-off was a settled failure;
 *   - a STATED REFUSAL (400 with `{ error }`) — the route's own sentence,
 *     unchanged, and NO refetch, because nothing is in doubt.
 */

const ENTRY = {
  id: "nt-1",
  kind: "person" as const,
  canonical: "Christian Lee",
  aliases: ["Chris"],
  description: "",
  email: "",
  role: "",
  organization: "",
  guidance: "",
};

/** The action phrase `NamesTermsSettings.save` hands `writeFailure`. */
const SAVE_ACTION = "save this entry";

let fetchMock: ReturnType<typeof vi.fn>;

/** The mount read, and every later GET: the stored dictionary. */
function listAnswer() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ entries: [ENTRY] }),
  } as unknown as Response;
}

/** Requests by method. `undefined` is the helper's own GET. */
function calls(method: string | undefined): unknown[][] {
  return fetchMock.mock.calls.filter(
    (call) => (call[1] as RequestInit | undefined)?.method === method,
  );
}

const reads = () => calls(undefined);
const posts = () => calls("POST");

/**
 * Fill the editor and submit. The button is `disabled` until `canonical` has
 * something in it, so the typing is not decoration.
 */
function saveNewEntry() {
  fireEvent.change(screen.getByPlaceholderText("Christian Lee"), {
    target: { value: "Ada Lovelace" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Remember this" }));
}

/** The feedback banner's text, whatever its variant. */
async function bannerText(): Promise<string> {
  const node = await screen.findByRole("status");
  return node.textContent ?? "";
}

beforeEach(() => {
  fetchMock = vi.fn(async () => listAnswer());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's `cleanup()` lands after this one and would unmount with the
  // globals still stubbed.
  cleanup();
  vi.unstubAllGlobals();
});

describe("a write whose outcome is unknown, at an adopting site (DW-717)", () => {
  it("reports an UNKNOWN outcome and refetches when a 2xx body read dies", async () => {
    render(<NamesTermsSettings />);
    await screen.findByText("Christian Lee");
    const readsBefore = reads().length;

    // The 200 ARRIVED and the body read then died — an abort, a fired deadline,
    // a `TypeError` off a dropped socket. The entry may be stored in full.
    // Before the gate had an owner this resolved `{}`, the destructure read a
    // missing `entry`, and the owner was told the save failed.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw Object.assign(new Error("signal timed out"), {
          name: "TimeoutError",
        });
      },
    } as unknown as Response);

    saveNewEntry();

    expect(await bannerText()).toBe(unconfirmedWriteMessage(SAVE_ACTION));
    // The words that must NOT be on screen: this is the whole defect. The
    // sentence speaks about a missing confirmation, never about a failure.
    expect(await bannerText()).not.toContain("Couldn’t");
    expect(await bannerText()).toContain("unknown");
    // …and the surface reconciles, so the owner is sent to a list that has been
    // refetched rather than to the stale one they were already looking at.
    await waitFor(() => expect(reads().length).toBe(readsBefore + 1));
    expect(posts()).toHaveLength(1);
  });

  it("keeps the sentence when the RECONCILING refetch dies the same way", async () => {
    // The likeliest real shape of this failure, and the one the ordering exists
    // for: the connection that lost the write is STILL DOWN when the refetch
    // goes out. `load` does not clear `feedback` on its way in — but its CATCH
    // writes to that same slot, so a sentence set before the refetch is
    // replaced by `Failed to fetch`: raw transport vocabulary, in place of the
    // one sentence that tells the owner their entry may be stored.
    render(<NamesTermsSettings />);
    await screen.findByText("Christian Lee");

    const dead = () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new TypeError("Failed to fetch");
        },
      }) as unknown as Response;

    // The POST, then the reconciling GET, both dying mid-body.
    fetchMock.mockResolvedValueOnce(dead());
    fetchMock.mockResolvedValueOnce(dead());

    saveNewEntry();

    await waitFor(() => expect(reads().length).toBeGreaterThan(1));
    expect(await bannerText()).toBe(unconfirmedWriteMessage(SAVE_ACTION));
    expect(await bannerText()).not.toContain("Failed to fetch");
  });

  it("reports the SAME unknown outcome for a gateway status", async () => {
    // 502: a proxy saying it could not get a usable reply out of the origin. No
    // route composed it, and the origin may have applied the write in full.
    //
    // This case is why the adopting helper throws `RequestFailedError` and not
    // a bare `Error`. `unconfirmedCause` classifies a 502 by reading the STATUS
    // off the error; a bare throw leaves only the string `Request failed (502)`
    // behind, `writeFailure` falls through to its "relay the message" branch,
    // and the owner is told a hand-off was a settled failure over a write that
    // may well have landed. Swap the throw back and this case fails while every
    // other assertion in the file stays green.
    render(<NamesTermsSettings />);
    await screen.findByText("Christian Lee");
    const readsBefore = reads().length;

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({}),
    } as unknown as Response);

    saveNewEntry();

    expect(await bannerText()).toBe(unconfirmedWriteMessage(SAVE_ACTION));
    // The proxy's own rendering of the status never reaches the owner.
    expect(await bannerText()).not.toContain("502");
    await waitFor(() => expect(reads().length).toBe(readsBefore + 1));
  });

  it("relays a STATED refusal unchanged, and reconciles nothing", async () => {
    // A 400 the route composed: it ran, it decided, it said so. Calling that an
    // unknown outcome would send the owner to reconcile a screen that is
    // already correct — and refetching would be a request made for no reason.
    render(<NamesTermsSettings />);
    await screen.findByText("Christian Lee");
    const readsBefore = reads().length;

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "A name or term is required." }),
    } as unknown as Response);

    saveNewEntry();

    expect(await bannerText()).toBe("A name or term is required.");
    // No refetch: `unconfirmed` is false, so nothing on this screen is in
    // doubt. Awaited past the POST settling so a late read would still be seen.
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(reads().length).toBe(readsBefore);
  });
});
