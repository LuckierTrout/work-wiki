import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readDataVersion } from "../data-version";
import { logger } from "../logger";
import { _resetLocks } from "../lock";
import { _resetStorage, getStorage } from "../storage";
import { wikiProfilePath } from "../wiki-paths";
import {
  listWikiArtifactRevisions,
  readWikiArtifactRevision,
} from "../wiki-artifact-revisions";
import {
  applyScenarioTemplate,
  canonicalizeWikiPurpose,
  createWiki,
  getWikiRegistry,
  readEffectiveWikiArtifact,
  readWikiArtifact,
  wikiArtifactPath,
  wikiRegistryPath,
} from "../wikis";
import { buildWorkspaceGuidance } from "../workspace-guidance";
import { canonicalizeWorkspacePurposes } from "../workspace-profile-backfill";
import {
  LEGACY_CONVENTIONS_END,
  LEGACY_CONVENTIONS_START,
} from "../workspace-purpose";

const OWNER = "alice";

const PROFILE = {
  version: 1,
  scenario: "custom",
  purpose: "Preserve the owner’s unique migration purpose.",
  keyQuestions: ["Which decision changed?"],
  inScope: ["Signed decisions"],
  outOfScope: ["Unverified rumor"],
  outputLanguage: "English",
  pageConventions: "Every claim names its evidence bundle.",
  createdAt: "2021-01-02T03:04:05.000Z",
  updatedAt: "2022-02-03T04:05:06.000Z",
  preservedUnknownField: "must remain byte-for-byte",
};

let tmpDir: string;
let originalDataDir: string | undefined;
let originalReadOnly: string | undefined;

function abs(relative: string): string {
  return path.join(tmpDir, relative);
}

