import { describe, it, expect } from "vitest";
import {
  PROVIDER_INFO,
  VALID_PROVIDERS,
  DEFAULT_MODELS,
  WORKERS_AI_MODEL_PREFIX,
  WORKERS_AI_EMBEDDING_DIMENSIONS,
  WORKERS_AI_EMBEDDING_MODEL_IDS,
  embeddingModelMatchesProvider,
  isWorkersAiEmbeddingModel,
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

  it("REFUSES the bare prefix under workers-ai — the leg is a catalog, not a namespace (DW-220)", () => {
    // `"@cf/"` is inside the namespace and used to pass, which meant the gate
    // approved an id `ai.run()` rejects — a gate that approves an id nothing can
    // serve. Membership answers the question the caller is actually asking.
    expect(embeddingModelMatchesProvider("workers-ai", WORKERS_AI_MODEL_PREFIX)).toBe(
      false,
    );
    // The other leg is unchanged: the bare prefix is still `@cf/`-shaped, so it
    // is still out of bounds under every non-Workers provider.
    expect(embeddingModelMatchesProvider("openai", WORKERS_AI_MODEL_PREFIX)).toBe(false);
  });

  it("refuses a real Workers AI model that is not an EMBEDDING model", () => {
    // A vision model is a genuine Cloudflare id in the genuine namespace — and
    // exactly the wrong thing to hand an embedding call. It failed only at
    // `ai.run()` before.
    expect(
      embeddingModelMatchesProvider("workers-ai", "@cf/llava-hf/llava-1.5-7b-hf"),
    ).toBe(false);
    expect(
      embeddingModelMatchesProvider("workers-ai", "@cf/meta/llama-3.1-8b-instruct"),
    ).toBe(false);
  });

  it("accepts EVERY id in the shipped catalog under workers-ai", () => {
    // The whole table, not a sample: an id in `WORKERS_AI_EMBEDDING_DIMENSIONS`
    // is one `embeddings.ts` dimension-checks, so the gate must not refuse it.
    for (const id of Object.keys(WORKERS_AI_EMBEDDING_DIMENSIONS)) {
      expect(embeddingModelMatchesProvider("workers-ai", id)).toBe(true);
      // …and the same id remains out of bounds everywhere else.
      expect(embeddingModelMatchesProvider("openai", id)).toBe(false);
    }
  });

  it("does not treat prototype keys as model ids", () => {
    // An OWN-PROPERTY test (`hasOwnProperty.call`), not `in`: `"constructor" in
    // {}` is true, and a settings surface that let it through would approve a
    // "model" nothing can serve.
    expect(embeddingModelMatchesProvider("workers-ai", "constructor")).toBe(false);
    expect(embeddingModelMatchesProvider("workers-ai", "toString")).toBe(false);
    expect(embeddingModelMatchesProvider("workers-ai", "__proto__")).toBe(false);
    expect(isWorkersAiEmbeddingModel("constructor")).toBe(false);
    expect(isWorkersAiEmbeddingModel("hasOwnProperty")).toBe(false);
  });

  it("is CASE-SENSITIVE, deliberately", () => {
    // `@CF/…` is neither a catalog key nor inside the `@cf/` namespace, and the
    // two legs read that fact in OPPOSITE directions: under workers-ai it is not
    // in the catalog, so it is REFUSED; under OpenAI the leg only asks whether
    // the id is `@cf/`-shaped, and `@CF/` is not, so it is ACCEPTED — as an
    // ordinary OpenAI model name would be. Refusing it under workers-ai is the
    // point rather than a rough edge: `resolveEmbeddingModelName` applies this
    // same helper and would drop the id for the provider default, so approving
    // it here would let the gate accept a model the resolver replaces — the bug
    // DW-73 fixes.
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

  it("does NOT trim — both callers hand it an already-trimmed value", () => {
    // A trimming predicate would re-open the gate/resolver split from the other
    // side (DW-221): the trim belongs in the ONE read both callers share, so
    // that "what the gate approved" and "what is sent" are the same string.
    expect(embeddingModelMatchesProvider("workers-ai", " @cf/baai/bge-m3")).toBe(false);
    expect(embeddingModelMatchesProvider("workers-ai", "@cf/baai/bge-m3 ")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The Workers AI embedding catalog — ONE table (DW-220)
// ---------------------------------------------------------------------------

describe("WORKERS_AI_EMBEDDING_MODEL_IDS", () => {
  it("is derived from the dimensions table, not a second list", () => {
    // Two lists would drift, and the drift would be invisible: the gate would
    // name ids the dimension check does not know, or refuse ids it does.
    expect([...WORKERS_AI_EMBEDDING_MODEL_IDS]).toEqual(
      Object.keys(WORKERS_AI_EMBEDDING_DIMENSIONS),
    );
    expect(WORKERS_AI_EMBEDDING_MODEL_IDS.length).toBe(4);
  });

  it("names only ids inside the Workers AI namespace, each with a width", () => {
    for (const id of WORKERS_AI_EMBEDDING_MODEL_IDS) {
      expect(id.startsWith(WORKERS_AI_MODEL_PREFIX)).toBe(true);
      expect(WORKERS_AI_EMBEDDING_DIMENSIONS[id]).toBeGreaterThan(0);
      expect(isWorkersAiEmbeddingModel(id)).toBe(true);
    }
  });

  it("still carries the widths `embeddings.ts` checks returned vectors against", () => {
    expect(WORKERS_AI_EMBEDDING_DIMENSIONS["@cf/baai/bge-m3"]).toBe(1024);
    expect(WORKERS_AI_EMBEDDING_DIMENSIONS["@cf/baai/bge-large-en-v1.5"]).toBe(1024);
    expect(WORKERS_AI_EMBEDDING_DIMENSIONS["@cf/baai/bge-base-en-v1.5"]).toBe(768);
    expect(WORKERS_AI_EMBEDDING_DIMENSIONS["@cf/baai/bge-small-en-v1.5"]).toBe(384);
  });
});
