/**
 * Story 1.2 — the Wiki entity, its registry, and template seeding.
 *
 * Everything runs against a real temp-`DATA_DIR` filesystem provider (the
 * `workspace-profile.test.ts` recipe) so the assertions are about bytes on
 * disk, not about mocks: which files exist, that two templates genuinely
 * differ, and — the load-bearing one — that applying a template leaves
 * `tenants/<t>/wiki/**` and `tenants/<t>/raw/**` byte-identical.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { DATA_VERSION_KEY, readDataVersion } from "../data-version";
import { ClientInputError } from "../errors";
import { _resetLocks, withFileLock } from "../lock";
import { logger } from "../logger";
import { _resetStorage, getStorage } from "../storage";
import { tenantForOwner } from "../wiki";
import { wikiDirPath, wikiLockKey } from "../wiki-paths";
import { buildWorkspaceGuidance } from "../workspace-guidance";
import { getWorkspaceProfile, saveWorkspaceProfile } from "../workspace-profile";
import { WORKSPACE_SCENARIO_TEMPLATES } from "../workspace-profile-schema";
import {
  MAX_WIKIS,
  ORPHAN_SWEEP_CANDIDATE_CAP,
  ORPHAN_SWEEP_GRACE_MS,
  applyScenarioTemplate,
  createWiki,
  deleteWiki,
  getCurrentWiki,
  getWikiRegistry,
  listWikis,
  parseCreateWikiInput,
  parseRenameWikiInput,
  parseScenarioInput,
  readWikiArtifact,
  renameWiki,
  setCurrentWiki,
  sweepOrphanWikiDirectories,
  wikiArtifactPath,
  wikiRegistryPath,
  type WikiRecord,
} from "../wikis";

const OWNER = "alice";
const TENANT = tenantForOwner(OWNER);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let tmpDir: string;
let originalDataDir: string | undefined;

function abs(...segments: string[]): string {
  return path.join(tmpDir, ...segments);
}

/** The raw bytes of one wiki's profile — "byte-identical" needs the file, not the parse. */
function profileBytes(wikiId: string): Promise<string> {
  return fs.readFile(
    abs("tenants", TENANT, "wikis", wikiId, "workspace-profile.json"),
    "utf8",
  );
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wikis-"));
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

describe("create a wiki from a scenario template", () => {
  it("seeds purpose.md, schema.md, and the workspace profile, and becomes current", async () => {
    expect(await listWikis(OWNER)).toEqual([]);
    expect(await getCurrentWiki(OWNER)).toBeNull();

    const wiki = await createWiki(OWNER, { name: "Q3 planning", scenario: "business" });

    // A real UUID shape: `/^[0-9a-f-]{36}$/` also matches thirty-six dashes.
    expect(wiki.id).toMatch(UUID_RE);
    expect(wiki.name).toBe("Q3 planning");
    expect(wiki.scenario).toBe("business");

    const registry = await getWikiRegistry(OWNER);
    expect(registry.wikis.map((item) => item.id)).toEqual([wiki.id]);
    expect(registry.currentId).toBe(wiki.id);
    expect((await getCurrentWiki(OWNER))?.id).toBe(wiki.id);

    const purpose = await readWikiArtifact(OWNER, wiki.id, "purpose.md");
    const schema = await readWikiArtifact(OWNER, wiki.id, "schema.md");
    expect(purpose).toContain("# Q3 planning");
    expect(schema).toContain("## Page conventions");

    // The seeded template reaches the prompt path, not just the disk — and it
    // is stored in THIS wiki's directory, not tenant-globally.
    const profile = await getWorkspaceProfile(OWNER, wiki.id);
    expect(profile.scenario).toBe("business");
    expect(profile.pageConventions).toContain("explicit owners");
    await expect(
      fs.stat(abs("tenants", TENANT, "wikis", wiki.id, "workspace-profile.json")),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(abs("tenants", TENANT, "workspace-profile.json")),
    ).rejects.toThrow();
  });

  it("writes the artifacts under wikis/, never under the reconciled wiki/ tree", async () => {
    const wiki = await createWiki(OWNER, { name: "Q3", scenario: "general" });
    await expect(
      fs.stat(abs("tenants", TENANT, "wikis", wiki.id, "purpose.md")),
    ).resolves.toBeTruthy();
    // reconcileSilos() deletes any .md under tenants/<t>/wiki that is not in
    // the page index — a seeded file there would silently disappear.
    await expect(fs.stat(abs("tenants", TENANT, "wiki"))).rejects.toThrow();
    await expect(fs.stat(abs("tenants", TENANT, "raw"))).rejects.toThrow();
  });

  it("produces genuinely different contents per template", async () => {
    const business = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const reading = await createWiki(OWNER, { name: "Shelf", scenario: "reading" });

    const businessPurpose = await readWikiArtifact(OWNER, business.id, "purpose.md");
    const readingPurpose = await readWikiArtifact(OWNER, reading.id, "purpose.md");
    const businessSchema = await readWikiArtifact(OWNER, business.id, "schema.md");
    const readingSchema = await readWikiArtifact(OWNER, reading.id, "schema.md");

    expect(businessPurpose).toBeTruthy();
    expect(readingPurpose).toBeTruthy();
    expect(businessPurpose).not.toEqual(readingPurpose);
    expect(businessSchema).not.toEqual(readingSchema);
  });

  it("keeps each wiki isolated per tenant", async () => {
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    expect(await listWikis("bob")).toEqual([]);
    expect(await getCurrentWiki("bob")).toBeNull();
  });

  it("embeds the engine's own page conventions alongside the scenario's", async () => {
    // Activating a wiki must ADD scenario direction, never subtract the
    // engine's structural contract — the seeded schema.md is what the ingest,
    // chat and lint prompts execute from that moment on.
    const wiki = await createWiki(OWNER, { name: "Shelf", scenario: "reading" });
    const schema = (await readWikiArtifact(OWNER, wiki.id, "schema.md")) ?? "";

    expect(schema).toContain("## Page conventions");
    // Engine rules, verbatim from the repo-root SCHEMA.md.
    expect(schema).toContain("/^[a-z0-9][a-z0-9-]*$/");
    expect(schema).toContain("[Title](other-slug.md)");
    expect(schema).toContain("Every page starts with an H1 title");
    expect(schema).toContain("`index.md`");
    // …and the scenario's own conventions, layered after them.
    expect(schema).toContain("### Scenario conventions — Reading");
    expect(schema).toContain("Preserve sequence when it matters");

    // The engine block uses ### sub-headings, which must not terminate the
    // section the loader extracts.
    expect(schema.indexOf("Work-wiki frontmatter fields")).toBeLessThan(
      schema.indexOf("## Key questions"),
    );
  });

  it("caps the registry with an error instead of silently dropping the oldest", async () => {
    // Seed the registry straight to the cap rather than creating 100 wikis.
    const now = new Date().toISOString();
    const wikis: WikiRecord[] = Array.from({ length: MAX_WIKIS }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      name: `Wiki ${index}`,
      scenario: "general",
      createdAt: now,
      updatedAt: now,
    }));
    await fs.mkdir(abs("tenants", TENANT), { recursive: true });
    await fs.writeFile(
      abs(wikiRegistryPath(OWNER)),
      JSON.stringify({ version: 1, wikis, currentId: wikis[0].id }),
    );

    await expect(createWiki(OWNER, { name: "One too many", scenario: "general" }))
      .rejects.toThrow(ClientInputError);

    const registry = await getWikiRegistry(OWNER);
    expect(registry.wikis).toHaveLength(MAX_WIKIS);
    // The oldest record survives — a silent slice would have orphaned its
    // wikis/<id>/ artifacts on disk with no error.
    expect(registry.wikis[0].id).toBe(wikis[0].id);
  });

  it("drops registry entries missing a usable name rather than rendering undefined", async () => {
    const now = new Date().toISOString();
    await fs.mkdir(abs("tenants", TENANT), { recursive: true });
    await fs.writeFile(
      abs(wikiRegistryPath(OWNER)),
      JSON.stringify({
        version: 1,
        currentId: "00000000-0000-4000-8000-000000000001",
        wikis: [
          { id: "00000000-0000-4000-8000-000000000001", scenario: "general", createdAt: now, updatedAt: now },
          { id: "00000000-0000-4000-8000-000000000002", name: "", scenario: "general", createdAt: now, updatedAt: now },
          { id: "00000000-0000-4000-8000-000000000003", name: "Real", scenario: "general", createdAt: now, updatedAt: now },
        ],
      }),
    );
    const registry = await getWikiRegistry(OWNER);
    expect(registry.wikis.map((wiki) => wiki.name)).toEqual(["Real"]);
    expect(registry.currentId).toBe("00000000-0000-4000-8000-000000000003");
  });

  it("drops entries whose id could never become a storage path", async () => {
    // An id that `wikiArtifactPath` rejects must not survive normalization:
    // it would list in the switcher and then 400 on every operation, and
    // `currentId` could point at it so `loadPageConventions()` silently falls
    // back to the root Schema with no wiki able to explain why.
    const now = new Date().toISOString();
    const good = "00000000-0000-4000-8000-000000000009";
    await fs.mkdir(abs("tenants", TENANT), { recursive: true });
    await fs.writeFile(
      abs(wikiRegistryPath(OWNER)),
      JSON.stringify({
        version: 1,
        currentId: "../../etc/passwd",
        wikis: [
          { id: "../../etc/passwd", name: "Traversal", scenario: "general", createdAt: now, updatedAt: now },
          { id: "not-a-uuid", name: "Shapeless", scenario: "general", createdAt: now, updatedAt: now },
          // Timestamps are part of WikiRecord; an entry without them renders
          // `undefined` wherever a caller shows when a wiki was made.
          { id: "00000000-0000-4000-8000-000000000008", name: "Undated", scenario: "general" },
          { id: good, name: "Real", scenario: "general", createdAt: now, updatedAt: now },
        ],
      }),
    );
    const registry = await getWikiRegistry(OWNER);
    expect(registry.wikis.map((wiki) => wiki.id)).toEqual([good]);
    expect(registry.currentId).toBe(good);
  });
});

describe("wiki ids never reach a storage path unvalidated", () => {
  it("rejects a traversal-shaped id", async () => {
    for (const id of ["../../etc/passwd", "..", "a/b", "not-a-uuid", ""]) {
      expect(() => wikiArtifactPath(OWNER, id, "purpose.md")).toThrow(ClientInputError);
      await expect(readWikiArtifact(OWNER, id, "schema.md")).rejects.toThrow(
        ClientInputError,
      );
    }
  });

  it("answers 'not found' for a traversal-shaped id on the registry lookups", async () => {
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    expect(await applyScenarioTemplate(OWNER, "../../etc/passwd", "reading")).toBeNull();
    expect(await setCurrentWiki(OWNER, "../../etc/passwd")).toBeNull();
    expect((await getCurrentWiki(OWNER))?.scenario).toBe("business");
  });
});

