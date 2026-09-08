import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  applyNamesTermsToGeneratedText,
  buildNamesTermsGuidance,
  canonicalizeNamesTerm,
  createNamesTerm,
  createNamesTermsCache,
  deleteNamesTerm,
  expandQueryWithNamesTerms,
  type FrozenNamesTermEntry,
  listNamesTerms,
  NamesTermConflictError,
  type NamesTermEntry,
  type NamesTermInput,
  parseNamesTermInput,
  renderNamesTermsGuidance,
  updateNamesTerm,
} from "../names-terms";
import { ClientInputError } from "../errors";
import { _resetLocks } from "../lock";
import { _resetStorage, getStorage } from "../storage";
import { tenantForOwner } from "../wiki";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "names-terms-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetStorage();
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("owner names and terms dictionary", () => {
  it("stores entries per owner and canonicalizes exact aliases", async () => {
    const entry = await createNamesTerm("Alice", {
      kind: "person",
      canonical: "Christian Lee",
      aliases: ["Christian", "Chris Lee", " christian "],
      role: "Product owner",
      organization: "WorkWiki",
    });

    expect(entry.aliases).toEqual(["Christian", "Chris Lee"]);
    expect(await listNamesTerms("bob")).toEqual([]);
    expect(canonicalizeNamesTerm(await listNamesTerms("alice"), "chris lee", ["person"]))
      .toBe("Christian Lee");
  });

  it("rejects ambiguous canonical or alias labels", async () => {
    await createNamesTerm("alice", {
      kind: "organization",
      canonical: "Chevron",
      aliases: ["CVX"],
    });
    await expect(createNamesTerm("alice", {
      kind: "acronym",
      canonical: "CVX",
    })).rejects.toBeInstanceOf(NamesTermConflictError);
  });

  /**
   * DW-641. The doors' 400 is now a TYPE check, so this is its source of truth:
   * if `cleanInput` went back to a bare `Error`, `POST`/`PUT /api/names-terms`
   * would answer 500 for a blank name instead of 400 and this row is what says
   * so. The messages are asserted alongside the class because the response body
   * carries the store's own sentence verbatim.
   */
  it.each([
    [
      "a kind that is not one of the five",
      { kind: "spaceship", canonical: "Christian Lee" } as unknown as NamesTermInput,
      "Invalid names and terms type",
    ],
    [
      "a canonical that is blank once trimmed",
      { kind: "person", canonical: "   " } as NamesTermInput,
      "Preferred name or term is required",
    ],
    [
      "an email that is not an address",
      { kind: "person", canonical: "Christian Lee", email: "chris at work" } as NamesTermInput,
      "Enter a valid email address",
    ],
  ])("refuses %s as the caller's input, not a server fault", async (_label, input, message) => {
    await expect(createNamesTerm("alice", input)).rejects.toBeInstanceOf(ClientInputError);
    await expect(createNamesTerm("alice", input)).rejects.toThrow(message);
    // Nothing was written for a refused entry.
    expect(await listNamesTerms("alice")).toEqual([]);
  });

  it("throws the same class from the parse door, so a route sees one type", async () => {
    // `parseNamesTermInput` runs BEFORE the store on both writing routes; both
    // halves of the request path must agree about whose fault a bad body is.
    expect(() => parseNamesTermInput({ kind: "spaceship", canonical: "x" }))
      .toThrow(ClientInputError);
    expect(() => parseNamesTermInput({ kind: "person", canonical: "" }))
      .toThrow(ClientInputError);
    expect(() => parseNamesTermInput({ kind: "person", canonical: "x", aliases: "Chris" }))
      .toThrow(ClientInputError);
    expect(() => parseNamesTermInput({ kind: "person", canonical: "x", role: 7 }))
      .toThrow(ClientInputError);
  });

  it("refuses the 500-entry cap as the caller's input too", async () => {
    // The eighth retyped site, and the only one that needs a full dictionary to
    // reach. A cap is the owner's own state, not a broken store, so it must not
    // arrive at `POST /api/names-terms` as the 500 an untyped throw would buy.
    const relative = `tenants/${tenantForOwner("alice")}/names-terms.json`;
    const full: NamesTermEntry[] = Array.from({ length: 500 }, (_value, index) => ({
      id: `entry-${index}`,
      kind: "project",
      canonical: `Project ${index}`,
      aliases: [],
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    }));
    await fs.mkdir(path.dirname(path.join(tmpDir, relative)), { recursive: true });
    await fs.writeFile(path.join(tmpDir, relative), JSON.stringify(full));

    await expect(createNamesTerm("alice", {
      kind: "person",
      canonical: "Christian Lee",
    })).rejects.toBeInstanceOf(ClientInputError);
  });

  it("supports updates and deletion", async () => {
    const entry = await createNamesTerm("alice", {
      kind: "project",
      canonical: "WorkWiki",
    });
    const updated = await updateNamesTerm("alice", entry.id, {
      kind: "project",
      canonical: "WorkWiki",
      aliases: ["Yopedia"],
      guidance: "Call the product WorkWiki in customer-facing prose.",
    });
    expect(updated?.aliases).toEqual(["Yopedia"]);
    expect(await deleteNamesTerm("alice", entry.id)).toBe(true);
    expect(await listNamesTerms("alice")).toEqual([]);
  });

  it("expands retrieval only when a configured name or alias appears", async () => {
    await createNamesTerm("alice", {
      kind: "project",
      canonical: "Project Lighthouse",
      aliases: ["Lighthouse"],
    });
    expect(await expandQueryWithNamesTerms("alice", "What changed in Lighthouse?"))
      .toContain("Project Lighthouse, Lighthouse");
    expect(await expandQueryWithNamesTerms("alice", "What changed today?"))
      .toBe("What changed today?");
  });

  it("tells models to preserve evidence while preferring canonical labels", () => {
    const guidance = renderNamesTermsGuidance([{
      id: "one",
      kind: "person",
      canonical: "Christian Lee",
      aliases: ["Chris"],
      guidance: "Use the full name in formal summaries.",
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    }]);
    expect(guidance).toContain("Never alter direct quotations or source excerpts");
    expect(guidance).toContain("person: Christian Lee");
    expect(guidance).toContain("aliases: Chris");
  });

  it("canonicalizes aliases in generated digest prose without partial-word matches", () => {
    const entry = {
      id: "one",
      kind: "organization" as const,
      canonical: "Chevron",
      aliases: ["CVX"],
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    };
    expect(applyNamesTermsToGeneratedText([entry], "CVX published an update."))
      .toBe("Chevron published an update.");
    expect(applyNamesTermsToGeneratedText([entry], "ACVX code stayed unchanged."))
      .toBe("ACVX code stayed unchanged.");
  });
});

