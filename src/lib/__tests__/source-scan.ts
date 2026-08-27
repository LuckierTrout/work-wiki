/**
 * One recursive source walk, shared by the suites that scan a SOURCE TREE for
 * files whose basename matches a pattern (DW-117).
 *
 * Seven suites grew their own `walk()`, and the copies drifted: some skipped
 * `node_modules`, some did not, one skipped nothing at all and filtered
 * `__tests__` out afterwards at each call site. Scans that READ as equivalent
 * therefore covered different file sets, and a scan quietly covering less than
 * its comment claims is the one failure a source guard cannot notice about
 * itself.
 *
 * WHAT THIS IS NOT THE SINGLE DEFINITION OF. Three other recursive walkers
 * survive on purpose, and a future consolidation should leave them alone:
 *
 * - `read-only-kernel-gate.test.ts`'s `walk()` snapshots the CONTENTS of a temp
 *   data directory into a map keyed by relative path. It is a different
 *   function wearing the same name: it reads every file rather than selecting
 *   by name, tolerates a missing directory, and must not exclude anything.
 * - `read-only-door-coverage.test.ts`'s `routeFiles()` and
 *   `retired-surfaces.test.ts`'s `retiredSurfacesOnDisk()` do match this
 *   contract, but walk `src/app` — a tree with no `__tests__`, `node_modules`,
 *   `.git` or `.next` in it — and `retiredSurfacesOnDisk()` reads and filters
 *   each file as it descends rather than returning paths. They were out of
 *   scope for DW-117 and are named here so the next reader does not have to
 *   rediscover that this module's reach stops short of them.
 *
 * Not named `*.test.ts`: `vitest.config.ts` collects
 * `src/**\/__tests__/**\/*.test.ts` into the `node` project, so a helper wearing
 * that suffix would be collected as a suite with no assertions in it. The
 * sibling `internal-link-fixture.ts` and `email-ingest-wire.ts` follow the same
 * rule and are imported the same way, as `./source-scan`.
 *
 * `source-scan.test.ts` executes the rules below against a temp fixture tree.
 * They are load-bearing for every caller at once — appending one name to
 * `SKIPPED_DIRS` deletes a subtree from every whole-tree scan in the repo
 * simultaneously — so they are pinned there rather than trusted here.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Directory names no source scan ever descends into.
 *
 * - `__tests__` — a scan that reads its own assertion text can only ever fail:
 *   the string a guard forbids is written out verbatim in the guard. This is
 *   also why `walkFiles` is the right place for the exclusion rather than a
 *   post-filter at each call site, which is what two of the copies did.
 * - `node_modules` — installed dependencies are not this repo's source, and the
 *   tree is large enough that walking it turns a fast scan into a slow one.
 * - `.git` — object storage, not text anyone wrote; a packed object can match
 *   almost any pattern by accident.
 * - `.next` — build output. Every file in it is a generated copy of something
 *   already scanned, so a hit there is a duplicate report at best and a report
 *   against a stale build at worst.
 *
 * Anything BEYOND this set stays per-call (`skipDirs`), for the reason
 * `brand-copy.test.ts` documents: a globally skipped extra name would silently
 * shrink every other scan too, and the shrink would show up as green.
 *
 * ADDING A NAME HERE IS A REPO-WIDE COVERAGE CUT. Every whole-tree scan loses
 * that subtree at once, and each of them asserts `offenders` is empty — which
 * an emptier corpus satisfies by construction. The callers therefore carry
 * member pins and count floors (the `english-only.test.ts` idiom) so the cut
 * fails somewhere instead of passing everywhere.
 */
export const SKIPPED_DIRS: readonly string[] = ["__tests__", "node_modules", ".git", ".next"];

export interface WalkOptions {
  /**
   * Matched against the entry's BASENAME, not its path — which is what every
   * copy this replaces did, so no call site's regex had to change.
   *
   * Must not carry `g` or `y`: those flags make `test()` resume from
   * `lastIndex` and so alternate between matching and not matching the same
   * string. `walkFiles` throws on one rather than silently returning every
   * other file.
   */
  include: RegExp;
  /** Extra directory names to leave unwalked, on top of `SKIPPED_DIRS`. */
  skipDirs?: readonly string[];
}

/**
 * Every file under `dir`, recursively, whose basename matches `include`.
 *
 * Returns ABSOLUTE paths (`dir` joined with each segment), so a caller that
 * wants repo-relative output derives it with `path.relative` — as the copies
 * already did.
 *
 * THE EXCLUSIONS APPLY TO CHILD DIRECTORIES ONLY. The `dir` argument itself is
 * never name-checked, so the same set means different things depending on where
 * a caller enters the tree: `walkFiles(srcHooks, …)` walks `src/hooks` whole,
 * while `walkFiles(src, …)` reaches it only because `hooks` is not an excluded
 * name. That asymmetry is deliberate and load-bearing — it is what lets
 * `brand-copy.test.ts` pass a tree directly as a root, and what would let a
 * caller point this at a `__tests__` directory on purpose — but it also means
 * "is this file covered?" cannot be answered from `SKIPPED_DIRS` alone without
 * knowing the root.
 */
export async function walkFiles(
  dir: string,
  { include, skipDirs = [] }: WalkOptions,
): Promise<string[]> {
  // Checked on every call rather than once at the root: the recursion passes
  // the same object down, so the cost is a flag read, and a caller that builds
  // its regex dynamically gets the failure at the call it made.
  if (include.global || include.sticky) {
    throw new Error(
      `walkFiles: include ${include} carries the ${include.global ? "g" : "y"} ` +
        `flag, which makes RegExp.test() resume from lastIndex — it would match ` +
        `every other file and silently halve the scan. Drop the flag.`,
    );
  }
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.includes(entry.name)) continue;
      if (skipDirs.includes(entry.name)) continue;
      out.push(...(await walkFiles(full, { include, skipDirs })));
    } else if (include.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}
