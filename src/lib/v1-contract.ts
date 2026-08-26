/**
 * The FR-76 `/api/v1` contract — one shape, two hosts (Story 8.2).
 *
 * Client-safe on purpose, the same posture as `chat-contract.ts`: the kernel
 * routes import it on the server, `SettingsCanvas` imports it in the browser to
 * render the Base URL and the copyable MCP config, and the node suite EXECUTES
 * every limit and every predicate here. A cap typed into a route handler could
 * only ever be grepped for, and "was `topK` clamped or refused" is exactly the
 * kind of rule a rewrite keeps the wording of while changing the behaviour.
 *
 * It holds NO storage, LLM or Node API. The sidecar cannot import it at all
 * (AD-6 forbids the sidecar reaching into `src/lib`), so `sidecar/loopback.mjs`
 * keeps its own copy of the handful of constants it needs and
 * `workbench-epic8.test.ts` pins the two against each other.
 */

import { isFilesystemWikiId, isSidecarWikiId } from "./chat-contract";

// ---------------------------------------------------------------------------
// The door itself
// ---------------------------------------------------------------------------

/** Loopback ONLY. Never `0.0.0.0`, never the LAN, never Clip-server 19827. */
export const LOOPBACK_HOST = "127.0.0.1";
export const LOOPBACK_PORT = 19828;
export const LOOPBACK_BASE_URL = `http://${LOOPBACK_HOST}:${LOOPBACK_PORT}`;
export const LOOPBACK_HEALTH_URL = `${LOOPBACK_BASE_URL}/api/v1/health`;

/**
 * The env variable that overrides the stored UI token.
 *
 * `LLM_WIKI_*`, not `YOPEDIA_*` and not `WORKWIKI_*`: this is the LOOPBACK
 * skill's credential, the name the nashsu-compatible clients already send, and
 * the frozen-identifier list in `AGENTS.md` keeps kernel and consumer secrets on
 * their own prefixes. Renaming it would strand every already-installed skill.
 */
export const LOOPBACK_TOKEN_ENV = "LLM_WIKI_API_TOKEN";

/**
 * Accepted ways to send the token, in the order the door tries them.
 *
 * `Authorization: Bearer` is preferred because it is the only one that stays out
 * of a URL an owner can screenshot; `?token=` is last for exactly that reason
 * and is supported only because some MCP clients cannot set a header.
 */
export const LOOPBACK_TOKEN_HEADER = "x-llm-wiki-token";
export const LOOPBACK_TOKEN_QUERY = "token";

/** Where the token in effect came from. `none` means nothing is configured. */
export type LoopbackTokenSource = "env" | "store" | "none";

/**
 * A fresh loopback token.
 *
 * HERE rather than in `config.ts` because the one caller that mints one is the
 * BROWSER — the Settings pane's Generate button — and `config.ts` reaches
 * storage. Nothing on the server needs to mint one: the store only ever
 * receives what the pane sent.
 *
 * 48 hex characters out of two `crypto.randomUUID()` calls, which is available
 * identically in node, in the browser and in the Worker, and wide enough that
 * guessing it is not a strategy. It carries no scheme prefix on purpose: the
 * token travels in an `Authorization: Bearer` header to third-party MCP clients
 * and skill packs, and a recognisable prefix would tell a log scraper what it
 * had found.
 */
export function newLoopbackApiToken(): string {
  return (
    crypto.randomUUID().replace(/-/g, "") +
    crypto.randomUUID().replace(/-/g, "").slice(0, 16)
  );
}

/**
 * Honest health, four values (Story 8.1).
 *
 * `starting` is a listener that has not bound yet, `running` a successful
 * listen, `port_conflict` somebody else on 19828, `error` a listener that died.
 * There is deliberately no `ok` value any more: Epic 3's `"ok"` said nothing
 * about whether the process answering was this one.
 *
 * A sidecar that is DOWN is not in this list at all — it is a refused TCP
 * connection, and inventing a status for it is how a caller ends up describing a
 * wiki nothing is serving.
 */