// ---------------------------------------------------------------------------
// The dictionary read is memoized per tenant by a caller-owned handle (DW-322)
// ---------------------------------------------------------------------------

/**
 * `buildNamesTermsGuidance` costs a storage read on every call, and one
 * `ingest()` makes up to four of them for a value that cannot change
 * mid-document. The optional handle collapses that to one read — so the
 * assertions here are about READ COUNTS against the real temp-`DATA_DIR`
 * filesystem, the only direct evidence the memo works. The uncached path is
 * pinned alongside, because "omit the handle and nothing changes" is half the
 * contract.
 */
describe("names and terms dictionary caching", () => {
  /** Where the dictionary lives — `dictionaryPath` itself is private. */
  function dictionaryFile(owner: string): string {
    return `tenants/${tenantForOwner(owner)}/names-terms.json`;
  }

  /** Rewrite the bytes directly, so seeding costs no counted read or write. */
  async function writeDictionaryBytes(
    owner: string,
    entries: readonly NamesTermEntry[],
  ): Promise<void> {
    await writeDictionaryText(owner, JSON.stringify(entries));
  }

  /**
   * The same, for bytes no `NamesTermEntry[]` can express — the hand-edited and
   * truncated files the read boundary has to degrade over (DW-499). Written as
   * TEXT rather than cast through the typed helper, because the point of these
   * fixtures is that they are not entries.
   */
  async function writeDictionaryText(owner: string, text: string): Promise<void> {
    const relative = dictionaryFile(owner);
    await fs.mkdir(path.dirname(path.join(tmpDir, relative)), { recursive: true });
    await fs.writeFile(path.join(tmpDir, relative), text);
  }

  /**
   * A read result seen through the WRITE type.
   *
   * The read type is frozen at COMPILE time now (DW-498), so the mutations the
   * freeze tests below assert on no longer typecheck — which is the point of
   * that change and is pinned on its own further down. The cast is the only way
   * a consumer could still reach the mutating line (a `any`, a stale
   * declaration, a JS caller), and `Object.freeze` is what stops them there. It
   * is deliberately a cast and not a type change: nothing in the source hands
   * out a mutable read result.
   */
  function asMutable(value: FrozenNamesTermEntry): NamesTermEntry {
    return value as NamesTermEntry;
  }

  function entry(canonical: string): NamesTermEntry {
    return {
      id: canonical.toLowerCase().replace(/\s+/g, "-"),
      kind: "project",
      canonical,
      aliases: [],
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    };
  }

  /**
   * Count `readFile` calls per path, installed AFTER the fixture is on disk so
   * only the calls under test are counted.
   */
  function countReads(): (relativePath: string) => number {
    const storage = getStorage();
    const readFile = storage.readFile.bind(storage);
    const seen: string[] = [];
    vi.spyOn(storage, "readFile").mockImplementation(async (target: string) => {
      seen.push(target);
      return readFile(target);
    });
    return (relativePath) => seen.filter((p) => p === relativePath).length;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the dictionary once per tenant when a handle is passed", async () => {
    await writeDictionaryBytes("alice", [entry("Project Lighthouse")]);

    const reads = countReads();
    const cache = createNamesTermsCache();

    const first = await buildNamesTermsGuidance("alice", cache);
    expect(first).toContain("Project Lighthouse");

    // The bytes change under the memo. A cached call must NOT see it — that is
    // the whole point: within one operation the value is fixed.
    await writeDictionaryBytes("alice", [entry("Phoenix Reading Shelf")]);

    const second = await buildNamesTermsGuidance("alice", cache);
    expect(second).toBe(first);
    expect(second).not.toContain("Phoenix Reading Shelf");

    expect(reads(dictionaryFile("alice"))).toBe(1);
  });

  it("re-reads on every call when no handle is passed", async () => {
    await writeDictionaryBytes("alice", [entry("Project Lighthouse")]);

    const reads = countReads();

    const first = await buildNamesTermsGuidance("alice");
    expect(first).toContain("Project Lighthouse");

    await writeDictionaryBytes("alice", [entry("Phoenix Reading Shelf")]);

    const second = await buildNamesTermsGuidance("alice");
    expect(second).toContain("Phoenix Reading Shelf");
    expect(second).not.toContain("Project Lighthouse");

    expect(reads(dictionaryFile("alice"))).toBe(2);
  });

  it("shares one read between listNamesTerms and buildNamesTermsGuidance", async () => {
    await writeDictionaryBytes("alice", [entry("Project Lighthouse")]);

    const reads = countReads();
    const cache = createNamesTermsCache();

    const listed = await listNamesTerms("alice", cache);
    expect(listed.map((e) => e.canonical)).toEqual(["Project Lighthouse"]);

    const guidance = await buildNamesTermsGuidance("alice", cache);
    expect(guidance).toContain("Project Lighthouse");

    expect(reads(dictionaryFile("alice"))).toBe(1);
  });

  it("shares one in-flight read between concurrent callers", async () => {
    // The memo is stored BEFORE the read settles, so the `Promise.all` pairs in
    // `ingest.ts` join one read rather than racing two.
    await writeDictionaryBytes("alice", [entry("Project Lighthouse")]);

    const reads = countReads();
    const cache = createNamesTermsCache();

    const [a, b] = await Promise.all([
      buildNamesTermsGuidance("alice", cache),
      listNamesTerms("alice", cache),
    ]);
    expect(a).toContain("Project Lighthouse");
    expect(b).toHaveLength(1);
    expect(reads(dictionaryFile("alice"))).toBe(1);
  });

  it("hands every cached caller its own array, so one cannot corrupt the next", async () => {
    await writeDictionaryBytes("alice", [
      entry("Alpha Project"),
      entry("Beta Project"),
    ]);

    const cache = createNamesTermsCache();
    const first = await listNamesTerms("alice", cache);
    expect(first.map((e) => e.canonical)).toEqual(["Alpha Project", "Beta Project"]);

    // A caller mutating its own result (several sort or splice theirs).
    first.reverse();
    first.splice(0, 1);

    const second = await listNamesTerms("alice", cache);
    expect(second).not.toBe(first);
    expect(second.map((e) => e.canonical)).toEqual(["Alpha Project", "Beta Project"]);
  });

  it("freezes each entry and its aliases, so one caller cannot edit another's", async () => {
    // The fresh top-level array protects the ORDER; it does not protect the
    // entry OBJECTS, which every caller under the handle shares. An unfrozen
    // `entry.aliases.push(...)` would leak into every later caller (DW-397);
    // frozen makes it an immediate TypeError at the mutating line.
    await writeDictionaryBytes("alice", [
      { ...entry("Alpha Project"), aliases: ["Alpha"] },
      entry("Beta Project"),
    ]);

    const cache = createNamesTermsCache();
    const first = await listNamesTerms("alice", cache);

    expect(Object.isFrozen(first[0])).toBe(true);
    expect(Object.isFrozen(first[0].aliases)).toBe(true);
    expect(() => asMutable(first[0]).aliases.push("Alfa")).toThrow(TypeError);
    expect(() => {
      asMutable(first[0]).canonical = "Hijacked";
    }).toThrow(TypeError);

    // The ARRAY stays mutable — callers legitimately sort and splice their own.
    expect(Object.isFrozen(first)).toBe(false);
    first.sort((a, b) => b.canonical.localeCompare(a.canonical));
    first.splice(0, 1);

    const second = await listNamesTerms("alice", cache);
    expect(second.map((e) => e.canonical)).toEqual([
      "Alpha Project",
      "Beta Project",
    ]);
    expect(second[0].aliases).toEqual(["Alpha"]);
  });

  it("freezes entries on the uncached path too, so the paths cannot drift", async () => {
    await writeDictionaryBytes("alice", [
      { ...entry("Alpha Project"), aliases: ["Alpha"] },
    ]);

    const entries = await listNamesTerms("alice");

    expect(Object.isFrozen(entries[0])).toBe(true);
    expect(Object.isFrozen(entries[0].aliases)).toBe(true);
    expect(() => asMutable(entries[0]).aliases.push("Alfa")).toThrow(TypeError);
    expect(() => {
      asMutable(entries[0]).canonical = "Hijacked";
    }).toThrow(TypeError);
  });

  /**
   * A corrupt dictionary degrades to its VALID SUBSET, at the read boundary
   * (DW-499).
   *
   * Every one of these used to fail the whole read. `resolveSortedEntries`
   * sorted BEFORE it skipped a non-object element, so a `null` beside a real
   * entry threw `TypeError: Cannot read properties of null (reading 'kind')`
   * out of the comparator; and a one-element file the comparator never touched
   * survived as far as `renderNamesTermsGuidance`'s `entry.aliases`. Both are
   * now dropped in `readEntries`, so the sort, the freeze and every pure helper
   * downstream see only elements they can dereference.
   *
   * `bytes` is what is on disk; `canonicals` is what the read must yield.
   */
  const DEGRADING_DICTIONARIES: ReadonlyArray<
    [label: string, bytes: string, canonicals: readonly string[]]
  > = [
    [
      "a corrupt element beside a real one",
      JSON.stringify([null, entry("Project Lighthouse")]),
      ["Project Lighthouse"],
    ],
    [
      "a field-less entry",
      '[{"kind":"project","canonical":"X"}]',
      [],
    ],
    [
      "an entry whose aliases are not all strings",
      JSON.stringify([{ ...entry("Project Lighthouse"), aliases: [1] }]),
      [],
    ],
    [
      "a non-object element",
      '["Project Lighthouse", 7, true]',
      [],
    ],
  ];

  for (const [label, bytes, canonicals] of DEGRADING_DICTIONARIES) {
    it(`degrades to the valid subset when the file holds ${label}`, async () => {
      await writeDictionaryText("alice", bytes);

      const uncached = await listNamesTerms("alice");
      expect(uncached.map((e) => e.canonical)).toEqual(canonicals);

      // And the cached path lands on the same resolve, so the two cannot drift.
      const cache = createNamesTermsCache();
      const cached = await listNamesTerms("alice", cache);
      expect(cached.map((e) => e.canonical)).toEqual(canonicals);

      // The RENDER layer is the one that used to throw on these files, and it
      // is what `merge.ts` probes before a fold.
      const guidance = renderNamesTermsGuidance(uncached);
      await expect(buildNamesTermsGuidance("alice")).resolves.toBe(guidance);
      if (canonicals.length === 0) expect(guidance).toBe("");
      else for (const canonical of canonicals) expect(guidance).toContain(canonical);
    });
  }

  it("lets a WRITE through a corrupt dictionary — and drops the element from the file", async () => {
    // The WRITE half of the read-boundary filter, which is not obvious from the
    // name `readEntries`: `createNamesTerm` / `updateNamesTerm` /
    // `deleteNamesTerm` all read through it and then persist what they read.
    //
    // (a) The create now RESOLVES. Before the filter, `assertNoConflicts` ran
    //     `[entry.canonical, ...entry.aliases]` over the raw parsed array and
    //     threw a `TypeError` on the unreadable element, so `POST
    //     /api/names-terms` answered 500 and the owner could not add a term at
    //     all until they hand-repaired the file.
    //
    // (b) The dropped element is GONE from the bytes afterwards. Every
    //     comparable store here (`query-history`, `workspace-profile`,
    //     `research-projects`) asserts the opposite — that a write preserves
    //     what it did not touch — so this asymmetry is deliberate and has to be
    //     visible. It is also the tripwire for the obvious future refactor:
    //     moving the filter down into `resolveSortedEntries` to stop deleting
    //     the owner's bytes leaves every READ test green while restoring the
    //     500 that (a) pins.
    await writeDictionaryText(
      "alice",
      JSON.stringify([{ kind: "project", canonical: "Half An Entry" }, entry("Project Lighthouse")]),
    );

    const created = await createNamesTerm("alice", {
      kind: "person",
      canonical: "Ada Lovelace",
    });
    expect(created.canonical).toBe("Ada Lovelace");

    // (a) again, from the outside: the read sees the survivor and the new one.
    const after = await listNamesTerms("alice");
    expect(after.map((e) => e.canonical)).toEqual([
      "Ada Lovelace",
      "Project Lighthouse",
    ]);

    // (b): read the BYTES, not the store — the store is what filtered.
    const bytes = await fs.readFile(
      path.join(tmpDir, dictionaryFile("alice")),
      "utf8",
    );
    expect(bytes).not.toContain("Half An Entry");
    expect(bytes).toContain("Project Lighthouse");
    expect(bytes).toContain("Ada Lovelace");
  });

  it("still rejects when the dictionary file does not parse at all", async () => {
    // The filter is a boundary over the PARSED array, not a repair of the
    // bytes: `readEntries` keeps its rethrow-everything-but-ENOENT behaviour,
    // so the `JSON.parse` SyntaxError still reaches the caller's own catch —
    // which is the whole reason `merge.ts` probes before it folds.
    await writeDictionaryText("alice", "{not json");

    await expect(listNamesTerms("alice")).rejects.toThrow(SyntaxError);
    await expect(buildNamesTermsGuidance("alice")).rejects.toThrow(SyntaxError);
  });

  it("types a read result as frozen, so a write through it does not compile", async () => {
    // The COMPILE-TIME half of the freeze (DW-498). `listNamesTerms` has always
    // handed back frozen entries, but its type said `NamesTermEntry[]`, so a
    // consumer could be written straight through `tsc` against a contract the
    // runtime then refuses at the mutating line — and under a shared handle
    // that line rewrites what every later caller sees.
    //
    // Never INVOKED: the assertions here are the `@ts-expect-error` directives
    // themselves, and each one fails the typecheck as "unused" the moment the
    // line below it starts compiling. Running the body would only re-prove the
    // runtime freeze, which the two tests above already pin.
    const writeThroughReadResult = async () => {
      const read = await listNamesTerms("alice");
      // @ts-expect-error — `FrozenNamesTermEntry.canonical` is `readonly`.
      read[0].canonical = "Hijacked";
      // @ts-expect-error — and `aliases` is a `readonly string[]`, so no `push`.
      read[0].aliases.push("Alfa");

      // The direction that must KEEP working: the write path stays mutable, so
      // a created or updated entry is still assignable in place.
      const created = await createNamesTerm("alice", {
        kind: "project",
        canonical: "Project Lighthouse",
      });
      created.canonical = "Renamed";
      created.aliases.push("Lighthouse");
    };

    expect(writeThroughReadResult).toBeTypeOf("function");
  });

  it("collapses two owner casings of one tenant onto a single read", async () => {
    // The memo is keyed by what ADDRESSES the file: "Alice" and "alice" are one
    // dictionary at `tenants/alice/names-terms.json`, so one handle must not
    // hold two slots — two reads and two snapshots that can diverge (DW-394).
    await writeDictionaryBytes("alice", [entry("Project Lighthouse")]);

    const reads = countReads();
    const cache = createNamesTermsCache();

    const first = await listNamesTerms("Alice", cache);
    expect(first.map((e) => e.canonical)).toEqual(["Project Lighthouse"]);

    // The bytes change under the memo: a second key would read them.
    await writeDictionaryBytes("alice", [entry("Phoenix Reading Shelf")]);

    const second = await listNamesTerms("alice", cache);
    expect(second.map((e) => e.canonical)).toEqual(["Project Lighthouse"]);
    expect(await buildNamesTermsGuidance("ALICE", cache)).toContain(
      "Project Lighthouse",
    );

    expect(cache.size).toBe(1);
    expect(reads(dictionaryFile("alice"))).toBe(1);
  });

  it("degrades an absent dictionary to [] once, without throwing", async () => {
    const reads = countReads();
    const cache = createNamesTermsCache();

    expect(await listNamesTerms("alice", cache)).toEqual([]);
    expect(await buildNamesTermsGuidance("alice", cache)).toBe("");

    expect(reads(dictionaryFile("alice"))).toBe(1);
  });

  it("evicts a FAILED read so the next call retries instead of inheriting it", async () => {
    // A handle can span a whole request (the batch route's inline fallback), so
    // pinning one transient non-ENOENT storage error would fail every remaining
    // document of that request even though each would have re-read and
    // succeeded. Only a successful read is memoized.
    await writeDictionaryBytes("alice", [entry("Project Lighthouse")]);

    const storage = getStorage();
    const readFile = storage.readFile.bind(storage);
    const seen: string[] = [];
    let failNext = true;
    vi.spyOn(storage, "readFile").mockImplementation(async (target: string) => {
      seen.push(target);
      if (failNext && target === dictionaryFile("alice")) {
        failNext = false;
        // Not ENOENT — ENOENT is the degrade-to-`[]` path, not a failure.
        throw Object.assign(new Error("EIO: transient storage failure"), {
          code: "EIO",
        });
      }
      return readFile(target);
    });

    const cache = createNamesTermsCache();

    await expect(listNamesTerms("alice", cache)).rejects.toThrow(
      "transient storage failure",
    );

    const recovered = await listNamesTerms("alice", cache);
    expect(recovered.map((e) => e.canonical)).toEqual(["Project Lighthouse"]);
    // Two reads: the one that failed and the retry. A pinned rejection would
    // have re-thrown without reading again.
    expect(seen.filter((path) => path === dictionaryFile("alice"))).toHaveLength(2);

    // And the successful read IS memoized — a third call adds no read.
    await listNamesTerms("alice", cache);
    expect(seen.filter((path) => path === dictionaryFile("alice"))).toHaveLength(2);
  });

  it("evicts a FAILED read under the TENANT key, not the raw handle", async () => {
    // The eviction must look the promise up under the SAME key it was stored
    // under. The test above cannot prove that: it uses "alice", where the raw
    // handle already equals its tenant, so an eviction keyed on `owner` passes
    // it unchanged. Here the handle differs from its tenant, so storing under
    // `tenant(owner)` while evicting under `owner` finds nothing to delete and
    // PINS the rejection — the second call would re-throw the transient error
    // without ever reading again.
    await writeDictionaryBytes("alice", [entry("Project Lighthouse")]);

    const storage = getStorage();
    const readFile = storage.readFile.bind(storage);
    const seen: string[] = [];
    let failNext = true;
    vi.spyOn(storage, "readFile").mockImplementation(async (target: string) => {
      seen.push(target);
      if (failNext && target === dictionaryFile("alice")) {
        failNext = false;
        throw Object.assign(new Error("EIO: transient storage failure"), {
          code: "EIO",
        });
      }
      return readFile(target);
    });

    const cache = createNamesTermsCache();

    await expect(listNamesTerms("Alice", cache)).rejects.toThrow(
      "transient storage failure",
    );
    // The rejected promise left no slot behind to inherit.
    expect(cache.size).toBe(0);

    const recovered = await listNamesTerms("Alice", cache);
    expect(recovered.map((e) => e.canonical)).toEqual(["Project Lighthouse"]);
    // Two reads: the one that failed and the retry. A rejection pinned under a
    // key the eviction never looked at would have re-thrown without reading.
    expect(seen.filter((path) => path === dictionaryFile("alice"))).toHaveLength(2);
  });

  it("never crosses two owners sharing one handle", async () => {
    await writeDictionaryBytes("alice", [entry("Project Lighthouse")]);
    await writeDictionaryBytes("bob", [entry("Phoenix Reading Shelf")]);

    const cache = createNamesTermsCache();

    expect((await listNamesTerms("alice", cache)).map((e) => e.canonical))
      .toEqual(["Project Lighthouse"]);
    expect((await listNamesTerms("bob", cache)).map((e) => e.canonical))
      .toEqual(["Phoenix Reading Shelf"]);
    expect(await buildNamesTermsGuidance("alice", cache))
      .toContain("Project Lighthouse");
    expect(await buildNamesTermsGuidance("bob", cache))
      .toContain("Phoenix Reading Shelf");
  });
});
