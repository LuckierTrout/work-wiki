import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  isUrl,
  fetchUrlContent,
  fetchPdfBytes,
  sniffContentType,
} from "../fetch";
import { MAX_CONTENT_LENGTH, MAX_RESPONSE_SIZE, MAX_PDF_SIZE } from "../constants";
import { INTAKE_ALLOWED_CONTENT_TYPES } from "../workbench-intake";

// ---------------------------------------------------------------------------
// Mock unpdf — dynamic import is used in production, vitest hoists vi.mock
// ---------------------------------------------------------------------------
const mockExtractText = vi.fn();
const mockCleanup = vi.fn();
const mockGetDocumentProxy = vi.fn();

vi.mock("unpdf", () => ({
  getDocumentProxy: (...args: unknown[]) => mockGetDocumentProxy(...args),
  extractText: (...args: unknown[]) => mockExtractText(...args),
}));

// ---------------------------------------------------------------------------
// Helpers for mocking fetch
// ---------------------------------------------------------------------------

/** Create a minimal Response-like object that triggers the `response.text()` fallback. */
function mockResponse(
  bodyText: string,
  options: {
    status?: number;
    statusText?: string;
    headers?: Record<string, string>;
    ok?: boolean;
  } = {},
): Response {
  const {
    status = 200,
    statusText = "OK",
    headers = {},
    ok = status >= 200 && status < 300,
  } = options;

  return {
    ok,
    status,
    statusText,
    headers: new Headers(headers),
    body: null, // triggers the text() fallback path
    text: () => Promise.resolve(bodyText),
    // Needed to satisfy Response type checks at runtime
    url: "",
    type: "basic" as ResponseType,
    redirected: false,
    bodyUsed: false,
    clone: () => ({}) as Response,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob()),
    formData: () => Promise.resolve(new FormData()),
    json: () => Promise.resolve({}),
    bytes: () => Promise.resolve(new Uint8Array()),
  } as Response;
}

/**
 * A Response-like object BACKED BY REAL BYTES.
 *
 * `mockResponse` above stubs `arrayBuffer` to an EMPTY buffer — it exists to
 * drive the `response.text()` fallback, and nothing that read it needed the
 * bytes. The headerless door (DW-441) reads the body to find out what it IS, so
 * a fixture whose `arrayBuffer` returns nothing would sniff every fixture as
 * "empty" and pass for the wrong reason. `body: null` is kept so the text path
 * still takes the same fallback the rest of this file exercises.
 */
function mockBytesResponse(
  bytes: Uint8Array,
  options: {
    status?: number;
    statusText?: string;
    headers?: Record<string, string>;
    ok?: boolean;
  } = {},
): Response {
  const {
    status = 200,
    statusText = "OK",
    headers = {},
    ok = status >= 200 && status < 300,
  } = options;
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

  return {
    ok,
    status,
    statusText,
    headers: new Headers(headers),
    body: null,
    text: () => Promise.resolve(new TextDecoder().decode(bytes)),
    url: "",
    type: "basic" as ResponseType,
    redirected: false,
    bodyUsed: false,
    clone: () => ({}) as Response,
    arrayBuffer: () => Promise.resolve(buffer),
    blob: () => Promise.resolve(new Blob()),
    formData: () => Promise.resolve(new FormData()),
    json: () => Promise.resolve({}),
    bytes: () => Promise.resolve(bytes),
  } as Response;
}

