/**
 * The read-only refusal in the research, Names & Terms and email-ingest stores
 * (DW-385).
 *
 * The sibling of `read-only-kernel-gate.test.ts`, for the three stores DW-314
 * left behind. They carried HTTP gates only, so a DIRECT LIBRARY CALL — the
 * CLI, `src/mcp.ts`, the agent runtime, a maintenance script — wrote them on a
 * read-only deployment. Like its sibling, this suite goes through NO route at
 * all: what it pins is exactly the claim no route test can make.
 *
 * Every refusal case asserts BYTES, not just a thrown error. A gate placed
 * after the write, or one that lets a lock lease land before throwing, would
 * satisfy `rejects.toThrow` and still have mutated the deployment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { ensureDirectories, tenantForOwner } from "../wiki";
import {
  applyResearchProjectMutation,
  createResearchProject,
  deleteResearchProject,
  editResearchProject,
  getResearchProject,
  isResearchWriteRefused,
  listResearchProjects,
  mutateResearchProject,
  mutateResearchProjectOrRefusal,
  RESEARCH_WRITE_REFUSED,
  updateResearchProject,
  updateResearchProjectIf,
  updateResearchProjectIfOrRefusal,
  withResearchProjectLifecycleFence,
} from "../research-projects";
import { acquireResearchSlot } from "../research-concurrency";
import {
  drainResearchOutbox,
  loadResearchOutbox,
  saveResearchOutbox,
} from "../research-completion";
import {
  cancelResearchProject,
  queueResearchProject,
  retireResearchProject,
} from "../research-runtime";
import {
  createNamesTerm,
  deleteNamesTerm,
  expandQueryWithNamesTerms,
  listNamesTerms,
  updateNamesTerm,
} from "../names-terms";
import { loadEmailIngestConfig, saveEmailIngestConfig } from "../email-ingest";
import { READ_ONLY_REFUSAL, isReadOnlyError } from "../read-only";
import { isEnoent } from "../errors";
import { _resetLocks, _setDurableLocksForTests } from "../lock";
import { _resetStorage, getStorage } from "../storage";
import * as config from "../config";

const OWNER = "yuanhao";

let tmpDir: string;
let original: Record<string, string | undefined> = {};

const ENV_KEYS = [
  "DATA_DIR",
  "WIKI_DIR",
  "RAW_DIR",
  "NEXT_PUBLIC_OWNER_HANDLE",
  "YOPEDIA_READONLY",
  // `queueResearchProject` resolves the provider once past its DW-680 entry
  // gate, and `resolveResearchProvider` reads this env credential AHEAD of any
  // stored setting — so the one case that gets past that gate (the mid-request
  // flip, which has to reach the CAS) sets it for itself. Cleared by default
  // and restored after, which makes its ABSENCE load-bearing for the two cases
  // that refuse AT the gate: with no credential in the environment an ungated
  // queue would fail on the missing provider, so a refusal carrying
  // `researchMutate` is also evidence the gate ran ahead of provider
  // resolution.
  "TAVILY_API_KEY",
] as const;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-only-store-"));
  original = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.DATA_DIR = tmpDir;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.NEXT_PUBLIC_OWNER_HANDLE = OWNER;
  // The seeds below run through the same writers under test, so the world must
  // start WRITABLE — and be cleared rather than inherited, or a value exported
  // in one developer's shell would turn the writable control cases red.
  delete process.env.YOPEDIA_READONLY;
  // Same rule for the provider credential: the one case that needs it — the
  // mid-flip case that gets past `queueResearchProject`'s entry gate — sets it
  // for itself, so a key exported in a developer's shell cannot quietly change
  // which fault the other cases exercise.
  delete process.env.TAVILY_API_KEY;
  await fs.mkdir(process.env.WIKI_DIR, { recursive: true });
  await fs.mkdir(process.env.RAW_DIR, { recursive: true });
  _resetLocks();
  _resetStorage();
  // Off by default, as everywhere else: `withDurableLock` short-circuits past
  // the CAS lease on any non-R2 provider, and the one case that needs the lease
  // to actually be written turns it on for itself.
  _setDurableLocksForTests(false);
  await ensureDirectories();
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  _resetStorage();
  _setDurableLocksForTests(false);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/**
 * Every byte under the temp data dir, keyed by relative path.
 *
 * The whole tree rather than the one store file: `deleteResearchProject` takes
 * a DURABLE lock, which writes a lease object under `locks-v2/`, and a refusal
 * that stopped only the registry rewrite would still have mutated the
 * deployment.
 */
async function snapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      // ENOENT only — a directory that does not exist yet contributes nothing.
      // A bare `catch` here would turn ANY walk failure (EACCES, EMFILE, a
      // path bug) into an EMPTY map, and every `toEqual(before)` below would
      // then pass by comparing nothing to nothing. The seeded cases also assert
      // the snapshot is non-empty, so the two guards fail independently.
      if (isEnoent(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else out[rel] = await fs.readFile(full, "utf8");
    }
  }
  await walk(tmpDir, "");
  return out;
}

/**
 * A refusal is a `ReadOnlyError` whose sentence names read-only.
 *
 * `isReadOnlyError` matches on `name`, not `instanceof`, so this is also the
 * assertion that the classification routes rely on actually holds — a plain
 * `Error` with the right words would answer 500 at every catch.
 */
async function expectRefusal(
  op: () => Promise<unknown>,
  sentence: string,
): Promise<void> {
  const err = await op().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).not.toBeNull();
  expect(isReadOnlyError(err)).toBe(true);
  expect((err as Error).message).toBe(sentence);
  expect((err as Error).message).toContain("read-only");
}

/**
 * A snapshot of a SEEDED world, asserted non-empty.
 *
 * Pairs with {@link snapshot}'s narrowed catch: byte-identity is only evidence
 * when the walk actually saw bytes. Without this a `{}`-returning walk would
 * make every `toEqual(before)` below vacuously true.
 */
async function seededSnapshot(): Promise<Record<string, string>> {
  const before = await snapshot();
  expect(
    Object.keys(before).length,
    "the seed wrote nothing — byte-identity would prove nothing",
  ).toBeGreaterThan(0);
  return before;
}

/**
 * The research REGISTRY's one entry in a {@link snapshot}, asserted present.
 *
 * Matched by suffix rather than spelled out, because the path is composed from
 * the owner's tenant. Asserting it was found is what stops a renamed store file
 * from turning "the registry did not change" into a comparison of two
 * `undefined`s.
 */
