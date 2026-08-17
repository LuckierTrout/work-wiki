/**
 * The Workspace Purpose profile, now stored PER WIKI.
 *
 * Everything runs against a real temp-`DATA_DIR` filesystem provider so the
 * assertions are about bytes on disk: which wiki's file was written, which was
 * left alone, and which profile the prompt path actually renders.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { buildIngestSystemPrompt } from "../ingest";
import { _resetLocks } from "../lock";
import { buildQuerySystemPrompt } from "../query";
import { _resetStorage } from "../storage";
import { tenantForOwner } from "../wiki";
import { createWiki, setCurrentWiki, wikiRegistryPath } from "../wikis";
import { buildWorkspaceGuidance } from "../workspace-guidance";
import {
  emptyWorkspaceProfile,
  getWorkspaceProfile,
  renderWorkspaceGuidance,
  saveWorkspaceProfile,
} from "../workspace-profile";
import {
  WORKSPACE_SCENARIO_TEMPLATES,
  parseWorkspaceProfileInput,
} from "../workspace-profile-schema";

const OWNER = "alice";
const TENANT = tenantForOwner(OWNER);
/** A well-shaped id that no registry entry uses — "this wiki has no file yet". */
const UNSEEDED_ID = "00000000-0000-4000-8000-000000000042";

let tmpDir: string;
let originalDataDir: string | undefined;

