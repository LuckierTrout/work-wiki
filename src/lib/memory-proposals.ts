import { contentHash } from "./embeddings";
import { isEnoent } from "./errors";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter";
import { withFileLock } from "./lock";
import { getStorage } from "./storage";
import {
  readWikiPageWithFrontmatter,
  tenantForOwner,
  tenantWikiRelPath,
  validateSlug,
  validateTenant,
} from "./wiki";
import { writeWikiPageWithSideEffects } from "./lifecycle";
import { getPageEvidence, type EvidenceAnchor } from "./evidence";
import { enqueueTask } from "./tasks";
import { logger } from "./logger";
import { recordOperationSafe } from "./operation-ledger";

export const MEMORY_PROPOSAL_VERSION = 1 as const;

export type MemoryProposalStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "superseded";
export type MemoryProposalRisk = "low" | "medium" | "high";
export type MemoryProposalKind = "create" | "update";

export interface MemoryChangeProposal {
  version: typeof MEMORY_PROPOSAL_VERSION;
  id: string;
  owner: string;
  targetSlug: string;
  kind: MemoryProposalKind;
  title: string;
  summary: string;
  reason: string;
  proposedContent: string;
  proposedContentHash: string;
  baseContentHash: string | null;
  evidenceIds: string[];
  actor: string;
  risk: MemoryProposalRisk;
  status: MemoryProposalStatus;
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  decisionNote?: string;
  revisions?: Array<{
    proposedContent: string;
    proposedContentHash: string;
    editedAt: string;
    editedBy: string;
  }>;
}

export type MemoryChangeProposalSummary = Omit<
  MemoryChangeProposal,
  "proposedContent"
>;

export interface CreateMemoryProposalInput {
  targetSlug: string;
  title: string;
  summary: string;
  reason: string;
  proposedContent: string;
  evidenceIds?: string[];
  actor?: string;
  risk?: MemoryProposalRisk;
}

export interface MemoryProposalReview {
  proposal: MemoryChangeProposal;
  currentContent: string | null;
  currentContentHash: string | null;
  isStale: boolean;
  evidence: EvidenceAnchor[];
}

const MAX_PROPOSALS = 1_000;
const MAX_PROPOSED_CONTENT_CHARS = 1_000_000;

function tenant(owner: string): string {
  const value = tenantForOwner(owner);
  validateTenant(value);
  return value;
}

function indexKey(owner: string): string {
  return `memory-proposals:${tenant(owner)}`;
}

function proposalPath(owner: string, id: string): string {
  if (!/^mp_[a-z0-9-]{8,80}$/i.test(id)) throw new Error("Invalid proposal id");
  return `tenants/${tenant(owner)}/memory-proposals/${id}.json`;
}

function lockKey(owner: string): string {
  return `memory-proposals:${tenant(owner)}`;
}

function asSummary(proposal: MemoryChangeProposal): MemoryChangeProposalSummary {
  const { proposedContent: _content, ...summary } = proposal;
  return summary;
}

