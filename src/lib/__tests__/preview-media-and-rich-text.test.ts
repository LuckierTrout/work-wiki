/**
 * Stories 7.7 and 7.8 — images, the lightbox, in-pane players, and the rich
 * text (Mermaid + KaTeX + GFM) that Preview, Chat and Search now render.
 *
 * Three layers, the shape the Workbench suites already use:
 *
 *   1. the PURE vocabulary — `previewFileKind` over the media table,
 *      `previewBodyState`'s media branch, the citation remark pass, and the
 *      Search image partition;
 *   2. the RENDER — `PreviewBody` and `ChatBody` through
 *      `renderToStaticMarkup`, because this repo runs vitest in `node` and a
 *      rendered string is the only way to assert what an owner actually sees;
 *   3. the SOURCE SCANS for the two rules a render cannot reach — the type
 *      lock (no face named in either component) and the one-overlay level.
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PreviewBody } from "@/components/workbench/PreviewBody";
import { ChatBody, chatUrlTransform } from "@/components/workbench/ChatBody";
import {
  CITATION_HREF_PREFIX,
  citationNumberFromHref,
  parseCitationRuns,
  remarkChatCitations,
} from "../chat-markdown";
import { fencedCodeText } from "../markdown-fence";
import {
  SEARCH_IMAGES_HEADING,
  isImagePath,
  partitionSearchImages,
  resolveSearchImageSrc,
  snippetImageUrl,
} from "../search-images";
import { intakeMediaContentType, INTAKE_MEDIA_EXTENSIONS } from "../workbench-intake";
import {
  PREVIEW_MEDIA_FAILED_COPY,
  PREVIEW_MEDIA_ROUTE,
  isPreviewMediaFormat,
  previewBodyState,
  previewFileKind,
  previewLightboxJump,
  previewMediaUrl,
  type PreviewPayload,
} from "../workbench-preview";

const SRC = path.resolve(__dirname, "../..");

function read(file: string): Promise<string> {
  return readFile(path.join(SRC, "components/workbench", file), "utf8");
}

// ---------------------------------------------------------------------------
// 1. The vocabulary
// ---------------------------------------------------------------------------

describe("previewFileKind over media", () => {
  it("names every extension the Intake door accepts as media", () => {
    // DERIVED, not restated: the door's table is the one list, so a format the
    // door starts taking is one the Preview starts showing on the same commit.
    // A second list here is how a Source gets stored that nothing can display.
    for (const [ext, format] of Object.entries(INTAKE_MEDIA_EXTENSIONS)) {
      expect(previewFileKind(`raw/sources/x/file.${ext}`), ext).toBe(format);
    }
  });

  it("keeps text, markdown and genuinely unsupported answers unchanged", () => {
    expect(previewFileKind("a.md")).toBe("markdown");
    expect(previewFileKind("a.txt")).toBe("text");
    // A PDF is extract work, not something this reader renders.
    expect(previewFileKind("a.pdf")).toBe("unsupported");
    expect(previewFileKind("a")).toBe("unsupported");
    // A dotfile has no extension — `.png` is its whole name.
    expect(previewFileKind(".png")).toBe("unsupported");
  });

  it("answers the media classes and nothing else to `isPreviewMediaFormat`", () => {
    expect(isPreviewMediaFormat("image")).toBe(true);
    expect(isPreviewMediaFormat("video")).toBe(true);
    expect(isPreviewMediaFormat("audio")).toBe(true);
    expect(isPreviewMediaFormat("markdown")).toBe(false);
    expect(isPreviewMediaFormat("text")).toBe(false);
    expect(isPreviewMediaFormat("unsupported")).toBe(false);
  });
});

describe("the media door's URL and content types", () => {
  it("addresses the gated door, never the public asset route", () => {
    const url = previewMediaUrl("raw/sources/shots/a b.png");
    expect(url.startsWith(`${PREVIEW_MEDIA_ROUTE}?`)).toBe(true);
    // Encoded: a Source name may contain a space, a `&` or a `#`, and an
    // unencoded one would truncate the path the door reads.
    expect(url).toContain("path=raw%2Fsources%2Fshots%2Fa+b.png");
    expect(url).not.toContain("/api/assets/");
  });

  it("labels every accepted media extension with a real content type", () => {
    // `Content-Type: image` is not a thing a browser renders — the FORMAT
    // class cannot be inverted back into a type, which is why the table is
    // separate. What must hold is that it covers the door's whole set.
    for (const ext of Object.keys(INTAKE_MEDIA_EXTENSIONS)) {
      const type = intakeMediaContentType(`file.${ext}`);
      expect(type, ext).not.toBe("application/octet-stream");
      expect(type, ext).toMatch(/^(?:image|video|audio)\//);
    }
    // An extension the table does not name falls back rather than guessing: a
    // wrong label is a mis-decode, and octet-stream is merely a download.
    expect(intakeMediaContentType("file.xyz")).toBe("application/octet-stream");
    expect(intakeMediaContentType("file")).toBe("application/octet-stream");
  });
});

describe("previewBodyState over a media payload", () => {
  function payload(format: PreviewPayload["format"]): PreviewPayload {
    return {
      name: "clip.mp4",
      path: "raw/sources/clip/abc.mp4",
      format,
      // A media payload carries NO body by design — see the route.
      body: "",
      truncated: false,
      editable: false,
    };
  }

  it("answers `media` for the three classes, and carries the payload", () => {
    for (const format of ["image", "video", "audio"] as const) {
      const state = previewBodyState({
        loading: false,
        gone: false,
        payload: payload(format),
      });
      expect(state.kind, format).toBe("media");
      expect(state.kind === "media" && state.payload.format, format).toBe(format);
    }
  });

  it("tests media BEFORE empty, or every image reads as an empty file", () => {
    // The ordering bug this pins is silent: a media payload's body is blank by
    // construction, so an `empty` test placed first answers `This file is
    // empty.` for a perfectly good PNG, with nothing on screen to contradict
    // it and the whole suite green.
    const state = previewBodyState({
      loading: false,
      gone: false,
      payload: { ...payload("image"), body: "   " },
    });
    expect(state.kind).toBe("media");
  });

  it("still lets loading, gone and unsupported win over media", () => {
    expect(
      previewBodyState({ loading: true, gone: false, payload: payload("image") }).kind,
    ).toBe("loading");
    expect(
      previewBodyState({ loading: false, gone: true, payload: payload("image") }).kind,
    ).toBe("failed");
    expect(
      previewBodyState({
        loading: false,
        gone: false,
        payload: payload("unsupported"),
      }).kind,
    ).toBe("unsupported");
  });
});

describe("previewLightboxJump", () => {
  it("lands on the CONTAINING row, not on the image", () => {
    // The whole AC: jump-to-source docks the Page or Source the image was
    // rendered inside. Reaching for the image's own path instead is the
    // mistake this function exists to make unavailable.
    const page = { kind: "page", slug: "alpha" } as const;
    const file = { kind: "file", path: "raw/sources/deck/a.png" } as const;
    expect(previewLightboxJump(page)).toEqual(page);
    expect(previewLightboxJump(file)).toEqual(file);
  });
});

// ---------------------------------------------------------------------------
// 2. The citation remark pass (Story 7.8)
// ---------------------------------------------------------------------------

describe("parseCitationRuns", () => {
  it("splits markers out of the surrounding prose", () => {
    expect(parseCitationRuns("See [1] and [12] here.")).toEqual([
      { kind: "text", value: "See " },
      { kind: "cite", n: 1 },
      { kind: "text", value: " and " },
      { kind: "cite", n: 12 },
      { kind: "text", value: " here." },
    ]);
  });

  it("leaves anything that is not a marker byte-for-byte alone", () => {
    for (const text of ["[0]", "[01]", "[a]", "[]", "[1", "1]"]) {
      expect(parseCitationRuns(text), text).toEqual([{ kind: "text", value: text }]);
    }
  });
});

describe("the citation href round trip", () => {
  it("recognises its own scheme and refuses everything else", () => {
    expect(citationNumberFromHref(`${CITATION_HREF_PREFIX}3`)).toBe(3);
    expect(citationNumberFromHref(`${CITATION_HREF_PREFIX}0`)).toBe(null);
    expect(citationNumberFromHref(`${CITATION_HREF_PREFIX}x`)).toBe(null);
    expect(citationNumberFromHref("https://example.com")).toBe(null);
    expect(citationNumberFromHref(undefined)).toBe(null);
  });

  it("lets the scheme past the sanitizer and defers everything else", () => {
    const href = `${CITATION_HREF_PREFIX}1`;
    expect(chatUrlTransform(href)).toBe(href);
    expect(chatUrlTransform("javascript:alert(1)")).toBe("");
  });
});

describe("remarkChatCitations", () => {
  it("never reaches inside code — the whole reason it is not a string split", () => {
    // `content.split(/(\[\d+\])/)` turned `arr[1]` in a fenced example into a
    // citation button. mdast gives `code` its own node type with no children,
    // so this walk structurally cannot.
    const tree = {
      type: "root",
      children: [
        { type: "code", value: "const x = arr[1];" },
        { type: "inlineCode", value: "arr[2]" },
        { type: "paragraph", children: [{ type: "text", value: "See [3]." }] },
      ],
    };
    remarkChatCitations()(tree);
    expect(tree.children[0]).toEqual({ type: "code", value: "const x = arr[1];" });
    expect(tree.children[1]).toEqual({ type: "inlineCode", value: "arr[2]" });
    const paragraph = tree.children[2] as { children: Array<{ type: string; url?: string }> };
    expect(paragraph.children[1].type).toBe("link");
    expect(paragraph.children[1].url).toBe(`${CITATION_HREF_PREFIX}3`);
  });

  it("does not nest a citation inside an existing link", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "link",
          url: "https://example.com",
          children: [{ type: "text", value: "see [1]" }],
        },
      ],
    };
    remarkChatCitations()(tree);
    const link = tree.children[0] as { children: Array<{ type: string }> };
    expect(link.children).toEqual([{ type: "text", value: "see [1]" }]);
  });
});

describe("fencedCodeText", () => {
  it("returns the fence's source for a matching language and null otherwise", () => {
    // The shape react-markdown hands a `pre` override: one child element whose
    // props carry the language class and the source. Cast because a hand-built
    // stand-in is not a real `ReactElement`, and the walk reads four fields.
    const node = (className: string, value: string) =>
      ({ props: { className, children: `${value}\n` } }) as unknown as ReactNode;
    expect(fencedCodeText(node("language-mermaid", "graph TD"), "mermaid")).toBe(
      "graph TD",
    );
    expect(fencedCodeText(node("language-ts", "const a = 1"), "mermaid")).toBe(null);
    // `language-mermaidish` must not match `mermaid` — the word boundary is
    // what stops a diagram renderer from eating an unrelated fence.
    expect(fencedCodeText(node("language-mermaidish", "x"), "mermaid")).toBe(null);
    expect(fencedCodeText("just a string", "mermaid")).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// 3. The Search image partition (Story 7.7)
// ---------------------------------------------------------------------------

describe("partitionSearchImages", () => {
  const hit = (path: string, snippet = "") => ({
    path,
    title: path,
    snippet,
    score: 1,
  });

  it("moves image PATHS out of the list, in rank order", () => {
    const { images, rest } = partitionSearchImages([
      hit("wiki/media/chart.png"),
      hit("wiki/alpha.md", "prose only"),
      hit("raw/assets/deck/slide.png"),
      hit("raw/sources/notes/abc.md", "text"),
    ]);
    expect(images.map((image) => image.hit.path)).toEqual([
      "wiki/media/chart.png",
      "raw/assets/deck/slide.png",
    ]);
    // A hit whose path IS the image has nothing left in the list to be: a row
    // reading `chart.png` with a one-line snippet is strictly worse than the
    // picture.
    expect(rest.map((row) => row.path)).toEqual([
      "wiki/alpha.md",
      "raw/sources/notes/abc.md",
    ]);
  });

  it("keeps a page whose SNIPPET shows an image in BOTH halves", () => {
    // The words matched — that is why the hit is here at all. Removing the row
    // deleted a prose result the owner searched for and replaced it with a
    // thumbnail of a figure that happened to sit near the match.
    const page = hit("wiki/beta.md", "before ![a](assets/beta/x.png) after");
    const { images, rest } = partitionSearchImages([page]);
    expect(images.map((image) => image.hit.path)).toEqual(["wiki/beta.md"]);
    expect(rest.map((row) => row.path)).toEqual(["wiki/beta.md"]);
  });

  it("does not turn a non-image under a media root into a thumbnail", () => {
    // The ROOT is not the test. A README filed under `raw/assets/`, or the
    // caption sidecar an exporter drops beside a video, became an <img>
    // pointing at bytes no browser can decode — a broken thumbnail in place of
    // a result the owner could have read.
    const { images, rest } = partitionSearchImages([
      hit("raw/assets/deck/README.md", "how this deck was built"),
      hit("wiki/media/clip.vtt", "captions"),
    ]);
    expect(images).toEqual([]);
    expect(rest.map((row) => row.path)).toEqual([
      "raw/assets/deck/README.md",
      "wiki/media/clip.vtt",
    ]);
  });

  it("points an embedded image at the asset route, not at its page", () => {
    const { images } = partitionSearchImages([
      hit("wiki/beta.md", "![a](assets/beta/x.png)"),
    ]);
    expect(images[0].src).toBe("/api/assets/beta/x.png");
  });

  it("points a media Source at the gated door", () => {
    const { images } = partitionSearchImages([hit("raw/sources/shots/a.png")]);
    expect(images[0].src.startsWith(PREVIEW_MEDIA_ROUTE)).toBe(true);
  });

  it("leaves an already-loadable reference exactly as it is", () => {
    expect(resolveSearchImageSrc("https://example.com/a.png")).toBe(
      "https://example.com/a.png",
    );
    expect(resolveSearchImageSrc("data:image/png;base64,AA")).toBe(
      "data:image/png;base64,AA",
    );
  });

  it("recognises an image path and a snippet's first image", () => {
    expect(isImagePath("a/b/c.PNG")).toBe(true);
    expect(isImagePath("a/b/c.mp4")).toBe(false);
    expect(isImagePath("a/b/c")).toBe(false);
    expect(snippetImageUrl("x ![alt](one.png) y ![alt](two.png)")).toBe("one.png");
    expect(snippetImageUrl("no image here")).toBe(null);
  });

  it("names the section once, where the canvas and this pin share it", () => {
    expect(SEARCH_IMAGES_HEADING).toBe("Images");
  });
});

// ---------------------------------------------------------------------------
// 4. What the two bodies actually render
// ---------------------------------------------------------------------------

function renderPreview(markdown: string, withLightbox = true): string {
  return renderToStaticMarkup(
    createElement(PreviewBody, {
      format: "markdown" as const,
      content: markdown,
      readableSlugs: new Set(["alpha"]),
      onOpenPage: () => {},
      ...(withLightbox ? { onOpenImage: () => {} } : {}),
    }),
  );
}

function renderChat(markdown: string, withCite = true): string {
  return renderToStaticMarkup(
    createElement(ChatBody, {
      content: markdown,
      ...(withCite ? { onCite: () => {} } : {}),
    }),
  );
}

describe("PreviewBody renders media and rich text", () => {
  it("wraps an image in a control so the lightbox is keyboard-reachable", () => {
    const html = renderPreview("![a shot](/api/workbench/media?path=x.png)");
    expect(html).toContain('class="wb-preview-image-button"');
    expect(html).toContain('alt="a shot"');
  });

  it("leaves the image inert when there is nowhere to open it", () => {
    const html = renderPreview("![a shot](/api/workbench/media?path=x.png)", false);
    expect(html).toContain("<img");
    expect(html).not.toContain("wb-preview-image-button");
  });

  it("typesets math and keeps a code fence literal", () => {
    // KaTeX emits its own markup; the class is the evidence it ran at all.
    expect(renderPreview("Mass is $E=mc^2$ today.")).toContain("katex");
    expect(renderPreview("$$\na^2\n$$")).toContain("katex");
    // …and remark-math never descends into code, so a shell snippet keeps its
    // dollars instead of becoming a formula.
    const fenced = renderPreview("```\ncost=$5 and $9\n```");
    expect(fenced).not.toContain("katex");
    expect(fenced).toContain("$5");
  });

  it("still renders GFM tables and wikilinks beside the new plugins", () => {
    // The regression the plugin order could cause: math or the diagram pass
    // claiming text the wikilink pass needed, or GFM being dropped entirely.
    const html = renderPreview("| a | b |\n| - | - |\n| 1 | 2 |\n\nSee [[alpha]].");
    expect(html).toContain('class="wb-preview-table"');
    expect(html).toContain("<td>1</td>");
    expect(html).toContain('class="wb-wikilink"');
  });
});

describe("ChatBody renders", () => {
  it("keeps `[n]` a citation BUTTON, not a link", () => {
    const html = renderChat("Answer [1] and [2].");
    expect(html).toContain('<button type="button" class="wb-chat-cite">[1]</button>');
    expect(html).toContain(">[2]</button>");
    // A citation that navigated would unmount the Workbench.
    expect(html).not.toContain(CITATION_HREF_PREFIX);
    expect(html).not.toContain("<a ");
  });

  it("renders a marker as text when nothing can be docked", () => {
    // Mid-stream: the citation list arrives with `done`, so a button now would
    // resolve to nothing when pressed.
    const html = renderChat("Answer [1].", false);
    expect(html).toContain('<span class="wb-chat-cite">[1]</span>');
    expect(html).not.toContain("<button");
  });

  it("renders GFM, math, and a citation in the same answer", () => {
    const html = renderChat("| a |\n| - |\n| 1 |\n\n$x^2$ per [1].");
    expect(html).toContain('class="wb-chat-table"');
    expect(html).toContain("katex");
    expect(html).toContain("wb-chat-cite");
  });

  it("never turns a `[n]` inside code into a control", () => {
    const html = renderChat("Use `arr[1]` and see [2].");
    expect(html).toContain("<code>arr[1]</code>");
    // Exactly one control: the real citation, not the array index.
    expect(html.match(/wb-chat-cite/g)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5. The rules a render cannot reach
// ---------------------------------------------------------------------------

describe("the type lock survives Story 7.8", () => {
  it("names no face in either body component", async () => {
    // The faces are `--wb-*` tokens applied by `.wb-preview-body` (Georgia) and
    // inherited by `.wb-chat-body` (system sans). A family named in a component
    // is how one of the two silently becomes the other.
    for (const file of ["PreviewBody.tsx", "ChatBody.tsx"]) {
      const source = await read(file);
      expect(source.replaceAll("sans-serif", ""), file).not.toContain("serif");
      expect(source, file).not.toContain("Georgia");
      expect(source, file).not.toContain("font-family");
    }
  });

  it("shares the mechanism with the article renderer, never its chrome", async () => {
    for (const file of ["PreviewBody.tsx", "ChatBody.tsx"]) {
      const source = await read(file);
      expect(source, file).toContain("rehypeKatex");
      expect(source, file).toContain("Mermaid");
      // Importing the article renderer would drag its `prose` wrapper, its
      // heading-id scheme and its `next/link` navigation in with it.
      expect(source, file).not.toContain("MarkdownRenderer");
      expect(source, file).not.toMatch(/from "next\/link"/);
      expect(source, file).not.toContain("prose-neutral");
    }
  });
});

describe("the Preview column's media and overlay wiring", () => {
  it("renders a player rather than bytes, and says the Source survived", async () => {
    const source = await read("PreviewColumn.tsx");
    expect(source).toContain('state.kind === "media"');
    expect(source).toContain("previewMediaUrl(state.payload.path)");
    expect(source).toContain("<video");
    expect(source).toContain("<audio");
    // A player error is a caption, never a deletion — and the sentence is the
    // shared constant, not a second copy typed here.
    expect(source).toContain("setMediaFailed(true)");
    expect(source).toContain("PREVIEW_MEDIA_FAILED_COPY");
    expect(source).not.toContain(PREVIEW_MEDIA_FAILED_COPY);
    // `preload="metadata"`: docking must not start pulling a large Source.
    expect(source).toContain('preload="metadata"');
  });

  it("keeps ONE overlay level across all three gates (UX-DR17)", async () => {
    const source = await read("PreviewColumn.tsx");
    // Opening the lightbox closes both confirms…
    expect(source).toContain(
      "function openLightbox(image: { src: string; alt: string }) {",
    );
    // …and each confirm's opener closes the lightbox. Two `setLightbox(null)`
    // calls beyond the reset block and the close handler is what that costs.
    expect(source.match(/setLightbox\(null\)/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it("drops the overlay and the player error on every pick", async () => {
    // A lightbox left standing across a pick shows the PREVIOUS row's image
    // under the new row's header, and its jump docks the row just left.
    const source = await read("PreviewColumn.tsx");
    expect(source).toContain("setLightbox(null);\n      setMediaFailed(false);");
  });
});

describe("the lightbox itself", () => {
  it("closes on Esc, locks the scroll, and offers jump-to-source", async () => {
    const source = await read("PreviewLightbox.tsx");
    expect(source).toContain('event.key === "Escape"');
    expect(source).toContain('document.body.style.overflow = "hidden"');
    // The listener and the lock are removed together, or a dismissed overlay
    // goes on swallowing Esc.
    expect(source).toContain('document.removeEventListener("keydown", onKeyDown)');
    expect(source).toContain("PREVIEW_LIGHTBOX_SOURCE_COPY");
    expect(source).toContain("PREVIEW_LIGHTBOX_CLOSE_COPY");
    // Focus starts inside the overlay, or a keyboard owner is tabbing through
    // a page they cannot see the boundaries of.
    expect(source).toContain("closeRef.current?.focus()");
    // NOT the Vault's component: that one's foot navigates out of the app.
    expect(source).not.toContain("VaultExplorer");
  });
});
