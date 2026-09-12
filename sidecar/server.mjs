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
import { createPairingSource, pairingOrigin, SIDECAR_INSTANCE_HEADER } from "./pairing.mjs";
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
/**
 * The three spellings of THIS MACHINE, admitted with nothing configured.
 *
 * `[::1]` — the bracketed IPv6 loopback literal, as it appears in an origin —
 * belongs beside the other two and not in the allowlist (DW-605). It is the
 * same machine; it carries the same Secure Contexts "potentially trustworthy"
 * carve-out that makes a plain-HTTP loopback subresource reachable from an
 * HTTPS page at all; and on a dual-stack host `localhost` frequently resolves
 * to it already. A dev server listening on IPv6 loopback was therefore refused
 * while the same process reached through `localhost` was admitted — a
 * difference the contract has no way to defend.
 *
 * THE WIDENING STOPS THERE. Only the bracketed literal: not a bare `::1`, not
 * any other IPv6 address (`[::ffff:127.0.0.1]`, a link-local `[fe80::1]`), and
 * not the rest of `127.0.0.0/8`. The pattern stays anchored at both ends, so
 * `http://[::1].evil.test` is not loopback however much it reads like it — a
 * deployed page is admitted by being NAMED in the allowlist, never by
 * resembling loopback.
 */
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

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
  for (const name of [".env.local", ".env"]) {
    try {
      applyDotEnv(fs.readFileSync(path.join(rootDir, name), "utf8"));
    } catch (error) {
      if (error && error.code !== "ENOENT") throw error;
    }
  }
}

/**
 * The env that names non-loopback origins allowed to reach this door.
 *
 * Comma-separated, e.g. `WORKWIKI_SIDECAR_ALLOWED_ORIGINS=https://app.example`.
 * Absent or garbage means "loopback only", which is exactly what the sidecar
 * did before this existed.
 */
export const SIDECAR_ALLOWED_ORIGINS_ENV = "WORKWIKI_SIDECAR_ALLOWED_ORIGINS";

/** Chrome's Private Network Access preflight request/response header pair. */
const PNA_REQUEST_HEADER = "access-control-request-private-network";
const PNA_RESPONSE_HEADER = "Access-Control-Allow-Private-Network";

/**
 * How long a browser may cache the preflight answer.
 *
 * It is also a REVOCATION LAG: an origin dropped from the allowlist stays
 * usable in an already-primed browser for this long. Ten minutes buys back the
 * preflight on a polled route without making a removal feel permanent.
 */
const CORS_MAX_AGE_SECONDS = 600;

/**
 * Did this preflight ask for private-network access?
 *
 * Read leniently — first comma-separated segment, trimmed, lowercased — because
 * a proxy that duplicates the header or a client that sends `TRUE` would
 * otherwise get no `Access-Control-Allow-Private-Network` back and fail the
 * request before any route runs. The header is a QUESTION, not a credential;
 * being strict about its spelling protects nothing.
 *
 * @param {import("node:http").IncomingHttpHeaders} headers
 */