function registryEntry(tree: Record<string, string>): [string, string] {
  const found = Object.entries(tree).filter(([key]) => key.endsWith("research-projects.json"));
  expect(found.length, "no research registry in the tree").toBe(1);
  return found[0];
}

const RESEARCH_INPUT = {
  title: "Competitor pricing",
  question: "How do the three closest competitors price their team tier?",
};

const TERM_INPUT = {
  kind: "organization" as const,
  canonical: "Acme Corp",
  aliases: ["Acme"],
};

const EMAIL_INPUT = {
  enabled: true,
  inboundAddress: "Notes@Example.com",
  allowedSenders: ["Owner@Example.com"],
};

describe("the research store refuses on a read-only deployment", () => {
  it("createResearchProject — no project, no registry file", async () => {
    const before = await snapshot();
    process.env.YOPEDIA_READONLY = "1";

    await expectRefusal(
      () => createResearchProject(OWNER, RESEARCH_INPUT),
      READ_ONLY_REFUSAL.researchCreate,
    );

    expect(await snapshot()).toEqual(before);
    // And the read path is untouched by the gate.
    expect(await listResearchProjects(OWNER)).toEqual([]);
  });

  it("deleteResearchProject — the project survives, and no lease was taken", async () => {
    // The lease has to be REAL for the claim to be: `withDurableLock`
    // short-circuits past the CAS lease on any provider that is not R2, so on
    // the filesystem provider no lease is written whatever the gate's position
    // and the snapshot below would be identical even with `assertWritable`
    // moved inside the fence. Forcing the R2 lease path is what makes the
    // ordering observable in bytes.
    _setDurableLocksForTests(true);
    const project = await createResearchProject(OWNER, RESEARCH_INPUT);
    const before = await seededSnapshot();
    process.env.YOPEDIA_READONLY = "1";

    await expectRefusal(
      () => deleteResearchProject(OWNER, project.id),
      READ_ONLY_REFUSAL.researchMutate,
    );

    // Byte-identical INCLUDING `locks-v2/`: the lifecycle fence is a
    // `withDurableLock`, so a gate one line lower would have written a lease
    // for a call it was about to refuse.
    expect(await snapshot()).toEqual(before);
    expect(await getResearchProject(OWNER, project.id)).not.toBeNull();
  });

  it("the durable lease is real, so the case above is not vacuous", async () => {
    // The control for the case above. If `_setDurableLocksForTests(true)` ever
    // stopped putting a lease on disk, "no lease was taken" would pass by
    // describing a world where none is ever taken.
    _setDurableLocksForTests(true);
    const project = await createResearchProject(OWNER, RESEARCH_INPUT);
    let sawLease = false;
    await withResearchProjectLifecycleFence(OWNER, project.id, async () => {
      sawLease = Object.keys(await snapshot()).some((rel) =>
        rel.startsWith("locks-v2/"),
      );
    });
    expect(sawLease, "the fence writes a lease under locks-v2/").toBe(true);
  });

  it("retireResearchProject — no tombstone, no 'Deleted.' label", async () => {
    // The DELETE route's actual entry point, and the one that WROTE before it
    // refused: it tombstones the row through the ungated CAS mutator
    // (`deleteRequested`, `cancelRequested`, `status: "cancelled"`, progress
    // "Deleted.") and only reaches the gated `deleteResearchProject` at its
    // last statement. Gating the delete alone left a caller with no route in
    // front holding a project marked deleted AND an error.
    const project = await createResearchProject(OWNER, RESEARCH_INPUT);
    const before = await seededSnapshot();
    process.env.YOPEDIA_READONLY = "1";

    await expectRefusal(
      () => retireResearchProject(OWNER, project.id),
      READ_ONLY_REFUSAL.researchMutate,
    );

    expect(await snapshot()).toEqual(before);
    const stored = await getResearchProject(OWNER, project.id);
    expect(stored?.deleteRequested).toBeUndefined();
    expect(stored?.cancelRequested).toBeUndefined();
    expect(stored?.status).toBe("draft");
    expect(stored?.progress?.message).not.toBe("Deleted.");
  });
});

describe("the Names & Terms store refuses on a read-only deployment", () => {
  it("createNamesTerm — no entry, no dictionary file", async () => {
    const before = await snapshot();
    process.env.YOPEDIA_READONLY = "1";

    await expectRefusal(
      () => createNamesTerm(OWNER, TERM_INPUT),
      READ_ONLY_REFUSAL.namesTerms,
    );

    expect(await snapshot()).toEqual(before);
    expect(await listNamesTerms(OWNER)).toEqual([]);
  });

  it("updateNamesTerm — the stored entry is unchanged", async () => {
    const entry = await createNamesTerm(OWNER, TERM_INPUT);
    const before = await seededSnapshot();
    process.env.YOPEDIA_READONLY = "1";

    await expectRefusal(
      () =>
        updateNamesTerm(OWNER, entry.id, {
          ...TERM_INPUT,
          canonical: "Acme Corporation",
        }),
      READ_ONLY_REFUSAL.namesTerms,
    );

    expect(await snapshot()).toEqual(before);
  });

  it("deleteNamesTerm — the entry survives", async () => {
    const entry = await createNamesTerm(OWNER, TERM_INPUT);
    const before = await seededSnapshot();
    process.env.YOPEDIA_READONLY = "1";

    await expectRefusal(
      () => deleteNamesTerm(OWNER, entry.id),
      READ_ONLY_REFUSAL.namesTerms,
    );

    expect(await snapshot()).toEqual(before);
    // The dictionary's READ side is what ingest and Ask run on, and it must be
    // untouched by the gate: a read-only deployment still answers questions.
    expect(await listNamesTerms(OWNER)).toHaveLength(1);
    expect(await expandQueryWithNamesTerms(OWNER, "what does Acme sell?"))
      .toContain("Acme Corp");
  });
});

