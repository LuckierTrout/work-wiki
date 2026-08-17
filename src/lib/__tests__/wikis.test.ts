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
import { ClientInputError } from "../errors";
import { _resetLocks, withFileLock } from "../lock";
import { _resetStorage, getStorage } from "../storage";
import { tenantForOwner } from "../wiki";
import { wikiLockKey } from "../wiki-paths";
import { buildWorkspaceGuidance } from "../workspace-guidance";
import { getWorkspaceProfile, saveWorkspaceProfile } from "../workspace-profile";
import { WORKSPACE_SCENARIO_TEMPLATES } from "../workspace-profile-schema";
import {
  MAX_WIKIS,
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
    await expect(
      createWiki(OWNER, { name: "   ", scenario: "general" } as never),
    ).rejects.toThrow(ClientInputError);
    await expect(
      createWiki(OWNER, { name: "x", scenario: "custom" } as never),
    ).rejects.toThrow(ClientInputError);

    expect(await listWikis(OWNER)).toEqual([]);
    await expect(fs.stat(abs("tenants", TENANT, "wikis.json"))).rejects.toThrow();
    await expect(fs.stat(abs("tenants", TENANT, "wikis"))).rejects.toThrow();
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

    const profileStore = await fs.readFile(
      path.resolve(__dirname, "../workspace-profile.ts"),
      "utf8",
    );
    expect(profileStore).toContain("withFileLock(wikiLockKey(owner)");
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
    expect(await sweepOrphanWikiDirectories(OWNER)).toBe(1);
    expect(await exists(wikiDir(drop.id))).toBe(false);
    expect(await exists(wikiDir(keep.id))).toBe(true);
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

  it("refuses to sweep against an empty registry, whatever is on disk", async () => {
    // `readRegistry` degrades a missing or unparseable wikis.json to an EMPTY
    // registry, so "no entries but directories on disk" is a lost or
    // half-restored registry as often as it is an empty tenant — and against
    // that reading, every wiki the owner has is an orphan. It also cannot be a
    // legitimate post-delete state: the current wiki is undeletable, so a
    // delete never empties the registry.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const purpose = await readWikiArtifact(OWNER, wiki.id, "purpose.md");
    await fs.rm(abs(wikiRegistryPath(OWNER)));

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
});