function requestsPrivateNetwork(headers) {
  const raw = headers[PNA_REQUEST_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return false;
  return value.split(",")[0].trim().toLowerCase() === "true";
}

/**
 * One entry, reduced to a bare `scheme://host[:port]` origin — or `null`.
 *
 * NORMALIZATION IS WHAT KEEPS THE ALLOWLIST AN ALLOWLIST. The comparison later
 * is string equality between two normalized origins, never a `startsWith` or
 * an `includes`, because `https://app.example.evil.test` passes both of those
 * against `https://app.example`. An entry that carries a path, a query, a
 * fragment, credentials, a non-http(s) scheme, or a `*` is not an origin and is
 * dropped rather than repaired.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeOrigin(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // `new URL("https://*.example")` parses, so the wildcard has to be refused
  // explicitly: a suffix pattern is the one thing an allowlist must not accept.
  if (!trimmed || trimmed.includes("*")) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Parse `WORKWIKI_SIDECAR_ALLOWED_ORIGINS` into normalized origins.
 *
 * Pure, and it NEVER THROWS: `parseWikiRoots` sets the convention, and the
 * reason is the same one — this value is read on the path to `server.listen`,
 * so a typo in `.env` that raised would stop the sidecar from binding at all
 * and turn a misconfigured origin into no sidecar. Bad entries are dropped
 * silently; the worst case is the loopback-only behaviour that predates it.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function parseSidecarAllowedOrigins(value) {
  if (typeof value !== "string" || !value.trim()) return [];
  const out = [];
  for (const part of value.split(",")) {
    const origin = normalizeOrigin(part);
    if (origin && !out.includes(origin)) out.push(origin);
  }
  return out;
}

/**
 * Loopback always; a configured origin only if it is a normalized member.
 *
 * `allowedOrigins` defaults to empty so the one-argument call sites — and a
 * sidecar with nothing configured — behave exactly as they did before DW-25.
 * The two tests stay SEPARATE: {@link LOOPBACK_ORIGIN_RE} answers only for the
 * spellings of this machine, and a deployed page is admitted by being NAMED in
 * the list, never by resembling loopback. DW-605 added `[::1]` to that regex
 * because it IS this machine; nothing about a remote origin got easier.
 *
 * @param {string | undefined} origin
 * @param {string[]} [allowedOrigins]
 */
export function allowSidecarOrigin(origin, allowedOrigins = []) {
  if (!origin) return true;
  if (LOOPBACK_ORIGIN_RE.test(origin)) return true;
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) return false;
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  // An entry already string-equal to the normalized origin IS that origin, so
  // the cheap compare runs first and `new URL()` is reached only for a list
  // that skipped `parseSidecarAllowedOrigins` — an injected option. Health is
  // polled, and re-parsing every entry on every request is a cost the door pays
  // forever for a case production never hits.
  return allowedOrigins.some(
    (entry) => entry === normalized || normalizeOrigin(entry) === normalized,
  );
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
 *
 * `Vary: Origin` is now UNCONDITIONAL, on this path AND on the 403 refusal, so
 * a shared cache can never serve one origin's answer to another.
 *
 * What is echoed is the NORMALIZED origin, not the raw header. The match is on
 * the normalized form, so echoing the raw one would admit `HTTPS://APP.EXAMPLE`
 * and then answer with a string the browser does not accept as a match — a
 * silent CORS failure that looks exactly like a refusal.
 */
function cors(req, res, allowedOrigins = []) {
  const origin = req.headers.origin;
  res.setHeader("Vary", "Origin");
  if (origin && allowSidecarOrigin(origin, allowedOrigins)) {
    res.setHeader("Access-Control-Allow-Origin", normalizeOrigin(origin) || origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    `Content-Type, Accept, Authorization, ${LOOPBACK_TOKEN_HEADER}, ${SIDECAR_INSTANCE_HEADER}`,
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
  pairingSource = createPairingSource({ kernel }),
  workspace = createAgentWorkspace(),
  capabilities = createCapabilityStore(),
  approvals = createConversationApprovals(),
  wikiRegistry = [],
  chatSessionFactory = createChatTurnSession,
  // Read HERE, at construction, and not at module load: `loadSidecarEnvFromFiles`
  // runs after this module is imported, so a top-level read would always see the
  // env as it was before `.env` / `.env.local` were applied.
  allowedOrigins = parseSidecarAllowedOrigins(
    process.env[SIDECAR_ALLOWED_ORIGINS_ENV],
  ),
} = {}) {
  // Normalized ONCE, here, so the per-request compare is string equality even
  // when the option was injected raw. Unusable entries fall out rather than
  // being carried as strings nothing can ever match.
  const admissibleOrigins = (Array.isArray(allowedOrigins) ? allowedOrigins : [])
    .map((entry) => normalizeOrigin(entry))
    .filter((entry) => entry !== null);
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && !allowSidecarOrigin(origin, admissibleOrigins)) {
      // Fail closed, and fail BARE: no `Access-Control-Allow-Origin`, no PNA
      // header. The browser reads the missing header as a CORS failure, which
      // is what makes the probe answer `down` instead of inventing an `up`.
      // `Vary` still goes out, because this answer is origin-specific too and a
      // shared cache must not replay a 403 at an origin that would be admitted.
      res.setHeader("Vary", "Origin");
      sendJson(res, 403, { error: "origin_not_allowed" });
      return;
    }
    cors(req, res, admissibleOrigins);
    const url = new URL(req.url || "/", `http://${SIDECAR_HOST}:${SIDECAR_PORT}`);
    if (req.method === "OPTIONS") {
      // Chrome forces a public-to-private preflight for a request from a public
      // page to 127.0.0.1 and fails it BEFORE any route runs unless this header
      // comes back. It is answered only when asked for, and only for an origin
      // already admitted above.
      //
      // The answer therefore varies by the PNA request header as well as by
      // origin, and `Access-Control-Max-Age` is preflight-only — a max-age on
      // every response would say nothing and a `Vary: Origin` alone would let a
      // cached non-PNA 204 be replayed for a PNA preflight it does not answer.
      if (origin && requestsPrivateNetwork(req.headers)) {
        res.setHeader(PNA_RESPONSE_HEADER, "true");
      }
      res.setHeader("Vary", "Origin, Access-Control-Request-Private-Network");
      res.setHeader("Access-Control-Max-Age", String(CORS_MAX_AGE_SECONDS));
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
      return;
    }

    const settings = settingsSource.current();
    const registry = wikiRegistryRows(wikiRegistry);

    if (req.method === "GET" && url.pathname === "/api/v1/health") {
      const pairing = await pairingSource.read();
      sendJson(res, 200, {
        ...healthPayload({ status: status(), settings }),
        pairing, kernelOrigin: pairingOrigin(kernel.base), pairingReady: pairing !== null && (!origin || pairingOrigin(origin) === pairingOrigin(kernel.base)),
      });
      return;
    }

    const admitted = gate.enter();
    if (!admitted.ok) {
      sendJson(res, admitted.status, { error: admitted.error });
      return;
    }
    try {
      const pairing = await pairingSource.read();
      const expectedInstance = req.headers[SIDECAR_INSTANCE_HEADER];
      // Originless MCP/CLI clients keep token auth, but the sidecar must still
      // attest its local kernel. Browsers must name the instance on every call.
      if (!pairing || ((origin || expectedInstance) && expectedInstance !== pairing.instance) ||
          (origin && pairingOrigin(origin) !== pairingOrigin(kernel.base))) {
        sendJson(res, 409, { error: "sidecar_pairing_mismatch" });
        return;
      }
      // Refresh the door token too: rotation must not wait for the background poll.
      await settingsSource.refresh();
      const currentSettings = settingsSource.current();
      const allowed = authorizeLoopback(currentSettings, extractToken(req.headers, url));
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
          skills: await scanSkills({ enablement: currentSettings.skillEnablement }),
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
          settings: currentSettings,
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
  // SAY WHICH ORIGINS SURVIVED, and name the ones that did not. A dropped entry
  // is invisible otherwise, and its symptom — a browser refused at the door
  // while the sidecar runs — is exactly the DW-25 bug this option exists to
  // fix. The parse itself stays pure and silent; the reporting lives here,
  // where there is a terminal to report to.
  const configuredOrigins = process.env[SIDECAR_ALLOWED_ORIGINS_ENV] || "";
  const effectiveOrigins = parseSidecarAllowedOrigins(configuredOrigins);
  const droppedOrigins = configuredOrigins
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry && normalizeOrigin(entry) === null);
  if (droppedOrigins.length > 0) {
    process.stderr.write(
      `work-wiki sidecar: ignoring ${droppedOrigins.length} unusable ` +
        `${SIDECAR_ALLOWED_ORIGINS_ENV} entr${droppedOrigins.length === 1 ? "y" : "ies"} ` +
        `— ${droppedOrigins.join(", ")}. An entry must be a bare ` +
        `http(s)://host[:port] origin with no path and no wildcard.\n`,
    );
  }
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
  const pairingSource = createPairingSource({ kernel });
  const startupPairing = await pairingSource.read();
  process.stdout.write(
    `work-wiki sidecar kernel: ${pairingOrigin(kernel.base) || "unconfigured"}; ` +
    `pairing: ${startupPairing ? "verified" : "unverified — check WORKWIKI_URL and start both processes from the same checkout"}\n`,
  );
  const server = createSidecarServer({
    pairingSource,
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
      `work-wiki sidecar listening on http://${SIDECAR_HOST}:${SIDECAR_PORT} ` +
        `(browser origins: loopback` +
        `${effectiveOrigins.length > 0 ? `, ${effectiveOrigins.join(", ")}` : " only"})\n`,
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
    beforeDrain: async () => (await pairingSource.read()) !== null,
    log: (message) => process.stdout.write(`${message}\n`),
  });
}
