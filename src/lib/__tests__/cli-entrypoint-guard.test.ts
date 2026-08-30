/**
 * `src/cli.ts` runs a command only when it IS the entry point (DW-551).
 *
 * THE BUG. `main().catch(...)` sat at module scope, so every import of this
 * module ran a CLI command. `src/cli.ts` exports `runStatus`, `runList` and the
 * rest for the suites that pin them, and importing it under vitest handed the
 * parser an argv with no command in it — which falls through to `help`, so the
 * HELP block landed in the suite's output — and routed any throw into a
 * `process.exit(1)` that takes the whole worker down with it.
 *
 * `src/mcp.ts` has carried the guard since it was written; this pins the CLI's
 * copy of it, in both directions: imported does nothing, executed still works.
 *
 * SPAWNED, not imported in-process. The condition under test is the value of
 * `process.argv[1]`, which under vitest is the vitest binary — true of this
 * worker whatever the guard says, so an in-process import could never tell a
 * fixed module from a broken one. Each case gets its own process with its own
 * argv.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const REPO_ROOT = path.resolve(__dirname, "../../..");
const CLI_PATH = path.join(REPO_ROOT, "src/cli.ts");
const TSX = path.join(REPO_ROOT, "node_modules/.bin/tsx");

/**
 * BUILT, not inherited. An inherited env could hand the child an
 * `ANTHROPIC_API_KEY` or a `DATA_DIR` from whoever is running the suite, and
 * `help` is the one command that should not care about either. PATH and HOME are
 * what the runtime itself needs; `NODE_ENV` is required on this repo's
 * `ProcessEnv` and keeps the child's logger at the suite's level.
 */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: process.env.NODE_ENV,
    ...extra,
  };
}

describe("src/cli.ts only runs a command when it is the entry point (DW-551)", () => {
  let tmpDir: string;
  let importerPath: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-entrypoint-"));
    importerPath = path.join(tmpDir, "importer.mts");

    // AN ABSOLUTE SPECIFIER, from a file outside the repo. `src/cli.ts` has zero
    // static imports — every dependency is a dynamic `import()` inside a command
    // — so nothing here needs the `@/` alias, a tsconfig, or a single package
    // from the repo's `node_modules` to be resolvable from this directory.
    //
    // `.mts` so `tsx` treats it as ESM and top-level `await` is legal.
    await fs.writeFile(
      importerPath,
      [
        `await import(${JSON.stringify(CLI_PATH)});`,
        `console.log("IMPORTED-NOTHING-RAN");`,
        "",
      ].join("\n"),
      "utf8",
    );
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("runs no command, and prints nothing, when it is merely imported", async () => {
    // THE POINT. `process.argv[1]` here is the importer, not `cli.ts`, which is
    // exactly the shape of a suite importing the module for its exports.
    const { stdout } = await run(TSX, [importerPath], {
      cwd: tmpDir,
      env: childEnv(),
    });

    // The sentinel proves the import RESOLVED — without it an empty stdout would
    // also be what a module that failed to load produces, and this case would
    // pass for the wrong reason.
    expect(stdout).toContain("IMPORTED-NOTHING-RAN");
    // The HELP block is what a bare `main()` prints when argv carries no
    // command, so its absence is the guard working.
    expect(stdout).not.toContain("Usage: pnpm cli");
    // Nothing but the sentinel: `list`, `status` and the rest would each add
    // their own rows here.
    expect(stdout.trim()).toBe("IMPORTED-NOTHING-RAN");
  }, 30_000);

  it("exits 0 when merely imported", async () => {
    // The other half of the same failure: an un-guarded `main()` whose command
    // throws reaches `process.exit(1)` and takes the importing process — a
    // vitest worker, in the case this is about — down with it.
    await expect(
      run(TSX, [importerPath], { cwd: tmpDir, env: childEnv() }),
    ).resolves.toBeDefined();
  }, 30_000);

  it("still runs the command when executed directly", async () => {
    // THE CONTROL. A guard that never lets `main()` run would satisfy every
    // assertion above, so the working surface is pinned in the same file.
    const { stdout } = await run(TSX, [CLI_PATH, "help"], {
      cwd: REPO_ROOT,
      env: childEnv(),
    });

    expect(stdout).toContain("Usage: pnpm cli");
  }, 30_000);
});
