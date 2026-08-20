/**
 * The read-only refusal at its ENFORCEMENT POINT (DW-187, DW-188).
 *
 * DW-37 gated read-only door by door at the HTTP layer, so every door it did
 * not name still wrote — and `src/mcp.ts`, the CLI and the agent runtime call
 * the kernel writers directly, where no HTTP gate can ever reach them. The fix
 * moves the gate into the four writers themselves, and this suite is the one
 * that goes through NO route at all: what it pins is that a direct library call
 * is refused, which is precisely the claim no route test can make.
 *
 * Every case asserts BYTES, not just a thrown error. A gate placed after the
 * write, or one that lets a side effect (index row, log line, backlink sweep,
 * refresh counter) land before throwing, would satisfy `rejects.toThrow` and
 * still have mutated the deployment.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { ensureDirectories, serializeFrontmatter } from "../wiki";
import { deleteWikiPage, writeWikiPageWithSideEffects } from "../lifecycle";
import { patchMetadata } from "../patch-metadata";
import {
  applyScenarioTemplate,
  createWiki,
  readWikiArtifact,
  renameWiki,
  writeWikiArtifact,
} from "../wikis";
import { getWorkspaceProfile, saveWorkspaceProfile } from "../workspace-profile";
import { listWikiArtifactRevisions } from "../wiki-artifact-revisions";
import { readDataVersion } from "../data-version";
import { READ_ONLY_REFUSAL, ReadOnlyError, isReadOnlyError } from "../read-only";
import { _resetLocks } from "../lock";
import { _resetStorage } from "../storage";
import type { Frontmatter } from "../frontmatter";

const OWNER = "yuanhao";

let tmpDir: string;
let original: Record<string, string | undefined> = {};

const ENV_KEYS = [
  "DATA_DIR",
  "WIKI_DIR",
  "RAW_DIR",
  "NEXT_PUBLIC_OWNER_HANDLE",
  "YOPEDIA_READONLY",
] as const;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-only-kernel-"));
  original = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.DATA_DIR = tmpDir;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.NEXT_PUBLIC_OWNER_HANDLE = OWNER;
  // The seeds below run through the same writers under test, so the world must
  // start WRITABLE — and be cleared rather than inherited, or a value exported
  // in one developer's shell would turn the writable control cases red.
  delete process.env.YOPEDIA_READONLY;
  await fs.mkdir(process.env.WIKI_DIR, { recursive: true });
  await fs.mkdir(process.env.RAW_DIR, { recursive: true });
  _resetLocks();
  _resetStorage();
  await ensureDirectories();
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/**
 * Every byte under the temp data dir, keyed by relative path.
 *
 * The whole tree rather than one file: a page write touches `index.md`,
 * `log.md`, the backlink/owner/recent/alias indexes and the page itself, and a
 * refusal that stopped only the page file would still be a mutated deployment.
 */
async function snapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else out[rel] = await fs.readFile(full, "utf8");
    }
  }
  await walk(tmpDir, "");
  return out;
}

const SEEDED_BODY = "Original content.";

async function seedPage(slug: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const frontmatter: Frontmatter = {
    created: today,
    confidence: 0.5,
    authors: [OWNER],
    owner: OWNER,
    visibility: "private",
    contributors: [],
    expiry: "2099-01-01",
    sources: [],
  };
  await writeWikiPageWithSideEffects({
    slug,
    title: slug,
    content: serializeFrontmatter(frontmatter, `# ${slug}\n\n${SEEDED_BODY}`),
    summary: "a seeded page",
    logOp: "ingest",
    crossRefSource: null,
  });
}

/**
 * A refusal is a `ReadOnlyError` whose sentence names read-only.
 *
 * `isReadOnlyError` matches on `name`, not `instanceof`, so this is also the
 * assertion that the classification routes rely on actually holds — a plain
 * `Error` with the right words would answer 500 at every catch.
 */
async function expectRefusal(
  op: () => Promise<unknown>,
  sentence: string,
): Promise<void> {
  const err = await op().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).not.toBeNull();
  expect(isReadOnlyError(err)).toBe(true);
  expect((err as Error).message).toBe(sentence);
  expect((err as Error).message).toContain("read-only");
}

