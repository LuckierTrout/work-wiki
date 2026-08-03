import { contentHash } from "./embeddings";
import { isEnoent } from "./errors";
import { withFileLock } from "./lock";
import { getStorage } from "./storage";
import type { SourceEntry } from "./types";
import { tenantForOwner, validateSlug, validateTenant } from "./wiki";

export const PAGE_EVIDENCE_VERSION = 1 as const;

export type EvidenceRelation =
  | "supports"
  | "contradicts"
  | "context"
  | "incomplete";

export type EvidenceLocation =
  | { kind: "text-range"; start: number; end: number; heading?: string }
  | { kind: "document-section"; heading: string }
  | { kind: "pdf-page"; page: number; start?: number; end?: number }
  | { kind: "slide"; slide: number; section?: "content" | "speaker-notes" }
  | { kind: "spreadsheet"; sheet: string; range?: string }
  | {
      kind: "email";
      section: "subject" | "body" | "attachment";
      attachmentName?: string;
    }
  | { kind: "url-fragment"; fragment?: string };

export interface EvidenceSource {
  type: SourceEntry["type"];
  url: string;
  rawId?: string;
  filename?: string;
  sha256?: string;
}

export interface EvidenceAnchor {
  id: string;
  source: EvidenceSource;
  location: EvidenceLocation;
  excerpt: string;
  excerptHash: string;
  capturedAt: string;
}

export interface ClaimEvidence {
  id: string;
  claim: string;
  relation: EvidenceRelation;
  evidenceIds: string[];
  pageRange?: { start: number; end: number };
}

