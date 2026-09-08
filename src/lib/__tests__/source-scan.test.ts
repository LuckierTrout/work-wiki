/**
 * The shared source walk, executed (DW-117).
 *
 * `walkFiles` is the single traversal behind every whole-tree scan in the repo,
 * and those scans all assert the same shape: "the offender list is empty".
 * An emptier CORPUS satisfies that by construction, so a mistake here — one
 * name appended to `SKIPPED_DIRS`, a dropped `skipDirs` check, a match against
 * the path instead of the basename — deletes coverage everywhere at once and
 * leaves every caller green. None of its rules were executable before this
 * file: deleting the `skipDirs` line from `walkFiles` broke nothing in the repo.
 *
 * This runs against a TEMP FIXTURE TREE rather than against `src/`, so each
 * rule is asserted on a tree small enough to state exactly, and so no case can
 * start passing because the real tree happens to lack an excluded directory
 * today.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SKIPPED_DIRS, walkFiles } from "./source-scan";

/** The pattern every case below walks with, unless it is testing the pattern. */
const KEEP = /^keep\.ts$/;

let root: string;

/**
 * Every file the fixture holds, as a `/`-joined path relative to `root`.
 *
 * `dirmatch/keep.ts/` is a DIRECTORY whose name matches `KEEP`, holding a file
 * of the same name — the one shape that tells "collected a directory" apart
 * from "descended into it".
 */
const FIXTURE_FILES = [
  "keep.ts",
  "skip.md",
  "nested/keep.ts",
  "nested/deeper/keep.ts",
  "dirmatch/keep.ts/keep.ts",
  // One match inside each globally excluded name, so a lost exclusion shows up
  // as a named extra path rather than as a count that moved.
  ...SKIPPED_DIRS.map((dir) => `${dir}/keep.ts`),
  // …and one behind a per-call exclusion.
  "dist/keep.ts",
];

/** Results as `/`-joined paths relative to `root`, sorted — readdir order is not a contract. */
function rel(files: string[]): string[] {
  return files.map((f) => path.relative(root, f).split(path.sep).join("/")).sort();
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "source-scan-"));
  for (const file of FIXTURE_FILES) {
    const full = path.join(root, ...file.split("/"));
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, "fixture\n", "utf8");
  }
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("walkFiles", () => {
  it("returns exactly the matching files, descending past ordinary directories", async () => {
    // Stated as an equality rather than as `toContain`s: this is the one case
    // that would notice a file the walk started returning as well as one it
    // stopped returning.
    expect(rel(await walkFiles(root, { include: KEEP }))).toEqual([
      "dirmatch/keep.ts/keep.ts",
      "dist/keep.ts",
      "keep.ts",
      "nested/deeper/keep.ts",
      "nested/keep.ts",
    ]);
  });

  it("never descends into a name in SKIPPED_DIRS", async () => {
    // Asserted over the CONSTANT rather than over four literals, so a name
    // added to the set is covered the moment it is added.
    const found = rel(await walkFiles(root, { include: KEEP }));
    for (const dir of SKIPPED_DIRS) {
      // The fixture really does stage a match under each excluded name, so the
      // assertion below cannot pass because there was nothing to find.
      expect(FIXTURE_FILES).toContain(`${dir}/keep.ts`);
      expect(
        found,
        `${dir}/keep.ts came back from the walk, so "${dir}" is no longer ` +
          `excluded — every whole-tree scan in the repo just started reading it.`,
      ).not.toContain(`${dir}/keep.ts`);
    }
  });

  it("never descends into a per-call skipDirs name", async () => {
    const found = rel(await walkFiles(root, { include: KEEP, skipDirs: ["dist"] }));
    expect(found).not.toContain("dist/keep.ts");
    // …and the rest of the tree is untouched, so `skipDirs` prunes ONE branch
    // rather than narrowing the match.
    expect(found).toContain("keep.ts");
    expect(found).toContain("nested/deeper/keep.ts");
  });

  it("walks the ROOT directory even when its own name is excluded", async () => {
    // The exclusions are applied to CHILD entries only. This is what lets
    // `brand-copy.test.ts` hand an otherwise-excluded tree straight to the walk
    // as a root, and it means the covered set cannot be read off
    // `SKIPPED_DIRS` without also knowing where the caller entered the tree.
    const tests = path.join(root, "__tests__");
    expect(rel(await walkFiles(tests, { include: KEEP }))).toEqual(["__tests__/keep.ts"]);
  });

  it("matches include against the BASENAME, not the path", async () => {
    // Every copy this module replaced matched the basename, so a switch to
    // path matching would change what every migrated call site covers while
    // each one's regex still read the same.
    expect(rel(await walkFiles(root, { include: KEEP }))).toContain("nested/deeper/keep.ts");
    expect(await walkFiles(root, { include: /^nested\/keep\.ts$/ })).toEqual([]);
  });

  it("collects files only — a DIRECTORY whose name matches is never returned", async () => {
    const found = rel(await walkFiles(root, { include: KEEP }));
    expect(found).not.toContain("dirmatch/keep.ts");
    // It is still descended into, like any other directory.
    expect(found).toContain("dirmatch/keep.ts/keep.ts");
  });

  it("refuses a global or sticky include instead of halving the scan", async () => {
    // `RegExp.test()` on a /g or /y pattern resumes from `lastIndex`, so it
    // alternates true/false over identical strings — the walk would return
    // roughly every other file, and every caller would still report an empty
    // offender list.
    await expect(walkFiles(root, { include: /^keep\.ts$/g })).rejects.toThrow(/lastIndex/);
    await expect(walkFiles(root, { include: /^keep\.ts$/y })).rejects.toThrow(/lastIndex/);
  });
});
