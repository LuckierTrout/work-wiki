import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { RETIRED_SURFACES, retiredPage, retiredRoute } from "../retired";
import {
  KNOWLEDGE_TREE_HREF,
  WORKBENCH_MODE_PARAM,
  readModeFromSearch,
} from "../workbench-url";
// The Knowledge TAB the escape hatch's copy promises, imported so the promise
// is pinned against the thing itself rather than against the route alone
// (DW-462).
import {
  DEFAULT_TREE_TAB,
  TREE_TABS,
  buildKnowledgeTree,
} from "../workbench-tree";
import type { IndexEntry } from "../types";
import { syncCommonsForPage, getCommonsIndex, upsertCommonsEntry } from "../commons";
import { canSetPrivate } from "../authz";
import { dispatchMcp } from "../mcp-http";
import { _resetStorage } from "../storage";
import { ensureDirectories } from "../wiki";
import { walkFiles } from "./source-scan";

// --- The retired modules, imported statically so vite can resolve them. ------
import WikiIndexPage from "@/app/wiki/page";
import PublicWikiPage from "@/app/wiki/[slug]/page";
import ContributorsPage from "@/app/wiki/contributors/page";
import WaitlistPage from "@/app/waitlist/[[...waitlist]]/page";
import SharePage from "@/app/share/[handle]/[slug]/page";
import ShareOgImage from "@/app/share/[handle]/[slug]/opengraph-image";
import UserProfilePage from "@/app/u/[handle]/page";
import AgentProfilePage from "@/app/u/[handle]/a/[agent]/page";

import * as browseRoute from "@/app/api/wiki/browse/route";
import * as contributorsRoute from "@/app/api/contributors/route";
import * as contributorRoute from "@/app/api/contributors/[handle]/route";
import * as queryDemoRoute from "@/app/api/query/demo/route";
import * as agentPublishRoute from "@/app/api/agents/[id]/publish/route";
import * as discussRoute from "@/app/api/wiki/[slug]/discuss/route";
import * as threadRoute from "@/app/api/wiki/[slug]/discuss/[threadIndex]/route";
import * as commentsRoute from "@/app/api/wiki/[slug]/discuss/[threadIndex]/comments/route";
import * as askYoyoRoute from "@/app/api/wiki/[slug]/discuss/[threadIndex]/ask-yoyo/route";
import * as wikiEditRoute from "@/app/wiki/[slug]/edit/route";

const APP_DIR = path.resolve(__dirname, "../../app");

/**
 * Walk `src/app` and return the App Router path of every route/page module
 * whose source imports `@/lib/retired` — i.e. what is retired **in the code**,
 * independent of any list a human maintains. Comparing this against
 * {@link RETIRED_SURFACES} is what stops the constant from silently drifting
 * out of sync with the tree.
 */