export const LOOPBACK_STATUSES = [
  "starting",
  "running",
  "port_conflict",
  "error",
] as const;

export type LoopbackStatus = (typeof LOOPBACK_STATUSES)[number];

export function isLoopbackStatus(value: unknown): value is LoopbackStatus {
  return (
    typeof value === "string" &&
    (LOOPBACK_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * The build both hosts report in `version`.
 *
 * A CONSTANT rather than an import of `package.json`, because the cloud façade
 * runs on a Worker where pulling the manifest into the bundle to read one string
 * is the wrong trade. The sidecar reads `package.json` directly (it is on the
 * owner's disk), so the two could drift — `workbench-epic8.test.ts` pins this
 * literal against the manifest so a version bump fails a test instead of making
 * the two doors disagree about what is running.
 */
export const V1_APP_VERSION = "0.1.0";

/** The public health body, on loopback and on the cloud façade alike. */
export interface V1Health {
  ok: boolean;
  status: LoopbackStatus;
  version: string;
  enabled: boolean;
  authRequired: boolean;
  authConfigured: boolean;
  allowUnauthenticated: boolean;
  tokenSource: LoopbackTokenSource;
}

/** Field names are the contract — the branded skill reads exactly these. */
export const V1_HEALTH_FIELDS = [
  "ok",
  "status",
  "version",
  "enabled",
  "authRequired",
  "authConfigured",
  "allowUnauthenticated",
  "tokenSource",
] as const;

/**
 * Is a payload fetched from 19828 actually a work-wiki health body?
 *
 * The `port_conflict` detector. A foreign HTTP server on that port answers
 * something — 200 with an HTML page, a JSON error, a Prometheus dump — and a
 * caller that read any 2xx as "the wiki is up" would then describe a wiki that
 * process has never heard of. So the SHAPE is the check, and anything reachable
 * whose body is not this shape is reported as a port conflict rather than as a
 * wiki.
 */
export function isV1Health(value: unknown): value is V1Health {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body.ok === "boolean" &&
    isLoopbackStatus(body.status) &&
    typeof body.version === "string" &&
    typeof body.enabled === "boolean" &&
    typeof body.authRequired === "boolean" &&
    typeof body.authConfigured === "boolean" &&
    typeof body.allowUnauthenticated === "boolean" &&
    (body.tokenSource === "env" ||
      body.tokenSource === "store" ||
      body.tokenSource === "none")
  );
}

// ---------------------------------------------------------------------------
// The refusals. One vocabulary, so the skill can branch on a string.
// ---------------------------------------------------------------------------

/** API switched off in Settings: every data route, `/health` excepted. */
export const V1_DISABLED_ERROR = "disabled";
/** 65th concurrent request. */
export const V1_BUSY_ERROR = "busy";
/** Missing or wrong token while the API is on and unauth is off. */
export const V1_UNAUTHORIZED_ERROR = "unauthorized";
/** Over 120 requests in a second. */
export const V1_RATE_LIMITED_ERROR = "rate_limited";
/** Cloud Chat. The Agent is on this machine or it is nowhere. */
export const V1_SIDECAR_REQUIRED_ERROR = "sidecar_required";
export const V1_INVALID_WIKI_ID_ERROR = "invalid_wiki_id";
export const V1_WIKI_NOT_FOUND_ERROR = "wiki_not_found";
export const V1_FILE_OUT_OF_SCOPE_ERROR = "out_of_scope";
export const V1_FILE_BINARY_ERROR = "unsupported_media_type";
export const V1_FILE_TOO_LARGE_ERROR = "too_large";
export const V1_BODY_TOO_LARGE_ERROR = "body_too_large";
export const V1_TREE_TOO_LARGE_ERROR = "tree_too_large";
export const V1_EMPTY_QUERY_ERROR = "query is required";
export const V1_UNKNOWN_ACTION_ERROR = "unknown_action";

// ---------------------------------------------------------------------------
// Limits. Every one of them is in the I/O matrix.
// ---------------------------------------------------------------------------

/** Concurrent in-flight requests before the door answers `busy`. */
export const V1_MAX_IN_FLIGHT = 64;
/** Requests per second before the door answers 429. */
export const V1_RATE_LIMIT_PER_SEC = 120;
/** Request bodies above this are 400, not truncated. */
export const V1_MAX_BODY_BYTES = 1_048_576;
/** A tree bigger than this is 413 — the caller asked for the wrong thing. */
export const V1_MAX_TREE_NODES = 10_000;
/** `topK` is CLAMPED (the caller still gets results), not refused. */
export const V1_MAX_TOP_K = 50;
export const V1_DEFAULT_TOP_K = 10;
/** Graph `limit` is clamped the same way. */
export const V1_MAX_GRAPH_LIMIT = 1_000;
export const V1_DEFAULT_GRAPH_LIMIT = 500;
/** One text file the content route will buffer. Above it, 413. */
export const V1_MAX_FILE_BYTES = 1_048_576;

export function clampTopK(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return V1_DEFAULT_TOP_K;
  }
  return Math.min(V1_MAX_TOP_K, Math.max(1, Math.round(value)));
}

export function clampGraphLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return V1_DEFAULT_GRAPH_LIMIT;
  }
  return Math.min(V1_MAX_GRAPH_LIMIT, Math.max(1, Math.round(value)));
}