export interface PageEvidenceBundle {
  version: typeof PAGE_EVIDENCE_VERSION;
  owner: string;
  pageSlug: string;
  pageContentHash: string;
  claims: ClaimEvidence[];
  evidence: EvidenceAnchor[];
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceAnchorInput {
  source: EvidenceSource;
  location: EvidenceLocation;
  excerpt: string;
  capturedAt?: string;
}

export interface ClaimEvidenceInput {
  claim: string;
  relation: EvidenceRelation;
  evidenceIds: string[];
  pageRange?: { start: number; end: number };
}

const MAX_EVIDENCE_PER_PAGE = 500;
const MAX_CLAIMS_PER_PAGE = 500;
const MAX_EXCERPT_CHARS = 4_000;
const MAX_CLAIM_CHARS = 2_000;

function evidencePath(owner: string, slug: string): string {
  const tenant = tenantForOwner(owner);
  validateTenant(tenant);
  validateSlug(slug);
  return `tenants/${tenant}/evidence/${slug}.json`;
}

function evidenceLock(owner: string, slug: string): string {
  return `evidence:${tenantForOwner(owner)}:${slug}`;
}

function normalizedLocation(location: EvidenceLocation): EvidenceLocation {
  switch (location.kind) {
    case "text-range": {
      const start = Math.max(0, Math.floor(location.start));
      const end = Math.max(start, Math.floor(location.end));
      return {
        kind: location.kind,
        start,
        end,
        ...(location.heading?.trim()
          ? { heading: location.heading.trim().slice(0, 240) }
          : {}),
      };
    }
    case "document-section":
      if (!location.heading.trim()) throw new Error("Evidence section heading is required");
      return { kind: location.kind, heading: location.heading.trim().slice(0, 240) };
    case "pdf-page": {
      const page = Math.max(1, Math.floor(location.page));
      const start = location.start === undefined ? undefined : Math.max(0, Math.floor(location.start));
      const end = location.end === undefined
        ? undefined
        : Math.max(start ?? 0, Math.floor(location.end));
      return {
        kind: location.kind,
        page,
        ...(start !== undefined ? { start } : {}),
        ...(end !== undefined ? { end } : {}),
      };
    }
    case "slide":
      return {
        kind: location.kind,
        slide: Math.max(1, Math.floor(location.slide)),
        ...(location.section ? { section: location.section } : {}),
      };
    case "spreadsheet":
      if (!location.sheet.trim()) throw new Error("Evidence sheet name is required");
      return {
        kind: location.kind,
        sheet: location.sheet.trim().slice(0, 240),
        ...(location.range?.trim() ? { range: location.range.trim().slice(0, 80) } : {}),
      };
    case "email":
      return {
        kind: location.kind,
        section: location.section,
        ...(location.attachmentName?.trim()
          ? { attachmentName: location.attachmentName.trim().slice(0, 240) }
          : {}),
      };
    case "url-fragment":
      return {
        kind: location.kind,
        ...(location.fragment?.trim()
          ? { fragment: location.fragment.trim().slice(0, 500) }
          : {}),
      };
  }
}

function cleanSource(source: EvidenceSource): EvidenceSource {
  if (!source.url.trim()) throw new Error("Evidence source URL is required");
  return {
    type: source.type,
    url: source.url.trim().slice(0, 2_000),
    ...(source.rawId?.trim() ? { rawId: source.rawId.trim().slice(0, 200) } : {}),
    ...(source.filename?.trim()
      ? { filename: source.filename.trim().slice(0, 240) }
      : {}),
    ...(source.sha256?.trim() ? { sha256: source.sha256.trim().slice(0, 128) } : {}),
  };
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${contentHash(value)}`;
}

export function buildEvidenceAnchor(input: EvidenceAnchorInput): EvidenceAnchor {
  const excerpt = input.excerpt.trim().slice(0, MAX_EXCERPT_CHARS);
  if (!excerpt) throw new Error("Evidence excerpt is required");
  const source = cleanSource(input.source);
  const location = normalizedLocation(input.location);
  const excerptHash = contentHash(excerpt);
  const identity = JSON.stringify({ source, location, excerptHash });
  return {
    id: stableId("ev", identity),
    source,
    location,
    excerpt,
    excerptHash,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
  };
}

export function buildClaimEvidence(input: ClaimEvidenceInput): ClaimEvidence {
  const claim = input.claim.trim().slice(0, MAX_CLAIM_CHARS);
  if (!claim) throw new Error("Claim text is required");
  const evidenceIds = Array.from(
    new Set(input.evidenceIds.map((id) => id.trim()).filter(Boolean)),
  );
  const pageRange = input.pageRange
    ? {
        start: Math.max(0, Math.floor(input.pageRange.start)),
        end: Math.max(
          Math.max(0, Math.floor(input.pageRange.start)),
          Math.floor(input.pageRange.end),
        ),
      }
    : undefined;
  return {
    id: stableId("claim", JSON.stringify({ claim, pageRange })),
    claim,
    relation: input.relation,
    evidenceIds,
    ...(pageRange ? { pageRange } : {}),
  };
}

async function readBundle(owner: string, slug: string): Promise<PageEvidenceBundle | null> {
  try {
    const parsed = JSON.parse(await getStorage().readFile(evidencePath(owner, slug))) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const bundle = parsed as PageEvidenceBundle;
    return bundle.version === PAGE_EVIDENCE_VERSION &&
      bundle.pageSlug === slug &&
      tenantForOwner(bundle.owner) === tenantForOwner(owner)
      ? bundle
      : null;
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

export async function getPageEvidence(
  owner: string,
  slug: string,
): Promise<PageEvidenceBundle | null> {
  return readBundle(owner, slug);
}

export async function savePageEvidence(
  owner: string,
  input: {
    pageSlug: string;
    pageContentHash: string;
    claims: readonly ClaimEvidence[];
    evidence: readonly EvidenceAnchor[];
  },
): Promise<PageEvidenceBundle> {
  validateSlug(input.pageSlug);
  if (!input.pageContentHash.trim()) throw new Error("Page content hash is required");
  if (input.claims.length > MAX_CLAIMS_PER_PAGE) {
    throw new Error(`A page may store at most ${MAX_CLAIMS_PER_PAGE} claims`);
  }
  if (input.evidence.length > MAX_EVIDENCE_PER_PAGE) {
    throw new Error(`A page may store at most ${MAX_EVIDENCE_PER_PAGE} evidence anchors`);
  }

  const evidence = Array.from(
    new Map(input.evidence.map((anchor) => [anchor.id, anchor])).values(),
  );
  const validEvidenceIds = new Set(evidence.map((anchor) => anchor.id));
  const claims = Array.from(
    new Map(input.claims.map((claim) => [claim.id, claim])).values(),
  );
  for (const claim of claims) {
    const missing = claim.evidenceIds.find((id) => !validEvidenceIds.has(id));
    if (missing) throw new Error(`Claim "${claim.id}" references missing evidence "${missing}"`);
  }

  return withFileLock(evidenceLock(owner, input.pageSlug), async () => {
    const existing = await readBundle(owner, input.pageSlug);
    const now = new Date().toISOString();
    const bundle: PageEvidenceBundle = {
      version: PAGE_EVIDENCE_VERSION,
      owner,
      pageSlug: input.pageSlug,
      pageContentHash: input.pageContentHash.trim(),
      claims,
      evidence,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await getStorage().writeFile(
      evidencePath(owner, input.pageSlug),
      JSON.stringify(bundle, null, 2),
    );
    return bundle;
  });
}

export async function deletePageEvidence(owner: string, slug: string): Promise<boolean> {
  return withFileLock(evidenceLock(owner, slug), async () => {
    if (!(await getStorage().fileExists(evidencePath(owner, slug)))) return false;
    await getStorage().deleteFile(evidencePath(owner, slug));
    return true;
  });
}
