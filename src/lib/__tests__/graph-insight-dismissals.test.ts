import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  dismissInsight,
  insightDismissalMap,
} from "../graph-insight-dismissals";
import { _resetLocks } from "../lock";
import { _resetStorage } from "../storage";

let tmpDir: string;
let originalDataDir: string | undefined;
let originalReadOnly: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "graph-dismiss-"));
  originalDataDir = process.env.DATA_DIR;
  originalReadOnly = process.env.YOPEDIA_READONLY;
  process.env.DATA_DIR = tmpDir;
  delete process.env.YOPEDIA_READONLY;
  _resetLocks();
  _resetStorage();
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalReadOnly === undefined) delete process.env.YOPEDIA_READONLY;
  else process.env.YOPEDIA_READONLY = originalReadOnly;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("insight dismissal kernel persist", () => {
  it("keeps a dismissal across a storage reset until the fingerprint changes", async () => {
    await dismissInsight("alice", "surprise:a-b", "fp-1");
    _resetStorage();
    expect(await insightDismissalMap("alice")).toEqual(new Map([["surprise:a-b", "fp-1"]]));
    await dismissInsight("alice", "surprise:a-b", "fp-2");
    expect((await insightDismissalMap("alice")).get("surprise:a-b")).toBe("fp-2");
  });
});
