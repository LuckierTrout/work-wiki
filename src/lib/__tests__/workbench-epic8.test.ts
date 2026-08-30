/**
 * Epic 8, the door: who may talk to the loopback API, what it admits them to,
 * and what it says when it will not.
 *
 * WHY THIS FILE EXISTS SEPARATELY from `workbench-epic3.test.ts`: that suite is
 * about Chat's SSE shape and opens the door explicitly to get at it. This one is
 * about the door itself — off, wrong token, env override, port conflict, busy,
 * rate, and which paths the sidecar owns versus proxies. Every row of the spec's
 * I/O matrix that names a status code is asserted here against a real listener
 * rather than against the source text, because "503 disabled" is a behaviour and
 * a source-grep pin would pass on a route that never runs.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import http from "node:http";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  authorizeLoopback,
  createLoadGate,
  extractToken,
  healthPayload,
  isKernelOnlyPath,
  isLoopbackHealth,
  isSidecarOwnedPath,
  kernelProxyPath,
  resolveLoopbackWikiId,
  rewriteProxiedWikiPath,
  LOOPBACK_HOST,
  LOOPBACK_PORT,
  LOOPBACK_STATUSES,
  readLoopbackSettingsFromDisk,
  resolveLoopbackSettings,
  timingSafeEqual,
  V1_BUSY_ERROR,
  V1_DISABLED_ERROR,
  V1_MAX_IN_FLIGHT,
  V1_RATE_LIMIT_PER_SEC,
  V1_RATE_LIMITED_ERROR,
  V1_UNAUTHORIZED_ERROR,
} from "../../../sidecar/loopback.mjs";
import { createSidecarServer } from "../../../sidecar/server.mjs";
import {
  callDoor,
  MCP_BASE_URL,
  MCP_SERVER_NAME,
  registerLoopbackTools,
} from "../../../sidecar/mcp.mjs";
import { SIDECAR_ORIGIN } from "../sidecar";
import * as contract from "../v1-contract";
import { LOOPBACK_BASE_URL, newLoopbackApiToken } from "../v1-contract";
import {
  brandedSkillInstallCommand,
  draftApiTokenMissing,
  draftApiUnauthenticated,
  LOOPBACK_MCP_SERVER_NAME,
  loopbackMcpConfig,
  SETTINGS_API_UNAUTH_OFF_COPY,
  SETTINGS_API_UNAUTH_WARNING_COPY,
  settingsDraftAfterApiEnabled,
  settingsDraftAfterTokenGenerated,
  WORK_WIKI_SKILL_DIR,
} from "../workbench-api-mcp-settings";
import { getLoopbackApiSettings, skillEnabled } from "../config";
import {
  matchSkills,
  parseSkillCommand,
  selectedSkillSummary,
  staleSkillCopy,
} from "../chat-agent";

type Settings = {
  enabled: boolean;
  allowUnauthenticated: boolean;
  token: string | null;
  tokenSource: string;
  skillEnablement: Record<string, boolean>;
};

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    enabled: false,
    allowUnauthenticated: false,
    token: null,
    tokenSource: "none",
    skillEnablement: {},
    ...overrides,
  };
}

const ROOT = path.resolve(__dirname, "../../..");

const open: Server[] = [];

/**
 * A listening sidecar with the settings this test wants, and a kernel that is
 * NOT configured.
 *
 * The absent kernel is deliberate for the door tests: a proxied call must be
 * refused by the door BEFORE anything reaches the kernel, so a suite whose
 * refusals depended on an unreachable upstream would be asserting the wrong
 * thing. The proxy path itself is exercised against a stub kernel below.
 */
