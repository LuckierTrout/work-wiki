import { generateText } from "ai";
import { contentHash } from "./embeddings";
import { isEnoent } from "./errors";
import { fetchUrlContent, validateUrlSafety } from "./fetch";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter";
import { getConfiguredModel } from "./llm";
import { withFileLock } from "./lock";
import { createMemoryChangeProposal } from "./memory-proposals";
import { getStorage } from "./storage";
import {
  buildClaimEvidence,
  buildEvidenceAnchor,
  getPageEvidence,
  savePageEvidence,
} from "./evidence";
import {
  tenantForOwner,
  tenantWikiRelPath,
  validateSlug,
  validateTenant,
} from "./wiki";
import { recordOperationSafe } from "./operation-ledger";

export type SourceMonitorCadence = "manual" | "daily" | "weekly";
export type SourceMonitorState = "active" | "paused" | "error";

export interface SourceMonitor {
  id: string;
  owner: string;
  name: string;
  url: string;
  targetSlug: string;
  cadence: SourceMonitorCadence;
  state: SourceMonitorState;
  meaningfulChangeThreshold: number;
  createdAt: string;
  updatedAt: string;
  nextCheckAt: string | null;
  lastCheckedAt?: string;
  lastChangedAt?: string;
  lastContentHash?: string;
  lastSnapshot?: string;
  etag?: string;
  lastModified?: string;
  failureCount: number;
  lastError?: string;
  lastProposalId?: string;
}

export interface SourceMonitorSummary {
  id: string;
  owner: string;
  nextCheckAt: string | null;
  state: SourceMonitorState;
}

export interface CreateSourceMonitorInput {
  name: string;
  url: string;
  targetSlug: string;
  cadence?: SourceMonitorCadence;
  meaningfulChangeThreshold?: number;
}

export type SourceMonitorRunResult =
  | { outcome: "not-modified" | "initialized" | "minor-change"; monitor: SourceMonitor }
  | { outcome: "proposal-created"; monitor: SourceMonitor; proposalId: string }
  | { outcome: "failed"; monitor: SourceMonitor; error: string };

interface FetchedMonitorSource {
  title: string;
  content: string;
  notModified?: boolean;
  etag?: string;
  lastModified?: string;
}

interface RunDependencies {
  fetchSource?: (monitor: SourceMonitor) => Promise<FetchedMonitorSource>;
  draftUpdate?: (input: {
    monitor: SourceMonitor;
    currentContent: string;
    sourceTitle: string;
    sourceContent: string;
  }) => Promise<string>;
  now?: Date;
}

const INDEX_KEY = "source-monitors:all";
const MAX_MONITORS_PER_OWNER = 100;
const MAX_SNAPSHOT_CHARS = 200_000;
const DEFAULT_THRESHOLD = 0.08;

function ownerTenant(owner: string): string {
  const value = tenantForOwner(owner);
  validateTenant(value);
  return value;
}

function monitorPath(owner: string, id: string): string {
  if (!/^mon_[a-z0-9-]{8,80}$/i.test(id)) throw new Error("Invalid monitor id");
  return `tenants/${ownerTenant(owner)}/source-monitors/${id}.json`;
}

function ownerIndexKey(owner: string): string {
  return `source-monitors:${ownerTenant(owner)}`;
}

function ownerLock(owner: string): string {
  return `source-monitors:${ownerTenant(owner)}`;
}

function nextCheck(cadence: SourceMonitorCadence, from: Date): string | null {
  if (cadence === "manual") return null;
  const interval = cadence === "weekly" ? 7 * 86_400_000 : 86_400_000;
  return new Date(from.getTime() + interval).toISOString();
}

function cleanThreshold(value: number | undefined): number {
  if (value === undefined) return DEFAULT_THRESHOLD;
  if (!Number.isFinite(value) || value < 0.01 || value > 1) {
    throw new Error("Meaningful change threshold must be between 0.01 and 1");
  }
  return value;
}

function normalizeSnapshot(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SNAPSHOT_CHARS);
}

export function sourceChangeScore(before: string, after: string): number {
  const words = (value: string) => new Set(
    normalizeSnapshot(value)
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2),
  );
  const oldWords = words(before);
  const newWords = words(after);
  if (oldWords.size === 0 && newWords.size === 0) return 0;
  const union = new Set([...oldWords, ...newWords]);
  let intersection = 0;
  for (const word of oldWords) if (newWords.has(word)) intersection += 1;
  return 1 - intersection / union.size;
}

function changedExcerpt(before: string, after: string): string {
  const oldNormalized = normalizeSnapshot(before).toLowerCase();
  const paragraphs = after.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const changed = paragraphs.find((part) => {
    const normalized = normalizeSnapshot(part).toLowerCase();
    return normalized.length >= 40 && !oldNormalized.includes(normalized);
  });
  return (changed ?? after).trim().slice(0, 4_000);
}

