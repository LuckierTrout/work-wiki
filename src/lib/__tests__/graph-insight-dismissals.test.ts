import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CorruptDismissalStoreError,
  dismissInsight,
  insightDismissalMap,
  listInsightDismissals,
  reconcileLegacyInsightDismissals,
} from "../graph-insight-dismissals";
import { _resetLocks } from "../lock";
import { getStorage, _resetStorage } from "../storage";
import { tenantForOwner } from "../wiki";

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
  vi.restoreAllMocks();
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalReadOnly === undefined) delete process.env.YOPEDIA_READONLY;
  else process.env.YOPEDIA_READONLY = originalReadOnly;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("insight dismissal kernel persist", () => {
  const dismissalPath = () => `tenants/${tenantForOwner("alice")}/graph-insight-dismissals.json`;

  it("keeps a dismissal across a storage reset until the fingerprint changes", async () => {
    await dismissInsight("alice", "surprise:a-b", "fp-1");
    _resetStorage();
    expect(await insightDismissalMap("alice")).toEqual(new Map([["surprise:a-b", "fp-1"]]));
    await dismissInsight("alice", "surprise:a-b", "fp-2");
    expect((await insightDismissalMap("alice")).get("surprise:a-b")).toBe("fp-2");
  });

  it("fails closed on corrupt dismissal JSON", async () => {
    await getStorage().writeFile(
      dismissalPath(),
      "{not-json",
    );
    await expect(listInsightDismissals("alice")).rejects.toBeInstanceOf(CorruptDismissalStoreError);
    expect(await getStorage().readFile(`${dismissalPath()}.corrupt`)).toBe("{not-json");
  });

  it("fails closed on a mixed or invalid-timestamp row", async () => {
    await getStorage().writeFile(dismissalPath(), JSON.stringify({
      items: [
        { id: "valid", fingerprint: "fp", dismissedAt: "2026-08-23T00:00:00.000Z" },
        { id: "invalid", fingerprint: "fp", dismissedAt: "sometime" },
      ],
    }));
    await expect(listInsightDismissals("alice")).rejects.toBeInstanceOf(CorruptDismissalStoreError);
  });

  it("quarantines the bytes read once without accumulating copies", async () => {
    await getStorage().writeFile(dismissalPath(), "first-corrupt");
    await expect(listInsightDismissals("alice")).rejects.toBeInstanceOf(CorruptDismissalStoreError);
    await getStorage().writeFile(dismissalPath(), "second-corrupt");
    await expect(listInsightDismissals("alice")).rejects.toBeInstanceOf(CorruptDismissalStoreError);
    expect(await getStorage().readFile(`${dismissalPath()}.corrupt`)).toBe("first-corrupt");
  });

  it("does not drop concurrent dismissals", async () => {
    await Promise.all([
      dismissInsight("alice", "surprise:a-b", "fp-a"),
      dismissInsight("alice", "isolated:alone", "fp-b"),
    ]);
    const map = await insightDismissalMap("alice");
    expect(map.get("surprise:a-b")).toBe("fp-a");
    expect(map.get("isolated:alone")).toBe("fp-b");
  });

  it("reapplies a dismissal after CAS loss without dropping the competing value", async () => {
    await dismissInsight("alice", "isolated:first", "fp-first");
    const storage = getStorage();
    const path = dismissalPath();
    const originalMatch = storage.writeFileIfMatch.bind(storage);
    let injected = false;
    vi.spyOn(storage, "writeFileIfMatch").mockImplementation(async (target, content, etag) => {
      if (target === path && !injected) {
        injected = true;
        const competing = JSON.parse(await storage.readFile(path)) as { items: unknown[] };
        competing.items.push({
          id: "bridge:competing",
          fingerprint: "fp-competing",
          dismissedAt: "2026-08-24T00:00:00.000Z",
        });
        await storage.writeFile(path, JSON.stringify(competing));
        return false;
      }
      return originalMatch(target, content, etag);
    });

    await dismissInsight("alice", "sparse:second", "fp-second");
    const map = await insightDismissalMap("alice");
    expect(map.get("isolated:first")).toBe("fp-first");
    expect(map.get("bridge:competing")).toBe("fp-competing");
    expect(map.get("sparse:second")).toBe("fp-second");
  });

  it("retains the newest 500 dismissals", async () => {
    const items = Array.from({ length: 500 }, (_, index) => ({
      id: `old-${index}`,
      fingerprint: `fp-${index}`,
      dismissedAt: new Date(Date.UTC(2020, 0, 1, 0, 0, index)).toISOString(),
    }));
    await getStorage().writeFile(dismissalPath(), JSON.stringify({ items }));
    await dismissInsight("alice", "newest", "fp-new");
    const stored = await listInsightDismissals("alice");
    expect(stored).toHaveLength(500);
    expect(stored.some((item) => item.id === "newest")).toBe(true);
    expect(stored.some((item) => item.id === "old-0")).toBe(false);
  });

  it.each([
    ["surprise:a:b:cross-community,cross-type", "surprise:a:b:cross-community"],
    ["isolated:alone", "isolated:alone:0"],
    ["sparse:1", "sparse:a,b,c:0.10"],
    ["bridge:hub", "bridge:hub:1,2,3"],
  ])("migrates the committed legacy format for %s exactly once", async (id, legacy) => {
    await getStorage().writeFile(dismissalPath(), JSON.stringify({
      items: [{
        id,
        fingerprint: legacy,
        dismissedAt: "2026-08-23T00:00:00.000Z",
      }],
    }));
    const current = `graph:cv1:1-${id.replace(/[^a-z0-9]/gi, "").slice(0, 16).padEnd(16, "0")}`;
    const migrated = await reconcileLegacyInsightDismissals("alice", [{
      id,
      fingerprint: current,
      legacyFingerprint: legacy,
    }]);
    expect(migrated.get(id)).toBe(current);
    expect((await listInsightDismissals("alice"))[0].fingerprint).toBe(current);
    await reconcileLegacyInsightDismissals("alice", [{
      id,
      fingerprint: current,
      legacyFingerprint: legacy,
    }]);
    expect((await listInsightDismissals("alice"))[0].fingerprint).toBe(current);
  });

  it("rewrites a stored long Insight id to the bounded live id", async () => {
    const legacyId = `surprise:${"long-slug-".repeat(20)}:cross-community`;
    const currentId = "surprise:bounded-id";
    const legacy = "surprise:a:b:cross-community";
    const current = "graph:cv1:1-surpriseabcross00";
    await getStorage().writeFile(dismissalPath(), JSON.stringify({
      items: [{
        id: legacyId,
        fingerprint: legacy,
        dismissedAt: "2026-08-23T00:00:00.000Z",
      }],
    }));
    const migrated = await reconcileLegacyInsightDismissals("alice", [{
      id: currentId,
      fingerprint: current,
      legacyFingerprint: legacy,
      legacyId,
    }]);
    expect(migrated.get(currentId)).toBe(current);
    expect(migrated.has(legacyId)).toBe(false);
    const stored = await listInsightDismissals("alice");
    expect(stored[0]?.id).toBe(currentId);
    expect(stored[0]?.fingerprint).toBe(current);
  });

  it("rejects oversized dismissal identities", async () => {
    await expect(dismissInsight("alice", "x".repeat(201), "fp")).rejects.toThrow(/too long/);
    await expect(dismissInsight("alice", "id", "x".repeat(81))).rejects.toThrow(/too long/);
  });
});
