/**
 * DW-411: the repo's `pnpm-workspace.yaml` files are load-bearing.
 *
 * pnpm searches UPWARD for a workspace root. With no `pnpm-workspace.yaml` in
 * the checkout it adopts the first one it finds above — on the maintainer's
 * machine `~/pnpm-workspace.yaml`, which declares only `allowBuilds:` and no
 * `packages:` key — and then every `pnpm <cmd>` run inside the repo aborts with
 * `ERROR packages field missing or empty` before doing any work, including
 * `pnpm install`, `pnpm lint` and `pnpm test`: the entry points `README.md` and
 * `.github/workflows/ci.yml` document. A repo-root workspace file with a
 * non-empty `packages:` list stops that walk inside the checkout.
 *
 * The same mechanism then has to be applied one level down. The root file
 * captures `workers/sandbox-runner`, the repo's SECOND pnpm package (its own
 * `package.json`, its own `pnpm-lock.yaml`), which the workflows install with
 * `pnpm --dir workers/sandbox-runner install --frozen-lockfile`. Captured by a
 * root workspace that does not list it, that command becomes a SILENT NO-OP —
 * it exits 0 in ~100ms and creates no `node_modules` at all. Concretely that
 * fails CI's Sandbox Worker job at the next step, `TS2307: Cannot find module
 * '@cloudflare/sandbox'`; the same no-op also sits in front of a
 * `wrangler deploy`, though that path is conditional here (AGENTS.md records
 * that the deploy workflows are inert on this fork unless opted into with
 * `ENABLE_CLOUDFLARE_DEPLOY`, and that production deploys are manual). Its own
 * `pnpm-workspace.yaml` stops the walk there and restores the install.
 *
 * The obvious-looking alternative is a trap, and this suite exists partly to
 * keep it shut: listing `workers/sandbox-runner` in the ROOT `packages:` list
 * does NOT shield it, it breaks the root instead. The root lockfile has no
 * importer for that directory, so `pnpm install --frozen-lockfile` at the root
 * fails with `ERR_PNPM_OUTDATED_LOCKFILE` — "specifiers in the lockfile ({})
 * don't match specs in package.json". Any directory carrying its own
 * `pnpm-lock.yaml` therefore has to be OUTSIDE the root list and hold its own
 * workspace file; both halves are asserted below.
 *
 * WHAT THIS SUITE ASSERTS IS THE FILE CONTRACT, NOT THE SHELL BEHAVIOUR.
 * Whether `pnpm` actually aborts depends on what sits ABOVE the checkout, which
 * is machine state a test suite cannot stage (and on a machine with nothing
 * above the repo, these files change nothing at all). What every machine shares
 * is that an absent — or `packages:`-less — workspace file is what makes the
 * abort reachable, so that is what gets pinned here. The shell behaviour, and
 * `pnpm-lock.yaml` staying byte-identical, were verified once by hand.
 *
 * The set of directories to shield is DERIVED, not hard-coded, so a nested
 * package added later inherits the guard instead of the bug. It is the union of
 * (a) every `--dir`/`-C` target scraped from `.github/workflows/*.yml` and
 * (b) every directory in the repo holding its own `pnpm-lock.yaml` — because a
 * nested package can also be installed by hand, with no workflow naming it.
 */

import { describe, expect, it, beforeAll } from "vitest";
import { readFile, readdir } from "fs/promises";
import path from "path";

const SRC = path.resolve(__dirname, "../..");
const ROOT = path.resolve(SRC, "..");

/**
 * ONE spelling of pnpm's abort, shared by this suite and by the comment block
 * inside each workspace file. The comments are the only thing standing between
 * these two-line files and a future "delete the empty config" cleanup, so the
 * assertions below require the string to still be there.
 */
const PNPM_ABORT = "packages field missing or empty";

/**
 * The nested files prevent a different failure from the root one — not an
 * abort, but an exit-0 install that installs nothing — so their comments are
 * pinned to that phrase instead.
 */
const SILENT_NO_OP = "silent no-op";

/** What a root list that swallows a nested package costs, verbatim from pnpm. */
const OUTDATED_LOCKFILE = "ERR_PNPM_OUTDATED_LOCKFILE";

