/**
 * DW-59 — per-Wiki artifact revisions.
 *
 * `writeWikiArtifact` used to overwrite `schema.md` with no prior read and no
 * snapshot, so an owner's edit destroyed the previous EXECUTABLE Schema
 * permanently. What this story ships is a recovery path, and a recovery path is
 * invisible when it works: nothing in the app looks different until the day
 * someone needs it. So the snapshot, the namespace it lands in, its fail-soft
 * envelope, and the route that reads it back are all pinned here directly
 * against a real temp `DATA_DIR`.
 *
 * The harness is `wiki-schema-edit.test.ts`'s: temp `DATA_DIR`/`WIKI_DIR`/
 * `RAW_DIR`, a hoisted `getPrincipal` mock (there is no Clerk session in a node
 * suite, and what is under test is what the route does WITH a principal), and
 * `createWiki` for the seed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

const principal = vi.hoisted(() => ({
  current: null as { id: string; handle: string } | null,
}));
vi.mock("@/lib/auth", () => ({
  getPrincipal: vi.fn(async () => principal.current),
}));

import { readDataVersion } from "../data-version";
import { _resetLocks } from "../lock";
import { logger } from "../logger";
import {
  PAGE_CONVENTIONS_HEADING,
  PAGE_CONVENTIONS_REQUIRED_COPY,
} from "../schema-source";
import { _resetStorage, getStorage } from "../storage";
import { readLog } from "../wiki-log";
import {
  listWikiArtifactRevisions,
  readWikiArtifactRevision,
  readWikiArtifactRevisionMeta,
  saveWikiArtifactRevision,
} from "../wiki-artifact-revisions";
import {
  wikiArtifactPath,
  wikiArtifactRevisionPath,
  wikiArtifactRevisionsDir,
  wikiDirPath,
} from "../wiki-paths";
import {
  applyScenarioTemplate,
  createWiki,
  deleteWiki,
  readWikiArtifact,
  retemplateRevisionReason,
  setCurrentWiki,
  writeWikiArtifact,
  type WikiRecord,
} from "../wikis";
import { contentVersion, scopedContentVersion } from "../write-precondition";

const OWNER = "yuanhao";

/** A Schema whose conventions section actually carries something. */
function schemaSaying(line: string): string {
  return [
    `# Schema — ${line}`,
    "",
    PAGE_CONVENTIONS_HEADING,
    "",
    line,
    "",
  ].join("\n");
}

const FIRST_EDIT = schemaSaying("every page names the meeting it came from");
const SECOND_EDIT = schemaSaying("every page names the source document");

/** The read-one envelope the route hand-builds. */
type ReadOneRevision = {
  timestamp: number;
  date: string;
  file: string;
  sizeBytes: number;
  author?: string;
  reason?: string;
};