async function readOwnerIndex(owner: string): Promise<string[]> {
  const value = await getStorage().getIndex<string[]>(ownerIndexKey(owner));
  return Array.isArray(value) ? value : [];
}

async function readGlobalIndex(): Promise<SourceMonitorSummary[]> {
  const value = await getStorage().getIndex<SourceMonitorSummary[]>(INDEX_KEY);
  return Array.isArray(value) ? value : [];
}

async function persistMonitor(monitor: SourceMonitor): Promise<void> {
  await getStorage().writeFile(
    monitorPath(monitor.owner, monitor.id),
    JSON.stringify(monitor, null, 2),
  );
  await withFileLock(INDEX_KEY, async () => {
    const summaries = await readGlobalIndex();
    const summary: SourceMonitorSummary = {
      id: monitor.id,
      owner: monitor.owner,
      nextCheckAt: monitor.nextCheckAt,
      state: monitor.state,
    };
    const position = summaries.findIndex(
      (item) => item.id === monitor.id && ownerTenant(item.owner) === ownerTenant(monitor.owner),
    );
    if (position === -1) summaries.push(summary);
    else summaries[position] = summary;
    await getStorage().putIndex(INDEX_KEY, summaries);
  });
}

export async function getSourceMonitor(owner: string, id: string): Promise<SourceMonitor | null> {
  try {
    const parsed = JSON.parse(await getStorage().readFile(monitorPath(owner, id))) as SourceMonitor;
    return parsed.id === id && ownerTenant(parsed.owner) === ownerTenant(owner) ? parsed : null;
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

export async function listSourceMonitors(owner: string): Promise<SourceMonitor[]> {
  const ids = await readOwnerIndex(owner);
  const monitors = await Promise.all(ids.map((id) => getSourceMonitor(owner, id)));
  return monitors
    .filter((monitor): monitor is SourceMonitor => monitor !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createSourceMonitor(
  owner: string,
  input: CreateSourceMonitorInput,
  now: Date = new Date(),
): Promise<SourceMonitor> {
  validateUrlSafety(input.url);
  validateSlug(input.targetSlug);
  const name = input.name.trim().slice(0, 200);
  if (!name) throw new Error("Monitor name is required");
  const cadence = input.cadence ?? "daily";
  if (cadence !== "manual" && cadence !== "daily" && cadence !== "weekly") {
    throw new Error("Invalid monitor cadence");
  }

  return withFileLock(ownerLock(owner), async () => {
    const ids = await readOwnerIndex(owner);
    if (ids.length >= MAX_MONITORS_PER_OWNER) {
      throw new Error(`An owner may configure at most ${MAX_MONITORS_PER_OWNER} monitors`);
    }
    const existing = await listSourceMonitors(owner);
    const duplicate = existing.find(
      (monitor) => monitor.url === input.url.trim() && monitor.targetSlug === input.targetSlug,
    );
    if (duplicate) return duplicate;
    const timestamp = now.toISOString();
    const monitor: SourceMonitor = {
      id: `mon_${crypto.randomUUID()}`,
      owner,
      name,
      url: input.url.trim().slice(0, 2_000),
      targetSlug: input.targetSlug,
      cadence,
      state: "active",
      meaningfulChangeThreshold: cleanThreshold(input.meaningfulChangeThreshold),
      createdAt: timestamp,
      updatedAt: timestamp,
      nextCheckAt: cadence === "manual" ? null : timestamp,
      failureCount: 0,
    };
    await persistMonitor(monitor);
    await getStorage().putIndex(ownerIndexKey(owner), [...ids, monitor.id]);
    return monitor;
  });
}

export async function updateSourceMonitor(
  owner: string,
  id: string,
  patch: Partial<Pick<SourceMonitor, "name" | "cadence" | "state" | "meaningfulChangeThreshold">>,
  now: Date = new Date(),
): Promise<SourceMonitor | null> {
  return withFileLock(ownerLock(owner), async () => {
    const monitor = await getSourceMonitor(owner, id);
    if (!monitor) return null;
    if (patch.name !== undefined) {
      const name = patch.name.trim().slice(0, 200);
      if (!name) throw new Error("Monitor name is required");
      monitor.name = name;
    }
    if (patch.cadence !== undefined) {
      if (!(["manual", "daily", "weekly"] as const).includes(patch.cadence)) {
        throw new Error("Invalid monitor cadence");
      }
      monitor.cadence = patch.cadence;
    }
    if (patch.state !== undefined) {
      if (patch.state !== "active" && patch.state !== "paused") {
        throw new Error("Monitor state must be active or paused");
      }
      monitor.state = patch.state;
    }
    if (patch.meaningfulChangeThreshold !== undefined) {
      monitor.meaningfulChangeThreshold = cleanThreshold(patch.meaningfulChangeThreshold);
    }
    monitor.updatedAt = now.toISOString();
    monitor.nextCheckAt = monitor.state === "active"
      ? nextCheck(monitor.cadence, now)
      : null;
    await persistMonitor(monitor);
    return monitor;
  });
}

export async function deleteSourceMonitor(owner: string, id: string): Promise<boolean> {
  return withFileLock(ownerLock(owner), async () => {
    const monitor = await getSourceMonitor(owner, id);
    if (!monitor) return false;
    await getStorage().deleteFile(monitorPath(owner, id));
    await getStorage().putIndex(
      ownerIndexKey(owner),
      (await readOwnerIndex(owner)).filter((value) => value !== id),
    );
    await withFileLock(INDEX_KEY, async () => {
      await getStorage().putIndex(
        INDEX_KEY,
        (await readGlobalIndex()).filter(
          (item) => !(item.id === id && ownerTenant(item.owner) === ownerTenant(owner)),
        ),
      );
    });
    return true;
  });
}

export async function listDueSourceMonitors(
  now: Date = new Date(),
  limit = 25,
): Promise<SourceMonitorSummary[]> {
  const timestamp = now.toISOString();
  return (await readGlobalIndex())
    .filter(
      (monitor) =>
        monitor.state === "active" &&
        monitor.nextCheckAt !== null &&
        monitor.nextCheckAt <= timestamp,
    )
    .sort((a, b) => (a.nextCheckAt ?? "").localeCompare(b.nextCheckAt ?? ""))
    .slice(0, Math.max(0, Math.min(limit, 100)));
}

async function defaultFetchSource(monitor: SourceMonitor): Promise<FetchedMonitorSource> {
  validateUrlSafety(monitor.url);
  let metadata: Pick<FetchedMonitorSource, "etag" | "lastModified"> = {};
  if (monitor.etag || monitor.lastModified) {
    const headers = new Headers({ "User-Agent": "yopedia-monitor/1.0" });
    if (monitor.etag) headers.set("If-None-Match", monitor.etag);
    if (monitor.lastModified) headers.set("If-Modified-Since", monitor.lastModified);
    const response = await fetch(monitor.url, {
      method: "HEAD",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 304) {
      return { title: monitor.name, content: "", notModified: true };
    }
    if (response.ok) {
      metadata = {
        ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}),
        ...(response.headers.get("last-modified")
          ? { lastModified: response.headers.get("last-modified")! }
          : {}),
      };
    }
  }
  const fetched = await fetchUrlContent(monitor.url);
  return { ...fetched, ...metadata };
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}

async function defaultDraftUpdate(input: {
  monitor: SourceMonitor;
  currentContent: string;
  sourceTitle: string;
  sourceContent: string;
}): Promise<string> {
  const parsed = parseFrontmatter(input.currentContent);
  const model = await getConfiguredModel();
  const { text } = await generateText({
    model,
    maxOutputTokens: 6_000,
    system:
      "You revise a private knowledge page from a newly changed source. Return only the complete revised Markdown body, without YAML frontmatter or code fences. Preserve still-valid material, update only claims supported by the supplied source, identify unresolved conflicts plainly, and never invent facts.",
    prompt:
      `Source URL: ${input.monitor.url}\nSource title: ${input.sourceTitle}\n\n` +
      `CURRENT PAGE BODY:\n${parsed.body.slice(0, 40_000)}\n\n` +
      `LATEST SOURCE CONTENT:\n${input.sourceContent.slice(0, 60_000)}`,
  });
  const body = stripCodeFence(text);
  if (!body) throw new Error("The model returned an empty monitored update");
  return serializeFrontmatter(
    { ...parsed.data, updated: new Date().toISOString().slice(0, 10) },
    body,
  );
}

async function readOwnerPage(owner: string, slug: string): Promise<string> {
  return getStorage().readFile(tenantWikiRelPath(ownerTenant(owner), `${slug}.md`));
}

export async function runSourceMonitor(
  owner: string,
  id: string,
  dependencies: RunDependencies = {},
): Promise<SourceMonitorRunResult> {
  return withFileLock(`source-monitor-run:${ownerTenant(owner)}:${id}`, async () => {
    const monitor = await getSourceMonitor(owner, id);
    if (!monitor) throw new Error("Source monitor not found");
    if (monitor.state === "paused") throw new Error("Source monitor is paused");
    const now = dependencies.now ?? new Date();
    const fetchSource = dependencies.fetchSource ?? defaultFetchSource;
    const draftUpdate = dependencies.draftUpdate ?? defaultDraftUpdate;

    try {
      const fetched = await fetchSource(monitor);
      monitor.lastCheckedAt = now.toISOString();
      monitor.updatedAt = now.toISOString();
      monitor.nextCheckAt = nextCheck(monitor.cadence, now);
      monitor.failureCount = 0;
      monitor.state = "active";
      delete monitor.lastError;
      if (fetched.etag) monitor.etag = fetched.etag;
      if (fetched.lastModified) monitor.lastModified = fetched.lastModified;

      if (fetched.notModified) {
        await persistMonitor(monitor);
        await recordOperationSafe(owner, { kind: "monitor", operation: "check", status: "succeeded", subjectId: id, detail: "not modified" });
        return { outcome: "not-modified", monitor };
      }

      const snapshot = normalizeSnapshot(fetched.content);
      if (!snapshot) throw new Error("The monitored source contained no readable text");
      const hash = contentHash(snapshot);
      if (!monitor.lastContentHash) {
        monitor.lastContentHash = hash;
        monitor.lastSnapshot = snapshot;
        await persistMonitor(monitor);
        await recordOperationSafe(owner, { kind: "monitor", operation: "check", status: "succeeded", subjectId: id, detail: "baseline initialized" });
        return { outcome: "initialized", monitor };
      }
      if (hash === monitor.lastContentHash) {
        await persistMonitor(monitor);
        await recordOperationSafe(owner, { kind: "monitor", operation: "check", status: "succeeded", subjectId: id, detail: "content hash unchanged" });
        return { outcome: "not-modified", monitor };
      }

      const previous = monitor.lastSnapshot ?? "";
      const score = sourceChangeScore(previous, snapshot);
      monitor.lastContentHash = hash;
      monitor.lastSnapshot = snapshot;
      monitor.lastChangedAt = now.toISOString();
      if (score < monitor.meaningfulChangeThreshold) {
        await persistMonitor(monitor);
        await recordOperationSafe(owner, { kind: "monitor", operation: "check", status: "succeeded", subjectId: id, detail: `minor change ${score.toFixed(3)}` });
        return { outcome: "minor-change", monitor };
      }

      const currentContent = await readOwnerPage(owner, monitor.targetSlug);
      const proposedContent = await draftUpdate({
        monitor,
        currentContent,
        sourceTitle: fetched.title,
        sourceContent: fetched.content,
      });
      const excerpt = changedExcerpt(previous, fetched.content);
      const anchor = buildEvidenceAnchor({
        source: { type: "url", url: monitor.url },
        location: { kind: "url-fragment" },
        excerpt,
        capturedAt: now.toISOString(),
      });
      const claim = buildClaimEvidence({
        claim: `The monitored source “${monitor.name}” changed materially.`,
        relation: "context",
        evidenceIds: [anchor.id],
      });
      const currentHash = contentHash(currentContent);
      const existingEvidence = await getPageEvidence(owner, monitor.targetSlug);
      const canMergeEvidence = existingEvidence?.pageContentHash === currentHash;
      await savePageEvidence(owner, {
        pageSlug: monitor.targetSlug,
        pageContentHash: currentHash,
        claims: [...(canMergeEvidence ? existingEvidence.claims : []), claim],
        evidence: [...(canMergeEvidence ? existingEvidence.evidence : []), anchor],
      });
      const proposal = await createMemoryChangeProposal(owner, {
        targetSlug: monitor.targetSlug,
        title: `Update ${monitor.name}`,
        summary: `A monitored source changed (${Math.round(score * 100)}% semantic token difference).`,
        reason: `Yopedia detected a meaningful change at ${monitor.url}. Review the proposed revision against the stored excerpt before accepting it.`,
        proposedContent,
        evidenceIds: [anchor.id],
        actor: `${owner}--source-monitor`,
        risk: "medium",
      });
      monitor.lastProposalId = proposal.id;
      await persistMonitor(monitor);
      await recordOperationSafe(owner, { kind: "monitor", operation: "propose-update", status: "succeeded", subjectId: id, detail: `proposal ${proposal.id}; change ${score.toFixed(3)}` });
      return { outcome: "proposal-created", monitor, proposalId: proposal.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      monitor.state = "error";
      monitor.failureCount += 1;
      monitor.lastError = message.slice(0, 1_000);
      monitor.lastCheckedAt = now.toISOString();
      monitor.updatedAt = now.toISOString();
      const retryHours = Math.min(24, 2 ** Math.min(monitor.failureCount, 5));
      monitor.nextCheckAt = new Date(now.getTime() + retryHours * 3_600_000).toISOString();
      await persistMonitor(monitor);
      await recordOperationSafe(owner, { kind: "monitor", operation: "check", status: "failed", subjectId: id, detail: message });
      return { outcome: "failed", monitor, error: message };
    }
  });
}
