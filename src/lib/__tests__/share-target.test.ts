import { describe, it, expect } from "vitest";
import {
  resolveSharedUrl,
  buildBookmarklet,
  hostOf,
  isolateCaptureClip,
  captureFromQuery,
} from "../share-target";
import manifest from "@/app/manifest";
import { readFile } from "node:fs/promises";
import path from "node:path";

describe("resolveSharedUrl", () => {
  it("prefers an explicit url param", () => {
    expect(resolveSharedUrl("https://example.com/a", "ignored")).toBe(
      "https://example.com/a",
    );
  });

  it("trims surrounding whitespace on the url param", () => {
    expect(resolveSharedUrl("  https://example.com/a  ")).toBe("https://example.com/a");
  });

  it("falls back to the first http(s) link in text (Web Share Target quirk)", () => {
    expect(
      resolveSharedUrl(undefined, "Great read: https://example.com/post via @x"),
    ).toBe("https://example.com/post");
  });

  it("ignores a non-http url param and recovers from text", () => {
    expect(resolveSharedUrl("not-a-url", "see https://example.com/x")).toBe(
      "https://example.com/x",
    );
  });

  it("returns null when neither carries a url", () => {
    expect(resolveSharedUrl("", "no link here")).toBeNull();
    expect(resolveSharedUrl(null, null)).toBeNull();
  });

  it("keeps query-string chars when recovering a link from text (no truncation)", () => {
    // Pins that the extraction char-class doesn't get tightened to drop ?,&,= —
    // a tweet-style share carries the full tracking URL inline.
    expect(
      resolveSharedUrl(undefined, "read https://example.com/p?utm=x&y=2 thanks"),
    ).toBe("https://example.com/p?utm=x&y=2");
  });
});

describe("isolateCaptureClip", () => {
  it("returns leftover share text after stripping the resolved URL", () => {
    expect(
      isolateCaptureClip(
        "Great read: https://example.com/post via @x",
        "https://example.com/post",
      ),
    ).toBe("Great read: via @x");
  });

  it("does not treat a longer URL as a prefix of the resolved one", () => {
    expect(
      isolateCaptureClip("https://example.com/article", "https://example.com/a"),
    ).toBe("https://example.com/article");
  });

  it("treats a share that is only the URL as clipless", () => {
    expect(isolateCaptureClip("https://example.com/post", "https://example.com/post")).toBe(
      "",
    );
    expect(isolateCaptureClip("  https://example.com/post  ", "https://example.com/post")).toBe(
      "",
    );
  });

  it("keeps a selection that does not contain the URL", () => {
    expect(isolateCaptureClip("Selected paragraph.", "https://example.com/post")).toBe(
      "Selected paragraph.",
    );
  });

  it("returns the whole text when there is no URL to strip", () => {
    expect(isolateCaptureClip("just words", null)).toBe("just words");
  });
});

describe("captureFromQuery", () => {
  it("is a capture attempt when url or text is present, even if neither is a URL", () => {
    expect(captureFromQuery(undefined, "just words")).toEqual({
      url: "",
      clip: "just words",
      attempted: true,
    });
    expect(captureFromQuery("", undefined)).toEqual({
      url: "",
      clip: "",
      attempted: true,
    });
    expect(captureFromQuery(undefined, undefined)).toEqual({
      url: "",
      clip: "",
      attempted: false,
    });
  });

  it("resolves the URL and isolates leftover clip text", () => {
    expect(
      captureFromQuery("https://example.com/a", "https://example.com/a extra notes"),
    ).toEqual({
      url: "https://example.com/a",
      clip: "extra notes",
      attempted: true,
    });
  });
});

describe("buildBookmarklet", () => {
  it("opens the given origin's /save with the encoded current url, title, and selection", () => {
    const bm = buildBookmarklet("https://yopedia.yolog.dev");
    expect(bm.startsWith("javascript:")).toBe(true);
    expect(bm).toContain("https://yopedia.yolog.dev/save?url=");
    expect(bm).toContain("encodeURIComponent(location.href)");
    expect(bm).toContain("encodeURIComponent(document.title)");
    expect(bm).toContain("&text=");
    expect(bm).toContain("getSelection()");
    expect(bm).toContain("window.open(");
  });

  it("strips a trailing slash from the origin (no double slash before /save)", () => {
    expect(buildBookmarklet("https://yopedia.yolog.dev/")).toContain(
      "https://yopedia.yolog.dev/save?url=",
    );
  });

  it("produces a syntactically valid javascript: body (catches quote/paren slips)", () => {
    const body = buildBookmarklet("https://yopedia.yolog.dev").replace(/^javascript:/, "");
    // If a future edit unbalances a quote/paren, this throws at parse time —
    // something substring matching can't catch.
    expect(() => new Function(body)).not.toThrow();
  });
});

describe("hostOf", () => {
  it("returns the hostname without a leading www.", () => {
    expect(hostOf("https://www.example.com/a/b?c=1")).toBe("example.com");
    expect(hostOf("https://sub.example.com/x")).toBe("sub.example.com");
  });

  it("returns the raw input unchanged when it doesn't parse as a URL", () => {
    expect(hostOf("not a url")).toBe("not a url");
  });
});

describe("PWA manifest share target", () => {
  it("registers /save as a GET share target so the OS share sheet sends links there", () => {
    // share_target isn't in Next's Manifest TS type yet, but it IS emitted at
    // runtime — assert the shape so a refactor can't silently drop the surface.
    const m = manifest() as unknown as {
      share_target?: { action: string; method: string; params: Record<string, string> };
    };
    expect(m.share_target?.action).toBe("/save");
    expect(m.share_target?.method).toBe("GET");
    expect(m.share_target?.params.url).toBe("url");
    expect(m.share_target?.params.text).toBe("text");
  });
});

describe("the /save page", () => {
  it("passes the isolated clip and shows Capture when text is a clipless non-URL", async () => {
    const page = await readFile(
      path.join(__dirname, "../../app/save/page.tsx"),
      "utf8",
    );
    expect(page).toContain("captureFromQuery");
    expect(page).toContain("clip={clip}");
    expect(page).toContain("attempted ? <SaveCapture");
    expect(page).not.toContain("initialTags");
    expect(page).not.toContain("first(sp.tags)");
    expect(page).not.toContain("title={title}");
  });
});
