import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";

import { runStatus } from "../../cli";
import { _resetConfigCache } from "../config";
import { logger } from "../logger";
import { _resetStorage } from "../storage";
import { ollamaBaseUrlRefusedCopy } from "../workbench-settings";

/**
 * `yopedia status` against the REAL config module and a REAL store (DW-502).
 *
 * `cli.test.ts` mocks `../config` wholesale, which is exactly why it could never
 * observe this bug: a mocked `getEffectiveSettings` hands back a fully populated
 * object no matter what the in-process cache holds, so the one condition that
 * broke `status` — a cold cache — is unrepresentable there. That suite pins the
 * CALL and its ORDER; this one pins the EFFECT.
 *
 * COLD means the config object exists on disk and `_configCache` has never seen
 * it. That is also why every case writes `.llm-wiki-config.json` with `fs`
 * rather than through `saveConfig()`: `saveConfig()` warms the cache as a side
 * effect, which would erase the very condition under test.
 *
 * Only `../wiki` and `../raw` are mocked — the two counts at the top of the
 * output are not what this file is about, and standing up real page and source
 * trees for them would add a second reason for these cases to fail. The last
 * case mocks nothing at all: it spawns the CLI as a process.
 */
vi.mock("../wiki", () => ({
  listWikiPages: vi.fn(async () => []),
}));

vi.mock("../raw", () => ({
  listRawSources: vi.fn(async () => []),
  // `status` counts the flat listing UNION the hashed snapshots (DW-437), so
  // both exports have to exist here or every row assertion below dies on the
  // missing mock rather than on the config-load ordering it is about.
  listRawSourceSnapshots: vi.fn(async () => []),
}));

// Every variable that can decide one of the FOUR ROWS `status` prints, plus the
// three that place the store itself. Deliberately not "everything `config.ts`
// reads" — that module also reads `FIRECRAWL_API_KEY`, `RESEARCH_PROVIDER`, the
// `SEARXNG_*`/`SERPAPI_*` pairs and `TAVILY_API_KEY`, none of which reach this
// output. The list exists so the ambient environment of whoever runs the suite
// cannot decide a leg of a ladder these cases mean to control from the store
// alone; growing it past that would be scrubbing for its own sake.
const ENV_KEYS = [
  "DATA_DIR",
  "WIKI_DIR",
  "RAW_DIR",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OLLAMA_API_KEY",
  "OLLAMA_BASE_URL",
  "OLLAMA_MODEL",
  "LLM_MODEL",
  "EMBEDDING_MODEL",
  "EMBEDDING_PROVIDER",
  "YOPEDIA_READONLY",
  "STORAGE_PROVIDER",
  "LLM_CUSTOM_API_KEY",
  "LLM_CUSTOM_BASE_URL",
];

