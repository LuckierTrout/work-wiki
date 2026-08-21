"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  createElement,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";

// ---------------------------------------------------------------------------
// Pure utility functions (exported for testing)
// ---------------------------------------------------------------------------

const INPUT_TAG_NAMES = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** Returns true when the event target is an element where typing should be ignored. */
export function isInputElement(target: EventTarget | null): boolean {
  if (!target || !(target as HTMLElement).tagName) return false;
  const el = target as HTMLElement;
  if (INPUT_TAG_NAMES.has(el.tagName)) return true;
  if (el.isContentEditable) return true;
  return false;
}

/** Shortcut definition */
export interface ShortcutDef {
  /** Key sequence, e.g. ["g", "i"] or ["?"] */
  keys: string[];
  /** Human-readable description */
  description: string;
  /** Route to navigate to (if navigation shortcut) */
  route?: string;
  /**
   * An IN-PAGE action this shortcut prefers over its route (DW-62).
   *
   * A mounted component claims the id with {@link useShortcutAction}; while one
   * is registered the keydown runs the handler and does not navigate. With none
   * registered the `route` below is still taken, so the same key works on every
   * page — which is the whole reason both fields coexist rather than the route
   * being replaced.
   */
  action?: ShortcutActionId;
}

/**
 * Every in-page action a shortcut may claim.
 *
 * A union rather than a bare string so a registration and a `SHORTCUTS` entry
 * cannot disagree by a typo — the one failure mode that would silently leave
 * `g s` navigating away from the shell again.
 */
export type ShortcutActionId = "open-settings";

/** Built-in shortcut definitions */
export const SHORTCUTS: ShortcutDef[] = [
  { keys: ["g", "i"], description: "Go to Ingest", route: "/ingest" },
  { keys: ["g", "q"], description: "Go to Query", route: "/query" },
  { keys: ["g", "l"], description: "Go to Lint", route: "/lint" },
  { keys: ["g", "g"], description: "Go to Graph", route: "/wiki/graph" },
  // Settings is a SURFACE on the mounted Workbench shell, not a page, whenever
  // that shell is on screen. What the in-page action avoids is the ROUTE
  // CHANGE: `router.push("/settings")` unmounts the entire shell — the rail,
  // the left column, both trees, the Preview, the canvas — and lands the owner
  // on a flat page carrying none of them, to reach a surface the rail control
  // opens in place. Pressing the key becomes exactly what pressing the rail
  // control does, which is the whole claim.
  //
  // The mode canvas survives it too (DW-373). `Workbench.tsx` used to swap
  // `ModeCanvas` out for `SettingsCanvas`, so opening Settings by either route
  // unmounted the Wiki subtree — an open Create Wiki dialog and its typed name
  // with it. It now renders both and hides the mode one, so the canvas and
  // everything mounted inside it come back exactly as they were left.
  //
  // THE CANVAS, and not the rest of the shell. `previewOpen` still ANDs in
  // `!settingsOpen`, so a docked Preview undocks and an unsaved Preview edit
  // goes with it, and the left column still hands its space to `SettingsNav`.
  // Both are deliberate, both are out of DW-373's scope, and neither is this
  // shortcut's doing — the rail control does precisely the same.
  //
  // So the shell claims `open-settings` and this route is the fallback for the
  // pages that have no shell to open it on. `/settings` itself stays a real
  // route (DW-61); nothing here retires it.
  {
    keys: ["g", "s"],
    description: "Go to Settings",
    route: "/settings",
    action: "open-settings",
  },
  { keys: ["?"], description: "Toggle keyboard shortcuts help" },
];

/** Timeout in ms for multi-key sequences */
export const SEQUENCE_TIMEOUT_MS = 1000;

/**
 * Given the current key buffer and a new key, returns a matching shortcut
 * (if any) and the updated buffer.
 */
export function matchShortcut(
  buffer: string[],
  key: string,
): { match: ShortcutDef | null; newBuffer: string[] } {
  const candidate = [...buffer, key];

  // Check for exact match
  for (const shortcut of SHORTCUTS) {
    if (shortcut.keys.length !== candidate.length) continue;
    if (shortcut.keys.every((k, i) => k === candidate[i])) {
      return { match: shortcut, newBuffer: [] };
    }
  }

  // Check if candidate is a valid prefix of any shortcut
  const isPrefix = SHORTCUTS.some((shortcut) => {
    if (shortcut.keys.length <= candidate.length) return false;
    return candidate.every((k, i) => shortcut.keys[i] === k);
  });

  if (isPrefix) {
    return { match: null, newBuffer: candidate };
  }

  // Not a match or prefix — try treating this key as a fresh start
  // (e.g. user pressed "g" then "x" then "g" — the second "g" should start a new sequence)
  for (const shortcut of SHORTCUTS) {
    if (shortcut.keys.length === 1 && shortcut.keys[0] === key) {
      return { match: shortcut, newBuffer: [] };
    }
  }

  const isFreshPrefix = SHORTCUTS.some(
    (shortcut) => shortcut.keys.length > 1 && shortcut.keys[0] === key,
  );
  if (isFreshPrefix) {
    return { match: null, newBuffer: [key] };
  }

  return { match: null, newBuffer: [] };
}