const ROOT_WORKSPACE = "pnpm-workspace.yaml";
const ROOT_LOCKFILE = "pnpm-lock.yaml";
const WORKSPACE_FILE = "pnpm-workspace.yaml";
const LOCKFILE = "pnpm-lock.yaml";
const WORKFLOWS_DIR = ".github/workflows";
const KNOWN_NESTED = "workers/sandbox-runner";

/** Directories the nested-package walk never descends into. */
const UNWALKED = new Set(["node_modules", ".git", ".next", ".yoyo"]);

/**
 * Read a repo file, turning a missing file into a sentence that names what the
 * file is for. A bare ENOENT stack would say only that a path did not resolve.
 */
async function readRepoFile(relPath: string, why: string): Promise<string> {
  try {
    return await readFile(path.join(ROOT, relPath), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(
      `${relPath} could not be read (${code ?? String(error)}). ${why}`,
    );
  }
}

async function readRepoDir(relPath: string, why: string): Promise<string[]> {
  try {
    return await readdir(path.join(ROOT, relPath));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(
      `${relPath}/ could not be listed (${code ?? String(error)}). ${why}`,
    );
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  // Unquoted scalars can carry a trailing comment: `- workers/foo # why`.
  return trimmed.split(/\s+#/)[0].trim();
}

function normalizeDir(value: string): string {
  const cleaned = value.replace(/^\.\//, "").replace(/\/+$/, "");
  return cleaned === "" ? "." : cleaned;
}

/**
 * Read the `packages:` list out of workspace YAML text.
 *
 * Hand-rolled because `package.json` carries no YAML parser — there is nothing
 * to import — and adding a dependency to read a two-line file would be a worse
 * trade than the ~40 lines below. It covers exactly what a workspace file can
 * legally hold:
 *
 * - block items at ANY indentation, including column zero, which YAML permits
 *   for a sequence under a mapping key;
 * - a flow sequence on the key line (`packages: ["."]`);
 * - a non-list scalar (`packages: .`, `packages: null`) reads as NO list, since
 *   that is not a packages declaration pnpm can use;
 * - TWO OR MORE top-level `packages:` keys read as no usable declaration. pnpm
 *   parses this file with js-yaml, which REJECTS duplicate mapping keys rather
 *   than taking either one — verified under the pinned pnpm 9.15.9, which
 *   prints `[ERROR] duplicated mapping key` and installs nothing. A reader that
 *   silently picked one would call a file healthy that pnpm refuses to load;
 * - a leading UTF-8 BOM.
 *
 * Returns `null` for "no usable packages declaration" — a missing key, a
 * scalar, or a duplicated key — and an array (possibly empty, for `packages:`
 * followed by nothing) otherwise.
 *
 * It does NOT validate YAML in general; the "neither workspace file contains a
 * tab" test below covers the one lexical trap this reader would otherwise wave
 * through.
 */
function readPackagesList(text: string): string[] | null {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);

  const keyIndexes: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    // Top-level means column zero: an indented `packages:` belongs to some
    // other mapping and is not the workspace's own key.
    if (/^packages:(.*)$/.test(lines[i])) keyIndexes.push(i);
  }
  // js-yaml errors on the duplicate rather than resolving it, so there is no
  // "winning" key to read.
  if (keyIndexes.length !== 1) return null;

  const keyIndex = keyIndexes[0];
  const inlineValue = (/^packages:(.*)$/.exec(lines[keyIndex]) as RegExpExecArray)[1].trim();

  if (inlineValue.startsWith("[")) {
    const end = inlineValue.lastIndexOf("]");
    if (end === -1) return null;
    const body = inlineValue.slice(1, end).trim();
    if (body === "") return [];
    return body
      .split(",")
      .map(unquote)
      .filter((entry) => entry !== "");
  }
  // Anything else on the key line that is not a comment is a scalar value, not
  // a list — `packages: .` and `packages: null` both land here.
  if (inlineValue !== "" && !inlineValue.startsWith("#")) return null;

  const items: string[] = [];
  for (let i = keyIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const item = /^\s*-\s*(.*)$/.exec(line);
    if (!item) break; // the next mapping key ends the sequence
    const value = unquote(item[1]);
    if (value !== "") items.push(value);
  }
  return items;
}

/**
 * The importer keys of a pnpm lockfile — the directories it actually resolves
 * dependencies for.
 */
function readLockfileImporters(text: string): string[] | null {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const start = lines.findIndex((line) => /^importers:\s*$/.test(line));
  if (start === -1) return null;
  const importers: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (/^\S/.test(line)) break; // back to column zero: the next top-level key
    const key = /^ {2}(\S.*?):\s*$/.exec(line);
    if (key) importers.push(normalizeDir(unquote(key[1])));
  }
  return importers;
}

/**
 * `*` stays inside one segment; `**` spans directories. A TRAILING `**` has to
 * match a directory (pnpm's `workers/**` claims `workers/sandbox-runner`) —
 * expanding it to a "zero or more directory prefixes" group would make it match
 * nothing at all and understate what the root list claims.
 */
function globToRegExp(glob: string): RegExp {
  const segments = glob.split("/");
  const source = segments
    .map((segment, index) => {
      const last = index === segments.length - 1;
      if (segment === "**") return last ? "[^/]+(?:/[^/]+)*" : "(?:[^/]+/)*";
      const literal = segment
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*");
      return last ? literal : `${literal}/`;
    })
    .join("");
  return new RegExp(`^${source}$`);
}

/** Which root `packages:` entries, if any, claim this directory as a member. */
function rootEntriesClaiming(packages: string[], target: string): string[] {
  const normalizedTarget = normalizeDir(target);
  return packages.filter((entry) =>
    globToRegExp(normalizeDir(entry)).test(normalizedTarget),
  );
}

/**
 * Every directory a workflow addresses with `pnpm --dir <path>` / `--dir=<path>`
 * / `-C <path>` / `-C=<path>`. `-C` is pnpm's own documented alias — `pnpm
 * install --help` under the pinned 9.15.9 prints `-C, --dir <dir>` — so a guard
 * that knew only the long spelling would miss half of what it is guarding.
 *
 * A command that already passes `--ignore-workspace` is skipped: it is immune
 * by construction, and demanding a workspace file for it would be a false
 * failure.
 */
function pnpmDirTargets(yaml: string): string[] {
  const targets: string[] = [];
  const invocation = /\bpnpm\b[^\n]*/g;
  let match = invocation.exec(yaml);
  while (match !== null) {
    const command = match[0];
    if (!/--ignore-workspace\b/.test(command)) {
      const dir = /(?:--dir|(?:^|\s)-C)[=\s]+("[^"]+"|'[^']+'|\S+)/.exec(command);
      if (dir) targets.push(normalizeDir(unquote(dir[1])));
    }
    match = invocation.exec(yaml);
  }
  return targets;
}

/**
 * Every directory below the repo root that carries its own `pnpm-lock.yaml`.
 * A lockfile is the durable marker of a separate pnpm package — it survives a
 * package that no workflow installs and one installed only by hand.
 */
async function nestedLockfileDirs(): Promise<string[]> {
  const found: string[] = [];
  async function walk(rel: string): Promise<void> {
    const entries = await readdir(path.join(ROOT, rel), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const child = rel === "." ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (UNWALKED.has(entry.name)) continue;
        await walk(child);
      } else if (entry.name === LOCKFILE && rel !== ".") {
        found.push(rel);
      }
    }
  }
  await walk(".");
  return found.sort();
}

