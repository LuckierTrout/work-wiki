/**
 * Chat-only loopback sidecar. Binds 127.0.0.1:19828.
 * Does not import src/lib, Next, or Clerk.
 */
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

export const SIDECAR_HOST = "127.0.0.1";
export const SIDECAR_PORT = 19828;
export const SSE_EVENTS = ["meta", "agent", "done", "cancelled", "error"];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COVERAGE_COPY =
  "Wiki has no coverage for this. Ingest a source or run Deep Research.";

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

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
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

async function callAnthropic({ apiKey, model, system, messages }) {
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
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Anthropic ${response.status}`);
  }
  const text = (payload.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return text;
}

async function callOpenAiCompatible({ apiKey, model, system, messages, baseUrl }) {
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
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || `OpenAI-compatible ${response.status}`);
  }
  return payload.choices?.[0]?.message?.content ?? "";
}

async function callGoogle({ apiKey, model, system, messages }) {
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
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Google ${response.status}`);
  }
  return payload.candidates?.[0]?.content?.parts?.map((part) => part.text).join("") ?? "";
}

export async function generateChat({
  provider,
  model,
  apiKey,
  baseUrl,
  system,
  messages,
}) {
  const resolvedModel = model || "claude-sonnet-4-5";
  const key =
    apiKey ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    process.env.OLLAMA_API_KEY ||
    "";
  if (!key && provider !== "ollama") {
    throw new Error("Configure a Chat model in Settings.");
  }
  if (provider === "google") {
    return callGoogle({ apiKey: key, model: resolvedModel, system, messages });
  }
  if (provider === "openai" || provider === "deepseek" || provider === "custom") {
    return callOpenAiCompatible({
      apiKey: key,
      model: resolvedModel,
      system,
      messages,
      baseUrl:
        baseUrl ||
        (provider === "deepseek" ? "https://api.deepseek.com" : "https://api.openai.com/v1"),
    });
  }
  if (provider === "ollama" || provider === "ollama-cloud") {
    return callOpenAiCompatible({
      apiKey: key || "ollama",
      model: resolvedModel,
      system,
      messages,
      baseUrl:
        baseUrl ||
        (provider === "ollama-cloud" ? "https://ollama.com/v1" : "http://127.0.0.1:11434/v1"),
    });
  }
  return callAnthropic({
    apiKey: key || process.env.ANTHROPIC_API_KEY,
    model: resolvedModel,
    system,
    messages,
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

async function handleChat(req, res, wikiId) {
  if (!isSidecarWikiId(wikiId)) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_wiki_id" }));
    return;
  }
  let body;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON" }));
    return;
  }
  const stream =
    body.stream === true ||
    String(req.headers.accept || "").includes("text/event-stream");
  const citations = Array.isArray(body.citations) ? body.citations : [];
  const history = Array.isArray(body.messages) ? body.messages : [];
  const context = typeof body.context === "string" ? body.context : "";
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
    typeof body.query === "string" && body.query.trim()
      ? body.query.trim()
      : history.filter((item) => item.role === "user").at(-1)?.content || "";
  const messages = [
    ...history
      .filter((item) => item.role === "user" || item.role === "assistant")
      .map((item) => ({ role: item.role, content: String(item.content ?? "") })),
  ];
  if (!messages.some((item) => item.role === "user" && item.content === userText) && userText) {
    messages.push({ role: "user", content: userText });
  }

  try {
    const raw = await generateChat({
      provider: body.model?.provider,
      model: body.model?.model,
      apiKey: body.model?.apiKey,
      baseUrl: body.model?.baseUrl,
      system,
      messages,
    });
    const split = extractThinking(raw);
    const content = split.content;
    await done({
      content,
      thinking: split.thinking,
      citations,
      coverage: true,
    });
  } catch (error) {
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
    cors(res);
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
  const server = createSidecarServer();
  server.listen(SIDECAR_PORT, SIDECAR_HOST, () => {
    process.stdout.write(
      `work-wiki sidecar listening on http://${SIDECAR_HOST}:${SIDECAR_PORT}\n`,
    );
  });
}
