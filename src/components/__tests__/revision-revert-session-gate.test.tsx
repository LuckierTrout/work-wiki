import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  REVERT_READ_ONLY_COPY,
  RevisionHistory,
} from "@/components/RevisionHistory";

/**
 * The SESSION half of the Revert gate, mounted (DW-392).
 *
 * `canRevert` carried a realm term and a site-owner term and no signed-in term,
 * so on a page the realm does not restrict — the common case — `canRevert` was
 * `true` for every viewer, anonymous ones included. `POST /api/wiki/[slug]/
 * revisions {action:"revert"}` is a write, and the write-gate middleware 401s an
 * unauthenticated caller before the route's own authz ever runs, so the button
 * offered there could only ever fail: the reader answers "Revert this page to
 * the revision from …?" — a dialog that promises a rewrite — and learns the
 * deployment was never going to run it. That is the DW-149 harm, and the
 * DW-269 shape one term over.
 *
 * WHY MOUNTED RATHER THAN SCANNED. `src/lib/__tests__/article-actions-gate.test.ts`
 * pins the expression's text, which is what stops a well-meaning edit from
 * adding an ownership term. It cannot see what a viewer actually gets: that the
 * Restore control is gone, that View survived (reading an old revision is not a
 * write and is never refused), that the read-only sentence did not become an
 * orphaned paragraph, and that neither a `window.confirm` nor a request was
 * ever raised. Every assertion below is on that outermost surface.
 *
 * `realmDeniesRevert` is varied only in the last case: it is a server-computed
 * prop with its own suite (`article-actions-delete-gate.test.tsx` renders it
 * through `ArticleView`), and holding it at `false` everywhere else is what
 * makes "no Restore button" attributable to the session and nothing else.
 */

const { router } = vi.hoisted(() => ({
  router: { refresh: vi.fn(), push: vi.fn() },
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

/** The Clerk session each case drives — the only input under test. */
const clerk = vi.hoisted(() => ({
  current: { isLoaded: true, isSignedIn: false, user: null } as {
    isLoaded: boolean;
    isSignedIn: boolean;
    user: { username?: string | null } | null;
  },
}));
vi.mock("@clerk/nextjs", () => ({ useUser: () => clerk.current }));

const TIMESTAMP = 1_700_000_000_000;
const REVERT_LABEL = new RegExp(`^Restore revision from`);
const VIEW_LABEL = new RegExp(`^View revision from`);

let fetchMock: ReturnType<typeof vi.fn>;
let confirmMock: ReturnType<typeof vi.fn>;
let originalOwnerHandle: string | undefined;

beforeEach(() => {
  router.refresh.mockClear();
  router.push.mockClear();
  // `isOwnerHandle` reads this at call time. A value exported in a developer's
  // shell would make the signed-in viewer below the SITE owner and turn the
  // realm case green for the wrong reason — on that machine only.
  originalOwnerHandle = process.env.NEXT_PUBLIC_OWNER_HANDLE;
  delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
  clerk.current = { isLoaded: true, isSignedIn: false, user: null };
  fetchMock = vi.fn(
    async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          revisions: [
            {
              timestamp: TIMESTAMP,
              date: new Date(TIMESTAMP).toISOString(),
              slug: "alpha",
              sizeBytes: 2048,
              author: "yuanhao",
            },
          ],
        }),
      }) as unknown as Response,
  );
  // Defaults to ACCEPTING, so a missing gate shows up as a request rather than
  // as a dialog nobody answered.
  confirmMock = vi.fn(() => true);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("confirm", confirmMock);
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's `cleanup()` lands after this one. Unmounting here tears the
  // tree down while the globals are still stubbed.
  cleanup();
  vi.unstubAllGlobals();
  if (originalOwnerHandle === undefined) delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
  else process.env.NEXT_PUBLIC_OWNER_HANDLE = originalOwnerHandle;
});

/**
 * Mount the panel and expand it.
 *
 * The list is fetched on expand, so "no Restore button" only means anything
 * once a ROW exists that could have carried one — hence the wait on View, which
 * is never gated. Returns after the row is on screen.
 */
async function openHistory(props: { realmDeniesRevert?: boolean; readOnly?: boolean } = {}) {
  render(
    <RevisionHistory
      slug="alpha"
      realmDeniesRevert={props.realmDeniesRevert ?? false}
      readOnly={props.readOnly ?? false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /History/ }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: VIEW_LABEL })).toBeTruthy(),
  );
}

