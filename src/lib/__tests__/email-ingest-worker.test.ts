import { describe, expect, it, vi } from "vitest";
import worker, {
  AGGREGATE_DOCUMENT_AVERAGE_BYTES,
  MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES,
  MAX_EMAIL_ATTACHMENTS,
  MAX_EMAIL_ATTACHMENT_NAMES_RECORDED,
  MAX_EMAIL_CONTENT_CHARS,
  MAX_EMAIL_DOCUMENT_BYTES,
  MAX_RAW_EMAIL_BYTES,
} from "../../../workers/email-ingest/index";
import { base64PartWireSize, quotedPrintablePartWireSize } from "./email-ingest-wire";

/**
 * Worker-level coverage for `workers/email-ingest`, which had none: the sibling
 * task-consumer receipt is pinned in `task-consumer.test.ts`, but nothing
 * exercised this worker at all — `brand-copy.test.ts` reads it as text and
 * looks only for brand strings.
 *
 * The surfaces pinned here, in file order:
 *
 * 1. The acknowledgement reply — the first thing a sender receives after
 *    forwarding a document in, and it carries a page link. `/wiki/<slug>` is
 *    retired (404), so that link had to move to the owner-scoped form; a
 *    regression to the retired URL would otherwise ship green.
 *
 * 2. The attachment byte-copy — the buffer the worker fills before wrapping
 *    each supported attachment in a `Blob`. Zeroing or emptying that copy still
 *    yields a correctly-sized buffer, an `{ ok: true, slug }` response and a
 *    byte-identical acknowledgement, so every emailed PDF/DOCX would ingest
 *    empty with the suite green.
 *
 * 3. The forwarded transport — the method, target URL and `Authorization`
 *    header of the `Request` handed to the `YOPEDIA` binding. Both worker
 *    suites read only `formData()` off that `Request`, so the envelope around
 *    the body was entirely unobserved (DW-252).
 *
 * 4. The multi-attachment forwarding loop — the per-email cap, the
 *    `attachment-<n>` filename fallback, the `attachmentName` fields and the
 *    index pairing of name to bytes, none of which a one-attachment fixture
 *    can reach.
 *
 * 5. The loss accounting — the attachment counts the acknowledgement reports
 *    back to the sender, and the `skippedAttachmentCount` field forwarded to
 *    the route so it need not re-derive the loss from a truncated name list.
 *
 * 6. The raw-message size gate — its exact boundary, the figure the refusal
 *    quotes back, and the recorded trade-off that the whole attachment budget
 *    and a maximal body do not fit under it together (DW-361).
 *
 * 7. Inline MIME parts — a signature logo is not an attachment the sender
 *    chose to send, and reporting one back as "skipped" is a lie about their
 *    own message (DW-359).
 *
 * 8. The post-decode aggregate byte budget — the bound on what the forwarding
 *    loop actually copies into `FormData`, which the widened raw cap makes
 *    load-bearing rather than incidental (DW-360).
 *
 * The `Blob` *type* the worker builds is pinned next door in
 * `email-ingest-worker-normalization.test.ts`, which mocks `postal-mime`: it is
 * invisible from the `Request` captured here, because the multipart serializer
 * rewrites an empty type before the body exists.
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

/**
 * Worst-case quoted-printable: every octet written as an `=XX` escape, which is
 * what a mail client really produces for a byte-dense `text/*` attachment.
 *
 * An `=XX` escape may not be split across a line break, so 25 of them (75
 * characters) fill the RFC 2045 76-character budget; the line is then closed
 * with a `=` soft line break -- the LAST line included. That trailing soft break
 * is not decoration: the CRLF before the MIME boundary is otherwise a hard line
 * break, and PostalMime hands the worker back the payload plus a stray `\n`.
 * The end-to-end test below is what caught that, and is why the part body ends
 * flush against the boundary with no blank line after it.
 *
 * Unlike `base64Lines` this has no real encoder behind it, which is why the
 * quoted-printable fixture is also run end to end through PostalMime: the
 * decode back to `partBytes` is the anchor `Buffer.toString("base64")` provides
 * for free on the other side.
 */
function quotedPrintableLines(bytes: Uint8Array): string {
  const escapes = Array.from(
    bytes,
    (byte) => `=${byte.toString(16).toUpperCase().padStart(2, "0")}`,
  );
  const lines: string[] = [];
  for (let i = 0; i < escapes.length; i += 25) {
    lines.push(`${escapes.slice(i, i + 25).join("")}=`);
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
  it("forwards a quoted-printable attachment byte-identically", async () => {
    // The DW-358 scenario itself, observed end to end at the Worker surface: a
    // `text/csv` part the sender's client wrote as quoted-printable rather than
    // base64. Every other fixture in this file is base64, so nothing exercised
    // the encoding the widened raw cap now exists for.
    //
    // It is also the anchor for `quotedPrintableLines`, which -- unlike
    // `base64Lines` -- has no real encoder behind it. PostalMime decoding the
    // fixture back to the exact source bytes is what says the hand-written
    // worst-case encoding is well-formed quoted-printable and not merely
    // self-consistent with the wire-size formula calibrated against it.
    //
    // 300 bytes, so the part spans twelve full lines and exercises the `=` soft
    // line breaks; `partBytes` covers every octet value, CR and LF included,
    // which only survive the round trip because worst-case QP escapes them.
    const raw = multipartEmail(
      [{ filename: "rows.csv", mime: "text/csv", bytes: 300, encoding: "quoted-printable" }],
      { subject: "Row export", messageId: "message-qp", body: "Rows attached." },
    );
    const msg = message(raw, "Row export");
    const bindings = env(Response.json({ ok: true, slug: "row-export" }));
    await worker.email(
      msg as unknown as Parameters<typeof worker.email>[0],
      bindings as unknown as Parameters<typeof worker.email>[1],
    );

    expect(bindings.YOPEDIA.fetch).toHaveBeenCalledOnce();
    const forwarded = bindings.YOPEDIA.fetch.mock.calls[0][0];
    const parts = (await forwarded.formData()).getAll("attachments");
    expect(parts).toHaveLength(1);
    const part = parts[0] as File;
    expect(part.name).toBe("rows.csv");
    expect(part.type).toBe("text/csv");
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(partBytes(0, 300));
    // Sanity only: this ~1 KB fixture cleared the raw gate before DW-358 too, so
    // it is evidence that nothing else refused the message on the way through --
    // not evidence for the widened cap. The cap is measured next door, against a
    // full-size document.
    expect(msg.reply.mock.calls[0][0].text).not.toContain("larger than");
  });
});