describe("the email-ingest store refuses on a read-only deployment", () => {
  it("saveEmailIngestConfig — the FIRST-ever save, with nothing stored", async () => {
    // The sibling of "no project, no registry file". Without it, a gate that
    // refused only when a config already existed — one placed after the read,
    // say, or predicated on the stored value — would pass the overwrite case
    // below and still let a read-only deployment be configured from cold.
    const before = await snapshot();
    process.env.YOPEDIA_READONLY = "1";

    await expectRefusal(
      () => saveEmailIngestConfig(EMAIL_INPUT),
      READ_ONLY_REFUSAL.emailSettings,
    );

    expect(await snapshot()).toEqual(before);
    // Still the default, not a half-written record.
    const stored = await loadEmailIngestConfig();
    expect(stored.enabled).toBe(false);
    expect(stored.inboundAddress).toBe("");
    expect(stored.allowedSenders).toEqual([]);
    expect(stored.updatedAt).toBeNull();
  });

  it("saveEmailIngestConfig — an OVERWRITE leaves the stored config unchanged", async () => {
    await saveEmailIngestConfig(EMAIL_INPUT);
    const before = await seededSnapshot();
    process.env.YOPEDIA_READONLY = "1";

    await expectRefusal(
      () =>
        saveEmailIngestConfig({
          ...EMAIL_INPUT,
          enabled: false,
          allowedSenders: ["someone-else@example.com"],
        }),
      READ_ONLY_REFUSAL.emailSettings,
    );

    expect(await snapshot()).toEqual(before);
    // The read path never meets a gate, and still reports the old value.
    const stored = await loadEmailIngestConfig();
    expect(stored.enabled).toBe(true);
    expect(stored.allowedSenders).toEqual(["owner@example.com"]);
  });
});

/**
 * The writable controls: the gate refuses a read-only deployment and NOTHING
 * else. Without these, a gate that threw unconditionally — or one wired to the
 * wrong predicate — would pass every case above.
 */
describe("with the flag unset, the six writers work exactly as before", () => {
  it("the research store still creates and deletes", async () => {
    const project = await createResearchProject(OWNER, RESEARCH_INPUT);
    expect(project.title).toBe(RESEARCH_INPUT.title);
    expect(await listResearchProjects(OWNER)).toHaveLength(1);

    expect(await deleteResearchProject(OWNER, project.id)).toBe(true);
    expect(await listResearchProjects(OWNER)).toEqual([]);
  });

  it("retireResearchProject still retires a draft end to end", async () => {
    const project = await createResearchProject(OWNER, RESEARCH_INPUT);
    expect(await retireResearchProject(OWNER, project.id)).toBe(true);
    expect(await getResearchProject(OWNER, project.id)).toBeNull();
  });

  it("the Names & Terms store still creates, updates and deletes", async () => {
    const entry = await createNamesTerm(OWNER, TERM_INPUT);
    expect(entry.canonical).toBe("Acme Corp");

    const updated = await updateNamesTerm(OWNER, entry.id, {
      ...TERM_INPUT,
      canonical: "Acme Corporation",
    });
    expect(updated?.canonical).toBe("Acme Corporation");
    expect((await listNamesTerms(OWNER))[0]?.canonical).toBe("Acme Corporation");

    expect(await deleteNamesTerm(OWNER, entry.id)).toBe(true);
    expect(await listNamesTerms(OWNER)).toEqual([]);
  });

  it("the email-ingest store still saves", async () => {
    const saved = await saveEmailIngestConfig(EMAIL_INPUT);
    expect(saved.enabled).toBe(true);
    expect(saved.inboundAddress).toBe("notes@example.com");
    expect((await loadEmailIngestConfig()).allowedSenders).toEqual([
      "owner@example.com",
    ]);
  });
});

/**
 * The gate PRECEDES the lock, pinned by source order.
 *
 * The half of the claim the byte snapshots above cannot make. A gate moved
 * inside `withFileLock`'s callback would refuse just as loudly and leave a
 * byte-identical tree, while a refused call had queued behind every in-flight
 * write for the tenant. Source order rather than behaviour because the property
 * IS textual: nothing observable distinguishes "refused before the lock" from
 * "refused inside it" on a deployment where nothing else holds the key, and
 * contriving one would pin the scheduler rather than the gate.
 *
 * `saveEmailIngestConfig` takes no lock, so its ordering claim is against the
 * byte write itself.
 */
