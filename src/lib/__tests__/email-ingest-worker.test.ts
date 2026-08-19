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

/**
 * A single supported attachment leaves most of the forwarding loop unobserved:
 * the 10-attachment cap, the `attachment-<n>` filename fallback, the
 * `attachmentName` fields (which carry the *unsupported* names the app records
 * in activity history), and the per-index pairing of name to bytes all survive
 * deletion against a one-attachment fixture.
 *
 * So: thirteen parts, eleven of them supported, interleaved with two the door
 * rejects, each carrying index-derived bytes so a pairing regression that mates
 * part *i*'s bytes with part *j*'s filename fails rather than passing on
 * identical payloads.
 */
interface MixedPart {
  filename: string | null;
  /** Header value written into the fixture. */
  mime: string;
  /** What `postal-mime` reports, and therefore what the forwarded Blob carries. */
  parsedMime: string;
  supported: boolean;
}

const MIXED_PARTS: MixedPart[] = [
  { filename: "a1.pdf", mime: "application/pdf", parsedMime: "application/pdf", supported: true },
  {
    filename: "a2.docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    parsedMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    supported: true,
  },
  {
    filename: "program.exe",
    mime: "application/octet-stream",
    parsedMime: "application/octet-stream",
    supported: false,
  },
  {
    filename: "a4.odt",
    mime: "application/vnd.oasis.opendocument.text",
    parsedMime: "application/vnd.oasis.opendocument.text",
    supported: true,
  },
  // `.data` is not an allowed extension, so this one rides in on its content
  // type alone. `postal-mime` drops the `; charset=utf-8` parameter before the
  // worker ever sees it -- the worker's own parameter stripping is pinned
  // directly in `email-ingest-allowlist-parity.test.ts` and, at the forwarding
  // surface, in `email-ingest-worker-normalization.test.ts`.
  { filename: "c.data", mime: "text/csv; charset=utf-8", parsedMime: "text/csv", supported: true },
  // No `filename` parameter: `postal-mime` reports `filename: null`, which is
  // what drives the `attachment-<n>` fallback.
  { filename: null, mime: "application/pdf", parsedMime: "application/pdf", supported: true },
  {
    filename: "a7.epub",
    mime: "application/epub+zip",
    parsedMime: "application/epub+zip",
    supported: true,
  },
  {
    filename: "archive.bin",
    mime: "application/x-binary-thing",
    parsedMime: "application/x-binary-thing",
    supported: false,
  },
  { filename: "a9.rtf", mime: "application/rtf", parsedMime: "application/rtf", supported: true },
  {
    filename: "a10.mobi",
    mime: "application/x-mobipocket-ebook",
    parsedMime: "application/x-mobipocket-ebook",
    supported: true,
  },
  { filename: "a11.org", mime: "text/org", parsedMime: "text/org", supported: true },
  {
    filename: "a12.xlsx",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    parsedMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    supported: true,
  },
  // The eleventh supported part: present only so `.slice(0, 10)` has something
  // to cut. Widening the cap forwards it and fails the length assertion.
  {
    filename: "a13.ods",
    mime: "application/vnd.oasis.opendocument.spreadsheet",
    parsedMime: "application/vnd.oasis.opendocument.spreadsheet",
    supported: true,
  },
];

/**
 * `(index * 31 + i * 7 + 3) & 0xff` -- distinct per part and per offset, so
 * neither a zeroed copy nor bytes borrowed from a neighbouring part matches.
 */
function partBytes(index: number, length = 96): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = (index * 31 + i * 7 + 3) & 0xff;
  return bytes;
}

function multipartEmail(
  parts: readonly Pick<MixedPart, "filename" | "mime">[],
  options: { subject: string; messageId: string; body: string },
): string {
  const lines = [
    "From: owner@example.com",
    "To: ingest@workwiki.app",
    `Subject: ${options.subject}`,
    `Message-ID: <${options.messageId}@example.com>`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="work-wiki-boundary"',
    "",
    "--work-wiki-boundary",
    "Content-Type: text/plain; charset=utf-8",
    "",
    options.body,
    "",
  ];
  parts.forEach((part, index) => {
    lines.push(
      "--work-wiki-boundary",
      `Content-Type: ${part.mime}`,
      part.filename
        ? `Content-Disposition: attachment; filename="${part.filename}"`
        : "Content-Disposition: attachment",
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(partBytes(index)),
      "",
    );
  });
  lines.push("--work-wiki-boundary--", "");
  return lines.join("\r\n");
}

