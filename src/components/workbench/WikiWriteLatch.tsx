"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * ONE unconfirmed-write latch for every wiki write control on screen, and the
 * SENTENCE it was raised beside (DW-516).
 *
 * `WikiWorkbench` and `WikiSwitcher` are rendered together by `page.tsx` — the
 * card inside `Workbench`, the switcher in `.wb-left-head` — and both open the
 * same {@link CreateWikiDialog} onto the same `POST /api/wikis`. Nothing
 * enforces unique wiki names, so while each surface held its own `useState`
 * flag an unconfirmed create latched on one of them left the OTHER's create
 * fully live: one click seeded the second wiki the latch exists to prevent, and
 * moved every prompt onto its template. A door with two frames is not shut.
 *
 * The shared state carries the sentence rather than a boolean, because that is
 * what lets a control dimmed by ANOTHER surface's write explain itself —
 * DW-430's rule, now across the seam. A dimmed `Create Wiki` on the card and a
 * dead `Create` in the header's dialog both resolve to the one sentence
 * `writeFailure` composed for the write actually in doubt. No copy constant
 * lives here: the message is always the one the failing call site was handed.
 *
 * WHAT IS NOT ADMITTED HERE. The card's SUCCESS-path latch (`awaitingCreate`)
 * stays local. A create that succeeded shuts one control — the empty state's
 * `Create Wiki`, stale behind `WIKI_EMPTY_COPY` for the length of the refresh —
 * and it carries no sentence at all, so sharing it would dim controls on the
 * other surface with nothing to say for them. `busy` stays local for the same
 * reason in reverse: it is one request's in-flight window, not an unanswered
 * question about the registry.
 *
 * AND NO RELEASE EFFECT LIVES HERE. Each surface already owns a ref-gated one
 * keyed on `[wikis, currentWikiId]`, and that ref gate is the whole mechanism
 * that separates a stale unknown-outcome sentence from a STATED refusal the
 * owner is still reading: only the surface that raised the standing latch may
 * clear its own errors when the render arrives. A provider-level effect could
 * not tell whose errors to drop, and a provider-level dependency on `latched`
 * would fire on the very commit that RAISES the latch and drop it before the
 * write had any answer. {@link WikiWriteLatch.release} is idempotent, so
 * whichever holder's effect runs first on the arriving render releases it and
 * the other's is a no-op.
 */
export interface WikiWriteLatch {
  /** A wiki write's outcome is unknown; every write control is shut. */
  latched: boolean;
  /** The sentence the latch was raised beside, or `null` when it is down. */
  message: string | null;
  /** Raise the latch, carrying `writeFailure`'s sentence. Stable identity. */
  raise: (message: string) => void;
  /** Drop it. Idempotent, and stable — see the docblock. */
  release: () => void;
}

/**
 * `null` rather than a default value, so {@link useWikiWriteLatch} can tell
 * "no provider above me" from "a provider holding no message" and degrade to
 * LOCAL state instead of to a constant. `WorkbenchData`'s `EMPTY_DATA`
 * convention degrades to a constant because a consumer outside that provider
 * has nothing to render; a bare-mounted `WikiSwitcher` still has four writes to
 * latch, so its fallback has to be state and not a frozen `false`.
 */
const WikiWriteLatchContext = createContext<WikiWriteLatch | null>(null);

/** The one piece of state, in the shape both the provider and the fallback use. */
function useLatchState(): WikiWriteLatch {
  const [message, setMessage] = useState<string | null>(null);
  // Stable across renders, because each surface's release effect takes
  // `release` as a DEPENDENCY: `latched` and `message` are not stable, and
  // either in that list would fire the effect on the commit that raises the
  // latch and drop it before the write it guards has any answer.
  const raise = useCallback((next: string) => setMessage(next), []);
  const release = useCallback(() => setMessage(null), []);
  return useMemo(
    () => ({ latched: message !== null, message, raise, release }),
    [message, raise, release],
  );
}

/**
 * Nests INSIDE `WorkbenchDataContext.Provider` (see `WorkbenchData.tsx`), which
 * is the seam `page.tsx` already composes around both wiki surfaces. It needs
 * no props: the server data it would carry is the data the release effects
 * already depend on, one component further down.
 */
export function WikiWriteLatchProvider({ children }: { children: ReactNode }) {
  const latch = useLatchState();
  return (
    <WikiWriteLatchContext.Provider value={latch}>
      {children}
    </WikiWriteLatchContext.Provider>
  );
}

/**
 * The shared latch, or an equivalent one of this component's own.
 *
 * The local fallback is not a degradation to "nothing": a `WikiSwitcher`
 * mounted bare — which is how its own suite renders it — must still raise, hold
 * and release exactly as it does with a provider above it. Both branches are
 * built every render because hooks cannot be called conditionally; the unused
 * one costs one `useState` and is never written to.
 */
export function useWikiWriteLatch(): WikiWriteLatch {
  const shared = useContext(WikiWriteLatchContext);
  const local = useLatchState();
  return shared ?? local;
}
