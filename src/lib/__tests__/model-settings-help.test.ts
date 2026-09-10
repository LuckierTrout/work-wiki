import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getIngestModelSettings, DEFAULT_MODELS, type AppConfig } from "../config";
import { generateChat, resolveChatProvider } from "../../../sidecar/chat-provider.mjs";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "model-help-"));
  vi.stubEnv("DATA_DIR", directory);
  // Neither provider discovery nor the test transport may use host credentials.
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY", "OLLAMA_API_KEY", "OLLAMA_CLOUD_API_KEY", "OLLAMA_BASE_URL", "LLM_PROVIDER", "LLM_MODEL"]) vi.stubEnv(key, undefined);
});
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

it.each([
  [{}, "primary-model"],
  [{ ingestModel: "saved-model" }, "saved-model"],
  [{ ingestProvider: "openai" }, DEFAULT_MODELS.openai],
  [{ ingestProvider: "openai", ingestModel: "saved-model" }, "saved-model"],
] as const)("resolves the Ingest combinations described by the help: %j", (override, model) => {
  const cfg: AppConfig = { provider: "openai", model: "primary-model", ...override };
  expect(getIngestModelSettings(cfg)).toMatchObject({ provider: "openai", model });
});

it.each([
  [{ chatModel: "sidecar-model" }, "browser-model", "sidecar-model"],
  [{}, "browser-model", "browser-model"],
  [{}, undefined, "claude-sonnet-4-5"],
] as const)("uses the sidecar model precedence described by Chat help: %j", async (override, model, expected) => {
  vi.stubEnv("OPENAI_API_KEY", "synthetic");
  await writeFile(join(directory, ".llm-wiki-config.json"), JSON.stringify({
    provider: "google", model: "primary-ignored", chatProvider: "openai", ...override,
  }));
  const fetch = vi.fn(async (_url, init) => {
    expect(JSON.parse(init.body).model).toBe(expected);
    return Response.json({ choices: [{ message: { content: "Synthetic response" } }] });
  });
  vi.stubGlobal("fetch", fetch);
  expect(await generateChat({ model, system: "Test", messages: [{ role: "user", content: "Test" }] })).toBe("Synthetic response");
  expect(fetch).toHaveBeenCalledOnce();
});

it("detects an unset Chat provider from the sidecar environment, independently of primary", () => {
  expect(resolveChatProvider({ OPENAI_API_KEY: "synthetic" }, { provider: "google" })).toBe("openai");
  expect(resolveChatProvider({}, { provider: "google" })).toBe("anthropic");
  expect(resolveChatProvider({ OPENAI_API_KEY: "synthetic" }, { chatProvider: "google" })).toBe("google");
});

it("does not promise a default model for a Custom provider with none configured", () => {
  expect(getIngestModelSettings({ provider: "openai", model: "primary-model", ingestProvider: "custom" }))
    .toMatchObject({ provider: "custom", model: null, configured: false });
});
