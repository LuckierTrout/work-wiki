import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import RootLayout from "@/app/layout";
import { NavHeader } from "@/components/NavHeader";
import { ClerkProvider, useUser } from "@clerk/nextjs";
import { useToast } from "@/hooks/useToast";
import { useShortcutsHelp } from "@/hooks/useKeyboardShortcuts";

/**
 * The APP SHELL, mounted (DW-118).
 *
 * Nothing else in the suite imports `src/app/layout.tsx` or `NavHeader`, so
 * deleting `<ClerkProvider>` or `<ClientProviders>` — the two wrappers every
 * route in the app depends on — kept `tsc`, `eslint` and the whole Vitest run
 * green; only `readFile` scans ever looked at the shell, and a scan cannot see
 * whether a wrapper still WRAPS anything.
 *
 * The lever is the probe child. It calls `useToast()`, `useShortcutsHelp()`
 * and Clerk's `useUser()` — three hooks that THROW outside their providers —
 * and it reaches them only through the layout's own nesting, so a deleted
 * wrapper is a thrown render rather than a subtly different tree.
 *
 * The Clerk mock therefore keeps `<ClerkProvider>` LOAD-BEARING: a passthrough
 * stub would let `useUser` answer from anywhere and silently void the whole
 * point of this file. `EnsureYoyo` and `NavHeader` call `useUser` too, so the
 * throw covers the layout even without the probe.
 */

// ---------------------------------------------------------------------------
// Module boundaries
// ---------------------------------------------------------------------------

const nav = vi.hoisted(() => ({
  pathname: "/chat",
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() },
}));

/**
 * The auth answer `useUser` gives INSIDE the provider. Moved per test rather
 * than re-mocked, so signed-out / member / owner are three states of one mock.
 */
