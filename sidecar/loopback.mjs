/**
 * The loopback door: who gets in, how many at once, and what health says
 * (Stories 8.1 / 8.2).
 *
 * A MODULE OF PURE RULES, deliberately. The one thing this file must never be is
 * a set of branches inside `createSidecarServer`'s request handler: "a missing
 * token is 401", "the 65th concurrent request is 503 busy" and "a foreign
 * payload on 19828 is a port conflict" are exactly the rules a later rewrite
 * keeps the wording of while changing the behaviour, and the node suite can
 * execute a function while it can only grep a branch.
 *
 * IT IMPORTS NOTHING FROM `src/lib` (AD-6), so the handful of constants it
 * shares with `src/lib/v1-contract.ts` are DUPLICATED here and pinned against
 * that file by `workbench-epic8.test.ts`. That is the deal AD-6 buys: the
 * sidecar is a standalone Node process that must run with no build step, and the
 * cost is one test holding two copies of six strings in step.
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// The door. These six must equal `src/lib/v1-contract.ts`.
// ---------------------------------------------------------------------------

/** Loopback ONLY. Never `0.0.0.0`, never the LAN, never Clip-server 19827. */
export const LOOPBACK_HOST = "127.0.0.1";
export const LOOPBACK_PORT = 19828;
export const LOOPBACK_TOKEN_ENV = "LLM_WIKI_API_TOKEN";
export const LOOPBACK_TOKEN_HEADER = "x-llm-wiki-token";
export const LOOPBACK_TOKEN_QUERY = "token";

export const V1_DISABLED_ERROR = "disabled";
export const V1_BUSY_ERROR = "busy";
export const V1_UNAUTHORIZED_ERROR = "unauthorized";
export const V1_RATE_LIMITED_ERROR = "rate_limited";

export const V1_MAX_IN_FLIGHT = 64;
export const V1_RATE_LIMIT_PER_SEC = 120;
export const V1_MAX_BODY_BYTES = 1_048_576;

export const LOOPBACK_STATUSES = ["starting", "running", "port_conflict", "error"];

// ---------------------------------------------------------------------------
// The token
// ---------------------------------------------------------------------------

/**
 * The token the caller presented, or `null`.
 *
 * THREE ways in, tried in this order, and the order is the point:
 * `Authorization: Bearer` first because it is the only one that stays out of a
 * URL an owner can screenshot or a proxy can log; the dedicated header next; and
 * `?token=` LAST, supported only because some MCP clients cannot set a header at
 * all. First match wins rather than "all must agree" — a client that sends the
 * header and a stale query string should not be told its credential is wrong.
 *
 * @param {Record<string, string | string[] | undefined>} headers
 * @param {URL} url
 */
export function extractToken(headers, url) {
  const auth = headerValue(headers, "authorization");
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) {
      const value = match[1].trim();
      if (value) return value;
    }
  }
  const direct = headerValue(headers, LOOPBACK_TOKEN_HEADER);
  if (direct && direct.trim()) return direct.trim();
  const query = url?.searchParams?.get(LOOPBACK_TOKEN_QUERY);
  if (query && query.trim()) return query.trim();
  return null;
}

function headerValue(headers, name) {
  if (!headers) return null;
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return typeof raw === "string" ? raw : null;
}

/**
 * Constant-time compare — the sidecar's own copy of `src/lib/auth.ts`'s, because
 * it cannot import that file.
 *
 * Length short-circuits, exactly as the kernel's does: the token is
 * high-entropy, so its length is not a useful signal to an attacker, and
 * padding the comparison to a fixed width would only hide the length of the
 * EXPECTED value, which the attacker already controls half of.
 */
