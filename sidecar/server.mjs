/**
 * The loopback sidecar. Binds 127.0.0.1:19828 and nothing else.
 *
 * Does not import src/lib, Next, or Clerk (AD-6). The rules the door enforces —
 * who gets in, how many at once, what health says — live in `loopback.mjs` as
 * pure functions the node suite executes; this file is the HTTP shell around
 * them plus the Chat Agent.
 *
 * WHAT IT OWNS versus what it forwards (Story 8.2): health is about this
 * listener, Chat and shell run the local Agent, and Skills are files on this
 * disk — so those four are answered here. Every other `/api/v1` path is
 * reverse-proxied to the kernel with an identical body, because the kernel is
 * the system of record for wiki data and a second implementation on this side
 * would be a second answer to "what does the wiki say".
 *
 * Secrets stay on this machine: `pnpm sidecar` loads project `.env` / `.env.local`
 * and may read `.llm-wiki-config.json` for Chat provider/model/custom key.
 * Request bodies must never carry `apiKey`.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  LOOPBACK_HOST,
  LOOPBACK_PORT,
  LOOPBACK_TOKEN_HEADER,
  V1_MAX_BODY_BYTES,
  authorizeLoopback,
  createLoadGate,
  createLoopbackSettingsSource,
  createWikiRegistrySource,
  extractToken,
  healthPayload as buildHealthPayload,
  kernelProxyPath,
  isSidecarOwnedPath,
  canonicalLoopbackWikiId,
  resolveLoopbackWikiId,
  wikiRegistryRows,
} from "./loopback.mjs";
import { createAgentWorkspace } from "./workspace.mjs";
import { scanSkills } from "./skills.mjs";
import {
  resumeAgentTurn,
  runAgentTurn,
  toolsForTurn,
  withSelectedSkill,
} from "./agent.mjs";
import {
  createCapabilityStore,
  createConversationApprovals,
  publicPending,
} from "./capabilities.mjs";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

export const SIDECAR_HOST = LOOPBACK_HOST;
export const SIDECAR_PORT = LOOPBACK_PORT;
export const SSE_EVENTS = ["meta", "agent", "done", "cancelled", "error"];
export const PROVIDER_TIMEOUT_MS = 60_000;
export const MAX_PROVIDER_RESPONSE_CHARS = 200_000;
/** How often the door re-asks the kernel what the owner saved. */
export const SETTINGS_POLL_INTERVAL_MS = 15_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i;
const COVERAGE_COPY =
  "Wiki has no coverage for this. Ingest a source or run Deep Research.";
const CITATION_MARKER_RE = /\[([1-9]\d*)\]/g;

export const SIDECAR_VERSION =
  typeof pkg.version === "string" ? pkg.version : "0.1.0";

function clientConversationId(body) {
  return typeof body?.conversationId === "string" && body.conversationId.trim()
    ? body.conversationId.trim()
    : "";
}

/**
 * This process's honest health.
 *
 * `status` describes THE LISTENER — `starting` until the bind resolves,
 * `running` after it, `port_conflict` when somebody else already owns 19828,
 * `error` when it died. Epic 3 answered a flat `"ok"` with `enabled: true` and
 * `allowUnauthenticated: true` hard-coded, which said nothing about whether the
 * process answering was this one and nothing true about the door at all.
 *
 * The stubbed booleans are gone with it: `enabled`, `authRequired`,
 * `authConfigured`, `allowUnauthenticated` and `tokenSource` are all derived
 * from the settings the poller resolved, which is what makes the branded skill's
 * "if `authConfigured` is false, ask for a token and stop" possible.
 */
