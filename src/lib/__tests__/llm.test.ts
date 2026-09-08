import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  hasLLMKey,
  callLLM,
  callLLMStream,
  getConfiguredModel,
  retryWithBackoff,
  isRetryableError,
} from "../llm";
import { _resetConfigCache, DEFAULT_MODELS } from "../config";
import { _resetStorage } from "../storage";
import { SETTINGS_LABEL, settingsCategory, settingsPointer } from "../workbench-settings";
import { logger } from "../logger";

// Save and restore env vars around each test so we don't leak state.
let savedAnthropic: string | undefined;
let savedOpenAI: string | undefined;
let savedGoogle: string | undefined;
let savedOllamaApiKey: string | undefined;
let savedOllamaBaseURL: string | undefined;
let savedOllamaModel: string | undefined;
let savedModel: string | undefined;
let savedDataDir: string | undefined;

beforeEach(() => {
  savedAnthropic = process.env.ANTHROPIC_API_KEY;
  savedOpenAI = process.env.OPENAI_API_KEY;
  savedGoogle = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  savedOllamaApiKey = process.env.OLLAMA_API_KEY;
  savedOllamaBaseURL = process.env.OLLAMA_BASE_URL;
  savedOllamaModel = process.env.OLLAMA_MODEL;
  savedModel = process.env.LLM_MODEL;
  savedDataDir = process.env.DATA_DIR;

  // Start each test from a clean slate so tests don't depend on ordering.
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.OLLAMA_MODEL;
  delete process.env.LLM_MODEL;

  // Point DATA_DIR at a nonexistent path so no config file is found
  process.env.DATA_DIR = "/tmp/llm-wiki-test-nonexistent-" + Date.now();

  // Reset config cache so tests don't see stale data — and the storage
  // singleton with it: `hasLLMKey()` reads the STORE on its non-env legs since
  // DW-548, and a singleton still bound to an earlier root would answer from a
  // directory this test never set.
  _resetConfigCache();
  _resetStorage();
});

afterEach(() => {
  // Restore original values (or delete if they were unset)
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };
  restore("ANTHROPIC_API_KEY", savedAnthropic);
  restore("OPENAI_API_KEY", savedOpenAI);
  restore("GOOGLE_GENERATIVE_AI_API_KEY", savedGoogle);
  restore("OLLAMA_API_KEY", savedOllamaApiKey);
  restore("OLLAMA_BASE_URL", savedOllamaBaseURL);
  restore("OLLAMA_MODEL", savedOllamaModel);
  restore("LLM_MODEL", savedModel);
  restore("DATA_DIR", savedDataDir);

  _resetConfigCache();
});

describe("hasLLMKey", () => {
  it("returns false when no provider env var is set", async () => {
    expect(await hasLLMKey()).toBe(false);
  });

  it("returns true when ANTHROPIC_API_KEY is set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(await hasLLMKey()).toBe(true);
  });

  it("returns true when OPENAI_API_KEY is set", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    expect(await hasLLMKey()).toBe(true);
  });

  it("returns true when only GOOGLE_GENERATIVE_AI_API_KEY is set", async () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "google-test-key";
    expect(await hasLLMKey()).toBe(true);
  });

  it("returns true when only OLLAMA_BASE_URL is set", async () => {
    process.env.OLLAMA_BASE_URL = "http://localhost:11434/api";
    expect(await hasLLMKey()).toBe(true);
  });

  it("returns true when OLLAMA_API_KEY is set", async () => {
    process.env.OLLAMA_API_KEY = "ollama-cloud-key";
    expect(await hasLLMKey()).toBe(true);
  });

  it("returns true when only OLLAMA_MODEL is set", async () => {
    process.env.OLLAMA_MODEL = "llama3.2";
    expect(await hasLLMKey()).toBe(true);
  });

  it("returns true when multiple keys are set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OPENAI_API_KEY = "sk-test";
    expect(await hasLLMKey()).toBe(true);
  });
});

describe("callLLM", () => {
  it("throws a clear error mentioning all four providers when no env vars are set", async () => {
    const promise = callLLM("system", "hello");

    // The error should mention every supported provider env var so users
    // know their options. Using substring checks keeps the assertion
    // resilient to minor wording tweaks.
    await expect(promise).rejects.toThrow(/No LLM API key found/);
    await expect(promise).rejects.toThrow(/ANTHROPIC_API_KEY/);
    await expect(promise).rejects.toThrow(/OPENAI_API_KEY/);
    await expect(promise).rejects.toThrow(/GOOGLE_GENERATIVE_AI_API_KEY/);
    await expect(promise).rejects.toThrow(/OLLAMA/);
  });
});