export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * May this request through? One answer, four refusals.
 *
 * FAIL CLOSED AT EVERY BRANCH. `settings` absent (the poll has not landed yet,
 * or the kernel is unreachable) is treated as a door that is SHUT, not as a door
 * with no lock: a sidecar that served the wiki during the window before its
 * first successful poll would be an unauthenticated API that appears and
 * disappears on a timer, which is the worst possible shape for a security
 * boundary.
 *
 * `allowUnauthenticated` is the one branch that lets a tokenless caller in, and
 * it only applies when the API is ON — an owner who shut the door did not thereby
 * open it to everyone.
 *
 * `authConfigured: false` with unauth off is a 401, not a 500. There is nothing
 * broken: the owner has switched the API on and generated no token, so the
 * honest answer is "you are not authorized", and `/health` is where a caller
 * learns WHY (see {@link healthPayload}).
 *
 * @param {{ enabled: boolean, allowUnauthenticated: boolean, token: string | null } | null} settings
 * @param {string | null} provided
 */
export function authorizeLoopback(settings, provided) {
  if (!settings || settings.enabled !== true) {
    return { ok: false, status: 503, error: V1_DISABLED_ERROR };
  }
  if (settings.allowUnauthenticated === true) return { ok: true };
  const expected = typeof settings.token === "string" ? settings.token : "";
  if (!expected) return { ok: false, status: 401, error: V1_UNAUTHORIZED_ERROR };
  if (!provided || !timingSafeEqual(provided, expected)) {
    return { ok: false, status: 401, error: V1_UNAUTHORIZED_ERROR };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/**
 * The health body, and the ONE public route that answers while the API is off.
 *
 * `status` is about THIS PROCESS's listener: `starting` before the bind
 * resolves, `running` after it, `port_conflict` when somebody else already owns
 * 19828, `error` when the listener died. Epic 3's `"ok"` is gone — it said
 * nothing about whether the process answering was this one, which is precisely
 * the question a caller on a shared port needs answered.
 *
 * `enabled: false` still answers 200. A caller has to be able to tell "the wiki
 * is here and switched off" from "nothing is listening", and only one of those
 * two is a sentence the owner can act on.
 *
 * `authRequired` is DERIVED — on and unauth off — never stored, so the two
 * cannot disagree. `authConfigured` says whether a token EXISTS, never what it
 * is: those two booleans together are the whole reason the branded skill can say
 * "generate a token" instead of retrying a 401 forever.
 *
 * @typedef {{
 *   enabled: boolean,
 *   allowUnauthenticated: boolean,
 *   token: string | null,
 *   tokenSource: string,
 *   skillEnablement: Record<string, boolean>,
 * }} ResolvedLoopbackSettings
 *
 * @param {{
 *   status?: string,
 *   version?: string,
 *   settings?: ResolvedLoopbackSettings | null,
 * }} [input]
 */
export function healthPayload({
  status = "running",
  version = "0.1.0",
  settings = null,
} = {}) {
  const enabled = settings?.enabled === true;
  const allowUnauthenticated = settings?.allowUnauthenticated === true;
  const authConfigured =
    typeof settings?.token === "string" && settings.token.length > 0;
  return {
    // `ok` is about the LISTENER, not about the API switch: a switched-off door
    // on a healthy sidecar is a working sidecar. A caller reading `ok` as "I may
    // call data routes" would be reading the wrong field, which is why `enabled`
    // is right beside it.
    ok: status === "running",
    status,
    version,
    enabled,
    authRequired: enabled && !allowUnauthenticated,
    authConfigured,
    allowUnauthenticated,
    tokenSource: settings?.tokenSource ?? "none",
  };
}

/**
 * Is this payload from a work-wiki sidecar at all?
 *
 * THE PORT-CONFLICT DETECTOR, and it is a SHAPE check rather than a status
 * check for a reason. A foreign HTTP server on 19828 answers something — an HTML
 * page, a JSON error, a Prometheus dump — and a caller that read any 2xx as "the
 * wiki is up" would go on to describe a wiki that process has never heard of.
 * Anything reachable whose body is not this shape is a port conflict.
 */
export function isLoopbackHealth(value) {
  if (!value || typeof value !== "object") return false;
  return (
    typeof value.ok === "boolean" &&
    typeof value.status === "string" &&
    LOOPBACK_STATUSES.includes(value.status) &&
    typeof value.version === "string" &&
    typeof value.enabled === "boolean" &&
    typeof value.authRequired === "boolean" &&
    typeof value.authConfigured === "boolean" &&
    typeof value.allowUnauthenticated === "boolean" &&
    typeof value.tokenSource === "string"
  );
}

// ---------------------------------------------------------------------------
// Load shedding
// ---------------------------------------------------------------------------

/**
 * Concurrency and rate, in one object because they are one decision.
 *
 * BOTH CAPS EXIST BECAUSE THEY CATCH DIFFERENT THINGS. The in-flight cap catches
 * a caller whose requests are SLOW — sixty-five parallel wiki searches on a
 * laptop that is also running the owner's editor — and answers 503 `busy`,
 * which is a "come back" rather than a "you are wrong". The rate limit catches a
 * caller whose requests are FAST — a runaway agent loop — and answers 429, which
 * is the status every HTTP client already knows how to back off from. A single
 * cap would let one of the two through.
 *
 * The rate window is a plain one-second bucket rather than a sliding window: the
 * limit is a safety valve on the owner's own machine, not a billing meter, and a
 * sliding window would cost a per-request array for a distinction nobody here
 * can observe.
 */
export function createLoadGate({
  maxInFlight = V1_MAX_IN_FLIGHT,
  ratePerSecond = V1_RATE_LIMIT_PER_SEC,
  now = () => Date.now(),
} = {}) {
  let inFlight = 0;
  let windowStart = now();
  let windowCount = 0;

  return {
    /** `{ ok: true, release }` or `{ ok: false, status, error }`. */
    enter() {
      const at = now();
      if (at - windowStart >= 1000) {
        windowStart = at;
        windowCount = 0;
      }
      windowCount += 1;
      if (windowCount > ratePerSecond) {
        return { ok: false, status: 429, error: V1_RATE_LIMITED_ERROR };
      }
      if (inFlight >= maxInFlight) {
        return { ok: false, status: 503, error: V1_BUSY_ERROR };
      }
      inFlight += 1;
      let released = false;
      return {
        ok: true,
        release() {
          // Idempotent: a handler that both `finally`s and error-paths must not
          // decrement twice, or the cap drifts downward until the door is
          // permanently busy.
          if (released) return;
          released = true;
          inFlight -= 1;
        },
      };
    },
    get inFlight() {
      return inFlight;
    },
  };
}

// ---------------------------------------------------------------------------
// Where the settings come from
// ---------------------------------------------------------------------------

/**
 * The loopback settings, resolved from the kernel and the environment.
 *
 * TWO SOURCES, and the env wins. `LLM_WIKI_API_TOKEN` is how a deployment
 * supplies the credential without it ever entering the config JSON, so a store
 * token standing BESIDE it would be a second valid password for the same door —
 * one the owner believes they rotated when they pressed Generate.
 *
 * The env alone is NOT enough to open the door, and that asymmetry is
 * deliberate: `enabled` comes from the kernel store only, so setting the
 * variable on a machine whose owner never switched the API on does not switch it
 * on. A credential is not a decision.
 *
 * @param {{
 *   enabled?: boolean,
 *   allowUnauthenticated?: boolean,
 *   token?: string | null,
 *   skillEnablement?: Record<string, boolean>,
 * } | null} fromKernel
 * @param {Record<string, string | undefined>} env
 * @returns {ResolvedLoopbackSettings}
 */
export function resolveLoopbackSettings(fromKernel, env = process.env) {
  const fromEnv = trimmed(env[LOOPBACK_TOKEN_ENV]);
  const stored = trimmed(fromKernel?.token);
  return {
    enabled: fromKernel?.enabled === true,
    allowUnauthenticated: fromKernel?.allowUnauthenticated === true,
    token: fromEnv ?? stored,
    tokenSource: fromEnv !== null ? "env" : stored !== null ? "store" : "none",
    // KERNEL ONLY, with no env override, because a Skill decision is not a
    // credential — there is no deployment reason to supply it out of band, and an
    // env variable that could re-enable a Skill the owner switched off would be a
    // second opinion about the same switch.
    //
    // `{}` when absent, never `null`: absent from the map MEANS ENABLED, and
    // `scanSkills` indexes it directly.
    skillEnablement:
      fromKernel?.skillEnablement && typeof fromKernel.skillEnablement === "object"
        ? fromKernel.skillEnablement
        : {},
  };
}

function trimmed(value) {
  if (typeof value !== "string") return null;
  const out = value.trim();
  return out.length > 0 ? out : null;
}

/**
 * The kernel half of the same question, read straight off disk.
 *
 * A FALLBACK, not the primary: `pnpm sidecar` runs beside a local kernel whose
 * `AppConfig` is a file on this machine, and reading it means the door works on
 * a dev machine with no owner-automation token configured at all. On a deployed
 * kernel the file is in R2 and this returns nothing, which is why the HTTP poll
 * exists.
 *
 * It reads exactly three keys and never logs them.
 */
export function readLoopbackSettingsFromDisk(
  dataDir = process.env.DATA_DIR || process.cwd(),
) {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dataDir, ".llm-wiki-config.json"), "utf8"),
    );
    if (!parsed || typeof parsed !== "object") return null;
    return {
      enabled: parsed.apiEnabled === true,
      allowUnauthenticated: parsed.allowUnauthenticated === true,
      token: trimmed(parsed.loopbackApiToken),
      skillEnablement:
        parsed.skillEnablement && typeof parsed.skillEnablement === "object"
          ? parsed.skillEnablement
          : {},
    };
  } catch {
    return null;
  }
}

