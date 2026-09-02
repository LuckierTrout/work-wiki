import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  wikiRelPath,
  rawRelPath,
  tenantWikiRelPath,
  tenantRawRelPath,
  validateTenant,
  DEFAULT_TENANT,
  tenantForSlug,
} from "../wiki";
import type { PageMetaIndex } from "../page-index";

// ---------------------------------------------------------------------------
// Mock page-index so tenantForSlug tests don't need real storage
// ---------------------------------------------------------------------------
let mockPageIndex: PageMetaIndex | null = null;
let getPageIndexCalls = 0;
vi.mock("../page-index", () => ({
  // Mirrors production: the real `getPageIndex` hands back a NULL-PROTOTYPE
  // map, which is what makes a slug naming an `Object.prototype` member read as
  // a miss on `tenantForSlug`'s fast path (DW-232). A plain-object mock would
  // quietly re-introduce the bug the tests below are meant to pin.
  getPageIndex: () => {
    getPageIndexCalls += 1;
    return Promise.resolve(
      mockPageIndex === null
        ? null
        : (Object.assign(Object.create(null), mockPageIndex) as PageMetaIndex),
    );
  },
  getPageIndexDirtySlugs: () => Promise.resolve(new Set<string>()),
}));

// Pin DATA_DIR and clear WIKI_DIR/RAW_DIR overrides so the relative-path math
// is deterministic.
const ENV_KEYS = ["DATA_DIR", "WIKI_DIR", "RAW_DIR"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.DATA_DIR = "/data";
  delete process.env.WIKI_DIR;
  delete process.env.RAW_DIR;
  mockPageIndex = null;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("legacy path helpers are unchanged (behavior-preserving)", () => {
  it("wikiRelPath / rawRelPath still resolve to the flat layout", () => {
    expect(wikiRelPath("hello.md")).toBe("wiki/hello.md");
    expect(wikiRelPath("index.md")).toBe("wiki/index.md");
    expect(rawRelPath("hello.md")).toBe("raw/hello.md");
  });
});

describe("tenant path helpers", () => {
  it("DEFAULT_TENANT is 'yopedia' (ownerless/seed content is the platform's)", () => {
    expect(DEFAULT_TENANT).toBe("yopedia");
  });

  it("build storage-relative keys under tenants/<tenant>/…", () => {
    expect(tenantWikiRelPath("yuanhao", "hello.md")).toBe(
      "tenants/yuanhao/wiki/hello.md",
    );
    expect(tenantWikiRelPath("system", "index.md")).toBe(
      "tenants/system/wiki/index.md",
    );
    expect(tenantRawRelPath("yuanhao", "hello.md")).toBe(
      "tenants/yuanhao/raw/hello.md",
    );
  });

  it("supports nested filenames (e.g. revisions)", () => {
    expect(tenantWikiRelPath("alice", ".revisions/p/123.md")).toBe(
      "tenants/alice/wiki/.revisions/p/123.md",
    );
  });
});

describe("validateTenant — traversal guard", () => {
  it("accepts plausible handles", () => {
    for (const t of ["yuanhao", "system", "yopedia", "a-b", "user123"]) {
      expect(() => validateTenant(t)).not.toThrow();
    }
  });

  it("rejects traversal / separators / dots / whitespace / control chars", () => {
    for (const bad of [
      "",
      "  ",
      ".", // bare dot collapses the path segment under path.join
      "..",
      "../x",
      "a/b",
      "a\\b",
      "a\0b",
      "a b", // internal whitespace
      "a\tb",
    ]) {
      expect(() => validateTenant(bad)).toThrow(/Invalid tenant/);
    }
  });

  it("the tenant path helpers reject traversal", () => {
    expect(() => tenantWikiRelPath("../escape", "x.md")).toThrow(/Invalid tenant/);
    expect(() => tenantRawRelPath("a/b", "x.md")).toThrow(/Invalid tenant/);
  });
});

// ---------------------------------------------------------------------------
// tenantForSlug — cached slug→tenant resolver
// ---------------------------------------------------------------------------

describe("tenantForSlug", () => {
  it("returns the correct tenant for a page with an owner", async () => {
    mockPageIndex = {
      "my-page": {
        slug: "my-page",
        title: "My Page",
        summary: "test",
        owner: "alice",
      },
    };
    expect(await tenantForSlug("my-page")).toBe("alice");
  });

  it("returns DEFAULT_TENANT for a page without an owner", async () => {
    mockPageIndex = {
      orphan: {
        slug: "orphan",
        title: "Orphan",
        summary: "no owner",
        // owner is undefined
      },
    };
    expect(await tenantForSlug("orphan")).toBe(DEFAULT_TENANT);
  });

  it("returns DEFAULT_TENANT for a nonexistent slug when index is present", async () => {
    mockPageIndex = {
      "existing-page": {
        slug: "existing-page",
        title: "Exists",
        summary: "yes",
        owner: "bob",
      },
    };
    // "no-such-page" is not in the index — falls through to buildSlugTenantMap
    // which also won't find it → DEFAULT_TENANT
    expect(await tenantForSlug("no-such-page")).toBe(DEFAULT_TENANT);
  });

  it("takes the slow path for a prototype-named slug missing from the index", async () => {
    mockPageIndex = {
      "existing-page": {
        slug: "existing-page",
        title: "Exists",
        summary: "yes",
        owner: "bob",
      },
    };
    getPageIndexCalls = 0;
    const tenant = await tenantForSlug("constructor");
    // Against a plain-object index, `pageIdx["constructor"]` answers with the
    // inherited `Object` constructor — truthy, so the fast path "hits" and the
    // slow path never runs. `listWikiPages` (the slow path) reads the index a
    // second time, so a call count above one is the proof the miss was
    // recorded and the fall-through happened.
    expect(getPageIndexCalls).toBeGreaterThan(1);
    expect(tenant).toBe(DEFAULT_TENANT);
    expect(typeof tenant).toBe("string");
  });

  it("falls back to buildSlugTenantMap when page index is absent", async () => {
    // mockPageIndex is null (default) → getPageIndex returns null
    // buildSlugTenantMap will return {} in this test env (no wiki pages on disk)
    // so any slug → DEFAULT_TENANT
    expect(await tenantForSlug("anything")).toBe(DEFAULT_TENANT);
  });
});
