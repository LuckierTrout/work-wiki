import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { E2eViewerIdentity } from "@/components/E2eViewerIdentity";
import { useViewerHandle } from "@/lib/viewer-handle";
import { E2E_COOKIE_NAME, mintE2eCookie } from "@/lib/e2e-identity";

/**
 * The SERVER half of the E2E identity seam (DW-534).
 *
 * `E2eViewerIdentity` is the only thing that turns the `yopedia_e2e` cookie into
 * a client-visible viewer, and it is the only place the harness is allowed to
 * decide who that viewer is. Two things have to hold and neither is visible to a
 * source scan: the answer must come from the SAME verifier the server gates on
 * (`principalFromCookieValue` — HMAC, plus `userId === YOPEDIA_OWNER_USER_ID`),
 * and every way of not having a valid cookie must fail CLOSED. A component that
 * defaulted to the configured owner handle whenever the cookie was missing would
 * look correct in the happy row and hand every client gate the owner on an
 * anonymous request — a client gate WIDER than the server's, which is the one
 * direction that is never acceptable.
 *
 * So each row runs the real component against a real minted cookie and reads the
 * answer through `useViewerHandle()` in a mounted child — the same hook the
 * islands call. `@clerk/nextjs` is mocked to THROW, because on this path there
 * is no `<ClerkProvider>`: any row that leaked through to Clerk fails loudly
 * instead of returning a signed-out answer that looks like a correct refusal.
 */

const OWNER_ID = "user_2e2eOwnerIdForTests";
const OWNER_HANDLE = "E2E-Owner";
const SECRET = "e2e-secret-that-is-long-enough-32+chars";

const jar = vi.hoisted(() => ({
  /** The `yopedia_e2e` cookie on the request, or `undefined` for none. */
  value: undefined as string | undefined,
  /** Whether `cookies()` itself throws — a non-request scope. */
  unavailable: false,
  /** Whether `cookies()` throws one of NEXT'S OWN control-flow errors. */
  controlFlow: false,
  reads: 0,
}));

vi.mock("next/headers", () => ({
  cookies: async () => {
    jar.reads += 1;
    if (jar.controlFlow) {
      // A real Next control-flow throw, minted by Next itself rather than
      // hand-shaped, so `unstable_rethrow` is exercised against the article it
      // actually recognises. `cookies()` throws one of these for real when a
      // statically-probed route reads it.
      const { notFound } = await import("next/navigation");
      notFound();
    }
    if (jar.unavailable) throw new Error("cookies() was called outside a request");
    return {
      get: (name: string) =>
        name === E2E_COOKIE_NAME && jar.value !== undefined
          ? { name, value: jar.value }
          : undefined,
    };
  },
}));

vi.mock("@clerk/nextjs", () => ({
  useUser: () => {
    throw new Error("useUser was called outside <ClerkProvider>");
  },
}));

const ENV_KEYS = [
  "YOPEDIA_E2E",
  "YOPEDIA_E2E_SECRET",
  "YOPEDIA_OWNER_USER_ID",
  "NEXT_PUBLIC_OWNER_HANDLE",
  "YOPEDIA_SITE_URL",
] as const;

let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function Probe() {
  const { isLoaded, isSignedIn, handle } = useViewerHandle();
  return (
    <p data-testid="viewer">{`${isLoaded}|${isSignedIn}|${handle ?? "null"}`}</p>
  );
}

/** Render the async server component the way React does: await, then mount. */
async function mount(): Promise<string> {
  const element = await E2eViewerIdentity({ children: <Probe /> });
  render(element);
  return screen.getByTestId("viewer").textContent ?? "";
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.YOPEDIA_E2E = "1";
  process.env.YOPEDIA_E2E_SECRET = SECRET;
  process.env.YOPEDIA_OWNER_USER_ID = OWNER_ID;
  process.env.NEXT_PUBLIC_OWNER_HANDLE = OWNER_HANDLE;
  // `isE2eIdentityArmed` refuses to arm on the production origin.
  process.env.YOPEDIA_SITE_URL = "";
  jar.value = undefined;
  jar.unavailable = false;
  jar.controlFlow = false;
  jar.reads = 0;
});