/**
 * Poll the kernel for `{ enabled, allowUnauthenticated, token, tokenSource }`.
 *
 * WHY A POLLER: the kernel runs on Cloudflare Workers and cannot dial
 * `127.0.0.1`, so every arrow points outward from this machine — the same shape
 * `extract-loop.mjs` already has, over the same owner-automation bearer token.
 *
 * "Settings apply only after Save" falls out of polling rather than caching
 * forever: a Save lands within one interval, and an unsaved draft never lands.
 *
 * A FAILED POLL DOES NOT OPEN THE DOOR and does not shut an open one either.
 * It keeps the last good answer — a transient 500 from the kernel must not make
 * the owner's agents start failing — and if there has never been a good answer,
 * the disk fallback and then `null` (shut) is what stands.
 *
 * NOTHING IS LOGGED. Not the token, not a redacted token, not its length.
 */
export function createLoopbackSettingsSource({
  base = (process.env.WORKWIKI_URL || process.env.YOPEDIA_URL || "").trim().replace(/\/+$/, ""),
  token = (process.env.WORKWIKI_API_TOKEN || process.env.YOPEDIA_SERVICE_TOKEN || "").trim(),
  env = process.env,
  dataDir = undefined,
  fetchImpl = fetch,
} = {}) {
  let last = null;
  let lastFromRemote = false;

  const refresh = async () => {
    if (base && token) {
      try {
        const response = await fetchImpl(`${base}/api/v1/loopback-settings`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) {
          const body = await response.json();
          if (body && typeof body === "object") {
            last = {
              enabled: body.enabled === true,
              allowUnauthenticated: body.allowUnauthenticated === true,
              token: trimmed(body.token),
              skillEnablement:
                body.skillEnablement && typeof body.skillEnablement === "object"
                  ? body.skillEnablement
                  : {},
            };
            lastFromRemote = true;
            return resolveLoopbackSettings(last, env);
          }
        }
      } catch {
        // Keep the last good REMOTE answer. A stale on-disk file must not
        // replace a kernel result we already trusted.
      }
    }
    if (lastFromRemote && last) {
      return resolveLoopbackSettings(last, env);
    }
    const onDisk = readLoopbackSettingsFromDisk(dataDir);
    if (onDisk) last = onDisk;
    return resolveLoopbackSettings(last, env);
  };

  return {
    refresh,
    /** The last resolved answer, without touching the network. */
    current() {
      return resolveLoopbackSettings(last, env);
    },
  };
}

