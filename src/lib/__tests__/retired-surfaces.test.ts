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
import { syncCommonsForPage, getCommonsIndex, upsertCommonsEntry } from "../commons";
import { canSetPrivate } from "../authz";
import { dispatchMcp } from "../mcp-http";
import { _resetStorage } from "../storage";
import { ensureDirectories } from "../wiki";

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
async function retiredSurfacesOnDisk(dir = APP_DIR): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await retiredSurfacesOnDisk(full)));
      continue;
    }
    if (!/^(page|route|opengraph-image)\.tsx?$/.test(entry.name)) continue;
    const src = await fs.readFile(full, "utf8");
    if (!/from\s+["']@\/lib\/retired["']/.test(src)) continue;
    const routeDir =
      "/" +
      path
        .relative(APP_DIR, dir)
        .split(path.sep)
        // An optional catch-all (`[[...waitlist]]`) matches the parent path
        // itself, so the addressable surface is the parent — `/waitlist`.
        .filter((seg) => !seg.startsWith("[["))
        .join("/");
    // `opengraph-image` is its own addressable route; page/route are the dir.
    found.push(
      entry.name.startsWith("opengraph-image")
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
   * The whole `<canvas>…</canvas>` element, once there is exactly one.
   *
   * Counted by OPENING tag rather than by matched span, for two reasons a span
   * count misses: a self-closing `<canvas />` has no fallback child at all and
   * no closing tag to be counted by, and a self-closing canvas placed BEFORE
   * the real one would otherwise be swallowed into a single span running from
   * the first opening tag to the second's `</canvas>`. Either way a second
   * canvas would ship with no accessible alternative and no failing test —
   * which is the shape of the DW-131 bug itself.
   */
  function canvasSpan(src: string): string {
    expect(
      (src.match(/<canvas\b/g) ?? []).length,
      "the graph page renders exactly one <canvas>",
    ).toBe(1);
    const span = /<canvas\b[^>]*>[\s\S]*?<\/canvas>/.exec(src);
    expect(
      span,
      "the <canvas> must carry a fallback child, not be self-closing",
    ).not.toBeNull();
    return span![0];
  }

  /** The `<canvas>` fallback child — what a client that cannot render it shows. */
  function canvasFallback(src: string): string {
    return /<canvas\b[^>]*>([\s\S]*?)<\/canvas>/.exec(canvasSpan(src))![1];
  }

  /** The `<canvas>`'s own `aria-label`. */
  function canvasAriaLabel(src: string): string {
    const label = /aria-label=\s*"([^"]*)"/.exec(canvasSpan(src));
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

  it("is built from the mode param rather than hand-copied", () => {
    // A path typed out by hand would survive a rename of
    // `WORKBENCH_MODE_PARAM` and quietly stop naming a mode at all. Reading the
    // href back through the shell's OWN parser is what makes "derived" a fact
    // rather than a comment: a `?mode=` that no longer resolves to a real
    // {@link WorkbenchModeId} answers `null` here.
    expect(KNOWLEDGE_TREE_HREF).toContain(`?${WORKBENCH_MODE_PARAM}=`);
    const search = KNOWLEDGE_TREE_HREF.slice(KNOWLEDGE_TREE_HREF.indexOf("?"));
    expect(readModeFromSearch(search)).not.toBeNull();
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
