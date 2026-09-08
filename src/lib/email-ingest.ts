import { READ_ONLY_REFUSAL, assertWritable } from "./read-only";
import { getStorage } from "./storage";

const EMAIL_CONFIG_INDEX_KEY = "email-ingest-config";

export const MAX_EMAIL_SENDERS = 50;
export const MAX_EMAIL_CONTENT_CHARS = 100_000;
export const MAX_EMAIL_ATTACHMENTS_RECORDED = 20;
/**
 * Supported document attachments accepted from one email. The inbound Worker
 * truncates to the same number before forwarding (`MAX_EMAIL_ATTACHMENTS` in
 * `workers/email-ingest/index.ts`, which cannot import this module); the two are
 * pinned in agreement by `email-ingest-allowlist-parity.test.ts`.
 */
export const MAX_EMAIL_DOCUMENTS = 10;

export interface EmailIngestConfig {
  enabled: boolean;
  inboundAddress: string;
  allowedSenders: string[];
  destinationVaultId: string;
  destinationAgentId: string;
  updatedAt: string | null;
}

export interface EmailIngestMetadata {
  from: string;
  to: string;
  subject: string;
  messageId: string;
  attachmentNames: string[];
  /**
   * When the message arrived, ISO-8601. Stamped by the route on receipt.
   *
   * OPTIONAL because records written before Epic 7 do not have one, and an
   * absent value must read as "unknown" rather than as the epoch. It exists so
   * an emailed PDF, whose extract may not compile for minutes, is dated by the
   * mail rather than by whenever the sidecar got round to it.
   */
  receivedAt?: string;
}

const DEFAULT_CONFIG: EmailIngestConfig = {
  enabled: false,
  inboundAddress: "",
  allowedSenders: [],
  destinationVaultId: "",
  destinationAgentId: "",
  updatedAt: null,
};

export function normalizeEmailAddress(value: string): string {
  return value.trim().toLowerCase();
}

export function isEmailAddress(value: string): boolean {
  const normalized = normalizeEmailAddress(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

export function normalizeAllowedSenders(values: string[]): string[] {
  return Array.from(
    new Set(values.map(normalizeEmailAddress).filter(Boolean)),
  ).sort();
}

export function senderIsAllowed(
  sender: string,
  allowedSenders: string[],
): boolean {
  const normalized = normalizeEmailAddress(sender);
  return normalizeAllowedSenders(allowedSenders).includes(normalized);
}

export async function loadEmailIngestConfig(): Promise<EmailIngestConfig> {
  const stored = await getStorage().getIndex<Partial<EmailIngestConfig>>(
    EMAIL_CONFIG_INDEX_KEY,
  );
  if (!stored) return { ...DEFAULT_CONFIG };

  return {
    enabled: stored.enabled === true,
    inboundAddress:
      typeof stored.inboundAddress === "string"
        ? normalizeEmailAddress(stored.inboundAddress)
        : "",
    allowedSenders: Array.isArray(stored.allowedSenders)
      ? normalizeAllowedSenders(
          stored.allowedSenders.filter(
            (value): value is string => typeof value === "string",
          ),
        )
      : [],
    destinationVaultId:
      typeof stored.destinationVaultId === "string"
        ? stored.destinationVaultId.trim()
        : "",
    destinationAgentId:
      typeof stored.destinationAgentId === "string"
        ? stored.destinationAgentId.trim()
        : "",
    updatedAt:
      typeof stored.updatedAt === "string" ? stored.updatedAt : null,
  };
}

export async function saveEmailIngestConfig(input: {
  enabled: boolean;
  inboundAddress: string;
  allowedSenders: string[];
  destinationVaultId?: string;
  destinationAgentId?: string;
}): Promise<EmailIngestConfig> {
  // Deployment read-only (DW-385). The store's only writer. Today
  // `PUT /api/email/settings` is its only caller and gates already, so this
  // changes no behaviour the app has; it is here for the DIRECT LIBRARY caller
  // added next — a CLI command, an MCP tool, a maintenance script — which no
  // HTTP gate can reach. Same reasoning as the wiki-lifecycle gates in
  // `read-only.ts`.
  assertWritable(READ_ONLY_REFUSAL.emailSettings);
  const config: EmailIngestConfig = {
    enabled: input.enabled,
    inboundAddress: normalizeEmailAddress(input.inboundAddress),
    allowedSenders: normalizeAllowedSenders(input.allowedSenders),
    destinationVaultId: input.destinationVaultId?.trim() || "",
    destinationAgentId: input.destinationAgentId?.trim() || "",
    updatedAt: new Date().toISOString(),
  };
  await getStorage().putIndex(EMAIL_CONFIG_INDEX_KEY, config);
  return config;
}

export async function emailJobId(messageId: string): Promise<string> {
  const bytes = new TextEncoder().encode(messageId.trim());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `email-${hex.slice(0, 48)}`;
}

export function sanitizeEmailSubject(value: string): string {
  const singleLine = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return (singleLine || "Emailed note").slice(0, 200);
}

/**
 * The per-name scrub, factored out rather than written twice (DW-690).
 * `sanitizeAttachmentNamesUnique` de-duplicates the SCRUBBED values, which only
 * means anything if "scrubbed" is exactly what the plain variant records; two
 * copies of this expression could drift and the unique variant would then
 * collapse names the recorded list does not actually equate.
 */
function scrubAttachmentName(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 200);
}

export function sanitizeAttachmentNames(values: string[]): string[] {
  return values
    .map(scrubAttachmentName)
    .filter(Boolean)
    .slice(0, MAX_EMAIL_ATTACHMENTS_RECORDED);
}

/**
 * `sanitizeAttachmentNames`, plus de-duplication of the names AS RECORDED
 * (DW-690).
 *
 * Order is the whole point: scrub, THEN de-duplicate, THEN cap. De-duplicating
 * raw strings first — which the route's caller-name/file-name union used to do
 * with a bare `new Set` — lets two names that scrub to the same string both
 * survive, so `report.pdf` and `report.pdf\r\n` were recorded twice and the
 * recorded-name skip floor read the surplus as a file that never arrived. And
 * the cap has to come LAST: applied before the collapse it would spend recorded
 * slots on duplicates and hide real names past the twentieth.
 *
 * A SEPARATE export rather than de-duplication folded into
 * `sanitizeAttachmentNames`, because that function's other callers need the
 * length it returns to track the input's. `src/app/api/email/ingest/route.ts`
 * derives `unnamedOversized` from `oversizedCount - oversizedAttachmentNames.length`,
 * so collapsing two oversized files that share a name there would invent a
 * phantom unnamed file in the refusal text.
 */
export function sanitizeAttachmentNamesUnique(values: string[]): string[] {
  return Array.from(new Set(values.map(scrubAttachmentName).filter(Boolean))).slice(
    0,
    MAX_EMAIL_ATTACHMENTS_RECORDED,
  );
}