describe("the kernel writers refuse on a read-only deployment", () => {
  it("writeWikiPageWithSideEffects — no page, no index row, no log line", async () => {
    const before = await snapshot();
    const beforeVersion = await readDataVersion();
    process.env.YOPEDIA_READONLY = "1";

    await expectRefusal(
      () =>
        writeWikiPageWithSideEffects({
          slug: "kernel-create",
          title: "Kernel create",
          content: "# Kernel create\n\nnew bytes",
          summary: "",
          logOp: "ingest",
          crossRefSource: null,
        }),
      READ_ONLY_REFUSAL.pageWrite,
    );

    expect(await snapshot()).toEqual(before);
    // The refresh counter is the observable a stale shell shows up in.
    expect(await readDataVersion()).toBe(beforeVersion);
  });

  it("writeWikiPageWithSideEffects — an EDIT of an existing page is refused too", async () => {
    await seedPage("kernel-edit");
    const before = await snapshot();
    process.env.YOPEDIA_READONLY = "1";

    await expectRefusal(
      () =>
        writeWikiPageWithSideEffects({
          slug: "kernel-edit",
          title: "kernel-edit",
          content: "# kernel-edit\n\nRewritten.",
          summary: "",
          logOp: "edit",
          crossRefSource: null,
        }),
      READ_ONLY_REFUSAL.pageWrite,
    );

    expect(await snapshot()).toEqual(before);
  });

  it("deleteWikiPage — the page and every index entry survive", async () => {
    await seedPage("kernel-delete");
    const before = await snapshot();
    const beforeVersion = await readDataVersion();
    process.env.YOPEDIA_READONLY = "1";

    await expectRefusal(
      () => deleteWikiPage("kernel-delete", OWNER),
      READ_ONLY_REFUSAL.pageDelete,
    );

    expect(await snapshot()).toEqual(before);
    expect(await readDataVersion()).toBe(beforeVersion);
  });

  it("deleteWikiPage — answers the same refusal for a slug that does not exist", async () => {
    // The gate runs BEFORE `validateSlug` and before the read, so a caller
    // cannot learn what is stored by comparing a known slug against an unknown
    // one — the DW-37 no-existence-oracle property, held at the kernel.
    await seedPage("kernel-real");
    process.env.YOPEDIA_READONLY = "1";

    const real = await deleteWikiPage("kernel-real").catch((e: unknown) => e);
    const ghost = await deleteWikiPage("kernel-ghost").catch((e: unknown) => e);
    expect((real as Error).message).toBe((ghost as Error).message);
    // And an invalid slug answers the refusal rather than "invalid slug".
    const invalid = await deleteWikiPage("../escape").catch((e: unknown) => e);
    expect((invalid as Error).message).toBe(READ_ONLY_REFUSAL.pageDelete);
  });

  it("patchMetadata — the frontmatter is untouched, and the sentence is the metadata one", async () => {
    await seedPage("kernel-patch");
    const before = await snapshot();
    process.env.YOPEDIA_READONLY = "1";

    // The refusal is stated BEFORE the lifecycle-key rejection and before the
    // ACL, so a patch that is ALSO invalid still reads as read-only rather than
    // as a permission or a field the caller does not lack. NO principal is
    // supplied on purpose: on a writable deployment this seeded private page
    // would cloak to "page not found: kernel-patch", so a gate ordered behind
    // the ACL would be caught here saying the wrong thing.
    await expectRefusal(
      () =>
        patchMetadata({
          slug: "kernel-patch",
          metadata: { confidence: 0.99 },
          author: OWNER,
        }),
      READ_ONLY_REFUSAL.pageMetadata,
    );
    await expectRefusal(
      () =>
        patchMetadata({
          slug: "kernel-patch",
          metadata: { created: "1999-01-01" },
          author: OWNER,
        }),
      READ_ONLY_REFUSAL.pageMetadata,
    );

    expect(await snapshot()).toEqual(before);
  });

  it("writeWikiArtifact — the Schema and its history are unchanged", async () => {
    const wiki = await createWiki(OWNER, { name: "Field notes", scenario: "research" });
    const seeded = await readWikiArtifact(OWNER, wiki.id, "schema.md");
    const before = await snapshot();
    process.env.YOPEDIA_READONLY = "1";

    await expectRefusal(
      () => writeWikiArtifact(OWNER, wiki.id, "schema.md", "# Rewritten Schema\n"),
      READ_ONLY_REFUSAL.artifactEdit,
    );

    // Refused BEFORE the lock and before the read-before-write snapshot, so the
    // Schema is byte-identical AND no revision was recorded for a save that
    // never happened.
    expect(await readWikiArtifact(OWNER, wiki.id, "schema.md")).toBe(seeded);
    expect(await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md")).toHaveLength(0);
    expect(await snapshot()).toEqual(before);
  });
});

/**
 * Four wiki writers gated by DW-266: `createWiki`, `applyScenarioTemplate`,
 * `renameWiki` and `saveWorkspaceProfile`.
 *
 * Not kernel writers in the DW-188 sense — `read-only-door-coverage.test.ts`
 * keeps `KERNEL_WRITERS` at four on purpose — but the same exposure: they are
 * exported library functions that write bytes, and a DIRECT LIBRARY CALLER (a
 * CLI command, a future MCP tool, a maintenance script) reaches them with no
 * route in front. Today the four API routes are their only callers and every
 * one of those gates first, so what these cases pin is the direct call.
 *
 * NOT A CLAIM ABOUT THE FAMILY. `deleteWiki`, `setCurrentWiki` and
 * `sweepOrphanWikiDirectories` still write `wikis.json` and delete Wiki
 * directories with no `assertWritable` — the bundle did not name them, so they
 * are a known gap rather than something these cases cover.
 *
 * WHAT THE BYTE SNAPSHOTS PROVE, AND WHAT THEY DO NOT. They prove the operation
 * committed nothing: no registry entry, no seeded file, no retitled heading, no
 * moved refresh counter. They do NOT prove the gate runs before the LOCK — a
 * gate moved inside the locked body would leave the tree byte-identical too,
 * because `discardCreatedWikiDirectory` removes a directory nothing had written
 * yet and `restoreSeededFiles` puts the snapshot back byte for byte. That
 * placement is what `describe("the gate precedes the lock")` below pins, by
 * source order, and the two together are the whole claim.
 */
describe("the wiki lifecycle writers refuse on a read-only deployment", () => {
  it("createWiki — no registry entry, no wiki directory, no compensation", async () => {
    // One existing wiki, so the registry file is already there and a refusal
    // that rewrote it (or swept the directory) would show as a diff rather than
    // as a missing file that was never there either way.
    await createWiki(OWNER, { name: "Field notes", scenario: "research" });
    const before = await snapshot();
    const beforeVersion = await readDataVersion();
    process.env.YOPEDIA_READONLY = "1";

    await expectRefusal(
      () => createWiki(OWNER, { name: "Second", scenario: "business" }),
      READ_ONLY_REFUSAL.wikiCreate,
    );

    expect(await snapshot()).toEqual(before);
    expect(await readDataVersion()).toBe(beforeVersion);
  });

  it("applyScenarioTemplate — no snapshot, no restore, no re-seeded bytes", async () => {
    const wiki = await createWiki(OWNER, { name: "Field notes", scenario: "research" });
    const seededSchema = await readWikiArtifact(OWNER, wiki.id, "schema.md");
    const before = await snapshot();
    process.env.YOPEDIA_READONLY = "1";

    await expectRefusal(
      () => applyScenarioTemplate(OWNER, wiki.id, "business"),
      READ_ONLY_REFUSAL.wikiTemplate,
    );

    // The re-template overwrites purpose.md, schema.md AND the wiki's own
    // workspace-profile.json; all three are inside the snapshot below, and the
    // Schema is called out because it is the EXECUTABLE one.
    expect(await readWikiArtifact(OWNER, wiki.id, "schema.md")).toBe(seededSchema);
    expect((await getWorkspaceProfile(OWNER, wiki.id)).scenario).toBe("research");
    expect(await snapshot()).toEqual(before);
  });

  it("renameWiki — wikis.json and purpose.md both survive", async () => {
    const wiki = await createWiki(OWNER, { name: "Field notes", scenario: "research" });
    const before = await snapshot();
    process.env.YOPEDIA_READONLY = "1";

    await expectRefusal(
      () => renameWiki(OWNER, wiki.id, "Renamed"),
      READ_ONLY_REFUSAL.wikiRename,
    );

    // `retitlePurpose` is FAIL-SOFT: a refusal raised by the putter inside it
    // would be warned about and swallowed, leaving a rewritten `wikis.json`
    // reporting success. The registry bytes below are what prove the gate runs
    // at the entry instead — this assertion is the one that goes red if the
    // gate is ever moved down to `putWikiArtifact` alone.
    expect(await snapshot()).toEqual(before);
  });

  it("saveWorkspaceProfile — the profile bytes are untouched", async () => {
    const wiki = await createWiki(OWNER, { name: "Field notes", scenario: "research" });
    const seeded = await getWorkspaceProfile(OWNER, wiki.id);
    const before = await snapshot();
    process.env.YOPEDIA_READONLY = "1";

    await expectRefusal(
      () =>
        saveWorkspaceProfile(OWNER, wiki.id, {
          scenario: "custom",
          purpose: "Rewritten on a read-only deployment.",
          keyQuestions: [],
          inScope: [],
          outOfScope: [],
          outputLanguage: "English",
          pageConventions: "",
        }),
      READ_ONLY_REFUSAL.wikiFileWrite,
    );

    expect(await getWorkspaceProfile(OWNER, wiki.id)).toEqual(seeded);
    expect(await snapshot()).toEqual(before);
  });

  it("all four are unchanged on a writable deployment — the control case", async () => {
    // `YOPEDIA_READONLY` is UNSET. Without this, every "unchanged" assertion
    // above would also pass against a lifecycle writer that simply stopped
    // working.
    const wiki = await createWiki(OWNER, { name: "Field notes", scenario: "research" });
    const renamed = await renameWiki(OWNER, wiki.id, "Field notes II");
    expect(renamed?.name).toBe("Field notes II");
    expect(await readWikiArtifact(OWNER, wiki.id, "purpose.md")).toContain(
      "# Field notes II",
    );

    const applied = await applyScenarioTemplate(OWNER, wiki.id, "business");
    expect(applied?.scenario).toBe("business");
    expect((await getWorkspaceProfile(OWNER, wiki.id)).scenario).toBe("business");

    const saved = await saveWorkspaceProfile(OWNER, wiki.id, {
      scenario: "custom",
      purpose: "Owner-authored.",
      keyQuestions: [],
      inScope: [],
      outOfScope: [],
      outputLanguage: "English",
      pageConventions: "",
    });
    expect(saved.purpose).toBe("Owner-authored.");
  });
});

/**
 * The gate PRECEDES the lock, pinned by source order (DW-266).
 *
 * The half of the claim the byte snapshots above cannot make. A gate moved
 * inside `withWikiLock`'s callback would refuse just as loudly and leave a
 * byte-identical tree — the compensations see to that — while a refused call
 * had queued behind every in-flight operation for the tenant and, in
 * `applyScenarioTemplate`, read three files it was never going to replace.
 *
 * Source order rather than behaviour because the property IS textual: there is
 * no observable that distinguishes "refused before the lock" from "refused
 * inside it" on a deployment where nothing else holds the key, and contriving
 * one (holding the lock from the test and timing the rejection) would pin the
 * scheduler rather than the gate.
 */
describe("the read-only gate precedes the wiki lock", () => {
  it("assertWritable comes before withWikiLock in each gated writer", async () => {
    const sources: Record<string, string> = {
      wikis: await fs.readFile(path.resolve(__dirname, "../wikis.ts"), "utf8"),
      "workspace-profile": await fs.readFile(
        path.resolve(__dirname, "../workspace-profile.ts"),
        "utf8",
      ),
    };

    for (const [module, fn] of [
      ["wikis", "createWiki"],
      ["wikis", "applyScenarioTemplate"],
      ["wikis", "renameWiki"],
      ["workspace-profile", "saveWorkspaceProfile"],
    ] as const) {
      const source = sources[module];
      const start = source.indexOf(`export async function ${fn}(`);
      expect(start, `${module}.ts: ${fn}`).toBeGreaterThan(-1);
      // The function's OWN body: bounded by the `}` in column 0 that closes it,
      // so the next declaration's text is never attributed to this one.
      const close = source.indexOf("\n}\n", start);
      expect(close, `${module}.ts: ${fn} close`).toBeGreaterThan(start);
      const body = source.slice(start, close);

      const gate = body.search(/assertWritable\(READ_ONLY_REFUSAL\.\w+\)/);
      const lock = body.indexOf("withWikiLock(owner");
      expect(gate, `${fn} calls assertWritable`).toBeGreaterThan(-1);
      expect(lock, `${fn} takes the wiki lock`).toBeGreaterThan(-1);
      expect(gate, `${fn} gates BEFORE taking the lock`).toBeLessThan(lock);
    }
  });
});

/**
 * `isReadOnlyError` matches on `name`, not `instanceof` — the rationale
 * `read-only.ts` states, pinned (DW-190).
 *
 * Without these four cases the implementation could be switched to
 * `err instanceof ReadOnlyError` and every other assertion in the repo would
 * stay green: each of them throws through the SAME module instance the route
 * imported. The failure the structural check exists for only appears where two
 * copies of the module exist — vitest's two projects, a bundler splitting
 * server and edge chunks, the stdio MCP entry compiled on its own — and there
 * the 403 silently becomes a 500 in production only.
 */
describe("isReadOnlyError classifies structurally, not by identity", () => {
  it("accepts a ReadOnlyError from a DIFFERENT copy of this module", () => {
    // Exactly what a duplicated module graph produces: same shape, same `name`,
    // different constructor. `instanceof` returns false here — this assertion is
    // the one that fails the moment the implementation switches.
    class ForeignReadOnlyError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "ReadOnlyError";
      }
    }
    const foreign = new ForeignReadOnlyError(READ_ONLY_REFUSAL.pageWrite);
    expect(foreign instanceof ReadOnlyError).toBe(false);
    expect(isReadOnlyError(foreign)).toBe(true);
  });

  it("accepts the real one", () => {
    expect(isReadOnlyError(new ReadOnlyError(READ_ONLY_REFUSAL.pageDelete))).toBe(true);
  });

  it("rejects a plain Error, including one whose MESSAGE says read-only", () => {
    // Structural on `name`, never on the wording — a storage failure that
    // happens to mention the flag must not be answered as the owner's refusal.
    expect(isReadOnlyError(new Error("boom"))).toBe(false);
    expect(isReadOnlyError(new Error(READ_ONLY_REFUSAL.pageWrite))).toBe(false);
  });

  it("rejects non-Error values rather than throwing on them", () => {
    // A catch block receives whatever was thrown; `null` and a bare string are
    // both reachable, and either would crash a naive `err.name` read.
    expect(isReadOnlyError(null)).toBe(false);
    expect(isReadOnlyError(undefined)).toBe(false);
    expect(isReadOnlyError("ReadOnlyError")).toBe(false);
    expect(isReadOnlyError({ name: "ReadOnlyError" })).toBe(false);
  });
});

