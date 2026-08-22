import { describe, expect, it, vi } from "vitest";
import worker, {
  MAX_EMAIL_ATTACHMENTS,
  MAX_EMAIL_ATTACHMENT_NAMES_RECORDED,
  MAX_EMAIL_CONTENT_CHARS,
  MAX_EMAIL_DOCUMENT_BYTES,
  MAX_RAW_EMAIL_BYTES,
} from "../../../workers/email-ingest/index";
import { base64PartWireSize } from "./email-ingest-wire";

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
 * 6. The two misconfiguration early returns — missing service token and missing
 *    site URL — whose sender-visible replies no fixture could reach while
 *    `env()` supplied both bindings (DW-364).
 *
 * 7. The raw-message size gate — its exact boundary, the figure the refusal
 *    quotes back, and the recorded trade-off that a full-size document and a
 *    maximal body do not fit under it together (DW-361).
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
    lines.push(
      "--work-wiki-boundary",
      `Content-Type: ${part.mime}`,
      part.disposition ??
        (part.filename
          ? `Content-Disposition: attachment; filename="${part.filename}"`
          : "Content-Disposition: attachment"),
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(partBytes(index, part.bytes ?? 96)),
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
 * only after decoding it, so nothing filtered on it at all: an oversized part
 * was forwarded, the route 400d the whole message, and the sender lost their
 * body and every other attachment to one bad file. It also paid for the bounce.
 *
 * These fixtures carry a genuinely over-ceiling part rather than a stubbed size:
 * the filter reads `bytes.byteLength` off the decode the forwarding loop reuses,
 * and a mocked parser would observe the filter without observing that the decode
 * it depends on still happens exactly once.
 */
describe("email-ingest oversized attachments", () => {
  /** One byte over -- the gate is `>`, so this is the smallest refused document. */
  const OVERSIZED_BYTES = MAX_EMAIL_DOCUMENT_BYTES + 1;
  /** The ceiling as the reply writes it, and as `/api/email/ingest` writes it. */
  const CEILING_MB = MAX_EMAIL_DOCUMENT_BYTES / 1024 / 1024;

  /**
   * Built lazily and cached: each of these encodes ~14 MB of base64, which is
   * worth paying once and not at module load for every other test in the file.
   */
  const fixtures = new Map<string, string>();
  function fixture(key: string, build: () => string): string {
    const existing = fixtures.get(key);
    if (existing !== undefined) return existing;
    const built = build();
    fixtures.set(key, built);
    return built;
  }

  /** One oversized supported part, one small supported part, and a body. */
  const oversizedAmongGood = () =>
    fixture("among-good", () =>
      multipartEmail(
        [
          { filename: "huge.pdf", mime: "application/pdf", bytes: OVERSIZED_BYTES },
          { filename: "solo.pdf", mime: "application/pdf" },
        ],
        {
          subject: "One too big",
          messageId: "message-oversized-among-good",
          body: "One of these is enormous.",
        },
      ),
    );

  /**
   * The oversized part comes FIRST, deliberately: if the byte filter ran after
   * `.slice(0, MAX_EMAIL_ATTACHMENTS)` it would eat a cap slot and only nine of
   * the ten small files would be forwarded. With it last, that ordering bug is
   * invisible.
   */
  const oversizedAtCap = () =>
    fixture("at-cap", () =>
      multipartEmail(
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
      ),
    );

  it("never forwards an oversized part, and names it in the acknowledgement", async () => {
    const { form, reply } = await forwardedForm(
      oversizedAmongGood(),
      "One too big",
      "one-too-big",
    );
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

    expect(reply.text).toContain("huge.pdf");
    expect(reply.text).toContain(`larger than ${CEILING_MB} MB`);
    expect(CEILING_MB).toBe(10);
    // The surviving file is still reported as queued -- the message was not
    // refused wholesale.
    expect(reply.text).toContain("1 supported attachment was queued for ingestion.");
    // Nothing was unsupported and nothing hit the cap, so neither of those
    // sentences fires: an oversized file is its own kind of loss.
    expect(reply.text).not.toContain("recorded but skipped");
    expect(reply.text).not.toContain("attachment limit");
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
    const raw = fixture("no-body", () =>
      multipartEmail(
        [{ filename: "huge.pdf", mime: "application/pdf", bytes: OVERSIZED_BYTES }],
        { subject: "Just the whale", messageId: "message-oversized-no-body", body: "" },
      ),
    );
    const msg = message(raw, "Just the whale");
    const bindings = env(Response.json({ ok: true, slug: "unused" }));
    await worker.email(
      msg as unknown as Parameters<typeof worker.email>[0],
      bindings as unknown as Parameters<typeof worker.email>[1],
    );

    // Nothing survived the size filter, so nothing is forwarded -- and the route
    // never sees a message it could only 400.
    expect(bindings.YOPEDIA.fetch).not.toHaveBeenCalled();
    const text = msg.reply.mock.calls[0][0].text;
    expect(text).toContain("huge.pdf");
    expect(text).toContain(`larger than ${CEILING_MB} MB`);
    // The honest lead sentence, and NOT the allowlist one: nothing here failed
    // the allowlist, so listing supported formats would answer a question the
    // sender did not ask and deny a fact they can see.
    expect(text).toContain("work-wiki found no email text to ingest.");
    expect(text).not.toContain("supported document attachment");
  });

  /**
   * All three losses in one acknowledgement. Every other fixture in this file
   * produces at most two, so the composition the intent actually promises --
   * the oversize sentence standing ALONGSIDE the existing skipped-attachment
   * ones -- was only ever asserted negatively, and the plural oversize wording
   * and the `"unnamed attachment"` fallback were unobserved.
   *
   * `rawSize` is overridden because two 10 MB parts cannot coexist under
   * `MAX_RAW_EMAIL_BYTES`: a message like this really would bounce at the raw
   * gate first. That gate is pinned on its own below; what is under test here is
   * the accounting BENEATH it, which must still be right -- and the plural
   * oversize wording is otherwise unreachable.
   */
  it("reports oversized, over-cap and unsupported losses in one acknowledgement", async () => {
    const raw = fixture("all-three", () =>
      multipartEmail(
        [
          // An RFC 2231 encoded name that really does arrive carrying CR/LF.
          // This is the whole attack: the filename is attacker-controlled text
          // that lands in an outbound email body, and interpolated raw it forges
          // extra lines in the acknowledgement. A tab does NOT test this -- the
          // parser normalizes tabs to spaces itself, so the reply would look
          // scrubbed whether or not the worker scrubbed anything.
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
          ...Array.from({ length: MAX_EMAIL_ATTACHMENTS + 1 }, (_unused, index) => ({
            filename: `small-${index + 1}.pdf`,
            mime: "application/pdf",
          })),
        ],
        {
          subject: "Every loss at once",
          messageId: "message-every-loss",
          body: "Two whales, two duds and eleven small ones.",
        },
      ),
    );
    const msg = { ...message(raw, "Every loss at once"), rawSize: MAX_RAW_EMAIL_BYTES };
    const bindings = env(Response.json({ ok: true, slug: "every-loss-at-once" }));
    await worker.email(
      msg as unknown as Parameters<typeof worker.email>[0],
      bindings as unknown as Parameters<typeof worker.email>[1],
    );

    expect(bindings.YOPEDIA.fetch).toHaveBeenCalledOnce();
    const form = await bindings.YOPEDIA.fetch.mock.calls[0][0].formData();
    // Ten forwarded: the oversized pair never competed for a slot, so the cap
    // cut exactly one within-size file.
    expect(form.getAll("attachments")).toHaveLength(MAX_EMAIL_ATTACHMENTS);
    // 2 oversized + 2 unsupported + 1 over-cap, as one number.
    expect(form.get("skippedAttachmentCount")).toBe("5");

    const text = msg.reply.mock.calls[0][0].text;
    expect(text).toContain(
      `${MAX_EMAIL_ATTACHMENTS} supported attachments were queued for ingestion.`,
    );
    // All three loss sentences together, each with its own plural form and its
    // own reason -- an oversized file is not an over-cap casualty and is not an
    // unsupported one.
    expect(text).toContain(
      `2 attachments were not queued because they are larger than ${CEILING_MB} MB: huge 1.pdf, unnamed attachment.`,
    );
    // The CR/LF is gone, not merely rendered harmlessly: the sentence naming the
    // dropped files must stay ONE line.
    expect(text).not.toContain("huge\r\n1.pdf");
    expect(
      text.split("\n").filter((line) => line.includes("larger than")),
    ).toHaveLength(1);
    expect(text).toContain(
      `1 supported attachment was not queued because this email exceeds the ${MAX_EMAIL_ATTACHMENTS}-attachment limit.`,
    );
    expect(text).toContain("2 unsupported attachments were recorded but skipped.");
  });

  it("does not let an oversized part consume a cap slot", async () => {
    const { form, reply } = await forwardedForm(
      oversizedAtCap(),
      "Ten and a whale",
      "ten-and-a-whale",
    );
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
    // fewer files, which would not have helped.
    expect(reply.text).not.toContain("attachment limit");
  });
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
 * The two misconfiguration early returns. Both are reachable only by removing a
 * binding `env()` always supplies, which is why neither was observed: deleting
 * either branch left the worker forwarding an unauthenticated request, or one
 * built against a relative URL, with the suite green.
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

  it("bounces a full-size document carried alongside a maximal body", async () => {
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
    // This guards the trade-off AS RECORDED TODAY; it is not a veto on widening
    // the cap. DW-358 (worst-case quoted-printable expansion) and DW-362 (an
    // aggregate multi-document budget) both carry accepted decisions to
    // re-derive `MAX_RAW_EMAIL_BYTES` upward, and either one is expected to move
    // this assertion with it. Re-derive the expectation there; do not read a
    // failure here as a reason to leave the cap alone.
    const rawSize = base64PartWireSize(MAX_EMAIL_DOCUMENT_BYTES) + MAX_EMAIL_CONTENT_CHARS;
    expect(rawSize).toBeGreaterThan(MAX_RAW_EMAIL_BYTES);

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
