import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { KeyboardShortcutsProvider } from "@/hooks/useKeyboardShortcuts";
import { ShortcutsHelp } from "@/components/ShortcutsHelp";

/**
 * The shortcuts sheet is a REAL modal (DW-424).
 *
 * It used to render `role="dialog"` with no `aria-modal`, which put it outside
 * `isInModalDialog` — so `g i` typed over the open help overlay navigated the
 * owner to `/ingest` and left the sheet floating over a page they never asked
 * for. The reason it was left non-modal was `?`: the provider owns that key, and
 * suppressing it inside the overlay would have made the sheet undismissable by
 * the key that opened it.
 *
 * So the fix has two halves and this suite drives both. The overlay declares
 * `aria-modal="true"` and adopts `useDialogA11y` (Esc, the Tab trap, focus,
 * scroll lock); `?` is handled by the overlay ITSELF, scoped to targets inside
 * its own container. The `?` case below is the one that would fail if the local
 * handler were unscoped — the provider's toggle would fire too and reopen the
 * sheet — and the `g i` case is the one that would fail if `aria-modal` were
 * dropped again.
 *
 * `keyboard-shortcuts.test.ts` executes the predicate against object literals;
 * only a mounted overlay can show what it now answers for.
 */

const { router } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * The sheet, plus one text field OUTSIDE it.
 *
 * The field is not scenery: `?` is a printable character, and the provider has
 * always refused to act on one typed into an input. The overlay's own handler
 * has to refuse it for the same reason, which is only possible because it is
 * scoped to its own subtree.
 */
function mountHelp() {
  return render(
    <KeyboardShortcutsProvider>
      <input aria-label="Somewhere else" />
      <ShortcutsHelp />
    </KeyboardShortcutsProvider>,
  );
}

/**
 * Mount, then open the sheet the way an owner does — `?` with nothing focused,
 * so the provider's GLOBAL handler is what runs. Every case starts here, since
 * a sheet opened any other way would not prove the provider still owns the key
 * from outside the overlay.
 */
function openHelp(): HTMLElement {
  mountHelp();
  fireEvent.keyDown(document.body, { key: "?" });
  return screen.getByRole("dialog", { name: "Keyboard shortcuts" });
}

beforeEach(() => {
  router.push.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("ShortcutsHelp modality", () => {
  it("declares itself modal, which is what the shortcut guard matches on", () => {
    const dialog = openHelp();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("takes focus into the overlay when it opens", () => {
    const dialog = openHelp();
    expect(document.activeElement).toBe(dialog);
  });

  it("swallows a global navigation sequence typed inside it", () => {
    const dialog = openHelp();

    fireEvent.keyDown(dialog, { key: "g" });
    fireEvent.keyDown(dialog, { key: "i" });

    expect(router.push).not.toHaveBeenCalled();
    // …and the sheet is still the thing on screen, rather than a leftover
    // overlay sitting on top of a route the owner never asked for.
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
  });

  it("closes on ? from inside — once, not toggled twice", () => {
    const dialog = openHelp();

    fireEvent.keyDown(dialog, { key: "?" });

    // If the provider's toggle ALSO ran, the sheet would have closed and
    // reopened within the one keystroke and this query would find it.
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
  });

  it("closes on ? typed on a control inside it", () => {
    openHelp();
    const closeButton = screen.getByRole("button", { name: "Close shortcuts help" });
    closeButton.focus();

    fireEvent.keyDown(closeButton, { key: "?" });

    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
  });

  it("closes once when ? is typed with focus outside the overlay", () => {
    // THE CASE THAT PINS THE SCOPING. `isInModalDialog` reads the EVENT TARGET,
    // so with focus back on `<body>` the provider's global toggle still fires.
    // An overlay handler that answered every `?` regardless of target would run
    // too — closing the sheet and letting the provider's functional toggle flip
    // it straight back open. Exactly one of the two may act on any one press.
    openHelp();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    fireEvent.keyDown(document.body, { key: "?" });

    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
  });

  it("ignores ? typed into a field outside the overlay", () => {
    // THE CASE THAT PINS THE SCOPING. A handler that answered every `?` while
    // the sheet was open would dismiss it out from under someone typing a
    // question mark into a text field — the exact reason the provider's own
    // dispatcher checks `isInputElement` before it acts.
    openHelp();
    const field = screen.getByRole("textbox", { name: "Somewhere else" });
    field.focus();

    fireEvent.keyDown(field, { key: "?" });

    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
  });

  it("closes on Escape", () => {
    const dialog = openHelp();

    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
  });

  it("traps Tab inside the overlay", () => {
    const dialog = openHelp();
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    expect(focusables.length).toBeGreaterThan(0);

    const last = focusables[focusables.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });

    // Wraps to the first focusable rather than escaping to the page behind,
    // which is the promise `aria-modal="true"` makes.
    expect(document.activeElement).toBe(focusables[0]);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("reopens with ? once it has been closed", () => {
    openHelp();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Keyboard shortcuts" }), {
      key: "?",
    });
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();

    // Focus returns to the opener on close — `<body>` here, since the sheet was
    // opened from nothing — so the provider's global handler owns `?` again and
    // the key still works both ways.
    fireEvent.keyDown(document.body, { key: "?" });
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
  });
});