function abs(...segments: string[]): string {
  return path.join(tmpDir, ...segments);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-profile-"));
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

describe("workspace purpose profile", () => {
  it("starts empty and stores one profile per wiki", async () => {
    expect(await getWorkspaceProfile(OWNER, UNSEEDED_ID)).toEqual(emptyWorkspaceProfile());

    const first = await createWiki(OWNER, { name: "One", scenario: "business" });
    const second = await createWiki(OWNER, { name: "Two", scenario: "reading" });

    const saved = await saveWorkspaceProfile("Alice", first.id, {
      scenario: "research",
      purpose: "Understand which evidence supports the launch decision.",
      keyQuestions: ["What changed?", "What changed?", " What is uncertain? "],
      inScope: ["Decision evidence"],
      outOfScope: ["Unsupported forecasts"],
      outputLanguage: "English",
      pageConventions: "Separate facts from recommendations.",
    });

    expect(saved.keyQuestions).toEqual(["What changed?", "What is uncertain?"]);
    expect(saved.createdAt).toBeTruthy();
    expect(saved.updatedAt).toBeTruthy();
    // The owner's edit landed on the wiki they were editing…
    expect((await getWorkspaceProfile(OWNER, first.id)).purpose).toContain(
      "launch decision",
    );
    // …and the other wiki still holds its own seeded template.
    expect((await getWorkspaceProfile(OWNER, second.id)).scenario).toBe("reading");
    // Storage is per wiki directory, not tenant-global.
    await expect(
      fs.stat(abs("tenants", TENANT, "wikis", first.id, "workspace-profile.json")),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(abs("tenants", TENANT, "workspace-profile.json")),
    ).rejects.toThrow();
    // Another owner shares nothing.
    expect(await getWorkspaceProfile("bob", UNSEEDED_ID)).toEqual(
      emptyWorkspaceProfile(),
    );
  });

  it("reads through to a legacy tenant-global profile and never rewrites it", async () => {
    const wiki = await createWiki(OWNER, { name: "Legacy", scenario: "business" });
    // A wiki created before per-Wiki profiles: no file of its own, and the
    // retired tenant-global singleton still holding the hand-authored purpose.
    const perWiki = abs("tenants", TENANT, "wikis", wiki.id, "workspace-profile.json");
    await fs.rm(perWiki);
    const legacyPath = abs("tenants", TENANT, "workspace-profile.json");
    const legacyBytes = JSON.stringify(
      {
        version: 1,
        scenario: "custom",
        purpose: "Hand-authored before the split.",
        keyQuestions: ["Who decided?"],
        inScope: [],
        outOfScope: [],
        outputLanguage: "English",
        pageConventions: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      null,
      2,
    );
    await fs.writeFile(legacyPath, legacyBytes);

    const readThrough = await getWorkspaceProfile(OWNER, wiki.id);
    expect(readThrough.purpose).toBe("Hand-authored before the split.");
    expect(readThrough.createdAt).toBe("2026-01-01T00:00:00.000Z");

    await saveWorkspaceProfile(OWNER, wiki.id, {
      ...readThrough,
      purpose: "Migrated onto its own wiki.",
    });

    // The next save writes the per-Wiki file; the legacy one is untouched.
    expect((await getWorkspaceProfile(OWNER, wiki.id)).purpose).toBe(
      "Migrated onto its own wiki.",
    );
    expect(await fs.readFile(legacyPath, "utf8")).toBe(legacyBytes);
    await expect(fs.stat(perWiki)).resolves.toBeTruthy();
  });

  it("treats an unusable legacy file as absent rather than blocking every write", async () => {
    // A `SyntaxError` from `JSON.parse` — or an `EISDIR` from a directory in
    // its place — must not escape a read-only fallback. It degrades to "no
    // legacy profile", it does not take the caller down: on the read path that
    // is a 500 on Settings and a failed ingest turn, and the `createWiki`
    // assertions below pin that the write path stays clear of this address
    // altogether (it consulted it for `createdAt` once, and a corrupt file
    // rejected creation for the whole tenant).
    await fs.mkdir(abs("tenants", TENANT), { recursive: true });
    await fs.writeFile(abs("tenants", TENANT, "workspace-profile.json"), "{ not json");

    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    expect((await getWorkspaceProfile(OWNER, wiki.id)).scenario).toBe("business");

    // And with no per-Wiki file either, the unusable legacy reads as empty.
    await fs.rm(abs("tenants", TENANT, "wikis", wiki.id, "workspace-profile.json"));
    expect(await getWorkspaceProfile(OWNER, wiki.id)).toEqual(emptyWorkspaceProfile());

    // The same for a directory where the file belongs.
    await fs.rm(abs("tenants", TENANT, "workspace-profile.json"));
    await fs.mkdir(abs("tenants", TENANT, "workspace-profile.json"));
    expect(await getWorkspaceProfile(OWNER, wiki.id)).toEqual(emptyWorkspaceProfile());
    await expect(
      createWiki(OWNER, { name: "Two", scenario: "reading" }),
    ).resolves.toBeTruthy();
  });

  it("stamps a newly seeded wiki with its own createdAt, not the legacy file's", async () => {
    // `putWorkspaceProfile` reads THIS wiki's own file for `createdAt`. Reading
    // through `getWorkspaceProfile` instead would inherit the retired
    // singleton's timestamp and date a wiki created today to 2020.
    await fs.mkdir(abs("tenants", TENANT), { recursive: true });
    await fs.writeFile(
      abs("tenants", TENANT, "workspace-profile.json"),
      JSON.stringify({
        version: 1,
        scenario: "custom",
        purpose: "Older than the wiki.",
        keyQuestions: [],
        inScope: [],
        outOfScope: [],
        outputLanguage: "English",
        pageConventions: "",
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-01T00:00:00.000Z",
      }),
    );

    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const seeded = await getWorkspaceProfile(OWNER, wiki.id);
    expect(seeded.createdAt).not.toBe("2020-01-01T00:00:00.000Z");
    expect(Date.parse(seeded.createdAt!)).toBeGreaterThan(Date.parse("2024-01-01"));
  });

  it("validates bounded profile input and independently authored templates", () => {
    expect(WORKSPACE_SCENARIO_TEMPLATES.business.purpose).toContain("operating memory");
    expect(() => parseWorkspaceProfileInput({ scenario: "unknown" })).toThrow(
      "Choose a valid workspace scenario",
    );
    expect(() => parseWorkspaceProfileInput({
      scenario: "custom",
      keyQuestions: "not-an-array",
    })).toThrow("Key questions must be a list");
  });

  it("renders evidence-safe guidance and omits an empty profile", () => {
    expect(renderWorkspaceGuidance(emptyWorkspaceProfile())).toBe("");
    const guidance = renderWorkspaceGuidance({
      scenario: "custom",
      purpose: "Track the Phoenix program.",
      keyQuestions: ["Who owns the next decision?"],
      inScope: ["Decisions"],
      outOfScope: ["Rumor"],
      outputLanguage: "English",
      pageConventions: "Use explicit dates.",
    });
    expect(guidance).toContain("WORKSPACE PURPOSE");
    expect(guidance).toContain("never overrides source evidence");
    expect(guidance).toContain("Track the Phoenix program");
    expect(guidance).toContain("Who owns the next decision?");
  });
});

describe("guidance follows the active wiki", () => {
  it("renders nothing when the owner has no wiki at all", async () => {
    expect(await buildWorkspaceGuidance(OWNER)).toBe("");
  });

  it("still renders a legacy purpose while the owner has no wiki yet", async () => {
    // The read-through is keyed on a wikiId, so an owner who upgrades with a
    // hand-authored tenant-global profile and has not created a wiki yet would
    // otherwise lose it from every prompt on the very deploy the fallback
    // exists to survive. Bounded to the migration window: the first wiki they
    // create seeds its own profile, and this branch stops being reached.
    await fs.mkdir(abs("tenants", TENANT), { recursive: true });
    await fs.writeFile(
      abs("tenants", TENANT, "workspace-profile.json"),
      JSON.stringify({
        version: 1,
        scenario: "custom",
        purpose: "Written before there were wikis.",
        keyQuestions: [],
        inScope: [],
        outOfScope: [],
        outputLanguage: "English",
        pageConventions: "",
      }),
    );

    expect(await buildWorkspaceGuidance(OWNER)).toContain(
      "Written before there were wikis.",
    );

    // Once a wiki exists, its own seeded profile takes over.
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const guidance = await buildWorkspaceGuidance(OWNER);
    expect(guidance).not.toContain("Written before there were wikis.");
    expect(guidance).toContain("operating memory");
  });

  it("degrades to no guidance when the registry cannot be read", async () => {
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    // Unreadable, not absent: a directory where wikis.json belongs makes the
    // read throw EISDIR rather than the ENOENT `readRegistry` degrades itself.
    // Guidance is an ADDITION to a prompt, so this must not fail the turn.
    await fs.rm(abs(wikiRegistryPath(OWNER)));
    await fs.mkdir(abs(wikiRegistryPath(OWNER)));

    expect(await buildWorkspaceGuidance(OWNER)).toBe("");
  });

  it("swaps which profile reaches the prompt when the pointer moves", async () => {
    const first = await createWiki(OWNER, { name: "One", scenario: "business" });
    const second = await createWiki(OWNER, { name: "Two", scenario: "reading" });
    await saveWorkspaceProfile(OWNER, first.id, {
      scenario: "custom",
      purpose: "Track Project Lighthouse decisions.",
      keyQuestions: [],
      inScope: [],
      outOfScope: [],
      outputLanguage: "English",
      pageConventions: "",
    });
    await saveWorkspaceProfile(OWNER, second.id, {
      scenario: "custom",
      purpose: "Track the Phoenix reading shelf.",
      keyQuestions: [],
      inScope: [],
      outOfScope: [],
      outputLanguage: "English",
      pageConventions: "",
    });

    expect(await buildWorkspaceGuidance(OWNER)).toContain("Phoenix reading shelf");

    await setCurrentWiki(OWNER, first.id);
    const guidance = await buildWorkspaceGuidance(OWNER);
    expect(guidance).toContain("Project Lighthouse");
    expect(guidance).not.toContain("Phoenix reading shelf");
  });

  it("injects the active wiki's saved purpose into ingest and query prompts", async () => {
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    await saveWorkspaceProfile(OWNER, wiki.id, {
      scenario: "business",
      purpose: "Keep a source-backed record of Project Lighthouse decisions.",
      keyQuestions: ["What was approved?"],
      inScope: ["Decisions"],
      outOfScope: [],
      outputLanguage: "English",
      pageConventions: "Preserve named owners.",
    });

    expect(await buildWorkspaceGuidance(OWNER)).toContain("Project Lighthouse");
    expect(await buildIngestSystemPrompt(OWNER)).toContain("Project Lighthouse");
    expect(
      await buildQuerySystemPrompt("context", [], [], "prose", OWNER),
    ).toContain("Project Lighthouse");
  });
});
