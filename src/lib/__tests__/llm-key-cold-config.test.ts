/**
 * `hasLLMKey()` against a REAL store on a COLD process (DW-548).
 *
 * THE BUG. The gate's two store-only legs — `ollama`, which is keyless, and
 * `custom`, whose key and endpoint may both live in the store — resolved through
 * `loadConfigSync()`. That answers `{}` whenever the in-memory cache is not warm
 * and re-stamps the `{}` for another 5 s each time it does, so a CLI or MCP
 * process (nothing runs ahead of the command to warm anything) told an owner who
 * had saved Ollama or Custom that no provider was configured — and then had
 * ingest, lint, vision, search and the query route all silently skip their LLM
 * steps.
 *
 * COLD means the config object exists on disk and `_configCache` has never seen
 * it, which is why every case writes `.llm-wiki-config.json` with `fs` rather
 * than through `saveConfig()`: `saveConfig()` warms the cache as a side effect,
 * erasing the very condition under test. `cli-status-config-load.test.ts` uses
 * the same harness for the `status` surface.
 *
 * NOTHING IS MOCKED HERE. The point is the real `config.ts` reading a real
 * directory; a mocked config module makes a cold cache unrepresentable, which is
 * exactly why no existing suite could see this.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { hasLLMKey } from "../llm";
import { _resetConfigCache } from "../config";
import { _resetStorage, getStorage } from "../storage";
import { logger } from "../logger";
import { walkFiles } from "./source-scan";

/**
 * Every variable that can decide a leg of the gate's ladder, plus the three that
 * place the store itself. Deliberately not "everything `config.ts` reads" — the
 * research and embedding variables reach no branch of `hasLLMKey`. The list
 * exists so the ambient environment of whoever runs the suite cannot answer a
 * question these cases mean to put to the store alone.
 */
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
  "STORAGE_PROVIDER",
  "LLM_CUSTOM_API_KEY",
  "LLM_CUSTOM_BASE_URL",
];

