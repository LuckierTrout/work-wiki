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
 *    the body was entirely unobserved (DW-252) — and the acknowledgement's
 *    LINKS with it, which are built from the same trimmed site URL (DW-363).
 *    There is one trim now rather than two (DW-451), so those cases pin the
 *    single definition at BOTH its consumers: deleting it has to fail at the
 *    reply link as well as at the transport target.
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
 * 11. The body-truncation boundary — that an over-long body is cut to EXACTLY
 *     `MAX_EMAIL_CONTENT_CHARS`, marker included, and that a body sitting on
 *     the cap passes through verbatim. Nothing observed this, so an off-by-one
 *     in `MAX_EMAIL_CONTENT_CHARS - TRUNCATION_MARKER.length` would ship green
 *     while `/api/email/ingest`'s `> MAX_EMAIL_CONTENT_CHARS` gate 400s every
 *     long email, costing the sender their body and every attachment on it
 *     (DW-453). Read at the `form.append` call, not off the wire — the
 *     serializer rewrites lone LFs into CRLFs, so the wire length of a
 *     truncated body is the transport's number rather than the worker's.
 *
 *     That is the LIMIT of what these cases claim, and the limit is not
 *     academic: measured under this suite's serializer, the same truncated body
 *     reads back off the wire at `MAX_EMAIL_CONTENT_CHARS + 2`, and an
 *     UNtruncated 98,599-character body carrying 3,398 newlines reads back at
 *     101,997 — both over the route's gate. So these cases pin the worker's
 *     arithmetic; they do NOT establish that what the route receives is under
 *     the cap. Whether that is a live production defect turns on whether
 *     `workerd`'s serializer normalizes the way Node's does, which nothing in
 *     this repo can measure; it is recorded as deferred work rather than
 *     answered here.
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
   * Returns the forwarded `Request` AND the acknowledgement, because the
   * trimmed site URL has TWO consumers -- the forward target, and the reply's
   * links further down -- and reading only the first leaves half of it
   * unobserved. It was two independent expressions when this helper was
   * written, and deleting the second kept every assertion below green while
   * every sender got a page link with a quadrupled slash in it (DW-363).
   *
   * DW-451 collapsed them into one `const site`, which is why both surfaces are
   * still read here rather than one: with a single definition the failure mode
   * is no longer drift between two copies but a bad trim reaching BOTH
   * consumers at once, and only a helper that returns both can say so.
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

/** One byte over -- the gate is `>`, so this is the smallest refused document. */
const OVERSIZED_BYTES = MAX_EMAIL_DOCUMENT_BYTES + 1;
/** The ceiling as the reply writes it, and as `/api/email/ingest` writes it. */
const CEILING_MB = MAX_EMAIL_DOCUMENT_BYTES / 1024 / 1024;

