import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { loadSlugTenants } from "@/hooks/useSlugTenants";
import { QueryResultPanel } from "@/components/QueryResultPanel";
import { SlidePreview } from "@/components/SlidePreview";
import { RawSourceBrowser } from "@/components/RawSourceBrowser";
import { AgentApiContent } from "@/components/AgentApiContent";

/**
 * Slug→tenant adoption across every renderer that shows user content, MOUNTED
 * (DW-83).
 *
 * `MarkdownRenderer` has resolved in-content `[T](target.md)` links through a
 * `slugTenants` map for a while, but five call sites never passed one — so a
 * query answer, a slide deck, a raw source and the agent-API guide all emitted
 * `/u/yopedia/target` and relied on the owner route's 308 to land on the real
 * handle. That is a wrong-handle hop on every internal link, and nothing
 * observed it: the link still worked, just one redirect later.
 *
 * The assertion is therefore on the RENDERED HREF, not on whether a component
 * imports the hook. A component that obtains the map and forgets to forward it
 * to one of its renderers (the `SlidePreview` shape — it renders markdown from
 * two places) passes an import check and fails here. `/api/wiki/routes` is
 * stubbed to `{target: "alice"}`, so the canonical href is `/u/alice/target`
 * and the pre-fix behavior — `/u/yopedia/target` — is a distinguishable failure
 * rather than a near-miss.
 */

const GUIDE = "# Guide\n\nSee [T](target.md) for details.\n";
const UNKNOWN_DECK = `---
marp: true
---

# Only slide

Cites [U](stranger.md).
`;
const PROSE = "An answer citing [T](target.md).";
const DECK = `---
marp: true
---

# One

Cites [T](target.md).

---

# Two

Also cites [T](target.md).
`;

let fetchMock: ReturnType<typeof vi.fn>;

/**
 * Every URL any component in this file has requested, accumulated across the
 * whole run and deliberately NOT reset between tests.
 *
 * `useSlugTenants` caches its map in a module-level singleton, so the map is
 * fetched exactly once for the file — a per-test spy would show zero calls in
 * every test but the first, and asserting on it would be asserting on test
 * order. This records where the map came from regardless of which test paid
 * for it.
 */
const fetchedUrls: string[] = [];

