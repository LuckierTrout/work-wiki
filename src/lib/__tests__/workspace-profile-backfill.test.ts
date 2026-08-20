/**
 * The DW-137 backfill — the retired tenant-global Workspace Purpose relocated
 * onto the Wikis that lack one, then removed.
 *
 * Everything runs against a real temp-`DATA_DIR` filesystem provider, because
 * every claim here is about BYTES: which Wiki's file was written, whether the
 * timestamps inside it survived the move, which files were left exactly as they
 * were, and whether the legacy file is still on disk afterwards. A mocked store
 * could satisfy the counts while getting all four wrong.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { _resetLocks } from "../lock";
import { _resetStorage } from "../storage";
import { tenantForOwner } from "../wiki";
import { createWiki } from "../wikis";
import { buildWorkspaceGuidance } from "../workspace-guidance";
import { getWorkspaceProfile } from "../workspace-profile";
import { backfillLegacyWorkspaceProfiles } from "../workspace-profile-backfill";

const OWNER = "alice";
const TENANT = tenantForOwner(OWNER);

/** The legacy profile every case migrates, with timestamps worth preserving. */
const LEGACY = {
  version: 1,
  scenario: "custom",
  purpose: "Hand-authored before the split.",
  keyQuestions: ["Who decided?"],
  inScope: ["Decision evidence"],
  outOfScope: ["Rumor"],
  outputLanguage: "English",
  pageConventions: "Cite sources.",
  createdAt: "2020-01-01T00:00:00.000Z",
  updatedAt: "2021-06-30T00:00:00.000Z",
};

let tmpDir: string;
let originalDataDir: string | undefined;
let originalReadOnly: string | undefined;

function abs(...segments: string[]): string {
  return path.join(tmpDir, ...segments);
}

/** `tenants/<t>/workspace-profile.json` — the address under migration. */
function legacyPath(): string {
  return abs("tenants", TENANT, "workspace-profile.json");
}

/** `tenants/<t>/wikis/<id>/workspace-profile.json` — one Wiki's own file. */
function ownPath(wikiId: string): string {
  return abs("tenants", TENANT, "wikis", wikiId, "workspace-profile.json");
}

