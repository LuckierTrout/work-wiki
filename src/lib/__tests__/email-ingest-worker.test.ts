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
 *    the body was entirely unobserved (DW-252) — and the SECOND site-URL trim,
 *    the one that builds the acknowledgement's links, with it (DW-363).
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
 *    own message (DW-359). They are excluded from ELIGIBILITY rather than from
 *    the accounting alone (DW-446), so an inline part of a supported format
 *    spends no attachment slot and no aggregate-budget bytes, and is never
 *    forwarded.
 *
 * 8. The post-decode aggregate byte budget — the bound on what the forwarding
 *    loop actually copies into `FormData`, which the widened raw cap makes
 *    load-bearing rather than incidental (DW-360).
 *
 * 9. The per-document byte ceiling — the pre-filter that keeps a single
 *    over-ceiling part from being forwarded into a 400 that costs the sender
 *    their body and every other attachment (DW-253).
 *
 * 10. The two misconfiguration early returns — missing service token and
 *     missing site URL — whose sender-visible replies no fixture could reach
 *     while `env()` supplied both bindings (DW-364).
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

  const TRANSPORT_SLUG = "quarterly-report";

  /**
   * Returns the forwarded `Request` AND the acknowledgement, because the site
   * URL is trimmed TWICE -- once to build the forward target, and again further
   * down to build the reply's links -- and the two trims are independent
   * expressions. Discarding `msg.reply` here left the second one unobserved:
   * deleting it kept every assertion below green while every sender got a page
   * link with a quadrupled slash in it (DW-363).
   */
  async function forwardedRequest(
    siteUrl: string,
    response: Response = Response.json({ ok: true, slug: TRANSPORT_SLUG }),
  ) {
    const msg = message(ATTACHMENT_EMAIL, "Quarterly report");
    const bindings = {
      ...env(response),
      YOPEDIA_SERVICE_TOKEN: TRANSPORT_TOKEN,
      YOPEDIA_SITE_URL: siteUrl,
    };
    await worker.email(
      msg as unknown as Parameters<typeof worker.email>[0],
      bindings as unknown as Parameters<typeof worker.email>[1],
    );
    expect(bindings.YOPEDIA.fetch).toHaveBeenCalledOnce();
    return {
      forwarded: bindings.YOPEDIA.fetch.mock.calls[0][0],
      reply: msg.reply.mock.calls[0][0] as { text: string },
    };
  }

  it("POSTs to the configured site's ingest endpoint as the service principal", async () => {
    const { forwarded } = await forwardedRequest(TRANSPORT_SITE);
    expect(forwarded.method).toBe("POST");
    expect(forwarded.url).toBe(`${TRANSPORT_SITE}/api/email/ingest`);
    // `Bearer ` included: the route's `getServicePrincipal` reads the scheme,
    // so a bare token authenticates as nobody and every email 401s.
    expect(forwarded.headers.get("Authorization")).toBe(`Bearer ${TRANSPORT_TOKEN}`);
  });

  it("builds the target from the configured site with its trailing slashes trimmed", async () => {
    const { forwarded } = await forwardedRequest(`${TRANSPORT_SITE}///`);
    // Not `https://ingest-edge.internal.test////api/email/ingest`.
    expect(forwarded.url).toBe(`${TRANSPORT_SITE}/api/email/ingest`);
  });

  it("builds the acknowledgement's page link from the same trimmed site", async () => {
    const { reply } = await forwardedRequest(`${TRANSPORT_SITE}///`);
    expect(reply.text).toContain(`Page: ${TRANSPORT_SITE}/u/yopedia/${TRANSPORT_SLUG}`);
    // The `//` in `https://` is the only doubled slash a correct link carries,
    // so this catches an untrimmed site anywhere in the reply -- a link the
    // sender clicks and lands nowhere.
    expect(reply.text).not.toContain("///");
  });

  it("builds the slugless Recent ingests link from the same trimmed site", async () => {
    // No slug, so the acknowledgement's OTHER link fires. Both are built from
    // the same trimmed `site`, but they are separate template strings: pinning
    // one leaves the other free to be written against the raw binding.
    const { reply } = await forwardedRequest(
      `${TRANSPORT_SITE}///`,
      Response.json({ ok: true, jobId: "job-transport-1" }),
    );
    expect(reply.text).toContain(`Track it under Recent ingests: ${TRANSPORT_SITE}/ingest`);
    expect(reply.text).not.toContain("///");
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
 * The per-document byte ceiling (DW-253). The Worker knows a part's decoded size
 * only after PostalMime has decoded it, so nothing filtered on it at all: an
 * oversized part was forwarded, the route 400d the whole message, and the sender
 * lost their body and every other attachment to one bad file. They also paid for
 * the bounce.
 *
 * These fixtures carry a genuinely over-ceiling part rather than a stubbed size:
 * the filter reads the same `decodedByteLength` the aggregate budget reads, and
 * a mocked parser would observe the filter without observing that a real
 * `application/pdf` part of that size arrives measurable at all.
 *
 * Each fixture is built inside the test that uses it and used exactly once, so
 * ~14 MB of base64 per oversized part is garbage as soon as its case finishes
 * rather than being held for the file's lifetime.
 */
describe("email-ingest oversized attachments", () => {
  /** One byte over -- the gate is `>`, so this is the smallest refused document. */
  const OVERSIZED_BYTES = MAX_EMAIL_DOCUMENT_BYTES + 1;
  /** The ceiling as the reply writes it, and as `/api/email/ingest` writes it. */
  const CEILING_MB = MAX_EMAIL_DOCUMENT_BYTES / 1024 / 1024;

  it("never forwards an oversized part, and names it in the acknowledgement", async () => {
    /** One oversized supported part, one small supported part, and a body. */
    const raw = multipartEmail(
      [
        { filename: "huge.pdf", mime: "application/pdf", bytes: OVERSIZED_BYTES },
        { filename: "solo.pdf", mime: "application/pdf" },
      ],
      {
        subject: "One too big",
        messageId: "message-oversized-among-good",
        body: "One of these is enormous.",
      },
    );
    const { form, reply } = await forwardedForm(raw, "One too big", "one-too-big");
    const parts = form.getAll("attachments");
    expect(parts).toHaveLength(1);
    expect((parts[0] as File).name).toBe("solo.pdf");
    // Index 1 among the parsed parts -- the pairing survives the file dropped
    // ahead of it.
    expect(new Uint8Array(await (parts[0] as File).arrayBuffer())).toEqual(partBytes(1));

    // The name is still recorded even though the bytes were not forwarded.
    expect(form.getAll("attachmentName")).toEqual(["huge.pdf", "solo.pdf"]);
    expect(form.get("skippedAttachmentCount")).toBe("1");
    expect(form.get("content")).toBe("One of these is enormous.");

    expect(reply.text).toContain(
      `1 attachment was not queued because it is larger than ${CEILING_MB} MB: huge.pdf.`,
    );
    expect(CEILING_MB).toBe(10);
    // The surviving file is still reported as queued -- the message was not
    // refused wholesale.
    expect(reply.text).toContain("1 supported attachment was queued for ingestion.");
    // Nothing was unsupported, nothing hit the cap and nothing hit the aggregate
    // budget, so none of those sentences fires: an oversized file is its own
    // kind of loss, and reporting it as any of the others tells the sender to
    // make a change that would not have helped.
    expect(reply.text).not.toContain("recorded but skipped");
    expect(reply.text).not.toContain("attachment limit");
    expect(reply.text).not.toContain("total attachment budget");
  });

  /**
   * The no-body early return. `parsed.attachments.length` was the wrong thing to
   * key the lead sentence on: a sender whose ONLY attachment was a supported PDF
   * that happened to be too big was told work-wiki "found no ... supported
   * document attachment", two paragraphs above a sentence naming that same PDF.
   *
   * Called directly rather than through `forwardedForm`, which asserts a forward
   * happened -- this branch deliberately forwards nothing.
   */
  it("does not claim nothing supported arrived when the file was merely too big", async () => {
    const raw = multipartEmail(
      [{ filename: "huge.pdf", mime: "application/pdf", bytes: OVERSIZED_BYTES }],
      { subject: "Just the whale", messageId: "message-oversized-no-body", body: "" },
    );
    const msg = message(raw, "Just the whale");
    const bindings = env(Response.json({ ok: true, slug: "unused" }));
    await worker.email(
      msg as unknown as Parameters<typeof worker.email>[0],
      bindings as unknown as Parameters<typeof worker.email>[1],
    );

    // Nothing survived the size filter, so nothing is forwarded -- and the route
    // never sees a message it could only 400. The raw gate is not what stopped
    // it: one full-size document has to fit under the cap by construction.
    expect(bindings.YOPEDIA.fetch).not.toHaveBeenCalled();
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThan(MAX_RAW_EMAIL_BYTES);
    const text = msg.reply.mock.calls[0][0].text;
    expect(text).toContain("huge.pdf");
    expect(text).toContain(`larger than ${CEILING_MB} MB`);
    // The honest lead sentence, and NOT the allowlist one: nothing here failed
    // the allowlist, so listing supported formats would answer a question the
    // sender did not ask and deny a fact they can see.
    expect(text).toContain("work-wiki found no email text to ingest.");
    expect(text).not.toContain("supported document attachment");
    expect(text).not.toContain("Markdown, TXT, HTML");
  });

  it("does not let an oversized part consume a cap slot", async () => {
    /**
     * The oversized part comes FIRST, deliberately: if the byte filter ran after
     * the count cap it would eat a slot and only nine of the ten small files
     * would be forwarded. With it last, that ordering bug is invisible.
     */
    const raw = multipartEmail(
      [
        { filename: "huge.pdf", mime: "application/pdf", bytes: OVERSIZED_BYTES },
        ...Array.from({ length: MAX_EMAIL_ATTACHMENTS }, (_unused, index) => ({
          filename: `small-${index + 1}.pdf`,
          mime: "application/pdf",
        })),
      ],
      {
        subject: "Ten and a whale",
        messageId: "message-oversized-at-cap",
        body: "Ten small files and one enormous one.",
      },
    );
    const { form, reply } = await forwardedForm(raw, "Ten and a whale", "ten-and-a-whale");
    const parts = form.getAll("attachments");
    // All ten small files, not nine.
    expect(parts).toHaveLength(MAX_EMAIL_ATTACHMENTS);
    expect(parts.map((part) => (part as File).name)).toEqual(
      Array.from({ length: MAX_EMAIL_ATTACHMENTS }, (_unused, index) => `small-${index + 1}.pdf`),
    );
    expect(form.get("skippedAttachmentCount")).toBe("1");

    expect(reply.text).toContain(
      `${MAX_EMAIL_ATTACHMENTS} supported attachments were queued for ingestion.`,
    );
    expect(reply.text).toContain("huge.pdf");
    expect(reply.text).toContain(`larger than ${CEILING_MB} MB`);
    // The cap never bit, so the over-cap sentence must not appear -- reporting a
    // dropped oversized file as an over-cap casualty tells the sender to send
    // fewer files, which would not have helped. This is the assertion that pins
    // the `- oversizedCount` term in the over-cap residue.
    expect(reply.text).not.toContain("attachment limit");
  });

  /**
   * Oversized, over-cap and unsupported in one acknowledgement, with the inline
   * exclusion (DW-359) live throughout. No other fixture drives those three
   * together, so the plural oversize wording, the `"unnamed attachment"`
   * fallback and the CR/LF scrubbing were all unobserved -- and a dropped term
   * in `overCapCount` would pass on every case that drives only two of them.
   *
   * The aggregate budget (DW-360) is deliberately NOT in play: the oversized
   * pair never reaches the selection loop, and eleven 96-byte parts cannot spend
   * a 20 MiB budget. Its own three-way case lives next door.
   */
  it("reports oversized, over-cap and unsupported losses in one scrubbed acknowledgement", async () => {
    const raw = multipartEmail(
      [
        // An RFC 2231 encoded name that really does arrive carrying CR/LF. This
        // is the whole attack: the filename is attacker-controlled text that
        // lands in an outbound email body, and interpolated raw it forges extra
        // lines in the acknowledgement. A tab does NOT test this -- the parser
        // normalizes tabs to spaces itself, so the reply would look scrubbed
        // whether or not the worker scrubbed anything.
        {
          filename: null,
          mime: "application/pdf",
          bytes: OVERSIZED_BYTES,
          disposition: `Content-Disposition: attachment; filename*=utf-8''huge%0D%0A1.pdf`,
        },
        // No filename parameter: `postal-mime` reports `null`, which is what
        // drives the reply's own name fallback.
        { filename: null, mime: "application/pdf", bytes: OVERSIZED_BYTES },
        { filename: "program.exe", mime: "application/octet-stream" },
        { filename: "clip.mov", mime: "video/quicktime" },
        // Inline and ineligible -- the signature logo DW-359 is about. It is in
        // neither the counts nor the names.
        {
          filename: "logo.png",
          mime: "image/png",
          disposition: 'Content-Disposition: inline; filename="logo.png"',
        },
        ...Array.from({ length: MAX_EMAIL_ATTACHMENTS + 1 }, (_unused, index) => ({
          filename: `small-${index + 1}.pdf`,
          mime: "application/pdf",
        })),
      ],
      {
        subject: "Too big and too many",
        messageId: "message-every-loss",
        body: "Two whales, two duds and eleven small ones.",
      },
    );
    const { form, reply } = await forwardedForm(
      raw,
      "Too big and too many",
      "too-big-and-too-many",
    );

    // Ten forwarded: the oversized pair never competed for a slot, so the cap
    // cut exactly one within-ceiling file.
    expect(form.getAll("attachments")).toHaveLength(MAX_EMAIL_ATTACHMENTS);
    // 2 oversized + 2 unsupported + 1 over-cap, as one number. The inline logo
    // is in none of them.
    expect(form.get("skippedAttachmentCount")).toBe("5");
    expect(form.getAll("attachmentName")).not.toContain("logo.png");

    expect(reply.text).toContain(
      `${MAX_EMAIL_ATTACHMENTS} supported attachments were queued for ingestion.`,
    );
    // All three loss sentences together, each with its own plural form and its
    // own reason -- an oversized file is not an over-cap casualty and is not an
    // unsupported one.
    expect(reply.text).toContain(
      `2 attachments were not queued because they are larger than ${CEILING_MB} MB: huge 1.pdf, unnamed attachment.`,
    );
    expect(reply.text).toContain(
      `1 supported attachment was not queued because this email exceeds the ${MAX_EMAIL_ATTACHMENTS}-attachment limit.`,
    );
    expect(reply.text).toContain("2 unsupported attachments were recorded but skipped.");
    expect(reply.text).not.toContain("total attachment budget");

    // The CR/LF is gone, not merely rendered harmlessly: the sentence naming the
    // dropped files must stay ONE line.
    expect(reply.text).not.toContain("huge\r\n1.pdf");
    expect(
      reply.text.split("\n").filter((line) => line.includes("larger than")),
    ).toHaveLength(1);
  });

  // NOT pinned here: the counted-name tail. `oversizedLine` and `overBudgetLine`
  // are built by the same `replyLossNames` helper, whose 20-name cap is pinned
  // by the over-budget suite next door -- and it is unreachable from an oversize
  // fixture anyway, because 21 parts each over `MAX_EMAIL_DOCUMENT_BYTES` are
  // ~300 MB on the wire and are refused by the raw gate long before a reply line
  // could be built for them.
});

/**
 * A body plus attachments the door refuses, end to end: the zero-attachment
 * form, the absent "queued" sentence, and the skipped total. Every prior
 * all-unsupported fixture in this suite carried at least one supported file
 * alongside, so the shape the Worker actually forwards when NOTHING is
 * forwardable -- a form with no `attachments` parts at all -- was never observed
 * (DW-253).
 */
describe("email-ingest body with only unsupported attachments", () => {
  const ALL_UNSUPPORTED_EMAIL = multipartEmail(
    [
      { filename: "program.exe", mime: "application/octet-stream" },
      { filename: "clip.mov", mime: "video/quicktime" },
    ],
    {
      subject: "Nothing usable",
      messageId: "message-all-unsupported",
      body: "The notes are in this email body.",
    },
  );

  it("forwards the body with no attachment parts and reports every skip", async () => {
    const { form, reply } = await forwardedForm(
      ALL_UNSUPPORTED_EMAIL,
      "Nothing usable",
      "nothing-usable",
    );
    expect(form.getAll("attachments")).toHaveLength(0);
    expect(form.get("content")).toBe("The notes are in this email body.");
    // Both names travel even though neither file does.
    expect(form.getAll("attachmentName")).toEqual(["program.exe", "clip.mov"]);
    expect(form.get("skippedAttachmentCount")).toBe("2");

    // No "queued for ingestion" line at all -- not a "0 supported attachments"
    // one, which is what a missing `supportedAttachments.length` guard produces.
    expect(reply.text).not.toContain("queued for ingestion");
    expect(reply.text).toContain("2 unsupported attachments were recorded but skipped.");
    expect(reply.text).not.toContain("attachment limit");
    expect(reply.text).not.toContain("larger than");
  });
});

/**
 * Inline MIME parts (DW-359, DW-446). `postal-mime` surfaces a signature logo,
 * an embedded screenshot and a `cid:`-referenced graphic in `parsed.attachments`
 * exactly like a real attachment, so the loss accounting reported a sender's own
 * branded email footer back to them as an "unsupported attachment ... recorded
 * but skipped" — a sentence about a file they never attached and cannot remove.
 *
 * DW-359 excluded them from the ACCOUNTING only, which left an inline part of a
 * SUPPORTED format still eligible: it spent a `MAX_EMAIL_ATTACHMENTS` slot and
 * aggregate-budget bytes while being excluded from every sentence that could
 * explain where they went. DW-446 moves the exclusion up to eligibility, so an
 * inline part costs the sender nothing at all — the cases below pin both halves.
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

  it("does not forward an inline part that is itself a supported document", async () => {
    // The case DW-446 reverses. This used to be forwarded on the theory that a
    // `.md` a client marked inline is still a document the sender meant to send
    // -- but the same part was then excluded from every loss sentence, so it
    // spent a slot and budget bytes that no reply could account for. Excluding
    // it entirely is the only reading under which the counts the sender is shown
    // describe the message the sender actually sent.
    //
    // Nothing forwardable and no body, so this exits before the forward and
    // `forwardedForm` -- which asserts a forward happened -- cannot be used.
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
    const msg = message(raw, "Inline notes");
    const bindings = env(Response.json({ ok: true, slug: "inline-notes" }));
    await worker.email(
      msg as unknown as Parameters<typeof worker.email>[0],
      bindings as unknown as Parameters<typeof worker.email>[1],
    );

    expect(bindings.YOPEDIA.fetch).not.toHaveBeenCalled();
    const text = msg.reply.mock.calls[0][0].text;
    // Not forwarded, not named, and not reported as a loss either: the sender
    // is told their message was empty, which it was. Nothing countable failed
    // the allowlist here, so `unsupportedCount` is zero and the branch keyed on
    // it stays the plain no-text sentence rather than the supported-formats
    // list, which would tell them to convert a file already in a supported
    // format.
    expect(text).toBe("work-wiki found no email text to ingest.");
    expect(text).not.toContain("recorded but skipped");
    expect(text).not.toContain("queued for ingestion");
    expect(text).not.toContain("Markdown, TXT, HTML");
  });

  it("spends no attachment slot on inline parts of a supported format", async () => {
    // The defect DW-446 is about, in the shape that is actually reachable: the
    // ledger's "three inline logos and nine real PDFs" cannot reproduce it,
    // because `image/png` is not in the allowlist and a logo was never eligible.
    // An inline `.md` preview IS eligible, so three of them ate three of the ten
    // slots -- and the two PDFs pushed past the cap were reported as an
    // "attachment limit" the sender never came close to reaching with nine files.
    const INLINE_LOGOS = 2;
    const INLINE_PREVIEWS = 3;
    const REAL_PDFS = MAX_EMAIL_ATTACHMENTS - 1;
    // The premise: inline parts plus real ones exceed the cap, the real ones
    // alone do not. Both halves have to hold or the case proves nothing.
    expect(REAL_PDFS).toBeLessThan(MAX_EMAIL_ATTACHMENTS);
    expect(INLINE_PREVIEWS + REAL_PDFS).toBeGreaterThan(MAX_EMAIL_ATTACHMENTS);
    // ...and more than one real PDF, so the PLURAL in the queued sentence
    // asserted below is sound rather than incidentally right.
    expect(REAL_PDFS).toBeGreaterThan(1);

    const raw = multipartEmail(
      [
        // Order is load-bearing. The selection loop consumes parts in SOURCE
        // order, so the inline parts have to come FIRST: listed last they would
        // fall past the cap on their own and every real PDF would survive even
        // against the pre-DW-446 code, leaving this case passing on the defect
        // it exists to pin.
        //
        // The logos are the ledger's own literal shape -- inline decoration
        // beside real files -- pinned positively here rather than only by the
        // DW-359 case above. They never spent a slot even before the fix
        // (`image/png` is not in the allowlist, so a logo was never eligible),
        // which is exactly why they cannot carry this case alone.
        ...Array.from({ length: INLINE_LOGOS }, (_unused, index) => ({
          filename: `logo-${index + 1}.png`,
          mime: "image/png",
          disposition: `Content-Disposition: inline; filename="logo-${index + 1}.png"`,
        })),
        ...Array.from({ length: INLINE_PREVIEWS }, (_unused, index) => ({
          filename: `preview-${index + 1}.md`,
          mime: "text/markdown",
          disposition: `Content-Disposition: inline; filename="preview-${index + 1}.md"`,
        })),
        ...Array.from({ length: REAL_PDFS }, (_unused, index) => ({
          filename: `real-${index + 1}.pdf`,
          mime: "application/pdf",
        })),
      ],
      { subject: "Nine files", messageId: "message-inline-slots", body: "Nine files attached." },
    );
    const { form, reply } = await forwardedForm(raw, "Nine files", "nine-files");

    // Every real PDF travels. Under the old ordering the last two lost their
    // slots to the previews.
    expect((form.getAll("attachments") as File[]).map((part) => part.name)).toEqual(
      Array.from({ length: REAL_PDFS }, (_unused, index) => `real-${index + 1}.pdf`),
    );
    expect(form.getAll("attachmentName")).toEqual(
      Array.from({ length: REAL_PDFS }, (_unused, index) => `real-${index + 1}.pdf`),
    );
    expect(form.get("skippedAttachmentCount")).toBe("0");

    expect(reply.text).toContain(
      `${REAL_PDFS} supported attachments were queued for ingestion.`,
    );
    // The exact lie this entry exists to remove.
    expect(reply.text).not.toContain("attachment limit");
    expect(reply.text).not.toContain("recorded but skipped");
    // Every count and name the sender sees describes the nine files they
    // actually attached -- no decoration of either kind appears anywhere.
    expect(reply.text).not.toContain("logo-1.png");
    expect(reply.text).not.toContain("preview-1.md");
  });

  it("spends no aggregate budget on an inline part of a supported format", async () => {
    // The second charge an inline part used to levy. Sized so the inline part
    // alone is the difference between both real PDFs fitting and the second one
    // being refused: if inline bytes are still charged, `real-2.pdf` is dropped
    // and the sender is told they exceeded a budget their own two files are
    // comfortably inside.
    //
    // A real MIME fixture, against the cost convention recorded in
    // `email-ingest-worker-normalization.test.ts` (`describe("email-ingest
    // oversized inline parts")`): a mocked 10 MiB part is one allocation, this
    // is ~28 MB of base64 on every run. That convention is about parts whose
    // disposition is incidental to the case. Here the disposition IS the case --
    // whether a `Content-Disposition: inline` header survives PostalMime as
    // `disposition === "inline"` is a fact about the parser, and a mock that
    // sets the field directly would assert the Worker's half of the contract
    // while assuming the half that fails.
    const INLINE_BYTES = MAX_EMAIL_DOCUMENT_BYTES;
    // The `+ 1` is the smallest per-part bump that puts the trio over the
    // budget: without it the three parts land EXACTLY on it, and the gate is
    // `>`, so even the pre-fix code would have forwarded both real PDFs and this
    // case would prove nothing. Both real parts carry the bump, so the total
    // sits two bytes over -- the least an equal-sized pair can overshoot by.
    const REAL_BYTES = Math.floor(
      (MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES - INLINE_BYTES) / 2 + 1,
    );
    // The premise, computed rather than assumed.
    expect(REAL_BYTES).toBeGreaterThan(0);
    expect(REAL_BYTES).toBeLessThanOrEqual(MAX_EMAIL_DOCUMENT_BYTES);
    expect(2 * REAL_BYTES).toBeLessThanOrEqual(MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES);
    expect(INLINE_BYTES + 2 * REAL_BYTES).toBeGreaterThan(
      MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES,
    );

    const raw = multipartEmail(
      [
        // Order is load-bearing, as in the slot case above: the selection loop
        // spends the budget in SOURCE order, so the inline part has to be
        // charged FIRST for its bytes to be what pushes `real-2.pdf` out.
        // Listed last it would itself be the part refused for the budget under
        // the old code, and both real PDFs would travel either way.
        {
          filename: "preview.pdf",
          mime: "application/pdf",
          bytes: INLINE_BYTES,
          disposition: 'Content-Disposition: inline; filename="preview.pdf"',
        },
        { filename: "real-1.pdf", mime: "application/pdf", bytes: REAL_BYTES },
        { filename: "real-2.pdf", mime: "application/pdf", bytes: REAL_BYTES },
      ],
      { subject: "Two files", messageId: "message-inline-budget", body: "Two files attached." },
    );
    // The fixture clears the raw gate, so the eligibility filter is the only
    // thing that decided anything here. Without this a change to either byte
    // constant could slide the message over `MAX_RAW_EMAIL_BYTES` and silently
    // turn this into a DW-358 door test that never reaches the filter at all.
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThan(MAX_RAW_EMAIL_BYTES);
    const { form, reply } = await forwardedForm(raw, "Two files", "two-files");

    const parts = form.getAll("attachments") as File[];
    expect(parts.map((part) => part.name)).toEqual(["real-1.pdf", "real-2.pdf"]);
    // The inline bytes were never copied into `FormData` -- not merely absent
    // from the name list. What travels is the two real files and nothing else.
    const forwardedBytes = (
      await Promise.all(parts.map((part) => part.arrayBuffer()))
    ).reduce((total, buffer) => total + buffer.byteLength, 0);
    expect(forwardedBytes).toBe(2 * REAL_BYTES);

    expect(form.getAll("attachmentName")).toEqual(["real-1.pdf", "real-2.pdf"]);
    expect(form.get("skippedAttachmentCount")).toBe("0");
    expect(reply.text).toContain("2 supported attachments were queued for ingestion.");
    expect(reply.text).not.toContain("total attachment budget");
    expect(reply.text).not.toContain("larger than");
  });

  it("ingests the body of a message whose only part is an inline document", async () => {
    // The reachable middle shape, and the one likeliest to arrive as a bug
    // report. The cases above cover the two ends -- an inline document with no
    // body at all, and inline parts beside real files -- and this is neither: a
    // body that ingests perfectly well, with one inline `.md` alongside it. It
    // was unasserted in EITHER direction, so both "the body was dropped with the
    // part" and "the part was forwarded anyway" would have shipped green.
    //
    // The forward must happen, because there is text to ingest, and it must
    // carry no attachment and no attachment sentence of any kind.
    const raw = multipartEmail(
      [
        {
          filename: "preview.md",
          mime: "text/markdown",
          disposition: 'Content-Disposition: inline; filename="preview.md"',
        },
      ],
      {
        subject: "Body and a preview",
        messageId: "message-inline-with-body",
        body: "The decision is recorded in this body.",
      },
    );
    const { form, reply } = await forwardedForm(raw, "Body and a preview", "body-and-a-preview");

    expect(form.get("content")).toBe("The decision is recorded in this body.");
    expect(form.getAll("attachments")).toHaveLength(0);
    expect(form.getAll("attachmentName")).toEqual([]);
    expect(form.get("skippedAttachmentCount")).toBe("0");

    // Not one attachment sentence, of any kind: the sender attached nothing, so
    // there is nothing to report queued and nothing to report lost. All four
    // loss terms are named so a regression cannot pass by picking a different
    // one of them.
    expect(reply.text).not.toContain("queued for ingestion");
    expect(reply.text).not.toContain("recorded but skipped");
    expect(reply.text).not.toContain("attachment limit");
    expect(reply.text).not.toContain("larger than");
    expect(reply.text).not.toContain("total attachment budget");
    expect(reply.text).not.toContain("preview.md");
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

  it("cannot strand a sender at the no-body exit with an over-budget loss", async () => {
    // DW-360 created a new way for `supportedAttachments` to be empty while
    // every part was a supported document -- a single file above the whole
    // budget -- and this suite pinned the no-body exit against exactly that
    // shape. DW-253's per-document ceiling then CLOSED it: the ceiling partition
    // runs before the selection loop, and `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES`
    // is floored at `MAX_EMAIL_DOCUMENT_BYTES` by its own `Math.max`, so any
    // part big enough to spend the budget alone is refused as oversized first
    // and never becomes an over-budget loss at all.
    //
    // The arithmetic is asserted rather than described, so if that relationship
    // ever inverts -- an aggregate budget below the per-file ceiling -- this
    // fails and says the over-budget branch of the no-body exit is reachable
    // again and owes a behavioural test. The Worker keeps `overBudgetLine` at
    // that exit for the same reason.
    expect(MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES).toBeGreaterThanOrEqual(MAX_EMAIL_DOCUMENT_BYTES);

    // What a sender who sends that file gets instead, observed end to end: the
    // oversize sentence, not the budget one. The honest lead sentence is pinned
    // beside it in `email-ingest oversized attachments`.
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
    expect(text).toContain(
      `larger than ${MAX_EMAIL_DOCUMENT_BYTES / 1024 / 1024} MB`,
    );
    expect(text).not.toContain("total attachment budget");
    // And the honest lead sentence, NOT the allowlist one: nothing here failed
    // the allowlist, so listing supported formats would deny a fact the sender
    // can see two lines below it.
    expect(text).toContain("work-wiki found no email text to ingest.");
    expect(text).not.toContain("supported document attachment");
    expect(text).not.toContain("Markdown, TXT, HTML");
  });

  /**
   * Every loss at once (and the name scrubbing). `overCapCount` is computed as
   * `eligible.length - supported.length - oversizedCount - overBudgetCount`,
   * four terms no other case drives together: the over-budget fixtures above
   * leave `overCapCount` at zero and the over-cap fixtures elsewhere leave
   * `overBudgetCount` at zero, so a sign error or a dropped term would pass on
   * both.
   *
   * The inline parts are load-bearing here rather than decorative: one is
   * ineligible (a signature logo) and one is a SUPPORTED-format `.md` sitting
   * past the count cap. Deriving `eligibleAttachments` from `parsed.attachments`
   * rather than from the countable list puts that `.md` back into the selection
   * arithmetic and reports four over-cap losses instead of three (DW-446).
   *
   * It is also where `replyAttachmentName` is pinned. A MIME `filename` is
   * attacker-controlled text and this is the first place this Worker
   * interpolates one into an outbound email body; RFC 2231 percent-encoding is
   * how CR/LF actually arrives (a tab would not test it -- the parser normalizes
   * tabs itself, so the reply would look scrubbed whether or not the Worker
   * scrubbed anything).
   */
  it("reports over-budget, over-cap and unsupported losses in one scrubbed acknowledgement", async () => {
    // A PAIR of leads, filling the budget to within `HEADROOM`. Two rather than
    // one because no single part may exceed `MAX_EMAIL_DOCUMENT_BYTES` any more
    // (DW-253) -- a lead above the ceiling is refused as oversized and never
    // charged against the budget at all, which would leave the budget unspent
    // and this case testing nothing.
    //
    // The headroom is what lets the two losses coexist: once the budget is fully
    // SPENT every later part is over budget and the count cap can never bite, so
    // the gap left after the leads has to be wide enough for the small files
    // that finish the selection and narrow enough that the mid-size ones do not
    // fit. The first lead sits EXACTLY on the ceiling, which also pins the
    // per-document gate as `>` rather than `>=`.
    const HEADROOM = 1024 * 1024;
    const LEAD_PART_BYTES = MAX_EMAIL_DOCUMENT_BYTES;
    const SECOND_LEAD_BYTES =
      MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES - LEAD_PART_BYTES - HEADROOM;
    const OVER_BUDGET_PART_BYTES = HEADROOM + 1;
    /** Small files finishing the selection, on top of the two leads. */
    const SMALL_PART_COUNT = MAX_EMAIL_ATTACHMENTS - 2;
    // The premise, computed rather than assumed: nothing is oversized, the leads
    // fit together, and either of the next two spends more than what is left.
    for (const size of [LEAD_PART_BYTES, SECOND_LEAD_BYTES, OVER_BUDGET_PART_BYTES]) {
      expect(size).toBeGreaterThan(0);
      expect(size).toBeLessThanOrEqual(MAX_EMAIL_DOCUMENT_BYTES);
    }
    expect(LEAD_PART_BYTES + SECOND_LEAD_BYTES).toBeLessThanOrEqual(
      MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES,
    );
    expect(LEAD_PART_BYTES + SECOND_LEAD_BYTES + OVER_BUDGET_PART_BYTES).toBeGreaterThan(
      MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES,
    );
    // ...and the small tail still fits in what the leads left behind, so the
    // selection really does reach the count cap.
    expect(LEAD_PART_BYTES + SECOND_LEAD_BYTES + SMALL_PART_COUNT * 96).toBeLessThanOrEqual(
      MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES,
    );

    const OVER_CAP_EXTRAS = 3;
    const raw = multipartEmail(
      [
        { filename: "lead-1.pdf", mime: "application/pdf", bytes: LEAD_PART_BYTES },
        { filename: "lead-2.pdf", mime: "application/pdf", bytes: SECOND_LEAD_BYTES },
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
        // Small supported files, filling the selection to the cap.
        ...Array.from({ length: SMALL_PART_COUNT }, (_unused, index) => ({
          filename: `small-${index + 1}.pdf`,
          mime: "application/pdf",
        })),
        // Three past the cap.
        ...Array.from({ length: OVER_CAP_EXTRAS }, (_unused, index) => ({
          filename: `extra-${index + 1}.pdf`,
          mime: "application/pdf",
        })),
        // Inline AND a supported format AND past the cap: eligible, and so
        // countable as an over-cap loss, only if the inline filter is missing
        // from `eligibleAttachments`.
        {
          filename: "notes.md",
          mime: "text/markdown",
          disposition: 'Content-Disposition: inline; filename="notes.md"',
        },
      ],
      { subject: "Every loss at once", messageId: "message-every-budget-loss", body: "Lots." },
    );
    const { form, reply } = await forwardedForm(raw, "Every loss at once", "every-loss-at-once");

    // Ten forwarded: the two leads plus the smalls. The two over-budget parts
    // never consumed a cap slot.
    expect(form.getAll("attachments")).toHaveLength(MAX_EMAIL_ATTACHMENTS);
    expect((form.getAll("attachments")[1] as File).name).toBe("lead-2.pdf");
    // 1 unsupported + 2 over budget + 3 over cap. The two inline parts are in
    // neither the count nor the names.
    expect(form.get("skippedAttachmentCount")).toBe(String(1 + 2 + OVER_CAP_EXTRAS));
    expect(form.getAll("attachmentName")).not.toContain("logo.png");
    expect(form.getAll("attachmentName")).not.toContain("notes.md");
    // ...and neither name reaches the REPLY either. Deleting `replyLossNames`'
    // own inline filter (DW-446) left that guarantee resting on a construction
    // argument -- every list handed to it is inline-free because eligibility
    // filtered first -- with nothing observing it. These two lines are the
    // observation, on the one fixture that carries both kinds of inline part.
    expect(reply.text).not.toContain("logo.png");
    expect(reply.text).not.toContain("notes.md");

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
    // And NOT the fourth: every part here is within the per-document ceiling, so
    // re-labelling an over-budget file as an oversized one would tell the sender
    // to shrink a file that was never too big (DW-253).
    expect(reply.text).not.toContain("larger than");

    // The CR/LF is gone, not merely rendered harmlessly: the sentence naming the
    // dropped files must stay ONE line.
    expect(reply.text).not.toContain("huge\r\n1.pdf");
    expect(
      reply.text.split("\n").filter((line) => line.includes("total attachment budget")),
    ).toHaveLength(1);
  });
});

