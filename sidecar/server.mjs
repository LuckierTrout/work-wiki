/**
 * Chat-only loopback sidecar. Binds 127.0.0.1:19828.
 * Does not import src/lib, Next, or Clerk.
 *
 * Secrets stay on this machine: `pnpm sidecar` loads project `.env` / `.env.local`
 * and may read `.llm-wiki-config.json` for Chat provider/model/custom key.
 * Request bodies must never carry `apiKey`.
 */
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

export const SIDECAR_HOST = "127.0.0.1";
export const SIDECAR_PORT = 19828;
export const SSE_EVENTS = ["meta", "agent", "done", "cancelled", "error"];
export const PROVIDER_TIMEOUT_MS = 60_000;
export const MAX_PROVIDER_RESPONSE_CHARS = 200_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i;
const COVERAGE_COPY =
  "Wiki has no coverage for this. Ingest a source or run Deep Research.";
const CITATION_MARKER_RE = /\[([1-9]\d*)\]/g;

export function healthPayload() {
  return {
    ok: true,
    status: "ok",
    version: typeof pkg.version === "string" ? pkg.version : "0.1.0",
    enabled: true,
    authRequired: false,
    authConfigured: false,
    allowUnauthenticated: true,
    tokenSource: "none",
  };
}

export function isSidecarWikiId(value) {
  return value === "current" || UUID_RE.test(value);
}

export function formatSse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function parseDotEnv(text) {
  const out = {};
  if (typeof text !== "string") return out;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** @param {string} text
 *  @param {Record<string, string | undefined>} [env] */
export function applyDotEnv(text, env = process.env) {
  const parsed = parseDotEnv(text);
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}

export function loadSidecarEnvFromFiles(rootDir) {
  for (const name of [".env", ".env.local"]) {
    try {
      applyDotEnv(fs.readFileSync(path.join(rootDir, name), "utf8"));
    } catch (error) {
      if (error && error.code !== "ENOENT") throw error;
    }
  }
}

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

export function allowSidecarOrigin(origin) {
  if (!origin) return true;
  return LOOPBACK_ORIGIN_RE.test(origin);
}

export function sanitizeCitedAnswer(content, citations, coverageCopy = COVERAGE_COPY) {
  const byN = new Map();
  for (const row of Array.isArray(citations) ? citations : []) {
    if (
      !row ||
      typeof row !== "object" ||
      !Number.isInteger(row.n) ||
      row.n < 1 ||
      typeof row.path !== "string" ||
      !row.path.trim()
    ) {
      continue;
    }
    if (!byN.has(row.n)) byN.set(row.n, row);
  }
  const used = new Set();
  const invented = new Set();
  const text = typeof content === "string" ? content : "";
  for (const match of text.matchAll(CITATION_MARKER_RE)) {
    const n = Number(match[1]);
    if (byN.has(n)) used.add(n);
    else invented.add(n);
  }
  let next = text;
  for (const n of invented) next = next.replaceAll(`[${n}]`, "");
  next = next.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (used.size === 0) {
    return { content: coverageCopy, citations: [], coverage: false };
  }
  return {
    content: next,
    citations: [...used]
      .sort((a, b) => a - b)
      .map((n) => byN.get(n)),
    coverage: true,
  };
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

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createChatTurnSession(req, res, stream) {
  const controller = new AbortController();
  let settled = false;

  const emitCancelled = () => {
    if (settled) return;
    settled = true;
    controller.abort();
    if (!stream || res.writableEnded) return;
    if (!res.headersSent) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
    }
    try {
      res.write(formatSse("cancelled", {}));
    } catch {
      // Client already gone.
    }
    res.end();
  };

  const settle = () => {
    settled = true;
  };

  if (typeof req.on === "function") {
    // Do not listen to req "close": it fires after the body is read, which
    // would abort every turn. aborted / socket close mean the client left.
    req.on("aborted", emitCancelled);
  }
  if (req.socket && typeof req.socket.on === "function") {
    req.socket.on("close", () => {
      if (!settled) emitCancelled();
    });
  }

  return { signal: controller.signal, emitCancelled, settle };
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && allowSidecarOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function extractThinking(text) {
  const match = text.match(/<thinking>([\s\S]*?)<\/thinking>/i);
  if (!match) return { thinking: "", content: text };
  return {
    thinking: match[1].trim(),
    content: text.replace(match[0], "").trim(),
  };
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

function chatPath(url) {
  const match = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/chat$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function isAbortError(error) {
  return (
    error?.name === "AbortError" ||
    (error instanceof Error && /aborted|abort/i.test(error.message))
  );
}

function rejectChat(res, status, error) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error }));
}

function parseHistory(value) {
  if (value === undefined) return { messages: [] };
  if (!Array.isArray(value)) return { error: "messages must be an array" };
  const messages = [];
  for (const item of value) {
    if (!isPlainObject(item)) return { error: "invalid history row" };
    if (item.role !== "user" && item.role !== "assistant") {
      return { error: "invalid history role" };
    }
    if (typeof item.content !== "string") {
      return { error: "invalid history content" };
    }
    messages.push({ role: item.role, content: item.content });
  }
  return { messages };
}