/** UTF-8 bytes, so a fixture can be written as the text it actually is. */
function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Build a simple well-formed article HTML page. */
function articleHtml(title: string, content: string): string {
  return `<!DOCTYPE html>
<html>
<head><title>${title}</title></head>
<body>
  <article>
    <h1>${title}</h1>
    ${"<p>" + content + "</p>\n".repeat(5)}
  </article>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// isUrl
// ---------------------------------------------------------------------------

describe("isUrl", () => {
  it("accepts http:// URLs", () => {
    expect(isUrl("http://example.com")).toBe(true);
  });

  it("accepts https:// URLs", () => {
    expect(isUrl("https://example.com/path?q=1")).toBe(true);
  });

  it("rejects ftp:// scheme", () => {
    expect(isUrl("ftp://files.example.com")).toBe(false);
  });

  it("rejects mailto: scheme", () => {
    expect(isUrl("mailto:a@b.com")).toBe(false);
  });

  it("rejects relative paths", () => {
    expect(isUrl("/some/path")).toBe(false);
    expect(isUrl("some/path")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isUrl("")).toBe(false);
  });

  it("trims whitespace before checking", () => {
    expect(isUrl("  https://example.com  ")).toBe(true);
  });

  it("rejects whitespace-only string", () => {
    expect(isUrl("   ")).toBe(false);
  });

  it("rejects bare domain without scheme", () => {
    expect(isUrl("example.com")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchUrlContent
// ---------------------------------------------------------------------------

describe("fetchUrlContent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    mockGetDocumentProxy.mockReset();
    mockExtractText.mockReset();
    mockCleanup.mockReset();
  });

  it("extracts title and content from HTML response (happy path)", async () => {
    const html = articleHtml("My Page", "This is the main body content of the article about important topics.");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse(html, {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      ),
    );

    const result = await fetchUrlContent("https://example.com/page");
    expect(result.title).toBeTruthy();
    expect(result.content).toBeTruthy();
    expect(result.content.length).toBeGreaterThan(0);
  });

  it("extracts text from a PDF response", async () => {
    const pdfBytes = new ArrayBuffer(100);
    const docProxy = { cleanup: mockCleanup };
    mockGetDocumentProxy.mockResolvedValue(docProxy);
    mockExtractText.mockResolvedValue({
      totalPages: 2,
      text: "Introduction to AI\n\nArtificial intelligence is transforming the world.",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/pdf" }),
        arrayBuffer: () => Promise.resolve(pdfBytes),
      }),
    );

    const result = await fetchUrlContent("https://example.com/doc.pdf");
    expect(result.title).toBe("Introduction to AI");
    expect(result.content).toContain("Artificial intelligence");
    expect(mockGetDocumentProxy).toHaveBeenCalled();
    expect(mockExtractText).toHaveBeenCalled();
    expect(mockCleanup).toHaveBeenCalled();
  });

  it("does not truncate PDF text when the caller explicitly removes the content cap", async () => {
    const long = `Document title\n${"x".repeat(MAX_CONTENT_LENGTH + 1_000)}`;
    const docProxy = { cleanup: mockCleanup };
    mockGetDocumentProxy.mockResolvedValue(docProxy);
    mockExtractText.mockResolvedValue({ totalPages: 1, text: long });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/pdf" }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
      }),
    );

    const result = await fetchUrlContent("https://example.com/full.pdf", {
      maxContentLength: null,
    });

    expect(result.content).toHaveLength(long.length);
    expect(result.content).not.toContain("[Content truncated]");
  });

  it("rejects PDF with no extractable text layer", async () => {
    const pdfBytes = new ArrayBuffer(100);
    const docProxy = { cleanup: mockCleanup };
    mockGetDocumentProxy.mockResolvedValue(docProxy);
    mockExtractText.mockResolvedValue({ totalPages: 1, text: "" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/pdf" }),
        arrayBuffer: () => Promise.resolve(pdfBytes),
      }),
    );

    await expect(fetchUrlContent("https://example.com/scan.pdf")).rejects.toThrow(
      /no extractable text layer/i,
    );
    expect(mockCleanup).toHaveBeenCalled();
  });

  it("fetchPdfBytes returns raw bytes and does not call unpdf", async () => {
    const pdfBytes = new ArrayBuffer(100);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/pdf" }),
        arrayBuffer: () => Promise.resolve(pdfBytes),
      }),
    );

    const result = await fetchPdfBytes("https://example.com/brief.pdf");
    expect(result.bytes).toBe(pdfBytes);
    expect(result.filename).toBe("brief.pdf");
    expect(result.title).toBe("brief");
    expect(mockGetDocumentProxy).not.toHaveBeenCalled();
    expect(mockExtractText).not.toHaveBeenCalled();
  });

  it("rejects PDF exceeding MAX_PDF_SIZE via Content-Length header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({
          "content-type": "application/pdf",
          "content-length": String(MAX_PDF_SIZE + 1),
        }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      }),
    );

    await expect(fetchUrlContent("https://example.com/huge.pdf")).rejects.toThrow(
      /PDF too large/i,
    );
  });

  it("rejects Content-Length exceeding MAX_RESPONSE_SIZE", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse("small body", {
          headers: {
            "content-type": "text/html",
            "content-length": String(MAX_RESPONSE_SIZE + 1),
          },
        }),
      ),
    );

    await expect(fetchUrlContent("https://example.com")).rejects.toThrow(
      /Content too large/,
    );
  });

  it("follows redirects and returns final content", async () => {
    const html = articleHtml("Redirected Page", "Content after redirect was followed successfully by the fetcher.");
    const mockFetch = vi
      .fn()
      // First call: redirect
      .mockResolvedValueOnce(
        mockResponse("", {
          status: 301,
          statusText: "Moved Permanently",
          ok: false,
          headers: { location: "https://example.com/new-page" },
        }),
      )
      // Second call: final response
      .mockResolvedValueOnce(
        mockResponse(html, {
          headers: { "content-type": "text/html" },
        }),
      );

    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchUrlContent("https://example.com/old-page");
    expect(result.title).toBeTruthy();
    expect(result.content).toBeTruthy();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("blocks redirect to private IP (SSRF protection)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse("", {
          status: 301,
          statusText: "Moved Permanently",
          ok: false,
          headers: { location: "http://127.0.0.1/admin" },
        }),
      ),
    );

    await expect(fetchUrlContent("https://example.com")).rejects.toThrow(
      /private\/reserved/,
    );
  });

  it("errors after too many redirects", async () => {
    const redirectResponse = mockResponse("", {
      status: 301,
      statusText: "Moved Permanently",
      ok: false,
      headers: { location: "https://example.com/loop" },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(redirectResponse),
    );

    await expect(fetchUrlContent("https://example.com/start")).rejects.toThrow(
      /Too many redirects/,
    );
  });

  it("passes through plain text without HTML parsing", async () => {
    const plainText = "This is raw plain text content, not HTML.";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse(plainText, {
          headers: { "content-type": "text/plain" },
        }),
      ),
    );

    const result = await fetchUrlContent("https://example.com/file.txt");
    expect(result.content).toBe(plainText);
    expect(result.title).toBe("example.com");
  });

  it("throws on non-ok status (404)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse("Not Found", {
          status: 404,
          statusText: "Not Found",
          ok: false,
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    await expect(fetchUrlContent("https://example.com/missing")).rejects.toThrow(
      /Failed to fetch URL.*404/,
    );
  });

  it("throws when no content can be extracted from empty HTML body", async () => {
    // HTML with only whitespace in body — stripHtml yields empty string after trim
    const emptyHtml = "<html><head><title>  </title></head><body>  \n  </body></html>";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse(emptyHtml, {
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    await expect(fetchUrlContent("https://example.com/empty")).rejects.toThrow(
      /No text content/,
    );
  });

  it("refuses a PDF when the CALLER narrows the allowed types (Story 2.1)", async () => {
    // Workbench Intake hands in `INTAKE_ALLOWED_CONTENT_TYPES`, which leaves
    // `application/pdf` out: that door runs no extract at all (Epic 7 owns the
    // sidecar), so a PDF URL has to fail visibly rather than be routed into
    // `unpdf`. The case above proves the module DEFAULT still extracts PDFs for
    // the vault's callers — this one proves the narrowing is what decides, and
    // that the extractor is never reached.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/pdf" }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
      }),
    );

    await expect(
      fetchUrlContent("https://example.com/doc.pdf", {
        allowedContentTypes: INTAKE_ALLOWED_CONTENT_TYPES,
      }),
    ).rejects.toThrow(/Unsupported content type/);
    expect(mockGetDocumentProxy).not.toHaveBeenCalled();
    expect(mockExtractText).not.toHaveBeenCalled();
  });

  it("still takes the Readability path for HTML under the narrowed list", async () => {
    // The narrowing must refuse PDF WITHOUT changing what HTML does: AD-16's
    // Readability + `htmlToMarkdown` clip is the whole value of the in-app URL
    // field, and a list that dropped `text/html` would refuse every article.
    const html = articleHtml(
      "Narrowed Page",
      "The body of an article fetched through the Workbench's narrower intake door.",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse(html, { headers: { "content-type": "text/html" } }),
      ),
    );

    const result = await fetchUrlContent("https://example.com/page", {
      allowedContentTypes: INTAKE_ALLOWED_CONTENT_TYPES,
    });
    expect(result.title).toBeTruthy();
    expect(result.content).toContain("Workbench");
  });

  it("does not truncate when maxContentLength is null", async () => {
    const long = "A".repeat(MAX_CONTENT_LENGTH + 4_000);
    const html = articleHtml("Long Page", long);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse(html, { headers: { "content-type": "text/html" } }),
      ),
    );

    const capped = await fetchUrlContent("https://example.com/long");
    expect(capped.content).toContain("[Content truncated]");
    const full = await fetchUrlContent("https://example.com/long", { maxContentLength: null });
    expect(full.content).not.toContain("[Content truncated]");
    expect(full.content.length).toBeGreaterThan(MAX_CONTENT_LENGTH);
  });

  it("rejects image content types", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse("binary", {
          headers: { "content-type": "image/png" },
        }),
      ),
    );

    await expect(fetchUrlContent("https://example.com/image.png")).rejects.toThrow(
      /Unsupported content type/,
    );
  });

  it("handles redirect without Location header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse("", {
          status: 301,
          statusText: "Moved Permanently",
          ok: false,
          headers: {},
        }),
      ),
    );

    await expect(fetchUrlContent("https://example.com")).rejects.toThrow(
      /without Location header/,
    );
  });

  it("uses hostname as title when no <title> in HTML and Readability fails", async () => {
    // Minimal HTML that Readability won't parse as article but has some text
    const html = "<html><body><div>Some text content here</div></body></html>";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse(html, {
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    const result = await fetchUrlContent("https://example.com/page");
    expect(result.title).toBe("example.com");
  });

  it("passes correct headers in the fetch request", async () => {
    const html = articleHtml("Test", "Content for verifying fetch request headers are passed correctly.");
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse(html, {
        headers: { "content-type": "text/html" },
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await fetchUrlContent("https://example.com");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({
        headers: expect.objectContaining({
          "User-Agent": "llm-wiki/1.0",
        }),
        redirect: "manual",
      }),
    );
  });

  it("handles streaming body and enforces size limit", async () => {
    const chunk = new TextEncoder().encode("x".repeat(100));

    const mockReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: chunk })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      cancel: vi.fn(),
    };

    const streamResponse = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/plain" }),
      body: { getReader: () => mockReader },
      text: () => Promise.resolve(""),
      url: "",
      type: "basic" as ResponseType,
      redirected: false,
      bodyUsed: false,
      clone: () => ({}) as Response,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      blob: () => Promise.resolve(new Blob()),
      formData: () => Promise.resolve(new FormData()),
      json: () => Promise.resolve({}),
      bytes: () => Promise.resolve(new Uint8Array()),
    } as unknown as Response;

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse));

    const result = await fetchUrlContent("https://example.com/stream.txt");
    expect(result.content).toBe("x".repeat(100));
  });

  it("cancels streaming body when it exceeds MAX_RESPONSE_SIZE", async () => {
    // Create a chunk that exceeds MAX_RESPONSE_SIZE
    const bigChunk = new TextEncoder().encode("x".repeat(MAX_RESPONSE_SIZE + 1));

    const mockCancel = vi.fn();
    const mockReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: bigChunk }),
      cancel: mockCancel,
    };

    const streamResponse = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/plain" }),
      body: { getReader: () => mockReader },
      text: () => Promise.resolve(""),
      url: "",
      type: "basic" as ResponseType,
      redirected: false,
      bodyUsed: false,
      clone: () => ({}) as Response,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      blob: () => Promise.resolve(new Blob()),
      formData: () => Promise.resolve(new FormData()),
      json: () => Promise.resolve({}),
      bytes: () => Promise.resolve(new Uint8Array()),
    } as unknown as Response;

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse));

    await expect(fetchUrlContent("https://example.com/big.txt")).rejects.toThrow(
      /Content too large/,
    );
    expect(mockCancel).toHaveBeenCalled();
  });

  it("handles 302 redirect status", async () => {
    const html = articleHtml("Found Page", "Content after a 302 temporary redirect was followed successfully.");
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse("", {
          status: 302,
          statusText: "Found",
          ok: false,
          headers: { location: "https://example.com/found" },
        }),
      )
      .mockResolvedValueOnce(
        mockResponse(html, {
          headers: { "content-type": "text/html" },
        }),
      );

    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchUrlContent("https://example.com/temp");
    expect(result.title).toBeTruthy();
    expect(result.content).toBeTruthy();
  });

  it("handles text/markdown content type", async () => {
    const markdown = "# Hello\n\nSome **markdown** content here.";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse(markdown, {
          headers: { "content-type": "text/markdown" },
        }),
      ),
    );

    const result = await fetchUrlContent("https://example.com/doc.md");
    expect(result.content).toBe(markdown);
    expect(result.title).toBe("example.com");
  });

  it("validates the initial URL against SSRF before fetching", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    await expect(
      fetchUrlContent("http://192.168.1.1/admin"),
    ).rejects.toThrow(/private\/reserved/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("handles content-type with charset parameter", async () => {
    const html = articleHtml("Charset Test", "Testing that charset parameter in content type header is handled correctly.");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse(html, {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      ),
    );

    const result = await fetchUrlContent("https://example.com/page");
    expect(result.title).toBeTruthy();
    expect(result.content).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// sniffContentType — the substitute evidence for a headerless response (DW-441)
// ---------------------------------------------------------------------------

describe("sniffContentType", () => {
  it("recognises `%PDF-` magic at offset 0", () => {
    expect(sniffContentType(utf8("%PDF-1.7\n1 0 obj"))).toBe("application/pdf");
  });

  it("does NOT recognise `%PDF-` further into the body", () => {
    // The magic is anchored. A page that merely MENTIONS %PDF- is prose.
    expect(sniffContentType(utf8("see the %PDF- header spec"))).toBe("text/plain");
  });

  it("refuses on a NUL byte", () => {
    expect(sniffContentType(new Uint8Array([0x68, 0x69, 0x00, 0x68, 0x69]))).toBeNull();
  });

  it("refuses on a non-whitespace C0 control byte (PNG magic)", () => {
    expect(
      sniffContentType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBeNull();
  });

  it("keeps TAB, LF, FF and CR as text", () => {
    expect(sniffContentType(utf8("a\tb\r\nc\f d"))).toBe("text/plain");
  });

  it("reads a leading XML declaration as application/xml", () => {
    expect(sniffContentType(utf8('<?xml version="1.0"?><feed/>'))).toBe("application/xml");
  });

  it("reads an XML declaration OVER a page as application/xhtml+xml", () => {
    // XHTML opens with the same declaration as a data document, and answering
    // `application/xml` for both refuses a type the doors explicitly allow:
    // `INTAKE_ALLOWED_CONTENT_TYPES` takes `application/xhtml+xml` and does NOT
    // take `application/xml`. The doctype (or an `<html` tag) is the separator.
    expect(
      sniffContentType(
        utf8('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html><html><body>hi</body></html>'),
      ),
    ).toBe("application/xhtml+xml");
    expect(
      sniffContentType(utf8('<?xml version="1.0"?>\n<html xmlns="http://www.w3.org/1999/xhtml">')),
    ).toBe("application/xhtml+xml");
  });

  it("reads a doctype or an HTML tag as text/html", () => {
    expect(sniffContentType(utf8("<!DOCTYPE html><html><body>hi</body></html>"))).toBe("text/html");
    expect(sniffContentType(utf8("\n\n  <html lang=\"en\">"))).toBe("text/html");
    expect(sniffContentType(utf8("<!-- a comment first --><div>x</div>"))).toBe("text/html");
  });

  it("does NOT guess HTML from an unrecognised tag", () => {
    // The list is closed on purpose: `text/plain` is the honest answer, and
    // calling this HTML would hand an empty article to Readability.
    expect(sniffContentType(utf8("<not-a-tag>body</not-a-tag>"))).toBe("text/plain");
  });

  it("refuses an empty or whitespace-only window", () => {
    expect(sniffContentType(new Uint8Array(0))).toBeNull();
    expect(sniffContentType(utf8("   \n\t  "))).toBeNull();
  });

  it("reads only the first 512 bytes", () => {
    // A NUL past the window must not change the verdict — and a body that is
    // text for 512 bytes is text as far as this function is concerned.
    const prefix = utf8("x".repeat(600) + "\u0000");
    expect(sniffContentType(prefix)).toBe("text/plain");
  });
});

// ---------------------------------------------------------------------------
// The headerless doors (DW-441)
// ---------------------------------------------------------------------------

/**
 * Both doors used to guard with `if (mimeType && ...)`, so a response that
 * omitted `Content-Type` skipped the allowlist entirely and whatever arrived
 * was ingested unchecked. These pin the substitute evidence — and pin that it
 * is still the CALLER's `allowedContentTypes` that decides.
 */
describe("headerless responses (DW-441)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    mockGetDocumentProxy.mockReset();
    mockExtractText.mockReset();
    mockCleanup.mockReset();
  });

  function stub(bytes: Uint8Array, headers: Record<string, string> = {}) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockBytesResponse(bytes, { headers })),
    );
  }

  it("a DECLARED type still wins outright — no sniff runs", async () => {
    // The bytes say PDF; the header says text. The header is not second-guessed,
    // so the body comes back verbatim and `unpdf` is never reached.
    stub(utf8("%PDF-1.7 but declared as text"), { "content-type": "text/plain" });

    const result = await fetchUrlContent("https://example.com/odd");
    expect(result.content).toBe("%PDF-1.7 but declared as text");
    expect(mockGetDocumentProxy).not.toHaveBeenCalled();
  });

  it("sniffs headerless HTML and takes the Readability path", async () => {
    stub(
      utf8(
        articleHtml(
          "Headerless Page",
          "An article served by a host that declared no content type at all.",
        ),
      ),
    );

    const result = await fetchUrlContent("https://example.com/page");
    expect(result.title).toBeTruthy();
    expect(result.content).toContain("declared no content type");
  });

  it("sniffs headerless plain text and returns it verbatim", async () => {
    stub(utf8("This is raw plain text content, not HTML."));

    const result = await fetchUrlContent("https://example.com/notes.txt");
    expect(result.title).toBe("example.com");
    expect(result.content).toBe("This is raw plain text content, not HTML.");
  });

  it("sniffs a headerless PDF and extracts it on the DEFAULT list", async () => {
    mockGetDocumentProxy.mockResolvedValue({ cleanup: mockCleanup });
    mockExtractText.mockResolvedValue({
      totalPages: 1,
      text: "Quarterly Brief\n\nRevenue rose across every region this quarter.",
    });
    stub(utf8("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>"));

    const result = await fetchUrlContent("https://example.com/brief.pdf");
    expect(result.title).toBe("Quarterly Brief");
    expect(result.content).toContain("Revenue rose");
    expect(mockGetDocumentProxy).toHaveBeenCalled();
  });

  it("refuses the SAME headerless PDF bytes under the Intake list", async () => {
    // The sniff decides what the bytes ARE; the caller's door still decides
    // what it takes. Workbench Intake leaves `application/pdf` out, so this
    // must fail visibly — and the extractor must never be reached.
    stub(utf8("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>"));

    await expect(
      fetchUrlContent("https://example.com/brief.pdf", {
        allowedContentTypes: INTAKE_ALLOWED_CONTENT_TYPES,
      }),
    ).rejects.toThrow(/Unsupported content type: application\/pdf/);
    expect(mockGetDocumentProxy).not.toHaveBeenCalled();
    expect(mockExtractText).not.toHaveBeenCalled();
  });

  it("refuses headerless binary before any parsing", async () => {
    stub(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]));

    await expect(fetchUrlContent("https://example.com/image")).rejects.toThrow(
      /Unsupported content type/,
    );
  });

  it("refuses a headerless empty body", async () => {
    stub(new Uint8Array(0));

    await expect(fetchUrlContent("https://example.com/nothing")).rejects.toThrow(
      /Unsupported content type/,
    );
  });

  it("refuses with a ClientInputError so the route answers 400, not 500", async () => {
    stub(new Uint8Array([0x00, 0x01, 0x02]));

    await expect(
      fetchUrlContent("https://example.com/blob"),
    ).rejects.toMatchObject({ name: "ClientInputError" });
  });

  it("accepts a headerless XHTML page under the Intake list and reads it as a page", async () => {
    // The narrowed list takes `application/xhtml+xml`. A sniff that answered
    // `application/xml` for every XML declaration would refuse this door a page
    // type it explicitly allows.
    stub(
      utf8(
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
          articleHtml(
            "XHTML Page",
            "An XHTML article served with an XML declaration and no content type header.",
          ),
      ),
    );

    const result = await fetchUrlContent("https://example.com/page.xhtml", {
      allowedContentTypes: INTAKE_ALLOWED_CONTENT_TYPES,
    });
    expect(result.title).toBeTruthy();
    expect(result.content).toContain("XML declaration");
  });

  it("accepts a headerless XML feed under the DEFAULT list", async () => {
    // `application/xml` is on the module default but NOT on the Intake list —
    // the same sniffed answer, two different doors, which is the whole point.
    const feed =
      '<?xml version="1.0"?><rss><channel><title>Release Notes</title>' +
      "<item><description>The parser now reads a feed that declared no type.</description></item>" +
      "</channel></rss>";
    stub(utf8(feed));

    const result = await fetchUrlContent("https://example.com/feed.xml");
    expect(result.content).toContain("declared no type");

    stub(utf8(feed));
    await expect(
      fetchUrlContent("https://example.com/feed.xml", {
        allowedContentTypes: INTAKE_ALLOWED_CONTENT_TYPES,
      }),
    ).rejects.toThrow(/Unsupported content type: application\/xml/);
  });

  it("refuses an oversized headerless body WITHOUT calling it a PDF", async () => {
    // `intakeUrl` relays this sentence verbatim to whoever pasted the URL.
    // Reading the body through `readPdfBuffer` told an owner their HTML page
    // was too large a PDF — a document nobody supplied.
    stub(new Uint8Array(0), { "content-length": String(MAX_PDF_SIZE + 1) });

    const refusal = fetchUrlContent("https://example.com/huge");
    await expect(refusal).rejects.toThrow(/Content too large/);
    await expect(refusal).rejects.not.toThrow(/PDF too large/);
  });

  it("refuses a headerless body over MAX_RESPONSE_SIZE once the sniff says it is text", async () => {
    // Under MAX_PDF_SIZE, so the read succeeds — the ordinary text cap is what
    // refuses it, which is the cap ordering this path is built around.
    stub(utf8("<p>" + "x".repeat(MAX_RESPONSE_SIZE + 1_000) + "</p>"));

    const refusal = fetchUrlContent("https://example.com/long");
    await expect(refusal).rejects.toThrow(/Content too large/);
    await expect(refusal).rejects.not.toThrow(/PDF too large/);
  });

  it("CANCELS a headerless stream at the cap instead of buffering it whole", async () => {
    // `response.arrayBuffer()` is unbounded DURING the read, and the declared
    // Content-Length pre-check does not fire on exactly the servers this path
    // exists for. Pre-DW-441 a headerless body was cancelled mid-stream by the
    // text reader; the byte read has to do the same.
    const chunk = new Uint8Array(6 * 1024 * 1024).fill(0x78); // 6 MB of "x"
    let reads = 0;
    const reader = {
      read: vi.fn().mockImplementation(() => {
        reads += 1;
        if (reads > 8) return Promise.resolve({ done: true, value: undefined });
        return Promise.resolve({ done: false, value: chunk });
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: { getReader: () => reader },
      }),
    );

    await expect(fetchUrlContent("https://example.com/huge-stream")).rejects.toThrow(
      /Content too large/,
    );
    expect(reader.cancel).toHaveBeenCalled();
    // Cancelled the moment the accumulated bytes passed MAX_PDF_SIZE (20 MB),
    // not after draining everything the server was willing to send.
    expect(reads).toBe(4);
  });

  it("fetchPdfBytes accepts a headerless response whose bytes ARE a PDF", async () => {
    const bytes = utf8("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n");
    stub(bytes);

    const result = await fetchPdfBytes("https://example.com/brief.pdf");
    expect(new Uint8Array(result.bytes)).toEqual(bytes);
    expect(result.filename).toBe("brief.pdf");
  });

  it("fetchPdfBytes refuses a headerless non-PDF even at a .pdf URL", async () => {
    // The URL LEAF is what the caller asked for, not what arrived. Before
    // DW-441 the `mimeType &&` guard let these bytes through as a PDF.
    stub(utf8("<!DOCTYPE html><html><body>Not a PDF at all</body></html>"));

    await expect(fetchPdfBytes("https://example.com/brief.pdf")).rejects.toThrow(
      /Only PDF is accepted at this door\./,
    );
  });
});

// ---------------------------------------------------------------------------
// The redirect chain's TOTAL budget (DW-700)
// ---------------------------------------------------------------------------

describe("fetchFollowingRedirects budget", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes ONE AND THE SAME signal to every hop", async () => {
    // The clock used to restart per hop: five redirects bought six fresh
    // `FETCH_TIMEOUT_MS` windows, up to 90 s, past any client margin. Identity
    // of the signal across the calls is what says the budget is a TOTAL — a
    // per-hop `AbortSignal.timeout(...)` would hand out three DIFFERENT objects
    // while every other assertion in this file stayed green.
    const html = articleHtml("Final Page", "The body after three hops of redirects were followed.");
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse("", {
          status: 301,
          ok: false,
          headers: { location: "https://example.com/two" },
        }),
      )
      .mockResolvedValueOnce(
        mockResponse("", {
          status: 302,
          ok: false,
          headers: { location: "https://example.com/three" },
        }),
      )
      .mockResolvedValueOnce(
        mockResponse(html, { headers: { "content-type": "text/html" } }),
      );
    vi.stubGlobal("fetch", mockFetch);

    await fetchUrlContent("https://example.com/one");

    expect(mockFetch).toHaveBeenCalledTimes(3);
    const signals = mockFetch.mock.calls.map((call) => call[1].signal);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).toBe(signals[0]);
    expect(signals[2]).toBe(signals[0]);
  });
});

// ---------------------------------------------------------------------------
// downloadImages
// ---------------------------------------------------------------------------

import { downloadImages } from "../fetch";
import { _resetStorage, getStorage } from "../storage";
import fs from "fs/promises";
import path from "path";
import os from "os";

describe("downloadImages", () => {
  let tmpDir: string;
  let origDataDir: string | undefined;
  let origRawDir: string | undefined;

  async function setup(): Promise<string> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fetch-test-"));
    // Point storage and rawRelPath at the temp dir
    origDataDir = process.env.DATA_DIR;
    origRawDir = process.env.RAW_DIR;
    process.env.DATA_DIR = tmpDir;
    process.env.RAW_DIR = tmpDir;
    _resetStorage();
    return tmpDir;
  }

  afterEach(async () => {
    if (origDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = origDataDir;
    }
    if (origRawDir === undefined) {
      delete process.env.RAW_DIR;
    } else {
      process.env.RAW_DIR = origRawDir;
    }
    _resetStorage();
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("rewrites absolute image URLs to local paths", async () => {
    const rawDir = await setup();
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(pngBytes, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );

    const md = "Some text\n![Photo](https://example.com/photo.png)\nMore text";
    const result = await downloadImages(md, "test-page", rawDir);

    expect(result).toContain("![Photo](assets/test-page/photo.png)");
    expect(result).not.toContain("https://example.com/photo.png");

    // Verify file was written
    const filePath = path.join(rawDir, "assets", "test-page", "photo.png");
    const stat = await fs.stat(filePath);
    expect(stat.size).toBe(pngBytes.length);
  });

  it("skips data URIs", async () => {
    const rawDir = await setup();

    const md = "![Icon](data:image/png;base64,iVBOR...)";
    const result = await downloadImages(md, "test-page", rawDir);

    expect(result).toBe(md); // unchanged
  });

  it("skips relative paths", async () => {
    const rawDir = await setup();

    const md = "![Local](images/photo.png)\n![Root](/assets/img.jpg)";
    const result = await downloadImages(md, "test-page", rawDir);

    expect(result).toBe(md); // unchanged
  });

  it("handles download failures gracefully (keeps original URL)", async () => {
    const rawDir = await setup();

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("Network error"),
    );

    const md = "![Broken](https://example.com/broken.png)";
    const result = await downloadImages(md, "test-page", rawDir);

    expect(result).toBe(md); // original URL preserved
  });

  it("keeps original URL on non-200 status", async () => {
    const rawDir = await setup();

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Not Found", {
        status: 404,
        headers: { "content-type": "text/html" },
      }),
    );

    const md = "![Missing](https://example.com/missing.png)";
    const result = await downloadImages(md, "test-page", rawDir);

    expect(result).toBe(md);
  });

  it("keeps original URL for non-image content-type", async () => {
    const rawDir = await setup();

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("<html>page</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const md = "![Page](https://example.com/page.png)";
    const result = await downloadImages(md, "test-page", rawDir);

    expect(result).toBe(md);
  });

  it("limits to 20 images max", async () => {
    const rawDir = await setup();
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    // Create markdown with 25 images
    const lines: string[] = [];
    for (let i = 0; i < 25; i++) {
      lines.push(`![img${i}](https://example.com/img${i}.png)`);
    }
    const md = lines.join("\n");

    const mockFetch = vi.spyOn(globalThis, "fetch");
    // Each call returns a valid image
    for (let i = 0; i < 20; i++) {
      mockFetch.mockResolvedValueOnce(
        new Response(pngBytes, {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      );
    }

    const result = await downloadImages(md, "test-page", rawDir);

    // Only 20 fetch calls should have been made
    expect(mockFetch).toHaveBeenCalledTimes(20);

    // First 20 should be rewritten, last 5 should still be original URLs
    for (let i = 0; i < 20; i++) {
      expect(result).toContain(`assets/test-page/img${i}.png`);
    }
    for (let i = 20; i < 25; i++) {
      expect(result).toContain(`https://example.com/img${i}.png`);
    }
  });

  it("sanitizes filenames — strips query params", async () => {
    const rawDir = await setup();
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(pngBytes, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );

    const md = "![Q](https://example.com/photo.png?width=200&format=webp)";
    const result = await downloadImages(md, "test-page", rawDir);

    expect(result).toContain("assets/test-page/photo.png");
    expect(result).not.toContain("?");
  });

  it("sanitizes filenames — prevents path traversal", async () => {
    const rawDir = await setup();
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(pngBytes, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );

    const md = "![Evil](https://example.com/../../etc/passwd.png)";
    const result = await downloadImages(md, "test-page", rawDir);

    // Should not contain path traversal
    expect(result).not.toContain("..");
    expect(result).toContain("assets/test-page/");
  });

  it("deduplicates filenames with counter suffix", async () => {
    const rawDir = await setup();
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    const mockFetch = vi.spyOn(globalThis, "fetch");
    mockFetch.mockResolvedValueOnce(
      new Response(pngBytes, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    mockFetch.mockResolvedValueOnce(
      new Response(pngBytes, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );

    const md = "![A](https://example.com/photo.png)\n![B](https://cdn.example.com/photo.png)";
    const result = await downloadImages(md, "test-page", rawDir);

    expect(result).toContain("assets/test-page/photo.png");
    expect(result).toContain("assets/test-page/photo-1.png");
  });

  it("returns markdown unchanged when no images present", async () => {
    const rawDir = await setup();

    const md = "Just some text with [a link](https://example.com) but no images.";
    const result = await downloadImages(md, "test-page", rawDir);

    expect(result).toBe(md);
  });

  /**
   * THE EXCLUSION, pinned (DW-572). Every other binary writer in this repo now
   * publishes through the create-only door; this one must NOT, and nothing else
   * in the suite notices if it does. The key is `assets/<slug>/<url-derived
   * name>` — URL-derived, never content-addressed — so a later fetch of the
   * same page has to refresh a changed remote image AT THE NAME the rewritten
   * markdown still points at. Under `writeAssetIfAbsent` the second write is a
   * silent no-op (`downloadImages` swallows per-image failures too), stranding
   * the stale bytes behind a link that claims to be current.
   */
  it("REFRESHES a changed remote image at the same URL-derived name", async () => {
    const rawDir = await setup();
    const original = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const changed = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xde, 0xad, 0xbe, 0xef]);
    const md = "![Photo](https://example.com/photo.png)";
    const filePath = path.join(rawDir, "assets", "test-page", "photo.png");

    const mockFetch = vi.spyOn(globalThis, "fetch");
    mockFetch.mockResolvedValueOnce(
      new Response(original, { status: 200, headers: { "content-type": "image/png" } }),
    );
    const first = await downloadImages(md, "test-page", rawDir);
    expect(first).toContain("assets/test-page/photo.png");
    expect(new Uint8Array(await fs.readFile(filePath))).toEqual(original);

    // Same page, same URL, DIFFERENT bytes at the far end.
    mockFetch.mockResolvedValueOnce(
      new Response(changed, { status: 200, headers: { "content-type": "image/png" } }),
    );
    const second = await downloadImages(md, "test-page", rawDir);

    // The markdown still points at the same name…
    expect(second).toContain("assets/test-page/photo.png");
    // …and the bytes behind that name were REPLACED, not stranded.
    expect(new Uint8Array(await fs.readFile(filePath))).toEqual(changed);
  });
});