function multipartEmail(
  parts: readonly (Pick<MixedPart, "filename" | "mime"> & {
    /** Decoded payload length. Defaults to `partBytes`'s own 96. */
    bytes?: number;
    /**
     * A verbatim `Content-Disposition` line, replacing the one derived from
     * `filename`. The only way to write a name the quoted-string form cannot
     * hold -- RFC 2231 percent-encoding smuggles bytes (CR/LF included) that a
     * `filename="..."` parameter could not carry without breaking the header.
     *
     * `null` OMITS the header entirely, which no earlier fixture could do: a
     * part carrying a `Content-ID` and no `Content-Disposition` is the whole
     * shape DW-450 is about, and it is unreachable while every part is forced
     * to declare a disposition. Such a part gets its name from the
     * `Content-Type` `name=` parameter instead, since the `filename` normally
     * comes off the line being omitted.
     */
    disposition?: string | null;
    /**
     * Extra part headers, written verbatim after `Content-Type` and the
     * disposition. `Content-ID: <logo@example.com>` is the only current use --
     * there was no way to give a part a header this helper does not derive.
     */
    headers?: readonly string[];
    /**
     * Transfer encoding for the part body. Defaults to base64, the encoding
     * every fixture used before DW-358; `quoted-printable` is the worst-case
     * encoding a sending client may pick instead.
     */
    encoding?: "base64" | "quoted-printable";
  })[],
  options: {
    subject: string;
    messageId: string;
    body: string;
    /**
     * A `text/html` sibling body part. Without one `parsed.html` is empty and
     * no `cid:` reference exists to be matched, so the whole DW-450 widening is
     * unreachable from a fixture. PostalMime folds the `text/plain` sibling
     * into `parsed.html` as well, so `parsed.text` stays the merged body text
     * rather than exactly `options.body`.
     */
    html?: string;
  },
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
  if (options.html !== undefined) {
    lines.push(
      "--work-wiki-boundary",
      "Content-Type: text/html; charset=utf-8",
      "",
      options.html,
      "",
    );
  }
  parts.forEach((part, index) => {
    const encoding = part.encoding ?? "base64";
    const payload = partBytes(index, part.bytes ?? 96);
    // `filename` is written into the `Content-Disposition` line and NOWHERE
    // else, so omitting that line silently discards it -- a fixture asking for
    // both would test a nameless part while reading as though it named one.
    // Throw rather than drop it: the name has to travel on `Content-Type`
    // instead, and a fixture that got this wrong would be asserting against a
    // differently-shaped part than its author wrote.
    if (part.disposition === null && part.filename !== null) {
      throw new Error(
        `multipartEmail: part "${part.filename}" omits Content-Disposition, which is the only header carrying \`filename\`. Pass \`filename: null\` and put the name in the Content-Type \`name=\` parameter instead.`,
      );
    }
    // `undefined` derives the header, an explicit `null` omits it, a string
    // replaces it. `??` cannot express the middle case.
    const disposition =
      part.disposition === undefined
        ? part.filename
          ? `Content-Disposition: attachment; filename="${part.filename}"`
          : "Content-Disposition: attachment"
        : part.disposition;
    lines.push("--work-wiki-boundary", `Content-Type: ${part.mime}`);
    if (disposition !== null) lines.push(disposition);
    for (const header of part.headers ?? []) lines.push(header);
    lines.push(`Content-Transfer-Encoding: ${encoding}`, "");
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

// Module scope rather than inside `describe("email-ingest aggregate decoded
// budget")`, which is where these were written and where their primary case
// still lives: the refusal suite needs an over-budget message too, and a second
// copy of the shape would mean encoding ~28 MB of base64 twice for no gain.
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
 * The refusal exit, which had no coverage at all: every other fixture in this
 * file answers the forward with an `{ ok: true }` response, so the
 * `!response.ok` branch was never entered.
 *
 * What it discarded (DW-452): the five loss sentences the handler has already
 * built by the time the forward returns. A route that refuses for a reason of
 * its own -- a read-only wiki, an unavailable queue -- is refusing a message
 * whose attachments were dropped BEFORE the forward, and replying with the
 * route's sentence alone told the sender none of it. Worse, it told them
 * nothing was wrong beyond a transient failure, so re-sending the same message
 * once the route recovered dropped the same files again in silence.
 *
 * FIVE cases, one per sentence the refusal reply now carries, because each loss
 * term is a separate entry in that array and a fixture driving one drives none
 * of the others: deleting any single entry has to fail exactly one case here.
 * The oversized and unsupported terms share a fixture (they are the two a
 * refusal most plausibly coincides with); over-cap, over-budget and
 * inline-dropped each need their own shape, reused from the suites that pin
 * them on the acknowledgement path.
 *
 * The sentences are the acknowledgement's own consts, so a test that only
 * checked "the reply mentions the loss" would pass against a second copy of the
 * prose; these assert the exact strings the acknowledgement path produces, and
 * bound the PARAGRAPH COUNT so an acknowledgement line cannot leak in unseen.
 */
describe("email-ingest route refusal", () => {
  /**
   * Like `forwardedForm`, but the forward is answered with a REFUSAL and the
   * reply is the surface under test. The forward is still asserted to have
   * happened: a reply that names the losses is only interesting if the handler
   * really reached the route and was turned away, rather than bailing earlier
   * for some unrelated reason.
   */
  async function refusedReply(raw: string, subject: string, response: Response) {
    const msg = message(raw, subject);
    const bindings = env(response);
    await worker.email(
      msg as unknown as Parameters<typeof worker.email>[0],
      bindings as unknown as Parameters<typeof worker.email>[1],
    );
    expect(bindings.YOPEDIA.fetch).toHaveBeenCalledOnce();
    // Exactly once: the losses are carried by the refusal reply itself, not by
    // a second message sent after it.
    expect(msg.reply).toHaveBeenCalledOnce();
    return (msg.reply.mock.calls[0][0] as { text: string }).text;
  }

  it("carries the loss sentences into the reply when the route refuses", async () => {
    const raw = multipartEmail(
      [
        { filename: "huge.pdf", mime: "application/pdf", bytes: OVERSIZED_BYTES },
        { filename: "program.exe", mime: "application/octet-stream" },
      ],
      {
        subject: "Refused with losses",
        messageId: "message-refused-losses",
        body: "The notes are in this email body.",
      },
    );
    const text = await refusedReply(
      raw,
      "Refused with losses",
      Response.json({ error: "wiki is read-only" }, { status: 400 }),
    );

    // The route's own sentence opens the reply -- it is the reason the message
    // was refused, and the losses are context beneath it, not a replacement.
    // Compared as a whole paragraph rather than with `startsWith`, so a
    // regression reports the sentence actually leading the reply.
    expect(text.split("\n\n")[0]).toBe("wiki is read-only");
    // Byte-identical to what the acknowledgement path would have said about the
    // same message: one const, two exits.
    expect(text).toContain(
      `1 attachment was not queued because it is larger than ${CEILING_MB} MB: huge.pdf.`,
    );
    expect(text).toContain("1 unsupported attachment was recorded but skipped.");
    // Blank-line joined, like every other multi-sentence reply this worker
    // sends -- not run together into one paragraph.
    expect(text.split("\n\n")).toHaveLength(3);
  });

  it("replies with the bare fallback sentence when the route refuses with no usable body", async () => {
    // Two things at once, and both are the point: `safeError(null)` supplies
    // the sentence when `response.json()` cannot parse the body, and
    // `.filter(Boolean)` keeps a loss-free refusal a single line. Joining the
    // empty sentences unfiltered would append four blank lines no sender should
    // ever see.
    const text = await refusedReply(
      RAW_EMAIL,
      "Quarterly notes",
      new Response("<html>502 Bad Gateway</html>", { status: 500 }),
    );
    expect(text).toBe("work-wiki could not accept this email.");
  });

  it("carries the over-cap sentence into the reply when the route refuses", async () => {
    // The over-cap sentence is one of the two DW-452 hoisted out of the
    // acknowledgement's `lines` array; asserting it separately is what says the
    // hoist reached the refusal exit rather than only tidying the array.
    const raw = multipartEmail(
      Array.from({ length: MAX_EMAIL_ATTACHMENTS + 1 }, (_unused, index) => ({
        filename: `small-${index + 1}.pdf`,
        mime: "application/pdf",
      })),
      {
        subject: "Refused while over cap",
        messageId: "message-refused-over-cap",
        body: "Eleven files attached.",
      },
    );
    const text = await refusedReply(
      raw,
      "Refused while over cap",
      Response.json({ error: "queue unavailable" }, { status: 503 }),
    );

    expect(text.split("\n\n")[0]).toBe("queue unavailable");
    expect(text).toContain(
      `1 supported attachment was not queued because this email exceeds the ${MAX_EMAIL_ATTACHMENTS}-attachment limit.`,
    );
    // The acknowledgement's own opening sentence is NOT in a refusal reply:
    // nothing was queued, so saying so would be a lie.
    expect(text).not.toContain("queued for ingestion");
    // Two paragraphs and no more: the error and the one loss this message
    // really had. A bound, not a spot check -- `not.toContain` can only rule
    // out the sentences it happens to name, and an acknowledgement line leaking
    // into this path would otherwise ride along unnoticed.
    expect(text.split("\n\n")).toHaveLength(2);
  });

  it("carries the over-budget sentence into the reply when the route refuses", async () => {
    // The aggregate-budget loss, which the three cases above cannot reach: they
    // all leave `overBudgetCount` at zero, so deleting `overBudgetLine` from the
    // refusal array kept every one of them green.
    //
    // The same cached fixture the aggregate suite's own case uses -- three
    // 7 MB parts that together exceed the budget, plus a small tail that still
    // fits behind the one that does not -- answered with a refusal instead of
    // an `{ ok: true }` response.
    const text = await refusedReply(
      overBudgetFixture(),
      "Too much at once",
      Response.json({ error: "wiki is read-only" }, { status: 400 }),
    );

    expect(text.split("\n\n")[0]).toBe("wiki is read-only");
    // Byte-identical to the sentence the acknowledgement path produces for this
    // same fixture, names and all: one const, two exits.
    expect(text).toContain(
      `1 supported attachment was not queued because this email exceeds the ${AGGREGATE_BUDGET_MB} MB total attachment budget: big-3.pdf.`,
    );
    expect(text.split("\n\n")).toHaveLength(2);
  });

  it("carries the inline-dropped sentence into the reply when the route refuses", async () => {
    // The fifth loss term (DW-565), likewise unreachable from the cases above.
    // A supported document the sending client labelled inline is dropped at
    // ELIGIBILITY, long before the forward -- so a route refusal is exactly the
    // moment the sender most needs to hear that it never travelled, and re-sending
    // the message unchanged once the route recovers would drop it again.
    //
    // The inline `.md` shape `describe("email-ingest inline parts")` uses, beside
    // a real PDF so there is something to forward and be refused.
    const raw = multipartEmail(
      [
        {
          filename: "notes.md",
          mime: "text/markdown",
          disposition: 'Content-Disposition: inline; filename="notes.md"',
        },
        { filename: "report.pdf", mime: "application/pdf" },
      ],
      {
        subject: "Refused with a preview",
        messageId: "message-refused-inline",
        body: "The report is attached.",
      },
    );
    const text = await refusedReply(
      raw,
      "Refused with a preview",
      Response.json({ error: "queue unavailable" }, { status: 503 }),
    );

    expect(text.split("\n\n")[0]).toBe("queue unavailable");
    expect(text).toContain(
      "1 supported attachment was not queued because it was marked inline by the sending client: notes.md.",
    );
    expect(text.split("\n\n")).toHaveLength(2);
  });
});

/**
 * The RECORDED name list -- the `attachmentName` fields the worker forwards, out
 * of which the route builds the activity history -- against filenames that are
 * non-null but scrub down to something else (DW-454).
 *
 * Its own suite because nothing here refuses anything: these cases answer the
 * forward with the ordinary `{ ok: true }` response `forwardedForm` supplies,
 * and the surface under test is the form field rather than the reply.
 *
 * The recorded-name assertion in `describe("email-ingest multi-attachment
 * forwarding")` reaches only a `null` filename, where the old
 * `filename || "unnamed attachment"` truthiness check and the
 * `replyAttachmentName` helper agree. These two are the inputs where they did
 * not.
 */
describe("email-ingest recorded attachment names", () => {
  it("records a whitespace-only filename the way the reply names it", async () => {
    // RFC 2231 rather than `filename="   "`: the quoted-string form invites the
    // parser to fold the parameter's own surrounding whitespace, and this case
    // needs the spaces to be the VALUE, unambiguously.
    //
    // The part is supported on its content type alone, so it is countable,
    // forwarded, and named -- the recorded name is the only thing in question.
    const raw = multipartEmail(
      [
        {
          filename: null,
          mime: "application/pdf",
          disposition: `Content-Disposition: attachment; filename*=utf-8''%20%20%20`,
        },
      ],
      {
        subject: "Blank name",
        messageId: "message-blank-name",
        body: "One oddly-named file attached.",
      },
    );
    const { form } = await forwardedForm(raw, "Blank name", "blank-name");

    // Not `"   "`. `sanitizeAttachmentNames` on the route side trims and
    // `.filter(Boolean)`s, so the raw form was dropped there -- the sender was
    // told about a file the activity history then had no name for.
    expect(form.getAll("attachmentName")).toEqual(["unnamed attachment"]);
    // And the list LENGTH is untouched by the helper, which the route's
    // `localSkipped` floor (`attachmentNames.length - attachments.length`)
    // depends on: one countable part, one recorded name, one forwarded file.
    expect(form.getAll("attachments")).toHaveLength(1);
  });

  it("scrubs CR/LF out of a recorded filename", async () => {
    // The same RFC 2231 smuggling the acknowledgement's scrubbing is pinned
    // against, observed at the RECORDED-name surface instead: the name reaches
    // the route, which writes it into activity history, and an unscrubbed CR/LF
    // is a forged line break wherever that history is rendered.
    const raw = multipartEmail(
      [
        {
          filename: null,
          mime: "application/pdf",
          disposition: `Content-Disposition: attachment; filename*=utf-8''a%0D%0Ab.pdf`,
        },
      ],
      {
        subject: "Folded name",
        messageId: "message-folded-name",
        body: "One oddly-named file attached.",
      },
    );
    const { form } = await forwardedForm(raw, "Folded name", "folded-name");

    expect(form.getAll("attachmentName")).toEqual(["a b.pdf"]);
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
   * Oversized, over-cap, unsupported and inline-document losses in one
   * acknowledgement, with the inline-DECORATION exclusion (DW-359) live
   * throughout. No other fixture drives those together, so the plural oversize
   * wording, the `"unnamed attachment"` fallback and the CR/LF scrubbing were
   * all unobserved -- and a dropped term in `overCapCount` would pass on every
   * case that drives only two of them.
   *
   * Four of the five terms, and the disjointness that matters most: the fifth
   * (DW-565) is the only one not derived from `countableAttachments`, so a
   * fixture driving it beside the others is what proves it neither
   * double-counts nor absorbs any of them.
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
        // Inline and a SUPPORTED format: the fifth loss term (DW-565), which
        // has to coexist with the other three here rather than only alone. The
        // asymmetry with the logo above is the whole rule -- a document the
        // sender could have had ingested is named, a decoration is not.
        {
          filename: "notes.md",
          mime: "text/markdown",
          disposition: 'Content-Disposition: inline; filename="notes.md"',
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
    // 2 oversized + 2 unsupported + 1 over-cap + 1 inline document, as one
    // number: the four terms in play are disjoint and sum to it. The inline
    // LOGO is in none of them.
    expect(form.get("skippedAttachmentCount")).toBe("6");
    expect(form.getAll("attachmentName")).not.toContain("logo.png");
    // ...and neither inline part is a recorded NAME, document or not: the route
    // derives a `localSkipped` floor from `attachmentNames.length -
    // attachments.length`, so `notes.md` recorded here would be counted a
    // second time downstream on top of the term it already contributes.
    expect(form.getAll("attachmentName")).not.toContain("notes.md");

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
    expect(reply.text).toContain(
      "1 supported attachment was not queued because it was marked inline by the sending client: notes.md.",
    );
    expect(reply.text).not.toContain("total attachment budget");
    // The logo is named nowhere, on the fixture that carries both kinds of
    // inline part (DW-359).
    expect(reply.text).not.toContain("logo.png");

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
 * DW-565 then closes the hole DW-446 opened at the other end: an inline part of
 * a supported format left eligibility and contributed to none of the four loss
 * terms, so a `.md` a client labelled inline arrived and NO sentence anywhere
 * mentioned it. It now has a fifth term of its own, named in both the
 * acknowledgement and the no-content exit — a document must never arrive and go
 * unmentioned. Note the asymmetry the cases below pin: an unsupported inline
 * part (a logo) is still silent, because there was never anything to ingest.
 *
 * DW-450/DW-566 split the predicate that decides all of this in two. A part
 * carrying only a body-referenced `Content-ID` is a decoration for COUNTING and
 * a real file for FORWARDING, which is why `describe("email-ingest Content-ID
 * parts")` below exists as its own suite.
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

  it("names an inline supported document as a loss when it is the only part", async () => {
    // The case DW-446 reverses and DW-565 completes. It used to be forwarded on
    // the theory that a `.md` a client marked inline is still a document the
    // sender meant to send -- but the same part was then excluded from every
    // loss sentence, so it spent a slot and budget bytes that no reply could
    // account for. DW-446 stopped forwarding it; the sender was then told
    // "work-wiki found no email text to ingest." and NOTHING else, which is the
    // defect DW-565 is about: a document arrived and no sentence mentioned it.
    // Both halves are asserted below -- not forwarded, and named.
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
    // The no-text sentence is still first and still the plain one: nothing
    // countable failed the allowlist here, so `unsupportedCount` is zero and
    // the branch keyed on it must not answer with the supported-formats list,
    // which would tell the sender to convert a file already in a supported
    // format (DW-359).
    //
    // ...and then the fifth loss sentence, naming the document. The exact
    // string, so a regression cannot pass by reporting the part under one of
    // the other four terms -- each of which would tell the sender to make a
    // change (shrink it, send fewer, convert it) that would not have helped.
    expect(text).toBe(
      [
        "work-wiki found no email text to ingest.",
        "1 supported attachment was not queued because it was marked inline by the sending client: notes.md.",
      ].join("\n\n"),
    );
    expect(text).not.toContain("recorded but skipped");
    expect(text).not.toContain("queued for ingestion");
    expect(text).not.toContain("Markdown, TXT, HTML");
    expect(text).not.toContain("larger than");
    expect(text).not.toContain("attachment limit");
  });

  it("does not offer the supported-formats list beside an inline document loss", async () => {
    // The contradiction the no-content exit's own comment warns about, in the
    // shape DW-565 created. An unsupported file makes `unsupportedCount`
    // non-zero, which used to open the reply with "found no email text or
    // supported document attachment. Supported attachments: Markdown, ..." --
    // directly above a sentence naming a MARKDOWN file that arrived. Both
    // sentences cannot be true, and the format list is not even the useful
    // advice here: what this sender has to change is their client's inline
    // labelling, which the line below tells them.
    const raw = multipartEmail(
      [
        { filename: "program.exe", mime: "application/octet-stream" },
        {
          filename: "notes.md",
          mime: "text/markdown",
          disposition: 'Content-Disposition: inline; filename="notes.md"',
        },
      ],
      { subject: "Dud and a preview", messageId: "message-inline-and-unsupported", body: "" },
    );
    const msg = message(raw, "Dud and a preview");
    const bindings = env(Response.json({ ok: true, slug: "unused" }));
    await worker.email(
      msg as unknown as Parameters<typeof worker.email>[0],
      bindings as unknown as Parameters<typeof worker.email>[1],
    );

    expect(bindings.YOPEDIA.fetch).not.toHaveBeenCalled();
    const text = msg.reply.mock.calls[0][0].text;
    expect(text).toBe(
      [
        "work-wiki found no email text to ingest.",
        "1 supported attachment was not queued because it was marked inline by the sending client: notes.md.",
      ].join("\n\n"),
    );
    // Named explicitly so a regression cannot pass by rewording the headline:
    // the format list must not appear beside a named supported document.
    expect(text).not.toContain("Markdown, TXT, HTML");
    expect(text).not.toContain("supported document attachment");
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
    // The three previews are supported documents that were not queued, so they
    // are the fifth loss term (DW-565) -- not zero, as they were while an
    // inline document could vanish without a sentence. The two logos are not:
    // `image/png` is not a format the door would ever have taken.
    expect(form.get("skippedAttachmentCount")).toBe(String(INLINE_PREVIEWS));

    expect(reply.text).toContain(
      `${REAL_PDFS} supported attachments were queued for ingestion.`,
    );
    // The exact lie this entry exists to remove.
    expect(reply.text).not.toContain("attachment limit");
    expect(reply.text).not.toContain("recorded but skipped");
    // The counts and names the sender sees describe the nine files they
    // attached -- plus the three documents their client marked inline, named so
    // they can re-send them as attachments. The logos stay invisible (DW-359):
    // the asymmetry is the point, and a fifth term that keyed on "inline"
    // rather than on "inline AND supported" would name them here.
    expect(reply.text).not.toContain("logo-1.png");
    expect(reply.text).toContain(
      `${INLINE_PREVIEWS} supported attachments were not queued because they were marked inline by the sending client: ${Array.from(
        { length: INLINE_PREVIEWS },
        (_unused, index) => `preview-${index + 1}.md`,
      ).join(", ")}.`,
    );
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
    // One: `preview.pdf` is a supported document that was not queued (DW-565).
    // Its name reaches the SENDER only -- `attachmentName` above stays the list
    // of files that travelled, because the route derives a `localSkipped` floor
    // from `attachmentNames.length - attachments.length` and a name with no file
    // behind it would be counted twice.
    expect(form.get("skippedAttachmentCount")).toBe("1");
    expect(reply.text).toContain("2 supported attachments were queued for ingestion.");
    expect(reply.text).toContain(
      "1 supported attachment was not queued because it was marked inline by the sending client: preview.pdf.",
    );
    // ...under its OWN reason. It was not refused for the budget it no longer
    // spends, and it is not over the per-document ceiling.
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
    // carry no attachment -- but it does now carry an attachment SENTENCE. This
    // is the acknowledgement half of DW-565: the no-body sibling above pins the
    // no-content exit, and a fifth line built only at that exit would leave this
    // shape -- the likelier one, since most senders write something -- still
    // dropping a document in silence.
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
    // Still not a recorded NAME -- that list is the files that travelled, and a
    // name with nothing behind it re-creates the phantom skip downstream -- but
    // it IS a counted loss.
    expect(form.getAll("attachmentName")).toEqual([]);
    expect(form.get("skippedAttachmentCount")).toBe("1");

    // Exactly one attachment sentence, and it is the fifth term naming the
    // document. The other four are named so a regression cannot pass by
    // reporting the part under one of them: each would tell the sender to make
    // a change -- shrink it, send fewer, convert it -- that would not have
    // helped.
    expect(reply.text).toContain(
      "1 supported attachment was not queued because it was marked inline by the sending client: preview.md.",
    );
    expect(reply.text).not.toContain("queued for ingestion");
    expect(reply.text).not.toContain("recorded but skipped");
    expect(reply.text).not.toContain("attachment limit");
    expect(reply.text).not.toContain("larger than");
    expect(reply.text).not.toContain("total attachment budget");
  });
});

/**
 * Parts carrying a `Content-ID` and NO `Content-Disposition` (DW-450, DW-566).
 *
 * The archetypal embedded graphic is written this way: a client drops the
 * disposition header, stamps a `Content-ID` on the part and points the HTML
 * body at it with `src="cid:..."`. `postal-mime` reports such a part as
 * `disposition: null`, which the loss accounting reads as an unlabelled real
 * attachment -- so the sender's own signature logo came back to them as "1
 * unsupported attachment was recorded but skipped", exactly the DW-359 lie in a
 * shape the disposition-only predicate cannot see.
 *
 * DW-450 widens the COUNTING predicate to trust that pairing, and DW-566 is the
 * reason it is a second predicate rather than a widening of the one that was
 * there: the same widening applied to ELIGIBILITY would silently discard every
 * supported document a client happens to tag with a Content-ID. Both halves are
 * pinned below -- a referenced logo disappears from the counts, a referenced
 * `.md` is still forwarded.
 *
 * Real fixtures, not the mocked parser, and deliberately so: whether a
 * `Content-ID` header with no `Content-Disposition` reaches the Worker as
 * `contentId` set with `disposition === null`, and whether a `text/html`
 * sibling part reaches it as a populated `parsed.html`, are facts about
 * PostalMime. A stub would assert the Worker's half of the contract while
 * assuming the half that can fail.
 */
describe("email-ingest Content-ID parts", () => {
  /** Referenced by `CID_BODY_HTML` below. The disposition header is absent. */
  const CID_LOGO = {
    filename: null,
    // The name has to travel on `Content-Type`: `filename` normally comes off
    // the `Content-Disposition` line this part deliberately omits.
    mime: 'image/png; name="logo.png"',
    disposition: null,
    headers: ["Content-ID: <logo@example.com>"],
  } as const;
  const CID_BODY_HTML = '<p>See <img src="cid:logo@example.com"> below.</p>';

  it("does not count a Content-ID-only logo the body references", async () => {
    const raw = multipartEmail([CID_LOGO, { filename: "report.pdf", mime: "application/pdf" }], {
      subject: "Signed off",
      messageId: "message-cid-logo",
      body: "The report is attached.",
      html: CID_BODY_HTML,
    });
    const { form, reply } = await forwardedForm(raw, "Signed off", "signed-off");

    // Only the real attachment travels, and it is the only recorded name. The
    // logo is a decoration: no count, no name, no sentence (DW-359).
    expect((form.getAll("attachments") as File[]).map((part) => part.name)).toEqual([
      "report.pdf",
    ]);
    expect(form.getAll("attachmentName")).toEqual(["report.pdf"]);
    expect(form.get("skippedAttachmentCount")).toBe("0");

    expect(reply.text).toContain("1 supported attachment was queued for ingestion.");
    // The exact sentence the sender used to get about their own footer, named so
    // a regression cannot pass by rewording it.
    expect(reply.text).not.toContain("1 unsupported attachment was recorded but skipped.");
    expect(reply.text).not.toContain("recorded but skipped");
    expect(reply.text).not.toContain("logo.png");
    // And not the fifth term either: the logo was never inline BY DISPOSITION,
    // and it is not a supported format, so neither half of that term applies.
    expect(reply.text).not.toContain("marked inline");
  });

  it("still forwards a Content-ID-only document the body references", async () => {
    // The DW-566 half, and the reason the predicate had to be split rather than
    // widened. This part is decorative by every counting signal -- no
    // disposition, a Content-ID, referenced by the body -- and it is STILL a
    // `.md` the sender sent. A single widened predicate gating eligibility
    // discards it, forwards nothing, and reports no loss: the file vanishes
    // between two clients with no sentence anywhere.
    const raw = multipartEmail(
      [
        {
          filename: null,
          mime: 'text/markdown; name="notes.md"',
          disposition: null,
          headers: ["Content-ID: <notes@example.com>"],
        },
      ],
      {
        subject: "Embedded notes",
        messageId: "message-cid-document",
        body: "Notes below.",
        html: '<p>Notes: <a href="cid:notes@example.com">here</a></p>',
      },
    );
    const { form, reply } = await forwardedForm(raw, "Embedded notes", "embedded-notes");

    // Forwarded WITH ITS BYTES -- not merely named. Dropping the content while
    // keeping the name would ingest an empty document.
    const parts = form.getAll("attachments") as File[];
    expect(parts.map((part) => part.name)).toEqual(["notes.md"]);
    expect(new Uint8Array(await parts[0].arrayBuffer())).toEqual(partBytes(0));
    expect(form.getAll("attachmentName")).toEqual(["notes.md"]);
    expect(form.get("skippedAttachmentCount")).toBe("0");

    expect(reply.text).toContain("1 supported attachment was queued for ingestion.");
    expect(reply.text).not.toContain("recorded but skipped");
    expect(reply.text).not.toContain("marked inline");
  });

  it("treats an UNREFERENCED Content-ID as a real attachment", async () => {
    // The bound on the widening. A `Content-ID` alone proves nothing -- clients
    // stamp one on ordinary attachments -- so it is the body's REFERENCE that
    // makes a part a decoration. The fixture carries an HTML body pointing at a
    // different `cid:`, so what is being pinned is the match, not the mere
    // presence of a body: a predicate that widened on `contentId` alone, or that
    // treated any HTML body as blanket permission, passes without this.
    const raw = multipartEmail([CID_LOGO], {
      subject: "Stray content id",
      messageId: "message-cid-unreferenced",
      body: "One file attached.",
      html: '<p>See <img src="cid:elsewhere@example.com"> below.</p>',
    });
    const { form, reply } = await forwardedForm(raw, "Stray content id", "stray-content-id");

    // Nothing forwardable -- `image/png` is not on the allowlist -- but it is
    // counted and named, which is what a real unlabelled attachment gets.
    expect(form.getAll("attachments")).toHaveLength(0);
    expect(form.getAll("attachmentName")).toEqual(["logo.png"]);
    expect(form.get("skippedAttachmentCount")).toBe("1");
    expect(reply.text).toContain("1 unsupported attachment was recorded but skipped.");
  });

  it("treats an explicitly ATTACHED part as one however the body references it", async () => {
    // The other bound. The widening applies ONLY where the disposition header is
    // absent: a client that said `attachment` said so, and a `cid:` reference
    // must not overrule it. Without this the sender who attached a chart AND
    // embedded a preview of it is told they attached nothing.
    const raw = multipartEmail(
      [
        {
          filename: "chart.png",
          mime: 'image/png; name="chart.png"',
          headers: ["Content-ID: <logo@example.com>"],
        },
      ],
      {
        subject: "Attached and embedded",
        messageId: "message-cid-attachment",
        body: "The chart is attached.",
        html: CID_BODY_HTML,
      },
    );
    const { form, reply } = await forwardedForm(
      raw,
      "Attached and embedded",
      "attached-and-embedded",
    );

    expect(form.getAll("attachmentName")).toEqual(["chart.png"]);
    expect(form.get("skippedAttachmentCount")).toBe("1");
    expect(reply.text).toContain("1 unsupported attachment was recorded but skipped.");
  });

  it("matches a Content-ID against the body reference case-insensitively", async () => {
    // Two no-ops until something varies case: `normalizeCid`'s `.toLowerCase()`
    // and the `/i` on the reference scanner. Every other fixture here writes
    // both sides in the same lower case, so deleting either leaves the suite
    // green -- and a client that round-trips Content-ID case, or emits
    // upper-case markup, gets the DW-359 phantom line back.
    //
    // Both halves vary at once, in opposite directions: the HEADER carries
    // mixed case (which only `.toLowerCase()` reconciles) and the MARKUP is
    // upper-case in both the attribute name and the scheme (which only `/i`
    // reaches).
    const raw = multipartEmail(
      [
        {
          filename: null,
          mime: 'image/png; name="logo.png"',
          disposition: null,
          headers: ["Content-ID: <Logo@Example.COM>"],
        },
        { filename: "report.pdf", mime: "application/pdf" },
      ],
      {
        subject: "Shouty markup",
        messageId: "message-cid-case",
        body: "The report is attached.",
        html: '<P>See <IMG SRC="CID:logo@example.com"> below.</P>',
      },
    );
    const { form, reply } = await forwardedForm(raw, "Shouty markup", "shouty-markup");

    expect(form.getAll("attachmentName")).toEqual(["report.pdf"]);
    expect(form.get("skippedAttachmentCount")).toBe("0");
    expect(reply.text).not.toContain("recorded but skipped");
    expect(reply.text).not.toContain("logo.png");
  });

  it("matches a single-quoted cid reference", async () => {
    // The delimiter is the sending CLIENT's choice, not the sender's, and every
    // other fixture in this suite double-quotes. The scanner reads three
    // spellings -- double-quoted, single-quoted, bare -- and two of them were
    // unobserved, so a pattern that handled only `"cid:..."` would ship green
    // and half the clients in the world would keep getting the phantom line.
    const raw = multipartEmail(
      [
        {
          filename: null,
          mime: 'image/png; name="logo.png"',
          disposition: null,
          headers: ["Content-ID: <logo@example.com>"],
        },
        { filename: "report.pdf", mime: "application/pdf" },
      ],
      {
        subject: "Single quotes",
        messageId: "message-cid-single-quoted",
        body: "The report is attached.",
        html: "<p>See <img src='cid:logo@example.com'> below.</p>",
      },
    );
    const { form, reply } = await forwardedForm(raw, "Single quotes", "single-quotes");

    expect(form.getAll("attachmentName")).toEqual(["report.pdf"]);
    expect(form.get("skippedAttachmentCount")).toBe("0");
    expect(reply.text).not.toContain("recorded but skipped");
    expect(reply.text).not.toContain("logo.png");
  });

  it("ignores a cid mention that is not a URL-bearing reference", async () => {
    // The bound on the SCAN, and the asymmetry that sets it. Under-matching
    // costs at worst the phantom "recorded but skipped" line DW-450 removes --
    // a sentence about a decoration. Over-matching takes a file the sender
    // really attached out of the counts, out of the recorded names and out of
    // every sentence, so they are told nothing about it at all.
    //
    // Three ways a `cid:` token appears without the body pointing at anything:
    // a commented-out draft, a script string, and a quoted reply that merely
    // mentions the URL in prose. A scanner reading the whole document -- which
    // is what this started as -- treats all three as proof the part is
    // embedded, and deletes a real attachment from the accounting on the
    // strength of someone TALKING about it.
    const raw = multipartEmail([CID_LOGO], {
      subject: "Talking about a cid",
      messageId: "message-cid-prose",
      body: "",
      html: [
        "<!-- <img src=\"cid:logo@example.com\"> -->",
        "<script>var embedded = \"cid:logo@example.com\";</script>",
        "<style>.sig { background: url(cid:logo@example.com); }</style>",
        "<p>The broken image was cid:logo@example.com in the last mail.</p>",
      ].join("\n"),
    });
    const { form, reply } = await forwardedForm(
      raw,
      "Talking about a cid",
      "talking-about-a-cid",
    );

    // Nothing points AT the part, so it is the unlabelled real attachment it
    // appears to be: counted, named, and reported.
    expect(form.getAll("attachmentName")).toEqual(["logo.png"]);
    expect(form.get("skippedAttachmentCount")).toBe("1");
    expect(reply.text).toContain("1 unsupported attachment was recorded but skipped.");
  });

  it("tells a sender whose only part was a referenced decoration that there was no text", async () => {
    // The exit where the DW-359 lie was loudest, in the Content-ID shape: a
    // message that is nothing but a signature. No fixture reached it -- every
    // Content-ID case above carries a real attachment beside the decoration --
    // and it IS reachable, because an HTML body consisting only of the `<img>`
    // reduces to empty `rawContent` once the tags are stripped.
    //
    // Before DW-450 this sender was told "work-wiki found no email text or
    // supported document attachment. Supported attachments: Markdown, ...":
    // asked to convert a logo they did not attach, in a message they meant to
    // be read as text.
    const raw = multipartEmail(
      [
        {
          filename: null,
          mime: 'image/png; name="logo.png"',
          disposition: null,
          headers: ["Content-ID: <logo@example.com>"],
        },
      ],
      {
        subject: "Just a signature",
        messageId: "message-cid-only-part",
        body: "",
        html: '<p><img src="cid:logo@example.com"></p>',
      },
    );
    const msg = message(raw, "Just a signature");
    const bindings = env(Response.json({ ok: true, slug: "unused" }));
    await worker.email(
      msg as unknown as Parameters<typeof worker.email>[0],
      bindings as unknown as Parameters<typeof worker.email>[1],
    );

    // The premise: the body really does reduce to nothing, so this is the
    // no-content exit and not the forward.
    expect(bindings.YOPEDIA.fetch).not.toHaveBeenCalled();
    const text = msg.reply.mock.calls[0][0].text;
    expect(text).toBe("work-wiki found no email text to ingest.");
    expect(text).not.toContain("supported document attachment");
    expect(text).not.toContain("Markdown, TXT, HTML");
    expect(text).not.toContain("logo.png");
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
    // 1 unsupported + 2 over budget + 3 over cap + 1 inline document: four
    // disjoint terms summing to the number on the wire. `notes.md` is a
    // supported document that was not queued, so it is the fifth term (DW-565);
    // `logo.png` is a decoration and is in no term at all (DW-359).
    expect(form.get("skippedAttachmentCount")).toBe(String(1 + 2 + OVER_CAP_EXTRAS + 1));
    // Neither inline part is a recorded NAME. The route derives a
    // `localSkipped` floor from `attachmentNames.length - attachments.length`,
    // so naming `notes.md` here would count it twice -- once in the term above
    // and once again downstream.
    expect(form.getAll("attachmentName")).not.toContain("logo.png");
    expect(form.getAll("attachmentName")).not.toContain("notes.md");
    // The logo's name reaches no reply line either. It is the DECORATION half
    // of the asymmetry, asserted on the one fixture carrying both kinds: the
    // document is named to the sender, the logo never is.
    expect(reply.text).not.toContain("logo.png");
    expect(reply.text).toContain(
      "1 supported attachment was not queued because it was marked inline by the sending client: notes.md.",
    );

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
    // And NOT the oversize one: every part here is within the per-document
    // ceiling, so re-labelling an over-budget file as an oversized one would
    // tell the sender to shrink a file that was never too big (DW-253).
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

/**
 * `TRUNCATION_MARKER` as `workers/email-ingest/index.ts` spells it. Not
 * exported by the worker -- unlike `MAX_EMAIL_CONTENT_CHARS`, which is -- so the
 * literal is duplicated here deliberately: this suite's whole job is to pin the
 * arithmetic that combines the two, and deriving the marker from the module
 * under test would let a reworded marker slide through silently.
 */
const TRUNCATION_MARKER = "\n\n[Email body truncated]";

/**
 * The `content` string the worker hands to `form.append("content", ...)`, read
 * at the append call itself rather than off the wire.
 *
 * The append call is the OUTERMOST surface at which the worker's own number is
 * still visible. The multipart/form-data encoding algorithm normalizes every
 * lone LF and CR in an entry value to CRLF, so `form.get("content")` on a
 * truncated body returns `MAX_EMAIL_CONTENT_CHARS + 2` -- the marker's `"\n\n"`
 * arriving as `"\r\n\r\n"` -- plus one more character for every newline in the
 * sender's own text. That divergence is a property of the serializer, not of
 * the worker, so a wire-read assertion would pin the transport instead of the
 * truncation. Same reasoning and same spy shape as `appendedAttachmentBlobs` in
 * `email-ingest-worker-normalization.test.ts` (which reaches for it because the
 * wire erases an empty `Blob` type the same way).
 */
async function appendedContent(raw: string, subject: string, slug: string): Promise<string> {
  const msg = message(raw, subject);
  const bindings = env(Response.json({ ok: true, slug }));
  const spy = vi.spyOn(FormData.prototype, "append");
  let recorded: unknown[][] = [];
  let contexts: unknown[] = [];
  try {
    await worker.email(
      msg as unknown as Parameters<typeof worker.email>[0],
      bindings as unknown as Parameters<typeof worker.email>[1],
    );
    // Snapshot BEFORE `mockRestore()`: vitest's `mockRestore` resets the
    // recorded calls along with the implementation, so reading `spy.mock.calls`
    // afterwards yields `[]` and every assertion below passes vacuously. The
    // same applies to `mock.contexts`, so both are captured together.
    recorded = spy.mock.calls.map((call) => [...call]);
    contexts = [...spy.mock.contexts];
  } finally {
    spy.mockRestore();
  }
  expect(bindings.YOPEDIA.fetch).toHaveBeenCalledOnce();
  // The spy is installed on the PROTOTYPE, so it records every `FormData` built
  // anywhere during the run. Scope the calls to the single form the worker
  // built, identified by its `messageId` append -- performed exactly once on
  // that form -- rather than trusting the key alone.
  expect(contexts).toHaveLength(recorded.length);
  const workerFormIndex = recorded.findIndex((call) => call[0] === "messageId");
  expect(workerFormIndex).toBeGreaterThanOrEqual(0);
  const workerForm = contexts[workerFormIndex];
  expect(workerForm).toBeInstanceOf(FormData);
  expect(recorded.filter((call) => call[0] === "messageId")).toHaveLength(1);
  const appended = recorded
    .filter((call, index) => call[0] === "content" && contexts[index] === workerForm)
    .map((call) => call[1] as string);
  // Guards the spy itself: `form.append("content", ...)` is behind
  // `if (content)`, so an empty body would leave this empty and make every
  // length assertion below unfalsifiable.
  expect(appended).toHaveLength(1);
  return appended[0];
}

/**
 * The body-truncation boundary (DW-453). The worker cuts an over-long body to
 * `MAX_EMAIL_CONTENT_CHARS - TRUNCATION_MARKER.length` and appends the marker,
 * landing on exactly `MAX_EMAIL_CONTENT_CHARS`; `/api/email/ingest` then 400s
 * anything `> MAX_EMAIL_CONTENT_CHARS`. Nothing observed the worker half, so an
 * off-by-one in that subtraction -- or dropping it -- would ship green here and
 * 400 every long email in production, costing the sender their body AND every
 * attachment on the message. The route half of the same boundary is pinned in
 * `email-ingest-route.test.ts` ("body length ceiling", DW-366).
 *
 * The two halves do NOT meet, and saying so is the point. The route half posts
 * JSON; this half stops at the `form.append` call. In between sits the
 * multipart serializer, which rewrites every lone LF into a CRLF -- so the
 * value the route actually reads is longer than the one pinned here, by one
 * character per newline in the sender's text plus two for the marker's own
 * `"\n\n"`. Measured: the `MAX + 1` fixture below reads back off the wire at
 * `MAX_EMAIL_CONTENT_CHARS + 2`, and an untruncated 98,599-character body with
 * 3,398 newlines reads back at 101,997 -- over a gate the worker never
 * triggered. Nothing here asserts otherwise, and nothing here should be read as
 * proof that the route accepts what the worker sends. Whether that is live in
 * production depends on `workerd`'s serializer, which this repo cannot measure;
 * it is recorded as deferred work.
 */
describe("email-ingest body truncation", () => {
  /**
   * A distinctive opening followed by filler `x`s to an exact total. The
   * prefix is what makes "what survived the cut" assertable: an all-`x` body of
   * the right length would satisfy a prefix check no matter which characters
   * the slice actually kept.
   */
  const BODY_PREFIX = "Quarterly figures follow: ";
  const body = (length: number) => BODY_PREFIX + "x".repeat(length - BODY_PREFIX.length);

  /** What `slice(0, MAX - marker)` must leave of `body(...)`, spelled independently. */
  const survives = BODY_PREFIX + "x".repeat(
    MAX_EMAIL_CONTENT_CHARS - TRUNCATION_MARKER.length - BODY_PREFIX.length,
  );

  it("truncates a body one character over the cap to exactly the cap", async () => {
    const content = await appendedContent(
      multipartEmail([], {
        subject: "Long body",
        messageId: "message-body-over-cap",
        body: body(MAX_EMAIL_CONTENT_CHARS + 1),
      }),
      "Long body",
      "long-body",
    );
    // The load-bearing number: the route's gate is `> MAX_EMAIL_CONTENT_CHARS`,
    // so the worker's own output must land AT the cap and never one past it.
    expect(content).toHaveLength(MAX_EMAIL_CONTENT_CHARS);
    expect(content.endsWith(TRUNCATION_MARKER)).toBe(true);
    // What survived, not merely how much: the marker is appended to the FRONT
    // of the body, so a slice taken from the wrong end would still be the right
    // length and still carry the marker.
    expect(content).toBe(`${survives}${TRUNCATION_MARKER}`);
    expect(content.startsWith(BODY_PREFIX)).toBe(true);
  });

  it("leaves a body sitting exactly on the cap verbatim", async () => {
    const atCap = body(MAX_EMAIL_CONTENT_CHARS);
    const content = await appendedContent(
      multipartEmail([], {
        subject: "Exactly full",
        messageId: "message-body-at-cap",
        body: atCap,
      }),
      "Exactly full",
      "exactly-full",
    );
    // The ternary is `>`, not `>=`: a body of exactly the advertised length is
    // the longest legal one and must pass through untouched -- a `>=` would
    // truncate it, invisibly to a clearly-under / clearly-over pair.
    expect(content).toBe(atCap);
    expect(content).toHaveLength(MAX_EMAIL_CONTENT_CHARS);
    expect(content).not.toContain(TRUNCATION_MARKER);
  });

  it("truncates a multi-line body to the same cap, cutting mid-line", async () => {
    // Short LF-terminated lines, so the cut lands inside a line rather than on
    // a boundary -- the shape a real long email has, and the one where an
    // off-by-one is easiest to mistake for a stray newline.
    const line = (index: number) => `line ${String(index).padStart(6, "0")} of the body text`;
    const lines = Array.from(
      { length: Math.ceil((MAX_EMAIL_CONTENT_CHARS + 500) / (line(0).length + 1)) },
      (_, index) => line(index),
    );
    const multiLine = lines.join("\n");
    expect(multiLine.length).toBeGreaterThan(MAX_EMAIL_CONTENT_CHARS);

    const content = await appendedContent(
      multipartEmail([], {
        subject: "Long multi-line body",
        messageId: "message-body-multi-line",
        body: multiLine,
      }),
      "Long multi-line body",
      "long-multi-line-body",
    );
    expect(content).toHaveLength(MAX_EMAIL_CONTENT_CHARS);
    expect(content.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(content).toBe(
      `${multiLine.slice(0, MAX_EMAIL_CONTENT_CHARS - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`,
    );
    // The cut really did land mid-line: the character immediately before the
    // marker is body text, not a line break the truncation happened to fall on.
    expect(content.slice(-TRUNCATION_MARKER.length - 1, -TRUNCATION_MARKER.length)).not.toBe("\n");
  });
});
