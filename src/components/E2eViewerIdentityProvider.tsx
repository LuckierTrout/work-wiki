"use client";

/**
 * The CLIENT half of the E2E identity seam (DW-534).
 *
 * Takes the handle its server parent resolved from the `yopedia_e2e` cookie and
 * publishes it on `E2eViewerHandleContext`, so `useViewerHandle()` — and through
 * it the Delete / Re-ingest / Graphify / Revert gates — sees the same viewer the
 * server admitted. `null` means "armed, but this request carries no valid
 * cookie", which must publish a SIGNED-OUT handle rather than nothing at all:
 * there is no `<ClerkProvider>` on this path to fall through to, and inventing
 * an owner would make the client gate WIDER than the server's answer.
 *
 * Lowercasing happens here for the same reason `@/lib/viewer-handle` does it for
 * the Clerk path: every consumer compares against server-stored handles, which
 * are lowercased on write, and a second normalization site is a second way the
 * gates can drift.
 *
 * Mounted only by `E2eViewerIdentity`, only on the armed branch of the root
 * layout. On every normal request this component never renders, the context
 * stays `null`, and the hook reads Clerk exactly as it always has.
 */

import { useMemo } from "react";
import { E2eViewerHandleContext, type ViewerHandle } from "@/lib/viewer-handle";

export function E2eViewerIdentityProvider({
  handle,
  children,
}: {
  /** The cookie-resolved owner handle, or `null` when there is no valid cookie. */
  handle: string | null;
  children: React.ReactNode;
}) {
  const value = useMemo<ViewerHandle>(
    () => ({
      // The cookie was already read and verified on the server, so unlike the
      // Clerk path there is no "not yet resolved" window for a gate to wait out.
      isLoaded: true,
      isSignedIn: handle !== null,
      handle: handle === null ? null : handle.toLowerCase(),
    }),
    [handle],
  );
  return (
    <E2eViewerHandleContext.Provider value={value}>
      {children}
    </E2eViewerHandleContext.Provider>
  );
}
