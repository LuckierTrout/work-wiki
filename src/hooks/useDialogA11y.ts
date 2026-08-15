"use client";

import { useEffect, useRef } from "react";

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
  const fallbackRef = useRef(fallbackFocusRef);
  fallbackRef.current = fallbackFocusRef;
  // Read through a ref inside the listener so a new `onDismiss` identity does
  // not tear down and re-add the handler mid-interaction.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // Remember the opener, take focus, lock scroll — and undo all three on close.
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement ? active : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      // The opener is frequently gone by now: confirming Create Wiki replaces
      // the empty state that owned the button. Focusing a detached node is a
      // silent no-op that drops the keyboard user on <body>.
      const opener = openerRef.current;
      if (opener?.isConnected) opener.focus();
      else fallbackRef.current?.current?.focus();
      openerRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
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
  }, [open]);

  return { dialogRef };
}
