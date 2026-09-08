import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Miniflare, Response as LocalResponse } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Real local workerd/SQLite/R2, not Cloudflare production acceptance.
const scriptUrl = new URL("../../../tools/write-safety-lab/worker.mjs", import.meta.url);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const legacy = `export default { async fetch(request, env) {
  if(new URL(request.url).pathname === '/network') return fetch('https://external.invalid/');
  if(new URL(request.url).pathname === '/capabilities') return Response.json({newStore: !!env.CONTENT, authority: !!env.AUTHORITY});
  const {path, content} = await request.json();
  if(content === null) await env.OLD.delete(path); else await env.OLD.put(path,content);
  return Response.json({written: true});
}};`;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
type Barrier = { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> };

describe("isolated write authority in real local workerd", () => {
  let runtime: Miniflare;
  let directory: string;
  let blockedNetwork: number;
  const barriers = new Map<string, Barrier>();
  async function start(shared = false) {
    runtime = new Miniflare({
      host: "127.0.0.1", port: 0, cf: false, telemetry: { enabled: false },
      resourcePersistencePath: directory,
      workers: [
        {
          config: {
            name: "write-safety-lab", type: "worker", compatibilityDate: "2026-08-01",
            exports: { CommitAuthority: { type: "durable-object", storage: "sqlite" } },
            env: {
              AUTHORITY: { type: "durable-object", worker: "write-safety-lab", exportName: "CommitAuthority" },
              CONTENT: { type: "r2", name: "synthetic-new" },
              BARRIER: { type: "fetcher", handler: async (request) => {
                const barrier = barriers.get(new URL(request.url).pathname.slice(1));
                if (!barrier) throw new Error("Unknown local barrier");
                barrier.entered.resolve();
                await barrier.release.promise;
                return new LocalResponse("released");
              } },
            },
            manifest: { mainModule: "worker.mjs", modules: { "worker.mjs": { type: "esm", contents: await readFile(scriptUrl, "utf8") } } },
          },
          dev: { unsafeRegisterWorker: false, outboundService: { type: "fetcher", handler: () => {
            blockedNetwork += 1; return new LocalResponse("outbound denied", { status: 403 });
          } } },
        },
        {
          config: {
            name: "synthetic-legacy", type: "worker", compatibilityDate: "2026-08-01",
            env: { OLD: { type: "r2", name: shared ? "synthetic-new" : "synthetic-old" } },
            manifest: { mainModule: "legacy.mjs", modules: { "legacy.mjs": { type: "esm", contents: legacy } } },
          },
          dev: { unsafeRegisterWorker: false, outboundService: { type: "fetcher", handler: () => {
            blockedNetwork += 1; return new LocalResponse("outbound denied", { status: 403 });
          } } },
        },
      ],
    });
    await runtime.ready;
  }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "write-safety-proof-"));
    blockedNetwork = 0;
    await start();
  }, 30_000);
  afterEach(async () => {
    for (const barrier of barriers.values()) barrier.release.resolve();
    barriers.clear();
    try { await runtime?.dispose(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  async function call(path: string, body?: unknown) {
    const response = await runtime.dispatchFetch(`https://lab.invalid${path}`, body === undefined ? {} : {
      method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  const command = (operation = "one", revision = 0, generation = 1) => ({
    operation, revision, generation,
    changes: [{ path: "wiki/a.md", content: "α" }, { path: "wiki/b.md", content: "B" }],
  });

  it("publishes multiple paths, tombstones, receipts and outbox atomically; reads exclude physical orphans", async () => {
    expect((await call("/commit", command())).status).toBe(200);
    expect((await call("/read?path=wiki/a.md")).body.content).toBe("α");
    expect((await call("/stat?path=wiki/a.md")).body.size).toBe(2);
    const bucket = await runtime.getR2Bucket("CONTENT", "write-safety-lab");
    await bucket.put("unpublished", "not visible");
    expect((await call("/list")).body.paths).toEqual(["wiki/a.md", "wiki/b.md"]);
    expect((await call("/commit", { ...command("delete", 1), changes: [{ path: "wiki/a.md", content: null }] })).status).toBe(200);
    expect((await call("/read?path=wiki/a.md")).status).toBe(404);
    const state = (await call("/state")).body;
    expect(state).toMatchObject({ revision: 2, generation: 1 });
    expect(state.refs).toContainEqual({ path: "wiki/a.md", blob: null, size: 0 });
    expect(state.receipts).toHaveLength(2);
    expect(state.outbox).toHaveLength(2);
  });

  it("rejects stale uploads and stale deletes after an interleaved generation advance", async () => {
    await call("/commit", command());
    const barrier = { entered: deferred(), release: deferred() };
    barriers.set("stale", barrier);
    const pending = call("/commit", { ...command("stale", 1), pause: "stale", changes: [
      { path: "wiki/a.md", content: null }, { path: "wiki/b.md", content: "stale" },
    ] });
    try {
      await barrier.entered.promise;
      expect((await call("/advance", { generation: 1, revision: 1 })).status).toBe(200);
    } finally { barrier.release.resolve(); }
    expect(await pending).toEqual({ status: 409, body: { error: "stale-generation" } });
    expect((await call("/read?path=wiki/a.md")).body.content).toBe("α");
    expect((await call("/read?path=wiki/b.md")).body.content).toBe("B");
  });

  it("lets only one concurrent revision commit; same-ID concurrent retries return one receipt", async () => {
    const results = await Promise.all([call("/commit", command("one")), call("/commit", command("two"))]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await call("/state")).body.revision).toBe(1);
    const duplicate = await Promise.all([call("/commit", command("three", 1)), call("/commit", command("three", 1))]);
    expect(duplicate[0]).toEqual(duplicate[1]);
    expect(duplicate[0].status).toBe(200);
    expect((await call("/state")).body.revision).toBe(2);
  });

  it("deduplicates canonical requests but rejects an operation ID reused with different content", async () => {
    const first = await call("/commit", command());
    expect(await call("/commit", { ...command(), changes: command().changes.reverse() })).toEqual(first);
    expect(await call("/commit", { ...command(), changes: [{ path: "wiki/a.md", content: "changed" }] }))
      .toEqual({ status: 409, body: { error: "operation-conflict" } });
  });

  it.each(["before-publish", "in-transaction"])("recovers an injected %s interruption without partial publication", async (fault) => {
    expect((await call("/commit", { ...command(), fault })).status).toBe(503);
    expect((await call("/state")).body).toMatchObject({ revision: 0, refs: [], receipts: [], outbox: [] });
    const bucket = await runtime.getR2Bucket("CONTENT", "write-safety-lab");
    expect((await bucket.list()).objects).toHaveLength(2);
    await runtime.dispose();
    await start();
    expect((await call("/list")).body.paths).toEqual([]);
    expect((await call("/commit", command())).status).toBe(200);
    expect((await call("/state")).body.revision).toBe(1);
  });

  it("recovers the persisted receipt after commit-before-response and restart, even after advancing generation", async () => {
    expect((await call("/commit", { ...command(), fault: "after-commit" })).status).toBe(503);
    const before = (await call("/state")).body;
    await runtime.dispose();
    await start();
    expect((await call("/state")).body).toEqual(before);
    await call("/advance", { generation: 1, revision: 1 });
    const retried = await call("/commit", command());
    expect(retried).toMatchObject({ status: 200, body: { operation: "one", revision: 1, generation: 1 } });
    expect((await call("/state")).body.revision).toBe(1);
  });

  it("replays full synthetic projections safely and rejects superseded revision/generation effects", async () => {
    await call("/commit", command());
    await call("/commit", { ...command("two", 1), changes: [{ path: "wiki/b.md", content: null }] });
    expect((await call("/project", { id: "1:1" })).body.status).toBe("superseded");
    expect((await call("/project", { id: "1:2" })).body.status).toBe("applied");
    const projected = (await call("/state")).body.projection;
    const snapshot = JSON.stringify([
      { path: "wiki/a.md", blob: sha("α"), size: 2 },
      { path: "wiki/b.md", blob: null, size: 0 },
    ]);
    expect(projected).toEqual([{ id: 1, generation: 1, revision: 2, snapshot }]);
    await call("/project", { id: "1:2" });
    expect((await call("/state")).body.projection).toEqual(projected);
    expect((await call("/project", { id: "1:1" })).body.status).toBe("superseded");
    expect((await call("/state")).body.projection).toEqual(projected);
    await call("/advance", { generation: 1, revision: 2 });
    expect((await call("/project", { id: "1:2" })).body.status).toBe("superseded");
    expect((await call("/state")).body.projection).toEqual(projected);
    expect((await call("/project", { id: "2:2" })).body.status).toBe("applied");
    const current = [{ id: 1, generation: 2, revision: 2, snapshot }];
    expect((await call("/state")).body.projection).toEqual(current);
    expect((await call("/project", { id: "1:2" })).body.status).toBe("superseded");
    expect((await call("/state")).body.projection).toEqual(current);
  });

  it("a resumed legacy writer can overwrite/delete old objects but has no new-store or authority capability", async () => {
    await call("/commit", command());
    await call("/advance", { generation: 1, revision: 1 });
    const old = await runtime.getWorker("synthetic-legacy");
    expect(await (await old.fetch("https://lab.invalid/capabilities")).json()).toEqual({ newStore: false, authority: false });
    for (const content of ["late old write", null]) await old.fetch("https://lab.invalid/write", {
      method: "POST", body: JSON.stringify({ path: sha("α"), content }),
    });
    expect((await call("/read?path=wiki/a.md")).body.content).toBe("α");
    const network = await old.fetch("https://lab.invalid/network");
    expect(network.status).toBe(403);
    expect(blockedNetwork).toBe(1);
  });

  it("negative control: sharing the destination bucket permits corruption and fails the read integrity check", async () => {
    await runtime.dispose(); await start(true);
    await call("/commit", command());
    const old = await runtime.getWorker("synthetic-legacy");
    await old.fetch("https://lab.invalid/write", { method: "POST", body: JSON.stringify({ path: sha("α"), content: "corrupt" }) });
    expect(await call("/read?path=wiki/a.md")).toEqual({ status: 500, body: { error: "blob-integrity" } });
    expect(await call("/commit", command("next", 1))).toEqual({ status: 500, body: { error: "blob-integrity" } });
    expect((await call("/state")).body.revision).toBe(1);
  });

  it("rejects byte corruption even when UTF-8 replacement decoding would hide it", async () => {
    const changes = [{ path: "wiki/a.md", content: "\ufffd" }];
    expect((await call("/commit", { ...command(), changes })).status).toBe(200);
    const before = (await call("/state")).body;
    const bucket = await runtime.getR2Bucket("CONTENT", "write-safety-lab");
    await bucket.put(sha("\ufffd"), new Uint8Array([0xff]));
    expect(await call("/read?path=wiki/a.md")).toEqual({ status: 500, body: { error: "blob-integrity" } });
    expect(await call("/commit", { ...command("next", 1), changes }))
      .toEqual({ status: 500, body: { error: "blob-integrity" } });
    expect((await call("/state")).body).toEqual(before);
  });

  it("rejects lone surrogates before uploading and preserves valid Unicode exactly", async () => {
    for (const content of ["\ud800", "\udc00", "a\ud800b", "\ud800\ud800", "\udc00\ud800"]) {
      expect(await call("/commit", { ...command(), changes: [{ path: "wiki/a.md", content }] }))
        .toEqual({ status: 400, body: { error: "invalid-change" } });
    }
    const bucket = await runtime.getR2Bucket("CONTENT", "write-safety-lab");
    expect((await bucket.list()).objects).toEqual([]);
    expect((await call("/state")).body).toMatchObject({ revision: 0, refs: [], receipts: [], outbox: [] });
    const content = "\ufeffValid: \ud83d\ude00 \ufffd α";
    const request = { ...command(), changes: [{ path: "wiki/a.md", content }] };
    const committed = await call("/commit", request);
    expect(committed.status).toBe(200);
    expect((await call("/read?path=wiki/a.md")).body.content).toBe(content);
    expect((await call("/stat?path=wiki/a.md")).body.size).toBe(Buffer.byteLength(content));
    expect(await call("/commit", request)).toEqual(committed);
  });

  it("refuses invalid paths, duplicate paths, invalid revisions and oversized bodies without publishing", async () => {
    for (const request of [
      { ...command(), changes: [{ path: "../escape", content: "x" }] },
      { ...command(), changes: [command().changes[0], command().changes[0]] },
      { ...command(), revision: -1 }, { ...command(), operation: 123 },
      { ...command(), changes: [{ path: "a", content: "x".repeat(8193) }] },
    ]) expect((await call("/commit", request)).status).toBe(400);
    expect((await call("/commit", { data: "x".repeat(300_001) })).status).toBe(413);
    expect((await call("/state")).body).toMatchObject({ revision: 0, refs: [], receipts: [] });
  });
});
