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
import {
  applyScenarioTemplate,
  createWiki,
  setCurrentWiki,
  wikiRegistryPath,
} from "../wikis";
import { withWikiLock } from "../wiki-lock";
import { buildWorkspaceGuidance } from "../workspace-guidance";
import {
  emptyWorkspaceProfile,
  getWorkspaceProfile,
  putWorkspaceProfile,
  renderWorkspaceGuidance,
  saveWorkspaceProfile,
} from "../workspace-profile";
import {
  WORKSPACE_SCENARIO_TEMPLATES,
  parseWorkspaceProfileInput,
} from "../workspace-profile-schema";
import { objectVersion } from "../write-precondition";

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

  it("treats this wiki's OWN unparseable profile as empty rather than throwing (DW-144)", async () => {
    // The file `putWorkspaceProfile` reads for `createdAt` is the file it is
    // about to overwrite. Rethrowing the `SyntaxError` from it meant a corrupt
    // profile BLOCKED the re-template and the Settings save that would have
    // repaired it — the write was refused by the very bytes it was replacing.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const perWiki = abs("tenants", TENANT, "wikis", wiki.id, "workspace-profile.json");
    await fs.writeFile(perWiki, "{ not json");

    expect(await getWorkspaceProfile(OWNER, wiki.id)).toEqual(emptyWorkspaceProfile());
  });

  it("does NOT read a corrupt own profile through to the legacy singleton (DW-144)", async () => {
    // Empty, not null. A wiki with a corrupt file HAS a file of its own; the
    // read-through exists only for wikis that never wrote one, and letting a
    // corrupt file fall through would show the owner a purpose authored for a
    // different era of the tenant and — worse — hand `putWorkspaceProfile` that
    // file's `createdAt`.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    await fs.writeFile(
      abs("tenants", TENANT, "wikis", wiki.id, "workspace-profile.json"),
      "{ not json",
    );
    await fs.writeFile(
      abs("tenants", TENANT, "workspace-profile.json"),
      JSON.stringify({
        version: 1,
        scenario: "custom",
        purpose: "Hand-authored before the split.",
        keyQuestions: [],
        inScope: [],
        outOfScope: [],
        outputLanguage: "English",
        pageConventions: "",
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-01T00:00:00.000Z",
      }),
    );

    const read = await getWorkspaceProfile(OWNER, wiki.id);
    expect(read.purpose).not.toContain("Hand-authored before the split.");
    expect(read).toEqual(emptyWorkspaceProfile());
  });

  it("lets a re-template overwrite a corrupt own profile (DW-144)", async () => {
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const perWiki = abs("tenants", TENANT, "wikis", wiki.id, "workspace-profile.json");
    await fs.writeFile(perWiki, "{ not json");

    await expect(
      applyScenarioTemplate(OWNER, wiki.id, "reading"),
    ).resolves.toBeTruthy();

    const repaired = await getWorkspaceProfile(OWNER, wiki.id);
    expect(repaired.scenario).toBe("reading");
    expect(repaired.purpose).toBe(WORKSPACE_SCENARIO_TEMPLATES.reading.purpose);
    // `createdAt` was unknowable, so it is stamped fresh rather than left null.
    expect(repaired.createdAt).toBeTruthy();
    expect(Date.parse(repaired.createdAt!)).toBeGreaterThan(Date.parse("2024-01-01"));
  });

  it("lets a Settings save overwrite a corrupt own profile (DW-144)", async () => {
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    await fs.writeFile(
      abs("tenants", TENANT, "wikis", wiki.id, "workspace-profile.json"),
      "not json at all",
    );

    const saved = await saveWorkspaceProfile(OWNER, wiki.id, {
      scenario: "custom",
      purpose: "Retyped after the file went bad.",
      keyQuestions: [],
      inScope: [],
      outOfScope: [],
      outputLanguage: "English",
      pageConventions: "",
    });

    expect(saved.purpose).toBe("Retyped after the file went bad.");
    expect(saved.createdAt).toBeTruthy();
    expect((await getWorkspaceProfile(OWNER, wiki.id)).purpose).toBe(
      "Retyped after the file went bad.",
    );
  });

  it("still throws when this wiki's own profile is UNREADABLE, not merely unparseable (DW-144)", async () => {
    // The line the degradation stops at. A directory in the file's place — or a
    // storage outage — is not fixed by writing, and answering it as an empty
    // Workspace Purpose would show the owner a blank purpose while storage was
    // merely failing, then let the next save stamp a fresh `createdAt` over a
    // profile that is still there.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const perWiki = abs("tenants", TENANT, "wikis", wiki.id, "workspace-profile.json");
    await fs.rm(perWiki);
    await fs.mkdir(perWiki);

    await expect(getWorkspaceProfile(OWNER, wiki.id)).rejects.toThrow();
  });

  it("treats a schema-REJECTED own profile as empty too, not just unparseable JSON (DW-144)", async () => {
    // `toProfile` raises on two different things and the degradation covers
    // both, because both are the same fact about the file: these bytes cannot
    // become a profile, and reading them again will not change that. Valid JSON
    // naming a scenario the schema retired is the realistic case — a rename in
    // `workspace-profile-schema.ts` turns every stored profile on the old name
    // into this, and rethrowing would have blocked the very save that migrates
    // them.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const perWiki = abs("tenants", TENANT, "wikis", wiki.id, "workspace-profile.json");
    await fs.writeFile(
      perWiki,
      JSON.stringify({
        version: 1,
        scenario: "retired-name",
        purpose: "Recoverable text.",
      }),
    );
    // A legacy singleton is present and must NOT be reached: the wiki has a
    // file of its own, unusable or not.
    await fs.writeFile(
      abs("tenants", TENANT, "workspace-profile.json"),
      JSON.stringify({
        version: 1,
        scenario: "custom",
        purpose: "Hand-authored before the split.",
        keyQuestions: [],
        inScope: [],
        outOfScope: [],
        outputLanguage: "English",
        pageConventions: "",
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-01T00:00:00.000Z",
      }),
    );

    expect(await getWorkspaceProfile(OWNER, wiki.id)).toEqual(emptyWorkspaceProfile());

    // And the next save replaces it, which is the whole reason the read degrades.
    const saved = await saveWorkspaceProfile(OWNER, wiki.id, {
      scenario: "reading",
      purpose: "Migrated off the retired scenario.",
      keyQuestions: [],
      inScope: [],
      outOfScope: [],
      outputLanguage: "English",
      pageConventions: "",
    });
    expect(saved.scenario).toBe("reading");
    expect(saved.createdAt).toBeTruthy();
    expect((await getWorkspaceProfile(OWNER, wiki.id)).purpose).toBe(
      "Migrated off the retired scenario.",
    );
  });

  it("refuses a lock token used AFTER withWikiLock returned (DW-139)", async () => {
    // A minted token is an ordinary value, so it outlives the critical section
    // it was minted in — captured in a closure, or carried by a promise started
    // inside the body and never awaited. Without the liveness check the type
    // system would go on asserting "the lock is held" about a moment when it is
    // not, which is the DW-139 exposure with a proof attached.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const profilePath = abs(
      "tenants",
      TENANT,
      "wikis",
      wiki.id,
      "workspace-profile.json",
    );

    let escaped!: Parameters<Parameters<typeof withWikiLock>[1]>[0];
    const inside = await withWikiLock(OWNER, async (held) => {
      escaped = held;
      // Accepted while the lock is actually held — the control that makes the
      // rejection below evidence of the lifetime rather than of a dead token.
      return putWorkspaceProfile(held, OWNER, wiki.id, {
        scenario: "custom",
        purpose: "Written inside the critical section.",
        keyQuestions: [],
        inScope: [],
        outOfScope: [],
        outputLanguage: "English",
        pageConventions: "",
      });
    });
    expect(inside.purpose).toBe("Written inside the critical section.");

    const before = await fs.readFile(profilePath, "utf8");
    await expect(
      putWorkspaceProfile(escaped, OWNER, wiki.id, {
        scenario: "custom",
        purpose: "Written with a token that outlived its lock.",
        keyQuestions: [],
        inScope: [],
        outOfScope: [],
        outputLanguage: "English",
        pageConventions: "",
      }),
    ).rejects.toThrow(/wiki lock proof expired/);

    // Distinct from the tenant-mismatch refusal: the two failures have
    // different fixes, and one message covering both would name neither.
    await expect(
      putWorkspaceProfile(escaped, OWNER, wiki.id, {
        scenario: "custom",
        purpose: "x",
        keyQuestions: [],
        inScope: [],
        outOfScope: [],
        outputLanguage: "English",
        pageConventions: "",
      }),
    ).rejects.not.toThrow(/proof mismatch/);

    // Nothing written — the check runs before a byte is read or written.
    expect(await fs.readFile(profilePath, "utf8")).toBe(before);
  });

  it("retires the token even when the locked body THREW (DW-139)", async () => {
    // A rejected body releases the lock exactly as a resolving one does, and a
    // token left live across a failure is the one most likely to be reused — by
    // the retry the failure prompts.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    let escaped!: Parameters<Parameters<typeof withWikiLock>[1]>[0];

    await expect(
      withWikiLock(OWNER, async (held) => {
        escaped = held;
        throw new Error("the locked body failed");
      }),
    ).rejects.toThrow("the locked body failed");

    await expect(
      putWorkspaceProfile(escaped, OWNER, wiki.id, {
        scenario: "custom",
        purpose: "Retried with the failed run's token.",
        keyQuestions: [],
        inScope: [],
        outOfScope: [],
        outputLanguage: "English",
        pageConventions: "",
      }),
    ).rejects.toThrow(/wiki lock proof expired/);
  });

  it("rejects a lock token minted for a DIFFERENT owner (DW-139)", async () => {
    // The one runtime mistake the brand cannot catch on its own: the type says
    // "some wiki lock is held", and only the key the token carries can say it is
    // the one covering the bytes about to be written. A token from another
    // tenant would serialize the write against the wrong key.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const before = await fs.readFile(
      abs("tenants", TENANT, "wikis", wiki.id, "workspace-profile.json"),
      "utf8",
    );

    await expect(
      withWikiLock("bob", (held) =>
        putWorkspaceProfile(held, OWNER, wiki.id, {
          scenario: "custom",
          purpose: "Written under another tenant's lock.",
          keyQuestions: [],
          inScope: [],
          outOfScope: [],
          outputLanguage: "English",
          pageConventions: "",
        }),
      ),
    ).rejects.toThrow(/wiki lock proof mismatch/);

    // Nothing written — the check runs before a byte is read or written.
    expect(
      await fs.readFile(
        abs("tenants", TENANT, "wikis", wiki.id, "workspace-profile.json"),
        "utf8",
      ),
    ).toBe(before);

    // …and the matching token is accepted, so the assertion above is evidence of
    // the tenant check rather than of a putter that rejects everything.
    const ok = await withWikiLock(OWNER, (held) =>
      putWorkspaceProfile(held, OWNER, wiki.id, {
        scenario: "custom",
        purpose: "Written under this tenant's lock.",
        keyQuestions: [],
        inScope: [],
        outOfScope: [],
        outputLanguage: "English",
        pageConventions: "",
      }),
    );
    expect(ok.purpose).toBe("Written under this tenant's lock.");
  });

  it("keeps the lock proof as putWorkspaceProfile's FIRST parameter (DW-139)", async () => {
    // A source-scan pin, because the guarantee is a COMPILE-time one and no
    // runtime assertion can observe it: an unlocked caller does not throw, it
    // fails to build. Dropping the parameter would leave every case in this file
    // green while restoring the exposure DW-139 named — an exported putter that
    // any module can call without holding `wikis:<tenant>`.
    const source = await fs.readFile(
      path.resolve(__dirname, "../workspace-profile.ts"),
      "utf8",
    );
    expect(source).toContain("export async function putWorkspaceProfile(\n  held: WikiLockHeld,");
    expect(source).toContain("assertWikiLockHeld(held, owner);");
    // And the ONE minting site is the lock wrapper, not this module.
    expect(source).not.toContain("WIKI_LOCK_HELD");
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

  it("versions a save and the read-back of it IDENTICALLY, against real bytes", async () => {
    // THE FIXED POINT `PUT /api/workspace-profile`'s second save rests on
    // (DW-145). The route answers `objectVersion` of what `saveWorkspaceProfile`
    // RETURNED, and conditions the next save on `objectVersion` of what
    // `getWorkspaceProfile` then READS BACK. Those are two different objects
    // built by two different functions — `putWorkspaceProfile` composes one from
    // the cleaned input, `toProfile` reconstructs the other from the serialized
    // bytes — and nothing else forces them to agree.
    //
    // Asserted HERE, against a real temp-`DATA_DIR`, because both route suites
    // mock this store: their versions agree only because the same fixture object
    // is handed to both mocks. If the two objects ever diverge by a field, every
    // second save in a session is refused 412 for a change the owner made
    // themselves, and no mocked suite can see it.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const written = await saveWorkspaceProfile(OWNER, wiki.id, {
      scenario: "custom",
      purpose: "Track decisions.",
      keyQuestions: ["What changed?"],
      inScope: ["Decisions"],
      outOfScope: ["Rumor"],
      outputLanguage: "Português",
      pageConventions: "Cite sources.",
    });
    const readBack = await getWorkspaceProfile(OWNER, wiki.id);

    expect(readBack).toEqual(written);
    expect(objectVersion(readBack)).toBe(objectVersion(written));

    // And a SECOND save moves it — the version has to be a change detector, not
    // a constant that would let a genuinely stale draft through.
    const again = await saveWorkspaceProfile(OWNER, wiki.id, {
      ...parseWorkspaceProfileInput(written),
      purpose: "Track decisions, and who made them.",
    });
    expect(objectVersion(again)).not.toBe(objectVersion(written));
    expect(objectVersion(await getWorkspaceProfile(OWNER, wiki.id))).toBe(
      objectVersion(again),
    );
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