function parseCitations(value) {
  if (value === undefined) return { citations: [] };
  if (!Array.isArray(value)) return { error: "citations must be an array" };
  const citations = [];
  for (const item of value) {
    if (!isPlainObject(item)) return { error: "invalid citation" };
    if (
      !Number.isInteger(item.n) ||
      item.n < 1 ||
      typeof item.path !== "string" ||
      !item.path.trim() ||
      typeof item.title !== "string" ||
      typeof item.type !== "string"
    ) {
      return { error: "invalid citation" };
    }
    citations.push({
      n: item.n,
      path: item.path.trim(),
      title: item.title,
      type: item.type,
    });
  }
  return { citations };
}

async function handleChat(req, res, wikiId) {
  if (!isSidecarWikiId(wikiId)) {
    rejectChat(res, 400, "invalid_wiki_id");
    return;
  }
  let body;
  try {
    body = await readBody(req);
  } catch {
    rejectChat(res, 400, "invalid JSON");
    return;
  }
  if (!isPlainObject(body)) {
    rejectChat(res, 400, "invalid JSON");
    return;
  }
  const historyParsed = parseHistory(body.messages);
  if (historyParsed.error) {
    rejectChat(res, 400, historyParsed.error);
    return;
  }
  const citationParsed = parseCitations(body.citations);
  if (citationParsed.error) {
    rejectChat(res, 400, citationParsed.error);
    return;
  }
  const context = typeof body.context === "string" ? body.context : "";
  const query =
    typeof body.query === "string" ? body.query.trim() : "";
  if (!query && context.trim() && body.coverage !== false) {
    rejectChat(res, 400, "query is required");
    return;
  }
  const stream =
    body.stream === true ||
    String(req.headers.accept || "").includes("text/event-stream");
  const session = createChatTurnSession(req, res, stream);
  const citations = citationParsed.citations;
  const history = historyParsed.messages;
  const system = [
    typeof body.system === "string" ? body.system : "",
    context ? `NUMBERED CONTEXT\n${context}` : "",
    typeof body.indexSlice === "string" && body.indexSlice
      ? `INDEX\n${body.indexSlice}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const done = async (payload) => {
    session.settle();
    if (!stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(formatSse("meta", { wikiId }));
    if (payload.thinking) {
      res.write(formatSse("agent", { thinking: payload.thinking, delta: "" }));
    }
    if (payload.content) {
      res.write(formatSse("agent", { delta: payload.content }));
    }
    res.write(formatSse("done", payload));
    res.end();
  };

  if (body.coverage === false || !context.trim()) {
    await done({
      content: COVERAGE_COPY,
      thinking: "",
      citations: [],
      coverage: false,
    });
    return;
  }

  const userText =
    query ||
    history.filter((item) => item.role === "user").at(-1)?.content ||
    "";
  const messages = [...history];
  if (!messages.some((item) => item.role === "user" && item.content === userText) && userText) {
    messages.push({ role: "user", content: userText });
  }

  try {
    const raw = await generateChat({
      model: typeof body.model?.model === "string" ? body.model.model : undefined,
      system,
      messages,
      signal: session.signal,
    });
    if (session.signal.aborted) {
      session.emitCancelled();
      return;
    }
    const split = extractThinking(raw);
    const sanitized = sanitizeCitedAnswer(split.content, citations);
    await done({
      content: sanitized.content,
      thinking: split.thinking,
      citations: sanitized.citations,
      coverage: sanitized.coverage,
    });
  } catch (error) {
    if (session.signal.aborted || isAbortError(error)) {
      session.emitCancelled();
      return;
    }
    session.settle();
    const message = error instanceof Error ? error.message : "Chat failed.";
    if (!stream) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: message }));
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
    });
    res.write(formatSse("error", { message }));
    res.end();
  }
}

export function createSidecarServer() {
  return http.createServer(async (req, res) => {
    cors(req, res);
    const url = new URL(req.url || "/", `http://${SIDECAR_HOST}:${SIDECAR_PORT}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v1/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(healthPayload()));
      return;
    }
    const wikiId = req.method === "POST" ? chatPath(url) : null;
    if (wikiId) {
      await handleChat(req, res, wikiId);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  loadSidecarEnvFromFiles(path.resolve(fileURLToPath(new URL("..", import.meta.url))));
  const server = createSidecarServer();
  server.listen(SIDECAR_PORT, SIDECAR_HOST, () => {
    process.stdout.write(
      `work-wiki sidecar listening on http://${SIDECAR_HOST}:${SIDECAR_PORT}\n`,
    );
  });
  // Extract is a second capability of the SAME process, started after the
  // listener so a Chat health probe never waits on a document parse. It is a
  // client of the kernel, not a route on this server: nothing outside this
  // machine can ask the sidecar to parse anything.
  const { startExtractLoop } = await import("./extract-loop.mjs");
  startExtractLoop({
    log: (message) => process.stdout.write(`${message}\n`),
  });
}
