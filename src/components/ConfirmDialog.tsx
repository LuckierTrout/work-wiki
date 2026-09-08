"use client";

import { useCallback, useId } from "react";
import { useDialogA11y } from "@/hooks/useDialogA11y";

/**
 * The one confirm-overlay level (UX-DR17).
 *
 * Modals never stack: this renders a single `role="dialog" aria-modal="true"`
 * overlay and delegates focus, Tab trapping, Esc, scroll lock, and focus
 * restore to {@link useDialogA11y}, which `CreateWikiDialog` shares — the
 * behavior is defined once, not copied per dialog.
 *
 * Shared on purpose — Stories 1.5 (confirm-gated Preview edit) and 1.8 (Schema
 * edit) reuse this rather than growing a second dialog.
 */

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  /** Blocks the confirm action — e.g. a destructive no-op selection. */
  confirmDisabled?: boolean;
  /**
   * A failed confirm, rendered INSIDE the overlay. The dialog stays open on
   * failure, so anything the host renders behind it is hidden by the backdrop
   * and the owner would see the spinner stop with no explanation.
   */
  error?: string | null;
  /** Where focus goes on close if the opener was unmounted by the action. */
  fallbackFocusRef?: React.RefObject<HTMLElement | null>;
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  busy = false,
  confirmDisabled = false,
  error = null,
  fallbackFocusRef,
}: ConfirmDialogProps) {
  const titleId = useId();
  const cancel = useCallback(() => {
    if (!busy) onCancel();
  }, [busy, onCancel]);
  const { dialogRef } = useDialogA11y({
    open,
    onDismiss: cancel,
    busy,
    fallbackFocusRef,
  });

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) cancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="fade w-full max-w-md rounded-xl border border-foreground/15 bg-background p-5 shadow-xl outline-none"
      >
        <h2 id={titleId} className="text-base font-semibold text-foreground">
          {title}
        </h2>
        <div className="mt-2 text-sm leading-6 text-foreground/70">{body}</div>
        {error && (
          <p role="alert" className="mt-4 text-sm text-red-700">
            {error}
          </p>
        )}
        <div className="mt-5 flex items-center justify-end gap-2">
          <button type="button" className="btn ghost" onClick={cancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