const MIXED_EMAIL = multipartEmail(MIXED_PARTS, {
  subject: "Mixed batch",
  messageId: "message-mixed",
  body: "Thirteen files attached.",
});

const SINGLE_SKIP_PARTS: MixedPart[] = [
  { filename: "solo.pdf", mime: "application/pdf", parsedMime: "application/pdf", supported: true },
  {
    filename: "program.exe",
    mime: "application/octet-stream",
    parsedMime: "application/octet-stream",
    supported: false,
  },
];

const SINGLE_SKIP_EMAIL = multipartEmail(SINGLE_SKIP_PARTS, {
  subject: "One and one",
  messageId: "message-single",
  body: "One good file, one bad.",
});

async function forwardedForm(raw: string, subject: string, slug: string) {
  const msg = message(raw, subject);
  const bindings = env(Response.json({ ok: true, slug }));
  await worker.email(
    msg as unknown as Parameters<typeof worker.email>[0],
    bindings as unknown as Parameters<typeof worker.email>[1],
  );
  expect(bindings.YOPEDIA.fetch).toHaveBeenCalledOnce();
  const forwarded = bindings.YOPEDIA.fetch.mock.calls[0][0];
  return {
    form: await forwarded.formData(),
    reply: msg.reply.mock.calls[0][0] as { text: string },
  };
}

describe("email-ingest multi-attachment forwarding", () => {
  it("forwards ten supported attachments in source order with their own bytes", async () => {
    const { form } = await forwardedForm(MIXED_EMAIL, "Mixed batch", "mixed-batch");
    const parts = form.getAll("attachments");

    // Eleven parts pass the allowlist; the cap forwards ten.
    const supported = MIXED_PARTS.map((part, index) => ({ ...part, index })).filter(
      (part) => part.supported,
    );
    expect(supported).toHaveLength(11);
    expect(parts).toHaveLength(10);

    for (const [position, source] of supported.slice(0, 10).entries()) {
      const part = parts[position] as File;
      expect(part).toBeInstanceOf(File);
      // The fallback numbers by position among the *supported* attachments, not
      // by position among all parsed parts -- here 5, not 6.
      expect(part.name).toBe(source.filename ?? `attachment-${position + 1}`);
      expect(part.type).toBe(source.parsedMime);
      expect(new Uint8Array(await part.arrayBuffer())).toEqual(partBytes(source.index));
    }
    expect((parts[4] as File).name).toBe("attachment-5");
    // The eleventh supported part was cut, not silently substituted.
    expect(parts.map((part) => (part as File).name)).not.toContain("a13.ods");
  });

  it("records every attachment name, including the ones it will not forward", async () => {
    const { form } = await forwardedForm(MIXED_EMAIL, "Mixed batch", "mixed-batch");
    expect(form.getAll("attachmentName")).toEqual([
      "a1.pdf",
      "a2.docx",
      "program.exe",
      "a4.odt",
      "c.data",
      "unnamed attachment",
      "a7.epub",
      "archive.bin",
      "a9.rtf",
      "a10.mobi",
      "a11.org",
      "a12.xlsx",
      "a13.ods",
    ]);
  });
});

/**
 * The acknowledgement is the only place the sender learns that some of what
 * they attached did not make it in. Both counts and both plural forms are
 * pinned; the cap-truncated eleventh supported part folding into the *skipped*
 * line is existing behaviour, pinned as-is rather than corrected here.
 */
describe("email-ingest acknowledgement attachment counts", () => {
  it("reports the queued and skipped counts in the plural", async () => {
    const { reply } = await forwardedForm(MIXED_EMAIL, "Mixed batch", "mixed-batch");
    expect(reply.text).toContain("10 supported attachments were queued for ingestion.");
    expect(reply.text).toContain(
      "3 unsupported attachments were recorded but skipped.",
    );
  });

  it("reports the queued and skipped counts in the singular", async () => {
    const { reply } = await forwardedForm(SINGLE_SKIP_EMAIL, "One and one", "one-and-one");
    expect(reply.text).toContain("1 supported attachment was queued for ingestion.");
    expect(reply.text).toContain("1 unsupported attachment was recorded but skipped.");
  });

  it("says nothing about attachments when the email carries none", async () => {
    const msg = message();
    await worker.email(
      msg as unknown as Parameters<typeof worker.email>[0],
      env(Response.json({ ok: true, slug: "quarterly-notes" })) as unknown as Parameters<
        typeof worker.email
      >[1],
    );
    const sent = msg.reply.mock.calls[0][0];
    expect(sent.text).not.toContain("queued for ingestion");
    expect(sent.text).not.toContain("recorded but skipped");
  });
});