describe("callLLMStream", () => {
  it("throws a clear error mentioning supported providers when no env vars are set", async () => {
    await expect(callLLMStream("system", "hello")).rejects.toThrow(
      /No LLM API key found/,
    );
    await expect(callLLMStream("system", "hello")).rejects.toThrow(/ANTHROPIC_API_KEY/);
    await expect(callLLMStream("system", "hello")).rejects.toThrow(/OPENAI_API_KEY/);
    await expect(callLLMStream("system", "hello")).rejects.toThrow(
      /GOOGLE_GENERATIVE_AI_API_KEY/,
    );
    await expect(callLLMStream("system", "hello")).rejects.toThrow(/OLLAMA_API_KEY/);
  });

  it("returns the stream result after loading persisted settings", async () => {
    // This test documents *why* callLLMStream doesn't use retryWithBackoff:
    // streamText() returns a StreamTextResult synchronously. The actual API
    // call happens lazily when the stream is consumed, so connection errors
    // (429, 503, ECONNRESET) only surface on stream read — not at call time.
    // Wrapping streamText() in retry would never catch transient errors.
    //
    // We set up a provider so getModel() succeeds, then verify callLLMStream
    // returns a result synchronously (not a Promise).
    process.env.OPENAI_API_KEY = "sk-test-fake-key";
    _resetConfigCache();

    const result = await callLLMStream("system prompt", "user message");

    // streamText returns an object, not a Promise
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
    // It should have stream-specific methods
    expect(typeof result.toTextStreamResponse).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// isRetryableError
// ---------------------------------------------------------------------------

describe("isRetryableError", () => {
  it("returns true for 429 rate limit errors", () => {
    const err = new Error("Request failed with status 429");
    expect(isRetryableError(err)).toBe(true);
  });

  it("returns true for 503 service unavailable", () => {
    const err = new Error("Service temporarily unavailable 503");
    expect(isRetryableError(err)).toBe(true);
  });

  it("returns true for 500 internal server error", () => {
    const err = new Error("Internal server error 500");
    expect(isRetryableError(err)).toBe(true);
  });

  it("returns true for 502 bad gateway", () => {
    const err = new Error("Bad gateway 502");
    expect(isRetryableError(err)).toBe(true);
  });

  it("returns true for 504 gateway timeout", () => {
    const err = new Error("Gateway timeout 504");
    expect(isRetryableError(err)).toBe(true);
  });

  it("returns true for errors with status property", () => {
    const err = Object.assign(new Error("overloaded"), { status: 529 });
    // 529 is not in the set, so it should NOT be retryable via status prop
    expect(isRetryableError(err)).toBe(false);

    const err2 = Object.assign(new Error("rate limited"), { status: 429 });
    expect(isRetryableError(err2)).toBe(true);
  });

  it("returns true for network errors", () => {
    expect(isRetryableError(new Error("ECONNRESET"))).toBe(true);
    expect(isRetryableError(new Error("ETIMEDOUT"))).toBe(true);
    expect(isRetryableError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableError(new Error("socket hang up"))).toBe(true);
  });

  it("returns false for auth errors (401, 403)", () => {
    expect(isRetryableError(new Error("Unauthorized 401"))).toBe(false);
    expect(isRetryableError(new Error("Forbidden 403"))).toBe(false);
  });

  it("returns false for 400 bad request", () => {
    expect(isRetryableError(new Error("Bad request 400"))).toBe(false);
  });

  it("returns false for missing API key errors", () => {
    expect(
      isRetryableError(new Error("No LLM API key found. Set one of ...")),
    ).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isRetryableError("string error")).toBe(false);
    expect(isRetryableError(42)).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });

  // --- False-positive prevention tests ---

  it("does not retry on 'limit of 500 tokens' message", () => {
    const err = new Error("limit of 500 tokens");
    expect(isRetryableError(err)).toBe(false);
  });

  it("does not treat 'maximum 400 characters' as non-retryable when status is 429", () => {
    // The message contains "400" but .status is 429 (rate limit) —
    // .status should win since it's checked first.
    const err = Object.assign(new Error("maximum 400 characters"), {
      status: 429,
    });
    expect(isRetryableError(err)).toBe(true);
  });

  it("prefers .status property over message text", () => {
    // .status: 429 (retryable) but message mentions "400" incidentally
    const err = Object.assign(
      new Error("exceeded the 400 character limit"),
      { status: 429 },
    );
    expect(isRetryableError(err)).toBe(true);

    // .status: 401 (not retryable) but message mentions "503"
    const err2 = Object.assign(
      new Error("something about 503 in text"),
      { status: 401 },
    );
    expect(isRetryableError(err2)).toBe(false);
  });

  it("does not retry on 'context window of 512 tokens' message", () => {
    const err = new Error("context window of 512 tokens");
    expect(isRetryableError(err)).toBe(false);
  });

  // --- HTTP status code in message pattern tests ---

  it("retries on 'status: 503' in message", () => {
    const err = new Error("Request failed with status: 503");
    expect(isRetryableError(err)).toBe(true);
  });

  it("retries on 'status 429' in message", () => {
    const err = new Error("Request failed with status 429");
    expect(isRetryableError(err)).toBe(true);
  });

  it("retries on '503 error' in message", () => {
    const err = new Error("503 error from upstream");
    expect(isRetryableError(err)).toBe(true);
  });

  it("retries on '429 too many' in message", () => {
    const err = new Error("429 too many requests");
    expect(isRetryableError(err)).toBe(true);
  });

  it("does not retry on plain number in message without HTTP context", () => {
    expect(isRetryableError(new Error("processed 500 items"))).toBe(false);
    expect(isRetryableError(new Error("timeout after 503 ms"))).toBe(false);
    expect(isRetryableError(new Error("batch size 429"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// retryWithBackoff
// ---------------------------------------------------------------------------

describe("retryWithBackoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns immediately on success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");

    const promise = retryWithBackoff(fn, 3, 100, 10_000);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on non-retryable errors (throws immediately)", async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(new Error("Unauthorized 401"));

    await expect(retryWithBackoff(fn, 3, 100, 10_000)).rejects.toThrow(
      "Unauthorized 401",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable errors and succeeds on later attempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("service unavailable"), { status: 503 }),
      )
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValue("success");

    // Suppress logger.warn during retry
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const promise = retryWithBackoff(fn, 3, 10, 10_000);

    // Advance timers past the first backoff (attempt 0 → retry 1)
    await vi.advanceTimersByTimeAsync(50);
    // Advance past the second backoff (attempt 1 → retry 2)
    await vi.advanceTimersByTimeAsync(50);

    const result = await promise;
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });

  it("throws the last error after exhausting all retries", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("server error first"), { status: 503 }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("server error second"), { status: 503 }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("server error third"), { status: 503 }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("server error final"), { status: 503 }),
      );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    let caughtError: Error | undefined;
    const promise = retryWithBackoff(fn, 3, 10, 10_000).catch((err) => {
      caughtError = err;
    });

    // Advance through all backoff delays
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(100);
    }

    await promise;
    expect(caughtError).toBeDefined();
    expect(caughtError!.message).toBe("server error final");
    // 1 initial + 3 retries = 4 total calls
    expect(fn).toHaveBeenCalledTimes(4);

    warnSpy.mockRestore();
  });

  it("respects the maxMs cap on backoff delay", async () => {
    // With baseMs=1000 and attempt 3, raw delay would be 8000
    // but maxMs=2000 should cap it
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValue("ok");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const promise = retryWithBackoff(fn, 1, 1000, 2000);

    // The delay should be capped at ~2000ms (± jitter)
    // Advance enough to cover it
    await vi.advanceTimersByTimeAsync(3000);

    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });

  it("uses correct number of retry attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fetch failed"));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    let caughtError: Error | undefined;
    const promise = retryWithBackoff(fn, 2, 10, 10_000).catch((err) => {
      caughtError = err;
    });

    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(100);
    }

    await promise;
    expect(caughtError).toBeDefined();
    expect(caughtError!.message).toBe("fetch failed");
    // maxRetries=2: initial + 2 retries = 3
    expect(fn).toHaveBeenCalledTimes(3);

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// The Custom provider's runtime refusals name a nav row that exists (DW-369)
// ---------------------------------------------------------------------------

describe("Custom provider refusals point at the LLM Models category", () => {
  let dataDir: string;
  let savedCustomBaseUrl: string | undefined;
  let savedCustomApiKey: string | undefined;

  /** What the nav row is called RIGHT NOW — derived, never spelled here. */
  const category = settingsCategory("llm-models").label;

  /** `custom` is selectable only from the store, so the store is what we seed. */
  function selectCustom() {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-custom-pointer-"));
    fs.writeFileSync(
      path.join(dataDir, ".llm-wiki-config.json"),
      JSON.stringify({ provider: "custom" }),
    );
    process.env.DATA_DIR = dataDir;
    // The filesystem provider memoises `getDataDir()` at construction, so a
    // config read earlier in this file has already pinned the storage instance
    // to the outer `beforeEach`'s throwaway directory.
    _resetStorage();
    _resetConfigCache();
  }

  beforeEach(() => {
    savedCustomBaseUrl = process.env.LLM_CUSTOM_BASE_URL;
    savedCustomApiKey = process.env.LLM_CUSTOM_API_KEY;
    delete process.env.LLM_CUSTOM_BASE_URL;
    delete process.env.LLM_CUSTOM_API_KEY;
    selectCustom();
  });

  afterEach(() => {
    if (savedCustomBaseUrl === undefined) delete process.env.LLM_CUSTOM_BASE_URL;
    else process.env.LLM_CUSTOM_BASE_URL = savedCustomBaseUrl;
    if (savedCustomApiKey === undefined) delete process.env.LLM_CUSTOM_API_KEY;
    else process.env.LLM_CUSTOM_API_KEY = savedCustomApiKey;
    fs.rmSync(dataDir, { recursive: true, force: true });
    _resetStorage();
    _resetConfigCache();
  });

  /** The message `callLLM` refuses with, for the currently seeded environment. */
  async function refusal(): Promise<string> {
    try {
      await callLLM("system", "hello");
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error("expected the Custom provider to be refused");
  }

  it("names the base URL gap with the DERIVED category label and no 'Workbench' prefix", async () => {
    const message = await refusal();
    // Derived, so a rename of the category renames this message too — which is
    // the whole of DW-369. Asserting the literal here would freeze the label and
    // let the derivation be reverted with the suite still green.
    expect(message).toBe(
      `The Custom provider needs a base URL. Set it in Settings → ${category}.`,
    );
    // SHORT form, deliberately. `settingsPointer`'s default would say "Workbench
    // Settings → …", which disambiguates two Settings SURFACES for a sentence
    // rendered on one of them. This is a runtime error raised from the LLM call;
    // it is on neither surface, so the extra word would only be noise.
    expect(message).not.toContain("Workbench");
  });

  it("names the API key gap the same way", async () => {
    process.env.LLM_CUSTOM_BASE_URL = "https://example.invalid/v1";
    _resetConfigCache();
    const message = await refusal();
    expect(message).toBe(
      `The Custom provider needs an API key. Set it in Settings → ${category}.`,
    );
    expect(message).not.toContain("Workbench");
  });

  it("names the model gap the same way", async () => {
    // `DEFAULT_MODELS.custom` is deliberately absent, so both halves supplied
    // still leaves the model unnamed — the third of the three throw sites in
    // `getModel()`.
    process.env.LLM_CUSTOM_BASE_URL = "https://example.invalid/v1";
    process.env.LLM_CUSTOM_API_KEY = "sk-custom-test";
    _resetConfigCache();
    const message = await refusal();
    expect(message).toBe(
      `The Custom provider needs a model name. Set it in Settings → ${category}.`,
    );
    expect(message).not.toContain("Workbench");
  });

  it("says the same thing on the getConfiguredModel path", async () => {
    // The OTHER throw sites. They are a separate resolution ladder, which is
    // exactly how five copies of one destination came to exist — so both ladders
    // are asserted against the same derived label. The key is set to reach the
    // MODEL gap in the second half; since DW-632 it is no longer needed to step
    // past a guard, because `custom` is exempt from that guard now.
    process.env.LLM_CUSTOM_API_KEY = "sk-custom-test";
    _resetConfigCache();
    await expect(getConfiguredModel({ provider: "custom" })).rejects.toThrow(
      `The Custom provider needs a base URL. Set it in Settings → ${category}.`,
    );

    process.env.LLM_CUSTOM_BASE_URL = "https://example.invalid/v1";
    _resetConfigCache();
    await expect(getConfiguredModel({ provider: "custom" })).rejects.toThrow(
      `The Custom provider needs a model name. Set it in Settings → ${category}.`,
    );
  });

  it("spells the destination nowhere in llm.ts itself", async () => {
    // The mutation this catches: re-typing the literal at one throw site while
    // the constant stays in place elsewhere. Read as bytes, because that drift
    // is invisible to any assertion on a single message.
    const source = await fs.promises.readFile(
      path.resolve(__dirname, "../llm.ts"),
      "utf8",
    );
    const throwSites = source
      .split("\n")
      .filter((line) => line.includes("The Custom provider needs"));
    // SIX since DW-632: `getConfiguredModel`'s `custom` case gained the API-key
    // refusal the pre-switch guard used to swallow, so both ladders now name the
    // same three gaps in the same order.
    expect(throwSites).toHaveLength(6);
    for (const line of throwSites) {
      expect(line).toContain("${LLM_MODELS_POINTER}");
      expect(line).not.toContain(`Settings → ${category}`);
    }

    // WIDENED for DW-503, and it earns its keep again under DW-631: the
    // pre-switch keyless guard and the `ollama-cloud` guard both carry this
    // destination and neither says "The Custom provider needs", so the scan
    // above would have walked straight past a hand-typed label at either. Every
    // line that sends an owner anywhere is checked instead of the six that
    // happen to share a subject.
    const pointerSites = source
      .split("\n")
      .filter((line) => line.includes("Set it in "));
    // EIGHT since DW-631/DW-632: the six above, the DW-503 keyless guard, and
    // the `ollama-cloud` guard, which used to name an env var and no field.
    expect(pointerSites.length).toBeGreaterThanOrEqual(8);
    for (const line of pointerSites) {
      expect(line).toContain("${LLM_MODELS_POINTER}");
      expect(line).not.toContain(`${SETTINGS_LABEL} → ${category}`);
    }

    // AND THE WHOLE FILE, because both loops above key on English phrasing —
    // a tenth refusal worded "Find it in Settings → LLM Models." matches
    // neither filter and would slip past both. The destination itself is what
    // may not be typed here, wherever and however it is worded. (It is also
    // what catches the no-provider throw, which ends "configure a provider in
    // …" and so carries the destination without saying "Set it in ".)
    expect(source).not.toContain(`${SETTINGS_LABEL} → ${category}`);
  });
});

// ---------------------------------------------------------------------------
// The keyless guard names the provider AND the destination (DW-503) — and does
// not fire for `custom`, whose own case names the gap better (DW-632)
// ---------------------------------------------------------------------------

describe("the pre-switch keyless guard: who it catches and who it lets past", () => {
  /**
   * The whole destination, built the one sanctioned way — and the ONLY derived
   * value this describe needs, which is why the category label is not read
   * separately here the way the DW-369 describe above reads it. Typing "Settings → "
   * here would leave the test asserting a sentence it had composed itself: it
   * would still pass if the guard stopped calling `settingsPointer`, and it
   * would fail on a rewording of {@link SETTINGS_LABEL} — the exact rename this
   * derivation exists to absorb.
   */
  const pointer = settingsPointer("llm-models", SETTINGS_LABEL);

  let dataDir: string | null = null;
  let savedCustomBaseUrl: string | undefined;
  let savedCustomApiKey: string | undefined;

  /** Seed a stored config and re-read it, the way the describe above does. */
  function seedConfig(config: Record<string, unknown>) {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-keyless-guard-"));
    fs.writeFileSync(
      path.join(dataDir, ".llm-wiki-config.json"),
      JSON.stringify(config),
    );
    process.env.DATA_DIR = dataDir;
    // The filesystem provider memoises `getDataDir()` at construction, so the
    // storage singleton has to be dropped with the config cache.
    _resetStorage();
    _resetConfigCache();
  }

  /** The message `getConfiguredModel` refuses with, for the seeded state. */
  async function refusal(options: Parameters<typeof getConfiguredModel>[0]) {
    try {
      await getConfiguredModel(options);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error("expected the keyless guard to refuse");
  }

  /**
   * The message the PRIMARY ladder (`callLLM` → `getModel`) refuses with.
   *
   * The sentinel throw is AFTER the `catch`, not inside the `try`, which is why
   * it is a helper rather than an inline block: written inline, its own `catch`
   * swallows it and the sentinel string becomes the message under assertion —
   * a test that reports "expected …" as though the code had said it.
   */
  async function primaryRefusal(): Promise<string> {
    try {
      await callLLM("system", "hello");
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error("expected the primary ladder to refuse");
  }

  beforeEach(() => {
    savedCustomBaseUrl = process.env.LLM_CUSTOM_BASE_URL;
    savedCustomApiKey = process.env.LLM_CUSTOM_API_KEY;
    delete process.env.LLM_CUSTOM_BASE_URL;
    delete process.env.LLM_CUSTOM_API_KEY;
  });

  afterEach(() => {
    if (savedCustomBaseUrl === undefined) delete process.env.LLM_CUSTOM_BASE_URL;
    else process.env.LLM_CUSTOM_BASE_URL = savedCustomBaseUrl;
    if (savedCustomApiKey === undefined) delete process.env.LLM_CUSTOM_API_KEY;
    else process.env.LLM_CUSTOM_API_KEY = savedCustomApiKey;
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
    _resetStorage();
    _resetConfigCache();
  });

  it("ends at the same destination the eight sibling refusals do", async () => {
    // The outer `beforeEach` deletes every provider key, so `openai` is asked
    // for and unconfigured — the exact state this guard exists for. Before
    // DW-503 the sentence stopped at "server.", naming no field to go and set.
    expect(await refusal({ provider: "openai" })).toBe(
      `The OpenAI provider is not configured on this server. Set it in ${pointer}.`,
    );
  });

  it("uses the display label, not the raw slug", async () => {
    // `ollama-cloud` is the case that makes the difference visible: the slug is
    // a hyphenated internal id and the label is what the Settings picker shows.
    const message = await refusal({ provider: "ollama-cloud" });
    expect(message).toBe(
      `The Ollama Cloud provider is not configured on this server. Set it in ${pointer}.`,
    );
    expect(message).not.toContain("ollama-cloud");
    // SHORT form, for the same reason the eight siblings use it: a runtime error
    // raised from the LLM call is rendered on neither Settings surface.
    expect(message).not.toContain("Workbench");
  });

  it("sends a keyless custom provider to its own case, not this guard (DW-632)", async () => {
    // INVERTED from DW-503 on purpose. `custom` used to reach this guard first,
    // so an owner who had set nothing was told the provider "is not configured
    // on this server" here while the SAME state resolved through `getModel`
    // said "needs a base URL" — one state, two diagnoses, decided by which
    // ladder the call arrived on. `custom` is exempt now, so its own case names
    // the first real gap and both ladders agree.
    const message = await refusal({ provider: "custom" });
    expect(message).toBe(
      `The Custom provider needs a base URL. Set it in ${pointer}.`,
    );
    expect(message).not.toContain("is not configured on this server");
  });

  it("names the API key gap a keyless custom provider used to hide", async () => {
    // The state the old guard made unreachable: endpoint supplied, key missing.
    // It short-circuited before the `switch`, so this sentence could not be
    // produced on this ladder at all — the second half of DW-632.
    process.env.LLM_CUSTOM_BASE_URL = "https://example.invalid/v1";
    _resetConfigCache();
    expect(await refusal({ provider: "custom" })).toBe(
      `The Custom provider needs an API key. Set it in ${pointer}.`,
    );
  });

  it("diagnoses one keyless custom state identically on both ladders", async () => {
    // The acceptance criterion itself, asserted as an EQUALITY between the two
    // resolvers rather than as two literals that happen to match — a rewording
    // of one alone fails here even if both still read plausibly.
    //
    // BOTH gap states, not just the first. The API-key sentence is the one this
    // change DUPLICATED — `getModel`'s custom case and `getConfiguredModel`'s
    // custom case now each spell it — so it is the pair most able to drift.
    seedConfig({ provider: "custom" });
    expect(await primaryRefusal()).toBe(await refusal({ provider: "custom" }));
    expect(await primaryRefusal()).toBe(
      `The Custom provider needs a base URL. Set it in ${pointer}.`,
    );

    process.env.LLM_CUSTOM_BASE_URL = "https://example.invalid/v1";
    _resetConfigCache();
    expect(await primaryRefusal()).toBe(await refusal({ provider: "custom" }));
    expect(await primaryRefusal()).toBe(
      `The Custom provider needs an API key. Set it in ${pointer}.`,
    );

    // THE THIRD GAP STATE, which used to be a documented divergence (DW-713).
    // With both credentials present and no model anywhere, this branch resolved
    // the model from its own arguments alone — never `cfg.model`, never
    // `LLM_MODEL` — so the two ladders could not be compared here at all. It
    // takes the primary ladder's answer from `getResolvedCredentials` now, so
    // the model gap is an equality like the two above.
    process.env.LLM_CUSTOM_API_KEY = "sk-custom-test";
    _resetConfigCache();
    expect(await primaryRefusal()).toBe(await refusal({ provider: "custom" }));
    expect(await primaryRefusal()).toBe(
      `The Custom provider needs a model name. Set it in ${pointer}.`,
    );
  });

  it("builds a STORED custom model instead of refusing it (DW-713)", async () => {
    // THE BUG. `getModel` builds this exact store fine — `cfg.model` is a leg of
    // its ladder — while this branch skipped from `options.model` straight to
    // `DEFAULT_MODELS`, which has no `custom` entry on purpose. So an owner who
    // had saved a complete Custom provider was told it "needs a model name" at
    // `agent-runtime.ts`'s door, for a model sitting in the store.
    seedConfig({
      provider: "custom",
      model: "my-model",
      customApiKey: "sk-custom",
      customBaseUrl: "https://example.invalid/v1",
    });
    const model = await getConfiguredModel({ provider: "custom" });
    // The name the owner saved, which is the refusal this branch used to send
    // instead.
    expect(model.modelId).toBe("my-model");
    // AND THE SAME NAME `getModel()` BUILDS, as an equality between the two
    // ladders rather than a second literal: the point is that one ladder is
    // derived from the other, not that both happen to spell "my-model". A bare
    // `getConfiguredModel()` falls straight through to `getModel(cfg)`, so this
    // IS the primary ladder's answer.
    expect(model.modelId).toBe((await getConfiguredModel()).modelId);
  });

  it("refuses a stored model that belongs to ANOTHER provider (DW-713)", async () => {
    // THE GUARD. The stored model is the PRIMARY provider's, so it may only be
    // spent on that provider. Unguarded, `claude-x` would reach an OpenAI-shaped
    // custom client as a request for a model that endpoint has never heard of —
    // a wire error about nothing, which is the state the refusal below exists to
    // replace. Both credential halves are present, so the model is the only gap.
    seedConfig({
      provider: "anthropic",
      model: "claude-x",
      customApiKey: "sk-custom",
      customBaseUrl: "https://example.invalid/v1",
    });
    expect(await refusal({ provider: "custom" })).toBe(
      `The Custom provider needs a model name. Set it in ${pointer}.`,
    );
  });

  it("takes the STORED model for a NON-custom provider too (DW-713)", async () => {
    // WHERE THE LEG ACTUALLY LANDS IN PRODUCTION. `custom` is the vivid case —
    // no `DEFAULT_MODELS` tail, so the gap surfaces as a refusal — but the only
    // door that reaches this branch with a provider and no model,
    // `runSpecializedAgent` in `agent-runtime.ts`, cannot even ask for it:
    // `AgentProfile.provider` excludes `custom`. For every provider it CAN ask
    // for, the old skip was silent rather than loud — an agent pinned to the
    // store's own provider quietly ran on `DEFAULT_MODELS[provider]` instead of
    // the model the owner had saved. Narrowing the leg back to `custom` would
    // restore exactly that, and nothing above this line would notice.
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    seedConfig({ provider: "anthropic", model: "claude-x" });

    expect((await getConfiguredModel({ provider: "anthropic" })).modelId).toBe(
      "claude-x",
    );
    expect((await getConfiguredModel({ provider: "anthropic" })).modelId).toBe(
      (await getConfiguredModel()).modelId,
    );
  });

  it("puts the stored model ABOVE OLLAMA_MODEL, as its owner does (DW-713)", async () => {
    // THE RUNG THAT MOVED. `OLLAMA_MODEL` used to be the first thing this branch
    // read for an ollama provider; `getResolvedCredentials` reads it BELOW
    // `cfg.model`, so taking the ladder from its owner necessarily reorders the
    // two here. That reorder is the point rather than a side effect — it is what
    // "one ladder, derived" means for this provider — and without this case it
    // could be reversed back green.
    process.env.OLLAMA_MODEL = "env-llama";
    seedConfig({ provider: "ollama", model: "cfg-llama" });

    expect((await getConfiguredModel({ provider: "ollama" })).modelId).toBe(
      "cfg-llama",
    );
    expect((await getConfiguredModel({ provider: "ollama" })).modelId).toBe(
      (await getConfiguredModel()).modelId,
    );
  });

  it("takes LLM_MODEL here too, and options.model still outranks it (DW-713)", async () => {
    // The other leg `getResolvedCredentials` owns, and the ordering that had to
    // survive the fix: `options.model` is the CALLER's explicit choice — an
    // agent's model override, or the workload settings' own model — so it stays
    // above the store, and the store sits above the `OLLAMA_MODEL` /
    // `DEFAULT_MODELS` tail.
    seedConfig({
      provider: "custom",
      model: "stored-model",
      customApiKey: "sk-custom",
      customBaseUrl: "https://example.invalid/v1",
    });
    process.env.LLM_MODEL = "env-model";
    _resetConfigCache();

    expect((await getConfiguredModel({ provider: "custom" })).modelId).toBe(
      "env-model",
    );
    expect(
      (await getConfiguredModel({ provider: "custom", model: "explicit-model" }))
        .modelId,
    ).toBe("explicit-model");
  });

  it("still BUILDS a fully configured custom provider on this ladder", async () => {
    // The exemption's other side, and the failure it could hide: `custom` no
    // longer stops at the pre-switch guard, so if its own case refused a
    // complete configuration every working custom deployment would break with
    // this suite green. Asserting the refusals alone cannot tell a guard that
    // throws correctly from one that always throws.
    process.env.LLM_CUSTOM_BASE_URL = "https://example.invalid/v1";
    process.env.LLM_CUSTOM_API_KEY = "sk-custom-test";
    _resetConfigCache();
    const model = await getConfiguredModel({
      // Explicit, because `DEFAULT_MODELS.custom` deliberately does not exist —
      // there is no name for this ladder to fall back to.
      provider: "custom",
      model: "some-served-model",
    });
    expect(model.modelId).toBe("some-served-model");
  });

  it("says the same thing when the WORKLOAD ladder routes the provider", async () => {
    // The other way in, and the reason the guard exists at all: nothing is
    // passed for `provider`, so it comes from the stored chat-model settings —
    // `usesPrimary` is false the moment `chatProvider` is set. A test that only
    // ever passed `provider` explicitly would leave this branch unwalked.
    seedConfig({ chatProvider: "openai" });
    expect(await refusal({ workload: "chat" })).toBe(
      `The OpenAI provider is not configured on this server. Set it in ${pointer}.`,
    );
  });

  it("leaves ollama exempt — self-hosted needs no key", async () => {
    // The guard's one carve-out. A throw here would refuse a provider that is
    // correctly configured, which is worse than the missing pointer was. The
    // MODEL ID is asserted rather than mere truthiness: any object satisfies
    // "did not throw", including one built from the wrong name.
    const model = await getConfiguredModel({ provider: "ollama" });
    expect(model.modelId).toBe(DEFAULT_MODELS.ollama);
  });
});

// ---------------------------------------------------------------------------
// The two refusals that named no field at all (DW-630, DW-631)
// ---------------------------------------------------------------------------

describe("getModel's remaining refusals name their destination", () => {
  /** Built the one sanctioned way, for the same reason the describes above do. */
  const pointer = settingsPointer("llm-models", SETTINGS_LABEL);

  let dataDir: string | null = null;
  let savedDeepseek: string | undefined;
  let savedCustomBaseUrl: string | undefined;
  let savedCustomApiKey: string | undefined;

  function seedConfig(config: Record<string, unknown>) {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-refusal-pointer-"));
    fs.writeFileSync(
      path.join(dataDir, ".llm-wiki-config.json"),
      JSON.stringify(config),
    );
    process.env.DATA_DIR = dataDir;
    _resetStorage();
    _resetConfigCache();
  }

  /** The message `callLLM` — i.e. the PRIMARY ladder — refuses with. */
  async function refusal(): Promise<string> {
    try {
      await callLLM("system", "hello");
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error("expected getModel to refuse");
  }

  beforeEach(() => {
    // The outer `beforeEach` clears every key `detectEnvProvider` consults
    // EXCEPT this one, and a real `DEEPSEEK_API_KEY` in the developer's shell
    // would auto-select a provider and make "no provider at all" unreachable.
    savedDeepseek = process.env.DEEPSEEK_API_KEY;
    savedCustomBaseUrl = process.env.LLM_CUSTOM_BASE_URL;
    savedCustomApiKey = process.env.LLM_CUSTOM_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.LLM_CUSTOM_BASE_URL;
    delete process.env.LLM_CUSTOM_API_KEY;
  });

  afterEach(() => {
    if (savedDeepseek === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = savedDeepseek;
    if (savedCustomBaseUrl === undefined) delete process.env.LLM_CUSTOM_BASE_URL;
    else process.env.LLM_CUSTOM_BASE_URL = savedCustomBaseUrl;
    if (savedCustomApiKey === undefined) delete process.env.LLM_CUSTOM_API_KEY;
    else process.env.LLM_CUSTOM_API_KEY = savedCustomApiKey;
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
    _resetStorage();
    _resetConfigCache();
  });

  it("ends the no-provider throw at the derived pointer, keeping the env var list", async () => {
    // The most common keyless state there is, and until DW-630 the one refusal
    // in this file that stopped at the bare surface word.
    const message = await refusal();
    // The WHOLE message, composed from the derived pointer. `toContain` would
    // pass on a message that had regrown a bare "…, or configure a provider in
    // Settings." clause somewhere else in the same string — which is exactly
    // the regression this test exists to catch.
    expect(message).toBe(
      "No LLM API key found. Set one of ANTHROPIC_API_KEY, OPENAI_API_KEY, " +
        "GOOGLE_GENERATIVE_AI_API_KEY, DEEPSEEK_API_KEY, OLLAMA_API_KEY, or " +
        "OLLAMA_BASE_URL / OLLAMA_MODEL in your environment, or configure a " +
        `provider in ${pointer}.`,
    );
    // Named separately as well as inside the whole-message assertion above: the
    // env var enumeration is the half an operator with no browser acts on, and
    // spelling out WHICH names are load-bearing says so to the next reader in a
    // way one long literal does not.
    expect(message).toContain("ANTHROPIC_API_KEY");
    expect(message).toContain("OLLAMA_BASE_URL / OLLAMA_MODEL");
    // SHORT form, as on every other runtime refusal raised from the LLM call.
    expect(message).not.toContain("Workbench");
  });

  it("names the Ollama Cloud gap in getModel's own voice, with a derived label", async () => {
    // `provider` is stored and `OLLAMA_API_KEY` is unset, so `getModel` reaches
    // the `ollama-cloud` case with no key. The old sentence hand-typed the
    // display label and sent the owner to an env var; both halves are derived
    // now (DW-631), and the gap is named the way the four sibling throws in
    // this function name theirs.
    seedConfig({ provider: "ollama-cloud" });
    const message = await refusal();
    expect(message).toBe(
      `The Ollama Cloud provider needs an API key. Set it in ${pointer}.`,
    );
    // The slug is an internal id; the picker shows the label.
    expect(message).not.toContain("ollama-cloud");
    expect(message).not.toContain("OLLAMA_API_KEY");
    expect(message).not.toContain("Workbench");
  });

  it("still builds an ollama-cloud model on the WORKLOAD ladder once the key is present", async () => {
    // NOT the other side of the guard DW-631 reworded. This calls
    // `getConfiguredModel`, which never enters `getModel`'s `ollama-cloud`
    // case at all — that guard's non-throwing leg is covered by
    // `src/lib/__tests__/llm-ollama-cloud.test.ts` ("uses the cloud API with
    // bearer authentication"). What this pins is the OTHER ladder reaching a
    // built model for the same credentials, so the pre-switch guard above is
    // shown to let a configured `ollama-cloud` past rather than merely to
    // refuse an unconfigured one.
    seedConfig({ provider: "ollama-cloud" });
    process.env.OLLAMA_API_KEY = "ollama-cloud-test-key";
    _resetConfigCache();
    const model = await getConfiguredModel({ provider: "ollama-cloud" });
    expect(model.modelId).toBe(DEFAULT_MODELS["ollama-cloud"]);
  });
});
