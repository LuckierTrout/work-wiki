import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { _resetSlugTenants, loadSlugTenants } from "@/hooks/useSlugTenants";
import { ActionInbox } from "@/components/ActionInbox";
import type { ActionItem } from "@/lib/action-items";

/**
 * The cited-source receipt when the Source is GONE (DW-593).
 *
 * `markSourceMissing` sets `ActionItem.sourceMissing` when a Source is
 * cascade-deleted and the to-do that cited it is kept. Nothing in
 * `ActionInbox` had ever read that flag, so the row went on rendering
 * `source · <slug>` as a live link into a page that no longer exists — the
 * component stating as fact something its own data contradicted. The sibling
 * Todo surface (`TodosCanvas`) has said "Source missing" since it shipped; this
 * is the same claim, in the same words, on the surface that was missing it.
 *
 * Its own file rather than a graft onto `owner-scoped-anchors.test.tsx`: that
 * file's subject is which OWNER an anchor addresses, and its one `ActionInbox`
 * mount exists to pin the live-source href. That case stays exactly as it is —
 * it is the other half of this contract, and this file must not be able to pass
 * by deleting the link altogether.
 *
 * Every assertion here is on `queryByRole("link", …)` so that the anchor's
 * ABSENCE is the thing that fails. A row that still links a deleted Source
 * would pass any assertion written on the visible text.
 */

const SLUG_TENANTS = { target: "alice" } as const;
/** The map's canonical answer — `target` is ALICE's, never the default tenant. */
const ALICE_TARGET = "/u/alice/target";

function item(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    id: "act-1",
    title: "Chase the quarterly numbers",
    priority: "medium",
    // The default tab is "inbox" (Proposed); any other status renders the
    // empty state, and the receipts row with it.
    status: "inbox",
    sourceSlug: "target",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

let routes: Record<string, unknown>;

beforeEach(async () => {
  // The hook caches its map for the life of the MODULE, so a cold start per
  // test is what keeps each mount's hrefs attributable to this file's fixture.
  _resetSlugTenants();
  routes = {
    "/api/wiki/routes": { ...SLUG_TENANTS },
    "/api/action-items": { items: [item()] },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const key = String(url);
      if (!(key in routes)) throw new Error(`unexpected fetch: ${key}`);
      return { ok: true, status: 200, json: async () => routes[key] } as unknown as Response;
    }),
  );
  // Warm the session cache BEFORE the mount, so the map is on the first paint.
  // Without it every href assertion races the hook's effect, and a component
  // that never adopted the map would look exactly like one still loading.
  await loadSlugTenants();
});

afterEach(() => {
  // FIRST: vitest runs `afterEach` in reverse registration order, so the setup
  // file's own `cleanup()` lands after this one. Unmount while `fetch` is still
  // stubbed.
  cleanup();
  vi.unstubAllGlobals();
});

/** The rendered to-do row, once the load has landed. */
async function row(): Promise<HTMLElement> {
  return (await screen.findByRole("heading", { name: "Chase the quarterly numbers" }))
    .closest("article") as HTMLElement;
}

describe("ActionInbox's cited-source receipt", () => {
  it("links a PRESENT source to its own owner's page", async () => {
    render(<ActionInbox />);
    const link = await screen.findByRole("link", { name: "source · target" });
    expect(link.getAttribute("href")).toBe(ALICE_TARGET);
  });

  it("names a cascade-deleted source as missing and offers NO route to it", async () => {
    routes["/api/action-items"] = { items: [item({ sourceMissing: true })] };

    render(<ActionInbox />);
    const article = await row();

    // The slug is still on screen: the owner has to know WHICH source went
    // away to judge the to-do, and a chip that simply vanished would read as
    // "this to-do never cited anything".
    expect(screen.getByText("source · target")).toBeTruthy();
    // …in `TodosCanvas`'s words, so the two Todo surfaces say one thing.
    expect(screen.getByText("Source missing")).toBeTruthy();

    // And it is NOT a link — the defect, stated the only way that fails.
    expect(screen.queryByRole("link", { name: "source · target" })).toBeNull();
    // Nothing else in the row addresses the slug either, so the fix cannot be
    // satisfied by moving the same anchor behind different text.
    const addressed = Array.from(article.querySelectorAll("a")).filter((anchor) =>
      (anchor.getAttribute("href") ?? "").includes("target"),
    );
    expect(addressed).toHaveLength(0);
  });

  it("renders neither chip for a to-do that cites no source at all", async () => {
    routes["/api/action-items"] = {
      items: [item({ sourceSlug: undefined, sourceMissing: undefined })],
    };

    render(<ActionInbox />);
    await row();

    expect(screen.queryByText(/^source · /)).toBeNull();
    // "Source missing" belongs to a to-do that HAD a source. A row that cites
    // nothing has lost nothing, and saying otherwise would be the same class of
    // unsupported claim in the other direction.
    expect(screen.queryByText("Source missing")).toBeNull();
    expect(screen.queryByRole("link", { name: /source · / })).toBeNull();
  });
});
