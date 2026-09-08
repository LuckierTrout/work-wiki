import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useViewerHandle } from "@/lib/viewer-handle";
import { E2eViewerIdentityProvider } from "@/components/E2eViewerIdentityProvider";

/**
 * `useViewerHandle()` under the E2E seam (DW-534), MOUNTED.
 *
 * The bug was invisible to every source scan in the repo: the hook read Clerk,
 * which is exactly what it is supposed to do on a live request, and under the
 * armed harness the root layout renders no `<ClerkProvider>` at all. So the hook
 * answered SIGNED OUT for the very owner `middleware.ts` admits, and Delete,
 * Re-ingest, Graphify and Revert all failed closed for the only viewer the E2E
 * lane has. Nothing but a mount can see which of the two sources answered.
 *
 * `useUser` is therefore mocked to THROW by default, the way the real one does
 * outside its provider. That turns "never reads Clerk when armed" into an
 * observable fact rather than an assumption: a hook that fell through to Clerk
 * on the injected path would fail here with a thrown render, not with a subtly
 * different handle. The call counter backs it up from the other side.
 *
 * The three rows are the spec's hook matrix: injected owner, injected but
 * signed out, and no injection at all (production, and every existing island
 * suite) — where the Clerk read must still be byte-for-byte what it was,
 * X/Twitter fallback included.
 */

const clerk = vi.hoisted(() => ({
  calls: 0,
  /** `null` means "no `<ClerkProvider>` in this tree", so `useUser` throws. */
  session: null as {
    isLoaded: boolean;
    isSignedIn: boolean;
    user: {
      username?: string | null;
      externalAccounts?: { provider?: string; username?: string | null }[];
    } | null;
  } | null,
}));

vi.mock("@clerk/nextjs", () => ({
  useUser: () => {
    clerk.calls += 1;
    if (!clerk.session) {
      throw new Error("useUser was called outside <ClerkProvider>");
    }
    return clerk.session;
  },
}));

/** Renders the hook's whole answer, so a row can assert all three fields. */
function Probe() {
  const { isLoaded, isSignedIn, handle } = useViewerHandle();
  return (
    <p data-testid="viewer">{`${isLoaded}|${isSignedIn}|${handle ?? "null"}`}</p>
  );
}

function viewer(): string {
  return screen.getByTestId("viewer").textContent ?? "";
}

beforeEach(() => {
  clerk.calls = 0;
  clerk.session = null;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useViewerHandle under the armed E2E harness (DW-534)", () => {
  it("reports the injected owner, lowercased, without consulting Clerk", () => {
    // The mixed case is deliberate: consumers compare against server-stored
    // handles, which are lowercased on write, so the injected path has to
    // normalize exactly as the Clerk path does.
    render(
      <E2eViewerIdentityProvider handle="E2E-Owner">
        <Probe />
      </E2eViewerIdentityProvider>,
    );
    expect(viewer()).toBe("true|true|e2e-owner");
    expect(
      clerk.calls,
      "The armed path has no <ClerkProvider>; a Clerk read there is a thrown " +
        "render on every page the harness drives.",
    ).toBe(0);
  });

  it("reports SIGNED OUT for an armed request with no valid cookie — never the owner", () => {
    // The client gate may be narrower than the server's answer, never wider.
    // An armed server whose request carries no (or an invalid) `yopedia_e2e`
    // cookie answers anonymous, so the hook must too. `clerk.session` is still
    // null, so a fall-through to Clerk would throw rather than quietly
    // returning a signed-out answer that happens to look the same.
    render(
      <E2eViewerIdentityProvider handle={null}>
        <Probe />
      </E2eViewerIdentityProvider>,
    );
    expect(viewer()).toBe("true|false|null");
    expect(clerk.calls).toBe(0);
  });

  it("still reads Clerk when nothing is injected", () => {
    clerk.session = {
      isLoaded: true,
      isSignedIn: true,
      user: { username: "Alice" },
    };
    render(<Probe />);
    expect(viewer()).toBe("true|true|alice");
    expect(clerk.calls).toBeGreaterThan(0);
  });

  it("keeps the X/Twitter fallback on the un-injected path", () => {
    // The branch no mounted island suite exercises, and the reason the rule
    // lives in one module at all — it must survive the E2E seam untouched.
    clerk.session = {
      isLoaded: true,
      isSignedIn: true,
      user: {
        username: null,
        externalAccounts: [
          { provider: "oauth_google", username: "ignored" },
          { provider: "oauth_x", username: "Bob" },
        ],
      },
    };
    render(<Probe />);
    expect(viewer()).toBe("true|true|bob");
  });

  it("propagates the un-injected Clerk failure, so the fallback is really Clerk", () => {
    // Without this the two rows above could both pass with the hook silently
    // answering signed-out from somewhere else. `clerk.session` is null, which
    // is this suite's stand-in for "rendered outside <ClerkProvider>".
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/outside <ClerkProvider>/);
    errors.mockRestore();
  });
});
