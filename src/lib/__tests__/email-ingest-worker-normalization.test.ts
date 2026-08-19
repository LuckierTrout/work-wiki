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
}

const parseMock = vi.fn();

vi.mock("postal-mime", () => ({
  default: { parse: (...args: unknown[]) => parseMock(...args) },
}));

import worker from "../../../workers/email-ingest/index";

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
    // The worker writes `attachment.mimeType || "application/octet-stream"`.
    // Note what this assertion can and cannot see: the multipart/form-data
    // serializer is required to emit `application/octet-stream` for an entry
    // whose type is the empty string, so the source-level `||` is belt-and-
    // braces -- deleting it does NOT change the bytes on the wire and does not
    // fail here. What is pinned is the type the route actually receives, which
    // it stores as the staged attachment's `contentType`; substituting any
    // other literal (`text/plain`, the filename, ...) does fail.
    expect(part.type).toBe("application/octet-stream");
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
