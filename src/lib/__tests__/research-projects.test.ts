import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  MAX_PROJECTS,
  applyResearchProjectMutation,
  createResearchProject,
  deleteResearchProject,
  filterResearchProjects,
  getResearchProject,
  listResearchProjects,
  repairResearchRegistry,
  ResearchProjectBusyError,
  updateResearchProject,
  updateResearchProjectIf,
} from "../research-projects";
import { ClientInputError, StoreFaultError } from "../errors";
import { READ_ONLY_REFUSAL, ReadOnlyError } from "../read-only";
import { _resetLocks } from "../lock";
import { _resetStorage, getStorage } from "../storage";
import { tenantForOwner } from "../wiki";

/** Absolute path of a tenant's stored registry — the bytes the rows below pin. */
function registryPath(owner: string): string {
  return path.join(tmpDir, "tenants", tenantForOwner(owner), "research-projects.json");
}

/** Seed raw registry bytes — the one writer, so a corrupt-file row can store a
 * non-list shape and {@link seedProjects} can store a well-formed one. */
async function seedRawRegistry(owner: string, raw: string): Promise<void> {
  const target = registryPath(owner);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, raw, "utf-8");
}

/** One stored row in exactly the shape the store itself writes. */
function seedRow(i: number, extra: Record<string, unknown> = {}) {
  const stamp = `2020-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`;
  return {
    id: `seed-${i}`,
    title: `Project ${i}`,
    question: "seeded",
    queries: [],
    sourceUrls: [],
    pageSlugs: [],
    status: "draft",
    createdAt: stamp,
    updatedAt: stamp,
    ...extra,
  };
}

/**
 * Seed `count` stored projects directly, so a cap row does not need 100 creates.
 *
 * `tombstoned` marks the FIRST n of them `deleteRequested` — the soft-deleted
 * state `retireResearchProject` leaves behind while a worker still holds the
 * row, which the panel hides.
 */
async function seedProjects(
  owner: string,
  count: number,
  { tombstoned = 0 }: { tombstoned?: number } = {},
): Promise<void> {
  const projects = Array.from({ length: count }, (_, i) =>
    seedRow(i, i < tombstoned ? { deleteRequested: true } : {}),
  );
  await seedRawRegistry(owner, JSON.stringify(projects, null, 2));
}

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "research-projects-"));
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

