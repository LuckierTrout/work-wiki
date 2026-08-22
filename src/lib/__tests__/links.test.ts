import { describe, it, expect } from "vitest";
import {
  escapeRegex,
  extractWikiLinks,
  hasLinkTo,
  DEFAULT_TENANT,
  ownerToTenant,
  pagePath,
  slugPath,
  editPath,
  rawPath,
  resolveSlugPath,
} from "../links";

describe("escapeRegex", () => {
  it("escapes all special regex characters", () => {
    const special = ".*+?^${}()|[]\\";
    const escaped = escapeRegex(special);
    // Every special char should be preceded by a backslash
    expect(escaped).toBe("\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\");
    // The escaped string should be usable in a RegExp without throwing
    expect(() => new RegExp(escaped)).not.toThrow();
  });

  it("passes through plain strings unchanged", () => {
    expect(escapeRegex("hello")).toBe("hello");
    expect(escapeRegex("foo-bar_baz")).toBe("foo-bar_baz");
  });

  it("handles empty string", () => {
    expect(escapeRegex("")).toBe("");
  });
});

describe("extractWikiLinks", () => {
  it("extracts a single [text](slug.md) link", () => {
    const content = "See [Machine Learning](machine-learning.md) for details.";
    const links = extractWikiLinks(content);
    expect(links).toEqual([
      { text: "Machine Learning", targetSlug: "machine-learning" },
    ]);
  });

  it("extracts multiple links from the same content", () => {
    const content =
      "Read [AI](ai.md) and [Deep Learning](deep-learning.md) pages.";
    const links = extractWikiLinks(content);
    expect(links).toHaveLength(2);
    expect(links[0]).toEqual({ text: "AI", targetSlug: "ai" });
    expect(links[1]).toEqual({
      text: "Deep Learning",
      targetSlug: "deep-learning",
    });
  });

  it("handles slugs with hyphens and underscores", () => {
    const content = "[A Page](some_slug-name.md)";
    const links = extractWikiLinks(content);
    expect(links).toEqual([
      { text: "A Page", targetSlug: "some_slug-name" },
    ]);
  });

  it("returns empty array when no links are present", () => {
    expect(extractWikiLinks("Just plain text.")).toEqual([]);
    expect(extractWikiLinks("")).toEqual([]);
  });

  it("does NOT match non-.md links", () => {
    const content = "[Example](https://example.com)";
    expect(extractWikiLinks(content)).toEqual([]);
  });

  it("does NOT match bare text without link syntax", () => {
    const content = "something.md is mentioned but not linked";
    expect(extractWikiLinks(content)).toEqual([]);
  });
});

describe("hasLinkTo", () => {
  it("returns true when content contains a link to the slug", () => {
    const content = "See [Transformers](transformers.md) for more info.";
    expect(hasLinkTo(content, "transformers")).toBe(true);
  });

  it("returns false when slug appears in prose but not as a link", () => {
    const content = "The transformers architecture is powerful.";
    expect(hasLinkTo(content, "transformers")).toBe(false);
  });

  it("returns false when content is empty", () => {
    expect(hasLinkTo("", "anything")).toBe(false);
  });

  it("handles slugs with special regex characters", () => {
    // Slug containing chars that are special in regex
    const content = "See [C++](c++.md) for details.";
    expect(hasLinkTo(content, "c++")).toBe(true);
    // Should not false-positive on similar but different content
    expect(hasLinkTo("See [Cpp](cpp.md) page.", "c++")).toBe(false);
  });

  it("does not match partial slug in link", () => {
    const content = "See [Foobar](foobar.md) page.";
    // "foo" should not match "foobar.md"
    expect(hasLinkTo(content, "foo")).toBe(false);
  });
});

describe("ownerToTenant", () => {
  it("lowercases the handle (one owner, one silo)", () => {
    expect(ownerToTenant("Alice")).toBe("alice");
    expect(ownerToTenant("  Bob  ")).toBe("bob");
  });

  it("falls back to DEFAULT_TENANT (yopedia) when ownerless", () => {
    expect(DEFAULT_TENANT).toBe("yopedia");
    expect(ownerToTenant(undefined)).toBe("yopedia");
    expect(ownerToTenant(null)).toBe("yopedia");
    expect(ownerToTenant("")).toBe("yopedia");
    expect(ownerToTenant("   ")).toBe("yopedia");
  });

  it("normalizes path-unsafe chars so the tenant is always a valid URL/folder", () => {
    // whitespace / separators / dots → dash; result must be validateTenant-safe.
    expect(ownerToTenant("Jean Luc")).toBe("jean-luc");
    expect(ownerToTenant("bob/admin")).toBe("bob-admin");
    expect(ownerToTenant("a.b")).toBe("a-b");
    expect(ownerToTenant("..")).toBe("yopedia"); // ".." → trimmed empty → default
  });

  it("preserves the `--` in agent-style ids and unicode handles", () => {
    expect(ownerToTenant("alice--yoyo")).toBe("alice--yoyo");
    expect(ownerToTenant("检索增强")).toBe("检索增强");
  });
});

describe("canonical URL builders", () => {
  it("build owner-qualified page/edit/raw paths", () => {
    expect(pagePath("yuanhao", "transformers")).toBe("/u/yuanhao/transformers");
    expect(editPath("yuanhao", "transformers")).toBe(
      "/u/yuanhao/transformers/edit",
    );
    expect(rawPath("yuanhao", "transformers")).toBe(
      "/u/yuanhao/raw/transformers",
    );
  });

  // The retired commons form `/wiki/<slug>`, the retired `/share/` form, and
  // the retired public-profile builder are all gone: an owner-less call site
  // addresses a page through the default tenant, which 308s to canonical.
  it("builds a slug-only page path through the default tenant", () => {
    expect(slugPath("transformers")).toBe("/u/yopedia/transformers");
    expect(slugPath("retrieval-augmented-generation")).toBe(
      "/u/yopedia/retrieval-augmented-generation",
    );
    // Raw slug (incl. Unicode), like pagePath — the route + browser encode it.
    expect(slugPath("math-解释")).toBe("/u/yopedia/math-解释");
  });
});

describe("resolveSlugPath", () => {
  const map = { foo: "alice", bar: "bob" };

  it("resolves a target to its real owner (cross-owner links stay correct)", () => {
    expect(resolveSlugPath("foo", map, "yuanhao")).toBe("/u/alice/foo");
    expect(resolveSlugPath("bar", map, "yuanhao")).toBe("/u/bob/bar");
  });

  it("falls back to the linking page's tenant for unknown (dangling) targets", () => {
    expect(resolveSlugPath("missing", map, "yuanhao")).toBe("/u/yuanhao/missing");
    expect(resolveSlugPath("missing", undefined, "yopedia")).toBe(
      "/u/yopedia/missing",
    );
  });

  it("never emits an empty tenant segment", () => {
    // `/u//<slug>` matches no route — a call site that lost its tenant must
    // still produce a link the owner route can 308 onto the real handle.
    expect(resolveSlugPath("ghost", map, "")).toBe("/u/yopedia/ghost");
    expect(resolveSlugPath("ghost", undefined, "   ")).toBe("/u/yopedia/ghost");
    expect(pagePath("", "ghost")).toBe("/u/yopedia/ghost");
    // The edit and raw URLs live at the same route family and are built from
    // the same caller-supplied tenant, so they get the same floor.
    expect(editPath("", "ghost")).toBe("/u/yopedia/ghost/edit");
    expect(rawPath("   ", "ghost")).toBe("/u/yopedia/raw/ghost");
  });

  it("never emits the retired global /wiki/<slug> form", () => {
    for (const slug of ["foo", "bar", "ghost"]) {
      expect(resolveSlugPath(slug, map, "yuanhao")).not.toContain("/wiki/");
    }
  });

  // A slug is user-controlled text: a page titled "Constructor" slugifies to
  // `constructor`, "To String" to `to-string`, and so on. An inherited-member
  // lookup (`map[slug]`) answers those from `Object.prototype` — with a
  // FUNCTION, which `tenantSegment`'s `.trim()` then throws a TypeError on,
  // in the middle of rendering the page. The map only ever holds OWN string
  // entries (parsed response JSON / a server-built plain object), so anything
  // else must fall back rather than be treated as a tenant.
  it.each([
    ["constructor", "Object.prototype.constructor (a function)"],
    ["toString", "Object.prototype.toString (a function)"],
    ["hasOwnProperty", "Object.prototype.hasOwnProperty (a function)"],
    ["valueOf", "Object.prototype.valueOf (a function)"],
    ["__proto__", "the prototype accessor (an object)"],
  ])(
    "falls back for the prototype-collision slug %s instead of resolving %s",
    (slug) => {
      expect(() => resolveSlugPath(slug, map, "yuanhao")).not.toThrow();
      expect(resolveSlugPath(slug, map, "yuanhao")).toBe(`/u/yuanhao/${slug}`);
      // Also with no map at all, and with the empty fallback the hook passes.
      expect(resolveSlugPath(slug, undefined, "yuanhao")).toBe(
        `/u/yuanhao/${slug}`,
      );
      expect(resolveSlugPath(slug, {}, "")).toBe(`/u/yopedia/${slug}`);
    },
  );

  it("still honours an OWN entry whose key collides with a prototype member", () => {
    // The guard is own-property-only, not a blocklist: a real page whose slug
    // happens to be `constructor` still resolves to its owner.
    expect(resolveSlugPath("constructor", { constructor: "alice" }, "yuanhao")).toBe(
      "/u/alice/constructor",
    );
  });

  it("falls back for an own value that is not a string", () => {
    // A malformed/hostile `/api/wiki/routes` body is parsed JSON, not a typed
    // map — a number, null, or nested object must degrade to the fallback
    // href, never reach `tenantSegment` and throw.
    const malformed = {
      num: 7,
      nul: null,
      obj: { handle: "alice" },
      arr: ["alice"],
    } as unknown as Record<string, string>;
    for (const slug of ["num", "nul", "obj", "arr"]) {
      expect(() => resolveSlugPath(slug, malformed, "yuanhao")).not.toThrow();
      expect(resolveSlugPath(slug, malformed, "yuanhao")).toBe(
        `/u/yuanhao/${slug}`,
      );
    }
  });
});
