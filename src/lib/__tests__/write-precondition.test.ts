/**
 * The write precondition's primitive, executed directly (DW-38, DW-51, DW-56,
 * DW-63).
 *
 * Every route and every surface in the story leans on this one module: the read
 * side derives a version, the write side re-derives it over the bytes it already
 * holds, and the whole guard is exactly as good as "the same input gives the
 * same string and a different input does not". `vitest.config.ts` is
 * `environment: "node"`, and this module is pure with no dependency, so all of
 * it runs here rather than being grepped for inside a route.
 *
 * The I/O matrix rows this module OWNS are the header parsing, the three
 * outcomes, and the two version functions' stability. The rows about a
 * particular route (a stale page save, a deleted artifact, a re-ordered config)
 * are executed in that route's own suite, against real bytes.
 */
import { describe, expect, it } from "vitest";
import fs from "fs/promises";
import path from "path";
import {
  IF_MATCH_HEADER,
  WRITE_CONFLICT_COPY,
  WRITE_CONFLICT_STATUS,
  WRITE_PRECONDITION_REQUIRED_COPY,
  WRITE_PRECONDITION_REQUIRED_STATUS,
  checkVersionPrecondition,
  checkWritePrecondition,
  contentVersion,
  formatIfMatch,
  isWriteConflictError,
  objectVersion,
  parseIfMatch,
  scopedContentVersion,
  WriteConflictError,
} from "../write-precondition";

// ---------------------------------------------------------------------------
// contentVersion
// ---------------------------------------------------------------------------

describe("contentVersion", () => {
  it("answers the same string for the same bytes, every time", () => {
    const page = "---\nowner: alice\n---\n\n# Alpha\n\nbody\n";
    expect(contentVersion(page)).toBe(contentVersion(page));
    // Two independently built copies of one string, so this cannot be passing
    // on identity.
    expect(contentVersion(["a", "b", "c"].join(""))).toBe(contentVersion("abc"));
  });

  it("names its scheme, and carries the length", () => {
    // The prefix is what stops a version from a future scheme being mistaken
    // for a match; the length is the cheapest discriminating property there is.
    expect(contentVersion("")).toMatch(/^w1:0-[0-9a-f]{16}$/);
    expect(contentVersion("abc")).toMatch(/^w1:3-[0-9a-f]{16}$/);
    // Base 36, so a large file's version stays short.
    expect(contentVersion("x".repeat(36)).startsWith("w1:10-")).toBe(true);
  });

  it("moves on a ONE-CHARACTER change, anywhere in the string", () => {
    const base = "# Alpha\n\nThe quick brown fox jumps over the lazy dog.\n";
    const variants = [
      "# Alphb\n\nThe quick brown fox jumps over the lazy dog.\n",
      "# Alpha\n\nThe quick brown fox jumps over the lazy dog!\n",
      "# Alpha\n\nThe quick brown fox jumps over the lazy dog.\n\n",
      " # Alpha\n\nThe quick brown fox jumps over the lazy dog.\n",
    ];
    for (const variant of variants) {
      expect(contentVersion(variant)).not.toBe(contentVersion(base));
    }
  });

  it("sees a change in the HIGH byte of a code unit", () => {
    // Hashing only the low byte would make these equal, which is a lost-update
    // detector that cannot see a diacritic being added: "a" is U+0061 and "ā"
    // is U+0101 — the same low byte.
    expect(contentVersion("a")).not.toBe(contentVersion("ā"));
    expect(contentVersion("note")).not.toBe(contentVersion("notť"));
  });

  it("distinguishes a transposition, which a sum would not", () => {
    expect(contentVersion("ab")).not.toBe(contentVersion("ba"));
    expect(contentVersion("# One\n# Two\n")).not.toBe(contentVersion("# Two\n# One\n"));
  });

  it("handles an empty string and a lone surrogate without throwing", () => {
    // An empty file is a real file — the version has to be a string, not a
    // special case the caller has to branch on.
    expect(typeof contentVersion("")).toBe("string");
    // `capPreviewBody` exists precisely because a cut can land between the two
    // halves of a pair; this function is not an encoder and must describe
    // whatever the storage layer actually holds.
    const high = "\ud83d"; // the leading half of an emoji
    const low = "\ude00"; // the trailing half
    expect(typeof contentVersion(high)).toBe("string");
    expect(contentVersion(high)).not.toBe(contentVersion(low));
    expect(contentVersion(high + low)).not.toBe(contentVersion(high));
    // …and a well-formed pair round-trips like any other content.
    expect(contentVersion("😀")).toBe(contentVersion("😀"));
  });

  it("is not a digest — it is documented as, and behaves as, a change detector", () => {
    // No crypto, no async, no dependency: it runs identically in node, the
    // browser and the Worker, which is the whole reason it is not a hash from a
    // platform API.
    expect(contentVersion("x")).not.toContain("[object");
    expect(contentVersion("x")).toHaveLength("w1:1-".length + 16);
  });
});

