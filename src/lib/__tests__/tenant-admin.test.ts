import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { deleteTenant } from "../tenant-admin";
import { writeWikiPageWithSideEffects } from "../lifecycle";
import { readWikiPage, ensureDirectories } from "../wiki";
import { serializeFrontmatter } from "../frontmatter";
import { getStorage, _resetStorage } from "../storage";

let tmpDir: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "WIKI_DIR",
  "RAW_DIR",
  "DATA_DIR",
  "YOPEDIA_SERVICE_TOKEN",
  "YOPEDIA_SERVICE_PRINCIPAL",
  // Cleared per case and restored in teardown: `write()` below goes through the
  // kernel page writer, which refuses while the flag is set, so an exported
  // value would turn this whole file red on one machine and nowhere else.
  "YOPEDIA_READONLY",
];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tenant-admin-test-"));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  delete process.env.YOPEDIA_SERVICE_TOKEN;
  delete process.env.YOPEDIA_SERVICE_PRINCIPAL;
  delete process.env.YOPEDIA_READONLY;
  _resetStorage();
  await ensureDirectories();
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function write(
  slug: string,
  fm: Record<string, string | string[]>,
  body = `# ${slug}`,
) {
  await writeWikiPageWithSideEffects({
    slug,
    title: slug,
    content: serializeFrontmatter(fm, body),
    summary: "s",
    logOp: "ingest",
    crossRefSource: null,
  });
}

describe("deleteTenant", () => {
  it("deletes only the tenant's OWNED pages (flat + silo) and its folder", async () => {
    await write("alice-1", { owner: "alice" });
    await write("alice-2", { owner: "alice" });
    await write("bob-1", { owner: "bob" });
    await write("seed", {}); // ownerless → yopedia

    // Silo was mirrored on write (P5a).
    expect(await getStorage().fileExists("tenants/alice/wiki/alice-1.md")).toBe(
      true,
    );

    const result = await deleteTenant("alice");
    expect(result.tenant).toBe("alice");
    expect(result.deletedPages).toBe(2);
    expect(result.errors).toEqual([]);

    // alice's pages gone (flat + silo); others untouched.
    expect(await readWikiPage("alice-1")).toBeNull();
    expect(await readWikiPage("alice-2")).toBeNull();
    expect(await readWikiPage("bob-1")).not.toBeNull();
    expect(await readWikiPage("seed")).not.toBeNull();
    expect(
      await getStorage().fileExists("tenants/alice/wiki/alice-1.md"),
    ).toBe(false);
    expect(await getStorage().fileExists("tenants/bob/wiki/bob-1.md")).toBe(
      true,
    );
  });

  it("removes the tenant's query history (it lives in the silo)", async () => {
    const { appendQuery } = await import("../query-history");
    await appendQuery({ question: "q", answer: "a", sources: [], timestamp: "2025-01-01T00:00:00Z", owner: "alice" });
    await appendQuery({ question: "q", answer: "a", sources: [], timestamp: "2025-01-01T00:00:00Z", owner: "bob" });
    expect(await getStorage().fileExists("tenants/alice/query-history.json")).toBe(true);

    await deleteTenant("alice");

    // alice's private query log is gone with her silo; bob's is untouched.
    expect(await getStorage().fileExists("tenants/alice/query-history.json")).toBe(false);
    expect(await getStorage().fileExists("tenants/bob/query-history.json")).toBe(true);
  });

  it("never deletes a page the handle only CONTRIBUTED to (owned by another)", async () => {
    // Owned by bob, but alice is a contributor — deleting tenant alice must
    // leave it intact (it belongs to bob's silo).
    await write("bobs-page", { owner: "bob", contributors: ["alice"] });

    const result = await deleteTenant("alice");
    expect(result.deletedPages).toBe(0);
    expect(await readWikiPage("bobs-page")).not.toBeNull();
  });

  it("ownerless/seed pages belong to the yopedia tenant", async () => {
    await write("seed-a", {});
    await write("seed-b", { owner: "yopedia" });
    await write("alice-x", { owner: "alice" });

    const result = await deleteTenant("yopedia");
    expect(result.deletedPages).toBe(2); // both seed pages
    expect(await readWikiPage("alice-x")).not.toBeNull();
  });
});

/**
 * A read-only deployment must not half-destroy a tenant (DW-187, DW-188).
 *
 * `deleteTenant` is the caller the kernel gate alone gets WRONG, and dangerously
 * so. Its per-page loop swallows every `deleteWikiPage` failure into `errors`
 * and carries on, and the silo `deleteDirectory` at the tail is not a kernel
 * writer at all — so with only the writer gated, a read-only deployment would
 * leave every flat page standing while destroying `tenants/<t>/`: the silo
 * mirrors, the tenant's private query history, all of it. And it would answer
 * 207, which reads as "mostly worked".
 *
 * So the assertion is NO MUTATION AT ALL, checked on three different artifacts
 * that the broken ordering destroys separately.
 */
