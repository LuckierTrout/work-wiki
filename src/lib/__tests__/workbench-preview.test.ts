/**
 * Story 1.5 — the Preview's only real logic, executed rather than grepped.
 *
 * Two things in this story can be wrong in a way no source scan would notice:
 * the wikilink parser (which must not touch code, must not nest anchors, and
 * must leave malformed syntax byte-identical) and the read gate behind
 * `readWorkbenchFile` (which decides what the Preview may fetch at all). Both
 * run here — the parser directly, the gate against a real temp `DATA_DIR`
 * through the filesystem provider, the same fixture convention
 * `workbench-tree.test.ts` uses.
 *
 * The renderer itself is not exercised: vitest runs `environment: "node"` and
 * this story is forbidden from adding jsdom. What it CAN pin without a DOM is
 * the mdast the renderer receives, which is where every wikilink rule lives.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

/**
 * The route's own gate is `getPrincipal()`. Mocked here — hoisted, so it governs
 * the whole file — because there is no Clerk session in a node suite and the
 * thing under test is what the route does WITH a principal, not how it gets one.
 * `authz` only imports the `Principal` TYPE from this module, so nothing else in
 * the file is affected.
 */
const principal = vi.hoisted(() => ({ current: null as { id: string; handle: string } | null }));
vi.mock("@/lib/auth", () => ({
  getPrincipal: vi.fn(async () => principal.current),
}));
import { stripFrontmatterBlock } from "../markdown";
import {
  ARTIFACT_WRITE_ROUTE,
  PAGE_WRITE_ROUTE,
  PREVIEW_CANCEL_COPY,
  PREVIEW_CLOSED_COPY,
  PREVIEW_DISCARD_CONFIRM_BODY,
  PREVIEW_DISCARD_CONFIRM_LABEL,
  PREVIEW_DISCARD_CONFIRM_TITLE,
  PREVIEW_EDIT_CONFIRM_BODY,
  PREVIEW_EDIT_CONFIRM_LABEL,
  PREVIEW_EDIT_CONFIRM_TITLE,
  PREVIEW_FAILED_COPY,
  PREVIEW_KEEP_EDITING_COPY,
  PREVIEW_MAX_CHARS,
  PREVIEW_REMOVED_COPY,
  PREVIEW_RETRY_COPY,
  PREVIEW_RETRYING_COPY,
  PREVIEW_ROUTE,
  PREVIEW_SAVE_FAILED_COPY,
  PREVIEW_TIMEOUT_REASON,
  PREVIEW_TRUNCATED_COPY,
  PREVIEW_STALE_ANNOUNCEMENT_COPY,
  PREVIEW_UNREACHABLE_COPY,
  PREVIEW_UNREACHABLE_STREAK,
  PREVIEW_UPDATED_COPY,
  WIKILINK_MISSING_COPY,
  artifactWriteUrl,
  canEditPreview,
  capPreviewBody,
  fetchPreview,
  pageWriteUrl,
  previewBodyState,
  previewDockAnnouncement,
  previewDraftDirty,
  previewEditTarget,
  previewFileKind,
  previewRefreshAnnouncement,
  previewRequestUrl,
  previewStaleNotice,
  previewUnreachableAnnouncement,
  previewWriteTarget,
  savePreviewBody,
  type PreviewFetch,
  type PreviewPayload,
} from "../workbench-preview";
import {
  WIKILINK_HREF_PREFIX,
  markdownLinkTarget,
  parseWikilinkRuns,
  previewLinkKind,
  remarkWikilinks,
  resolveWikilink,
  wikilinkHref,
  wikilinkTargetFromHref,
} from "../workbench-wikilinks";
import { buildFileTree, wikilinkSelection } from "../workbench-tree";
import {
  WRITE_CONFLICT_COPY,
  WRITE_PRECONDITION_REQUIRED_COPY,
  contentVersion,
  formatIfMatch,
} from "../write-precondition";
import { readWorkbenchFile } from "../workbench-files";
import { wikiArtifactPath, wikiRegistryPath } from "../wikis";
import { tenantForOwner, tenantRawRelPath, tenantWikiRelPath } from "../wiki";
import { getDataDir } from "../paths";
import { _resetStorage } from "../storage";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PreviewBody, previewUrlTransform } from "@/components/workbench/PreviewBody";

// ---------------------------------------------------------------------------
// Wikilink parsing
// ---------------------------------------------------------------------------

describe("parseWikilinkRuns", () => {
  it("splits a plain link out of its surrounding text", () => {
    expect(parseWikilinkRuns("see [[alpha]] now")).toEqual([
      { kind: "text", value: "see " },
      { kind: "link", target: "alpha", label: "alpha" },
      { kind: "text", value: " now" },
    ]);
  });

  it("takes the target first and the label second", () => {
    // The order `src/lib/export.ts` emits: `[[slug|Title]]`.
    expect(parseWikilinkRuns("[[alpha-beta|Alpha Beta]]")).toEqual([
      { kind: "link", target: "alpha-beta", label: "Alpha Beta" },
    ]);
  });

  it("keeps malformed syntax verbatim instead of eating the brackets", () => {
    // Every one of these is text the owner typed. Dropping the brackets — or
    // emitting a link to nowhere — would edit their prose.
    for (const source of ["[[]]", "[[ | x ]]", "[[a", "a]]", "[[|]]", "[[   ]]"]) {
      expect(parseWikilinkRuns(source)).toEqual([{ kind: "text", value: source }]);
    }
  });

  it("finds several links in one run and trims around the pipe", () => {
    expect(parseWikilinkRuns("[[ a ]] and [[ b | B ]]")).toEqual([
      { kind: "link", target: "a", label: "a" },
      { kind: "text", value: " and " },
      { kind: "link", target: "b", label: "B" },
    ]);
  });

  it("falls back to the target when the label half is empty", () => {
    expect(parseWikilinkRuns("[[alpha|]]")).toEqual([
      { kind: "link", target: "alpha", label: "alpha" },
    ]);
  });

  it("does not let one run straddle two links", () => {
    const runs = parseWikilinkRuns("[[a]][[b]]");
    expect(runs).toEqual([
      { kind: "link", target: "a", label: "a" },
      { kind: "link", target: "b", label: "b" },
    ]);
  });
});

describe("the wikilink href round trip", () => {
  it("survives a target with a space, a slash and a percent", () => {
    for (const target of ["Alpha Beta", "a/b", "100% sure", "研究"]) {
      expect(wikilinkTargetFromHref(wikilinkHref(target))).toBe(target);
    }
  });

  it("returns null for an ordinary href", () => {
    for (const href of ["https://example.com", "/u/yopedia/a", "a.md", ""]) {
      expect(wikilinkTargetFromHref(href)).toBeNull();
    }
  });

  it("survives a malformed escape rather than throwing mid-render", () => {
    expect(wikilinkTargetFromHref(`${WIKILINK_HREF_PREFIX}%E0%A4%A`)).toBe("%E0%A4%A");
  });
});

describe("markdownLinkTarget", () => {
  it("claims a relative .md link, whatever shape it arrives in", () => {
    // `[text](slug.md)` is what the kernel WRITES and `extractWikiLinks` parses,
    // so this is the common in-content link, not an edge case.
    expect(markdownLinkTarget("alpha.md")).toBe("alpha");
    expect(markdownLinkTarget("./alpha.md")).toBe("alpha");
    expect(markdownLinkTarget("wiki/alpha.md")).toBe("alpha");
    expect(markdownLinkTarget("alpha.MD")).toBe("alpha");
    // A fragment or query is addressing a place in the page, not another page.
    expect(markdownLinkTarget("alpha.md#section")).toBe("alpha");
    expect(markdownLinkTarget("alpha.md?v=2")).toBe("alpha");
  });

  it("leaves anything that is not a relative .md link alone", () => {
    for (const href of [
      "https://example.com/a.md",
      "http://example.com/a.md",
      "mailto:someone@example.com",
      "data:text/plain,a.md",
      "//example.com/a.md",
      "#section",
      "/u/yopedia/alpha",
      "alpha.txt",
      "alpha",
      ".md",
      "",
    ]) {
      expect(markdownLinkTarget(href)).toBeNull();
    }
  });

  it("refuses a directory a page does not live in", () => {
    // Keeping only the last segment would resolve `raw/notes.md` — a SOURCE —
    // against the page slug `notes`, so the link would open an unrelated page or
    // label a real file "(missing page)". The kernel's own parser agrees that
    // this is not the page `notes`: `extractWikiLinks` reads the target as
    // `raw/notes`. These fall through to `previewLinkKind`, which renders text.
    for (const href of [
      "raw/notes.md",
      "raw/alpha/scan.md",
      "../alpha.md",
      "docs/alpha.md",
      "wiki/sub/alpha.md",
    ]) {
      expect(markdownLinkTarget(href)).toBeNull();
      expect(previewLinkKind(href)).toBe("inert");
    }
    // The two directories a page IS addressed by are unaffected: `wiki/` is the
    // display path the tree prints, `./` is the file's own directory.
    expect(markdownLinkTarget("./wiki/alpha.md")).toBe("alpha");
    expect(markdownLinkTarget("WIKI/alpha.md")).toBe("alpha");
  });

  it("percent-decodes the segment, so both spellings of one link agree", () => {
    // A link destination is a URL and most editors escape a space in one. Left
    // encoded the target is `Alpha%20Beta`, which `slugify` cannot map onto the
    // page `[[Alpha Beta]]` reaches — one link, two answers.
    expect(markdownLinkTarget("Alpha%20Beta.md")).toBe("Alpha Beta");
    expect(resolveWikilink(markdownLinkTarget("Alpha%20Beta.md")!, new Set(["alpha-beta"])))
      .toEqual({ slug: "alpha-beta", exists: true });
    // A malformed escape is kept verbatim rather than throwing mid-render.
    expect(markdownLinkTarget("100%.md")).toBe("100%");
  });
});

describe("previewLinkKind", () => {
  it("keeps a link in the shell unless leaving it opens a new tab", () => {
    // `inert` is the one that matters: each of these navigates the SAME tab off
    // the Workbench, which is what the story's "do not navigate" rule forbids —
    // `/u/…` by name — and unlike a wikilink there is nothing to select instead.
    for (const href of ["/u/yopedia/alpha", "raw/scan.pdf", "./notes.txt", "", undefined, null]) {
      expect(previewLinkKind(href)).toBe("inert");
    }
    // A new tab leaves the Workbench standing; a fragment never left.
    for (const href of ["https://example.com", "http://example.com", "mailto:a@b.c", "//cdn.example.com/x"]) {
      expect(previewLinkKind(href)).toBe("external");
    }
    // `remark-gfm` emits both of these for a footnote and its back-reference.
    expect(previewLinkKind("#user-content-fn-1")).toBe("anchor");
    expect(previewLinkKind("#user-content-fnref-1")).toBe("anchor");
  });
});

describe("resolveWikilink", () => {
  it("slugifies the target before looking it up", () => {
    const slugs = new Set(["alpha-beta"]);
    expect(resolveWikilink("Alpha Beta", slugs)).toEqual({
      slug: "alpha-beta",
      exists: true,
    });
    expect(resolveWikilink("alpha-beta", slugs)).toEqual({
      slug: "alpha-beta",
      exists: true,
    });
  });

  it("reports a target outside the readable set as missing", () => {
    expect(resolveWikilink("ghost", new Set(["alpha"]))).toEqual({
      slug: "ghost",
      exists: false,
    });
  });

  it("never resolves a target that slugifies to nothing", () => {
    expect(resolveWikilink("!!!", new Set([""]))).toEqual({ slug: "", exists: false });
  });
});

// ---------------------------------------------------------------------------
// The remark pass
// ---------------------------------------------------------------------------

/** Minimal mdast shapes, hand-built — `@types/mdast` is not a dependency. */
interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
}

function run(tree: Node): Node {
  remarkWikilinks()(tree);
  return tree;
}

function text(value: string): Node {
  return { type: "text", value };
}

