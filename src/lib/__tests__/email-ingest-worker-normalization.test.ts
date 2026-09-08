import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The worker normalizes every parsed attachment's `content` into a byte view
 * before wrapping it in a `Blob`, across three shapes -- a `string`, an
 * `ArrayBuffer`, and a typed-array view -- and falls back to
 * `application/octet-stream` when the part reports no MIME type.
 *
 * Only one of those branches is reachable through the real parser: probing the
 * installed `postal-mime@2.7.5` shows `content` is always an `ArrayBuffer` and
 * `mimeType` is never empty (a part with no `Content-Type` defaults to
 * `text/plain`). The `string` branch, the view branch and the octet-stream
 * fallback are dead against every fixture the sibling suite can build, so a
 * `postal-mime` upgrade that starts handing back strings or subarray views --
 * and a normalizer that mishandles either -- would ship green. Mocking the
 * parser is the only way to observe them.
 *
 * The view branch specifically needs a NON-ZERO `byteOffset`: a
 * `new Uint8Array(buffer)` view would pass even if the worker ignored
 * `byteOffset`/`byteLength` and copied the whole underlying buffer.
 */

interface FakeAttachment {
  filename: string | null;
  mimeType: string;
  content: string | ArrayBuffer | Uint8Array;
  /**
   * What `postal-mime` reports for `Content-Disposition`. Omitted by every
   * fixture that predates DW-359, and `undefined` reads as "not inline"
   * exactly as `null` does.
   *
   * That equivalence is about the FORWARDING predicate only. The counting
   * predicate reads an absent disposition together with a body-referenced
   * `contentId` (DW-450), and no fixture here carries either -- `parsedEmail`
   * pins `html: ""`, so no reference exists to match and every part is a real
   * attachment whatever its disposition field holds. The Content-ID behaviour
   * is pinned against REAL PostalMime next door, in
   * `email-ingest-worker.test.ts`, because whether such a part arrives with
   * `contentId` set and `disposition` absent is a fact about the parser.
   */
  disposition?: "attachment" | "inline" | null;
}

const parseMock = vi.fn();

vi.mock("postal-mime", () => ({
  default: { parse: (...args: unknown[]) => parseMock(...args) },
}));

import worker, {
  decodedByteLength,
  MAX_EMAIL_DOCUMENT_BYTES,
} from "../../../workers/email-ingest/index";

function parsedEmail(attachments: FakeAttachment[]) {
  return {
    subject: "Normalized batch",
    messageId: "<message-normalized@example.com>",
    text: "Body text.",
    html: "",
    attachments,
  };
}

function message() {
  return {
    from: "owner@example.com",
    to: "ingest@workwiki.app",
    headers: new Headers({ subject: "Normalized batch" }),
    raw: new Blob(["ignored: postal-mime is mocked"]).stream() as ReadableStream<Uint8Array>,
    rawSize: 64,
    setReject: vi.fn(),
    reply: vi.fn(async (_builder: { from: string; subject: string; text: string }) => ({})),
  };
}

function env() {
  return {
    YOPEDIA_CONFIG: {
      get: vi.fn(async () => ({
        enabled: true,
        inboundAddress: "ingest@workwiki.app",
        allowedSenders: ["owner@example.com"],
      })),
    },
    YOPEDIA: {
      fetch: vi.fn(async (_request: Request) =>
        Response.json({ ok: true, slug: "normalized-batch" }),
      ),
    },
    YOPEDIA_SERVICE_TOKEN: "test-token",
    YOPEDIA_SITE_URL: "https://yopedia.example.com",
  };
}

async function forwardedAttachments(attachments: FakeAttachment[]): Promise<File[]> {
  parseMock.mockResolvedValueOnce(parsedEmail(attachments));
  const bindings = env();
  await worker.email(
    message() as unknown as Parameters<typeof worker.email>[0],
    bindings as unknown as Parameters<typeof worker.email>[1],
  );
  expect(bindings.YOPEDIA.fetch).toHaveBeenCalledOnce();
  const forwarded = bindings.YOPEDIA.fetch.mock.calls[0][0];
  return (await forwarded.formData()).getAll("attachments") as File[];
}

