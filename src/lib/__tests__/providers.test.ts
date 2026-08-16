import { describe, it, expect } from "vitest";
import {
  PROVIDER_INFO,
  VALID_PROVIDERS,
  DEFAULT_MODELS,
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