async function write(relative: string, content: string): Promise<void> {
  const target = abs(relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

async function makeLegacyWiki() {
  const wiki = await createWiki(OWNER, { name: "Decision room", scenario: "business" });
  const registry = JSON.parse(await fs.readFile(abs(wikiRegistryPath(OWNER)), "utf8"));
  delete registry.wikis[0].artifactAuthority;
  await write(wikiRegistryPath(OWNER), JSON.stringify(registry, null, 2));
  const profileBytes = ` {\n  "version": 1,\n  "scenario": "custom",\n  "purpose": ${JSON.stringify(PROFILE.purpose)},\n  "keyQuestions": [${JSON.stringify(PROFILE.keyQuestions[0])}],\n  "inScope": [${JSON.stringify(PROFILE.inScope[0])}],\n  "outOfScope": [${JSON.stringify(PROFILE.outOfScope[0])}],\n  "outputLanguage": "English",\n  "pageConventions": ${JSON.stringify(PROFILE.pageConventions)},\n  "createdAt": "${PROFILE.createdAt}",\n  "updatedAt": "${PROFILE.updatedAt}",\n  "preservedUnknownField": "must remain byte-for-byte"\n}\n`;
  await write(wikiProfilePath(OWNER, wiki.id), profileBytes);
  return { wiki, profileBytes };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-purpose-canonical-"));
  originalDataDir = process.env.DATA_DIR;
  originalReadOnly = process.env.YOPEDIA_READONLY;
  process.env.DATA_DIR = tmpDir;
  delete process.env.YOPEDIA_READONLY;
  _resetLocks();
  _resetStorage();
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalReadOnly === undefined) delete process.env.YOPEDIA_READONLY;
  else process.env.YOPEDIA_READONLY = originalReadOnly;
  vi.restoreAllMocks();
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("canonical Workspace Purpose migration", () => {
  it("projects every supported field, snapshots changed artifacts, preserves evidence, marks last, and is idempotent", async () => {
    const { wiki, profileBytes } = await makeLegacyWiki();
    const oldPurpose = "# Decision room\n\nOld seeded purpose.\n";
    const oldSchema = "# Schema\n\n## Page conventions\n\nExisting rule.\n\n## Key questions\n\n- Existing?\n";
    await write(wikiArtifactPath(OWNER, wiki.id, "purpose.md"), oldPurpose);
    await write(wikiArtifactPath(OWNER, wiki.id, "schema.md"), oldSchema);

    const effectiveBefore = await readEffectiveWikiArtifact(OWNER, wiki.id, "purpose.md");
    expect(effectiveBefore).toContain(PROFILE.purpose);
    expect(effectiveBefore).toContain(PROFILE.keyQuestions[0]);
    expect(effectiveBefore).not.toBe(oldPurpose);
    const versionBefore = await readDataVersion();

    expect(await canonicalizeWikiPurpose(OWNER, wiki.id)).toBe("migrated");

    const purpose = await readWikiArtifact(OWNER, wiki.id, "purpose.md");
    const schema = await readWikiArtifact(OWNER, wiki.id, "schema.md");
    expect(purpose).toContain(PROFILE.purpose);
    expect(purpose).toContain(PROFILE.keyQuestions[0]);
    expect(purpose).toContain(PROFILE.inScope[0]);
    expect(purpose).toContain(PROFILE.outOfScope[0]);
    expect(purpose).toContain("## Output language\n\nEnglish");
    expect(schema).toContain(LEGACY_CONVENTIONS_START);
    expect(schema).toContain(PROFILE.pageConventions);
    expect(schema).toContain(LEGACY_CONVENTIONS_END);
    expect(schema?.indexOf(PROFILE.pageConventions)).toBeLessThan(schema?.indexOf("## Key questions") ?? 0);
    expect(await fs.readFile(abs(wikiProfilePath(OWNER, wiki.id)), "utf8")).toBe(profileBytes);
    expect((await getWikiRegistry(OWNER)).wikis[0].artifactAuthority).toBe(1);
    expect(await readDataVersion()).toBe(versionBefore + 1);

    const purposeHistory = await listWikiArtifactRevisions(OWNER, wiki.id, "purpose.md");
    const schemaHistory = await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md");
    expect(purposeHistory).toHaveLength(1);
    expect(schemaHistory).toHaveLength(1);
    expect(await readWikiArtifactRevision(OWNER, wiki.id, "purpose.md", purposeHistory[0].timestamp)).toBe(oldPurpose);
    expect(await readWikiArtifactRevision(OWNER, wiki.id, "schema.md", schemaHistory[0].timestamp)).toBe(oldSchema);

    const firstPurpose = purpose;
    const firstSchema = schema;
    expect(await canonicalizeWikiPurpose(OWNER, wiki.id)).toBe("already-authoritative");
    expect(await readDataVersion()).toBe(versionBefore + 1);
    expect(await readWikiArtifact(OWNER, wiki.id, "purpose.md")).toBe(firstPurpose);
    expect(await readWikiArtifact(OWNER, wiki.id, "schema.md")).toBe(firstSchema);
    expect(await listWikiArtifactRevisions(OWNER, wiki.id, "purpose.md")).toHaveLength(1);
    expect(await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md")).toHaveLength(1);

    await write(
      wikiProfilePath(OWNER, wiki.id),
      JSON.stringify({ ...PROFILE, purpose: "A later stale profile mutation." }),
    );
    expect(await buildWorkspaceGuidance(OWNER)).toContain(PROFILE.purpose);
    expect(await buildWorkspaceGuidance(OWNER)).not.toContain("A later stale profile mutation.");
  });

  it("leaves corrupt evidence unmarked and retryable while serving stored Markdown", async () => {
    const { wiki } = await makeLegacyWiki();
    const stored = "# Decision room\n\nRecoverable artifact purpose.\n";
    await write(wikiArtifactPath(OWNER, wiki.id, "purpose.md"), stored);
    await write(wikiProfilePath(OWNER, wiki.id), "{ not valid json");
    const versionBefore = await readDataVersion();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect(await canonicalizeWorkspacePurposes(OWNER)).toBe(0);
    expect((await getWikiRegistry(OWNER)).wikis[0].artifactAuthority).toBeUndefined();
    expect(await readWikiArtifact(OWNER, wiki.id, "purpose.md")).toBe(stored);
    expect(await readEffectiveWikiArtifact(OWNER, wiki.id, "purpose.md")).toBe(stored);
    expect(await fs.readFile(abs(wikiProfilePath(OWNER, wiki.id)), "utf8")).toBe("{ not valid json");
    expect(await readDataVersion()).toBe(versionBefore);
    expect(warn).toHaveBeenCalled();
  });

  it("compensates artifact writes when the authority marker cannot commit", async () => {
    const { wiki, profileBytes } = await makeLegacyWiki();
    const purposeBefore = await readWikiArtifact(OWNER, wiki.id, "purpose.md");
    const schemaBefore = await readWikiArtifact(OWNER, wiki.id, "schema.md");
    const versionBefore = await readDataVersion();
    const registryPath = wikiRegistryPath(OWNER);
    const storage = getStorage();
    const realWrite = storage.writeFile.bind(storage);
    vi.spyOn(storage, "writeFile").mockImplementation(async (target, content) => {
      if (target === registryPath) throw new Error("registry unavailable");
      return realWrite(target, content);
    });

    await expect(canonicalizeWikiPurpose(OWNER, wiki.id)).rejects.toThrow("registry unavailable");
    expect(await readWikiArtifact(OWNER, wiki.id, "purpose.md")).toBe(purposeBefore);
    expect(await readWikiArtifact(OWNER, wiki.id, "schema.md")).toBe(schemaBefore);
    expect(await fs.readFile(abs(wikiProfilePath(OWNER, wiki.id)), "utf8")).toBe(profileBytes);
    expect((await getWikiRegistry(OWNER)).wikis[0].artifactAuthority).toBeUndefined();
    expect(await readDataVersion()).toBe(versionBefore);
  });

  it("re-template replaces and revisions both artifacts without making the profile live", async () => {
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const profileBytes = JSON.stringify({ ...PROFILE, purpose: "Stale legacy profile." }, null, 3);
    await write(wikiProfilePath(OWNER, wiki.id), profileBytes);
    const purposeBefore = "# Ops\n\nOwner-authored canonical Purpose.\n";
    const schemaBefore = "# Schema\n\n## Page conventions\n\nOwner-authored canonical rule.\n";
    await write(wikiArtifactPath(OWNER, wiki.id, "purpose.md"), purposeBefore);
    await write(wikiArtifactPath(OWNER, wiki.id, "schema.md"), schemaBefore);
    const versionBefore = await readDataVersion();

    await applyScenarioTemplate(OWNER, wiki.id, "reading");

    expect(await readDataVersion()).toBe(versionBefore + 1);
    expect((await getWikiRegistry(OWNER)).wikis[0].artifactAuthority).toBe(1);
    expect(await fs.readFile(abs(wikiProfilePath(OWNER, wiki.id)), "utf8")).toBe(profileBytes);
    expect(await buildWorkspaceGuidance(OWNER)).not.toContain("Stale legacy profile.");
    const purposeHistory = await listWikiArtifactRevisions(OWNER, wiki.id, "purpose.md");
    const schemaHistory = await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md");
    expect(await readWikiArtifactRevision(OWNER, wiki.id, "purpose.md", purposeHistory[0].timestamp)).toBe(purposeBefore);
    expect(await readWikiArtifactRevision(OWNER, wiki.id, "schema.md", schemaHistory[0].timestamp)).toBe(schemaBefore);
  });
});
