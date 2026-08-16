"use client";

import type { KeyboardEvent, PointerEvent } from "react";
import {
  isPrimarySplitPress,
  isUnmodifiedSplitKey,
  type SplitId,
} from "@/lib/workbench-split";

/**
 * One column divider (Story 1.6) — the control, and nothing else.
 *
 * It carries no number, no bound and no geometry. The value it announces, the
 * range it announces, where the pointer went and what a key means all arrive as
 * props or leave as callbacks, because `vitest.config.ts` is `environment:
 * "node"` and a condition typed into a handler here could only ever be grepped
 * for. Everything this control could get wrong is executed in
 * `workbench-split.test.ts` instead.
 *
 * `role="separator"` with `tabIndex={0}` is the ARIA window-splitter pattern:
 * resizing is functionality, so it is keyboard-operable (WCAG 2.1.1) rather than
 * pointer-only. The `aria-valuemin` / `aria-valuemax` the parent passes come
 * from the same `splitBounds` call the clamp obeys — a drag that stopped
 * somewhere the announced range said it should not would be a lie to a screen
 * reader.
 *
 * WHERE it sits is decided in CSS, from the same `--wb-*` custom properties the
 * grid tracks read, so the divider is on the boundary by construction rather
 * than by a second derivation of the layout in JavaScript.
 */

export interface SplitHandleProps {
  /** Which boundary this is. Only ever a modifier class and a callback tag. */
  id: SplitId;
  /** The accessible name, from `workbench-split`'s Copy constants. */
  label: string;
  /** The width the column is actually rendered at, in whole pixels. */
  value: number;
  /** The range the parent's clamp enforces, in whole pixels. */
  min: number;
  max: number;
  /** The press began — the shell arms `data-resizing`. */
  onStart: () => void;
  /** The pointer moved while captured. Raw viewport x; the shell does the maths. */
  onMove: (clientX: number) => void;
  /**
   * The gesture ended — released on `pointerup`, or taken away by the browser.
   * Fires exactly once per press; see the handler below for why.
   */
  onEnd: () => void;
  /**
   * A key was pressed. Returns whether the shell claimed it — only then is the
   * default prevented, so Tab, Escape and every shortcut still work from a
   * focused divider.
   */
  onKey: (key: string) => boolean;
}

export function SplitHandle({
  id,
  label,
  value,
  min,
  max,
  onStart,
  onMove,
  onEnd,
  onKey,
}: SplitHandleProps) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className={`wb-split-handle wb-split-handle--${id}`}
      data-no-localize
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        // A secondary button must not start a drag: it would take capture and
        // arm `data-resizing`, after which the divider follows a pointer with no
        // button held for as long as the context menu is open. The rule itself
        // lives in `workbench-split` so the suite can run it.
        if (!isPrimarySplitPress(event)) return;
        // Capture keeps the drag alive when the pointer outruns the 9px strip,
        // which it does on the very first move.
        event.currentTarget.setPointerCapture(event.pointerId);
        onStart();
      }}
      onPointerMove={(event: PointerEvent<HTMLDivElement>) => {
        // Capture is the drag state: without this the divider would follow a
        // pointer that is merely hovering it.
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        onMove(event.clientX);
      }}
      // `lostpointercapture` ALONE, and it is not the exotic path: the browser
      // releases an implicit capture right after dispatching `pointerup`, so
      // this fires once at the end of every ordinary drag — and once more for
      // nothing if `onPointerUp` were wired to the same callback, which would
      // mean two `setResizing(false)` calls and two synchronous localStorage
      // writes per gesture. It also covers `pointercancel` and a capture the
      // browser takes for a gesture of its own, so nothing can strand
      // `data-resizing` on.
      onLostPointerCapture={onEnd}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        // A MODIFIED press belongs to the platform, not to the divider: Alt+Left
        // is browser-back, Ctrl/Alt+arrow is word-jump, Meta+Left is back on
        // macOS, Shift+arrow is selection-extension. This control implements no
        // modified gesture, so claiming one would only break a working shortcut.
        // Shift is included in that rule — see `isUnmodifiedSplitKey`.
        if (!isUnmodifiedSplitKey(event)) return;
        if (onKey(event.key)) event.preventDefault();
      }}
    />
  );
}
