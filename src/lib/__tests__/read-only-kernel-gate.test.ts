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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { ensureDirectories, serializeFrontmatter } from "../wiki";
import { deleteWikiPage, writeWikiPageWithSideEffects } from "../lifecycle";
import { patchMetadata } from "../patch-metadata";
import {
  applyScenarioTemplate,
  createWiki,
  deleteWiki,
  getWikiRegistry,
  readWikiArtifact,
  renameWiki,
  setCurrentWiki,
  sweepOrphanWikiDirectories,
  writeWikiArtifact,
} from "../wikis";
import {
  getWorkspaceProfile,
  putWorkspaceProfile,
  saveWorkspaceProfile,
} from "../workspace-profile";
import { withWikiLock } from "../wiki-lock";
import { logger } from "../logger";
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
 * The wiki lifecycle writers gated by DW-266 and DW-314: `createWiki`,
 * `applyScenarioTemplate`, `renameWiki`, `saveWorkspaceProfile`, `deleteWiki`,
 * `setCurrentWiki` and `sweepOrphanWikiDirectories`.
 *
 * IS `renameWiki` A KERNEL WRITER? The two files that could disagree now give
 * one answer. `read-only-door-coverage.test.ts` SCANS for these — DW-315
 * widened its `KERNEL_WRITERS` roll past the original four to include them, so
 * a future route importing one untreated fails there. What the DW-188 label
 * still marks off is narrower and unchanged: the four page/artifact writers
 * that answer `pageWrite`, `pageDelete`, `pageMetadata` and `artifactEdit`.
 * These carry sentences of their OWN instead.
 *
 * What they share with the four is the exposure: they are exported library
 * functions that write bytes, and a DIRECT LIBRARY CALLER (a CLI command, a
 * future MCP tool, a maintenance script) reaches them with no route in
 * front. Today the API routes are their only callers and every one of
 * those gates first, so what these cases pin is the direct call.
 *
 * THE FAMILY IS COMPLETE NOW, which this note used to say it was not. DW-266
 * left `deleteWiki`, `setCurrentWiki` and `sweepOrphanWikiDirectories` writing
 * `wikis.json` and deleting Wiki directories with no `assertWritable` at all —
 * a recorded gap, closed by DW-314 and covered by the three cases below. The
 * sweep mattered most: `POST /api/tasks/scan` reaches it on a CRON, so nobody
 * had to press anything for a read-only deployment to lose directories.
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

    // The re-template overwrites only the two canonical artifacts. The legacy
    // profile is retained as byte-for-byte migration evidence.
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

  it("setCurrentWiki — the pointer and every registry byte survive", async () => {
    // TWO wikis, because a switch is only observable against a registry that
    // has somewhere else to point.
    const first = await createWiki(OWNER, { name: "Field notes", scenario: "research" });
    const second = await createWiki(OWNER, { name: "Second", scenario: "business" });
    const before = await snapshot();
    const beforeVersion = await readDataVersion();
    process.env.YOPEDIA_READONLY = "1";

    // Switch AWAY from the one `createWiki` left current, so a gate that
    // silently no-opped would be indistinguishable from success.
    await expectRefusal(
      () => setCurrentWiki(OWNER, first.id),
      READ_ONLY_REFUSAL.wikiSwitch,
    );

    // `wikis.json` is the only TENANT file a switch writes, so the whole-tree
    // snapshot is exactly the right assertion — and `currentId` is named
    // separately because it is the field that decides which `schema.md` every
    // prompt in the app runs on.
    expect(await snapshot()).toEqual(before);
    // The switch also carries a `dataVersion` tail (DW-518), so "nothing moved"
    // is claimed here rather than left implied: `assertWritable` throws ahead of
    // the lock, which puts that tail out of reach on a refusal.
    expect(await readDataVersion()).toBe(beforeVersion);
    delete process.env.YOPEDIA_READONLY;
    expect((await getWikiRegistry(OWNER)).currentId).toBe(second.id);
  });

  it("deleteWiki — the entry stays, the directory stays, nothing is swallowed", async () => {
    // The DOOMED one first, because `createWiki` leaves the wiki it just made
    // current and `deleteWiki` refuses the CURRENT wiki with a
    // `ClientInputError` — a target chosen the other way round would make this
    // case pass on the wrong refusal entirely.
    const doomed = await createWiki(OWNER, { name: "Field notes", scenario: "research" });
    const current = await createWiki(OWNER, { name: "Second", scenario: "business" });
    expect((await getWikiRegistry(OWNER)).currentId).toBe(current.id);
    const before = await snapshot();
    process.env.YOPEDIA_READONLY = "1";

    await expectRefusal(
      () => deleteWiki(OWNER, doomed.id),
      READ_ONLY_REFUSAL.wikiDelete,
    );

    // THE assertion this case exists for. Both byte-removal steps inside
    // `deleteWiki` are fail-soft: a refusal raised inside the lock would be
    // caught by one of the two `logger.warn` handlers and never reach the
    // caller — after `writeRegistry` had already removed the entry. So a gate
    // moved down is not merely slower here, it is silently wrong, and this
    // snapshot plus the registry read below is what catches it.
    expect(await snapshot()).toEqual(before);
    delete process.env.YOPEDIA_READONLY;
    expect((await getWikiRegistry(OWNER)).wikis.map((w) => w.id).sort()).toEqual(
      [current.id, doomed.id].sort(),
    );
    expect(await readWikiArtifact(OWNER, doomed.id, "schema.md")).not.toBeNull();
  });

  it("sweepOrphanWikiDirectories — an orphan the cron would have reclaimed stays put", async () => {
    // A REAL orphan, made the way the sweep expects to find one: a directory
    // under `wikis/` that the registry does not name. Without it the case would
    // pass against a sweep that simply had nothing to do.
    await createWiki(OWNER, { name: "Field notes", scenario: "research" });
    const orphanDir = path.join(tmpDir, "tenants", OWNER, "wikis", "00000000-0000-4000-8000-0000000000ff");
    await fs.mkdir(orphanDir, { recursive: true });
    await fs.writeFile(path.join(orphanDir, "schema.md"), "# Orphaned Schema\n", "utf8");
    const before = await snapshot();
    process.env.YOPEDIA_READONLY = "1";

    await expectRefusal(
      () => sweepOrphanWikiDirectories(OWNER),
      READ_ONLY_REFUSAL.wikiDirectorySweep,
    );

    expect(await snapshot()).toEqual(before);
  });

  it("all seven are unchanged on a writable deployment — the control case", async () => {
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
    expect((await getWorkspaceProfile(OWNER, wiki.id)).scenario).toBe("research");
    expect(await readWikiArtifact(OWNER, wiki.id, "purpose.md")).toContain(
      "Scenario Template: Business",
    );

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

    // …and the three DW-314 additions, which the cases above only ever observe
    // REFUSING. Without this every "unchanged" assertion there would also pass
    // against a writer that simply stopped working.
    const second = await createWiki(OWNER, { name: "Second", scenario: "business" });
    expect((await setCurrentWiki(OWNER, second.id))?.id).toBe(second.id);
    // `wiki` is no longer current, so it is deletable.
    expect((await deleteWiki(OWNER, wiki.id))?.id).toBe(wiki.id);
    expect((await getWikiRegistry(OWNER)).wikis.map((w) => w.id)).toEqual([second.id]);
    // The delete already swept, so the standalone sweep has nothing left —
    // which is the answer it should give, not a throw.
    expect(await sweepOrphanWikiDirectories(OWNER)).toBe(0);
  });
});

