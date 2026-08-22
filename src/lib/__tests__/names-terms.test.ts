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
  listNamesTerms,
  NamesTermConflictError,
  type NamesTermEntry,
  renderNamesTermsGuidance,
  updateNamesTerm,
} from "../names-terms";
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
// The dictionary read is memoized per owner by a caller-owned handle (DW-322)
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
    const relative = dictionaryFile(owner);
    await fs.mkdir(path.dirname(path.join(tmpDir, relative)), { recursive: true });
    await fs.writeFile(path.join(tmpDir, relative), JSON.stringify(entries));
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

  it("reads the dictionary once per owner when a handle is passed", async () => {
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