beforeEach(async () => {
  fetchMock = vi.fn(async (url: string) => {
    fetchedUrls.push(url);
    if (url === "/api/wiki/routes") {
      return { ok: true, json: async () => ({ target: "alice" }) } as unknown as Response;
    }
    if (url === "/agent-api.md") {
      return { ok: true, text: async () => GUIDE } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  // `useSlugTenants` initializes its state from a module-level session cache,
  // so warming it here makes the map available on the FIRST paint. Without
  // this every assertion would race the hook's effect, and a component that
  // never adopted the map would look the same as one still loading.
  await loadSlugTenants();
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's `cleanup()` lands after this one. Unmount while `fetch` is
  // still stubbed.
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * The single fact every case asserts: the in-content link is canonical.
 *
 * `findByRole` already retries until the element appears, and the session cache
 * is warmed in `beforeEach`, so the href is right on the first paint — no
 * `waitFor` wrapper (which would only stack a second timeout onto a real
 * failure). `getAttribute` rather than jest-dom's `toHaveAttribute`: this
 * project's DOM setup registers no custom matchers.
 */
async function expectCanonicalTargetLink() {
  const link = await screen.findByRole("link", { name: "T" });
  expect(link.getAttribute("href")).toBe("/u/alice/target");
}

describe("in-content wikilinks resolve to the target's real owner", () => {
  it("QueryResultPanel — a prose answer", async () => {
    render(
      <QueryResultPanel
        result={{ answer: PROSE, sources: [] }}
        streaming={false}
        question="who owns target?"
        currentHistoryId={null}
      />,
    );
    await expectCanonicalTargetLink();
  });

  it("SlidePreview via QueryResultPanel — a Marp answer", async () => {
    // Also pins that the panel needs to do NOTHING for its deck branch to
    // resolve links: `SlidePreview` fetches the gated map itself.
    render(
      <QueryResultPanel
        result={{ answer: DECK, sources: [] }}
        streaming={false}
        question="deck?"
        currentHistoryId={null}
      />,
    );
    await expectCanonicalTargetLink();
  });

  it("SlidePreview — the all-slides view uses the map too", async () => {
    // The component renders `MarkdownRenderer` from TWO places (single slide,
    // and the "Show all slides" list). Wiring the map into one of them would
    // leave the other on the DEFAULT_TENANT hop, so both are asserted after
    // the toggle.
    render(<SlidePreview content={DECK} />);
    // `fireEvent`, not `element.click()`: a raw DOM click fires outside React's
    // act/event system, so the state update it causes is unbatched and warns.
    fireEvent.click(screen.getByRole("button", { name: "Show all slides" }));
    await waitFor(() => {
      const links = screen.getAllByRole("link", { name: "T" });
      expect(links.length).toBe(2); // both slides rendered
      for (const link of links) {
        expect(link.getAttribute("href")).toBe("/u/alice/target");
      }
    });
  });

  it("SlidePreview sources its OWN gated map and accepts none from its parent", async () => {
    // The privacy half of DW-83. `SlidePreview` is `"use client"`, and one of
    // its parents (`ArticleView`) is an async SERVER component holding the map
    // from the UNGATED `buildSlugTenantMap()` — so a `slugTenants` PROP would
    // have serialized every private page's slug→owner pairing into the RSC
    // payload of any legacy Marp deck page.
    //
    // Mounting `ArticleView` to prove the negative is impractical (async server
    // component, filesystem-backed). These two assertions cover it instead:

    // 1. The map arrives without a parent supplying one, and the only body
    //    carrying `alice` is the readability-gated `/api/wiki/routes` response
    //    — the stub throws on any URL but that one and `/agent-api.md`, and
    //    the guide is plain markdown with no map in it.
    render(<SlidePreview content={DECK} />);
    await expectCanonicalTargetLink();
    expect(fetchedUrls).toContain("/api/wiki/routes");

    // 2. There is no prop to hand it one. `@ts-expect-error` FAILS `tsc` if the
    //    prop is ever reintroduced, which is the actual regression to catch —
    //    a runtime assertion could not see a prop that silently works again.
    // @ts-expect-error `SlidePreview` must not accept a caller-supplied map.
    void (<SlidePreview content={DECK} slugTenants={{ target: "mallory" }} />);
  });

  it("falls back to the DEFAULT_TENANT href for a slug the map does not know", async () => {
    // The other half of the contract, and the reason `slugPath()` still exists:
    // an unknown slug is what a renderer sees for a page created after the map
    // was cached, and what every renderer sees while the session fetch is in
    // flight. The link must still work — addressed through DEFAULT_TENANT, one
    // 308 from canonical — rather than emitting `/u//stranger` or throwing.
    render(<SlidePreview content={UNKNOWN_DECK} />);
    const link = await screen.findByRole("link", { name: "U" });
    expect(link.getAttribute("href")).toBe("/u/yopedia/stranger");
  });

  it("RawSourceBrowser — markdown-shaped raw content", async () => {
    render(
      <RawSourceBrowser
        slug="host"
        items={[
          {
            key: "__legacy__",
            kind: "legacy",
            sourceId: null,
            type: "url",
            url: "https://example.com/doc",
            fetched: "2026-01-01",
            triggeredBy: "system",
          },
        ]}
        initialKey="__legacy__"
        initialContent={GUIDE}
        backHref="/u/alice/host"
      />,
    );
    await expectCanonicalTargetLink();
  });

  it("AgentApiContent — the fetched guide", async () => {
    render(<AgentApiContent />);
    await expectCanonicalTargetLink();
  });
});