/**
 * THE TWO UNLOCKED BYTE PUTTERS, reached with the entry gate already passed
 * (DW-317).
 *
 * `putWikiArtifact` (`wikis.ts`) and `putWorkspaceProfile`
 * (`workspace-profile.ts`) each open with
 * `assertWritable(READ_ONLY_REFUSAL.wikiFileWrite)` — the backstop their
 * docstrings describe, for a future caller inside `wikis.ts` or a direct
 * library caller already holding the lock that forgets to gate for itself.
 * Every case above reaches them through an entry point that refuses FIRST, so
 * deleting either line leaves the whole suite green and the backstop is pinned
 * by inspection only.
 *
 * So both cases below get PAST the entry gate before the flag is set, and both
 * assert BYTES rather than a rejection — `rejects.toThrow` would be satisfied
 * by whichever gate happened to fire, which is exactly the shadowing these two
 * cases exist to see through. Nothing is mocked: a stubbed `assertWritable`
 * would prove nothing about the real one.
 */
describe("the unlocked byte putters refuse with the entry gate already passed", () => {
  it("putWikiArtifact — a flag that flips mid-rename leaves purpose.md's heading", async () => {
    const wiki = await createWiki(OWNER, { name: "Original", scenario: "research" });
    expect(await readWikiArtifact(OWNER, wiki.id, "purpose.md")).toContain("# Original");
    const registryBefore = await getWikiRegistry(OWNER);

    // `retitlePurpose`'s catch swallows ANY error, so "the heading did not
    // move" is equally what a failed read or a broken storage adapter looks
    // like. The `logger.warn` it hands the swallowed error to is the only place
    // that error survives, so it is what tells "the gate refused" apart from
    // "something else broke" — the sibling case gets the same sharpness for
    // free by pinning the sentence through `expectRefusal`.
    //
    // SPIED, NOT STUBBED: `vi.spyOn` records the call and delegates to the real
    // logger, and nothing about the gate under test is replaced.
    const warn = vi.spyOn(logger, "warn");
    try {
      // Hold `wikis:<tenant>` from the test. `renameWiki` runs its own gate
      // SYNCHRONOUSLY — while the deployment is still writable — and then
      // queues on this lock, so the flag flips before its locked body ever
      // runs. That is the real mid-request flip the codebase already recognises
      // (DW-319), not a contrivance: `putWikiArtifact` is module-private on
      // purpose and there is no direct call to make.
      let pending!: ReturnType<typeof renameWiki>;
      await withWikiLock(OWNER, async () => {
        pending = renameWiki(OWNER, wiki.id, "Renamed");
        process.env.YOPEDIA_READONLY = "1";
      });

      // The rename RESOLVES. `retitlePurpose` is fail-soft by design, so the
      // `ReadOnlyError` the putter raises inside it is warned about and
      // swallowed — which is precisely why the heading, and not a rejection, is
      // the only observable this gate leaves on disk.
      const renamed = await pending;
      expect(renamed?.name).toBe("Renamed");
      // …and the registry write DID land, so the case is not passing against a
      // rename that never got past the lock at all.
      expect((await getWikiRegistry(OWNER)).wikis.map((w) => w.name)).toEqual([
        "Renamed",
      ]);
      expect(registryBefore.wikis.map((w) => w.name)).toEqual(["Original"]);

      // THE assertion this case exists for. Gate present => the seeded heading
      // stands. Gate deleted from `putWikiArtifact` => it reads `# Renamed`,
      // and nothing else in the repo would have said so.
      const purpose = await readWikiArtifact(OWNER, wiki.id, "purpose.md");
      expect(purpose).toContain("# Original");
      expect(purpose).not.toContain("# Renamed");

      // …and the heading stood because THE REFUSAL is what `retitlePurpose`
      // caught. `logger.warn(tag, msg, ...args)` puts the swallowed error at
      // index 2; exactly one such warning, carrying the putter's own sentence.
      const swallowed = warn.mock.calls.filter((call) => isReadOnlyError(call[2]));
      expect(
        swallowed.map((call) => (call[2] as Error).message),
        "the error retitlePurpose swallowed",
      ).toEqual([READ_ONLY_REFUSAL.wikiFileWrite]);
      expect(swallowed[0][0]).toBe("wikis");
    } finally {
      warn.mockRestore();
    }
  });

  it("putWorkspaceProfile — a direct call under a LIVE token is refused, bytes intact", async () => {
    const wiki = await createWiki(OWNER, { name: "Field notes", scenario: "research" });
    const seeded = await getWorkspaceProfile(OWNER, wiki.id);
    const before = await snapshot();
    process.env.YOPEDIA_READONLY = "1";

    // `saveWorkspaceProfile`'s gate is not in the way here — this is the shape a
    // direct library caller inside the lock takes, and the only one where the
    // putter's OWN gate is what answers. The token is minted by `withWikiLock`,
    // the one sanctioned spelling, so `assertWikiLockHeld` passes and cannot be
    // the gate being observed; `expectRefusal` pins the sentence, not just the
    // fact of a throw, for the same reason.
    await withWikiLock(OWNER, async (held) => {
      await expectRefusal(
        () =>
          putWorkspaceProfile(held, OWNER, wiki.id, {
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
    });

    expect(await getWorkspaceProfile(OWNER, wiki.id)).toEqual(seeded);
    expect(await snapshot()).toEqual(before);
  });

  it("both putters write on a writable deployment — the control case", async () => {
    // `YOPEDIA_READONLY` is UNSET, and the two calls take exactly the shapes
    // above. Without this, both "unchanged" assertions would also pass against
    // a putter that had simply stopped writing — or against a mid-rename hold
    // that never let the locked body run.
    const wiki = await createWiki(OWNER, { name: "Original", scenario: "research" });

    let pending!: ReturnType<typeof renameWiki>;
    await withWikiLock(OWNER, async () => {
      pending = renameWiki(OWNER, wiki.id, "Renamed");
    });
    expect((await pending)?.name).toBe("Renamed");
    // The same read the first case expects to be UNCHANGED — retitled here.
    expect(await readWikiArtifact(OWNER, wiki.id, "purpose.md")).toContain("# Renamed");

    const written = await withWikiLock(OWNER, (held) =>
      putWorkspaceProfile(held, OWNER, wiki.id, {
        scenario: "custom",
        purpose: "Owner-authored.",
        keyQuestions: [],
        inScope: [],
        outOfScope: [],
        outputLanguage: "English",
        pageConventions: "",
      }),
    );
    expect(written.purpose).toBe("Owner-authored.");
    expect((await getWorkspaceProfile(OWNER, wiki.id)).purpose).toBe("Owner-authored.");
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
      "workspace-profile-backfill": await fs.readFile(
        path.resolve(__dirname, "../workspace-profile-backfill.ts"),
        "utf8",
      ),
    };

    for (const [module, fn] of [
      ["wikis", "createWiki"],
      ["wikis", "applyScenarioTemplate"],
      ["wikis", "renameWiki"],
      // DW-314’s three. `deleteWiki` is the one the ordering is load-bearing
      // for: both of its byte-removal steps are fail-soft, so a gate inside the
      // lock would be logged and swallowed after the registry was rewritten.
      ["wikis", "deleteWiki"],
      ["wikis", "setCurrentWiki"],
      ["wikis", "sweepOrphanWikiDirectories"],
      ["workspace-profile", "saveWorkspaceProfile"],
      // The DW-137 backfill: the one gated writer whose caller is a SCAN rather
      // than an owner, so it catches the refusal and answers 0 instead of
      // propagating it — but the gate still has to come first, or a read-only
      // deployment queues behind every in-flight operation for the tenant
      // before deciding it was never going to write.
      ["workspace-profile-backfill", "backfillLegacyWorkspaceProfiles"],
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
