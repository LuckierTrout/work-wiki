import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));

import { getPrincipal } from "../auth";
import { DELETE } from "@/app/api/ingest/history/route";
import { createIngestJob, updateIngestJob, getIngestJob } from "../ingest-jobs";
import { _resetStorage, getStorage } from "../storage";
import { _resetLocks } from "../lock";
import { ensureDirectories, readWikiPage, updateIndex, tenantWikiRelPath } from "../wiki";

let directory: string;
const content = "---\nowner: alice\nvisibility: private\n---\n# Orphan\n\nKeep these bytes.\n";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "history-delete-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.stubEnv("WIKI_DIR", join(directory, "wiki"));
  vi.stubEnv("RAW_DIR", join(directory, "raw"));
  vi.stubEnv("NEXT_PUBLIC_OWNER_HANDLE", "alice");
  vi.stubEnv("ADMIN_HANDLES", "");
  vi.stubEnv("YOPEDIA_READONLY", "");
  _resetStorage();
  _resetLocks();
  await ensureDirectories();
  vi.mocked(getPrincipal).mockResolvedValue({ id: "alice-id", handle: "alice" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  _resetStorage();
  _resetLocks();
  await rm(directory, { recursive: true, force: true });
});
async function job(slug: string) {
  await createIngestJob({ jobId: slug, owner: "alice", title: slug });
  await updateIngestJob(slug, { status: "done", slug });
}
function remove(...jobIds: string[]) {
  return DELETE(new NextRequest("http://localhost/api/ingest/history", {
    method: "DELETE", body: JSON.stringify({ jobIds }),
  }));
}

describe("history route through lifecycle and filesystem storage", () => {
  it("deletes an owner-silo orphan and then clears its terminal job", async () => {
    await getStorage().writeFile(tenantWikiRelPath("alice", "orphan.md"), content);
    await job("orphan");
    const response = await remove("orphan");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ deletedPageSlugs: ["orphan"], deletedJobIds: ["orphan"], failed: [] });
    expect(await readWikiPage("orphan", { owner: "alice", fresh: true, strict: true })).toBeNull();
    expect(await getIngestJob("orphan")).toBeNull();
  });

  it.each(["alice", "bob"])("retains job evidence on indexed %s page read failure while clearing confirmed absence", async (owner) => {
    const key = tenantWikiRelPath(owner, "unavailable.md");
    await getStorage().writeFile(key, content.replace("alice", owner));
    await updateIndex([{ slug: "unavailable", title: "Unavailable", summary: "", owner, visibility: "private" }]);
    await getStorage().putIndex("pages", { unavailable: { slug: "unavailable", title: "Unavailable", summary: "", owner, visibility: "private" } });
    await job("unavailable");
    await job("gone");
    const storage = getStorage();
    const read = storage.readFile.bind(storage);
    vi.spyOn(storage, "readFile").mockImplementation(async (path) => {
      if (path === key) throw new Error("private-provider-fault");
      return read(path);
    });
    const response = await remove("unavailable", "gone");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ deletedPageSlugs: [], deletedJobIds: ["gone"], failed: [{ id: "unavailable", kind: "job" }] });
    expect(JSON.stringify(body)).not.toContain("private-provider-fault");
    expect(await getIngestJob("unavailable")).not.toBeNull();
    expect(await read(key)).toBe(content.replace("alice", owner));
  });
});