describe("Revert, and the viewer's session (DW-392)", () => {
  it("offers no Restore control to a signed-out viewer of a non-realm page", async () => {
    await openHistory();

    expect(screen.queryByRole("button", { name: REVERT_LABEL })).toBeNull();
    // View is NOT a write and must survive: hiding it would be a refusal the
    // server never answers, and the mirror of the bug being fixed.
    expect(screen.getByRole("button", { name: VIEW_LABEL })).toBeTruthy();

    // One call: the GET that loaded the list. Reading history stays open to
    // everyone, so the absence of the button is the whole change.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("renders no read-only note for a signed-out viewer — it would be orphaned", async () => {
    // The sentence explains a CONTROL, and `aria-describedby` on that control is
    // its only referrer. With Revert gone the paragraph would be a refusal shown
    // to a reader who was never offered the action, with a dangling id. The note
    // is gated on `canRevert`, so the new session term reaches it for free —
    // this is the assertion that keeps that true.
    await openHistory({ readOnly: true });

    expect(screen.queryByRole("button", { name: REVERT_LABEL })).toBeNull();
    expect(screen.queryByText(REVERT_READ_ONLY_COPY)).toBeNull();
    expect(screen.getByRole("button", { name: VIEW_LABEL })).toBeTruthy();
  });

  it("fails closed while the session is still loading", async () => {
    // Before Clerk resolves, `isSignedIn` is false for a viewer who will turn
    // out to be signed in. "We do not know yet" has to answer NO for a gate
    // whose permissive answer puts an irreversible-sounding dialog on screen;
    // once the session lands the button appears (the case below).
    clerk.current = { isLoaded: false, isSignedIn: false, user: null };
    await openHistory();

    expect(screen.queryByRole("button", { name: REVERT_LABEL })).toBeNull();
    expect(screen.getByRole("button", { name: VIEW_LABEL })).toBeTruthy();
  });

  it("fails closed for a SIGNED-IN viewer whose session has not resolved yet", async () => {
    // The case that makes `isLoaded` load-bearing HERE. The case above pairs
    // `isLoaded: false` with `isSignedIn: false`, so deleting `isLoaded &&` from
    // `canRevert` leaves it green — `isSignedIn` alone still hides the button,
    // and only the string pin in `article-actions-gate.test.ts` would catch the
    // regression. This row separates the two terms: `isSignedIn` is already
    // true, so the ONLY thing that can hide Restore is `isLoaded`.
    //
    // Why that matters beyond tidiness: mid-hydration Clerk can report a
    // resolved-looking session before the user object lands, and the permissive
    // answer here puts an irreversible-sounding confirm on screen. "We do not
    // know yet" has to mean no.
    clerk.current = { isLoaded: false, isSignedIn: true, user: null };
    await openHistory();

    expect(screen.queryByRole("button", { name: REVERT_LABEL })).toBeNull();
    expect(screen.getByRole("button", { name: VIEW_LABEL })).toBeTruthy();
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("still offers Restore to a signed-in non-owner on a non-realm page", async () => {
    // The BOUND on the three cases above: the session term must remove the
    // button for anonymous viewers and no one else. This viewer neither owns
    // the page nor is the site owner — the revert route gates on the realm and
    // the private-page ACL, never on page ownership, so they are exactly who
    // the server admits and the gate must not narrow past.
    clerk.current = { isLoaded: true, isSignedIn: true, user: { username: "someone-else" } };
    await openHistory();

    const button = screen.getByRole("button", { name: REVERT_LABEL });
    expect(button.hasAttribute("aria-disabled")).toBe(false);

    fireEvent.click(button);

    expect(confirmMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/wiki/alpha/revisions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      action: "revert",
      timestamp: TIMESTAMP,
    });
  });

  it("still hides Restore from a signed-in non-owner on a REALM page", async () => {
    // The realm term is unchanged by DW-392, and this is what says so: a session
    // is necessary, not sufficient. `POST …/revisions` re-authorizes with
    // `writeKind: "body"`, which the realm branch refuses for every non-admin.
    clerk.current = { isLoaded: true, isSignedIn: true, user: { username: "someone-else" } };
    await openHistory({ realmDeniesRevert: true });

    expect(screen.queryByRole("button", { name: REVERT_LABEL })).toBeNull();
    expect(screen.getByRole("button", { name: VIEW_LABEL })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(confirmMock).not.toHaveBeenCalled();
  });
});