/**
 * The `Blob`s the worker hands to `form.append("attachments", ...)`, read at
 * the append call itself rather than off the wire.
 *
 * The append call is the OUTERMOST surface at which the octet-stream fallback
 * is still observable: everything outside it erases the distinction, because
 * the multipart/form-data serializer is spec-required to write
 * `application/octet-stream` for an entry whose type is the empty string, so by
 * the time a body exists the `||` has left no trace. See the wire-level
 * assertion below for the other half.
 */
async function appendedAttachmentBlobs(attachments: FakeAttachment[]): Promise<Blob[]> {
  parseMock.mockResolvedValueOnce(parsedEmail(attachments));
  const bindings = env();
  const spy = vi.spyOn(FormData.prototype, "append");
  let recorded: unknown[][] = [];
  let contexts: unknown[] = [];
  try {
    await worker.email(
      message() as unknown as Parameters<typeof worker.email>[0],
      bindings as unknown as Parameters<typeof worker.email>[1],
    );
    // Snapshot BEFORE `mockRestore()`: vitest's `mockRestore` resets the
    // recorded calls as well as the implementation, so reading `spy.mock.calls`
    // afterwards yields `[]` and every assertion below passes vacuously. The
    // same applies to `mock.contexts`, so both are captured together.
    recorded = spy.mock.calls.map((call) => [...call]);
    contexts = [...spy.mock.contexts];
  } finally {
    spy.mockRestore();
  }
  expect(bindings.YOPEDIA.fetch).toHaveBeenCalledOnce();
  // The spy is installed on the PROTOTYPE, so it records every `FormData` built
  // anywhere during the run. Filtering on the key alone would silently fold in
  // an "attachments" entry appended to some other form, so the calls are scoped
  // to the single instance the worker built -- identified by its `messageId`
  // append, which the worker performs exactly once on that form.
  expect(contexts).toHaveLength(recorded.length);
  const workerFormIndex = recorded.findIndex((call) => call[0] === "messageId");
  expect(workerFormIndex).toBeGreaterThanOrEqual(0);
  const workerForm = contexts[workerFormIndex];
  expect(workerForm).toBeInstanceOf(FormData);
  expect(recorded.filter((call) => call[0] === "messageId")).toHaveLength(1);
  const blobs = recorded
    .filter((call, index) => call[0] === "attachments" && contexts[index] === workerForm)
    .map((call) => call[1] as Blob);
  // Guards the spy itself: a form the worker built some other way would leave
  // this empty and make the type assertions unfalsifiable.
  expect(blobs.length).toBeGreaterThan(0);
  return blobs;
}

/**
 * The forwarded form AND the acknowledgement, for cases that assert on what was
 * NOT sent as much as on what was.
 */
async function forwardedRun(attachments: FakeAttachment[]) {
  parseMock.mockResolvedValueOnce(parsedEmail(attachments));
  const msg = message();
  const bindings = env();
  await worker.email(
    msg as unknown as Parameters<typeof worker.email>[0],
    bindings as unknown as Parameters<typeof worker.email>[1],
  );
  expect(bindings.YOPEDIA.fetch).toHaveBeenCalledOnce();
  return {
    form: await bindings.YOPEDIA.fetch.mock.calls[0][0].formData(),
    reply: msg.reply.mock.calls[0][0] as { text: string },
  };
}

const STRING_CONTENT = "id,total\nalpha,10\nbêta,20\n";