describe("yopedia status reads the stored config on a cold process (DW-502)", () => {
  let tmpDir: string;
  let savedEnv: Record<string, string | undefined>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-status-cfg-"));

    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.DATA_DIR = tmpDir;

    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // The refused-endpoint case drives `resolveOllamaBaseUrl` through
    // `warnOnceAbout`, which calls the real `logger.warn`. That is SILENT under
    // a plain `vitest run` — `defaultLevel()` returns `error` when `NODE_ENV` is
    // `test` (`src/lib/logger.ts`) — but `LOG_LEVEL` OVERRIDES that default and
    // is not one of the variables `ENV_KEYS` scrubs, so an ambient
    // `LOG_LEVEL=warn` would put the line into this suite's output. Stubbed so
    // the noise cannot depend on who is running the tests. Never asserted on:
    // the assertion belongs on the `issue` the resolver RETURNS, which is what
    // actually reaches the printed row.
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    _resetConfigCache();
    _resetStorage();
  });

  afterEach(async () => {
    logSpy.mockRestore();
    warnSpy.mockRestore();

    for (const key of ENV_KEYS) {
      const val = savedEnv[key];
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }

    _resetConfigCache();
    _resetStorage();

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Put an object in the store WITHOUT warming the cache that reads it. */
  async function storeConfig(config: Record<string, unknown>): Promise<void> {
    await fs.writeFile(
      path.join(tmpDir, ".llm-wiki-config.json"),
      JSON.stringify(config),
      "utf8",
    );
    // The write above went through `fs`, but the storage singleton may already
    // be bound to an earlier root, and the cache may hold an earlier snapshot.
    _resetConfigCache();
    _resetStorage();
  }

  function printedLines(): string[] {
    return logSpy.mock.calls.map((c) => c[0] as string);
  }

  it("reports a provider that exists only in the store", async () => {
    // THE BUG. Before DW-502 nothing awaited `loadConfig()`, so
    // `getEffectiveSettings()` read a cold `loadConfigSync()` — `{}` — and this
    // printed "not configured" for a provider the owner had saved.
    await storeConfig({ provider: "openai" });

    await runStatus();

    expect(printedLines()).toContain("LLM provider:\topenai");
  });

  it("reports a stored Ollama endpoint the resolver refused", async () => {
    // The other half of the same blindness: a store leg that never ran cannot
    // complain, so the refusal sentence the owner needs was simply absent.
    await storeConfig({ provider: "ollama", ollamaBaseUrl: "localhost:11434" });

    await runStatus();

    const issue = ollamaBaseUrlRefusedCopy("config", "localhost:11434");
    expect(printedLines()).toContain(`Ollama endpoint:\t${issue}`);
  });

  it("prints exactly four rows when nothing is stored and nothing is set", async () => {
    // A SHAPE GUARD, NOT A DW-502 PIN — and the distinction is worth stating so
    // nobody reads this case as evidence the fix works. With an empty store and
    // a scrubbed env the cold path and the warmed path resolve identically, so
    // this passes with or without the `await loadConfig()`. What it does prove
    // is that adding the await introduced no failure mode on the empty case:
    // `loadConfig()` answers `{}` on ENOENT rather than throwing, and the output
    // is still the four rows it always was — `Label:\tvalue` is a parsed shape,
    // and a fifth row would be a new field for every reader.
    await expect(runStatus()).resolves.toBeUndefined();

    const lines = printedLines();
    expect(lines).toHaveLength(4);
    expect(lines).toContain("LLM provider:\tnot configured");
    expect(lines.join("\n")).not.toContain("Ollama endpoint:");
  });

  it("keeps the store leg ahead of the environment, as the web surface does", async () => {
    // Not a new precedence rule — `getEffectiveSettings()` has always preferred
    // `cfg.provider` over a detected env provider. The point is that the CLI now
    // sees the same ladder the `/settings` page does instead of only its tail.
    await storeConfig({ provider: "openai" });
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";

    await runStatus();

    expect(printedLines()).toContain("LLM provider:\topenai");
  });

  it("reports the stored provider when the REAL CLI process runs `status`", async () => {
    // THE SURFACE, not the mechanism. Every case above calls the exported
    // `runStatus()` in-process after resetting the cache by hand — a faithful
    // model of a cold cache, but still a model: the reset is something the test
    // does, not something the process is. The intent's words are "a cold CLI
    // process", so one case spawns one and reads its stdout. Nothing here is
    // mocked and no cache is reset, because a fresh `node` has nothing to reset.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-status-spawn-"));
    try {
      await fs.writeFile(
        path.join(dir, ".llm-wiki-config.json"),
        JSON.stringify({ provider: "openai" }),
        "utf8",
      );

      // BUILT, not inherited. `beforeEach` has already mutated this process's
      // env, and inheriting it would hand the child a `DATA_DIR` pointing at the
      // other cases' temp dir. PATH and HOME are what the runtime itself needs
      // and `NODE_ENV` is required on this repo's `ProcessEnv` (it also keeps
      // the child's logger at the suite's level, `src/lib/logger.ts`); the only
      // thing said about the wiki is where its data lives.
      const { stdout } = await promisify(execFile)(
        path.join(process.cwd(), "node_modules/.bin/tsx"),
        ["src/cli.ts", "status"],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            NODE_ENV: process.env.NODE_ENV,
            DATA_DIR: dir,
          },
        },
      );

      // STDOUT only. The child also writes a node `DEP0205` deprecation warning
      // to stderr, which is the runtime's business and not this command's
      // output — asserting on it, or failing on a non-empty stderr, would make
      // this case break on a node upgrade that has nothing to do with DW-502.
      expect(stdout).toContain("LLM provider:\topenai");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
