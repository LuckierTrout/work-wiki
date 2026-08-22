/**
 * DW-27 — the Workbench's URL rules, EXECUTED.
 *
 * The shell mirrors its active mode into `?mode=` and resolves the mode it
 * mounts in from the URL first and storage second. Every one of those decisions
 * lives in `workbench-url.ts` precisely so this suite can run it: typed into the
 * mount effect instead, "the URL wins" could only ever be grepped for, and an
 * inverted precedence would keep every source scan green while making every
 * deep link resolve to whatever the visitor last used.
 *
 * Runs on `environment: "node"`, which is also the SSR check: the module is
 * imported here with no `window` in scope at all.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_WORKBENCH_MODE } from "../workbench-modes";
import {
  WORKBENCH_MODE_PARAM,
  initialMode,
  locationHref,
  modeHref,
  readModeFromSearch,
  type WorkbenchLocation,
} from "../workbench-url";

/** A location literal, so the shell's `window.location` needs no adapter. */
function at(search: string, pathname = "/", hash = ""): WorkbenchLocation {
  return { pathname, search, hash };
}

describe("readModeFromSearch", () => {
  it("reads a mode this build has", () => {
    expect(readModeFromSearch("?mode=chat")).toBe("chat");
    // `URLSearchParams` takes the string with or without the leading `?`, and
    // `window.location.search` supplies it with one.
    expect(readModeFromSearch("mode=lint")).toBe("lint");
  });

  it("answers null for absent, empty and unknown alike", () => {
    // One answer for all three, because the caller's next move is the same:
    // fall back to storage.
    expect(readModeFromSearch("")).toBeNull();
    expect(readModeFromSearch("?wiki=abc")).toBeNull();
    expect(readModeFromSearch("?mode=")).toBeNull();
    expect(readModeFromSearch("?mode=nope")).toBeNull();
    // A mode id from a future build, or a hand-edited link. Narrowed by the
    // same `isWorkbenchModeId` the localStorage read uses — a query param is
    // exactly as untrusted as a stored value, so there is no second validator.
    expect(readModeFromSearch("?mode=Chat")).toBeNull();
    expect(readModeFromSearch("?mode=settings")).toBeNull();
  });

  it("finds the mode wherever it sits among other params", () => {
    expect(readModeFromSearch("?wiki=abc&mode=graph&q=x")).toBe("graph");
  });

  it("takes the FIRST of a repeated param, and rejects it on its own merits", () => {
    // A hand-edited or concatenated link can carry `mode` twice. `get` answers
    // with the first, which is the half `modeHref` then overwrites in place —
    // so the read and the write agree on which occurrence is the live one, and
    // a second occurrence cannot outvote it. Worth pinning precisely because
    // the module's stated premise is that a query param is exactly as untrusted
    // as a hand-edited storage value.
    expect(readModeFromSearch("?mode=chat&mode=wiki")).toBe("chat");
    // …and the first is still narrowed, not trusted for being first.
    expect(readModeFromSearch("?mode=nope&mode=wiki")).toBeNull();
  });

  it("names the param once, and it is `mode`", () => {
    expect(WORKBENCH_MODE_PARAM).toBe("mode");
  });
});

describe("initialMode", () => {
  it("lets a deep link beat the stored mode", () => {
    // The whole point of DW-27: a link is an explicit instruction, and a
    // preference from an earlier session must not override it — otherwise
    // `?mode=chat` is unshareable with anyone who has ever used the app.
    expect(initialMode("?mode=chat", "wiki")).toBe("chat");
  });

  it("falls back to the stored mode when the URL names none", () => {
    expect(initialMode("", "lint")).toBe("lint");
    expect(initialMode("?wiki=abc", "lint")).toBe("lint");
  });

  it("falls back to the stored mode on an unknown or empty value", () => {
    expect(initialMode("?mode=nope", "graph")).toBe("graph");
    expect(initialMode("?mode=", "graph")).toBe("graph");
  });

  it("bottoms out at the default, through the stored accessor's own fallback", () => {
    // `readStoredMode()` has already applied this fallback by the time it is
    // handed in, which is why this takes a mode rather than a nullable one.
    expect(initialMode("?mode=", DEFAULT_WORKBENCH_MODE)).toBe("wiki");
    expect(DEFAULT_WORKBENCH_MODE).toBe("wiki");
  });
});

describe("locationHref", () => {
  it("is path, query and fragment exactly as written", () => {
    expect(locationHref(at("?mode=chat", "/", "#top"))).toBe("/?mode=chat#top");
    expect(locationHref(at(""))).toBe("/");
  });
});

describe("modeHref", () => {
  it("writes the mode onto a location that had none", () => {
    expect(modeHref(at(""), "lint")).toBe("/?mode=lint");
  });

  it("replaces the mode in place, keeping every other param", () => {
    // The Wiki id and anything a later story adds belong to other features; the
    // shell has no business dropping them to say which mode is showing. `set`
    // updates in place, so the param order the owner's link had survives too.
    expect(modeHref(at("?wiki=abc&mode=wiki"), "search")).toBe("/?wiki=abc&mode=search");
    expect(modeHref(at("?mode=wiki&wiki=abc"), "search")).toBe("/?mode=search&wiki=abc");
  });

  it("keeps the hash, which is a scroll target and not the shell's to discard", () => {
    expect(modeHref(at("?wiki=abc", "/", "#notes"), "graph")).toBe(
      "/?wiki=abc&mode=graph#notes",
    );
  });

  it("normalizes the query string while preserving every value", () => {
    // `URLSearchParams.toString()` re-encodes rather than echoing the input, so
    // "everything else untouched" would be the wrong promise: these are the
    // three shapes where the string changes. Each still PARSES back to what it
    // came in as, which is the property that actually matters — asserted here
    // rather than asserted about, because a future switch to string surgery
    // could preserve the bytes and break the parse.
    for (const [search, expected] of [
      ["?q=a%20b", "/?q=a+b&mode=lint"],
      ["?flag", "/?flag=&mode=lint"],
      ["?tags=x,y", "/?tags=x%2Cy&mode=lint"],
    ] as const) {
      const href = modeHref(at(search), "lint");
      expect(href).toBe(expected);
      const before = new URLSearchParams(search);
      const after = new URLSearchParams(href.slice(href.indexOf("?")));
      for (const [key, value] of before) expect(after.get(key)).toBe(value);
    }
  });

  it("is idempotent on the normalized form, which is what makes the skip-the-write check sound", () => {
    // `selectMode` and the mount seed both compare this against the current
    // href and write no history entry when they agree. That comparison is only
    // meaningful if applying the rule twice cannot produce a third string —
    // i.e. the normalized form has to be a FIXED POINT, which is what makes the
    // one-off rewrite above a one-off.
    //
    // Fed from the raw inputs, not from this function's own output: handing it
    // back its already-normalized answer can only exercise strings that survive
    // round-tripping, so it could never fail for the reason this test exists.
    for (const search of ["?wiki=abc", "?q=a%20b", "?flag", "?tags=x,y", "?mode=todos"]) {
      const once = modeHref(at(search, "/", "#notes"), "todos");
      const query = once.slice(once.indexOf("?"), once.indexOf("#"));
      expect(modeHref(at(query, "/", "#notes"), "todos")).toBe(once);
    }
    // The one input that is already its own normalized form.
    expect(modeHref(at("?mode=todos"), "todos")).toBe("/?mode=todos");
  });

  it("leaves a path other than `/` alone", () => {
    expect(modeHref(at("", "/nested"), "review")).toBe("/nested?mode=review");
  });
});
