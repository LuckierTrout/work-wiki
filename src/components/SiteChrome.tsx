"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

/**
 * Wraps the app's global chrome (nav + footer) so it can be hidden on
 * chrome-less routes — today only `/sign-in`, which supplies its own layout.
 * The nav/footer are passed in as nodes (rendered on the server) so a client
 * component can conditionally render them without importing them.
 *
 * There is deliberately no device-specific alternate navigation: every viewport
 * gets the same information architecture (Epic 1, AC3).
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
  const bare = Boolean(pathname?.startsWith("/sign-in"));

  if (bare) {
    return (
      <main id="main-content" className="flex-1">
        {children}
      </main>
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