const auth = vi.hoisted(() => ({
  state: {
    isLoaded: true,
    isSignedIn: false,
    user: null as { username: string | null } | null,
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => nav.router,
  // `Analytics` reads this; it is `null`-guarded there, but handing back a real
  // (empty) params object is what the App Router does inside a Suspense
  // boundary, and the `qs` branch is only reachable with one.
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * `next/font/google` runs a build-time loader that has no jsdom equivalent. The
 * shape is what `layout.tsx` consumes: it interpolates `.variable` into the
 * `<html>` className.
 */
vi.mock("next/font/google", () => {
  const loader = (variable: string) => () => ({
    variable,
    className: variable.replace(/^--/, "font-"),
    style: { fontFamily: variable },
  });
  return {
    Inter: loader("--font-sans-next"),
    Source_Serif_4: loader("--font-serif-next"),
    JetBrains_Mono: loader("--font-mono-next"),
  };
});

/**
 * `Analytics` really imports and inits posthog-js, and its scroll manager
 * installs timers that outlive the environment — a torn-down jsdom then throws
 * from a stranded callback, which surfaces as an unhandled error on an
 * unrelated suite.
 */
vi.mock("posthog-js", () => ({
  default: { init: vi.fn(), capture: vi.fn() },
}));

/**
 * Clerk, with `<ClerkProvider>` kept load-bearing.
 *
 * `useUser` throws outside the provider, the way the real one does, so a layout
 * that stopped wrapping its tree fails here instead of rendering a
 * signed-out-looking shell. The context lives inside the factory because
 * `vi.mock` is hoisted above every import in this file.
 */
vi.mock("@clerk/nextjs", async () => {
  const React = await import("react");
  const InsideProvider = React.createContext(false);

  // Named as a hook so the linter reads the `useContext` below correctly: it IS
  // one, called from `useUser` and from `Show`'s render.
  function useInsideProvider(hook: string): void {
    if (!React.useContext(InsideProvider)) {
      throw new Error(`${hook} was called outside <ClerkProvider>`);
    }
  }

  function UserButton({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
  }
  // The owner menu is where the workspace / Settings / Wiki Health links live,
  // so these render as REAL anchors — the link set is the thing under test.
  UserButton.MenuItems = function MenuItems({
    children,
  }: {
    children?: React.ReactNode;
  }) {
    return <>{children}</>;
  };
  UserButton.Link = function MenuLink({
    label,
    href,
  }: {
    label: string;
    href: string;
  }) {
    return <a href={href}>{label}</a>;
  };

  return {
    ClerkProvider: ({ children }: { children?: React.ReactNode }) => (
      <InsideProvider.Provider value={true}>{children}</InsideProvider.Provider>
    ),
    useUser: () => {
      useInsideProvider("useUser");
      return auth.state;
    },
    Show: ({ when, children }: { when: string; children?: React.ReactNode }) => {
      useInsideProvider("Show");
      const showing = auth.state.isSignedIn ? "signed-in" : "signed-out";
      return when === showing ? <>{children}</> : null;
    },
    SignInButton: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    UserButton,
  };
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const OWNER = "site-owner";
let savedOwner: string | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
let swRegister: ReturnType<typeof vi.fn>;

/**
 * The child the layout hands down. Every hook here throws outside its provider,
 * so this renders at all ONLY when Clerk and the client providers are both
 * still wrapping the tree.
 */
function Probe() {
  useToast();
  useShortcutsHelp();
  useUser();
  return <p>probe reached the page</p>;
}

function signedOut() {
  auth.state = { isLoaded: true, isSignedIn: false, user: null };
}

function signedInAs(username: string) {
  auth.state = { isLoaded: true, isSignedIn: true, user: { username } };
}

/** Every `main` landmark in the document — portals included. */
function landmarks() {
  return document.querySelectorAll('main, [role="main"]');
}

function linkNames(): string[] {
  return screen.getAllByRole("link").map((link) => link.textContent?.trim() ?? "");
}

beforeEach(() => {
  savedOwner = process.env.NEXT_PUBLIC_OWNER_HANDLE;
  // `isOwnerHandle` reads the env var per call, and CI is the only place it is
  // set — so the owner branch would silently never render locally.
  process.env.NEXT_PUBLIC_OWNER_HANDLE = OWNER;
  nav.pathname = "/chat";
  signedOut();
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as unknown as Response);
  vi.stubGlobal("fetch", fetchMock);
  // jsdom ships NO `navigator.serviceWorker`, so `RegisterSW` returns on its
  // capability guard and the registration could never be observed. The shim
  // lives here rather than in `vitest.setup.dom.ts` because this is the only
  // suite that mounts the component, and rather than in `src/` because
  // reshaping the component to stop asking the platform would pin something
  // else. Defined on the instance so `afterEach` can take it back off.
  swRegister = vi.fn(() => Promise.resolve({} as ServiceWorkerRegistration));
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register: swRegister },
  });
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's `cleanup()` lands after this one. Unmount while `fetch` is
  // still stubbed and the env var still holds.
  cleanup();
  vi.unstubAllGlobals();
  if (savedOwner === undefined) delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
  else process.env.NEXT_PUBLIC_OWNER_HANDLE = savedOwner;
  // The shell hoists onto the REAL document, but nothing has to be swept up
  // after it: `cleanup()` unmounts the root and React takes back everything it
  // put there — verified by reading `lang`, both className values and
  // `document.head` from a LATER test in this same file, all of which come back
  // empty. (Files cannot see each other's document in any case; vitest gives
  // each one its own jsdom.) A manual reset here would be dead code that reads
  // like a guard.
  Reflect.deleteProperty(navigator, "serviceWorker");
});

// ---------------------------------------------------------------------------
// The layout
// ---------------------------------------------------------------------------

describe("RootLayout, mounted", () => {
  /**
   * `RootLayout` is a SYNC server component: calling it returns the element,
   * and rendering that element is the whole mount. React hoists the
   * `<html>`/`<head>`/`<body>` it returns onto the real document, which is why
   * the assertions below read `document.documentElement` rather than the render
   * container. (One `In HTML, <html> cannot be a child of <div>` nesting
   * message is logged as a result; it is expected and changes nothing.)
   */
  function mountLayout() {
    return render(RootLayout({ children: <Probe /> }));
  }

  it("puts the children on the page through Clerk and the client providers", () => {
    mountLayout();

    // The probe rendered, so `useToast`, `useShortcutsHelp` and `useUser` all
    // found their providers — i.e. `<ClerkProvider>` and `<ClientProviders>`
    // are both still wrapping `children`.
    expect(screen.getByText("probe reached the page")).toBeTruthy();
  });

  it("declares the document language on <html>", () => {
    mountLayout();
    // The one attribute every assistive technology reads before anything else
    // (WCAG 3.1.1), and the one this shell is the only source of.
    expect(document.documentElement.lang).toBe("en");
  });

  it("puts exactly one main landmark on the page, and it is SiteChrome's", () => {
    mountLayout();
    expect(landmarks()).toHaveLength(1);
    expect(landmarks()[0].id).toBe("main-content");
    // …and the children are INSIDE it, not beside it.
    expect(screen.getByText("probe reached the page").closest("main")?.id).toBe(
      "main-content",
    );
  });

  it("still renders one main landmark on the chrome-less Workbench route", () => {
    // `/` takes `SiteChrome`'s bare branch — a different subtree, same shell.
    nav.pathname = "/";
    mountLayout();
    expect(landmarks()).toHaveLength(1);
    expect(screen.getByText("probe reached the page")).toBeTruthy();
  });

  it("carries the font variables onto <html> so the CSS tokens resolve", () => {
    mountLayout();
    // `globals.css` reads `--font-sans-next` et al. from the root element; the
    // layout is the only place they are applied, and losing one silently drops
    // the app to a fallback face.
    const className = document.documentElement.className;
    expect(className).toContain("--font-sans-next");
    expect(className).toContain("--font-serif-next");
    expect(className).toContain("--font-mono-next");
  });

  it("mounts the nav and the footer on a chrome-carrying route", () => {
    mountLayout();
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeTruthy();
    expect(document.querySelector("footer")).toBeTruthy();
  });

  it("provisions the signed-in user's yoyo from the shell", () => {
    signedInAs(OWNER);
    mountLayout();

    // `EnsureYoyo` renders nothing, so the ONLY evidence it is still mounted is
    // the request it issues. Every user is auto-provisioned by design — there
    // is no button anywhere else in the app that would do this instead.
    expect(fetchMock).toHaveBeenCalledWith("/api/agents/ensure", { method: "POST" });
  });

  it("asks for nothing on behalf of a signed-out visitor", () => {
    mountLayout();
    // The other half of the same gate: provisioning a yoyo for nobody would be
    // a request the server has to reject on every anonymous page view.
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/agents/ensure",
      expect.anything(),
    );
  });

  it("registers the service worker from the shell", () => {
    mountLayout();

    // `RegisterSW` also renders nothing. Losing it costs the PWA install and
    // the Web Share Target with no visible symptom anywhere in the UI.
    expect(swRegister).toHaveBeenCalledWith("/sw.js");
  });
});

// ---------------------------------------------------------------------------
// The nav
// ---------------------------------------------------------------------------

/**
 * `NavHeader` is mounted on its own — inside the Clerk provider, because that
 * is the only environment in which the real one renders either.
 */
function mountNav() {
  return render(
    <ClerkProvider>
      <NavHeader />
    </ClerkProvider>,
  );
}

/**
 * Open the hamburger panel.
 *
 * It is not a responsive restyling of the bar above it — it is a SECOND render
 * of the primary links and its own copy of the `isOwner &&` gate on Settings
 * and Wiki Health. Everything asserted about the desktop menu therefore has to
 * be asserted here too, or half the owner gate is unobserved.
 */
function openMobileMenu() {
  // `fireEvent`, not `element.click()`: a raw DOM click fires outside React's
  // event system, so the state update it causes is unbatched and warns.
  fireEvent.click(screen.getByRole("button", { name: "Toggle navigation menu" }));
}

const PRIMARY = ["Ask", "Chat", "Ingest", "Save", "To-do"];
const WORKSPACE = [
  "Knowledge Studio",
  "Vaults",
  "Agents",
  "Review",
  "Sources",
  "Knowledge",
  "Integrations",
  "System",
];

describe("NavHeader", () => {
  it("offers the primary links and a way in, signed out", () => {
    mountNav();

    for (const label of PRIMARY) {
      expect(screen.getAllByRole("link", { name: label }).length).toBeGreaterThan(0);
    }
    // Owner-only deployment: signing in is the only entry point.
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("offers no workspace or owner links at all while signed out", () => {
    mountNav();

    const names = linkNames();
    for (const label of [...WORKSPACE, "Settings", "Wiki Health"]) {
      expect(names).not.toContain(label);
    }
  });

  it("opens the workspace to a signed-in member, but not the owner tools", () => {
    signedInAs("someone-else");
    mountNav();

    for (const label of WORKSPACE) {
      expect(screen.getByRole("link", { name: label })).toBeTruthy();
    }
    // The client gate is UX (the server gate is the real boundary), but a
    // member seeing Settings and Wiki Health is still a wrong menu.
    const names = linkNames();
    expect(names).not.toContain("Settings");
    expect(names).not.toContain("Wiki Health");
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("adds Settings and Wiki Health for the site owner", () => {
    signedInAs(OWNER);
    mountNav();

    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe(
      "/settings",
    );
    expect(screen.getByRole("link", { name: "Wiki Health" }).getAttribute("href")).toBe(
      "/lint",
    );
  });

  it("treats the owner handle case-insensitively", () => {
    // `isOwnerHandle` lowercases both sides, so an owner whose Clerk username
    // differs in case is still the owner — one silo, not two.
    signedInAs(OWNER.toUpperCase());
    mountNav();

    expect(screen.getByRole("link", { name: "Settings" })).toBeTruthy();
  });

  it("marks the primary link for the route the reader is on", () => {
    nav.pathname = "/ingest/history";
    mountNav();

    // `getActiveHref` matches a route AND its children, so a nested ingest URL
    // still lights the Ingest link.
    const active = screen
      .getAllByRole("link", { name: "Ingest" })
      .find((link) => link.style.fontWeight === "600");
    expect(active).toBeTruthy();

    const chat = screen
      .getAllByRole("link", { name: "Chat" })
      .find((link) => link.style.fontWeight === "600");
    expect(chat).toBeUndefined();
  });

  it("marks nothing when the reader is on a route outside the primary set", () => {
    nav.pathname = "/studio";
    mountNav();

    for (const label of PRIMARY) {
      for (const link of screen.getAllByRole("link", { name: label })) {
        expect(link.style.fontWeight).not.toBe("600");
      }
    }
  });

  it("opens the owner tools nowhere when a signed-in user has no username", () => {
    // Clerk usernames are optional, so `user.username` is legitimately `null`
    // for a signed-in account. `isOwnerHandle(null)` is `false` — but a gate
    // rewritten as a truthiness check on `user` alone would open Settings and
    // Wiki Health to every signed-in visitor.
    auth.state = { isLoaded: true, isSignedIn: true, user: { username: null } };
    mountNav();
    openMobileMenu();

    const names = linkNames();
    expect(names).not.toContain("Settings");
    expect(names).not.toContain("Wiki Health");
  });

  describe("the hamburger panel", () => {
    it("renders a second copy of the primary links once opened", () => {
      mountNav();
      for (const label of PRIMARY) {
        expect(screen.getAllByRole("link", { name: label })).toHaveLength(1);
      }

      openMobileMenu();

      // The narrow-width route tree is the SAME tree (Epic 1, AC3): every
      // primary link is reachable here too, not a reduced subset.
      for (const label of PRIMARY) {
        expect(screen.getAllByRole("link", { name: label })).toHaveLength(2);
      }
    });

    it("carries the way in, signed out — and nothing owner-only", () => {
      mountNav();
      openMobileMenu();

      // Auth is hidden below xl in the bar, so the panel is the ONLY sign-in
      // affordance a narrow viewport has.
      expect(screen.getAllByRole("button", { name: "Sign in" }).length).toBeGreaterThan(1);
      const names = linkNames();
      for (const label of ["Studio", "Settings", "Wiki Health"]) {
        expect(names).not.toContain(label);
      }
    });

    it("opens the workspace to a signed-in member, but not the owner tools", () => {
      signedInAs("someone-else");
      mountNav();
      openMobileMenu();

      // `Studio` is the panel's own label for the workspace (the user menu
      // spells the same route "Knowledge Studio"), so finding it proves the
      // panel's list rendered rather than the desktop menu's.
      expect(screen.getByRole("link", { name: "Studio" })).toBeTruthy();
      const names = linkNames();
      expect(names).not.toContain("Settings");
      expect(names).not.toContain("Wiki Health");
    });

    it("adds Settings and Wiki Health for the site owner", () => {
      signedInAs(OWNER);
      mountNav();
      openMobileMenu();

      // Two copies each: the user menu's and the panel's — two independent
      // `isOwner &&` gates, both of which have to hold.
      for (const label of ["Settings", "Wiki Health"]) {
        expect(screen.getAllByRole("link", { name: label })).toHaveLength(2);
      }
    });
  });
});
