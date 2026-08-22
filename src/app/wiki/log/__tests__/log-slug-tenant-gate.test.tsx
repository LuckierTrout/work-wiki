import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import type { SlugTenantMap } from "@/lib/links";
import type { IndexEntry } from "@/lib/types";

/**
 * The activity log's in-content links, and the readability gate on the map that
 * resolves them (DW-83).
 *
 * The log is a SERVER page, so it cannot use `useSlugTenants` — it builds the
 * slug→tenant map itself. That makes the gate load-bearing in a way the client
 * call sites' is not: the page already redacts every log line naming a page the
 * viewer can't read, and an ungated map (`buildSlugTenantMap()`, one call
 * shorter and the obvious thing to reach for) would hand the renderer those
 * exact slugs paired with their owners — contradicting the redaction entry by
 * entry, whether or not any surviving line links to them.
 *
 * The map does NOT currently reach the browser: `MarkdownRenderer` has no
 * `"use client"` directive, so this whole subtree renders on the server. That
 * is a property of the renderer rather than of this page, and it is exactly
 * what would stop being true the moment it (or any child) became a client
 * component — at which point the ungated map would be serialized into the
 * payload. The gate is what makes that change a non-event.
 *
 * Which is why the assertion reads the MAP, not the markup: a hidden slug's
 * absence from the DOM proves only that the redaction worked, and would stay
 * green with the gate deleted.
 */

const READABLE_LINE = "- 2026-01-01 ingest [Public Thing](public-thing.md)";
const HIDDEN_LINE = "- 2026-01-02 ingest [Secret Thing](secret-thing.md)";

const entries: IndexEntry[] = [
  {
    slug: "public-thing",
    title: "Public Thing",
    summary: "",
    owner: "alice",
    visibility: "public",
  },
  {
    slug: "secret-thing",
    title: "Secret Thing",
    summary: "",
    owner: "mallory",
    visibility: "private",
  },
];

vi.mock("@/lib/wiki", () => ({
  readLog: vi.fn(async () => `${READABLE_LINE}\n\n${HIDDEN_LINE}\n`),
  listWikiPages: vi.fn(async () => entries),
}));

// A signed-in viewer who owns NEITHER page: `alice`'s public page is readable,
// `mallory`'s private one is not. `canReadEntry` itself is deliberately real —
// it is the gate under test.
vi.mock("@/lib/auth", () => ({
  getPrincipal: vi.fn(async () => ({ id: "user_bob", handle: "bob" })),
}));

import LogPage from "@/app/wiki/log/page";

/** The `slugTenants` the page actually hands its renderer, found in the tree. */
function renderedSlugTenants(node: ReactNode): SlugTenantMap | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = renderedSlugTenants(child);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  const props = node.props as { children?: ReactNode; slugTenants?: SlugTenantMap };
  if (node.type === MarkdownRenderer) return props.slugTenants;
  return renderedSlugTenants(props.children);
}

afterEach(() => {
  cleanup();
});

describe("activity log slug→tenant map", () => {
  it("resolves a readable page's link to its real owner", async () => {
    render(await LogPage());
    expect(
      screen.getByRole("link", { name: "Public Thing" }).getAttribute("href"),
    ).toBe("/u/alice/public-thing");
  });

  it("carries only readable pages, so no private slug→owner pairing is ever built", async () => {
    const map = renderedSlugTenants(await LogPage());
    // An exact match, not a `not.toHaveProperty`: the gate's job is to admit
    // the readable half and nothing else — the same half the redaction leaves
    // in the prose.
    expect(map).toEqual({ "public-thing": "alice" });
  });

  it("still redacts the hidden page's line from the prose", async () => {
    render(await LogPage());
    expect(screen.queryByRole("link", { name: "Secret Thing" })).toBeNull();
  });
});
