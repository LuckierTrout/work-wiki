import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const principal = { id: "user_stable", handle: "changed" };
vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn(async () => ({ id: "user_stable", handle: "changed" })), getServicePrincipal: vi.fn(() => null) }));
vi.mock("@/lib/ingest-async", () => ({ enqueueOrInline: vi.fn(async () => NextResponse.json({ queued: true }, { status: 202 })) }));

import { _resetStorage, getStorage } from "../storage";
import { _resetLocks } from "../lock";
import { enqueueTodoCandidates, listTodos } from "../todos";
import { createIngestJob } from "../ingest-jobs";
import { enqueueOrInline } from "../ingest-async";
import { requeueExtractJob, getExtractJob } from "../extract-jobs";
import { completeExtract, enqueueExtract } from "../extract-dispatch";
import { POST as intake } from "@/app/api/workbench/intake/route";
import { POST as decide } from "@/app/api/todos/route";
import { GET as jobs } from "@/app/api/ingest/jobs/route";
import { GET as status } from "@/app/api/ingest/status/[jobId]/route";

let temp: string;
const req = (url: string, body?: unknown) => new NextRequest(`http://localhost${url}`, { method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "owner-actors-"));
  for (const [key, value] of Object.entries({ DATA_DIR: temp, WIKI_DIR: path.join(temp, "wiki"), RAW_DIR: path.join(temp, "raw"), NEXT_PUBLIC_OWNER_HANDLE: "canonical", YOPEDIA_OWNER_USER_ID: principal.id, YOPEDIA_READONLY: "0" })) vi.stubEnv(key, value);
  _resetStorage(); _resetLocks(); vi.clearAllMocks();
});
afterEach(async () => { vi.unstubAllEnvs(); _resetStorage(); _resetLocks(); await fs.rm(temp, { recursive: true, force: true }); });

it("stores intake and queue ownership canonically while preserving live author and trigger", async () => {
  const oldPath = "tenants/changed/raw/sources/retained.md";
  await getStorage().writeFile(oldPath, "old actor data\n");
  const response = await intake(req("/api/workbench/intake", { url: "https://example.com/source", clip: "# Meeting\n\nA distinct source." }));
  expect(response.status).toBe(202);
  expect(vi.mocked(enqueueOrInline).mock.calls[0][1]).toMatchObject({ owner: "canonical", author: "changed", triggeredBy: "changed" });
  const listing = await (await jobs(req("/api/ingest/jobs"))).json();
  expect(listing.jobs).toHaveLength(1);
  expect(listing.jobs[0].owner).toBe("canonical");
  expect(await getStorage().readFile(oldPath)).toBe("old actor data\n");
});

it("uses canonical job ownership for list and status without aliasing old jobs", async () => {
  await createIngestJob({ jobId: "canonical-job", owner: "canonical", title: "Current" });
  await createIngestJob({ jobId: "old-job", owner: "changed", title: "Preserved" });
  const listing = await (await jobs(req("/api/ingest/jobs"))).json();
  expect(listing.jobs.map((j: { jobId: string }) => j.jobId)).toEqual(["canonical-job"]);
  expect((await status(req("/api/ingest/status/canonical-job"), { params: Promise.resolve({ jobId: "canonical-job" }) })).status).toBe(200);
  expect((await status(req("/api/ingest/status/old-job"), { params: Promise.resolve({ jobId: "old-job" }) })).status).toBe(404);
});

it("records the live Todo decision actor in the canonical store", async () => {
  const [candidate] = await enqueueTodoCandidates("canonical", { wikiId: "wiki-one", sourceId: "raw/sources/meeting.md", candidates: [{ title: "Call Sam", rationale: "Meeting follow-up" }] });
  const [retained] = await enqueueTodoCandidates("changed", { wikiId: "wiki-old", sourceId: "raw/sources/old.md", candidates: [{ title: "Old candidate", rationale: "Retained" }] });
  const response = await decide(req("/api/todos", { ids: [candidate.id], decision: "approve" }));
  expect(response.status).toBe(200);
  expect((await listTodos("canonical"))[0]).toMatchObject({ id: candidate.id, status: "open", actor: "changed" });
  expect((await listTodos("changed"))[0]).toEqual(retained);
});


it.each(["changed", undefined])("preserves extract actor %s through persistence, retry and completion", async (actor) => {
  const arrival = await enqueueExtract({ owner: "canonical", ...(actor === undefined ? {} : { actor }), slug: "document", bytesSha256: "a".repeat(64), ext: "pdf", format: "pdf", filename: "document.pdf", title: "Document", bytes: new TextEncoder().encode("synthetic bytes").buffer });
  expect((await getExtractJob(arrival.extractId))?.actor).toBe(actor);
  await requeueExtractJob(arrival.extractId, "canonical");
  expect((await getExtractJob(arrival.extractId))?.actor).toBe(actor);
  const result = await completeExtract({ extractId: arrival.extractId, owner: "canonical", text: "# Extracted\n\nSynthetic text." });
  expect(result.ok).toBe(true);
  expect(vi.mocked(enqueueOrInline).mock.calls[0][1]).toMatchObject({ owner: "canonical", author: actor ?? "canonical", triggeredBy: actor ?? "canonical" });
});

