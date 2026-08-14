import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => { throw new Error("off workers"); }),
}));

import {
  deliverOutboxEvent,
  listDueOutboxEvents,
  listOutboxEvents,
  saveIntegrationSettings,
  stageAcceptedActionIntegrations,
} from "../integration-outbox";
import { _resetLocks } from "../lock";
import { _resetStorage } from "../storage";
import type { ActionItem } from "../action-items";

let tmpDir: string;
let originalDataDir: string | undefined;

const action: ActionItem = {
  id: "action-1",
  title: "Send the launch brief",
  details: "Send the approved brief to the regional team.",
  dueDate: "2026-08-10",
  priority: "high",
  status: "accepted",
  createdAt: "2026-08-03T10:00:00.000Z",
  updatedAt: "2026-08-03T10:00:00.000Z",
};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "integration-outbox-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetStorage();
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  _resetLocks();
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("integration outbox", () => {
  it("stages deterministic events once for each enabled destination", async () => {
    await saveIntegrationSettings("alice", {
      webhookEnabled: true,
      webhookUrl: "https://example.com/hooks/yopedia",
      calendarEnabled: true,
    });
    const first = await stageAcceptedActionIntegrations("alice", action);
    const replay = await stageAcceptedActionIntegrations("alice", action);
    expect(first).toHaveLength(2);
    expect(replay.map((event) => event.id)).toEqual(first.map((event) => event.id));
    expect(await listOutboxEvents("alice")).toHaveLength(2);
    const afterStaging = new Date(
      Math.max(...first.map((event) => Date.parse(event.nextAttemptAt!))) + 1,
    );
    expect(await listDueOutboxEvents(afterStaging)).toHaveLength(2);
  });

  it("renders an iCalendar task and records a durable delivery receipt", async () => {
    await saveIntegrationSettings("alice", { calendarEnabled: true });
    const [event] = await stageAcceptedActionIntegrations("alice", action);
    const delivered = await deliverOutboxEvent("alice", event.id, {
      now: new Date("2026-08-03T11:00:00.000Z"),
    });
    expect(delivered.status).toBe("delivered");
    expect(delivered.receipt?.calendar).toContain("BEGIN:VTODO");
    expect(delivered.receipt?.calendar).toContain("DUE;VALUE=DATE:20260810");
  });

  it("sends webhooks with a stable idempotency key", async () => {
    await saveIntegrationSettings("alice", {
      webhookEnabled: true,
      webhookUrl: "https://example.com/hooks/yopedia",
    });
    const [event] = await stageAcceptedActionIntegrations("alice", action);
    const fetchMock = vi.fn().mockResolvedValue(new Response("accepted", { status: 202 }));
    const delivered = await deliverOutboxEvent("alice", event.id, { fetch: fetchMock });
    expect(delivered.status).toBe("delivered");
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe(event.idempotencyKey);
  });
});