// ---------------------------------------------------------------------------
// React context & provider
// ---------------------------------------------------------------------------

interface ShortcutsHelpContextValue {
  showHelp: boolean;
  setShowHelp: (show: boolean) => void;
}

const ShortcutsHelpContext = createContext<ShortcutsHelpContextValue | null>(
  null,
);

/**
 * Where a mounted component leaves the handler for an action id.
 *
 * A REGISTRY rather than a second provider prop, because the claim is made from
 * deep inside the tree (`Workbench`, which the page renders as a child of
 * `ClientProviders`) and released on unmount — the shortcut has to fall back to
 * its route the moment the shell that claimed it is gone.
 */
interface ShortcutActionRegistry {
  /** Claim `id`; the returned function releases it. */
  register: (id: ShortcutActionId, run: () => void) => () => void;
  /** The handler for `id`, or `undefined` when nothing has claimed it. */
  handler: (id: ShortcutActionId) => (() => void) | undefined;
}

/**
 * `null` outside a provider, and {@link useShortcutAction} treats that as "no
 * registry to claim" rather than throwing: the Workbench shell is mounted bare
 * by several suites and by nothing that needs a keyboard dispatcher, and a hook
 * that threw there would make the provider a hard dependency of the shell.
 */
const ShortcutActionsContext = createContext<ShortcutActionRegistry | null>(null);

export function KeyboardShortcutsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const router = useRouter();
  const [showHelp, setShowHelp] = useState(false);
  const bufferRef = useRef<string[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The claimed actions. A REF, not state: the keydown listener below reads it
   * at dispatch time, so a registration must not re-render the whole app — and
   * must not rebuild the listener either, which would drop a half-typed `g`.
   */
  const actionsRef = useRef(new Map<ShortcutActionId, () => void>());
  // Stable for the lifetime of the provider, so `useShortcutAction`'s effect
  // does not re-run — and therefore does not release and re-claim the id — on
  // every render of the component that claimed it.
  const registry = useRef<ShortcutActionRegistry>({
    register(id, run) {
      actionsRef.current.set(id, run);
      return () => {
        // Only if it is still OURS. Two shells overlapping for one commit (a
        // remount renders the new tree before the old one's cleanup runs) would
        // otherwise have the departing instance delete the arriving one's
        // claim, leaving `g s` navigating away from a shell that is on screen.
        if (actionsRef.current.get(id) === run) actionsRef.current.delete(id);
      };
    },
    handler(id) {
      return actionsRef.current.get(id);
    },
  }).current;

  const clearBuffer = useCallback(() => {
    bufferRef.current = [];
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ignore when typing in form elements
      if (isInputElement(e.target)) return;

      // Ignore when modifier keys are held (except shift for ?)
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const key = e.key;

      // Skip pure modifier presses
      if (
        key === "Shift" ||
        key === "Control" ||
        key === "Alt" ||
        key === "Meta"
      ) {
        return;
      }

      const { match, newBuffer } = matchShortcut(bufferRef.current, key);

      bufferRef.current = newBuffer;

      // Reset the sequence timeout
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      if (newBuffer.length > 0) {
        timerRef.current = setTimeout(() => {
          bufferRef.current = [];
        }, SEQUENCE_TIMEOUT_MS);
      }

      if (match) {
        e.preventDefault();
        // An in-page action OUTRANKS the route (DW-62). `g s` on a mounted
        // Workbench must open the Settings surface on that shell rather than
        // navigate to `/settings`, which would unmount the shell itself; on
        // every other page nothing has claimed the id and the route below still
        // runs.
        const action = match.action ? registry.handler(match.action) : undefined;
        if (action) {
          action();
        } else if (match.route) {
          router.push(match.route);
        } else if (match.keys.length === 1 && match.keys[0] === "?") {
          setShowHelp((prev) => !prev);
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [router, clearBuffer, registry]);

  return createElement(
    ShortcutActionsContext.Provider,
    { value: registry },
    createElement(
      ShortcutsHelpContext.Provider,
      { value: { showHelp, setShowHelp } },
      children,
    ),
  );
}

/**
 * Claim a shortcut's in-page action for as long as this component is mounted.
 *
 * The handler is read through a ref, so a caller may pass a fresh closure on
 * every render without releasing and re-claiming the id between keystrokes.
 *
 * A no-op outside {@link KeyboardShortcutsProvider}: the shortcut then has no
 * dispatcher at all, so there is nothing to claim and nothing to fall back
 * from.
 */
export function useShortcutAction(id: ShortcutActionId, handler: () => void): void {
  const registry = useContext(ShortcutActionsContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    if (!registry) return;
    return registry.register(id, () => handlerRef.current());
  }, [registry, id]);
}

export function useShortcutsHelp(): ShortcutsHelpContextValue {
  const ctx = useContext(ShortcutsHelpContext);
  if (!ctx) {
    throw new Error(
      "useShortcutsHelp must be used within a KeyboardShortcutsProvider",
    );
  }
  return ctx;
}
