import { contentHash } from "./embeddings";
import { isEnoent } from "./errors";
import { withFileLock } from "./lock";
import { getStorage } from "./storage";
import { enqueueTask } from "./tasks";
import type { ActionItem } from "./action-items";
import { validateUrlSafety } from "./url-safety";
import { tenantForOwner, validateTenant } from "./wiki";
import { recordOperationSafe } from "./operation-ledger";

export type IntegrationDestination = "webhook" | "icalendar";
export type OutboxStatus = "pending" | "delivering" | "delivered" | "failed" | "cancelled";

export interface IntegrationSettings {
  owner: string;
  webhookEnabled: boolean;
  webhookUrl?: string;
  calendarEnabled: boolean;
  updatedAt: string;
}

export interface IntegrationOutboxEvent {
  id: string;
  owner: string;
  destination: IntegrationDestination;
  sourceType: "action-item" | "agent-action";
  sourceId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: string | null;
  deliveredAt?: string;
  lastError?: string;
  receipt?: {
    status?: number;
    body?: string;
    calendar?: string;
  };
}

interface OutboxSummary {
  id: string;
  owner: string;
  status: OutboxStatus;
  nextAttemptAt: string | null;
}

const GLOBAL_INDEX = "integration-outbox:all";
const MAX_OUTBOX_EVENTS = 2_000;

function tenant(owner: string): string {
  const value = tenantForOwner(owner);
  validateTenant(value);
  return value;
}

function settingsPath(owner: string): string {
  return `tenants/${tenant(owner)}/integration-settings.json`;
}

function eventPath(owner: string, id: string): string {
  if (!/^out_[a-f0-9]{16,128}$/i.test(id)) throw new Error("Invalid outbox id");
  return `tenants/${tenant(owner)}/integration-outbox/${id}.json`;
}

function ownerIndexKey(owner: string): string {
  return `integration-outbox:${tenant(owner)}`;
}

function ownerLock(owner: string): string {
  return `integration-outbox:${tenant(owner)}`;
}

async function readOwnerIds(owner: string): Promise<string[]> {
  const value = await getStorage().getIndex<string[]>(ownerIndexKey(owner));
  return Array.isArray(value) ? value : [];
}

async function readGlobalIndex(): Promise<OutboxSummary[]> {
  const value = await getStorage().getIndex<OutboxSummary[]>(GLOBAL_INDEX);
  return Array.isArray(value) ? value : [];
}

async function persistEvent(event: IntegrationOutboxEvent): Promise<void> {
  await getStorage().writeFile(eventPath(event.owner, event.id), JSON.stringify(event, null, 2));
  await withFileLock(GLOBAL_INDEX, async () => {
    const entries = await readGlobalIndex();
    const summary: OutboxSummary = {
      id: event.id,
      owner: event.owner,
      status: event.status,
      nextAttemptAt: event.nextAttemptAt,
    };
    const position = entries.findIndex(
      (item) => item.id === event.id && tenant(item.owner) === tenant(event.owner),
    );
    if (position === -1) entries.push(summary);
    else entries[position] = summary;
    await getStorage().putIndex(GLOBAL_INDEX, entries.slice(-MAX_OUTBOX_EVENTS));
  });
}

