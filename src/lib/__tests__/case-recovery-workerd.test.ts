import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare, Response as LocalResponse } from "miniflare";
import { _resetStorage, getStorage, initCloudflareStorage } from "../storage";
import type { CloudflareEnv } from "../storage/cloudflare-types";
import { _resetLocks, _setDurableLocksForTests } from "../lock";
import { deleteWikiPage, writeWikiPageWithSideEffects, type WritePageOptions } from "../lifecycle";
import { readWikiPage, readLog, listWikiPages, updateIndex } from "../wiki";
import { readDataVersion } from "../data-version";

let runtime: Miniflare;
let directory: string;
const content = "---\nowner: alice\nvisibility: private\n---\n# Cased\n\nAccepted bytes.\n";
const silo = "tenants/alice/wiki/cased.md";
const flat = "wiki/cased.md";
const opts = (): WritePageOptions => ({
  slug: "cased", title: "Cased", content, summary: "Recovered", logOp: "ingest",
  createOnly: true, crossRefSource: null,
  idempotency: { key: "accepted-operation", receiptPath: "receipts/cased.json" },
});
async function start() {
  runtime = new Miniflare({
    host: "127.0.0.1", port: 0, cf: false, telemetry: { enabled: false },
    resourcePersistencePath: directory,
    workers: [{
      config: {
        name: "case-recovery", type: "worker", compatibilityDate: "2026-08-01",
        env: { CONTENT: { type: "r2", name: "case-content" }, INDEX: { type: "kv", id: "case-index" } },
        manifest: { mainModule: "worker.mjs", modules: { "worker.mjs": {
          type: "esm", contents: "export default { fetch() { return new Response('local'); } };",
        } } },
      },
      dev: { unsafeRegisterWorker: false, outboundService: { type: "fetcher", handler: () => new LocalResponse("denied", { status: 403 }) } },
    }],
  });
  await runtime.ready;
  initCloudflareStorage({
    YOPEDIA_BUCKET: await runtime.getR2Bucket("CONTENT", "case-recovery"),
    YOPEDIA_CONFIG: await runtime.getKVNamespace("INDEX", "case-recovery"),
  } as unknown as CloudflareEnv);
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "case-recovery-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.stubEnv("WIKI_DIR", join(directory, "wiki"));
  vi.stubEnv("RAW_DIR", join(directory, "raw"));
  vi.stubEnv("YOPEDIA_READONLY", "");
  // Synthetic resources contain no legacy workers; production gate stays unchanged.
  vi.stubEnv("WORKWIKI_DURABLE_LOCK_V2_READY", "1");
  _resetStorage(); _resetLocks(); _setDurableLocksForTests(false);
  await start();
}, 30_000);
afterEach(async () => {
  vi.restoreAllMocks();
  _resetStorage(); _resetLocks(); _setDurableLocksForTests(false);
  try { await runtime?.dispose(); }
  finally { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); }
});
async function restart() {
  vi.restoreAllMocks();
  _resetStorage(); _resetLocks();
  await runtime.dispose();
  await start();
}
async function seed() {
  await getStorage().writeFile(silo, content);
  await getStorage().writeFile(flat, content);
  await getStorage().putIndex("pages", { cased: { slug: "cased", title: "Cased", summary: "", owner: "alice" } });
  await updateIndex([{ slug: "cased", title: "Cased", summary: "", owner: "alice" }]);
}

