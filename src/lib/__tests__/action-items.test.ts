import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  deleteActionItem,
  listActionItems,
  proposeActionItems,
  updateActionItem,
} from "../action-items";
import { _resetLocks } from "../lock";
import { _resetStorage } from "../storage";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "action-items-"));
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

describe("owner action items", () => {
  it("stores proposals privately and deduplicates title plus source", async () => {
    const [created] = await proposeActionItems("alice", [{
      title: "Send the report",
      sourceSlug: "meeting-notes",
      priority: "high",
      confidence: 0.93,
    }]);
    expect(created).toMatchObject({ status: "inbox", priority: "high" });
    expect(await proposeActionItems("alice", [{
      title: "  send   the report ",
      sourceSlug: "meeting-notes",
    }])).toEqual([]);
    expect(await listActionItems("bob")).toEqual([]);
    expect(await listActionItems("alice")).toHaveLength(1);
  });

  it("supports approval, completion, filtering, and deletion", async () => {
    const [created] = await proposeActionItems("alice", [{ title: "Review draft" }]);
    const edited = await updateActionItem("alice", created.id, {
      title: "Review final draft",
      details: "Check the revised methodology section.",
      assignee: "Christian",
      dueDate: "next Friday",
      priority: "high",
      status: "accepted",
    });
    expect(edited).toMatchObject({
      title: "Review final draft",
      details: "Check the revised methodology section.",
      assignee: "Christian",
      dueDate: "next Friday",
      priority: "high",
      status: "accepted",
    });
    expect(await listActionItems("alice", "accepted")).toHaveLength(1);
    const cleared = await updateActionItem("alice", created.id, {
      assignee: "",
      dueDate: "",
    });
    expect(cleared?.assignee).toBeUndefined();
    expect(cleared?.dueDate).toBeUndefined();
    const done = await updateActionItem("alice", created.id, { status: "done" });
    expect(done?.completedAt).toBeTruthy();
    expect(await deleteActionItem("alice", created.id)).toBe(true);
    expect(await listActionItems("alice")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Guidance by human, storage by handle (DW-709)
// ---------------------------------------------------------------------------

import { createNamesTerm } from "../names-terms";
import { tenantForOwner } from "../wiki";

/**
 * `ownerToTenant("alice--yoyo")` is the AGENT's own tenant, so before DW-709
 * both dictionary reads here addressed an empty file and every assignee an
 * agent proposed came through uncanonicalized. The reduction is guidance-only:
 * the lock key and the item store still name the agent's silo.
 */
describe("agent-owned action items resolve the dictionary by human owner", () => {
  const HUMAN = "alice";
  const AGENT = "alice--yoyo";

  beforeEach(async () => {
    await createNamesTerm(HUMAN, {
      kind: "person",
      canonical: "Alice Chen",
      aliases: ["Ali"],
    });
  });

  it("canonicalizes a proposed assignee against the human's dictionary", async () => {
    const [created] = await proposeActionItems(AGENT, [{
      title: "Send the launch brief",
      assignee: "Ali",
    }]);
    expect(created.assignee).toBe("Alice Chen");
  });

  it("canonicalizes an edited assignee against the human's dictionary", async () => {
    const [created] = await proposeActionItems(AGENT, [{ title: "Review draft" }]);
    const edited = await updateActionItem(AGENT, created.id, { assignee: "Ali" });
    expect(edited?.assignee).toBe("Alice Chen");
  });

  it("keeps the item in the AGENT's silo, not the human's", async () => {
    // The half that must NOT move. `tenantForOwner` deliberately keeps the
    // `--<agent>` suffix, so a reduced handle on `lockKey`/`readItems` would
    // silently repoint the write into alice's inbox.
    expect(tenantForOwner(AGENT)).not.toBe(tenantForOwner(HUMAN));
    await proposeActionItems(AGENT, [{ title: "Agent-only work", assignee: "Ali" }]);
    expect(await listActionItems(AGENT)).toHaveLength(1);
    expect(await listActionItems(HUMAN)).toEqual([]);
  });

  it("leaves an unreducible handle addressing its own tenant", async () => {
    // `humanOwnerOf` passes `yoyo` / `system` / `--yoyo` through whole, so these
    // read the same (empty) dictionary they read before DW-709.
    for (const handle of ["yoyo", "system", "--yoyo"]) {
      const [created] = await proposeActionItems(handle, [{
        title: `Work for ${handle}`,
        assignee: "Ali",
      }]);
      expect(created.assignee).toBe("Ali");
    }
  });
});
