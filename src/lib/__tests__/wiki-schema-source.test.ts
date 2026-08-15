/**
 * Story 1.2 — the Schema a Scenario Template seeds is the Schema that executes.
 *
 * AD-10 says there is ONE loader and no forked copy of the page conventions in
 * code. So `loadPageConventions()` (no argument — how ingest, query, and lint
 * call it) must read the ACTIVE Wiki's `schema.md`, and must degrade to the
 * repo-root `SCHEMA.md` when there is no owner, no Wiki, or an unreadable file.
 *
 * `loadPageTemplates()` stays on the root file: page templates are the engine's
 * own output shapes, not a Scenario Template, and a seeded `schema.md` has no
 * `## Page templates` section to find.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { _resetLocks } from "../lock";
import { loadPageConventions, loadPageTemplates } from "../schema";
import { _resetStorage } from "../storage";
import { createWiki, wikiArtifactPath } from "../wikis";

const OWNER = "alice";

let tmpDir: string;
let originalDataDir: string | undefined;
let originalOwner: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-schema-"));
  originalDataDir = process.env.DATA_DIR;
  originalOwner = process.env.NEXT_PUBLIC_OWNER_HANDLE;
  process.env.DATA_DIR = tmpDir;
  process.env.NEXT_PUBLIC_OWNER_HANDLE = OWNER;
  _resetLocks();
  _resetStorage();
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalOwner === undefined) delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
  else process.env.NEXT_PUBLIC_OWNER_HANDLE = originalOwner;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("loadPageConventions resolves the active wiki's Schema", () => {
  it("returns the repo-root conventions when the registry is empty", async () => {
    const root = await loadPageConventions();
    expect(root).toContain("## Page conventions");
    // The root file documents the engine's kebab-case slug rule; a seeded
    // Scenario Template Schema does not.
    expect(root).toBe(await loadPageConventions(`${process.cwd()}/SCHEMA.md`));
  });

  it("returns the current wiki's conventions once one exists", async () => {
    const root = await loadPageConventions();
    await createWiki(OWNER, { name: "Shelf", scenario: "reading" });

    const active = await loadPageConventions();
    expect(active).toContain("## Page conventions");
    expect(active).not.toBe(root);
    // The reading template's own prose, projected into the executable Schema.
    expect(active).toContain("Preserve sequence when it matters");
  });

  it("adds the scenario's guidance without dropping the engine's rules", async () => {
    const root = await loadPageConventions();
    await createWiki(OWNER, { name: "Shelf", scenario: "reading" });
    const active = await loadPageConventions();

    // Everything the ingest/graph/index machinery relies on is still in the
    // prompt after a wiki is activated — this is the regression that would
    // silently degrade every generated page.
    for (const rule of [
      "/^[a-z0-9][a-z0-9-]*$/",
      "[Title](other-slug.md)",
      "Every page starts with an H1 title",
      "one-paragraph summary",
      "log.md",
    ]) {
      expect(root).toContain(rule);
      expect(active).toContain(rule);
    }
    expect(active).toContain("Preserve sequence when it matters");
    expect(active.length).toBeGreaterThan(root.length);
  });

  it("falls back to the root Schema when the wiki's conventions section is empty", async () => {
    const wiki = await createWiki(OWNER, { name: "Shelf", scenario: "reading" });
    // A hand-emptied schema.md must not silently strip the prompt to "".
    await fs.writeFile(
      path.join(tmpDir, wikiArtifactPath(OWNER, wiki.id, "schema.md")),
      "# Schema\n\n## Page conventions\n\n## Key questions\n\n- nothing\n",
    );
    expect(await loadPageConventions()).toBe(
      await loadPageConventions(`${process.cwd()}/SCHEMA.md`),
    );
  });

  it("follows the active pointer when a second wiki is created", async () => {
    await createWiki(OWNER, { name: "Shelf", scenario: "reading" });
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const active = await loadPageConventions();
    expect(active).toContain("Prefer explicit owners");
    expect(active).not.toContain("Preserve sequence when it matters");
  });

  it("falls back to the root Schema when the wiki's file cannot be read", async () => {
    const wiki = await createWiki(OWNER, { name: "Shelf", scenario: "reading" });
    await fs.rm(path.join(tmpDir, wikiArtifactPath(OWNER, wiki.id, "schema.md")));
    const conventions = await loadPageConventions();
    expect(conventions).toBe(await loadPageConventions(`${process.cwd()}/SCHEMA.md`));
  });

  it("falls back to the root Schema when no owner handle is configured", async () => {
    await createWiki(OWNER, { name: "Shelf", scenario: "reading" });
    delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
    expect(await loadPageConventions()).toBe(
      await loadPageConventions(`${process.cwd()}/SCHEMA.md`),
    );
  });

  it("respects an explicit path override, wiki or no wiki", async () => {
    await createWiki(OWNER, { name: "Shelf", scenario: "reading" });
    const explicit = path.join(tmpDir, "OTHER.md");
    await fs.writeFile(explicit, "# Other\n\n## Page conventions\n\nOnly this.\n");
    expect(await loadPageConventions(explicit)).toContain("Only this.");
  });
});

describe("loadPageTemplates stays on the repo-root SCHEMA.md", () => {
  it("is unaffected by an active wiki", async () => {
    const before = await loadPageTemplates();
    await createWiki(OWNER, { name: "Shelf", scenario: "reading" });
    const after = await loadPageTemplates();
    expect(before).toContain("## Page templates");
    expect(after).toBe(before);
  });
});
