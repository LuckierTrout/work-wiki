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
  RequestFailedError,
  UNCONFIRMED_STATUSES,
  refusedWriteFailure,
  send,
  thrownWriteFailure,
  unconfirmedWriteMessage,
  writeFailure,
} from "../workbench-request";
import { CONFIG_UNREADABLE_COPY } from "../config";

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

  it("carries the STATUS as a fact, not only as a rendered sentence", async () => {
    // `writeFailure` has to tell a gateway that gave up from a route that
    // refused, and it cannot do that by reading `Request failed (504)`: the
    // moment somebody rewords that string the two come apart with nothing
    // failing. So the status rides the error.
    stubFetch(() => answer({ error: "Nope." }, { ok: false, status: 409 }));

    await expect(send("/api/wikis", { method: "POST" })).rejects.toMatchObject({
      message: "Nope.",
      status: 409,
    });
    // …and it is still an Error, so every `cause instanceof Error` branch and
    // every `catch` that reads `.message` goes on working.
    const cause = await send("/api/wikis", { method: "POST" }).catch((error) => error);
    expect(cause).toBeInstanceOf(Error);
    expect(cause).toBeInstanceOf(RequestFailedError);
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

  it("reports a dropped connection as an outcome nobody knows (DW-374)", () => {
    // What `fetch` rejects with when the connection itself fails, one spelling
    // per engine. The message is TRANSPORT vocabulary — no Copy table contains
    // any of it — and the fact underneath is that the bytes may well have
    // arrived before the socket went away.
    for (const cause of [
      new TypeError("Failed to fetch"),
      new TypeError("NetworkError when attempting to fetch resource"),
      new TypeError("Load failed"),
    ]) {
      const verdict = writeFailure(cause, "rename the wiki");
      expect(verdict.unconfirmed).toBe(true);
      expect(verdict.message).toBe(unconfirmedWriteMessage("rename the wiki"));
      expect(verdict.message).not.toContain(cause.message);
      expect(verdict.message).toContain("unknown");
      expect(verdict.message).toContain("rename the wiki");
    }
  });

  it("reports a gateway status through `send` as an outcome nobody knows", async () => {
    // The whole of DW-374's second half, EXECUTED end to end: the status leaves
    // `send` inside the error and arrives at the verdict as a fact.
    for (const status of UNCONFIRMED_STATUSES) {
      stubFetch(() => answer(undefined, { ok: false, status }));
      const cause = await send("/api/wikis", { method: "POST" }).catch((error) => error);
      const verdict = writeFailure(cause, "create the wiki");

      expect(verdict.unconfirmed).toBe(true);
      // The shared sentence REPLACES `Request failed (504)` — a string in no
      // Copy table that names the transport rather than the thing that failed.
      expect(verdict.message).toBe(unconfirmedWriteMessage("create the wiki"));
      expect(verdict.message).not.toContain(String(status));
      expect(verdict.message).not.toContain("Request failed");
      vi.unstubAllGlobals();
    }
  });

  it("ignores whatever a gateway put in the body — it is not the route's verdict", async () => {
    stubFetch(() => answer({ error: "<html>502 Bad Gateway</html>" }, {
      ok: false,
      status: 502,
    }));
    const cause = await send("/api/wikis", { method: "POST" }).catch((error) => error);

    const verdict = writeFailure(cause, "create the wiki");
    expect(verdict.unconfirmed).toBe(true);
    expect(verdict.message).not.toContain("502 Bad Gateway");
  });

  it("leaves a 4xx and a plain 500 KNOWN — those are the route's own answer", async () => {
    // The other edge of the rule, and the reason it is not "any 5xx": a route
    // that ran and decided has ANSWERED. Calling that unknown would send the
    // owner to reconcile a screen that is already correct.
    for (const status of [400, 403, 404, 409, 412, 428, 500]) {
      stubFetch(() => answer({ error: "Wiki name is required." }, { ok: false, status }));
      const cause = await send("/api/wikis", { method: "POST" }).catch((error) => error);

      const verdict = writeFailure(cause, "create the wiki");
      expect(verdict.unconfirmed).toBe(false);
      expect(verdict.message).toBe("Wiki name is required.");
      vi.unstubAllGlobals();
    }
  });

  it("keeps a 503 KNOWN — this app's own routes emit it as a verdict", () => {
    // The one status that looks like a gateway's silence and is not. `PUT
    // /api/settings` answers 503 with `CONFIG_UNREADABLE_COPY` when the store
    // cannot be read, and it refuses BEFORE merging anything — so nothing was
    // written, and the sentence saying so is the most actionable thing the owner
    // could be handed.
    //
    // Widening to 503 would discard that sentence, tell the owner the outcome is
    // unknown, and send `SettingsCanvas` to clear the version it was holding —
    // all for a write that provably did not land. A status this codebase itself
    // uses as a verdict cannot also be read as the absence of one.
    expect(UNCONFIRMED_STATUSES).not.toContain(503);

    const cause = new RequestFailedError(CONFIG_UNREADABLE_COPY, 503);
    const verdict = writeFailure(cause, "save these settings");
    expect(verdict.unconfirmed).toBe(false);
    expect(verdict.message).toBe(CONFIG_UNREADABLE_COPY);
    // …and through the resolve-style entry point the Settings canvas uses.
    expect(
      refusedWriteFailure(503, CONFIG_UNREADABLE_COPY, "save these settings", "fallback"),
    ).toEqual({ message: CONFIG_UNREADABLE_COPY, unconfirmed: false });
  });

  it("keeps a caller's own bad-2xx-shape throw KNOWN", () => {
    // `if (!wiki?.id) throw new Error("Couldn’t create the wiki.")` — the server
    // ANSWERED, with a 200 whose body was not the documented shape. Nothing is
    // unknown about it, and a reconciliation would be a round trip for nothing.
    const verdict = writeFailure(new Error("Couldn’t create the wiki."), "create the wiki");
    expect(verdict.unconfirmed).toBe(false);
    expect(verdict.message).toBe("Couldn’t create the wiki.");
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

/**
 * The two entry points the RESOLVE-style write clients use — `savePreviewBody`,
 * `revertArtifactRevision` and `saveWorkbenchSettings`, which catch their own
 * `fetch` and return a result rather than throwing.
 *
 * They differ from `writeFailure` on exactly one thing, and it is the point:
 * `send` throws the SERVER's sentence, so relaying a thrown message there is
 * right. These three only ever THROW on transport, so a thrown message is
 * `Failed to fetch` — the vocabulary their docblocks already refuse.
 */
describe("the resolve-style clients' entry points (DW-376)", () => {
  const FALLBACK = "This page couldn’t be saved.";

  it("never relays a thrown cause's message, whatever the verdict", () => {
    const thrown = [
      Object.assign(new Error("signal timed out"), { name: "TimeoutError" }),
      Object.assign(new Error("This operation was aborted"), { name: "AbortError" }),
      new TypeError("Failed to fetch"),
      new Error("NetworkError when attempting to fetch resource"),
      new SyntaxError("Unexpected token '<'"),
      "boom",
    ];
    for (const cause of thrown) {
      const verdict = thrownWriteFailure(cause, "save this page", FALLBACK);
      if (cause instanceof Error) {
        expect(verdict.message).not.toContain(cause.message);
      }
      expect([unconfirmedWriteMessage("save this page"), FALLBACK]).toContain(
        verdict.message,
      );
    }
  });

  it("calls an abort and a dropped connection unknown, and everything else the fallback", () => {
    for (const cause of [
      Object.assign(new Error("signal timed out"), { name: "TimeoutError" }),
      Object.assign(new Error("This operation was aborted"), { name: "AbortError" }),
      new TypeError("Failed to fetch"),
    ]) {
      expect(thrownWriteFailure(cause, "save this page", FALLBACK)).toEqual({
        message: unconfirmedWriteMessage("save this page"),
        unconfirmed: true,
      });
    }
    // A `SyntaxError` from a body that would not parse is not a transport
    // failure: something answered. The fallback, and a KNOWN outcome.
    for (const cause of [new SyntaxError("Unexpected token '<'"), "boom", undefined]) {
      expect(thrownWriteFailure(cause, "save this page", FALLBACK)).toEqual({
        message: FALLBACK,
        unconfirmed: false,
      });
    }
  });

  it("relays a refusal that ARRIVED, and shuts the body out on a gateway status", () => {
    // A 409 the route answered with a reason: the sentence is the server's, and
    // the outcome is known.
    expect(refusedWriteFailure(409, "Somebody else changed this.", "save this page", FALLBACK))
      .toEqual({ message: "Somebody else changed this.", unconfirmed: false });
    // …and with no usable sentence, the surface's own fallback.
    expect(refusedWriteFailure(500, "", "save this page", FALLBACK)).toEqual({
      message: FALLBACK,
      unconfirmed: false,
    });
    // Each gateway status, with a body that WOULD have been relayed at any other
    // status. It is a proxy's page, not the route's verdict.
    for (const status of UNCONFIRMED_STATUSES) {
      expect(refusedWriteFailure(status, "Bad Gateway", "save this page", FALLBACK)).toEqual({
        message: unconfirmedWriteMessage("save this page"),
        unconfirmed: true,
      });
    }
  });
});

describe("the one unconfirmed sentence", () => {
  it("names the action, says the outcome is unknown, and speaks no transport", () => {
    // ONE sentence for every surface and every cause — the reason `action` is a
    // phrase rather than a finished sentence.
    for (const action of [
      "create the wiki",
      "rename the wiki",
      "delete the wiki",
      "switch wiki",
      "save this page",
      "save the Schema",
      "revert the Schema",
      "save these settings",
    ]) {
      const message = unconfirmedWriteMessage(action);
      expect(message).toContain(action);
      expect(message).toContain("unknown");
      expect(message).not.toBe(`Couldn’t ${action}.`);
      // No transport vocabulary: no Copy table contains any of these words, and
      // none of them tells the owner anything they can act on.
      for (const word of [
        "fetch",
        "network",
        "timed out",
        "timeout",
        "abort",
        "gateway",
        "502",
        "503",
        "504",
        "Request failed",
      ]) {
        expect(message.toLowerCase()).not.toContain(word.toLowerCase());
      }
    }
  });

  it("is the SAME sentence whichever cause produced it", () => {
    // The whole claim of DW-374: one honest story, not one per mechanism.
    const abort = Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
    const dropped = new TypeError("Failed to fetch");
    const gateway = new RequestFailedError("Request failed (504)", 504);

    const messages = [abort, dropped, gateway].map(
      (cause) => writeFailure(cause, "create the wiki").message,
    );
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toBe(unconfirmedWriteMessage("create the wiki"));
    // …and the resolve-style clients speak it too.
    expect(thrownWriteFailure(dropped, "create the wiki", "x").message).toBe(messages[0]);
    expect(refusedWriteFailure(504, "y", "create the wiki", "x").message).toBe(messages[0]);
  });
});