// ---------------------------------------------------------------------------
// The proxy split
// ---------------------------------------------------------------------------

/**
 * Which `/api/v1` paths does the SIDECAR answer itself?
 *
 * Everything else with an `/api/v1` prefix is reverse-proxied to the kernel with
 * an identical body, because the kernel is the system of record for wiki data
 * (AD-1) and a second implementation on this side would be a second answer to
 * "what does the wiki say".
 *
 * The four it keeps are the four the kernel CANNOT answer: health is about this
 * listener, Chat and shell run the local Agent, and Skills are files on this
 * disk.
 */
export const SIDECAR_OWNED_V1 = [
  /^\/api\/v1\/health$/,
  /^\/api\/v1\/skills(\/|$)/,
  /^\/api\/v1\/workspace(\/|$)/,
  /^\/api\/v1\/projects\/[^/]+\/chat$/,
  // The project-less alias is owned HERE too, even though every documented
  // client uses the project form. Proxied, it would reach the kernel's alias and
  // come back `sidecar_required` — telling a caller that is already talking to
  // the sidecar to go find the sidecar. It resolves to `current` instead.
  /^\/api\/v1\/chat$/,
];

export function isSidecarOwnedPath(pathname) {
  return SIDECAR_OWNED_V1.some((re) => re.test(pathname));
}

