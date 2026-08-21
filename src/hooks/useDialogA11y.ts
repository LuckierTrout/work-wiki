"use client";

import { useEffect, useRef } from "react";
import { useSurfaceVisible } from "@/hooks/useSurfaceVisibility";

/**
 * The modal-dialog accessibility behavior every overlay in this app needs.
 *
 * One implementation rather than a copy per dialog (UX-DR17 says modals never
 * stack, so they had better all behave identically):
 *
 * - initial focus lands on the dialog container, so the title is announced
 *   before the button cluster;
 * - Tab is trapped, INCLUDING the case where focus has drifted outside the
 *   dialog — then it is pulled back in rather than allowed to walk the
 *   background;
 * - Esc dismisses exactly one overlay level (`stopPropagation`), except when
 *   the event came from a native `<select>`, whose open dropdown consumes Esc
 *   itself — closing the whole dialog there would be a second dismissal;
 * - background scroll is locked while open (the `VaultExplorer` lightbox
 *   precedent);
 * - and every one of those stands DOWN while the surface the dialog renders
 *   into is off screen (DW-26). The Wiki canvas stays mounted behind `hidden`
 *   when another mode is showing, so a dialog left open there is still in the
 *   document — and `hidden` does not undo a `document.body` scroll lock or a
 *   capture-phase Tab listener on `document`. `useSurfaceVisible()` is how the
 *   canvas says so; it answers `true` everywhere no surface provider exists,
 *   which is every other dialog in the app;
 * - focus returns to whatever opened the dialog when it closes, instead of
 *   being dropped on `<body>` — and when the opener has been unmounted by the
 *   very action the dialog performed (creating the first Wiki replaces the
 *   empty state that held the opening button), focus lands on the caller's
 *   `fallbackFocusRef` instead of nowhere.
 */

export interface DialogA11yOptions {
  open: boolean;
  /** Called on Esc and on a backdrop click. Ignored while `busy`. */
  onDismiss: () => void;
  /** Suppresses dismissal while a request is in flight. */
  busy?: boolean;
  /**
   * Where focus goes on close when the opener is gone from the document.
   * Give it a `tabIndex={-1}` landmark heading near the opener's old position.
   */
  fallbackFocusRef?: React.RefObject<HTMLElement | null>;
}

/** Every focusable descendant, in tab order. */
function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

export function useDialogA11y({
  open,
  onDismiss,
  busy = false,
  fallbackFocusRef,
}: DialogA11yOptions) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  /**
   * Whether {@link openerRef} holds a capture for the dialog CURRENTLY open.
   *
   * Separate from `openerRef` being non-null, because `document.activeElement`
   * can legitimately be captured as `null` — and a re-arm that read the ref
   * itself would then treat that as "nothing recorded" and overwrite it.
   */
  const openerRecordedRef = useRef(false);
  const fallbackRef = useRef(fallbackFocusRef);
  fallbackRef.current = fallbackFocusRef;
  // Read through a ref inside the listener so a new `onDismiss` identity does
  // not tear down and re-add the handler mid-interaction.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const surfaceVisible = useSurfaceVisible();
  /**
   * When the dialog's machinery is armed.
   *
   * OPEN is what the caller asked for; SHOWING is whether anyone can see it.
   * Both effects key on the pair, so a mode switch that hides the Wiki canvas
   * tears the scroll lock and the Tab trap down, and coming back re-focuses the
   * dialog exactly as opening it does.
   */
  const armed = open && surfaceVisible;
  /**
   * Read in the teardown below to tell HIDING apart from CLOSING.
   *
   * Both are assigned in the render body, so by the time React runs the
   * previous effect's cleanup they already hold the values of the render that
   * caused it — which is the only way the cleanup can know why it is running.
   */
  const openRef = useRef(open);
  openRef.current = open;
  const visibleRef = useRef(surfaceVisible);
  visibleRef.current = surfaceVisible;

  // Remember the opener, take focus, lock scroll — and undo all three on close.
  useEffect(() => {
    if (!armed) return;
    // Captured only when arming from a CLOSED state. This effect re-arms when a
    // dialog that never closed comes back on screen, and at that moment
    // `document.activeElement` is whatever the owner used to switch surfaces —
    // the rail button. Recapturing there would silently replace the control
    // that opened the dialog, so closing it afterwards would drop the keyboard
    // on the rail instead of where the owner left it. The teardown below clears
    // this flag on a real close, which is the only thing that reopens the
    // capture.
    if (!openerRecordedRef.current) {
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement ? active : null;
      openerRecordedRef.current = true;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      // HIDDEN, not closed: the dialog is still open, it has simply gone off
      // screen with the rest of its surface. Its opener went with it, so
      // "restoring" focus would put the keyboard inside a `hidden` subtree —
      // and the owner has already moved focus themselves, to whatever switched
      // the surface. The dialog stays open, so `openerRef` is kept for the
      // close that eventually comes, and `openerRecordedRef` stays set so the
      // re-arm above does not overwrite it with the control that hid it.
      if (openRef.current && !visibleRef.current) return;
      // The opener is frequently gone by now: confirming Create Wiki replaces
      // the empty state that owned the button. Focusing a detached node is a
      // silent no-op that drops the keyboard user on <body>.
      const opener = openerRef.current;
      if (opener?.isConnected) opener.focus();
      else fallbackRef.current?.current?.focus();
      openerRef.current = null;
      openerRecordedRef.current = false;
    };
  }, [armed]);

  useEffect(() => {
    if (!armed) return;
    function handleKey(event: KeyboardEvent) {
      const root = dialogRef.current;
      if (event.key === "Escape") {
        // A native <select> with its dropdown open swallows Esc to close the
        // dropdown. Dismissing the dialog too would close two things at once.
        if (event.target instanceof HTMLSelectElement) return;
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) dismissRef.current();
        return;
      }
      if (event.key !== "Tab" || !root) return;
      const items = focusables(root);
      if (!items.length) {
        // Nothing focusable inside: keep focus on the container rather than
        // letting Tab escape to the page behind the overlay.
        event.preventDefault();
        root.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && root.contains(active);
      if (!inside) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && (active === first || active === root)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKey, true);
    return () => document.removeEventListener("keydown", handleKey, true);
  }, [armed]);

  return { dialogRef };
}
