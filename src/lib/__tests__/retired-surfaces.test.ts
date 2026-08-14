import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { RETIRED_SURFACES, retiredPage, retiredRoute } from "../retired";
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