/**
 * The two misconfiguration early returns. Both are reachable only by removing a
 * binding `env()` always supplies, which is why neither was observed: deleting
 * either branch left the worker forwarding an unauthenticated request, or one
 * built against a relative URL, with the suite green (DW-364).
 */
describe("email-ingest misconfigured bindings", () => {
  it("tells the sender it could not queue and never forwards without a service token", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const msg = message();
      const { YOPEDIA_SERVICE_TOKEN: _token, ...bindings } = env(
        Response.json({ ok: true, slug: "quarterly-notes" }),
      );
      await worker.email(
        msg as unknown as Parameters<typeof worker.email>[0],
        bindings as unknown as Parameters<typeof worker.email>[1],
      );
      // No forward: an unauthenticated POST would be refused by the route
      // anyway, but silently -- the sender has to hear about it.
      expect(bindings.YOPEDIA.fetch).not.toHaveBeenCalled();
      expect(msg.reply).toHaveBeenCalledOnce();
      expect(msg.reply.mock.calls[0][0].text).toBe(
        "work-wiki could not queue this email because the ingest service is not configured.",
      );
      // The diagnostic too, for the same reason the sibling case below asserts
      // its own: the reply alone cannot tell a deliberate guard from an
      // incidental failure, and an operator staring at a "not configured"
      // bounce needs the binding named in the log to know what to fix.
      expect(errors).toHaveBeenCalledWith(
        "email-ingest: YOPEDIA_SERVICE_TOKEN is missing",
      );
    } finally {
      errors.mockRestore();
    }
  });

  it("falls through to the generic retry reply when the site URL is missing", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const msg = message();
      const { YOPEDIA_SITE_URL: _site, ...bindings } = env(
        Response.json({ ok: true, slug: "quarterly-notes" }),
      );
      await worker.email(
        msg as unknown as Parameters<typeof worker.email>[0],
        bindings as unknown as Parameters<typeof worker.email>[1],
      );
      expect(bindings.YOPEDIA.fetch).not.toHaveBeenCalled();
      expect(msg.reply).toHaveBeenCalledOnce();
      // The generic text, deliberately: the missing-site-URL `throw` has no
      // bespoke message of its own -- it is caught by the try/catch around the
      // forward, and this is the sentence that routing produces.
      expect(msg.reply.mock.calls[0][0].text).toBe(
        "work-wiki could not queue this email. Please try again in a few minutes.",
      );
      // The diagnostic, not the reply, is the discriminating surface here. The
      // reply text and the absent forward are produced by ANY throw inside that
      // try -- including the URL-parse `TypeError` that `new Request()` raises
      // on the relative "/api/email/ingest" left behind when the guard is
      // deleted. Both assertions above therefore stay green without the guard;
      // only the logged error tells the deliberate check apart from an
      // incidental rejection downstream of it.
      expect(errors).toHaveBeenCalledWith(
        "email-ingest: service binding request failed",
        expect.objectContaining({ message: "YOPEDIA_SITE_URL is missing" }),
      );
    } finally {
      errors.mockRestore();
    }
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
