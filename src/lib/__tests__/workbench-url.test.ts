/**
 * DW-27 / DW-167 / DW-514 / DW-166 — the Workbench's URL rules, EXECUTED.
 *
 * The shell mirrors its active mode into `?mode=`, the open Settings surface
 * into `?settings=1` and the PANE that surface is open on into `?category=`, and
 * resolves the surface it mounts in from the URL first and storage second. Every
 * one of those decisions lives in `workbench-url.ts` precisely so this suite can
 * run it: typed into the mount effect instead, "the URL wins" could only ever be
 * grepped for, and an inverted precedence would keep every source scan green
 * while making every deep link resolve to whatever the visitor last used.
 *
 * The graph canvas's lens (`?scope=`) is read here too, and it is the one param
 * in the module the shell neither writes nor validates (DW-166) — it is here
 * because one module reads client query params, not because the Workbench owns
 * it.
 *
 * Runs on `environment: "node"`, which is also the SSR check: the module is
 * imported here with no `window` in scope at all.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_WORKBENCH_MODE } from "../workbench-modes";
import {
  DEFAULT_SETTINGS_CATEGORY,
  SETTINGS_CATEGORIES,
} from "../workbench-settings";
import {
  GRAPH_SCOPE_PARAM,
  WORKBENCH_MODE_PARAM,
  WORKBENCH_SETTINGS_CATEGORY_PARAM,
  WORKBENCH_SETTINGS_PARAM,
  initialMode,
  locationHref,
  readModeFromSearch,
  readScopeFromSearch,
  readSettingsCategoryFromSearch,
  readSettingsFromSearch,
  surfaceHref,
  type WorkbenchLocation,
} from "../workbench-url";

/** A pane that is NOT the default, so the omit-at-default rule is observable. */
const OTHER_CATEGORY = "embeddings" as const;

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
    // And the one that decides the whole shape of DW-167: Settings is a SURFACE
    // over a mode, never a mode value, so it gets its own param. A
    // `mode=settings` would destroy the mode underneath the surface and leave
    // closing it nowhere to land.
    expect(readModeFromSearch("?mode=settings")).toBeNull();
  });

  it("finds the mode wherever it sits among other params", () => {
    expect(readModeFromSearch("?wiki=abc&mode=graph&q=x")).toBe("graph");
  });

  it("takes the FIRST of a repeated param, and rejects it on its own merits", () => {
    // A hand-edited or concatenated link can carry `mode` twice. `get` answers
    // with the first, which is the half `surfaceHref` then overwrites in place —
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

describe("readSettingsFromSearch", () => {
  it("reads the one spelling that means open", () => {
    expect(readSettingsFromSearch("?mode=chat&settings=1")).toBe(true);
    // With or without the leading `?`, like every other reader here.
    expect(readSettingsFromSearch("settings=1")).toBe(true);
    // Wherever it sits among other params.
    expect(readSettingsFromSearch("?wiki=abc&settings=1&mode=graph")).toBe(true);
  });

  it("answers false for absent, empty and every other value alike", () => {
    // ONE accepted spelling. `settings=0` is not "closed spelled out" — it is
    // simply not the flag, which is the same answer as no param at all, because
    // the writer DELETES the param rather than writing a falsy value.
    expect(readSettingsFromSearch("")).toBe(false);
    expect(readSettingsFromSearch("?mode=chat")).toBe(false);
    expect(readSettingsFromSearch("?settings=")).toBe(false);
    expect(readSettingsFromSearch("?settings=0")).toBe(false);
    expect(readSettingsFromSearch("?settings=yes")).toBe(false);
    expect(readSettingsFromSearch("?settings=true")).toBe(false);
    // A valueless `?settings` parses as the empty string, not as present-and-on.
    expect(readSettingsFromSearch("?settings")).toBe(false);
  });

  it("takes the FIRST of a repeated param, and rejects it on its own merits", () => {
    // The same `get` semantics `readModeFromSearch` is pinned on one describe
    // up, and worth pinning separately because this reader compares a VALUE
    // rather than narrowing a type — a `some(v => v === "1")` spelling would
    // pass every other case here and let a trailing `&settings=1` outvote the
    // occurrence the writer owns.
    expect(readSettingsFromSearch("?settings=1&settings=0")).toBe(true);
    expect(readSettingsFromSearch("?settings=0&settings=1")).toBe(false);
    // …and the writer collapses the duplicate either way, because `set` replaces
    // every occurrence with one and `delete` removes them all — so a link like
    // this survives exactly one trip through the shell.
    expect(
      surfaceHref(at("?settings=0&settings=1"), "chat", true, DEFAULT_SETTINGS_CATEGORY),
    ).toBe("/?settings=1&mode=chat");
    expect(
      surfaceHref(at("?settings=0&settings=1"), "chat", false, DEFAULT_SETTINGS_CATEGORY),
    ).toBe("/?mode=chat");
  });

  it("names the param once, and it is `settings`", () => {
    expect(WORKBENCH_SETTINGS_PARAM).toBe("settings");
  });
});

describe("readSettingsCategoryFromSearch", () => {
  it("reads a pane this build has", () => {
    expect(readSettingsCategoryFromSearch("?settings=1&category=embeddings")).toBe(
      "embeddings",
    );
    // With or without the leading `?`, and wherever it sits among other params.
    expect(readSettingsCategoryFromSearch("category=about")).toBe("about");
    expect(readSettingsCategoryFromSearch("?mode=chat&category=intake&wiki=x")).toBe(
      "intake",
    );
  });

  it("answers null for absent, empty and unknown alike", () => {
    // The `readModeFromSearch` shape: one answer for all three, because the
    // caller's next move is the same in every case — fall back to the default
    // pane.
    expect(readSettingsCategoryFromSearch("")).toBeNull();
    expect(readSettingsCategoryFromSearch("?settings=1")).toBeNull();
    expect(readSettingsCategoryFromSearch("?settings=1&category=")).toBeNull();
    expect(readSettingsCategoryFromSearch("?settings=1&category=nope")).toBeNull();
    // Narrowed, not trusted: a mis-cased id from a hand-edited link is not one.
    expect(readSettingsCategoryFromSearch("?category=Embeddings")).toBeNull();
    // …and a category LABEL is not an id either.
    expect(readSettingsCategoryFromSearch("?category=LLM%20Models")).toBeNull();
  });

  it("says nothing about whether the surface is open", () => {
    // The two reads are independent, which is what lets the shell decline a
    // stray pane on a closed surface AND lets one builder delete it in the same
    // write. A reader that folded the flag in would have to answer `null` here
    // and the caller could no longer tell "no pane named" from "pane named on a
    // closed surface".
    expect(readSettingsCategoryFromSearch("?mode=wiki&category=embeddings")).toBe(
      "embeddings",
    );
    expect(readSettingsFromSearch("?mode=wiki&category=embeddings")).toBe(false);
  });

  it("accepts every listed pane and nothing else", () => {
    // Pinned against the vocabulary rather than a retyped list: the narrower
    // lives in `workbench-settings.ts` precisely so a category added there is
    // linkable without a second edit here.
    for (const category of SETTINGS_CATEGORIES) {
      expect(readSettingsCategoryFromSearch(`?category=${category.id}`)).toBe(
        category.id,
      );
    }
  });

  it("names the param once, and it is `category`", () => {
    expect(WORKBENCH_SETTINGS_CATEGORY_PARAM).toBe("category");
  });
});

describe("readScopeFromSearch", () => {
  it("reads the lens a deep link names, whatever it is", () => {
    // VALIDATES NOTHING (DW-166). The vocabulary is `/api/wiki/graph`'s — the
    // vault ids and owner handles behind it are the deployment's — so this
    // hands the string through and the route decides.
    expect(readScopeFromSearch("?scope=vault:v1")).toBe("vault:v1");
    expect(readScopeFromSearch("scope=mine")).toBe("mine");
    expect(readScopeFromSearch("?scope=owner:someone")).toBe("owner:someone");
    // Including one no route would answer for: rejecting it here would only
    // move the refusal somewhere with no vocabulary to refuse it against.
    expect(readScopeFromSearch("?scope=nonsense")).toBe("nonsense");
  });

  it("answers null for absent and empty alike", () => {
    // The page's one `?? "mine"` then covers every miss, exactly as the
    // hand-rolled `|| undefined` it replaces did.
    expect(readScopeFromSearch("")).toBeNull();
    expect(readScopeFromSearch("?q=x")).toBeNull();
    expect(readScopeFromSearch("?scope=")).toBeNull();
    expect(readScopeFromSearch("?scope")).toBeNull();
  });

  it("names the param once, and it is `scope`", () => {
    expect(GRAPH_SCOPE_PARAM).toBe("scope");
  });
});

describe("surfaceHref", () => {
  it("writes the mode onto a location that had none", () => {
    expect(surfaceHref(at(""), "lint", false, DEFAULT_SETTINGS_CATEGORY)).toBe(
      "/?mode=lint",
    );
  });

  it("replaces the mode in place, keeping every other param", () => {
    // The Wiki id and anything a later story adds belong to other features; the
    // shell has no business dropping them to say which surface is showing. `set`
    // updates in place, so the param order the owner's link had survives too.
    expect(surfaceHref(at("?wiki=abc&mode=wiki"), "search", false, DEFAULT_SETTINGS_CATEGORY)).toBe(
      "/?wiki=abc&mode=search",
    );
    expect(surfaceHref(at("?mode=wiki&wiki=abc"), "search", false, DEFAULT_SETTINGS_CATEGORY)).toBe(
      "/?mode=search&wiki=abc",
    );
  });

  it("keeps the hash, which is a scroll target and not the shell's to discard", () => {
    expect(surfaceHref(at("?wiki=abc", "/", "#notes"), "graph", false, DEFAULT_SETTINGS_CATEGORY)).toBe(
      "/?wiki=abc&mode=graph#notes",
    );
  });

  it("writes the Settings flag ALONGSIDE the mode, never instead of it", () => {
    // The mode underneath the surface is still named, which is what gives
    // closing Settings somewhere to land — and what makes a copied link reopen
    // the surface OVER the canvas it was opened from rather than over a default.
    expect(surfaceHref(at("?wiki=abc"), "graph", true, DEFAULT_SETTINGS_CATEGORY)).toBe(
      "/?wiki=abc&mode=graph&settings=1",
    );
    expect(surfaceHref(at(""), "chat", true, DEFAULT_SETTINGS_CATEGORY)).toBe("/?mode=chat&settings=1");
    // In place, like the mode, when the location already carries it.
    expect(surfaceHref(at("?settings=1&wiki=abc"), "chat", true, DEFAULT_SETTINGS_CATEGORY)).toBe(
      "/?settings=1&wiki=abc&mode=chat",
    );
  });

  it("DELETES the flag when Settings is closed rather than writing it off", () => {
    // A closed surface is the ordinary state, so the ordinary URL is the one
    // without the param. `settings=0` would make the closed state two strings
    // instead of one, and the shell compares strings to decide whether to write
    // a history entry at all.
    expect(surfaceHref(at("?mode=chat&settings=1"), "chat", false, DEFAULT_SETTINGS_CATEGORY)).toBe("/?mode=chat");
    expect(surfaceHref(at("?wiki=abc&settings=1&mode=chat"), "graph", false, DEFAULT_SETTINGS_CATEGORY)).toBe(
      "/?wiki=abc&mode=graph",
    );
    // Including a value the reader would already have called closed: the writer
    // leaves no `settings` key behind whatever it found.
    expect(surfaceHref(at("?settings=0"), "lint", false, DEFAULT_SETTINGS_CATEGORY)).toBe("/?mode=lint");
    expect(surfaceHref(at("?settings=1", "/", "#notes"), "lint", false, DEFAULT_SETTINGS_CATEGORY)).toBe(
      "/?mode=lint#notes",
    );
  });

  it("names both params when the location carried only the flag", () => {
    // A hand-shortened or hand-edited link. The two params are independent —
    // the flag is read straight from the URL while the mode falls back to
    // storage — so the builder has to be able to ADD the mode beside a flag it
    // did not write, which is what makes the seed's one `replaceState` able to
    // normalize such a URL into one that names a whole surface.
    expect(surfaceHref(at("?settings=1"), "chat", true, DEFAULT_SETTINGS_CATEGORY)).toBe(
      "/?settings=1&mode=chat",
    );
    expect(readSettingsFromSearch("?settings=1")).toBe(true);
    // …and the mode is storage's answer, because the URL names none.
    expect(readModeFromSearch("?settings=1")).toBeNull();
    expect(initialMode("?settings=1", "lint")).toBe("lint");
  });

  it("writes the PANE beside the flag when the surface is open on a non-default one", () => {
    expect(surfaceHref(at(""), "chat", true, OTHER_CATEGORY)).toBe(
      "/?mode=chat&settings=1&category=embeddings",
    );
    // In place, like the mode and the flag, when the location already carries it.
    expect(surfaceHref(at("?category=about&wiki=abc"), "chat", true, OTHER_CATEGORY)).toBe(
      "/?category=embeddings&wiki=abc&mode=chat&settings=1",
    );
  });

  it("OMITS the pane at the default, so the ordinary surface keeps one URL", () => {
    // `?mode=chat&settings=1` is a string several suites pin, and the default
    // pane is the ordinary state for the same reason a closed surface is — so
    // writing `category=general` would give the ordinary surface a second
    // spelling and cost the fixed point below.
    expect(surfaceHref(at(""), "chat", true, DEFAULT_SETTINGS_CATEGORY)).toBe(
      "/?mode=chat&settings=1",
    );
    // …and a stale non-default pane is DELETED on the way back to the default,
    // not left behind.
    expect(
      surfaceHref(at("?mode=chat&settings=1&category=embeddings"), "chat", true,
        DEFAULT_SETTINGS_CATEGORY),
    ).toBe("/?mode=chat&settings=1");
  });

  it("DELETES the pane whenever the surface is closed, in the same write as the flag", () => {
    // A pane of a surface that is not showing is not a state the shell can be
    // in, so there is never a URL naming one. Both params go in ONE write, which
    // is the whole reason there is one builder.
    expect(
      surfaceHref(at("?mode=chat&settings=1&category=embeddings"), "graph", false,
        OTHER_CATEGORY),
    ).toBe("/?mode=graph");
    // Including the stray case: `?category=` with no flag beside it survives
    // exactly one trip through the shell.
    expect(surfaceHref(at("?category=embeddings"), "wiki", false, OTHER_CATEGORY)).toBe(
      "/?mode=wiki",
    );
    // …and the hash is still not the shell's to discard.
    expect(
      surfaceHref(at("?settings=1&category=intake", "/", "#notes"), "lint", false,
        OTHER_CATEGORY),
    ).toBe("/?mode=lint#notes");
  });

  it("round-trips through its own reader, both ways", () => {
    // The writer and the reader are the two halves of one convention, and the
    // only thing that keeps them from drifting is running them against each
    // other.
    for (const open of [true, false]) {
      for (const category of [DEFAULT_SETTINGS_CATEGORY, OTHER_CATEGORY]) {
        const href = surfaceHref(at("?wiki=abc"), "graph", open, category);
        const query = href.slice(href.indexOf("?"));
        expect(readSettingsFromSearch(query)).toBe(open);
        expect(readModeFromSearch(query)).toBe("graph");
        // The pane comes back only where the writer put one — which is the
        // round trip the OMIT and DELETE rules actually make: on every other
        // combination the reader answers `null` and the caller's fallback to
        // `DEFAULT_SETTINGS_CATEGORY` is what restores the state that was
        // written.
        const written = open && category !== DEFAULT_SETTINGS_CATEGORY;
        expect(readSettingsCategoryFromSearch(query)).toBe(written ? category : null);
        expect(readSettingsCategoryFromSearch(query) ?? DEFAULT_SETTINGS_CATEGORY).toBe(
          open ? category : DEFAULT_SETTINGS_CATEGORY,
        );
      }
    }
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
      const href = surfaceHref(at(search), "lint", false, DEFAULT_SETTINGS_CATEGORY);
      expect(href).toBe(expected);
      const before = new URLSearchParams(search);
      const after = new URLSearchParams(href.slice(href.indexOf("?")));
      for (const [key, value] of before) expect(after.get(key)).toBe(value);
    }
  });

  it("is idempotent on the normalized form, which is what makes the skip-the-write check sound", () => {
    // `selectMode`, `toggleSettings`, `openSettings` and the mount seed all
    // compare this against the current href and write no history entry when they
    // agree. That comparison is only meaningful if applying the rule twice
    // cannot produce a third string — i.e. the normalized form has to be a FIXED
    // POINT, which is what makes the one-off rewrite above a one-off.
    //
    // Fed from the raw inputs, not from this function's own output: handing it
    // back its already-normalized answer can only exercise strings that survive
    // round-tripping, so it could never fail for the reason this test exists.
    //
    // Run for BOTH flag values, because the delete branch has its own way to
    // fail: a writer that emitted `settings=0` would be stable on the second
    // pass and still wrong on the first.
    for (const open of [true, false]) {
      // Run across the PANES too (DW-514): the omit-at-default branch has the
      // same way to fail as the delete-the-flag one — a writer that emitted
      // `category=general` would be stable on the second pass and still wrong
      // on the first — and the delete-when-closed branch has to survive an
      // input that already carries a pane.
      for (const category of [DEFAULT_SETTINGS_CATEGORY, OTHER_CATEGORY]) {
        for (const search of [
          "?wiki=abc",
          "?q=a%20b",
          "?flag",
          "?tags=x,y",
          "?mode=todos",
          "?mode=todos&settings=1",
          "?settings=0",
          "?mode=todos&settings=1&category=embeddings",
          "?category=about",
          "?category=nope",
        ]) {
          const once = surfaceHref(at(search, "/", "#notes"), "todos", open, category);
          const query = once.slice(once.indexOf("?"), once.indexOf("#"));
          expect(surfaceHref(at(query, "/", "#notes"), "todos", open, category)).toBe(
            once,
          );
        }
      }
    }
    // The two inputs that are already their own normalized form.
    expect(surfaceHref(at("?mode=todos"), "todos", false, DEFAULT_SETTINGS_CATEGORY)).toBe(
      "/?mode=todos",
    );
    expect(
      surfaceHref(at("?mode=todos&settings=1"), "todos", true, DEFAULT_SETTINGS_CATEGORY),
    ).toBe("/?mode=todos&settings=1");
    expect(
      surfaceHref(
        at("?mode=todos&settings=1&category=embeddings"),
        "todos",
        true,
        OTHER_CATEGORY,
      ),
    ).toBe("/?mode=todos&settings=1&category=embeddings");
  });

  it("leaves a path other than `/` alone", () => {
    expect(surfaceHref(at("", "/nested"), "review", false, DEFAULT_SETTINGS_CATEGORY)).toBe("/nested?mode=review");
  });
});