describe("the kernel writers are unchanged on a writable deployment", () => {
  it("writes, patches and deletes exactly as before — the control case", async () => {
    // `YOPEDIA_READONLY` is UNSET here (the ordinary deployment). Without this,
    // every "unchanged" assertion above would also pass against a writer that
    // simply stopped working.
    const beforeVersion = await readDataVersion();

    await seedPage("rw-kernel");
    const patched = await patchMetadata({
      slug: "rw-kernel",
      metadata: { confidence: 0.99 },
      author: OWNER,
      // The seed is a PRIVATE page, so the ACL below the new gate still needs a
      // principal — which is also what proves the gate did not swallow it.
      principal: { id: "u1", handle: OWNER },
    });
    expect(patched.updated).toBe(true);

    const deleted = await deleteWikiPage("rw-kernel", OWNER);
    expect(deleted.slug).toBe("rw-kernel");

    const wiki = await createWiki(OWNER, { name: "Field notes", scenario: "research" });
    const edited = "# Schema\n\n## Page conventions\n\nevery page names its source\n";
    await writeWikiArtifact(OWNER, wiki.id, "schema.md", edited);
    expect(await readWikiArtifact(OWNER, wiki.id, "schema.md")).toBe(edited);

    // And the counter DID move, which is what makes the byte-identical
    // assertions above evidence of the gate rather than of an inert fixture.
    expect(await readDataVersion()).toBeGreaterThan(beforeVersion);
  });
});
