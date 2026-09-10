import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { loadSlugTenants } from "@/hooks/useSlugTenants";
import { ChatWorkspace } from "@/components/ChatWorkspace";
import { unconfirmedWriteMessage } from "@/lib/workbench-request";
import type { ChatConversation } from "@/lib/chat";

/**
 * `ChatWorkspace.saveAnswer`, on the two outcomes that are NOT a saved page
 * (DW-263).
 *
 * Every `/api/query/save` stub in the suite answers ok-with-slug, so both of
 * the branches below were shipped unexecuted:
 *
 *   - `json()` maps an unparseable-but-OK body to `{}`, and `result.slug ? … :
 *     null` is what keeps the banner hidden rather than rendering "Saved as
 *     undefined". A rewrite to `setSavedMessage(result)` would look right, pass
 *     every existing case, and put a broken link in front of the owner.
 *   - the `catch` hands the reason to `writeFailure`, which answers the
 *     UNCONFIRMED sentence for a dropped connection. This surface refetches
 *     nothing — the page it writes lives in the wiki, which it does not render —
 *     so the sentence is the entire recovery, and a `Couldn’t save the answer.`
 *     here would be a flat claim the client is in no position to make.
 *
 * Its own file rather than a case in `owner-scoped-anchors.test.tsx`: that
 * suite's subject is the slug→tenant ANCHORS, and a save that renders no
 * anchor at all has nothing to say there.
 */

// ---------------------------------------------------------------------------
// Module boundaries
// ---------------------------------------------------------------------------

const nav = vi.hoisted(() => ({
  pathname: "/chat",
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => nav.router,
  useSearchParams: () => new URLSearchParams(),
}));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/**
 * A route table value meaning "the connection itself failed".
 *
 * A `TypeError` SPECIFICALLY, not any old rejection: `unconfirmedCause` treats
 * it as the one thing `fetch` rejects with when the socket goes away, and that
 * is the whole reason the outcome is unknown rather than failed. A plain
 * `Error` here would take the "caller's own sentence" branch of `writeFailure`
 * and the assertion below would be about a different code path.
 */
const TRANSPORT_FAILURE = Symbol("transport failure");

/** Per-test route table, consulted by the one `fetch` stub below. */
let routes: Record<string, unknown>;
let fetchMock: ReturnType<typeof vi.fn>;

const THREAD: ChatConversation = {
  id: "conv-1",
  title: "What the wiki says",
  scope: "",
  retrievalMode: "wiki",
  contextBudget: "standard",
  messages: [
    {
      id: "m1",
      role: "user",
      content: "What does the wiki say?",
      sources: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "m2",
      role: "assistant",
      content: "It says quite a lot.",
      sources: [],
      createdAt: "2026-01-01T00:00:01.000Z",
    },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
};

beforeEach(async () => {
  routes = {
    // The readability-gated slug→tenant map the workspace reads through
    // `useSlugTenants`; empty, because no assertion here is about an anchor.
    "/api/wiki/routes": {},
    "/api/chat/conversations": { conversations: [{ ...THREAD, messages: [] }] },
    "/api/vaults": { vaults: [] },
    "/api/agents?mine=1": { agents: [] },
    "/api/chat/hermes": { configured: false, available: false, safe: false },
    "/api/chat/conversations/conv-1": { conversation: THREAD },
  };
  fetchMock = vi.fn(async (url: string) => {
    const key = Object.keys(routes).find((route) => route === url);
    // A URL no fixture describes is a new call site or a broken fixture, not a
    // state under test — so it fails as itself rather than as a staged outage.
    if (key === undefined) throw new Error(`unexpected fetch: ${url}`);
    if (routes[key] === TRANSPORT_FAILURE) {
      throw new TypeError("Failed to fetch");
    }
    return ok(routes[key]);
  });
  vi.stubGlobal("fetch", fetchMock);
  // `useSlugTenants` initializes from a module-level session cache, so warming
  // it here makes the map available on the FIRST paint instead of racing the
  // hook's effect.
  await loadSlugTenants();
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's `cleanup()` lands after this one. Unmount while `fetch` is
  // still stubbed — the workspace aborts in-flight reads on unmount.
  cleanup();
  vi.unstubAllGlobals();
});

/** Mount the workspace and open the one thread, which is what renders answers. */
async function openThread() {
  render(<ChatWorkspace />);
  // `fireEvent`, not `element.click()`: a raw DOM click fires outside React's
  // event system, so the state update it causes is unbatched and warns.
  fireEvent.click(await screen.findByRole("button", { name: /What the wiki says/ }));
  await screen.findByRole("button", { name: "Save to wiki" });
}

/**
 * Press Save and let the whole save chain settle.
 *
 * `act` around the click flushes the effects AND the microtasks `saveAnswer`
 * awaits, so the state it sets last has landed by the time this returns. That
 * is what makes the two NEGATIVE assertions below sound: the control case
 * asserts a banner through this same helper, so an outcome that renders
 * nothing has genuinely rendered nothing rather than merely not yet.
 */
async function clickSave() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save to wiki" }));
  });
}

/** The success banner's text, whatever it links to — `null` when there is none. */
function savedBanner(): HTMLElement | null {
  return screen.queryByText(/^Saved as/);
}

describe("ChatWorkspace save outcomes", () => {
  it("banners a saved answer — the control this file's negatives rest on", async () => {
    await openThread();
    routes["/api/query/save"] = { slug: "fresh-answer", url: "/u/carol/fresh-answer" };

    await clickSave();

    expect(savedBanner()).not.toBeNull();
    expect(screen.getByRole("link", { name: "fresh-answer" }).getAttribute("href")).toBe(
      "/u/carol/fresh-answer",
    );
  });

  it("keeps the banner hidden when the save comes back without a slug", async () => {
    await openThread();
    // The shape `readJsonBody` produces for an OK response whose body did not
    // parse. There is nothing to link, so "Saved as undefined" is the only
    // thing a slug-less banner could say.
    routes["/api/query/save"] = {};

    await clickSave();

    expect(savedBanner()).toBeNull();
    // And it is not reported as a failure either: the route answered 200, so
    // an error alert here would be a claim about a write that may well have
    // landed.
    expect(
      screen.queryByText(unconfirmedWriteMessage("save the answer")),
    ).toBeNull();
  });

  it("says the outcome is unknown when the connection drops mid-save", async () => {
    await openThread();
    routes["/api/query/save"] = TRANSPORT_FAILURE;

    await clickSave();

    // THE UNCONFIRMED SENTENCE, not `Couldn’t save the answer.` — the request
    // left and no verdict came back, so the page may exist in the wiki. This
    // surface has nothing to refetch, which is exactly why the wording has to
    // send the owner to look rather than to press the button again.
    expect(screen.getByText(unconfirmedWriteMessage("save the answer"))).toBeTruthy();
    expect(savedBanner()).toBeNull();
  });
});


describe("DW-777 save retry feedback", () => {
  it("clears a prior unconfirmed error when the next save succeeds", async () => {
    await openThread();
    routes["/api/query/save"] = TRANSPORT_FAILURE;
    await clickSave();
    expect(screen.getByText(unconfirmedWriteMessage("save the answer"))).toBeTruthy();
    routes["/api/query/save"] = { slug: "queries/recovered" };
    await clickSave();
    expect(savedBanner()).not.toBeNull();
    expect(screen.queryByText(unconfirmedWriteMessage("save the answer"))).toBeNull();
  });
});
