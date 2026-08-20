import { describe, expect, it, vi } from "vitest";
import worker, {
  MAX_EMAIL_ATTACHMENTS,
  MAX_EMAIL_ATTACHMENT_NAMES_RECORDED,
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
 * 6. The raw-message size gate — its exact boundary and the figure the refusal
 *    quotes back.
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
      part.filename
        ? `Content-Disposition: attachment; filename="${part.filename}"`
        : "Content-Disposition: attachment",
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
});