describe("lifecycle with real local case-sensitive R2 and KV", () => {
  it("removes every equivalent owned spelling and leaves other tenants intact", async () => {
    await seed();
    for (const suffix of ["MD", "Md", "mD"]) {
      await getStorage().writeFile(silo.replace(/md$/, suffix), content);
      await getStorage().writeFile(flat.replace(/md$/, suffix), content);
    }
    const other = "tenants/bob/wiki/cased.MD";
    await getStorage().writeFile(other, "# Bob's unrelated page");
    await deleteWikiPage("cased", "alice", content);
    expect(await readWikiPage("cased", { fresh: true, strict: true, owner: "alice" })).toBeNull();
    expect((await getStorage().listFiles("tenants/alice/wiki")).filter((file) => /^cased\./.test(file.name))).toEqual([]);
    expect((await getStorage().listFiles("wiki")).filter((file) => /^cased\./.test(file.name))).toEqual([]);
    expect(await getStorage().readFile(other)).toBe("# Bob's unrelated page");
  });

  it.each(["different bytes", "different owner", "incomplete inventory"])("refuses %s before deleting anything", async (failure) => {
    await seed();
    const key = silo.replace(/md$/, "MD");
    await getStorage().writeFile(key, failure === "different owner" ? content.replace("alice", "bob") : `${content}Extra.`);
    const storage = getStorage();
    if (failure === "incomplete inventory") {
      const read = storage.readFile.bind(storage);
      vi.spyOn(storage, "readFile").mockImplementation(async (path) => {
        if (path === key) throw new Error("inventory interrupted");
        return read(path);
      });
    }
    const unlink = vi.spyOn(storage, "deleteFile");
    await expect(deleteWikiPage("cased", "alice", content)).rejects.toThrow();
    expect(unlink).not.toHaveBeenCalled();
    expect(await storage.readFile(silo)).toBe(content);
    expect(await storage.readFile(flat)).toBe(content);
  });

  it("reports partial deletion and resumes the remaining spellings after runtime restart", async () => {
    await seed();
    const variant = silo.replace(/md$/, "MD");
    await getStorage().writeFile(variant, content);
    const storage = getStorage();
    const unlink = storage.deleteFile.bind(storage);
    vi.spyOn(storage, "deleteFile").mockImplementation(async (key) => {
      if (key === variant) throw new Error("delete interrupted");
      return unlink(key);
    });
    await expect(deleteWikiPage("cased", "alice", content)).rejects.toThrow("delete interrupted");
    expect(await storage.readFile(variant)).toBe(content);
    expect((await listWikiPages()).map((page) => page.slug)).toContain("cased");
    await restart();
    await deleteWikiPage("cased", "alice", content);
    expect(await readWikiPage("cased", { fresh: true, strict: true, owner: "alice" })).toBeNull();
  });

  it("recovers a variant after commit-before-receipt and restart without a duplicate object or log", async () => {
    const storage = getStorage();
    const write = storage.writeFile.bind(storage);
    vi.spyOn(storage, "writeFile").mockImplementation(async (key, value) => {
      if (key === opts().idempotency!.receiptPath) throw new Error("receipt interrupted");
      return write(key, value);
    });
    await expect(writeWikiPageWithSideEffects(opts())).rejects.toThrow("receipt interrupted");
    vi.restoreAllMocks();
    for (const key of [silo, flat]) {
      await storage.writeFile(key.replace(/md$/, "MD"), await storage.readFile(key));
      await storage.deleteFile(key);
    }
    await restart();
    await writeWikiPageWithSideEffects(opts());
    const version = await readDataVersion();
    await writeWikiPageWithSideEffects(opts());
    expect(await readDataVersion()).toBe(version);
    expect((await readLog())?.match(/ingest \| Cased/g)).toHaveLength(1);
    await expect(getStorage().readFile(silo)).rejects.toThrow();
    await expect(getStorage().readFile(flat)).rejects.toThrow();
    expect(await getStorage().readFile(silo.replace(/md$/, "MD"))).toBe(content);
    await expect(writeWikiPageWithSideEffects({ ...opts(), content: `${content}Changed` })).rejects.toThrow("operation identity changed");
    await expect(writeWikiPageWithSideEffects({ ...opts(), idempotency: { ...opts().idempotency!, key: "another-operation" } })).rejects.toThrow("accepted operation identity");
  });

  it("does not manufacture recovery identity for a pre-existing variant on repeated attempts", async () => {
    await getStorage().writeFile(silo.replace(/md$/, "MD"), content);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(writeWikiPageWithSideEffects(opts())).rejects.toThrow("accepted operation identity");
    }
    expect((await getStorage().listFiles("receipts"))).toEqual([]);
    expect(await getStorage().readFile(silo.replace(/md$/, "MD"))).toBe(content);
  });

  it("rejects an owner-silo object whose metadata points to another tenant", async () => {
    const contradictory = content.replace("alice", "bob");
    await getStorage().writeFile(silo, contradictory);
    await getStorage().writeFile("tenants/bob/wiki/cased.md", contradictory);
    await expect(deleteWikiPage("cased", "alice", contradictory, undefined, { ownerHint: "alice" }))
      .rejects.toThrow("conflicting Page spellings");
    expect(await getStorage().readFile(silo)).toBe(contradictory);
    expect(await getStorage().readFile("tenants/bob/wiki/cased.md")).toBe(contradictory);
  });

  it("repairs an interrupted compatibility publication from the accepted silo variant", async () => {
    const storage = getStorage();
    const create = storage.writeFileIfAbsent.bind(storage);
    vi.spyOn(storage, "writeFileIfAbsent").mockImplementation(async (key, value) => {
      if (key === flat) throw new Error("publication interrupted");
      return create(key, value);
    });
    // The create-only path compensates a failed flat claim. Interrupt that
    // compensation too, reproducing the persistent orphan left by a crash.
    const unlink = storage.deleteFile.bind(storage);
    vi.spyOn(storage, "deleteFile").mockImplementation(async (key) => {
      if (key === silo) throw new Error("compensation interrupted");
      return unlink(key);
    });
    await expect(writeWikiPageWithSideEffects(opts())).rejects.toThrow("publication interrupted");
    vi.restoreAllMocks();
    await storage.writeFile(silo.replace(/md$/, "MD"), await storage.readFile(silo));
    await storage.deleteFile(silo);
    await restart();
    await writeWikiPageWithSideEffects(opts());
    expect(await getStorage().readFile(flat)).toBe(content);
    await expect(getStorage().readFile(silo)).rejects.toThrow();
    expect(await getStorage().readFile(silo.replace(/md$/, "MD"))).toBe(content);
  });
});