/**
 * The envelope around that body: method, target URL and credential. Both worker
 * suites read only `formData()` off the captured `Request`, so dropping the
 * `Authorization` header, sending a bare token, or hardcoding a different
 * ingest path all shipped green (DW-252).
 *
 * The bindings below deliberately carry values that appear nowhere else in this
 * file -- `env()`'s own `test-token` / `yopedia.example.com` are what a
 * hardcoded literal would most plausibly be frozen to, and asserting against
 * them could not tell a threaded value from a baked-in one.
 */
describe("email-ingest forwarded transport", () => {
  const TRANSPORT_TOKEN = "svc-9f3c1a-transport";
  const TRANSPORT_SITE = "https://ingest-edge.internal.test";

  async function forwardedRequest(siteUrl: string) {
    const msg = message(ATTACHMENT_EMAIL, "Quarterly report");
    const bindings = {
      ...env(Response.json({ ok: true, slug: "quarterly-report" })),
      YOPEDIA_SERVICE_TOKEN: TRANSPORT_TOKEN,
      YOPEDIA_SITE_URL: siteUrl,
    };
    await worker.email(
      msg as unknown as Parameters<typeof worker.email>[0],
      bindings as unknown as Parameters<typeof worker.email>[1],
    );
    expect(bindings.YOPEDIA.fetch).toHaveBeenCalledOnce();
    return bindings.YOPEDIA.fetch.mock.calls[0][0];
  }

  it("POSTs to the configured site's ingest endpoint as the service principal", async () => {
    const forwarded = await forwardedRequest(TRANSPORT_SITE);
    expect(forwarded.method).toBe("POST");
    expect(forwarded.url).toBe(`${TRANSPORT_SITE}/api/email/ingest`);
    // `Bearer ` included: the route's `getServicePrincipal` reads the scheme,
    // so a bare token authenticates as nobody and every email 401s.
    expect(forwarded.headers.get("Authorization")).toBe(`Bearer ${TRANSPORT_TOKEN}`);
  });

  it("builds the target from the configured site with its trailing slashes trimmed", async () => {
    const forwarded = await forwardedRequest(`${TRANSPORT_SITE}///`);
    // Not `https://ingest-edge.internal.test////api/email/ingest`.
    expect(forwarded.url).toBe(`${TRANSPORT_SITE}/api/email/ingest`);
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
  parts: readonly (Pick<MixedPart, "filename" | "mime"> & {
    /** Decoded payload length. Defaults to `partBytes`'s own 96. */
    bytes?: number;
    /**
     * A verbatim `Content-Disposition` line, replacing the one derived from
     * `filename`. The only way to write a name the quoted-string form cannot
     * hold -- RFC 2231 percent-encoding smuggles bytes (CR/LF included) that a
     * `filename="..."` parameter could not carry without breaking the header.
     */
    disposition?: string;
    /**
     * Transfer encoding for the part body. Defaults to base64, the encoding
     * every fixture used before DW-358; `quoted-printable` is the worst-case
     * encoding a sending client may pick instead.
     */
    encoding?: "base64" | "quoted-printable";
  })[],
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
    const encoding = part.encoding ?? "base64";
    const payload = partBytes(index, part.bytes ?? 96);
    lines.push(
      "--work-wiki-boundary",
      `Content-Type: ${part.mime}`,
      part.disposition ??
        (part.filename
          ? `Content-Disposition: attachment; filename="${part.filename}"`
          : "Content-Disposition: attachment"),
      `Content-Transfer-Encoding: ${encoding}`,
      "",
    );
    if (encoding === "base64") {
      lines.push(base64Lines(payload), "");
    } else {
      // No blank line after a quoted-printable body: the CRLF that opens the
      // boundary delimiter is the last line's terminator, and an extra one
      // decodes into a literal line break appended to the payload.
      lines.push(quotedPrintableLines(payload));
    }
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
 * Twenty-four parts, twelve of them supported: enough to push the recorded-name
 * list past its own 20 cap while the forwarding cap is also biting. This is the
 * fixture the old `attachmentNames.length - supportedAttachments.length`
 * subtraction got most wrong — it reported `20 - 10 = 10` skipped where fourteen
 * files were actually lost, and called two supported files unsupported.
 */
const OVER_NAME_CAP_PARTS: MixedPart[] = Array.from({ length: 24 }, (_, index) =>
  index % 2 === 0
    ? {
        filename: `keep-${index}.pdf`,
        mime: "application/pdf",
        parsedMime: "application/pdf",
        supported: true,
      }
    : {
        filename: `drop-${index}.exe`,
        mime: "application/octet-stream",
        parsedMime: "application/octet-stream",
        supported: false,
      },
);

const OVER_NAME_CAP_EMAIL = multipartEmail(OVER_NAME_CAP_PARTS, {
  subject: "Everything at once",
  messageId: "message-over-name-cap",
  body: "Twenty-four files attached.",
});

/**
 * The acknowledgement is the only place the sender learns that some of what
 * they attached did not make it in. Both counts and both plural forms are
 * pinned -- and the two losses are pinned *separately*: a supported file the
 * per-email cap dropped is not an unsupported one, and telling the sender it was
 * is a lie about their own file (DW-247).
 */
describe("email-ingest acknowledgement attachment counts", () => {
  it("separates the over-cap supported files from the unsupported ones", async () => {
    const { reply } = await forwardedForm(MIXED_EMAIL, "Mixed batch", "mixed-batch");
    expect(reply.text).toContain("10 supported attachments were queued for ingestion.");
    expect(reply.text).toContain(
      `1 supported attachment was not queued because this email exceeds the ${MAX_EMAIL_ATTACHMENTS}-attachment limit.`,
    );
    expect(reply.text).toContain("2 unsupported attachments were recorded but skipped.");
    // The exact wrong number the old subtraction produced: eleven supported
    // parts, ten forwarded, and the cast-off eleventh counted as unsupported.
    expect(reply.text).not.toContain("3 unsupported");
  });

  it("reports the true totals when there are more parts than the names cap", async () => {
    const { form, reply } = await forwardedForm(
      OVER_NAME_CAP_EMAIL,
      "Everything at once",
      "everything-at-once",
    );
    // The recorded-name list is still truncated -- that cap is unchanged.
    expect(form.getAll("attachmentName")).toHaveLength(
      MAX_EMAIL_ATTACHMENT_NAMES_RECORDED,
    );
    expect(reply.text).toContain("10 supported attachments were queued for ingestion.");
    expect(reply.text).toContain(
      `2 supported attachments were not queued because this email exceeds the ${MAX_EMAIL_ATTACHMENTS}-attachment limit.`,
    );
    expect(reply.text).toContain("12 unsupported attachments were recorded but skipped.");
    // `20 - 10`: what the truncated-list subtraction reported, understating the
    // loss by four files and mislabelling two more.
    expect(reply.text).not.toContain("10 unsupported");
  });

  it("reports the queued and skipped counts in the singular", async () => {
    const { reply } = await forwardedForm(SINGLE_SKIP_EMAIL, "One and one", "one-and-one");
    expect(reply.text).toContain("1 supported attachment was queued for ingestion.");
    expect(reply.text).toContain("1 unsupported attachment was recorded but skipped.");
    // Nothing was dropped by the cap, so no over-cap line at all -- not a zero.
    expect(reply.text).not.toContain("not queued because");
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
    expect(sent.text).not.toContain("not queued because");
  });
});

/**
 * The route re-derives nothing: whatever the Worker did not forward travels with
 * the message as one number. Without this field the route can only subtract a
 * 20-capped name list from a 10-capped file list and understate the loss.
 */
describe("email-ingest forwarded skipped count", () => {
  it("forwards the true total the sender was told about", async () => {
    const { form } = await forwardedForm(MIXED_EMAIL, "Mixed batch", "mixed-batch");
    // Two unsupported plus one supported file cut by the cap.
    expect(form.get("skippedAttachmentCount")).toBe("3");
  });

  it("forwards a total the truncated name list could not express", async () => {
    const { form } = await forwardedForm(
      OVER_NAME_CAP_EMAIL,
      "Everything at once",
      "everything-at-once",
    );
    // Twelve unsupported plus two over-cap -- above the 20-name list's own
    // arithmetic ceiling of `20 - 10`.
    expect(form.get("skippedAttachmentCount")).toBe("14");
  });

  it("forwards a zero when nothing was skipped", async () => {
    const { form } = await forwardedForm(ATTACHMENT_EMAIL, "Quarterly report", "quarterly-report");
    expect(form.get("skippedAttachmentCount")).toBe("0");
  });
});

/**
 * Inline MIME parts (DW-359). `postal-mime` surfaces a signature logo, an
 * embedded screenshot and a `cid:`-referenced graphic in `parsed.attachments`
 * exactly like a real attachment, so the loss accounting reported a sender's own
 * branded email footer back to them as an "unsupported attachment ... recorded
 * but skipped" — a sentence about a file they never attached and cannot remove.
 *
 * Built from real fixtures rather than a mocked parser: whether a
 * `Content-Disposition: inline` header actually reaches the Worker as
 * `disposition === "inline"` is a fact about PostalMime, and a stub would assert
 * the Worker's half of the contract while assuming the half that fails.
 */
describe("email-ingest inline parts", () => {
  /** A signature logo: inline, and not a format the door would take anyway. */
  const INLINE_LOGO = {
    filename: "logo.png",
    mime: "image/png",
    disposition: 'Content-Disposition: inline; filename="logo.png"',
  } as const;

  it("does not report an inline logo as a skipped attachment", async () => {
    const raw = multipartEmail([INLINE_LOGO, { filename: "report.pdf", mime: "application/pdf" }], {
      subject: "Signed off",
      messageId: "message-inline-beside",
      body: "The report is attached.",
    });
    const { form, reply } = await forwardedForm(raw, "Signed off", "signed-off");

    // Eligibility is untouched: the PDF still travels, with its own bytes.
    expect(form.getAll("attachments")).toHaveLength(1);
    expect((form.getAll("attachments")[0] as File).name).toBe("report.pdf");
    expect(new Uint8Array(await (form.getAll("attachments")[0] as File).arrayBuffer())).toEqual(
      partBytes(1),
    );

    // The inline part is not in the recorded name list. This is the assertion
    // that keeps the fix from being undone one surface downstream: the route
    // derives a `localSkipped` FLOOR from `attachmentNames.length -
    // attachments.length`, so a name here with no file behind it re-creates the
    // phantom skip in the app's own activity history.
    expect(form.getAll("attachmentName")).toEqual(["report.pdf"]);
    expect(form.get("skippedAttachmentCount")).toBe("0");

    expect(reply.text).toContain("1 supported attachment was queued for ingestion.");
    expect(reply.text).not.toContain("recorded but skipped");
    // The exact sentence the sender used to get, named so a regression cannot
    // pass by rewording it.
    expect(reply.text).not.toContain("1 unsupported attachment was recorded but skipped.");
  });

  it("tells a sender whose only part was an inline logo that there was no text", async () => {
    // No body and nothing forwardable, so this exits before the forward --
    // `forwardedForm` asserts a forward happened and cannot be used.
    const raw = multipartEmail([INLINE_LOGO], {
      subject: "Just a footer",
      messageId: "message-inline-only",
      body: "",
    });
    const msg = message(raw, "Just a footer");
    const bindings = env(Response.json({ ok: true, slug: "unused" }));
    await worker.email(
      msg as unknown as Parameters<typeof worker.email>[0],
      bindings as unknown as Parameters<typeof worker.email>[1],
    );

    expect(bindings.YOPEDIA.fetch).not.toHaveBeenCalled();
    const text = msg.reply.mock.calls[0][0].text;
    // The honest answer -- their message was empty. Keying this branch on
    // `parsed.attachments.length` instead answered with the supported-formats
    // list, telling the sender to convert a logo they did not attach.
    expect(text).toBe("work-wiki found no email text to ingest.");
    expect(text).not.toContain("supported document attachment");
    expect(text).not.toContain("Markdown, TXT, HTML");
  });

  it("still forwards an inline part that is itself a supported document", async () => {
    // Inline changes ACCOUNTING, not eligibility. A `.md` file a client marked
    // inline is still a document the sender meant to send, and dropping it would
    // trade one silent lie for a worse one.
    const raw = multipartEmail(
      [
        {
          filename: "notes.md",
          mime: "text/markdown",
          disposition: 'Content-Disposition: inline; filename="notes.md"',
        },
      ],
      { subject: "Inline notes", messageId: "message-inline-supported", body: "" },
    );
    const { form, reply } = await forwardedForm(raw, "Inline notes", "inline-notes");

    expect(form.getAll("attachments")).toHaveLength(1);
    expect((form.getAll("attachments")[0] as File).name).toBe("notes.md");
    expect(new Uint8Array(await (form.getAll("attachments")[0] as File).arrayBuffer())).toEqual(
      partBytes(0),
    );
    expect(reply.text).toContain("1 supported attachment was queued for ingestion.");
    // Forwarded but not named: it is not a loss, and it is not something the
    // sender listed either.
    expect(form.getAll("attachmentName")).toEqual([]);
    expect(form.get("skippedAttachmentCount")).toBe("0");
  });
});

/**
 * The post-decode aggregate budget (DW-360). `MAX_RAW_EMAIL_BYTES` is derived
 * from the WORST transfer encoding, so a sender who picks the CHEAP one gets
 * far more decoded bytes under the same raw gate than the budget the cap was
 * sized for -- and every one of those bytes was copied into `FormData` and held
 * in memory at once. Widening the door for DW-358/DW-362 without this bound
 * would have made that peak worse, not better.
 *
 * Base64 on purpose: it is the encoding that makes the gap reachable. A
 * quoted-printable message carrying this much decoded payload would be refused
 * at the door instead, and would test the raw gate rather than this bound.
 */
describe("email-ingest aggregate decoded budget", () => {
  /**
   * The budget as the acknowledgement quotes it, derived with the SAME floor
   * arithmetic production uses. A plain `/ 1024 / 1024` agrees with it only
   * because 20 MiB happens to be MiB-aligned today; the "rounded DOWN, so the
   * figure quoted is never larger than the one enforced" invariant is pinned for
   * `MAX_RAW_EMAIL_MB` and would otherwise be unpinned here.
   */
  const AGGREGATE_BUDGET_MB = Math.floor(MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES / 1024 / 1024);

  /**
   * Three parts that together exceed the budget, and a fourth that still fits
   * behind the one that does not.
   *
   * Each is under `MAX_EMAIL_DOCUMENT_BYTES`, so nothing here is refused for
   * being an oversized document -- the only thing under test is the aggregate.
   * The small tail part is what tells a `continue` from a `break`: a bound that
   * stopped at the first over-budget part would silently drop it too, and
   * whether a file survives would depend on what sat ahead of it rather than on
   * the budget.
   */
  const PART_BYTES = 7 * 1024 * 1024;

  /** Built once: ~28 MB of base64 is worth encoding a single time. */
  let overBudgetEmail: string | undefined;
  function overBudgetFixture(): string {
    overBudgetEmail ??= multipartEmail(
      [
        { filename: "big-1.pdf", mime: "application/pdf", bytes: PART_BYTES },
        { filename: "big-2.pdf", mime: "application/pdf", bytes: PART_BYTES },
        { filename: "big-3.pdf", mime: "application/pdf", bytes: PART_BYTES },
        { filename: "tail.pdf", mime: "application/pdf" },
      ],
      {
        subject: "Too much at once",
        messageId: "message-over-budget",
        body: "Four files attached.",
      },
    );
    return overBudgetEmail;
  }

  it("stops appending parts once the decoded budget is spent", async () => {
    // The premise, computed rather than assumed: two parts fit and three do not.
    // Stated here so a change to the budget or the part size fails loudly rather
    // than turning this case into a no-op that passes on an empty over-budget
    // list.
    expect(2 * PART_BYTES).toBeLessThanOrEqual(MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES);
    expect(3 * PART_BYTES).toBeGreaterThan(MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES);
    expect(PART_BYTES).toBeLessThan(MAX_EMAIL_DOCUMENT_BYTES);

    const { form, reply } = await forwardedForm(
      overBudgetFixture(),
      "Too much at once",
      "too-much-at-once",
    );

    const parts = form.getAll("attachments");
    // The leading two, plus the small tail that still fits behind the one that
    // did not. `big-3.pdf` is absent -- and the bytes it would have contributed
    // never reached the multipart body at all.
    expect(parts.map((part) => (part as File).name)).toEqual([
      "big-1.pdf",
      "big-2.pdf",
      "tail.pdf",
    ]);
    const forwardedBytes = (
      await Promise.all(parts.map((part) => (part as File).arrayBuffer()))
    ).reduce((total, buffer) => total + buffer.byteLength, 0);
    expect(forwardedBytes).toBeLessThanOrEqual(MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES);
    // The tail really is the fourth part's payload, not the third's shifted up.
    expect(new Uint8Array(await (parts[2] as File).arrayBuffer())).toEqual(partBytes(3));

    // Named and counted, not dropped in silence. The name list is unaffected --
    // the file was attached, it just was not queued.
    expect(form.getAll("attachmentName")).toEqual([
      "big-1.pdf",
      "big-2.pdf",
      "big-3.pdf",
      "tail.pdf",
    ]);
    expect(form.get("skippedAttachmentCount")).toBe("1");

    expect(reply.text).toContain("3 supported attachments were queued for ingestion.");
    expect(reply.text).toContain(
      `1 supported attachment was not queued because this email exceeds the ${AGGREGATE_BUDGET_MB} MB total attachment budget: big-3.pdf.`,
    );
    // It is its own kind of loss: the count cap never bit, and nothing failed
    // the allowlist. Reporting either would tell the sender to send fewer files
    // or a different format, neither of which would have helped.
    expect(reply.text).not.toContain("attachment limit");
    expect(reply.text).not.toContain("recorded but skipped");
    // Never larger than the budget actually enforced: a quoted figure above the
    // real one invites the sender to resend a message that bounces again.
    expect(AGGREGATE_BUDGET_MB * 1024 * 1024).toBeLessThanOrEqual(
      MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES,
    );
  });

  it("clears the raw gate, so the bound is the only thing that dropped a part", async () => {
    // Without this the case above could be passing because the message was
    // refused at the door, which would test DW-358's cap and not DW-360's bound.
    const raw = overBudgetFixture();
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThan(MAX_RAW_EMAIL_BYTES);
    // And the decoded payload really is over budget while the wire size is not:
    // the gap base64 opens under a cap derived from quoted-printable is exactly
    // what this bound exists to close.
    expect(4 * PART_BYTES).toBeGreaterThan(MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES);
  });

  /**
   * The exact boundary, as the raw gate has one. The bound is
   * `aggregateBytes + size > MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES`, so a selection
   * landing EXACTLY on the budget is forwarded whole and the next byte after it
   * is not -- a `>=` would drop a message that fits, invisibly to a
   * clearly-under / clearly-over pair.
   *
   * The same fixture carries the tail that pins the name cap: once the budget is
   * spent EVERY later eligible part is over budget, and the count cap never
   * fires because nothing more is selected, so this shape is exactly the one
   * that could name an unbounded list of files in one reply line.
   */
  const ON_BUDGET_HALF = MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES / 2;
  /** Enough over-budget parts to overflow the recorded-name cap and then some. */
  const OVERFLOW_PART_COUNT = MAX_EMAIL_ATTACHMENT_NAMES_RECORDED + 5;

  let onBudgetEmail: string | undefined;
  function onBudgetFixture(): string {
    onBudgetEmail ??= multipartEmail(
      [
        { filename: "half-1.pdf", mime: "application/pdf", bytes: ON_BUDGET_HALF },
        { filename: "half-2.pdf", mime: "application/pdf", bytes: ON_BUDGET_HALF },
        // ONE byte. The smallest thing the budget can refuse, and the only
        // payload size that tells `>` from `>=` at the boundary.
        { filename: "one-byte.pdf", mime: "application/pdf", bytes: 1 },
        ...Array.from({ length: OVERFLOW_PART_COUNT - 1 }, (_unused, index) => ({
          filename: `overflow-${index + 1}.pdf`,
          mime: "application/pdf",
        })),
      ],
      {
        subject: "Exactly full",
        messageId: "message-on-budget",
        body: "Two halves and a lot of stragglers.",
      },
    );
    return onBudgetEmail;
  }

  it("forwards a selection sitting exactly on the budget, and refuses the next byte", async () => {
    // The premise, computed rather than assumed.
    expect(2 * ON_BUDGET_HALF).toBe(MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES);

    const { form, reply } = await forwardedForm(onBudgetFixture(), "Exactly full", "exactly-full");
    const parts = form.getAll("attachments");
    // Both halves, and nothing else: the aggregate is spent to the byte.
    expect(parts.map((part) => (part as File).name)).toEqual(["half-1.pdf", "half-2.pdf"]);
    const forwardedBytes = (
      await Promise.all(parts.map((part) => (part as File).arrayBuffer()))
    ).reduce((total, buffer) => total + buffer.byteLength, 0);
    expect(forwardedBytes).toBe(MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES);
    // The one-byte part is refused. A `>=` gate would have dropped `half-2.pdf`
    // as well and this assertion would still pass on the first line alone --
    // hence the exact equality above.
    expect(parts.map((part) => (part as File).name)).not.toContain("one-byte.pdf");
    expect(reply.text).toContain("one-byte.pdf");
    // The count cap never bit: only two parts were ever selected.
    expect(reply.text).not.toContain("attachment limit");
  });

  it("caps the names it lists while still counting every dropped file", async () => {
    const { form, reply } = await forwardedForm(onBudgetFixture(), "Exactly full", "exactly-full");

    // The COUNT is the true total -- the cap truncates the naming, never the
    // accounting the route is handed.
    expect(form.get("skippedAttachmentCount")).toBe(String(OVERFLOW_PART_COUNT));
    expect(reply.text).toContain(
      `${OVERFLOW_PART_COUNT} supported attachments were not queued because this email exceeds the`,
    );

    const line = reply.text.split("\n").find((text) => text.includes("total attachment budget"));
    expect(line).toBeDefined();
    // Twenty names and a counted tail for the rest, not all twenty-five.
    const listed = /budget: (.*)\.$/.exec(line ?? "")?.[1] ?? "";
    const names = listed.split(", ");
    expect(names).toHaveLength(MAX_EMAIL_ATTACHMENT_NAMES_RECORDED + 1);
    expect(names.slice(0, MAX_EMAIL_ATTACHMENT_NAMES_RECORDED)).toEqual([
      "one-byte.pdf",
      ...Array.from(
        { length: MAX_EMAIL_ATTACHMENT_NAMES_RECORDED - 1 },
        (_unused, index) => `overflow-${index + 1}.pdf`,
      ),
    ]);
    expect(names[MAX_EMAIL_ATTACHMENT_NAMES_RECORDED]).toBe(
      `and ${OVERFLOW_PART_COUNT - MAX_EMAIL_ATTACHMENT_NAMES_RECORDED} others`,
    );
    // The last file really was left unnamed, so the cap is doing something.
    expect(line).not.toContain(`overflow-${OVERFLOW_PART_COUNT - 1}.pdf`);
  });

  it("does not claim nothing supported arrived when the only file was over budget", async () => {
    // DW-360 created a new way for `supportedAttachments` to be empty while
    // every part was a supported document. Keyed on the countable list, this
    // exit answered a sender whose only file was a single over-budget PDF with
    // "found no ... supported document attachment" plus the list of formats they
    // had already used -- and discarded the sentence naming their file.
    //
    // Called directly rather than through `forwardedForm`, which asserts a
    // forward happened: this branch deliberately forwards nothing.
    const raw = multipartEmail(
      [
        {
          filename: "enormous.pdf",
          mime: "application/pdf",
          bytes: MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES + 1,
        },
      ],
      { subject: "One enormous file", messageId: "message-over-budget-no-body", body: "" },
    );
    const msg = message(raw, "One enormous file");
    const bindings = env(Response.json({ ok: true, slug: "unused" }));
    await worker.email(
      msg as unknown as Parameters<typeof worker.email>[0],
      bindings as unknown as Parameters<typeof worker.email>[1],
    );

    // Nothing forwarded, and the raw gate is not what stopped it.
    expect(bindings.YOPEDIA.fetch).not.toHaveBeenCalled();
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThan(MAX_RAW_EMAIL_BYTES);

    const text = msg.reply.mock.calls[0][0].text;
    // The loss sentence survives to this exit at all -- it used to be computed
    // and thrown away here.
    expect(text).toContain("enormous.pdf");
    expect(text).toContain("total attachment budget");
    // And the honest lead sentence, NOT the allowlist one: nothing here failed
    // the allowlist, so listing supported formats would deny a fact the sender
    // can see two lines below it.
    expect(text).toContain("work-wiki found no email text to ingest.");
    expect(text).not.toContain("supported document attachment");
    expect(text).not.toContain("Markdown, TXT, HTML");
  });

  /**
   * Every loss at once (and the name scrubbing). `overCapCount` is computed as
   * `countable(eligible) - countable(supported) - overBudgetCount`, three terms
   * no other case drives together: the over-budget fixtures above leave
   * `overCapCount` at zero and the over-cap fixtures elsewhere leave
   * `overBudgetCount` at zero, so a sign error or a dropped term would pass on
   * both.
   *
   * The inline parts are load-bearing here rather than decorative: one is
   * ineligible (a signature logo) and one is an ELIGIBLE `.md` sitting past the
   * count cap, so replacing `countable(eligible)` with `eligible.length` reports
   * four over-cap losses instead of three.
   *
   * It is also where `replyAttachmentName` is pinned. A MIME `filename` is
   * attacker-controlled text and this is the first place this Worker
   * interpolates one into an outbound email body; RFC 2231 percent-encoding is
   * how CR/LF actually arrives (a tab would not test it -- the parser normalizes
   * tabs itself, so the reply would look scrubbed whether or not the Worker
   * scrubbed anything).
   */
  it("reports over-budget, over-cap and unsupported losses in one scrubbed acknowledgement", async () => {
    const FIRST_PART_BYTES = 19 * 1024 * 1024;
    const OVER_BUDGET_PART_BYTES = 2 * 1024 * 1024;
    // The premise: the first part fits and either of the next two does not.
    expect(FIRST_PART_BYTES).toBeLessThanOrEqual(MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES);
    expect(FIRST_PART_BYTES + OVER_BUDGET_PART_BYTES).toBeGreaterThan(
      MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES,
    );

    const OVER_CAP_EXTRAS = 3;
    const raw = multipartEmail(
      [
        { filename: "lead.pdf", mime: "application/pdf", bytes: FIRST_PART_BYTES },
        // An RFC 2231 encoded name that really does arrive carrying CR/LF.
        {
          filename: null,
          mime: "application/pdf",
          bytes: OVER_BUDGET_PART_BYTES,
          disposition: `Content-Disposition: attachment; filename*=utf-8''huge%0D%0A1.pdf`,
        },
        // No filename parameter at all: `postal-mime` reports `null`, which is
        // what drives the reply's own name fallback.
        { filename: null, mime: "application/pdf", bytes: OVER_BUDGET_PART_BYTES },
        // Inline and ineligible -- the signature logo DW-359 is about.
        {
          filename: "logo.png",
          mime: "image/png",
          disposition: 'Content-Disposition: inline; filename="logo.png"',
        },
        { filename: "program.exe", mime: "application/octet-stream" },
        // Nine more small supported files, filling the selection to the cap.
        ...Array.from({ length: MAX_EMAIL_ATTACHMENTS - 1 }, (_unused, index) => ({
          filename: `small-${index + 1}.pdf`,
          mime: "application/pdf",
        })),
        // Three past the cap.
        ...Array.from({ length: OVER_CAP_EXTRAS }, (_unused, index) => ({
          filename: `extra-${index + 1}.pdf`,
          mime: "application/pdf",
        })),
        // Inline AND eligible AND past the cap: countable only if the inline
        // filter is missing from the over-cap arithmetic.
        {
          filename: "notes.md",
          mime: "text/markdown",
          disposition: 'Content-Disposition: inline; filename="notes.md"',
        },
      ],
      { subject: "Every loss at once", messageId: "message-every-budget-loss", body: "Lots." },
    );
    const { form, reply } = await forwardedForm(raw, "Every loss at once", "every-loss-at-once");

    // Ten forwarded: the lead file plus the nine smalls. The two over-budget
    // parts never consumed a cap slot.
    expect(form.getAll("attachments")).toHaveLength(MAX_EMAIL_ATTACHMENTS);
    // 1 unsupported + 2 over budget + 3 over cap. The two inline parts are in
    // neither the count nor the names.
    expect(form.get("skippedAttachmentCount")).toBe(String(1 + 2 + OVER_CAP_EXTRAS));
    expect(form.getAll("attachmentName")).not.toContain("logo.png");
    expect(form.getAll("attachmentName")).not.toContain("notes.md");

    // All three loss sentences together, each with its own plural form and its
    // own reason -- an over-budget file is not an over-cap casualty and is not
    // an unsupported one.
    expect(reply.text).toContain(
      `2 supported attachments were not queued because this email exceeds the ${AGGREGATE_BUDGET_MB} MB total attachment budget: huge 1.pdf, unnamed attachment.`,
    );
    expect(reply.text).toContain(
      `${OVER_CAP_EXTRAS} supported attachments were not queued because this email exceeds the ${MAX_EMAIL_ATTACHMENTS}-attachment limit.`,
    );
    expect(reply.text).toContain("1 unsupported attachment was recorded but skipped.");

    // The CR/LF is gone, not merely rendered harmlessly: the sentence naming the
    // dropped files must stay ONE line.
    expect(reply.text).not.toContain("huge\r\n1.pdf");
    expect(
      reply.text.split("\n").filter((line) => line.includes("total attachment budget")),
    ).toHaveLength(1);
  });
});

/**
 * `message.rawSize` is counted before any MIME decoding, so the cap it is
 * compared against has to be big enough for an ENCODED full-size document. It
 * was not: 10 MB flat, which put the route's own `MAX_DOCUMENT_SIZE` gate out of
 * reach over email entirely (DW-104).
 */
describe("email-ingest raw message cap", () => {
  it("predicts a real fixture's encoded part length at every awkward length", () => {
    // Calibration. The parity test measures a full-size document against the cap
    // with `base64PartWireSize`; if that formula stopped describing how MIME is
    // actually written, the measurement would be fiction. So: apply it to
    // messages this suite really builds, and compare with the bytes on the page.
    //
    // Three lengths, because the formula has three ways to be wrong and 96 bytes
    // exercises none of them on its own:
    //   96  -- a multiple of 3 (no base64 padding) whose 128 characters end
    //          mid-line, so the last line is short;
    //   100 -- not a multiple of 3, so the encoder emits `=` padding and the
    //          character count is no longer a clean 4n/3;
    //   114 -- a multiple of 57, i.e. exactly 152 characters = two FULL 76-char
    //          lines. This is the boundary case a 10 MB document actually lands
    //          near, and the one a `ceil(chars / 76)` off-by-one would break:
    //          counting a phantom trailing line inflates the prediction here and
    //          nowhere else.
    const LENGTHS = [96, 100, 114];
    const raw = multipartEmail(
      LENGTHS.map((bytes, index) => ({
        filename: `part-${index}.pdf`,
        mime: "application/pdf",
        bytes,
      })),
      {
        subject: "Calibration",
        messageId: "message-calibration",
        body: "Three files attached.",
      },
    );

    // Read the encoded regions back out of the message rather than rebuilding
    // them: a calibration against a restatement of the formula would agree with
    // itself no matter how wrong both were.
    const marker = "Content-Transfer-Encoding: base64\r\n\r\n";
    const blocks: string[] = [];
    for (let cursor = 0; ; ) {
      const found = raw.indexOf(marker, cursor);
      if (found < 0) break;
      const start = found + marker.length;
      const end = raw.indexOf("\r\n\r\n--work-wiki-boundary", start);
      expect(end).toBeGreaterThan(start);
      // Through the CRLF that terminates the last base64 line -- exactly the
      // span the helper counts.
      blocks.push(raw.slice(start, end + 2));
      cursor = end;
    }

    expect(blocks).toHaveLength(LENGTHS.length);
    expect(blocks.map((block) => new TextEncoder().encode(block).byteLength)).toEqual(
      LENGTHS.map((bytes) => base64PartWireSize(bytes)),
    );
    // The padding case really is padded, and the multiple-of-57 case really does
    // end on a full line -- so the lengths above cannot silently stop being the
    // awkward ones.
    expect(blocks[1]).toContain("=");
    expect(blocks[2]?.split("\r\n")[1]).toHaveLength(76);
  });
  it("predicts a real quoted-printable fixture's part length at every awkward length", () => {
    // The same calibration for the formula the parity test now measures a
    // full-size document with. This side needs it more, not less: `base64Lines`
    // delegates to a real encoder, while `quotedPrintableLines` is hand-written,
    // so nothing but a comparison against bytes on the page keeps the pair
    // honest -- and the end-to-end case above is what keeps the encoding itself
    // honest by making PostalMime decode it.
    //
    // Three lengths, one per branch of the formula:
    //   96  -- three full lines plus a short remainder line (21 escapes);
    //   100 -- exactly four filled lines and no short tail, so the remainder
    //          term drops out entirely: charging for a phantom fifth line, or
    //          for a soft break the last line supposedly does not need, is the
    //          off-by-one this length and no other catches;
    //   1   -- no full line at all, so only the remainder term is exercised.
    const LENGTHS = [96, 100, 1];
    const raw = multipartEmail(
      LENGTHS.map((bytes, index) => ({
        filename: `part-${index}.csv`,
        mime: "text/csv",
        bytes,
        encoding: "quoted-printable" as const,
      })),
      {
        subject: "QP calibration",
        messageId: "message-qp-calibration",
        body: "Three files attached.",
      },
    );

    // Read the encoded regions back out of the message rather than rebuilding
    // them, for the same reason the base64 calibration does.
    const marker = "Content-Transfer-Encoding: quoted-printable\r\n\r\n";
    const blocks: string[] = [];
    for (let cursor = 0; ; ) {
      const found = raw.indexOf(marker, cursor);
      if (found < 0) break;
      const start = found + marker.length;
      // One CRLF, not two: a quoted-printable body sits flush against the
      // boundary, so the delimiter's CRLF terminates the last encoded line.
      const end = raw.indexOf("\r\n--work-wiki-boundary", start);
      expect(end).toBeGreaterThan(start);
      // Through that CRLF -- exactly the span the helper counts.
      blocks.push(raw.slice(start, end + 2));
      cursor = end;
    }

    expect(blocks).toHaveLength(LENGTHS.length);
    expect(blocks.map((block) => new TextEncoder().encode(block).byteLength)).toEqual(
      LENGTHS.map((bytes) => quotedPrintablePartWireSize(bytes)),
    );
    // The awkward lengths really are the awkward ones: a filled line is 76
    // characters ending in the `=` soft break, the 100-byte part's FINAL line is
    // filled too (four of them, no short tail), and every line -- last included
    // -- carries the soft break the round trip depends on.
    const first = blocks[0]?.split("\r\n") ?? [];
    expect(first[0]).toHaveLength(76);
    expect(first[3]).toHaveLength(64);
    const second = blocks[1]?.split("\r\n") ?? [];
    expect(second).toHaveLength(5);
    expect(second.slice(0, 4).map((line) => line.length)).toEqual([76, 76, 76, 76]);
    for (const block of blocks) {
      for (const line of block.split("\r\n").slice(0, -1)) {
        expect(line.endsWith("=")).toBe(true);
      }
    }
    // Worst case means worst case: every octet escaped, no literal payload
    // characters left in the block.
    expect(blocks[2]).toMatch(/^=[0-9A-F]{2}=\r\n$/);
  });

  it("forwards a message the size of a worst-case quoted-printable full-size document", async () => {
    // The cap's reason for existing, at the surface a sender actually feels: the
    // encoding `MAX_RAW_EMAIL_BYTES` is now derived from (DW-358). The parity
    // test pins the same document against the constant; this pins it against the
    // gate, which is where a sender learns whether their `.csv` was refused.
    const msg = {
      ...message(ATTACHMENT_EMAIL, "Quarterly report"),
      rawSize: quotedPrintablePartWireSize(MAX_EMAIL_DOCUMENT_BYTES),
    };
    const bindings = env(Response.json({ ok: true, slug: "quarterly-report" }));
    await worker.email(
      msg as unknown as Parameters<typeof worker.email>[0],
      bindings as unknown as Parameters<typeof worker.email>[1],
    );
    expect(bindings.YOPEDIA.fetch).toHaveBeenCalledOnce();
    expect(msg.reply.mock.calls[0][0].text).not.toContain("larger than");
  });

  it("forwards a message the size of a base64-encoded full-size document", async () => {
    const msg = {
      ...message(ATTACHMENT_EMAIL, "Quarterly report"),
      rawSize: base64PartWireSize(MAX_EMAIL_DOCUMENT_BYTES),
    };
    const bindings = env(Response.json({ ok: true, slug: "quarterly-report" }));
    await worker.email(
      msg as unknown as Parameters<typeof worker.email>[0],
      bindings as unknown as Parameters<typeof worker.email>[1],
    );
    expect(bindings.YOPEDIA.fetch).toHaveBeenCalledOnce();
    expect(msg.reply.mock.calls[0][0].text).not.toContain("larger than");
  });

  it("forwards a message carrying the whole aggregate attachment budget", async () => {
    // DW-362 at the gate, which is where a sender learns whether their ten
    // mid-size files were refused. The parity suite pins the same aggregate
    // against the constant; this pins it against `message.rawSize`, the only
    // surface the sender sees. Measured per part, because ten short final lines
    // cost more than one.
    const msg = {
      ...message(ATTACHMENT_EMAIL, "Quarterly report"),
      rawSize:
        MAX_EMAIL_ATTACHMENTS * quotedPrintablePartWireSize(AGGREGATE_DOCUMENT_AVERAGE_BYTES),
    };
    const bindings = env(Response.json({ ok: true, slug: "quarterly-report" }));
    await worker.email(
      msg as unknown as Parameters<typeof worker.email>[0],
      bindings as unknown as Parameters<typeof worker.email>[1],
    );
    expect(bindings.YOPEDIA.fetch).toHaveBeenCalledOnce();
    expect(msg.reply.mock.calls[0][0].text).not.toContain("larger than");
  });

  it("forwards a message sitting exactly on the cap", async () => {
    // The gate is `>`, and the refusal copy quotes the cap as the size a message
    // may not EXCEED. A `>=` would make that sentence false for exactly one byte
    // count -- invisible to a below/above pair of tests.
    const msg = {
      ...message(ATTACHMENT_EMAIL, "Quarterly report"),
      rawSize: MAX_RAW_EMAIL_BYTES,
    };
    const bindings = env(Response.json({ ok: true, slug: "quarterly-report" }));
    await worker.email(
      msg as unknown as Parameters<typeof worker.email>[0],
      bindings as unknown as Parameters<typeof worker.email>[1],
    );
    expect(bindings.YOPEDIA.fetch).toHaveBeenCalledOnce();
    expect(msg.reply.mock.calls[0][0].text).not.toContain("larger than");
  });

  it("refuses a genuinely oversized message and quotes a cap it really enforces", async () => {
    const msg = {
      ...message(ATTACHMENT_EMAIL, "Quarterly report"),
      rawSize: MAX_RAW_EMAIL_BYTES + 1,
    };
    const bindings = env(Response.json({ ok: true, slug: "quarterly-report" }));
    await worker.email(
      msg as unknown as Parameters<typeof worker.email>[0],
      bindings as unknown as Parameters<typeof worker.email>[1],
    );
    expect(bindings.YOPEDIA.fetch).not.toHaveBeenCalled();
    const text = msg.reply.mock.calls[0][0].text;
    expect(text).toContain("larger than");
    // The stale hardcoded figure, and any figure ABOVE the enforced cap: quoting
    // a limit larger than the one enforced invites the sender to resend a message
    // that will bounce again. Rounding must go down, not to nearest.
    expect(text).not.toContain("larger than 10 MB");
    const quoted = Number(/larger than ([\d.]+) MB/.exec(text)?.[1]);
    expect(Number.isFinite(quoted)).toBe(true);
    expect(quoted * 1024 * 1024).toBeLessThanOrEqual(MAX_RAW_EMAIL_BYTES);
  });

  it("bounces a full aggregate of documents carried alongside a maximal body", async () => {
    // The trade-off `MIME_ENVELOPE_HEADROOM_BYTES` records in its comment,
    // enforced instead of merely stated: the headroom covers part headers,
    // boundaries and an ORDINARY body, not a body at `MAX_EMAIL_CONTENT_CHARS`.
    // Both extremes at once do not fit, by design.
    //
    // Derived from the exported terms, never hand-typed, so it tracks the
    // constants rather than a snapshot of them.
    //
    // The sum is a conservative LOWER bound on the real wire size, not an
    // estimate of it: it adds a decoded character count to an encoded byte
    // count and charges nothing for the MIME envelope. A body of
    // `MAX_EMAIL_CONTENT_CHARS` characters occupies at least that many bytes on
    // the wire and usually more (UTF-8 multi-byte runes, quoted-printable
    // escapes), and headers and boundaries are pure addition on top. So the
    // real message is always at least this large -- the assertion cannot become
    // falsely true by the bound being loose.
    //
    // Measured on the quoted-printable wire size, because that is what
    // `MAX_RAW_EMAIL_BYTES` is derived from (DW-358): against a cap widened for
    // worst-case expansion, a base64 payload plus a maximal body fits
    // comfortably, so the base64 measurement would no longer be testing the
    // trade-off at all -- it would just be asserting a true-by-slack inequality.
    //
    // Re-derived at the AGGREGATE ceiling the cap now binds at (DW-362). The
    // trade-off is unchanged in kind, only in where it binds: one full-size
    // document plus a maximal body now fits with room to spare, so measuring
    // there would test nothing. Measured PER PART rather than by scaling one
    // part, for the same reason the parity suite measures it that way: ten short
    // final lines cost more than one.
    //
    // This still guards the trade-off AS RECORDED TODAY; it is not a veto on
    // widening the cap again. Re-derive the expectation from the constants if
    // the budget moves; do not read a failure here as a reason to leave the cap
    // alone.
    const aggregateWireSize =
      MAX_EMAIL_ATTACHMENTS * quotedPrintablePartWireSize(AGGREGATE_DOCUMENT_AVERAGE_BYTES);
    const rawSize = aggregateWireSize + MAX_EMAIL_CONTENT_CHARS;
    expect(rawSize).toBeGreaterThan(MAX_RAW_EMAIL_BYTES);
    // ...while the attachments ALONE are under it, so what this case proves is
    // the body/headroom trade-off and not an oversized aggregate.
    expect(aggregateWireSize).toBeLessThan(MAX_RAW_EMAIL_BYTES);

    const msg = { ...message(ATTACHMENT_EMAIL, "Quarterly report"), rawSize };
    const bindings = env(Response.json({ ok: true, slug: "quarterly-report" }));
    await worker.email(
      msg as unknown as Parameters<typeof worker.email>[0],
      bindings as unknown as Parameters<typeof worker.email>[1],
    );
    expect(bindings.YOPEDIA.fetch).not.toHaveBeenCalled();
    expect(msg.reply.mock.calls[0][0].text).toContain("larger than");
  });
});
