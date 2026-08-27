/**
 * The loopback sidecar. Binds 127.0.0.1:19828 and nothing else.
 *
 * Does not import src/lib, Next, or Clerk (AD-6). The rules the door enforces —
 * who gets in, how many at once, what health says — live in `loopback.mjs` as
 * pure functions the node suite executes; this file is the HTTP shell around
 * them. Provider resolution lives in `chat-provider.mjs`; Chat turn handling
 * lives in `chat-transport.mjs`.
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
  resolveLoopbackWikiId,
  wikiRegistryRows,
} from "./loopback.mjs";
import { createAgentWorkspace } from "./workspace.mjs";
import { scanSkills } from "./skills.mjs";
import {
  createCapabilityStore,
  createConversationApprovals,
} from "./capabilities.mjs";
import {
  MAX_PROVIDER_RESPONSE_CHARS,
  PROVIDER_TIMEOUT_MS,
  generateChat,
  readSidecarConfig,
  resolveChatEndpoint,
  resolveChatProvider,
  resolveChatSecret,
} from "./chat-provider.mjs";
import {
  chatPath,
  createChatTurnSession,
  formatSse,
  handleChat,
  sanitizeCitedAnswer,
} from "./chat-transport.mjs";

export {
  MAX_PROVIDER_RESPONSE_CHARS,
  PROVIDER_TIMEOUT_MS,
  generateChat,
  readSidecarConfig,
  resolveChatEndpoint,
  resolveChatProvider,
  resolveChatSecret,
};
export { createChatTurnSession, formatSse, sanitizeCitedAnswer };

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

export const SIDECAR_HOST = LOOPBACK_HOST;
export const SIDECAR_PORT = LOOPBACK_PORT;
export const SSE_EVENTS = ["meta", "agent", "done", "cancelled", "error"];
/** How often the door re-asks the kernel what the owner saved. */
export const SETTINGS_POLL_INTERVAL_MS = 15_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i;

export const SIDECAR_VERSION =
  typeof pkg.version === "string" ? pkg.version : "0.1.0";

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

export function allowSidecarOrigin(origin) {
  if (!origin) return true;
  return LOOPBACK_ORIGIN_RE.test(origin);
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
  chatSessionFactory = createChatTurnSession,
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
          sessionFactory: chatSessionFactory,
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
