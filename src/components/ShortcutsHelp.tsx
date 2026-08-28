"use client";

import { useEffect, useCallback } from "react";
import { useShortcutsHelp, SHORTCUTS } from "@/hooks/useKeyboardShortcuts";
import { useDialogA11y } from "@/hooks/useDialogA11y";

/** Detect platform for modifier key display */
function modKey(): string {
  if (typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.platform ?? "")) {
    return "⌘";
  }
  return "Ctrl";
}

export function ShortcutsHelp() {
  const { showHelp, setShowHelp } = useShortcutsHelp();

  const close = useCallback(() => setShowHelp(false), [setShowHelp]);

  // Esc, the Tab trap, initial focus, the scroll lock and the focus restore all
  // come from the shared hook — the same behaviour every other overlay in the
  // app has. Adopting it is what lets the overlay honestly claim
  // `aria-modal="true"` below, which is in turn what brings it inside
  // `isInModalDialog` so a global `g <key>` cannot navigate out from under an
  // open help sheet (DW-424).
  const { dialogRef } = useDialogA11y({ open: showHelp, onDismiss: close });

  /**
   * `?` from INSIDE the sheet.
   *
   * `KeyboardShortcutsProvider` owns `?`, but its handler now returns early for
   * any target inside this overlay — and `useDialogA11y` focuses the container
   * on open, so that is the ordinary case. Without this the key that opens the
   * sheet would no longer close it.
   *
   * Scoped to targets inside `dialogRef.current`, and it is the SCOPE that does
   * the work: outside the overlay the provider's handler still owns the key,
   * and it refuses a `?` typed into a text field. A listener here that answered
   * every `?` while the sheet was open would dismiss it out from under someone
   * typing a question mark somewhere else on the page.
   *
   * Capture phase plus `stopPropagation`, so exactly one of the two handlers
   * acts on any one press — without it the provider's bubble-phase toggle would
   * be free to flip the sheet back open in the same keystroke wherever the
   * modal guard did not already stop it.
   */
  useEffect(() => {
    if (!showHelp) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key !== "?") return;
      const root = dialogRef.current;
      const target = event.target;
      if (!root || !(target instanceof Node) || !root.contains(target)) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    }
    document.addEventListener("keydown", handleKey, true);
    return () => document.removeEventListener("keydown", handleKey, true);
  }, [showHelp, close, dialogRef]);

  if (!showHelp) return null;

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div className="w-full max-w-md mx-4 rounded-lg border border-foreground/10 bg-background shadow-xl">
        <div className="flex items-center justify-between border-b border-foreground/10 px-4 py-3">
          <h2 className="text-lg font-semibold text-foreground">
            Keyboard Shortcuts
          </h2>
          <button
            type="button"
            onClick={close}
            className="text-foreground/50 hover:text-foreground transition-colors p-1 rounded-md hover:bg-foreground/5"
            aria-label="Close shortcuts help"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18 18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="px-4 py-3">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-foreground/50">
                <th className="pb-2 pr-4 font-medium">Shortcut</th>
                <th className="pb-2 font-medium">Description</th>
              </tr>
            </thead>
            <tbody className="text-foreground">
              {/* Built-in navigation shortcuts */}
              {SHORTCUTS.map((shortcut) => (
                <tr
                  key={shortcut.keys.join("-")}
                  className="border-t border-foreground/5"
                >
                  <td className="py-1.5 pr-4">
                    <kbd className="inline-flex gap-1">
                      {shortcut.keys.map((k, i) => (
                        <span key={i}>
                          {i > 0 && (
                            <span className="text-foreground/30 mx-0.5">
                              {" "}
                            </span>
                          )}
                          <span className="rounded border border-foreground/20 bg-foreground/5 px-1.5 py-0.5 font-mono text-xs">
                            {k}
                          </span>
                        </span>
                      ))}
                    </kbd>
                  </td>
                  <td className="py-1.5">{shortcut.description}</td>
                </tr>
              ))}
              {/* Existing search shortcut */}
              <tr className="border-t border-foreground/5">
                <td className="py-1.5 pr-4">
                  <kbd className="inline-flex gap-1">
                    <span className="rounded border border-foreground/20 bg-foreground/5 px-1.5 py-0.5 font-mono text-xs">
                      {modKey()}+K
                    </span>
                  </kbd>
                </td>
                <td className="py-1.5">Focus search</td>
              </tr>
              <tr className="border-t border-foreground/5">
                <td className="py-1.5 pr-4">
                  <kbd className="inline-flex gap-1">
                    <span className="rounded border border-foreground/20 bg-foreground/5 px-1.5 py-0.5 font-mono text-xs">
                      /
                    </span>
                  </kbd>
                </td>
                <td className="py-1.5">Focus search</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="border-t border-foreground/10 px-4 py-2 text-xs text-foreground/40">
          Press <kbd className="rounded border border-foreground/20 bg-foreground/5 px-1 py-0.5 font-mono text-xs">Esc</kbd> or <kbd className="rounded border border-foreground/20 bg-foreground/5 px-1 py-0.5 font-mono text-xs">?</kbd> to close
        </div>
      </div>
    </div>
  );
}
