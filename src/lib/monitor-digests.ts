import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { SendEmail } from "@cloudflare/workers-types";
import { contentHash } from "./embeddings";
import { isEmailAddress, normalizeEmailAddress } from "./email-ingest";
import { isEnoent } from "./errors";
import { withFileLock } from "./lock";
import {
  applyNamesTermsToGeneratedText,
  listNamesTerms,
} from "./names-terms";
import { listOperations, type OperationRecord } from "./operation-ledger";
import {
  getSourceMonitor,
  listSourceMonitorOwners,
  type SourceMonitor,
} from "./source-monitors";
import { getStorage } from "./storage";
import { tenantForOwner, validateTenant } from "./wiki";

export type MonitorDigestCadence = "daily" | "weekly";
export type MonitorDigestDeliveryStatus =
  | "disabled"
  | "pending"
  | "queued"
  | "sending"
  | "sent"
  | "failed";

export interface MonitorDigestSettings {
  owner: string;
  enabled: boolean;
  cadence: MonitorDigestCadence;
  emailEnabled: boolean;
  emailAddress: string;
  nextDigestAt: string | null;
  lastWindowEndAt: string | null;
  lastDigestAt: string | null;
  updatedAt: string | null;
}

export interface MonitorDigestEntry {
  kind: "proposal" | "failure" | "recovery";
  monitorId: string;
  monitorName: string;
  sourceUrl?: string;
  targetSlug?: string;
  detail: string;
  occurredAt: string;
  proposalId?: string;
}

export interface MonitorDigest {
  id: string;
  owner: string;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
  readAt: string | null;
  counts: {
    checks: number;
    unchanged: number;
    initialized: number;
    minorChanges: number;
    proposals: number;
    failures: number;
    recoveries: number;
  };
  entries: MonitorDigestEntry[];
  email: {
    status: MonitorDigestDeliveryStatus;
    to?: string;
    attempts: number;
    queuedAt?: string;
    lastAttemptAt?: string;
    nextAttemptAt?: string;
    sentAt?: string;
    messageId?: string;
    error?: string;
  };
}

export interface PendingMonitorDigestDelivery {
  id: string;
  owner: string;
  status: Extract<MonitorDigestDeliveryStatus, "pending" | "queued" | "sending" | "failed">;
  nextAttemptAt: string;
}

interface MonitorDigestScheduleSummary {
  owner: string;
  enabled: boolean;
  nextDigestAt: string | null;
}