describe("remarkWikilinks", () => {
  it("replaces a text node with text and link nodes", () => {
    const tree = run({
      type: "root",
      children: [{ type: "paragraph", children: [text("see [[alpha]] now")] }],
    });
    expect(tree.children?.[0].children).toEqual([
      { type: "text", value: "see " },
      {
        type: "link",
        url: `${WIKILINK_HREF_PREFIX}alpha`,
        children: [{ type: "text", value: "alpha" }],
      },
      { type: "text", value: " now" },
    ]);
  });

  it("cannot reach inside a fenced code block", () => {
    // The whole reason this is an mdast pass and not a source rewrite: `code`
    // carries its source in `value` and has no children, so the walk has no way
    // in. A regex over the markdown string could not promise this.
    const tree = run({
      type: "root",
      children: [{ type: "code", value: "see [[alpha]] now" }],
    });
    expect(tree.children?.[0]).toEqual({ type: "code", value: "see [[alpha]] now" });
  });

  it("cannot reach inside inline code", () => {
    const tree = run({
      type: "root",
      children: [
        { type: "paragraph", children: [{ type: "inlineCode", value: "[[alpha]]" }] },
      ],
    });
    expect(tree.children?.[0].children).toEqual([
      { type: "inlineCode", value: "[[alpha]]" },
    ]);
  });

  it("leaves text inside a link alone, so no anchor nests in another", () => {
    for (const type of ["link", "linkReference"]) {
      const tree = run({
        type: "root",
        children: [
          {
            type: "paragraph",
            children: [{ type, url: "https://example.com", children: [text("[[alpha]]")] }],
          },
        ],
      });
      expect(tree.children?.[0].children?.[0].children).toEqual([
        { type: "text", value: "[[alpha]]" },
      ]);
    }
  });

  it("descends into nested containers", () => {
    const tree = run({
      type: "root",
      children: [
        {
          type: "blockquote",
          children: [{ type: "paragraph", children: [text("[[alpha|A]]")] }],
        },
      ],
    });
    expect(tree.children?.[0].children?.[0].children).toEqual([
      {
        type: "link",
        url: `${WIKILINK_HREF_PREFIX}alpha`,
        children: [{ type: "text", value: "A" }],
      },
    ]);
  });

  it("leaves a tree with no wikilinks structurally identical", () => {
    const before: Node = {
      type: "root",
      children: [{ type: "paragraph", children: [text("nothing to see")] }],
    };
    const original = before.children?.[0].children?.[0];
    run(before);
    // Same NODE, not merely an equal one: an unconditional rebuild would drop
    // every field this transform does not know about (positions, GFM extras).
    expect(before.children?.[0].children?.[0]).toBe(original);
  });

  it("tolerates a tree that is not a tree", () => {
    expect(() => remarkWikilinks()(null)).not.toThrow();
    expect(() => remarkWikilinks()("nope")).not.toThrow();
    expect(() => remarkWikilinks()({ type: "root" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

describe("stripFrontmatterBlock", () => {
  it("removes a terminated block and the blank line after it", () => {
    expect(stripFrontmatterBlock("---\nx: 1\n---\n# T")).toBe("# T");
    expect(stripFrontmatterBlock("---\nx: 1\n---\n\n# T")).toBe("# T");
    expect(stripFrontmatterBlock("---\r\nx: 1\r\n---\r\n# T")).toBe("# T");
    // An empty block is still a block.
    expect(stripFrontmatterBlock("---\n---\n# T")).toBe("# T");
  });

  it("returns a body with no frontmatter unchanged", () => {
    expect(stripFrontmatterBlock("# T\n\nbody")).toBe("# T\n\nbody");
  });

  it("returns an UNTERMINATED opener unchanged rather than half-stripping", () => {
    // A body that opens with a horizontal rule is content, not frontmatter.
    expect(stripFrontmatterBlock("---\nx: 1")).toBe("---\nx: 1");
    expect(stripFrontmatterBlock("---\nx: 1\n")).toBe("---\nx: 1\n");
  });

  it("never throws, whatever it is handed", () => {
    expect(stripFrontmatterBlock("")).toBe("");
    // A second `---` LATER in the body is not the opener's terminator unless
    // the block really did open at character zero.
    expect(stripFrontmatterBlock("body\n---\nmore")).toBe("body\n---\nmore");
  });

  it("leaves a body that is exactly one block empty, not mangled", () => {
    expect(stripFrontmatterBlock("---\nx: 1\n---\n")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Format, request shape and copy
// ---------------------------------------------------------------------------

describe("previewFileKind", () => {
  it("names the format from the extension alone", () => {
    expect(previewFileKind("a.md")).toBe("markdown");
    expect(previewFileKind("wiki/a.md")).toBe("markdown");
    expect(previewFileKind("a.txt")).toBe("text");
    expect(previewFileKind("a.pdf")).toBe("unsupported");
    expect(previewFileKind("a")).toBe("unsupported");
  });

  it("reads the extension of the LAST segment, case-insensitively", () => {
    expect(previewFileKind("raw/a.md/b")).toBe("unsupported");
    expect(previewFileKind("A.MD")).toBe("markdown");
    // A dotfile has no extension — `.md` is its whole name.
    expect(previewFileKind(".md")).toBe("unsupported");
  });
});

describe("previewRequestUrl", () => {
  it("addresses each selection shape by its own parameters", () => {
    expect(previewRequestUrl({ kind: "page", slug: "alpha beta" })).toBe(
      `${PREVIEW_ROUTE}?kind=page&slug=alpha+beta`,
    );
    expect(previewRequestUrl({ kind: "file", path: "wiki/a.md" })).toBe(
      `${PREVIEW_ROUTE}?kind=file&path=wiki%2Fa.md`,
    );
  });
});

const PAYLOAD_SHAPE: PreviewPayload = {
  name: "Alpha",
  path: "wiki/alpha.md",
  slug: "alpha",
  format: "markdown",
  body: "# Alpha\n",
  truncated: false,
  editable: true,
};

describe("capPreviewBody", () => {
  it("passes a body under the cap through untouched", () => {
    expect(capPreviewBody("short")).toEqual({ body: "short", truncated: false });
    const exact = "x".repeat(PREVIEW_MAX_CHARS);
    expect(capPreviewBody(exact)).toEqual({ body: exact, truncated: false });
  });

  it("cuts an oversized body to the cap", () => {
    const result = capPreviewBody("x".repeat(PREVIEW_MAX_CHARS + 10));
    expect(result.truncated).toBe(true);
    expect(result.body).toHaveLength(PREVIEW_MAX_CHARS);
  });

  it("never cuts through a surrogate pair", () => {
    // `slice` counts UTF-16 code UNITS. An emoji straddling the boundary would
    // otherwise ship a LONE high surrogate — not a character, and not something
    // that survives JSON as what it was.
    const emoji = "😀"; // two code units
    const body = "x".repeat(PREVIEW_MAX_CHARS - 1) + emoji;
    const result = capPreviewBody(body);
    expect(result.truncated).toBe(true);
    expect(result.body).toHaveLength(PREVIEW_MAX_CHARS - 1);
    // The proof: no unpaired surrogate survived the cut.
    for (const unit of result.body) expect(unit.codePointAt(0)).toBeLessThan(0xd800);
    expect(JSON.parse(JSON.stringify(result.body))).toBe(result.body);
  });

  it("keeps a pair that ends exactly on the boundary", () => {
    const body = "x".repeat(PREVIEW_MAX_CHARS - 2) + "😀" + "tail";
    const result = capPreviewBody(body);
    expect(result.body).toHaveLength(PREVIEW_MAX_CHARS);
    expect(result.body.endsWith("😀")).toBe(true);
  });
});

describe("canEditPreview", () => {
  const editable: PreviewPayload = { ...PAYLOAD_SHAPE, editable: true, truncated: false };
  /** The live column: bytes on screen and the route still answering. */
  const showing = (payload: PreviewPayload | null) => ({ gone: false, payload });

  it("offers the editor only for an editable, whole body", () => {
    expect(canEditPreview(showing(editable))).toBe(true);
    expect(canEditPreview(showing(null))).toBe(false);
    expect(canEditPreview(showing({ ...editable, editable: false }))).toBe(false);
    // The half that is easy to drop: the editor is seeded with `body`, which for
    // a capped page is a PREFIX, and saving it would replace the whole page.
    expect(canEditPreview(showing({ ...editable, truncated: true }))).toBe(false);
    expect(
      canEditPreview(showing({ ...editable, editable: false, truncated: true })),
    ).toBe(false);
  });

  it("refuses a payload that is editable but names no target at all", () => {
    // The editor writes to a target's URL. With neither a slug nor an artifact
    // the control opens, `Save` enables, and pressing it does nothing at all —
    // no write and no message. Neither route emits this shape and
    // `isPreviewPayload` does not check it, so this is the only thing that
    // refuses it.
    const { slug: _slug, ...slugless } = editable;
    expect(canEditPreview(showing(slugless as PreviewPayload))).toBe(false);
    expect(canEditPreview(showing({ ...editable, slug: "" }))).toBe(false);
  });

  it("offers the editor for the editable artifact, which has no slug", () => {
    // Story 1.8: `schema.md` is editable and is NOT a page — the old
    // slug-or-nothing rule would have refused it forever.
    const { slug: _slug, ...base } = editable;
    const schema = { ...base, artifact: "schema.md" } as PreviewPayload;
    expect(canEditPreview(showing(schema))).toBe(true);
    // The server still decides, and truncation still refuses — saving a capped
    // prefix over an executable Schema is the same mistake as over a page.
    expect(canEditPreview(showing({ ...schema, editable: false }))).toBe(false);
    expect(canEditPreview(showing({ ...schema, truncated: true }))).toBe(false);
    // The allowlist is the gate, not "any string in `artifact`".
    expect(
      canEditPreview(
        showing({ ...base, artifact: "purpose.md" } as unknown as PreviewPayload),
      ),
    ).toBe(false);
  });

  it("refuses everything a 404 replaced, however editable the kept payload is", () => {
    // DW-181. The `gone` branch KEEPS the payload on purpose (DW-54), so every
    // one of these describes bytes that WERE editable and are no longer on
    // screen. Asked about the payload alone this answers `true` for all of them.
    const { slug: _slug, ...base } = editable;
    for (const payload of [
      editable,
      { ...base, artifact: "schema.md" } as PreviewPayload,
      { ...editable, version: "v9" },
    ]) {
      expect(canEditPreview({ gone: true, payload })).toBe(false);
      expect(canEditPreview({ gone: false, payload })).toBe(true);
    }
  });
});

describe("previewEditTarget (DW-181)", () => {
  const editable: PreviewPayload = { ...PAYLOAD_SHAPE, editable: true, truncated: false };

  it("is previewWriteTarget for a column the route is still answering", () => {
    // Not a second rule: `gone: false` is the whole of the old behaviour, so
    // Story 1.8's page/artifact split cannot drift out of this one.
    const { slug: _slug, ...base } = editable;
    for (const payload of [
      editable,
      { ...editable, truncated: true },
      { ...editable, editable: false },
      { ...base, artifact: "schema.md" } as PreviewPayload,
      base as PreviewPayload,
      null,
    ]) {
      expect(previewEditTarget({ gone: false, payload })).toEqual(
        previewWriteTarget(payload),
      );
    }
  });

  it("answers null over a 404, for both kinds", () => {
    const { slug: _slug, ...base } = editable;
    const schema = { ...base, artifact: "schema.md" } as PreviewPayload;
    // The page and the Schema both have somewhere to write, and both lose it
    // the moment the route says the row is not there. The affordance, the
    // confirm copy, `startEditing` and BOTH of `save()`'s guards read this, so
    // this `null` is what refuses the write as well as the button.
    expect(previewWriteTarget(editable)).not.toBeNull();
    expect(previewWriteTarget(schema)).not.toBeNull();
    expect(previewEditTarget({ gone: true, payload: editable })).toBeNull();
    expect(previewEditTarget({ gone: true, payload: schema })).toBeNull();
    expect(previewEditTarget({ gone: true, payload: null })).toBeNull();
  });

  it("is exactly what canEditPreview asks, on both sides of `gone`", () => {
    const { slug: _slug, ...base } = editable;
    for (const gone of [false, true]) {
      for (const payload of [
        editable,
        { ...editable, truncated: true },
        { ...base, artifact: "schema.md" } as PreviewPayload,
        null,
      ]) {
        expect(canEditPreview({ gone, payload })).toBe(
          previewEditTarget({ gone, payload }) !== null,
        );
      }
    }
  });
});

describe("previewUnreachableAnnouncement (DW-183)", () => {
  /** Bytes on screen — the state the strip and the sentence are both about. */
  const shown: PreviewPayload = { ...PAYLOAD_SHAPE, editable: true, truncated: false };

  it("stays silent for a single blip", () => {
    // One failed read heals on the next read that already happens, with the
    // bytes on screen unchanged throughout. A sentence in a reader's ear for a
    // condition that is already over is chatter.
    expect(previewUnreachableAnnouncement({ failures: 1, payload: shown })).toBeNull();
    expect(previewUnreachableAnnouncement({ failures: 0, payload: shown })).toBeNull();
  });

  it("says it on the second consecutive failure", () => {
    expect(PREVIEW_UNREACHABLE_STREAK).toBe(2);
    expect(
      previewUnreachableAnnouncement({
        failures: PREVIEW_UNREACHABLE_STREAK,
        payload: shown,
      }),
    ).toBe(PREVIEW_STALE_ANNOUNCEMENT_COPY);
  });

  it("says it ONCE, not on every failure after that", () => {
    // Exactly ON the threshold, never at-or-above. With `>=` — and with DW-182's
    // mark making a repeat audible again — a reader would be told the same thing
    // on every `dataVersion` bump in the system for as long as the outage ran.
    for (const failures of [3, 4, 12, 99]) {
      expect(previewUnreachableAnnouncement({ failures, payload: shown })).toBeNull();
    }
  });

  it("says nothing at all when there is no last version to be showing", () => {
    // The sentence claims bytes are on screen. With no payload the column is
    // rendering `PREVIEW_FAILED_COPY` and `previewStaleNotice` shows no strip —
    // that row's FIRST read failed, so nothing ever loaded. Announcing there
    // would contradict the body, with no strip beside it to be the visual half.
    for (const failures of [0, 1, PREVIEW_UNREACHABLE_STREAK, 3, 99]) {
      expect(previewUnreachableAnnouncement({ failures, payload: null })).toBeNull();
    }
  });

  it("agrees with the strip on every failure count", () => {
    // The two are one decision seen twice — an announcement with no strip is a
    // sentence about a screen that does not say it. `previewStaleNotice`'s other
    // terms are pinned to the state this branch actually runs in: the result was
    // unreachable, the read has settled, and `previewFetchPlan` refuses to fetch
    // at all while the editor is open.
    for (const payload of [shown, null]) {
      for (const failures of [1, PREVIEW_UNREACHABLE_STREAK, 3]) {
        const spoken = previewUnreachableAnnouncement({ failures, payload }) !== null;
        const visible = previewStaleNotice({
          loading: false,
          gone: false,
          unreachable: true,
          editing: false,
          payload,
        });
        expect(spoken && !visible).toBe(false);
      }
    }
  });

  it("says the strip's own sentence, named for the surface", () => {
    // Built FROM the strip's copy, so the sentence on screen and the sentence a
    // reader hears cannot drift into two accounts of one fact.
    expect(PREVIEW_STALE_ANNOUNCEMENT_COPY).toContain(PREVIEW_UNREACHABLE_COPY);
    expect(PREVIEW_STALE_ANNOUNCEMENT_COPY).toContain("Preview");
    // …and NOT the same string, or `getByText` could not tell the strip from the
    // region — a live announcement arrives with none of the strip's surroundings
    // and has to name the surface it is about.
    expect(PREVIEW_STALE_ANNOUNCEMENT_COPY).not.toBe(PREVIEW_UNREACHABLE_COPY);
    // Not the body's failure sentence either: nothing was lost.
    expect(PREVIEW_STALE_ANNOUNCEMENT_COPY).not.toContain(PREVIEW_FAILED_COPY);
    expect(PREVIEW_STALE_ANNOUNCEMENT_COPY).not.toContain("'");
  });
});

describe("previewDraftDirty", () => {
  it("says nothing is at stake while the editor is closed", () => {
    // `draft` outlives the editor — it is plain state that keeps whatever the
    // last session of editing left in it. Read without the `editing` term, a
    // pick made minutes after a save would still be gated behind a discard
    // confirm for text that is already on disk.
    expect(previewDraftDirty({ editing: false, draft: "typed", seed: "# Alpha" })).toBe(
      false,
    );
    expect(previewDraftDirty({ editing: false, draft: "", seed: null })).toBe(false);
  });

  it("says nothing is at stake for an untouched draft", () => {
    // The editor is seeded with exactly the bytes the body rendered, so an
    // opened-and-not-typed-in editor holds nothing to lose. Answering `true`
    // here would put a dialog in front of every pick made with the editor open.
    expect(previewDraftDirty({ editing: true, draft: "# Alpha", seed: "# Alpha" })).toBe(
      false,
    );
    expect(previewDraftDirty({ editing: true, draft: "", seed: "" })).toBe(false);
  });

  it("says text would be LOST once the draft moves off the seed", () => {
    expect(previewDraftDirty({ editing: true, draft: "# Alpha!", seed: "# Alpha" })).toBe(
      true,
    );
    // Deletion is a loss too — a cleared textarea is not "unedited".
    expect(previewDraftDirty({ editing: true, draft: "", seed: "# Alpha" })).toBe(true);
    // …and one character into an empty file is, which is why an empty-string
    // seed cannot be folded into the `null` case below.
    expect(previewDraftDirty({ editing: true, draft: "x", seed: "" })).toBe(true);
    // Whitespace is text the owner typed. Nothing here trims: `Save` refuses a
    // whitespace-only body, but refusing to SAVE it is not permission to
    // silently throw it away.
    expect(previewDraftDirty({ editing: true, draft: "# Alpha ", seed: "# Alpha" })).toBe(
      true,
    );
  });

  it("refuses to guess when no seed was recorded", () => {
    // An open editor with no seed is a state nothing produces — the seed and
    // `editing` are set in the same commit — and it is deliberately NOT read as
    // dirty. Answering `true` on a missing comparison would gate every pick
    // behind a confirm the moment the capture ever regressed, which costs a
    // click on every single pick and reads as a broken tree.
    expect(previewDraftDirty({ editing: true, draft: "typed", seed: null })).toBe(false);
    expect(previewDraftDirty({ editing: true, draft: "", seed: null })).toBe(false);
  });
});

describe("previewWriteTarget", () => {
  const editable: PreviewPayload = { ...PAYLOAD_SHAPE, editable: true, truncated: false };

  it("routes a page to the page write path", () => {
    expect(previewWriteTarget(editable)).toEqual({
      kind: "page",
      key: "page:alpha",
      url: "/api/wiki/alpha",
    });
  });

  it("routes the artifact to the artifact write path", () => {
    const { slug: _slug, ...base } = editable;
    expect(
      previewWriteTarget({ ...base, artifact: "schema.md" } as PreviewPayload),
    ).toEqual({
      kind: "artifact",
      key: "artifact:schema.md",
      url: "/api/workbench/artifact?path=schema.md",
    });
  });

  it("namespaces the key so a page can never collide with the artifact", () => {
    // A page whose slug reads `schema.md` and the Schema itself must not share
    // a key: the column compares keys to decide whether the row on screen is
    // still the one the draft came from, and a collision there would let a save
    // land on the wrong URL.
    const page = previewWriteTarget({ ...editable, slug: "schema.md" });
    const { slug: _slug, ...base } = editable;
    const artifact = previewWriteTarget({
      ...base,
      artifact: "schema.md",
    } as PreviewPayload);
    expect(page?.key).not.toBe(artifact?.key);
    expect(page?.url).not.toBe(artifact?.url);
  });

  it("answers null for everything with nowhere to write", () => {
    const { slug: _slug, ...slugless } = editable;
    expect(previewWriteTarget(null)).toBeNull();
    expect(previewWriteTarget({ ...editable, editable: false })).toBeNull();
    expect(previewWriteTarget({ ...editable, truncated: true })).toBeNull();
    expect(previewWriteTarget(slugless as PreviewPayload)).toBeNull();
  });

  it("is exactly what canEditPreview asks", () => {
    // Not two rules that agree today: one is defined as the other, so the
    // truncation half cannot be dropped from the edit control without also
    // dropping it from the save. Through `previewEditTarget` since DW-181,
    // which adds `gone` to the same one derivation rather than beside it.
    const { slug: _slug, ...base } = editable;
    for (const payload of [
      editable,
      { ...editable, truncated: true },
      { ...editable, editable: false },
      { ...base, artifact: "schema.md" } as PreviewPayload,
      base as PreviewPayload,
    ]) {
      expect(canEditPreview({ gone: false, payload })).toBe(
        previewWriteTarget(payload) !== null,
      );
    }
  });
});

describe("artifactWriteUrl", () => {
  it("names the route and carries nothing but the file", () => {
    expect(ARTIFACT_WRITE_ROUTE).toBe("/api/workbench/artifact");
    expect(artifactWriteUrl("schema.md")).toBe("/api/workbench/artifact?path=schema.md");
    // The browser names neither a Wiki, a tenant nor a storage key — the route
    // re-derives all three from the session.
    expect(artifactWriteUrl("schema.md")).not.toMatch(/tenant|wikis?\/|wikiId/);
  });
});

describe("previewBodyState", () => {
  const payload: PreviewPayload = { ...PAYLOAD_SHAPE };

  it("shows the loading sentence before anything else", () => {
    expect(previewBodyState({ loading: true, gone: false, payload: null })).toEqual({
      kind: "loading",
    });
    // Still loading even with a stale payload still on screen: the column is
    // about to replace it, and rendering it under the new row's header would
    // put one file's bytes under another file's name.
    expect(previewBodyState({ loading: true, gone: true, payload })).toEqual({
      kind: "loading",
    });
  });

  it("treats a missing payload as a failure once loading is over", () => {
    expect(previewBodyState({ loading: false, gone: true, payload })).toEqual({
      kind: "failed",
    });
    // The flag is not the only route into this state: settled with nothing to
    // render is a failure whether or not anything set it.
    expect(previewBodyState({ loading: false, gone: false, payload: null })).toEqual({
      kind: "failed",
    });
  });

  it("answers an unsupported format before it asks whether the body is empty", () => {
    // Order matters: the route sends `body: ""` for a blob it never read, so an
    // `empty`-first branch would say `This file is empty.` about a PDF.
    expect(
      previewBodyState({
        loading: false,
        gone: false,
        payload: { ...payload, format: "unsupported", body: "" },
      }),
    ).toEqual({ kind: "unsupported" });
  });

  it("distinguishes an empty file from a body", () => {
    expect(
      previewBodyState({ loading: false, gone: false, payload: { ...payload, body: "" } }),
    ).toEqual({ kind: "empty" });
    // Whitespace only is empty to a reader, and the sentence is the honest
    // answer rather than a blank column.
    expect(
      previewBodyState({ loading: false, gone: false, payload: { ...payload, body: "\n \t\n" } }),
    ).toEqual({ kind: "empty" });
    expect(previewBodyState({ loading: false, gone: false, payload })).toEqual({
      kind: "body",
      payload,
    });
    // The payload travels with the state, so the caller renders the one it was
    // judged on rather than re-reading a variable that may have moved on.
    const truncated = { ...payload, truncated: true };
    expect(previewBodyState({ loading: false, gone: false, payload: truncated })).toEqual({
      kind: "body",
      payload: truncated,
    });
  });

  it("has no input for a read that merely could not be reached (DW-54)", () => {
    // The rename is the point. The old input was `failed`, which meant all five
    // of deleted, refused, 5xx, blip and malformed — so a dropped packet
    // replaced the page the owner was reading with `This file couldn’t be
    // loaded.` This function now only ever hears about the 404, and an
    // unreachable read reaches `previewStaleNotice` instead. With a payload
    // held, that read leaves the BODY on screen.
    expect(previewBodyState({ loading: false, gone: false, payload })).toEqual({
      kind: "body",
      payload,
    });
    // …and `gone` still wins over the bytes, because a 404 is the one answer
    // that says the row is not there. No strip over that replacement.
    expect(previewBodyState({ loading: false, gone: true, payload })).toEqual({
      kind: "failed",
    });
  });
});

describe("previewStaleNotice", () => {
  const payload: PreviewPayload = { ...PAYLOAD_SHAPE };
  const landed = {
    loading: false,
    gone: false,
    unreachable: false,
    editing: false,
    payload,
  };

  it("shows only over bytes that are actually on screen", () => {
    expect(previewStaleNotice({ ...landed, unreachable: true })).toBe(true);
    // With no payload the column is already showing PREVIEW_FAILED_COPY, and a
    // `Retry` beside it would promise to restore bytes it never had. This is
    // the FRESH-PICK failure the spec refuses to change: no strip.
    expect(previewStaleNotice({ ...landed, unreachable: true, payload: null })).toBe(false);
  });

  it("stays away while a read is in flight or after a 4xx", () => {
    // A read is already answering the previous one's failure; a strip there
    // would report a state the column is in the middle of leaving.
    expect(previewStaleNotice({ ...landed, unreachable: true, loading: true })).toBe(false);
    // The body has been REPLACED by the failure sentence, so "showing the last
    // version that loaded" would be a false statement about what is underneath.
    expect(previewStaleNotice({ ...landed, unreachable: true, gone: true })).toBe(false);
  });

  it("stays away while the editor is open, because Retry could do nothing", () => {
    // `previewFetchPlan` answers `fetch: false` for every run while `editing`,
    // so the strip's one control would be a button that silently no-ops on
    // every press — the worst of the three outcomes `previewWriteTarget`
    // documents, in a different place. Closing the editor lets the deferred
    // read happen, and THAT decides whether the strip comes back.
    expect(previewStaleNotice({ ...landed, unreachable: true, editing: true })).toBe(false);
    // …and it is the editor, not the payload, doing the refusing here.
    expect(previewStaleNotice({ ...landed, unreachable: true, editing: false })).toBe(true);
  });

  it("is absent whenever the read landed", () => {
    expect(previewStaleNotice(landed)).toBe(false);
    // Self-healing, expressed as a pure read of current state rather than a
    // dismissible banner: the next read that already happens clears
    // `unreachable`, and the strip goes with it. No timer is involved.
    expect(previewStaleNotice({ ...landed, payload: null })).toBe(false);
  });
});

describe("previewRefreshAnnouncement", () => {
  const payload: PreviewPayload = { ...PAYLOAD_SHAPE };
  const changed: PreviewPayload = { ...PAYLOAD_SHAPE, body: `${PAYLOAD_SHAPE.body} more` };

  it("announces a body swapped underneath a reader", () => {
    expect(
      previewRefreshAnnouncement({ reset: false, shown: payload, next: changed }),
    ).toBe(PREVIEW_UPDATED_COPY);
  });

  it("says nothing when the bytes did not move", () => {
    // A `dataVersion` bump fires for every write in the system, most of them
    // about some other page. Announcing each one makes the region chatter at a
    // reader whose screen did not change.
    expect(
      previewRefreshAnnouncement({ reset: false, shown: payload, next: { ...payload } }),
    ).toBeNull();
    // …including when a field that is IDENTITY rather than content moved.
    // `name` follows from the row this read was for, which on the announcing
    // path is the row already showing, so it is not something the reader can
    // hear change underneath them.
    expect(
      previewRefreshAnnouncement({
        reset: false,
        shown: payload,
        next: { ...payload, name: "Alpha (renamed)" },
      }),
    ).toBeNull();
  });

  it("announces a truncation that appeared or vanished", () => {
    // Flipping `truncated` adds or removes PREVIEW_TRUNCATED_COPY above the
    // bytes AND takes the `Edit` control with it (`canEditPreview` refuses a
    // prefix), so a page that grew past the cap changes the column visibly even
    // when the first 200,000 characters are byte-identical.
    expect(
      previewRefreshAnnouncement({
        reset: false,
        shown: payload,
        next: { ...payload, truncated: !payload.truncated },
      }),
    ).toBe(PREVIEW_UPDATED_COPY);
  });

  it("says nothing on a fresh pick, which the shell already announced", () => {
    // The dock announcement (`Preview, Alpha`) reported this event once. A
    // second sentence about the same click reports it twice.
    expect(
      previewRefreshAnnouncement({ reset: true, shown: payload, next: changed }),
    ).toBeNull();
    // …including the case where a pick's read genuinely differs from whatever
    // the column happened to be holding a moment earlier.
    expect(
      previewRefreshAnnouncement({ reset: true, shown: null, next: changed }),
    ).toBeNull();
  });

  it("says nothing when there were no bytes to swap out", () => {
    // Nothing was replaced underneath anybody: the column was empty or failed,
    // and the arriving bytes are the first bytes.
    expect(
      previewRefreshAnnouncement({ reset: false, shown: null, next: payload }),
    ).toBeNull();
  });
});

describe("the announcement copy", () => {
  it("names the thing the Preview just docked on", () => {
    // The same shape as `Settings, <category>`: a surface appeared and it is
    // showing a named thing (EXPERIENCE.md:175).
    expect(previewDockAnnouncement("Alpha")).toBe("Preview, Alpha");
    expect(previewDockAnnouncement("a b.md")).toBe("Preview, a b.md");
  });

  it("keeps the two undock sentences apart", () => {
    // One is the owner's own re-click; the other is a row that left the tree
    // while they were reading it. Only the second owes them a reason.
    expect(PREVIEW_CLOSED_COPY).toBe("Preview closed");
    expect(PREVIEW_REMOVED_COPY).not.toBe(PREVIEW_CLOSED_COPY);
    expect(PREVIEW_REMOVED_COPY).toContain("removed");
  });

  it("does not reuse the body's failure sentence for a blip", () => {
    // `PREVIEW_FAILED_COPY` replaces the body. Shown above bytes that are still
    // there it would tell the owner their page is gone while they are reading
    // it — the exact conflation DW-54 is about.
    expect(PREVIEW_UNREACHABLE_COPY).not.toBe(PREVIEW_FAILED_COPY);
    expect(PREVIEW_UPDATED_COPY).toBe("Preview updated");
    expect(PREVIEW_RETRY_COPY).toBe("Retry");
    // …and the busy label is the control's own, in the same register as
    // `Saving…` — never a rewrite of the strip's sentence, which stays true
    // for as long as the bytes below it are the last ones that loaded.
    expect(PREVIEW_RETRYING_COPY).toBe("Retrying…");
    expect(PREVIEW_RETRYING_COPY).not.toBe(PREVIEW_RETRY_COPY);
  });

  it("uses typographic apostrophes, like every other sentence here", () => {
    for (const copy of [
      PREVIEW_CLOSED_COPY,
      PREVIEW_REMOVED_COPY,
      PREVIEW_UPDATED_COPY,
      PREVIEW_UNREACHABLE_COPY,
      PREVIEW_STALE_ANNOUNCEMENT_COPY,
      PREVIEW_RETRY_COPY,
      PREVIEW_RETRYING_COPY,
      PREVIEW_DISCARD_CONFIRM_TITLE,
      PREVIEW_DISCARD_CONFIRM_BODY,
      PREVIEW_DISCARD_CONFIRM_LABEL,
      PREVIEW_KEEP_EDITING_COPY,
      previewDockAnnouncement("Alpha"),
    ]) {
      expect(copy).not.toContain("'");
    }
    expect(PREVIEW_UNREACHABLE_COPY).toContain("’");
  });
});

describe("the discard gate's copy (DW-36)", () => {
  it("names the LOSS, not the mechanism", () => {
    // The owner is being asked to authorise a deletion of their own text. A
    // title that only named the pick ("Open another row?") would hide what the
    // confirm actually costs.
    expect(PREVIEW_DISCARD_CONFIRM_TITLE).toContain("unsaved");
    expect(PREVIEW_DISCARD_CONFIRM_BODY).toContain("discarded");
    // Not tied to "another row": the same dialog covers re-picking the row
    // already showing, which undocks the column and unmounts the editor.
    expect(PREVIEW_DISCARD_CONFIRM_BODY).not.toContain("another row");
  });

  it("keeps the two buttons tellable apart without reading the sentence", () => {
    expect(PREVIEW_DISCARD_CONFIRM_LABEL).toBe("Discard edits");
    expect(PREVIEW_KEEP_EDITING_COPY).toBe("Keep editing");
    // …and neither is `Cancel`, which this surface already spends on leaving the
    // editor. Two controls labelled `Cancel` one overlay apart, with opposite
    // consequences, is the state this wording exists to avoid.
    expect(PREVIEW_KEEP_EDITING_COPY).not.toBe(PREVIEW_CANCEL_COPY);
    expect(PREVIEW_DISCARD_CONFIRM_LABEL).not.toBe(PREVIEW_CANCEL_COPY);
  });

  it("is not the EDIT gate's copy wearing a different name", () => {
    // Two gates, opposite directions: one authorises opening the editor, the
    // other authorises destroying what is in it.
    expect(PREVIEW_DISCARD_CONFIRM_TITLE).not.toBe(PREVIEW_EDIT_CONFIRM_TITLE);
    expect(PREVIEW_DISCARD_CONFIRM_BODY).not.toBe(PREVIEW_EDIT_CONFIRM_BODY);
    expect(PREVIEW_DISCARD_CONFIRM_LABEL).not.toBe(PREVIEW_EDIT_CONFIRM_LABEL);
  });
});

describe("the truncation sentence", () => {
  it("derives its numeral from the cap it describes", () => {
    // Typed, the sentence could outlive the number — and would then tell the
    // owner a falsehood about their own file.
    expect(PREVIEW_TRUNCATED_COPY).toContain("200,000");
    expect(PREVIEW_MAX_CHARS).toBe(200_000);
  });
});

// ---------------------------------------------------------------------------
// Following a wikilink
// ---------------------------------------------------------------------------

describe("wikilinkSelection", () => {
  const files = buildFileTree(["wiki/", "wiki/alpha.md", "raw/"]);

  it("selects the page on the Knowledge tab", () => {
    expect(wikilinkSelection("knowledge", files, "alpha")).toEqual({
      kind: "page",
      slug: "alpha",
    });
  });

  it("selects the file row on the Files tab, so aria-current lands on it", () => {
    expect(wikilinkSelection("files", files, "alpha")).toEqual({
      kind: "file",
      path: "wiki/alpha.md",
    });
  });

  it("falls back to the page when the Files tab has no such row", () => {
    // Truncated, gated out, or a legacy flat-tree page: selecting a row that is
    // not rendered would leave nothing carrying `aria-current`.
    expect(wikilinkSelection("files", files, "ghost")).toEqual({
      kind: "page",
      slug: "ghost",
    });
    expect(wikilinkSelection("files", [], "alpha")).toEqual({
      kind: "page",
      slug: "alpha",
    });
  });
});

// ---------------------------------------------------------------------------
// The read gate
// ---------------------------------------------------------------------------

describe("readWorkbenchFile", () => {
  const OWNER = "yuanhao";
  const WIKI_ID = "11111111-2222-4333-8444-555555555555";
  // Own root, own cleanup — `vitest.setup.ts` only DEFAULTS `DATA_DIR`, so a
  // developer running with it pointed at real data must not lose it.
  let root: string;
  let tmpDir: string;
  let caseIndex = 0;
  let originalDataDir: string | undefined;
  let originalWikiDir: string | undefined;
  let originalRawDir: string | undefined;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "wb-preview-"));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = root;
    // The filesystem provider is a singleton that captures its base path on
    // first use, so pointing `DATA_DIR` somewhere new is not enough on its own.
    _resetStorage();
  });

  afterAll(async () => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    _resetStorage();
    await fs.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    caseIndex += 1;
    tmpDir = path.join(root, `case-${caseIndex}`);
    originalWikiDir = process.env.WIKI_DIR;
    originalRawDir = process.env.RAW_DIR;
    process.env.WIKI_DIR = path.join(tmpDir, "wiki");
    process.env.RAW_DIR = path.join(tmpDir, "raw");
    await fs.mkdir(process.env.WIKI_DIR, { recursive: true });
    await fs.mkdir(process.env.RAW_DIR, { recursive: true });
  });

  afterEach(async () => {
    if (originalWikiDir === undefined) delete process.env.WIKI_DIR;
    else process.env.WIKI_DIR = originalWikiDir;
    if (originalRawDir === undefined) delete process.env.RAW_DIR;
    else process.env.RAW_DIR = originalRawDir;
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(path.join(root, "tenants"), { recursive: true, force: true });
  });

  /** Exactly the slugs named — `gate()` is a CLOSED gate, not an open one. */
  function gate(...slugs: string[]) {
    return { readableSlugs: new Set(slugs) };
  }

  async function writeSilo(kind: "wiki" | "raw", name: string, body: string) {
    const rel =
      kind === "wiki"
        ? tenantWikiRelPath(tenantForOwner(OWNER), name)
        : tenantRawRelPath(tenantForOwner(OWNER), name);
    const abs = path.join(getDataDir(), rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body, "utf-8");
  }

  it("returns the bytes of a gated page under the flat root", async () => {
    await fs.writeFile(path.join(tmpDir, "wiki", "alpha.md"), "# Alpha\n", "utf-8");
    await expect(
      readWorkbenchFile(OWNER, null, "wiki/alpha.md", gate("alpha")),
    ).resolves.toEqual({ content: "# Alpha\n" });
  });

  it("refuses a page the gate excludes, with the same answer as a missing one", async () => {
    await fs.writeFile(path.join(tmpDir, "wiki", "hidden.md"), "secret", "utf-8");
    // Present but ungated, and absent-and-ungated, are indistinguishable — which
    // is what stops this route from being an existence oracle.
    expect(await readWorkbenchFile(OWNER, null, "wiki/hidden.md", gate("alpha"))).toBeNull();
    expect(await readWorkbenchFile(OWNER, null, "wiki/ghost.md", gate("alpha"))).toBeNull();
  });

  it("rejects a traversal, an absolute path, a backslash and an empty segment", async () => {
    // Written OUTSIDE the roots: if any of these resolved, this is the file they
    // would reach, so the test would fail loudly rather than silently pass.
    await fs.writeFile(path.join(tmpDir, "secrets.md"), "secret", "utf-8");
    for (const bad of [
      "wiki/../secrets.md",
      "../secrets.md",
      "/etc/x",
      "a\\b",
      "wiki//a.md",
      "wiki/./a.md",
      "",
      ".",
      "..",
      "wiki/.hidden.md",
    ]) {
      expect(await readWorkbenchFile(OWNER, WIKI_ID, bad, gate("a", "secrets"))).toBeNull();
    }
  });

  it("refuses a non-page leaf under wiki/, whose bytes need not be the caller's", async () => {
    // `resolveRoot` falls back to the SHARED flat `wiki/` root when the caller's
    // silo is empty, so these bytes are not necessarily theirs. Story 1.4
    // disclosed such filenames; reading them would disclose their contents.
    // `wikiLeafFilter` — the LISTING filter — no longer offers them either: it
    // derives its admissible set from this same gate (DW-41), so the refusal is
    // now the row's absence rather than a row that could only fail. The READ is
    // gated regardless of what any listing showed, which is what this asserts.
    for (const name of ["scratch.txt", "dump.json", "notes.markdown", "secrets"]) {
      await fs.writeFile(path.join(tmpDir, "wiki", name), "not yours", "utf-8");
      expect(
        await readWorkbenchFile(OWNER, null, `wiki/${name}`, gate("scratch", "dump", "notes", "secrets")),
      ).toBeNull();
    }
    // The generated index is a `.md`, so it is refused by the SLUG half of the
    // gate rather than the extension half: it is not a page, so
    // `readableSlugsFromKnowledge` never contains it.
    await fs.writeFile(path.join(tmpDir, "wiki", "index.md"), "# Wiki Index\n", "utf-8");
    expect(await readWorkbenchFile(OWNER, null, "wiki/index.md", gate("alpha"))).toBeNull();
  });

  it("accepts a .md whose extension is cased oddly, if its slug is readable", async () => {
    // A filesystem need not be case-sensitive, so the extension test is too —
    // but the SLUG is matched exactly, which is what the gate is about.
    await fs.writeFile(path.join(tmpDir, "wiki", "alpha.MD"), "cased", "utf-8");
    await expect(
      readWorkbenchFile(OWNER, null, "wiki/alpha.MD", gate("alpha")),
    ).resolves.toEqual({ content: "cased" });
    await fs.writeFile(path.join(tmpDir, "wiki", "Beta.md"), "cased slug", "utf-8");
    expect(await readWorkbenchFile(OWNER, null, "wiki/Beta.md", gate("beta"))).toBeNull();
  });

  it("refuses a nested wiki path, even one whose basename is a readable slug", async () => {
    // `rest.length !== 1`: the gate serves only a DIRECT child of the wiki root.
    // That half is load-bearing beyond this read now — `wikiLeafFilter` derives
    // the LISTING's `depth === 1` from it (DW-41), so a last-segment check here
    // would silently put every nested leaf back into the Files tab as a row the
    // Preview refuses. `validateSlug` rejects `/`, so no page lives down there;
    // what does is `wiki/query-history/<key>.json`, another owner's history.
    await fs.mkdir(path.join(tmpDir, "wiki", "archive"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "wiki", "archive", "mine.md"), "not yours", "utf-8");
    expect(await readWorkbenchFile(OWNER, null, "wiki/archive/mine.md", gate("mine"))).toBeNull();
  });

  it("refuses a root it does not own", async () => {
    await fs.mkdir(path.join(tmpDir, "other"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "other", "a.md"), "x", "utf-8");
    expect(await readWorkbenchFile(OWNER, WIKI_ID, "other/a.md", gate("a"))).toBeNull();
    // And a bare filename that is not one of the two seeded artifacts.
    expect(await readWorkbenchFile(OWNER, WIKI_ID, "notes.md", gate("notes"))).toBeNull();
  });

  it("resolves a seeded artifact through its real storage key", async () => {
    // The tree shows `purpose.md` at its root; storage holds it three segments
    // deep under `tenants/<t>/wikis/<id>/`. This mapping is the whole reason the
    // resolver exists (`spec-1-4` deferred entry 2).
    const abs = path.join(getDataDir(), wikiArtifactPath(OWNER, WIKI_ID, "purpose.md"));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, "# Purpose\n", "utf-8");

    await expect(
      readWorkbenchFile(OWNER, WIKI_ID, "purpose.md", gate()),
    ).resolves.toEqual({ content: "# Purpose\n" });
    // An artifact the template never wrote is null, not an empty string.
    expect(await readWorkbenchFile(OWNER, WIKI_ID, "schema.md", gate())).toBeNull();
  });

  it("resolves no artifact without a current Wiki", async () => {
    const abs = path.join(getDataDir(), wikiArtifactPath(OWNER, WIKI_ID, "purpose.md"));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, "# Purpose\n", "utf-8");
    expect(await readWorkbenchFile(OWNER, null, "purpose.md", gate())).toBeNull();
  });

  it("reads a source under raw/, including one nesting level", async () => {
    await fs.writeFile(path.join(tmpDir, "raw", "a.md"), "flat source", "utf-8");
    await fs.mkdir(path.join(tmpDir, "raw", "alpha"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "raw", "alpha", "h1.md"), "snapshot", "utf-8");

    // `raw/` holds sources, not pages, so the page gate does not apply to it —
    // exactly as the listing walk treats it.
    await expect(readWorkbenchFile(OWNER, null, "raw/a.md", gate())).resolves.toEqual({
      content: "flat source",
    });
    await expect(
      readWorkbenchFile(OWNER, null, "raw/alpha/h1.md", gate()),
    ).resolves.toEqual({ content: "snapshot" });
  });

  it("refuses a path deeper than the walk can list", async () => {
    await fs.mkdir(path.join(tmpDir, "raw", "a", "b"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "raw", "a", "b", "c.md"), "deep", "utf-8");
    expect(await readWorkbenchFile(OWNER, null, "raw/a/b/c.md", gate())).toBeNull();
  });

  it("prefers the tenant silo over the flat root", async () => {
    await writeSilo("wiki", "alpha.md", "silo bytes");
    await fs.writeFile(path.join(tmpDir, "wiki", "alpha.md"), "flat bytes", "utf-8");
    await expect(
      readWorkbenchFile(OWNER, null, "wiki/alpha.md", gate("alpha")),
    ).resolves.toEqual({ content: "silo bytes" });
  });

  it("falls back to the flat root when the silo is genuinely empty", async () => {
    await fs.writeFile(path.join(tmpDir, "wiki", "alpha.md"), "flat bytes", "utf-8");
    await expect(
      readWorkbenchFile(OWNER, null, "wiki/alpha.md", gate("alpha")),
    ).resolves.toEqual({ content: "flat bytes" });
  });

  it("does not fall back to the flat root when the silo read FAILED", async () => {
    // A missing prefix answers with an empty list; only a real error rejects. So
    // a rejection must not widen the read to the shared transitional tree —
    // the same rule `resolveRoot` already applies to the listing.
    const siloWiki = path.join(getDataDir(), tenantWikiRelPath(tenantForOwner(OWNER), ""));
    await fs.mkdir(path.dirname(siloWiki), { recursive: true });
    await fs.writeFile(siloWiki, "not a directory", "utf-8"); // ENOTDIR on readdir
    await fs.writeFile(path.join(tmpDir, "wiki", "alpha.md"), "flat bytes", "utf-8");

    expect(await readWorkbenchFile(OWNER, null, "wiki/alpha.md", gate("alpha"))).toBeNull();
  });

  it("returns the empty string for an empty file, never null", async () => {
    // "Empty" and "could not be read" are different facts and get different
    // sentences; collapsing them here would make that impossible upstream.
    await fs.writeFile(path.join(tmpDir, "wiki", "alpha.md"), "", "utf-8");
    await expect(
      readWorkbenchFile(OWNER, null, "wiki/alpha.md", gate("alpha")),
    ).resolves.toEqual({ content: "" });
  });
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

describe("GET /api/workbench/preview", () => {
  const OWNER = "yuanhao";
  let root: string;
  let originalDataDir: string | undefined;
  let originalWikiDir: string | undefined;
  let originalRawDir: string | undefined;
  // The artifact half of `editable` consults `isOwnerHandle()`, which is false
  // for EVERYONE while `NEXT_PUBLIC_OWNER_HANDLE` is unset — so a block that
  // asserts what the owner is offered has to say who the owner is. Without it
  // the `schema.md` case below would assert `editable: true` in the one
  // configuration where no save can land.
  let originalOwner: string | undefined;
  // Since DW-37 the page half of `editable` consults `isReadOnly()`, so every
  // `editable: true` in this block is a claim about an ordinary deployment.
  // Inherited from the shell, `YOPEDIA_READONLY=1` would turn them all red on
  // one developer's machine and nowhere else.
  let originalReadOnly: string | undefined;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "wb-preview-route-"));
    originalDataDir = process.env.DATA_DIR;
    originalWikiDir = process.env.WIKI_DIR;
    originalRawDir = process.env.RAW_DIR;
    originalOwner = process.env.NEXT_PUBLIC_OWNER_HANDLE;
    originalReadOnly = process.env.YOPEDIA_READONLY;
    process.env.DATA_DIR = root;
    process.env.WIKI_DIR = path.join(root, "wiki");
    process.env.RAW_DIR = path.join(root, "raw");
    process.env.NEXT_PUBLIC_OWNER_HANDLE = OWNER;
    await fs.mkdir(process.env.WIKI_DIR, { recursive: true });
    await fs.mkdir(process.env.RAW_DIR, { recursive: true });
    _resetStorage();
  });

  afterAll(async () => {
    for (const [key, value] of [
      ["DATA_DIR", originalDataDir],
      ["WIKI_DIR", originalWikiDir],
      ["RAW_DIR", originalRawDir],
      ["NEXT_PUBLIC_OWNER_HANDLE", originalOwner],
      ["YOPEDIA_READONLY", originalReadOnly],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetStorage();
    await fs.rm(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    principal.current = { id: "u1", handle: OWNER };
    // Every case starts from a writable deployment, whatever the shell exported
    // and whatever the previous case set.
    delete process.env.YOPEDIA_READONLY;
  });

  /**
   * A page as the kernel stores it: the file, plus a line in `wiki/index.md` —
   * which is what `listWikiPages` reads, and therefore what the route's gate is
   * ultimately derived from.
   */
  async function writePage(slug: string, body: string) {
    await fs.writeFile(
      path.join(root, "wiki", `${slug}.md`),
      `---\ntitle: ${slug}\ntype: concept\n---\n\n${body}`,
      "utf-8",
    );
    listed.add(slug);
    await writeIndex();
  }

  const listed = new Set<string>();
  async function writeIndex() {
    const lines = [...listed].map((slug) => `- [${slug}](${slug}.md) — ${slug}`);
    await fs.writeFile(
      path.join(root, "wiki", "index.md"),
      `# Wiki Index\n\n${lines.join("\n")}\n`,
      "utf-8",
    );
  }

  /** The handler, imported lazily so the env above is in place first. */
  async function get(query: string): Promise<Response> {
    const { GET } = await import("@/app/api/workbench/preview/route");
    return GET(new Request(`http://localhost/api/workbench/preview?${query}`));
  }

  it("answers 401 without a principal, and reads nothing", async () => {
    principal.current = null;
    const response = await get("kind=page&slug=alpha");
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Sign in required." });
  });

  it("answers 400 for a shape it does not parse", async () => {
    for (const query of ["", "kind=folder", "kind=page", "kind=file"]) {
      expect((await get(query)).status).toBe(400);
    }
  });

  it("serves a readable page's body with the YAML block already gone", async () => {
    await writePage("alpha", "# Alpha\n\nbody text\n");
    const response = await get("kind=page&slug=alpha");
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.body).toBe("# Alpha\n\nbody text\n");
    expect(payload.body).not.toContain("---");
    expect(payload).toMatchObject({
      path: "wiki/alpha.md",
      slug: "alpha",
      format: "markdown",
      truncated: false,
      editable: true,
    });
  });

  it("answers 404 with ONE body for gated-out, absent and traversal alike", async () => {
    await writePage("alpha", "# Alpha\n");
    const answers = await Promise.all(
      [
        "kind=page&slug=ghost",
        "kind=file&path=wiki%2Fghost.md",
        "kind=file&path=wiki%2F..%2Fsecrets.md",
        "kind=file&path=%2Fetc%2Fpasswd",
        // No current Wiki in this fixture, so the artifacts resolve to nothing —
        // including the one Story 1.8 made editable. "Editable" is a statement
        // about a resolved artifact, never a reason to answer differently about
        // one that did not resolve.
        "kind=file&path=purpose.md",
        "kind=file&path=schema.md",
      ].map(async (query) => {
        const response = await get(query);
        return { status: response.status, body: await response.json() };
      }),
    );
    // Indistinguishable: a caller must not be able to learn what exists by
    // comparing these.
    for (const answer of answers) {
      expect(answer).toEqual(answers[0]);
      expect(answer.status).toBe(404);
    }
  });

  it("serves the same page from the Files tab, still editable", async () => {
    await writePage("alpha", "# Alpha\n");
    const payload = await (await get("kind=file&path=wiki%2Falpha.md")).json();
    expect(payload).toMatchObject({
      name: "alpha.md",
      path: "wiki/alpha.md",
      slug: "alpha",
      format: "markdown",
      editable: true,
    });
  });

  it("serves a source under raw/ read-only, and refuses to edit it", async () => {
    await fs.writeFile(path.join(root, "raw", "note.md"), "# Note\n", "utf-8");
    const payload = await (await get("kind=file&path=raw%2Fnote.md")).json();
    expect(payload).toMatchObject({ format: "markdown", editable: false });
    expect(payload.slug).toBeUndefined();
  });

  it("names a format it cannot render and never reads its bytes", async () => {
    await fs.writeFile(path.join(root, "raw", "scan.pdf"), "%PDF-1.4 binary", "utf-8");
    const payload = await (await get("kind=file&path=raw%2Fscan.pdf")).json();
    expect(payload).toMatchObject({ format: "unsupported", body: "", editable: false });
    // Not merely discarded after the fact: the name decides the format, so an
    // arbitrarily large blob is never pulled through the Worker to learn what
    // its extension already said. A path that does not exist still 404s.
    expect((await get("kind=file&path=raw%2Fmissing.pdf")).status).toBe(404);
    // …and one outside the caller's reach is refused rather than described.
    expect((await get("kind=file&path=other%2Fscan.pdf")).status).toBe(404);
  });

  it("marks every answer private and uncacheable", async () => {
    // Each body is per-principal and gated; a shared cache or the browser's
    // back/forward store holding one would serve it to the wrong reader.
    await writePage("alpha", "# Alpha\n");
    for (const query of ["kind=page&slug=alpha", "kind=page&slug=ghost", "kind=folder"]) {
      const response = await get(query);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    principal.current = null;
    expect((await get("kind=page&slug=alpha")).headers.get("Cache-Control")).toBe(
      "private, no-store",
    );
  });

  it("answers a thrown read with its own { error } shape, not a framework 500", async () => {
    // Without a top-level wrap, a throw from the principal, the index read or a
    // storage read escapes as an HTML 500 — breaking the shape every other
    // route in this tree answers with, and the one the column parses.
    const { GET } = await import("@/app/api/workbench/preview/route");
    // A URL the runtime cannot parse makes `new URL(request.url)` throw inside
    // the handler, which is the cheapest reachable throw after the auth check.
    const response = await GET({ url: "not a url" } as unknown as Request);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(typeof body.error).toBe("string");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("serves the write precondition over the WHOLE stored file, not the body", async () => {
    // `PUT /api/wiki/[slug]` checks `If-Match` against `existing.content`, which
    // still carries the YAML block this payload stripped — so a version derived
    // from `payload.body` would never match anything and every save would 412.
    await writePage("versioned", "# Versioned\n\nbody text\n");
    const stored = await fs.readFile(
      path.join(root, "wiki", "versioned.md"),
      "utf-8",
    );
    const payload = await (await get("kind=page&slug=versioned")).json();

    expect(payload.version).toBe(contentVersion(stored));
    expect(payload.version).not.toBe(contentVersion(payload.body));

    // …and the SAME bytes reached from the Files tab carry the SAME version, or
    // the two surfaces onto one Page would disagree about what a save conflicts
    // with.
    const asFile = await (await get("kind=file&path=wiki%2Fversioned.md")).json();
    expect(asFile.version).toBe(payload.version);
  });

  it("moves the version when the file moves, and only then", async () => {
    await writePage("moving", "# Moving\n\nfirst\n");
    const first = (await (await get("kind=page&slug=moving")).json()).version;
    expect((await (await get("kind=page&slug=moving")).json()).version).toBe(first);

    await writePage("moving", "# Moving\n\nsecond\n");
    expect((await (await get("kind=page&slug=moving")).json()).version).not.toBe(first);
  });

  it("serves a version for a raw source too, and NONE for bytes it never read", async () => {
    await fs.writeFile(path.join(root, "raw", "versioned.md"), "# Raw\n", "utf-8");
    const source = await (await get("kind=file&path=raw%2Fversioned.md")).json();
    expect(source.version).toBe(contentVersion("# Raw\n"));

    // An `unsupported` format is answered from an existence check alone — no
    // bytes were read, so there is nothing to have a version OF, and there is no
    // editor for it either way.
    await fs.writeFile(path.join(root, "raw", "unread.pdf"), "%PDF-1.4", "utf-8");
    const blob = await (await get("kind=file&path=raw%2Funread.pdf")).json();
    expect(blob.format).toBe("unsupported");
    expect("version" in blob).toBe(false);
  });

  it("versions the RAW bytes of a capped body, not the prefix it served", async () => {
    // The editor is refused for a truncated payload anyway, but a version over
    // the prefix would be a claim about a file the route did not serve.
    await writePage("capped", `# Capped\n\n${"x".repeat(PREVIEW_MAX_CHARS + 500)}`);
    const stored = await fs.readFile(path.join(root, "wiki", "capped.md"), "utf-8");
    const payload = await (await get("kind=page&slug=capped")).json();
    expect(payload.truncated).toBe(true);
    expect(payload.version).toBe(contentVersion(stored));
  });

  it("refuses a non-page leaf under wiki/ the same way it refuses a stranger", async () => {
    await fs.writeFile(path.join(root, "wiki", "scratch.txt"), "not yours", "utf-8");
    expect((await get("kind=file&path=wiki%2Fscratch.txt")).status).toBe(404);
  });

  it("caps an oversized body and says so", async () => {
    await writePage("alpha", `# Alpha\n\n${"x".repeat(PREVIEW_MAX_CHARS + 500)}`);
    const payload = await (await get("kind=page&slug=alpha")).json();
    expect(payload.body).toHaveLength(PREVIEW_MAX_CHARS);
    expect(payload.truncated).toBe(true);
  });

  it("serves a seeded artifact through the registry's current Wiki", async () => {
    // The ONLY thing that makes `purpose.md` and `schema.md` resolvable is
    // `getWikiRegistry(principal.handle).currentId` — the same expression
    // `page.tsx` uses to list them. Every other case in this block has an empty
    // registry, so without this one `currentId = null` passes the whole suite
    // while both artifact rows answer 404 in the product.
    const WIKI_ID = "11111111-2222-4333-8444-555555555555";
    const registry = path.join(root, wikiRegistryPath(OWNER));
    await fs.mkdir(path.dirname(registry), { recursive: true });
    await fs.writeFile(
      registry,
      JSON.stringify({
        version: 1,
        currentId: WIKI_ID,
        wikis: [
          {
            id: WIKI_ID,
            name: "Field notes",
            scenario: "research",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      "utf-8",
    );
    const artifact = path.join(root, wikiArtifactPath(OWNER, WIKI_ID, "purpose.md"));
    await fs.mkdir(path.dirname(artifact), { recursive: true });
    await fs.writeFile(artifact, "# Purpose\n\nwhy this Wiki exists\n", "utf-8");

    try {
      const response = await get("kind=file&path=purpose.md");
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        name: "purpose.md",
        path: "purpose.md",
        format: "markdown",
        body: "# Purpose\n\nwhy this Wiki exists\n",
        // Schema editing is Story 1.8: an artifact has no write path through
        // `/api/wiki/[slug]`, so it is readable and nothing more.
        editable: false,
      });
      // The other seeded artifact was never written, and a missing artifact is
      // the same 404 as one outside the caller's reach.
      expect((await get("kind=file&path=schema.md")).status).toBe(404);
    } finally {
      // Every other case in this block asserts against an EMPTY registry.
      await fs.rm(path.dirname(registry), { recursive: true, force: true });
    }
  });

  it("offers schema.md for editing and keeps purpose.md read-only", async () => {
    // Story 1.8. The SERVER decides what may be written: the column only asks.
    // Both artifacts resolve through the same `currentId`, so the pair proves
    // the allowlist rather than the presence of a Wiki.
    const WIKI_ID = "11111111-2222-4333-8444-555555555555";
    const registry = path.join(root, wikiRegistryPath(OWNER));
    await fs.mkdir(path.dirname(registry), { recursive: true });
    await fs.writeFile(
      registry,
      JSON.stringify({
        version: 1,
        currentId: WIKI_ID,
        wikis: [
          {
            id: WIKI_ID,
            name: "Field notes",
            scenario: "research",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      "utf-8",
    );
    for (const [file, body] of [
      ["schema.md", "# Schema\n\n## Page conventions\n\nKeep it short.\n"],
      ["purpose.md", "# Purpose\n"],
    ] as const) {
      const abs = path.join(root, wikiArtifactPath(OWNER, WIKI_ID, file));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, body, "utf-8");
    }

    try {
      const schema = await (await get("kind=file&path=schema.md")).json();
      expect(schema).toMatchObject({
        name: "schema.md",
        path: "schema.md",
        format: "markdown",
        artifact: "schema.md",
        editable: true,
      });
      expect(schema.body).toContain("## Page conventions");
      // An artifact has no slug — it is not a Page and never acquires one.
      expect(schema.slug).toBeUndefined();

      const purpose = await (await get("kind=file&path=purpose.md")).json();
      expect(purpose).toMatchObject({ format: "markdown", editable: false });
      expect(purpose.artifact).toBeUndefined();
      expect(purpose.slug).toBeUndefined();

      // An artifact is WHOLE-FILE: the write route stores `content` verbatim and
      // owns no frontmatter for it, so a leading `---` block must survive the
      // read. Stripping it here would hand the editor a body whose next save
      // deletes the block, answered with a 200.
      const yaml = "---\nnote: keep me\n---\n\n## Page conventions\n\nx\n";
      const abs = path.join(root, wikiArtifactPath(OWNER, WIKI_ID, "schema.md"));
      await fs.writeFile(abs, yaml, "utf-8");
      const whole = await (await get("kind=file&path=schema.md")).json();
      expect(whole.body).toBe(yaml);
    } finally {
      // Every other case in this block asserts against an EMPTY registry.
      await fs.rm(path.dirname(registry), { recursive: true, force: true });
    }
  });

  it("serves the CURRENT Wiki's artifacts, not the first one in the registry", async () => {
    // The left column now TELLS the owner "Switching wikis shows that wiki's
    // purpose.md and Schema" (`WIKI_SCOPE_COPY`), and this route is the only
    // thing that makes the promise true — `currentId` is what a switch moves.
    // Both artifact cases above hold a ONE-Wiki registry, where `currentId` and
    // "the first entry" are the same string: swapping this route's
    // `getWikiRegistry(...).currentId` for `wikis[0].id` leaves them green while
    // an owner on their second Wiki reads the first Wiki's Purpose and Schema —
    // and then Story 1.8's `Edit` saves that body into the CURRENT Wiki, so a
    // read/write mismatch overwrites the Wiki they were never shown.
    const FIRST = "11111111-2222-4333-8444-555555555555";
    const CURRENT = "33333333-4444-4555-8666-777777777777";
    const registry = path.join(root, wikiRegistryPath(OWNER));
    await fs.mkdir(path.dirname(registry), { recursive: true });
    await fs.writeFile(
      registry,
      JSON.stringify({
        version: 1,
        // The current Wiki is deliberately NOT the first entry.
        currentId: CURRENT,
        wikis: [FIRST, CURRENT].map((id, index) => ({
          id,
          name: index === 0 ? "Field notes" : "Reading list",
          scenario: "research",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })),
      }),
      "utf-8",
    );
    for (const id of [FIRST, CURRENT]) {
      for (const file of ["purpose.md", "schema.md"] as const) {
        const abs = path.join(root, wikiArtifactPath(OWNER, id, file));
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, `# ${id} ${file}\n`, "utf-8");
      }
    }

    try {
      for (const file of ["purpose.md", "schema.md"] as const) {
        const payload = await (await get(`kind=file&path=${file}`)).json();
        expect(payload.body).toBe(`# ${CURRENT} ${file}\n`);
        expect(payload.body).not.toContain(FIRST);
      }
    } finally {
      // Every other case in this block asserts against an EMPTY registry.
      await fs.rm(path.dirname(registry), { recursive: true, force: true });
    }
  });

  it("serves a page whose extension is cased oddly, still editable", async () => {
    // The read gate accepts `.MD` because a filesystem need not be
    // case-sensitive. A case-SENSITIVE slug derivation here would hand that
    // same page back with no slug, so the Files tab would show it read-only
    // while the Knowledge tab edits it.
    await fs.writeFile(path.join(root, "wiki", "cased.MD"), "# Cased\n", "utf-8");
    listed.add("cased");
    await writeIndex();
    const payload = await (await get("kind=file&path=wiki%2Fcased.MD")).json();
    expect(payload).toMatchObject({ slug: "cased", format: "markdown", editable: true });
  });

  it("distinguishes an empty file from an unreadable one", async () => {
    await fs.writeFile(path.join(root, "wiki", "blank.md"), "", "utf-8");
    listed.add("blank");
    await writeIndex();
    const response = await get("kind=file&path=wiki%2Fblank.md");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ body: "", truncated: false });
  });

  it("does not offer a Page for editing on a read-only deployment (DW-37)", async () => {
    // The mirror of `wiki-schema-edit.test.ts`'s artifact-half case, for the
    // half that used to be `slug !== undefined` unconditionally. The read
    // decides whether `Edit` is on screen and the write decides whether a save
    // lands: while `PUT /api/wiki/[slug]` had no read-only gate the two agreed,
    // and the moment it got one they would have disagreed — the owner retyping
    // a page and being refused at `Save`.
    //
    // `isReadOnly()` is read at CALL time, so the flag is flipped here and
    // cleared in `finally` rather than at import.
    await writePage("ro-page", "# Read Only\n\nstill served in full\n");
    process.env.YOPEDIA_READONLY = "1";
    try {
      const response = await get("kind=page&slug=ro-page");
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload.editable).toBe(false);
      // Read-only means read-only, NOT hidden: the bytes are still served whole.
      expect(payload.body).toBe("# Read Only\n\nstill served in full\n");
      expect(payload).toMatchObject({ slug: "ro-page", truncated: false });

      // The same page reached from the Files tab answers the same way — one
      // rule, two surfaces, exactly as the editable-when-writable pair above.
      const fromFiles = await (await get("kind=file&path=wiki%2Fro-page.md")).json();
      expect(fromFiles).toMatchObject({ slug: "ro-page", editable: false });
      expect(fromFiles.body.length).toBeGreaterThan(0);

      // …and the flag is what made the difference: the same page is editable
      // again once it is cleared. CLEARED, never "restored to what it was" — a
      // machine with `YOPEDIA_READONLY=1` exported would otherwise put the
      // deployment straight back into read-only and fail this half for a reason
      // that has nothing to do with the code.
      delete process.env.YOPEDIA_READONLY;
      const writable = await (await get("kind=page&slug=ro-page")).json();
      expect(writable.editable).toBe(true);
    } finally {
      // `beforeEach` clears it for the next case; the suite's `afterAll` puts
      // the shell's own value back.
      delete process.env.YOPEDIA_READONLY;
    }
  });
});

// ---------------------------------------------------------------------------
// The two request decisions
// ---------------------------------------------------------------------------
//
// These are the rules that used to live inside the React effect, where — with
// no DOM environment in this suite and none allowed — they could only ever be
// matched as source text. Both now run against a stub: no network, no timers,
// no component.

const PAYLOAD = PAYLOAD_SHAPE;

/** A stub `fetch`. Every case below drives one of these; none opens a socket. */
function stubFetch(
  handler: (url: string, init?: Parameters<PreviewFetch>[1]) => unknown,
): { fetchImpl: PreviewFetch; calls: Array<{ url: string; init?: Parameters<PreviewFetch>[1] }> } {
  const calls: Array<{ url: string; init?: Parameters<PreviewFetch>[1] }> = [];
  const fetchImpl: PreviewFetch = async (url, init) => {
    calls.push({ url, init });
    const result = handler(url, init);
    if (result instanceof Error) throw result;
    return result as Awaited<ReturnType<PreviewFetch>>;
  };
  return { fetchImpl, calls };
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError("Unexpected end of JSON input");
      return body;
    },
  };
}

function abortError(name: "AbortError" | "TimeoutError"): Error {
  const error = new Error(name === "TimeoutError" ? "signal timed out" : "aborted");
  error.name = name;
  return error;
}

describe("fetchPreview", () => {
  it("returns the payload for a 200", async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, PAYLOAD));
    const controller = new AbortController();
    await expect(
      fetchPreview("/api/workbench/preview?kind=page&slug=alpha", controller.signal, fetchImpl),
    ).resolves.toEqual({ status: "ok", payload: PAYLOAD });
    // The signal travels with the request, so an abort actually cancels it.
    expect(calls[0].init?.signal).toBe(controller.signal);
  });

  it("refuses a 200 whose JSON is not a payload", async () => {
    // A 200 is not a promise about shape — an interstitial or a proxy can put
    // valid JSON on one. The column reads `payload.body.trim()` during render,
    // where a non-string throws and takes the column down instead of showing
    // the sentence a failed read exists to show.
    // …and it is `unreachable`, not `gone`: a proxy, an interstitial or a
    // future change to the route is not evidence that the row was removed, so
    // the bytes already on screen must survive it.
    for (const body of [
      null,
      "a string",
      42,
      {},
      { ...PAYLOAD, body: 42 },
      { ...PAYLOAD, format: "pdf" },
      // A non-string version would be sent straight back as `If-Match` and
      // refused as a conflict the owner could not explain.
      { ...PAYLOAD, version: 42 },
      { ...PAYLOAD, version: {} },
    ]) {
      const { fetchImpl } = stubFetch(() => jsonResponse(200, body));
      await expect(
        fetchPreview(PREVIEW_ROUTE, new AbortController().signal, fetchImpl),
      ).resolves.toEqual({ status: "unreachable" });
    }
    // The real shape still passes, including one with no `slug`.
    const { fetchImpl } = stubFetch(() => jsonResponse(200, { ...PAYLOAD, slug: undefined }));
    await expect(
      fetchPreview(PREVIEW_ROUTE, new AbortController().signal, fetchImpl),
    ).resolves.toMatchObject({ status: "ok" });
    // …and one with no `version` at all: an `unsupported` format never carries
    // one, and it is still a payload the column must render.
    const versionless = stubFetch(() => jsonResponse(200, PAYLOAD));
    await expect(
      fetchPreview(PREVIEW_ROUTE, new AbortController().signal, versionless.fetchImpl),
    ).resolves.toEqual({ status: "ok", payload: PAYLOAD });
    // …and `null`, which is that same absence as a serializer or a proxy spells
    // it. Taking the WHOLE column down to "unreachable" over a metadata field
    // the body does not depend on would be the DW-54 conflation all over again.
    const nulled = stubFetch(() => jsonResponse(200, { ...PAYLOAD, version: null }));
    await expect(
      fetchPreview(PREVIEW_ROUTE, new AbortController().signal, nulled.fetchImpl),
    ).resolves.toMatchObject({ status: "ok" });
    // …while one that DOES carry a string version keeps it, because that string
    // is the whole precondition the next save is conditional on.
    const carried = stubFetch(() =>
      jsonResponse(200, { ...PAYLOAD, version: "w1:8-0123456789abcdef" }),
    );
    await expect(
      fetchPreview(PREVIEW_ROUTE, new AbortController().signal, carried.fetchImpl),
    ).resolves.toEqual({
      status: "ok",
      payload: { ...PAYLOAD, version: "w1:8-0123456789abcdef" },
    });
  });

  it("discards a response that arrives after the owner picked another row", async () => {
    // The I/O matrix's "selection changes mid-fetch": the second pick aborts the
    // first, and the first's answer must not reach state. `stale`, not `failed`
    // — reporting it as an error would flash "couldn’t be loaded" on a column
    // that is about to show the row the owner actually wants.
    const controller = new AbortController();
    const { fetchImpl } = stubFetch(() => {
      controller.abort(); // the owner clicks another row while this is in flight
      return jsonResponse(200, PAYLOAD);
    });
    const result = await fetchPreview("/preview", controller.signal, fetchImpl);
    expect(result).toEqual({ status: "stale" });
    // Nothing for the caller to write: there is no payload on this branch at
    // all, so a mapping that forgot to return early could not compile.
    expect("payload" in result).toBe(false);
  });

  it("discards a response whose BODY parsed after the abort", async () => {
    // Two awaits, two chances to lose the race. The second one is the one a
    // hand-written effect forgets.
    const controller = new AbortController();
    const { fetchImpl } = stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => {
        controller.abort();
        return PAYLOAD;
      },
    }));
    await expect(fetchPreview("/preview", controller.signal, fetchImpl)).resolves.toEqual({
      status: "stale",
    });
  });

  it("splits a refusal from a read that did not land (DW-54)", async () => {
    // 4xx is `gone`, and the seam is whether RETRYING COULD EVER HELP. 404 is
    // the route's "there is nothing here for you" — deliberately
    // indistinguishable between absent and refused, per `PREVIEW_FAILED_COPY`.
    // 400 is a request this build will keep sending identically, and 401/403 is
    // an expired or insufficient session: all three answer the same way next
    // time, so holding stale bytes behind a `Retry` would promise a recovery
    // that is not coming and a strip that never heals.
    for (const status of [400, 401, 403, 404, 410]) {
      const { fetchImpl } = stubFetch(() => jsonResponse(status, { error: "Nope." }));
      await expect(
        fetchPreview("/preview", new AbortController().signal, fetchImpl),
      ).resolves.toEqual({ status: "gone" });
    }

    // A server that erred or a hop that dropped goes away by itself, so the
    // bytes already on screen survive it. Collapsed into one `failed`, a 502
    // from a proxy hiccup deleted the page the owner was reading.
    //
    // 408, 425 and 429 ride with them even though they are 4xx: each says WHEN
    // rather than WHAT, and a rate limiter in front of the route is precisely
    // the intermediary this split exists to stop reading as a deletion. Ranged
    // as `>= 400 && < 500`, a throttled refresh wiped the page the owner was
    // reading and offered no way back — the DW-54 failure, one status class over.
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      const { fetchImpl } = stubFetch(() => jsonResponse(status, { error: "Nope." }));
      await expect(
        fetchPreview("/preview", new AbortController().signal, fetchImpl),
      ).resolves.toEqual({ status: "unreachable" });
    }
  });

  it("carries no message of its own on either failure", async () => {
    // The server's `{ error }` sentence is read by `savePreviewBody` and by
    // nothing here: a read has exactly two sentences, both in the Copy table,
    // so a transport or route string can never reach the owner as copy nobody
    // wrote.
    for (const status of [404, 500]) {
      const { fetchImpl } = stubFetch(() =>
        jsonResponse(status, { error: "Some internal detail." }),
      );
      const result = await fetchPreview("/preview", new AbortController().signal, fetchImpl);
      expect(Object.keys(result)).toEqual(["status"]);
    }
  });

  it("reports a DEADLINE abort as unreachable, not as stale — and never as gone", async () => {
    // The bug this pins: both reasons stop the same controller, so with one
    // outcome for "aborted" a hung request is silently classified as superseded
    // — the caller stays quiet, `loading` is never cleared, and the column shows
    // `Loading…` for the rest of the session. Exactly what the deadline exists
    // to prevent.
    const controller = new AbortController();
    const { fetchImpl } = stubFetch(() => {
      controller.abort(PREVIEW_TIMEOUT_REASON);
      return abortError("AbortError");
    });
    // `unreachable`, and this is the half DW-54 adds: a request that took too
    // long says NOTHING about whether the row still exists, so answering `gone`
    // would delete a page from the owner's screen because their connection
    // stalled.
    await expect(fetchPreview("/preview", controller.signal, fetchImpl)).resolves.toEqual({
      status: "unreachable",
    });
  });

  it("reports a deadline that fired after the response landed as unreachable too", async () => {
    // Same reason, the other await: a response that arrives just as the deadline
    // fires must not be reported as superseded either.
    const controller = new AbortController();
    const { fetchImpl } = stubFetch(() => {
      controller.abort(PREVIEW_TIMEOUT_REASON);
      return jsonResponse(200, PAYLOAD);
    });
    await expect(fetchPreview("/preview", controller.signal, fetchImpl)).resolves.toEqual({
      status: "unreachable",
    });
  });

  it("reports a transport failure as unreachable, and an abort as stale", async () => {
    const { fetchImpl } = stubFetch(() => new TypeError("network down"));
    await expect(
      fetchPreview("/preview", new AbortController().signal, fetchImpl),
    ).resolves.toEqual({ status: "unreachable" });

    // The same throw, but the caller is the one who stopped it.
    const controller = new AbortController();
    const aborted = stubFetch(() => {
      controller.abort();
      return abortError("AbortError");
    });
    await expect(
      fetchPreview("/preview", controller.signal, aborted.fetchImpl),
    ).resolves.toEqual({ status: "stale" });
  });

  it("survives a body that is not JSON", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse(200, undefined));
    await expect(
      fetchPreview("/preview", new AbortController().signal, fetchImpl),
    ).resolves.toEqual({ status: "unreachable" });
  });
});