describe("research projects", () => {
  it("persists a brief with an empty source list, and its synthesis, per owner", async () => {
    const project = await createResearchProject("alice", {
      title: "Launch research",
      question: "What evidence supports the launch date?",
      queries: ["launch evidence", "launch evidence", "schedule risk"],
      vaultId: "alice--launch",
    });
    expect(project).toMatchObject({
      status: "draft",
      queries: ["launch evidence", "schedule risk"],
      // DW-442: creation takes no seed URLs, and the stored field still exists
      // as the empty `string[]` the registry guard requires.
      sourceUrls: [],
    });
    expect(await listResearchProjects("bob")).toEqual([]);

    const updated = await updateResearchProject("alice", project.id, {
      status: "complete",
      synthesis: "The launch date is supported by the approved brief.",
    });
    expect(updated).toMatchObject({
      status: "complete",
      synthesis: "The launch date is supported by the approved brief.",
    });
  });

  /**
   * DW-442. Creation stopped accepting `sourceUrls`, but the RUN still writes
   * it — `research-runtime` patches `{ results, sourceUrls }` when a provider
   * answers. These two rows are the whole remaining write path.
   */
  it("lands a run's collected source URLs through the patch", async () => {
    const project = await createResearchProject("alice", {
      title: "Launch research",
      question: "What evidence supports the launch date?",
    });
    expect(project.sourceUrls).toEqual([]);

    const updated = await updateResearchProject("alice", project.id, {
      // The `javascript:` entry pins that `cleanUrls` is still reached on this
      // path: the http/https filter moved, it did not go away.
      sourceUrls: ["https://example.com/found", "javascript:alert(1)"],
    });

    expect(updated?.sourceUrls).toEqual(["https://example.com/found"]);
  });

  it("lands a title and collected URLs patched together", async () => {
    // The `title`/`question` branch of `mutateProject` runs `cleanInput`, whose
    // result is `Object.assign`ed onto the live project. While that helper
    // still returned a `sourceUrls` key, a patch carrying BOTH dropped the URLs
    // on the floor — so the URL line now runs after both branches.
    const project = await createResearchProject("alice", {
      title: "Launch research",
      question: "What evidence supports the launch date?",
    });

    const updated = await updateResearchProject("alice", project.id, {
      title: "Launch research (revised)",
      sourceUrls: ["https://example.com/found"],
    });

    expect(updated).toMatchObject({
      title: "Launch research (revised)",
      sourceUrls: ["https://example.com/found"],
    });
  });

  it("keeps collected URLs when a title-only edit follows the run", async () => {
    // The other half: `cleanInput` must not return the key at all. Returning
    // `[]` from it would wipe the run's collected URLs on any title edit.
    const project = await createResearchProject("alice", {
      title: "Launch research",
      question: "What evidence supports the launch date?",
    });
    await updateResearchProject("alice", project.id, {
      sourceUrls: ["https://example.com/found"],
    });

    const updated = await updateResearchProject("alice", project.id, {
      title: "Launch research (revised)",
    });

    expect(updated?.sourceUrls).toEqual(["https://example.com/found"]);
  });

  /**
   * DW-603. `cleanUrls`' bounds were only ever pinned through the create,
   * which since DW-442 no longer accepts URLs — so the cap, the per-URL slice
   * and the dedupe were live on the run's patch (`research-runtime`'s
   * `{ results, sourceUrls }`) with nothing holding them. These rows pin the
   * CURRENT numbers; they are a characterization, not a request to change them.
   */
  describe("the run patch's source-URL bounds", () => {
    async function patchUrls(urls: readonly string[]): Promise<string[] | undefined> {
      const project = await createResearchProject("alice", {
        title: "Launch research",
        question: "What evidence supports the launch date?",
      });
      const updated = await updateResearchProject("alice", project.id, { sourceUrls: urls });
      return updated?.sourceUrls;
    }

    it("keeps the first 40 of a longer list, in first-seen order", async () => {
      const urls = Array.from({ length: 45 }, (_, i) => `https://example.com/found/${i}`);

      const stored = await patchUrls(urls);

      expect(stored).toHaveLength(40);
      expect(stored).toEqual(urls.slice(0, 40));
      // The tail is DROPPED, not rotated in: the cap `break`s on the way, so
      // the newest URLs a long run collected are the ones that do not land.
      expect(stored).not.toContain("https://example.com/found/40");
    });

    it("lets an unusable entry among the first 40 consume a slot and then drops it", async () => {
      // Where the cap actually bites. `cleanList` applies the 40-item cap and
      // `break`s BEFORE `cleanUrls`' http/https filter ever runs, so a
      // `javascript:` entry is counted toward the 40, then thrown away — and
      // the 40th good URL, which would otherwise have fitted, is never reached.
      // A run whose provider returns one unusable URL silently loses one good
      // one. Characterized, not endorsed; the order is not this bundle's to
      // change.
      const valid = Array.from({ length: 40 }, (_, i) => `https://example.com/found/${i}`);

      const stored = await patchUrls(["javascript:alert(1)", ...valid]);

      expect(stored).toHaveLength(39);
      expect(stored).toEqual(valid.slice(0, 39));
      expect(stored).not.toContain("https://example.com/found/39");
    });

    it("truncates a URL longer than 2000 characters", async () => {
      const long = `https://example.com/${"a".repeat(4_000)}`;

      const stored = await patchUrls([long]);

      expect(stored).toHaveLength(1);
      expect(stored?.[0]).toHaveLength(2_000);
      expect(stored?.[0]).toBe(long.slice(0, 2_000));
    });

    it("keeps a duplicate URL once, at its first position", async () => {
      const a = "https://example.com/a";
      const b = "https://example.com/b";

      // Dedupe runs on the CLEANED string, so surrounding whitespace does not
      // buy a second slot either.
      expect(await patchUrls([a, b, a, `  ${a}  `])).toEqual([a, b]);
    });

    it("counts a truncated URL as a duplicate of one sharing its first 2000 characters", async () => {
      // The slice happens BEFORE the dedupe, so two distinct URLs that agree
      // for their first 2000 characters collapse to one. Documented, not
      // desired — nothing here asks for the order to change.
      const prefix = `https://example.com/${"a".repeat(4_000)}`;

      const stored = await patchUrls([`${prefix}?one`, `${prefix}?two`]);

      expect(stored).toEqual([prefix.slice(0, 2_000)]);
    });
  });

  /**
   * DW-655. The bounds above are unchanged — every characterization row in
   * `the run patch's source-URL bounds` still passes unedited. What is new is
   * that the discarding is RECORDED: `Collect N URLs` reported the survivors
   * as if they were everything, and the row now carries what N left out.
   */
  describe("the run patch's recorded source-URL loss", () => {
    async function patch(urls: readonly string[]) {
      const project = await createResearchProject("alice", {
        title: "Launch research",
        question: "What evidence supports the launch date?",
      });
      return updateResearchProject("alice", project.id, { sourceUrls: urls });
    }

    it("records the tail the 40-item cap dropped", async () => {
      const urls = Array.from({ length: 45 }, (_, i) => `https://example.com/found/${i}`);

      const updated = await patch(urls);

      // The stored list is EXACTLY what it was before this work.
      expect(updated?.sourceUrls).toEqual(urls.slice(0, 40));
      expect(updated?.sourceUrlLoss).toEqual({ dropped: 5, truncated: 0 });
      // …and it SURVIVES a round trip. `isResearchProject` is structural and
      // knows nothing about this field, so a serialization regression would
      // never be caught by the returned value alone.
      const stored = await getResearchProject("alice", updated!.id);
      expect(stored?.sourceUrlLoss).toEqual({ dropped: 5, truncated: 0 });
    });

    it("records a truncation and the collapse it caused", async () => {
      // Two distinct URLs sharing their first 2,000 characters: the slice runs
      // before the dedupe, so one of them is stored — shortened — and the
      // other vanishes into it. Two facts, both now said.
      const prefix = `https://example.com/${"a".repeat(4_000)}`;

      const updated = await patch([`${prefix}?one`, `${prefix}?two`]);

      expect(updated?.sourceUrls).toEqual([prefix.slice(0, 2_000)]);
      expect(updated?.sourceUrlLoss).toEqual({ dropped: 1, truncated: 1 });
      const stored = await getResearchProject("alice", updated!.id);
      expect(stored?.sourceUrlLoss).toEqual({ dropped: 1, truncated: 1 });
    });

    it("counts a slot an unusable entry consumed as loss", async () => {
      // `cleanList` caps and `break`s BEFORE the http/https filter runs, so a
      // `javascript:` entry costs a good URL its place. Characterized above;
      // reported here.
      const valid = Array.from({ length: 40 }, (_, i) => `https://example.com/found/${i}`);

      const updated = await patch(["javascript:alert(1)", ...valid]);

      expect(updated?.sourceUrls).toHaveLength(39);
      expect(updated?.sourceUrlLoss).toEqual({ dropped: 1, truncated: 0 });
    });

    it("records nothing when a run lost nothing", async () => {
      const a = "https://example.com/a";

      const updated = await patch([a, "https://example.com/b", a, `  ${a}  `]);

      // A repeated URL is NOT loss: the caller only ever wanted one of it.
      expect(updated?.sourceUrls).toEqual([a, "https://example.com/b"]);
      expect(updated).not.toHaveProperty("sourceUrlLoss");
    });

    it("clears the record when a later run stores everything it found", async () => {
      const project = await createResearchProject("alice", {
        title: "Launch research",
        question: "What evidence supports the launch date?",
      });
      const lossy = await updateResearchProject("alice", project.id, {
        sourceUrls: Array.from({ length: 45 }, (_, i) => `https://example.com/found/${i}`),
      });
      expect(lossy?.sourceUrlLoss).toEqual({ dropped: 5, truncated: 0 });

      const clean = await updateResearchProject("alice", project.id, {
        sourceUrls: ["https://example.com/one"],
      });

      // The key is DELETED rather than zeroed, so the panel has one shape to
      // read and a stale note cannot outlive the run that earned it.
      expect(clean).not.toHaveProperty("sourceUrlLoss");
      const stored = await getResearchProject("alice", project.id);
      expect(stored).not.toHaveProperty("sourceUrlLoss");
    });

    it("is never taken from a caller's patch", async () => {
      const project = await createResearchProject("alice", {
        title: "Launch research",
        question: "What evidence supports the launch date?",
      });

      // Not on the patch type at all — so it arrives through a variable rather
      // than a fresh literal, which is the only way a caller could smuggle it
      // in. A future widening of that type has to come back and decide.
      const smuggled = {
        sourceUrls: ["https://example.com/one"],
        sourceUrlLoss: { dropped: 99, truncated: 99 },
      };
      await updateResearchProject("alice", project.id, smuggled);

      expect(await getResearchProject("alice", project.id)).not.toHaveProperty("sourceUrlLoss");

      // THE LOAD-BEARING HALF: with no `sourceUrls` key the guard block does
      // not run at all, so the `delete` above is not what refuses this. A
      // blanket `Object.assign(project, patch)` would land it here and the
      // case above would still be green.
      await updateResearchProject("alice", project.id, {
        status: "complete",
        ...({ sourceUrlLoss: { dropped: 99, truncated: 99 } } as object),
      });

      expect(await getResearchProject("alice", project.id)).not.toHaveProperty("sourceUrlLoss");
    });

    it("keeps a recorded loss across an unrelated edit", async () => {
      // The other direction: the field is per-RUN, not per-write. A title edit
      // is not a new run and must not clear what the last run recorded — only
      // a fresh `sourceUrls` patch (or a requeue) does.
      const project = await createResearchProject("alice", {
        title: "Launch research",
        question: "What evidence supports the launch date?",
      });
      await updateResearchProject("alice", project.id, {
        sourceUrls: Array.from({ length: 45 }, (_, i) => `https://example.com/found/${i}`),
      });

      await updateResearchProject("alice", project.id, { title: "Launch research (revised)" });

      const stored = await getResearchProject("alice", project.id);
      expect(stored?.title).toBe("Launch research (revised)");
      expect(stored?.sourceUrlLoss).toEqual({ dropped: 5, truncated: 0 });
    });
  });

  it("deletes only from the owning workspace", async () => {
    const project = await createResearchProject("alice", {
      title: "Topic",
      question: "What changed?",
    });
    expect(await deleteResearchProject("bob", project.id)).toBe(false);
    expect(await deleteResearchProject("alice", project.id)).toBe(true);
    expect(await listResearchProjects("alice")).toEqual([]);
  });
  /**
   * DW-164. The registry write USED TO persist only the last `MAX_PROJECTS`
   * entries, so a create that pushed past the cap reported success while
   * silently evicting the tenant's OLDEST project. It no longer truncates at
   * all — `serializeProjects` writes the array verbatim, and this create guard
   * is the only place the cap is enforced. These rows pin the create's whole
   * obligation to state that was already on disk: it either appends, or it
   * changes nothing at all.
   */
  describe("create discipline at the cap", () => {
    it("refuses at MAX_PROJECTS without evicting anything", async () => {
      await seedProjects("alice", MAX_PROJECTS);
      const before = await fs.readFile(registryPath("alice"), "utf-8");
      // Byte equality alone would NOT prove the refusal wrote nothing:
      // `seedProjects` writes the exact format and key order
      // `serializeProjects` produces, so a read-reserialize-rewrite would land
      // identical bytes and pass. The spy is what pins "before any write".
      const storage = getStorage();
      const spy = vi.spyOn(storage, "writeFile");

      try {
        await expect(
          createResearchProject("alice", { title: "One too many", question: "Fits?" }),
        ).rejects.toBeInstanceOf(ClientInputError);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }

      expect(await fs.readFile(registryPath("alice"), "utf-8")).toBe(before);
      const after = await listResearchProjects("alice");
      expect(after).toHaveLength(MAX_PROJECTS);
      expect(after.map((p) => p.id)).toContain("seed-0");
    });

    /**
     * DW-479. The cap counted `projects.length` while the panel renders
     * `filterResearchProjects`, so a tenant holding tombstones was refused at a
     * cap the UI said had room — a dead end, because the rows occupying the
     * slots are invisible to the owner. The cap now counts the same visible set.
     */
    it("does not count a tombstoned row against the cap", async () => {
      await seedProjects("alice", MAX_PROJECTS, { tombstoned: 2 });

      const project = await createResearchProject("alice", {
        title: "The panel says there is room",
        question: "Fits?",
      });

      // Accepted AND appended — nothing was evicted to make space.
      const stored = await listResearchProjects("alice");
      expect(stored).toHaveLength(MAX_PROJECTS + 1);
      expect(stored.map((p) => p.id)).toContain(project.id);
      expect(stored.map((p) => p.id)).toContain("seed-0");
      // The tombstones are still there: the cap stopped counting them, it did
      // not reap or rewrite them.
      expect(stored.filter((p) => p.deleteRequested)).toHaveLength(2);
      expect(filterResearchProjects(stored, null)).toHaveLength(MAX_PROJECTS - 1);
    });

    it("still refuses when every row at the cap is visible", async () => {
      // The discriminator for the row above: hiding is what buys the slot, not
      // "the cap got looser".
      await seedProjects("alice", MAX_PROJECTS);

      await expect(
        createResearchProject("alice", { title: "No room", question: "Fits?" }),
      ).rejects.toBeInstanceOf(ClientInputError);
    });

    it("still appends one below the cap", async () => {
      await seedProjects("alice", MAX_PROJECTS - 1);

      const project = await createResearchProject("alice", {
        title: "Room for one more",
        question: "Fits?",
      });

      expect(project.status).toBe("draft");
      const after = await listResearchProjects("alice");
      expect(after).toHaveLength(MAX_PROJECTS);
      expect(after.map((p) => p.id)).toContain(project.id);
      expect(after.map((p) => p.id)).toContain("seed-0");
    });

    it("leaves the stored registry untouched when the registry write fails", async () => {
      await seedProjects("alice", 3);
      const before = await fs.readFile(registryPath("alice"), "utf-8");
      const storage = getStorage();
      const fault = new Error("disk full");
      const spy = vi
        .spyOn(storage, "writeFileIfMatch")
        .mockImplementation(async (target: string) => {
          if (target.endsWith("research-projects.json")) throw fault;
          return false;
        });

      try {
        // The original storage error, not a wrapped one — the caller needs to
        // tell a storage fault from a cap refusal.
        await expect(
          createResearchProject("alice", { title: "Doomed", question: "Lands?" }),
        ).rejects.toBe(fault);
      } finally {
        spy.mockRestore();
      }

      // No undo runs and none is needed: the create writes exactly one file and
      // the pushed array is function-local.
      expect(await fs.readFile(registryPath("alice"), "utf-8")).toBe(before);
      expect((await listResearchProjects("alice")).map((p) => p.id)).toEqual([
        "seed-2",
        "seed-1",
        "seed-0",
      ]);
    });
  });

  /**
   * DW-297. A registry that parsed to something other than a list used to read
   * as "no projects" at BOTH read sites, so a corrupt file cleared the cap
   * guard and the very next create overwrote it. Refusing is the only honest
   * answer: the tenant's projects are not gone, they are unreadable.
   */
  describe("a registry that is not a list", () => {
    it.each([
      ["a JSON object", '{"projects":[]}'],
      ["a JSON string", '"nope"'],
      ["a JSON number", "12"],
    ])("rejects reads when the stored registry is %s", async (_label, raw) => {
      await seedRawRegistry("alice", raw);

      // A StoreFaultError, NOT a ClientInputError: a wrong-shaped stored file
      // is a server fault (500), not something the caller sent. The POSITIVE
      // assertion is the load-bearing one — `not.toBeInstanceOf` alone is
      // satisfied by a plain `Error`, so it would not notice the type going
      // away, and the route classifiers now read this type to answer 500.
      await expect(listResearchProjects("alice")).rejects.toThrow(
        "Research projects file is not a list.",
      );
      await expect(listResearchProjects("alice")).rejects.toBeInstanceOf(StoreFaultError);
      await expect(listResearchProjects("alice")).rejects.not.toBeInstanceOf(ClientInputError);
      await expect(getResearchProject("alice", "seed-0")).rejects.toThrow(
        "Research projects file is not a list.",
      );
    });

    it("rejects a create and leaves the stored bytes byte-identical", async () => {
      const raw = '{"projects":[{"id":"seed-0"}]}';
      await seedRawRegistry("alice", raw);
      const storage = getStorage();
      const spies = [
        vi.spyOn(storage, "writeFile"),
        vi.spyOn(storage, "writeFileIfMatch"),
        vi.spyOn(storage, "writeFileIfAbsent"),
      ];

      try {
        // The CAS read refuses too, so the create never sees `[]`, never
        // clears the cap guard and never replaces the file.
        await expect(
          createResearchProject("alice", { title: "Overwrite", question: "Lands?" }),
        ).rejects.toThrow("Research projects file is not a list.");
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }

      expect(await fs.readFile(registryPath("alice"), "utf-8")).toBe(raw);
    });

    it.each([
      [
        "an update",
        async () => {
          // Would resolve `null` for an unknown id against a healthy registry,
          // so a REJECTION can only have come from the registry parse.
          await updateResearchProject("alice", "seed-0", { status: "complete" });
        },
      ],
      [
        "a delete",
        async () => {
          // `deleteResearchProject` clears `withResearchProjectLifecycleFence`
          // and `hasResearchSlot` first, and both of those early-out by
          // RESOLVING `false` — never by throwing. A rejection here therefore
          // reaches past them to the CAS read.
          await deleteResearchProject("alice", "seed-0");
        },
      ],
    ])("rejects %s and leaves the stored bytes byte-identical", async (_label, run) => {
      const raw = '{"projects":[{"id":"seed-0"}]}';
      await seedRawRegistry("alice", raw);

      await expect(run()).rejects.toThrow("Research projects file is not a list.");

      expect(await fs.readFile(registryPath("alice"), "utf-8")).toBe(raw);
    });

    it("still treats a missing registry as an empty one", async () => {
      expect(await listResearchProjects("alice")).toEqual([]);
      const project = await createResearchProject("alice", { title: "First", question: "New?" });
      expect((await listResearchProjects("alice")).map((p) => p.id)).toEqual([project.id]);
    });
  });

  /**
   * DW-476. `parseRegistry` refused a non-array but validated no ELEMENT, so a
   * list of anything at all was cast to `ResearchProject[]` and died later —
   * `[1,2,3]` blew up in `listResearchProjects`' `b.updatedAt.localeCompare` as
   * an opaque `TypeError`, far from the file that caused it, and only on the
   * paths that happen to sort. The per-element guard lives in the same shared
   * helper as the non-array check, so both read sites refuse together.
   */
  describe("a registry whose elements are not research projects", () => {
    /** A row the app would otherwise accept, minus the field the sort reads. */
    function withoutUpdatedAt(): Record<string, unknown> {
      const row: Record<string, unknown> = seedRow(0);
      delete row.updatedAt;
      return row;
    }

    const badRegistries: [string, string][] = [
      ["a list of numbers", JSON.stringify([1, 2, 3])],
      ["a list of empty objects", JSON.stringify([{}])],
      ["a row missing updatedAt", JSON.stringify([withoutUpdatedAt()])],
      // An unrecognized status is refused rather than read as "not editable":
      // the `EDITABLE` sets around the app all decide by membership, so an
      // unknown literal would quietly mean "locked forever".
      ["a row with an unknown status", JSON.stringify([seedRow(0, { status: "archived" })])],
      ["a row whose queries are not strings", JSON.stringify([seedRow(0, { queries: [7] })])],
      // Load-bearing twice over since DW-479: a truthy non-boolean would hide
      // the row from the panel forever AND free a cap slot nothing reclaims.
      [
        "a row whose deleteRequested is the string \"false\"",
        JSON.stringify([seedRow(0, { deleteRequested: "false" })]),
      ],
    ];

    it.each(badRegistries)("rejects reads when the registry is %s", async (_label, raw) => {
      await seedRawRegistry("alice", raw);

      // A StoreFaultError, NOT a ClientInputError: a wrong-shaped stored file
      // is a server fault (500), the same rule the non-array throw states.
      // The INDEX is part of the contract: the repair route restarts the
      // registry EMPTY, so this is the operator's only account of what the
      // quarantined bytes held.
      await expect(listResearchProjects("alice")).rejects.toThrow(
        "Research project entry 0 is invalid.",
      );
      await expect(listResearchProjects("alice")).rejects.toBeInstanceOf(StoreFaultError);
      await expect(listResearchProjects("alice")).rejects.not.toBeInstanceOf(ClientInputError);
      await expect(getResearchProject("alice", "seed-0")).rejects.toThrow(
        "Research project entry 0 is invalid.",
      );
    });

    it.each(badRegistries)(
      "rejects a create against %s and leaves the stored bytes byte-identical",
      async (_label, raw) => {
        await seedRawRegistry("alice", raw);
        const storage = getStorage();
        const spies = [
          vi.spyOn(storage, "writeFile"),
          vi.spyOn(storage, "writeFileIfMatch"),
          vi.spyOn(storage, "writeFileIfAbsent"),
        ];

        try {
          // The CAS read refuses too, so the create never sees `[]` and never
          // replaces the file.
          const create = () =>
            createResearchProject("alice", { title: "Overwrite", question: "Lands?" });
          await expect(create()).rejects.toThrow("Research project entry 0 is invalid.");
          // A SERVER fault at this door too, not just at the read doors: the
          // whole point of `StoreFaultError` is that every door answers 500.
          await expect(create()).rejects.not.toBeInstanceOf(ClientInputError);
          for (const spy of spies) expect(spy).not.toHaveBeenCalled();
        } finally {
          for (const spy of spies) spy.mockRestore();
        }

        expect(await fs.readFile(registryPath("alice"), "utf-8")).toBe(raw);
      },
    );

    it.each([
      [
        "an update",
        async () => {
          await updateResearchProject("alice", "seed-0", { status: "complete" });
        },
      ],
      [
        "a delete",
        async () => {
          await deleteResearchProject("alice", "seed-0");
        },
      ],
    ])("rejects %s and leaves the stored bytes byte-identical", async (_label, run) => {
      const raw = JSON.stringify([{}]);
      await seedRawRegistry("alice", raw);

      await expect(run()).rejects.toThrow("Research project entry 0 is invalid.");
      await expect(run()).rejects.not.toBeInstanceOf(ClientInputError);

      expect(await fs.readFile(registryPath("alice"), "utf-8")).toBe(raw);
    });

    it("still reads a registry the app itself wrote", async () => {
      // The guard must not be stricter than the writer: every status the store
      // can persist, plus the optional fields a run adds, still parse.
      await seedRawRegistry(
        "alice",
        JSON.stringify([
          seedRow(0),
          seedRow(1, { status: "queued", vaultId: "alice--launch" }),
          seedRow(2, { status: "collecting", progress: { completedQueries: 1, totalQueries: 3, message: "" } }),
          seedRow(3, { status: "ready", thinking: ["looking"] }),
          seedRow(4, { status: "complete", synthesis: "done", results: [] }),
          seedRow(5, { status: "failed", error: "provider down" }),
          seedRow(6, { status: "cancelled", deleteRequested: true }),
        ]),
      );

      const stored = await listResearchProjects("alice");
      expect(stored).toHaveLength(7);
      expect(filterResearchProjects(stored, null)).toHaveLength(6);
      expect(await getResearchProject("alice", "seed-4")).toMatchObject({ status: "complete" });
    });
  });

  /**
   * DW-575. `parseRegistry` wrapped neither of the two throws below it in a
   * try/catch around `JSON.parse`, so bytes that are not JSON at all escaped
   * as a raw `SyntaxError` naming a byte offset instead of the file — the
   * opaque-error-far-from-the-cause shape the element guard above exists to
   * kill. The parse fault is now the same plain `Error` refusal, at the same
   * shared helper, so every door still says the same thing.
   */
  describe("a registry whose bytes are not JSON", () => {
    const unreadable: [string, string][] = [
      ["truncated bytes", '{"id":'],
      ["a truncated list", '[{"id":"seed-0"}'],
      ["bytes that are not JSON at all", "not json at all"],
      ["empty bytes", ""],
    ];

    it.each(unreadable)("rejects reads when the registry holds %s", async (_label, raw) => {
      await seedRawRegistry("alice", raw);

      // A StoreFaultError, NOT a ClientInputError: unreadable stored bytes are
      // a server fault (500). The message names the FILE — a `SyntaxError`'s
      // "Unexpected token … at position 41" names only an offset.
      await expect(listResearchProjects("alice")).rejects.toThrow(
        "Research projects file is unreadable.",
      );
      await expect(listResearchProjects("alice")).rejects.toBeInstanceOf(StoreFaultError);
      await expect(listResearchProjects("alice")).rejects.not.toBeInstanceOf(ClientInputError);
      await expect(listResearchProjects("alice")).rejects.not.toBeInstanceOf(SyntaxError);
      await expect(getResearchProject("alice", "seed-0")).rejects.toThrow(
        "Research projects file is unreadable.",
      );
    });

    it.each(unreadable)(
      "rejects a create against %s and leaves the stored bytes byte-identical",
      async (_label, raw) => {
        await seedRawRegistry("alice", raw);
        const storage = getStorage();
        const spies = [
          vi.spyOn(storage, "writeFile"),
          vi.spyOn(storage, "writeFileIfMatch"),
          vi.spyOn(storage, "writeFileIfAbsent"),
        ];

        try {
          // The CAS read refuses too, so the create never sees `[]`, never
          // clears the cap guard and never overwrites the corrupt file.
          await expect(
            createResearchProject("alice", { title: "Overwrite", question: "Lands?" }),
          ).rejects.toThrow("Research projects file is unreadable.");
          for (const spy of spies) expect(spy).not.toHaveBeenCalled();
        } finally {
          for (const spy of spies) spy.mockRestore();
        }

        expect(await fs.readFile(registryPath("alice"), "utf-8")).toBe(raw);
      },
    );

    it.each([
      [
        "an update",
        async () => {
          await updateResearchProject("alice", "seed-0", { status: "complete" });
        },
      ],
      [
        "a delete",
        async () => {
          await deleteResearchProject("alice", "seed-0");
        },
      ],
    ])("rejects %s and leaves the stored bytes byte-identical", async (_label, run) => {
      const raw = "not json at all";
      await seedRawRegistry("alice", raw);

      await expect(run()).rejects.toThrow("Research projects file is unreadable.");
      await expect(run()).rejects.not.toBeInstanceOf(ClientInputError);

      expect(await fs.readFile(registryPath("alice"), "utf-8")).toBe(raw);
    });

    it("still treats a MISSING registry as an empty one", async () => {
      // Only the parse fault is retyped: `readProjects` still swallows ENOENT,
      // so a tenant with no file yet is not an unreadable one.
      expect(await listResearchProjects("alice")).toEqual([]);
      const project = await createResearchProject("alice", { title: "First", question: "New?" });
      expect((await listResearchProjects("alice")).map((p) => p.id)).toEqual([project.id]);
    });

    it("still reads a well-formed registry", async () => {
      await seedRawRegistry("alice", JSON.stringify([seedRow(0), seedRow(1)]));
      expect((await listResearchProjects("alice")).map((p) => p.id)).toEqual(["seed-1", "seed-0"]);
    });
  });

  /**
   * DW-477. A registry `parseRegistry` refuses wedges every research door for
   * its owner — the DELETEs that could have shrunk the file included — and
   * until now the 500 named no way out. `repairResearchRegistry` is that way
   * out: quarantine the bytes, restart empty. These rows run against REAL
   * stored bytes, so what they pin is the store's behaviour, not the door's
   * status codes (`research-repair-route.test.ts` owns those).
   */
  describe("repairing a wedged registry", () => {
    /** The one shape of write that must never happen on a healthy registry. */
    function writeSpies() {
      const storage = getStorage();
      return [
        vi.spyOn(storage, "writeFile"),
        vi.spyOn(storage, "writeFileIfMatch"),
        vi.spyOn(storage, "writeFileIfAbsent"),
      ];
    }

    it.each([
      ["a JSON object", '{"projects":[]}'],
      ["truncated bytes", '[{"id":"seed-0"}'],
      ["bytes that are not JSON at all", "not json at all"],
      ["a list whose elements are not projects", JSON.stringify([{}])],
    ])(
      "quarantines %s verbatim and leaves the tenant a readable empty registry",
      async (_label, raw) => {
        await seedRawRegistry("alice", raw);
        // The precondition the repair exists for: every door refuses.
        await expect(listResearchProjects("alice")).rejects.toBeInstanceOf(StoreFaultError);

        const repair = await repairResearchRegistry("alice");

        expect(repair.quarantined).toBe(true);
        const quarantinePath = (repair as { path: string }).path;
        expect(quarantinePath).toMatch(
          new RegExp(`^tenants/${tenantForOwner("alice")}/research-projects\\.json\\.corrupt-\\d+$`),
        );
        // VERBATIM. The bytes are unreadable, not worthless — they are the
        // only record of what the tenant had, and nothing reaps them.
        expect(await getStorage().readFile(quarantinePath)).toBe(raw);
        // …and the doors answer again.
        expect(await listResearchProjects("alice")).toEqual([]);
        expect(await getResearchProject("alice", "seed-0")).toBeNull();
        const created = await createResearchProject("alice", {
          title: "After the repair",
          question: "Does the store work again?",
        });
        expect((await listResearchProjects("alice")).map((p) => p.id)).toEqual([created.id]);
      },
    );

    it.each([
      ["a healthy registry", JSON.stringify([seedRow(0), seedRow(1)], null, 2)],
      ["an empty list", "[]"],
      // Every row tombstoned still PARSES, so there is nothing to repair — the
      // panel showing no projects is not the same fact as the file being
      // unreadable, and a repair that could not tell them apart would throw
      // away a tenant's outstanding deletes.
      ["a fully tombstoned registry", JSON.stringify([seedRow(0, { deleteRequested: true })], null, 2)],
    ])("refuses to touch %s, writing nothing at all", async (_label, raw) => {
      await seedRawRegistry("alice", raw);
      const spies = writeSpies();

      try {
        expect(await repairResearchRegistry("alice")).toEqual({ quarantined: false });
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }

      expect(await fs.readFile(registryPath("alice"), "utf-8")).toBe(raw);
    });

    it("treats a missing registry as nothing to repair, and creates no file", async () => {
      const spies = writeSpies();

      try {
        expect(await repairResearchRegistry("alice")).toEqual({ quarantined: false });
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }

      await expect(fs.readFile(registryPath("alice"), "utf-8")).rejects.toThrow();
    });

    it("repairs only the owner's own tenant", async () => {
      await seedRawRegistry("alice", "not json at all");
      await seedRawRegistry("bob", JSON.stringify([seedRow(0)], null, 2));
      const bobBefore = await fs.readFile(registryPath("bob"), "utf-8");

      expect((await repairResearchRegistry("alice")).quarantined).toBe(true);

      expect(await fs.readFile(registryPath("bob"), "utf-8")).toBe(bobBefore);
      expect((await listResearchProjects("bob")).map((p) => p.id)).toEqual(["seed-0"]);
    });

    it("loses the compare-and-swap rather than blind-writing over a concurrent fix", async () => {
      await seedRawRegistry("alice", "not json at all");
      const storage = getStorage();
      // The writer that got there first — possibly the very fix this call was
      // about to make.
      const spy = vi.spyOn(storage, "writeFileIfMatch").mockResolvedValue(false);

      try {
        const error = await repairResearchRegistry("alice").then(
          () => null,
          (e: unknown) => e,
        );

        // The EXISTING typed class and its existing sentence, so the door can
        // answer the 503 `POST /api/research/[id]/run` already answers.
        expect(error).toBeInstanceOf(ResearchProjectBusyError);
        expect((error as Error).message).toBe(
          "Research projects were busy; retry the request.",
        );
      } finally {
        spy.mockRestore();
      }

      // The live file is untouched, and the quarantine copy — written first on
      // purpose — is the harmless residue of the race.
      expect(await fs.readFile(registryPath("alice"), "utf-8")).toBe("not json at all");
    });

    it("never replaces the live file when the quarantine copy fails", async () => {
      await seedRawRegistry("alice", "not json at all");
      const storage = getStorage();
      const copy = vi.spyOn(storage, "writeFileIfAbsent").mockRejectedValue(
        Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }),
      );
      const replace = vi.spyOn(storage, "writeFileIfMatch");

      try {
        await expect(repairResearchRegistry("alice")).rejects.toThrow("ENOSPC");
        // Copy FIRST, and its failure propagates: a silently skipped copy
        // would turn a repair into a delete.
        expect(replace).not.toHaveBeenCalled();
      } finally {
        copy.mockRestore();
        replace.mockRestore();
      }

      expect(await fs.readFile(registryPath("alice"), "utf-8")).toBe("not json at all");
    });

    it("rethrows a storage read fault untouched, writing nothing", async () => {
      const storage = getStorage();
      const fault = Object.assign(
        new Error("EACCES: permission denied, open 'research-projects.json'"),
        { code: "EACCES" },
      );
      const read = vi.spyOn(storage, "readFileWithEtag").mockRejectedValue(fault);
      const spies = writeSpies();

      try {
        // Not swallowed as "nothing to repair": only ENOENT means that, and a
        // permission fault reported as a 409 would send the operator looking
        // for a file that reads fine.
        await expect(repairResearchRegistry("alice")).rejects.toBe(fault);
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      } finally {
        read.mockRestore();
        for (const spy of spies) spy.mockRestore();
      }
    });

    it("refuses on a read-only deployment before reading anything", async () => {
      await seedRawRegistry("alice", "not json at all");
      const storage = getStorage();
      const read = vi.spyOn(storage, "readFileWithEtag");
      const spies = writeSpies();
      process.env.YOPEDIA_READONLY = "1";

      try {
        // The kernel gate, not the door's: a direct library caller with no
        // route in front meets the same refusal, and it precedes the read.
        await expect(repairResearchRegistry("alice")).rejects.toBeInstanceOf(ReadOnlyError);
        await expect(repairResearchRegistry("alice")).rejects.toThrow(
          READ_ONLY_REFUSAL.researchMutate,
        );
        expect(read).not.toHaveBeenCalled();
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      } finally {
        delete process.env.YOPEDIA_READONLY;
        read.mockRestore();
        for (const spy of spies) spy.mockRestore();
      }

      expect(await fs.readFile(registryPath("alice"), "utf-8")).toBe("not json at all");
    });

    it.each([
      ["a JSON object", '{"projects":[]}', "Research projects file is not a list."],
      ["bytes that are not JSON", "not json", "Research projects file is unreadable."],
      ["a bad row", JSON.stringify([{}]), "Research project entry 0 is invalid."],
    ])("names the repair route in the refusal for %s", async (_label, raw, diagnosis) => {
      await seedRawRegistry("alice", raw);

      // The SUFFIX shape: the existing diagnosis leads, verbatim, and the way
      // out follows. A 500 that named no remedy is what DW-477 was.
      await expect(listResearchProjects("alice")).rejects.toThrow(
        `${diagnosis} Repair it with POST /api/research/repair, then retry.`,
      );
      await expect(listResearchProjects("alice")).rejects.toBeInstanceOf(StoreFaultError);
    });

    it("keeps a second quarantine beside the first", async () => {
      // No sleep between the two: the key is CLAIMED create-only, so a
      // same-millisecond second repair takes the next suffix rather than
      // overwriting the first rescue.
      await seedRawRegistry("alice", "first corruption");
      const first = await repairResearchRegistry("alice");
      await seedRawRegistry("alice", "second corruption");

      const second = await repairResearchRegistry("alice");

      const firstPath = (first as { path: string }).path;
      const secondPath = (second as { path: string }).path;
      expect(secondPath).not.toBe(firstPath);
      // Nothing prunes or reaps a `.corrupt-*` sibling.
      expect(await getStorage().readFile(firstPath)).toBe("first corruption");
      expect(await getStorage().readFile(secondPath)).toBe("second corruption");
    });

    it("never overwrites a rescue whose key it would otherwise reuse", async () => {
      // The collision the `Date.now()` stamp cannot rule out, forced: the
      // timestamped key is already taken. A plain `writeFile` would destroy
      // the bytes sitting there — the exact copy this operation exists to
      // preserve — and report success.
      await seedRawRegistry("alice", "second corruption");
      const storage = getStorage();
      // The clock is FROZEN, so the collision is the one the millisecond stamp
      // genuinely cannot rule out rather than one this test raced for.
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_788_000_000_000);
      const stamp = `tenants/${tenantForOwner("alice")}/research-projects.json.corrupt-1788000000000`;

      try {
        await storage.writeFile(stamp, "first corruption");

        const repair = await repairResearchRegistry("alice");

        const claimed = (repair as { path: string }).path;
        expect(claimed).not.toBe(stamp);
        // The occupied key still holds what it held.
        expect(await storage.readFile(stamp)).toBe("first corruption");
        expect(await storage.readFile(claimed)).toBe("second corruption");
        // The ordinary shape is preserved for the ordinary case; only a real
        // collision grows a suffix.
        expect(claimed).toBe(`${stamp}-2`);
      } finally {
        clock.mockRestore();
      }
    });

    it("leaves the live file alone when no quarantine key can be claimed", async () => {
      await seedRawRegistry("alice", "not json at all");
      const storage = getStorage();
      // Every key refused, which is the only case that must NOT fall back to
      // an overwrite: the repair's whole safety is that the bytes are
      // somewhere else first.
      const claim = vi.spyOn(storage, "writeFileIfAbsent").mockResolvedValue(false);
      const replace = vi.spyOn(storage, "writeFileIfMatch");

      try {
        await expect(repairResearchRegistry("alice")).rejects.toThrow(
          /Could not claim a quarantine key/,
        );
        await expect(repairResearchRegistry("alice")).rejects.toBeInstanceOf(StoreFaultError);
        expect(replace).not.toHaveBeenCalled();
      } finally {
        claim.mockRestore();
        replace.mockRestore();
      }

      expect(await fs.readFile(registryPath("alice"), "utf-8")).toBe("not json at all");
    });
  });

  /**
   * DW-298. The registry write used to `slice(-MAX_PROJECTS)`, so an update or
   * a delete against legacy over-cap data shed the OLDEST-inserted rows as a
   * side effect of saving something else. A write now evicts nothing; the
   * create guard is the only cap.
   */
  describe("legacy over-cap registry", () => {
    it("loses no entry when one project is deleted", async () => {
      await seedProjects("alice", MAX_PROJECTS + 2);

      expect(await deleteResearchProject("alice", "seed-50")).toBe(true);

      const after = await listResearchProjects("alice");
      expect(after).toHaveLength(MAX_PROJECTS + 1);
      const ids = after.map((p) => p.id);
      expect(ids).toContain("seed-0");
      expect(ids).not.toContain("seed-50");
    });

    it("loses no entry when one project is updated", async () => {
      await seedProjects("alice", MAX_PROJECTS + 2);

      await updateResearchProject("alice", `seed-${MAX_PROJECTS + 1}`, { status: "complete" });

      const after = await listResearchProjects("alice");
      expect(after).toHaveLength(MAX_PROJECTS + 2);
      expect(after.map((p) => p.id)).toContain("seed-0");
    });

    it("still refuses a create while the registry is at or above the cap", async () => {
      await seedProjects("alice", MAX_PROJECTS + 2);

      await expect(
        createResearchProject("alice", { title: "One too many", question: "Fits?" }),
      ).rejects.toBeInstanceOf(ClientInputError);
      expect(await listResearchProjects("alice")).toHaveLength(MAX_PROJECTS + 2);
    });
  });

  it.each([
    ["a blank title", { title: "   ", question: "What changed?" }],
    ["a blank question", { title: "Topic", question: "   " }],
  ])("rejects %s as caller input, not a server fault", async (_label, input) => {
    // DW-296. Typed so `POST /api/research` can classify it 400 without
    // string-matching the message.
    await expect(createResearchProject("alice", input)).rejects.toBeInstanceOf(ClientInputError);
  });

  it("filters the list to one Workbench Wiki and leaves unscoped lists intact", async () => {
    const projects = [
      { id: "a", vaultId: "wiki-a" },
      { id: "b", vaultId: "wiki-b" },
      { id: "c" },
    ] as Awaited<ReturnType<typeof listResearchProjects>>;
    expect(filterResearchProjects(projects, "wiki-a").map((project) => project.id)).toEqual(["a"]);
    expect(filterResearchProjects(projects, "").map((project) => project.id)).toEqual(["a", "b", "c"]);
    expect(filterResearchProjects(
      [...projects, { id: "gone", vaultId: "wiki-a", deleteRequested: true } as (typeof projects)[number]],
      "wiki-a",
    ).map((project) => project.id)).toEqual(["a"]);
  });

  it("makes the queued-to-collecting claim atomic", async () => {
    const created = await createResearchProject("alice", { title: "Claim", question: "Once?" });
    const first = await updateResearchProjectIf(
      "alice",
      created.id,
      (project) => project.status === "draft",
      { status: "collecting" },
    );
    const second = await updateResearchProjectIf(
      "alice",
      created.id,
      (project) => project.status === "draft",
      { status: "collecting" },
    );
    expect(first?.status).toBe("collecting");
    expect(second).toBeNull();
  });

  it("lets only one of two isolate-style claim racers write collecting", async () => {
    const created = await createResearchProject("alice", { title: "Race", question: "Once?" });
    await updateResearchProject("alice", created.id, { status: "queued" });

    const claim = () =>
      applyResearchProjectMutation("alice", (projects) => {
        const project = projects.find((item) => item.id === created.id);
        if (!project || project.status !== "queued") {
          return { projects, result: null };
        }
        project.status = "collecting";
        return { projects, result: project };
      });

    const [first, second] = await Promise.all([claim(), claim()]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect((await listResearchProjects("alice"))[0]?.status).toBe("collecting");
  });

  it("throws a typed busy error when the CAS ladder is exhausted", async () => {
    // DW-651. `POST /api/research/[id]/run` classifies its catch by TYPE, so
    // this refusal being a plain `Error` made contention indistinguishable from
    // a broken store: 503-with-a-retry-signal reported as a permanent 500. The
    // sentence is asserted alongside the class because the response body echoes
    // it verbatim.
    await createResearchProject("alice", { title: "Contended", question: "Lands?" });
    const storage = getStorage();
    // Every compare-and-swap loses, which is what an infinitely contended
    // registry looks like from inside the loop. The registry is the ONLY file
    // this mutation writes, so any other target means the test has drifted from
    // the code it pins rather than that a second write is legitimate.
    const spy = vi
      .spyOn(storage, "writeFileIfMatch")
      .mockImplementation(async (target: string) => {
        if (!target.endsWith("research-projects.json")) {
          throw new Error(`unexpected registry-mutation write to ${target}`);
        }
        return false;
      });

    try {
      const error = await applyResearchProjectMutation("alice", (projects) => ({
        projects,
        result: null,
      })).then(() => null, (e: unknown) => e);

      expect(error).toBeInstanceOf(ResearchProjectBusyError);
      expect((error as Error).message).toBe(
        "Research projects were busy; retry the request.",
      );
      // The whole LADDER ran, not one attempt that gave up. Without this a loop
      // cut to a single try would still throw the same class with the same
      // sentence, and a contended-but-recoverable write would start failing.
      // 8 is `CAS_ATTEMPTS`, module-private and so spelled out here.
      expect(spy).toHaveBeenCalledTimes(8);
    } finally {
      spy.mockRestore();
    }
  });
});
