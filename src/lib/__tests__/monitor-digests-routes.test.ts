import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));
vi.mock("@/lib/monitor-digests", () => ({
  createMonitorDigest: vi.fn(),
  listMonitorDigests: vi.fn(),
  loadMonitorDigestSettings: vi.fn(),
  markMonitorDigestQueued: vi.fn(),
  markMonitorDigestRead: vi.fn(),
  saveMonitorDigestSettings: vi.fn(),
}));
vi.mock("@/lib/tasks", () => ({ enqueueTask: vi.fn() }));

import { getPrincipal } from "@/lib/auth";
import {
  createMonitorDigest,
  listMonitorDigests,
  loadMonitorDigestSettings,
  markMonitorDigestQueued,
  markMonitorDigestRead,
  saveMonitorDigestSettings,
} from "@/lib/monitor-digests";
import { enqueueTask } from "@/lib/tasks";
import { GET, PATCH, POST } from "@/app/api/monitor-digests/route";
import { POST as POST_READ } from "@/app/api/monitor-digests/[id]/read/route";

const mockedPrincipal = vi.mocked(getPrincipal);
const mockedCreate = vi.mocked(createMonitorDigest);
const mockedList = vi.mocked(listMonitorDigests);
const mockedLoadSettings = vi.mocked(loadMonitorDigestSettings);
const mockedMarkQueued = vi.mocked(markMonitorDigestQueued);
const mockedMarkRead = vi.mocked(markMonitorDigestRead);
const mockedSaveSettings = vi.mocked(saveMonitorDigestSettings);
const mockedEnqueue = vi.mocked(enqueueTask);

const SETTINGS = {
  owner: "alice",
  enabled: true,
  cadence: "daily" as const,
  emailEnabled: true,
  emailAddress: "alice@example.com",
  nextDigestAt: "2026-08-06T06:00:00.000Z",
  lastWindowEndAt: null,
  lastDigestAt: null,
  updatedAt: "2026-08-05T06:00:00.000Z",
};

const DIGEST = {
  id: "mdg_1234567890abcdef",
  owner: "alice",
  periodStart: "2026-08-04T06:00:00.000Z",
  periodEnd: "2026-08-05T06:00:00.000Z",
  createdAt: "2026-08-05T06:00:00.000Z",
  readAt: null,
  counts: {
    checks: 1,
    unchanged: 0,
    initialized: 0,
    minorChanges: 0,
    proposals: 1,
    failures: 0,
    recoveries: 0,
  },
  entries: [],
  email: {
    status: "pending" as const,
    to: "alice@example.com",
    attempts: 0,
    nextAttemptAt: "2026-08-05T06:00:00.000Z",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedPrincipal.mockResolvedValue({ id: "user_alice", handle: "alice" });
  mockedLoadSettings.mockResolvedValue(SETTINGS);
  mockedList.mockResolvedValue([DIGEST]);
  mockedSaveSettings.mockResolvedValue(SETTINGS);
  mockedCreate.mockResolvedValue(DIGEST);
  mockedMarkQueued.mockResolvedValue({ ...DIGEST, email: { ...DIGEST.email, status: "queued" } });
  mockedMarkRead.mockResolvedValue({ ...DIGEST, readAt: "2026-08-05T07:00:00.000Z" });
  mockedEnqueue.mockResolvedValue(true);
});

describe("monitor digest API", () => {
  it("keeps digest history behind the signed-in owner boundary", async () => {
    mockedPrincipal.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("returns only the principal's digest history and unread count", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ unread: 1, settings: SETTINGS });
    expect(mockedList).toHaveBeenCalledWith("alice");
  });

  it("validates and saves owner delivery preferences", async () => {
    const response = await PATCH(new Request("http://localhost/api/monitor-digests", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        cadence: "daily",
        emailEnabled: true,
        emailAddress: "alice@example.com",
      }),
    }));
    expect(response.status).toBe(200);
    expect(mockedSaveSettings).toHaveBeenCalledWith("alice", {
      enabled: true,
      cadence: "daily",
      emailEnabled: true,
      emailAddress: "alice@example.com",
    });
  });

  it("generates now and queues email through the durable task path", async () => {
    const response = await POST();
    expect(response.status).toBe(200);
    expect(mockedCreate).toHaveBeenCalledWith("alice", { force: true });
    expect(mockedEnqueue).toHaveBeenCalledWith({
      kind: "deliver-monitor-digest",
      digestId: DIGEST.id,
      owner: "alice",
    });
    expect(mockedMarkQueued).toHaveBeenCalledWith("alice", DIGEST.id);
  });

  it("marks a digest read only within the principal's owner scope", async () => {
    const response = await POST_READ(
      new Request(`http://localhost/api/monitor-digests/${DIGEST.id}/read`, { method: "POST" }),
      { params: Promise.resolve({ id: DIGEST.id }) },
    );
    expect(response.status).toBe(200);
    expect(mockedMarkRead).toHaveBeenCalledWith("alice", DIGEST.id);
  });
});
