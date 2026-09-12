import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startExtractLoop } from "../../../sidecar/extract-loop.mjs";
import { createSidecarServer, loadSidecarEnvFromFiles } from "../../../sidecar/server.mjs";
import { createPairingSource, SIDECAR_PAIRING_PROTOCOL as SERVER_PROTOCOL, SIDECAR_INSTANCE_HEADER as SERVER_HEADER } from "../../../sidecar/pairing.mjs";
import { localSidecarIdentity } from "../../../tools/sidecar-identity.mjs";
import { bindLoopback, sidecarHarness } from "./sidecar-harness";
import { loopbackFetch } from "../loopback-client";
import { SIDECAR_PAIRING_PROTOCOL, SIDECAR_INSTANCE_HEADER, matchesSidecarPairing } from "../sidecar-pairing";
import { LOOPBACK_HEALTH_URL } from "../v1-contract";

const harness = sidecarHarness();
const realFetch = globalThis.fetch;
const pair = { protocol: 1, instance: "app-A", localIdentity: "checkout-A" };
const settings = { enabled: true, allowUnauthenticated: false, token: "door-token", tokenSource: "store", skillEnablement: {} };
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await harness.closeAll(); });

async function startPair() {
  let livePair: unknown = pair;
  let doorToken = settings.token;
  let settingsUp = true;
  let writes = 0;
  const kernel = http.createServer((req, res) => {
    if (req.url === "/api/v1/loopback-settings") {
      res.writeHead(settingsUp ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...settings, token: doorToken, pairing: livePair }));
    } else { writes++; res.writeHead(200); res.end(JSON.stringify({ written: true })); }
  });
  harness.track(kernel);
  const base = await bindLoopback(kernel);
  const target = { base, token: "kernel-token" };
  const pairingSource = createPairingSource({ kernel: target, localIdentity: "checkout-A", fetchImpl: realFetch });
  const sidecar = createSidecarServer({ kernel: target, pairingSource,
    settingsSource: { current: () => ({ ...settings, token: doorToken }), refresh: async () => ({ ...settings, token: doorToken }) },
    workspace: { read: async () => ({ status: 200, body: { content: "paired workspace" } }) } as never,
  });
  harness.track(sidecar);
  const sidecarBase = await bindLoopback(sidecar);
  return { base, sidecarBase, pairingSource, writes: () => writes,
    switchPair: (value: unknown) => { livePair = value; },
    rotate: () => { doorToken = "rotated-token"; },
    fail: () => { settingsUp = false; },
  };
}

