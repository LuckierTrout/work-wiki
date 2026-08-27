/**
 * Local Chat provider resolution and vendor calls.
 *
 * THE REQUEST NEVER CHOOSES THE PROVIDER. `generateChat` reads env and
 * `.llm-wiki-config.json` on this machine; caller `provider` / `apiKey` /
 * `baseUrl` are ignored. A browser-supplied key would leave the owner's
 * secret in a request body and let any local page pick the endpoint.
 *
 * Imports nothing from `src/lib` (AD-6).
 */

import fs from "node:fs";
import path from "node:path";

export const PROVIDER_TIMEOUT_MS = 60_000;
export const MAX_PROVIDER_RESPONSE_CHARS = 200_000;

export function readSidecarConfig(dataDir = process.env.DATA_DIR || process.cwd()) {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dataDir, ".llm-wiki-config.json"), "utf8"),
    );
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** @param {string} provider
 *  @param {Record<string, string | undefined>} [env]
 *  @param {Record<string, unknown>} [config] */
export function resolveChatSecret(provider, env = process.env, config = {}) {
  switch (provider) {
    case "anthropic":
      return env.ANTHROPIC_API_KEY || "";
    case "openai":
      return env.OPENAI_API_KEY || "";
    case "google":
      return env.GOOGLE_GENERATIVE_AI_API_KEY || "";
    case "deepseek":
      return env.DEEPSEEK_API_KEY || "";
    case "ollama-cloud":
      return env.OLLAMA_API_KEY || "";
    case "custom":
      return env.LLM_CUSTOM_API_KEY || config.customApiKey || "";
    default:
      return "";
  }
}

/** @param {Record<string, string | undefined>} [env] */
function detectEnvProvider(env = process.env) {
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  if (env.OPENAI_API_KEY) return "openai";
  if (env.GOOGLE_GENERATIVE_AI_API_KEY) return "google";
  if (env.DEEPSEEK_API_KEY) return "deepseek";
  if (env.OLLAMA_API_KEY) return "ollama-cloud";
  if (env.OLLAMA_BASE_URL || env.OLLAMA_MODEL) return "ollama";
  return null;
}

/** Local env/config only. Caller-selected provider identity is ignored. */
/** @param {Record<string, string | undefined>} [env]
 *  @param {Record<string, unknown>} [config] */
export function resolveChatProvider(env = process.env, config = {}) {
  return config.chatProvider || detectEnvProvider(env) || "anthropic";
}

/** Local env/config only. Caller-selected endpoints are ignored. */
/** @param {string} provider
 *  @param {Record<string, string | undefined>} [env]
 *  @param {Record<string, unknown>} [config] */
export function resolveChatEndpoint(provider, env = process.env, config = {}) {
  if (provider === "custom") return config.customBaseUrl || "";
  if (provider === "deepseek") return "https://api.deepseek.com";
  if (provider === "ollama-cloud") return "https://ollama.com/v1";
  if (provider === "ollama") {
    return env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1";
  }
  if (provider === "openai") return "https://api.openai.com/v1";
  return "";
}

function mergeAbortSignals(left, right) {
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([left, right]);
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (left.aborted || right.aborted) {
    controller.abort();
    return controller.signal;
  }
  left.addEventListener("abort", abort, { once: true });
  right.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

function providerSignal(signal) {
  const timeout = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
  return signal ? mergeAbortSignals(signal, timeout) : timeout;
}

async function readProviderJson(response) {
  const text = await response.text();
  if (text.length > MAX_PROVIDER_RESPONSE_CHARS) {
    throw new Error("Provider response too large");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Provider returned invalid JSON");
  }
}

async function callAnthropic({ apiKey, model, system, messages, signal }) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system,
      messages,
    }),
    signal,
  });
  const payload = await readProviderJson(response);
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Anthropic ${response.status}`);
  }
  const text = (payload.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return text;
}

async function callOpenAiCompatible({ apiKey, model, system, messages, baseUrl, signal }) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, ...messages],
    }),
    signal,
  });
  const payload = await readProviderJson(response);
  if (!response.ok) {
    throw new Error(payload?.error?.message || `OpenAI-compatible ${response.status}`);
  }
  return payload.choices?.[0]?.message?.content ?? "";
}

async function callGoogle({ apiKey, model, system, messages, signal }) {
  const contents = messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  }));
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
    }),
    signal,
  });
  const payload = await readProviderJson(response);
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Google ${response.status}`);
  }
  return payload.candidates?.[0]?.content?.parts?.map((part) => part.text).join("") ?? "";
}

export async function generateChat({
  provider: _ignoredProvider,
  model,
  apiKey: _ignoredApiKey,
  baseUrl: _ignoredBaseUrl,
  system,
  messages,
  signal,
} = {}) {
  const config = readSidecarConfig();
  const resolvedProvider = resolveChatProvider(process.env, config);
  const resolvedModel = config.chatModel || model || "claude-sonnet-4-5";
  const key = resolveChatSecret(resolvedProvider, process.env, config);
  if (!key && resolvedProvider !== "ollama") {
    throw new Error("Configure a Chat model in Settings.");
  }
  const resolvedBase = resolveChatEndpoint(resolvedProvider, process.env, config);
  const bounded = providerSignal(signal);
  if (resolvedProvider === "google") {
    return callGoogle({
      apiKey: key,
      model: resolvedModel,
      system,
      messages,
      signal: bounded,
    });
  }
  if (
    resolvedProvider === "openai" ||
    resolvedProvider === "deepseek" ||
    resolvedProvider === "custom"
  ) {
    if (!resolvedBase) {
      throw new Error("Configure a Chat model in Settings.");
    }
    return callOpenAiCompatible({
      apiKey: key,
      model: resolvedModel,
      system,
      messages,
      baseUrl: resolvedBase,
      signal: bounded,
    });
  }
  if (resolvedProvider === "ollama" || resolvedProvider === "ollama-cloud") {
    return callOpenAiCompatible({
      apiKey: key || "ollama",
      model: resolvedModel,
      system,
      messages,
      baseUrl: resolvedBase,
      signal: bounded,
    });
  }
  return callAnthropic({
    apiKey: key,
    model: resolvedModel,
    system,
    messages,
    signal: bounded,
  });
}