async function listen(
  value: Settings,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const source = { current: () => value, refresh: async () => value };
  const server = createSidecarServer({
    settingsSource: source,
    kernel: { base: "", token: "" },
    ...extra,
  }) as Server;
  open.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await Promise.all(
    open.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("the two copies of the contract cannot drift", () => {
  it("spells every shared constant identically on both sides of AD-6", () => {
    // AD-6 forbids the sidecar importing `src/lib`, so `loopback.mjs` keeps its
    // own copy of the handful of constants the door needs. That is the deal the
    // rule buys, and THIS is the payment: a value changed on one side and not
    // the other fails here rather than at a client that gets a 401 from one host
    // and a 200 from the other.
    expect(LOOPBACK_HOST).toBe(contract.LOOPBACK_HOST);
    expect(LOOPBACK_PORT).toBe(contract.LOOPBACK_PORT);
    expect(V1_DISABLED_ERROR).toBe(contract.V1_DISABLED_ERROR);
    expect(V1_BUSY_ERROR).toBe(contract.V1_BUSY_ERROR);
    expect(V1_UNAUTHORIZED_ERROR).toBe(contract.V1_UNAUTHORIZED_ERROR);
    expect(V1_RATE_LIMITED_ERROR).toBe(contract.V1_RATE_LIMITED_ERROR);
    expect(V1_MAX_IN_FLIGHT).toBe(contract.V1_MAX_IN_FLIGHT);
    expect(V1_RATE_LIMIT_PER_SEC).toBe(contract.V1_RATE_LIMIT_PER_SEC);
    expect(LOOPBACK_STATUSES).toEqual([...contract.LOOPBACK_STATUSES]);
  });

  it("keeps generateChat in chat-provider and sidecar modules off src/lib", async () => {
    const provider = await readFile(
      path.join(ROOT, "sidecar/chat-provider.mjs"),
      "utf8",
    );
    const transport = await readFile(
      path.join(ROOT, "sidecar/chat-transport.mjs"),
      "utf8",
    );
    const server = await readFile(path.join(ROOT, "sidecar/server.mjs"), "utf8");
    expect(provider).toMatch(/export async function generateChat\(/);
    expect(server).not.toMatch(/export async function generateChat\(/);
    expect(server).toMatch(/from ["']\.\/chat-provider\.mjs["']/);
    for (const src of [provider, transport, server]) {
      expect(src).not.toMatch(/from\s+["'][^"']*src\/lib/);
      expect(src).not.toMatch(/import\s*\(\s*["'][^"']*src\/lib/);
    }
  });

  it("reports the same version from the constant as from the manifest", async () => {
    // The cloud façade uses the literal (a Worker should not bundle the manifest
    // to read one string); the sidecar reads `package.json` off the owner's
    // disk. A version bump therefore has to touch both, and this is what says so.
    const manifest = JSON.parse(
      await readFile(path.join(ROOT, "package.json"), "utf8"),
    ) as { version?: string };
    expect(contract.V1_APP_VERSION).toBe(manifest.version);
    expect(healthPayload().version).toBe(manifest.version);
  });

  it("clamps rather than refuses, at the numbers the matrix names", () => {
    expect(contract.clampTopK(99)).toBe(50);
    expect(contract.clampTopK(0)).toBe(1);
    expect(contract.clampTopK(undefined)).toBe(contract.V1_DEFAULT_TOP_K);
    expect(contract.clampGraphLimit(9_999)).toBe(1_000);
    expect(contract.clampGraphLimit(undefined)).toBe(
      contract.V1_DEFAULT_GRAPH_LIMIT,
    );
    // An agent asking for the whole graph of a large wiki wants as much as it can
    // have — a 400 would leave it with nothing and no idea what to ask for next.
    expect(contract.clampGraphLimit(-5)).toBe(1);
    const exported = contract.v1WikilinkExport(
      [
        { id: "b", label: "B" },
        { id: "a", label: "A" },
      ],
      [
        { source: "a", target: "b", signals: ["direct link"] },
        { source: "b", target: "a", signals: ["direct link"] },
        { source: "a", target: "a", signals: ["direct link"] },
        { source: "a", target: "b", signals: ["shared source"] },
      ],
      10,
    );
    expect(exported.edges).toEqual([{ source: "a", target: "b", weight: 1 }]);
    expect(exported.nodes.map((node) => node.linkCount)).toEqual([1, 1]);
  });

  it("accepts a path as {id} on loopback only", async () => {
    const wikiPath = await mkdtemp(path.join(os.tmpdir(), "epic8-loopback-id-"));
    const registeredPath = await realpath(wikiPath);
    for (const id of ["current", "8f4e2c1a-0000-4000-8000-000000000000"]) {
      expect(contract.isCloudWikiId(id)).toBe(true);
      expect(contract.isLoopbackWikiId(id)).toBe(true);
    }
    // A spoken Wiki NAME is not an id on either host: the Workbench resolves a
    // name to a UUID before it calls anything, and a route that guessed would
    // bind a caller to a Wiki they did not pick.
    expect(contract.isCloudWikiId("Work Notes")).toBe(false);
    expect(contract.isLoopbackWikiId("Work Notes")).toBe(false);
    // A path is meaningless on a Worker — there is no such disk.
    expect(contract.isCloudWikiId("/Users/me/wiki")).toBe(false);
    expect(contract.isLoopbackWikiId("/Users/me/wiki")).toBe(true);
    // …and a traversal segment means the caller is composing an address rather
    // than naming one.
    expect(contract.isLoopbackWikiId("/Users/me/../etc")).toBe(false);
    expect(resolveLoopbackWikiId(wikiPath)).toBeNull();
    expect(
      resolveLoopbackWikiId(wikiPath, [
        { id: "8f4e2c1a-0000-4000-8000-000000000000", path: registeredPath },
      ]),
    ).toBe("8f4e2c1a-0000-4000-8000-000000000000");
    expect(resolveLoopbackWikiId("Work Notes")).toBeNull();
    expect(
      rewriteProxiedWikiPath("/api/v1/projects/%2FUsers%2Fme%2Fwiki/files"),
    ).toBeNull();
  });
});

describe("the door is shut until the owner opens it", () => {
  it("answers 503 disabled on a data route and still answers health", async () => {
    const base = await listen(settings({ enabled: false }));

    const data = await fetch(`${base}/api/v1/skills`);
    expect(data.status).toBe(503);
    await expect(data.json()).resolves.toEqual({ error: V1_DISABLED_ERROR });

    // HEALTH IS THE ONE ROUTE THAT ANSWERS WHILE THE API IS OFF, and it says so
    // rather than pretending nothing is there. "The wiki is here and switched
    // off" is the only version of this an owner can act on.
    const health = await fetch(`${base}/api/v1/health`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as Record<string, unknown>;
    expect(body.enabled).toBe(false);
    expect(body.status).toBe("running");
    expect(isLoopbackHealth(body)).toBe(true);
  });

  it("answers 503 disabled rather than proxying, with no kernel configured", async () => {
    const base = await listen(settings({ enabled: false }));
    const proxied = await fetch(`${base}/api/v1/projects`);
    expect(proxied.status).toBe(503);
    await expect(proxied.json()).resolves.toEqual({ error: V1_DISABLED_ERROR });
  });

  it("treats an absent settings answer as shut, not as unlocked", () => {
    // The window before the first poll lands. A door that admitted callers here
    // would be an unauthenticated API that appears and disappears on a timer.
    expect(authorizeLoopback(null, "anything")).toEqual({
      ok: false,
      status: 503,
      error: V1_DISABLED_ERROR,
    });
  });
});

describe("the token", () => {
  it("401s a missing or wrong token and never echoes what was sent", async () => {
    const base = await listen(settings({ enabled: true, token: "right-token" }));

    for (const init of [
      undefined,
      { headers: { authorization: "Bearer wrong-token" } },
      { headers: { "x-llm-wiki-token": "wrong-token" } },
    ] as (RequestInit | undefined)[]) {
      const response = await fetch(`${base}/api/v1/skills`, init);
      expect(response.status).toBe(401);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ error: V1_UNAUTHORIZED_ERROR });
      // NOT the provided token, NOT its length, NOT a redacted form of it. The
      // body is the one word — an echo would turn the door into an oracle.
      expect(text).not.toContain("wrong-token");
      expect(text).not.toContain("right-token");
    }

    const wrongQuery = await fetch(`${base}/api/v1/skills?token=wrong-token`);
    expect(wrongQuery.status).toBe(401);
  });

  it("admits the right token by Bearer, header, or query", async () => {
    const base = await listen(settings({ enabled: true, token: "right-token" }));
    const accepted = await Promise.all([
      fetch(`${base}/api/v1/skills`, {
        headers: { authorization: "Bearer right-token" },
      }),
      fetch(`${base}/api/v1/skills`, {
        headers: { "x-llm-wiki-token": "right-token" },
      }),
      // LAST RESORT, and supported only because some MCP clients cannot set a
      // header at all — which is why the copyable config puts the token in env.
      fetch(`${base}/api/v1/skills?token=right-token`),
    ]);
    for (const response of accepted) expect(response.status).toBe(200);
  });

  it("reads the three carriers in Bearer, header, query order", () => {
    const url = new URL("http://127.0.0.1/api/v1/skills?token=from-query");
    expect(
      extractToken(
        { authorization: "Bearer from-bearer", "x-llm-wiki-token": "from-header" },
        url,
      ),
    ).toBe("from-bearer");
    expect(extractToken({ "x-llm-wiki-token": "from-header" }, url)).toBe("from-header");
    expect(extractToken({}, url)).toBe("from-query");
    expect(extractToken({}, new URL("http://127.0.0.1/api/v1/skills"))).toBeNull();
    // A client sending the header AND a stale query string is not told its
    // credential is wrong — first match wins, rather than "all must agree".
    expect(
      extractToken(
        { "x-llm-wiki-token": "from-header" },
        new URL("http://127.0.0.1/x?token=stale"),
      ),
    ).toBe("from-header");
  });

  it("compares in constant time and refuses a length mismatch", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("abc", null as unknown as string)).toBe(false);
  });

  it("admits a tokenless caller only when the owner turned unauth on", async () => {
    const shut = await listen(settings({ enabled: true, allowUnauthenticated: false }));
    // API on, no token generated: 401, not 500. Nothing is broken — the honest
    // answer is "you are not authorized", and health says why.
    expect((await fetch(`${shut}/api/v1/skills`)).status).toBe(401);

    const openDoor = await listen(
      settings({ enabled: true, allowUnauthenticated: true }),
    );
    expect((await fetch(`${openDoor}/api/v1/skills`)).status).toBe(200);

    // …and unauth does not survive the API being switched off. An owner who shut
    // the door did not thereby open it to everyone.
    const off = await listen(
      settings({ enabled: false, allowUnauthenticated: true }),
    );
    expect((await fetch(`${off}/api/v1/skills`)).status).toBe(503);
  });
});

describe("the env token wins", () => {
  it("accepts the env token, reports tokenSource env, and 401s the store token", async () => {
    const resolved = resolveLoopbackSettings(
      { enabled: true, allowUnauthenticated: false, token: "store-token" },
      { LLM_WIKI_API_TOKEN: "env-token" },
    );
    expect(resolved.token).toBe("env-token");
    expect(resolved.tokenSource).toBe("env");

    const base = await listen(resolved as Settings);
    expect(
      (
        await fetch(`${base}/api/v1/skills`, {
          headers: { authorization: "Bearer env-token" },
        })
      ).status,
    ).toBe(200);
    // THE STORE TOKEN IS NOT A SECOND VALID PASSWORD. An owner who set the
    // variable believes the stored one is superseded, and a door that took both
    // would keep a credential alive that they think they rotated.
    expect(
      (
        await fetch(`${base}/api/v1/skills`, {
          headers: { authorization: "Bearer store-token" },
        })
      ).status,
    ).toBe(401);
  });

  it("does not let the env variable switch the API on by itself", () => {
    const resolved = resolveLoopbackSettings(
      { enabled: false, token: null },
      { LLM_WIKI_API_TOKEN: "env-token" },
    );
    // A credential is not a decision: `enabled` comes from the kernel store only.
    expect(resolved.enabled).toBe(false);
    expect(resolved.tokenSource).toBe("env");
    expect(authorizeLoopback(resolved, "env-token").ok).toBe(false);
  });

  it("falls back to store and none, and keeps Skill enablement kernel-only", () => {
    const stored = resolveLoopbackSettings(
      { enabled: true, token: "store-token", skillEnablement: { "project:a": false } },
      {},
    );
    expect(stored.tokenSource).toBe("store");
    expect(stored.skillEnablement).toEqual({ "project:a": false });

    expect(resolveLoopbackSettings({ enabled: true }, {}).tokenSource).toBe("none");
    // Absent is `{}` and never `null`, because absent from the map MEANS enabled
    // and `scanSkills` indexes it directly.
    expect(resolveLoopbackSettings(null, {}).skillEnablement).toEqual({});
  });

  it("reads the same three keys off a local kernel's config file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "epic8-config-"));
    await writeFile(
      path.join(dir, ".llm-wiki-config.json"),
      JSON.stringify({
        apiEnabled: true,
        allowUnauthenticated: true,
        loopbackApiToken: "disk-token",
        skillEnablement: { "user:notes": false },
      }),
      "utf8",
    );
    const fromDisk = readLoopbackSettingsFromDisk(dir);
    expect(fromDisk).toMatchObject({
      enabled: true,
      allowUnauthenticated: true,
      token: "disk-token",
    });
    expect(fromDisk?.skillEnablement).toEqual({ "user:notes": false });

    // A machine with no config file is not an error — it is a door that stays
    // shut, which `authorizeLoopback` already reads as `disabled`.
    expect(readLoopbackSettingsFromDisk(await mkdtemp(path.join(os.tmpdir(), "epic8-empty-")))).toBeNull();
  });
});

describe("health is honest about which process answered", () => {
  it("carries every field, derives authRequired, and never carries the token", () => {
    const health = healthPayload({
      settings: settings({ enabled: true, token: "secret-token", tokenSource: "store" }),
    });
    expect(health).toEqual({
      ok: true,
      status: "running",
      version: expect.any(String),
      enabled: true,
      authRequired: true,
      authConfigured: true,
      allowUnauthenticated: false,
      tokenSource: "store",
    });
    // `authConfigured` says a token EXISTS, never what it is. Those two booleans
    // together are why the branded skill can say "generate a token" rather than
    // retrying a 401 forever.
    expect(JSON.stringify(health)).not.toContain("secret-token");

    expect(
      healthPayload({
        settings: settings({ enabled: true, allowUnauthenticated: true }),
      }).authRequired,
    ).toBe(false);
  });

  it("names port_conflict, and reads a foreign payload on 19828 as one", () => {
    expect(LOOPBACK_STATUSES).toEqual(["starting", "running", "port_conflict", "error"]);
    const conflict = healthPayload({ status: "port_conflict" });
    expect(conflict.status).toBe("port_conflict");
    // `ok` is about the LISTENER: somebody else owns the port, so this process
    // is not serving, and a caller reading `ok` gets the truth.
    expect(conflict.ok).toBe(false);
    expect(isLoopbackHealth(conflict)).toBe(true);

    // A foreign HTTP server answers SOMETHING — an HTML page, a Prometheus dump,
    // another tool's JSON. None of it is a wiki, and a caller that read any 2xx
    // as "the wiki is up" would go on to describe a wiki that process has never
    // heard of.
    for (const foreign of [
      null,
      "OK",
      {},
      { ok: true },
      { ok: true, status: "ok", version: "1", enabled: true },
    ]) {
      expect(isLoopbackHealth(foreign)).toBe(false);
    }
  });

  it("binds the loopback host and port the product points at", () => {
    expect(LOOPBACK_HOST).toBe("127.0.0.1");
    expect(LOOPBACK_PORT).toBe(19828);
    // One origin, spelled once. `SIDECAR_ORIGIN` is what the Workbench fetches,
    // `LOOPBACK_BASE_URL` is what Settings shows the owner, and `MCP_BASE_URL`
    // is what the copyable config points a client at — three readers of one fact.
    expect(SIDECAR_ORIGIN).toBe(`http://${LOOPBACK_HOST}:${LOOPBACK_PORT}`);
    expect(LOOPBACK_BASE_URL).toBe(SIDECAR_ORIGIN);
    expect(MCP_BASE_URL).toBe(SIDECAR_ORIGIN);
  });
});

describe("load shedding", () => {
  it("admits the cap and answers 503 busy to the next one", () => {
    const gate = createLoadGate({ maxInFlight: 2, ratePerSecond: 1000 });
    const first = gate.enter();
    const second = gate.enter();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(gate.enter()).toEqual({ ok: false, status: 503, error: V1_BUSY_ERROR });
    // Release is idempotent: a handler that both `finally`s and error-paths must
    // not decrement twice, or the cap drifts down until the door is permanently
    // busy.
    first.release?.();
    first.release?.();
    expect(gate.inFlight).toBe(1);
    expect(gate.enter().ok).toBe(true);
  });

  it("answers 429 past the per-second rate and refills on the next window", () => {
    let clock = 1_000;
    const gate = createLoadGate({
      maxInFlight: 1000,
      ratePerSecond: 3,
      now: () => clock,
    });
    for (let i = 0; i < 3; i += 1) expect(gate.enter().ok).toBe(true);
    expect(gate.enter()).toEqual({
      ok: false,
      status: 429,
      error: V1_RATE_LIMITED_ERROR,
    });
    // A runaway agent loop is FAST, not slow, which is why this cap exists
    // beside the in-flight one — 429 is the status every client already knows
    // how to back off from.
    clock += 1_000;
    expect(gate.enter().ok).toBe(true);
  });

  it("ships the caps the spec names", () => {
    expect(V1_MAX_IN_FLIGHT).toBe(64);
    expect(V1_RATE_LIMIT_PER_SEC).toBe(120);
  });

  it("does not shed health, so a busy sidecar is still diagnosable", async () => {
    const base = await listen(settings({ enabled: true, allowUnauthenticated: true }), {
      gate: createLoadGate({ maxInFlight: 0 }),
    });
    expect((await fetch(`${base}/api/v1/health`)).status).toBe(200);
    const shed = await fetch(`${base}/api/v1/skills`);
    expect(shed.status).toBe(503);
    await expect(shed.json()).resolves.toEqual({ error: V1_BUSY_ERROR });
  });
});

describe("who owns which path", () => {
  it("keeps Chat, Skills, workspace reads and health on the sidecar", () => {
    for (const owned of [
      "/api/v1/health",
      "/api/v1/skills",
      "/api/v1/workspace/file",
      "/api/v1/projects/current/chat",
      "/api/v1/chat",
    ]) {
      expect(isSidecarOwnedPath(owned)).toBe(true);
      expect(kernelProxyPath(owned)).toBeNull();
    }
  });

  it("proxies wiki data to the kernel unchanged", () => {
    for (const proxied of [
      "/api/v1/projects",
      "/api/v1/projects/current/files",
      "/api/v1/projects/current/files/content",
      "/api/v1/projects/current/reviews",
      "/api/v1/projects/current/search",
      "/api/v1/projects/current/graph",
      "/api/v1/projects/current/sources/rescan",
    ]) {
      expect(kernelProxyPath(proxied)).toBe(proxied);
    }
    // Nothing outside `/api/v1` is proxied at all — the door is not an open
    // relay onto the kernel's whole surface.
    expect(kernelProxyPath("/api/settings")).toBeNull();
    expect(kernelProxyPath("/api/ingest")).toBeNull();
  });

  it("refuses to proxy the three kernel-only routes", () => {
    // `loopback-settings` would hand the door's own token to anything that got
    // through the door; `web-search` spends the owner's provider budget; and
    // `retrieve` is Chat's internal assemble, not an FR-76 route. Each is
    // reachable from the kernel side and none of them through 19828.
    for (const blocked of [
      "/api/v1/loopback-settings",
      "/api/v1/web-search",
      "/api/v1/projects/current/retrieve",
    ]) {
      expect(isKernelOnlyPath(blocked)).toBe(true);
      expect(kernelProxyPath(blocked)).toBeNull();
    }
  });

  it("404s a v1 path nobody owns", async () => {
    const base = await listen(
      settings({ enabled: true, allowUnauthenticated: true }),
    );
    const response = await fetch(`${base}/api/v1/loopback-settings`);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
  });

  it("forwards a proxied call to the kernel with the automation bearer", async () => {
    const seen: { url: string; auth: string | undefined }[] = [];
    const kernel = http.createServer((req, res) => {
      seen.push({ url: req.url ?? "", auth: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ projects: [] }));
    });
    open.push(kernel);
    await new Promise<void>((resolve) => kernel.listen(0, "127.0.0.1", resolve));
    const kernelPort = (kernel.address() as { port: number }).port;

    const base = await listen(
      settings({ enabled: true, allowUnauthenticated: true }),
      {
        kernel: {
          base: `http://127.0.0.1:${kernelPort}`,
          token: "automation-token",
        },
      },
    );
    const response = await fetch(`${base}/api/v1/projects`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ projects: [] });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/api/v1/projects");
    // The DOOR's token is not the KERNEL's token. What the caller presented at
    // 19828 stays at 19828; the hop inland carries owner automation.
    expect(seen[0].auth).toBe("Bearer automation-token");
  });
});

describe("the copyable MCP config", () => {
  it("names the frozen server, points at the loopback door, and keeps the token in env", async () => {
    // The MCP server name is a frozen identifier — a rename orphans every client
    // config an owner has already saved. Settings and the wrap must also agree:
    // two spellings of the server name would be two servers to the client.
    expect(MCP_SERVER_NAME).toBe("yopedia");
    expect(LOOPBACK_MCP_SERVER_NAME).toBe(MCP_SERVER_NAME);

    const config = loopbackMcpConfig("shown-token");
    const parsed = JSON.parse(config) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    const entry = parsed.mcpServers[MCP_SERVER_NAME];
    expect(entry.command).toBe("node");
    expect(entry.args).toHaveLength(1);
    expect(entry.args[0].endsWith(`${path.sep}sidecar${path.sep}mcp.mjs`)).toBe(
      true,
    );
    expect(path.isAbsolute(entry.args[0])).toBe(true);
    // The token rides in `env`, never inlined into a URL: a URL is the thing an
    // owner screenshots and a proxy logs.
    expect(entry.env.LLM_WIKI_API_TOKEN).toBe("shown-token");
    expect(config).not.toMatch(/token=shown-token/);

    // With no plaintext token in hand — the ordinary case, because the server
    // never serves a stored token back — the config is still valid and says
    // where to paste.
    expect(
      JSON.parse(loopbackMcpConfig(null)).mcpServers[MCP_SERVER_NAME].env
        .LLM_WIKI_API_TOKEN,
    ).toBe("PASTE_YOUR_TOKEN");

    const wrap = await readFile(path.join(process.cwd(), "sidecar/mcp.mjs"), "utf8");
    expect(wrap).toContain("tools: true");
    expect(wrap).toContain("allowWrites: false");
  });

  it("installs the branded pack from this repo rather than fetching it", () => {
    expect(brandedSkillInstallCommand()).toContain(WORK_WIKI_SKILL_DIR);
    expect(brandedSkillInstallCommand()).not.toMatch(/curl|wget|npx|git clone/);
  });
});

describe("Settings → API + MCP", () => {
  /**
   * A draft with only the fields these rules read.
   *
   * The pane's draft carries every provider credential too; spelling all of them
   * here would make the test about the fixture rather than about the two
   * booleans the rules turn on.
   */
  const draft = (over: Record<string, unknown>) =>
    ({
      apiEnabled: false,
      allowUnauthenticated: false,
      loopbackApiToken: "",
      ...over,
    }) as never;

  it("reads an absent config as a door that is shut", () => {
    // NOT THE DEFAULT is the whole matrix row. An owner who has never opened
    // this pane has a wiki nothing on the machine can read — and both keys are
    // absent from the config of every workspace that predates Epic 8.
    expect(getLoopbackApiSettings({})).toEqual({
      enabled: false,
      allowUnauthenticated: false,
      token: null,
      tokenSource: "none",
    });
    // Skills go the other way on purpose: absent means ENABLED, so a newly
    // scanned pack is usable without a visit to Settings.
    expect(skillEnabled("project:notes", undefined)).toBe(true);
    expect(skillEnabled("project:notes", { "project:notes": false })).toBe(false);
  });

  it("warns only while the draft would admit an untokened caller", () => {
    // Read off the DRAFT, so the orange sentence appears when the owner ticks
    // the box rather than after the Save that opened the door.
    expect(
      draftApiUnauthenticated(draft({ apiEnabled: true, allowUnauthenticated: true })),
    ).toBe(true);
    expect(
      draftApiUnauthenticated(draft({ apiEnabled: false, allowUnauthenticated: true })),
    ).toBe(false);
    expect(
      draftApiUnauthenticated(draft({ apiEnabled: true, allowUnauthenticated: false })),
    ).toBe(false);
    expect(SETTINGS_API_UNAUTH_WARNING_COPY).not.toBe(SETTINGS_API_UNAUTH_OFF_COPY);
  });

  it("clears unauthenticated access when the door is shut", () => {
    const shut = settingsDraftAfterApiEnabled(
      draft({ apiEnabled: true, allowUnauthenticated: true }),
      false,
    );
    expect(shut).toMatchObject({ apiEnabled: false, allowUnauthenticated: false });
    // A later re-open therefore cannot silently re-open it unauthenticated.
    expect(settingsDraftAfterApiEnabled(shut, true).allowUnauthenticated).toBe(false);
  });

  it("says the door is shut to everyone rather than blocking Save", () => {
    const on = draft({ apiEnabled: true, allowUnauthenticated: false });
    // On, unauth off, no token: a safe and honest state, and a SENTENCE so the
    // owner is not left wondering why their agent gets 401.
    expect(draftApiTokenMissing(on, { loopbackTokenSource: "none" } as never)).toBe(
      true,
    );
    // An env-supplied token is a token, even though this pane never saw it.
    expect(draftApiTokenMissing(on, { loopbackTokenSource: "env" } as never)).toBe(
      false,
    );
    // A token this pane just minted counts before it is saved.
    expect(
      draftApiTokenMissing(
        settingsDraftAfterTokenGenerated(on, "a".repeat(48)),
        { loopbackTokenSource: "none" } as never,
      ),
    ).toBe(false);
  });

  it("mints a token wide enough that guessing it is not a strategy", () => {
    const token = newLoopbackApiToken();
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(newLoopbackApiToken()).not.toBe(token);
    // No scheme prefix: the token travels to third-party clients, and a
    // recognisable prefix would tell a log scraper what it had found.
    expect(token).not.toMatch(/^(wk|ww|yp|sk)/);
  });
});

describe("/skill completion sees enabled Skills only", () => {
  const skills = [
    { id: "project:notes", name: "Notes", description: "", scope: "project", enabled: true },
    { id: "project:recap", name: "Recap", description: "", scope: "project", enabled: true },
    { id: "user:legacy", name: "Legacy", description: "", scope: "user", enabled: false },
  ];

  it("parses the command, and reads the bare form as clear", () => {
    // The bare form CLEARS rather than erroring, because "run without a Skill"
    // needs a way to be said.
    expect(parseSkillCommand("/skill")).toEqual({ kind: "clear" });
    expect(parseSkillCommand("/skill rec")).toEqual({ kind: "query", term: "rec" });
    // Ordinary prose is not a command — a message that happens to mention a
    // Skill mid-sentence must still be sendable.
    expect(parseSkillCommand("what does /skill do?").kind).toBe("none");
    expect(parseSkillCommand("tell me about /skill notes").kind).toBe("none");
  });

  it("never offers a disabled Skill", () => {
    expect(matchSkills(skills, "").map((s) => s.name)).toEqual(["Notes", "Recap"]);
    expect(matchSkills(skills, "leg")).toEqual([]);
    // …and a conversation still pointing at one says so instead of silently
    // running without it.
    expect(selectedSkillSummary(skills, "user:legacy")).toBeNull();
    expect(staleSkillCopy("user:legacy")).not.toBe("");
    expect(selectedSkillSummary(skills, "project:notes")?.name).toBe("Notes");
  });
});

describe("the stock MCP wrap", () => {
  /** A `server` that records registrations instead of speaking MCP. */
  function recordingServer() {
    const tools = new Map<
      string,
      { description: string; annotations?: Record<string, unknown> }
    >();
    return {
      tools,
      registerTool(
        name: string,
        spec: { description: string; annotations?: Record<string, unknown> },
      ) {
        tools.set(name, spec);
      },
    };
  }

  it("registers the FR-76 tools and nothing that can only fail", () => {
    const server = recordingServer();
    registerLoopbackTools(server as never, { call: async () => ({ ok: true, text: "" }) });
    expect([...server.tools.keys()].sort()).toEqual([
      "chat",
      "files",
      "graph",
      "health",
      "projects",
      "read_file",
      "rescan_sources",
      "reviews",
      "search",
    ]);
    // No page-write tool and no settings tool: the door does not expose them, so
    // a wrap that offered them would be advertising a call that can only fail.
    for (const name of server.tools.keys()) {
      expect(name).not.toMatch(/write|delete|ingest|settings|token/);
    }
  });

  it("is read-only everywhere except rescan and chat", () => {
    const server = recordingServer();
    registerLoopbackTools(server as never, { call: async () => ({ ok: true, text: "" }) });
    for (const [name, spec] of server.tools) {
      const readOnly = spec.annotations?.readOnlyHint === true;
      // Rescan schedules compiles and chat spends a model call. Everything else
      // only reads, and says so — a client that batches read-only tools would
      // otherwise batch a rescan.
      expect({ name, readOnly }).toEqual({
        name,
        readOnly: name !== "rescan_sources" && name !== "chat",
      });
    }
  });

  it("sends the token from the environment and never puts it in the URL", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const result = await callDoor("/api/v1/projects", {
      token: "env-token",
      fetchImpl: async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return new Response('{"projects":[]}', { status: 200 });
      },
    });
    expect(result).toEqual({ ok: true, text: '{"projects":[]}' });
    expect(seen[0].url).toBe(`${MCP_BASE_URL}/api/v1/projects`);
    expect(seen[0].url).not.toContain("env-token");
    expect(
      (seen[0].init.headers as Record<string, string>).authorization,
    ).toBe("Bearer env-token");
  });

  it("says the sidecar is not running when the connection is refused", async () => {
    const result = await callDoor("/api/v1/projects", {
      token: "t",
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    // The one diagnosis a client cannot reach on its own: every other failure
    // arrives as an HTTP status with a body.
    expect(result.ok).toBe(false);
    expect(result.text).toContain("Could not reach");
    expect(result.text).toContain("pnpm sidecar");
  });

  it("passes the door's own refusal word through unparaphrased", async () => {
    const result = await callDoor("/api/v1/projects", {
      token: "t",
      fetchImpl: async () =>
        new Response('{"error":"unauthorized"}', { status: 401 }),
    });
    // `disabled`, `unauthorized`, `busy` and `rate_limited` are all actionable,
    // and a paraphrase would lose that.
    expect(result.ok).toBe(false);
    expect(result.text).toContain("401");
    expect(result.text).toContain("unauthorized");
  });
});

describe("the branded Agent Skill pack", () => {
  async function pack(file: string): Promise<string> {
    return readFile(path.join(ROOT, "skills", "work-wiki", file), "utf8");
  }

  it("ships the four files Settings' install command copies", async () => {
    for (const file of ["SKILL.md", "api-reference.md", "examples.md", "README.md"]) {
      expect((await pack(file)).length).toBeGreaterThan(200);
    }
  });

  it("tells the agent to probe health first and to stop when there is no token", async () => {
    const skill = await pack("SKILL.md");
    expect(skill).toContain("/api/v1/health");
    // THE STOP CONDITION, in the pack rather than in prose we hope a model
    // infers: `authConfigured: false` with unauth off means generate a token,
    // and retrying the data routes would just be a 401 loop.
    expect(skill).toContain("authConfigured");
    expect(skill).toMatch(/generate a token|Generate/i);
    // The two failures that look alike from outside are named separately, and
    // the port-conflict row says not to describe a wiki it has not read.
    expect(skill).toMatch(/owns port 19828/i);
    expect(skill).toMatch(/do not describe a wiki/i);
    expect(skill).toMatch(/connection refused|not running/i);
  });

  it("says not to fabricate when a search comes back empty", async () => {
    const skill = await pack("SKILL.md");
    expect(skill).toMatch(/never fabricate/i);
    expect(skill).toMatch(/no results|no coverage/i);
    expect(skill).toMatch(/do not answer from your own knowledge/i);
    // Lookup order, so an agent does not answer from the project list alone.
    expect(skill).toMatch(/search/i);
    expect(skill).toMatch(/cite/i);
  });

  it("defaults to the current project and documents this fork's chat route", async () => {
    const skill = await pack("SKILL.md");
    expect(skill).toContain("current");
    // The stock nashsu skill must not `POST /chat`; the branded pack is where
    // that route is documented, because it is this fork's local Agent.
    expect(skill).toContain("/api/v1/projects/{id}/chat");
    expect(await pack("README.md")).toMatch(/nashsu|stock/i);
  });

  it("documents every FR-76 route in the reference", async () => {
    const reference = await pack("api-reference.md");
    for (const route of [
      "/api/v1/health",
      "/api/v1/projects",
      "/api/v1/projects/{id}/files",
      "/api/v1/projects/{id}/files/content",
      "/api/v1/projects/{id}/search",
      "/api/v1/projects/{id}/reviews",
      "/api/v1/projects/{id}/reviews/resolve",
      "/api/v1/projects/{id}/graph",
      "/api/v1/projects/{id}/sources/rescan",
      "/api/v1/projects/{id}/chat",
    ]) {
      expect(reference).toContain(route);
    }
  });
});