afterEach(() => {
  cleanup();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("E2eViewerIdentity resolves the E2E viewer on the server (DW-534)", () => {
  it("publishes the owner handle, lowercased, for a valid cookie", async () => {
    jar.value = await mintE2eCookie(OWNER_ID, SECRET);
    expect(await mount()).toBe("true|true|e2e-owner");
    expect(
      jar.reads,
      "The identity must come from the request's own cookie jar, not from an " +
        "env read that would answer the same for an anonymous request.",
    ).toBeGreaterThan(0);
  });

  it("publishes a signed-out viewer when the request carries no cookie", async () => {
    expect(await mount()).toBe("true|false|null");
  });

  it("refuses a cookie whose HMAC does not verify", async () => {
    const minted = await mintE2eCookie(OWNER_ID, SECRET);
    // Flip the last signature nibble — same shape, wrong signature.
    const last = minted.slice(-1);
    jar.value = minted.slice(0, -1) + (last === "0" ? "1" : "0");
    expect(await mount()).toBe("true|false|null");
  });

  it("refuses a correctly signed cookie that names someone other than the owner", async () => {
    // The signature verifies; the user id does not match
    // `YOPEDIA_OWNER_USER_ID`. This is the case a signature-only check would
    // wave through, and it is exactly what `principalFromCookieValue` exists to
    // refuse — the client must not admit a viewer middleware would turn away.
    jar.value = await mintE2eCookie("user_someoneElseEntirely", SECRET);
    expect(await mount()).toBe("true|false|null");
  });

  it("refuses a malformed cookie value", async () => {
    jar.value = "not-a-v1-cookie";
    expect(await mount()).toBe("true|false|null");
  });

  it("fails closed when there is no request cookie store at all", async () => {
    jar.unavailable = true;
    expect(await mount()).toBe("true|false|null");
  });

  it("re-throws Next's own control-flow errors instead of reading them as 'no cookie'", async () => {
    // The catch above must be as narrow as its comment. Absorbing the
    // dynamic-rendering bailout would mislabel a normal framework event as a
    // missing cookie AND stop Next seeing the route as dynamic — and the
    // resulting signed-out viewer is indistinguishable from DW-534 itself.
    jar.controlFlow = true;
    await expect(E2eViewerIdentity({ children: <Probe /> })).rejects.toThrow();
    // Every other row answers signed-out; this one must not have.
    expect(screen.queryByTestId("viewer")).toBeNull();
  });

  it("fails closed when the harness is not armed, even with a valid cookie", async () => {
    // Belt and braces on top of `principalFromCookieValue`'s own arming check:
    // this component is what a stray render outside the harness would reach.
    jar.value = await mintE2eCookie(OWNER_ID, SECRET);
    delete process.env.YOPEDIA_E2E;
    expect(await mount()).toBe("true|false|null");
  });
});

/**
 * What a mount cannot see: WHERE the provider is mounted.
 *
 * Every row above would pass unchanged if `src/app/layout.tsx` wrapped the Clerk
 * branch too (double-providing the identity on live requests, where the context
 * would then win over the real session), or if it stopped wrapping the armed
 * branch at all (back to DW-534). The seam is three lines of JSX in a file no
 * mounted suite renders on the armed branch, so it is pinned as text.
 */
describe("the root layout wraps ONLY the armed branch", () => {
  const APP = path.resolve(__dirname, "../../app");
  const COMPONENTS = path.resolve(__dirname, "..");

  it("keeps <ClerkProvider> on the live branch and <E2eViewerIdentity> on the other", async () => {
    const layout = await readFile(path.join(APP, "layout.tsx"), "utf8");
    expect(layout).toContain(
      'import { E2eViewerIdentity } from "@/components/E2eViewerIdentity";',
    );
    // The whole ternary, so "wraps the armed branch" and "still wraps the other
    // in Clerk" are one assertion rather than two independently satisfiable
    // `toContain`s.
    expect(layout).toMatch(
      /return e2e \? \(\s*<E2eViewerIdentity>\{shell\}<\/E2eViewerIdentity>\s*\) : \(\s*<ClerkProvider/,
    );
    // `AppProviders` and `RootLayout` stay SYNC: `app-shell.test.tsx` mounts
    // `RootLayout({children})` by calling it directly, and an async one would
    // hand it a promise instead of an element.
    expect(layout).toContain("function AppProviders({");
    expect(layout).not.toMatch(/async function AppProviders/);
    expect(layout).toContain("async function RootLayout");
    // The harness stays out of production render paths: the layout itself never
    // reads cookies.
    expect(layout).not.toContain("next/headers");
  });

  it("loads next/headers only inside the component that runs on the armed path", async () => {
    const source = await readFile(path.join(COMPONENTS, "E2eViewerIdentity.tsx"), "utf8");
    // A STATIC import would put a request-scoped API into the module graph of
    // every render, armed or not, because `layout.tsx` imports this file
    // unconditionally.
    expect(source).not.toMatch(/^import .*"next\/headers"/m);
    expect(source).toContain('await import("next/headers")');
    // And the verification is the shared one, never a second HMAC check.
    expect(source).toContain(
      'import { E2E_COOKIE_NAME, principalFromCookieValue } from "@/lib/e2e-identity";',
    );
  });
});