describe("sidecar instance boundary over real HTTP", () => {
  it("keeps both protocol copies aligned and fingerprints checkout and data root", () => {
    expect(SERVER_PROTOCOL).toBe(SIDECAR_PAIRING_PROTOCOL);
    expect(SERVER_HEADER).toBe(SIDECAR_INSTANCE_HEADER);
    expect(localSidecarIdentity(process.cwd(), "/tmp/store-A")).not.toBe(localSidecarIdentity(process.cwd(), "/tmp/store-B"));
    expect(localSidecarIdentity(process.cwd())).not.toBe(localSidecarIdentity("/tmp"));
  });
  it("attests fresh settings, rejects another checkout, and never retains a failed proof", async () => {
    const live = await startPair();
    expect(await live.pairingSource.read()).toEqual(pair);
    live.switchPair({ ...pair, localIdentity: "checkout-B" });
    expect(await live.pairingSource.read()).toBeNull();
    live.switchPair(pair);
    expect(await live.pairingSource.read()).toEqual(pair);
    live.fail();
    expect(await live.pairingSource.read()).toBeNull();
  });
  it("rejects stale/missing browser identities before Chat, workspace, Skills or proxy work", async () => {
    const live = await startPair();
    for (const route of ["/api/v1/projects/current/chat", "/api/v1/workspace/file", "/api/v1/skills", "/api/v1/projects"]) {
      for (const instance of ["app-B", ""]) {
        const response = await realFetch(live.sidecarBase + route, {
          method: route.includes("chat") || route.endsWith("projects") ? "POST" : "GET",
          headers: { origin: live.base, authorization: "Bearer door-token", [SIDECAR_INSTANCE_HEADER]: instance },
        });
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: "sidecar_pairing_mismatch" });
      }
    }
    expect(live.writes()).toBe(0);
    const passed = await realFetch(live.sidecarBase + "/api/v1/workspace/file", {
      headers: { origin: live.base, authorization: "Bearer door-token", [SIDECAR_INSTANCE_HEADER]: pair.instance },
    });
    expect(await passed.json()).toEqual({ content: "paired workspace" });
    const wrongToken = await realFetch(live.sidecarBase + "/api/v1/workspace/file", {
      headers: { origin: live.base, authorization: "Bearer wrong", [SIDECAR_INSTANCE_HEADER]: pair.instance },
    });
    expect(wrongToken.status).toBe(401);
  });
  it("rejects a different app origin even when it has copied the instance and token", async () => {
    const live = await startPair();
    const response = await realFetch(live.sidecarBase + "/api/v1/workspace/file", {
      headers: { origin: "http://localhost:4173", authorization: "Bearer door-token", [SIDECAR_INSTANCE_HEADER]: pair.instance },
    });
    expect(response.status).toBe(409);
  });
  it("drives browser client through sidecar to kernel; rotates tokens and stops after a target swap", async () => {
    const live = await startPair();
    vi.stubEnv("NEXT_PUBLIC_SIDECAR_INSTANCE", pair.instance);
    vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
      if (input === "/api/v1/loopback-settings") return realFetch(live.base + input, init);
      const url = String(input).replace("http://127.0.0.1:19828", live.sidecarBase);
      const headers = new Headers(init.headers); headers.set("origin", live.base);
      return realFetch(url, { ...init, headers });
    });
    const url = "http://127.0.0.1:19828/api/v1/projects";
    expect((await loopbackFetch(url, { method: "POST", body: "{}" })).ok).toBe(true);
    live.rotate();
    expect((await loopbackFetch(url, { method: "POST", body: "{}" })).ok).toBe(true);
    expect(live.writes()).toBe(2);
    live.switchPair({ ...pair, instance: "app-B" });
    expect((await loopbackFetch(url, { method: "POST", body: "{}" })).status).toBe(409);
    expect(live.writes()).toBe(2);
  });
  it("sends no credential or mutation to an old sidecar with no handshake", async () => {
    vi.stubEnv("NEXT_PUBLIC_SIDECAR_INSTANCE", pair.instance);
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => Response.json({ status: "running" }));
    vi.stubGlobal("fetch", fetch);
    const response = await loopbackFetch("http://127.0.0.1:19828/api/v1/chat", { method: "POST", body: "sensitive" });
    expect(response.status).toBe(409);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(LOOPBACK_HEALTH_URL);
    expect(matchesSidecarPairing({ pairing: { ...pair, protocol: 2 }, pairingReady: true }, pair.instance)).toBe(false);
  });
});

it("allows a remote kernel without comparing its filesystem, but rejects another protocol", async () => {
  let pairing = { ...pair, localIdentity: "cloud-build" };
  const source = createPairingSource({
    kernel: { base: "https://app.example", token: "service" }, localIdentity: "laptop",
    fetchImpl: async () => Response.json({ pairing }),
  });
  expect(await source.read()).toEqual(pairing);
  pairing = { ...pairing, protocol: 2 };
  expect(await source.read()).toBeNull();
});

it("checks again at the server after a successful health probe", async () => {
  const live = await startPair();
  const headers = { origin: live.base, authorization: "Bearer door-token", [SIDECAR_INSTANCE_HEADER]: pair.instance };
  const health = await realFetch(live.sidecarBase + "/api/v1/health", { headers: { origin: live.base } });
  expect((await health.json()).pairingReady).toBe(true);
  live.switchPair({ ...pair, instance: "replacement-app" });
  const refused = await realFetch(live.sidecarBase + "/api/v1/projects", { method: "POST", headers, body: "{}" });
  expect(refused.status).toBe(409);
  expect(live.writes()).toBe(0);
  const preflight = await realFetch(live.sidecarBase + "/api/v1/projects", { method: "OPTIONS", headers: { origin: live.base } });
  expect(preflight.headers.get("access-control-allow-headers")).toContain(SIDECAR_INSTANCE_HEADER);
});

it("does not claim extraction jobs while the pair is unverified", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const log = vi.fn();
  const stop = startExtractLoop({
    env: { NODE_ENV: "test", WORKWIKI_URL: "http://localhost:3000", WORKWIKI_API_TOKEN: "service" },
    beforeDrain: async () => false, log,
  });
  try {
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining("sidecar_pairing_mismatch")));
    expect(fetch).not.toHaveBeenCalled();
  } finally { stop(); }
});

it("loads local overrides before defaults and keeps shell overrides", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sidecar-env-"));
  const key = "SIDECAR_PAIRING_TEST_ENV";
  vi.stubEnv(key, undefined);
  try {
    writeFileSync(path.join(root, ".env"), `${key}=default`);
    writeFileSync(path.join(root, ".env.local"), `${key}=local`);
    loadSidecarEnvFromFiles(root);
    expect(process.env[key]).toBe("local");
    process.env[key] = "shell";
    loadSidecarEnvFromFiles(root);
    expect(process.env[key]).toBe("shell");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
