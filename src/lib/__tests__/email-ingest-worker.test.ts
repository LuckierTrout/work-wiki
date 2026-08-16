import { describe, expect, it, vi } from "vitest";
import worker from "../../../workers/email-ingest/index";

/**
 * Worker-level coverage for `workers/email-ingest`, which had none: the sibling
 * task-consumer receipt is pinned in `task-consumer.test.ts`, but nothing
 * exercised this worker at all — `brand-copy.test.ts` reads it as text and
 * looks only for brand strings. Two surfaces are pinned here.
 *
 * The acknowledgement reply is the first thing a sender receives after
 * forwarding a document in, and it carries a page link. `/wiki/<slug>` is
 * retired (404), so that link had to move to the owner-scoped form; a
 * regression to the retired URL would otherwise ship green.
 *
 * The attachment byte-copy is the buffer the worker fills before wrapping each
 * supported attachment in a `Blob`. Zeroing or emptying that copy still yields
 * a correctly-sized buffer, an `{ ok: true, slug }` response and a
 * byte-identical acknowledgement, so every emailed PDF/DOCX would ingest empty
 * with the suite green.
 */

const RAW_EMAIL = [
  "From: owner@example.com",
  "To: ingest@workwiki.app",
  "Subject: Quarterly notes",
  "Message-ID: <message-1@example.com>",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Here are the quarterly notes to file.",
  "",
].join("\r\n");

/**
 * Byte payload for the attachment fixture. `(i * 7 + 3) & 0xff` over 256 bytes
 * hits every value in 0x00-0xff, so a zeroed copy, a truncated copy and a
 * UTF-8 decode/re-encode of the payload all diverge from the source.
 */
const ATTACHMENT_BYTES = new Uint8Array(256);
for (let i = 0; i < ATTACHMENT_BYTES.length; i += 1) {
  ATTACHMENT_BYTES[i] = (i * 7 + 3) & 0xff;
}

function base64Lines(bytes: Uint8Array): string {
  const encoded = Buffer.from(bytes).toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < encoded.length; i += 76) {
    lines.push(encoded.slice(i, i + 76));
  }
  return lines.join("\r\n");
}

const ATTACHMENT_EMAIL = [
  "From: owner@example.com",
  "To: ingest@workwiki.app",
  "Subject: Quarterly report",
  "Message-ID: <message-2@example.com>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="work-wiki-boundary"',
  "",
  "--work-wiki-boundary",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "The quarterly report is attached.",
  "",
  "--work-wiki-boundary",
  'Content-Type: application/pdf; name="report.pdf"',
  'Content-Disposition: attachment; filename="report.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  base64Lines(ATTACHMENT_BYTES),
  "",
  "--work-wiki-boundary--",
  "",
].join("\r\n");

function message(raw: string = RAW_EMAIL, subject: string = "Quarterly notes") {
  return {
    from: "owner@example.com",
    to: "ingest@workwiki.app",
    headers: new Headers({ subject }),
    raw: new Blob([raw]).stream() as ReadableStream<Uint8Array>,
    // `rawSize` is a byte count the worker compares against
    // MAX_RAW_EMAIL_BYTES, not a string length.
    rawSize: new TextEncoder().encode(raw).byteLength,
    setReject: vi.fn(),
    reply: vi.fn(async (_builder: { from: string; subject: string; text: string }) => ({})),
  };
}

function env(response: Response) {
  return {
    YOPEDIA_CONFIG: {
      get: vi.fn(async () => ({
        enabled: true,
        inboundAddress: "ingest@workwiki.app",
        allowedSenders: ["owner@example.com"],
      })),
    },
    YOPEDIA: { fetch: vi.fn(async (_request: Request) => response) },
    YOPEDIA_SERVICE_TOKEN: "test-token",
    YOPEDIA_SITE_URL: "https://yopedia.example.com",
  };
}

describe("email-ingest acknowledgement", () => {
  it("links the owner-scoped page URL, never the retired commons URL", async () => {
    const msg = message();
    await worker.email(
      msg as unknown as Parameters<typeof worker.email>[0],
      env(Response.json({ ok: true, slug: "quarterly-notes" })) as unknown as Parameters<
        typeof worker.email
      >[1],
    );
    expect(msg.reply).toHaveBeenCalledOnce();
    const sent = msg.reply.mock.calls[0][0];
    expect(sent.text).toContain(
      "https://yopedia.example.com/u/yopedia/quarterly-notes",
    );
    expect(sent.text).not.toContain("/wiki/");
  });

  it("points a queued (slugless) ingest at a live surface", async () => {
    const msg = message();
    await worker.email(
      msg as unknown as Parameters<typeof worker.email>[0],
      env(Response.json({ ok: true, jobId: "job-1" })) as unknown as Parameters<
        typeof worker.email
      >[1],
    );
    const sent = msg.reply.mock.calls[0][0];
    expect(sent.text).toContain("https://yopedia.example.com/ingest");
    expect(sent.text).not.toContain("/wiki/");
  });
});

/**
 * Assert on the outermost surface the worker controls -- the `Request` body it
 * hands to the `YOPEDIA` service binding -- rather than `parsed.attachments` or
 * the `Blob` built from it, so the assertion observes the copy itself and not a
 * proxy for it.
 */
describe("email-ingest attachment forwarding", () => {
  it("forwards the attachment bytes to the ingest service unchanged", async () => {
    const msg = message(ATTACHMENT_EMAIL, "Quarterly report");
    const bindings = env(Response.json({ ok: true, slug: "quarterly-report" }));
    await worker.email(
      msg as unknown as Parameters<typeof worker.email>[0],
      bindings as unknown as Parameters<typeof worker.email>[1],
    );

    expect(bindings.YOPEDIA.fetch).toHaveBeenCalledOnce();
    const forwarded = bindings.YOPEDIA.fetch.mock.calls[0][0];
    const parts = (await forwarded.formData()).getAll("attachments");
    expect(parts).toHaveLength(1);

    expect(parts[0]).toBeInstanceOf(File);
    const part = parts[0] as File;
    expect(part.name).toBe("report.pdf");
    expect(part.type).toBe("application/pdf");
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(ATTACHMENT_BYTES);
  });
});
