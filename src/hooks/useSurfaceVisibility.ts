"use client";

import { createContext, createElement, useContext, type ReactNode } from "react";

/**
 * Whether the surface a subtree renders into is ON SCREEN.
 *
 * The Wiki canvas is MOUNTED in every mode (DW-26) — leaving it is not allowed
 * to unmount `WikiWorkbench`, because an open `CreateWikiDialog` would take the
 * owner's typed name and its error message down with it, and `CreateWikiDialog`
 * resets its fields on close, so hiding cannot be spelled as closing either.
 * What leaving a mode does instead is put the subtree behind `hidden`.
 *
 * `hidden` removes the pixels, the accessibility tree entry and the tab order
 * entry, and that is all it removes. Everything a dialog does to the DOCUMENT —
 * `document.body.style.overflow = "hidden"`, a capture-phase Tab trap on
 * `document` — outlives it, so an off-screen dialog would go on locking the
 * page's scroll and swallowing Tab for a surface nobody can see. That is the
 * one fact the canvas knows and `useDialogA11y` cannot infer, so the canvas
 * publishes it here.
 *
 * A CONTEXT rather than a prop: the Wiki canvas reaches the shell as
 * `children` — server-rendered in `page.tsx` — so there is no prop path from
 * `ModeCanvas` down to a dialog nested inside it, and adding one would mean
 * threading a boolean through every component in between.
 *
 * The default is `true`, which is what makes every dialog with no provider
 * above it (`/settings`, the Vault explorer) behave exactly as it did before
 * this existed.
 *
 * The Preview column publishes one too now. It stays MOUNTED behind `hidden`
 * for a Settings visit so its editor's unsaved markdown survives (DW-412), and
 * it owns two `ConfirmDialog`s — so it needs exactly what the mode canvas
 * needs, and for exactly the same reason.
 */
const SurfaceVisibilityContext = createContext(true);

export function SurfaceVisibilityProvider({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}) {
  return createElement(SurfaceVisibilityContext.Provider, { value: visible }, children);
}

/** `true` unless an enclosing surface says it is currently off screen. */
export function useSurfaceVisible(): boolean {
  return useContext(SurfaceVisibilityContext);
}
