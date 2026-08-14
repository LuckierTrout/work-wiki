import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  applyMemoryChangeProposal,
  createMemoryChangeProposal,
  getMemoryChangeProposal,
  listMemoryChangeProposals,
  rejectMemoryChangeProposal,
  reviseMemoryChangeProposal,
} from "../memory-proposals";
import { serializeFrontmatter } from "../frontmatter";
import { _resetLocks } from "../lock";
import { _resetStorage } from "../storage";
import {
  tenantWikiRelPath,
  tenantForOwner,
} from "../wiki";
import { getStorage } from "../storage";
import { listOperations } from "../operation-ledger";

let tmpDir: string;
let originalDataDir: string | undefined;

function page(owner: string, body: string): string {
  return serializeFrontmatter(
    {
      owner,
      visibility: "private",
      authors: [owner],
      created: "2026-08-01",
      updated: "2026-08-01",
    },
    body,
  );
}

async function readAlicePage(): Promise<string> {
  return getStorage().readFile(
    tenantWikiRelPath(tenantForOwner("alice"), "plan.md"),
  );
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-proposals-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetStorage();
  await getStorage().writeFile(
    tenantWikiRelPath(tenantForOwner("alice"), "plan.md"),
    page("alice", "# Plan\n\nCurrent plan."),
  );
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  _resetLocks();
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("reviewable memory proposals", () => {
  it("does not change a page until the owner accepts the proposal", async () => {
    const proposedContent = page("alice", "# Plan\n\nUpdated plan with evidence.");
    const proposal = await createMemoryChangeProposal("alice", {
      targetSlug: "plan",
      title: "Plan",
      summary: "Updated plan",
      reason: "A newer source changed the deadline.",
      proposedContent,
      evidenceIds: ["ev_deadline"],
      actor: "alice--research-monitor",
      risk: "high",
    });

    expect(proposal.status).toBe("pending");
    expect(await readAlicePage()).toContain("Current plan");
    expect((await listMemoryChangeProposals("alice", "pending"))).toHaveLength(1);
    expect(await getMemoryChangeProposal("bob", proposal.id)).toBeNull();

    const accepted = await applyMemoryChangeProposal(
      "alice",
      proposal.id,
      "alice",
      "Source checked.",
    );
    expect(accepted.status).toBe("accepted");
    expect(await readAlicePage()).toContain(
      "Updated plan with evidence",
    );
    expect(await applyMemoryChangeProposal("alice", proposal.id, "alice")).toEqual(accepted);
  });

  it("fails closed when the page changed after proposal creation", async () => {
    const proposal = await createMemoryChangeProposal("alice", {
      targetSlug: "plan",
      title: "Plan",
      summary: "Proposed update",
      reason: "New evidence.",
      proposedContent: page("alice", "# Plan\n\nProposed update."),
    });
    await getStorage().writeFile(
      tenantWikiRelPath(tenantForOwner("alice"), "plan.md"),
      page("alice", "# Plan\n\nA human edited this first."),
    );
    await expect(
      applyMemoryChangeProposal("alice", proposal.id, "alice"),
    ).rejects.toThrow(/stale/);
    expect((await getMemoryChangeProposal("alice", proposal.id))?.status).toBe("pending");
  });

  it("keeps rejected proposals auditable and unapplied", async () => {
    const proposal = await createMemoryChangeProposal("alice", {
      targetSlug: "plan",
      title: "Plan",
      summary: "Rejected update",
      reason: "Untrusted suggestion.",
      proposedContent: page("alice", "# Plan\n\nRejected content."),
    });
    const rejected = await rejectMemoryChangeProposal(
      "alice",
      proposal.id,
      "alice",
      "Evidence was insufficient.",
    );
    expect(rejected).toMatchObject({
      status: "rejected",
      decisionNote: "Evidence was insufficient.",
    });
    await expect(
      applyMemoryChangeProposal("alice", proposal.id, "alice"),
    ).rejects.toThrow(/rejected proposal/);
    expect(await readAlicePage()).toContain("Current plan");
    expect(await listOperations("alice")).toEqual([
      expect.objectContaining({ operation: "reject-memory-proposal" }),
    ]);
  });

  it("keeps a bounded draft history when the owner revises before accepting", async () => {
    const proposal = await createMemoryChangeProposal("alice", {
      targetSlug: "plan",
      title: "Plan",
      summary: "Editable update",
      reason: "Owner review.",
      proposedContent: page("alice", "# Plan\n\nFirst draft."),
    });
    const revised = await reviseMemoryChangeProposal(
      "alice",
      proposal.id,
      "alice",
      "# Plan\n\nOwner-edited draft.",
    );
    expect(revised.revisions).toHaveLength(1);
    expect(revised.revisions?.[0].proposedContent).toContain("First draft");
    expect(revised.proposedContent).toContain("Owner-edited draft");
    expect(await readAlicePage()).toContain("Current plan");
  });
});
