/**
 * The one request helper the workbench's client components share (DW-175).
 *
 * Its invariants are the kind a source scan can only spell: the JSON content
 * type, the deadline, and the `...init` FIRST spread order.
 *
 * The copy in `WikiWorkbench.tsx` armed no signal at all, so a hung create left
 * that card's `busy` flag up for the rest of the session with no message to
 * explain it — that one was a live defect. It also spread the caller OVER the
 * headers, which cost nothing while both call sites passed only `method` and
 * `body`: the content type went out either way. The order matters for the call
 * nobody has written yet, which is exactly the kind of invariant that is worth
 * executing rather than trusting.
 *
 * So the helper is EXERCISED here against a stubbed `fetch`: what reaches the
 * network is read off the call, not matched against the file's text.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REQUEST_TIMEOUT_MS,
  send,
  writeFailure,
} from "../workbench-request";

/** The subset of `Response` `send` reads — `status` included. */
function answer(body: unknown, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body } as unknown as Response;
}

function stubFetch(response: () => Promise<Response> | Response) {
  const mock = vi.fn(async () => response());
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("send", () => {
  it("declares the JSON content type and arms the deadline", async () => {
    const mock = stubFetch(() => answer({ wiki: { id: "w1" } }));

    await expect(
      send<{ wiki: { id: string } }>("/api/wikis", {
        method: "POST",
        body: JSON.stringify({ name: "Acme" }),
      }),
    ).resolves.toEqual({ wiki: { id: "w1" } });

    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/wikis");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    // A deadline is present at all: `finally` cannot rescue a promise that
    // never settles, so this is the only thing that ever will.
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  it("keeps both invariants when the caller passes headers of its own", async () => {
    // The `...init` FIRST order, EXECUTED — and the only shape in which that
    // order is observable at all. Spread the other way round, this caller's
    // `headers` object replaces the helper's whole map and the content type
    // disappears with no diagnostic anywhere; a call passing only `method` and
    // `body` cannot tell the two orders apart.
    const mock = stubFetch(() => answer({}));

    await send("/api/wikis/w1", {
      method: "PATCH",
      headers: { "X-Test": "1" },
      body: JSON.stringify({ name: "Acme" }),
    });

    const [, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Test")).toBe("1");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses to let a caller drop the deadline by passing its own signal", async () => {
    // The caller's `signal` is overwritten, not merged: the deadline is this
    // helper's promise to every consumer, and a call that could opt out of it
    // is a call that can strand a busy flag forever.
    const mock = stubFetch(() => answer({}));
    const caller = new AbortController();

    await send("/api/wikis", { method: "POST", signal: caller.signal });

    const [, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).not.toBe(caller.signal);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws the server's own message on a non-2xx", async () => {
    stubFetch(() => answer({ error: "A wiki with that name already exists." }, {
      ok: false,
      status: 409,
    }));

    await expect(send("/api/wikis", { method: "POST" })).rejects.toThrow(
      "A wiki with that name already exists.",
    );
  });

  it("names the status when the failure body carries no message at all", async () => {
    // The ordinary shape of a route that dies before it can answer — including
    // an HTML error page, whose `json()` rejects and is caught into `{}`.
    stubFetch(
      () =>
        ({
          ok: false,
          status: 502,
          json: async () => {
            throw new SyntaxError("Unexpected token '<'");
          },
        }) as unknown as Response,
    );

    await expect(send("/api/wikis", { method: "POST" })).rejects.toThrow(
      "Request failed (502)",
    );
  });

  it("has a deadline long enough to be a rescue rather than a second failure mode", () => {
    // Named rather than asserted exactly: what matters is that it exists and is
    // measured in seconds, not that it is any particular number.
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  });
});

describe("writeFailure", () => {
  /**
   * BOTH abort flavours reach a caller's catch as an error whose `name` is the
   * whole signal: the message names the MECHANISM ("signal timed out", "This
   * operation was aborted") rather than the thing the owner was trying to do.
   *
   * Built with `Object.assign(new Error(...), { name })` and NOT with a real
   * `DOMException`: jsdom's DOMException does not inherit from Error, so
   * `cause instanceof Error` would be false and the fallback would arrive from
   * the function's last line whatever the abort branch did.
   */
  const ABORTS: ReadonlyArray<readonly [string, string]> = [
    ["TimeoutError", "signal timed out"],
    ["AbortError", "This operation was aborted"],
  ];

  for (const [name, mechanism] of ABORTS) {
    it(`reports a ${name} as an outcome nobody knows (DW-283)`, () => {
      const verdict = writeFailure(
        Object.assign(new Error(mechanism), { name }),
        "create the wiki",
      );

      // The whole defect: this used to answer `Couldn’t create the wiki.` — a
      // claim about the SERVER that the client is in no position to make. The
      // request left; the deadline fired on this side; nothing came back.
      expect(verdict.unconfirmed).toBe(true);
      expect(verdict.message).not.toBe("Couldn’t create the wiki.");
      // It says the outcome is unknown, and it names the action rather than the
      // mechanism the abort was spelled with.
      expect(verdict.message).toContain("unknown");
      expect(verdict.message).toContain("create the wiki");
      expect(verdict.message).not.toContain(mechanism);
    });
  }

  it("composes both sentences from ONE phrase per call site", () => {
    // The reason `action` is a phrase rather than a finished sentence: the
    // failure copy and the unknown-outcome copy are two renderings of one fact,
    // and a caller passing both would be where they start to disagree.
    for (const action of [
      "create the wiki",
      "apply the template",
      "switch wiki",
      "rename the wiki",
      "delete the wiki",
    ]) {
      const abort = Object.assign(new Error("signal timed out"), {
        name: "TimeoutError",
      });
      expect(writeFailure(abort, action).message).toContain(action);
      // Today's sentence, character for character — curly apostrophe included.
      expect(writeFailure(new Error(""), action).message).toBe(`Couldn’t ${action}.`);
    }
  });

  it("prefers a server-supplied message, and calls that outcome KNOWN", () => {
    const verdict = writeFailure(new Error("Wiki name is required."), "rename the wiki");
    expect(verdict.message).toBe("Wiki name is required.");
    // A route that answered with a reason answered: there is nothing to
    // reconcile, and refreshing on it would be a round trip for nothing.
    expect(verdict.unconfirmed).toBe(false);
  });

  it("falls back on an Error with no message, and on anything that is not one", () => {
    for (const cause of [new Error(""), "boom", undefined]) {
      const verdict = writeFailure(cause, "delete the wiki");
      expect(verdict.message).toBe("Couldn’t delete the wiki.");
      expect(verdict.unconfirmed).toBe(false);
    }
  });
});