describe("per-Wiki artifact revisions", () => {
  let tmpDir: string;
  let originalDataDir: string | undefined;
  let originalOwner: string | undefined;
  let originalWikiDir: string | undefined;
  let originalRawDir: string | undefined;
  let originalReadOnly: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-artifact-revisions-"));
    originalDataDir = process.env.DATA_DIR;
    originalOwner = process.env.NEXT_PUBLIC_OWNER_HANDLE;
    originalWikiDir = process.env.WIKI_DIR;
    originalRawDir = process.env.RAW_DIR;
    originalReadOnly = process.env.YOPEDIA_READONLY;
    process.env.DATA_DIR = tmpDir;
    process.env.NEXT_PUBLIC_OWNER_HANDLE = OWNER;
    process.env.WIKI_DIR = path.join(tmpDir, "wiki");
    process.env.RAW_DIR = path.join(tmpDir, "raw");
    delete process.env.YOPEDIA_READONLY;
    await fs.mkdir(process.env.WIKI_DIR, { recursive: true });
    await fs.mkdir(process.env.RAW_DIR, { recursive: true });
    _resetLocks();
    _resetStorage();
    principal.current = { id: "u1", handle: OWNER };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    principal.current = null;
    for (const [key, value] of [
      ["DATA_DIR", originalDataDir],
      ["NEXT_PUBLIC_OWNER_HANDLE", originalOwner],
      ["WIKI_DIR", originalWikiDir],
      ["RAW_DIR", originalRawDir],
      ["YOPEDIA_READONLY", originalReadOnly],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetStorage();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** One Wiki, current, with both artifacts seeded. */
  async function seed(): Promise<WikiRecord> {
    return createWiki(OWNER, { name: "Field notes", scenario: "research" });
  }

  async function readSchema(wiki: WikiRecord): Promise<string> {
    return (await readWikiArtifact(OWNER, wiki.id, "schema.md")) ?? "";
  }

  /** The GET handler, imported lazily so the env above is in place first. */
  async function get(query: string): Promise<Response> {
    const { GET } = await import("@/app/api/workbench/artifact/revisions/route");
    return GET(
      new Request(`http://localhost/api/workbench/artifact/revisions?${query}`),
    );
  }

  /** The POST (revert) handler. `body` may be a raw string to send bad JSON. */
  async function post(query: string, body: unknown): Promise<Response> {
    const { POST } = await import("@/app/api/workbench/artifact/revisions/route");
    return POST(
      new Request(`http://localhost/api/workbench/artifact/revisions?${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  }

  // -------------------------------------------------------------------------
  // The snapshot — read before write, inside the lock
  // -------------------------------------------------------------------------

  it("snapshots the bytes an edit replaces, into the Wiki's own directory", async () => {
    const wiki = await seed();
    const seeded = await readSchema(wiki);

    await writeWikiArtifact(OWNER, wiki.id, "schema.md", FIRST_EDIT);

    const revisions = await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md");
    expect(revisions).toHaveLength(1);
    expect(revisions[0].file).toBe("schema.md");
    expect(revisions[0].author).toBe(OWNER);
    // No `reason` on a plain edit — the field exists to mark a revert.
    expect(revisions[0].reason).toBeUndefined();
    expect(
      await readWikiArtifactRevision(OWNER, wiki.id, "schema.md", revisions[0].timestamp),
    ).toBe(seeded);

    // The address is the ONE the path module spells, nested under the Wiki
    // directory — which is what makes every existing `deleteDirectory` reclaim
    // it and what keeps the write inside the lock that already serializes the
    // artifact.
    const rel = wikiArtifactRevisionPath(
      OWNER,
      wiki.id,
      "schema.md",
      `${revisions[0].timestamp}.md`,
    );
    expect(rel).toBe(
      `${wikiDirPath(OWNER, wiki.id)}/revisions/schema.md/${revisions[0].timestamp}.md`,
    );
    await expect(fs.readFile(path.join(tmpDir, rel), "utf-8")).resolves.toBe(seeded);
    // The new bytes are at the artifact path, untouched by any of this.
    await expect(readSchema(wiki)).resolves.toBe(FIRST_EDIT);
  });

  it("lists two edits newest-first, newest holding what the second edit replaced", async () => {
    const wiki = await seed();
    const seeded = await readSchema(wiki);

    await writeWikiArtifact(OWNER, wiki.id, "schema.md", FIRST_EDIT);
    await writeWikiArtifact(OWNER, wiki.id, "schema.md", SECOND_EDIT);

    const revisions = await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md");
    expect(revisions).toHaveLength(2);
    expect(revisions[0].timestamp).toBeGreaterThan(revisions[1].timestamp);
    // Newest = the bytes the SECOND edit replaced, i.e. the first edit.
    expect(
      await readWikiArtifactRevision(OWNER, wiki.id, "schema.md", revisions[0].timestamp),
    ).toBe(FIRST_EDIT);
    expect(
      await readWikiArtifactRevision(OWNER, wiki.id, "schema.md", revisions[1].timestamp),
    ).toBe(seeded);
    expect(revisions[0].sizeBytes).toBe(Buffer.byteLength(FIRST_EDIT, "utf-8"));
  });

  it("writes NO revision on the first write, and warns about nothing", async () => {
    const wiki = await seed();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    // Remove the seeded artifact so the write is a genuine first write.
    await fs.rm(path.join(tmpDir, wikiArtifactPath(OWNER, wiki.id, "schema.md")));

    await writeWikiArtifact(OWNER, wiki.id, "schema.md", FIRST_EDIT);

    expect(await readSchema(wiki)).toBe(FIRST_EDIT);
    expect(await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md")).toEqual([]);
    // ENOENT is the first-write case, not a fault: no warning at all.
    expect(warn).not.toHaveBeenCalled();
  });

  it("is FAIL-SOFT: a snapshot that cannot be written warns and the save still lands", async () => {
    const wiki = await seed();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const storage = getStorage();
    const realWrite = storage.writeFile.bind(storage);
    vi.spyOn(storage, "writeFile").mockImplementation(async (p, content) => {
      if (p.includes("/revisions/")) throw new Error("revision store is down");
      return realWrite(p, content);
    });

    // The route answers 200 with the new bytes on disk — a save that reached
    // storage is never reported as failed because history could not be recorded.
    await expect(
      writeWikiArtifact(OWNER, wiki.id, "schema.md", FIRST_EDIT),
    ).resolves.toBeUndefined();
    expect(await readSchema(wiki)).toBe(FIRST_EDIT);
    expect(
      warn.mock.calls.some(
        (call) => call[0] === "wikis" && String(call[1]).includes("snapshotting"),
      ),
    ).toBe(true);
  });

  it("a failed SIDECAR write leaves the revision standing, and is not reported as a lost snapshot", async () => {
    const wiki = await seed();
    const seeded = await readSchema(wiki);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const storage = getStorage();
    const realWrite = storage.writeFile.bind(storage);
    vi.spyOn(storage, "writeFile").mockImplementation(async (p, content) => {
      if (p.endsWith(".meta.json")) throw new Error("sidecar store is down");
      return realWrite(p, content);
    });

    await writeWikiArtifact(OWNER, wiki.id, "schema.md", FIRST_EDIT);

    // The sidecar reports ITSELF…
    expect(
      warn.mock.calls.some(
        (call) =>
          call[0] === "wiki-artifact-revisions" && String(call[1]).includes("sidecar"),
      ),
    ).toBe(true);
    // …and the caller does NOT claim the snapshot was lost, because it was not.
    expect(
      warn.mock.calls.some(
        (call) => call[0] === "wikis" && String(call[1]).includes("snapshotting"),
      ),
    ).toBe(false);

    vi.restoreAllMocks();
    // The revision is in the listing and readable — merely unattributed.
    const [only] = await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md");
    expect(only.author).toBeUndefined();
    expect(
      await readWikiArtifactRevision(OWNER, wiki.id, "schema.md", only.timestamp),
    ).toBe(seeded);
  });

  it("records ONE normalized reason in both the sidecar and the log line", async () => {
    const wiki = await seed();

    await writeWikiArtifact(
      OWNER,
      wiki.id,
      "schema.md",
      FIRST_EDIT,
      { reason: "  reverted   to\n## [2026-08-18] delete | injected\nrevision 7  " },
    );

    const [only] = await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md");
    const collapsed = "reverted to ## [2026-08-18] delete | injected revision 7";
    expect(only.reason).toBe(collapsed);

    const log = (await readLog()) ?? "";
    // The newline is gone, so the injected text cannot be read as a log HEADING:
    // `readLog`'s grammar is line-anchored, and there is still exactly one entry.
    expect(log.match(/^## \[\d{4}-\d{2}-\d{2}\] /gm) ?? []).toHaveLength(1);
    expect(log).toContain(`Wiki: ${wiki.id} · ${collapsed}`);
  });

  it("treats a whitespace-only reason as ABSENT in both records, and caps a long one", async () => {
    const wiki = await seed();

    await writeWikiArtifact(OWNER, wiki.id, "schema.md", FIRST_EDIT, {
      reason: "   \n\t ",
    });
    const [blank] = await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md");
    // Neither record carries it — the two cannot disagree about whether the
    // edit had a summary.
    expect(blank.reason).toBeUndefined();
    expect((await readLog()) ?? "").toContain(`Wiki: ${wiki.id}\n`);

    await writeWikiArtifact(OWNER, wiki.id, "schema.md", SECOND_EDIT, {
      reason: "x".repeat(500),
    });
    const [long] = await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md");
    expect(long.reason).toBe("x".repeat(200));
    expect((await readLog()) ?? "").toContain(`Wiki: ${wiki.id} · ${"x".repeat(200)}\n`);

    // The cap counts CHARACTERS, so it cannot cut an astral character in half.
    // "🌵" is a surrogate PAIR: a UTF-16 `slice` at 200 would land between its
    // two halves and record a lone surrogate — invalid text — in both the
    // sidecar's JSON and the tenant-global log line.
    const withAstral = `${"x".repeat(199)}🌵${"y".repeat(20)}`;
    await writeWikiArtifact(OWNER, wiki.id, "schema.md", FIRST_EDIT, {
      reason: withAstral,
    });
    const [astral] = await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md");
    expect(astral.reason).toBe(`${"x".repeat(199)}🌵`);
    expect([...(astral.reason ?? "")]).toHaveLength(200);
    // No unpaired surrogate survived into either record.
    expect(/[\uD800-\uDFFF]/.test((astral.reason ?? "").replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))).toBe(false);
    expect((await readLog()) ?? "").toContain(
      `Wiki: ${wiki.id} · ${"x".repeat(199)}🌵\n`,
    );
  });

  it("is invisible to callers that do not ask: no revision dir until the first overwrite", async () => {
    const wiki = await seed();
    // Seeding writes both artifacts through the unlocked putter, which the
    // recorded decision deliberately leaves un-snapshotted: DW-59 scopes
    // read-before-write to `writeWikiArtifact`.
    //
    // BE PRECISE ABOUT WHAT THAT LEAVES OPEN, AND WHAT NO LONGER DOES.
    // `restoreSeededFiles` still runs only from `applyScenarioTemplate`'s
    // `catch` — it is rollback for a FAILED re-template, not history. What DW-213
    // added is the other half: a COMMITTED re-template now records the
    // `schema.md` bytes it overwrote as a revision, from the snapshot it already
    // took (see "a committed re-template …" below). CREATE is still deliberately
    // silent, and that is what this row pins — a Wiki seeded moments ago
    // overwrote nothing, so there is nothing for its history to hold.
    await expect(
      fs.stat(path.join(tmpDir, wikiArtifactRevisionsDir(OWNER, wiki.id, "schema.md"))),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md")).toEqual([]);
  });

  it("reads null for an unknown revision and null meta for an unattributed one", async () => {
    const wiki = await seed();
    expect(await readWikiArtifactRevision(OWNER, wiki.id, "schema.md", 1)).toBeNull();
    expect(await readWikiArtifactRevisionMeta(OWNER, wiki.id, "schema.md", 1)).toBeNull();

    // A snapshot with neither author nor reason writes no sidecar at all.
    await saveWikiArtifactRevision(OWNER, wiki.id, "schema.md", FIRST_EDIT);
    const [only] = await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md");
    expect(only.author).toBeUndefined();
    expect(only.reason).toBeUndefined();
    expect(
      await readWikiArtifactRevisionMeta(OWNER, wiki.id, "schema.md", only.timestamp),
    ).toBeNull();
  });

  it("is FAIL-SOFT the other way too: a non-ENOENT READ failure warns and the save lands", async () => {
    const wiki = await seed();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const storage = getStorage();
    const artifact = wikiArtifactPath(OWNER, wiki.id, "schema.md");
    const realRead = storage.readFile.bind(storage);
    vi.spyOn(storage, "readFile").mockImplementation(async (p) => {
      if (p === artifact) throw new Error("read timed out");
      return realRead(p);
    });

    await expect(
      writeWikiArtifact(OWNER, wiki.id, "schema.md", FIRST_EDIT),
    ).resolves.toBeUndefined();

    // The read half warns on its own sentence — a read fault is NOT the
    // first-write ENOENT it used to be lumped in with. Asserted BEFORE the
    // restore: `restoreAllMocks` also resets the recorded calls.
    expect(
      warn.mock.calls.some(
        (call) => call[0] === "wikis" && String(call[1]).includes("reading"),
      ),
    ).toBe(true);

    vi.restoreAllMocks();
    expect(await readSchema(wiki)).toBe(FIRST_EDIT);
    // Nothing was snapshotted, because nothing could be read.
    expect(await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md")).toEqual([]);
  });

  it("warns about a corrupt sidecar rather than swallowing it, and still lists the revision", async () => {
    const wiki = await seed();
    const seeded = await readSchema(wiki);
    await writeWikiArtifact(OWNER, wiki.id, "schema.md", FIRST_EDIT);
    const [only] = await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md");
    await fs.writeFile(
      path.join(
        tmpDir,
        wikiArtifactRevisionPath(OWNER, wiki.id, "schema.md", `${only.timestamp}.meta.json`),
      ),
      "{not json",
      "utf-8",
    );
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    // Losing attribution SILENTLY is how history stops being trustworthy — a
    // sidecar that exists but will not parse is a fault, unlike an absent one.
    expect(
      await readWikiArtifactRevisionMeta(OWNER, wiki.id, "schema.md", only.timestamp),
    ).toBeNull();
    expect(
      warn.mock.calls.some((call) => call[0] === "wiki-artifact-revisions"),
    ).toBe(true);

    // The BYTES are still readable and still listed — attribution is not the
    // revision.
    const [still] = await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md");
    expect(still.timestamp).toBe(only.timestamp);
    expect(still.author).toBeUndefined();
    expect(
      await readWikiArtifactRevision(OWNER, wiki.id, "schema.md", only.timestamp),
    ).toBe(seeded);
  });

  it("lists nothing it cannot open: junk files, subdirectories and non-canonical stems", async () => {
    const wiki = await seed();
    await writeWikiArtifact(OWNER, wiki.id, "schema.md", FIRST_EDIT);
    const [real] = await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md");
    const dir = path.join(tmpDir, wikiArtifactRevisionsDir(OWNER, wiki.id, "schema.md"));

    await fs.writeFile(path.join(dir, "notes.txt"), "not a revision", "utf-8");
    await fs.mkdir(path.join(dir, "nested"), { recursive: true });
    await fs.writeFile(path.join(dir, "nested", "1700000000000.md"), "buried", "utf-8");
    // Stems that PARSE but do not round-trip. Listing these would show entries
    // whose `?timestamp=` read 404s, because every later read re-serializes the
    // number (`012` → `12`, `1e12` → `1000000000000`).
    for (const junk of ["012.md", "1e12.md", " 12.md", "12.5.md", "-3.md", "0.md"]) {
      await fs.writeFile(path.join(dir, junk), "junk", "utf-8");
    }

    const revisions = await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md");
    expect(revisions).toHaveLength(1);
    expect(revisions[0].timestamp).toBe(real.timestamp);
    // Everything listed is also openable — the property the round-trip buys.
    for (const revision of revisions) {
      expect(
        await readWikiArtifactRevision(OWNER, wiki.id, "schema.md", revision.timestamp),
      ).not.toBeNull();
    }
  });

  it("keeps two Wikis' histories apart", async () => {
    const first = await seed();
    const second = await createWiki(OWNER, { name: "Reading log", scenario: "reading" });

    await writeWikiArtifact(OWNER, first.id, "schema.md", FIRST_EDIT);
    await writeWikiArtifact(OWNER, first.id, "schema.md", SECOND_EDIT);
    await writeWikiArtifact(OWNER, second.id, "schema.md", FIRST_EDIT);

    // Per-Wiki, because the namespace hangs off `wikiDirPath` — editing one
    // must never surface in the other's history.
    expect(await listWikiArtifactRevisions(OWNER, first.id, "schema.md")).toHaveLength(2);
    expect(await listWikiArtifactRevisions(OWNER, second.id, "schema.md")).toHaveLength(1);
    const [onlySecond] = await listWikiArtifactRevisions(OWNER, second.id, "schema.md");
    expect(
      await readWikiArtifactRevision(OWNER, first.id, "schema.md", onlySecond.timestamp),
    ).toBeNull();
  });

  // -------------------------------------------------------------------------
  // The re-template snapshot (DW-213)
  // -------------------------------------------------------------------------
  //
  // DW-59 scoped read-before-write to `writeWikiArtifact` and left the most
  // destructive operation in the module uncovered: `applyScenarioTemplate` seeds
  // through `putWikiArtifact`, which owns no tail, so a re-template that
  // SUCCEEDED replaced an owner-edited Schema with template bytes and kept no
  // copy. `snapshotSeededFiles`/`restoreSeededFiles` is not that copy — it is
  // rollback for a FAILED seed, reachable only from the `catch`. These four rows
  // are the matrix for the path that commits.

  it("a committed re-template records the Schema bytes it overwrote", async () => {
    const wiki = await seed();
    await writeWikiArtifact(OWNER, wiki.id, "schema.md", FIRST_EDIT);
    // The owner's OWN bytes, and the ones the template is about to destroy.
    expect(await readSchema(wiki)).toBe(FIRST_EDIT);

    expect(await applyScenarioTemplate(OWNER, wiki.id, "reading")).not.toBeNull();

    // The seed landed: the Schema is the new template's.
    expect(await readSchema(wiki)).toContain("### Scenario conventions — Reading");
    const revisions = await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md");
    // Two: the seeded bytes the owner's edit replaced, and now the owner's
    // edit itself — newest first.
    expect(revisions).toHaveLength(2);
    expect(revisions[0].file).toBe("schema.md");
    expect(revisions[0].author).toBe(OWNER);
    // The reason NAMES the event and the template that caused it, so the entry
    // reads differently from an owner's own edit sitting beside it.
    expect(revisions[0].reason).toBe(retemplateRevisionReason("reading"));
    expect(revisions[0].reason).toContain("Reading");
    expect(
      await readWikiArtifactRevision(OWNER, wiki.id, "schema.md", revisions[0].timestamp),
    ).toBe(FIRST_EDIT);
  });

  it("records the bytes the snapshot held, never the template's own", async () => {
    // The one way to get this wrong: reading `schema.md` again AFTER the seed,
    // which answers the TEMPLATE's bytes and files them as the owner's. The
    // snapshot is taken before the first overwrite, inside the same lock, and
    // that is what this pins.
    const wiki = await seed();
    await writeWikiArtifact(OWNER, wiki.id, "schema.md", FIRST_EDIT);
    await applyScenarioTemplate(OWNER, wiki.id, "reading");

    const [newest] = await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md");
    const recorded = await readWikiArtifactRevision(
      OWNER,
      wiki.id,
      "schema.md",
      newest.timestamp,
    );
    expect(recorded).toBe(FIRST_EDIT);
    expect(recorded).not.toContain("### Scenario conventions — Reading");

    // …and reverting to it puts the owner's Schema back, which is the whole
    // point of recording it (the acceptance criterion this feature exists for).
    const response = await post(`path=schema.md`, {
      action: "revert",
      timestamp: newest.timestamp,
    });
    expect(response.status).toBe(200);
    expect(await readSchema(wiki)).toBe(FIRST_EDIT);
  });

  it("records only schema.md — purpose.md has no surface to reach a revision through", async () => {
    const wiki = await seed();
    await applyScenarioTemplate(OWNER, wiki.id, "reading");

    // `EDITABLE_ARTIFACT_FILES` is the set the revisions route can list and
    // revert; a `purpose.md` revision would be bytes nothing can open.
    await expect(
      fs.stat(path.join(tmpDir, wikiArtifactRevisionsDir(OWNER, wiki.id, "purpose.md"))),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md")).toHaveLength(1);
  });

  it("writes NO revision when the pre-seed read found nothing", async () => {
    const wiki = await seed();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    // `content: null` in the snapshot — the FIRST-WRITE case, where the seed
    // overwrote nothing and there is nothing to have lost.
    await fs.rm(path.join(tmpDir, wikiArtifactPath(OWNER, wiki.id, "schema.md")));

    expect(await applyScenarioTemplate(OWNER, wiki.id, "reading")).not.toBeNull();

    expect(await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md")).toEqual([]);
    // Absent is not a fault: nothing about history is warned here.
    expect(
      warn.mock.calls.some((call) => String(call[1]).includes("re-templating")),
    ).toBe(false);
  });

  it("writes NO revision when the re-template FAILS mid-seed", async () => {
    const wiki = await seed();
    await writeWikiArtifact(OWNER, wiki.id, "schema.md", FIRST_EDIT);
    const before = await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md");
    const storage = getStorage();
    const realWrite = storage.writeFile.bind(storage);
    vi.spyOn(storage, "writeFile").mockImplementation(async (p, content) => {
      if (p.endsWith("wikis.json")) throw new Error("the registry store is down");
      return realWrite(p, content);
    });

    await expect(applyScenarioTemplate(OWNER, wiki.id, "reading")).rejects.toThrow(
      "the registry store is down",
    );
    vi.restoreAllMocks();

    // The compensation is unchanged and history recorded nothing: a revision
    // written before the seed would have been an entry for an event that did
    // not happen, sitting beside bytes `restoreSeededFiles` put straight back.
    expect(await readSchema(wiki)).toBe(FIRST_EDIT);
    expect(await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md")).toEqual(before);
  });

  it("is FAIL-SOFT on the commit: a rejected snapshot warns and the re-template still lands", async () => {
    const wiki = await seed();
    await writeWikiArtifact(OWNER, wiki.id, "schema.md", FIRST_EDIT);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const storage = getStorage();
    const realWrite = storage.writeFile.bind(storage);
    // Only the revision write of the re-template rejects — the seed and the
    // registry write have both already landed by the time it runs.
    vi.spyOn(storage, "writeFile").mockImplementation(async (p, content) => {
      if (p.includes("/revisions/")) throw new Error("revision store is down");
      return realWrite(p, content);
    });

    const applied = await applyScenarioTemplate(OWNER, wiki.id, "reading");

    // A re-template that reached storage is NEVER reported as failed for a
    // history miss — the record is returned and the bytes are the template's.
    expect(applied).not.toBeNull();
    expect(applied?.scenario).toBe("reading");
    expect(await readSchema(wiki)).toContain("### Scenario conventions — Reading");
    expect(
      warn.mock.calls.some(
        (call) =>
          call[0] === "wikis" && String(call[1]).includes("before re-templating wiki"),
      ),
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Lifecycle — the whole reason the namespace is nested under the Wiki
  // -------------------------------------------------------------------------

  it("dies with the Wiki: deleteWiki leaves nothing under the Wiki directory", async () => {
    const keeper = await seed();
    const doomed = await createWiki(OWNER, { name: "Scratch", scenario: "general" });
    // `deleteWiki` refuses the CURRENT Wiki, so make the keeper current again.
    await setCurrentWiki(OWNER, keeper.id);
    await writeWikiArtifact(OWNER, doomed.id, "schema.md", FIRST_EDIT);
    expect(await listWikiArtifactRevisions(OWNER, doomed.id, "schema.md")).toHaveLength(1);

    await deleteWiki(OWNER, doomed.id);

    await expect(
      fs.stat(path.join(tmpDir, wikiDirPath(OWNER, doomed.id))),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await listWikiArtifactRevisions(OWNER, doomed.id, "schema.md")).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // GET — list and read one
  // -------------------------------------------------------------------------

  it("GET lists revisions newest-first, private and unstored", async () => {
    const wiki = await seed();
    await writeWikiArtifact(OWNER, wiki.id, "schema.md", FIRST_EDIT);
    await writeWikiArtifact(OWNER, wiki.id, "schema.md", SECOND_EDIT);

    const res = await get("path=schema.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = (await res.json()) as {
      revisions: { timestamp: number; date: string; file: string; sizeBytes: number; author?: string }[];
    };
    expect(body.revisions).toHaveLength(2);
    expect(body.revisions[0].timestamp).toBeGreaterThan(body.revisions[1].timestamp);
    expect(body.revisions[0].file).toBe("schema.md");
    expect(body.revisions[0].author).toBe(OWNER);
    expect(body.revisions[0].date).toBe(new Date(body.revisions[0].timestamp).toISOString());
  });

  it("GET ?timestamp= returns that revision's content and its whole envelope", async () => {
    const wiki = await seed();
    const seeded = await readSchema(wiki);
    await writeWikiArtifact(OWNER, wiki.id, "schema.md", FIRST_EDIT);
    const [only] = await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md");

    const res = await get(`path=schema.md&timestamp=${only.timestamp}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      content: string;
      revision: ReadOneRevision;
    };
    expect(body.content).toBe(seeded);
    // The payload is HAND-BUILT in the route rather than reused from the
    // lister, so every field it claims is asserted here — dropping any one of
    // them is a silent contract change otherwise.
    expect(body.revision.timestamp).toBe(only.timestamp);
    expect(body.revision.date).toBe(new Date(only.timestamp).toISOString());
    expect(body.revision.file).toBe("schema.md");
    expect(body.revision.sizeBytes).toBe(Buffer.byteLength(seeded, "utf-8"));
    expect(body.revision.author).toBe(OWNER);
    // A plain edit carries no reason — the field is absent, not empty.
    expect(body.revision.reason).toBeUndefined();
  });

  it("GET ?timestamp= carries the reason a revert recorded", async () => {
    const wiki = await seed();
    await writeWikiArtifact(OWNER, wiki.id, "schema.md", FIRST_EDIT);
    const [seedRevision] = await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md");
    await post("path=schema.md", { action: "revert", timestamp: seedRevision.timestamp });
    // The revert's own snapshot — the newest — is the one carrying the reason.
    const [revertRevision] = await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md");

    const res = await get(`path=schema.md&timestamp=${revertRevision.timestamp}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; revision: ReadOneRevision };
    expect(body.content).toBe(FIRST_EDIT);
    expect(body.revision.author).toBe(OWNER);
    expect(body.revision.reason).toBe(
      `reverted to revision ${new Date(seedRevision.timestamp).toISOString()}`,
    );
    expect(body.revision.date).toBe(new Date(revertRevision.timestamp).toISOString());
  });

  it("GET refuses an unknown or malformed timestamp", async () => {
    await seed();
    expect((await get("path=schema.md&timestamp=1")).status).toBe(404);
    expect((await get("path=schema.md&timestamp=abc")).status).toBe(400);
    expect((await get("path=schema.md&timestamp=0")).status).toBe(400);
    expect((await get("path=schema.md&timestamp=-5")).status).toBe(400);
    // MALFORMED, not merely missing. No stem on disk survives `canonicalStem`
    // unless `String(n)` reproduces it, so a value that could never have BEEN a
    // stem is a bad request rather than a 404 claiming it was well-formed. The
    // two rules admit the same set, which is what keeps "listed" and "readable"
    // the same question at both layers.
    expect((await get("path=schema.md&timestamp=12.5")).status).toBe(400);
    expect((await get("path=schema.md&timestamp=1e400")).status).toBe(400);
    expect(
      (await get(`path=schema.md&timestamp=${Number.MAX_SAFE_INTEGER + 2}`)).status,
    ).toBe(400);
    // And the POST refuses the same values with the same status, so a revert
    // cannot address an id the listing could never have produced.
    expect(
      (await post("path=schema.md", { action: "revert", timestamp: 12.5 })).status,
    ).toBe(400);
  });

  it("GET refuses any path that is not the editable artifact, with ONE body", async () => {
    await seed();
    const bodies = new Set<string>();
    for (const query of ["path=purpose.md", "path=wiki/alpha.md", "path=../secrets", ""]) {
      const res = await get(query);
      expect(res.status).toBe(400);
      bodies.add(JSON.stringify(await res.json()));
    }
    // No existence oracle: every refusal is the same sentence.
    expect(bodies.size).toBe(1);
    expect([...bodies][0]).toContain("can’t be edited here");
  });

  it("refuses both verbs with 404 when the registry has no current Wiki", async () => {
    // The last rung of the shared ladder, and the only one no other test
    // reaches: with nothing seeded the registry has no `currentId`, so there is
    // no Wiki to read a history OUT OF. The caller never names one — it is
    // re-derived here — so the refusal belongs to the route, not the client.
    expect((await get("path=schema.md")).status).toBe(404);
    expect(
      (await post("path=schema.md", { action: "revert", timestamp: 1 })).status,
    ).toBe(404);
  });

  it("refuses a non-editable path with the PARENT route's body, byte for byte", async () => {
    await seed();
    const { PUT } = await import("@/app/api/workbench/artifact/route");
    const parent = await PUT(
      new Request("http://localhost/api/workbench/artifact?path=purpose.md", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "anything" }),
      }),
    );
    const child = await get("path=purpose.md");

    // The docblock claims this route carries the parent's `NOT_EDITABLE` copy
    // "unchanged", and the two are independent literals in two files — so
    // nothing but this assertion stops one from being reworded alone, which
    // would make the two halves of ONE allowlist refuse the same path with two
    // different sentences.
    expect(parent.status).toBe(400);
    expect(child.status).toBe(400);
    expect(await child.json()).toEqual(await parent.json());
  });

  it("GET still answers in a read-only deployment — history is a read", async () => {
    const wiki = await seed();
    await writeWikiArtifact(OWNER, wiki.id, "schema.md", FIRST_EDIT);
    process.env.YOPEDIA_READONLY = "1";

    const res = await get("path=schema.md");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { revisions: unknown[] }).revisions).toHaveLength(1);
  });

  it("GET is 401 signed out and 403 for a non-owner", async () => {
    await seed();
    principal.current = null;
    expect((await get("path=schema.md")).status).toBe(401);
    principal.current = { id: "u2", handle: "someone-else" };
    expect((await get("path=schema.md")).status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // POST — revert
  // -------------------------------------------------------------------------

  it("stays UNGATED — a revert carries no precondition and needs none", async () => {
    // The revert names the revision it is restoring; the caller that picked it
    // from the list was never seeded with the CURRENT bytes, so there is no
    // version for it to hold. DW-193 gated the direct artifact `PUT` and
    // deliberately left this route alone — `post` sends no `If-Match` at all,
    // and the answer is a 200, not the 428 the gated route would give.
    const wiki = await seed();
    const seeded = await readSchema(wiki);
    await writeWikiArtifact(OWNER, wiki.id, "schema.md", FIRST_EDIT);
    const revisions = await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md");

    const res = await post("path=schema.md", {
      action: "revert",
      timestamp: revisions[0].timestamp,
    });

    expect(res.status).toBe(200);
    expect(await readSchema(wiki)).toBe(seeded);

    // The wire fact, stated once and not re-derived from source text: this
    // route reads no `If-Match` at all. A source SLICE around the writer call
    // would pin formatting rather than behaviour — reflowing the call or
    // writing a comment containing `});` would change what is scanned without
    // changing anything — and the 200 above already pins the property that
    // matters, so only the import-level fact is scanned here.
    const source = await fs.readFile(
      path.resolve(__dirname, "../../app/api/workbench/artifact/revisions/route.ts"),
      "utf8",
    );
    expect(source).not.toContain("IF_MATCH_HEADER");
    expect(source).not.toContain("parseIfMatch");
  });

  it("reverts to a revision, snapshots what it replaced, logs it and bumps the signal", async () => {
    const wiki = await seed();
    const seeded = await readSchema(wiki);
    await writeWikiArtifact(OWNER, wiki.id, "schema.md", FIRST_EDIT);
    await writeWikiArtifact(OWNER, wiki.id, "schema.md", SECOND_EDIT);
    const before = await readDataVersion();
    const logLinesBefore = ((await readLog()) ?? "").match(/^## \[\d{4}-\d{2}-\d{2}\] edit \| /gm)?.length ?? 0;
    // The OLDEST revision is the seed — the bytes the first edit replaced.
    const revisions = await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md");
    const seedRevision = revisions[revisions.length - 1];

    const res = await post("path=schema.md", {
      action: "revert",
      timestamp: seedRevision.timestamp,
    });

    expect(res.status).toBe(200);
    // SCOPED by the Wiki this route already gated on (DW-200) — the same token
    // the Preview serves and the artifact `PUT` compares, so an editor holding
    // the file open can save straight back with it.
    expect(await res.json()).toEqual({
      ok: true,
      version: scopedContentVersion(wiki.id, seeded),
    });
    // Not the unscoped one: a content-only token would match another Wiki's
    // byte-identical seeded artifact.
    expect(scopedContentVersion(wiki.id, seeded)).not.toBe(contentVersion(seeded));
    // The artifact is the seed again…
    expect(await readSchema(wiki)).toBe(seeded);
    // …and the revert is itself undoable: a THIRD revision holds the bytes it
    // replaced, marked with the reason that tells it apart from an edit.
    const after = await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md");
    expect(after).toHaveLength(3);
    expect(
      await readWikiArtifactRevision(OWNER, wiki.id, "schema.md", after[0].timestamp),
    ).toBe(SECOND_EDIT);
    expect(after[0].reason).toContain("reverted to revision");
    expect(after[0].author).toBe(OWNER);

    // The same tail a direct edit fires: ONE more `edit` line, naming the revert.
    const log = (await readLog()) ?? "";
    expect(log.match(/^## \[\d{4}-\d{2}-\d{2}\] edit \| /gm) ?? []).toHaveLength(
      logLinesBefore + 1,
    );
    expect(log).toContain(`Wiki: ${wiki.id} · reverted to revision`);
    expect(await readDataVersion()).toBe(before + 1);
  });

  it("refuses a revert to a conventions-less revision, writing nothing", async () => {
    const wiki = await seed();
    // A snapshot taken before the guard existed: no `## Page conventions`.
    await saveWikiArtifactRevision(
      OWNER,
      wiki.id,
      "schema.md",
      "# Schema\n\n## Key questions\n\n- one\n",
      OWNER,
    );
    const [stale] = await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md");
    const schemaBefore = await readSchema(wiki);
    const versionBefore = await readDataVersion();

    const res = await post("path=schema.md", {
      action: "revert",
      timestamp: stale.timestamp,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: PAGE_CONVENTIONS_REQUIRED_COPY });
    // Refused ABOVE the writer: no bytes, no new revision, no bump.
    expect(await readSchema(wiki)).toBe(schemaBefore);
    expect(await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md")).toHaveLength(1);
    expect(await readDataVersion()).toBe(versionBefore);
  });

  it("refuses a revert while the deployment is read-only, writing nothing", async () => {
    const wiki = await seed();
    await writeWikiArtifact(OWNER, wiki.id, "schema.md", FIRST_EDIT);
    const [only] = await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md");
    process.env.YOPEDIA_READONLY = "1";

    const res = await post("path=schema.md", {
      action: "revert",
      timestamp: only.timestamp,
    });

    expect(res.status).toBe(403);
    expect(await readSchema(wiki)).toBe(FIRST_EDIT);
    expect(await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md")).toHaveLength(1);
  });

  it("refuses a malformed revert body, an unknown revision and a non-editable path", async () => {
    await seed();
    expect((await post("path=schema.md", "not json")).status).toBe(400);
    expect((await post("path=schema.md", { action: "delete", timestamp: 1 })).status).toBe(400);
    expect((await post("path=schema.md", { action: "revert" })).status).toBe(400);
    expect((await post("path=schema.md", { action: "revert", timestamp: "1" })).status).toBe(400);
    expect((await post("path=schema.md", { action: "revert", timestamp: 1 })).status).toBe(404);
    expect((await post("path=purpose.md", { action: "revert", timestamp: 1 })).status).toBe(400);
  });

  it("answers a revert whose artifact write rejects with 500, and moves nothing", async () => {
    const wiki = await seed();
    await writeWikiArtifact(OWNER, wiki.id, "schema.md", FIRST_EDIT);
    const [only] = await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md");
    const before = await readDataVersion();
    const logBefore = await readLog();
    vi.spyOn(getStorage(), "writeFile").mockRejectedValue(new Error("disk is gone"));

    const res = await post("path=schema.md", {
      action: "revert",
      timestamp: only.timestamp,
    });

    expect(res.status).toBe(500);
    // The shape `savePreviewBody` parses — a framework 500 would not be `{ error }`.
    expect(typeof ((await res.json()) as { error: unknown }).error).toBe("string");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");

    vi.restoreAllMocks();
    expect(await readSchema(wiki)).toBe(FIRST_EDIT);
    expect(await readDataVersion()).toBe(before);
    expect(await readLog()).toBe(logBefore);
  });

  it("POST is 401 signed out and 403 for a non-owner", async () => {
    const wiki = await seed();
    await writeWikiArtifact(OWNER, wiki.id, "schema.md", FIRST_EDIT);
    const [only] = await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md");
    const body = { action: "revert", timestamp: only.timestamp };

    principal.current = null;
    expect((await post("path=schema.md", body)).status).toBe(401);
    principal.current = { id: "u2", handle: "someone-else" };
    expect((await post("path=schema.md", body)).status).toBe(403);
    // Neither reached the writer.
    principal.current = { id: "u1", handle: OWNER };
    expect(await readSchema(wiki)).toBe(FIRST_EDIT);
    expect(await listWikiArtifactRevisions(OWNER, wiki.id, "schema.md")).toHaveLength(1);
  });
});
