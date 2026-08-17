/**
 * Story 1.2 — the Wiki entity, its registry, and template seeding.
 *
 * Everything runs against a real temp-`DATA_DIR` filesystem provider (the
 * `workspace-profile.test.ts` recipe) so the assertions are about bytes on
 * disk, not about mocks: which files exist, that two templates genuinely
 * differ, and — the load-bearing one — that applying a template leaves
 * `tenants/<t>/wiki/**` and `tenants/<t>/raw/**` byte-identical.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ClientInputError } from "../errors";
import { _resetLocks, withFileLock } from "../lock";
import { _resetStorage } from "../storage";
import { tenantForOwner } from "../wiki";
import { wikiLockKey } from "../wiki-paths";
import { buildWorkspaceGuidance } from "../workspace-guidance";
import { getWorkspaceProfile, saveWorkspaceProfile } from "../workspace-profile";
import { WORKSPACE_SCENARIO_TEMPLATES } from "../workspace-profile-schema";
import {
  MAX_WIKIS,
  applyScenarioTemplate,
  createWiki,
  getCurrentWiki,
  getWikiRegistry,
  listWikis,
  parseCreateWikiInput,
  parseScenarioInput,
  readWikiArtifact,
  setCurrentWiki,
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