async function readIndex(owner: string): Promise<MemoryChangeProposalSummary[]> {
  try {
    const value = await getStorage().getIndex<MemoryChangeProposalSummary[]>(indexKey(owner));
    return Array.isArray(value) ? value : [];
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

async function writeIndex(
  owner: string,
  proposals: MemoryChangeProposalSummary[],
): Promise<void> {
  await getStorage().putIndex(
    indexKey(owner),
    proposals
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-MAX_PROPOSALS),
  );
}

async function writeProposal(proposal: MemoryChangeProposal): Promise<void> {
  await getStorage().writeFile(
    proposalPath(proposal.owner, proposal.id),
    JSON.stringify(proposal, null, 2),
  );
}

function ownerMatches(owner: string, pageOwner: unknown): boolean {
  return typeof pageOwner === "string" && tenantForOwner(pageOwner) === tenantForOwner(owner);
}

async function readOwnerPage(
  owner: string,
  slug: string,
): Promise<{ content: string; frontmatter: ReturnType<typeof parseFrontmatter>["data"] } | null> {
  try {
    const content = await getStorage().readFile(
      tenantWikiRelPath(tenant(owner), `${slug}.md`),
    );
    const { data: frontmatter } = parseFrontmatter(content);
    return ownerMatches(owner, frontmatter.owner)
      ? { content, frontmatter }
      : null;
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }

  // Transitional fallback for pages that have not yet been moved into a
  // tenant silo. The owner check prevents a same-slug page from another
  // tenant being used as the proposal base.
  const page = await readWikiPageWithFrontmatter(slug);
  return page && ownerMatches(owner, page.frontmatter.owner)
    ? { content: page.content, frontmatter: page.frontmatter }
    : null;
}

export async function createMemoryChangeProposal(
  owner: string,
  input: CreateMemoryProposalInput,
): Promise<MemoryChangeProposal> {
  validateSlug(input.targetSlug);
  const title = input.title.trim().slice(0, 240);
  const summary = input.summary.trim().slice(0, 1_000);
  const reason = input.reason.trim().slice(0, 2_000);
  const proposedContent = input.proposedContent.trim();
  if (!title) throw new Error("Proposal title is required");
  if (!summary) throw new Error("Proposal summary is required");
  if (!reason) throw new Error("Proposal reason is required");
  if (!proposedContent) throw new Error("Proposed page content is required");
  if (proposedContent.length > MAX_PROPOSED_CONTENT_CHARS) {
    throw new Error("Proposed page content is too large");
  }

  const proposedFrontmatter = parseFrontmatter(proposedContent).data;
  if (!ownerMatches(owner, proposedFrontmatter.owner)) {
    throw new Error("Proposed page owner must match the review owner");
  }

  const existing = await readOwnerPage(owner, input.targetSlug);
  const kind: MemoryProposalKind = existing ? "update" : "create";
  const baseContentHash = existing ? contentHash(existing.content) : null;
  const proposedContentHash = contentHash(proposedContent);
  if (baseContentHash === proposedContentHash) {
    throw new Error("The proposal does not change the page");
  }

  return withFileLock(lockKey(owner), async () => {
    const index = await readIndex(owner);
    const duplicate = index.find(
      (proposal) =>
        proposal.status === "pending" &&
        proposal.targetSlug === input.targetSlug &&
        proposal.proposedContentHash === proposedContentHash,
    );
    if (duplicate) {
      const current = await getMemoryChangeProposal(owner, duplicate.id);
      if (current) return current;
    }

    const now = new Date().toISOString();
    const proposal: MemoryChangeProposal = {
      version: MEMORY_PROPOSAL_VERSION,
      id: `mp_${crypto.randomUUID()}`,
      owner,
      targetSlug: input.targetSlug,
      kind,
      title,
      summary,
      reason,
      proposedContent,
      proposedContentHash,
      baseContentHash,
      evidenceIds: Array.from(
        new Set((input.evidenceIds ?? []).map((id) => id.trim()).filter(Boolean)),
      ),
      actor: input.actor?.trim().slice(0, 160) || owner,
      risk: input.risk ?? "medium",
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    await writeProposal(proposal);
    await writeIndex(owner, [...index, asSummary(proposal)]);
    return proposal;
  });
}

export async function getMemoryChangeProposal(
  owner: string,
  id: string,
): Promise<MemoryChangeProposal | null> {
  try {
    const parsed = JSON.parse(await getStorage().readFile(proposalPath(owner, id))) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const proposal = parsed as MemoryChangeProposal;
    if (
      proposal.version !== MEMORY_PROPOSAL_VERSION ||
      proposal.id !== id ||
      tenantForOwner(proposal.owner) !== tenantForOwner(owner)
    ) {
      return null;
    }
    return proposal;
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

export async function listMemoryChangeProposals(
  owner: string,
  status?: MemoryProposalStatus,
): Promise<MemoryChangeProposalSummary[]> {
  return (await readIndex(owner))
    .filter((proposal) => !status || proposal.status === status)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getMemoryProposalReview(
  owner: string,
  id: string,
): Promise<MemoryProposalReview | null> {
  const proposal = await getMemoryChangeProposal(owner, id);
  if (!proposal) return null;

  const [current, evidenceBundle] = await Promise.all([
    readOwnerPage(owner, proposal.targetSlug),
    getPageEvidence(owner, proposal.targetSlug),
  ]);
  const currentContentHash = current ? contentHash(current.content) : null;
  const requestedEvidence = new Set(proposal.evidenceIds);
  const evidence = evidenceBundle?.evidence.filter((anchor) =>
    requestedEvidence.has(anchor.id),
  ) ?? [];
  const isStale = proposal.status === "pending" && (
    proposal.kind === "create"
      ? current !== null
      : currentContentHash !== proposal.baseContentHash
  );

  return {
    proposal,
    currentContent: current?.content ?? null,
    currentContentHash,
    isStale,
    evidence,
  };
}

async function persistUpdatedProposal(
  owner: string,
  proposal: MemoryChangeProposal,
): Promise<void> {
  const index = await readIndex(owner);
  const position = index.findIndex((item) => item.id === proposal.id);
  if (position === -1) throw new Error("Proposal index entry is missing");
  index[position] = asSummary(proposal);
  await writeProposal(proposal);
  await writeIndex(owner, index);
}

export async function rejectMemoryChangeProposal(
  owner: string,
  id: string,
  reviewedBy: string,
  decisionNote?: string,
): Promise<MemoryChangeProposal | null> {
  return withFileLock(lockKey(owner), async () => {
    const proposal = await getMemoryChangeProposal(owner, id);
    if (!proposal) return null;
    if (proposal.status !== "pending") return proposal;
    const now = new Date().toISOString();
    proposal.status = "rejected";
    proposal.reviewedAt = now;
    proposal.reviewedBy = reviewedBy;
    proposal.updatedAt = now;
    if (decisionNote?.trim()) proposal.decisionNote = decisionNote.trim().slice(0, 1_000);
    await persistUpdatedProposal(owner, proposal);
    await recordOperationSafe(owner, {
      kind: "review",
      operation: "reject-memory-proposal",
      status: "succeeded",
      subjectId: proposal.id,
      actor: reviewedBy,
      detail: proposal.targetSlug,
    });
    return proposal;
  });
}

export async function reviseMemoryChangeProposal(
  owner: string,
  id: string,
  editedBy: string,
  proposedBody: string,
): Promise<MemoryChangeProposal> {
  return withFileLock(lockKey(owner), async () => {
    const proposal = await getMemoryChangeProposal(owner, id);
    if (!proposal) throw new Error("Proposal not found");
    if (proposal.status !== "pending") {
      throw new Error(`A ${proposal.status} proposal cannot be revised`);
    }
    const body = proposedBody.trim();
    if (!body) throw new Error("Proposed page body is required");
    const frontmatter = parseFrontmatter(proposal.proposedContent).data;
    if (!ownerMatches(owner, frontmatter.owner)) {
      throw new Error("Proposed page owner must match the review owner");
    }
    const proposedContent = serializeFrontmatter(frontmatter, body);
    if (proposedContent.length > MAX_PROPOSED_CONTENT_CHARS) {
      throw new Error("Proposed page content is too large");
    }
    const proposedContentHash = contentHash(proposedContent);
    if (proposedContentHash === proposal.proposedContentHash) return proposal;
    if (proposedContentHash === proposal.baseContentHash) {
      throw new Error("The revised proposal does not change the page");
    }
    const now = new Date().toISOString();
    proposal.revisions = [
      ...(proposal.revisions ?? []),
      {
        proposedContent: proposal.proposedContent,
        proposedContentHash: proposal.proposedContentHash,
        editedAt: now,
        editedBy,
      },
    ].slice(-20);
    proposal.proposedContent = proposedContent;
    proposal.proposedContentHash = proposedContentHash;
    proposal.updatedAt = now;
    await persistUpdatedProposal(owner, proposal);
    await recordOperationSafe(owner, {
      kind: "review",
      operation: "revise-memory-proposal",
      status: "succeeded",
      subjectId: proposal.id,
      actor: editedBy,
      detail: proposal.targetSlug,
    });
    return proposal;
  });
}

export async function applyMemoryChangeProposal(
  owner: string,
  id: string,
  reviewedBy: string,
  decisionNote?: string,
): Promise<MemoryChangeProposal> {
  return withFileLock(lockKey(owner), async () => {
    const proposal = await getMemoryChangeProposal(owner, id);
    if (!proposal) throw new Error("Proposal not found");
    if (proposal.status !== "pending") {
      if (proposal.status === "accepted") return proposal;
      throw new Error(`A ${proposal.status} proposal cannot be applied`);
    }

    const current = await readOwnerPage(owner, proposal.targetSlug);
    if (proposal.kind === "create" && current) {
      throw new Error("Proposal is stale: the target page now exists");
    }
    if (proposal.kind === "update") {
      if (!current) throw new Error("Proposal is stale: the target page was deleted");
      if (!ownerMatches(owner, current.frontmatter.owner)) {
        throw new Error("Only the page owner may apply this proposal");
      }
      if (contentHash(current.content) !== proposal.baseContentHash) {
        throw new Error("Proposal is stale: the page changed after this proposal was created");
      }
    }

    await writeWikiPageWithSideEffects({
      slug: proposal.targetSlug,
      title: proposal.title,
      content: proposal.proposedContent,
      summary: proposal.summary,
      logOp: proposal.kind === "create" ? "save" : "edit",
      crossRefSource: null,
      author: reviewedBy,
      logDetails: () => `accepted memory proposal ${proposal.id}`,
    });

    const now = new Date().toISOString();
    proposal.status = "accepted";
    proposal.reviewedAt = now;
    proposal.reviewedBy = reviewedBy;
    proposal.updatedAt = now;
    if (decisionNote?.trim()) proposal.decisionNote = decisionNote.trim().slice(0, 1_000);
    await persistUpdatedProposal(owner, proposal);
    await recordOperationSafe(owner, {
      kind: "review",
      operation: "accept-memory-proposal",
      status: "succeeded",
      subjectId: proposal.id,
      actor: reviewedBy,
      detail: proposal.targetSlug,
    });
    try {
      await enqueueTask({
        kind: "extract-knowledge",
        slug: proposal.targetSlug,
        owner,
      });
    } catch (error) {
      // The accepted page is already durable. Derived records are rebuildable,
      // so a queue outage must not turn a successful owner decision into a 500.
      logger.warn(
        "memory-proposals",
        `structured knowledge enqueue failed for ${proposal.targetSlug}`,
        error,
      );
    }
    return proposal;
  });
}