export async function getIntegrationSettings(owner: string): Promise<IntegrationSettings> {
  try {
    const parsed = JSON.parse(await getStorage().readFile(settingsPath(owner))) as IntegrationSettings;
    if (tenant(parsed.owner) === tenant(owner)) return parsed;
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  return {
    owner,
    webhookEnabled: false,
    calendarEnabled: false,
    updatedAt: new Date(0).toISOString(),
  };
}

export async function saveIntegrationSettings(
  owner: string,
  input: { webhookEnabled?: boolean; webhookUrl?: string | null; calendarEnabled?: boolean },
): Promise<IntegrationSettings> {
  const current = await getIntegrationSettings(owner);
  if (input.webhookUrl?.trim()) validateUrlSafety(input.webhookUrl.trim());
  const settings: IntegrationSettings = {
    owner,
    webhookEnabled: input.webhookEnabled ?? current.webhookEnabled,
    calendarEnabled: input.calendarEnabled ?? current.calendarEnabled,
    ...(input.webhookUrl === null || input.webhookUrl?.trim() === ""
      ? {}
      : input.webhookUrl?.trim()
        ? { webhookUrl: input.webhookUrl.trim().slice(0, 2_000) }
        : current.webhookUrl
          ? { webhookUrl: current.webhookUrl }
          : {}),
    updatedAt: new Date().toISOString(),
  };
  if (settings.webhookEnabled && !settings.webhookUrl) {
    throw new Error("A webhook URL is required before webhook delivery can be enabled");
  }
  await getStorage().writeFile(settingsPath(owner), JSON.stringify(settings, null, 2));
  return settings;
}

export async function getOutboxEvent(owner: string, id: string): Promise<IntegrationOutboxEvent | null> {
  try {
    const parsed = JSON.parse(await getStorage().readFile(eventPath(owner, id))) as IntegrationOutboxEvent;
    return tenant(parsed.owner) === tenant(owner) && parsed.id === id ? parsed : null;
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

export async function listOutboxEvents(owner: string): Promise<IntegrationOutboxEvent[]> {
  const events = await Promise.all((await readOwnerIds(owner)).map((id) => getOutboxEvent(owner, id)));
  return events
    .filter((event): event is IntegrationOutboxEvent => event !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function createEvent(
  owner: string,
  destination: IntegrationDestination,
  sourceType: IntegrationOutboxEvent["sourceType"],
  sourceId: string,
  payload: Record<string, unknown>,
): Promise<IntegrationOutboxEvent> {
  const idempotencyKey = contentHash(`${tenant(owner)}:${sourceType}:${sourceId}:${destination}`);
  const id = `out_${idempotencyKey}`;
  const existing = await getOutboxEvent(owner, id);
  if (existing) return existing;
  const now = new Date().toISOString();
  const event: IntegrationOutboxEvent = {
    id,
    owner,
    destination,
    sourceType,
    sourceId,
    idempotencyKey,
    payload,
    status: "pending",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    nextAttemptAt: now,
  };
  await persistEvent(event);
  const ids = await readOwnerIds(owner);
  if (!ids.includes(id)) {
    await getStorage().putIndex(ownerIndexKey(owner), [...ids, id].slice(-MAX_OUTBOX_EVENTS));
  }
  return event;
}

export async function stageAcceptedActionIntegrations(
  owner: string,
  item: ActionItem,
): Promise<IntegrationOutboxEvent[]> {
  const settings = await getIntegrationSettings(owner);
  const destinations: IntegrationDestination[] = [
    ...(settings.webhookEnabled ? ["webhook" as const] : []),
    ...(settings.calendarEnabled ? ["icalendar" as const] : []),
  ];
  if (destinations.length === 0) return [];
  return withFileLock(ownerLock(owner), async () => {
    const payload = {
      event: "action.accepted",
      action: {
        id: item.id,
        title: item.title,
        details: item.details,
        assignee: item.assignee,
        dueDate: item.dueDate,
        priority: item.priority,
        sourceSlug: item.sourceSlug,
      },
    };
    const events: IntegrationOutboxEvent[] = [];
    for (const destination of destinations) {
      const event = await createEvent(owner, destination, "action-item", item.id, payload);
      events.push(event);
      if (event.status === "pending" || event.status === "failed") {
        try {
          await enqueueTask({ kind: "deliver-integration", owner, outboxId: event.id });
        } catch {
          // The durable pending event remains discoverable by the scheduled scan.
        }
      }
    }
    return events;
  });
}

function escapeIcs(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function icsDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) {
    return new Date().toISOString().slice(0, 10).replace(/-/g, "");
  }
  return value.slice(0, 10).replace(/-/g, "");
}

export function eventToIcalendar(event: IntegrationOutboxEvent): string {
  const action = (event.payload.action ?? {}) as Record<string, unknown>;
  const start = icsDate(action.dueDate);
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//work-wiki//work-wiki//EN",
    "BEGIN:VTODO",
    `UID:${event.id}@workwiki.app`,
    `DTSTAMP:${event.createdAt.replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`,
    `DUE;VALUE=DATE:${start}`,
    `SUMMARY:${escapeIcs(String(action.title ?? "work-wiki action"))}`,
    `DESCRIPTION:${escapeIcs(String(action.details ?? ""))}`,
    "END:VTODO",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

async function webhookSignature(body: string): Promise<string | null> {
  const secret = process.env.YOPEDIA_WEBHOOK_SIGNING_SECRET;
  if (!secret) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function deliverOutboxEvent(
  owner: string,
  id: string,
  dependencies: { fetch?: typeof fetch; now?: Date } = {},
): Promise<IntegrationOutboxEvent> {
  return withFileLock(`integration-delivery:${tenant(owner)}:${id}`, async () => {
    const event = await getOutboxEvent(owner, id);
    if (!event) throw new Error("Outbox event not found");
    if (event.status === "delivered" || event.status === "cancelled") return event;
    const now = dependencies.now ?? new Date();
    event.status = "delivering";
    event.attempts += 1;
    event.updatedAt = now.toISOString();
    event.nextAttemptAt = null;
    await persistEvent(event);

    try {
      if (event.destination === "icalendar") {
        event.receipt = { calendar: eventToIcalendar(event) };
      } else {
        const settings = await getIntegrationSettings(owner);
        if (!settings.webhookEnabled || !settings.webhookUrl) {
          throw new Error("Webhook delivery is no longer enabled");
        }
        validateUrlSafety(settings.webhookUrl);
        const body = JSON.stringify({ ...event.payload, idempotencyKey: event.idempotencyKey });
        const signature = await webhookSignature(body);
        const response = await (dependencies.fetch ?? fetch)(settings.webhookUrl, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": event.idempotencyKey,
            ...(signature ? { "X-Yopedia-Signature": `sha256=${signature}` } : {}),
          },
          body,
        });
        const responseBody = (await response.text().catch(() => "")).slice(0, 1_000);
        if (!response.ok) throw new Error(`Webhook returned ${response.status}: ${responseBody}`);
        event.receipt = { status: response.status, body: responseBody };
      }
      event.status = "delivered";
      event.deliveredAt = now.toISOString();
      event.updatedAt = now.toISOString();
      delete event.lastError;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      event.status = "failed";
      event.lastError = message.slice(0, 1_000);
      event.updatedAt = now.toISOString();
      const delayMinutes = Math.min(24 * 60, 5 * 2 ** Math.min(event.attempts, 8));
      event.nextAttemptAt = new Date(now.getTime() + delayMinutes * 60_000).toISOString();
    }
    await persistEvent(event);
    await recordOperationSafe(owner, {
      kind: "integration",
      operation: `deliver-${event.destination}`,
      status: event.status === "delivered" ? "succeeded" : "failed",
      subjectId: event.id,
      detail: event.lastError ?? `${event.attempts} attempt(s)`,
    });
    return event;
  });
}

export async function listDueOutboxEvents(
  now: Date = new Date(),
  limit = 50,
): Promise<OutboxSummary[]> {
  const timestamp = now.toISOString();
  return (await readGlobalIndex())
    .filter(
      (event) =>
        (event.status === "pending" || event.status === "failed") &&
        event.nextAttemptAt !== null &&
        event.nextAttemptAt <= timestamp,
    )
    .sort((a, b) => (a.nextAttemptAt ?? "").localeCompare(b.nextAttemptAt ?? ""))
    .slice(0, Math.max(0, Math.min(limit, 100)));
}

export async function retryOutboxEvent(owner: string, id: string): Promise<IntegrationOutboxEvent | null> {
  const event = await getOutboxEvent(owner, id);
  if (!event) return null;
  if (event.status === "delivered" || event.status === "cancelled") return event;
  event.status = "pending";
  event.nextAttemptAt = new Date().toISOString();
  event.updatedAt = event.nextAttemptAt;
  delete event.lastError;
  await persistEvent(event);
  try {
    await enqueueTask({ kind: "deliver-integration", owner, outboxId: id });
  } catch {
    // Scheduled scan will pick up the durable pending event.
  }
  return event;
}
