/**
 * The per-request guidance cache (DW-141).
 *
 * `buildWorkspaceGuidance` costs a registry read plus a profile read on every
 * call, and `ingest()` calls it up to three times for a value that cannot
 * change mid-document. The optional caller-owned handle collapses that to one
 * resolution — so the assertions here are about READ COUNTS against a real
 * temp-`DATA_DIR` filesystem, which is the only direct evidence the memo works.
 * The uncached path is pinned alongside, because "omit the handle and nothing
 * changes" is half the contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { _resetLocks } from "../lock";
import { logger } from "../logger";
import { _resetStorage, getStorage } from "../storage";
import { wikiProfilePath } from "../wiki-paths";
import { createWiki, wikiRegistryPath } from "../wikis";
import { saveWorkspaceProfile } from "../workspace-profile";
import {
  buildWorkspaceGuidance,
  createWorkspaceGuidanceCache,
} from "../workspace-guidance";

const OWNER = "alice";
const OTHER_OWNER = "bob";

let tmpDir: string;
let originalDataDir: string | undefined;

function abs(...segments: string[]): string {
  return path.join(tmpDir, ...segments);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-guidance-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetStorage();
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  _resetLocks();
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** A profile written as raw bytes, so rewriting it costs no counted reads. */
async function writeProfileBytes(
  owner: string,
  wikiId: string,
  purpose: string,
): Promise<void> {
  const relative = wikiProfilePath(owner, wikiId);
  await fs.mkdir(path.dirname(abs(relative)), { recursive: true });
  await fs.writeFile(
    abs(relative),
    JSON.stringify({
      version: 1,
      scenario: "custom",
      purpose,
      keyQuestions: [],
      inScope: [],
      outOfScope: [],
      outputLanguage: "English",
      pageConventions: "",
    }),
  );
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

describe("buildWorkspaceGuidance caching", () => {
  it("resolves once per owner when a cache handle is passed", async () => {
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    await saveWorkspaceProfile(OWNER, wiki.id, {
      scenario: "custom",
      purpose: "Track Project Lighthouse decisions.",
      keyQuestions: [],
      inScope: [],
      outOfScope: [],
      outputLanguage: "English",
      pageConventions: "",
    });

    const reads = countReads();
    const cache = createWorkspaceGuidanceCache();

    const first = await buildWorkspaceGuidance(OWNER, cache);
    expect(first).toContain("Project Lighthouse");

    // The bytes change under the memo. A cached call must NOT see it — that is
    // the whole point: within one document the value is fixed.
    await writeProfileBytes(OWNER, wiki.id, "Track the Phoenix reading shelf.");

    const second = await buildWorkspaceGuidance(OWNER, cache);
    expect(second).toBe(first);
    expect(second).not.toContain("Phoenix reading shelf");

    expect(reads(wikiRegistryPath(OWNER))).toBe(1);
    expect(reads(wikiProfilePath(OWNER, wiki.id))).toBe(1);
  });

  it("shares one in-flight resolution between concurrent callers", async () => {
    // The memo is stored BEFORE the resolution settles, so the `Promise.all`
    // pairs in `ingest.ts` join one read rather than racing two.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    await saveWorkspaceProfile(OWNER, wiki.id, {
      scenario: "custom",
      purpose: "Track Project Lighthouse decisions.",
      keyQuestions: [],
      inScope: [],
      outOfScope: [],
      outputLanguage: "English",
      pageConventions: "",
    });

    const reads = countReads();
    const cache = createWorkspaceGuidanceCache();

    const [a, b, c] = await Promise.all([
      buildWorkspaceGuidance(OWNER, cache),
      buildWorkspaceGuidance(OWNER, cache),
      buildWorkspaceGuidance(OWNER, cache),
    ]);

    expect(a).toContain("Project Lighthouse");
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(reads(wikiRegistryPath(OWNER))).toBe(1);
    expect(reads(wikiProfilePath(OWNER, wiki.id))).toBe(1);
  });

  it("re-reads on every call when NO cache handle is passed", async () => {
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    await saveWorkspaceProfile(OWNER, wiki.id, {
      scenario: "custom",
      purpose: "Track Project Lighthouse decisions.",
      keyQuestions: [],
      inScope: [],
      outOfScope: [],
      outputLanguage: "English",
      pageConventions: "",
    });

    const reads = countReads();

    expect(await buildWorkspaceGuidance(OWNER)).toContain("Project Lighthouse");
    await writeProfileBytes(OWNER, wiki.id, "Track the Phoenix reading shelf.");
    const second = await buildWorkspaceGuidance(OWNER);

    expect(second).toContain("Phoenix reading shelf");
    expect(second).not.toContain("Project Lighthouse");
    expect(reads(wikiRegistryPath(OWNER))).toBe(2);
    expect(reads(wikiProfilePath(OWNER, wiki.id))).toBe(2);
  });

  it("caches the no-wiki answer without ever reading a profile", async () => {
    const reads = countReads();
    const cache = createWorkspaceGuidanceCache();

    expect(await buildWorkspaceGuidance(OWNER, cache)).toBe("");
    expect(await buildWorkspaceGuidance(OWNER, cache)).toBe("");

    expect(reads(wikiRegistryPath(OWNER))).toBe(1);
    // No wiki id exists to key a profile read on, so nothing under `wikis/`
    // was touched at all.
    expect(
      reads(wikiProfilePath(OWNER, "00000000-0000-4000-8000-000000000042")),
    ).toBe(0);
  });

  it("caches the fail-soft empty answer and warns only once", async () => {
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    // Unreadable, not absent: a directory where wikis.json belongs makes the
    // read throw EISDIR rather than the ENOENT `readRegistry` degrades itself.
    await fs.rm(abs(wikiRegistryPath(OWNER)));
    await fs.mkdir(abs(wikiRegistryPath(OWNER)));

    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const reads = countReads();
    const cache = createWorkspaceGuidanceCache();

    expect(await buildWorkspaceGuidance(OWNER, cache)).toBe("");
    expect(await buildWorkspaceGuidance(OWNER, cache)).toBe("");

    expect(reads(wikiRegistryPath(OWNER))).toBe(1);
    expect(
      warn.mock.calls.filter((call) => call[0] === "workspace-guidance").length,
    ).toBe(1);
  });

  it("keeps two owners apart under one shared handle", async () => {
    const aliceWiki = await createWiki(OWNER, {
      name: "Ops",
      scenario: "business",
    });
    await saveWorkspaceProfile(OWNER, aliceWiki.id, {
      scenario: "custom",
      purpose: "Track Project Lighthouse decisions.",
      keyQuestions: [],
      inScope: [],
      outOfScope: [],
      outputLanguage: "English",
      pageConventions: "",
    });
    const bobWiki = await createWiki(OTHER_OWNER, {
      name: "Shelf",
      scenario: "reading",
    });
    await saveWorkspaceProfile(OTHER_OWNER, bobWiki.id, {
      scenario: "custom",
      purpose: "Track the Phoenix reading shelf.",
      keyQuestions: [],
      inScope: [],
      outOfScope: [],
      outputLanguage: "English",
      pageConventions: "",
    });

    const reads = countReads();
    const cache = createWorkspaceGuidanceCache();

    const alice = await buildWorkspaceGuidance(OWNER, cache);
    const bob = await buildWorkspaceGuidance(OTHER_OWNER, cache);

    expect(alice).toContain("Project Lighthouse");
    expect(alice).not.toContain("Phoenix reading shelf");
    expect(bob).toContain("Phoenix reading shelf");
    expect(bob).not.toContain("Project Lighthouse");

    // And each is still memoized under its OWN key. Value-equality alone would
    // pass with the memo removed, so the READ COUNTS are the real assertion:
    // four calls, one resolution each per owner and no leakage between them.
    expect(await buildWorkspaceGuidance(OWNER, cache)).toBe(alice);
    expect(await buildWorkspaceGuidance(OTHER_OWNER, cache)).toBe(bob);

    expect(reads(wikiRegistryPath(OWNER))).toBe(1);
    expect(reads(wikiProfilePath(OWNER, aliceWiki.id))).toBe(1);
    expect(reads(wikiRegistryPath(OTHER_OWNER))).toBe(1);
    expect(reads(wikiProfilePath(OTHER_OWNER, bobWiki.id))).toBe(1);
  });

  it("hands out a FRESH handle each time, so a new one re-reads", async () => {
    // The one guarantee the caller-owned design exists to provide: a handle's
    // memo dies with the handle. If the factory ever returned a shared map, a
    // Purpose saved between two operations would never be seen again.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    await saveWorkspaceProfile(OWNER, wiki.id, {
      scenario: "custom",
      purpose: "Track Project Lighthouse decisions.",
      keyQuestions: [],
      inScope: [],
      outOfScope: [],
      outputLanguage: "English",
      pageConventions: "",
    });

    const reads = countReads();

    const first = createWorkspaceGuidanceCache();
    expect(await buildWorkspaceGuidance(OWNER, first)).toContain(
      "Project Lighthouse",
    );

    await writeProfileBytes(OWNER, wiki.id, "Track the Phoenix reading shelf.");

    const second = createWorkspaceGuidanceCache();
    expect(second).not.toBe(first);
    const afterNewHandle = await buildWorkspaceGuidance(OWNER, second);

    expect(afterNewHandle).toContain("Phoenix reading shelf");
    expect(afterNewHandle).not.toContain("Project Lighthouse");
    expect(reads(wikiRegistryPath(OWNER))).toBe(2);
    expect(reads(wikiProfilePath(OWNER, wiki.id))).toBe(2);
  });
});