it("keeps old-owner summary and overview identities and bytes on canonical intake bookkeeping", async () => {
  const { runIngestBookkeeping } = await import("../ingest-bookkeeping");
  const { listWikiPages, readWikiPageWithFrontmatter } = await import("../wiki");
  const input = { actor: "changed", sourceTitle: "Shared source", sourceText: "Original source.", sourcePath: "raw/sources/shared/abcdef.md", rawId: "abcdef", sourceType: "text" as const };
  await runIngestBookkeeping({ ...input, owner: "changed" });
  const oldSummary = (await listWikiPages()).find((page) => page.type === "summary")!;
  const paths = [oldSummary.slug, "overview"].flatMap((slug) => [`wiki/${slug}.md`, `tenants/changed/wiki/${slug}.md`]);
  const oldBytes = await Promise.all(paths.map((file) => getStorage().readFile(file)));
  await runIngestBookkeeping({ ...input, owner: "canonical", sourceText: "Canonical source." });
  const pages = await listWikiPages();
  const summary = pages.find((page) => page.type === "summary" && page.owner === "canonical")!;
  expect(summary.slug).toBe(`${oldSummary.slug}-2`);
  expect(pages.find((page) => page.slug === oldSummary.slug)?.owner).toBe("changed");
  expect(pages.find((page) => page.slug === "overview")?.owner).toBe("changed");
  expect(pages.find((page) => page.slug === "overview-2")?.owner).toBe("canonical");
  expect((await readWikiPageWithFrontmatter("overview-2"))?.content).toContain(`[[${oldSummary.slug}]]`);
  await runIngestBookkeeping({ ...input, owner: "canonical", sourceText: "Canonical updated." });
  expect((await listWikiPages()).filter((page) => page.type === "summary")).toHaveLength(2);
  expect((await listWikiPages()).filter((page) => page.type === "overview")).toHaveLength(2);
  const overview = await readWikiPageWithFrontmatter("overview-2");
  expect(overview?.content).toContain("This wiki has 2 pages.");
  expect(overview?.content).not.toContain("[[overview-2]]");
  const { checkInboundWikilinkOrphans } = await import("../workbench-lint");
  expect((await checkInboundWikilinkOrphans((await listWikiPages()).map((page) => page.slug))).some((issue) => issue.slug === "overview-2")).toBe(false);
  expect(await Promise.all(paths.map((file) => getStorage().readFile(file)))).toEqual(oldBytes);
});

it.each([false, true])("repairs interrupted canonical Review creation with persisted actor (legacy claim: %s)", async (legacy) => {
  const lifecycle = await import("../lifecycle");
  const { enqueueReviewFromAnalysis, listReviewItems } = await import("../review-queue");
  const { emptyIngestAnalysis } = await import("../ingest-analysis");
  const { readWikiPageWithFrontmatter } = await import("../wiki");
  const { POST: createReviewPage } = await import("@/app/api/review-queue/[id]/route");
  await enqueueReviewFromAnalysis("canonical", { wikiId: "current", pageSlug: "topic", analysis: { ...emptyIngestAnalysis(), tensions: ["Interrupted page"] } });
  const [item] = await listReviewItems("canonical", "current");
  const writer = vi.spyOn(lifecycle, "writeWikiPageWithSideEffects")
    .mockImplementationOnce(async (input) => {
      await getStorage().writeFile(`tenants/canonical/wiki/${input.slug}.md`, input.content);
      throw new Error("simulated process loss after primary write");
    })
    .mockRejectedValueOnce(new Error("repair unavailable before restart"));
  try {
    const response = await createReviewPage(req(`/api/review-queue/${item.id}`, { action: "create-page", wikiId: "current" }), { params: Promise.resolve({ id: item.id }) });
    expect(response.status).toBe(500);
  } finally { writer.mockRestore(); }
  const queuePath = "tenants/canonical/review-queue.json";
  const stored = JSON.parse(await getStorage().readFile(queuePath));
  expect(stored.items[0]).toMatchObject({ status: "creating", claimActor: "changed" });
  const slug = stored.items[0].pageSlug;
  stored.items[0].claimExpiresAt = "2026-01-01T00:00:00.000Z";
  if (legacy) delete stored.items[0].claimActor;
  await getStorage().writeFile(queuePath, JSON.stringify(stored));
  _resetStorage(); _resetLocks();
  expect(await listReviewItems("canonical", "current")).toEqual([]);
  expect(JSON.parse(await getStorage().readFile(queuePath)).items[0].status).toBe("created");
  const page = await readWikiPageWithFrontmatter(slug, { fresh: true, strict: true });
  expect(page?.frontmatter.owner).toBe("canonical");
  const { listRevisions } = await import("../revisions");
  expect((await listRevisions(slug, "canonical"))[0]?.author).toBe(legacy ? "canonical" : "changed");
  await expect(getStorage().readFile(`tenants/changed/wiki/${slug}.md`)).rejects.toMatchObject({ code: "ENOENT" });
});