// ---------------------------------------------------------------------------
// scopedContentVersion (DW-200)
// ---------------------------------------------------------------------------

describe("scopedContentVersion", () => {
  const SEEDED = "# Schema\n\n## Page conventions\n\nWrite it down.\n";

  it("answers the same string for the same scope and bytes, every time", () => {
    expect(scopedContentVersion("wiki-a", SEEDED)).toBe(
      scopedContentVersion("wiki-a", SEEDED),
    );
  });

  it("separates two Wikis holding BYTE-IDENTICAL content", () => {
    // The whole reason this function exists: two Wikis seeded from one
    // template hold the same `schema.md`, so a token read from one would
    // otherwise be a valid precondition for the other's file.
    expect(scopedContentVersion("wiki-a", SEEDED)).not.toBe(
      scopedContentVersion("wiki-b", SEEDED),
    );
  });

  it("still separates two different bodies under ONE scope", () => {
    expect(scopedContentVersion("wiki-a", SEEDED)).not.toBe(
      scopedContentVersion("wiki-a", `${SEEDED}one more line\n`),
    );
  });

  it("makes the scope/content boundary unambiguous", () => {
    // Without the length prefix both of these hash the string "abc", so a
    // token read under one scope would match content stored under another —
    // the cross-Wiki match this closes, reintroduced by concatenation.
    expect(scopedContentVersion("ab", "c")).not.toBe(
      scopedContentVersion("a", "bc"),
    );
    // And the degenerate ends of the same boundary.
    expect(scopedContentVersion("", "abc")).not.toBe(
      scopedContentVersion("a", "bc"),
    );
    expect(scopedContentVersion("abc", "")).not.toBe(
      scopedContentVersion("ab", "c"),
    );
  });

  it("carries its OWN scheme prefix, so it can never be read as an unscoped one", () => {
    const scoped = scopedContentVersion("wiki-a", SEEDED);
    expect(scoped.startsWith("w1s:")).toBe(true);
    expect(contentVersion(SEEDED).startsWith("w1:")).toBe(true);
    // Not merely a different prefix on the same digest: the two are different
    // strings end to end, for every input.
    expect(scoped).not.toBe(contentVersion(SEEDED));
    // …and no scoped token is ever an unscoped one, whatever the scope.
    for (const scope of ["", "a", "wiki-a", "0".repeat(64)]) {
      expect(scopedContentVersion(scope, SEEDED)).not.toBe(contentVersion(SEEDED));
    }
  });

  it("names no Wiki in the token it produces", () => {
    // The version is relayed by the browser, so the id must not be legible in
    // it. This is not a secrecy claim about the hash — it is the check that
    // nobody concatenated the id in plaintext.
    const id = "11111111-2222-4333-8444-555555555555";
    expect(scopedContentVersion(id, SEEDED)).not.toContain(id);
  });

  it("is stable across astral characters and a lone surrogate", () => {
    // The same property `contentVersion` guarantees, through the wrapper: the
    // scope prefix must not disturb how the content is hashed.
    for (const body of ["🌵", "\uD800", `${SEEDED}🌵`]) {
      expect(scopedContentVersion("wiki-a", body)).toBe(
        scopedContentVersion("wiki-a", body),
      );
    }
    expect(scopedContentVersion("wiki-a", "🌵")).not.toBe(
      scopedContentVersion("wiki-a", "\uD800"),
    );
  });
});

// ---------------------------------------------------------------------------
// objectVersion
// ---------------------------------------------------------------------------