interface EmailMessageInput {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

interface DeliveryDependencies {
  now?: Date;
  from?: string;
  siteUrl?: string;
  send?: (message: EmailMessageInput) => Promise<{ messageId: string }>;
}

const SETTINGS_INDEX_PREFIX = "monitor-digest-settings:";
const SETTINGS_SCHEDULE_INDEX = "monitor-digest-settings:all";
const DIGEST_INDEX_PREFIX = "monitor-digests:";
const PENDING_DELIVERIES_INDEX = "monitor-digests:pending";
const MAX_DIGESTS_PER_OWNER = 90;
const MAX_DIGEST_ENTRIES = 100;
const MAX_LEDGER_RECORDS = 500;

function ownerTenant(owner: string): string {
  const tenant = tenantForOwner(owner);
  validateTenant(tenant);
  return tenant;
}

function settingsIndexKey(owner: string): string {
  return `${SETTINGS_INDEX_PREFIX}${ownerTenant(owner)}`;
}

function digestIndexKey(owner: string): string {
  return `${DIGEST_INDEX_PREFIX}${ownerTenant(owner)}`;
}

function digestPath(owner: string, id: string): string {
  if (!/^mdg_[a-f0-9]{16}$/.test(id)) throw new Error("Invalid monitor digest id");
  return `tenants/${ownerTenant(owner)}/monitor-digests/${id}.json`;
}

function cadenceMs(cadence: MonitorDigestCadence): number {
  return cadence === "weekly" ? 7 * 86_400_000 : 86_400_000;
}

function nextDigestAt(cadence: MonitorDigestCadence, from: Date): string {
  return new Date(from.getTime() + cadenceMs(cadence)).toISOString();
}

function defaultSettings(owner: string, now: Date): MonitorDigestSettings {
  return {
    owner,
    enabled: true,
    cadence: "daily",
    emailEnabled: false,
    emailAddress: "",
    nextDigestAt: now.toISOString(),
    lastWindowEndAt: null,
    lastDigestAt: null,
    updatedAt: null,
  };
}

function validDate(value: unknown): string | null {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

export async function loadMonitorDigestSettings(
  owner: string,
  now: Date = new Date(),
): Promise<MonitorDigestSettings> {
  const stored = await getStorage().getIndex<Partial<MonitorDigestSettings>>(
    settingsIndexKey(owner),
  );
  if (!stored) return defaultSettings(owner, now);
  const cadence: MonitorDigestCadence = stored.cadence === "weekly" ? "weekly" : "daily";
  const enabled = stored.enabled !== false;
  const emailAddress = typeof stored.emailAddress === "string"
    ? normalizeEmailAddress(stored.emailAddress)
    : "";
  return {
    owner,
    enabled,
    cadence,
    emailEnabled: stored.emailEnabled === true && isEmailAddress(emailAddress),
    emailAddress,
    nextDigestAt: enabled
      ? validDate(stored.nextDigestAt) ?? now.toISOString()
      : null,
    lastWindowEndAt: validDate(stored.lastWindowEndAt),
    lastDigestAt: validDate(stored.lastDigestAt),
    updatedAt: validDate(stored.updatedAt),
  };
}

async function updateScheduleSummary(settings: MonitorDigestSettings): Promise<void> {
  await withFileLock(SETTINGS_SCHEDULE_INDEX, async () => {
    const stored = await getStorage().getIndex<MonitorDigestScheduleSummary[]>(
      SETTINGS_SCHEDULE_INDEX,
    );
    const summaries = Array.isArray(stored) ? stored : [];
    const tenant = ownerTenant(settings.owner);
    const next: MonitorDigestScheduleSummary = {
      owner: settings.owner,
      enabled: settings.enabled,
      nextDigestAt: settings.nextDigestAt,
    };
    const position = summaries.findIndex((item) => ownerTenant(item.owner) === tenant);
    if (position === -1) summaries.push(next);
    else summaries[position] = next;
    await getStorage().putIndex(SETTINGS_SCHEDULE_INDEX, summaries);
  });
}

async function persistSettings(settings: MonitorDigestSettings): Promise<void> {
  await getStorage().putIndex(settingsIndexKey(settings.owner), settings);
  await updateScheduleSummary(settings);
}

export async function saveMonitorDigestSettings(
  owner: string,
  input: {
    enabled: boolean;
    cadence: MonitorDigestCadence;
    emailEnabled: boolean;
    emailAddress?: string;
  },
  now: Date = new Date(),
): Promise<MonitorDigestSettings> {
  if (input.cadence !== "daily" && input.cadence !== "weekly") {
    throw new Error("Digest cadence must be daily or weekly");
  }
  const emailAddress = normalizeEmailAddress(input.emailAddress ?? "");
  if (input.emailEnabled && !isEmailAddress(emailAddress)) {
    throw new Error("Enter a valid digest email address before enabling email delivery");
  }
  return withFileLock(`monitor-digest-settings:${ownerTenant(owner)}`, async () => {
    const current = await loadMonitorDigestSettings(owner, now);
    const wasInactive = !current.enabled;
    const cadenceChanged = current.cadence !== input.cadence;
    const settings: MonitorDigestSettings = {
      ...current,
      owner,
      enabled: input.enabled,
      cadence: input.cadence,
      emailEnabled: input.enabled && input.emailEnabled,
      emailAddress,
      nextDigestAt: input.enabled
        ? wasInactive || cadenceChanged
          ? now.toISOString()
          : current.nextDigestAt ?? now.toISOString()
        : null,
      updatedAt: now.toISOString(),
    };
    await persistSettings(settings);
    return settings;
  });
}

async function readDigestIndex(owner: string): Promise<string[]> {
  const stored = await getStorage().getIndex<string[]>(digestIndexKey(owner));
  return Array.isArray(stored) ? stored : [];
}

export async function getMonitorDigest(owner: string, id: string): Promise<MonitorDigest | null> {
  try {
    const parsed = JSON.parse(await getStorage().readFile(digestPath(owner, id))) as MonitorDigest;
    return parsed.id === id && ownerTenant(parsed.owner) === ownerTenant(owner) ? parsed : null;
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

export async function listMonitorDigests(
  owner: string,
  limit = 20,
): Promise<MonitorDigest[]> {
  const ids = (await readDigestIndex(owner)).slice(-Math.max(1, Math.min(limit, 90)));
  const digests = await Promise.all(ids.map((id) => getMonitorDigest(owner, id)));
  return digests
    .filter((digest): digest is MonitorDigest => digest !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function updatePendingDelivery(digest: MonitorDigest): Promise<void> {
  await withFileLock(PENDING_DELIVERIES_INDEX, async () => {
    const stored = await getStorage().getIndex<PendingMonitorDigestDelivery[]>(
      PENDING_DELIVERIES_INDEX,
    );
    const deliveries = Array.isArray(stored) ? stored : [];
    const tenant = ownerTenant(digest.owner);
    const matches = (item: PendingMonitorDigestDelivery) =>
      item.id === digest.id && ownerTenant(item.owner) === tenant;
    const retained = deliveries.filter((item) => !matches(item));
    if (
      digest.email.status === "pending" ||
      digest.email.status === "queued" ||
      digest.email.status === "sending" ||
      digest.email.status === "failed"
    ) {
      retained.push({
        id: digest.id,
        owner: digest.owner,
        status: digest.email.status,
        nextAttemptAt: digest.email.nextAttemptAt ?? digest.createdAt,
      });
    }
    await getStorage().putIndex(PENDING_DELIVERIES_INDEX, retained);
  });
}

async function persistDigest(digest: MonitorDigest): Promise<void> {
  await getStorage().writeFile(digestPath(digest.owner, digest.id), JSON.stringify(digest, null, 2));
  const ids = await readDigestIndex(digest.owner);
  const nextIds = ids.includes(digest.id) ? ids : [...ids, digest.id];
  await getStorage().putIndex(
    digestIndexKey(digest.owner),
    nextIds.slice(-MAX_DIGESTS_PER_OWNER),
  );
  await updatePendingDelivery(digest);
}

function monitorDetail(monitor: SourceMonitor | null, id: string) {
  return {
    monitorId: id,
    monitorName: monitor?.name ?? "Removed source monitor",
    ...(monitor?.url ? { sourceUrl: monitor.url } : {}),
    ...(monitor?.targetSlug ? { targetSlug: monitor.targetSlug } : {}),
  };
}

function proposalIdFor(operation: OperationRecord): string | undefined {
  const match = /(?:^|;)\s*proposal\s+([^;\s]+)/i.exec(operation.detail ?? "");
  return match?.[1];
}

async function digestEntries(
  owner: string,
  operations: OperationRecord[],
): Promise<{ entries: MonitorDigestEntry[]; recoveries: number }> {
  const monitorIds = Array.from(new Set(
    operations.map((operation) => operation.subjectId).filter((id): id is string => Boolean(id)),
  ));
  const monitors = new Map<string, SourceMonitor | null>();
  await Promise.all(monitorIds.map(async (id) => {
    monitors.set(id, await getSourceMonitor(owner, id));
  }));

  const entries: MonitorDigestEntry[] = [];
  for (const operation of operations) {
    const id = operation.subjectId;
    if (!id) continue;
    const common = monitorDetail(monitors.get(id) ?? null, id);
    if (operation.operation === "propose-update" && operation.status === "succeeded") {
      entries.push({
        kind: "proposal",
        ...common,
        detail: operation.detail ?? "A meaningful source change created a review proposal.",
        occurredAt: operation.createdAt,
        ...(proposalIdFor(operation) ? { proposalId: proposalIdFor(operation) } : {}),
      });
    }
  }

  const chronological = [...operations].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const latestFailure = new Map<string, OperationRecord>();
  const latestRecovery = new Map<string, OperationRecord>();
  for (const operation of chronological) {
    if (!operation.subjectId || operation.operation !== "check") continue;
    if (operation.status === "failed") {
      latestFailure.set(operation.subjectId, operation);
      latestRecovery.delete(operation.subjectId);
    } else if (latestFailure.has(operation.subjectId)) {
      latestRecovery.set(operation.subjectId, operation);
    }
  }
  for (const [id, failure] of latestFailure) {
    const common = monitorDetail(monitors.get(id) ?? null, id);
    entries.push({
      kind: "failure",
      ...common,
      detail: failure.detail ?? "The source check failed.",
      occurredAt: failure.createdAt,
    });
    const recovery = latestRecovery.get(id);
    if (recovery && recovery.createdAt > failure.createdAt) {
      entries.push({
        kind: "recovery",
        ...common,
        detail: "The source responded successfully after an earlier failure.",
        occurredAt: recovery.createdAt,
      });
    }
  }
  entries.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  return {
    entries: entries.slice(0, MAX_DIGEST_ENTRIES),
    recoveries: latestRecovery.size,
  };
}

export async function createMonitorDigest(
  owner: string,
  options: { now?: Date; force?: boolean } = {},
): Promise<MonitorDigest | null> {
  const now = options.now ?? new Date();
  return withFileLock(`monitor-digest-generate:${ownerTenant(owner)}`, async () => {
    const settings = await loadMonitorDigestSettings(owner, now);
    if (!settings.enabled && !options.force) return null;
    if (!options.force && settings.nextDigestAt && settings.nextDigestAt > now.toISOString()) {
      return null;
    }
    const periodEnd = now.toISOString();
    const periodStart = settings.lastWindowEndAt ??
      new Date(now.getTime() - cadenceMs(settings.cadence)).toISOString();
    const operations = (await listOperations(owner, MAX_LEDGER_RECORDS)).filter(
      (operation) =>
        operation.kind === "monitor" &&
        operation.createdAt > periodStart &&
        operation.createdAt <= periodEnd,
    );

    settings.lastWindowEndAt = periodEnd;
    settings.nextDigestAt = settings.enabled ? nextDigestAt(settings.cadence, now) : null;
    settings.updatedAt = periodEnd;

    if (operations.length === 0) {
      await persistSettings(settings);
      return null;
    }

    const id = `mdg_${contentHash(`${ownerTenant(owner)}|${periodStart}|${periodEnd}`)}`;
    const existing = await getMonitorDigest(owner, id);
    if (existing) {
      settings.lastDigestAt = existing.createdAt;
      await persistSettings(settings);
      return existing;
    }
    const built = await digestEntries(owner, operations);
    const dictionary = await listNamesTerms(owner);
    const entries = built.entries.map((entry) => ({
      ...entry,
      monitorName: applyNamesTermsToGeneratedText(dictionary, entry.monitorName),
      detail: applyNamesTermsToGeneratedText(dictionary, entry.detail),
    }));
    const checks = operations.filter((operation) => operation.operation === "check");
    const digest: MonitorDigest = {
      id,
      owner,
      periodStart,
      periodEnd,
      createdAt: periodEnd,
      readAt: null,
      counts: {
        checks: checks.length,
        unchanged: checks.filter((operation) =>
          operation.status === "succeeded" &&
          /not modified|content hash unchanged/i.test(operation.detail ?? "")
        ).length,
        initialized: checks.filter((operation) =>
          operation.status === "succeeded" && /baseline initialized/i.test(operation.detail ?? "")
        ).length,
        minorChanges: checks.filter((operation) =>
          operation.status === "succeeded" && /minor change/i.test(operation.detail ?? "")
        ).length,
        proposals: operations.filter((operation) =>
          operation.operation === "propose-update" && operation.status === "succeeded"
        ).length,
        failures: checks.filter((operation) => operation.status === "failed").length,
        recoveries: built.recoveries,
      },
      entries,
      email: settings.emailEnabled && isEmailAddress(settings.emailAddress)
        ? {
            status: "pending",
            to: settings.emailAddress,
            attempts: 0,
            nextAttemptAt: periodEnd,
          }
        : { status: "disabled", attempts: 0 },
    };
    await persistDigest(digest);
    settings.lastDigestAt = digest.createdAt;
    await persistSettings(settings);
    return digest;
  });
}

export async function listDueMonitorDigestOwners(
  now: Date = new Date(),
  limit = 25,
): Promise<string[]> {
  const stored = await getStorage().getIndex<MonitorDigestScheduleSummary[]>(
    SETTINGS_SCHEDULE_INDEX,
  );
  const summaries = Array.isArray(stored) ? stored : [];
  const owners = new Map<string, string>();
  for (const owner of await listSourceMonitorOwners()) owners.set(ownerTenant(owner), owner);
  for (const summary of summaries) owners.set(ownerTenant(summary.owner), summary.owner);
  const due: Array<{ owner: string; nextDigestAt: string }> = [];
  for (const owner of owners.values()) {
    const settings = await loadMonitorDigestSettings(owner, now);
    if (
      settings.enabled &&
      settings.nextDigestAt !== null &&
      settings.nextDigestAt <= now.toISOString()
    ) {
      due.push({ owner, nextDigestAt: settings.nextDigestAt });
    }
  }
  return due
    .sort((a, b) => a.nextDigestAt.localeCompare(b.nextDigestAt))
    .slice(0, Math.max(0, Math.min(limit, 100)))
    .map((item) => item.owner);
}

export async function listPendingMonitorDigestDeliveries(
  now: Date = new Date(),
  limit = 50,
): Promise<PendingMonitorDigestDelivery[]> {
  const stored = await getStorage().getIndex<PendingMonitorDigestDelivery[]>(
    PENDING_DELIVERIES_INDEX,
  );
  const deliveries = Array.isArray(stored) ? stored : [];
  return deliveries
    .filter((delivery) => delivery.nextAttemptAt <= now.toISOString())
    .sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt))
    .slice(0, Math.max(0, Math.min(limit, 100)));
}

export async function markMonitorDigestQueued(
  owner: string,
  id: string,
  now: Date = new Date(),
): Promise<MonitorDigest | null> {
  return withFileLock(`monitor-digest:${ownerTenant(owner)}:${id}`, async () => {
    const digest = await getMonitorDigest(owner, id);
    if (!digest || digest.email.status === "sent" || digest.email.status === "disabled") {
      return digest;
    }
    digest.email.status = "queued";
    digest.email.queuedAt = now.toISOString();
    digest.email.nextAttemptAt = new Date(now.getTime() + 2 * 3_600_000).toISOString();
    delete digest.email.error;
    await persistDigest(digest);
    return digest;
  });
}

export async function markMonitorDigestRead(
  owner: string,
  id: string,
  now: Date = new Date(),
): Promise<MonitorDigest | null> {
  return withFileLock(`monitor-digest:${ownerTenant(owner)}:${id}`, async () => {
    const digest = await getMonitorDigest(owner, id);
    if (!digest) return null;
    if (!digest.readAt) {
      digest.readAt = now.toISOString();
      await persistDigest(digest);
    }
    return digest;
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function trimSiteUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function renderMonitorDigestEmail(
  digest: MonitorDigest,
  siteUrl = "https://workwiki.app",
): { subject: string; text: string; html: string } {
  const baseUrl = trimSiteUrl(siteUrl) || "https://workwiki.app";
  const attention = digest.counts.proposals + digest.counts.failures;
  const subject = attention > 0
    ? `WorkWiki source digest: ${attention} item${attention === 1 ? "" : "s"} need attention`
    : `WorkWiki source digest: ${digest.counts.checks} source check${digest.counts.checks === 1 ? "" : "s"}`;
  const summary = [
    `${digest.counts.checks} checks`,
    `${digest.counts.proposals} proposed updates`,
    `${digest.counts.failures} failures`,
    `${digest.counts.recoveries} recoveries`,
  ].join(" · ");
  const textEntries = digest.entries.length > 0
    ? digest.entries.map((entry) =>
        `- ${entry.monitorName}: ${entry.kind} — ${entry.detail}${entry.targetSlug ? ` (${baseUrl}/u/${encodeURIComponent(digest.owner)}/${encodeURIComponent(entry.targetSlug)})` : ""}`
      ).join("\n")
    : "No sources need attention in this digest.";
  const text = `Your WorkWiki source-monitor digest\n\n${summary}\n\n${textEntries}\n\nOpen source watch: ${baseUrl}/monitors\nOpen Review: ${baseUrl}/review`;
  const htmlEntries = digest.entries.length > 0
    ? `<ul>${digest.entries.map((entry) => {
        const pageUrl = entry.targetSlug
          ? `${baseUrl}/u/${encodeURIComponent(digest.owner)}/${encodeURIComponent(entry.targetSlug)}`
          : null;
        return `<li><strong>${escapeHtml(entry.monitorName)}</strong>: ${escapeHtml(entry.kind)} — ${escapeHtml(entry.detail)}${pageUrl ? ` <a href="${escapeHtml(pageUrl)}">Open page</a>` : ""}</li>`;
      }).join("")}</ul>`
    : "<p>No sources need attention in this digest.</p>";
  const html = `<h1>Your WorkWiki source-monitor digest</h1><p>${escapeHtml(summary)}</p>${htmlEntries}<p><a href="${escapeHtml(`${baseUrl}/monitors`)}">Open source watch</a> · <a href="${escapeHtml(`${baseUrl}/review`)}">Open Review</a></p>`;
  return { subject, text, html };
}

function defaultEmailSender(): (message: EmailMessageInput) => Promise<{ messageId: string }> {
  const { env } = getCloudflareContext();
  const email = (env as typeof env & { MONITOR_DIGEST_EMAIL?: SendEmail }).MONITOR_DIGEST_EMAIL;
  if (!email || typeof email.send !== "function") {
    throw new Error("MONITOR_DIGEST_EMAIL binding is not configured");
  }
  return (message) => email.send(message);
}

export async function deliverMonitorDigest(
  owner: string,
  id: string,
  dependencies: DeliveryDependencies = {},
): Promise<MonitorDigest> {
  return withFileLock(`monitor-digest-delivery:${ownerTenant(owner)}:${id}`, async () => {
    const now = dependencies.now ?? new Date();
    const digest = await getMonitorDigest(owner, id);
    if (!digest) throw new Error("Monitor digest not found");
    if (digest.email.status === "sent") return digest;

    const settings = await loadMonitorDigestSettings(owner, now);
    if (!settings.enabled || !settings.emailEnabled || !isEmailAddress(settings.emailAddress)) {
      digest.email.status = "disabled";
      delete digest.email.nextAttemptAt;
      delete digest.email.error;
      await persistDigest(digest);
      return digest;
    }
    if (
      digest.email.status === "sending" &&
      digest.email.nextAttemptAt &&
      digest.email.nextAttemptAt > now.toISOString()
    ) {
      return digest;
    }

    digest.email.status = "sending";
    digest.email.to = settings.emailAddress;
    digest.email.attempts += 1;
    digest.email.lastAttemptAt = now.toISOString();
    digest.email.nextAttemptAt = new Date(now.getTime() + 30 * 60_000).toISOString();
    delete digest.email.error;
    await persistDigest(digest);

    try {
      const rendered = renderMonitorDigestEmail(
        digest,
        dependencies.siteUrl ?? process.env.YOPEDIA_SITE_URL ?? "https://workwiki.app",
      );
      const send = dependencies.send ?? defaultEmailSender();
      const result = await send({
        from: dependencies.from ?? process.env.YOPEDIA_MONITOR_EMAIL_FROM ?? "ingest@workwiki.app",
        to: settings.emailAddress,
        ...rendered,
      });
      digest.email.status = "sent";
      digest.email.sentAt = now.toISOString();
      digest.email.messageId = result.messageId;
      delete digest.email.nextAttemptAt;
      delete digest.email.error;
      await persistDigest(digest);
      return digest;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryMinutes = Math.min(24 * 60, 15 * 2 ** Math.min(digest.email.attempts - 1, 6));
      digest.email.status = "failed";
      digest.email.error = message.slice(0, 1_000);
      digest.email.nextAttemptAt = new Date(now.getTime() + retryMinutes * 60_000).toISOString();
      await persistDigest(digest);
      throw error;
    }
  });
}