describe("input validation", () => {
  it("rejects the custom scenario, unknown scenarios, and a missing one", () => {
    for (const scenario of ["custom", "blank", "", undefined, 5]) {
      expect(() => parseCreateWikiInput({ name: "x", scenario })).toThrow(ClientInputError);
      expect(() => parseScenarioInput({ scenario })).toThrow(ClientInputError);
    }
  });

  it("accepts exactly the five creatable scenarios", () => {
    for (const scenario of ["research", "reading", "personal-growth", "business", "general"]) {
      expect(parseScenarioInput({ scenario })).toBe(scenario);
    }
  });

  it("rejects a blank or oversized name", () => {
    expect(() => parseCreateWikiInput({ name: "   ", scenario: "general" })).toThrow(
      ClientInputError,
    );
    expect(() => parseCreateWikiInput({ name: 42, scenario: "general" })).toThrow(
      ClientInputError,
    );
    expect(() =>
      parseCreateWikiInput({ name: "x".repeat(81), scenario: "general" }),
    ).toThrow(ClientInputError);
    expect(parseCreateWikiInput({ name: "  Q3   planning ", scenario: "general" })).toEqual({
      name: "Q3 planning",
      scenario: "general",
    });
  });

  it("writes nothing when create is rejected", async () => {
    // Seeded, not zero: a rejected input must leave a counter that was ALREADY
    // counting exactly where it was, and against 0 this row would also pass
    // with `readDataVersion` failing open.
    await getStorage().putIndex(DATA_VERSION_KEY, 7);
    const before = await readDataVersion();
    expect(before).toBe(7);
    await expect(
      createWiki(OWNER, { name: "   ", scenario: "general" } as never),
    ).rejects.toThrow(ClientInputError);
    await expect(
      createWiki(OWNER, { name: "x", scenario: "custom" } as never),
    ).rejects.toThrow(ClientInputError);

    expect(await listWikis(OWNER)).toEqual([]);
    await expect(fs.stat(abs("tenants", TENANT, "wikis.json"))).rejects.toThrow();
    await expect(fs.stat(abs("tenants", TENANT, "wikis"))).rejects.toThrow();
    // "Writes nothing" includes the refresh signal: a rejected input never
    // reaches the lock, so there is nothing for an open tab to refresh to.
    expect(await readDataVersion()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// The refresh signal (DW-49, DW-57)
// ---------------------------------------------------------------------------

/**
 * Seeding writes `purpose.md` and `schema.md` through the tail-less
 * `putWikiArtifact`, so for a while neither create nor re-template moved
 * `dataVersion` — and a re-template moves NOTHING else a Preview is keyed on
 * (its fetch effect watches `[selection, dataVersion, editing]`, and a re-apply
 * changes no selection and no mode). A Preview READING either artifact across a
 * confirm-gated re-apply therefore kept the pre-template bytes until the owner
 * reselected the row or reloaded. A Preview mid-EDIT is a different case and
 * not this tail's job: `previewFetchPlan` defers the read while `editing` so
 * the draft survives, and the If-Match precondition (DW-38) is what refuses the
 * stale save.
 *
 * The tail lives at the two CALLERS, outside `wikis:<tenant>`, because
 * `bumpDataVersion` takes `DATA_VERSION_LOCK` and `withFileLock` is not
 * reentrant. These rows are the only guard against a refactor moving it back
 * inside the lock or dropping it: every one of them would still pass with the
 * bump deleted if it only asserted on bytes.
 *
 * DELETE (DW-382) IS IN HERE FOR A DIFFERENT REASON, and the rows say so: it
 * moves no bytes a Preview renders at all. A Preview resolves both artifacts
 * through `currentId` read server-side at fetch time and the current Wiki is
 * undeletable, and the Files tree is built from `currentId` alone — so nothing a
 * delete takes can be under a second client. What goes stale there is the WIKI
 * LIST `page.tsx` hands down and `WikiSwitcher` renders: that client keeps
 * offering a Wiki that is gone, and acting on it 404s. A delete moves no
 * `currentWikiId` either, so the counter is the only thing that can tell it.
 *
 * EVERY ROW STARTS FROM A NON-ZERO COUNTER. `beforeEach` mints a fresh
 * `DATA_DIR`, so an unseeded counter reads `0` — and `0` is also what
 * `readDataVersion` answers when the store is unreadable. A `before` of `0`
 * would let "bumps once" pass against an implementation that just STORES `1`,
 * and let the "does not bump" rows pass against a counter that is failing open.
 */
describe("create, re-template, rename and delete move the refresh signal (DW-49, DW-57, DW-209, DW-382)", () => {
  it("bumps exactly once per create, not once per seeded file", async () => {
    // The FIRST create is what lifts the counter off zero, so the second one's
    // `before + 1` is arithmetic on the stored value rather than a literal an
    // implementation that simply stores `1` would also satisfy.
    await createWiki(OWNER, { name: "First", scenario: "business" });
    const before = await readDataVersion();
    expect(before).toBe(1);

    await createWiki(OWNER, { name: "Q3 planning", scenario: "business" });

    // Exactly one: the seed writes three files and the registry, but the
    // signal is monotonic and a consumer only needs "it moved forward".
    expect(await readDataVersion()).toBe(before + 1);
  });

  it("bumps exactly once per re-template, which is the only signal a re-apply sends", async () => {
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const before = await readDataVersion();
    expect(before).toBeGreaterThan(0); // the create's own bump

    expect(await applyScenarioTemplate(OWNER, wiki.id, "reading")).not.toBeNull();

    expect(await readDataVersion()).toBe(before + 1);
    // …and the bytes the bump is telling an open Preview to refetch really did
    // change, so the signal is not moving on its own.
    expect(await readWikiArtifact(OWNER, wiki.id, "schema.md")).toContain(
      "### Scenario conventions — Reading",
    );
  });

  it("does not bump for an unknown wiki id", async () => {
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const before = await readDataVersion();
    expect(before).toBeGreaterThan(0); // so "unchanged" is not "still zero"

    expect(await applyScenarioTemplate(OWNER, "no-such-wiki", "reading")).toBeNull();

    // The locked body returns before its first write, so there is nothing new
    // to see and a refresh would be pure churn.
    expect(await readDataVersion()).toBe(before);
  });

  it("does not bump when a re-template is rejected outright", async () => {
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const before = await readDataVersion();
    expect(before).toBeGreaterThan(0);

    await expect(
      applyScenarioTemplate(OWNER, wiki.id, "custom" as never),
    ).rejects.toThrow(ClientInputError);

    expect(await readDataVersion()).toBe(before);
  });

  it("does not bump when create is capped", async () => {
    const now = new Date().toISOString();
    const wikis: WikiRecord[] = Array.from({ length: MAX_WIKIS }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      name: `Wiki ${index}`,
      scenario: "general",
      createdAt: now,
      updatedAt: now,
    }));
    await fs.mkdir(abs("tenants", TENANT), { recursive: true });
    await fs.writeFile(
      abs(wikiRegistryPath(OWNER)),
      JSON.stringify({ version: 1, wikis, currentId: wikis[0].id }),
    );
    // The registry was written straight to disk, so nothing has bumped yet.
    // Seed the counter by hand: against a `before` of 0 this row would also
    // pass with `readDataVersion` failing open.
    await getStorage().putIndex(DATA_VERSION_KEY, 7);
    const before = await readDataVersion();
    expect(before).toBe(7);

    await expect(
      createWiki(OWNER, { name: "One too many", scenario: "general" }),
    ).rejects.toThrow(ClientInputError);

    expect(await readDataVersion()).toBe(before);
  });

  it("bumps exactly once per rename, which is the only signal a rename sends", async () => {
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const before = await readDataVersion();
    expect(before).toBeGreaterThan(0); // the create's own bump

    expect((await renameWiki(OWNER, wiki.id, "Q4 plan"))?.name).toBe("Q4 plan");

    // Once, not once per write: the registry and `purpose.md` both moved, and
    // the signal is monotonic — a consumer only needs "it moved forward".
    expect(await readDataVersion()).toBe(before + 1);
    // …and the bytes the bump is telling an open Preview to refetch really did
    // change. A rename moves no `currentWikiId`, so the Workbench's
    // selection-reset effect never fires and this counter is the ONLY thing
    // that can un-stale a Preview left open on `purpose.md` (DW-209).
    expect(await readWikiArtifact(OWNER, wiki.id, "purpose.md")).toContain("# Q4 plan");
  });

  it("does not bump for a rename of an unknown wiki id", async () => {
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const before = await readDataVersion();
    expect(before).toBeGreaterThan(0); // so "unchanged" is not "still zero"

    expect(
      await renameWiki(OWNER, "00000000-0000-4000-8000-000000000000", "New name"),
    ).toBeNull();

    // The locked body returns before its first write, so there is nothing new
    // to see and a refresh would be pure churn.
    expect(await readDataVersion()).toBe(before);
  });

  it("does not bump when a rename is rejected outright", async () => {
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const before = await readDataVersion();
    expect(before).toBeGreaterThan(0);

    // `parseWikiName` throws BEFORE the lock, so not a byte was written.
    for (const name of ["   ", 42 as never, "x".repeat(81)]) {
      await expect(renameWiki(OWNER, wiki.id, name)).rejects.toThrow(ClientInputError);
    }

    expect(await readDataVersion()).toBe(before);
  });

  it("bumps a rename whose purpose.md retitle failed", async () => {
    // The registry name has moved — and that name is what the switcher and the
    // Workbench heading render — so there IS something new to refetch even
    // though the heading is stale. `retitlePurpose` is fail-soft, so skipping
    // the bump here would drop the signal on exactly the path where the two
    // representations have diverged.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const before = await readDataVersion();
    expect(before).toBeGreaterThan(0);

    const storage = getStorage();
    const write = storage.writeFile.bind(storage);
    const spy = vi
      .spyOn(storage, "writeFile")
      .mockImplementation(async (target: string, content: string) =>
        target.endsWith("purpose.md")
          ? Promise.reject(new Error("the artifact store is unavailable"))
          : write(target, content),
      );
    try {
      expect((await renameWiki(OWNER, wiki.id, "Q4 plan"))?.name).toBe("Q4 plan");
    } finally {
      spy.mockRestore();
    }

    expect(await readDataVersion()).toBe(before + 1);
    // The heading really is stale — so the bump above is not being earned by a
    // retitle that quietly succeeded.
    expect(await readWikiArtifact(OWNER, wiki.id, "purpose.md")).toContain("# Ops");
  });

  it("bumps exactly once per delete, not once per removed directory", async () => {
    const keep = await createWiki(OWNER, { name: "Keep", scenario: "business" });
    const drop = await createWiki(OWNER, { name: "Drop", scenario: "reading" });
    // `drop` was created last, so it is current — move the pointer back.
    await setCurrentWiki(OWNER, keep.id);
    // TWO aged orphans, so the inline sweep really has directories to reclaim
    // and "once" is arithmetic rather than an artefact of a single removal.
    const orphans = [
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "11111111-2222-4333-8444-555555555555",
    ];
    for (const id of orphans) await ageDirectory(await plantOrphan(id));
    const before = await readDataVersion();
    expect(before).toBeGreaterThan(0); // the two creates' own bumps

    expect((await deleteWiki(OWNER, drop.id))?.id).toBe(drop.id);

    // Once, not once per removed directory: three directories went — the
    // target's and both orphans' — and the signal is monotonic, so a consumer
    // only needs "it moved forward".
    expect(await readDataVersion()).toBe(before + 1);
    // …and the bump is earned. The DELETE moves no `currentWikiId` — it refuses
    // the current Wiki rather than re-pointing it — so the Workbench's
    // selection-reset effect never fires, and this counter is the ONLY thing
    // that can tell a SECOND open client that the Wiki list it is still
    // offering names a Wiki that is gone (DW-382).
    expect(await exists(wikiDir(drop.id))).toBe(false);
    for (const id of orphans) expect(await exists(wikiDir(id))).toBe(false);
  });

  it("does not bump for a delete of an unknown or traversal-shaped id", async () => {
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const before = await readDataVersion();
    expect(before).toBeGreaterThan(0); // so "unchanged" is not "still zero"

    for (const id of ["00000000-0000-4000-8000-000000000000", "../../etc/passwd"]) {
      expect(await deleteWiki(OWNER, id)).toBeNull();
    }

    // The locked body returns before its first write, so no list anywhere has
    // changed and a refresh would be pure churn.
    expect(await readDataVersion()).toBe(before);
  });

  it("does not bump when the current-wiki refusal throws", async () => {
    await createWiki(OWNER, { name: "One", scenario: "business" });
    const second = await createWiki(OWNER, { name: "Two", scenario: "reading" });
    const before = await readDataVersion();
    expect(before).toBeGreaterThan(0);

    // The refusal throws from inside the locked body, before a byte is written,
    // and propagates straight past the tail.
    await expect(deleteWiki(OWNER, second.id)).rejects.toThrow(ClientInputError);

    // The counter ONLY: that nothing else moved — entry, directory, pointer —
    // is already pinned in `describe("deleting a wiki")`.
    expect(await readDataVersion()).toBe(before);
  });

  it("bumps a delete whose own directory removal failed", async () => {
    // The registry entry is gone, so the Wiki has disappeared from every read
    // in the app and the list a second client is offering is wrong whether or
    // not the bytes went with it. `deleteDirectory` is fail-soft, so skipping
    // the bump here would drop the signal on exactly the path where the two
    // representations have diverged.
    const keep = await createWiki(OWNER, { name: "Keep", scenario: "business" });
    const drop = await createWiki(OWNER, { name: "Drop", scenario: "reading" });
    await setCurrentWiki(OWNER, keep.id);
    const before = await readDataVersion();
    expect(before).toBeGreaterThan(0);

    const removal = vi
      .spyOn(getStorage(), "deleteDirectory")
      .mockRejectedValue(new Error("the directory is busy"));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    let warned: unknown[][] = [];
    try {
      expect((await deleteWiki(OWNER, drop.id))?.id).toBe(drop.id);
      // Captured BEFORE the restore — `mockRestore` clears `mock.calls`.
      warned = warn.mock.calls.map((call) => [...call]);
    } finally {
      warn.mockRestore();
      removal.mockRestore();
    }

    expect(await readDataVersion()).toBe(before + 1);
    // The bytes really ARE still on disk — so the bump above is not being
    // earned by a removal that quietly succeeded.
    expect(await exists(wikiDir(drop.id))).toBe(true);
    // …and the handler whose whole contract is "warn and swallow" really warned.
    expect(
      warned.some(
        ([scope, message]) =>
          scope === "wikis" &&
          String(message).includes(
            `removing the directory of deleted wiki "${drop.id}" failed`,
          ),
      ),
    ).toBe(true);
  });

  it("bumps a delete whose inline orphan sweep failed", async () => {
    const keep = await createWiki(OWNER, { name: "Keep", scenario: "business" });
    const drop = await createWiki(OWNER, { name: "Drop", scenario: "reading" });
    await setCurrentWiki(OWNER, keep.id);
    // Aged, so a sweep that RAN would have reclaimed it — which is what makes
    // "still there" below evidence that the sweep really failed rather than an
    // assertion that would hold on the happy path too.
    const orphan = await plantOrphan("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    await ageDirectory(orphan);
    const before = await readDataVersion();
    expect(before).toBeGreaterThan(0);

    // `sweepOrphans`' FIRST storage call, so the sweep throws while the Wiki's
    // own `deleteDirectory` still succeeds. A blanket `deleteDirectory` mock
    // would conflate the two failure modes.
    const listing = vi
      .spyOn(getStorage(), "listFiles")
      .mockRejectedValue(new Error("the object store is unavailable"));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    let warned: unknown[][] = [];
    try {
      expect((await deleteWiki(OWNER, drop.id))?.id).toBe(drop.id);
      warned = warn.mock.calls.map((call) => [...call]);
    } finally {
      warn.mockRestore();
      listing.mockRestore();
    }

    expect(await readDataVersion()).toBe(before + 1);
    // The target's own directory went; the aged orphan did NOT — only true when
    // the sweep failed, and what keeps this row from silently becoming a
    // duplicate of the happy-path one the day the `listFiles` seam moves.
    expect(await exists(wikiDir(drop.id))).toBe(false);
    expect(await exists(orphan)).toBe(true);
    expect(
      warned.some(
        ([scope, message]) =>
          scope === "wikis" &&
          String(message).includes("sweeping orphaned wiki directories failed"),
      ),
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // The counter store is down
  // -------------------------------------------------------------------------

  /**
   * WHOSE warning to assert on, and why it is not the callers'.
   *
   * `bumpDataVersion` wraps its ENTIRE body, so a rejecting `putIndex` makes it
   * answer `0` rather than throw — which means the `try/catch` in `createWiki`,
   * `applyScenarioTemplate`, `renameWiki` and `deleteWiki` never runs and their
   * "the refresh signal did not move after …" wording never reaches the log. Those wrappers are
   * redundant defence, kept deliberately so the tail reads identically at all
   * five call sites (`writeWikiArtifact` and `deleteWiki` included) and stays
   * correct if `bumpDataVersion` ever stops swallowing; they are unreachable
   * today.
   *
   * So these rows assert on `data-version`'s own warn. Asserting on the
   * callers' sentence instead would be a test that passes with their `catch`
   * deleted AND passes with it kept — it would pin nothing either way.
   */
  const BUMP_FAILED_WARN = "bump failed; the signal did not move";

  it("still resolves a create when the counter store rejects putIndex", async () => {
    // An existing wiki puts the counter at a non-zero value, so "did not move"
    // below is an observation rather than a fresh store's 0.
    await createWiki(OWNER, { name: "First", scenario: "business" });
    const before = await readDataVersion();
    expect(before).toBeGreaterThan(0);

    const putIndex = vi
      .spyOn(getStorage(), "putIndex")
      .mockRejectedValue(new Error("kv is gone"));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    let wiki: WikiRecord;
    let warned: unknown[][] = [];
    try {
      wiki = await createWiki(OWNER, { name: "Q3", scenario: "business" });
      // Captured BEFORE the restore — `mockRestore` clears `mock.calls`.
      warned = warn.mock.calls.map((call) => [...call]);
    } finally {
      warn.mockRestore();
      putIndex.mockRestore();
    }

    // The create resolved and every byte it owed is on disk…
    expect(wiki.name).toBe("Q3");
    expect((await listWikis(OWNER)).map((item) => item.name).sort()).toEqual([
      "First",
      "Q3",
    ]);
    expect(await readWikiArtifact(OWNER, wiki.id, "schema.md")).toContain(
      "## Page conventions",
    );
    // …while the signal genuinely did NOT move — read from the store, not
    // inferred from the mock having been called.
    expect(await readDataVersion()).toBe(before);
    expect(
      warned.some(
        ([scope, message]) =>
          scope === "data-version" && String(message).includes(BUMP_FAILED_WARN),
      ),
    ).toBe(true);
  });

  it("still resolves a re-template when the counter store rejects putIndex", async () => {
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const before = await readDataVersion();
    expect(before).toBeGreaterThan(0);

    const putIndex = vi
      .spyOn(getStorage(), "putIndex")
      .mockRejectedValue(new Error("kv is gone"));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    let applied: WikiRecord | null;
    let warned: unknown[][] = [];
    try {
      applied = await applyScenarioTemplate(OWNER, wiki.id, "reading");
      warned = warn.mock.calls.map((call) => [...call]);
    } finally {
      warn.mockRestore();
      putIndex.mockRestore();
    }

    expect(applied?.scenario).toBe("reading");
    expect(await readWikiArtifact(OWNER, wiki.id, "schema.md")).toContain(
      "### Scenario conventions — Reading",
    );
    expect(await readDataVersion()).toBe(before);
    expect(
      warned.some(
        ([scope, message]) =>
          scope === "data-version" && String(message).includes(BUMP_FAILED_WARN),
      ),
    ).toBe(true);
  });

  it("still resolves a rename when the counter store rejects putIndex", async () => {
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const before = await readDataVersion();
    expect(before).toBeGreaterThan(0);

    const putIndex = vi
      .spyOn(getStorage(), "putIndex")
      .mockRejectedValue(new Error("kv is gone"));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    let renamed: WikiRecord | null;
    let warned: unknown[][] = [];
    try {
      renamed = await renameWiki(OWNER, wiki.id, "Q4 plan");
      warned = warn.mock.calls.map((call) => [...call]);
    } finally {
      warn.mockRestore();
      putIndex.mockRestore();
    }

    // The rename resolved and both halves of it landed…
    expect(renamed?.name).toBe("Q4 plan");
    expect((await getWikiRegistry(OWNER)).wikis[0].name).toBe("Q4 plan");
    expect(await readWikiArtifact(OWNER, wiki.id, "purpose.md")).toContain("# Q4 plan");
    // …while the signal genuinely did NOT move.
    expect(await readDataVersion()).toBe(before);
    expect(
      warned.some(
        ([scope, message]) =>
          scope === "data-version" && String(message).includes(BUMP_FAILED_WARN),
      ),
    ).toBe(true);
  });

  it("still resolves a delete when the counter store rejects putIndex", async () => {
    const keep = await createWiki(OWNER, { name: "Keep", scenario: "business" });
    const drop = await createWiki(OWNER, { name: "Drop", scenario: "reading" });
    await setCurrentWiki(OWNER, keep.id);
    const before = await readDataVersion();
    expect(before).toBeGreaterThan(0);

    const putIndex = vi
      .spyOn(getStorage(), "putIndex")
      .mockRejectedValue(new Error("kv is gone"));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    let deleted: WikiRecord | null;
    let warned: unknown[][] = [];
    try {
      deleted = await deleteWiki(OWNER, drop.id);
      warned = warn.mock.calls.map((call) => [...call]);
    } finally {
      warn.mockRestore();
      putIndex.mockRestore();
    }

    // The delete resolved and both halves of it landed…
    expect(deleted?.id).toBe(drop.id);
    expect((await listWikis(OWNER)).map((item) => item.id)).toEqual([keep.id]);
    expect(await exists(wikiDir(drop.id))).toBe(false);
    // …while the signal genuinely did NOT move.
    expect(await readDataVersion()).toBe(before);
    expect(
      warned.some(
        ([scope, message]) =>
          scope === "data-version" && String(message).includes(BUMP_FAILED_WARN),
      ),
    ).toBe(true);
  });
});

describe("applying a different scenario template", () => {
  it("rewrites purpose, Schema and the profile while leaving Pages and Sources byte-identical", async () => {
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const businessPurpose = await readWikiArtifact(OWNER, wiki.id, "purpose.md");
    const businessSchema = await readWikiArtifact(OWNER, wiki.id, "schema.md");

    // Pre-seed the two trees this operation must never touch.
    await fs.mkdir(abs("tenants", TENANT, "wiki"), { recursive: true });
    await fs.mkdir(abs("tenants", TENANT, "raw"), { recursive: true });
    await fs.writeFile(abs("tenants", TENANT, "wiki", "existing-page.md"), "# Page\n");
    await fs.writeFile(abs("tenants", TENANT, "raw", "source.txt"), "raw bytes\n");

    const applied = await applyScenarioTemplate(OWNER, wiki.id, "reading");
    expect(applied?.scenario).toBe("reading");

    expect(await readWikiArtifact(OWNER, wiki.id, "purpose.md")).not.toEqual(businessPurpose);
    expect(await readWikiArtifact(OWNER, wiki.id, "schema.md")).not.toEqual(businessSchema);
    expect(await readWikiArtifact(OWNER, wiki.id, "schema.md")).toContain(
      "## Page conventions",
    );
    expect((await getWorkspaceProfile(OWNER, wiki.id)).scenario).toBe("reading");

    expect(
      await fs.readFile(abs("tenants", TENANT, "wiki", "existing-page.md"), "utf8"),
    ).toBe("# Page\n");
    expect(await fs.readFile(abs("tenants", TENANT, "raw", "source.txt"), "utf8")).toBe(
      "raw bytes\n",
    );
    // The purpose file keeps the wiki's own name — only the template changes.
    expect(await readWikiArtifact(OWNER, wiki.id, "purpose.md")).toContain("# Ops");
  });

  it("returns null for an unknown wiki id and writes nothing", async () => {
    expect(await applyScenarioTemplate(OWNER, "no-such-wiki", "reading")).toBeNull();
    await expect(fs.stat(abs("tenants", TENANT, "wikis"))).rejects.toThrow();
  });

  it("rejects the custom scenario", async () => {
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    await expect(
      applyScenarioTemplate(OWNER, wiki.id, "custom" as never),
    ).rejects.toThrow(ClientInputError);
    expect((await getCurrentWiki(OWNER))?.scenario).toBe("business");
  });
});

describe("the active wiki pointer", () => {
  it("persists a switch and 404s on an unknown id", async () => {
    const first = await createWiki(OWNER, { name: "One", scenario: "business" });
    const second = await createWiki(OWNER, { name: "Two", scenario: "reading" });
    expect((await getCurrentWiki(OWNER))?.id).toBe(second.id);

    expect((await setCurrentWiki(OWNER, first.id))?.id).toBe(first.id);
    expect((await getCurrentWiki(OWNER))?.id).toBe(first.id);
    expect((await getWikiRegistry(OWNER)).currentId).toBe(first.id);

    expect(await setCurrentWiki(OWNER, "missing")).toBeNull();
    expect((await getCurrentWiki(OWNER))?.id).toBe(first.id);
  });

  it("writes only wikis.json — a switch overwrites no profile (DW-21)", async () => {
    // The switch used to re-seed a tenant-global profile from the newly active
    // wiki's template, so an unguarded <select> silently discarded whatever the
    // owner had authored in Settings. The profile is per-wiki now: moving the
    // pointer swaps which one is live and rewrites nothing.
    const business = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const reading = await createWiki(OWNER, { name: "Shelf", scenario: "reading" });

    // Hand-author the business wiki's purpose, the way Settings would.
    await saveWorkspaceProfile(OWNER, business.id, {
      scenario: "custom",
      purpose: "Hand-authored: the Phoenix decision record.",
      keyQuestions: [],
      inScope: [],
      outOfScope: [],
      outputLanguage: "English",
      pageConventions: "",
    });
    const before = await Promise.all(
      [business.id, reading.id].map((id) => profileBytes(id)),
    );
    const registryBefore = await fs.readFile(abs(wikiRegistryPath(OWNER)), "utf8");

    await setCurrentWiki(OWNER, business.id);

    expect(await Promise.all([business.id, reading.id].map(profileBytes))).toEqual(before);
    expect(await fs.readFile(abs(wikiRegistryPath(OWNER)), "utf8")).not.toBe(
      registryBefore,
    );
    // Guidance and schema.md now come from the same wiki's directory.
    expect(await buildWorkspaceGuidance(OWNER)).toContain("Hand-authored");
    expect(await readWikiArtifact(OWNER, business.id, "schema.md")).toContain(
      "### Scenario conventions — Business",
    );
  });

  it("keeps a hand-authored purpose when another wiki is created or re-templated (DW-14)", async () => {
    const first = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    await saveWorkspaceProfile(OWNER, first.id, {
      scenario: "custom",
      purpose: "Hand-authored: the Phoenix decision record.",
      keyQuestions: ["Who signed off?"],
      inScope: [],
      outOfScope: [],
      outputLanguage: "English",
      pageConventions: "",
    });
    const authored = await profileBytes(first.id);

    const second = await createWiki(OWNER, { name: "Shelf", scenario: "reading" });
    expect(await profileBytes(first.id)).toBe(authored);
    expect((await getWorkspaceProfile(OWNER, second.id)).scenario).toBe("reading");

    await applyScenarioTemplate(OWNER, second.id, "research");
    expect(await profileBytes(first.id)).toBe(authored);
    expect((await getWorkspaceProfile(OWNER, second.id)).scenario).toBe("research");

    // And it is still what Settings would show once that wiki is active again.
    await setCurrentWiki(OWNER, first.id);
    expect((await getWorkspaceProfile(OWNER, first.id)).purpose).toContain(
      "Hand-authored",
    );
  });

  it("makes a Settings save wait on the Wiki lock, not a second key (DW-22)", async () => {
    // THE DISCRIMINATOR. Firing the two operations concurrently proves nothing:
    // they enqueue synchronously in call order, and neither one tears a single
    // `writeFile`, so that shape passes under the OLD two-key arrangement too.
    // Holding `wikis:<tenant>` from the test is what tells the arrangements
    // apart — under `workspace-profile:<tenant>` the save would sail straight
    // past a held Wiki lock, which is exactly the interleave DW-22 names.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = withFileLock(wikiLockKey(OWNER), () => held);

    let saved = false;
    const save = saveWorkspaceProfile(OWNER, wiki.id, {
      scenario: "custom",
      purpose: "Settings save racing the re-template.",
      keyQuestions: [],
      inScope: [],
      outOfScope: [],
      outputLanguage: "English",
      pageConventions: "",
    }).then(() => {
      saved = true;
    });
    let retemplated = false;
    const template = applyScenarioTemplate(OWNER, wiki.id, "reading").then(() => {
      retemplated = true;
    });

    // Give both every chance to run. Neither may, while the Wiki lock is held.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(saved).toBe(false);
    expect(retemplated).toBe(false);

    release();
    await Promise.all([gate, save, template]);

    // And each file is wholly ONE writer's bytes — never a blend. The save
    // queued first, so the re-template's template bytes are what landed last.
    const profile = await getWorkspaceProfile(OWNER, wiki.id);
    expect(profile.scenario).toBe("reading");
    expect(profile.purpose).toBe(WORKSPACE_SCENARIO_TEMPLATES.reading.purpose);
    expect(await readWikiArtifact(OWNER, wiki.id, "schema.md")).toContain(
      "### Scenario conventions — Reading",
    );
    // Deliberately NOT asserted: that the profile's `scenario` and `schema.md`
    // name the same template. Within one wiki they can still diverge — a
    // Settings save sets `scenario: "custom"` and rewrites no artifact — and
    // reconciling the two representations is Story 1.8's, explicitly out of
    // scope here. What DW-22 buys is that they cannot come from two different
    // wikis, and that neither file is ever half-written by the other operation.
  });

  it("takes no `workspace-profile:` lock key anywhere in src (DW-22)", async () => {
    // The behaviour above pins that the save waits on the Wiki lock; this pins
    // that the retired key is gone for good, in the source-scan style
    // `wiki-schema-edit.test.ts` already uses for the artifact layout. A future
    // caller reintroducing a second key would restore the exact nesting hazard.
    const root = path.resolve(__dirname, "../..");
    const files = (await fs.readdir(root, { recursive: true, encoding: "utf8" }))
      .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
      .map((name) => path.join(root, name));
    expect(files.length).toBeGreaterThan(100);

    for (const file of files) {
      const source = await fs.readFile(file, "utf8");
      // The lock-key FORM, not the words: `lock.ts` and this suite both discuss
      // the retired key in prose, and prose is not a call.
      expect(source).not.toMatch(/`workspace-profile:\$\{/);
      expect(source).not.toMatch(/withFileLock\(\s*["'`]workspace-profile:/);
    }

    // The save takes the WIKI key — pinned through the one spelling that now
    // exists for it. `withWikiLock` wraps `withFileLock(wikiLockKey(owner))`
    // and mints the `WikiLockHeld` the putter demands (DW-139), so the
    // assertion is split across the two files: the store calls the wrapper, and
    // the wrapper is the thing that resolves to `wikis:<tenant>`.
    const profileStore = await fs.readFile(
      path.resolve(__dirname, "../workspace-profile.ts"),
      "utf8",
    );
    expect(profileStore).toContain("withWikiLock(owner");
    const wikiLock = await fs.readFile(
      path.resolve(__dirname, "../wiki-lock.ts"),
      "utf8",
    );
    // The STATEMENT, not the identifier: `wikiLockKey(owner)` on its own also
    // matches this module's docblock, so deleting the real call would leave the
    // prose behind and keep this green.
    expect(wikiLock).toContain("const key = wikiLockKey(owner);");
    expect(wikiLock).toContain("withFileLock(key");

    // ONE SPELLING, enforced. `lock.ts`, `wikis.ts`, `wiki-lock.ts` and
    // `workspace-profile.ts` all now claim that no module takes the Wiki key
    // without minting a `WikiLockHeld`, and a claim four docblocks make and
    // nothing checks is how the second spelling comes back — `withWikiLock` is
    // a wrapper, so the old form still compiles and still works, and a future
    // author copying it would reach the unlocked putters with no token to
    // demand. `__tests__` is excluded: several suites hold the lock directly to
    // create the contention they are testing, which is legitimate.
    //
    // Comments are STRIPPED before matching, because four of the modules that
    // must not make this call quote it verbatim while explaining why — the
    // rule's own documentation would otherwise be the only thing failing.
    // Known limit: the line-comment strip also truncates at a `//` inside a
    // string literal (a URL), which can only ever hide a match, and no
    // production line pairs a URL with a lock call.
    const withoutComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

    const offenders: string[] = [];
    for (const file of files) {
      if (file.includes("__tests__")) continue;
      if (file.endsWith(`${path.sep}wiki-lock.ts`)) continue;
      const source = withoutComments(await fs.readFile(file, "utf8"));
      // The CALL form across its argument list, in any spelling of it.
      if (/\bwithFileLock\(\s*[^)]*\bwikiLockKey\(/.test(source)) {
        offenders.push(path.relative(root, file));
      }
    }
    expect(offenders, "modules taking the wiki lock outside wiki-lock.ts").toEqual([]);

    // The scan is only evidence if the regex actually matches the form it
    // bans — a broken pattern would produce an empty `offenders` and a green,
    // meaningless assertion. `wiki-lock.ts`, the one legitimate site, is the
    // fixture.
    expect(
      /\bwithFileLock\(\s*[^)]*\bwikiLockKey\(/.test(
        withoutComments("return withFileLock(wikiLockKey(owner), async () => {}); "),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: rename, delete, and the orphan sweep (DW-18)
// ---------------------------------------------------------------------------

/** The absolute path of one Wiki's own directory, for existence assertions. */
function wikiDir(wikiId: string): string {
  return abs("tenants", TENANT, "wikis", wikiId);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Push every mtime under `dir` (and the directory's own) well past
 * {@link ORPHAN_SWEEP_GRACE_MS}, so the sweep sees settled bytes rather than
 * what looks exactly like a create still in flight on another isolate.
 *
 * Every directory these tests plant was written milliseconds ago, so WITHOUT
 * this the grace window skips it — and a sweep test that passed by deleting the
 * grace check instead would be testing the code it removed.
 */
async function ageDirectory(
  dir: string,
  ageMs = ORPHAN_SWEEP_GRACE_MS * 2,
): Promise<void> {
  const when = new Date(Date.now() - ageMs);
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) await ageDirectory(child, ageMs);
    else await fs.utimes(child, when, when);
  }
  // The directory itself LAST: it is the fallback when a candidate holds no
  // files at all, and writing a child would have bumped it again.
  await fs.utimes(dir, when, when);
}

/** A `wikis/<uuid>/` directory with artifacts and no registry entry. */
async function plantOrphan(id: string): Promise<string> {
  await fs.mkdir(wikiDir(id), { recursive: true });
  await fs.writeFile(path.join(wikiDir(id), "purpose.md"), "# Orphan\n");
  return wikiDir(id);
}

/** Backdate a Wiki's `updatedAt` so "bumped" is an observation, not a coin flip. */
async function backdate(wikiId: string, when = "2000-01-01T00:00:00.000Z"): Promise<void> {
  const file = abs(wikiRegistryPath(OWNER));
  const registry = JSON.parse(await fs.readFile(file, "utf8"));
  for (const entry of registry.wikis) {
    if (entry.id === wikiId) entry.updatedAt = when;
  }
  await fs.writeFile(file, JSON.stringify(registry, null, 2));
}

describe("renaming a wiki", () => {
  it("trims and collapses the name, bumps updatedAt, and retitles purpose.md only", async () => {
    const wiki = await createWiki(OWNER, { name: "Q3 planning", scenario: "business" });
    await backdate(wiki.id);
    const before = (await readWikiArtifact(OWNER, wiki.id, "purpose.md")) ?? "";
    const schemaBefore = await readWikiArtifact(OWNER, wiki.id, "schema.md");
    const profileBefore = await profileBytes(wiki.id);

    const renamed = await renameWiki(OWNER, wiki.id, "  Q4   plan ");

    expect(renamed?.name).toBe("Q4 plan");
    expect(renamed?.updatedAt.localeCompare("2000-01-01T00:00:00.000Z")).toBe(1);
    expect((await getWikiRegistry(OWNER)).wikis[0].name).toBe("Q4 plan");
    // The scenario is a label change away from nothing else: a rename must not
    // re-seed, so the Schema and the profile are byte-identical.
    expect(renamed?.scenario).toBe("business");
    expect(await readWikiArtifact(OWNER, wiki.id, "schema.md")).toBe(schemaBefore);
    expect(await profileBytes(wiki.id)).toBe(profileBefore);

    const after = (await readWikiArtifact(OWNER, wiki.id, "purpose.md")) ?? "";
    expect(after.split("\n")[0]).toBe("# Q4 plan");
    // Only line 1 moved — the rest of the seeded file is byte-identical.
    expect(after.split("\n").slice(1)).toEqual(before.split("\n").slice(1));
  });

  it("rejects a blank, non-string or oversized name and writes nothing", async () => {
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const purpose = await readWikiArtifact(OWNER, wiki.id, "purpose.md");
    const registryBefore = await fs.readFile(abs(wikiRegistryPath(OWNER)), "utf8");

    for (const name of ["   ", "", 42 as never, null as never, "x".repeat(81)]) {
      await expect(renameWiki(OWNER, wiki.id, name)).rejects.toThrow(ClientInputError);
    }
    // The parser is also reachable on its own, the way the route calls it.
    for (const body of [{ name: "  " }, { name: 7 }, {}, { name: "x".repeat(81) }]) {
      expect(() => parseRenameWikiInput(body)).toThrow(ClientInputError);
    }
    expect(parseRenameWikiInput({ name: "  Q4   plan " })).toEqual({ name: "Q4 plan" });

    expect(await fs.readFile(abs(wikiRegistryPath(OWNER)), "utf8")).toBe(registryBefore);
    expect(await readWikiArtifact(OWNER, wiki.id, "purpose.md")).toBe(purpose);
  });

  it("returns null for an unknown or traversal-shaped id and writes nothing", async () => {
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const registryBefore = await fs.readFile(abs(wikiRegistryPath(OWNER)), "utf8");

    for (const id of ["00000000-0000-4000-8000-000000000000", "../../etc/passwd", "nope"]) {
      expect(await renameWiki(OWNER, id, "New name")).toBeNull();
    }

    expect(await fs.readFile(abs(wikiRegistryPath(OWNER)), "utf8")).toBe(registryBefore);
    expect(await readWikiArtifact(OWNER, wiki.id, "purpose.md")).toContain("# Ops");
  });

  it("still renames when purpose.md is missing or does not open with a heading", async () => {
    const missing = await createWiki(OWNER, { name: "Gone", scenario: "general" });
    await fs.rm(path.join(wikiDir(missing.id), "purpose.md"));

    expect((await renameWiki(OWNER, missing.id, "Renamed anyway"))?.name).toBe(
      "Renamed anyway",
    );
    expect(await readWikiArtifact(OWNER, missing.id, "purpose.md")).toBeNull();

    const shapeless = await createWiki(OWNER, { name: "Odd", scenario: "general" });
    await fs.writeFile(
      path.join(wikiDir(shapeless.id), "purpose.md"),
      "no heading here\n## Purpose\n",
    );

    expect((await renameWiki(OWNER, shapeless.id, "Also renamed"))?.name).toBe(
      "Also renamed",
    );
    // The owner's own bytes are left exactly as written, not guessed at.
    expect(await readWikiArtifact(OWNER, shapeless.id, "purpose.md")).toBe(
      "no heading here\n## Purpose\n",
    );
    const names = (await getWikiRegistry(OWNER)).wikis.map((item) => item.name);
    expect(names).toEqual(["Renamed anyway", "Also renamed"]);
  });

  it("still renames when writing the retitled purpose.md fails", async () => {
    // The registry write lands FIRST, so the rename has already happened by
    // the time the artifact is touched. Propagating a storage failure from
    // there would 500 a rename the owner can see took effect — and the retry
    // would 500 again. The delete path pins the mirror of this with a
    // `deleteDirectory` spy; this is the rename half.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const storage = getStorage();
    const write = storage.writeFile.bind(storage);
    const spy = vi
      .spyOn(storage, "writeFile")
      .mockImplementation(async (target: string, content: string) =>
        target.endsWith("purpose.md")
          ? Promise.reject(new Error("the artifact store is unavailable"))
          : write(target, content),
      );

    try {
      expect((await renameWiki(OWNER, wiki.id, "Q4 plan"))?.name).toBe("Q4 plan");
    } finally {
      spy.mockRestore();
    }

    // The registry — what the switcher and every id lookup read — has moved.
    expect((await getWikiRegistry(OWNER)).wikis[0].name).toBe("Q4 plan");
    // The heading is stale, which is the accepted cost of not failing.
    expect(await readWikiArtifact(OWNER, wiki.id, "purpose.md")).toContain("# Ops");
  });
});

describe("deleting a wiki", () => {
  it("removes the entry and the directory, and leaves the active wiki alone", async () => {
    const keep = await createWiki(OWNER, { name: "Keep", scenario: "business" });
    const drop = await createWiki(OWNER, { name: "Drop", scenario: "reading" });
    // `drop` was created last, so it is current — move the pointer back.
    await setCurrentWiki(OWNER, keep.id);

    // The trees a delete must never reach.
    await fs.mkdir(abs("tenants", TENANT, "wiki"), { recursive: true });
    await fs.mkdir(abs("tenants", TENANT, "raw"), { recursive: true });
    await fs.writeFile(abs("tenants", TENANT, "wiki", "existing-page.md"), "# Page\n");
    await fs.writeFile(abs("tenants", TENANT, "raw", "source.txt"), "raw bytes\n");

    expect((await deleteWiki(OWNER, drop.id))?.id).toBe(drop.id);

    const registry = await getWikiRegistry(OWNER);
    expect(registry.wikis.map((item) => item.id)).toEqual([keep.id]);
    expect(registry.currentId).toBe(keep.id);
    expect(await exists(wikiDir(drop.id))).toBe(false);
    // The OTHER wiki's directory is untouched — all three files still there.
    expect(await exists(wikiDir(keep.id))).toBe(true);
    expect(await readWikiArtifact(OWNER, keep.id, "purpose.md")).toContain("# Keep");
    expect(await readWikiArtifact(OWNER, keep.id, "schema.md")).toBeTruthy();
    expect(await profileBytes(keep.id)).toBeTruthy();
    // Pages and Sources are tenant-wide; a delete is not a content reset.
    expect(
      await fs.readFile(abs("tenants", TENANT, "wiki", "existing-page.md"), "utf8"),
    ).toBe("# Page\n");
    expect(await fs.readFile(abs("tenants", TENANT, "raw", "source.txt"), "utf8")).toBe(
      "raw bytes\n",
    );
  });

  it("refuses the current wiki instead of silently re-pointing current", async () => {
    const first = await createWiki(OWNER, { name: "One", scenario: "business" });
    const second = await createWiki(OWNER, { name: "Two", scenario: "reading" });
    expect((await getCurrentWiki(OWNER))?.id).toBe(second.id);

    await expect(deleteWiki(OWNER, second.id)).rejects.toThrow(ClientInputError);

    // Nothing moved: not the entry, not the directory, and not the pointer.
    const registry = await getWikiRegistry(OWNER);
    expect(registry.wikis.map((item) => item.id)).toEqual([first.id, second.id]);
    expect(registry.currentId).toBe(second.id);
    expect(await exists(wikiDir(second.id))).toBe(true);
  });

  it("refuses the last wiki, which is always the current one", async () => {
    const only = await createWiki(OWNER, { name: "Only", scenario: "general" });
    await expect(deleteWiki(OWNER, only.id)).rejects.toThrow(ClientInputError);
    expect((await listWikis(OWNER)).map((item) => item.id)).toEqual([only.id]);
  });

  it("returns null for an unknown or traversal-shaped id and removes nothing", async () => {
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const registryBefore = await fs.readFile(abs(wikiRegistryPath(OWNER)), "utf8");

    for (const id of ["00000000-0000-4000-8000-000000000000", "../../etc/passwd", "nope"]) {
      expect(await deleteWiki(OWNER, id)).toBeNull();
    }

    expect(await fs.readFile(abs(wikiRegistryPath(OWNER)), "utf8")).toBe(registryBefore);
    expect(await exists(wikiDir(wiki.id))).toBe(true);
  });

  it("still reports success when removing the directory fails", async () => {
    // The registry write has already landed, so the wiki is gone from every
    // read in the app. Propagating the failure would 500 a delete that has
    // effectively happened — and the owner's retry would then 404.
    const keep = await createWiki(OWNER, { name: "Keep", scenario: "business" });
    const drop = await createWiki(OWNER, { name: "Drop", scenario: "reading" });
    await setCurrentWiki(OWNER, keep.id);

    const removal = vi
      .spyOn(getStorage(), "deleteDirectory")
      .mockRejectedValue(new Error("the directory is busy"));
    try {
      expect((await deleteWiki(OWNER, drop.id))?.id).toBe(drop.id);
    } finally {
      removal.mockRestore();
    }

    expect((await listWikis(OWNER)).map((item) => item.id)).toEqual([keep.id]);
    // The bytes are still there — deliberately, for the next sweep to reclaim.
    expect(await exists(wikiDir(drop.id))).toBe(true);
    await ageDirectory(wikiDir(drop.id));
    expect(await sweepOrphanWikiDirectories(OWNER)).toBe(1);
    expect(await exists(wikiDir(drop.id))).toBe(false);
    expect(await exists(wikiDir(keep.id))).toBe(true);
  });
});

describe("the orphan-directory sweep", () => {
  it("removes only unreferenced uuid directories, and counts them", async () => {
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const orphan = await plantOrphan("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    await ageDirectory(orphan);
    // Neither of these is a Wiki directory, so neither is the sweep's business.
    const sibling = abs("tenants", TENANT, "wikis", "archive");
    await fs.mkdir(sibling, { recursive: true });
    const loose = abs("tenants", TENANT, "wikis", "README.md");
    await fs.writeFile(loose, "notes\n");

    expect(await sweepOrphanWikiDirectories(OWNER)).toBe(1);

    expect(await exists(orphan)).toBe(false);
    expect(await exists(sibling)).toBe(true);
    expect(await exists(loose)).toBe(true);
    expect(await exists(wikiDir(wiki.id))).toBe(true);
    // Idempotent: a second sweep has nothing left to reclaim.
    expect(await sweepOrphanWikiDirectories(OWNER)).toBe(0);
  });

  it("reclaims orphans as a side effect of a delete", async () => {
    const keep = await createWiki(OWNER, { name: "Keep", scenario: "business" });
    const drop = await createWiki(OWNER, { name: "Drop", scenario: "reading" });
    await setCurrentWiki(OWNER, keep.id);
    const orphan = await plantOrphan("11111111-2222-4333-8444-555555555555");
    await ageDirectory(orphan);

    expect((await deleteWiki(OWNER, drop.id))?.id).toBe(drop.id);

    expect(await exists(orphan)).toBe(false);
    expect(await exists(wikiDir(drop.id))).toBe(false);
    expect(await exists(wikiDir(keep.id))).toBe(true);
  });

  it("is empty, not an error, when no wiki directory exists at all", async () => {
    // The registry has to NAME something, or the empty-registry guard below
    // returns first and `listFiles` is never reached — the assertion would then
    // pass for a reason that has nothing to do with the missing directory.
    // `wikis.json` is a sibling of the `wikis/` tree, so removing the tree
    // leaves the registry standing.
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    await fs.rm(abs("tenants", TENANT, "wikis"), { recursive: true });

    expect(await sweepOrphanWikiDirectories(OWNER)).toBe(0);
  });

  it("refuses to sweep an untombstoned directory against an empty registry", async () => {
    // `readRegistry` degrades a missing or unparseable wikis.json to an EMPTY
    // registry, so "no entries but directories on disk" is a lost or
    // half-restored registry as often as it is an empty tenant — and against
    // that reading, every wiki the owner has is an orphan. It also cannot be a
    // legitimate post-delete state: the current wiki is undeletable, so a
    // delete never empties the registry.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const purpose = await readWikiArtifact(OWNER, wiki.id, "purpose.md");
    await fs.rm(abs(wikiRegistryPath(OWNER)));
    // Aged, so what is being pinned is the registry rule and not the grace
    // window standing in for it.
    await ageDirectory(wikiDir(wiki.id));

    expect(await sweepOrphanWikiDirectories(OWNER)).toBe(0);

    expect(await exists(wikiDir(wiki.id))).toBe(true);
    expect(await readWikiArtifact(OWNER, wiki.id, "purpose.md")).toBe(purpose);
    // Same for a registry that parses but names nothing.
    await fs.writeFile(
      abs(wikiRegistryPath(OWNER)),
      JSON.stringify({ version: 1, wikis: [], currentId: null }),
    );
    expect(await sweepOrphanWikiDirectories(OWNER)).toBe(0);
    expect(await exists(wikiDir(wiki.id))).toBe(true);
  });

  it("reclaims a tombstoned directory against an empty registry (DW-162)", async () => {
    // The one thing that outranks the empty-registry rule. Only the half-create
    // compensation writes `.discarded`, and only for an id whose create
    // provably failed — so this directory is unclaimed no matter what the
    // registry does or does not say, which is exactly the first-ever-create
    // case that used to need the tenant to own a wiki AND run a delete.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const doomed = await plantOrphan("cccccccc-dddd-4eee-8fff-000000000000");
    await fs.writeFile(path.join(doomed, ".discarded"), "2020-01-01T00:00:00.000Z\n");
    await ageDirectory(doomed);
    await ageDirectory(wikiDir(wiki.id));
    await fs.rm(abs(wikiRegistryPath(OWNER)));

    expect(await sweepOrphanWikiDirectories(OWNER)).toBe(1);

    expect(await exists(doomed)).toBe(false);
    // …and the real wiki, whose registry entry the lost wikis.json took with
    // it, is untouched. That is the whole point of narrowing rather than
    // lifting the bail.
    expect(await exists(wikiDir(wiki.id))).toBe(true);
  });

  it("leaves a tombstoned directory alone while it is still inside the grace window", async () => {
    const doomed = await plantOrphan("cccccccc-dddd-4eee-8fff-111111111111");
    await fs.writeFile(path.join(doomed, ".discarded"), "now\n");
    await fs.rm(abs(wikiRegistryPath(OWNER)), { force: true });

    expect(await sweepOrphanWikiDirectories(OWNER)).toBe(0);
    expect(await exists(doomed)).toBe(true);
  });

  it("sweeps an aged orphan and spares a fresh one in the same pass", async () => {
    // The multi-isolate guard, and the reason it cannot be a whole-pass bail:
    // isolate A's in-flight `createWiki` has already seeded its directory but
    // not yet written the registry, so from here it is indistinguishable from
    // an orphan — except by age. Sparing it must not cost the aged sibling.
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const aged = await plantOrphan("aaaaaaaa-1111-4111-8111-111111111111");
    const inFlight = await plantOrphan("bbbbbbbb-2222-4222-8222-222222222222");
    await ageDirectory(aged);

    expect(await sweepOrphanWikiDirectories(OWNER)).toBe(1);

    expect(await exists(aged)).toBe(false);
    expect(await exists(inFlight)).toBe(true);
    // And once it settles, the next pass takes it — the window delays, it does
    // not exempt.
    await ageDirectory(inFlight);
    expect(await sweepOrphanWikiDirectories(OWNER)).toBe(1);
    expect(await exists(inFlight)).toBe(false);
  });

  it("sweeps an aged orphan that holds no files at all", async () => {
    // `FileEntry` carries no mtime, so age comes from `stat` per FILE — and an
    // empty directory has none. The directory's own `stat` is the fallback, and
    // this is the only row that reaches it: without it the walk finds nothing,
    // the age is unknown, and a directory that is provably dead is skipped
    // forever. (Replace that fallback with `return null` and only this fails.)
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const bare = wikiDir("aaaaaaaa-5555-4555-8555-555555555555");
    await fs.mkdir(bare, { recursive: true });
    await ageDirectory(bare);

    expect(await sweepOrphanWikiDirectories(OWNER)).toBe(1);
    expect(await exists(bare)).toBe(false);
  });

  it("skips a candidate whose per-file stat throws", async () => {
    // The other half of "unknown age": the listing succeeds, so the walk knows
    // the files are there, but their mtimes cannot be read. Seeing the names is
    // not seeing the ages, and only the ages decide.
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const unreadable = await plantOrphan("aaaaaaaa-6666-4666-8666-666666666666");
    const readable = await plantOrphan("aaaaaaaa-7777-4777-8777-777777777777");
    await ageDirectory(unreadable);
    await ageDirectory(readable);

    const storage = getStorage();
    const stat = storage.stat.bind(storage);
    const spy = vi
      .spyOn(storage, "stat")
      .mockImplementation(async (target: string) => {
        if (target.includes("aaaaaaaa-6666-4666-8666-666666666666")) {
          throw new Error("the file is unreadable");
        }
        return stat(target);
      });
    try {
      expect(await sweepOrphanWikiDirectories(OWNER)).toBe(1);
    } finally {
      spy.mockRestore();
    }

    expect(await exists(unreadable)).toBe(true);
    expect(await exists(readable)).toBe(false);
  });

  it("skips a candidate whose tombstone probe throws, under an empty registry", async () => {
    // An unreadable probe is NOT a tombstone. Treating it as one would delete
    // live wiki directories in precisely the lost-`wikis.json` state the whole
    // empty-registry rule exists to protect — the registry names nothing, so
    // the probe is the only thing standing between the sweep and every
    // artifact the tenant owns.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    await ageDirectory(wikiDir(wiki.id));
    await fs.rm(abs(wikiRegistryPath(OWNER)));

    const probe = vi
      .spyOn(getStorage(), "fileExists")
      .mockRejectedValue(new Error("the marker cannot be read"));
    try {
      expect(await sweepOrphanWikiDirectories(OWNER)).toBe(0);
    } finally {
      probe.mockRestore();
    }

    expect(await exists(wikiDir(wiki.id))).toBe(true);
  });

  it("does not abort the pass when one removal fails", async () => {
    // `sweepOrphanWikiDirs` turns a throw into 0, so a propagating failure here
    // would make the scan report "removed nothing" for a pass that had already
    // removed the sibling — the count would contradict the disk.
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const stuck = await plantOrphan("aaaaaaaa-8888-4888-8888-888888888888");
    const fine = await plantOrphan("aaaaaaaa-9999-4999-8999-999999999999");
    await ageDirectory(stuck);
    await ageDirectory(fine);

    const storage = getStorage();
    const remove = storage.deleteDirectory.bind(storage);
    const spy = vi
      .spyOn(storage, "deleteDirectory")
      .mockImplementation(async (target: string) => {
        if (target.endsWith("aaaaaaaa-8888-4888-8888-888888888888")) {
          throw new Error("the directory is busy");
        }
        return remove(target);
      });
    try {
      expect(await sweepOrphanWikiDirectories(OWNER)).toBe(1);
    } finally {
      spy.mockRestore();
    }

    expect(await exists(stuck)).toBe(true);
    expect(await exists(fine)).toBe(false);
  });

  it("skips a candidate whose age cannot be read", async () => {
    // Unknown age is treated as too young. A directory that cannot be read is
    // exactly as likely to be a create in flight as a dead one, and only one of
    // those two mistakes destroys bytes.
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const unreadable = await plantOrphan("aaaaaaaa-3333-4333-8333-333333333333");
    const readable = await plantOrphan("aaaaaaaa-4444-4444-8444-444444444444");
    await ageDirectory(unreadable);
    await ageDirectory(readable);

    const storage = getStorage();
    const listFiles = storage.listFiles.bind(storage);
    const listing = vi
      .spyOn(storage, "listFiles")
      .mockImplementation(async (prefix: string) => {
        if (prefix.endsWith("aaaaaaaa-3333-4333-8333-333333333333")) {
          throw new Error("the directory is unreadable");
        }
        return listFiles(prefix);
      });
    try {
      // The readable sibling still goes: one bad candidate is not a bad pass.
      expect(await sweepOrphanWikiDirectories(OWNER)).toBe(1);
    } finally {
      listing.mockRestore();
    }

    expect(await exists(unreadable)).toBe(true);
    expect(await exists(readable)).toBe(false);
  });

  it("never fails the delete it runs inside", async () => {
    // The requested wiki is gone from BOTH the registry and the disk by the
    // time the sweep runs. Failing the request over leftovers from some earlier
    // interruption would report a completed delete as failed, and the owner
    // would retry a delete that has already happened.
    const keep = await createWiki(OWNER, { name: "Keep", scenario: "business" });
    const drop = await createWiki(OWNER, { name: "Drop", scenario: "reading" });
    await setCurrentWiki(OWNER, keep.id);

    const listing = vi
      .spyOn(getStorage(), "listFiles")
      .mockRejectedValue(new Error("listing the wikis directory failed"));
    try {
      expect((await deleteWiki(OWNER, drop.id))?.id).toBe(drop.id);
    } finally {
      listing.mockRestore();
    }

    expect((await listWikis(OWNER)).map((item) => item.id)).toEqual([keep.id]);
    expect(await exists(wikiDir(drop.id))).toBe(false);
  });

  it("considers at most the per-pass cap and defers the rest to the next sweep (DW-289)", async () => {
    // The whole walk — `newestWriteTime` per candidate, the tombstone probe,
    // `deleteDirectory` — runs while `wikis:<tenant>` is HELD, so every create,
    // rename and delete for this tenant queues behind it. Uncapped, the length
    // of that queue is set by however many orphan directories happen to exist.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const OVERFLOW = 3;
    const planted: string[] = [];
    for (let index = 0; index < ORPHAN_SWEEP_CANDIDATE_CAP + OVERFLOW; index += 1) {
      const dir = await plantOrphan(
        `aaaaaaaa-0000-4000-8000-${String(index).padStart(12, "0")}`,
      );
      await ageDirectory(dir);
      planted.push(dir);
    }

    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    let removed: number;
    let warned: unknown[][] = [];
    try {
      removed = await sweepOrphanWikiDirectories(OWNER);
      warned = warn.mock.calls.map((call) => [...call]);
    } finally {
      warn.mockRestore();
    }

    // Exactly the cap — the return value is still "directories removed by THIS
    // pass", not a total.
    expect(removed).toBe(ORPHAN_SWEEP_CANDIDATE_CAP);
    const survivors: string[] = [];
    for (const dir of planted) if (await exists(dir)) survivors.push(dir);
    expect(survivors).toHaveLength(OVERFLOW);
    // The truncation is reported, naming how many were held back — a silent cap
    // would look exactly like a sweep that had finished its work.
    expect(
      warned.some(
        ([scope, message]) =>
          scope === "wikis" &&
          String(message).includes(`deferring ${OVERFLOW} to the next sweep`),
      ),
    ).toBe(true);

    // Continuation needs no cursor: removal IS the progress, so the next pass
    // starts on a listing the reclaimed directories are already gone from.
    expect(await sweepOrphanWikiDirectories(OWNER)).toBe(OVERFLOW);
    for (const dir of planted) expect(await exists(dir)).toBe(false);
    // …and the real wiki was never a candidate at any point.
    expect(await exists(wikiDir(wiki.id))).toBe(true);
    expect(await sweepOrphanWikiDirectories(OWNER)).toBe(0);
  });

  it("logs no truncation warning when the candidate list is exactly at the cap", async () => {
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const planted: string[] = [];
    for (let index = 0; index < ORPHAN_SWEEP_CANDIDATE_CAP; index += 1) {
      const dir = await plantOrphan(
        `bbbbbbbb-0000-4000-8000-${String(index).padStart(12, "0")}`,
      );
      await ageDirectory(dir);
      planted.push(dir);
    }

    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    let removed: number;
    let warned: unknown[][] = [];
    try {
      removed = await sweepOrphanWikiDirectories(OWNER);
      warned = warn.mock.calls.map((call) => [...call]);
    } finally {
      warn.mockRestore();
    }

    // Exactly at the cap is the boundary the `>` comparison has to get right:
    // every candidate is still considered and nothing is reported as deferred.
    expect(removed).toBe(ORPHAN_SWEEP_CANDIDATE_CAP);
    for (const dir of planted) expect(await exists(dir)).toBe(false);
    expect(
      warned.some(([, message]) => String(message).includes("to the next sweep")),
    ).toBe(false);
  });

  it("probes at most the cap candidates even when it removes none of them (DW-289)", async () => {
    // THE ROW THAT SEPARATES A CANDIDATE CAP FROM A REMOVAL CAP. Every other
    // cap row plants AGED orphans, where "walked" and "removed" coincide — so
    // all of them still pass against an implementation that walks the whole list
    // and merely stops DELETING at the cap, which is exactly the unbounded
    // in-lock walk DW-289 was filed against. Here nothing is aged, so nothing is
    // removable and the only observable is how many candidates were PROBED: the
    // grace-window skip logs one INFO line per candidate it actually reached.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const OVERFLOW = 3;
    const planted: string[] = [];
    for (let index = 0; index < ORPHAN_SWEEP_CANDIDATE_CAP + OVERFLOW; index += 1) {
      // Deliberately NOT `ageDirectory`d — these were written milliseconds ago.
      planted.push(
        await plantOrphan(`cccccccc-0000-4000-8000-${String(index).padStart(12, "0")}`),
      );
    }

    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    let removed: number;
    let logged: unknown[][] = [];
    let warned: unknown[][] = [];
    try {
      removed = await sweepOrphanWikiDirectories(OWNER);
      logged = info.mock.calls.map((call) => [...call]);
      warned = warn.mock.calls.map((call) => [...call]);
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }

    // Nothing was reclaimed — every candidate is inside the grace window.
    expect(removed).toBe(0);
    for (const dir of planted) expect(await exists(dir)).toBe(true);
    // …and the cap still applied, because only `cap` of them were ever reached.
    // A removal cap would have probed all 28 and logged 28.
    const skipped = logged.filter(
      ([scope, message]) =>
        scope === "wikis" &&
        String(message).includes("skipped orphaned wiki directory"),
    );
    expect(skipped).toHaveLength(ORPHAN_SWEEP_CANDIDATE_CAP);
    expect(
      warned.some(([, message]) =>
        String(message).includes(`deferring ${OVERFLOW} to the next sweep`),
      ),
    ).toBe(true);
    expect(await exists(wikiDir(wiki.id))).toBe(true);
  });

  it("still reclaims a tombstoned directory that sorts past the cap against an empty registry", async () => {
    // The cap must not sit ABOVE the tombstone filter. In `tombstonedOnly` mode
    // an untombstoned directory is skipped on every pass FOREVER, so if one
    // could occupy a slot then a genuinely tombstoned DW-162 directory sorting
    // after `cap` of them would never be reclaimed at all — a permanent leak,
    // not a deferral, and worse than the uncapped behaviour it replaced.
    //
    // No wiki is created, so `wikis.json` is missing and `readRegistry` degrades
    // it to the empty registry that turns `tombstonedOnly` on.
    const untombstoned: string[] = [];
    for (let index = 0; index < ORPHAN_SWEEP_CANDIDATE_CAP; index += 1) {
      untombstoned.push(
        // Deliberately young as well: these must never reach the age walk.
        await plantOrphan(`aaaaaaaa-0000-4000-8000-${String(index).padStart(12, "0")}`),
      );
    }
    const marked = await plantOrphan("ffffffff-9999-4999-8999-999999999999");
    await fs.writeFile(path.join(marked, ".discarded"), "");
    await ageDirectory(marked);

    // `fs.readdir` order is not specified, and the position of the tombstoned
    // entry is the whole point — so the listing is sorted here to put it LAST,
    // which is also how R2 enumerates.
    const storage = getStorage();
    const list = storage.listFiles.bind(storage);
    const listing = vi
      .spyOn(storage, "listFiles")
      .mockImplementation(async (prefix: string) =>
        (await list(prefix)).sort((a, b) => a.name.localeCompare(b.name)),
      );
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    let removed: number;
    let logged: unknown[][] = [];
    let warned: unknown[][] = [];
    try {
      removed = await sweepOrphanWikiDirectories(OWNER);
      logged = info.mock.calls.map((call) => [...call]);
      warned = warn.mock.calls.map((call) => [...call]);
    } finally {
      warn.mockRestore();
      info.mockRestore();
      listing.mockRestore();
    }

    // Reclaimed in ONE pass, from position 26 of 26.
    expect(removed).toBe(1);
    expect(await exists(marked)).toBe(false);
    // The untombstoned ones are left exactly where they were — and were never
    // walked at all, so they cost no `newestWriteTime` under the tenant lock.
    for (const dir of untombstoned) expect(await exists(dir)).toBe(true);
    expect(
      logged.some(([, message]) =>
        String(message).includes("skipped orphaned wiki directory"),
      ),
    ).toBe(false);
    // The empty-registry warn is keyed on the PRE-cap list, so it still fires…
    expect(
      warned.some(([, message]) =>
        String(message).includes("the registry names no wikis"),
      ),
    ).toBe(true);
    // …while the truncation warn does NOT, because one directory is genuinely
    // reclaimable here. Counting all 26 would announce a lost registry's every
    // artifact as a deferred orphan.
    expect(
      warned.some(([, message]) => String(message).includes("to the next sweep")),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Compensating cleanup for a half-finished seed (DW-20, DW-143)
// ---------------------------------------------------------------------------

/**
 * `seedWikiArtifacts` + `writeRegistry` is four sequential writes and the
 * storage provider has no transaction, so every one of them is a place a create
 * or a re-template can stop halfway. What these pin is what is on DISK
 * afterwards: a create leaves no directory the registry does not name, and a
 * re-template leaves all three of its files byte-identical to the pre-call
 * bytes — never `purpose.md` on the new template beside a profile on the old
 * one. The injector is the `writeFile` path-conditional spy the rename suite
 * above already uses.
 */
describe("a half-finished create or re-template leaves no wreckage (DW-20, DW-143)", () => {
  const FAULT = "the storage provider is unavailable";

  /**
   * Reject the FIRST `writeFile` to each path ending in one of `suffixes`; pass
   * every other write through, that path's later ones included.
   *
   * "First only" is what makes these rows test anything. The seed and the
   * compensation write the SAME three paths, so a spy that rejects every match
   * also rejects the restore of the very file it broke — the byte assertions
   * then hold because nothing was ever overwritten, and a compensation that did
   * nothing at all would satisfy them identically. Faulting the seed's write and
   * letting the restore's land is the only arrangement under which "the bytes
   * are back" means the restore put them back.
   */
  function failWritesTo(suffixes: string | string[], message = FAULT) {
    const endings = Array.isArray(suffixes) ? suffixes : [suffixes];
    const failed = new Set<string>();
    const storage = getStorage();
    const write = storage.writeFile.bind(storage);
    return vi
      .spyOn(storage, "writeFile")
      .mockImplementation(async (target: string, content: string) => {
        if (endings.some((e) => target.endsWith(e)) && !failed.has(target)) {
          failed.add(target);
          return Promise.reject(new Error(message));
        }
        return write(target, content);
      });
  }

  /** Capture every `logger.warn` call made while `run` executes. */
  async function warnsDuring(run: () => Promise<void>): Promise<unknown[][]> {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await run();
      return warn.mock.calls.map((call) => [...call]);
    } finally {
      warn.mockRestore();
    }
  }

  /** A page and a raw source outside `wikis/`, as blast-radius controls. */
  async function seedTenantTrees(): Promise<void> {
    await fs.mkdir(abs("tenants", TENANT, "wiki"), { recursive: true });
    await fs.mkdir(abs("tenants", TENANT, "raw"), { recursive: true });
    await fs.writeFile(abs("tenants", TENANT, "wiki", "existing-page.md"), "# Page\n");
    await fs.writeFile(abs("tenants", TENANT, "raw", "source.txt"), "raw bytes\n");
  }

  async function expectTenantTreesIntact(): Promise<void> {
    expect(
      await fs.readFile(abs("tenants", TENANT, "wiki", "existing-page.md"), "utf8"),
    ).toBe("# Page\n");
    expect(await fs.readFile(abs("tenants", TENANT, "raw", "source.txt"), "utf8")).toBe(
      "raw bytes\n",
    );
  }

  /** Every name directly under `tenants/<t>/wikis/`, sorted; [] when absent. */
  async function wikisRootEntries(): Promise<string[]> {
    try {
      return (await fs.readdir(abs("tenants", TENANT, "wikis"))).sort();
    } catch {
      return [];
    }
  }

  /** The raw bytes of all three seeded files, with null for "does not exist". */
  function seededBytes(wikiId: string): Promise<(string | null)[]> {
    return Promise.all(
      ["purpose.md", "schema.md", "workspace-profile.json"].map(async (file) => {
        try {
          return await fs.readFile(path.join(wikiDir(wikiId), file), "utf8");
        } catch {
          return null;
        }
      }),
    );
  }

  // One row per write a create makes, in the order it makes them.
  for (const suffix of [
    "purpose.md",
    "schema.md",
    "workspace-profile.json",
    "wikis.json",
  ]) {
    it(`discards the fresh wiki directory when create faults on ${suffix}`, async () => {
      // A wiki that already exists is the control: compensation is scoped to
      // the id this call minted, so nothing of this one may move.
      const existing = await createWiki(OWNER, { name: "Existing", scenario: "business" });
      // This is the only compensation that issues a RECURSIVE directory delete,
      // so the two tenant-wide trees are controls here even more than on the
      // re-template rows: a `wikiDirPath` that ever lost its `<id>` segment
      // would take the whole tenant with it.
      await seedTenantTrees();
      const registryBefore = await fs.readFile(abs(wikiRegistryPath(OWNER)), "utf8");
      const entriesBefore = await wikisRootEntries();
      const bytesBefore = await seededBytes(existing.id);
      const versionBefore = await readDataVersion();

      const spy = failWritesTo(suffix);
      try {
        await expect(
          createWiki(OWNER, { name: "Doomed", scenario: "reading" }),
        ).rejects.toThrow(FAULT);
      } finally {
        spy.mockRestore();
      }

      // No directory for the attempted id — whether the fault came before the
      // first byte landed or after two files were already written.
      expect(await wikisRootEntries()).toEqual(entriesBefore);
      expect((await listWikis(OWNER)).map((item) => item.id)).toEqual([existing.id]);
      expect((await getWikiRegistry(OWNER)).currentId).toBe(existing.id);
      // The old registry bytes and the other wiki's files are untouched.
      expect(await fs.readFile(abs(wikiRegistryPath(OWNER)), "utf8")).toBe(registryBefore);
      expect(await seededBytes(existing.id)).toEqual(bytesBefore);
      await expectTenantTreesIntact();
      // …and the refresh signal did not move either: the compensation discarded
      // the bytes, so there is nothing new for an open tab to refetch. The bump
      // tail sits after the lock on the SUCCESS path only.
      expect(await readDataVersion()).toBe(versionBefore);
    });
  }

  it("re-throws the seed error, not the cleanup error, when the discard also fails", async () => {
    // Compensation removes wreckage; it must never replace the diagnosis with
    // its own, or the owner is told the directory was busy when what actually
    // broke was the artifact store.
    const write = failWritesTo("schema.md", "the artifact store is unavailable");
    const remove = vi
      .spyOn(getStorage(), "deleteDirectory")
      .mockRejectedValue(new Error("the directory is busy"));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    let warned: unknown[][] = [];
    try {
      await expect(
        createWiki(OWNER, { name: "Doomed", scenario: "reading" }),
      ).rejects.toThrow("the artifact store is unavailable");
      warned = warn.mock.calls.map((call) => [...call]);
    } finally {
      write.mockRestore();
      remove.mockRestore();
      warn.mockRestore();
    }

    expect(
      warned.some(
        ([scope, message]) =>
          scope === "wikis" && String(message).includes("half-created"),
      ),
    ).toBe(true);
    // The bytes stay behind, unnamed by any registry entry — but the failed
    // compensation left a `.discarded` marker on them (DW-162). That marker is
    // the only evidence the sweep has here: this tenant's registry names
    // nothing, so an UNMARKED directory could just as well be a wiki whose
    // wikis.json was lost, and the sweep refuses those.
    expect(await listWikis(OWNER)).toEqual([]);
    const [leftover] = await wikisRootEntries();
    expect(leftover).toBeDefined();
    expect(await exists(path.join(wikiDir(leftover), ".discarded"))).toBe(true);

    // Still inside the grace window, so nothing goes yet — the marker says
    // "unclaimed", the window says "not yet proven settled", and both must hold.
    expect(await sweepOrphanWikiDirectories(OWNER)).toBe(0);
    expect(await wikisRootEntries()).toHaveLength(1);

    // Once it has settled, a scheduled sweep reclaims it with no wiki and no
    // delete anywhere in sight — the DW-162 fix.
    await ageDirectory(wikiDir(leftover));
    expect(await sweepOrphanWikiDirectories(OWNER)).toBe(1);
    expect(await wikisRootEntries()).toEqual([]);
  });

  it("reclaims an UNTOMBSTONED half-create leftover once the tenant owns a wiki", async () => {
    // The documented residual, pinned rather than left to inference: when the
    // marker write fails too — or when the isolate dies before the catch runs
    // at all — the leftovers are exactly as unreclaimable as they were before
    // the tombstone existed. They are not lost, though: the moment the registry
    // names ANY wiki, the empty-registry rule no longer applies and an ordinary
    // sweep takes them.
    const write = failWritesTo(["schema.md", ".discarded"], "the artifact store is unavailable");
    const remove = vi
      .spyOn(getStorage(), "deleteDirectory")
      .mockRejectedValue(new Error("the directory is busy"));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await expect(
        createWiki(OWNER, { name: "Doomed", scenario: "reading" }),
      ).rejects.toThrow("the artifact store is unavailable");
    } finally {
      write.mockRestore();
      remove.mockRestore();
      warn.mockRestore();
    }

    const [leftover] = await wikisRootEntries();
    expect(leftover).toBeDefined();
    expect(await exists(path.join(wikiDir(leftover), ".discarded"))).toBe(false);

    // Empty registry + no marker = no evidence, so it stays however old it is.
    await ageDirectory(wikiDir(leftover));
    expect(await sweepOrphanWikiDirectories(OWNER)).toBe(0);
    expect(await wikisRootEntries()).toEqual([leftover]);

    // A real wiki makes the registry authoritative again, and the leftover is
    // then just an ordinary orphan.
    const keep = await createWiki(OWNER, { name: "Keep", scenario: "business" });
    expect(await sweepOrphanWikiDirectories(OWNER)).toBe(1);
    expect((await wikisRootEntries()).sort()).toEqual([keep.id]);
  });

  it("still re-throws the seed error when the tombstone cannot be written either", async () => {
    // The marker is best-effort by design. Losing it costs reclaimability —
    // the bytes are merely back where they were before it existed — but it must
    // never cost the diagnosis: compensation reports what actually broke.
    const write = failWritesTo(["schema.md", ".discarded"], "the artifact store is unavailable");
    const remove = vi
      .spyOn(getStorage(), "deleteDirectory")
      .mockRejectedValue(new Error("the directory is busy"));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    let warned: unknown[][] = [];
    try {
      await expect(
        createWiki(OWNER, { name: "Doomed", scenario: "reading" }),
      ).rejects.toThrow("the artifact store is unavailable");
      warned = warn.mock.calls.map((call) => [...call]);
    } finally {
      write.mockRestore();
      remove.mockRestore();
      warn.mockRestore();
    }

    expect(
      warned.some(
        ([scope, message]) =>
          scope === "wikis" && String(message).includes("marking half-created"),
      ),
    ).toBe(true);
    // Unmarked, so an empty registry gives the sweep no evidence and the bytes
    // stay — the honest outcome, not a silent deletion.
    const [leftover] = await wikisRootEntries();
    expect(leftover).toBeDefined();
    expect(await exists(path.join(wikiDir(leftover), ".discarded"))).toBe(false);
    await ageDirectory(wikiDir(leftover));
    expect(await sweepOrphanWikiDirectories(OWNER)).toBe(0);
    expect(await wikisRootEntries()).toHaveLength(1);
  });

  // Same four writes, the other caller: here the files already existed, so the
  // undo is a byte restore rather than a directory discard.
  for (const suffix of [
    "purpose.md",
    "schema.md",
    "workspace-profile.json",
    "wikis.json",
  ]) {
    it(`restores all three files when a re-template faults on ${suffix}`, async () => {
      // A bystander wiki (created FIRST, so the target stays current) and the
      // two tenant-wide trees are the blast-radius controls: this is the first
      // code on the seed path that DELETES files, and the compensation must
      // reach nothing but the three files it snapshotted.
      const bystander = await createWiki(OWNER, { name: "Bystander", scenario: "research" });
      const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
      await seedTenantTrees();

      const bytesBefore = await seededBytes(wiki.id);
      const bystanderBefore = await seededBytes(bystander.id);
      const registryBefore = await fs.readFile(abs(wikiRegistryPath(OWNER)), "utf8");
      const versionBefore = await readDataVersion();

      const spy = failWritesTo(suffix);
      let warned: unknown[][] = [];
      try {
        warned = await warnsDuring(async () => {
          await expect(applyScenarioTemplate(OWNER, wiki.id, "reading")).rejects.toThrow(
            FAULT,
          );
        });
      } finally {
        spy.mockRestore();
      }

      // Every restore this row needed LANDED. Without this the row is satisfied
      // by a compensation that failed on every file: on the rows where the seed
      // never got past the faulting write there is nothing to put back anyway,
      // so silence is what separates "restored" from "never overwritten".
      expect(warned.filter(([scope]) => scope === "wikis")).toEqual([]);
      // Byte-identical, not merely equivalent: a re-seed through
      // `putWorkspaceProfile` would re-stamp `updatedAt` and still leave the
      // file different from what the owner had.
      expect(await seededBytes(wiki.id)).toEqual(bytesBefore);
      expect(await fs.readFile(abs(wikiRegistryPath(OWNER)), "utf8")).toBe(registryBefore);
      expect((await getCurrentWiki(OWNER))?.scenario).toBe("business");
      // …so the Schema and the profile still describe ONE template.
      expect(await readWikiArtifact(OWNER, wiki.id, "schema.md")).toContain(
        "### Scenario conventions — Business",
      );
      expect((await getWorkspaceProfile(OWNER, wiki.id)).scenario).toBe("business");
      // Nothing outside this wiki's own directory moved.
      expect(await seededBytes(bystander.id)).toEqual(bystanderBefore);
      await expectTenantTreesIntact();
      // Including the refresh signal — the restore put the OLD bytes back, so
      // telling an open Preview to refetch would be churn at best and, on the
      // `warned` assertion above, a second story's bug at worst.
      expect(await readDataVersion()).toBe(versionBefore);
    });
  }

  it("snapshots exactly the files the seed goes on to write", async () => {
    // `seededFilePaths` derives from `WIKI_ARTIFACT_FILES` while
    // `seedWikiArtifacts` spells its writes out one call at a time, so the two
    // can drift: a fourth seeded file added to the seeder alone would be
    // overwritten with nothing to put it back, and every fault row above would
    // still pass, because each only looks at the three files it already knows
    // about. This compares the SETS on a successful re-template.
    //
    // The snapshot is every read that happens BEFORE the first write — that
    // boundary is the point. `putWorkspaceProfile` reads the profile itself
    // just before writing it, so a plain reads-vs-writes comparison stays
    // green even with the profile dropped from the snapshot entirely.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const dir = `${wikiDirPath(OWNER, wiki.id)}/`;
    const storage = getStorage();
    const readFile = storage.readFile.bind(storage);
    const writeFile = storage.writeFile.bind(storage);
    const calls: { op: "read" | "write"; target: string }[] = [];
    const reads = vi
      .spyOn(storage, "readFile")
      .mockImplementation(async (target: string) => {
        calls.push({ op: "read", target });
        return readFile(target);
      });
    const writes = vi
      .spyOn(storage, "writeFile")
      .mockImplementation(async (target: string, content: string) => {
        calls.push({ op: "write", target });
        return writeFile(target, content);
      });

    try {
      expect(await applyScenarioTemplate(OWNER, wiki.id, "reading")).not.toBeNull();
    } finally {
      reads.mockRestore();
      writes.mockRestore();
    }

    const firstWrite = calls.findIndex((call) => call.op === "write");
    // The HISTORY namespace is deliberately outside this comparison (DW-213).
    // `revisions/<file>/<ts>.md` and its sidecar are writes with no pre-seed
    // read of their own BY CONSTRUCTION: they replay bytes the snapshot already
    // holds, land only after the seed and the registry write have COMMITTED,
    // and are never restored by the compensation this test is about. Counted
    // in, they would make the seeded set look permanently out of balance and
    // hide the drift the assertion exists to catch. `wikiArtifactRevisionsDir`'s
    // own parity is `wiki-artifact-revisions.test.ts`'s.
    const history = `${dir}revisions/`;
    const inDir = (subset: typeof calls, op: "read" | "write") =>
      [
        ...new Set(
          subset
            .filter(
              (call) =>
                call.op === op &&
                call.target.startsWith(dir) &&
                !call.target.startsWith(history),
            )
            .map((call) => call.target),
        ),
      ].sort();

    expect(inDir(calls.slice(0, firstWrite), "read")).toEqual(inDir(calls, "write"));
    // …and the exclusion is PAIRED with what it excludes, or it would be a
    // blind spot rather than a scope. This re-template is the path that DOES
    // record history, so the namespace must have been written to — the
    // assertion above passing because nothing landed there would be the same
    // green for a snapshot that stopped happening entirely.
    expect(calls.some((call) => call.op === "write" && call.target.startsWith(history))).toBe(
      true,
    );
  });

  it("writes NOTHING under the revisions namespace on the CREATE path", async () => {
    // The other half of the exclusion above. DW-213 records history for a
    // COMMITTED RE-TEMPLATE only: a create overwrote nothing — the id came from
    // `crypto.randomUUID()` moments earlier — so a revision there would be a
    // snapshot of bytes that never existed, and its undo is
    // `discardCreatedWikiDirectory`, not a restore. With the parity comparison
    // above no longer looking at that subtree, this is what would notice a
    // snapshot that leaked onto the seeder.
    const storage = getStorage();
    const writeFile = storage.writeFile.bind(storage);
    const targets: string[] = [];
    const writes = vi
      .spyOn(storage, "writeFile")
      .mockImplementation(async (target: string, content: string) => {
        targets.push(target);
        return writeFile(target, content);
      });

    let wiki: WikiRecord;
    try {
      wiki = await createWiki(OWNER, { name: "Fresh", scenario: "reading" });
    } finally {
      writes.mockRestore();
    }

    expect(targets.some((target) => target.includes("/revisions/"))).toBe(false);
    await expect(
      fs.stat(abs(`${wikiDirPath(OWNER, wiki.id)}/revisions`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores the other two files when one file's restore also fails", async () => {
    // The restore loop attempts each entry INDEPENDENTLY. Bailing out on the
    // first failure would leave the files after it on the new template while
    // the ones before it went back to the old — the compensation itself
    // recreating the two-templates-in-one-wiki state it exists to prevent.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const [purposeBefore, schemaBefore, profileBefore] = await seededBytes(wiki.id);

    const storage = getStorage();
    const write = storage.writeFile.bind(storage);
    let purposeWrites = 0;
    const spy = vi
      .spyOn(storage, "writeFile")
      .mockImplementation(async (target: string, content: string) => {
        // The registry write faults, so the seed has already overwritten all
        // three files by the time the compensation runs.
        if (target.endsWith("wikis.json")) return Promise.reject(new Error(FAULT));
        if (target.endsWith("purpose.md")) {
          purposeWrites += 1;
          // The SEED's write lands and the RESTORE's write is what fails —
          // purpose.md is first in the loop, so a `break` there would strand
          // schema.md and the profile on the reading template.
          if (purposeWrites > 1) {
            return Promise.reject(new Error("the artifact store is unavailable"));
          }
        }
        return write(target, content);
      });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    let warned: unknown[][] = [];
    try {
      await expect(applyScenarioTemplate(OWNER, wiki.id, "reading")).rejects.toThrow(
        FAULT,
      );
      warned = warn.mock.calls.map((call) => [...call]);
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }

    const [purposeAfter, schemaAfter, profileAfter] = await seededBytes(wiki.id);
    // The two the loop had to carry on to are back to the business bytes.
    expect(schemaAfter).toBe(schemaBefore);
    expect(profileAfter).toBe(profileBefore);
    // The blocked one is the injected damage, not a second defect — and it is
    // exactly what the warn is for.
    expect(purposeAfter).not.toBe(purposeBefore);
    expect(
      warned.some(
        ([scope, message]) =>
          scope === "wikis" && String(message).includes("purpose.md"),
      ),
    ).toBe(true);
  });

  it("seeds nothing at all when the pre-seed snapshot cannot be read", async () => {
    // The snapshot is the ONE step in the compensation that is not fail-soft,
    // and it must stay that way. Degrading an unreadable file to "absent"
    // would make a later restore DELETE the owner's schema.md; warning and
    // seeding anyway would overwrite it with no way back. The snapshot runs
    // before the first write, so throwing costs only the operation.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const bytesBefore = await seededBytes(wiki.id);
    const registryBefore = await fs.readFile(abs(wikiRegistryPath(OWNER)), "utf8");

    const storage = getStorage();
    const read = storage.readFile.bind(storage);
    const reads = vi
      .spyOn(storage, "readFile")
      .mockImplementation(async (target: string) =>
        target.endsWith("schema.md")
          ? Promise.reject(new Error("the artifact store is unreadable"))
          : read(target),
      );
    const writes = vi.spyOn(storage, "writeFile");

    let writeTargets: string[] = [];
    try {
      await expect(applyScenarioTemplate(OWNER, wiki.id, "reading")).rejects.toThrow(
        "the artifact store is unreadable",
      );
      writeTargets = writes.mock.calls.map(([target]) => String(target));
    } finally {
      reads.mockRestore();
      writes.mockRestore();
    }

    // Not "restored" — never written. The read failure is surfaced verbatim.
    expect(writeTargets).toEqual([]);
    expect(await seededBytes(wiki.id)).toEqual(bytesBefore);
    expect(await fs.readFile(abs(wikiRegistryPath(OWNER)), "utf8")).toBe(registryBefore);
    expect((await getCurrentWiki(OWNER))?.scenario).toBe("business");
  });

  it("deletes the profile again when the wiki had none before the re-template", async () => {
    // "Did not exist" restores as a DELETE. Leaving the new template's profile
    // (or an empty file) beside the old template's schema.md is exactly the
    // two-templates-in-one-wiki state DW-143 names.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const profile = path.join(wikiDir(wiki.id), "workspace-profile.json");
    await fs.rm(profile);
    const bytesBefore = await seededBytes(wiki.id);

    const spy = failWritesTo("wikis.json");
    try {
      await expect(applyScenarioTemplate(OWNER, wiki.id, "reading")).rejects.toThrow(
        FAULT,
      );
    } finally {
      spy.mockRestore();
    }

    expect(await exists(profile)).toBe(false);
    expect(await seededBytes(wiki.id)).toEqual(bytesBefore);
    expect((await getCurrentWiki(OWNER))?.scenario).toBe("business");
  });

  it("tolerates the missing profile silently when the seed never wrote one", async () => {
    // The other half of "did not exist restores as a delete": here the seed
    // faults BEFORE `putWorkspaceProfile`, so the undo's `deleteFile` finds
    // nothing and its ENOENT is the expected outcome rather than a failure.
    // Dropping the `isEnoent` guard leaves every byte assertion passing — the
    // only symptom is a warn saying this wiki may now describe two templates,
    // about a compensation that in fact succeeded completely. That warn is the
    // one signal an operator would use to decide whether a wiki is damaged, so
    // silence is the assertion.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const profile = path.join(wikiDir(wiki.id), "workspace-profile.json");
    await fs.rm(profile);
    const bytesBefore = await seededBytes(wiki.id);

    const spy = failWritesTo("purpose.md");
    let warned: unknown[][] = [];
    try {
      warned = await warnsDuring(async () => {
        await expect(applyScenarioTemplate(OWNER, wiki.id, "reading")).rejects.toThrow(
          FAULT,
        );
      });
    } finally {
      spy.mockRestore();
    }

    expect(warned.filter(([scope]) => scope === "wikis")).toEqual([]);
    expect(await exists(profile)).toBe(false);
    expect(await seededBytes(wiki.id)).toEqual(bytesBefore);
    expect((await getCurrentWiki(OWNER))?.scenario).toBe("business");
  });

  it("re-throws the registry error, not the restore error, when the restore also fails", async () => {
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    await fs.rm(path.join(wikiDir(wiki.id), "workspace-profile.json"));

    const write = failWritesTo("wikis.json", "the registry store is unavailable");
    // The profile's undo is a delete, so this is the restore step failing with
    // something other than the ENOENT the restore already tolerates.
    const remove = vi
      .spyOn(getStorage(), "deleteFile")
      .mockRejectedValue(new Error("the file is locked"));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    let warned: unknown[][] = [];
    try {
      await expect(applyScenarioTemplate(OWNER, wiki.id, "reading")).rejects.toThrow(
        "the registry store is unavailable",
      );
      warned = warn.mock.calls.map((call) => [...call]);
    } finally {
      write.mockRestore();
      remove.mockRestore();
      warn.mockRestore();
    }

    expect(
      warned.some(
        ([scope, message]) => scope === "wikis" && String(message).includes("restoring"),
      ),
    ).toBe(true);
    // The registry never moved, so the wiki is still on its old template.
    expect((await getCurrentWiki(OWNER))?.scenario).toBe("business");
  });
});