// ---------------------------------------------------------------------------
// `{id}` — and the one asymmetry between the two hosts
// ---------------------------------------------------------------------------

/**
 * May the CLOUD façade accept this `{id}`?
 *
 * `current` or a Wiki UUID and nothing else. A filesystem path is meaningless
 * on a Worker — there is no such disk — so accepting one would either 500 or,
 * worse, be coerced into some tenant key. Spoken Wiki NAMES are not ids either:
 * the Workbench resolves a name to a UUID before it calls anything here, and a
 * route that guessed would bind a caller to a Wiki they did not pick.
 */
export function isCloudWikiId(value: string): boolean {
  return !isFilesystemWikiId(value) && isSidecarWikiId(value);
}

/**
 * May the LOOPBACK door accept this `{id}`?
 *
 * The same two, PLUS a URL-encoded absolute path — and only because on the
 * owner's own machine a path is a real address for a Wiki directory or the
 * sidecar workspace. Resolution still has to map it to a known Wiki: this
 * predicate says the SHAPE is admissible, not that the path exists.
 */
export function isLoopbackWikiId(value: string): boolean {
  return isCloudWikiId(value) || isAbsolutePathWikiId(value);
}

/**
 * An absolute POSIX or Windows path, with no traversal segment.
 *
 * `..` is refused outright rather than normalised away: the whole point of the
 * loopback path form is that it names a directory the owner already has, and a
 * traversal segment means the caller is composing an address rather than naming
 * one.
 */
