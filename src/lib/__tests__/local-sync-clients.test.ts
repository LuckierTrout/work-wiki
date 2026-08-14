import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  listLocalSyncClients,
  recordLocalSyncHeartbeat,
  removeLocalSyncClient,
} from "../local-sync-clients";
import { _resetLocks } from "../lock";
import { _resetStorage } from "../storage";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "local-sync-clients-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetStorage();
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("local sync clients", () => {
  it("upserts owner-scoped heartbeats and removes retired records", async () => {
    await recordLocalSyncHeartbeat({
      owner: "alice",
      clientId: "alice-macbook",
      label: "Alice MacBook",
      mode: "sources",
      operation: "source-watch",
      state: "watching",
      itemCount: 4,
    });
    await recordLocalSyncHeartbeat({
      owner: "alice",
      clientId: "alice-macbook",
      mode: "sources",
      operation: "source-push",
      state: "ok",
      itemCount: 1,
    });

    expect(await listLocalSyncClients("bob")).toEqual([]);
    expect(await listLocalSyncClients("alice")).toMatchObject([{
      id: "alice-macbook",
      label: "Alice MacBook",
      operation: "source-push",
      state: "ok",
      itemCount: 1,
    }]);
    expect(await removeLocalSyncClient("alice", "alice-macbook")).toBe(true);
    expect(await listLocalSyncClients("alice")).toEqual([]);
  });
});