describe("pageWriteUrl", () => {
  it("addresses the ONE write path, escaping the slug", () => {
    expect(PAGE_WRITE_ROUTE).toBe("/api/wiki");
    expect(pageWriteUrl("alpha")).toBe("/api/wiki/alpha");
    expect(pageWriteUrl("研究 note")).toBe(`/api/wiki/${encodeURIComponent("研究 note")}`);
    // A slug can never escape its own path segment.
    expect(pageWriteUrl("../secrets")).not.toContain("/../");
  });
});

describe("savePreviewBody", () => {
  it("PUTs the body — no YAML — to the URL it was handed", async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, { ok: true }));
    await expect(
      savePreviewBody(pageWriteUrl("alpha"), "# Alpha\n", { fetchImpl }),
    ).resolves.toEqual({ status: "ok" });
    expect(calls[0].url).toBe("/api/wiki/alpha");
    expect(calls[0].init?.method).toBe("PUT");
    expect(calls[0].init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(calls[0].init?.body ?? "{}")).toEqual({ content: "# Alpha\n" });
  });

  it("sends the artifact's body to the artifact route, in the same shape", async () => {
    // ONE save client for both write paths (Story 1.8). The URL is the only
    // difference; a second `fetch` in the column is the state this prevents.
    const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, { ok: true }));
    await expect(
      savePreviewBody(artifactWriteUrl("schema.md"), "## Page conventions\n\nx\n", {
        fetchImpl,
      }),
    ).resolves.toEqual({ status: "ok" });
    expect(calls[0].url).toBe("/api/workbench/artifact?path=schema.md");
    expect(calls[0].init?.method).toBe("PUT");
    expect(JSON.parse(calls[0].init?.body ?? "{}")).toEqual({
      content: "## Page conventions\n\nx\n",
    });
  });

  it("prefers the server's own sentence on a 403", async () => {
    // Only the server knows this was a permission rather than a missing page.
    const { fetchImpl } = stubFetch(() =>
      jsonResponse(403, { error: "You don't have permission to edit this page." }),
    );
    await expect(savePreviewBody(pageWriteUrl("alpha"), "x", { fetchImpl })).resolves.toEqual({
      status: "error",
      message: "You don't have permission to edit this page.",
    });
  });

  it("relays the sentences the write route actually returns", async () => {
    // A 404 and a 403 are facts only the server has. The write route's 400
    // (`content must be a non-empty string`) is deliberately NOT in this list:
    // the Save control is disabled on an empty draft, so it is unreachable from
    // the UI — and it is a developer string in no Copy table.
    for (const [status, error] of [
      [404, "page not found: alpha"],
      [403, "You don't have permission to edit this page."],
    ] as const) {
      const { fetchImpl } = stubFetch(() => jsonResponse(status, { error }));
      await expect(savePreviewBody(pageWriteUrl("alpha"), "x", { fetchImpl })).resolves.toEqual({
        status: "error",
        message: error,
      });
    }
  });

  it("falls back to the Copy sentence for a 500 whose body will not parse", async () => {
    // The old shape produced "Request failed (500)" here — a user-visible string
    // that is in no Copy table and names the transport rather than the failure.
    const { fetchImpl } = stubFetch(() => jsonResponse(500, undefined));
    await expect(savePreviewBody(pageWriteUrl("alpha"), "x", { fetchImpl })).resolves.toEqual({
      status: "error",
      message: PREVIEW_SAVE_FAILED_COPY,
    });
    // Same for a 500 with a well-formed body that simply carries no message.
    const empty = stubFetch(() => jsonResponse(500, { error: "   " }));
    await expect(
      savePreviewBody(pageWriteUrl("alpha"), "x", { fetchImpl: empty.fetchImpl }),
    ).resolves.toEqual({ status: "error", message: PREVIEW_SAVE_FAILED_COPY });
  });

  it("never relays a THROWN error's message", async () => {
    // `signal timed out`, `Failed to fetch` and `NetworkError when attempting to
    // fetch resource` are all transport vocabulary: no Copy table contains them
    // and none tells the owner anything they can act on.
    const thrown = [
      abortError("TimeoutError"),
      abortError("AbortError"),
      new TypeError("Failed to fetch"),
      new Error("NetworkError when attempting to fetch resource"),
    ];
    for (const cause of thrown) {
      const { fetchImpl } = stubFetch(() => cause);
      const result = await savePreviewBody(pageWriteUrl("alpha"), "x", { fetchImpl });
      expect(result).toEqual({ status: "error", message: PREVIEW_SAVE_FAILED_COPY });
      expect(result).not.toMatchObject({ message: cause.message });
    }
  });

  it("resolves rather than throwing, so the editor can stay open", async () => {
    const { fetchImpl } = stubFetch(() => new TypeError("network down"));
    // A rejection here would skip the caller's "keep the text, show the error"
    // branch entirely unless every call site remembered to catch.
    await expect(savePreviewBody(pageWriteUrl("alpha"), "x", { fetchImpl })).resolves.toEqual({
      status: "error",
      message: PREVIEW_SAVE_FAILED_COPY,
    });
  });

  it("honours a caller-supplied fallback sentence", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse(500, undefined));
    await expect(
      savePreviewBody(pageWriteUrl("alpha"), "x", { fetchImpl, fallback: "Nope." }),
    ).resolves.toEqual({ status: "error", message: "Nope." });
  });

  // -------------------------------------------------------------------------
  // The write precondition (DW-38, DW-51, DW-56)
  // -------------------------------------------------------------------------

  it("sends the seeded version as `If-Match`, on both write paths", async () => {
    const version = contentVersion("---\nowner: alice\n---\n\n# Alpha\n");
    for (const url of [pageWriteUrl("alpha"), artifactWriteUrl("schema.md")]) {
      const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, { ok: true }));
      await savePreviewBody(url, "x", { fetchImpl, version });
      expect(calls[0].init?.headers).toEqual({
        "Content-Type": "application/json",
        "If-Match": formatIfMatch(version),
      });
      // The precondition is a HEADER, not a body field: the routes check it
      // before they parse a body at all.
      expect(JSON.parse(calls[0].init?.body ?? "{}")).toEqual({ content: "x" });
    }
  });

  it("returns the version the write LANDED with, so the surface can save again", async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse(200, { ok: true, version: "w1:5-1111111122222222" }),
    );
    await expect(
      savePreviewBody(pageWriteUrl("alpha"), "x", { fetchImpl, version: "w1:2-old" }),
    ).resolves.toEqual({ status: "ok", version: "w1:5-1111111122222222" });
  });

  it("still reports a landed save when the answer carries no version", async () => {
    // The next save is then refused rather than blind, which is the safe
    // direction: a 200 that cannot be parsed is still a write that happened.
    for (const body of [{ ok: true }, undefined, { ok: true, version: "" }]) {
      const { fetchImpl } = stubFetch(() => jsonResponse(200, body));
      await expect(
        savePreviewBody(pageWriteUrl("alpha"), "x", { fetchImpl }),
      ).resolves.toEqual({ status: "ok" });
    }
  });

  it("relays the SERVER's conflict sentence verbatim, and resolves", async () => {
    // A refused save must never throw: the caller's only correct response is to
    // keep the editor open with the owner's text and show this.
    for (const [status, error] of [
      [412, WRITE_CONFLICT_COPY],
      [428, WRITE_PRECONDITION_REQUIRED_COPY],
    ] as const) {
      const { fetchImpl } = stubFetch(() => jsonResponse(status, { error }));
      await expect(
        savePreviewBody(pageWriteUrl("alpha"), "x", { fetchImpl, version: "w1:2-old" }),
      ).resolves.toEqual({ status: "error", message: error });
    }
  });

  it("omits the header entirely when it has no version to send", async () => {
    // Not an empty or wildcard `If-Match`, which the routes would have to
    // decide about — the absence is the honest signal, and it is answered 428.
    // `null` and `""` are the two other spellings of "there is none": `If-Match:
    // ""` is a MALFORMED header rather than an absent one, and sending it would
    // be this client asserting a precondition it does not have.
    for (const version of [undefined, null, ""]) {
      const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, { ok: true }));
      await savePreviewBody(pageWriteUrl("alpha"), "x", { fetchImpl, version });
      expect(calls[0].init?.headers).toEqual({ "Content-Type": "application/json" });
    }
  });
});


