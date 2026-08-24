/**
 * The Deep Research concurrency lease (AD-18: at most three runs per workspace).
 *
 * Real storage over a temp `DATA_DIR`, the `research-projects.test.ts` recipe —
 * the lease IS a file, and a mocked store would pin the arithmetic while
 * proving nothing about what the next isolate reads. The rows below pin the
 * three properties the runtime depends on: the ceiling holds, a redelivery of
 * the same project does not consume a second slot, and a slot that nobody
 * released stops counting once its TTL passes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  MAX_CONCURRENT_RESEARCH,
  RESEARCH_SLOT_TTL_MS,
  acquireResearchSlot,
  activeResearchCount,
  releaseResearchSlot,
  renewResearchSlot,
} from "../research-concurrency";
import { _resetLocks } from "../lock";
import { _resetStorage } from "../storage";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "research-leases-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetStorage();
});

afterEach(async () => {
  vi.useRealTimers();
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("research concurrency lease", () => {
  it("admits three runs and queues the fourth", async () => {
    expect(MAX_CONCURRENT_RESEARCH).toBe(3);

    const first = await acquireResearchSlot("alice", "p1");
    const second = await acquireResearchSlot("alice", "p2");
    const third = await acquireResearchSlot("alice", "p3");
    const fourth = await acquireResearchSlot("alice", "p4");

    expect([first.granted, second.granted, third.granted]).toEqual([true, true, true]);
    expect(third.active).toBe(3);
    // The refusal reports the ceiling so the caller can SAY what it is waiting
    // behind — the panel's "waiting for a free research slot (3 of 3 running)".
    expect(fourth).toEqual({ granted: false, active: 3, limit: 3 });
    expect(await activeResearchCount("alice")).toBe(3);
  });

  it("frees the ceiling when a run releases", async () => {
    await acquireResearchSlot("alice", "p1");
    await acquireResearchSlot("alice", "p2");
    await acquireResearchSlot("alice", "p3");
    expect((await acquireResearchSlot("alice", "p4")).granted).toBe(false);

    await releaseResearchSlot("alice", "p2");

    expect(await activeResearchCount("alice")).toBe(2);
    expect((await acquireResearchSlot("alice", "p4")).granted).toBe(true);
  });

  it("counts one slot per project however often the task is redelivered", async () => {
    // Cloudflare Queues can deliver `run-research` more than once. A redelivery
    // that took a second slot would let one project eat the whole ceiling.
    await acquireResearchSlot("alice", "p1");
    await acquireResearchSlot("alice", "p1");
    await acquireResearchSlot("alice", "p1");

    // One slot, so the workspace still has two to give — three redeliveries of
    // `p1` would have exhausted the ceiling on their own.
    expect(await activeResearchCount("alice")).toBe(1);
    expect((await acquireResearchSlot("alice", "p2")).granted).toBe(true);
    expect((await acquireResearchSlot("alice", "p3")).granted).toBe(true);
    expect(await activeResearchCount("alice")).toBe(3);
  });

  it("is per workspace, not global", async () => {
    await acquireResearchSlot("alice", "p1");
    await acquireResearchSlot("alice", "p2");
    await acquireResearchSlot("alice", "p3");

    // Bob's ceiling is his own — one workspace's burst must not throttle
    // another's, which is what a single global counter would do.
    expect((await acquireResearchSlot("bob", "p1")).granted).toBe(true);
    expect(await activeResearchCount("bob")).toBe(1);
  });

  it("reaps a slot whose holder died without releasing", async () => {
    // Three evicted isolates would otherwise wedge Deep Research permanently,
    // with no surface to unwedge it from.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
    await acquireResearchSlot("alice", "p1");
    await acquireResearchSlot("alice", "p2");
    await acquireResearchSlot("alice", "p3");
    expect((await acquireResearchSlot("alice", "p4")).granted).toBe(false);

    vi.setSystemTime(new Date(Date.now() + RESEARCH_SLOT_TTL_MS + 1_000));

    expect(await activeResearchCount("alice")).toBe(0);
    expect((await acquireResearchSlot("alice", "p4")).granted).toBe(true);
  });

  it("keeps a long but live run out of the reaper", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
    await acquireResearchSlot("alice", "p1");

    // Two thirds of the way to expiry, twice — a run that renews as it makes
    // progress outlives a TTL shorter than the run itself.
    vi.setSystemTime(new Date(Date.now() + RESEARCH_SLOT_TTL_MS * 0.66));
    await renewResearchSlot("alice", "p1");
    vi.setSystemTime(new Date(Date.now() + RESEARCH_SLOT_TTL_MS * 0.66));

    expect(await activeResearchCount("alice")).toBe(1);
  });

  it("renews nothing for a project that holds no slot", async () => {
    await renewResearchSlot("alice", "ghost");
    expect(await activeResearchCount("alice")).toBe(0);
  });

  it("admits rather than refuses when the lease file is unreadable", async () => {
    // FAIL-OPEN. The ceiling is a throttle, not a correctness invariant: a
    // workspace whose lease file got mangled should still be able to research.
    const target = path.join(tmpDir, "tenants", "alice", "research-leases.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "{ not json", "utf-8");

    expect((await acquireResearchSlot("alice", "p1")).granted).toBe(true);
  });
});