export function healthPayload({ status = "running", settings = null } = {}) {
  return buildHealthPayload({ status, version: SIDECAR_VERSION, settings });
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

export function sanitizeCitedAnswer(
  content,
  citations,
  coverageCopy = COVERAGE_COPY,
  extras = {},
) {
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
    const rows = [...byN.values()];
    const typed = rows.some(
      (row) =>
        row.type === "source" ||
        row.type === "web" ||
        row.type === "graph" ||
        row.type === "workspace",
    );
    if (extras.allowUncited === true || typed) {
      return { content: next, citations: rows, coverage: rows.length > 0 };
    }
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

/**
 * CORS, with the Epic 3 origin allowlist intact.
 *
 * STILL AN ALLOWLIST, and still echoing the request's own origin rather than
 * `*`. That matters more now than it did in Epic 3, not less: with credentials
 * in play, `Access-Control-Allow-Origin: *` would let any page the owner's
 * browser happens to load read this wiki through the browser's own loopback
 * access.
 *
 * The two token headers join the allowed list because the Workbench sends them
 * from the browser — a preflight that refused `Authorization` would make the
 * token unusable from the one client that is guaranteed to be on this machine.
 * `PATCH` joins the methods for the same reason: Review actions are patches.
 */
function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && allowSidecarOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    `Content-Type, Accept, Authorization, ${LOOPBACK_TOKEN_HEADER}`,
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > V1_MAX_BODY_BYTES) {
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
  // The alias means `current`: on the loopback door there is exactly one
  // workspace, and a client that omitted the project meant this one.
  if (url.pathname === "/api/v1/chat") return "current";
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

function resumeCapabilityId(resume) {
  if (typeof resume?.capabilityId === "string" && resume.capabilityId) {
    return resume.capabilityId;
  }
  if (
    isPlainObject(resume?.pending) &&
    typeof resume.pending.capabilityId === "string" &&
    resume.pending.capabilityId
  ) {
    return resume.pending.capabilityId;
  }
  return null;
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

/**
 * One tool-using turn, streamed.
 *
 * TOOL ROWS STREAM AS THEY HAPPEN and the `done` frame is still the COMPLETE
 * aggregate — both, not either. A client that joined late, or one that only
 * reads `done` (the non-streaming JSON caller is exactly that), must end up with
 * the same turn as one that watched every row. So `runAgentTurn`'s `emit` writes
 * rows to the wire while they run, and the payload assembled at the end carries
 * every row again.
 *
 * `pending` rides on `done` rather than on a new event name: a shell approval or
 * a Skill form is the turn's OUTCOME for now — the surface draws a modal and
 * sends the answer back — and inventing a sixth SSE event for it would break
 * every client filtering on the locked five.
 */
async function runToolTurn({
  res,
  body,
  wikiId,
  session,
  stream,
  system,
  messages,
  citations,
  options,
  resumePending,
}) {
  let opened = false;
  const open = () => {
    if (opened || !stream) return;
    opened = true;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(formatSse("meta", { wikiId, tools: true }));
  };
  const emit = (event, payload) => {
    if (!stream) return;
    open();
    res.write(formatSse(event, payload));
  };

  const workspace = options.workspace ?? createAgentWorkspace();
  const enablement = options.settings?.skillEnablement ?? {};
  // Mint when the body omits one so a ticket is never stored under "". Resume
  // uses the client-supplied id only — a second omitted body gets a new mint
  // and cannot take the first ticket.
  const conversationId =
    clientConversationId(body) || `anon:${randomBytes(16).toString("hex")}`;
  const context = {
    wikiId,
    workspace,
    // FROM THE SETTINGS POLL, never from the request body. A caller-supplied
    // enablement map would let any local process re-enable a Skill the owner
    // switched off in Settings, which would make the switch decorative.
    enablement,
    approvedExecutables: options.approvals.setFor(conversationId),
    kernel: (pathname, init) => kernelFetch(options.kernel, pathname, init),
  };
  const tools = toolsForTurn(body.allowWrites !== false);
  system = await withSelectedSkill(system, body.skill, enablement);
  const generate = ({ system: sys, messages: msgs }) =>
    generateChat({
      model: typeof body.model?.model === "string" ? body.model.model : undefined,
      system: sys,
      messages: msgs,
      signal: session.signal,
    });

  // A RESUME rather than a fresh turn when the owner answered an approval. The
  // pending record carries the transcript, so nothing gathered before the
  // question is re-fetched.
  const result = resumePending
    ? await resumeAgentTurn({
        pending: resumePending,
        // EXPLICIT TRUE ONLY. A resume that arrived without the flag — a client
        // bug, a truncated body — must read as Deny/Cancel, because the failure
        // mode of the other default is running a command nobody approved.
        approved: body.resume.approved === true,
        answers: isPlainObject(body.resume.answers) ? body.resume.answers : {},
        generate,
        emit,
        system,
        context,
        tools,
      })
    : await runAgentTurn({ generate, emit, messages, system, context, tools });

  if (session.signal.aborted) {
    session.emitCancelled();
    return;
  }
  session.settle();
  const split = extractThinking(result.content);
  // Cited against what the TOOLS found, falling back to what the caller
  // assembled. The invented-marker strip is the same one the Epic 3 path uses:
  // the loop makes the model better informed, not more trustworthy about `[7]`.
  const evidence = result.citations.length > 0 ? result.citations : citations;
  const sanitized = sanitizeCitedAnswer(split.content, evidence, COVERAGE_COPY, {
    allowUncited:
      result.outputs.length > 0 ||
      result.toolCalls.length > 0,
  });
  let pending = null;
  if (result.pending) {
    const capabilityId = options.capabilities.issue(
      result.pending.kind,
      result.pending,
      {
        conversationId,
        wikiId,
      },
    );
    pending = publicPending(result.pending, capabilityId);
  }
  const payload = {
    content: sanitized.content,
    thinking: split.thinking,
    citations: sanitized.citations,
    coverage: sanitized.coverage,
    toolCalls: result.toolCalls,
    outputs: result.outputs,
    conversationId,
    ...(pending ? { pending } : {}),
  };
  if (!stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }
  open();
  if (payload.thinking) {
    res.write(formatSse("agent", { thinking: payload.thinking, delta: "" }));
  }
  if (payload.content) {
    res.write(formatSse("agent", { delta: payload.content }));
  }
  res.write(formatSse("done", payload));
  res.end();
}

/** One kernel read for a tool, as parsed JSON or `null`. */
async function kernelFetch(kernel, pathname, init = {}) {
  if (!kernel?.base || !kernel?.token) return null;
  try {
    const response = await fetch(`${kernel.base}${pathname}`, {
      ...init,
      headers: {
        authorization: `Bearer ${kernel.token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function handleChat(req, res, wikiId, options = {}) {
  const resolvedWikiId = resolveLoopbackWikiId(wikiId, options.wikiRegistry);
  if (!resolvedWikiId) {
    rejectChat(res, 400, "invalid_wiki_id");
    return;
  }
  const canonicalWikiId = canonicalLoopbackWikiId(
    resolvedWikiId,
    options.wikiRegistry,
  );
  const currentIdentityUnavailable =
    resolvedWikiId === "current" && canonicalWikiId === null;
  // Non-tool Chat retains the kernel's existing `/current` behavior. A tool
  // turn can mint a resumable capability, so it must bind to an immutable UUID
  // and is refused below when the registry poller cannot supply one.
  wikiId = canonicalWikiId ?? resolvedWikiId;
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

  /**
   * Is this a TOOL-USING turn? (Story 8.5)
   *
   * OPT-IN from the request, and that is not timidity — it is what keeps the
   * Epic 3 contract intact. The retrieve-then-chat turn the Workbench has been
   * sending since Epic 3 hands over pre-assembled numbered context and expects
   * exactly one provider call; a loop that started searching on its own behalf
   * inside that shape would spend the owner's budget re-finding what the
   * Workbench had already found and would break the `coverage: false` pin.
   */
  const toolsEnabled = body.tools === true || isPlainObject(body.resume);
  if (toolsEnabled && currentIdentityUnavailable) {
    rejectChat(res, 503, "current_wiki_unavailable");
    return;
  }
  let resumePending = null;
  if (isPlainObject(body.resume)) {
    const capabilityId = resumeCapabilityId(body.resume);
    const taken = options.capabilities?.take(capabilityId, {
      conversationId: clientConversationId(body),
      wikiId,
    });
    if (
      !taken ||
      (taken.kind !== "shell_approval" && taken.kind !== "skill_form")
    ) {
      rejectChat(res, 400, "invalid_resume");
      return;
    }
    resumePending = taken.payload;
  }

  // NO CONTEXT AND NO TOOLS is honest coverage-missing: nothing was retrieved
  // and nothing may go looking, so there is no answer to give. With tools on,
  // an empty context is the NORMAL start of a turn — the Agent's first act is to
  // search, which is the whole "without me picking the tool" criterion.
  //
  // `coverage: false` from the caller is the ASSEMBLE step's verdict, and with
  // tools on it is an opening position rather than an answer: the assemble ran
  // one retrieval, the Agent is about to run several. Honouring it here would
  // make the tool loop unreachable for exactly the questions it was built for —
  // the ones the wiki does not obviously cover.
  if (!toolsEnabled && (body.coverage === false || !context.trim())) {
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
    if (toolsEnabled) {
      await runToolTurn({
        res,
        body,
        wikiId,
        session,
        stream,
        system,
        messages,
        citations,
        options,
        resumePending,
      });
      return;
    }
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

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/**
 * Forward one `/api/v1` request to the kernel, body for body.
 *
 * THE LOOPBACK TOKEN DOES NOT TRAVEL. It authorizes the caller AT THIS DOOR and
 * has no meaning on the kernel; what goes out is the owner-automation bearer
 * token the sidecar already holds — the same credential the extract claim loop
 * presents. Forwarding the caller's header instead would either 401 every proxied
 * request or, worse, make the loopback token a kernel credential.
 *
 * The kernel's status and body are relayed VERBATIM, because "same `/api/v1`
 * shapes on loopback and the cloud façade" is only true if this hop is
 * transparent. A 413 for an oversize file has to arrive as a 413.
 */
async function proxyToKernel(req, res, url, pathname, kernel) {
  if (!kernel.base || !kernel.token) {
    // Honest, and specifically NOT a 404: the route exists, the sidecar simply
    // has no kernel to ask. A 404 would send an agent looking for a typo.
    sendJson(res, 503, {
      error: "kernel_unreachable",
      detail:
        "Set WORKWIKI_URL and WORKWIKI_API_TOKEN so the sidecar can reach the wiki kernel.",
    });
    return;
  }
  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    try {
      body = await readRawBody(req);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return;
    }
  }
  // The caller's own `?token=` is STRIPPED. It is this door's credential, and
  // relaying it would put it in the kernel's access log for no reason.
  const forward = new URL(`${kernel.base}${pathname}`);
  for (const [key, value] of url.searchParams) {
    if (key === "token") continue;
    forward.searchParams.append(key, value);
  }
  try {
    const upstream = await fetch(forward, {
      method: req.method,
      headers: {
        authorization: `Bearer ${kernel.token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      "content-type":
        upstream.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
    });
    res.end(text);
  } catch {
    sendJson(res, 502, { error: "kernel_unreachable" });
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > V1_MAX_BODY_BYTES) {
        // 400 `body_too_large`, never a truncation: a half-read JSON body that
        // happened to parse would be a request the caller never sent.
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8") || undefined));
    req.on("error", reject);
  });
}

/**
 * The one HTTP shell.
 *
 * ORDER IS THE CONTRACT, and every step of it is a rule from the matrix:
 *
 *   1. CORS and `OPTIONS`, before anything can refuse — a preflight that got a
 *      401 would make the whole door unusable from the browser.
 *   2. `/api/v1/health`, PUBLIC and ungated. It is the one route that answers
 *      while the API is off, because a caller must be able to tell "switched
 *      off" from "nothing listening".
 *   3. The LOAD GATE, before the token compare. Shedding is cheaper than
 *      comparing, and a flood should not get 401s that look like an auth
 *      problem.
 *   4. The TOKEN GATE, on every data route.
 *   5. Sidecar-owned routes, then the kernel proxy.
 */
/**
 * What `pnpm sidecar` / `node sidecar/server.mjs` actually binds: kernel
 * credentials from the process env, and a Wiki registry that polls
 * `GET /api/v1/projects`. Tests that only call `createSidecarServer()` never
 * execute this, which is how production once started with an empty registry.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   fetchImpl?: typeof fetch,
 * }} [options]
 */
export function productionWikiRegistry({
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const kernel = {
    base: (env.WORKWIKI_URL || env.YOPEDIA_URL || "").trim().replace(/\/+$/, ""),
    token: (env.WORKWIKI_API_TOKEN || env.YOPEDIA_SERVICE_TOKEN || "").trim(),
  };
  return {
    kernel,
    wikiRegistry: createWikiRegistrySource({
      base: kernel.base,
      token: kernel.token,
      dataDir: env.DATA_DIR || process.cwd(),
      wikiRoots: env.WORKWIKI_WIKI_ROOTS,
      workspaceRoot: path.join(process.cwd(), "agent-workspace"),
      fetchImpl,
    }),
  };
}

export function createSidecarServer({
  settingsSource = createLoopbackSettingsSource(),
  gate = createLoadGate(),
  status = () => "running",
  kernel = {
    base: (process.env.WORKWIKI_URL || process.env.YOPEDIA_URL || "")
      .trim()
      .replace(/\/+$/, ""),
    token: (
      process.env.WORKWIKI_API_TOKEN ||
      process.env.YOPEDIA_SERVICE_TOKEN ||
      ""
    ).trim(),
  },
  workspace = createAgentWorkspace(),
  capabilities = createCapabilityStore(),
  approvals = createConversationApprovals(),
  wikiRegistry = [],
} = {}) {
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && !allowSidecarOrigin(origin)) {
      sendJson(res, 403, { error: "origin_not_allowed" });
      return;
    }
    cors(req, res);
    const url = new URL(req.url || "/", `http://${SIDECAR_HOST}:${SIDECAR_PORT}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const settings = settingsSource.current();
    const registry = wikiRegistryRows(wikiRegistry);

    if (req.method === "GET" && url.pathname === "/api/v1/health") {
      sendJson(res, 200, healthPayload({ status: status(), settings }));
      return;
    }

    const admitted = gate.enter();
    if (!admitted.ok) {
      sendJson(res, admitted.status, { error: admitted.error });
      return;
    }
    try {
      const allowed = authorizeLoopback(settings, extractToken(req.headers, url));
      if (!allowed.ok) {
        // The token is NEVER echoed — not the provided one, not its length, not
        // a redacted form of it. The body is the one word.
        sendJson(res, allowed.status, { error: allowed.error });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/v1/skills") {
        // Enablement comes from the SAME settings answer the token gate just
        // used, so a Skill the owner switched off in Settings is off here within
        // one poll — and a scan that ignored the map would list packs the Agent
        // will refuse to read.
        sendJson(res, 200, {
          skills: await scanSkills({ enablement: settings.skillEnablement }),
        });
        return;
      }

      if (
        req.method === "GET" &&
        url.pathname === "/api/v1/workspace/file"
      ) {
        const read = await workspace.read(url.searchParams.get("path") || "");
        sendJson(res, read.status, read.body);
        return;
      }

      const wikiId = req.method === "POST" ? chatPath(url) : null;
      if (wikiId) {
        await handleChat(req, res, wikiId, {
          workspace,
          kernel,
          settings,
          capabilities,
          approvals,
          // The poller, not a flattened snapshot. `canonicalLoopbackWikiId`
          // needs `currentId()` so a pause on `/projects/current/chat` can
          // be resumed on `/projects/<uuid>/chat`.
          wikiRegistry,
        });
        return;
      }

      const proxied = kernelProxyPath(url.pathname, registry);
      if (
        proxied === null &&
        /^\/api\/v1\/projects\//.test(url.pathname) &&
        !isSidecarOwnedPath(url.pathname)
      ) {
        let id = "";
        const match = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)/);
        if (match) {
          try {
            id = decodeURIComponent(match[1]);
          } catch {
            id = "";
          }
        }
        if (id && resolveLoopbackWikiId(id, registry) === null) {
          sendJson(res, 400, { error: "invalid_wiki_id" });
          return;
        }
      }
      if (proxied) {
        await proxyToKernel(req, res, url, proxied, kernel);
        return;
      }

      sendJson(res, 404, { error: "not_found" });
    } finally {
      admitted.release();
    }
  });
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  loadSidecarEnvFromFiles(path.resolve(fileURLToPath(new URL("..", import.meta.url))));
  const settingsSource = createLoopbackSettingsSource();
  // The FIRST poll happens before the listener binds, so the door is never open
  // with a stale `null` behind it. A failure here is not fatal — `authorize`
  // reads an absent answer as SHUT — so the sidecar still starts and still
  // answers `/health`, which is where the owner sees `enabled: false`.
  await settingsSource.refresh().catch(() => {});
  const { kernel, wikiRegistry } = productionWikiRegistry();
  // FIRST poll before listen, same as settings: a registered host-path `{id}`
  // must resolve on the first request, not fifteen seconds later.
  await wikiRegistry.refresh();
  // `starting` until the bind resolves. It is a real state, not a formality: a
  // client that probed during startup used to be told `"ok"`.
  let listenerStatus = "starting";
  const server = createSidecarServer({
    settingsSource,
    status: () => listenerStatus,
    kernel,
    wikiRegistry,
  });
  server.on("error", (error) => {
    if (error && error.code === "EADDRINUSE") {
      // SOMEBODY ELSE OWNS 19828, so this process exits rather than retrying on
      // another port. A sidecar on a port nothing looks at is worse than no
      // sidecar: the Workbench would report the wiki as down while a healthy
      // process sat there, and the owner would have two to debug. The occupant
      // is left alone — it may well be another copy of this sidecar.
      listenerStatus = "port_conflict";
      process.stderr.write(
        `work-wiki sidecar: port ${SIDECAR_PORT} is already in use. Stop the other process and start again.\n`,
      );
      process.exit(1);
    }
    listenerStatus = "error";
    process.stderr.write(`work-wiki sidecar: listener failed — ${error?.message}\n`);
    process.exit(1);
  });
  server.listen(SIDECAR_PORT, SIDECAR_HOST, () => {
    listenerStatus = "running";
    process.stdout.write(
      `work-wiki sidecar listening on http://${SIDECAR_HOST}:${SIDECAR_PORT}\n`,
    );
  });
  // Re-ask on an interval, so a Save in Settings lands within one poll and an
  // unsaved draft never lands at all. `unref` so this timer alone never keeps
  // the process alive.
  setInterval(() => {
    void settingsSource.refresh().catch(() => {});
    void wikiRegistry.refresh();
  }, SETTINGS_POLL_INTERVAL_MS).unref();
  // Extract is a second capability of the SAME process, started after the
  // listener so a Chat health probe never waits on a document parse. It is a
  // client of the kernel, not a route on this server: nothing outside this
  // machine can ask the sidecar to parse anything.
  const { startExtractLoop } = await import("./extract-loop.mjs");
  startExtractLoop({
    log: (message) => process.stdout.write(`${message}\n`),
  });
}
