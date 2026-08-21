/**
 * The page-read refusal's own contract (DW-378, DW-380).
 *
 * `wiki.test.ts` covers what THROWS it and the route suites cover what each
 * door answers for it. What neither can cover is the leaf's central design
 * claim: {@link isPageUnreadableError} classifies on `err.name`, NOT
 * `instanceof`, so an error thrown by a SECOND copy of this module — vitest's
 * two projects, a bundler splitting server and edge chunks, the stdio MCP entry
 * point compiled separately — is still classified, and a route's 503 cannot
 * silently become a 500 only in production. Every in-process test would pass
 * with `instanceof` too, because there is only one copy of the class in a single
 * suite. So the foreign error is CONSTRUCTED here rather than thrown, which is
 * the same thing `read-only-kernel-gate.test.ts` does for `isReadOnlyError`.
 *
 * The other half is the copy: `PAGE_UNREADABLE_COPY` is a deliberate hand-copy
 * of `CONFIG_UNREADABLE_COPY`'s recovery clause (same owner situation, a
 * different store named), and the repo pins that kind of by-intent duplication
 * by test rather than by import — see `read-only-copy-parity.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  PAGE_UNREADABLE_COPY,
  PAGE_UNREADABLE_STATUS,
  PageUnreadableError,
  isPageUnreadableError,
} from "../page-read-failure";
import { CONFIG_UNREADABLE_COPY } from "../config";

describe("isPageUnreadableError", () => {
  it("accepts the error this module throws", () => {
    expect(isPageUnreadableError(new PageUnreadableError())).toBe(true);
  });

  it("accepts a FOREIGN Error carrying the same name — the whole point", () => {
    // What a second copy of this module produces: a real `Error` with the right
    // `name` and no relationship to the class this file imported. `instanceof`
    // says false here; the predicate must not.
    const foreign = new Error(PAGE_UNREADABLE_COPY);
    foreign.name = "PageUnreadableError";

    expect(foreign instanceof PageUnreadableError).toBe(false);
    expect(isPageUnreadableError(foreign)).toBe(true);
  });

  it("rejects a plain object wearing the name", () => {
    // The `err instanceof Error` half still does work: a JSON body, a
    // structured-clone survivor or an attacker-shaped value is not a thrown
    // error and must not buy a 503.
    expect(isPageUnreadableError({ name: "PageUnreadableError" })).toBe(false);
    expect(
      isPageUnreadableError({ name: "PageUnreadableError", message: "x" }),
    ).toBe(false);
  });

  it("rejects everything else a catch can hand it", () => {
    for (const value of [
      null,
      undefined,
      "PageUnreadableError",
      42,
      new Error("something else"),
      new TypeError("PageUnreadableError"),
      Object.assign(new Error("enoent"), { code: "ENOENT" }),
    ]) {
      expect(isPageUnreadableError(value)).toBe(false);
    }
  });
});

describe("PageUnreadableError", () => {
  it("sets `name` explicitly, which is what the predicate reads", () => {
    // Not inherited from the class identity: a minifier renaming the class must
    // not change what routes classify on.
    expect(new PageUnreadableError().name).toBe("PageUnreadableError");
  });

  it("defaults its message to the one sentence this module owns", () => {
    expect(new PageUnreadableError().message).toBe(PAGE_UNREADABLE_COPY);
  });

  it("preserves the underlying failure as `cause`", () => {
    // The owner sees one sentence; a log line or a debugger still reaches the
    // EIO underneath. Losing it would make a storage incident unattributable.
    const underlying = Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    const err = new PageUnreadableError(PAGE_UNREADABLE_COPY, { cause: underlying });

    expect((err as Error & { cause?: unknown }).cause).toBe(underlying);
  });

  it("is a real Error, so a catch that rethrows loses nothing", () => {
    const err = new PageUnreadableError();
    expect(err).toBeInstanceOf(Error);
    expect(typeof err.stack).toBe("string");
  });
});

describe("PAGE_UNREADABLE_STATUS", () => {
  it("is 503 — a store that is temporarily unavailable, not a server fault", () => {
    // Pinned as a literal, not re-derived: 500 would read as a server fault and
    // 404 is the lie DW-378 removes. `workbench-preview.ts` also depends on 503
    // specifically, by EXCLUDING it from `UNCONFIRMED_STATUSES` so a save's
    // refusal is relayed as a verdict rather than an unknown outcome.
    expect(PAGE_UNREADABLE_STATUS).toBe(503);
  });
});

describe("PAGE_UNREADABLE_COPY", () => {
  /**
   * The recovery half both unreadable-store sentences share, word for word.
   *
   * Duplicated by INTENT rather than imported: `CONFIG_UNREADABLE_COPY` names
   * the settings store, so a page refusal cannot reuse it whole, and
   * `page-read-failure.ts` is a zero-dependency leaf that must not import
   * `config.ts` (the settings/storage/embeddings graph) to borrow a clause. The
   * price of that boundary is silent drift, and this is the pin — the same
   * device `read-only-copy-parity.test.ts` uses for the client/server halves.
   */
  const RECOVERY =
    "This is usually temporary — copy anything you have unsaved, then reload and try again.";

  it("ends with the same recovery clause as the settings-store refusal", () => {
    expect(PAGE_UNREADABLE_COPY.endsWith(RECOVERY)).toBe(true);
    expect(CONFIG_UNREADABLE_COPY.endsWith(RECOVERY)).toBe(true);
  });

  it("names the PAGE, so the two are not interchangeable", () => {
    // Same shape, different subject: an owner refused a page save must not be
    // sent looking at their settings.
    expect(PAGE_UNREADABLE_COPY).not.toBe(CONFIG_UNREADABLE_COPY);
    expect(PAGE_UNREADABLE_COPY).toContain("This page could not be read");
    expect(PAGE_UNREADABLE_COPY).not.toContain("settings");
  });

  it("says the write did not land, and never says the page is missing", () => {
    // "so nothing was changed" is what makes it safe for `savePreviewBody` to
    // relay verbatim; "not found" is precisely the claim the failed read did
    // not establish.
    expect(PAGE_UNREADABLE_COPY).toContain("nothing was changed");
    expect(PAGE_UNREADABLE_COPY.toLowerCase()).not.toContain("not found");
  });
});