// ---------------------------------------------------------------------------
// The rendered body
// ---------------------------------------------------------------------------
//
// The story's central feature, and until now only grepped for. `environment` is
// still `"node"` and there is still no jsdom, no `@testing-library` and no
// `.test.tsx` — the intent's **Never** is untouched. This is the house
// precedent (`src/components/__tests__/markdown-math.test.ts`): render the
// component to a static string with `react-dom/server` and assert on the markup.
//
// Two regressions this exists to catch, both of which used to keep the whole
// suite green: making `previewUrlTransform` defer unconditionally (every
// wikilink becomes a dead `<a href="">`), and inverting the `if (!exists)`
// branch (readable pages render as "(missing page)", missing ones as buttons).

function renderBody(
  markdown: string,
  slugs: string[] = ["alpha", "alpha-beta"],
  format: "markdown" | "text" = "markdown",
): string {
  return renderToStaticMarkup(
    createElement(PreviewBody, {
      format,
      content: markdown,
      readableSlugs: new Set(slugs),
      onOpenPage: () => {},
    }),
  );
}

describe("previewUrlTransform", () => {
  it("lets the wikilink scheme past and defers everything else", () => {
    // Deferring unconditionally is the one-word edit that empties every
    // wikilink href, because react-markdown's sanitizer drops schemes it does
    // not know — including the one the remark pass just wrote.
    const href = `${WIKILINK_HREF_PREFIX}alpha`;
    expect(previewUrlTransform(href)).toBe(href);
    expect(previewUrlTransform("https://example.com/a.png")).toBe(
      "https://example.com/a.png",
    );
    expect(previewUrlTransform("data:image/png;base64,AAAA")).toBe(
      "data:image/png;base64,AAAA",
    );
    // The app's policy still governs: script-capable data URIs are stripped.
    expect(previewUrlTransform("data:image/svg+xml;base64,PHN2Zz4=")).toBe("");
    expect(previewUrlTransform("javascript:alert(1)")).toBe("");
  });
});

