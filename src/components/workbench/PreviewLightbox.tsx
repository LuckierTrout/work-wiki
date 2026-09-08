"use client";

import React, { useEffect, useRef } from "react";
import {
  PREVIEW_LIGHTBOX_CLOSE_COPY,
  PREVIEW_LIGHTBOX_SOURCE_COPY,
} from "@/lib/workbench-preview";

/**
 * The Workbench's own image lightbox (Story 7.7).
 *
 * ITS OWN, not the Vault explorer's figure overlay. The spec says to reuse that
 * one's BEHAVIOUR — one overlay, Esc closes, the body does not scroll behind it
 * — and not its surface: the Vault's foot opens the original in a new tab,
 * which navigates out of the shell, while this one's second control DOCKS the
 * containing Page or Source in the Preview column. Retargeting that component
 * would have meant teaching it a Workbench selection it has no business
 * knowing about.
 *
 * ONE OVERLAY LEVEL (UX-DR17). The column closes both `ConfirmDialog`s before
 * opening this, and refuses to open it while either is up — enforced at the
 * openers, the same way the edit gate and the revert gate already refuse each
 * other, rather than left to the fact that a focus trap happens to be in the
 * way.
 */

export interface PreviewLightboxProps {
  src: string;
  /** The image's own alt text, or its filename when the markdown carried none. */
  alt: string;
  onClose: () => void;
  /**
   * Dock the Page or Source that CONTAINS this image, and close. Optional: a
   * mount with no way to re-point the shell renders no control rather than a
   * button that does nothing.
   */
  onJumpToSource?: () => void;
}

export function PreviewLightbox({
  src,
  alt,
  onClose,
  onJumpToSource,
}: PreviewLightboxProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // The scroll lock and the key listener are ONE effect because they are one
    // lifetime: an early return that restored the overflow without removing the
    // listener is how a dismissed overlay goes on swallowing Esc.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // The overlay is modal, so the Esc belongs to it and to nothing behind
        // it — without this the shell's own Esc handling can also fire and
        // undock the column the owner is about to be returned to.
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    // Focus lands INSIDE the overlay, or a keyboard owner is left tabbing
    // through the page behind a dialog they cannot see the boundaries of.
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      className="wb-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      // `onMouseDown` and the currentTarget test together: a click that STARTED
      // on the image and ended on the dim (a drag past the edge) is not a
      // request to dismiss, and `onClick` alone treats it as one.
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <div className="wb-lightbox-panel">
        {/* The bytes come from the owner-gated media door, not from a
            configured next/image loader, so a plain <img> is required. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="wb-lightbox-image" src={src} alt={alt} />
        <div className="wb-lightbox-actions">
          {onJumpToSource && (
            <button
              type="button"
              className="wb-lightbox-action"
              onClick={onJumpToSource}
            >
              {PREVIEW_LIGHTBOX_SOURCE_COPY}
            </button>
          )}
          <button
            type="button"
            ref={closeRef}
            className="wb-lightbox-action"
            onClick={onClose}
          >
            {PREVIEW_LIGHTBOX_CLOSE_COPY}
          </button>
        </div>
      </div>
    </div>
  );
}
