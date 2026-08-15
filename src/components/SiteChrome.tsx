"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

/**
 * Wraps the app's global chrome (nav + footer) so it can be hidden on
 * chrome-less routes — `/sign-in`, which supplies its own layout, and `/`,
 * which is the Workbench: a full-bleed, full-height shell whose 48px icon rail
 * IS the navigation. Stacking a sticky link-row nav and a footer above and
 * below it would restate the information architecture the rail replaces, and
 * the centred 1180px `.shell` cannot hold a full-bleed grid.
 *
 * The nav/footer are passed in as nodes (rendered on the server) so a client
 * component can conditionally render them without importing them.
 *
 * This is a per-route chrome opt-out, not a second IA: there is deliberately no
 * device-specific alternate navigation, and every viewport gets the same route
 * tree (Epic 1, AC3).
 */
export function SiteChrome({
  nav,
  footer,
  children,
}: {
  nav: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  // `/` is matched exactly — `startsWith` would strip the chrome off the whole
  // app.
  const workbench = pathname === "/";
  const bare = workbench || Boolean(pathname?.startsWith("/sign-in"));

  // On `/` the shell — rail first — is INSIDE <main>, so `#main-content` lands
  // ahead of the twelve rail controls and skips nothing. The Workbench canvas
  // is where the content actually starts, so that is what the bypass targets.
  const skipTarget = workbench ? "#wb-canvas" : "#main-content";

  if (bare) {
    return (
      <>
        {/* Bare does not mean bypass-less. `/` puts twelve rail controls ahead
            of the canvas, so the skip link matters MORE here than on a route
            with the site nav, not less (WCAG 2.4.1). */}
        <a href={skipTarget} className="skip-nav">
          Skip to main content
        </a>
        <main id="main-content" className="flex-1">
          {children}
        </main>
      </>
    );
  }

  return (
    <>
      <a href="#main-content" className="skip-nav">
        Skip to main content
      </a>
      {nav}
      <main id="main-content" className="flex-1">
        {children}
      </main>
      {footer}
    </>
  );
}