describe("PreviewBody renders", () => {
  it("turns a resolved wikilink into an actionable control", () => {
    const html = renderBody("See [[alpha]] now.");
    expect(html).toContain('<button type="button" class="wb-wikilink">alpha</button>');
    // Not an anchor, and not a dead one: following it must not navigate.
    expect(html).not.toContain("<a ");
    expect(html).not.toContain('href=""');
  });

  it("resolves an aliased target through slugify and keeps the label", () => {
    const html = renderBody("[[Alpha Beta|the other]]");
    expect(html).toContain('class="wb-wikilink">the other</button>');
  });

  it("renders an unresolved wikilink as non-interactive, and says so", () => {
    const html = renderBody("See [[ghost]] now.");
    expect(html).toContain("wb-wikilink--missing");
    expect(html).toContain(WIKILINK_MISSING_COPY);
    // Inverting the branch would put a button here and the missing state on
    // `alpha` above — both assertions have to hold at once.
    expect(html).not.toContain("<button");
  });

  it("never turns a wikilink inside code into a link", () => {
    const fenced = renderBody("```\nsee [[alpha]] here\n```");
    expect(fenced).toContain("<code");
    expect(fenced).toContain("[[alpha]]");
    expect(fenced).not.toContain("wb-wikilink");

    const inline = renderBody("A `[[alpha]]` literal.");
    expect(inline).toContain("<code>[[alpha]]</code>");
    expect(inline).not.toContain("wb-wikilink");
  });

  it("treats a relative .md link exactly like a wikilink", () => {
    // `[text](slug.md)` is the form the kernel writes. As a live anchor it
    // navigates the browser off the Workbench to a URL that does not exist.
    const resolved = renderBody("See [Alpha](alpha.md) now.");
    expect(resolved).toContain('<button type="button" class="wb-wikilink">Alpha</button>');
    expect(resolved).not.toContain('href="alpha.md"');

    const missing = renderBody("See [Ghost](ghost.md) now.");
    expect(missing).toContain("wb-wikilink--missing");
    expect(missing).toContain(WIKILINK_MISSING_COPY);
    expect(missing).not.toContain('href="ghost.md"');
  });

  it("refuses to render a link that would navigate the shell away", () => {
    // Each of these is a live `<a href>` in the same tab: clicking it unmounts
    // the Workbench, and the first is `<a href>` to `/u/…` from the Preview by
    // name — the exact shape the story forbids.
    for (const [markdown, href] of [
      ["See [Alpha](/u/yopedia/alpha) now.", "/u/yopedia/alpha"],
      ["See [scan](raw/scan.pdf) now.", "raw/scan.pdf"],
      ["See [notes](./notes.txt) now.", "./notes.txt"],
      // The sanitizer empties this one, and `<a href="">` reloads the shell.
      ["See [x](javascript:alert(1)) now.", ""],
    ] as const) {
      const html = renderBody(markdown);
      expect(html).toContain('class="wb-preview-deadlink"');
      expect(html).not.toContain(`href="${href}"`);
      expect(html).not.toContain("<a ");
    }
  });

  it("still renders a footnote's anchors, which are fragments", () => {
    // `remark-gfm` emits `#user-content-fn-…` links in both directions. A
    // fragment moves the caret inside the page already on screen, so treating
    // it like a navigation would break the one GFM feature that needs anchors.
    const html = renderBody("A claim.[^1]\n\n[^1]: The note.");
    expect(html).toContain('href="#user-content-fn-1"');
    expect(html).toContain("data-footnote-backref");
    expect(html).not.toContain('class="wb-preview-deadlink"');
  });

  it("leaves an external link an ordinary anchor, opened safely", () => {
    const html = renderBody("[site](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("renders a GFM table inside its own scroll container", () => {
    const html = renderBody("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(html).toContain('<div class="wb-preview-table">');
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>1</td>");
    // react-markdown's own mdast handle must not leak into the markup.
    expect(html).not.toContain("[object Object]");
  });

  it("renders the rest of GFM: strikethrough and task lists", () => {
    expect(renderBody("~~gone~~")).toContain("<del>gone</del>");
    const tasks = renderBody("- [x] done\n- [ ] todo");
    expect(tasks).toContain('type="checkbox"');
    expect(tasks).toContain("task-list-item");
  });

  it("shows plain text verbatim rather than parsing it", () => {
    const html = renderBody("# not a heading\n\n[[alpha]]", ["alpha"], "text");
    expect(html).toContain("<pre");
    expect(html).toContain("# not a heading");
    expect(html).not.toContain("<h1>");
    expect(html).not.toContain("wb-wikilink");
  });

  it("emits no empty href anywhere, for any of the above", () => {
    const html = renderBody(
      [
        "See [[alpha]], [[ghost]], [Alpha](alpha.md), [site](https://example.com).",
        "",
        "![x](data:image/png;base64,AAAA)",
      ].join("\n"),
    );
    expect(html).not.toContain('href=""');
    expect(html).not.toContain('src=""');
  });
});
