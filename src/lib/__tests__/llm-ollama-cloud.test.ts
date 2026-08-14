import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createOllamaMock, generateTextMock } = vi.hoisted(() => ({
  createOllamaMock: vi.fn(() => vi.fn((id: string) => ({ id }))),
  generateTextMock: vi.fn(async () => ({ text: "OK" })),
}));

vi.mock("ollama-ai-provider-v2", () => ({ createOllama: createOllamaMock }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: vi.fn(() => vi.fn()) }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: vi.fn(() => vi.fn()) }));
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: vi.fn(() => vi.fn()),
}));
vi.mock("ai", () => ({
  generateText: generateTextMock,
  streamText: vi.fn(() => ({ toTextStreamResponse: vi.fn() })),
}));

import { callLLM } from "../llm";
import { _resetConfigCache } from "../config";
import { _resetStorage } from "../storage";

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OLLAMA_API_KEY",
  "OLLAMA_BASE_URL",
  "OLLAMA_MODEL",
  "LLM_MODEL",
  "DATA_DIR",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.DATA_DIR = "/tmp/yopedia-ollama-cloud-test";
  process.env.OLLAMA_API_KEY = "ollama-cloud-secret";
  vi.clearAllMocks();
  _resetConfigCache();
  _resetStorage();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  _resetConfigCache();
  _resetStorage();
});

describe("Ollama Cloud model construction", () => {
  it("uses the cloud API with bearer authentication", async () => {
    await callLLM("system", "message");

    expect(createOllamaMock).toHaveBeenCalledWith({
      baseURL: "https://ollama.com/api",
      headers: { Authorization: "Bearer ollama-cloud-secret" },
      compatibility: "strict",
    });
    const provider = createOllamaMock.mock.results[0].value;
    expect(provider).toHaveBeenCalledWith("gpt-oss:120b");
    expect(generateTextMock).toHaveBeenCalledOnce();
  });
});