describe("objectVersion", () => {
  it("ignores key ORDER, at every depth", () => {
    // `.llm-wiki-config.json` is hand-editable and re-serialized on every save;
    // a re-ordered file must not read as a change nobody made.
    expect(objectVersion({ a: 1, b: 2 })).toBe(objectVersion({ b: 2, a: 1 }));
    expect(objectVersion({ outer: { x: 1, y: 2 }, z: 3 })).toBe(
      objectVersion({ z: 3, outer: { y: 2, x: 1 } }),
    );
  });

  it("still moves when a VALUE changes", () => {
    expect(objectVersion({ a: 1 })).not.toBe(objectVersion({ a: 2 }));
    expect(objectVersion({ a: { b: 1 } })).not.toBe(objectVersion({ a: { b: 2 } }));
    expect(objectVersion({ a: 1 })).not.toBe(objectVersion({ a: "1" }));
    // A key added or removed is a change.
    expect(objectVersion({ a: 1 })).not.toBe(objectVersion({ a: 1, b: 2 }));
  });

  it("treats an absent key and an `undefined` one as the same config", () => {
    // `delete updated.model` and `model: undefined` are the two shapes the
    // settings route's own merge produces; `JSON.stringify` drops both, and so
    // must this — or an unrelated edit would refuse the next save.
    expect(objectVersion({ a: 1, b: undefined })).toBe(objectVersion({ a: 1 }));
  });

  it("keeps ARRAY order, because an array's order is its value", () => {
    expect(objectVersion({ a: [1, 2] })).not.toBe(objectVersion({ a: [2, 1] }));
    expect(objectVersion({ a: [1, 2] })).toBe(objectVersion({ a: [1, 2] }));
  });

  it("is total over the values a parsed config can hold", () => {
    for (const value of [null, 0, "", false, [], {}, { a: null }]) {
      expect(typeof objectVersion(value)).toBe("string");
    }
    // …and the empty config, which is the documented default, is stable.
    expect(objectVersion({})).toBe(objectVersion({}));
    expect(objectVersion({})).not.toBe(objectVersion({ a: 1 }));
  });

  it("THROWS a TypeError on a cycle rather than overflowing the stack", () => {
    // `JSON.stringify` throws on a cycle; so does this, for the same reason and
    // catchably. A recursion that never terminated would take the route down
    // with a stack overflow nothing could attribute.
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => objectVersion(cyclic)).toThrow(TypeError);

    // Indirect cycles too.
    const outer: Record<string, unknown> = {};
    const inner: Record<string, unknown> = { outer };
    outer.inner = inner;
    expect(() => objectVersion(outer)).toThrow(TypeError);

    // …but SHARING is not a cycle: a DAG serializes fine, and parsed config
    // that reuses one object in two places is ordinary.
    const shared = { a: 1 };
    expect(() => objectVersion({ left: shared, right: shared })).not.toThrow();
  });

  it("THROWS a RangeError past the depth bound", () => {
    let deep: unknown = 1;
    for (let level = 0; level < 200; level += 1) deep = { deep };
    expect(() => objectVersion(deep)).toThrow(RangeError);

    // A depth anything real reaches is fine.
    let shallow: unknown = 1;
    for (let level = 0; level < 10; level += 1) shallow = { shallow };
    expect(() => objectVersion(shallow)).not.toThrow();
  });

  it("DISTINGUISHES the non-plain values that used to collapse to `{}`", () => {
    // `Object.entries` sees no own enumerable keys on any of these, so all of
    // them used to serialize as `{}` — two different dates, or two maps with
    // different contents, produced the SAME version and a real edit read as no
    // edit at all.
    expect(objectVersion(new Date(1))).not.toBe(objectVersion(new Date(2)));
    expect(objectVersion(new Map([["a", 1]]))).not.toBe(
      objectVersion(new Map([["a", 2]])),
    );
    expect(objectVersion(new Set([1]))).not.toBe(objectVersion([1]));
    expect(objectVersion(/a/)).not.toBe(objectVersion(/b/));

    // A class instance is not its plain-object twin, and two instances of
    // different classes with the same fields are not each other.
    class Point {
      constructor(
        readonly x: number,
        readonly y: number,
      ) {}
    }
    class Vector {
      constructor(
        readonly x: number,
        readonly y: number,
      ) {}
    }
    expect(objectVersion(new Point(1, 2))).not.toBe(objectVersion({ x: 1, y: 2 }));
    expect(objectVersion(new Point(1, 2))).not.toBe(objectVersion(new Vector(1, 2)));
    // …and it still MOVES when the instance's own fields move.
    expect(objectVersion(new Point(1, 2))).not.toBe(objectVersion(new Point(1, 3)));

    // Equal values still agree, whichever kind they are.
    expect(objectVersion(new Date(1))).toBe(objectVersion(new Date(1)));
    expect(objectVersion(new Set([1, 2]))).toBe(objectVersion(new Set([2, 1])));
    expect(objectVersion(new Map([["a", 1], ["b", 2]]))).toBe(
      objectVersion(new Map([["b", 2], ["a", 1]])),
    );
  });

  it("separates a SUBCLASS from its built-in, and a look-alike class from both", () => {
    // Two collisions the kind-name alone and the class-name alone each leave
    // open. `instanceof` puts a subclass on the built-in's branch, so without
    // the class name `MyMap` and `Map` holding the same entries agreed…
    class MyMap extends Map<string, number> {}
    class MySet extends Set<number> {}
    class MyList extends Array<number> {}
    expect(objectVersion(new MyMap([["a", 1]]))).not.toBe(
      objectVersion(new Map([["a", 1]])),
    );
    expect(objectVersion(new MySet([1]))).not.toBe(objectVersion(new Set([1])));
    expect(objectVersion(MyList.from([1, 2]))).not.toBe(objectVersion([1, 2]));

    // …and a class merely NAMED like a built-in never reaches that branch at
    // all, so without the kind name an ordinary object called `Set` and an
    // empty real `Set` agreed — both had the tag and no own fields.
    const Set_ = class Set {};
    const Map_ = class Map {};
    const RegExp_ = class RegExp {};
    expect(objectVersion(new Set_())).not.toBe(objectVersion(new Set()));
    expect(objectVersion(new Map_())).not.toBe(objectVersion(new Map()));
    expect(objectVersion(new RegExp_())).not.toBe(objectVersion(/(?:)/));

    // Two subclasses of the same built-in are still told apart by their names,
    // and each still moves with its own contents.
    class OtherMap extends Map<string, number> {}
    expect(objectVersion(new MyMap([["a", 1]]))).not.toBe(
      objectVersion(new OtherMap([["a", 1]])),
    );
    expect(objectVersion(new MyMap([["a", 1]]))).not.toBe(
      objectVersion(new MyMap([["a", 2]])),
    );
  });

  it("honours `toJSON`, without confusing a value for what it serializes to", () => {
    const custom = { toJSON: () => ({ kind: "one" }) };
    const other = { toJSON: () => ({ kind: "two" }) };
    expect(objectVersion(custom)).not.toBe(objectVersion(other));
    // A `Date` and its own ISO string are different values, so they get
    // different versions — the type name is kept alongside the replacement.
    const date = new Date(1);
    expect(objectVersion(date)).not.toBe(objectVersion(date.toISOString()));
  });
});

