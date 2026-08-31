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

import { ensureDirectories } from "../wiki";
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
import { _resetStorage } from "../storage";
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
  // `queueResearchProject` resolves the provider BEFORE its CAS, and
  // `resolveResearchProvider` reads this env credential AHEAD of any stored
  // setting — so the refusal case below has to make one available or the run
  // fails on the missing credential instead of on the flag.
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
  // Same rule for the provider credential: the one case that needs it sets it
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

/**
 * A {@link snapshot} with the research LEASE file removed.
 *
 * For the one path whose pre-CAS behaviour is outside this suite's claim — see
 * the `queueResearchProject` case, which explains why.
 */
function withoutLeases(tree: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tree).filter(([key]) => !key.endsWith("research-leases.json")),
  );
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
    ] as const) {
      const source = sources[module];
      const start = source.indexOf(`export async function ${fn}(`);
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
    // DW-657, the other half of the run door.
    //
    // WHAT THIS CASE DOES NOT CLAIM. Unlike every other refusal here it cannot
    // assert whole-tree byte-identity, and pretending otherwise would be
    // worse than not asserting it: `queueResearchProject` retires the
    // project's previous slot through `releaseResearchSlotAndConfirmGone`
    // BEFORE it reaches the CAS, and `research-concurrency.ts` carries no
    // read-only gate at all — so on a read-only deployment a project that
    // holds a lease really does have it released, and `research-leases.json`
    // really does change, before the registry write is refused. That ungated
    // pre-CAS release is pre-existing behaviour outside this change's scope
    // (this change moves the CAS onto the refusal-preserving sibling and
    // nothing else), so the lease file is EXCLUDED from the comparison rather
    // than seeded into looking unchanged, and its mutation is not pinned here
    // as expected behaviour either way.
    //
    // The project therefore holds a REAL lease when the flag flips, which is
    // the state that makes the exclusion honest — with an empty lease file
    // there would be nothing for the release to change and the exclusion would
    // be hiding nothing.
    process.env.TAVILY_API_KEY = "test-key";
    const project = await createResearchProject(OWNER, RESEARCH_INPUT);
    const grant = await acquireResearchSlot(OWNER, project.id);
    expect(grant.attemptId, "the seed took no slot").toBeTruthy();
    await updateResearchProject(OWNER, project.id, { runAttemptId: grant.attemptId });
    const before = await seededSnapshot();
    process.env.YOPEDIA_READONLY = "1";

    await expectRefusal(
      () => queueResearchProject(OWNER, project.id),
      READ_ONLY_REFUSAL.researchMutate,
    );

    const after = await snapshot();
    // WHAT THIS CHANGE OWNS: the registry, byte for byte. The CAS refused, so
    // not one field of the stored row moved.
    expect(registryEntry(after)).toEqual(registryEntry(before));
    // And nothing else in the tree moved either — the lease aside.
    expect(withoutLeases(after)).toEqual(withoutLeases(before));
    // Read back through the store as well as off the bytes: not queued, not
    // handed a provider it never got to search with, and still carrying the
    // attempt token the seed gave it.
    const stored = await getResearchProject(OWNER, project.id);
    expect(stored?.status).toBe("draft");
    expect(stored?.provider).toBeUndefined();
    expect(stored?.runAttemptId).toBe(grant.attemptId);
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
