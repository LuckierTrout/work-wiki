import { getStorage } from "./storage";

const EMAIL_CONFIG_INDEX_KEY = "email-ingest-config";

export const MAX_EMAIL_SENDERS = 50;
export const MAX_EMAIL_CONTENT_CHARS = 100_000;
export const MAX_EMAIL_ATTACHMENTS_RECORDED = 20;

export interface EmailIngestConfig {
  enabled: boolean;
  inboundAddress: string;
  allowedSenders: string[];
  updatedAt: string | null;
}

export interface EmailIngestMetadata {
  from: string;
  to: string;
  subject: string;
  messageId: string;
  attachmentNames: string[];
}

const DEFAULT_CONFIG: EmailIngestConfig = {
  enabled: false,
  inboundAddress: "",
  allowedSenders: [],
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
    updatedAt:
      typeof stored.updatedAt === "string" ? stored.updatedAt : null,
  };
}

export async function saveEmailIngestConfig(input: {
  enabled: boolean;
  inboundAddress: string;
  allowedSenders: string[];
}): Promise<EmailIngestConfig> {
  const config: EmailIngestConfig = {
    enabled: input.enabled,
    inboundAddress: normalizeEmailAddress(input.inboundAddress),
    allowedSenders: normalizeAllowedSenders(input.allowedSenders),
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

export function sanitizeAttachmentNames(values: string[]): string[] {
  return values
    .map((value) => value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, MAX_EMAIL_ATTACHMENTS_RECORDED);
}
