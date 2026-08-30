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
  RESEARCH_WRITE_REFUSED,
  updateResearchProjectIf,
  withResearchProjectLifecycleFence,
} from "../research-projects";
import { retireResearchProject } from "../research-runtime";
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
      ["research-runtime", "retireResearchProject", "mutateResearchProject(owner"],
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
      await expectRefusal(
        () => createResearchProject(OWNER, { ...RESEARCH_INPUT, title: "Second" }),
        READ_ONLY_REFUSAL.researchMutate,
      );
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
      "updateResearchProjectIf",
      "updateResearchProject",
    ]) {
      // `<T>` on the generic CAS helpers, `(` on the rest — matched together
      // so `updateResearchProject` cannot land on `updateResearchProjectIf`.
      const start = source.search(
        new RegExp(`export async function ${fn}[(<]`),
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