describe("the read-only gate precedes the store's lock", () => {
  it("assertWritable comes first in each newly gated writer", async () => {
    const sources: Record<string, string> = {
      "research-projects": await fs.readFile(
        path.resolve(__dirname, "../research-projects.ts"),
        "utf8",
      ),
      "names-terms": await fs.readFile(
        path.resolve(__dirname, "../names-terms.ts"),
        "utf8",
      ),
      "email-ingest": await fs.readFile(
        path.resolve(__dirname, "../email-ingest.ts"),
        "utf8",
      ),
      "research-runtime": await fs.readFile(
        path.resolve(__dirname, "../research-runtime.ts"),
        "utf8",
      ),
      "research-completion": await fs.readFile(
        path.resolve(__dirname, "../research-completion.ts"),
        "utf8",
      ),
    };

    for (const [module, fn, after] of [
      ["research-projects", "createResearchProject", "lockedMutation(owner"],
      // The one the ordering is load-bearing for beyond style:
      // `withResearchProjectLifecycleFence` is a `withDurableLock`, which takes
      // a CAS lease — a written object on the R2 provider — before the callback
      // runs.
      [
        "research-projects",
        "deleteResearchProject",
        "withResearchProjectLifecycleFence(owner",
      ],
      ["names-terms", "createNamesTerm", "withFileLock(lockKey(owner)"],
      ["names-terms", "updateNamesTerm", "withFileLock(lockKey(owner)"],
      ["names-terms", "deleteNamesTerm", "withFileLock(lockKey(owner)"],
      ["email-ingest", "saveEmailIngestConfig", "putIndex("],
      // Not a lock but a WRITE: `retireResearchProject` tombstones the row
      // through the deliberately ungated CAS mutator before it ever reaches the
      // gated delete, so the gate has to precede that call or the refusal
      // arrives after the damage.
      ["research-runtime", "retireResearchProject", "mutateResearchProjectOrRefusal(owner"],
      // Also a WRITE rather than a lock, and the one this table exists for
      // (DW-680): `queueResearchProject` releases the project's slot through
      // `releaseResearchSlotAndConfirmGone` — into `research-concurrency.ts`,
      // which carries no gate of its own — as its LAST statement before the
      // CAS. A gate that drifted below that line would leave the byte case
      // above passing only by accident of ordering.
      ["research-runtime", "queueResearchProject", "releaseResearchSlotAndConfirmGone(owner"],
      // DW-681, and the reason the probe below stopped requiring `export`:
      // `drainOrphanOutbox` is PRIVATE. Its unclaimed branch deletes the outbox
      // JSON and every staged body beside it, so the gate has to precede that
      // call — and `deleteResearchOutbox` itself stays ungated, because ~20
      // in-flight and fail-soft call sites reach it.
      ["research-completion", "drainOrphanOutbox", "deleteResearchOutbox(owner, id)"],
    ] as const) {
      const source = sources[module];
      // `export` is OPTIONAL: a gate that has to precede a write is the same
      // claim whether the function is exported or private, and a probe that
      // could not see a private one would silently skip it. ANCHORED at column
      // zero — the same reasoning as the `}` bound below — so a mention of the
      // name inside a comment or a string cannot be mistaken for the
      // declaration and hand the assertions some other function's body.
      const start = source.search(
        new RegExp(`^(?:export )?async function ${fn}\\(`, "m"),
      );
      expect(start, `${module}.ts: ${fn}`).toBeGreaterThan(-1);
      // The function's OWN body: bounded by the `}` in column 0 that closes it,
      // so the next declaration's text is never attributed to this one.
      const close = source.indexOf("\n}\n", start);
      expect(close, `${module}.ts: ${fn} close`).toBeGreaterThan(start);
      const body = source.slice(start, close);

      const gate = body.search(/assertWritable\(READ_ONLY_REFUSAL\.\w+\)/);
      const guarded = body.indexOf(after);
      expect(gate, `${fn} calls assertWritable`).toBeGreaterThan(-1);
      expect(guarded, `${fn} reaches ${after}`).toBeGreaterThan(-1);
      expect(gate, `${fn} gates BEFORE ${after}`).toBeLessThan(guarded);
    }
  });

  it("the research CAS wrappers refuse WITHOUT throwing (DW-527)", async () => {
    // The inversion of what this case used to pin. Until DW-527 the primitive
    // WROTE here, and a direct library caller could patch a project's fields on
    // a read-only deployment. It now refuses — but as a VALUE, because several
    // callers read `null` as "lost the CAS race" and compensate, so a throw
    // would turn fail-soft recovery into a stranded run.
    //
    // The source-text case below cannot make this claim: it only sees that the
    // four bodies carry no `assertWritable(`, which stays true of a refusal
    // that writes anyway and of one that does not.
    const project = await createResearchProject(OWNER, RESEARCH_INPUT);
    const before = await seededSnapshot();
    process.env.YOPEDIA_READONLY = "1";

    const progressed = await updateResearchProjectIf(
      OWNER,
      project.id,
      (current) => current.id === project.id,
      { status: "collecting", synthesis: "an in-flight run's own progress" },
    );

    // `null`, not a throw: the fail-soft contract the ~30 runtime call sites
    // depend on.
    expect(progressed).toBeNull();
    // BYTES, not just the return: a refusal placed after the write, or one
    // that let a lock lease land, would satisfy the line above and still have
    // mutated the deployment.
    expect(await snapshot()).toEqual(before);
    const stored = await getResearchProject(OWNER, project.id);
    expect(stored?.status).toBe("draft");
    expect(stored?.synthesis).toBeUndefined();
  });

  it("the primitive itself returns a sentinel a caller can tell from a lost race", async () => {
    const project = await createResearchProject(OWNER, RESEARCH_INPUT);
    const before = await seededSnapshot();
    process.env.YOPEDIA_READONLY = "1";
    let ran = false;

    const result = await applyResearchProjectMutation(OWNER, (projects) => {
      ran = true;
      return { projects: projects.filter((row) => row.id !== project.id), result: "wrote" };
    });

    expect(isResearchWriteRefused(result)).toBe(true);
    expect(result).toBe(RESEARCH_WRITE_REFUSED);
    // `mutate` never ran, so nothing was even computed against the registry.
    expect(ran).toBe(false);
    expect(await snapshot()).toEqual(before);
    // And the refusal is not confusable with a caller's own look-alike value.
    expect(isResearchWriteRefused({ researchWrite: "read-only" })).toBe(false);
    expect(isResearchWriteRefused(null)).toBe(false);
  });

  it("editResearchProject — the owner's edit THROWS, and no byte moves", async () => {
    // The other half of the pair. `PATCH /api/research/[id]` goes through this
    // entry point, where the quiet `null` above would be reported as 409
    // "A running or finished research project cannot be edited." — the wrong
    // reason for a refusal that is really about the deployment.
    const project = await createResearchProject(OWNER, RESEARCH_INPUT);
    const before = await seededSnapshot();
    process.env.YOPEDIA_READONLY = "1";

    await expectRefusal(
      () => editResearchProject(
        OWNER,
        project.id,
        (current) => current.id === project.id,
        { title: "Renamed while read-only" },
      ),
      READ_ONLY_REFUSAL.researchMutate,
    );

    expect(await snapshot()).toEqual(before);
    expect((await getResearchProject(OWNER, project.id))?.title)
      .toBe(RESEARCH_INPUT.title);
  });

  it("create and delete THROW when the flag flips after their own gate", async () => {
    // The third shape of the refusal (DW-527). `isReadOnly()` is read TWICE on
    // these paths — once by the entry point's own `assertWritable`, once by the
    // CAS primitive — so writable at the first read and read-only at the second
    // is the mid-request flip, the only moment the sentinel can reach an entry
    // point whose contract is to throw. A silent `false` from the delete would
    // read as "no such project" and a fake row from the create would report a
    // write that never happened.
    const seeded = await createResearchProject(OWNER, RESEARCH_INPUT);
    const before = await seededSnapshot();
    let reads = 0;
    const flag = vi.spyOn(config, "isReadOnly").mockImplementation(() => reads++ > 0);

    try {
      await expectRefusal(
        () => deleteResearchProject(OWNER, seeded.id),
        READ_ONLY_REFUSAL.researchMutate,
      );
      reads = 0;
      // `researchCreate`, NOT the delete's `researchMutate` (DW-659). The
      // caller cannot tell which read of the flag lost, so both refusals out of
      // the create door have to carry the sentence its own gate serves — a
      // project that was never stored must not be reported as one that "cannot
      // be changed".
      await expectRefusal(
        () => createResearchProject(OWNER, { ...RESEARCH_INPUT, title: "Second" }),
        READ_ONLY_REFUSAL.researchCreate,
      );
      // Both halves are pinned, which is the point: a future "these two are
      // nearly the same, unify them" edit re-merges the doors and passes every
      // assertion above unless the strings are asserted DISTINCT here.
      expect(READ_ONLY_REFUSAL.researchCreate).not.toBe(READ_ONLY_REFUSAL.researchMutate);
      // The owner's edit is the third: its CAS returns `null` here, which the
      // route would serve as 409 "cannot be edited" — the wrong reason. It
      // re-reads the flag on that null path so the window stays a refusal.
      reads = 0;
      await expectRefusal(
        () => editResearchProject(
          OWNER,
          seeded.id,
          (current) => current.id === seeded.id,
          { title: "Renamed mid-flip" },
        ),
        READ_ONLY_REFUSAL.researchMutate,
      );
    } finally {
      flag.mockRestore();
    }

    // Neither reported a fake outcome, and neither moved a byte.
    expect(await snapshot()).toEqual(before);
    expect(await getResearchProject(OWNER, seeded.id)).not.toBeNull();
    expect(await listResearchProjects(OWNER)).toHaveLength(1);
  });

  it("both paths still write on a WRITABLE deployment", async () => {
    // The control every refusal case above needs: a gate that refused
    // unconditionally would satisfy all of them and break the product.
    const project = await createResearchProject(OWNER, RESEARCH_INPUT);

    const edited = await editResearchProject(
      OWNER,
      project.id,
      (current) => current.id === project.id,
      { title: "Renamed by the owner" },
    );
    const progressed = await updateResearchProjectIf(
      OWNER,
      project.id,
      (current) => current.id === project.id,
      { status: "collecting", synthesis: "an in-flight run's own progress" },
    );

    expect(edited?.title).toBe("Renamed by the owner");
    expect(progressed?.status).toBe("collecting");
    const stored = await getResearchProject(OWNER, project.id);
    expect(stored?.title).toBe("Renamed by the owner");
    expect(stored?.status).toBe("collecting");
    expect(stored?.synthesis).toBe("an in-flight run's own progress");
  });

  it("the *OrRefusal siblings hand back the sentinel their fail-soft pair collapses", async () => {
    // DW-661. Until now the refusal was distinguishable ONLY at
    // `applyResearchProjectMutation`: every wrapper above it folded
    // `RESEARCH_WRITE_REFUSED` into the same `null` that means "gone, or the
    // predicate said no", so no runtime caller could tell a read-only
    // deployment from a lost CAS race. The siblings carry it through; the
    // originals still collapse it, which is what keeps the ~30 fail-soft call
    // sites in `research-runtime`/`research-completion` unedited.
    const project = await createResearchProject(OWNER, RESEARCH_INPUT);
    const before = await seededSnapshot();
    process.env.YOPEDIA_READONLY = "1";

    const mutated = await mutateResearchProjectOrRefusal(OWNER, project.id, (current) => {
      current.status = "collecting";
      return current;
    });
    const patched = await updateResearchProjectIfOrRefusal(
      OWNER,
      project.id,
      (current) => current.id === project.id,
      { status: "collecting", synthesis: "an in-flight run's own progress" },
    );

    // IDENTITY, not shape: `isResearchWriteRefused` compares against the one
    // frozen instance, so a caller's look-alike object cannot pass for it.
    expect(mutated).toBe(RESEARCH_WRITE_REFUSED);
    expect(patched).toBe(RESEARCH_WRITE_REFUSED);
    expect(isResearchWriteRefused(mutated)).toBe(true);
    expect(isResearchWriteRefused(patched)).toBe(true);

    // The collapsing originals, same arguments, same deployment: still `null`,
    // still no throw. The control that proves the split changed nothing for
    // the fail-soft half.
    await expect(
      mutateResearchProject(OWNER, project.id, (current) => {
        current.status = "collecting";
        return current;
      }),
    ).resolves.toBeNull();
    await expect(
      updateResearchProjectIf(
        OWNER,
        project.id,
        (current) => current.id === project.id,
        { status: "collecting" },
      ),
    ).resolves.toBeNull();

    // And none of the four touched a byte.
    expect(await snapshot()).toEqual(before);
    expect((await getResearchProject(OWNER, project.id))?.status).toBe("draft");
  });

  it("the *OrRefusal siblings answer a WRITABLE deployment exactly as their pair does", async () => {
    // The control the refusal case above needs. Pinned only on the refusal
    // branch, a sibling that returned the sentinel for a missing row or a
    // false predicate would pass — and every caller that converts it would
    // then report a read-only deployment for a project that simply is not
    // there. All three non-refusal outcomes, on a writable deployment:
    const project = await createResearchProject(OWNER, RESEARCH_INPUT);

    // 1. A hit returns the project, and the write actually lands.
    const hit = await mutateResearchProjectOrRefusal(OWNER, project.id, (current) => {
      current.status = "collecting";
      return current;
    });
    expect(isResearchWriteRefused(hit)).toBe(false);
    expect((hit as typeof project).status).toBe("collecting");
    expect((await getResearchProject(OWNER, project.id))?.status).toBe("collecting");

    // 2. An id that is not there is `null` — "gone", never "refused".
    const missing = await mutateResearchProjectOrRefusal(OWNER, "no-such-project", (current) => current);
    expect(isResearchWriteRefused(missing)).toBe(false);
    expect(missing).toBeNull();

    // 3. A predicate that says no is `null` too, and writes nothing.
    const rejected = await updateResearchProjectIfOrRefusal(
      OWNER,
      project.id,
      () => false,
      { synthesis: "never written" },
    );
    expect(isResearchWriteRefused(rejected)).toBe(false);
    expect(rejected).toBeNull();
    expect((await getResearchProject(OWNER, project.id))?.synthesis).toBeUndefined();

    // 4. And a predicate that says yes still patches, so 3 is not vacuous.
    const patched = await updateResearchProjectIfOrRefusal(
      OWNER,
      project.id,
      (current) => current.id === project.id,
      { synthesis: "written by the owner" },
    );
    expect(isResearchWriteRefused(patched)).toBe(false);
    expect((patched as typeof project).synthesis).toBe("written by the owner");
  });

  it("retireResearchProject THROWS when the flag flips after its own gate", async () => {
    // DW-657. `retireResearchProject` gates first, then TOMBSTONES through the
    // CAS. A flip in between used to collapse to `null`, leave by
    // `if (!retired) return false`, and reach the owner as
    // `DELETE /api/research/[id]` 404 "Research project not found." — the row
    // reported as gone when nothing had been written to it at all.
    const seeded = await createResearchProject(OWNER, RESEARCH_INPUT);
    const before = await seededSnapshot();
    let reads = 0;
    const flag = vi.spyOn(config, "isReadOnly").mockImplementation(() => reads++ > 0);

    try {
      await expectRefusal(
        () => retireResearchProject(OWNER, seeded.id),
        READ_ONLY_REFUSAL.researchMutate,
      );
    } finally {
      flag.mockRestore();
    }

    expect(await snapshot()).toEqual(before);
    const stored = await getResearchProject(OWNER, seeded.id);
    // No tombstone: the four fields the mutator would have written, and the
    // "Deleted." label the panel renders from, are all still absent.
    expect(stored?.deleteRequested).toBeUndefined();
    expect(stored?.cancelRequested).toBeUndefined();
    expect(stored?.status).toBe("draft");
    expect(stored?.progress).toBeUndefined();
  });

  it("cancelResearchProject refuses with the deployment's own sentence", async () => {
    // DW-657. The CAS is this function's FIRST statement, so a read-only
    // deployment refuses before anything is read. Collapsed, that refusal left
    // as `ResearchProjectNotFoundError` → `POST .../run` 404.
    const project = await createResearchProject(OWNER, RESEARCH_INPUT);
    const before = await seededSnapshot();
    process.env.YOPEDIA_READONLY = "1";

    await expectRefusal(
      () => cancelResearchProject(OWNER, project.id),
      READ_ONLY_REFUSAL.researchMutate,
    );

    expect(await snapshot()).toEqual(before);
    expect((await getResearchProject(OWNER, project.id))?.cancelRequested).toBeUndefined();
  });

  it("queueResearchProject refuses with the deployment's own sentence", async () => {
    // DW-657, the other half of the run door — and since DW-680 a WHOLE-TREE
    // claim, like every other refusal in this suite.
    //
    // WHAT USED TO BE EXCLUDED HERE, and why it no longer is.
    // `queueResearchProject` retires the project's previous slot through
    // `releaseResearchSlotAndConfirmGone` BEFORE it reaches the CAS, and
    // `research-concurrency.ts` carries no read-only gate at all — so a refused
    // Run really did empty the project's lease out of `research-leases.json`
    // while the row went on recording that `runAttemptId`. The lease file was
    // excluded from the comparison rather than pinned. DW-680 put an
    // `assertWritable` at the ENTRY POINT, above that release and above the
    // done-phase `deleteResearchOutbox`, so the lease is now compared like every
    // other byte in the tree.
    //
    // The project holds a REAL lease when the flag flips, which is what keeps
    // the claim non-vacuous: with an empty lease file there would be nothing
    // for the release to change and byte-identity would prove nothing about the
    // pre-CAS writes.
    //
    // And NO `TAVILY_API_KEY`: the gate precedes `resolveResearchProvider`, so
    // with no credential in the environment an ungated queue would fail on the
    // missing provider instead. A refusal carrying `researchMutate` is
    // therefore also evidence the gate runs first.
    const project = await createResearchProject(OWNER, RESEARCH_INPUT);
    const grant = await acquireResearchSlot(OWNER, project.id);
    expect(grant.attemptId, "the seed took no slot").toBeTruthy();
    await updateResearchProject(OWNER, project.id, { runAttemptId: grant.attemptId });
    const before = await seededSnapshot();
    expect(
      Object.keys(before).some((key) => key.endsWith("research-leases.json")),
      "the seed left no lease file — the whole-tree claim would prove nothing",
    ).toBe(true);
    process.env.YOPEDIA_READONLY = "1";

    await expectRefusal(
      () => queueResearchProject(OWNER, project.id),
      READ_ONLY_REFUSAL.researchMutate,
    );

    const after = await snapshot();
    // The registry byte for byte, called out separately because it is the row
    // the CAS would have rewritten.
    expect(registryEntry(after)).toEqual(registryEntry(before));
    // And the whole tree, LEASE FILE INCLUDED — the half this case could not
    // claim before DW-680.
    expect(after).toEqual(before);
    // Read back through the store as well as off the bytes: not queued, not
    // handed a provider it never got to search with, and still carrying the
    // attempt token the seed gave it.
    const stored = await getResearchProject(OWNER, project.id);
    expect(stored?.status).toBe("draft");
    expect(stored?.provider).toBeUndefined();
    expect(stored?.runAttemptId).toBe(grant.attemptId);
  });

  it("queueResearchProject refuses the DELIVERY-RETRY branch with that sentence too", async () => {
    // DW-651/DW-657 together. `queueResearchProject` has a SECOND write, taken
    // when the owner presses Run on a project whose delivery is blocked: it
    // flips the row back to `complete` with a fresh delivery fence and returns
    // without ever reaching the branch the case above covers.
    //
    // That write used to go through the sentinel-COLLAPSING
    // `updateResearchProjectIf`, so a read-only deployment arrived as `null` —
    // indistinguishable from a lost predicate, and since DW-651 that `null` is
    // a `ResearchProjectBusyError` → 503. The owner would be told to retry in a
    // moment a write this deployment will never accept, and the route's 403
    // would never be reached at all. It takes the refusal-preserving sibling
    // now, so contention and a refusal stay two different answers.
    //
    // WHOLE-TREE byte-identity, as in the case above — but reached differently:
    // that one is stopped at the entry gate before any write, while this branch
    // would not have touched a lease even without one, since it returns before
    // `releaseResearchSlotAndConfirmGone` is ever reached.
    const project = await createResearchProject(OWNER, RESEARCH_INPUT);
    await updateResearchProject(OWNER, project.id, {
      status: "failed",
      deliveryBlocked: true,
      completion: { phase: "page", pageSlug: "research-competitor-pricing", sources: [] },
    });
    const before = await seededSnapshot();
    process.env.YOPEDIA_READONLY = "1";

    await expectRefusal(
      () => queueResearchProject(OWNER, project.id),
      READ_ONLY_REFUSAL.researchMutate,
    );

    expect(await snapshot()).toEqual(before);
    // The retry generation was NOT opened: still blocked, still no new fence.
    const stored = await getResearchProject(OWNER, project.id);
    expect(stored?.deliveryBlocked).toBe(true);
    expect(stored?.status).toBe("failed");
    expect(stored?.deliveryAttemptId).toBeUndefined();
  });

  it("queueResearchProject THROWS on the DELIVERY-RETRY branch when the flag flips after its own gate", async () => {
    // The coverage DW-680's entry gate would otherwise have taken away. With
    // the gate in front, both read-only cases above stop at the door, so the
    // two `isResearchWriteRefused(...)` -> `ReadOnlyError` conversions inside
    // `queueResearchProject` (DW-657, DW-651) are reachable ONLY on a
    // mid-request flip — and with nothing exercising that window, deleting both
    // conversions would leave every other case in this suite green.
    //
    // `isReadOnly()` is read TWICE on this path: once by the entry
    // `assertWritable`, once by the CAS primitive. Writable at the first read
    // and read-only at the second IS the window, the same idiom the create,
    // delete and retire cases above use.
    const project = await createResearchProject(OWNER, RESEARCH_INPUT);
    await updateResearchProject(OWNER, project.id, {
      status: "failed",
      deliveryBlocked: true,
      completion: { phase: "page", pageSlug: "research-competitor-pricing", sources: [] },
    });
    const before = await seededSnapshot();
    let reads = 0;
    const flag = vi.spyOn(config, "isReadOnly").mockImplementation(() => reads++ > 0);

    try {
      await expectRefusal(
        () => queueResearchProject(OWNER, project.id),
        READ_ONLY_REFUSAL.researchMutate,
      );
    } finally {
      flag.mockRestore();
    }

    // WHOLE-TREE byte-identity IS assertable on this branch: it reaches its CAS
    // without writing anything first, so a refusal converted at the sentinel
    // leaves the deployment exactly as it was.
    expect(await snapshot()).toEqual(before);
    // And not the COLLAPSED answer: a `null` here is `ResearchProjectBusyError`
    // -> 503, telling the owner to come back in a moment for a write this
    // deployment will never accept.
    const stored = await getResearchProject(OWNER, project.id);
    expect(stored?.deliveryBlocked).toBe(true);
    expect(stored?.status).toBe("failed");
    expect(stored?.deliveryAttemptId).toBeUndefined();
  });

  it("queueResearchProject THROWS on the MAIN CAS when the flag flips after its own gate", async () => {
    // The second of the two conversions, and the second half of the coverage
    // the entry gate would otherwise have removed. Collapsed, this refusal left
    // as `ResearchProjectNotFoundError` -> `POST .../run` 404: the row reported
    // as gone when nothing had been written to it at all (DW-657).
    //
    // The credential is set HERE and nowhere else in the suite. Once the entry
    // gate passes, `resolveResearchProvider` runs for real, and with no key it
    // would throw `ResearchProviderUnconfiguredError` long before the CAS —
    // which is exactly what makes its absence evidence in the two gate cases.
    process.env.TAVILY_API_KEY = "test-key";
    const project = await createResearchProject(OWNER, RESEARCH_INPUT);
    const grant = await acquireResearchSlot(OWNER, project.id);
    expect(grant.attemptId, "the seed took no slot").toBeTruthy();
    await updateResearchProject(OWNER, project.id, { runAttemptId: grant.attemptId });
    const before = await seededSnapshot();
    let reads = 0;
    const flag = vi.spyOn(config, "isReadOnly").mockImplementation(() => reads++ > 0);

    try {
      await expectRefusal(
        () => queueResearchProject(OWNER, project.id),
        READ_ONLY_REFUSAL.researchMutate,
      );
    } finally {
      flag.mockRestore();
    }

    // NO whole-tree comparison here, and deliberately — this is the ONE case in
    // the suite that cannot make that claim. The flip lets the entry gate pass,
    // so the ungated pre-CAS writes really do run:
    // `releaseResearchSlotAndConfirmGone` empties this project's slot out of
    // `research-leases.json` through `research-concurrency.ts`, which carries
    // no gate of its own. That is the cost of the flip window, not of the gate,
    // and asserting an unchanged tree would be a false claim rather than a
    // stronger one. What IS pinned is that the refusal keeps its class and its
    // sentence, and that the row itself never moved.
    expect(registryEntry(await snapshot())).toEqual(registryEntry(before));
    const stored = await getResearchProject(OWNER, project.id);
    expect(stored?.status).toBe("draft");
    expect(stored?.provider).toBeUndefined();
  });

  it("drainResearchOutbox refuses to DROP an unclaimed orphan outbox", async () => {
    // DW-681, which names THIS path: an outbox whose project row is gone and
    // which never won the Page-write claim reaches `drainOrphanOutbox`, and its
    // unclaimed branch calls `deleteResearchOutbox` — a `clearResearchStaging`
    // plus a raw `deleteFile`, so the outbox JSON and the staged bodies beside
    // it both go. Nothing on a deployment that refuses writes can produce them
    // again, so the drop has to be refused rather than run fail-soft.
    //
    // NOT the last such path, and this case does not claim to be: several
    // other `deleteResearchOutbox` call sites still delete on a read-only
    // deployment — `drainResearchOutbox`'s own done-phase and `deleteRequested`
    // branches, `commitResearchPage`'s retire/cancel branches, and
    // `reconcileResearchProjects`' done-phase branch with its ungated lease
    // release. Each is reached with a project row in hand, which is a different
    // shape from an orphan and a different decision; DW-681 closed the one
    // where the row is already gone and the outbox is all that is left.
    //
    // The gate lives at `drainOrphanOutbox`, not at `deleteResearchOutbox`,
    // which ~20 in-flight and fail-soft call sites reach — hence the
    // source-order pin below rather than a "no assertWritable" pin.
    const orphanId = "orphan-outbox-project";
    const stagingPath =
      `tenants/${tenantForOwner(OWNER)}/research-outbox`
      + `/staging-${orphanId}-example-com-abc123.md`;
    await getStorage().writeFile(stagingPath, "# Staged body\n");
    await saveResearchOutbox(OWNER, orphanId, {
      pageSlug: "research-orphan",
      title: "Orphan",
      synthesis: "Synthesis the deployment can no longer reproduce.",
      thinking: [],
      // No `claimed`, which is what makes this the UNCLAIMED branch.
      sources: [{
        url: "https://example.com/a",
        title: "A",
        slug: "example-com",
        sha: "abc123",
        sourcePath: stagingPath,
        length: 14,
      }],
      evidence: [{ url: "https://example.com/a", title: "A" }],
    });
    // ORPHAN means exactly this: an outbox with no registry row behind it, so
    // `drainResearchOutbox` takes the orphan path rather than the normal drain.
    expect(
      await getResearchProject(OWNER, orphanId),
      "the seed left a project row, so this is not an orphan",
    ).toBeNull();
    const before = await seededSnapshot();
    expect(
      before[stagingPath],
      "the seed wrote no staging body — the deletion would have nothing to destroy",
    ).toBeTruthy();
    process.env.YOPEDIA_READONLY = "1";

    await expectRefusal(
      () => drainResearchOutbox(OWNER, orphanId),
      READ_ONLY_REFUSAL.researchMutate,
    );

    // Whole tree: the outbox JSON, the staging body, and everything else.
    expect(await snapshot()).toEqual(before);
    // And read back through the loader, not just off the bytes: what survived
    // is still a loadable outbox, drainable once the deployment is writable.
    const survived = await loadResearchOutbox(OWNER, orphanId);
    expect(survived?.synthesis).toBe("Synthesis the deployment can no longer reproduce.");
    expect(survived?.sources.map((source) => source.sourcePath)).toEqual([stagingPath]);
  });

  it("a CLAIMED orphan outbox refuses at the PAGE writer, with that door's sentence", async () => {
    // The sibling of the case above, and the reason DW-681's gate covers only
    // the unclaimed branch. A CLAIMED outbox already won the Page-write claim,
    // so the drain goes on to `writeResearchPage` ->
    // `writeWikiPageWithSideEffects`, gated since DW-188 — and it answers
    // `pageWrite`, a DIFFERENT sentence from the unclaimed branch's
    // `researchMutate`, because they are two different doors: one is a page
    // write refused, the other the deletion of a research outbox refused.
    //
    // The tree is byte-identical anyway, which is the claim
    // `drainOrphanOutbox`'s comment makes and which nothing pinned until now:
    // `claimOrphanWrite` writes a `<outbox>.writing` claim file BEFORE the page
    // write, and the `finally` removes it in the same call, so a refusal in
    // between leaves nothing behind.
    const orphanId = "claimed-orphan-project";
    const stagingPath =
      `tenants/${tenantForOwner(OWNER)}/research-outbox`
      + `/staging-${orphanId}-example-com-def456.md`;
    await getStorage().writeFile(stagingPath, "# Staged body\n");
    await saveResearchOutbox(OWNER, orphanId, {
      pageSlug: "research-claimed-orphan",
      title: "Claimed orphan",
      synthesis: "Synthesis whose Page write never landed.",
      thinking: [],
      claimed: true,
      sources: [{
        url: "https://example.com/b",
        title: "B",
        slug: "example-com",
        sha: "def456",
        sourcePath: stagingPath,
        length: 14,
      }],
      evidence: [{ url: "https://example.com/b", title: "B" }],
    });
    expect(
      await getResearchProject(OWNER, orphanId),
      "the seed left a project row, so this is not an orphan",
    ).toBeNull();
    const before = await seededSnapshot();
    process.env.YOPEDIA_READONLY = "1";

    await expectRefusal(
      () => drainResearchOutbox(OWNER, orphanId),
      READ_ONLY_REFUSAL.pageWrite,
    );

    // Asserted DISTINCT, or a later "these two refusals are nearly the same,
    // unify them" edit would collapse the two doors and still pass everything
    // above.
    expect(READ_ONLY_REFUSAL.pageWrite).not.toBe(READ_ONLY_REFUSAL.researchMutate);
    // No `.writing` claim file left behind, and nothing else moved either.
    expect(await snapshot()).toEqual(before);
    const survived = await loadResearchOutbox(OWNER, orphanId);
    expect(survived?.claimed).toBe(true);
    expect(survived?.synthesis).toBe("Synthesis whose Page write never landed.");
  });

  it("the research CAS primitives carry no THROWING gate in their own source", async () => {
    // Still meaningful after DW-527, with a NEW rationale: these four must
    // refuse by RETURNING the sentinel, never by throwing, because a throw
    // here strands an in-flight run. `assertWritable(` in one of these bodies
    // is exactly that regression, so its absence is the thing pinned — the
    // gated owner door lives in `editResearchProject`, deliberately outside
    // this list.
    const source = await fs.readFile(
      path.resolve(__dirname, "../research-projects.ts"),
      "utf8",
    );
    for (const fn of [
      "applyResearchProjectMutation",
      "mutateResearchProject",
      // The refusal-preserving siblings (DW-661). They are the ones a THROWING
      // entry point now calls, which makes an `assertWritable(` slipping into
      // one of them the same in-flight-run hazard: the throw would land inside
      // the CAS layer, where the fail-soft callers reach it too.
      "mutateResearchProjectOrRefusal",
      "updateResearchProjectIfOrRefusal",
      // PRIVATE, and so invisible to this pin until the pattern below stopped
      // requiring `export` (DW-661). `mutateProjectOrRefusal` is where the
      // whole patch body moved, and `mutateProject` is the line that collapses
      // its refusal — both reach the CAS, and neither is any safer to gate
      // than the exported four.
      "mutateProjectOrRefusal",
      "mutateProject",
      "updateResearchProjectIf",
      "updateResearchProject",
    ]) {
      // `<T>` on the generic CAS helpers, `(` on the rest — matched together
      // so `updateResearchProject` cannot land on `updateResearchProjectIf`,
      // and `mutateProject` cannot land on `mutateProjectOrRefusal`. `export`
      // is OPTIONAL: a hazard that moved into a private helper is the same
      // hazard, and a pin that could not see it would report the move as a
      // clean bill of health.
      const start = source.search(
        new RegExp(`(?:export )?async function ${fn}[(<]`),
      );
      expect(start, `research-projects.ts: ${fn}`).toBeGreaterThan(-1);
      const close = source.indexOf("\n}\n", start);
      // Without this, a failed bound gives `slice(start, -1)` — the rest of the
      // FILE minus one char — and the assertion below would read every later
      // function's gate as this one's.
      expect(close, `research-projects.ts: ${fn} close`).toBeGreaterThan(start);
      const body = source.slice(start, close);
      expect(body, `${fn} is deliberately ungated`).not.toMatch(
        /assertWritable\(/,
      );
    }
  });
});
