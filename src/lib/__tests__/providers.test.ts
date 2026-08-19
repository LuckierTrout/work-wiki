import { describe, it, expect } from "vitest";
import {
  PROVIDER_INFO,
  VALID_PROVIDERS,
  DEFAULT_MODELS,
  WORKERS_AI_MODEL_PREFIX,
  embeddingModelMatchesProvider,
  providerLabel,
} from "../providers";

// ---------------------------------------------------------------------------
// PROVIDER_INFO
// ---------------------------------------------------------------------------

describe("PROVIDER_INFO", () => {
  it("has entries for every supported provider", () => {
    const values = PROVIDER_INFO.map((p) => p.value);
    expect(values).toContain("anthropic");
    expect(values).toContain("openai");
    expect(values).toContain("google");
    expect(values).toContain("deepseek");
    expect(values).toContain("ollama-cloud");
    expect(values).toContain("ollama");
    // Story 1.9: an owner-pointed OpenAI-compatible endpoint.
    expect(values).toContain("custom");
  });

  it("has exactly 7 providers", () => {
    expect(PROVIDER_INFO).toHaveLength(7);
  });

  it("each entry has value and label properties", () => {
    for (const entry of PROVIDER_INFO) {
      expect(typeof entry.value).toBe("string");
      expect(typeof entry.label).toBe("string");
      expect(entry.value.length).toBeGreaterThan(0);
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  it("labels are human-readable (capitalized)", () => {
    for (const entry of PROVIDER_INFO) {
      // Label should start with an uppercase letter
      expect(entry.label[0]).toBe(entry.label[0].toUpperCase());
    }
  });
});

// ---------------------------------------------------------------------------
// VALID_PROVIDERS
// ---------------------------------------------------------------------------

describe("VALID_PROVIDERS", () => {
  it("is a Set containing exactly the 7 provider values", () => {
    expect(VALID_PROVIDERS).toBeInstanceOf(Set);
    expect(VALID_PROVIDERS.size).toBe(7);
    expect(VALID_PROVIDERS.has("custom")).toBe(true);
    expect(VALID_PROVIDERS.has("anthropic")).toBe(true);
    expect(VALID_PROVIDERS.has("openai")).toBe(true);
    expect(VALID_PROVIDERS.has("google")).toBe(true);
    expect(VALID_PROVIDERS.has("deepseek")).toBe(true);
    expect(VALID_PROVIDERS.has("ollama-cloud")).toBe(true);
    expect(VALID_PROVIDERS.has("ollama")).toBe(true);
  });

  it("does not contain unknown providers", () => {
    expect(VALID_PROVIDERS.has("azure")).toBe(false);
    expect(VALID_PROVIDERS.has("")).toBe(false);
    expect(VALID_PROVIDERS.has("ANTHROPIC")).toBe(false);
  });

  it("matches PROVIDER_INFO values exactly", () => {
    const infoValues = new Set(PROVIDER_INFO.map((p) => p.value));
    expect(VALID_PROVIDERS).toEqual(infoValues);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_MODELS
// ---------------------------------------------------------------------------

describe("DEFAULT_MODELS", () => {
  it("has a default model for every provider that can have one", () => {
    for (const provider of VALID_PROVIDERS) {
      // `custom` is an endpoint the owner points at, so no model name here
      // could be right — the owner types one. See DEFAULT_MODELS' docblock.
      if (provider === "custom") continue;
      expect(DEFAULT_MODELS[provider]).toBeDefined();
      expect(typeof DEFAULT_MODELS[provider]).toBe("string");
      expect(DEFAULT_MODELS[provider].length).toBeGreaterThan(0);
    }
  });

  it("has exactly 6 entries — one per provider except `custom`", () => {
    expect(Object.keys(DEFAULT_MODELS)).toHaveLength(6);
    expect(DEFAULT_MODELS.custom).toBeUndefined();
  });

  it("deepseek default model is deepseek-v4-flash", () => {
    expect(DEFAULT_MODELS.deepseek).toBe("deepseek-v4-flash");
  });

  it("anthropic default model contains claude", () => {
    expect(DEFAULT_MODELS.anthropic.toLowerCase()).toContain("claude");
  });

  it("openai default model contains gpt", () => {
    expect(DEFAULT_MODELS.openai.toLowerCase()).toContain("gpt");
  });
});

// ---------------------------------------------------------------------------
// providerLabel
// ---------------------------------------------------------------------------

describe("providerLabel", () => {
  it("returns 'Anthropic' for 'anthropic'", () => {
    expect(providerLabel("anthropic")).toBe("Anthropic");
  });

  it("returns 'OpenAI' for 'openai'", () => {
    expect(providerLabel("openai")).toBe("OpenAI");
  });

  it("returns 'Google' for 'google'", () => {
    expect(providerLabel("google")).toBe("Google");
  });

  it("distinguishes Ollama Cloud from self-hosted Ollama", () => {
    expect(providerLabel("ollama-cloud")).toBe("Ollama Cloud");
    expect(providerLabel("ollama")).toBe("Ollama (self-hosted)");
  });

  it("returns 'DeepSeek' for 'deepseek'", () => {
    expect(providerLabel("deepseek")).toBe("DeepSeek");
  });

  it("returns raw string for unknown provider", () => {
    expect(providerLabel("azure")).toBe("azure");
  });

  it("returns raw string for empty string", () => {
    expect(providerLabel("")).toBe("");
  });

  it("is case-sensitive — 'Anthropic' is unknown", () => {
    expect(providerLabel("Anthropic")).toBe("Anthropic");
  });
});

// ---------------------------------------------------------------------------
// embeddingModelMatchesProvider — the Workers AI namespace boundary (DW-73)
// ---------------------------------------------------------------------------

describe("embeddingModelMatchesProvider", () => {
  // This helper is the SINGLE statement of a rule two modules depend on:
  // `embeddings.ts`'s `resolveEmbeddingModelName` drops an override that fails
  // it, and `workbench-settings.ts`'s vector gate refuses the same combination
  // at the Settings surface. Everything else that covers it reaches it through
  // one of those two callers, which means the boundary inputs below — the empty
  // string, the bare prefix, a differently-cased prefix — have no home anywhere
  // else. They live here, in the suite for the module that owns the rule.

  it("accepts a Workers AI id under workers-ai", () => {
    expect(embeddingModelMatchesProvider("workers-ai", "@cf/baai/bge-m3")).toBe(true);
    expect(embeddingModelMatchesProvider("workers-ai", "@cf/baai/bge-large-en-v1.5")).toBe(
      true,
    );
  });

  it("accepts a non-Workers-AI id under every keyed or self-hosted provider", () => {
    expect(embeddingModelMatchesProvider("openai", "text-embedding-3-small")).toBe(true);
    expect(embeddingModelMatchesProvider("google", "gemini-embedding-001")).toBe(true);
    expect(embeddingModelMatchesProvider("ollama", "nomic-embed-text")).toBe(true);
  });

  it("refuses BOTH directions — it is an equality, not a ban on @cf/", () => {
    expect(embeddingModelMatchesProvider("workers-ai", "text-embedding-3-small")).toBe(
      false,
    );
    expect(embeddingModelMatchesProvider("openai", "@cf/baai/bge-m3")).toBe(false);
    expect(embeddingModelMatchesProvider("google", "@cf/baai/bge-m3")).toBe(false);
    expect(embeddingModelMatchesProvider("ollama", "@cf/baai/bge-m3")).toBe(false);
  });

  it("treats the empty string as OUT of the namespace", () => {
    // Not a judgement about emptiness: `"".startsWith("@cf/")` is false, so ""
    // is out-of-namespace and matches every provider except workers-ai. Callers
    // never pass it — the gate checks `!v.model` first and the resolver only
    // reaches here for a truthy override — but the answer is pinned so a future
    // caller cannot discover it by accident.
    expect(embeddingModelMatchesProvider("openai", "")).toBe(true);
    expect(embeddingModelMatchesProvider("workers-ai", "")).toBe(false);
  });

  it("accepts the BARE prefix under workers-ai — this is a namespace test, not a catalog", () => {
    // `"@cf/"` is in the namespace and nothing more is claimed: the helper says
    // where an id lives, not whether Workers AI serves it. A bare prefix fails
    // later, at `ai.run()`, which is the documented boundary of this rule.
    expect(embeddingModelMatchesProvider("workers-ai", WORKERS_AI_MODEL_PREFIX)).toBe(true);
    expect(embeddingModelMatchesProvider("openai", WORKERS_AI_MODEL_PREFIX)).toBe(false);
  });

  it("is CASE-SENSITIVE, deliberately", () => {
    // `@CF/…` is not in the namespace, so under workers-ai it is refused by a
    // sentence naming `@cf/`. That is the point rather than a rough edge:
    // `resolveEmbeddingModelName` applies this same helper and would drop the id
    // for the provider default, so accepting it here would let the gate approve
    // a model the resolver silently replaces — the exact bug DW-73 fixes.
    expect(embeddingModelMatchesProvider("workers-ai", "@CF/baai/bge-m3")).toBe(false);
    expect(embeddingModelMatchesProvider("openai", "@CF/baai/bge-m3")).toBe(true);
  });

  it("is the prefix constant, not a second copy of the literal", () => {
    // If the prefix ever moves, this is the assertion that fails first.
    expect(WORKERS_AI_MODEL_PREFIX).toBe("@cf/");
    expect(
      embeddingModelMatchesProvider("workers-ai", `${WORKERS_AI_MODEL_PREFIX}baai/bge-m3`),
    ).toBe(true);
  });
});
