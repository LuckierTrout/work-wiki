import PostalMime from "postal-mime";

interface KVNamespace {
  get(key: string, type: "json"): Promise<unknown>;
}

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface EmailIngestConfig {
  enabled?: boolean;
  inboundAddress?: string;
  allowedSenders?: string[];
}

interface ForwardableEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
  reply(builder: {
    from: string;
    subject: string;
    text: string;
  }): Promise<unknown>;
}

interface Env {
  YOPEDIA_CONFIG: KVNamespace;
  YOPEDIA: Fetcher;
  YOPEDIA_SERVICE_TOKEN?: string;
  YOPEDIA_SITE_URL?: string;
}

const CONFIG_KEY = "_idx:email-ingest-config";
const MAX_RAW_EMAIL_BYTES = 10 * 1024 * 1024;
const MAX_EMAIL_CONTENT_CHARS = 100_000;
const TRUNCATION_MARKER = "\n\n[Email body truncated]";
const SUPPORTED_EXTENSIONS = new Set(["docx", "pptx", "xlsx", "csv"]);
const SUPPORTED_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "application/csv",
]);

function supportedAttachment(filename: string | null, mimeType: string): boolean {
  const ext = filename?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  return SUPPORTED_EXTENSIONS.has(ext) || SUPPORTED_MIME_TYPES.has(mimeType.toLowerCase());
}

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function htmlToText(html: string): string {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function reply(
  message: ForwardableEmailMessage,
  subject: string,
  text: string,
): Promise<void> {
  try {
    await message.reply({
      from: message.to,
      subject: `Re: ${subject}`,
      text,
    });
  } catch (error) {
    console.error("email-ingest: reply failed", error);
  }
}

function safeError(value: unknown): string {
  if (!value || typeof value !== "object") return "Yopedia could not accept this email.";
  const error = (value as Record<string, unknown>).error;
  return typeof error === "string" && error.trim()
    ? error.replace(/[\r\n]+/g, " ").slice(0, 300)
    : "Yopedia could not accept this email.";
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const config = (await env.YOPEDIA_CONFIG.get(CONFIG_KEY, "json")) as
      | EmailIngestConfig
      | null;
    if (!config?.enabled) {
      message.setReject("Email ingestion is not enabled for this Yopedia.");
      return;
    }

    const from = normalizeAddress(message.from);
    const to = normalizeAddress(message.to);
    const allowed = Array.isArray(config.allowedSenders)
      ? config.allowedSenders.map(normalizeAddress)
      : [];
    if (!allowed.includes(from)) {
      message.setReject("This sender is not approved for Yopedia ingestion.");
      return;
    }
    if (config.inboundAddress && normalizeAddress(config.inboundAddress) !== to) {
      message.setReject("This address is not configured for Yopedia ingestion.");
      return;
    }

    const headerSubject =
      message.headers.get("subject")?.replace(/[\r\n]+/g, " ").trim() ||
      "Emailed note";
    if (message.rawSize > MAX_RAW_EMAIL_BYTES) {
      await reply(
        message,
        headerSubject,
        "Yopedia did not process this message because it is larger than 10 MB.",
      );
      return;
    }

    const serviceToken = env.YOPEDIA_SERVICE_TOKEN;
    if (!serviceToken) {
      console.error("email-ingest: YOPEDIA_SERVICE_TOKEN is missing");
      await reply(
        message,
        headerSubject,
        "Yopedia could not queue this email because the ingest service is not configured.",
      );
      return;
    }

    let parsed: Awaited<ReturnType<typeof PostalMime.parse>>;
    try {
      parsed = await PostalMime.parse(message.raw);
    } catch (error) {
      console.error("email-ingest: MIME parse failed", error);
      await reply(
        message,
        headerSubject,
        "Yopedia could not read this email. Send a new message with a plain-text or HTML body.",
      );
      return;
    }

    const subject =
      parsed.subject?.replace(/[\r\n]+/g, " ").trim() || headerSubject;
    const messageId =
      parsed.messageId?.trim() || message.headers.get("message-id")?.trim() || "";
    const rawContent = parsed.text?.trim() || htmlToText(parsed.html || "");
    if (!messageId) {
      await reply(
        message,
        subject,
        "Yopedia could not process this message because it has no Message-ID. Please resend it from a standard email client.",
      );
      return;
    }
    const supportedAttachments = parsed.attachments
      .filter((attachment) => supportedAttachment(attachment.filename, attachment.mimeType))
      .slice(0, 10);
    if (!rawContent && supportedAttachments.length === 0) {
      await reply(
        message,
        subject,
        parsed.attachments.length
          ? "Yopedia found no email text or supported document attachment. Supported attachments: DOCX, PPTX, XLSX, and CSV."
          : "Yopedia found no email text to ingest.",
      );
      return;
    }

    const content =
      rawContent.length > MAX_EMAIL_CONTENT_CHARS
        ? `${rawContent.slice(0, MAX_EMAIL_CONTENT_CHARS - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`
        : rawContent;
    const attachmentNames = parsed.attachments
      .map((attachment) => attachment.filename || "unnamed attachment")
      .slice(0, 20);

    let response: Response;
    try {
      const site = (env.YOPEDIA_SITE_URL || "").replace(/\/+$/, "");
      if (!site) throw new Error("YOPEDIA_SITE_URL is missing");
      const form = new FormData();
      form.append("from", from);
      form.append("to", to);
      form.append("subject", subject);
      form.append("messageId", messageId);
      if (content) form.append("content", content);
      for (const name of attachmentNames) form.append("attachmentName", name);
      for (const [index, attachment] of supportedAttachments.entries()) {
        const filename = attachment.filename || `attachment-${index + 1}`;
        const bytes = typeof attachment.content === "string"
          ? new TextEncoder().encode(attachment.content)
          : attachment.content instanceof ArrayBuffer
            ? new Uint8Array(attachment.content)
            : new Uint8Array(
                attachment.content.buffer,
                attachment.content.byteOffset,
                attachment.content.byteLength,
              );
        form.append(
          "attachments",
          new Blob([bytes], { type: attachment.mimeType || "application/octet-stream" }),
          filename,
        );
      }
      response = await env.YOPEDIA.fetch(
        new Request(`${site}/api/email/ingest`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${serviceToken}`,
          },
          body: form,
        }),
      );
    } catch (error) {
      console.error("email-ingest: service binding request failed", error);
      await reply(
        message,
        subject,
        "Yopedia could not queue this email. Please try again in a few minutes.",
      );
      return;
    }

    const result = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!response.ok) {
      await reply(message, subject, safeError(result));
      return;
    }

    const site = (env.YOPEDIA_SITE_URL || "").replace(/\/+$/, "");
    const jobId = typeof result?.jobId === "string" ? result.jobId : "";
    const slug = typeof result?.slug === "string" ? result.slug : "";
    const lines = [
      slug ? "Yopedia has already processed this email." : "Yopedia received your email and queued it for processing.",
      jobId ? `Job: ${jobId}` : "",
      slug && site ? `Page: ${site}/wiki/${encodeURIComponent(slug)}` : "",
      !slug && site ? `Track it under Recent ingests: ${site}/ingest` : "",
      supportedAttachments.length
        ? `${supportedAttachments.length} supported attachment${supportedAttachments.length === 1 ? " was" : "s were"} queued for ingestion.`
        : "",
      attachmentNames.length > supportedAttachments.length
        ? `${attachmentNames.length - supportedAttachments.length} unsupported attachment${attachmentNames.length - supportedAttachments.length === 1 ? " was" : "s were"} recorded but skipped.`
        : "",
    ].filter(Boolean);
    await reply(message, subject, lines.join("\n\n"));
  },

  async fetch(): Promise<Response> {
    return new Response("yopedia email-ingest ok\n", {
      headers: { "content-type": "text/plain" },
    });
  },
};