async function writeLegacy(bytes: string = JSON.stringify(LEGACY, null, 2)) {
  await fs.mkdir(abs("tenants", TENANT), { recursive: true });
  await fs.writeFile(legacyPath(), bytes);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-profile-backfill-"));
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
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("the legacy Workspace Purpose backfill (DW-137)", () => {
  it("does nothing at all when there is no legacy file", async () => {
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const before = await fs.readFile(ownPath(wiki.id), "utf8");

    expect(await backfillLegacyWorkspaceProfiles(OWNER)).toBe(0);

    expect(await fs.readFile(ownPath(wiki.id), "utf8")).toBe(before);
    expect(await exists(legacyPath())).toBe(false);
  });

  it("copies onto the wiki that lacks a file, leaves the one that has it, and removes the original", async () => {
    // The row the whole story exists for. `withOwn` was created after the
    // split and has a seeded profile of its own; `withoutOwn` is a wiki from
    // before it, so its directory holds `purpose.md` and `schema.md` and no
    // profile at all. Only the second may be written.
    const withOwn = await createWiki(OWNER, { name: "Kept", scenario: "business" });
    const withoutOwn = await createWiki(OWNER, { name: "Bare", scenario: "reading" });
    await fs.rm(ownPath(withoutOwn.id));
    const untouched = await fs.readFile(ownPath(withOwn.id), "utf8");
    await writeLegacy();

    // BEFORE the scan, the bare wiki reads EMPTY — not the legacy purpose.
    // That is the read-through DW-137 deleted: with it, this wiki (and every
    // other one like it, forever) rendered a purpose authored for a different
    // era of the tenant, and the file was never relocated or removed.
    expect((await getWorkspaceProfile(OWNER, withoutOwn.id)).purpose).toBe("");

    expect(await backfillLegacyWorkspaceProfiles(OWNER)).toBe(1);

    // The bytes LANDED, timestamps and all: this is a relocation, not a fresh
    // save, so re-stamping `createdAt` would erase when the owner wrote it.
    const migrated = await getWorkspaceProfile(OWNER, withoutOwn.id);
    expect(migrated.purpose).toBe("Hand-authored before the split.");
    expect(migrated.keyQuestions).toEqual(["Who decided?"]);
    expect(migrated.createdAt).toBe("2020-01-01T00:00:00.000Z");
    expect(migrated.updatedAt).toBe("2021-06-30T00:00:00.000Z");

    // The wiki that had one is byte-identical — the backfill fills gaps, it
    // never reconciles.
    expect(await fs.readFile(ownPath(withOwn.id), "utf8")).toBe(untouched);
    expect((await getWorkspaceProfile(OWNER, withOwn.id)).scenario).toBe("business");

    // And the removal milestone the read-through never had.
    expect(await exists(legacyPath())).toBe(false);
  });

  it("is idempotent: a second run copies nothing and writes nothing", async () => {
    const wiki = await createWiki(OWNER, { name: "Bare", scenario: "business" });
    await fs.rm(ownPath(wiki.id));
    await writeLegacy();

    expect(await backfillLegacyWorkspaceProfiles(OWNER)).toBe(1);
    const afterFirst = await fs.readFile(ownPath(wiki.id), "utf8");

    expect(await backfillLegacyWorkspaceProfiles(OWNER)).toBe(0);
    expect(await fs.readFile(ownPath(wiki.id), "utf8")).toBe(afterFirst);
  });

  it("does NOT overwrite a wiki's own corrupt profile, and keeps the legacy file", async () => {
    // A wiki with unparseable bytes HAS a file. Those bytes are the owner's —
    // recoverable by the next Settings save — and a migration that decided
    // "unreadable means absent" would silently replace a damaged purpose with
    // a retired one. Nothing is copied, so nothing carries the legacy bytes,
    // so deleting the legacy file would leave the tenant with no usable
    // profile anywhere at all.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    await fs.writeFile(ownPath(wiki.id), "{ not json");
    await writeLegacy();

    expect(await backfillLegacyWorkspaceProfiles(OWNER)).toBe(0);

    expect(await fs.readFile(ownPath(wiki.id), "utf8")).toBe("{ not json");
    expect(await fs.readFile(legacyPath(), "utf8")).toBe(
      JSON.stringify(LEGACY, null, 2),
    );
  });

  it("leaves an UNUSABLE legacy file alone rather than throwing", async () => {
    // Its only caller is the maintenance scan. A `SyntaxError` from
    // `JSON.parse` escaping a migration courtesy would fail a scan whose real
    // work has nothing to do with this file.
    const wiki = await createWiki(OWNER, { name: "Bare", scenario: "business" });
    await fs.rm(ownPath(wiki.id));
    await writeLegacy("{ not json");

    expect(await backfillLegacyWorkspaceProfiles(OWNER)).toBe(0);
    expect(await fs.readFile(legacyPath(), "utf8")).toBe("{ not json");
    expect(await exists(ownPath(wiki.id))).toBe(false);
  });

  it("copies onto EVERY profile-less wiki in one pass and counts them", async () => {
    // The return value is a COUNT, not a flag. With a single migrating wiki in
    // every other case, an implementation that stopped after the first copy —
    // or returned a boolean the caller coerced — would satisfy all of them
    // while leaving the second wiki bare and then deleting the only remaining
    // copy of its purpose.
    const first = await createWiki(OWNER, { name: "One", scenario: "business" });
    const second = await createWiki(OWNER, { name: "Two", scenario: "reading" });
    await fs.rm(ownPath(first.id));
    await fs.rm(ownPath(second.id));
    await writeLegacy();

    expect(await backfillLegacyWorkspaceProfiles(OWNER)).toBe(2);

    for (const wiki of [first, second]) {
      const migrated = await getWorkspaceProfile(OWNER, wiki.id);
      expect(migrated.purpose).toBe("Hand-authored before the split.");
      expect(migrated.createdAt).toBe("2020-01-01T00:00:00.000Z");
      expect(migrated.updatedAt).toBe("2021-06-30T00:00:00.000Z");
    }
    expect(await exists(legacyPath())).toBe(false);
  });

  it("leaves a schema-REJECTED legacy file alone rather than migrating a husk", async () => {
    // Valid JSON, valid object, retired `scenario` name — the realistic decay,
    // since a rename in `workspace-profile-schema.ts` turns every stored
    // profile on the old name into exactly this. The parser throws, so the
    // whole file is unusable and stays put: relocating what could be salvaged
    // would spread a profile the schema has already refused.
    const wiki = await createWiki(OWNER, { name: "Bare", scenario: "business" });
    await fs.rm(ownPath(wiki.id));
    const bytes = JSON.stringify({
      version: 1,
      scenario: "retired-name",
      purpose: "Recoverable text.",
    });
    await writeLegacy(bytes);

    expect(await backfillLegacyWorkspaceProfiles(OWNER)).toBe(0);

    expect(await exists(ownPath(wiki.id))).toBe(false);
    expect(await fs.readFile(legacyPath(), "utf8")).toBe(bytes);
  });

  it("leaves a legacy file that is a JSON ARRAY alone, and does not blank every wiki", async () => {
    // THE QUIETEST WAY THIS COULD HAVE GONE WRONG. `parseStoredWorkspaceProfile`
    // RETURNS an empty profile for JSON that is not an object — `[]`, `null`,
    // `42`, `"text"` — rather than throwing, which is right for a wiki's own
    // file and catastrophic for this one: an empty profile is truthy, so a
    // reader that delegated the whole decision to the parser would write BLANK
    // bytes onto every profile-less wiki and then delete the legacy file,
    // destroying whatever the owner actually wrote. Nothing is copied instead,
    // and the file stays for a human to look at.
    const wiki = await createWiki(OWNER, { name: "Bare", scenario: "business" });
    await fs.rm(ownPath(wiki.id));
    await writeLegacy("[]");

    expect(await backfillLegacyWorkspaceProfiles(OWNER)).toBe(0);

    expect(await exists(ownPath(wiki.id))).toBe(false);
    expect(await fs.readFile(legacyPath(), "utf8")).toBe("[]");
  });

  it("leaves an UNREADABLE legacy address alone too — a directory in its place", async () => {
    const wiki = await createWiki(OWNER, { name: "Bare", scenario: "business" });
    await fs.rm(ownPath(wiki.id));
    await fs.mkdir(legacyPath(), { recursive: true });

    expect(await backfillLegacyWorkspaceProfiles(OWNER)).toBe(0);
    expect(await exists(legacyPath())).toBe(true);
    expect(await exists(ownPath(wiki.id))).toBe(false);
  });

  it("keeps the legacy file when the registry is empty — a later scan finishes the job", async () => {
    // There is nowhere to put the bytes yet. Deleting them here would destroy
    // the owner's purpose on the strength of a registry they have not filled
    // in, which is precisely the case the file is waiting for.
    await writeLegacy();

    expect(await backfillLegacyWorkspaceProfiles(OWNER)).toBe(0);
    expect(await fs.readFile(legacyPath(), "utf8")).toBe(
      JSON.stringify(LEGACY, null, 2),
    );
  });

  it("writes and deletes nothing on a read-only deployment", async () => {
    const wiki = await createWiki(OWNER, { name: "Bare", scenario: "business" });
    await fs.rm(ownPath(wiki.id));
    await writeLegacy();
    // Flipped AFTER the fixture is built, since a read-only deployment cannot
    // create a wiki either.
    process.env.YOPEDIA_READONLY = "1";

    // Answers, rather than refusing: nobody ASKED for this write, so the
    // refusal must not surface as a failed scan.
    expect(await backfillLegacyWorkspaceProfiles(OWNER)).toBe(0);

    expect(await exists(ownPath(wiki.id))).toBe(false);
    expect(await fs.readFile(legacyPath(), "utf8")).toBe(
      JSON.stringify(LEGACY, null, 2),
    );
  });

  it("copies the wikis it can when one fails, and keeps the legacy file for the next scan", async () => {
    // A directory where one wiki's profile belongs: the read throws EISDIR
    // rather than the ENOENT that means "no file of its own", so that wiki is
    // a FAILURE rather than a skip. The other wiki still gets its copy — one
    // tenant-mate's broken storage is not the rest of the tenant's problem —
    // and the legacy file stays, because a wiki that wanted these bytes did
    // not get them.
    const broken = await createWiki(OWNER, { name: "Broken", scenario: "business" });
    const healthy = await createWiki(OWNER, { name: "Healthy", scenario: "reading" });
    await fs.rm(ownPath(broken.id));
    await fs.mkdir(ownPath(broken.id));
    await fs.rm(ownPath(healthy.id));
    await writeLegacy();

    expect(await backfillLegacyWorkspaceProfiles(OWNER)).toBe(1);

    expect((await getWorkspaceProfile(OWNER, healthy.id)).purpose).toBe(
      "Hand-authored before the split.",
    );
    expect(await fs.readFile(legacyPath(), "utf8")).toBe(
      JSON.stringify(LEGACY, null, 2),
    );
  });

  it("renders no guidance for an owner holding a legacy file and no wiki", async () => {
    // The read paths do not know this address any more, backfill or no
    // backfill — so an owner in the state the migration is FOR gets nothing in
    // their prompts until a scan relocates the file onto a wiki they created.
    await writeLegacy();

    expect(await buildWorkspaceGuidance(OWNER)).toBe("");
    expect(await backfillLegacyWorkspaceProfiles(OWNER)).toBe(0);

    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    await fs.rm(ownPath(wiki.id));
    expect(await buildWorkspaceGuidance(OWNER)).toBe("");

    // …and after the scan, the relocated purpose is what the prompt renders.
    expect(await backfillLegacyWorkspaceProfiles(OWNER)).toBe(1);
    expect(await buildWorkspaceGuidance(OWNER)).toContain(
      "Hand-authored before the split.",
    );
  });
});