export function isAbsolutePathWikiId(value: string): boolean {
  if (!value.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(value)) return false;
  return !value.split(/[\\/]/).includes("..");
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * The four roots a file read may name, and nothing else.
 *
 * `sources` is an ALIAS for `raw` (and for `raw/sources`): the FR-76 vocabulary
 * calls them Sources and the tree calls them `raw/`, and a caller that used the
 * product's word should not get a 400 for it.
 */
export const V1_FILE_ROOTS = ["all", "wiki", "raw", "sources"] as const;
export type V1FileRoot = (typeof V1_FILE_ROOTS)[number];

export function isV1FileRoot(value: unknown): value is V1FileRoot {
  return (
    typeof value === "string" && (V1_FILE_ROOTS as readonly string[]).includes(value)
  );
}

/** `sources` and `raw/sources` both mean the `raw` tree. */
export function normalizeFileRoot(value: unknown): V1FileRoot {
  if (value === undefined || value === null || value === "") return "all";
  if (value === "raw/sources") return "raw";
  if (!isV1FileRoot(value)) return "all";
  return value === "sources" ? "raw" : value;
}

/**
 * Extensions the content route will serve as TEXT.
 *
 * Deliberately a small allowlist rather than a binary sniff: the door's promise
 * is "text only", and a sniff that guessed would hand a caller a decoded PDF's
 * mojibake instead of the honest 415. Anything not on this list is
 * {@link V1_FILE_BINARY_ERROR}.
 */
export const V1_TEXT_EXTENSIONS = [
  "md",
  "markdown",
  "txt",
  "text",
  "json",
  "yaml",
  "yml",
  "csv",
  "tsv",
  "log",
  "html",
  "xml",
] as const;

export function isV1TextPath(displayPath: string): boolean {
  const dot = displayPath.lastIndexOf(".");
  if (dot <= 0) return false;
  const ext = displayPath.slice(dot + 1).toLowerCase();
  return (V1_TEXT_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * Is this display path inside the readable window at all?
 *
 * `purpose.md`, `schema.md`, `wiki/**` and `raw/sources/**` — plus the rest of
 * `raw/`, which is where Sources physically live and which `listWorkbenchFilePaths`
 * already surfaces. Hidden files and symlink-looking segments are refused here
 * so the answer is a 403 rather than a storage error.
 *
 * This is the SCOPE question only. Whether the caller may read those particular
 * BYTES is `readWorkbenchFile`'s gate, and it is stricter.
 */
export function isV1FileInScope(displayPath: string): boolean {
  if (typeof displayPath !== "string" || displayPath.length === 0) return false;
  if (displayPath.includes("\\") || displayPath.includes("\0")) return false;
  if (displayPath.startsWith("/")) return false;
  const segments = displayPath.split("/");
  if (segments.some((s) => s.length === 0 || s.startsWith(".") || s === "..")) {
    return false;
  }
  if (segments.length === 1) {
    return segments[0] === "purpose.md" || segments[0] === "schema.md";
  }
  return segments[0] === "wiki" || segments[0] === "raw";
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

/**
 * The FR-23 action set, unchanged (Story 8.2).
 *
 * These are the three the Review queue already performs. There is no second
 * Review store and no fourth verb: an unknown action is a 400 rather than a
 * silent skip, because "I asked it to create a page and it dismissed the card"
 * is the worst possible reading of a typo.
 */
export const V1_REVIEW_ACTIONS = ["create_page", "deep_research", "skip"] as const;
export type V1ReviewAction = (typeof V1_REVIEW_ACTIONS)[number];

export function isV1ReviewAction(value: unknown): value is V1ReviewAction {
  return (
    typeof value === "string" &&
    (V1_REVIEW_ACTIONS as readonly string[]).includes(value)
  );
}

/**
 * What one review PATCH means, given `{ resolved, action }`.
 *
 * `resolved: false` REOPENS regardless of the action — a caller undoing a
 * dismissal has no action to name. An omitted action with `resolved: true` is a
 * dismissal, because that is the only thing "resolved" can mean without a verb.
 */
export type V1ReviewIntent =
  | { kind: "reopen" }
  | { kind: "skip" }
  | { kind: "create_page" }
  | { kind: "deep_research" }
  | { kind: "invalid" };

export function v1ReviewIntent(body: {
  resolved?: unknown;
  action?: unknown;
}): V1ReviewIntent {
  if (body.action !== undefined && !isV1ReviewAction(body.action)) {
    return { kind: "invalid" };
  }
  if (body.resolved === false) return { kind: "reopen" };
  if (body.action === "create_page") return { kind: "create_page" };
  if (body.action === "deep_research") return { kind: "deep_research" };
  if (body.action === "skip" || body.resolved === true) return { kind: "skip" };
  return { kind: "invalid" };
}

/** Ids one bulk review call may name. A caller with more calls again. */
export const V1_BULK_REVIEW_MAX = 200;

export type V1BulkReviewIntent =
  | { kind: "skip"; ids: string[] }
  | { kind: "reopen"; ids: string[] }
  | { kind: "invalid"; reason: string };

/**
 * What a BULK review PATCH means.
 *
 * Deliberately narrower than {@link v1ReviewIntent}: only the two reversible
 * verbs, and only over an explicit id list. Every refusal carries a `reason`,
 * because "400" alone leaves an agent guessing between "wrong verb", "no ids"
 * and "too many" — three problems with three different fixes.
 */
export function v1BulkReviewIntent(body: {
  ids?: unknown;
  resolved?: unknown;
  action?: unknown;
}): V1BulkReviewIntent {
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((id): id is string => typeof id === "string" && id !== "")
    : [];
  if (ids.length === 0) {
    return { kind: "invalid", reason: "ids is required" };
  }
  if (ids.length > V1_BULK_REVIEW_MAX) {
    return {
      kind: "invalid",
      reason: `at most ${V1_BULK_REVIEW_MAX} ids per call`,
    };
  }
  if (body.resolved === false) return { kind: "reopen", ids };
  if (body.action === "skip" || body.resolved === true) {
    return { kind: "skip", ids };
  }
  if (body.action === "create_page" || body.action === "deep_research") {
    return {
      kind: "invalid",
      reason: `${body.action} is per review: PATCH .../reviews/{reviewId}`,
    };
  }
  return { kind: "invalid", reason: "action must be skip, or resolved false" };
}

// ---------------------------------------------------------------------------
// Wikilink graph export (loopback + cloud façade)
// ---------------------------------------------------------------------------

/**
 * The 4-signal builder names a `[[wikilink]]` this way. The v1 export keeps
 * only those edges — shared-source / type-affinity / Adamic-Adar edges are
 * the Workbench engine, not this route.
 */
export const V1_WIKILINK_SIGNAL = "direct link";

export function isV1WikilinkEdge(edge: {
  source: string;
  target: string;
  signals?: readonly string[];
}): boolean {
  return (edge.signals ?? []).some(
    (signal) => signal === V1_WIKILINK_SIGNAL || signal === "wikilink",
  );
}

/** Undirected pair, or `null` for a self-edge. */
export function v1WikilinkPair(
  source: string,
  target: string,
): { source: string; target: string } | null {
  if (source === target) return null;
  return source < target
    ? { source, target }
    : { source: target, target: source };
}

export function v1PagePath(id: string): string {
  return id.includes("/") ? id : `wiki/${id}.md`;
}

/**
 * FR-76 graph: `[[wikilink]]` only, undirected, `weight` always 1.0.
 */
export function v1WikilinkExport(
  nodes: readonly { id: string; label?: string; type?: string }[],
  edges: readonly {
    source: string;
    target: string;
    signals?: readonly string[];
  }[],
  limit: number,
): {
  truncated: boolean;
  nodeCount: number;
  nodes: {
    id: string;
    label: string;
    nodeType: string | null;
    path: string;
    linkCount: number;
  }[];
  edges: { source: string; target: string; weight: number }[];
} {
  const pairs = new Map<string, { source: string; target: string }>();
  for (const edge of edges) {
    if (!isV1WikilinkEdge(edge)) continue;
    const pair = v1WikilinkPair(edge.source, edge.target);
    if (!pair) continue;
    pairs.set(`${pair.source}\0${pair.target}`, pair);
  }
  const counts = new Map<string, number>();
  for (const pair of pairs.values()) {
    counts.set(pair.source, (counts.get(pair.source) ?? 0) + 1);
    counts.set(pair.target, (counts.get(pair.target) ?? 0) + 1);
  }
  const ranked = nodes
    .map((node) => ({
      id: node.id,
      label: node.label ?? node.id,
      nodeType: node.type ?? null,
      path: v1PagePath(node.id),
      linkCount: counts.get(node.id) ?? 0,
    }))
    .sort(
      (a, b) =>
        b.linkCount - a.linkCount || a.id.localeCompare(b.id),
    );
  const kept = ranked.slice(0, limit);
  const ids = new Set(kept.map((node) => node.id));
  return {
    truncated: kept.length < nodes.length,
    nodeCount: kept.length,
    nodes: kept,
    edges: [...pairs.values()]
      .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
      .map((edge) => ({ ...edge, weight: 1.0 })),
  };
}
