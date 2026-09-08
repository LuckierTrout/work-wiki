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
import { readEnginePageConventions } from "../schema-source";
import { _resetStorage, getStorage } from "../storage";
import {
  renderPurposeMarkdown,
  renderSchemaMarkdown,
  scenarioTemplate,
} from "../wiki-scenarios";
import { tenantForOwner } from "../wiki";
import { wikiDirPath, wikiLockKey } from "../wiki-paths";
import { buildWorkspaceGuidance } from "../workspace-guidance";
import { getWorkspaceProfile } from "../workspace-profile";
import {
  ARTIFACT_AUTHORITY_VERSION,
  renderCanonicalPurposeMarkdown,
} from "../workspace-purpose";
import { WORKSPACE_SCENARIO_TEMPLATES } from "../workspace-profile-schema";
import {
  MAX_WIKIS,
  ORPHAN_SWEEP_CANDIDATE_CAP,
  ORPHAN_SWEEP_GRACE_MS,
  ORPHAN_SWEEP_ROTATION_MS,
  _resetWikiSweepWarnings,
  applyScenarioTemplate,
  createWiki,
  deleteWiki,
  getCurrentWiki,
  getWikiRegistry,
  listWikis,
  parseCreateWikiInput,
  parseRenameWikiInput,
  parseScenarioInput,
  readEffectiveWikiArtifact,
  readWikiArtifact,
  reconcileWikiScenarioDrift,
  renameWiki,
  setCurrentWiki,
  sweepOrphanWikiDirectories,
  wikiArtifactPath,
  wikiRegistryPath,
  writeWikiArtifact,
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
  // TWO warn-once records, both module-global across the suite's lifetime: the
  // future-dated orphan-sweep skip (DW-483) and the Scenario Template
  // contradiction the reconciler names (DW-735). Without this reset the first
  // row to assert either one would silence it for every row after — and the
  // COUNT is exactly what those rows are about.
  _resetWikiSweepWarnings();
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
 * EVERY ROW STARTS FROM A NON-ZERO COUNTER. `beforeEach` mints a fresh
 * `DATA_DIR`, so an unseeded counter reads `0` — and `0` is also what
 * `readDataVersion` answers when the store is unreadable. A `before` of `0`
 * would let "bumps once" pass against an implementation that just STORES `1`,
 * and let the "does not bump" rows pass against a counter that is failing open.
 */
describe("create, re-template, rename and switch move the refresh signal (DW-49, DW-57, DW-209, DW-518)", () => {
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

  it("bumps exactly once per switch, which is the only signal another tab gets", async () => {
    const first = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const second = await createWiki(OWNER, { name: "Reading", scenario: "reading" });
    // A create makes its own Wiki current, so `first` is NOT current here.
    expect((await getWikiRegistry(OWNER)).currentId).toBe(second.id);
    const before = await readDataVersion();
    expect(before).toBeGreaterThan(0); // the creates' own bumps

    expect((await setCurrentWiki(OWNER, first.id))?.id).toBe(first.id);

    // The pointer really moved — so the bump below is not being earned by a
    // no-op switch back to the Wiki that was already current.
    expect((await getWikiRegistry(OWNER)).currentId).toBe(first.id);
    // Once, and this counter is the ONLY thing a SECOND open tab can see: the
    // switcher's `router.refresh()` reaches only the tab that drove the switch,
    // while every `purpose.md`/`schema.md` read now resolves against a
    // different Wiki (DW-518).
    expect(await readDataVersion()).toBe(before + 1);
  });

  it("does not bump for a switch to an unknown wiki id", async () => {
    const ops = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const before = await readDataVersion();
    expect(before).toBeGreaterThan(0); // so "unchanged" is not "still zero"

    expect(
      await setCurrentWiki(OWNER, "00000000-0000-4000-8000-000000000000"),
    ).toBeNull();

    // The locked body returns before its write, so `current` never moved and
    // there is nothing new for any tab to resolve against — both halves
    // asserted, because "did not bump" is only meaningful if the pointer really
    // did stay put.
    expect((await getWikiRegistry(OWNER)).currentId).toBe(ops.id);
    expect(await readDataVersion()).toBe(before);
  });

  // -------------------------------------------------------------------------
  // The counter store is down
  // -------------------------------------------------------------------------

  /**
   * WHOSE warning to assert on, and why it is not the callers'.
   *
   * `bumpDataVersion` wraps its ENTIRE body, so a rejecting `putIndex` makes it
   * answer `0` rather than throw — which means the `try/catch` inside
   * `bumpRefreshSignal` never runs and its "the refresh signal did not move
   * after …" wording never reaches the log. Every writer in `wikis.ts` reaches
   * the counter through that one helper — eight call sites across seven
   * writers today — so there is a single `catch`, kept deliberately as
   * redundant defence in case `bumpDataVersion` ever stops swallowing; it is
   * unreachable today.
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

  it("still resolves a switch when the counter store rejects putIndex", async () => {
    const first = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    await createWiki(OWNER, { name: "Reading", scenario: "reading" });
    const before = await readDataVersion();
    expect(before).toBeGreaterThan(0);

    const putIndex = vi
      .spyOn(getStorage(), "putIndex")
      .mockRejectedValue(new Error("kv is gone"));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    let switched: WikiRecord | null;
    let warned: unknown[][] = [];
    try {
      switched = await setCurrentWiki(OWNER, first.id);
      warned = warn.mock.calls.map((call) => [...call]);
    } finally {
      warn.mockRestore();
      putIndex.mockRestore();
    }

    // `wikis.json` was written before the tail ran, so the switch landed…
    expect(switched?.id).toBe(first.id);
    expect((await getWikiRegistry(OWNER)).currentId).toBe(first.id);
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
  it("rewrites Purpose and Schema while preserving profile evidence, Pages and Sources", async () => {
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const businessPurpose = await readWikiArtifact(OWNER, wiki.id, "purpose.md");
    const businessSchema = await readWikiArtifact(OWNER, wiki.id, "schema.md");
    const profileBefore = await profileBytes(wiki.id);

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
    expect(await profileBytes(wiki.id)).toBe(profileBefore);
    expect((await getWorkspaceProfile(OWNER, wiki.id)).scenario).toBe("business");

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

  it("writes only wikis.json among tenant files — a switch overwrites no Purpose or profile (DW-21)", async () => {
    const business = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const reading = await createWiki(OWNER, { name: "Shelf", scenario: "reading" });

    await writeWikiArtifact(
      OWNER,
      business.id,
      "purpose.md",
      "# Ops\n\nHand-authored: the Phoenix decision record.\n",
    );
    const before = await Promise.all(
      [business.id, reading.id].map(async (id) => ({
        profile: await profileBytes(id),
        purpose: await readWikiArtifact(OWNER, id, "purpose.md"),
      })),
    );
    const registryBefore = await fs.readFile(abs(wikiRegistryPath(OWNER)), "utf8");

    await setCurrentWiki(OWNER, business.id);

    expect(
      await Promise.all(
        [business.id, reading.id].map(async (id) => ({
          profile: await profileBytes(id),
          purpose: await readWikiArtifact(OWNER, id, "purpose.md"),
        })),
      ),
    ).toEqual(before);
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
    await writeWikiArtifact(
      OWNER,
      first.id,
      "purpose.md",
      "# Ops\n\nHand-authored: the Phoenix decision record.\n",
    );
    const authored = await readWikiArtifact(OWNER, first.id, "purpose.md");

    const second = await createWiki(OWNER, { name: "Shelf", scenario: "reading" });
    expect(await readWikiArtifact(OWNER, first.id, "purpose.md")).toBe(authored);
    expect((await getWorkspaceProfile(OWNER, second.id)).scenario).toBe("reading");

    await applyScenarioTemplate(OWNER, second.id, "research");
    expect(await readWikiArtifact(OWNER, first.id, "purpose.md")).toBe(authored);
    expect((await getWorkspaceProfile(OWNER, second.id)).scenario).toBe("reading");
    expect(await readWikiArtifact(OWNER, second.id, "purpose.md")).toContain(
      "Scenario Template: Research",
    );

    // And it is still what Settings would show once that wiki is active again.
    await setCurrentWiki(OWNER, first.id);
    expect(await buildWorkspaceGuidance(OWNER)).toContain("Hand-authored");
  });

  it("makes a Purpose save wait on the Wiki lock, not a second key (DW-22)", async () => {
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
    const save = writeWikiArtifact(
      OWNER,
      wiki.id,
      "purpose.md",
      "# Ops\n\nPurpose save racing the re-template.\n",
    ).then(() => {
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
    expect((await getWorkspaceProfile(OWNER, wiki.id)).scenario).toBe("business");
    expect(await readWikiArtifact(OWNER, wiki.id, "purpose.md")).toContain(
      WORKSPACE_SCENARIO_TEMPLATES.reading.purpose,
    );
    expect(await readWikiArtifact(OWNER, wiki.id, "schema.md")).toContain(
      "### Scenario conventions — Reading",
    );
    // The profile is intentionally non-live evidence; the two canonical files
    // are wholly from the later template operation, never a blend.
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
 *
 * A NEGATIVE `ageMs` IS A FUTURE DATE, and load-bearing: the subtraction below
 * runs unchanged, so `-ORPHAN_SWEEP_GRACE_MS * 4` stamps the tree four grace
 * windows AHEAD of now. Every DW-290 and DW-483 row addresses the future-dated
 * branch that way; {@link stampDirectory} is the one to reach for when the row
 * needs the SAME future instant twice.
 */
async function ageDirectory(
  dir: string,
  ageMs = ORPHAN_SWEEP_GRACE_MS * 2,
): Promise<void> {
  await stampDirectory(dir, new Date(Date.now() - ageMs));
}

/**
 * Stamp every mtime under `dir` (and the directory's own) at `when` EXACTLY.
 *
 * {@link ageDirectory} is relative to `Date.now()`, and until this existed it
 * re-read that clock at EVERY level of its own recursion — so a single call
 * left a nested tree holding several distinct mtimes, and two calls with the
 * same offset were further apart still. None of that matters to a row that only
 * asks which side of a threshold an age falls on, and all of it matters to one
 * asking whether a LATER pass read the SAME instant, which is precisely the
 * DW-483 dedupe key. Hoisting the resolved `when` up here fixes both: one clock
 * reading per call, and an exact instant the caller can name twice.
 */
async function stampDirectory(dir: string, when: Date): Promise<void> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) await stampDirectory(child, when);
    else await fs.utimes(child, when, when);
  }
  // The directory itself LAST: it is the fallback when a candidate holds no
  // files at all, and writing a child would have bumped it again.
  await fs.utimes(dir, when, when);
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
    const before = await readDataVersion();
    expect(before).toBeGreaterThan(0); // so "moved" below is not "left zero"

    const removal = vi
      .spyOn(getStorage(), "deleteDirectory")
      .mockRejectedValue(new Error("the directory is busy"));
    try {
      expect((await deleteWiki(OWNER, drop.id))?.id).toBe(drop.id);
    } finally {
      removal.mockRestore();
    }

    expect((await listWikis(OWNER)).map((item) => item.id)).toEqual([keep.id]);
    // …AND the signal still moved (DW-382). The registry entry is gone, and
    // that is what every list, switcher and id lookup in the app reads, so
    // there IS something new to refetch even though the bytes are still on
    // disk. Without this assertion the tail could be moved inside the locked
    // body or guarded on the directory removal having succeeded, and every
    // other row here would stay green — the same hole the rename suite closes
    // with "bumps a rename whose purpose.md retitle failed".
    expect(await readDataVersion()).toBe(before + 1);
    // The bytes are still there — deliberately, for the next sweep to reclaim.
    expect(await exists(wikiDir(drop.id))).toBe(true);
    await ageDirectory(wikiDir(drop.id));
    expect(await sweepOrphanWikiDirectories(OWNER)).toBe(1);
    expect(await exists(wikiDir(drop.id))).toBe(false);
    expect(await exists(wikiDir(keep.id))).toBe(true);
  });

  it("bumps the refresh signal exactly once (DW-382)", async () => {
    // A delete moves no `currentWikiId` — the current wiki is undeletable — so
    // the Workbench's selection-reset effect never fires and this counter is the
    // only thing that can tell ANOTHER client's open tab that a wiki and its
    // artifacts are gone. Without it that tab goes on listing bytes that no
    // longer exist until the owner reloads.
    const keep = await createWiki(OWNER, { name: "Keep", scenario: "business" });
    const drop = await createWiki(OWNER, { name: "Drop", scenario: "reading" });
    await setCurrentWiki(OWNER, keep.id);
    const before = await readDataVersion();
    // Two creates already lifted it off zero, so `before + 1` below is
    // arithmetic on a stored value rather than a literal an implementation that
    // simply stores `1` would also satisfy.
    expect(before).toBeGreaterThan(0);

    expect((await deleteWiki(OWNER, drop.id))?.id).toBe(drop.id);

    // Once, not once per removed file: the registry write and the directory
    // removal both happened, and the signal is monotonic.
    expect(await readDataVersion()).toBe(before + 1);
  });

  it("does not bump for an unknown id or for the refused current wiki", async () => {
    const first = await createWiki(OWNER, { name: "One", scenario: "business" });
    const second = await createWiki(OWNER, { name: "Two", scenario: "reading" });
    const before = await readDataVersion();
    expect(before).toBeGreaterThan(0); // so "unchanged" is not "still zero"

    // The locked body returns before its first write…
    expect(await deleteWiki(OWNER, "00000000-0000-4000-8000-000000000000")).toBeNull();
    // …and the current-wiki refusal throws before it too.
    await expect(deleteWiki(OWNER, second.id)).rejects.toThrow(ClientInputError);

    expect(await readDataVersion()).toBe(before);
    expect((await listWikis(OWNER)).map((item) => item.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it("still reports success when the counter store rejects putIndex", async () => {
    // The tail is fail-soft for the same reason the two byte-removal steps are:
    // the registry write has landed, so the wiki is gone from every read in the
    // app, and a counter hiccup must not send the owner into a retry that 404s.
    const keep = await createWiki(OWNER, { name: "Keep", scenario: "business" });
    const drop = await createWiki(OWNER, { name: "Drop", scenario: "reading" });
    await setCurrentWiki(OWNER, keep.id);
    const before = await readDataVersion();
    expect(before).toBeGreaterThan(0);

    const putIndex = vi
      .spyOn(getStorage(), "putIndex")
      .mockRejectedValue(new Error("kv is gone"));
    try {
      expect((await deleteWiki(OWNER, drop.id))?.id).toBe(drop.id);
    } finally {
      putIndex.mockRestore();
    }

    // The delete resolved and both halves of it landed…
    expect((await listWikis(OWNER)).map((item) => item.id)).toEqual([keep.id]);
    expect(await exists(wikiDir(drop.id))).toBe(false);
    // …while the signal genuinely did NOT move — read from the store, not
    // inferred from the mock having been called.
    expect(await readDataVersion()).toBe(before);
  });
});

describe("the orphan-directory sweep", () => {
  /** A `wikis/<uuid>/` directory with artifacts and no registry entry. */
  async function plantOrphan(id: string): Promise<string> {
    await fs.mkdir(wikiDir(id), { recursive: true });
    await fs.writeFile(path.join(wikiDir(id), "purpose.md"), "# Orphan\n");
    return wikiDir(id);
  }

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

  it("skips a candidate whose per-file mtime cannot be represented as a date (DW-674)", async () => {
    // The THIRD way an age goes unread, and the quiet one: the listing succeeds
    // AND the `stat` resolves — it just answers with a date this isolate cannot
    // use. A dropped-and-continue would have left `newest` holding the readable
    // sibling FILE's mtime, which is aged, so the directory would be deleted on
    // the strength of an age nothing ever read. Unusable is unknown, and unknown
    // poisons the whole answer exactly as the depth bound does.
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const unreadable = await plantOrphan("aaaaaaaa-8888-4888-8888-888888888888");
    // A second file, and it is stamped SEPARATELY at a distinctly older instant.
    // `stampDirectory` puts every file and the directory itself on ONE mtime, so
    // "the sibling is older" is only true if it is stamped on its own — and the
    // gap is what makes the row fail against a walk that keeps the best age it
    // happened to see rather than refusing to answer.
    const sibling = path.join(unreadable, "schema.md");
    await fs.writeFile(sibling, "# Orphan schema\n");
    const readable = await plantOrphan("aaaaaaaa-9999-4999-8999-999999999999");
    await ageDirectory(unreadable);
    await ageDirectory(readable);
    const older = new Date(Date.now() - ORPHAN_SWEEP_GRACE_MS * 8);
    await fs.utimes(sibling, older, older);

    const storage = getStorage();
    const stat = storage.stat.bind(storage);
    const spy = vi
      .spyOn(storage, "stat")
      .mockImplementation(async (target: string) => {
        if (target.endsWith("aaaaaaaa-8888-4888-8888-888888888888/purpose.md")) {
          return { ...(await stat(target)), lastModified: new Date(NaN) };
        }
        return stat(target);
      });
    try {
      // The readable orphan beside it is still reclaimed: one unusable age
      // poisons ITS OWN candidate, never the pass.
      expect(await sweepOrphanWikiDirectories(OWNER)).toBe(1);
    } finally {
      spy.mockRestore();
    }

    expect(await exists(unreadable)).toBe(true);
    expect(await exists(readable)).toBe(false);
  });

  it("warns that an unrepresentable mtime made the age unreadable (DW-674)", async () => {
    // The operator-facing half: the sweep says the same sentence it says for a
    // `stat` that threw, because from the age gate's side they are the same
    // non-answer — "could not read the age", never "the directory is young".
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const unreadable = await plantOrphan("aaaaaaaa-8181-4818-8818-818181818181");
    await ageDirectory(unreadable);

    const storage = getStorage();
    const stat = storage.stat.bind(storage);
    const spy = vi
      .spyOn(storage, "stat")
      .mockImplementation(async (target: string) => {
        if (target.includes("aaaaaaaa-8181-4818-8818-818181818181")) {
          return { ...(await stat(target)), lastModified: new Date(NaN) };
        }
        return stat(target);
      });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await sweepOrphanWikiDirectories(OWNER)).toBe(0);
      expect(
        warn.mock.calls.filter(
          ([scope, message]) =>
            scope === "wikis" &&
            String(message).includes("could not read the age of wiki directory") &&
            String(message).includes("treating it as too young to sweep"),
        ),
      ).toHaveLength(1);
    } finally {
      warn.mockRestore();
      spy.mockRestore();
    }

    expect(await exists(unreadable)).toBe(true);
  });

  /**
   * A `stat` that RESOLVES for every path under `id` but answers with
   * `lastModified`, leaving every other path alone. `Date` is the declared type,
   * so a finite-but-out-of-range instant has to arrive as a stub with its own
   * `getTime` — no real `Date` past ±8.64e15 has one (they are all NaN).
   */
  function statAnswers(id: string, lastModified: Date) {
    const storage = getStorage();
    const stat = storage.stat.bind(storage);
    return vi
      .spyOn(storage, "stat")
      .mockImplementation(async (target: string) =>
        target.includes(id) ? { ...(await stat(target)), lastModified } : stat(target),
      );
  }

  /** Finite, ordered, older than any cutoff — and unrenderable by `toISOString`. */
  function outOfRangeDate(): Date {
    return Object.assign(new Date(0), { getTime: () => -1e16 });
  }

  /** How many "could not read the age" lines `run` emitted. */
  async function ageWarningsDuring(run: () => Promise<void>): Promise<number> {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await run();
      return warn.mock.calls.filter(
        ([scope, message]) =>
          scope === "wikis" &&
          String(message).includes("could not read the age of wiki directory") &&
          String(message).includes("treating it as too young to sweep"),
      ).length;
    } finally {
      warn.mockRestore();
    }
  }

  it("skips a file-less candidate whose directory mtime cannot be represented (DW-674)", async () => {
    // The fallback arm of the same predicate. The row above it — "sweeps an
    // aged orphan that holds no files at all" — proves this fallback is the
    // ONLY thing that can age a bare directory, so an unusable answer from it
    // leaves nothing else to fall back to and the directory must stay.
    //
    // NaN is what a real provider can actually produce (an `Invalid Date`), and
    // `Number.isFinite` already rejected it, so the SKIP here is not new. What
    // is new is that the skip now SPEAKS: this exit used to return null in
    // silence, which made `sweepOrphans`' "newestWriteTime already warned" false
    // for a directory that can never be reclaimed while the condition holds.
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const bare = wikiDir("aaaaaaaa-1111-4111-8111-111111111111");
    await fs.mkdir(bare, { recursive: true });
    await ageDirectory(bare);

    const spy = statAnswers("aaaaaaaa-1111-4111-8111-111111111111", new Date(NaN));
    try {
      expect(
        await ageWarningsDuring(async () => {
          expect(await sweepOrphanWikiDirectories(OWNER)).toBe(0);
        }),
      ).toBe(1);
    } finally {
      spy.mockRestore();
    }

    expect(await exists(bare)).toBe(true);
  });

  it("skips a file-less candidate whose directory mtime is finite but out of range (DW-674)", async () => {
    // THE FALLBACK'S RANGE HALF, which is the only behaviour the predicate adds
    // at this site: `Number.isFinite` accepted this value and the directory was
    // reclaimed on an age `toISOString()` cannot even print. Nothing we ship can
    // produce it — `stat` types `lastModified` as a real `Date` — so the stub
    // stands in for a future provider that builds the value some other way. The
    // row exists because the future-dated warn RENDERS this number, so "usable"
    // has to mean renderable, not merely comparable.
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const bare = wikiDir("aaaaaaaa-3333-4333-8333-333333333333");
    await fs.mkdir(bare, { recursive: true });
    await ageDirectory(bare);

    const spy = statAnswers("aaaaaaaa-3333-4333-8333-333333333333", outOfRangeDate());
    try {
      expect(
        await ageWarningsDuring(async () => {
          expect(await sweepOrphanWikiDirectories(OWNER)).toBe(0);
        }),
      ).toBe(1);
    } finally {
      spy.mockRestore();
    }

    expect(await exists(bare)).toBe(true);
  });

  it("skips a candidate whose per-file mtime is finite but outside Date's range (DW-674)", async () => {
    // The same range half at the WALK site, where the value would have been
    // compared, kept as `newest`, and then handed to the age gate.
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const orphan = await plantOrphan("aaaaaaaa-2222-4222-8222-222222222222");
    await ageDirectory(orphan);

    const spy = statAnswers("aaaaaaaa-2222-4222-8222-222222222222", outOfRangeDate());
    try {
      expect(await sweepOrphanWikiDirectories(OWNER)).toBe(0);
    } finally {
      spy.mockRestore();
    }

    expect(await exists(orphan)).toBe(true);
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

  it("considers at most the per-pass cap and defers the rest to a later pass (DW-289)", async () => {
    // The whole walk — `newestWriteTime` per candidate, the tombstone probe,
    // `deleteDirectory` — runs while `wikis:<tenant>` is HELD, so every create,
    // rename and delete for this tenant queues behind it. Uncapped, the length
    // of that queue is set by however many orphan directories happen to exist.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const OVERFLOW = 3;
    const planted: string[] = [];
    // THE CLOCK IS PINNED because this row plants MORE than the cap, so
    // `rotatingSweepWindow` actually chooses a window — and which one it hands
    // this pass is a function of the UTC day (DW-383). Left on the real clock,
    // which `cap` of the `cap + 3` are reclaimed first depends on the date the
    // suite happens to run (DW-485). `Date` alone is faked, so the file lock's
    // own `setTimeout` waits stay real, and it is set BEFORE the planting so
    // `ageDirectory` and the sweep read the same clock.
    vi.useFakeTimers({ toFake: ["Date"] });
    const day0 = Date.UTC(2026, 4, 20, 6, 0, 0);
    try {
      vi.setSystemTime(day0);
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
            String(message).includes(`deferring ${OVERFLOW} to a later UTC day`),
        ),
      ).toBe(true);

      // Continuation needs no cursor: removal IS the progress, so the next pass
      // starts on a listing the reclaimed directories are already gone from.
      expect(await sweepOrphanWikiDirectories(OWNER)).toBe(OVERFLOW);
      for (const dir of planted) expect(await exists(dir)).toBe(false);
      // …and the real wiki was never a candidate at any point.
      expect(await exists(wikiDir(wiki.id))).toBe(true);
      expect(await sweepOrphanWikiDirectories(OWNER)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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
      warned.some(([, message]) => String(message).includes("deferring")),
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
    // Pinned for the same reason as the row above: more than the cap is planted,
    // so `rotatingSweepWindow` picks a window and the real calendar date would
    // otherwise decide which `cap` of them got probed (DW-485).
    vi.useFakeTimers({ toFake: ["Date"] });
    const day0 = Date.UTC(2026, 4, 20, 6, 0, 0);
    try {
      vi.setSystemTime(day0);
      for (let index = 0; index < ORPHAN_SWEEP_CANDIDATE_CAP + OVERFLOW; index += 1) {
        const dir = await plantOrphan(
          `cccccccc-0000-4000-8000-${String(index).padStart(12, "0")}`,
        );
        // Aged INSIDE the grace window rather than left at the real mtime the
        // write just gave them: against the PINNED `now` a real-clock mtime is
        // months ahead of the horizon, which is the future-dated branch, not the
        // grace-window one this row counts. Half the window is unambiguously
        // young and unambiguously not skewed.
        await ageDirectory(dir, ORPHAN_SWEEP_GRACE_MS / 2);
        planted.push(dir);
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
          String(message).includes(`deferring ${OVERFLOW} to a later UTC day`),
        ),
      ).toBe(true);
      expect(await exists(wikiDir(wiki.id))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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
      warned.some(([, message]) => String(message).includes("deferring")),
    ).toBe(false);
  });

  // -------------------------------------------------------------------------
  // A future-dated write is not a young one (DW-290)
  // -------------------------------------------------------------------------

  it("warns rather than whispers about an orphan whose newest write is in the future", async () => {
    // The age gates a DELETE, so an age this isolate cannot trust must never
    // authorise one — the skip itself is correct and stays. What was wrong was
    // the LEVEL: a future-dated directory can never age out on its own, so it is
    // not the benign, self-clearing case the grace-window INFO line describes.
    // The bytes sit there until the wall clock passes that date, which for a
    // restored archive or a skewed provider clock can be months.
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const ahead = await plantOrphan("dddddddd-1111-4111-8111-111111111111");
    // A NEGATIVE age is a future date — `ageDirectory` subtracts it. Four times
    // the grace window, so this is well past the forward-skew tolerance rather
    // than a borderline value the row could pass by luck.
    await ageDirectory(ahead, -ORPHAN_SWEEP_GRACE_MS * 4);

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

    // Not removed — an unverifiable age never authorises a delete.
    expect(removed).toBe(0);
    expect(await exists(ahead)).toBe(true);
    // Named, with the date, and at WARN.
    const future = warned.filter(
      ([scope, message]) =>
        scope === "wikis" &&
        String(message).includes("dddddddd-1111-4111-8111-111111111111") &&
        String(message).includes("further into the future"),
    );
    expect(future).toHaveLength(1);
    expect(String(future[0][1])).toMatch(/dated \d{4}-\d{2}-\d{2}T/);
    // …and NOT also as the grace-window line, which would say the opposite:
    // that it is merely young and will settle.
    expect(
      logged.some(([, message]) =>
        String(message).includes("skipped orphaned wiki directory"),
      ),
    ).toBe(false);
  });

  it("still treats a small forward skew as an ordinary young directory", async () => {
    // The tolerance, and the reason the escalation is keyed on `now + grace`
    // rather than on `now`. A provider clock (`head.uploaded`, or an mtime) and
    // this isolate's can disagree by a little; the grace window is already the
    // size of that allowance, so a write dated inside it is jitter and gets the
    // line it always got.
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const skewed = await plantOrphan("dddddddd-2222-4222-8222-222222222222");
    await ageDirectory(skewed, -ORPHAN_SWEEP_GRACE_MS / 2);

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

    expect(removed).toBe(0);
    expect(await exists(skewed)).toBe(true);
    expect(
      logged.some(
        ([scope, message]) =>
          scope === "wikis" &&
          String(message).includes("dddddddd-2222-4222-8222-222222222222") &&
          String(message).includes("grace window"),
      ),
    ).toBe(true);
    expect(
      warned.some(([, message]) =>
        String(message).includes("further into the future"),
      ),
    ).toBe(false);
  });

  // -------------------------------------------------------------------------
  // …and it is said once per fact, not once per pass (DW-483)
  //
  // EVERY ROW BELOW RUNS ON THE REAL CLOCK, and may only keep doing so while it
  // plants FEWER THAN `ORPHAN_SWEEP_CANDIDATE_CAP` directories. Under the cap,
  // `rotatingSweepWindow` returns the candidate list unchanged on any UTC day,
  // so naming specific ids is safe; at or over it the window becomes a function
  // of the calendar and the ids a row reaches depend on the date the suite runs
  // — the DW-485 hazard the two overflow rows above are pinned against. A new
  // row here that needs more than the cap needs the pinning recipe too.
  // -------------------------------------------------------------------------

  /** The future-dated WARN lines naming `id`, in emission order. */
  function futureWarnsFor(warned: unknown[][], id: string): string[] {
    return warned
      .filter(
        ([scope, message]) =>
          scope === "wikis" &&
          String(message).includes(id) &&
          String(message).includes("further into the future"),
      )
      .map(([, message]) => String(message));
  }

  /**
   * One scheduled pass that reclaims nothing, with every log line it produced.
   *
   * The DW-483 rows are all about a directory the sweep can never remove, so
   * "removed 0" is a precondition of each of them rather than an assertion any
   * one of them makes — asserting it here keeps a row that accidentally planted
   * a reclaimable directory from reading as a silent warn.
   */
  async function sweepCollecting(): Promise<{
    warned: unknown[][];
    logged: unknown[][];
  }> {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await sweepOrphanWikiDirectories(OWNER)).toBe(0);
      return {
        warned: warn.mock.calls.map((call) => [...call]),
        logged: info.mock.calls.map((call) => [...call]),
      };
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  }

  it("says a standing future-dated write once, not once per pass", async () => {
    // The condition cannot self-clear — the bytes sit there until the wall clock
    // passes that date, which for a restored archive is months — while the cron
    // re-reaches the same directory every tick. Said per pass, this is exactly
    // the noise the empty-registry warn a few lines above it is keyed against.
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const ID = "dddddddd-6666-4666-8666-666666666666";
    const ahead = await plantOrphan(ID);
    await ageDirectory(ahead, -ORPHAN_SWEEP_GRACE_MS * 4);

    const spoken: string[] = [];
    for (let pass = 0; pass < 3; pass += 1) {
      spoken.push(...futureWarnsFor((await sweepCollecting()).warned, ID));
    }

    // Once across all three — and the SKIP is untouched on every one of them,
    // which is the half of this that must never become a dedupe.
    expect(spoken).toHaveLength(1);
    expect(await exists(ahead)).toBe(true);
  });

  it("speaks again when the future date moves further out", async () => {
    // The sentence NAMES the date, so a different instant is a different fact.
    // Keying on the directory alone would leave the operator holding a date the
    // directory has since moved past.
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const ID = "dddddddd-7777-4777-8777-777777777777";
    const ahead = await plantOrphan(ID);
    await ageDirectory(ahead, -ORPHAN_SWEEP_GRACE_MS * 4);
    const first = futureWarnsFor((await sweepCollecting()).warned, ID);
    await ageDirectory(ahead, -ORPHAN_SWEEP_GRACE_MS * 40);
    const second = futureWarnsFor((await sweepCollecting()).warned, ID);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    // …and it is the NEW instant, not a replay of the one already reported.
    expect(second[0]).not.toBe(first[0]);
    expect(second[0]).toMatch(/dated \d{4}-\d{2}-\d{2}T/);
  });

  it("re-arms once a pass sees the directory back inside the grace window", async () => {
    // The evidence the skew ENDED, and the reason the record is re-armable
    // rather than write-once. `stampDirectory` puts the SAME instant back for
    // the third pass, so this row cannot be satisfied by a warn that simply
    // repeats a fact it already reported.
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const ID = "dddddddd-8888-4888-8888-888888888888";
    const ahead = await plantOrphan(ID);
    const future = new Date(Date.now() + ORPHAN_SWEEP_GRACE_MS * 4);
    await stampDirectory(ahead, future);
    expect(futureWarnsFor((await sweepCollecting()).warned, ID)).toHaveLength(1);

    // The clock caught up, or the provider's did: young now, and not skewed.
    await ageDirectory(ahead, ORPHAN_SWEEP_GRACE_MS / 2);
    const middle = await sweepCollecting();
    expect(futureWarnsFor(middle.warned, ID)).toHaveLength(0);
    expect(
      middle.logged.some(
        ([scope, message]) =>
          scope === "wikis" &&
          String(message).includes(ID) &&
          String(message).includes("grace window"),
      ),
    ).toBe(true);

    // …and the same future instant is news again.
    await stampDirectory(ahead, future);
    expect(futureWarnsFor((await sweepCollecting()).warned, ID)).toHaveLength(1);
  });

  it("neither warns nor re-arms on an age it could not read", async () => {
    // `null` is "I could not look" — the same non-answer that refuses to
    // authorise a delete, and just as much not evidence that the skew ended.
    // Re-arming on it would repeat the future-dated line on the next readable
    // pass, for a fact the operator already has.
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const ID = "dddddddd-9999-4999-8999-999999999999";
    const ahead = await plantOrphan(ID);
    const future = new Date(Date.now() + ORPHAN_SWEEP_GRACE_MS * 4);
    await stampDirectory(ahead, future);
    expect(futureWarnsFor((await sweepCollecting()).warned, ID)).toHaveLength(1);

    // Only THIS directory's age is unreadable — the registry read and the file
    // lock keep working, so the pass is otherwise the same pass.
    const storage = getStorage();
    const readStat = storage.stat.bind(storage);
    const stat = vi
      .spyOn(storage, "stat")
      .mockImplementation(async (target: string) => {
        if (target.includes(ID)) throw new Error("the age is unreadable");
        return readStat(target);
      });
    let blind: { warned: unknown[][]; logged: unknown[][] };
    try {
      blind = await sweepCollecting();
    } finally {
      stat.mockRestore();
    }

    // `newestWriteTime` already said the age is unreadable; the future-dated
    // line would be a second sentence about a date this pass never read.
    expect(futureWarnsFor(blind.warned, ID)).toHaveLength(0);
    expect(
      blind.warned.some(([, message]) =>
        String(message).includes("could not read the age of wiki directory"),
      ),
    ).toBe(true);

    // And the record was left exactly as it was: the same instant is still said
    // to be old news on the next readable pass.
    expect(futureWarnsFor((await sweepCollecting()).warned, ID)).toHaveLength(0);
    expect(await exists(ahead)).toBe(true);
  });

  it("re-arms on the pass that RECLAIMS the directory, not only on a young one", async () => {
    // The re-arm sits before the age gate, which claims both halves of "the skew
    // ended": a young directory that will settle, and an aged one this very pass
    // is about to reclaim. Only the second half distinguishes that placement — a
    // re-arm hung on the grace-window branch instead would satisfy the young row
    // above and fail here.
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const ID = "dddddddd-eeee-4eee-8eee-eeeeeeeeeeee";
    const future = new Date(Date.now() + ORPHAN_SWEEP_GRACE_MS * 4);
    await stampDirectory(await plantOrphan(ID), future);
    expect(futureWarnsFor((await sweepCollecting()).warned, ID)).toHaveLength(1);

    // The archive's dates are corrected in place: same directory, an age this
    // pass can finally act on. It is reclaimed, and re-armed on the way past.
    await ageDirectory(wikiDir(ID));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await sweepOrphanWikiDirectories(OWNER)).toBe(1);
    } finally {
      warn.mockRestore();
    }
    expect(await exists(wikiDir(ID))).toBe(false);

    // The same id comes back at the SAME future instant, with no pass in between
    // that could have pruned the key for it — so speaking again is the re-arm's
    // doing and nothing else's.
    await stampDirectory(await plantOrphan(ID), future);
    expect(futureWarnsFor((await sweepCollecting()).warned, ID)).toHaveLength(1);
  });

  it("forgets a directory that stops being an orphan between passes", async () => {
    // THE EVICTION. Re-arming only fires for a directory the pass REACHED, so a
    // directory that quietly stops being a candidate — removed out of band here,
    // and equally a directory a restored `wikis.json` claims again — would leave
    // its key behind for the life of the isolate. The prune runs over `found`
    // every pass and is what actually bounds the record.
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const ID = "dddddddd-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
    const future = new Date(Date.now() + ORPHAN_SWEEP_GRACE_MS * 4);
    await stampDirectory(await plantOrphan(ID), future);
    expect(futureWarnsFor((await sweepCollecting()).warned, ID)).toHaveLength(1);
    // Standing state, so the next pass is silent — the state this row then
    // changes underneath the record.
    expect(futureWarnsFor((await sweepCollecting()).warned, ID)).toHaveLength(0);

    await fs.rm(wikiDir(ID), { recursive: true, force: true });
    // THE LOAD-BEARING STEP: a pass while the directory is ABSENT. Nothing
    // reaches it, so no re-arm can fire; the only thing that can clear the key
    // is the prune reading it out of `found`. Remove that pass and the row below
    // fails, which is exactly the difference between an evicting record and one
    // that only ever grows.
    expect(futureWarnsFor((await sweepCollecting()).warned, ID)).toHaveLength(0);

    // Back, at the SAME instant the record once held — so a surviving key would
    // silence it, and speaking again is the prune's doing.
    await stampDirectory(await plantOrphan(ID), future);
    expect(futureWarnsFor((await sweepCollecting()).warned, ID)).toHaveLength(1);
  });

  it("shares the record with the sweep that runs inside a delete", async () => {
    // The record is deliberately NOT keyed on which caller ran the pass. The
    // inline sweep is the only path that reaches a tenant created before the
    // DW-159 gate — the schedule resolves the single configured owner — so a
    // dedupe gated on `scheduled` would leave exactly those tenants repeating the
    // line on every delete, and on the owner's own tenant would let the two
    // callers each say the same fact once.
    const keep = await createWiki(OWNER, { name: "Keep", scenario: "business" });
    const drop = await createWiki(OWNER, { name: "Drop", scenario: "reading" });
    await setCurrentWiki(OWNER, keep.id);
    const ID = "dddddddd-ffff-4fff-8fff-ffffffffffff";
    const ahead = await plantOrphan(ID);
    await ageDirectory(ahead, -ORPHAN_SWEEP_GRACE_MS * 4);

    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    let inline: unknown[][] = [];
    try {
      expect((await deleteWiki(OWNER, drop.id))?.id).toBe(drop.id);
      inline = warn.mock.calls.map((call) => [...call]);
    } finally {
      warn.mockRestore();
    }

    // The inline pass said it once…
    expect(futureWarnsFor(inline, ID)).toHaveLength(1);
    // …so the scheduled pass behind it says nothing, and the directory is still
    // there for it to have said nothing about.
    expect(futureWarnsFor((await sweepCollecting()).warned, ID)).toHaveLength(0);
    expect(await exists(ahead)).toBe(true);
  });

  it("names each future-dated directory, not just the first one in the pass", async () => {
    // The record is per DIRECTORY: one skewed restore must not silence the next
    // one in the same listing, which is what a per-pass flag would have done.
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const FIRST = "dddddddd-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const SECOND = "dddddddd-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    for (const id of [FIRST, SECOND]) {
      await ageDirectory(await plantOrphan(id), -ORPHAN_SWEEP_GRACE_MS * 4);
    }

    const { warned } = await sweepCollecting();

    expect(futureWarnsFor(warned, FIRST)).toHaveLength(1);
    expect(futureWarnsFor(warned, SECOND)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // The per-pass window rotates, so nothing is starved (DW-383)
  // -------------------------------------------------------------------------

  /**
   * Which candidates one pass actually reached, in window order.
   *
   * `deleteDirectory` is rejected throughout, so NOTHING is removable and the
   * listing is identical on every pass — which is the only arrangement under
   * which "the window moved" is an observation rather than a side effect of the
   * previous pass having reclaimed its own candidates. The per-candidate
   * failure warn names each directory the pass walked.
   */
  async function windowOf(): Promise<string[]> {
    const removal = vi
      .spyOn(getStorage(), "deleteDirectory")
      .mockRejectedValue(new Error("the directory is busy"));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await sweepOrphanWikiDirectories(OWNER)).toBe(0);
      return warn.mock.calls
        .map((call) => String(call[1]))
        .map((message) => /removing orphaned wiki directory "([^"]+)" failed/.exec(message))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => match[1]);
    } finally {
      warn.mockRestore();
      removal.mockRestore();
    }
  }

  it("rotates the per-pass window by the cap once per UTC day", async () => {
    // THE STARVATION THIS FIXES. A candidate that is skipped rather than removed
    // is listed again next pass and occupies a slot again, so a cap that always
    // took the same head of the list meant everything sorting behind a
    // permanently unsweepable directory was never even walked — not deferred,
    // leaked. Removal is still the progress; rotation only matters in the case
    // where nothing is removable, which is exactly what this row constructs.
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const OVERFLOW = 5;
    const planted: string[] = [];
    // `Date` alone is faked — `setTimeout` stays real, so the file lock's own
    // waits are unaffected. Set BEFORE the directories are aged, so their mtimes
    // are computed against the same clock the sweep will read.
    vi.useFakeTimers({ toFake: ["Date"] });
    const day0 = Date.UTC(2026, 0, 15, 6, 0, 0);
    try {
      vi.setSystemTime(day0);
      for (let index = 0; index < ORPHAN_SWEEP_CANDIDATE_CAP + OVERFLOW; index += 1) {
        const dir = await plantOrphan(
          `dddddddd-3333-4333-8333-${String(index).padStart(12, "0")}`,
        );
        await ageDirectory(dir);
        planted.push(dir);
      }

      const first = await windowOf();
      // Two passes on the SAME UTC day see the SAME window — a delete run twice
      // in one afternoon must not re-shuffle the work.
      const sameDay = await windowOf();
      // …and a pass later the same UTC day, well after the 15-minute grace
      // window has elapsed, still does: rotation is keyed on the day, not on
      // the grace bucket.
      vi.setSystemTime(day0 + ORPHAN_SWEEP_ROTATION_MS / 4);
      const laterSameDay = await windowOf();
      vi.setSystemTime(day0 + ORPHAN_SWEEP_ROTATION_MS);
      const nextDay = await windowOf();

      expect(first).toHaveLength(ORPHAN_SWEEP_CANDIDATE_CAP);
      expect(sameDay).toEqual(first);
      expect(laterSameDay).toEqual(first);
      expect(nextDay).toHaveLength(ORPHAN_SWEEP_CANDIDATE_CAP);
      expect(nextDay).not.toEqual(first);
      // Every candidate is reached within `ceil(n / cap)` days — here two. The
      // starved tail of the old behaviour is precisely this difference.
      const starved = planted
        .map((dir) => path.basename(dir))
        .filter((id) => !first.includes(id));
      expect(starved).toHaveLength(OVERFLOW);
      for (const id of starved) expect(nextDay).toContain(id);
      expect(new Set([...first, ...nextDay]).size).toBe(planted.length);
    } finally {
      vi.useRealTimers();
    }

    // Nothing was reclaimed at any point — the rotation is the only thing this
    // row observed.
    for (const dir of planted) expect(await exists(dir)).toBe(true);
  });

  it("needs ceil(n / cap) days to cover a list more than twice the cap", async () => {
    // The row above uses `cap + 5`, where two days cover everything and the
    // window never has to wrap far. `ceil(n / cap)` is the claim three docblocks
    // make, and it only has content once the answer is more than two: here the
    // start advances past the end of the list and comes back round, and two
    // days are provably NOT enough — which is what separates a rotation that
    // advances by `cap` from one that merely alternates between two windows.
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const TOTAL = ORPHAN_SWEEP_CANDIDATE_CAP * 2 + 5;
    const planted: string[] = [];
    vi.useFakeTimers({ toFake: ["Date"] });
    const day0 = Date.UTC(2026, 2, 3, 6, 0, 0);
    try {
      vi.setSystemTime(day0);
      for (let index = 0; index < TOTAL; index += 1) {
        const dir = await plantOrphan(
          `dddddddd-5555-4555-8555-${String(index).padStart(12, "0")}`,
        );
        await ageDirectory(dir);
        planted.push(dir);
      }

      const days: string[][] = [];
      for (let day = 0; day < 3; day += 1) {
        vi.setSystemTime(day0 + day * ORPHAN_SWEEP_ROTATION_MS);
        days.push(await windowOf());
      }

      for (const window of days) {
        expect(window).toHaveLength(ORPHAN_SWEEP_CANDIDATE_CAP);
        // Each window holds `cap` DISTINCT ids — a start that advanced by less
        // than the cap would revisit inside a single window once it wrapped.
        expect(new Set(window).size).toBe(ORPHAN_SWEEP_CANDIDATE_CAP);
      }
      // Two days genuinely are not enough, so the third is doing real work
      // rather than repeating one of the first two.
      const afterTwo = new Set([...days[0], ...days[1]]);
      expect(afterTwo.size).toBe(ORPHAN_SWEEP_CANDIDATE_CAP * 2);
      expect(afterTwo.size).toBeLessThan(TOTAL);
      // …and the third closes it: `ceil(55 / 25) = 3`.
      expect(new Set([...days[0], ...days[1], ...days[2]]).size).toBe(TOTAL);
    } finally {
      vi.useRealTimers();
    }

    for (const dir of planted) expect(await exists(dir)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Stale discard markers on wikis the registry DOES name (DW-291)
  // -------------------------------------------------------------------------

  /** The `.discarded` marker path for one wiki id. */
  function tombstone(wikiId: string): string {
    return path.join(wikiDir(wikiId), ".discarded");
  }

  it("clears a discard marker from a directory the registry names", async () => {
    // The marker is the ONE thing that outranks the empty-registry rule, so a
    // stale one on a LIVE wiki arms a delete of that wiki's artifacts for the
    // day its `wikis.json` is lost — precisely the state that rule exists to
    // survive. Nothing else ever removes the file: the directory is not an
    // orphan, so the sweep's own loop never reaches it.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const purpose = await readWikiArtifact(OWNER, wiki.id, "purpose.md");
    await fs.writeFile(tombstone(wiki.id), "2020-01-01T00:00:00.000Z\n");

    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    let removed: number;
    let warned: unknown[][] = [];
    try {
      removed = await sweepOrphanWikiDirectories(OWNER);
      warned = warn.mock.calls.map((call) => [...call]);
    } finally {
      warn.mockRestore();
    }

    // The marker is gone and NOTHING else moved — this is a marker clear, not a
    // reclaim, so the count stays 0 and the artifacts stay byte-identical.
    expect(removed).toBe(0);
    expect(await exists(tombstone(wiki.id))).toBe(false);
    expect(await exists(wikiDir(wiki.id))).toBe(true);
    expect(await readWikiArtifact(OWNER, wiki.id, "purpose.md")).toBe(purpose);
    expect((await listWikis(OWNER)).map((item) => item.id)).toEqual([wiki.id]);
    expect(
      warned.some(
        ([scope, message]) =>
          scope === "wikis" &&
          String(message).includes("cleared the stale discard marker") &&
          String(message).includes(wiki.id),
      ),
    ).toBe(true);

    // …and the registry-lost state is now survivable again: an empty registry
    // finds no marker to act on, so the wiki's bytes stay.
    await ageDirectory(wikiDir(wiki.id));
    await fs.rm(abs(wikiRegistryPath(OWNER)));
    expect(await sweepOrphanWikiDirectories(OWNER)).toBe(0);
    expect(await exists(wikiDir(wiki.id))).toBe(true);
  });

  it("leaves the marker alone on the sweep that runs inside a delete", async () => {
    // Clearing costs one `fileExists` per registry-claimed directory, and
    // `deleteWiki` is a user-facing request holding `wikis:<tenant>` — where the
    // healthy case is a single `listFiles` today and every create, rename and
    // delete for the tenant queues behind it. The cron tick already tolerates
    // the full walk, and the fault needs three unlikely failures in a row, so a
    // few minutes' delay costs nothing.
    const keep = await createWiki(OWNER, { name: "Keep", scenario: "business" });
    const drop = await createWiki(OWNER, { name: "Drop", scenario: "reading" });
    await setCurrentWiki(OWNER, keep.id);
    await fs.writeFile(tombstone(keep.id), "2020-01-01T00:00:00.000Z\n");

    expect((await deleteWiki(OWNER, drop.id))?.id).toBe(drop.id);

    expect(await exists(tombstone(keep.id))).toBe(true);
    // The SCHEDULED entry point is the one that clears it — same marker, same
    // registry, different caller.
    expect(await sweepOrphanWikiDirectories(OWNER)).toBe(0);
    expect(await exists(tombstone(keep.id))).toBe(false);
  });

  it("warns and carries on when a marker cannot be removed", async () => {
    // Per directory, like every other step in the pass. A marker left one more
    // day is exactly where it already was; a pass that aborted over it would
    // strand the orphan it had not reached yet.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    await fs.writeFile(tombstone(wiki.id), "2020-01-01T00:00:00.000Z\n");
    const orphan = await plantOrphan("dddddddd-4444-4444-8444-444444444444");
    await ageDirectory(orphan);

    const removal = vi
      .spyOn(getStorage(), "deleteFile")
      .mockRejectedValue(new Error("the marker is busy"));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    let removed: number;
    let warned: unknown[][] = [];
    try {
      removed = await sweepOrphanWikiDirectories(OWNER);
      warned = warn.mock.calls.map((call) => [...call]);
    } finally {
      warn.mockRestore();
      removal.mockRestore();
    }

    // The orphan reclaim — the pass's actual work — still happened.
    expect(removed).toBe(1);
    expect(await exists(orphan)).toBe(false);
    expect(await exists(tombstone(wiki.id))).toBe(true);
    expect(
      warned.some(
        ([scope, message]) =>
          scope === "wikis" &&
          String(message).includes("could not clear the stale discard marker") &&
          String(message).includes(wiki.id),
      ),
    ).toBe(true);
  });

  it("says nothing about the directories that carry no marker", async () => {
    // The probe runs on every registry-claimed directory, so a line per healthy
    // wiki on every cron tick would train the operator to ignore the one that
    // matters — the same argument the empty-registry warn is keyed on.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });

    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    let warned: unknown[][] = [];
    try {
      expect(await sweepOrphanWikiDirectories(OWNER)).toBe(0);
      warned = warn.mock.calls.map((call) => [...call]);
    } finally {
      warn.mockRestore();
    }

    expect(
      warned.some(([, message]) => String(message).includes("discard marker")),
    ).toBe(false);
    expect(await exists(wikiDir(wiki.id))).toBe(true);
  });

  it("does not claim it cleared a marker when the probe itself threw", async () => {
    // An unreadable probe is not evidence — and it is emphatically not evidence
    // that there was a marker to clear. One `catch` over both steps would print
    // "could not clear the stale discard marker", asserting a marker exists on
    // a directory nothing ever managed to look at.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    await fs.writeFile(tombstone(wiki.id), "2020-01-01T00:00:00.000Z\n");
    const orphan = await plantOrphan("dddddddd-6666-4666-8666-666666666666");
    await ageDirectory(orphan);

    const probe = vi
      .spyOn(getStorage(), "fileExists")
      .mockRejectedValue(new Error("the marker cannot be read"));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    let removed: number;
    let warned: unknown[][] = [];
    try {
      removed = await sweepOrphanWikiDirectories(OWNER);
      warned = warn.mock.calls.map((call) => [...call]);
    } finally {
      warn.mockRestore();
      probe.mockRestore();
    }

    // The pass's actual work still happened, and the marker is untouched.
    expect(removed).toBe(1);
    expect(await exists(orphan)).toBe(false);
    expect(await exists(tombstone(wiki.id))).toBe(true);
    expect(
      warned.some(
        ([scope, message]) =>
          scope === "wikis" &&
          String(message).includes("could not check whether wiki directory") &&
          String(message).includes("carries a stale discard marker") &&
          String(message).includes(wiki.id),
      ),
    ).toBe(true);
    // …and NOT the other sentence, which would be a claim about a file nobody
    // read.
    expect(
      warned.some(([, message]) =>
        String(message).includes("could not clear the stale discard marker"),
      ),
    ).toBe(false);
  });

  it("bounds and rotates the marker probe over registry-named directories", async () => {
    // The marker probe walks the CLAIMED directories, and every other DW-291
    // row here has one or two of them — so `rotatingSweepWindow` returns the
    // list unchanged and only its identity branch ever runs. Replace the call
    // with a plain loop and those rows stay green while the per-pass bound is
    // gone; replace it with `.slice(0, cap)` and they stay green while a marker
    // sorting past the cap is never reached at all. This is the row that
    // separates the three.
    const TOTAL = ORPHAN_SWEEP_CANDIDATE_CAP + 5;
    const stamp = "2026-01-01T00:00:00.000Z";
    const claimed = Array.from({ length: TOTAL }, (_, index) => ({
      id: `eeeeeeee-1111-4111-8111-${String(index).padStart(12, "0")}`,
      name: `Wiki ${index}`,
      scenario: "general" as const,
      createdAt: stamp,
      updatedAt: stamp,
    }));
    // Written straight to disk, because `createWiki` would seed 30 wikis' worth
    // of artifacts for a row that only cares which directories are NAMED.
    await fs.mkdir(abs("tenants", TENANT), { recursive: true });
    await fs.writeFile(
      abs(wikiRegistryPath(OWNER)),
      JSON.stringify({ version: 1, wikis: claimed, currentId: claimed[0].id }),
    );
    for (const entry of claimed) await fs.mkdir(wikiDir(entry.id), { recursive: true });

    /** Which claimed directories one pass probed for a marker. */
    async function probedDirectories(): Promise<string[]> {
      const storage = getStorage();
      const fileExists = storage.fileExists.bind(storage);
      const seen: string[] = [];
      const probe = vi
        .spyOn(storage, "fileExists")
        .mockImplementation(async (target: string) => {
          const match = /wikis\/([^/]+)\/\.discarded$/.exec(target);
          if (match) seen.push(match[1]);
          return fileExists(target);
        });
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
      try {
        expect(await sweepOrphanWikiDirectories(OWNER)).toBe(0);
        return seen;
      } finally {
        warn.mockRestore();
        probe.mockRestore();
      }
    }

    vi.useFakeTimers({ toFake: ["Date"] });
    const day0 = Date.UTC(2026, 4, 9, 6, 0, 0);
    try {
      vi.setSystemTime(day0);
      const first = await probedDirectories();
      // (a) BOUNDED: 30 claimed directories, at most `cap` round trips.
      expect(first).toHaveLength(ORPHAN_SWEEP_CANDIDATE_CAP);
      expect(new Set(first).size).toBe(ORPHAN_SWEEP_CANDIDATE_CAP);

      // (b) ROTATING: put the marker on a directory day 0 provably did not
      // reach, rather than on a hand-computed index — the window's start is the
      // implementation's business, and this row should fail if it moves, not if
      // the arithmetic in the test does.
      const victim = claimed.map((entry) => entry.id).find((id) => !first.includes(id));
      expect(victim).toBeDefined();
      await fs.writeFile(tombstone(victim!), `${stamp}\n`);

      // Still day 0: the marker is outside this window, so it survives.
      expect(await probedDirectories()).toEqual(first);
      expect(await exists(tombstone(victim!))).toBe(true);

      // …and the day its window comes round, it goes. `ceil(30 / 25) = 2`, so
      // one more day is enough; the loop is bounded rather than exact so the
      // row pins "eventually, within the documented bound" instead of pinning
      // which day.
      let cleared = false;
      for (let day = 1; day <= 2 && !cleared; day += 1) {
        vi.setSystemTime(day0 + day * ORPHAN_SWEEP_ROTATION_MS);
        const probed = await probedDirectories();
        expect(probed).toHaveLength(ORPHAN_SWEEP_CANDIDATE_CAP);
        cleared = !(await exists(tombstone(victim!)));
        expect(cleared).toBe(probed.includes(victim!));
      }
      expect(cleared).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    // Nothing was reclaimed and no directory was removed — the registry names
    // every one of them.
    for (const entry of claimed) expect(await exists(wikiDir(entry.id))).toBe(true);
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
      let warned: unknown[][] = [];
      try {
        warned = await warnsDuring(async () => {
          await expect(
            createWiki(OWNER, { name: "Doomed", scenario: "reading" }),
          ).rejects.toThrow(FAULT);
        });
      } finally {
        spy.mockRestore();
      }

      // THE NEGATIVE, on every one of the four. Without it a read-back predicate
      // that answered "the registry names it" for a create that never landed
      // would still satisfy every assertion below — they only say the directory
      // is gone, and a discard that ran for the wrong reason looks identical. On
      // the three seed faults the read must not be attempted at all; on the
      // `wikis.json` fault `failWritesTo` rejects WITHOUT calling through, so
      // the read runs and must answer absent. Both are silence here.
      expect(
        warned.filter(([, message]) =>
          String(message).includes("after a create that reported failure"),
        ),
      ).toEqual([]);

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

  /**
   * Writes every path THROUGH and then rejects on `wikis.json` — the
   * landed-then-threw provider the four rows above cannot produce, because
   * `failWritesTo` rejects WITHOUT calling through. Same spy shape the DW-484
   * re-template row uses.
   */
  function landRegistryWriteThenThrow() {
    const storage = getStorage();
    const write = storage.writeFile.bind(storage);
    return vi
      .spyOn(storage, "writeFile")
      .mockImplementation(async (target: string, content: string) => {
        await write(target, content);
        if (target.endsWith("wikis.json")) throw new Error(FAULT);
      });
  }

  /** The one id in the stored registry that is not `existingId`. */
  async function mintedWikiId(existingId: string): Promise<string> {
    const ids = (await listWikis(OWNER)).map((item) => item.id);
    const minted = ids.filter((id) => id !== existingId);
    expect(minted).toHaveLength(1);
    return minted[0];
  }

  it("reports the create as SUCCEEDED when the registry write landed before reporting failure (DW-675, DW-676)", async () => {
    // THE COMPENSATION'S UNVERIFIED BELIEF. The discard is a RECURSIVE delete of
    // the whole new directory, justified by "no registry entry names it" — which
    // was never read. `writeFile` is specified atomic about the FILE, not about
    // the throw: a provider can store `wikis.json` and still fail on the way
    // back. Discarding then leaves the tenant's CURRENT wiki with no purpose.md,
    // no schema.md and no profile — a record `normalizeRegistry` keeps and no
    // sweep can reclaim, because the registry names it.
    const existing = await createWiki(OWNER, { name: "Existing", scenario: "business" });
    await seedTenantTrees();
    const versionBefore = await readDataVersion();
    expect(versionBefore).toBeGreaterThan(0); // so "moved" is not "left zero"

    const spy = landRegistryWriteThenThrow();
    let warned: unknown[][] = [];
    let created: WikiRecord | undefined;
    try {
      warned = await warnsDuring(async () => {
        // THE FAULT IS NOT SERVED (DW-676). The read-back FOUND the record, so
        // the create has already proved it landed: `wikis.json` names the wiki,
        // `currentId` points at it, and all three artifacts are on disk. That is
        // a successful create, and answering it with the storage error made
        // `POST /api/wikis` 500 over a wiki the whole app then resolved against
        // — sending the owner into a retry that mints a SECOND one against
        // MAX_WIKIS.
        created = await createWiki(OWNER, { name: "Doomed", scenario: "reading" });
      });
    } finally {
      spy.mockRestore();
    }

    // The registry really does name it, and `currentId` really does point at it
    // — read from the store, not inferred from the mock having been called.
    const minted = await mintedWikiId(existing.id);
    // …and it is THAT record the caller was handed, not a fresh object that
    // merely looks like one: the id has to be the one the registry stores, or
    // every read the caller makes next resolves against a different wiki.
    expect(created?.id).toBe(minted);
    expect(created?.name).toBe("Doomed");
    expect(created?.scenario).toBe("reading");
    expect((await getWikiRegistry(OWNER)).currentId).toBe(minted);
    // …so its directory and ALL THREE seeded artifacts are still on disk.
    expect(await wikisRootEntries()).toEqual([existing.id, minted].sort());
    expect(await seededBytes(minted)).not.toContain(null);
    // Nothing was discarded, so no tombstone was written either.
    expect(await exists(path.join(wikiDir(minted), ".discarded"))).toBe(false);
    // The detection is LOGGED: this is a create the caller was told failed and
    // the tenant is now sitting on, so an operator needs the id.
    expect(
      warned.filter(
        ([scope, message]) =>
          scope === "wikis" &&
          String(message).includes(`the registry names wiki "${minted}"`) &&
          String(message).includes("after a create that reported failure"),
      ),
    ).toHaveLength(1);
    // …and the STORAGE FAULT is logged rather than served — relocated, not lost.
    // The owner cannot act on it and would act wrongly if they tried; an
    // operator can.
    const relocated = warned.filter(
      ([scope, message]) =>
        scope === "wikis" &&
        String(message).includes(`the storage fault under the create of wiki "${minted}"`) &&
        String(message).includes("logged rather than served"),
    );
    expect(relocated).toHaveLength(1);
    // The original diagnosis itself rides along, unwrapped: a warn that named
    // the id but dropped the cause would leave the operator with no fault to
    // chase.
    expect(String((relocated[0][2] as Error)?.message)).toContain(FAULT);
    // …and the compensation stayed silent — no "half-created" line, because the
    // destructive branch was never entered.
    expect(warned.filter(([, message]) => String(message).includes("half-created"))).toEqual(
      [],
    );
    // The disk moved under a reported failure, so the signal moves too — once.
    expect(await readDataVersion()).toBe(versionBefore + 1);
    // Blast-radius controls: the other wiki and the tenant-wide trees.
    await expectTenantTreesIntact();
    expect(await seededBytes(existing.id)).not.toContain(null);
  });

  it("keeps the new wiki when the registry read-back itself throws (DW-675)", async () => {
    // UNKNOWN NEVER AUTHORISES A DELETE. A read that throws cannot tell the
    // landed case from the not-landed one, and the two ways to be wrong are not
    // symmetric: leftover bytes are recoverable, a deleted current wiki's
    // artifacts are not. So the directory stays — AND NOTHING BUMPS, because
    // refusing to destroy under uncertainty is not the same claim as observing
    // that the disk moved, and only the first is safe to make without evidence.
    //
    // The registry write here does NOT land (the spy rejects without calling
    // through), so this is the arm's genuinely costly case: bytes kept that
    // did not need keeping. The tail of the row pins exactly what that costs.
    const versionBefore = await readDataVersion();

    const storage = getStorage();
    const write = storage.writeFile.bind(storage);
    const read = storage.readFile.bind(storage);
    // The registry read that OPENS the locked body must still succeed, so the
    // reader only starts failing once the registry write has been issued.
    let registryWriteIssued = false;
    const writeSpy = vi
      .spyOn(storage, "writeFile")
      .mockImplementation(async (target: string, content: string) => {
        if (target.endsWith("wikis.json")) {
          registryWriteIssued = true;
          throw new Error(FAULT);
        }
        return write(target, content);
      });
    const readSpy = vi
      .spyOn(storage, "readFile")
      .mockImplementation(async (target: string) => {
        if (registryWriteIssued && target.endsWith("wikis.json")) {
          throw new Error("the registry is unreadable");
        }
        return read(target);
      });
    let warned: unknown[][] = [];
    try {
      warned = await warnsDuring(async () => {
        // The ORIGINAL diagnosis, unwrapped: the read-back neither replaces nor
        // wraps what actually broke.
        await expect(
          createWiki(OWNER, { name: "Doomed", scenario: "reading" }),
        ).rejects.toThrow(FAULT);
      });
    } finally {
      readSpy.mockRestore();
      writeSpy.mockRestore();
    }

    // Nothing was deleted, and the directory keeps all three seeded files.
    const [leftover] = await wikisRootEntries();
    expect(leftover).toBeDefined();
    expect(await seededBytes(leftover)).not.toContain(null);
    // The read failure is reported, and reported as a READ failure — it must
    // never be mistaken for the positive detection, which did not happen.
    expect(
      warned.filter(
        ([scope, message]) =>
          scope === "wikis" &&
          String(message).includes(
            `reading the registry back after a failed create of wiki "${leftover}" failed`,
          ),
      ),
    ).toHaveLength(1);
    expect(
      warned.filter(([, message]) =>
        String(message).includes("after a create that reported failure"),
      ),
    ).toEqual([]);
    // NO BUMP. The read could not say the registry gained anything, so telling
    // every open tab to refetch would assert a change nobody observed.
    expect(await readDataVersion()).toBe(versionBefore);

    // WHAT THE ARM COSTS, PINNED RATHER THAN LEFT TO INFERENCE. No `.discarded`
    // marker is written, and deliberately: `unknown` cannot rule out that the
    // registry names this wiki with `currentId` on it, and a marker would arm a
    // delete of a possibly-live CURRENT wiki's artifacts on the day this
    // tenant's `wikis.json` goes missing — which is this empty-registry state.
    expect(await exists(path.join(wikiDir(leftover), ".discarded"))).toBe(false);
    expect(await listWikis(OWNER)).toEqual([]);
    // So while the registry names nothing, no pass reclaims it however aged it
    // is — the documented DW-162 residual, reached by a second route.
    await ageDirectory(wikiDir(leftover));
    expect(await sweepOrphanWikiDirectories(OWNER)).toBe(0);
    expect(await wikisRootEntries()).toEqual([leftover]);
    // …and it is not lost: the moment the tenant owns a wiki the empty-registry
    // rule stops applying and an ordinary sweep takes it, exactly as the
    // untombstoned half-create leftover row below pins.
    const recovered = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    await ageDirectory(wikiDir(leftover));
    expect(await sweepOrphanWikiDirectories(OWNER)).toBe(1);
    expect(await wikisRootEntries()).toEqual([recovered.id]);
  });

  it("never even asks the registry when the fault came before the write (DW-675)", async () => {
    // `registryWriteAttempted` is load-bearing and would otherwise be unpinned:
    // on a seed fault the read-back answers "absent" anyway, so DELETING the
    // flag leaves every other row in this file green while spending a read on a
    // question control flow has already answered — and putting a registry read
    // failure in the log for a registry write that was never issued.
    const storage = getStorage();
    const write = storage.writeFile.bind(storage);
    const read = storage.readFile.bind(storage);
    let seedFaulted = false;
    let registryReadsAfterFault = 0;
    const writeSpy = vi
      .spyOn(storage, "writeFile")
      .mockImplementation(async (target: string, content: string) => {
        if (target.endsWith("schema.md")) {
          seedFaulted = true;
          throw new Error(FAULT);
        }
        return write(target, content);
      });
    const readSpy = vi
      .spyOn(storage, "readFile")
      .mockImplementation(async (target: string) => {
        if (seedFaulted && target.endsWith("wikis.json")) registryReadsAfterFault += 1;
        return read(target);
      });
    try {
      await warnsDuring(async () => {
        await expect(
          createWiki(OWNER, { name: "Doomed", scenario: "reading" }),
        ).rejects.toThrow(FAULT);
      });
    } finally {
      readSpy.mockRestore();
      writeSpy.mockRestore();
    }

    // Not "the answer was absent" — the question was never asked.
    expect(registryReadsAfterFault).toBe(0);
    // …and the compensation still ran on control-flow evidence alone.
    expect(await wikisRootEntries()).toEqual([]);
  });

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
    "wikis.json",
  ]) {
    it(`restores canonical files and preserves profile evidence when a re-template faults on ${suffix}`, async () => {
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

  it("bumps the refresh signal when the restore could not put every file back (DW-210)", async () => {
    // THE ONE STATE A RE-TEMPLATE COULD CHANGE WITHOUT TELLING ANYBODY.
    // `restoreSeededFiles` is fail-soft PER ENTRY — one unwritable file must
    // not skip the restore of the other two — so a partial rollback leaves some
    // of the NEW template's bytes on disk under a call that reports failure.
    // The four rows above cover the clean rollback, where not bumping is
    // correct because the old bytes are back; this is the other half.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const bytesBefore = await seededBytes(wiki.id);
    const registryBefore = await fs.readFile(abs(wikiRegistryPath(OWNER)), "utf8");
    const versionBefore = await readDataVersion();
    expect(versionBefore).toBeGreaterThan(0); // so "moved" is not "left zero"

    // The fault has to land AFTER all three files were overwritten, or the
    // failed restore would be putting back a file the seed never touched and
    // the disk would be identical anyway. `wikis.json` is the last of the four
    // writes, so faulting it means the seed committed every artifact — and
    // faulting the SECOND write to `purpose.md` is what then fails its restore
    // specifically, leaving the new template's purpose beside the old registry.
    const storage = getStorage();
    const write = storage.writeFile.bind(storage);
    const seen = new Map<string, number>();
    const spy = vi
      .spyOn(storage, "writeFile")
      .mockImplementation(async (target: string, content: string) => {
        const nth = (seen.get(target) ?? 0) + 1;
        seen.set(target, nth);
        if (target.endsWith("wikis.json")) throw new Error(FAULT);
        if (target.endsWith("purpose.md") && nth === 2) {
          throw new Error("the artifact store is unavailable");
        }
        return write(target, content);
      });
    let warned: unknown[][] = [];
    try {
      warned = await warnsDuring(async () => {
        // The ORIGINAL diagnosis propagates, not the restore's: compensation
        // reports what actually broke.
        await expect(applyScenarioTemplate(OWNER, wiki.id, "reading")).rejects.toThrow(
          FAULT,
        );
      });
    } finally {
      spy.mockRestore();
    }

    // The restore really did fail, on `purpose.md` and on nothing else.
    expect(
      warned.filter(
        ([scope, message]) =>
          scope === "wikis" &&
          String(message).includes("after a failed re-template failed"),
      ),
    ).toHaveLength(1);
    // …so the disk genuinely diverged: `purpose.md` holds the reading
    // template's bytes while the registry, the Schema and the profile are all
    // still on business. THAT is what the bump is announcing.
    const bytesAfter = await seededBytes(wiki.id);
    expect(bytesAfter[0]).not.toBe(bytesBefore[0]);
    expect(bytesAfter.slice(1)).toEqual(bytesBefore.slice(1));
    expect(await fs.readFile(abs(wikiRegistryPath(OWNER)), "utf8")).toBe(registryBefore);
    expect((await getCurrentWiki(OWNER))?.scenario).toBe("business");
    expect((await getWorkspaceProfile(OWNER, wiki.id)).scenario).toBe("business");

    // Once — the failure path owes exactly the tail the success path owes.
    expect(await readDataVersion()).toBe(versionBefore + 1);
  });

  it("still re-throws the original error when the incomplete-restore bump also fails", async () => {
    // The tail is fail-soft in both directions: a counter that will not move
    // must not replace the diagnosis any more than a restore that will not
    // write does.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const versionBefore = await readDataVersion();

    const storage = getStorage();
    const write = storage.writeFile.bind(storage);
    const seen = new Map<string, number>();
    const spy = vi
      .spyOn(storage, "writeFile")
      .mockImplementation(async (target: string, content: string) => {
        const nth = (seen.get(target) ?? 0) + 1;
        seen.set(target, nth);
        if (target.endsWith("wikis.json")) throw new Error(FAULT);
        if (target.endsWith("purpose.md") && nth === 2) {
          throw new Error("the artifact store is unavailable");
        }
        return write(target, content);
      });
    const putIndex = vi
      .spyOn(storage, "putIndex")
      .mockRejectedValue(new Error("kv is gone"));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await expect(applyScenarioTemplate(OWNER, wiki.id, "reading")).rejects.toThrow(
        FAULT,
      );
    } finally {
      warn.mockRestore();
      putIndex.mockRestore();
      spy.mockRestore();
    }

    // The signal genuinely did not move — read from the store, not inferred
    // from the mock having been called.
    expect(await readDataVersion()).toBe(versionBefore);
  });

  it("bumps the refresh signal when the registry write landed before reporting failure (DW-484)", async () => {
    // THE COMPENSATION'S OTHER ASSUMPTION. `restoreSeededFiles` answers for the
    // FILES; the registry was taken on trust, on the reasoning that a write
    // specified atomic which THREW cannot have stored its bytes. Atomicity is a
    // claim about the file — never a half-written one — not about the throw: a
    // provider can land the object and still fail on the way back, on a flush,
    // a close, or an ack lost after the store. When it does, the compensation
    // puts every artifact back and leaves the registry naming a scenario
    // NOTHING on disk describes, under a call that reports failure.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const bytesBefore = await seededBytes(wiki.id);
    const versionBefore = await readDataVersion();
    expect(versionBefore).toBeGreaterThan(0); // so "moved" is not "left zero"

    // Writes `wikis.json` and THEN throws. Every other write passes through —
    // the three restores included — so "the bytes are back" means the
    // compensation put them back, exactly as the clean-rollback rows require.
    const storage = getStorage();
    const write = storage.writeFile.bind(storage);
    const spy = vi
      .spyOn(storage, "writeFile")
      .mockImplementation(async (target: string, content: string) => {
        await write(target, content);
        if (target.endsWith("wikis.json")) throw new Error(FAULT);
      });
    let warned: unknown[][] = [];
    try {
      warned = await warnsDuring(async () => {
        // The ORIGINAL diagnosis, unwrapped: the read-back neither replaces nor
        // wraps what actually broke.
        await expect(applyScenarioTemplate(OWNER, wiki.id, "reading")).rejects.toThrow(
          FAULT,
        );
      });
    } finally {
      spy.mockRestore();
    }

    // The detection is LOGGED, not just bumped: this is the most operationally
    // interesting degradation this module has, and every other one here warns.
    expect(
      warned.filter(
        ([scope, message]) =>
          scope === "wikis" &&
          String(message).includes(
            "the registry names the Reading Scenario Template for wiki",
          ) &&
          String(message).includes("may describe a different one"),
      ),
    ).toHaveLength(1);
    // And the compensation stayed silent — the fact the blanket "nothing
    // warned" assertion was really here to prove: every restore landed, so
    // "the bytes are back" means the restore put them back.
    expect(
      warned.filter(([, message]) =>
        String(message).includes("after a failed re-template failed"),
      ),
    ).toEqual([]);
    // Byte-identical artifacts — all three describe business still…
    expect(await seededBytes(wiki.id)).toEqual(bytesBefore);
    expect(await readWikiArtifact(OWNER, wiki.id, "schema.md")).toContain(
      "### Scenario conventions — Business",
    );
    expect((await getWorkspaceProfile(OWNER, wiki.id)).scenario).toBe("business");
    // …under a stored record that names READING. That divergence is the bug:
    // the switcher, `describeWiki` and the guidance all read this record, so a
    // Preview left open goes on rendering business bytes the registry disowns.
    const stored = JSON.parse(
      await fs.readFile(abs(wikiRegistryPath(OWNER)), "utf8"),
    ) as { wikis: { id: string; scenario: string }[] };
    expect(stored.wikis.find((item) => item.id === wiki.id)?.scenario).toBe("reading");
    expect((await getCurrentWiki(OWNER))?.scenario).toBe("reading");
    // Once — the failure path owes exactly the tail the success path owes, and
    // the two facts compose ONE reason rather than two bumps.
    expect(await readDataVersion()).toBe(versionBefore + 1);
  });

  it("bumps exactly once when the registry landed AND the restore was incomplete", async () => {
    // Both facts at the same time. They are independent observations with
    // different remedies, so both have to be true here — and the tail still
    // has to move the signal once, because a second bump would be a second
    // refetch of the same state.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const bytesBefore = await seededBytes(wiki.id);
    const versionBefore = await readDataVersion();
    expect(versionBefore).toBeGreaterThan(0);

    const storage = getStorage();
    const write = storage.writeFile.bind(storage);
    const seen = new Map<string, number>();
    const spy = vi
      .spyOn(storage, "writeFile")
      .mockImplementation(async (target: string, content: string) => {
        const nth = (seen.get(target) ?? 0) + 1;
        seen.set(target, nth);
        // The registry lands and then reports failure…
        if (target.endsWith("wikis.json")) {
          await write(target, content);
          throw new Error(FAULT);
        }
        // …and the SECOND write to `purpose.md` — the restore's — fails, so the
        // new template's purpose is left on disk as well.
        if (target.endsWith("purpose.md") && nth === 2) {
          throw new Error("the artifact store is unavailable");
        }
        return write(target, content);
      });
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

    // The restore really did fail, on `purpose.md` and on nothing else.
    expect(
      warned.filter(
        ([scope, message]) =>
          scope === "wikis" &&
          String(message).includes("after a failed re-template failed"),
      ),
    ).toHaveLength(1);
    // Both halves of the divergence: a purpose on the new template, a registry
    // on the new scenario, and a Schema and profile still on the old one.
    const bytesAfter = await seededBytes(wiki.id);
    expect(bytesAfter[0]).not.toBe(bytesBefore[0]);
    expect(bytesAfter.slice(1)).toEqual(bytesBefore.slice(1));
    expect((await getCurrentWiki(OWNER))?.scenario).toBe("reading");
    expect((await getWorkspaceProfile(OWNER, wiki.id)).scenario).toBe("business");

    // ONE bump, not two.
    expect(await readDataVersion()).toBe(versionBefore + 1);
  });

  it("bumps anyway when the registry read-back itself fails", async () => {
    // The read-back runs on a path that already holds the diagnosis it owes the
    // caller, so a read that throws must not become the failure. It is also the
    // only thing that can answer whether the registry moved, so a read that
    // throws cannot answer "no" either: it answers "landed" and pays one
    // spurious refetch, the same side of the trade DW-210 takes.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const bytesBefore = await seededBytes(wiki.id);
    const versionBefore = await readDataVersion();
    expect(versionBefore).toBeGreaterThan(0);

    // The registry write is genuinely ATTEMPTED here — it lands and then throws,
    // as the landed row's does — because the read-back is reached only when
    // `writeRegistry` was actually called. A seed fault would skip it entirely
    // and this row would pin nothing. Only the READ is broken, and only after
    // the write: keyed off the fault rather than off a read counter, so it
    // cannot start faulting the read that FINDS the record if this call ever
    // reads `wikis.json` a third time.
    const storage = getStorage();
    const write = storage.writeFile.bind(storage);
    const read = storage.readFile.bind(storage);
    let registryWritten = false;
    const writeSpy = vi
      .spyOn(storage, "writeFile")
      .mockImplementation(async (target: string, content: string) => {
        await write(target, content);
        if (target.endsWith("wikis.json")) {
          registryWritten = true;
          throw new Error(FAULT);
        }
      });
    const readSpy = vi
      .spyOn(storage, "readFile")
      .mockImplementation(async (target: string) => {
        if (registryWritten && target.endsWith("wikis.json")) {
          throw new Error("the registry is unreadable");
        }
        return read(target);
      });
    let warned: unknown[][] = [];
    try {
      warned = await warnsDuring(async () => {
        await expect(applyScenarioTemplate(OWNER, wiki.id, "reading")).rejects.toThrow(
          FAULT,
        );
      });
    } finally {
      readSpy.mockRestore();
      writeSpy.mockRestore();
    }

    // Warned and swallowed — and it is the READ-BACK's warning, not the
    // positive detection's: the helper never got to see the record.
    expect(
      warned.filter(
        ([scope, message]) =>
          scope === "wikis" &&
          String(message).includes(
            "reading the registry back after a failed re-template",
          ),
      ),
    ).toHaveLength(1);
    expect(
      warned.filter(([, message]) =>
        String(message).includes("may describe a different one"),
      ),
    ).toEqual([]);
    // …and NOT because the compensation also failed: the restore was clean.
    expect(
      warned.filter(([, message]) =>
        String(message).includes("after a failed re-template failed"),
      ),
    ).toEqual([]);
    // The artifacts went back, and the bump happened on an answer the helper
    // could not actually read. The over-signal is paid knowingly, and this row
    // exists to pin that it is paid rather than swallowed along with the read.
    expect(await seededBytes(wiki.id)).toEqual(bytesBefore);
    expect((await getWorkspaceProfile(OWNER, wiki.id)).scenario).toBe("business");
    expect(await readDataVersion()).toBe(versionBefore + 1);
  });

  it("still re-throws the original error when the landed-registry bump also fails", async () => {
    // The other half of the fail-soft the incomplete-restore row already pins,
    // on the path DW-484 added: a counter that will not move must not replace
    // the diagnosis any more than a restore that will not write does. Both
    // facts now feed ONE bump call, so both need this guarantee proved of them.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const versionBefore = await readDataVersion();

    const storage = getStorage();
    const write = storage.writeFile.bind(storage);
    const spy = vi
      .spyOn(storage, "writeFile")
      .mockImplementation(async (target: string, content: string) => {
        await write(target, content);
        if (target.endsWith("wikis.json")) throw new Error(FAULT);
      });
    const putIndex = vi
      .spyOn(storage, "putIndex")
      .mockRejectedValue(new Error("kv is gone"));
    // `bumpDataVersion` catches its own failure and warns, so `bumpRefreshSignal`'s
    // catch is redundant defence — and the composed reason it logs is, today,
    // observable NOWHERE ELSE. That swallow's own `logger.warn` is the one seam
    // that can make the bump reject, so it is the seam this row uses; if
    // `bumpDataVersion` ever stops swallowing, the rejection arrives on its own
    // and these assertions keep holding.
    const warn = vi
      .spyOn(logger, "warn")
      .mockImplementation((scope: string) => {
        if (scope === "data-version") throw new Error("the log sink is gone");
      });
    let warned: unknown[][] = [];
    try {
      await expect(applyScenarioTemplate(OWNER, wiki.id, "reading")).rejects.toThrow(
        FAULT,
      );
      warned = warn.mock.calls.map((call) => [...call]);
    } finally {
      warn.mockRestore();
      putIndex.mockRestore();
      spy.mockRestore();
    }

    // WHY THE TWO FACTS ARE NOT ONE FLAG. The bump's own failure warning is the
    // only place the COMPOSED reason is observable, and the claim being made of
    // it is that it names which fact fired — so the rollback, which was clean
    // on this row, has to be absent from it. A fixed string would satisfy the
    // first assertion and fail the second.
    const reasons = warned
      .map(([, message]) => String(message))
      .filter((message) => message.includes("the refresh signal did not move after"));
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("a registry write that landed");
    expect(reasons[0]).toContain(`the failed re-template of wiki "${wiki.id}"`);
    expect(reasons[0]).not.toContain("an incomplete rollback");

    // The signal genuinely did not move — read from the store, not inferred
    // from the mock having been called.
    expect(await readDataVersion()).toBe(versionBefore);
  });

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
    await fs.rm(path.join(wikiDir(wiki.id), "purpose.md"));

    const write = failWritesTo("wikis.json", "the registry store is unavailable");
    // The absent Purpose's undo is a delete, so this is the restore step failing with
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

/**
 * DW-676 — the registry/artifact scenario divergence finally gets an owner.
 *
 * `registryNamesScenario` DETECTS the state a failed re-template leaves when its
 * `wikis.json` write lands and its artifact writes are rolled back: the registry
 * names the NEW Scenario Template while `purpose.md` and `schema.md` still
 * describe the OLD one. Nothing reconciled it, so the Wiki switcher silently
 * re-labelled itself on the next poll and stayed wrong for the life of the Wiki.
 *
 * Every row here asserts BYTES — which registry field moved, whether
 * `wikis.json` was rewritten at all, whether an artifact changed — because the
 * repair's whole licence is that it can only ever rewrite one string, and a
 * count alone would be satisfied by a pass that had re-seeded the files.
 */
describe("reconcileWikiScenarioDrift — registry labels follow the artifacts (DW-676)", () => {
  /** The stored registry bytes, so "not rewritten" can mean bytes and not a parse. */
  function registryBytes(): Promise<string> {
    return fs.readFile(abs(...wikiRegistryPath(OWNER).split("/")), "utf8");
  }

  function artifactPath(wikiId: string, file: "purpose.md" | "schema.md"): string {
    return abs(...wikiArtifactPath(OWNER, wikiId, file).split("/"));
  }

  /**
   * Overwrite one artifact with a HAND-WRITTEN copy of the anchor the renderer
   * emits — `Scenario Template: <Label> — ` on a `purpose.md` line,
   * `# Schema — <Label>` as a whole `schema.md` line.
   *
   * WHAT THIS PINS IS PARSER DRIFT, IN ONE DIRECTION ONLY: a witness derivation
   * that stopped reading these anchors fails the rows below. It CANNOT see the
   * other direction — a reword of `renderPurposeMarkdown` or
   * `renderSchemaMarkdown` would leave every fixture here matching a string the
   * app no longer writes, so the derivation would answer null for every real
   * wiki forever while this suite stayed green and the reconciler, which is
   * deliberately silent when it does not fire, said nothing. The round-trip row
   * below is what covers that direction, by writing the renderers' actual
   * output.
   */
  async function nameScenarioIn(
    wikiId: string,
    file: "purpose.md" | "schema.md",
    label: string,
  ): Promise<void> {
    const body =
      file === "purpose.md"
        ? `# Doomed\n\nScenario Template: ${label} — a description.\n\n## Purpose\n\nBody.\n`
        : `# Schema — ${label}\n\nSeeded from the ${label} Scenario Template.\n\n## Page conventions\n\nBody.\n`;
    await fs.writeFile(artifactPath(wikiId, file), body, "utf8");
  }

  async function warnsDuring(run: () => Promise<void>): Promise<unknown[][]> {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await run();
      return warn.mock.calls.map((call) => [...call]);
    } finally {
      warn.mockRestore();
    }
  }

  /** How many times `wikis.json` was written while `run` ran. */
  async function registryWritesDuring(run: () => Promise<void>): Promise<number> {
    const storage = getStorage();
    const write = storage.writeFile.bind(storage);
    let writes = 0;
    const spy = vi
      .spyOn(storage, "writeFile")
      .mockImplementation(async (target: string, content: string) => {
        if (target.endsWith("wikis.json")) writes += 1;
        return write(target, content);
      });
    try {
      await run();
      return writes;
    } finally {
      spy.mockRestore();
    }
  }

  async function storedScenario(wikiId: string): Promise<string | undefined> {
    return (await getWikiRegistry(OWNER)).wikis.find((item) => item.id === wikiId)
      ?.scenario;
  }

  it("leaves a healthy tenant completely alone", async () => {
    // Two wikis on two different templates, both seeded by the real create — so
    // the artifacts say exactly what the renderer emits and the registry agrees.
    const first = await createWiki(OWNER, { name: "Reading list", scenario: "reading" });
    const second = await createWiki(OWNER, { name: "Q3", scenario: "business" });
    const bytesBefore = await registryBytes();
    const versionBefore = await readDataVersion();

    let repaired = 0;
    let warned: unknown[][] = [];
    const writes = await registryWritesDuring(async () => {
      warned = await warnsDuring(async () => {
        repaired = await reconcileWikiScenarioDrift(OWNER);
      });
    });

    expect(repaired).toBe(0);
    // NOT REWRITTEN AT ALL, which the count alone does not say: a pass that
    // re-serialised an unchanged registry would churn `wikis.json` on every scan
    // tick for the life of a perfectly healthy deployment.
    expect(writes).toBe(0);
    expect(await registryBytes()).toBe(bytesBefore);
    // …and no bump, so no open tab is told to refetch a registry that did not
    // move.
    expect(await readDataVersion()).toBe(versionBefore);
    expect(warned.filter(([, message]) => String(message).includes("Scenario Template"))).toEqual(
      [],
    );
    expect(await storedScenario(first.id)).toBe("reading");
    expect(await storedScenario(second.id)).toBe("business");
  });

  it("relabels the record when BOTH artifacts name a different template", async () => {
    // THE DW-676 STATE, planted exactly as a rolled-back re-template leaves it:
    // the registry moved to the new template and the restored artifacts describe
    // the old one.
    const wiki = await createWiki(OWNER, { name: "Doomed", scenario: "reading" });
    const control = await createWiki(OWNER, { name: "Healthy", scenario: "business" });
    await nameScenarioIn(wiki.id, "purpose.md", "Business");
    await nameScenarioIn(wiki.id, "schema.md", "Business");
    const artifactsBefore = await Promise.all([
      fs.readFile(artifactPath(wiki.id, "purpose.md"), "utf8"),
      fs.readFile(artifactPath(wiki.id, "schema.md"), "utf8"),
    ]);
    const profileBefore = (await getWorkspaceProfile(OWNER, wiki.id)).scenario;
    const recordBefore = (await getWikiRegistry(OWNER)).wikis.find(
      (item) => item.id === wiki.id,
    );
    const currentBefore = (await getWikiRegistry(OWNER)).currentId;
    const versionBefore = await readDataVersion();

    let repaired = 0;
    let warned: unknown[][] = [];
    const writes = await registryWritesDuring(async () => {
      warned = await warnsDuring(async () => {
        repaired = await reconcileWikiScenarioDrift(OWNER);
      });
    });

    expect(repaired).toBe(1);
    expect(await storedScenario(wiki.id)).toBe("business");
    // ONE FIELD, and the rest of the record left exactly as it was — which the
    // code makes an explicit decision (`updatedAt` in particular is deliberately
    // NOT touched: nothing about the wiki changed, the record is being corrected
    // to describe what it always was). Nor does `currentId` move: a relabel is
    // not a switch, and moving it would change which `schema.md` every ingest,
    // chat and lint prompt runs on.
    const recordAfter = (await getWikiRegistry(OWNER)).wikis.find(
      (item) => item.id === wiki.id,
    );
    expect({ ...recordAfter, scenario: recordBefore?.scenario }).toEqual(recordBefore);
    expect((await getWikiRegistry(OWNER)).currentId).toBe(currentBefore);
    // ONE registry write for the whole pass, and ONE bump — the switcher's label
    // is what moved, so another open tab has to be told, but exactly once.
    expect(writes).toBe(1);
    expect(await readDataVersion()).toBe(versionBefore + 1);
    // NOT ONE ARTIFACT BYTE. The direction of the repair is the entire safety
    // argument: both files are owner-editable, so a reconciler that re-seeded
    // them from the registry label would destroy hand-authored work.
    expect(await Promise.all([
      fs.readFile(artifactPath(wiki.id, "purpose.md"), "utf8"),
      fs.readFile(artifactPath(wiki.id, "schema.md"), "utf8"),
    ])).toEqual(artifactsBefore);
    // …and the workspace profile is out of scope: profile-versus-artifact drift
    // is a separately recorded design decision with an owner of its own.
    expect((await getWorkspaceProfile(OWNER, wiki.id)).scenario).toBe(profileBefore);
    // The warn names the id and BOTH labels — an operator reading it has to be
    // able to tell a repair from a template the owner applied on purpose.
    const repairWarns = warned.filter(
      ([scope, message]) =>
        scope === "wikis" &&
        String(message).includes(`wiki "${wiki.id}"`) &&
        String(message).includes("Reading") &&
        String(message).includes("Business"),
    );
    expect(repairWarns).toHaveLength(1);
    // The healthy wiki beside it is the blast-radius control.
    expect(await storedScenario(control.id)).toBe("business");
  });

  it("derives its witnesses from the RENDERERS' own output, not from a fixture", async () => {
    // THE OTHER DIRECTION OF ANCHOR DRIFT, and the only row that can see it.
    // Every other fixture in this suite hand-writes `Scenario Template: <Label>
    // — ` and `# Schema — <Label>`, so a reword of `renderPurposeMarkdown` or
    // `renderSchemaMarkdown` would leave the derivation reading a string the app
    // stopped writing: null for every wiki, forever, with this file green and
    // the reconciler — which says nothing when it does not fire — silently dead.
    // Here the bytes come from the renderers themselves, so the round trip
    // render → derive is what is asserted.
    const wiki = await createWiki(OWNER, { name: "Round trip", scenario: "reading" });
    const template = scenarioTemplate("business");
    await fs.writeFile(
      artifactPath(wiki.id, "purpose.md"),
      renderPurposeMarkdown("Round trip", template),
      "utf8",
    );
    await fs.writeFile(
      artifactPath(wiki.id, "schema.md"),
      // The engine conventions the seeder composes in, read the same way it
      // reads them — a `schema.md` missing them is not the file the app writes.
      renderSchemaMarkdown(template, await readEnginePageConventions()),
      "utf8",
    );
    const versionBefore = await readDataVersion();

    expect(await reconcileWikiScenarioDrift(OWNER)).toBe(1);
    expect(await storedScenario(wiki.id)).toBe("business");
    expect(await readDataVersion()).toBe(versionBefore + 1);
  });

  it("consults the SERVED purpose.md, not stored bytes the app never reads", async () => {
    // AN UNMARKED RECORD IS THE ONE PLACE THE TWO DIFFER. Until the
    // `artifactAuthority` migration commits, what the app serves for
    // `purpose.md` is `renderCanonicalPurposeMarkdown` projected from the legacy
    // profile, and the stored file is a leftover nothing reads. Worse, `POST
    // /api/tasks/scan` runs `backfillWorkspaceProfiles()` AFTER this pass in the
    // same request — so a witness taken from those bytes would decide a
    // permanent relabel from a file the very same request is about to overwrite.
    const wiki = await createWiki(OWNER, { name: "Legacy", scenario: "reading" });
    const registryFile = abs(...wikiRegistryPath(OWNER).split("/"));
    const parsed = JSON.parse(await fs.readFile(registryFile, "utf8")) as {
      wikis: Record<string, unknown>[];
    };
    for (const item of parsed.wikis) delete item.artifactAuthority;
    await fs.writeFile(registryFile, JSON.stringify(parsed), "utf8");
    // The stored bytes name Business; `schema.md` is gone, so those bytes are
    // the only thing that COULD be a witness.
    await nameScenarioIn(wiki.id, "purpose.md", "Business");
    await fs.rm(artifactPath(wiki.id, "schema.md"));

    // THE PREMISE, asserted rather than assumed: the two reads really do
    // disagree here, or this row would pass against a pass that read either one.
    expect(await readWikiArtifact(OWNER, wiki.id, "purpose.md")).toContain(
      "Scenario Template: Business — ",
    );
    expect(await readEffectiveWikiArtifact(OWNER, wiki.id, "purpose.md")).not.toContain(
      "Scenario Template:",
    );

    expect(await reconcileWikiScenarioDrift(OWNER)).toBe(0);
    expect(await storedScenario(wiki.id)).toBe("reading");

    // …AND THE CONTROL: remove the legacy evidence and the projection stops
    // applying, so the same stored bytes become the served ones and the same
    // drift repairs. Nothing else about the wiki changed, so the projection is
    // provably what suppressed the repair above.
    await fs.rm(
      abs("tenants", TENANT, "wikis", wiki.id, "workspace-profile.json"),
    );
    expect(await reconcileWikiScenarioDrift(OWNER)).toBe(1);
    expect(await storedScenario(wiki.id)).toBe("business");
  });

  it("reads a CRLF schema.md, which an owner edit stores verbatim", async () => {
    // `schema.md` is in `EDITABLE_ARTIFACT_FILES` and `writeWikiArtifact` stores
    // the submitted bytes as they arrive, so a save from a Windows editor or a
    // paste through a form that normalises line endings really does land CRLF
    // here. The heading anchor is an EXACT line comparison, so without the `\r`
    // strip such a file would silently stop being a witness.
    const wiki = await createWiki(OWNER, { name: "CRLF", scenario: "reading" });
    // `purpose.md` removed so `schema.md` is the sole witness — otherwise the
    // seeded Reading line would contradict it and the wiki would be skipped for
    // a reason that has nothing to do with line endings.
    await fs.rm(artifactPath(wiki.id, "purpose.md"));
    await fs.writeFile(
      artifactPath(wiki.id, "schema.md"),
      "# Schema — Business\r\n\r\n## Page conventions\r\n\r\nBody.\r\n",
      "utf8",
    );

    expect(await reconcileWikiScenarioDrift(OWNER)).toBe(1);
    expect(await storedScenario(wiki.id)).toBe("business");
  });

  it("skips a wiki whose two artifacts disagree, and says so ONCE (DW-735)", async () => {
    // AN OWNER-EDITED ARTIFACT IS A NORMAL STATE, not an anomaly. `purpose.md`
    // and `schema.md` are both in `EDITABLE_ARTIFACT_FILES`, so a hand-edit that
    // leaves the two naming different templates is something this pass will meet
    // on every tick for the life of the wiki — repairing on it would pick a
    // winner nobody chose. But it is ALSO the fingerprint of a
    // partially-rolled-back re-template, and collapsing it into the same silence
    // as "no witness" meant nothing detected, repaired or logged it. So: still
    // no write, and exactly one operator line per isolate.
    const wiki = await createWiki(OWNER, { name: "Doomed", scenario: "reading" });
    // NEITHER label is the stored one, deliberately. If one of them were, a
    // reconciler that simply took the LAST witness it read would answer "no
    // change" here for the wrong reason and this row would pass vacuously —
    // what is being pinned is that a contradiction is refused, not that one
    // particular file happens to agree with the registry.
    await nameScenarioIn(wiki.id, "purpose.md", "Business");
    await nameScenarioIn(wiki.id, "schema.md", "Research");
    const bytesBefore = await registryBytes();
    const versionBefore = await readDataVersion();

    let repaired = 0;
    let warned: unknown[][] = [];
    const writes = await registryWritesDuring(async () => {
      warned = await warnsDuring(async () => {
        repaired = await reconcileWikiScenarioDrift(OWNER);
      });
    });

    // SIGNAL ONLY: not one byte moved, and the contradiction counts for nothing
    // in the repair total.
    expect(repaired).toBe(0);
    expect(writes).toBe(0);
    expect(await registryBytes()).toBe(bytesBefore);
    expect(await readDataVersion()).toBe(versionBefore);
    expect(await storedScenario(wiki.id)).toBe("reading");

    // ONE line, naming the wiki, both files and both labels — an operator who
    // has to choose a winner needs to know which file said what.
    expect(warned).toHaveLength(1);
    const [scope, message] = warned[0];
    expect(scope).toBe("wikis");
    expect(String(message)).toContain(wiki.id);
    expect(String(message)).toContain("purpose.md");
    expect(String(message)).toContain("Business");
    expect(String(message)).toContain("schema.md");
    expect(String(message)).toContain("Research");

    // A SECOND PASS IN THE SAME ISOLATE IS SILENT. The contradiction is
    // permanent until an owner resolves it and the reconciler runs on a timer,
    // so a per-tick line would be a recurring entry in the log of a deployment
    // behaving exactly as designed.
    const again = await warnsDuring(async () => {
      expect(await reconcileWikiScenarioDrift(OWNER)).toBe(0);
    });
    expect(again).toEqual([]);
  });

  it("re-arms the contradiction warning once the artifacts stop disagreeing (DW-735)", async () => {
    const wiki = await createWiki(OWNER, { name: "Doomed", scenario: "reading" });
    await nameScenarioIn(wiki.id, "purpose.md", "Business");
    await nameScenarioIn(wiki.id, "schema.md", "Research");

    const first = await warnsDuring(async () => {
      expect(await reconcileWikiScenarioDrift(OWNER)).toBe(0);
    });
    expect(first).toHaveLength(1);

    // The owner resolves it: both files now name Business. That is a REPAIR
    // pass, which speaks with the sentence it always did — and it is also the
    // evidence, visible from inside the process, that the disagreement ended.
    await nameScenarioIn(wiki.id, "schema.md", "Business");
    const repairWarns = await warnsDuring(async () => {
      expect(await reconcileWikiScenarioDrift(OWNER)).toBe(1);
    });
    expect(repairWarns).toHaveLength(1);
    expect(String(repairWarns[0][1])).toContain("relabelled the record");
    expect(await storedScenario(wiki.id)).toBe("business");

    // A LATER contradiction on the same wiki is news again, not a repeat.
    await nameScenarioIn(wiki.id, "schema.md", "Research");
    const second = await warnsDuring(async () => {
      expect(await reconcileWikiScenarioDrift(OWNER)).toBe(0);
    });
    expect(second).toHaveLength(1);
    expect(String(second[0][1])).toContain("DIFFERENT Scenario Templates");
  });

  it("speaks again when the contradiction itself CHANGES (DW-735)", async () => {
    // The warn-once value is the PAIR, not a flag: an owner who edits
    // `schema.md` from Research to Personal Growth has produced a new fact, and
    // an operator who has only the first line would otherwise never learn the
    // pair moved.
    const wiki = await createWiki(OWNER, { name: "Doomed", scenario: "reading" });
    await nameScenarioIn(wiki.id, "purpose.md", "Business");
    await nameScenarioIn(wiki.id, "schema.md", "Research");
    const first = await warnsDuring(async () => {
      await reconcileWikiScenarioDrift(OWNER);
    });
    expect(first).toHaveLength(1);

    await nameScenarioIn(wiki.id, "schema.md", "Personal Growth");
    const second = await warnsDuring(async () => {
      expect(await reconcileWikiScenarioDrift(OWNER)).toBe(0);
    });
    expect(second).toHaveLength(1);
    expect(String(second[0][1])).toContain("Personal Growth");
  });

  it("prunes the contradiction record against the REGISTRY, not the window (DW-735)", async () => {
    // TWO PROPERTIES OF THE PRUNE, in the order they can be observed.
    //
    // 1. It runs over the registry's FULL id list. Pruning over what the pass
    //    WALKED would evict every key outside today's rotation window and
    //    re-warn the whole tail tomorrow, turning the per-day rotation back into
    //    the per-tick repetition the record exists to prevent.
    // 2. It runs at all. Re-arming only fires for a wiki the pass REACHED, so a
    //    wiki that leaves the registry would otherwise leave its key behind for
    //    the life of the isolate.
    //
    // PLANTED, not created, for the reason the window row below states: 26 real
    // creates cost four writes and a lock apiece and none of it is what this
    // asserts. Ids are padded so their lexicographic sort — the order
    // `rotatingSweepWindow` rotates over — is the index order used here.
    const total = ORPHAN_SWEEP_CANDIDATE_CAP + 1;
    const stamp = new Date().toISOString();
    const planted = Array.from({ length: total }, (_, index) => ({
      id: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
      name: `Wiki ${index}`,
      scenario: "business" as const,
      createdAt: stamp,
      updatedAt: stamp,
      // MARKED, so `readEffectiveWikiArtifact` serves the stored `purpose.md`
      // bytes rather than a canonical projection — otherwise the planted
      // purpose line would not be a witness and there would be no contradiction
      // to report.
      artifactAuthority: ARTIFACT_AUTHORITY_VERSION,
    }));
    // n = 26 against a cap of 25, so every pass misses EXACTLY ONE wiki and the
    // one it misses shifts by a single position per UTC day. Which position
    // that is is not hard-coded here — repeating `rotatingSweepWindow`'s
    // arithmetic in the row would make it agree with a broken window as
    // readily as a correct one. It is OBSERVED instead, by the probe below.
    for (const wiki of planted) {
      await fs.mkdir(path.dirname(artifactPath(wiki.id, "purpose.md")), {
        recursive: true,
      });
      await nameScenarioIn(wiki.id, "purpose.md", "Business");
      await nameScenarioIn(wiki.id, "schema.md", "Research");
    }
    const registryFile = abs(...wikiRegistryPath(OWNER).split("/"));
    await fs.mkdir(path.dirname(registryFile), { recursive: true });
    const writeRegistryOf = async (wikis: typeof planted) =>
      fs.writeFile(
        registryFile,
        JSON.stringify({ version: 1, wikis, currentId: wikis[0].id }),
        "utf8",
      );
    await writeRegistryOf(planted);

    const day = 20_000;
    const now = vi.spyOn(Date, "now");
    async function warnsOn(at: number): Promise<unknown[][]> {
      now.mockReturnValue(at * ORPHAN_SWEEP_ROTATION_MS);
      return warnsDuring(async () => {
        expect(await reconcileWikiScenarioDrift(OWNER)).toBe(0);
      });
    }

    let target: string;
    try {
      // THE PROBE. Every wiki contradicts, so on the middle day each one the
      // pass REACHES says so — and the single id that stays quiet is the one
      // outside that day's window. Deriving it this way means the row is
      // reading the real rotation rather than asserting against a copy of it.
      const seen = new Set(
        (await warnsOn(day + 2)).flatMap(([, message]) =>
          planted.map((w) => w.id).filter((id) => String(message).includes(id)),
        ),
      );
      const missed = planted.map((w) => w.id).filter((id) => !seen.has(id));
      expect(missed).toHaveLength(1);
      target = missed[0];
      // Forget everything the probe reported; the days below start clean.
      _resetWikiSweepWarnings();
      // And quiet every other wiki, so from here a line about anything but the
      // target would be noise. They now agree with themselves and with the
      // registry, so the pass still repairs nothing and writes nothing.
      for (const wiki of planted) {
        if (wiki.id === target) continue;
        await nameScenarioIn(wiki.id, "schema.md", "Business");
      }

      /** One pass on `at`, keeping only the lines that name the target. */
      const passOn = async (at: number) =>
        (await warnsOn(at)).filter(([, message]) =>
          String(message).includes(target),
        );

      // The day BEFORE the miss — in the window, so the contradiction is news.
      expect(await passOn(day + 1)).toHaveLength(1);
      // The middle day — OUT of the window. Nothing reaches it, so nothing can
      // re-arm it, and the prune must not evict it either.
      expect(await passOn(day + 2)).toHaveLength(0);
      // THE LOAD-BEARING ASSERTION. The day after, the same standing
      // contradiction is in the window again. Pruning against what the pass
      // WALKED would have dropped the key on the middle day, and this line
      // would speak a second time.
      expect(await passOn(day + 3)).toHaveLength(0);

      // Now the eviction half: the wiki leaves the registry entirely. The walk
      // never reaches it, so only the prune can clear its key.
      await writeRegistryOf(planted.filter((wiki) => wiki.id !== target));
      expect(await passOn(day + 3)).toHaveLength(0);

      // Back, with the SAME contradiction the record once held — so a surviving
      // key would silence it, and speaking again is the prune's doing.
      await writeRegistryOf(planted);
      expect(await passOn(day + 3)).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });

  it("names EVERY contradicting wiki in a pass, not just the first (DW-735)", async () => {
    // The record is per WIKI, and the collect must not stop at the first hit: a
    // partially-rolled-back BULK re-template leaves several wikis in exactly
    // this state at once, which is the case the change exists for. A per-pass
    // flag — or an `if (contradictions.length === 0)` guard on the collect —
    // would satisfy every single-wiki row above and lose the rest of the batch.
    const first = await createWiki(OWNER, { name: "One", scenario: "reading" });
    const second = await createWiki(OWNER, { name: "Two", scenario: "reading" });
    await nameScenarioIn(first.id, "purpose.md", "Business");
    await nameScenarioIn(first.id, "schema.md", "Research");
    await nameScenarioIn(second.id, "purpose.md", "General");
    await nameScenarioIn(second.id, "schema.md", "Personal Growth");

    let warned: unknown[][] = [];
    const writes = await registryWritesDuring(async () => {
      warned = await warnsDuring(async () => {
        expect(await reconcileWikiScenarioDrift(OWNER)).toBe(0);
      });
    });

    expect(writes).toBe(0);
    expect(warned).toHaveLength(2);
    // Each line names ITS OWN wiki and ITS OWN pair — an operator triaging a
    // batch has to be able to tell them apart.
    const forFirst = warned.filter(([, message]) =>
      String(message).includes(first.id),
    );
    const forSecond = warned.filter(([, message]) =>
      String(message).includes(second.id),
    );
    expect(forFirst).toHaveLength(1);
    expect(forSecond).toHaveLength(1);
    expect(String(forFirst[0][1])).toContain("Research");
    expect(String(forSecond[0][1])).toContain("Personal Growth");
    expect(String(forSecond[0][1])).not.toContain(first.id);
  });

  it("stays silent when an artifact is UNREADABLE — that is not a contradiction (DW-735)", async () => {
    // "I could not look" is the non-answer that already refuses to authorise a
    // repair; it must not be promoted into an operator line, and it must not
    // re-arm a warning the operator has already seen.
    const wiki = await createWiki(OWNER, { name: "Doomed", scenario: "reading" });
    await nameScenarioIn(wiki.id, "purpose.md", "Business");
    await nameScenarioIn(wiki.id, "schema.md", "Research");

    const storage = getStorage();
    const read = storage.readFile.bind(storage);
    const spy = vi
      .spyOn(storage, "readFile")
      .mockImplementation(async (target: string) => {
        if (target.endsWith("schema.md")) throw new Error("storage unavailable");
        return read(target);
      });
    let warned: unknown[][] = [];
    try {
      warned = await warnsDuring(async () => {
        expect(await reconcileWikiScenarioDrift(OWNER)).toBe(0);
      });
    } finally {
      spy.mockRestore();
    }
    expect(warned).toEqual([]);

    // And the record was left untouched, so the first READABLE pass is the one
    // that speaks.
    const after = await warnsDuring(async () => {
      expect(await reconcileWikiScenarioDrift(OWNER)).toBe(0);
    });
    expect(after).toHaveLength(1);
  });

  it("repairs on ONE witness when the other artifact names nothing", async () => {
    // A canonicalized `purpose.md` carries NO template line at all —
    // `renderCanonicalPurposeMarkdown` emits none — so insisting on two
    // witnesses would make the pass blind to exactly the wikis an owner has
    // already tidied. "Nothing to say" is not a contradiction of the file that
    // does have something to say.
    const wiki = await createWiki(OWNER, { name: "Doomed", scenario: "reading" });
    await fs.writeFile(
      artifactPath(wiki.id, "purpose.md"),
      renderCanonicalPurposeMarkdown("Doomed", await getWorkspaceProfile(OWNER, wiki.id)),
      "utf8",
    );
    // The premise, asserted rather than assumed: if the canonical render ever
    // grows a template line this row stops testing the one-witness case.
    expect(await fs.readFile(artifactPath(wiki.id, "purpose.md"), "utf8")).not.toContain(
      "Scenario Template:",
    );
    await nameScenarioIn(wiki.id, "schema.md", "Business");
    const versionBefore = await readDataVersion();

    expect(await reconcileWikiScenarioDrift(OWNER)).toBe(1);
    expect(await storedScenario(wiki.id)).toBe("business");
    expect(await readDataVersion()).toBe(versionBefore + 1);
  });

  it("treats a missing or unreadable artifact as no evidence at all", async () => {
    const missing = await createWiki(OWNER, { name: "Gone", scenario: "reading" });
    await fs.rm(artifactPath(missing.id, "purpose.md"));
    await fs.rm(artifactPath(missing.id, "schema.md"));
    const bytesBefore = await registryBytes();
    const versionBefore = await readDataVersion();

    // A MISSING FILE IS NOT EVIDENCE. `readWikiArtifact` answers null for
    // ENOENT, and null is "this file has nothing to say" — not "the registry is
    // wrong". Repairing on it would relabel a wiki from no evidence whatsoever.
    expect(await reconcileWikiScenarioDrift(OWNER)).toBe(0);
    expect(await registryBytes()).toBe(bytesBefore);
    expect(await readDataVersion()).toBe(versionBefore);

    // AND UNREADABLE IS THE SAME ANSWER, one step further out — but the pass
    // must not ABORT on it: the throw is caught per wiki, so the rest of the
    // window is still examined.
    const others = [
      await createWiki(OWNER, { name: "A", scenario: "reading" }),
      await createWiki(OWNER, { name: "B", scenario: "reading" }),
    ];
    for (const wiki of others) {
      await nameScenarioIn(wiki.id, "purpose.md", "Research");
      await nameScenarioIn(wiki.id, "schema.md", "Research");
    }
    await nameScenarioIn(missing.id, "purpose.md", "Business");
    await nameScenarioIn(missing.id, "schema.md", "Business");
    // THE BLOCKED WIKI IS THE ONE THE PASS REACHES FIRST. `rotatingSweepWindow`
    // sorts by code unit, so the smallest id leads the window — which is what
    // makes "the rest of the window is still examined" a claim this row can
    // actually fail on. Picked from the store rather than assumed, since the ids
    // are minted UUIDs.
    const blocked = [missing.id, ...others.map((wiki) => wiki.id)].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    )[0];
    const stillDrifted = [missing.id, ...others.map((wiki) => wiki.id)].filter(
      (id) => id !== blocked,
    );
    const storage = getStorage();
    const read = storage.readFile.bind(storage);
    const spy = vi.spyOn(storage, "readFile").mockImplementation(async (target: string) => {
      if (target.includes(blocked)) throw new Error("the artifact store is unavailable");
      return read(target);
    });
    try {
      expect(await reconcileWikiScenarioDrift(OWNER)).toBe(stillDrifted.length);
    } finally {
      spy.mockRestore();
    }
    // The unreadable one is untouched; every wiki behind it in the window was
    // still examined and repaired.
    expect(await storedScenario(blocked)).toBe("reading");
    for (const id of stillDrifted) {
      expect(await storedScenario(id)).not.toBe("reading");
    }
  });

  it("reads only the renderer's own anchors, and refuses an ambiguous file", async () => {
    // A PROSE MENTION IS NOT A DECLARATION. The witness is derived from the
    // exact line `renderPurposeMarkdown` emits — `Scenario Template: <Label> — `
    // — because both artifacts are owner-editable and an owner writing about a
    // template in a paragraph has not relabelled their wiki. A fuzzy match here
    // would relabel a record from a sentence.
    const prose = await createWiki(OWNER, { name: "Notes", scenario: "reading" });
    await fs.writeFile(
      artifactPath(prose.id, "purpose.md"),
      "# Notes\n\nThis wiki replaced our Business workspace last quarter.\n",
      "utf8",
    );
    await fs.rm(artifactPath(prose.id, "schema.md"));

    expect(await reconcileWikiScenarioDrift(OWNER)).toBe(0);
    expect(await storedScenario(prose.id)).toBe("reading");

    // AND ONE FILE NAMING TWO TEMPLATES IS NO WITNESS EITHER — an owner
    // mid-edit, a half-applied paste. The repair's whole licence to write is
    // that the bytes are unambiguous, so a file that answers two ways answers
    // none. Picking the first would relabel from a coin toss.
    await fs.writeFile(
      artifactPath(prose.id, "purpose.md"),
      [
        "# Notes",
        "",
        "Scenario Template: Business — a description.",
        "",
        "Scenario Template: Research — a description.",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(await reconcileWikiScenarioDrift(OWNER)).toBe(0);
    expect(await storedScenario(prose.id)).toBe("reading");

    // …and the same file with ONE of them removed does repair, so neither
    // assertion above is passing against a witness derivation that simply never
    // fires.
    await fs.writeFile(
      artifactPath(prose.id, "purpose.md"),
      "# Notes\n\nScenario Template: Business — a description.\n",
      "utf8",
    );
    expect(await reconcileWikiScenarioDrift(OWNER)).toBe(1);
    expect(await storedScenario(prose.id)).toBe("business");

    // THE SCHEMA ANCHOR IS A WHOLE LINE, not a mention anywhere in the file. A
    // rendered `schema.md` is long and full of prose, and matching loosely turns
    // a file that declares one template in its heading into two witnesses that
    // contradict each other — so the wiki is skipped for a divergence that is
    // not there, which is a silent failure to repair rather than a loud one.
    const schemaOnly = await createWiki(OWNER, {
      name: "Schema only",
      scenario: "reading",
    });
    await fs.rm(artifactPath(schemaOnly.id, "purpose.md"));
    await fs.writeFile(
      artifactPath(schemaOnly.id, "schema.md"),
      "# Schema — Business\n\nMigrated from our Research notes.\n\n## Page conventions\n\nBody.\n",
      "utf8",
    );

    expect(await reconcileWikiScenarioDrift(OWNER)).toBe(1);
    expect(await storedScenario(schemaOnly.id)).toBe("business");
  });

  it("bounds each pass by the sweep window and covers every wiki across UTC days", async () => {
    // ONE MORE WIKI THAN THE CAP, so the rotation is actually exercised: a pass
    // that walked the whole registry would repair all 26 on day one and this row
    // would pass for the wrong reason, which the day-one assertion below rules
    // out. `MAX_WIKIS` is 100, so 26 is a state a tenant can really reach.
    //
    // PLANTED rather than driven through `createWiki`, which every other row in
    // this suite uses: 26 real creates cost four writes, two lock acquisitions
    // and a `dataVersion` bump apiece, and none of that is what this row
    // asserts — it made the row the slowest in the file and flaky against the
    // 5s default timeout under a full parallel run. What the pass actually
    // reads is `wikis.json` and two artifacts per wiki, and those are exactly
    // the bytes written here, through the same `nameScenarioIn` helper and the
    // same `wikiRegistryPath` the rest of the suite addresses through.
    const total = ORPHAN_SWEEP_CANDIDATE_CAP + 1;
    const stamp = new Date().toISOString();
    const planted = Array.from({ length: total }, (_, index) => ({
      id: crypto.randomUUID(),
      name: `Wiki ${index}`,
      scenario: "reading" as const,
      createdAt: stamp,
      updatedAt: stamp,
    }));
    const ids = planted.map((wiki) => wiki.id);
    for (const wiki of planted) {
      await fs.mkdir(path.dirname(artifactPath(wiki.id, "purpose.md")), {
        recursive: true,
      });
      await nameScenarioIn(wiki.id, "purpose.md", "Business");
      await nameScenarioIn(wiki.id, "schema.md", "Business");
    }
    const registryFile = abs(...wikiRegistryPath(OWNER).split("/"));
    await fs.mkdir(path.dirname(registryFile), { recursive: true });
    await fs.writeFile(
      registryFile,
      JSON.stringify({ version: 1, wikis: planted, currentId: ids[0] }),
      "utf8",
    );

    // The window is `(day * cap) % n`, so two CONSECUTIVE UTC days is
    // `ceil(26 / 25)` — the bound the acceptance criterion states.
    const day = 20_000;
    const now = vi.spyOn(Date, "now");
    const versionBefore = await readDataVersion();
    let repaired = 0;
    let first = 0;
    let firstWrites = 0;
    let versionAfterFirst = 0;
    try {
      now.mockReturnValue(day * ORPHAN_SWEEP_ROTATION_MS);
      firstWrites = await registryWritesDuring(async () => {
        first = await reconcileWikiScenarioDrift(OWNER);
      });
      // Read between the two passes: the second one bumps as well, so a reading
      // taken after both would say +2 and prove nothing about either.
      versionAfterFirst = await readDataVersion();
      // Exactly the cap, never the whole registry: the pass runs under
      // `wikis:<tenant>` and reads two artifacts per wiki, so an unbounded walk
      // would hold the tenant lock for 200 reads on a full tenant.
      expect(first).toBe(ORPHAN_SWEEP_CANDIDATE_CAP);
      now.mockReturnValue((day + 1) * ORPHAN_SWEEP_ROTATION_MS);
      repaired = first + (await reconcileWikiScenarioDrift(OWNER));
    } finally {
      now.mockRestore();
    }

    // ONE WRITE AND ONE BUMP FOR TWENTY-FIVE REPAIRS — the reconciler's central
    // cost argument, which the single-repair row can only ever pin at n=1. A
    // pass that wrote per record would rewrite `wikis.json` 25 times under the
    // tenant lock and tell every open tab to refetch 25 times. It is also the
    // one row that reaches the bump message's plural branch.
    expect(firstWrites).toBe(1);
    expect(versionAfterFirst).toBe(versionBefore + 1);

    expect(repaired).toBe(total);
    const registry = await getWikiRegistry(OWNER);
    expect(registry.wikis.map((item) => item.scenario)).toEqual(
      ids.map(() => "business"),
    );
  });
});