/**
 * `/api/v1` routes the door will NOT forward, even though the kernel has them.
 *
 * NOT AN OVERSIGHT LIST — each one is a route whose caller is the sidecar itself,
 * reached with the owner-automation token, and forwarding it would hand an
 * external client something FR-76 never offered:
 *
 *  - `loopback-settings` answers with the LOOPBACK TOKEN IN PLAINTEXT. A client
 *    that already holds the token could read it back, which is harmless, but one
 *    reaching the door with unauthenticated access ON could read it without ever
 *    holding it — that is the door handing out its own key.
 *  - `web-search` spends the owner's search-provider budget. The Chat Agent calls
 *    it directly on the kernel; an MCP client that could reach it would be
 *    billing the owner for queries they never saw.
 *  - `retrieve` is Chat's internal assemble step, not an external contract (the
 *    code map says so). `search` is the FR-76 route for the same need.
 */
export const KERNEL_ONLY_V1 = [
  /^\/api\/v1\/loopback-settings$/,
  /^\/api\/v1\/web-search$/,
  /^\/api\/v1\/projects\/[^/]+\/retrieve$/,
];

export function isKernelOnlyPath(pathname) {
  return KERNEL_ONLY_V1.some((re) => re.test(pathname));
}

/**
 * Should this path be proxied to the kernel, and as what?
 *
 * `null` for anything the sidecar owns and anything outside `/api/v1`. The
 * loopback door is not a general-purpose reverse proxy onto the kernel: a caller
 * that could reach `/api/settings` or `/api/wiki` through it would be using the
 * loopback token as a kernel session, and those routes are owner-gated for
 * reasons this door does not reproduce.
 *
 * @param {string} pathname
 * @param {WikiRegistryInput} [registry]
 */
export function kernelProxyPath(pathname, registry = []) {
  if (!pathname.startsWith("/api/v1/")) return null;
  if (isSidecarOwnedPath(pathname)) return null;
  if (isKernelOnlyPath(pathname)) return null;
  return rewriteProxiedWikiPath(pathname, registry);
}

/**
 * A host filesystem path is a legal loopback `{id}` (Story 8.2) only when the
 * owner has registered that path. The kernel never accepts a raw path, so the
 * door rewrites a registered one to its Wiki UUID before proxy or Chat.
 */
export function isAbsolutePathWikiId(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (!value.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(value)) return false;
  return !value.split(/[\\/]/).includes("..");
}