describe("pnpm workspace roots", () => {
  beforeAll(async () => {
    // Anchor the repo root before asserting on paths relative to it: if this
    // file ever moves, every assertion below would otherwise fail with a
    // confusing "missing pnpm-workspace.yaml" instead of "wrong root".
    const pkg = JSON.parse(
      await readRepoFile(
        "package.json",
        "This suite takes the repo root to be two directories above the " +
          "`src/` that contains this test (`SRC` = `__dirname/../..`, `ROOT` = " +
          "`SRC/..`); if this file moved, that no longer lands on the repo root.",
      ),
    ) as { name?: string };
    expect(
      pkg.name,
      `ROOT resolved to ${ROOT}, which is not the work-wiki repo root — ` +
        `every path assertion in this suite is relative to it.`,
    ).toBe("work-wiki");
  });

  it("the repo-root workspace file declares exactly the root package", async () => {
    const text = await readRepoFile(
      ROOT_WORKSPACE,
      `Without a repo-root ${ROOT_WORKSPACE}, pnpm walks up past the checkout, ` +
        `adopts an unrelated ancestor workspace file, and every \`pnpm <cmd>\` ` +
        `run in this repo — \`pnpm install\`, \`pnpm lint\`, \`pnpm test\` — ` +
        `aborts with \`ERROR ${PNPM_ABORT}\`. Restore the file.`,
    );
    const packages = readPackagesList(text);

    expect(
      packages,
      `${ROOT_WORKSPACE} declares no usable \`packages:\` list (missing key, a ` +
        `scalar value, or the key twice). That is the exact state pnpm ` +
        `rejects: every command run in this repo aborts with ` +
        `\`ERROR ${PNPM_ABORT}\`.`,
    ).not.toBeNull();
    expect(
      packages?.length ?? 0,
      `${ROOT_WORKSPACE} has an EMPTY \`packages:\` list, which pnpm treats ` +
        `exactly like a missing one — \`ERROR ${PNPM_ABORT}\`.`,
    ).toBeGreaterThan(0);
    // Exactly `["."]`, not merely "contains `.`": this repo IS one package at
    // the root, and any extra entry is either a directory with its own
    // lockfile (which breaks the root install, see the nested test) or a
    // package that does not exist.
    expect(
      (packages ?? []).map(normalizeDir),
      `${ROOT_WORKSPACE} must declare exactly \`["."]\` — listing \`.\` is what ` +
        `makes the list non-empty without inventing a subdirectory, and this ` +
        `repo has no other root-installed package. Adding an entry here is how ` +
        `the ${OUTDATED_LOCKFILE} failure gets introduced.`,
    ).toEqual(["."]);
  });

  it("the repo-root workspace file keeps the comment that explains why it exists", async () => {
    const text = await readRepoFile(
      ROOT_WORKSPACE,
      `The repo-root workspace file is missing; see the previous test.`,
    );
    expect(
      text,
      `${ROOT_WORKSPACE} reads as a near-empty config, so its comment is the ` +
        `only thing telling the next reader that deleting it re-opens ` +
        `\`ERROR ${PNPM_ABORT}\` for every pnpm command in this repo. Keep the ` +
        `explanation.`,
    ).toContain(PNPM_ABORT);

    // The `onlyBuiltDependencies` ban below is only true for pnpm 9, so pin
    // the premise next to the conclusion.
    const pkg = JSON.parse(
      await readRepoFile("package.json", `It anchors this suite; see beforeAll.`),
    ) as { packageManager?: string };
    expect(
      pkg.packageManager ?? "",
      `This suite forbids \`onlyBuiltDependencies\` in ${ROOT_WORKSPACE} on the ` +
        `strength of the PINNED pnpm 9, which reads build approval from ` +
        `\`package.json#pnpm\` and ignores the workspace file. On a bump to ` +
        `pnpm 10+ that reverses — the workspace file becomes the right home ` +
        `for that key — so this assertion and the comments in both ` +
        `${WORKSPACE_FILE} files must be revisited together with the bump.`,
    ).toMatch(/^pnpm@9\./);
    expect(
      /^onlyBuiltDependencies:/m.test(text),
      `${ROOT_WORKSPACE} must not declare \`onlyBuiltDependencies\`: the ` +
        `pinned pnpm@9 reads build approval from \`package.json#pnpm\`, so a ` +
        `key here is inert while implying the per-machine ` +
        `\`pnpm approve-builds\` step documented in AGENTS.md no longer applies.`,
    ).toBe(false);
  });

  it("the root lockfile still has exactly one importer, as both YAML comments claim", async () => {
    // Both workspace files justify themselves with "this repo is one package at
    // the root, and the nested one is installed separately". A second importer
    // in the root lockfile would make that prose stale, and would mean the
    // nested package had been folded into the root workspace after all.
    const text = await readRepoFile(
      ROOT_LOCKFILE,
      `The root lockfile is what \`pnpm install --frozen-lockfile\` installs ` +
        `from in CI and in the Dockerfile.`,
    );
    const importers = readLockfileImporters(text);
    expect(
      importers,
      `${ROOT_LOCKFILE} has no \`importers:\` section — this suite can no ` +
        `longer tell how many packages the root install covers.`,
    ).not.toBeNull();
    expect(
      importers,
      `${ROOT_LOCKFILE} must declare exactly one importer, \`.\`. That single ` +
        `importer is why the new ${ROOT_WORKSPACE} is invisible to ` +
        `\`pnpm install --frozen-lockfile\`, and why nested packages must stay ` +
        `OUT of the root \`packages:\` list. If the root workspace genuinely ` +
        `grew a second package, update both ${WORKSPACE_FILE} comments and ` +
        `this assertion deliberately.`,
    ).toEqual(["."]);

    // Pin the nested lockfile too: it is the reason `workers/sandbox-runner`
    // installs on its own, and its absence would silently empty the derived
    // set in the next test.
    await readRepoFile(
      `${KNOWN_NESTED}/${LOCKFILE}`,
      `${KNOWN_NESTED} is a separate pnpm package precisely because it carries ` +
        `its own lockfile. Without it, it is not installable on its own and ` +
        `this suite's whole nested-package story no longer holds.`,
    );
  });

  it("every nested pnpm package is shielded from the root workspace", async () => {
    const rootText = await readRepoFile(
      ROOT_WORKSPACE,
      `The repo-root workspace file is missing; see the first test.`,
    );
    const rootPackages = readPackagesList(rootText) ?? [];

    // (a) directories addressed by a workflow…
    const entries = await readRepoDir(
      WORKFLOWS_DIR,
      `This suite derives half the nested-package list from the workflows ` +
        `rather than hard-coding it, so it needs that directory.`,
    );
    const workflows = entries.filter((entry) => /\.ya?ml$/.test(entry)).sort();
    expect(
      workflows.length,
      `No workflow files found under ${WORKFLOWS_DIR}/ — half of this test's ` +
        `derived set would be empty.`,
    ).toBeGreaterThan(0);

    const sourcesFor = new Map<string, string[]>();
    for (const workflow of workflows) {
      const yaml = await readRepoFile(
        `${WORKFLOWS_DIR}/${workflow}`,
        `It was listed by ${WORKFLOWS_DIR}/ a moment ago.`,
      );
      for (const target of pnpmDirTargets(yaml)) {
        sourcesFor.set(target, [...(sourcesFor.get(target) ?? []), workflow]);
      }
    }
    // Anti-vacuity, scraper half: a regex that stops matching must fail here
    // rather than quietly reduce the derived set to nothing.
    expect(
      [...sourcesFor.keys()],
      `Expected to find the \`pnpm --dir ${KNOWN_NESTED} …\` steps in ` +
        `${WORKFLOWS_DIR}/. Finding none means this guard has stopped reading ` +
        `the workflows, not that the risk went away.`,
    ).toContain(KNOWN_NESTED);

    // …(b) union'd with every directory holding its own lockfile, so a nested
    // package installed only by hand is shielded too.
    const ownLockfile = new Set(await nestedLockfileDirs());
    expect(
      [...ownLockfile],
      `Expected to discover ${KNOWN_NESTED} by its own ${LOCKFILE}. Finding ` +
        `none means the repo walk has stopped working, not that the repo has ` +
        `one package.`,
    ).toContain(KNOWN_NESTED);

    const shielded = new Set([...sourcesFor.keys(), ...ownLockfile]);
    shielded.delete(".");

    for (const target of [...shielded].sort()) {
      const sources = sourcesFor.get(target) ?? [];
      const via =
        sources.length > 0
          ? sources.join(", ")
          : `it carries its own ${LOCKFILE}`;
      const claimed = rootEntriesClaiming(rootPackages, target);

      if (ownLockfile.has(target)) {
        // The trap. Listing it in the root looks like shielding and is the
        // opposite: it breaks the ROOT install instead.
        expect(
          claimed,
          `${ROOT_WORKSPACE} claims ${target} (via ${claimed
            .map((entry) => `\`${entry}\``)
            .join(", ")}), but ${target} carries its own ${LOCKFILE}. The root ` +
            `${ROOT_LOCKFILE} has NO importer for it, so ` +
            `\`pnpm install --frozen-lockfile\` at the root now fails with ` +
            `${OUTDATED_LOCKFILE} — "specifiers in the lockfile ({}) don't ` +
            `match specs in package.json" — breaking CI's Application job, the ` +
            `Dockerfile build, and every fresh clone. Remove ${target} from the ` +
            `root \`packages:\` list; shield it with its own ` +
            `${target}/${WORKSPACE_FILE} instead.`,
        ).toEqual([]);
      } else if (claimed.length > 0) {
        // Not a separate package: a genuine member of the root workspace,
        // resolved by the root lockfile. Nothing to shield.
        continue;
      }

      const nested = `${target}/${WORKSPACE_FILE}`;
      const text = await readRepoFile(
        nested,
        `${target} is a separate pnpm package (${via}) and the root ` +
          `${ROOT_WORKSPACE} does not list it. Without ${nested} to stop ` +
          `pnpm's upward walk at that directory, pnpm resolves ` +
          `\`pnpm --dir ${target} …\` to the ROOT workspace and ` +
          `\`pnpm --dir ${target} install --frozen-lockfile\` becomes a SILENT ` +
          `NO-OP: it exits 0 and installs nothing, so every step after it ` +
          `fails on missing modules. Add ${nested} declaring ` +
          `\`packages: ["."]\`. Adding ${target} to the ROOT list instead is ` +
          `NOT the fix — that breaks the root install with ` +
          `${OUTDATED_LOCKFILE}.`,
      );
      const packages = readPackagesList(text);
      expect(
        packages,
        `${nested} declares no usable \`packages:\` list, so pnpm reads it as ` +
          `\`ERROR ${PNPM_ABORT}\` instead of using it to stop the walk — and ` +
          `\`pnpm --dir ${target} install --frozen-lockfile\` (${via}) stops ` +
          `installing anything.`,
      ).not.toBeNull();
      // Exactly `["."]`: an entry like `..` would re-capture the very root
      // this file exists to escape, restoring the silent no-op while looking
      // like a valid declaration.
      expect(
        (packages ?? []).map(normalizeDir),
        `${nested} must declare exactly \`["."]\` so ${target} is its own ` +
          `workspace's only package. Any other entry — \`..\` above all — ` +
          `widens this workspace back over the repo root and re-opens the ` +
          `"${SILENT_NO_OP}" install this file exists to prevent.`,
      ).toEqual(["."]);
      expect(
        text,
        `${nested} is a near-empty config whose only defence against deletion ` +
          `is the comment explaining it. Keep the note that removing it turns ` +
          `\`pnpm --dir ${target} install --frozen-lockfile\` into a ` +
          `"${SILENT_NO_OP}" — the consequence a reader cannot infer from two ` +
          `lines of YAML.`,
      ).toContain(SILENT_NO_OP);
    }
  });

  it("neither workspace file contains a tab, which pnpm's YAML parser rejects outright", async () => {
    // The reader above is lexical and would happily parse a file pnpm refuses
    // to load. A committed-but-unparseable workspace file is strictly WORSE
    // than the bug this story fixes: every pnpm command in the repo dies, and
    // every other assertion here still passes. Tabs are the one trap a
    // hand-edited two-line YAML file realistically hits — pnpm 9.15.9 prints
    // `[ERROR] tab characters must not be used in indentation`.
    const files = [
      ROOT_WORKSPACE,
      ...(await nestedLockfileDirs()).map((dir) => `${dir}/${WORKSPACE_FILE}`),
    ];
    expect(files.length, `Expected at least the root workspace file.`).toBeGreaterThan(1);
    for (const file of files) {
      const text = await readRepoFile(
        file,
        `It is one of this repo's workspace files; see the tests above.`,
      );
      expect(
        text.includes("\t"),
        `${file} contains a TAB. pnpm's YAML parser refuses the whole file — ` +
          `\`tab characters must not be used in indentation\` — so every pnpm ` +
          `command run against it fails, which is worse than the ` +
          `\`${PNPM_ABORT}\` abort this file exists to prevent. Use spaces.`,
      ).toBe(false);
    }
  });

  describe("the packages: reader", () => {
    it("reads a healthy list, at any indentation and in either form", () => {
      expect(readPackagesList('packages:\n  - "."\n')).toEqual(["."]);
      expect(readPackagesList("packages:\n- .\n- workers/x\n")).toEqual([
        ".",
        "workers/x",
      ]);
      expect(readPackagesList('\uFEFFpackages:\n  - "."\n')).toEqual(["."]);
      expect(readPackagesList('packages: [".", "workers/x"]\n')).toEqual([
        ".",
        "workers/x",
      ]);
      // An indented `packages:` belongs to some other mapping.
      expect(readPackagesList("other:\n  packages:\n    - a\n")).toBeNull();
    });

    it("rejects a duplicated packages: key, because js-yaml does", () => {
      // Verified against the pinned pnpm 9.15.9: a file with the key twice
      // fails with `[ERROR] duplicated mapping key` and installs nothing. It
      // does NOT resolve to the first or the last key, so a reader that picked
      // one would call this file healthy while pnpm refuses to load it.
      expect(
        readPackagesList('packages:\n  - a\npackages:\n  - "."\n'),
        `Two top-level \`packages:\` keys must read as NO usable declaration: ` +
          `pnpm parses this file with js-yaml, which errors with ` +
          `\`duplicated mapping key\` rather than choosing one.`,
      ).toBeNull();
    });

    it("reads the two degenerate shapes as 'no packages declared' — the state pnpm rejects", () => {
      // Matrix row: workspace text with no `packages:` key at all. This is the
      // shape of the ancestor file pnpm was adopting.
      const noKey = "allowBuilds:\n  esbuild: set this to true or false\n";
      expect(
        readPackagesList(noKey),
        `Text with no \`packages:\` key must read as NO list — that is what ` +
          `makes pnpm abort with \`ERROR ${PNPM_ABORT}\`, and a reader that ` +
          `returned [] here would let an empty file pass the root assertion.`,
      ).toBeNull();

      // Matrix row: `packages:` followed by no list items. Distinct from the
      // row above (the key IS present) and equally fatal.
      const emptyList = "packages:\nother: value\n";
      expect(
        readPackagesList(emptyList),
        `\`packages:\` with no items must read as an EMPTY list, distinct from ` +
          `a healthy one and from a missing key.`,
      ).toEqual([]);
      expect(readPackagesList("packages:\n")).toEqual([]);

      // A scalar value is not a list at all.
      expect(readPackagesList("packages: .\n")).toBeNull();
      expect(readPackagesList("packages: null\n")).toBeNull();
    });
  });

  describe("the --dir scraper", () => {
    it("recognises every spelling pnpm accepts, and exempts --ignore-workspace", () => {
      // `-C` is pnpm's own documented alias: `pnpm install --help` under the
      // pinned 9.15.9 prints `-C, --dir <dir>`. A guard that knew only
      // `--dir` would leave every `-C` step unshielded.
      expect(pnpmDirTargets("      - run: pnpm --dir workers/a install\n")).toEqual([
        "workers/a",
      ]);
      expect(pnpmDirTargets("      - run: pnpm --dir=workers/a install\n")).toEqual([
        "workers/a",
      ]);
      expect(pnpmDirTargets("      - run: pnpm -C workers/a install\n")).toEqual([
        "workers/a",
      ]);
      expect(pnpmDirTargets("      - run: pnpm -C=workers/a install\n")).toEqual([
        "workers/a",
      ]);
      expect(pnpmDirTargets('      - run: pnpm --dir "workers/a b" install\n')).toEqual([
        "workers/a b",
      ]);
      // Trailing slash and a leading `./` are the same directory.
      expect(pnpmDirTargets("      - run: pnpm --dir ./workers/a/ install\n")).toEqual([
        "workers/a",
      ]);
      // Already immune: pnpm never consults a workspace root for this command,
      // so demanding a workspace file for it would be a false failure.
      expect(
        pnpmDirTargets("      - run: pnpm --dir workers/a --ignore-workspace install\n"),
        "a command that already passes --ignore-workspace needs no workspace file",
      ).toEqual([]);
      // Not a pnpm --dir invocation at all.
      expect(pnpmDirTargets("      - uses: pnpm/action-setup@v6\n")).toEqual([]);
    });
  });

  describe("the root-coverage matcher", () => {
    it("matches a trailing ** against a directory, as pnpm's own globs do", () => {
      // `workers/**` claims `workers/sandbox-runner`. Expanding a trailing
      // `**` to "zero or more directory prefixes" would make it match nothing,
      // understating what the root list claims and letting the
      // ERR_PNPM_OUTDATED_LOCKFILE configuration slip through as "not covered".
      expect(rootEntriesClaiming(["workers/**"], "workers/sandbox-runner")).toEqual([
        "workers/**",
      ]);
      expect(rootEntriesClaiming(["workers/**"], "workers/a/b")).toEqual([
        "workers/**",
      ]);
      expect(rootEntriesClaiming(["workers/*"], "workers/sandbox-runner")).toEqual([
        "workers/*",
      ]);
      expect(
        rootEntriesClaiming(["workers/sandbox-runner"], "workers/sandbox-runner"),
      ).toEqual(["workers/sandbox-runner"]);
      // `.` claims only the root, and `workers/*` does not reach two levels.
      expect(rootEntriesClaiming(["."], "workers/sandbox-runner")).toEqual([]);
      expect(rootEntriesClaiming(["workers/*"], "workers/a/b")).toEqual([]);
    });
  });
});