describe("deleteTenant on a read-only deployment", () => {
  it("refuses before touching anything — pages, silo and query history all survive", async () => {
    await write("alice-1", { owner: "alice" });
    await write("alice-2", { owner: "alice" });
    const { appendQuery } = await import("../query-history");
    await appendQuery({
      question: "q",
      answer: "a",
      sources: [],
      timestamp: "2025-01-01T00:00:00Z",
      owner: "alice",
    });
    expect(await getStorage().fileExists("tenants/alice/wiki/alice-1.md")).toBe(true);
    expect(await getStorage().fileExists("tenants/alice/query-history.json")).toBe(true);

    process.env.YOPEDIA_READONLY = "1";

    await expect(deleteTenant("alice")).rejects.toThrow(/read-only/);

    // The flat pages the loop would have reported as `errors`…
    expect(await readWikiPage("alice-1")).not.toBeNull();
    expect(await readWikiPage("alice-2")).not.toBeNull();
    // …and the silo the unconditional `deleteDirectory` would have taken with it.
    expect(await getStorage().fileExists("tenants/alice/wiki/alice-1.md")).toBe(true);
    expect(await getStorage().fileExists("tenants/alice/wiki/alice-2.md")).toBe(true);
    expect(await getStorage().fileExists("tenants/alice/query-history.json")).toBe(true);
  });

  it("refuses before the page listing, so an unknown tenant answers the same", async () => {
    process.env.YOPEDIA_READONLY = "1";
    await expect(deleteTenant("nobody-here")).rejects.toThrow(/read-only/);
  });

  it("deletes exactly as before with the flag unset — the control case", async () => {
    await write("alice-1", { owner: "alice" });

    const result = await deleteTenant("alice");

    expect(result.deletedPages).toBe(1);
    expect(result.errors).toEqual([]);
    expect(await readWikiPage("alice-1")).toBeNull();
    expect(await getStorage().fileExists("tenants/alice/wiki/alice-1.md")).toBe(false);
  });
});

describe("DELETE /api/admin/tenant/[handle] — gating", () => {
  async function del(
    handle: string,
    opts: { confirm?: string; token?: string } = {},
  ) {
    const { DELETE } = await import(
      "../../app/api/admin/tenant/[handle]/route"
    );
    const url = `http://localhost/api/admin/tenant/${handle}${opts.confirm ? `?confirm=${opts.confirm}` : ""}`;
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    return DELETE(new Request(url, { method: "DELETE", headers }), {
      params: Promise.resolve({ handle }),
    });
  }

  it("403 for an unauthenticated caller (even with confirm)", async () => {
    const res = await del("alice", { confirm: "alice" });
    expect(res.status).toBe(403);
  });

  it("400 when authed but confirmation is missing/wrong", async () => {
    process.env.YOPEDIA_SERVICE_TOKEN = "tok";
    process.env.YOPEDIA_SERVICE_PRINCIPAL = "yopedia";
    expect((await del("alice", { token: "tok" })).status).toBe(400);
    expect((await del("alice", { token: "tok", confirm: "nope" })).status).toBe(
      400,
    );
  });

  it("deletes with the service token + matching confirm", async () => {
    process.env.YOPEDIA_SERVICE_TOKEN = "tok";
    process.env.YOPEDIA_SERVICE_PRINCIPAL = "yopedia";
    await write("alice-1", { owner: "alice" });

    const res = await del("alice", { token: "tok", confirm: "alice" });
    expect(res.status).toBe(200);
    expect((await res.json()).deletedPages).toBe(1);
    expect(await readWikiPage("alice-1")).toBeNull();
  });

  it("admins (service token) CAN delete the platform yopedia tenant", async () => {
    process.env.YOPEDIA_SERVICE_TOKEN = "tok";
    process.env.YOPEDIA_SERVICE_PRINCIPAL = "yopedia";
    await write("seed", {}); // ownerless → yopedia

    const res = await del("yopedia", { token: "tok", confirm: "yopedia" });
    expect(res.status).toBe(200);
    expect((await res.json()).deletedPages).toBe(1);
    expect(await readWikiPage("seed")).toBeNull();
  });

  it("answers 403 on a read-only deployment, not 500 and not 207", async () => {
    process.env.YOPEDIA_SERVICE_TOKEN = "tok";
    process.env.YOPEDIA_SERVICE_PRINCIPAL = "yopedia";
    await write("alice-1", { owner: "alice" });
    process.env.YOPEDIA_READONLY = "1";

    const res = await del("alice", { token: "tok", confirm: "alice" });

    // 207 is what the un-gated ordering answered — a half-destroyed tenant
    // reported as a partial success. 500 is what the catch would say without
    // the classification.
    expect(res.status).toBe(403);
    expect(String((await res.json()).error)).toContain("read-only");
    expect(await readWikiPage("alice-1")).not.toBeNull();
  });
});
