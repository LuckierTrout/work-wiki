import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SiteChrome } from "@/components/SiteChrome";
import { PrivateWorkspaceNotice } from "@/components/PrivateWorkspaceNotice";

/**
 * The single-`main` rule, MOUNTED.
 *
 * `src/lib/__tests__/single-main-landmark-scan.test.ts` scans source so no file
 * can reintroduce an inner `<main>`; this asserts the thing that scan is a proxy
 * for — that a real owner-only surface composed inside `SiteChrome` puts exactly
 * ONE `main` landmark in the document (WCAG 2.2 AA), and that the demoted
 * wrapper still carries the classes and padding it had as a `<main>`.
 *
 * `PrivateWorkspaceNotice` is the surface under test because it is the
 * signed-out branch of all nine owner-only pages, so it is the one wrapper that
 * a duplicate landmark would reach on every route at once.
 *
 * Landmarks are counted on `document`, not on the render `container`: a `<main>`
 * reaching the DOM through a portal (a modal, a sheet) is outside the container
 * subtree but is still a second landmark in the accessibility tree, and
 * counting the container would call that a pass.
 */

let pathname = "/chat";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

// The notice's only Clerk dependency is the modal trigger. Rendering its child
// through is enough for the landmark question and keeps the test off Clerk's
// provider, which a `<main>` count has no business needing.
vi.mock("@clerk/nextjs", () => ({
  SignInButton: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

afterEach(() => {
  cleanup();
  pathname = "/chat";
});

function renderNotice() {
  return render(
    <SiteChrome nav={<nav aria-label="Site" />} footer={<footer />}>
      <PrivateWorkspaceNotice heading="Chat" action="Sign in to chat" />
    </SiteChrome>,
  );
}

/**
 * Every `main` landmark in the document, portals included.
 *
 * `[role="main"]` is counted alongside the tag because the accessibility tree
 * makes no distinction between them: a `<div role="main">` is a second landmark
 * that `querySelectorAll("main")` alone reports as zero, so the count would
 * read as a pass while a screen reader sees the duplicate.
 */
function landmarks() {
  return document.querySelectorAll('main, [role="main"]');
}

describe("one main landmark per rendered document", () => {
  it("puts exactly one <main> on a nav route, and it is SiteChrome's", () => {
    renderNotice();
    expect(landmarks()).toHaveLength(1);
    expect(landmarks()[0].id).toBe("main-content");
  });

  it("puts exactly one <main> on the chrome-less Workbench route too", () => {
    // `/` takes SiteChrome's `bare` branch, which renders its own `<main>`. A
    // notice nested under it would double up there as well.
    pathname = "/";
    renderNotice();
    expect(landmarks()).toHaveLength(1);
    expect(landmarks()[0].id).toBe("main-content");
  });

  it("puts exactly one <main> on /sign-in, the other bare route", () => {
    // `bare` is `/` OR a `/sign-in` prefix, and the two reach it by different
    // conditions — so covering only `/` leaves half the branch unobserved.
    pathname = "/sign-in/factor-one";
    renderNotice();
    expect(landmarks()).toHaveLength(1);
    expect(landmarks()[0].id).toBe("main-content");
  });

  it("keeps the notice's classes and padding on the demoted wrapper", () => {
    renderNotice();
    // Read from the `<h1>` outward: the wrapper is the element the notice
    // actually rendered, not one this test located by class and then asserted
    // the class of.
    const wrapper = screen.getByRole("heading", { level: 1 }).parentElement;
    expect(wrapper?.tagName).toBe("DIV");
    expect(wrapper?.className).toBe("shell fade");
    expect(wrapper?.style.paddingTop).toBe("120px");
    expect(wrapper?.style.paddingBottom).toBe("120px");
    expect(wrapper?.style.textAlign).toBe("center");
    // And it is inside the landmark rather than replacing it.
    expect(wrapper?.closest("main")?.id).toBe("main-content");
  });

  it("still offers the skip link that the landmark is the target of", () => {
    const { container } = renderNotice();
    const skip = container.querySelector("a.skip-nav");
    expect(skip?.getAttribute("href")).toBe("#main-content");
  });

  it("points the skip link past the rail on the Workbench route", () => {
    // On `/` the shell sits INSIDE the landmark with twelve rail controls ahead
    // of the content, so `#main-content` would skip nothing; the canvas is the
    // real bypass target. Losing this is an accessibility regression that the
    // landmark count alone cannot see.
    pathname = "/";
    const { container } = renderNotice();
    const skip = container.querySelector("a.skip-nav");
    expect(skip?.getAttribute("href")).toBe("#wb-canvas");
  });
});