/**
 * @typedef {{ id?: string, path?: string }} WikiRegistryRow
 * @typedef {WikiRegistryRow[] | { current?: () => unknown }} WikiRegistryInput
 */

/**
 * Rows the door may treat as registered Wiki roots.
 *
 * Production passes a poller (`{ current }`); tests pass a plain array. Either
 * shape is legal — the HTTP shell must not snapshot the array at listen time,
 * or a later poll would never be seen.
 *
 * @param {WikiRegistryInput} [wikiRegistry]
 * @returns {WikiRegistryRow[]}
 */
export function wikiRegistryRows(wikiRegistry) {
  if (Array.isArray(wikiRegistry)) return wikiRegistry;
  if (wikiRegistry && typeof wikiRegistry.current === "function") {
    const rows = wikiRegistry.current();
    return Array.isArray(rows) ? rows : [];
  }
  return [];
}

/**
 * Poll `GET /api/v1/projects` and map each Wiki to a host filesystem root.
 *
 * `{id}` on the loopback door may be a URL-encoded absolute path, but only
 * when that path is one of these roots. The kernel reports
 * `tenants/<t>/wikis/<uuid>` (kernel-relative); resolving it against `DATA_DIR`
 * is what makes a host path the owner already registered match the UUID.
 *
 * A FAILED POLL KEEPS THE LAST GOOD ROWS. An empty successful list replaces
 * them — the owner deleted every Wiki — and is not treated as an error.
 */
export function createWikiRegistrySource({
  base = (process.env.WORKWIKI_URL || process.env.YOPEDIA_URL || "")
    .trim()
    .replace(/\/+$/, ""),
  token = (
    process.env.WORKWIKI_API_TOKEN ||
    process.env.YOPEDIA_SERVICE_TOKEN ||
    ""
  ).trim(),
  dataDir = process.env.DATA_DIR || process.cwd(),
  fetchImpl = fetch,
} = {}) {
  let rows = [];

  const refresh = async () => {
    if (!base || !token) return rows;
    try {
      const response = await fetchImpl(`${base}/api/v1/projects`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return rows;
      const body = await response.json();
      if (!body || typeof body !== "object" || !Array.isArray(body.projects)) {
        return rows;
      }
      const next = [];
      for (const project of body.projects) {
        if (!project || typeof project.id !== "string" || !project.id) continue;
        const raw = typeof project.path === "string" ? project.path : "";
        if (!raw || raw.split(/[\\/]/).includes("..")) continue;
        const absolute = path.isAbsolute(raw)
          ? path.resolve(raw)
          : path.resolve(dataDir, raw);
        next.push({ id: project.id, path: absolute });
      }
      rows = next;
    } catch {
      // Keep the last good list. A transient 500 must not empty the registry
      // and start refusing paths the owner already registered.
    }
    return rows;
  };

  return {
    refresh,
    current: () => rows,
  };
}

/**
 * @param {string} value
 * @param {WikiRegistryInput} [registry]
 * @returns {string | null}
 */
export function resolveLoopbackWikiId(value, registry = []) {
  if (typeof value !== "string") return null;
  if (value === "current" || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return value;
  }
  if (!isAbsolutePathWikiId(value)) return null;
  const resolved = path.resolve(value);
  const hit = wikiRegistryRows(registry).find(
    (row) => row && path.resolve(String(row.path ?? "")) === resolved,
  );
  return hit?.id ?? null;
}

/**
 * @param {string} pathname
 * @param {WikiRegistryInput} [registry]
 * @returns {string | null}
 */
export function rewriteProxiedWikiPath(pathname, registry = []) {
  const match = pathname.match(/^(\/api\/v1\/projects\/)([^/]+)(\/.*)?$/);
  if (!match) return pathname;
  let id = match[2];
  try {
    id = decodeURIComponent(id);
  } catch {
    return pathname;
  }
  const resolved = resolveLoopbackWikiId(id, registry);
  if (!resolved) return isAbsolutePathWikiId(id) ? null : pathname;
  return `${match[1]}${resolved}${match[3] ?? ""}`;
}