// ---------------------------------------------------------------------------
// The header
// ---------------------------------------------------------------------------

describe("formatIfMatch / parseIfMatch", () => {
  it("round-trips a version through the header it travels in", () => {
    expect(IF_MATCH_HEADER).toBe("If-Match");
    const version = contentVersion("# Alpha\n");
    expect(formatIfMatch(version)).toBe(`"${version}"`);
    expect(parseIfMatch(formatIfMatch(version))).toBe(version);
    // Whitespace an intermediary may add is not a malformation.
    expect(parseIfMatch(`  ${formatIfMatch(version)} `)).toBe(version);
  });

  it("treats `*`, an unquoted value, and an empty header as ABSENT", () => {
    // `*` is "any current representation", i.e. the unconditional write this
    // guard exists to stop. Accepting it would let a caller opt out with one
    // character.
    for (const header of [
      "*",
      " * ",
      "w1:3-0000000000000000",
      "",
      "   ",
      '""',
      'W/"w1:3-0000000000000000"',
      '"a", "b"',
      null,
      undefined,
    ]) {
      expect(parseIfMatch(header)).toBeNull();
    }
  });

  it("never treats a malformed header as a MATCH", () => {
    const current = contentVersion("bytes");
    for (const header of ["*", current, "", null]) {
      expect(checkWritePrecondition(header, current).ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// checkWritePrecondition
// ---------------------------------------------------------------------------

describe("checkWritePrecondition", () => {
  const current = contentVersion("# Alpha\n\noriginal\n");

  it("passes a header that describes the bytes the route is holding", () => {
    expect(checkWritePrecondition(formatIfMatch(current), current)).toEqual({
      ok: true,
    });
  });

  it("answers 428 when there is no usable precondition at all", () => {
    expect(checkWritePrecondition(null, current)).toEqual({
      ok: false,
      status: WRITE_PRECONDITION_REQUIRED_STATUS,
      error: WRITE_PRECONDITION_REQUIRED_COPY,
    });
    expect(WRITE_PRECONDITION_REQUIRED_STATUS).toBe(428);
  });

  it("answers 412 when the header describes OTHER bytes", () => {
    const stale = contentVersion("# Alpha\n\nwhat it used to say\n");
    expect(checkWritePrecondition(formatIfMatch(stale), current)).toEqual({
      ok: false,
      status: WRITE_CONFLICT_STATUS,
      error: WRITE_CONFLICT_COPY,
    });
    expect(WRITE_CONFLICT_STATUS).toBe(412);
  });

  it("answers 412 when the TARGET IS GONE — a missing file matches no version", () => {
    // Not 404 and not a pass: a save into a hole is the lost update, not an
    // exception to it, and the draft has to survive it.
    expect(checkWritePrecondition(formatIfMatch(current), null)).toMatchObject({
      ok: false,
      status: WRITE_CONFLICT_STATUS,
    });
    // …and a gone target with NO header is still the missing-precondition case,
    // because the request was malformed before the target mattered.
    expect(checkWritePrecondition(null, null)).toMatchObject({
      ok: false,
      status: WRITE_PRECONDITION_REQUIRED_STATUS,
    });
  });

  it("has exactly two sentences, and they are recoverable", () => {
    // ONE wording per outcome, owned here: no surface types a conflict sentence
    // at its render site, so a rewrite of either has to happen in this module.
    for (const copy of [WRITE_CONFLICT_COPY, WRITE_PRECONDITION_REQUIRED_COPY]) {
      // The draft is never destroyed, and the sentence says so — otherwise an
      // owner reads a refusal and assumes their text is gone.
      expect(copy).toContain("Your text is still here");
      // ONE recovery instruction for both: reloading destroys the draft
      // identically whichever refusal this was, so "copy it" is exactly as
      // load-bearing on the 428 as on the 412. Only the first clause differs.
      expect(copy).toContain(
        "Your text is still here — copy it, reload, and apply it to the current version.",
      );
      // It names no file, no person and no time: the routes know none of them.
      expect(copy).not.toMatch(/schema\.md|\.llm-wiki-config|slug/i);
    }
    expect(WRITE_CONFLICT_COPY).not.toBe(WRITE_PRECONDITION_REQUIRED_COPY);
  });
});

// ---------------------------------------------------------------------------
// checkVersionPrecondition + WriteConflictError (DW-193)
// ---------------------------------------------------------------------------

describe("checkVersionPrecondition", () => {
  const STORED = contentVersion("# Alpha\n");

  it("passes when the supplied version is the current one", () => {
    expect(checkVersionPrecondition(STORED, STORED)).toEqual({ ok: true });
  });

  it("refuses a version that is not the current one with the conflict", () => {
    expect(checkVersionPrecondition(STORED, contentVersion("# Beta\n"))).toEqual({
      ok: false,
      status: WRITE_CONFLICT_STATUS,
      error: WRITE_CONFLICT_COPY,
    });
  });

  it("refuses against a target that is GONE — a missing file matches nothing", () => {
    expect(checkVersionPrecondition(STORED, null)).toEqual({
      ok: false,
      status: WRITE_CONFLICT_STATUS,
      error: WRITE_CONFLICT_COPY,
    });
  });

  it("refuses an absent version with the 428, not the conflict", () => {
    // `null` is what `parseIfMatch` answers for a missing, wildcard, unquoted
    // or listed header — the "could not be checked" fact, which is different
    // from "was checked and did not match".
    expect(checkVersionPrecondition(null, STORED)).toEqual({
      ok: false,
      status: WRITE_PRECONDITION_REQUIRED_STATUS,
      error: WRITE_PRECONDITION_REQUIRED_COPY,
    });
    // Even when the target is gone too: nothing was checkable, so the caller's
    // request is the fact to report.
    expect(checkVersionPrecondition(null, null)).toEqual({
      ok: false,
      status: WRITE_PRECONDITION_REQUIRED_STATUS,
      error: WRITE_PRECONDITION_REQUIRED_COPY,
    });
  });

  it("is the ONE comparison — `checkWritePrecondition` is it, with the header parsed", () => {
    // Not two expressions of "does this match": the header-level check must
    // answer exactly what the parsed-version check answers, for every header
    // shape, or a route that runs one half would accept what the other refuses.
    for (const header of [
      null,
      undefined,
      "*",
      "",
      STORED,
      formatIfMatch(STORED),
      formatIfMatch(contentVersion("# Beta\n")),
      `${formatIfMatch(STORED)}, "other"`,
      `W/${formatIfMatch(STORED)}`,
    ]) {
      expect([header, checkWritePrecondition(header, STORED)]).toEqual([
        header,
        checkVersionPrecondition(parseIfMatch(header), STORED),
      ]);
    }
  });
});

describe("WriteConflictError", () => {
  it("carries the shared sentence and nothing of its own", () => {
    expect(new WriteConflictError().message).toBe(WRITE_CONFLICT_COPY);
  });

  it("is recognised by NAME, so a duplicated module graph cannot turn a 412 into a 500", () => {
    const err = new WriteConflictError();
    expect(err.name).toBe("WriteConflictError");
    expect(isWriteConflictError(err)).toBe(true);
    // A structurally identical error from a SECOND copy of this module — what
    // vitest's two projects, bundler chunking and the stdio MCP entry point
    // actually produce — is still classified.
    const duplicate = new Error(WRITE_CONFLICT_COPY);
    duplicate.name = "WriteConflictError";
    expect(isWriteConflictError(duplicate)).toBe(true);
  });

  it("does not classify anything else", () => {
    for (const other of [
      null,
      undefined,
      WRITE_CONFLICT_COPY,
      new Error(WRITE_CONFLICT_COPY),
      { name: "WriteConflictError" },
    ]) {
      expect([String(other), isWriteConflictError(other)]).toEqual([
        String(other),
        false,
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// ONE wording, in ONE module — the wiring a node suite cannot execute
// ---------------------------------------------------------------------------

describe("the conflict sentence has exactly one owner", () => {
  const SRC = path.resolve(__dirname, "../..");

  /** Every file that participates in the guard, on both sides of the wire. */
  const PARTICIPANTS = [
    "app/api/wiki/[slug]/route.ts",
    "app/api/workbench/artifact/route.ts",
    "app/api/settings/route.ts",
    "app/api/workspace-profile/route.ts",
    "app/api/workbench/preview/route.ts",
    "lib/workbench-preview.ts",
    "lib/workbench-settings.ts",
    "components/workbench/PreviewColumn.tsx",
    "components/workbench/SettingsCanvas.tsx",
    "components/WikiEditor.tsx",
    "components/WorkspacePurposeSettings.tsx",
    "hooks/useSettings.ts",
    "app/u/[handle]/[slug]/edit/page.tsx",
  ];

  async function read(file: string): Promise<string> {
    return fs.readFile(path.join(SRC, file), "utf8");
  }

  it("is typed at no render site and in no route — BOTH sentences", async () => {
    // The routes relay `precondition.error`; the surfaces relay the server's
    // `{ error }`. Neither may spell either sentence, or the three surfaces
    // would drift into three wordings for one fact. Scanning only the 412 copy
    // left the 428 one free to be typed at a render site with nothing failing.
    for (const copy of [WRITE_CONFLICT_COPY, WRITE_PRECONDITION_REQUIRED_COPY]) {
      const distinctive = copy.slice(0, 40);
      for (const file of PARTICIPANTS) {
        expect([file, copy.slice(0, 12), (await read(file)).includes(distinctive)]).toEqual([
          file,
          copy.slice(0, 12),
          false,
        ]);
      }
    }
  });

  it("is reached only through this module, on every write route", async () => {
    // THE THREE ROUTES THAT READ THEIR OWN MERGE BASE run the whole guard in
    // place. The check is the shared function, never a comparison typed at the
    // route — two expressions of "does this match" is how one route starts
    // accepting what another refuses.
    for (const route of [
      "app/api/wiki/[slug]/route.ts",
      "app/api/settings/route.ts",
      "app/api/workspace-profile/route.ts",
    ]) {
      const source = await read(route);
      expect([route, source.includes('from "@/lib/write-precondition"')]).toEqual([
        route,
        true,
      ]);
      expect([route, source.includes("checkWritePrecondition(")]).toEqual([
        route,
        true,
      ]);
      expect([route, source.includes("IF_MATCH_HEADER")]).toEqual([route, true]);
      // …and the status codes come from the outcome, not from a literal.
      expect(source).not.toMatch(/status: 412|, 412\)/);
      expect(source).not.toMatch(/status: 428|, 428\)/);
    }

    // THE ARTIFACT ROUTE RUNS HALF OF IT (DW-193), and the half it keeps is
    // pinned precisely — accepting "it mentions `parseIfMatch`" would let it
    // parse the header, never compare anything, and stay green.
    const artifact = await read("app/api/workbench/artifact/route.ts");
    expect(artifact).toContain('from "@/lib/write-precondition"');
    expect(artifact).toContain("IF_MATCH_HEADER");
    // It reads the header through this module…
    expect(artifact).toContain("parseIfMatch(");
    // …and it does NOT compare in place: the comparison it would otherwise run
    // is the one that moved inside the lock.
    expect(artifact).not.toContain("checkWritePrecondition(");
    // …so the parsed version MUST reach the writer, or nothing is checked at
    // all. This is the assertion that makes the two halves add up to one guard.
    // Bounded to the CALL's own argument list (no `;` crosses it), so a later
    // mention of the word elsewhere in the file cannot satisfy this.
    expect(artifact).toMatch(/writeWikiArtifact\([^;]*\bexpectedVersion\b[^;]*\)/);
    expect(artifact).not.toMatch(/status: 412|, 412\)/);
    expect(artifact).not.toMatch(/status: 428|, 428\)/);

    // THE HALF THAT MOVED still lives in this module, not in the writer.
    const writer = await read("lib/wikis.ts");
    expect(writer).toContain('from "./write-precondition"');
    expect(writer).toContain("checkVersionPrecondition(");
    // It compares against the SCOPED version (DW-200), not the content-only
    // one, so a token read from one Wiki matches no other.
    expect(writer).toContain("scopedContentVersion(");
    // The writer never re-types either sentence and never answers a status: it
    // throws, and the route maps it. (`412` appears in prose there, which is
    // why this scans for the answer shape rather than for the number.)
    for (const copy of [WRITE_CONFLICT_COPY, WRITE_PRECONDITION_REQUIRED_COPY]) {
      expect(writer).not.toContain(copy.slice(0, 40));
    }
    expect(writer).not.toMatch(/status: 412|, 412\)/);
    expect(writer).not.toMatch(/status: 428|, 428\)/);
  });

  it("is not gated onto the routes DW-38/51/56/63 do not name", async () => {
    // Record, do not widen. `PATCH` (metadata), `POST /api/wiki`, the revisions
    // and revert routes, the re-ingest route and the MCP server all keep their
    // current contract — a precondition there would refuse callers this story
    // never examined.
    for (const file of [
      "app/api/wiki/route.ts",
      "app/api/ingest/reingest/route.ts",
      "mcp.ts",
    ]) {
      // Read without a `catch`: a renamed file must fail here rather than
      // silently turn this into an assertion about the empty string.
      const source = await read(file);
      expect(source).not.toContain("write-precondition");
    }
    // `PATCH` lives in the same file as the gated `PUT`, so it is checked as a
    // slice rather than as a file: exactly ONE call site, and it is the `PUT`.
    const page = await read("app/api/wiki/[slug]/route.ts");
    expect(page.match(/checkWritePrecondition\(/g) ?? []).toHaveLength(1);
    const patch = page.slice(page.indexOf("export async function PATCH"));
    expect(patch).not.toContain("checkWritePrecondition");
    expect(patch).not.toContain("IF_MATCH_HEADER");
  });
});