describe("hasLLMKey() sees a store nothing warmed (DW-548)", () => {
  let tmpDir: string;
  let savedEnv: Record<string, string | undefined>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-key-cold-"));

    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.DATA_DIR = tmpDir;

    // `readStoredConfig` logs through the real `logger.warn` on an unreadable
    // store. That is silent under a plain `vitest run` — `defaultLevel()`
    // returns `error` when `NODE_ENV` is `test` — but `LOG_LEVEL` overrides that
    // default and is not scrubbed above, so an ambient `LOG_LEVEL=warn` would
    // put the line into this suite's output. Never asserted on.
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    _resetConfigCache();
    _resetStorage();
  });

  afterEach(async () => {
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
    // be bound to an earlier root and the cache may hold an earlier snapshot.
    _resetConfigCache();
    _resetStorage();
  }

  it("answers true for a store-only Ollama selection", async () => {
    // THE BUG, in one line. Ollama is keyless, so the store is the ONLY place
    // this deployment's choice can live — and the cold `loadConfigSync()` could
    // not see it.
    await storeConfig({ provider: "ollama" });

    expect(await hasLLMKey()).toBe(true);
  });

  it("answers true for a store-only Custom selection with BOTH halves", async () => {
    await storeConfig({
      provider: "custom",
      customApiKey: "sk-custom",
      customBaseUrl: "https://api.example/v1",
    });

    expect(await hasLLMKey()).toBe(true);
  });

  it("still refuses a Custom selection missing either half", async () => {
    // `providerIsConfigured` is unchanged and stays the one rule: a key with no
    // endpoint has nowhere to go, an endpoint with no key 401s. Reading the
    // store correctly must not turn a half-saved Custom into a promise the
    // runtime cannot keep.
    await storeConfig({ provider: "custom", customApiKey: "sk-custom" });
    expect(await hasLLMKey()).toBe(false);

    await storeConfig({ provider: "custom", customBaseUrl: "https://api.example/v1" });
    expect(await hasLLMKey()).toBe(false);
  });

  it("still refuses a WORKLOAD-only selection — the gate speaks for the primary route", async () => {
    // DW-621 asked for the gate to be widened to `chatProvider` /
    // `ingestProvider`, and this case pins the decision NOT to. The gate answers
    // "can the primary route make a call", and every one of its ~25 consumers
    // takes that route (`callLLM` / `callLLMStream` / `callVisionLLM` / bare
    // `getConfiguredModel()`) immediately after. `getResolvedCredentials` still
    // resolves this store to `provider: null`, so a `true` here would trade a
    // graceful skip for a thrown `No LLM API key found…` at every one of them.
    // Nothing in production passes `workload`, so the `false` is honest.
    //
    // THE WHOLE ARGUMENT, though: this `false` is not costless either. For a
    // `chatProvider`-only store `chat.ts:865` throws "No LLM provider is
    // configured." after `ChatCanvas` has already reported the chat model
    // configured from the retrieve payload — a real user-visible disagreement.
    // It is filed as DW-711 and fixed at the call sites (wiring the workload
    // route) rather than by widening this predicate, which would only move the
    // throw to `getModel()` and take ~20 graceful skips down with it.
    await storeConfig({ chatProvider: "ollama", chatModel: "llama3" });
    expect(await hasLLMKey()).toBe(false);

    await storeConfig({ ingestProvider: "ollama", ingestModel: "llama3" });
    expect(await hasLLMKey()).toBe(false);
  });

  it("answers from the environment WITHOUT reading the store", async () => {
    // THE COST CONTROL. ~20 call sites ask this gate, several of them inside
    // loops, so an env-configured deployment must not start paying a storage
    // read per call for a store leg it never reaches. The env check stays FIRST
    // and this case pins that it short-circuits — not merely that the answer is
    // right, which it would be either way.
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const readSpy = vi.spyOn(getStorage(), "readFileWithEtag");

    expect(await hasLLMKey()).toBe(true);
    expect(readSpy).not.toHaveBeenCalled();

    readSpy.mockRestore();
  });

  it("answers false — not a rejection — when the store cannot be read", async () => {
    // THE FAILURE MODE THE ASYNC GATE OPENS. `loadConfigSync()` could not throw;
    // an awaited read can, and ~20 call sites gate on this function without a
    // `try` between them and it — `src/lib/ingest.ts` and the query stream route
    // among them. `readStoredConfig` RETURNS its failure rather than throwing and
    // `loadConfig()` flattens that to `{}`, so a config file the process cannot
    // parse closes the gate cleanly instead of turning every LLM feature into an
    // unhandled rejection. (`logger.warn` is stubbed in `beforeEach`, which is
    // the line that read would otherwise print here.)
    await fs.writeFile(
      path.join(tmpDir, ".llm-wiki-config.json"),
      "{ this is not json",
      "utf8",
    );
    _resetConfigCache();
    _resetStorage();

    await expect(hasLLMKey()).resolves.toBe(false);
  });

  it("answers false for an empty store and a scrubbed environment", async () => {
    // The absent-config path: `readStoredConfig` turns ENOENT into `{}` rather
    // than throwing, so the gate closes cleanly instead of rejecting into ~20
    // call sites that never expected this function to fail.
    expect(await hasLLMKey()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The surface the defect was actually reported at
// ---------------------------------------------------------------------------

const run = promisify(execFile);

const REPO_ROOT = path.resolve(__dirname, "../../..");
const TSX = path.join(REPO_ROOT, "node_modules/.bin/tsx");

/**
 * Run the CLI and hand back its output whether or not it exited 0.
 *
 * `execFile` REJECTS on a non-zero exit, and the case below expects one: the
 * proof it is after is a failure that happens DOWNSTREAM of the gate. The output
 * rides on the rejection, so it is read off the error rather than lost with it.
 */
async function runCli(
  args: string[],
  dataDir: string,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await run(TSX, ["src/cli.ts", ...args], {
      cwd: REPO_ROOT,
      // BUILT, not inherited — the same rule the spawn case in
      // `cli-status-config-load.test.ts` follows. An inherited env would hand the
      // child an `ANTHROPIC_API_KEY` from whoever is running the suite, which is
      // the env fast path, which would make the store leg under test unreachable.
      // PATH and HOME are what the runtime needs; `NODE_ENV` is required on this
      // repo's `ProcessEnv` and keeps the child's logger at the suite's level.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NODE_ENV: process.env.NODE_ENV,
        DATA_DIR: dataDir,
      },
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("a cold CLI process sees a store-only provider (DW-548)", () => {
  /**
   * THE SURFACE, not the mechanism. Every case above calls `hasLLMKey()`
   * in-process after resetting the cache by hand — a faithful model of a cold
   * cache, but still a model: the reset is something the test does, not
   * something the process is. The defect was reported as `pnpm cli query`
   * answering "No API key configured." for a provider the owner had saved, so
   * one case spawns exactly that. Nothing is mocked and no cache is reset,
   * because a fresh `node` has nothing to reset.
   */
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-key-cold-cli-"));

    // The smallest wiki `query` will retrieve against. With no pages the command
    // short-circuits before it ever reaches the gate, and the case would pass
    // for the wrong reason.
    await fs.mkdir(path.join(tmpDir, "wiki"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "wiki/index.md"),
      "- [Alpha](alpha.md) — A test page.\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "wiki/alpha.md"),
      "---\ntitle: Alpha\ntype: concept\n---\n\n# Alpha\n\nAlpha is a test page about the alpha concept.\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("opens the gate for a store-only Custom provider", async () => {
    // THE LEDGER'S OWN SENTENCE. Before the fix this printed "No API key
    // configured." and listed the wiki's pages — the fallback — for a Custom
    // provider whose key and endpoint were both sitting in the store the process
    // never read.
    //
    // NO `model` IN THE STORE, DELIBERATELY. The proof wanted here is that
    // execution got PAST the gate, which any downstream failure demonstrates —
    // so the cheapest one is the right one. Omitting `model` makes
    // `getConfiguredModel` refuse locally and immediately (~0.3 s). A model plus
    // a dead endpoint proves the identical thing by way of three retries and
    // about six seconds of backoff, in a suite that would pay it on every run.
    await fs.writeFile(
      path.join(tmpDir, ".llm-wiki-config.json"),
      JSON.stringify({
        provider: "custom",
        customApiKey: "sk-x",
        customBaseUrl: "http://127.0.0.1:9/v1",
      }),
      "utf8",
    );

    const { stdout, stderr } = await runCli(["query", "what is alpha"], tmpDir);
    const output = `${stdout}\n${stderr}`;

    // THE ASSERTION. The gate did not close.
    expect(output).not.toContain("No API key configured.");
    // A FAILURE DOWNSTREAM of the gate is what proves it opened — a bare
    // "did not print the fallback" would also be satisfied by a command that
    // died before reaching either.
    expect(output).toContain("The Custom provider needs a model name.");
  }, 60_000);

  it("still prints the fallback when nothing is stored and nothing is set", async () => {
    // THE CONTROL. A `query` that never reached the gate at all would satisfy
    // the case above, so the closed gate is pinned on the same tree and the same
    // spawn — only the config file differs.
    const { stdout } = await runCli(["query", "what is alpha"], tmpDir);

    expect(stdout).toContain("**No API key configured.**");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The source scan
// ---------------------------------------------------------------------------

const SRC = path.resolve(__dirname, "../..");
const ROOT = path.resolve(SRC, "..");

/** Every module that can hold a call: app routes, lib, hooks, components. */
const SCANNED = /\.[cm]?[jt]sx?$/;

/**
 * A call, awaited or not. `hasLLMKey` also appears in import lists and in prose,
 * neither of which is followed by `(` — so anchoring on the open paren is what
 * separates a CALL from a mention.
 */
const CALL = /hasLLMKey\s*\(/;
/**
 * Every awaited call on a line, GLOBAL because it is used to DELETE them rather
 * than to test for one.
 *
 * A line-level `test()` for an awaited call would exonerate the whole line the
 * moment it found one, so `(await hasLLMKey()) && hasLLMKey()` — one fixed call
 * and one missed, which is exactly the shape a half-finished edit leaves — read
 * as clean. Removing the awaited occurrences and asking whether a bare one
 * SURVIVES is the same question asked per call instead of per line.
 *
 * The `g` flag is why this constant is never handed to `walkFiles`, whose
 * `include` rejects it: `test()` resumes from `lastIndex` and would match every
 * other file. `String.replace` has no such state.
 */
const AWAITED_CALLS = /await\s+hasLLMKey\s*\(/g;
/** The declaration in `src/lib/llm.ts` itself, which is not a call. */
const DECLARATION = /function\s+hasLLMKey\s*\(/;

interface CallSite {
  file: string;
  line: number;
  text: string;
}

async function callSites(): Promise<CallSite[]> {
  const files = await walkFiles(SRC, { include: SCANNED });

  // A scan that matches no files passes every assertion below while proving
  // nothing, so the reach is pinned by name before anything is asserted about
  // the contents — the `english-only.test.ts` idiom. One member per subtree the
  // gate is actually called from.
  const relative = files.map((f) => path.relative(ROOT, f));
  for (const member of [
    "src/lib/query.ts",
    "src/lib/ingest.ts",
    "src/app/api/query/stream/route.ts",
  ]) {
    expect(relative).toContain(path.normalize(member));
  }
  // Named files prove the reach; a floor proves the walk did not collapse to
  // just them after a directory filter goes wrong.
  expect(files.length).toBeGreaterThan(100);

  const found: CallSite[] = [];
  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    if (!CALL.test(source)) continue;
    source.split("\n").forEach((text, index) => {
      if (!CALL.test(text)) return;
      if (DECLARATION.test(text)) return;
      found.push({ file: path.relative(ROOT, file), line: index + 1, text: text.trim() });
    });
  }
  return found;
}

describe("every hasLLMKey() call in src/ is awaited (DW-548)", () => {
  it("leaves no bare call anywhere in the tree", async () => {
    // THE REGRESSION THE FIX OPENS, and the reason this scan exists rather than
    // a lint rule: the gate now returns a Promise, and a Promise is TRUTHY. A
    // dropped `await` therefore does not fail — `if (!hasLLMKey())` becomes
    // `if (false)` and every gated feature runs with no provider behind it,
    // failing later and elsewhere. This repo runs no type-aware lint rule
    // (`no-floating-promises`, `await-thenable`) that would catch it, so the
    // guard is a source scan.
    //
    // `__tests__` is excluded by `walkFiles`, which is also what keeps this
    // file's own examples from being read as offenders.
    const sites = await callSites();
    const offenders = sites
      .filter((s) => CALL.test(s.text.replace(AWAITED_CALLS, "")))
      .map((s) => `${s.file}:${s.line}  ${s.text}`);

    expect(offenders).toEqual([]);
  });

  it("actually found the call sites it is guarding", async () => {
    // A scan whose corpus quietly shrank satisfies "no offenders" by
    // construction. The pins above prove the FILES were walked; this proves the
    // CALLS inside them were seen.
    const sites = await callSites();
    const files = new Set(sites.map((s) => s.file));

    for (const member of [
      "src/lib/query.ts",
      "src/lib/ingest.ts",
      "src/app/api/query/stream/route.ts",
    ]) {
      expect(files).toContain(path.normalize(member));
    }
    expect(sites.length).toBeGreaterThanOrEqual(15);
  });
});