// ---------------------------------------------------------------------------
// storeImageBytes — the content-addressed key uses the CREATE-ONLY door
// ---------------------------------------------------------------------------

import { storeImageBytes } from "../fetch";
import { rawRelPath } from "../wiki";

/**
 * The key is `assets/<slug>/<digest>-<name>`, so an occupied key already holds
 * these exact bytes. Through `writeAsset` the second upload still rewrote them
 * (FR-2's "stored bytes are never mutated" was enforced only on the `raw.ts`
 * arrival path); through `writeAssetIfAbsent` it cannot. The sentinel is
 * DIFFERENT bytes at the digest-derived key — impossible in real traffic, and
 * the only way to see whether the second publication wrote at all.
 */
describe("storeImageBytes — create-only publication (DW-572)", () => {
  let tmpDir: string;
  let origDataDir: string | undefined;
  let origRawDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "store-image-bytes-"));
    origDataDir = process.env.DATA_DIR;
    origRawDir = process.env.RAW_DIR;
    process.env.DATA_DIR = tmpDir;
    process.env.RAW_DIR = tmpDir;
    _resetStorage();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (origDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = origDataDir;
    if (origRawDir === undefined) delete process.env.RAW_DIR;
    else process.env.RAW_DIR = origRawDir;
    _resetStorage();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("leaves an occupied key untouched and returns the same path", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
    const first = await storeImageBytes(bytes, "test-page", "photo.png");

    const sentinel = new Uint8Array([1, 2, 3, 4, 5]);
    await getStorage().writeAsset(rawRelPath(first.localPath), sentinel.buffer);

    const second = await storeImageBytes(bytes, "test-page", "photo.png");

    // Occupied is a SUCCESS: same path, same filename, no error.
    expect(second.localPath).toBe(first.localPath);
    expect(second.filename).toBe(first.filename);
    // …and the stored bytes were not rewritten.
    expect(new Uint8Array(await getStorage().readAsset(rawRelPath(first.localPath))))
      .toEqual(sentinel);
  });

  it("propagates a create-only failure instead of falling back to an overwrite", async () => {
    const storage = getStorage();
    const writeAsset = vi.spyOn(storage, "writeAsset");
    vi.spyOn(storage, "writeAssetIfAbsent").mockRejectedValue(
      new Error("storage unavailable"),
    );

    await expect(
      storeImageBytes(new Uint8Array([1, 2, 3]).buffer, "test-page", "photo.png"),
    ).rejects.toThrow("storage unavailable");
    expect(writeAsset).not.toHaveBeenCalled();
  });
});