async function retiredSurfacesOnDisk(): Promise<string[]> {
  const found: string[] = [];
  for (const file of await walkFiles(APP_DIR, {
    include: /^(page|route|opengraph-image)\.tsx?$/,
  })) {
    const src = await fs.readFile(file, "utf8");
    if (!/from\s+["']@\/lib\/retired["']/.test(src)) continue;
    const routeDir =
      "/" +
      path
        .relative(APP_DIR, path.dirname(file))
        .split(path.sep)
        // An optional catch-all (`[[...waitlist]]`) matches the parent path
        // itself, so the addressable surface is the parent — `/waitlist`.
        .filter((seg) => !seg.startsWith("[["))
        .join("/");
    // `opengraph-image` is its own addressable route; page/route are the dir.
    found.push(
      path.basename(file).startsWith("opengraph-image")
        ? `${routeDir}/opengraph-image`
        : routeDir,
    );
  }
  return found;
}

/**
 * Story 1.1's cut list, verified end to end: every entry in
 * {@link RETIRED_SURFACES} resolves to a real 404, the commons write side
 * effect is inert, private no longer costs a plan, and MCP reads need a
 * principal. Covers the I/O matrix rows for the retired surfaces.
 */

// Pages 404 by throwing Next's not-found signal.
const RETIRED_PAGES: Record<string, () => never> = {
  "/wiki": WikiIndexPage as () => never,
  "/wiki/[slug]": PublicWikiPage as () => never,
  "/wiki/contributors": ContributorsPage as () => never,
  "/waitlist": WaitlistPage as () => never,
  "/share/[handle]/[slug]": SharePage as () => never,
  "/u/[handle]": UserProfilePage as () => never,
  "/u/[handle]/a/[agent]": AgentProfilePage as () => never,
};

// Route handlers (and the share OG metadata route) 404 by returning a Response.
const RETIRED_HANDLERS: Record<string, Record<string, () => Response>> = {
  "/share/[handle]/[slug]/opengraph-image": { default: ShareOgImage },
  "/api/wiki/browse": { GET: browseRoute.GET },
  "/api/contributors": { GET: contributorsRoute.GET },
  "/api/contributors/[handle]": { GET: contributorRoute.GET },
  "/api/query/demo": { GET: queryDemoRoute.GET },
  "/api/agents/[id]/publish": { POST: agentPublishRoute.POST },
  "/api/wiki/[slug]/discuss": { GET: discussRoute.GET, POST: discussRoute.POST },
  "/api/wiki/[slug]/discuss/[threadIndex]": {
    GET: threadRoute.GET,
    PATCH: threadRoute.PATCH,
  },
  "/api/wiki/[slug]/discuss/[threadIndex]/comments": {
    POST: commentsRoute.POST,
  },
  "/api/wiki/[slug]/discuss/[threadIndex]/ask-yoyo": {
    POST: askYoyoRoute.POST,
  },
  "/wiki/[slug]/edit": { GET: wikiEditRoute.GET as () => Response },
};

describe("RETIRED_SURFACES is the single enumerable cut list", () => {
  it("has no duplicate entries", () => {
    expect(new Set(RETIRED_SURFACES).size).toBe(RETIRED_SURFACES.length);
  });

  it("matches what is actually retired on disk", async () => {
    // Derived from the tree, not from a second hand-written list: a route
    // retired in code but forgotten in the constant (or the reverse) fails here.
    const onDisk = (await retiredSurfacesOnDisk()).sort();
    expect(onDisk).toEqual([...RETIRED_SURFACES].sort());
  });

  it("every entry is exercised by this suite", () => {
    const covered = [
      ...Object.keys(RETIRED_PAGES),
      ...Object.keys(RETIRED_HANDLERS),
    ].sort();
    expect(covered).toEqual([...RETIRED_SURFACES].sort());
  });
});

describe("every retired surface answers 404", () => {
  for (const [surface, page] of Object.entries(RETIRED_PAGES)) {
    it(`${surface} (page) triggers Next's not-found`, () => {
      // `notFound()` signals a 404 by throwing a tagged Next error.
      expect(() => page()).toThrowError(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
    });
  }

  for (const [surface, methods] of Object.entries(RETIRED_HANDLERS)) {
    for (const [method, handler] of Object.entries(methods)) {
      it(`${surface} (${method}) returns a bodiless 404`, async () => {
        const res = handler();
        expect(res.status).toBe(404);
        expect(await res.text()).toBe("");
      });

      it(`${surface} (${method}) takes no arguments — nothing is inspected`, () => {
        expect(handler.length).toBe(0);
      });
    }
  }
});

describe("retired helpers", () => {
  it("retiredPage() never returns", () => {
    expect(() => retiredPage()).toThrow();
  });

  it("retiredRoute() is a fresh, bodiless 404 each call", async () => {
    const a = retiredRoute();
    const b = retiredRoute();
    expect(a).not.toBe(b);
    expect(a.status).toBe(404);
    expect(await a.text()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The graph canvas's accessible escape hatch (DW-131)
// ---------------------------------------------------------------------------

/**
 * `/wiki` — the wiki index the graph canvas used to send screen-reader users
 * to for "a text-based list of all pages" — is an entry in
 * {@link RETIRED_SURFACES}, so that promise had been answering 404 since Story
 * 1.1. Nothing noticed, because the only reader of an `aria-label` or a
 * `<canvas>` fallback is someone who cannot see the canvas.
 *
 * The replacement target is {@link KNOWLEDGE_TREE_HREF}, spelled once in
 * `workbench-url.ts`. These pin it against the same list that retired the old
 * one: if the Workbench route joins `RETIRED_SURFACES`, or if the page starts
 * hand-writing a path again, this fails instead of the escape hatch quietly
 * 404ing.
 */
describe("the graph canvas's text-list alternative is a live route", () => {
  const GRAPH_PAGE = path.join(APP_DIR, "wiki", "graph", "page.tsx");

  /**
   * Markup only, the `workbench-split.test.ts` convention. A source scan that
   * kept comments would count the prose ABOVE the canvas — which discusses
   * `<canvas>` fallbacks by name — as markup, and every assertion below would
   * be measuring a sentence instead of an element.
   */
  function markup(source: string): string {
    return source
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  const graphSource = async () => markup(await fs.readFile(GRAPH_PAGE, "utf8"));

  /** An `<a>` or a `<Link>` whose href is the constant, not a string. */
  const LINK_TO_CONSTANT = /<(?:a|Link)\s[^>]*href=\{KNOWLEDGE_TREE_HREF\}/;

  /**
   * The `<canvas>` opening tag, found by SCANNING rather than by pattern.
   *
   * `/<canvas\b[^>]*>/` — what this replaced — stops at the first `>` after
   * `<canvas`, and a `>` is ordinary inside a JSX opening tag: an inline arrow
   * handler (`onClick={(e) => handleClick(e)}`) carries one, and so does any
   * attribute string that spells a comparison (`aria-label="a > b"`).
   *
   * The defect that pattern carries is LATENT, not live. Today's canvas
   * (`src/app/wiki/graph/page.tsx`) passes `onClick={handleClick}` — a bare
   * reference, no arrow — and no attribute of it contains a `>`, so the old
   * pattern happens to find the right boundary. It is one ordinary prop away
   * from not doing so: inline the handler, or write a `>` into the label, and
   * the tag "ends" mid-attribute. `canvasFallback()` would then return
   * ` handleClick(e)} …>` plus the children, and the assertions built on it
   * would go on passing while measuring a string the element never renders
   * (DW-460). Which is why the boundary is scanned rather than matched: the
   * guarantee should not depend on the page keeping its props shaped a
   * particular way.
   *
   * So the end of the tag is decided the way a parser decides it — a `>` counts
   * only at brace depth 0 and outside a string. `markup()` has already removed
   * `{/* … *\/}` and `//` comments, so props and attribute strings are the
   * whole of what this has to survive.
   *
   * Returns the tag's bounds plus whether it self-closes; `end` is `-1` when no
   * `>` closes it at all — an unterminated tag, or a scan that has lost sync
   * with the source's own nesting (see the `depth < 0` bail below).
   */
  function canvasOpeningTag(src: string, start: number) {
    let depth = 0;
    let quote: string | null = null;
    for (let i = start + "<canvas".length; i < src.length; i += 1) {
      const ch = src[i];
      if (quote !== null) {
        // A backslash escape belongs to the string, so the character after it
        // can never be read as the closing quote.
        if (ch === "\\") i += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        // A `}` with no `{` before it means the scan is no longer tracking the
        // source's own nesting, and every `>` after this point would be judged
        // at the wrong depth. Worse, a later `{` brings the count back to zero,
        // at which point a `>` sitting inside an attribute would be ACCEPTED as
        // the end of the tag. Stopping is the only honest answer: the boundary
        // is unknown, not found — and "unknown" is the same `-1` an
        // unterminated tag reports, which the callers already refuse.
        if (depth < 0) break;
      } else if (ch === ">" && depth === 0) {
        return {
          start,
          end: i + 1,
          selfClosing: /\/\s*$/.test(src.slice(start, i)),
        };
      }
    }
    return { start, end: -1, selfClosing: false };
  }

  /**
   * The one `<canvas>` opening tag on the page, with the count assertion that
   * makes "the one" true.
   *
   * Counted by OPENING tag rather than by matched span, for two reasons a span
   * count misses: a self-closing `<canvas />` has no fallback child at all and
   * no closing tag to be counted by, and a self-closing canvas placed BEFORE
   * the real one would otherwise be swallowed into a single span running from
   * the first opening tag to the second's `</canvas>`. Either way a second
   * canvas would ship with no accessible alternative and no failing test —
   * which is the shape of the DW-131 bug itself.
   */
  function canvasTag(src: string) {
    expect(
      (src.match(/<canvas\b/g) ?? []).length,
      "the graph page renders exactly one <canvas>",
    ).toBe(1);
    return canvasOpeningTag(src, src.search(/<canvas\b/));
  }

  /**
   * The whole `<canvas>…</canvas>` element, once there is exactly one.
   *
   * A self-closing tag, an unterminated one, and one with no `</canvas>` after
   * it are the same failure from the reader's side — no fallback child — so
   * they share the message.
   */
  function canvasSpan(src: string): string {
    const tag = canvasTag(src);
    const close = tag.end === -1 ? -1 : src.indexOf("</canvas>", tag.end);
    const span =
      tag.end === -1 || tag.selfClosing || close === -1
        ? null
        : src.slice(tag.start, close + "</canvas>".length);
    expect(
      span,
      "the <canvas> must carry a fallback child, not be self-closing",
    ).not.toBeNull();
    return span!;
  }

  /** The `<canvas>` fallback child — what a client that cannot render it shows. */
  function canvasFallback(src: string): string {
    // Sliced from the SCANNED tag end, so a `>` inside a prop cannot move the
    // boundary into the attribute list.
    const span = canvasSpan(src);
    const tag = canvasOpeningTag(span, 0);
    return span.slice(tag.end, span.length - "</canvas>".length);
  }

  /**
   * The `<canvas>`'s own `aria-label`.
   *
   * Read out of the OPENING TAG alone, not out of the whole span: an
   * `aria-label` on a descendant of the fallback child is somebody else's
   * label, and with the old truncated tag the search ran over the children too.
   */
  function canvasAriaLabel(src: string): string {
    const tag = canvasTag(src);
    // `end === -1` must be refused BEFORE the slice: `src.slice(start, -1)` is
    // the rest of the file bar one character, so an unterminated opening tag
    // would quietly hand back some LATER element's `aria-label` as the
    // canvas's — the shape of the bug this whole section exists to catch.
    expect(
      tag.end,
      "the <canvas> opening tag has no `>` that ends it — nothing here can be read from it",
    ).toBeGreaterThan(-1);
    const label = /aria-label=\s*"([^"]*)"/.exec(src.slice(tag.start, tag.end));
    expect(label, "the <canvas> still carries an aria-label").not.toBeNull();
    return label![1];
  }

  /** Every `aria-label="…"` string literal in the file. */
  function ariaLabels(src: string): string[] {
    return [...src.matchAll(/aria-label=\s*"([^"]*)"/g)].map((m) => m[1]);
  }

  it("KNOWLEDGE_TREE_HREF's pathname is not a retired surface", () => {
    const pathname = KNOWLEDGE_TREE_HREF.split(/[?#]/)[0];
    expect(RETIRED_SURFACES as readonly string[]).not.toContain(pathname);
  });

  it("is built from the mode param and names Wiki mode", () => {
    // A path typed out by hand would survive a rename of
    // `WORKBENCH_MODE_PARAM` and quietly stop naming a mode at all. Reading the
    // href back through the shell's OWN parser is what makes "derived" a fact
    // rather than a comment: a `?mode=` that no longer resolves to a real
    // {@link WorkbenchModeId} answers `null` here.
    //
    // But "resolves to SOME mode" is not the property this escape hatch needs.
    // Every id in `WORKBENCH_MODES` parses, so a `KNOWLEDGE_TREE_MODE` slipped
    // to `"graph"` or `"chat"` would satisfy a `not.toBeNull()` while pointing
    // the canvas's only accessible alternative at another visual surface — a
    // silent re-run of the DW-131 bug, one mode over. The Knowledge tree is a
    // property of WIKI mode specifically (`workbench-modes.ts`), so that is the
    // mode pinned here, by the parser rather than by string comparison against
    // the href.
    expect(KNOWLEDGE_TREE_HREF).toContain(`?${WORKBENCH_MODE_PARAM}=`);
    const search = KNOWLEDGE_TREE_HREF.slice(KNOWLEDGE_TREE_HREF.indexOf("?"));
    expect(readModeFromSearch(search)).toBe("wiki");
  });

  it("the App Router file behind that pathname exists and is not retired", async () => {
    // The assertion above can barely fire: `RETIRED_SURFACES` names sub-routes
    // in segment notation and would never list the app root. THIS is the pin
    // that can — it asks the tree the same question `retiredSurfacesOnDisk()`
    // asks, so retiring the Workbench page fails here rather than turning the
    // escape hatch back into a 404.
    const segments = KNOWLEDGE_TREE_HREF.split(/[?#]/)[0].split("/").filter(Boolean);
    const file = path.join(APP_DIR, ...segments, "page.tsx");
    const source = await fs.readFile(file, "utf8").catch(() => null);
    expect(source, `${file} backs KNOWLEDGE_TREE_HREF and must exist`).not.toBeNull();
    expect(
      markup(source!),
      `${file} imports @/lib/retired — the target is retired`,
    ).not.toMatch(/from\s+["']@\/lib\/retired["']/);
  });

  it("the graph page takes its target from the constant", async () => {
    const src = await graphSource();
    expect(src).toContain("KNOWLEDGE_TREE_HREF");
    expect(src).toMatch(/from\s+["']@\/lib\/workbench-url["']/);
  });

  it("offers the link OUTSIDE the canvas, where a reader can reach it", async () => {
    // The load-bearing half. A `<canvas>` fallback child renders only where
    // canvas is unsupported, and `role="img"` prunes descendants from the
    // accessibility tree — so the in-canvas link alone reaches nobody. With the
    // canvas span removed, a real link to the constant must survive.
    const src = await graphSource();
    const outside = src.replace(canvasSpan(src), "");
    expect(outside, "no link to KNOWLEDGE_TREE_HREF outside the <canvas>").toMatch(
      LINK_TO_CONSTANT,
    );
  });

  it("the canvas fallback is a real link built from the constant", async () => {
    const fallback = canvasFallback(await graphSource());
    expect(fallback).toMatch(/<a\s+href=\{KNOWLEDGE_TREE_HREF\}/);
  });

  it("the canvas aria-label still names the replacement target", async () => {
    // Without this, shortening the label to "Wiki page relationship graph."
    // would pass every other assertion here while removing the only thing that
    // tells a screen-reader user the alternative exists.
    expect(canvasAriaLabel(await graphSource())).toMatch(/Knowledge tree/);
  });

  it("spells no route literal of its own in an href", async () => {
    const src = await graphSource();
    // Brace-wrapped literals (`href={"/wiki"}`) count: they are the same
    // hand-written route the constant exists to replace. Non-route hrefs — an
    // external `https://`, a `mailto:`, a `#anchor` — are nobody's business
    // here, so only path-shaped literals are forbidden.
    const literals = [...src.matchAll(/href=\s*\{?\s*["'`]([^"'`]*)["'`]/g)]
      .map((m) => m[1])
      .filter((href) => href.startsWith("/"));
    expect(
      literals,
      `the graph page must take its routes from KNOWLEDGE_TREE_HREF, not spell ${literals.join(", ")}`,
    ).toEqual([]);
  });

  it("names no retired route in its accessible copy", async () => {
    const src = await graphSource();
    const copy = [...ariaLabels(src), canvasFallback(src)].join("\n");
    for (const surface of RETIRED_SURFACES) {
      expect(copy, `accessible copy points at retired ${surface}`).not.toContain(
        surface,
      );
    }
    // The exact wording the retired target shipped under, so a revert reads as
    // a failure rather than as prose someone is free to restore.
    expect(copy.toLowerCase()).not.toContain("wiki index");
  });

  // -------------------------------------------------------------------------
  // The opening-tag scanner's own evidence (DW-460)
  // -------------------------------------------------------------------------

  /**
   * Four of the nine assertions above measure from this boundary — the two
   * canvas-fallback ones, the `aria-label` one and the retired-route copy scan
   * — and so does the tab-label coupling further down. None of them can be
   * better than the boundary is, and that boundary used to be `[^>]*`.
   *
   * WHICH CASES BELOW ARE NEW EVIDENCE, precisely: the arrow-prop and the
   * quoted-`>` cases are, and so are the escaped-quote, template-literal,
   * stray-`}` and both `aria-label`-scope cases — every one of them passes the
   * old pattern while measuring the wrong text, or fails it outright. The
   * self-closing, unterminated-tag, missing-`</canvas>` and two-canvas cases
   * are NOT new evidence: the regex this replaced refused those three the same
   * way, and they are written down here to carry the pre-existing guarantee
   * forward unchanged rather than to demonstrate a fix.
   */
  describe("the <canvas> opening-tag scanner", () => {
    it("ends the tag past an arrow prop, not at the `>` inside it", () => {
      const src = `<canvas onClick={(e) => handleClick(e)} aria-label="graph">child</canvas>`;
      // The old `[^>]*` stopped at the `=>`, so the "fallback" came back as
      // ` handleClick(e)} aria-label="graph">child` — attribute text presented
      // as the element's accessible alternative.
      expect(canvasFallback(src)).toBe("child");
      expect(canvasAriaLabel(src)).toBe("graph");
    });

    it("ends the tag past a `>` inside a quoted attribute", () => {
      const src = `<canvas aria-label="a > b">child</canvas>`;
      expect(canvasFallback(src)).toBe("child");
      expect(canvasAriaLabel(src)).toBe("a > b");
    });

    it("refuses a self-closing canvas, which has no fallback child at all", () => {
      expect(() => canvasSpan(`<canvas ref={r} />`)).toThrow(
        /must carry a fallback child, not be self-closing/,
      );
      // Same verdict when the self-closing tag also carries a `>`-bearing prop,
      // which is the form the old pattern truncated.
      expect(() => canvasSpan(`<canvas onClick={(e) => f(e)} />`)).toThrow(
        /must carry a fallback child, not be self-closing/,
      );
      // The flag itself, and not only the absent `</canvas>` that follows from
      // it: a scanner reading `<canvas … />` as an ordinary opening tag would
      // go looking for children this element cannot have, and would find the
      // next element's.
      expect(canvasOpeningTag(`<canvas ref={r} />`, 0).selfClosing).toBe(true);
      expect(canvasOpeningTag(`<canvas ref={r}>x</canvas>`, 0).selfClosing).toBe(false);
    });

    it("refuses an opening tag nothing closes", () => {
      expect(() => canvasSpan(`<canvas aria-label="unterminated`)).toThrow(
        /must carry a fallback child, not be self-closing/,
      );
    });

    it("refuses a second canvas", () => {
      const src = `<canvas ref={a}>one</canvas><canvas ref={b}>two</canvas>`;
      expect(() => canvasSpan(src)).toThrow(/renders exactly one <canvas>/);
    });

    it("ends the tag past a `>` inside a SINGLE-quoted attribute", () => {
      // The `'` branch of the string state. JSX takes either quote, and an
      // attribute written with the other one would otherwise be scanned as if
      // it carried no string at all.
      const src = `<canvas data-hint='a > b' aria-label="graph">child</canvas>`;
      expect(canvasFallback(src)).toBe("child");
      expect(canvasAriaLabel(src)).toBe("graph");
    });

    it("ends the tag past a template-literal prop, quotes and all", () => {
      // The backtick branch. A template is the one attribute form that can
      // legitimately contain a LONE quote character — an apostrophe in prose —
      // and without backtick state that `\'` opens a string the scanner then
      // hunts a closing quote for through the rest of the file, swallowing the
      // tag boundary and every attribute after it.
      const src = "<canvas title={`what\'s > next`} aria-label=\"graph\">child</canvas>";
      expect(canvasFallback(src)).toBe("child");
      expect(canvasAriaLabel(src)).toBe("graph");
    });

    it("keeps a template's own `${…}` braces out of the depth count", () => {
      // The other half of the backtick branch: an interpolation's braces are
      // inside the string, so they must not move the depth counter that decides
      // where the tag ends — and the `>` in the interpolated expression must
      // not end it either.
      const src =
        "<canvas title={`a ${x > 1 ? \"y\" : \"n\"}`} aria-label=\"graph\">child</canvas>";
      expect(canvasFallback(src)).toBe("child");
      expect(canvasAriaLabel(src)).toBe("graph");
    });

    it("keeps a backslash-escaped quote inside the string it belongs to", () => {
      // Without the escape branch the escaped quote reads as the string's END,
      // the scanner leaves string state one character early, and the rest of
      // the attribute is scanned as markup — here that loses the tag boundary
      // altogether and the element stops having a fallback at all.
      const src = `<canvas aria-label={"a \\" > b"}>child</canvas>`;
      expect(canvasFallback(src)).toBe("child");
    });

    it("bails when a stray `}` puts the scan out of step", () => {
      // Depth below zero means the count no longer describes the source. A
      // later `{` returns it to zero, and without the bail the very next `>` —
      // wherever it sits — is accepted as the end of the tag.
      const src = `<canvas } {>child</canvas>`;
      expect(canvasOpeningTag(src, 0).end).toBe(-1);
      expect(() => canvasSpan(src)).toThrow(
        /must carry a fallback child, not be self-closing/,
      );
    });

    it("refuses a canvas whose closing tag never arrives", () => {
      // A DIFFERENT branch from the unterminated-opening-tag case above: here
      // the opening tag is complete, and it is `</canvas>` that is missing, so
      // there is no end to bound a fallback child with.
      const src = `<canvas ref={r}>child`;
      expect(canvasOpeningTag(src, 0).end).toBeGreaterThan(0);
      expect(() => canvasSpan(src)).toThrow(
        /must carry a fallback child, not be self-closing/,
      );
    });

    it("reads the aria-label off the TAG, never off a descendant", () => {
      // The rule that makes `canvasAriaLabel` worth having, and the one a
      // span-wide search silently gives up. With the search run over the whole
      // element, deleting the canvas's own `aria-label` and moving the identical
      // string onto the fallback `<a>` leaves every assertion in this section
      // green — a `<canvas role="img">` with no accessible name at all, which
      // is DW-131 restored in full.
      expect(() =>
        canvasAriaLabel(`<canvas ref={r}><a aria-label="Knowledge tree">x</a></canvas>`),
      ).toThrow(/still carries an aria-label/);
    });

    it("refuses to read an aria-label off an unterminated tag", () => {
      // The guard in `canvasAriaLabel`, which has to fire BEFORE the slice:
      // `src.slice(start, -1)` is the rest of the file bar one character, so
      // without it the canvas's accessible name is read off whatever element
      // happens to come next — a label the canvas does not carry, reported as
      // the canvas's own.
      const src = `<canvas title='unterminated><p aria-label="stolen">x</p>`;
      expect(canvasOpeningTag(src, 0).end).toBe(-1);
      expect(() => canvasAriaLabel(src)).toThrow(
        /opening tag has no `>` that ends it/,
      );
    });

    it("returns the tag's own aria-label when a descendant has one too", () => {
      // The other half of the same rule, stated so nobody has to guess which
      // label wins: the element's accessible name is the one on the element.
      const src = `<canvas aria-label="canvas own"><a aria-label="link's own">x</a></canvas>`;
      expect(canvasAriaLabel(src)).toBe("canvas own");
      // And both are still visible to the whole-file reader, which is what the
      // retired-route copy scan uses — the narrowing is to THIS helper only.
      expect(ariaLabels(src)).toEqual(["canvas own", "link's own"]);
    });
  });

  // -------------------------------------------------------------------------
  // The Knowledge TAB the escape hatch promises (DW-462)
  // -------------------------------------------------------------------------

  /**
   * The route is pinned above; the tree it promises was not. `TREE_TABS`,
   * `DEFAULT_TREE_TAB`, `TreePanel` and `buildKnowledgeTree` were unreferenced
   * from this file, so renaming the Knowledge tab — or removing it — left the
   * graph page's "a text list of this wiki's pages" unkept with every
   * assertion here green.
   */
  describe("the Knowledge tree that href promises still exists", () => {
    const TREE_PANEL = path.resolve(
      __dirname,
      "..",
      "..",
      "components",
      "workbench",
      "TreePanel.tsx",
    );

    it("lands a first-time reader on a real tree tab", () => {
      // The href guarantees the SURFACE, not the tab: `workbench-url.ts` keeps
      // the tree tab in browser-local state, so which tab someone following
      // this link lands on is `DEFAULT_TREE_TAB` and nothing else. A tab param
      // appearing in the href would mean that is no longer the tab to pin.
      const search = KNOWLEDGE_TREE_HREF.slice(KNOWLEDGE_TREE_HREF.indexOf("?"));
      expect(
        [...new URLSearchParams(search).keys()],
        "KNOWLEDGE_TREE_HREF carries a param besides the mode — the landing tab is no longer DEFAULT_TREE_TAB alone",
      ).toEqual([WORKBENCH_MODE_PARAM]);
      expect(
        TREE_TABS.map((tab) => tab.id),
        `DEFAULT_TREE_TAB ("${DEFAULT_TREE_TAB}") names no TREE_TABS member — the link lands on a tablist with nothing selected`,
      ).toContain(DEFAULT_TREE_TAB);
    });

    it("names that tab's own label in the copy the canvas points at", async () => {
      // THE COUPLING, and what makes this pin non-redundant with
      // `workbench-tree.test.ts`: the label is READ out of `TREE_TABS` rather
      // than written here a second time, so renaming the tab, or moving
      // `DEFAULT_TREE_TAB` to `files`, fails HERE — at the escape hatch that
      // promises it — and not only in a tree suite that has no opinion about
      // the promise this page makes.
      const landing = TREE_TABS.find((tab) => tab.id === DEFAULT_TREE_TAB);
      expect(landing, "DEFAULT_TREE_TAB is not a TREE_TABS member").toBeDefined();
      const named = `${landing!.label} tree`;

      const src = await graphSource();
      const where = `the graph page's copy must name the "${named}" the link lands on`;
      expect(canvasAriaLabel(src), where).toContain(named);
      expect(canvasFallback(src), where).toContain(named);
      expect(src.replace(canvasSpan(src), ""), where).toContain(named);
    });

    it("builds a text list of this wiki's pages, by title", () => {
      // The copy's literal promise. `buildKnowledgeTree` is the pure function
      // behind the tab, so the claim can be executed rather than asserted:
      // pages in, titled rows out.
      //
      // The fixture arrives in NONE of the orders the output uses, and the
      // result is compared as it comes back — sorting it here would discard
      // exactly the ordering this test's name claims. Three rules are pinned at
      // once: the untyped catch-all LEADS (its label, "Pages", collates after
      // both typed labels, so a plain label sort would put it last), typed
      // groups follow by label, and pages inside a group are in title order.
      const entries: IndexEntry[] = [
        { slug: "zeta", title: "Zeta", summary: "", type: "note" },
        { slug: "delta", title: "Delta", summary: "" },
        { slug: "acme", title: "Acme", summary: "", type: "brief" },
        { slug: "alpha", title: "Alpha", summary: "" },
        // Agent-scoped pages are not this wiki's pages and are dropped, which
        // is the one exclusion the promise has to survive.
        { slug: "yoyo", title: "Yoyo", summary: "", type: "agent-identity" },
      ];
      expect(
        buildKnowledgeTree(entries).map((group) => [
          group.label,
          group.pages.map((page) => page.title),
        ]),
      ).toEqual([
        ["Pages", ["Alpha", "Delta"]],
        ["Brief", ["Acme"]],
        ["Note", ["Zeta"]],
      ]);
    });

    it("renders those tabs in the left column's tablist", async () => {
      // A source pin rather than a mount: this file's suite is the `node`
      // project, which mounts nothing. It answers the half `TREE_TABS` alone
      // cannot — that the constant is what the tablist actually maps, so a
      // panel that hard-codes its own buttons stops satisfying the promise.
      const panel = markup(await fs.readFile(TREE_PANEL, "utf8"));
      expect(panel).toMatch(/from\s+["']@\/lib\/workbench-tree["']/);
      // Bound to the tablist element's OWN children — `[^>]*>` cannot cross out
      // of the opening tag, and `\s*` cannot cross an intervening element. An
      // unbounded `[\s\S]*?` would be satisfied by a `TREE_TABS.map(` anywhere
      // later in the module, so a panel that hand-spells its tab buttons and
      // maps the constant somewhere else entirely would still pass — which is
      // the one failure this assertion exists to catch.
      expect(
        panel,
        "TreePanel's tablist no longer maps TREE_TABS directly — the tabs the link lands on are whatever the panel spells by hand",
      ).toMatch(/role="tablist"[^>]*>\s*\{TREE_TABS\.map\(/);
    });
  });
});

// ---------------------------------------------------------------------------
// syncCommonsForPage is inert
// ---------------------------------------------------------------------------

describe("syncCommonsForPage performs no storage I/O", () => {
  let tmpDir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "retired-test-"));
    for (const k of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) saved[k] = process.env[k];
    process.env.WIKI_DIR = path.join(tmpDir, "wiki");
    process.env.RAW_DIR = path.join(tmpDir, "raw");
    process.env.DATA_DIR = tmpDir;
    _resetStorage();
    await ensureDirectories();
  });

  afterEach(async () => {
    for (const k of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _resetStorage();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes nothing for a page that used to belong in the commons", async () => {
    await syncCommonsForPage("x", {
      owner: "alice",
      visibility: "public",
      title: "X",
      summary: "s",
    });
    expect(await getCommonsIndex()).toEqual([]);
  });

  it("removes nothing either — an existing entry is left untouched", async () => {
    await upsertCommonsEntry({ tenant: "alice", slug: "x", title: "X", summary: "" });
    await syncCommonsForPage("x", {
      owner: "alice",
      visibility: "private",
      title: "X",
      summary: "",
    });
    expect(await getCommonsIndex()).toHaveLength(1);
  });

  it("resolves and never throws", async () => {
    await expect(
      syncCommonsForPage("y", { title: "Y", summary: "" }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Private no longer consults a plan
// ---------------------------------------------------------------------------

describe("canSetPrivate no longer consults a plan", () => {
  it("allows any non-null principal, human or service", async () => {
    expect(await canSetPrivate({ id: "u_alice", handle: "alice" })).toBe(true);
    expect(await canSetPrivate({ id: "service:ci", handle: "ci" })).toBe(true);
    expect(await canSetPrivate({ id: "agent:a--yoyo", handle: "a" })).toBe(true);
  });

  it("still denies an anonymous caller", async () => {
    expect(await canSetPrivate(null)).toBe(false);
  });

  it("does not export a paid-plan check any more", async () => {
    const authz = await import("../authz");
    expect("hasPaidPlan" in authz).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MCP: reads require a principal (AD-8)
// ---------------------------------------------------------------------------

describe("dispatchMcp refuses a READ tool with a null principal", () => {
  it("read_page is not served without a principal", async () => {
    const res = await dispatchMcp(
      {
        id: 1,
        method: "tools/call",
        params: { name: "read_page", arguments: { slug: "anything" } },
      },
      null,
    );
    const result = res!.result as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/authentication required/i);
    // No page content leaks into the refusal.
    expect(result.content[0].text).not.toMatch(/anything/);
  });

  it("search_wiki and query_wiki are refused too", async () => {
    for (const name of ["search_wiki", "query_wiki"]) {
      const res = await dispatchMcp(
        {
          id: 1,
          method: "tools/call",
          params: { name, arguments: { query: "q", question: "q" } },
        },
        null,
      );
      const result = res!.result as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(result.isError, name).toBe(true);
      expect(result.content[0].text).toMatch(/authentication required/i);
    }
  });

  it("publish_to_commons is gone from the tool list", async () => {
    const res = await dispatchMcp(
      { id: 1, method: "tools/list" },
      { id: "u_alice", handle: "alice" },
    );
    const tools = (res!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).not.toContain("publish_to_commons");
  });
});