/** Distinct per offset, so a zeroed or shifted copy diverges. */
function bytes(seed: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (seed * 31 + i * 7 + 3) & 0xff;
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("email-ingest attachment content normalization", () => {
  it("forwards string content as its UTF-8 bytes", async () => {
    const [part] = await forwardedAttachments([
      { filename: "notes.csv", mimeType: "text/csv", content: STRING_CONTENT },
    ]);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(
      // Non-ASCII on purpose: a latin1 or char-code copy would diverge here.
      new TextEncoder().encode(STRING_CONTENT),
    );
    expect(part.type).toBe("text/csv");
  });

  it("forwards ArrayBuffer content byte-identically", async () => {
    const source = bytes(5, 128);
    const [part] = await forwardedAttachments([
      {
        filename: "report.pdf",
        mimeType: "application/pdf",
        content: source.slice().buffer,
      },
    ]);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(source);
  });

  it("forwards only the window a typed-array view covers", async () => {
    const backing = bytes(9, 256);
    // Offset 40, length 96: neither end coincides with the backing buffer, so
    // dropping `byteOffset` or `byteLength` produces the wrong bytes AND the
    // wrong length.
    const view = new Uint8Array(backing.buffer, 40, 96);
    // `application/msword` is in neither allowlist on purpose: this part is
    // forwarded on its `.docx` extension alone, so the assertion below is about
    // the byte window and nothing else.
    const [part] = await forwardedAttachments([
      { filename: "slice.docx", mimeType: "application/msword", content: view },
    ]);
    const forwarded = new Uint8Array(await part.arrayBuffer());
    expect(forwarded).toHaveLength(96);
    expect(forwarded).toEqual(backing.slice(40, 136));
  });

  it("still forwards a part that reports no MIME type, typed octet-stream", async () => {
    // Only the extension arm of `supportedAttachment` can carry this one: the
    // MIME arm must not treat the empty string as a set member and must not let
    // a typeless part through on its own.
    const source = bytes(2, 32);
    const [part] = await forwardedAttachments([
      { filename: "mystery.pdf", mimeType: "", content: source.slice().buffer },
    ]);
    expect(part.name).toBe("mystery.pdf");
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(source);
    // The route-visible half of `attachment.mimeType || "application/octet-stream"`.
    // The multipart/form-data serializer is required to emit
    // `application/octet-stream` for an entry whose type is the empty string,
    // so this assertion pins the type the route actually receives -- and thus
    // stores as the staged attachment's `contentType` -- and fails on any other
    // literal (`text/plain`, the filename, ...). It cannot see the `||` itself:
    // deleting it leaves the wire unchanged. The discriminating assertion is
    // the append-surface one in "types a MIME-less attachment ..." below.
    expect(part.type).toBe("application/octet-stream");
  });

  it("types a MIME-less attachment as application/octet-stream at the Blob it appends", async () => {
    const blobs = await appendedAttachmentBlobs([
      { filename: "mystery.pdf", mimeType: "", content: bytes(2, 32).slice().buffer },
      // A typed sibling in the same batch: a fallback applied unconditionally
      // would flatten this one to octet-stream too, and a single-part fixture
      // could not tell that apart from the correct behaviour.
      { filename: "notes.csv", mimeType: "text/csv", content: STRING_CONTENT },
    ]);
    expect(blobs.map((blob) => blob.type)).toEqual([
      "application/octet-stream",
      "text/csv",
    ]);
  });

  it("does not let a typeless, extensionless part through", async () => {
    const parts = await forwardedAttachments([
      { filename: null, mimeType: "", content: bytes(6, 16).slice().buffer },
      { filename: "keep.pdf", mimeType: "application/pdf", content: bytes(7, 16).slice().buffer },
    ]);
    expect(parts.map((part) => part.name)).toEqual(["keep.pdf"]);
  });

  it("names an unnamed attachment by its position among the supported ones", async () => {
    const parts = await forwardedAttachments([
      { filename: "skip.exe", mimeType: "application/octet-stream", content: bytes(1, 8).slice().buffer },
      { filename: "first.pdf", mimeType: "application/pdf", content: bytes(3, 8).slice().buffer },
      { filename: null, mimeType: "application/pdf", content: bytes(4, 8).slice().buffer },
    ]);
    // The unnamed part is the third parsed attachment but the second supported
    // one, so the fallback reads `attachment-2`.
    expect(parts.map((part) => part.name)).toEqual(["first.pdf", "attachment-2"]);
  });

  it("strips MIME parameters before deciding an attachment is supported", async () => {
    // `.data` is not an allowed extension, so this part is forwarded only if
    // the worker matches on `text/csv` rather than the whole header value --
    // which is what a real client sending a charset parameter would produce.
    const parts = await forwardedAttachments([
      {
        filename: "c.data",
        mimeType: "text/csv; charset=utf-8",
        content: STRING_CONTENT,
      },
    ]);
    expect(parts.map((part) => part.name)).toEqual(["c.data"]);
  });
});

/**
 * The per-document ceiling's INLINE exclusion (DW-253 x DW-359 x DW-446).
 *
 * An inline part no longer reaches the ceiling partition at all: DW-446 drops it
 * one step earlier, at eligibility, so `oversizedAttachments` cannot contain one
 * and `oversizedCount` is a plain `.length`. What these cases still pin is that
 * the earlier filter really does cover the oversized shape. No fixture in the
 * sibling suite carries an inline part that is ALSO over the ceiling, so
 * deriving `eligibleAttachments` from `parsed.attachments` again would leave the
 * whole repo green while a sender's signature banner, oversized or not, was
 * reported back to them as a file they had to shrink.
 *
 * `banner.pdf` is a supported DOCUMENT, so since DW-565 it is also the fifth
 * loss term: dropped at eligibility, and therefore named to the sender under
 * its own reason -- inline, not oversized. That distinction is the point of
 * running it here at all. Reporting it as oversized would tell the sender to
 * shrink a file whose size was never what stopped it, and reporting it not at
 * all would drop a document in silence.
 *
 * It lives HERE, against the mocked parser, for cost: a 10 MiB `Uint8Array` is
 * one allocation, whereas the same part written into a real MIME fixture is
 * ~14 MB of base64 string work on every run of the main worker suite.
 */
describe("email-ingest oversized inline parts", () => {
  /** One byte over -- the gate is `>`, so this is the smallest refused document. */
  const oversized = () => new ArrayBuffer(MAX_EMAIL_DOCUMENT_BYTES + 1);

  it("does not report an oversized INLINE part as a dropped attachment", async () => {
    const { form, reply } = await forwardedRun([
      // Inline, a supported format by extension, and over the ceiling. The
      // eligibility filter drops it before the ceiling partition ever sees it,
      // so ONE filter now keeps it out of both the forward and every reported
      // loss, where two used to.
      {
        filename: "banner.pdf",
        mimeType: "application/pdf",
        content: oversized(),
        disposition: "inline",
      },
      { filename: "report.pdf", mimeType: "application/pdf", content: bytes(3, 64).slice().buffer },
    ]);

    // Eligibility is unchanged: the inline filter drops it, so only the small
    // file travels.
    expect((form.getAll("attachments") as File[]).map((part) => part.name)).toEqual([
      "report.pdf",
    ]);
    // Not a recorded name -- that list is the files that travelled, and a name
    // with nothing behind it re-creates a phantom skip downstream -- but it IS
    // a counted loss, under the inline term (DW-565).
    expect(form.getAll("attachmentName")).toEqual(["report.pdf"]);
    expect(form.get("skippedAttachmentCount")).toBe("1");

    expect(reply.text).toContain("1 supported attachment was queued for ingestion.");
    // The whole point: no OVERSIZE sentence, because size is not why it was
    // dropped. It is named under the inline reason instead.
    expect(reply.text).not.toContain("larger than");
    expect(reply.text).toContain(
      "1 supported attachment was not queued because it was marked inline by the sending client: banner.pdf.",
    );
  });

  it("still names an oversized ATTACHMENT part alongside an oversized inline one", async () => {
    // The discriminating half. The case above passes if the ceiling filter runs
    // at all, whatever the inline handling; this one has BOTH kinds oversized,
    // so an eligibility filter that let inline parts through reports two losses
    // and names the banner.
    const { form, reply } = await forwardedRun([
      {
        filename: "banner.pdf",
        mimeType: "application/pdf",
        content: oversized(),
        disposition: "inline",
      },
      {
        filename: "huge.pdf",
        mimeType: "application/pdf",
        content: oversized(),
        disposition: "attachment",
      },
      { filename: "report.pdf", mimeType: "application/pdf", content: bytes(4, 64).slice().buffer },
    ]);

    expect((form.getAll("attachments") as File[]).map((part) => part.name)).toEqual([
      "report.pdf",
    ]);
    // TWO, under two different reasons: `huge.pdf` is oversized, `banner.pdf`
    // is inline. An eligibility filter that let inline parts through would
    // report both as oversized instead -- one number, one sentence, two names --
    // which is what these assertions discriminate.
    expect(form.get("skippedAttachmentCount")).toBe("2");
    expect(form.getAll("attachmentName")).toEqual(["huge.pdf", "report.pdf"]);
    expect(reply.text).toContain(
      `1 attachment was not queued because it is larger than ${
        MAX_EMAIL_DOCUMENT_BYTES / 1024 / 1024
      } MB: huge.pdf.`,
    );
    expect(reply.text).toContain(
      "1 supported attachment was not queued because it was marked inline by the sending client: banner.pdf.",
    );
    // The oversize sentence names ONE file: the banner must not appear in it.
    expect(
      reply.text.split("\n").filter((line) => line.includes("larger than")),
    ).toHaveLength(1);
    expect(reply.text).not.toContain("MB: huge.pdf, banner.pdf");
  });
});

/**
 * `decodedByteLength`'s string branch (DW-360). The aggregate budget has to
 * measure a part WITHOUT allocating it — encoding it to read the result's length
 * would materialise the very bytes the budget exists to bound — so the helper
 * hand-computes UTF-8 widths from code units: 1, 2 or 3 bytes by range, 4 for a
 * surrogate PAIR, and 3 for a LONE surrogate, which is the width of the U+FFFD
 * `TextEncoder` substitutes.
 *
 * That is ~20 lines of arithmetic with four ways to be wrong and no behavioural
 * coverage anywhere: every fixture in the sibling suite goes through real
 * PostalMime, whose default `attachmentEncoding` is `arraybuffer`, so the string
 * branch is dead against all of them. An under-count would let an over-budget
 * selection through the bound silently.
 *
 * Pinned against `TextEncoder` rather than against hand-typed byte counts: the
 * encoder is the authority on what these strings really occupy, and restating
 * its answers as literals would agree with the helper only by coincidence.
 */
describe("email-ingest decoded byte length", () => {
  const CASES: readonly (readonly [string, string])[] = [
    ["ASCII", "id,total\nalpha,10\n"],
    // 2-byte range: Latin-1 supplement and Greek, U+0080-U+07FF.
    ["two-byte", "bêta café naïve — ΑΒΓΔ"],
    // 3-byte range: CJK and the replacement char itself, U+0800-U+FFFF.
    ["three-byte", "四半期報告書 �"],
    // 4-byte: astral plane, which arrives as a surrogate PAIR of code units.
    // The pair must cost 4 bytes total, not 4 each -- the off-by-one that
    // double-counts the trailing unit shows up only here.
    ["astral (surrogate pair)", "quarterly 📊📈 report 𝕏"],
    // A LONE high surrogate: unpaired, so `TextEncoder` substitutes U+FFFD at 3
    // bytes. Reachable from real mail, because a client that truncates a UTF-16
    // string mid-pair emits exactly this.
    ["lone high surrogate", "truncated \ud83d"],
    // A lone LOW surrogate, and one followed by an ordinary character, so the
    // "is the next unit a low surrogate?" lookahead is exercised in both
    // directions rather than only at end-of-string.
    ["lone low surrogate", "\udc00 stray \ud83dx tail"],
    // Mixed, plus the empty string: the loop must terminate at zero length
    // without charging for a phantom unit.
    ["mixed", "aé中😀\ud83d"],
    ["empty", ""],
  ];

  for (const [label, content] of CASES) {
    it(`counts ${label} content exactly as TextEncoder does`, () => {
      expect(decodedByteLength(content)).toBe(new TextEncoder().encode(content).byteLength);
    });
  }

  it("reads byteLength off the buffer shapes without touching the string path", () => {
    // The two branches the real parser actually produces. An `ArrayBuffer` and a
    // view over a NON-ZERO offset must report their own lengths -- a view whose
    // length was read from the underlying buffer would over-count the budget and
    // drop parts that fit.
    const source = bytes(9, 64);
    expect(decodedByteLength(source.slice().buffer)).toBe(64);
    const view = new Uint8Array(source.slice().buffer, 16, 32);
    expect(decodedByteLength(view)).toBe(32);
  });
});
