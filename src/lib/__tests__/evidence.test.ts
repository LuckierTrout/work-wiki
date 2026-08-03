import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  buildClaimEvidence,
  buildEvidenceAnchor,
  deletePageEvidence,
  getPageEvidence,
  savePageEvidence,
} from "../evidence";
import { contentHash } from "../embeddings";
import { _resetLocks } from "../lock";
import { _resetStorage } from "../storage";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "evidence-"));
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

describe("claim-level evidence", () => {
  it("stores evidence by owner and keeps stable anchor ids", async () => {
    const anchor = buildEvidenceAnchor({
      source: { type: "pptx", url: "upload", filename: "plan.pptx" },
      location: { kind: "slide", slide: 4, section: "speaker-notes" },
      excerpt: "Launch approval is required by Friday.",
      capturedAt: "2026-08-03T12:00:00.000Z",
    });
    expect(buildEvidenceAnchor({
      source: { type: "pptx", url: "upload", filename: "plan.pptx" },
      location: { kind: "slide", slide: 4, section: "speaker-notes" },
      excerpt: "Launch approval is required by Friday.",
      capturedAt: "2027-01-01T00:00:00.000Z",
    }).id).toBe(anchor.id);

    const claim = buildClaimEvidence({
      claim: "The launch requires approval by Friday.",
      relation: "supports",
      evidenceIds: [anchor.id, anchor.id],
      pageRange: { start: 10, end: 54 },
    });
    const saved = await savePageEvidence("alice", {
      pageSlug: "launch-plan",
      pageContentHash: contentHash("page version one"),
      claims: [claim, claim],
      evidence: [anchor, anchor],
    });

    expect(saved.claims).toHaveLength(1);
    expect(saved.claims[0].evidenceIds).toEqual([anchor.id]);
    expect(saved.evidence).toHaveLength(1);
    expect(await getPageEvidence("alice", "launch-plan")).toMatchObject({
      owner: "alice",
      pageSlug: "launch-plan",
    });
    expect(await getPageEvidence("bob", "launch-plan")).toBeNull();
  });

  it("rejects dangling evidence references and supports deletion", async () => {
    const claim = buildClaimEvidence({
      claim: "An unsupported claim.",
      relation: "incomplete",
      evidenceIds: ["ev_missing"],
    });
    await expect(savePageEvidence("alice", {
      pageSlug: "claim",
      pageContentHash: contentHash("claim"),
      claims: [claim],
      evidence: [],
    })).rejects.toThrow(/missing evidence/);

    await savePageEvidence("alice", {
      pageSlug: "claim",
      pageContentHash: contentHash("claim"),
      claims: [],
      evidence: [],
    });
    expect(await deletePageEvidence("alice", "claim")).toBe(true);
    expect(await deletePageEvidence("alice", "claim")).toBe(false);
  });
});
