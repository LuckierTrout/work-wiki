import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

/**
 * DOM-project setup: unmount between tests, plus the three browser capabilities
 * jsdom does not have that the components under test read directly.
 *
 * Every shim lives HERE and never in `src/`. The point of the DOM project is to
 * pin the behaviour the app already has; reshaping a component so it stops
 * asking the platform a question would be pinning something else.
 */

// React Testing Library keeps mounted trees in a module-level registry. Without
// this, a suite's second test renders into a document that still holds the
// first test's tree — `getByRole` then finds two matches and throws.
//
// This `cleanup()` is a BACKSTOP, not the primary teardown. vitest runs
// `afterEach` hooks in REVERSE registration order, and a setup file registers
// before any test file does — so this one runs LAST, after a suite has already
// restored real timers, unstubbed `fetch` and reset module registries. A tree
// unmounted at that point tears down against an environment that is no longer
// the one it ran in, which hides leaks instead of catching them. Every suite
// here therefore calls `cleanup()` itself as the first statement of its own
// `afterEach`; this covers any file that forgets to.
afterEach(() => {
  cleanup();
  resetMediaQueries();
  setVisibilityState("visible");
});

// ---------------------------------------------------------------------------
// window.matchMedia
// ---------------------------------------------------------------------------
//
// jsdom ships NO `window.matchMedia` at all (it has no CSSOM media evaluation),
// so `Workbench`'s breakpoint effect returns on its `!window.matchMedia` guard
// and the "widening past 900px closes the sheet" path can never execute. The
// shim is a real listener-carrying MediaQueryList whose `matches` a test moves
// with `setMediaQuery`, which is the only way to drive that path.

type MediaChangeListener = (event: MediaQueryListEvent) => void;

/** One `MediaQueryList` the shim has handed out, so `onchange` can be read. */
interface FakeList {
  onchange: MediaChangeListener | null;
}

interface FakeMediaQuery {
  media: string;
  matches: boolean;
  listeners: Set<MediaChangeListener>;
  /**
   * A real `matchMedia` returns a NEW MediaQueryList per call, and each one
   * carries its own `onchange`. Keeping them here is what lets `setMediaQuery`
   * notify an `onchange` handler as a browser would — the shim advertises the
   * property, so it has to honour it.
   */
  lists: Set<FakeList>;
  /** Has anything actually called `matchMedia(query)` for this string? */
  observed: boolean;
}

const mediaQueries = new Map<string, FakeMediaQuery>();

function mediaQuery(query: string): FakeMediaQuery {
  let entry = mediaQueries.get(query);
  if (!entry) {
    // Default `false`: the narrow viewport, which is the only width at which
    // the sheet exists at all, so a test that never touches this gets the
    // breakpoint the sheet behaviours are about.
    entry = {
      media: query,
      matches: false,
      listeners: new Set(),
      lists: new Set(),
      observed: false,
    };
    mediaQueries.set(query, entry);
  }
  return entry;
}

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  writable: true,
  value: (query: string): MediaQueryList => {
    const entry = mediaQuery(query);
    entry.observed = true;
    const list: FakeList = {
      onchange: null,
      get media() {
        return entry.media;
      },
      get matches() {
        return entry.matches;
      },
      addEventListener: (type: string, listener: MediaChangeListener) => {
        if (type === "change") entry.listeners.add(listener);
      },
      removeEventListener: (type: string, listener: MediaChangeListener) => {
        if (type === "change") entry.listeners.delete(listener);
      },
      // The legacy pair, so a component using either API works against the shim.
      addListener: (listener: MediaChangeListener) => entry.listeners.add(listener),
      removeListener: (listener: MediaChangeListener) => entry.listeners.delete(listener),
      dispatchEvent: () => true,
    } as FakeList;
    entry.lists.add(list);
    return list as unknown as MediaQueryList;
  },
});

/**
 * Move a media query and notify every listener registered against it.
 *
 * Throws when nothing under test has asked for this query. A test drives a
 * breakpoint by repeating the query string the component uses (they are
 * module-private, so there is nothing to import), and `mediaQuery()` mints an
 * entry for whatever string it is handed — so a typo, or a query the component
 * has since renamed, would move a registry entry nobody listens to and pass as
 * a silent no-op. Refusing is the difference between a red test naming the
 * query and a green one asserting nothing.
 */
export function setMediaQuery(query: string, matches: boolean): void {
  const entry = mediaQuery(query);
  if (!entry.observed) {
    throw new Error(
      `setMediaQuery("${query}"): nothing has called matchMedia() with this ` +
        `query, so moving it would notify no one. Render the component first, ` +
        `and check the query string still matches the one it uses.`,
    );
  }
  entry.matches = matches;
  const event = { matches, media: query } as MediaQueryListEvent;
  for (const listener of [...entry.listeners]) listener(event);
  for (const list of [...entry.lists]) list.onchange?.(event);
}

/**
 * Return every query to its default and drop its listeners, so files cannot
 * leak state into each other.
 *
 * Each entry is reset IN PLACE rather than dropped from the map: a component
 * that outlives the reset still holds the `MediaQueryList` this shim handed it,
 * and clearing the map would mint a fresh entry on the next `setMediaQuery` —
 * silently moving a query nothing is listening to.
 */
export function resetMediaQueries(): void {
  for (const entry of mediaQueries.values()) {
    entry.matches = false;
    entry.listeners.clear();
    entry.lists.clear();
    // The next file has to ask for the query itself, or `setMediaQuery` would
    // accept a string only some earlier file ever used.
    entry.observed = false;
  }
}

// ---------------------------------------------------------------------------
// HTMLElement.prototype.offsetParent
// ---------------------------------------------------------------------------
//
// jsdom has no layout engine, so `offsetParent` is undefined for every element.
// `Workbench`'s focus-restore guard is `if (trigger?.offsetParent) trigger.focus()`
// — with the real jsdom value that branch is dead, and "Esc returns focus to the
// trigger" could never be observed. The approximation answers the only question
// the guard asks: is this element actually in the rendered layout?

/**
 * FIDELITY LIMIT, and the most important one in this file. jsdom loads no
 * stylesheet, so there is no computed style to consult: this sees ONLY the
 * `hidden` attribute and an INLINE `display: none`, walking up the ancestor
 * chain. An element hidden by a CSS class or a media query — which is how the
 * real app hides the rail's collapse chevron below 900px — reads as VISIBLE
 * here. A test that needs an element to count as hidden must hide it the two
 * ways this function can actually observe.
 */
function displayHidden(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.hidden || node.style.display === "none") return true;
  }
  return false;
}

Object.defineProperty(HTMLElement.prototype, "offsetParent", {
  configurable: true,
  get(this: HTMLElement): Element | null {
    if (!this.isConnected || displayHidden(this)) return null;
    // `<body>` has no offset parent in a real browser either.
    return this === document.body ? null : document.body;
  },
});

// ---------------------------------------------------------------------------
// HTMLElement.prototype.getClientRects
// ---------------------------------------------------------------------------
//
// Same missing layout engine: jsdom returns an EMPTY DOMRectList for every
// element, including visible ones. `Workbench`'s sheet Tab cycle filters the
// rail's controls with `item.getClientRects().length > 0`, so against real jsdom
// the filtered list is always empty and the cycle returns before it can wrap —
// the behaviour would be untestable rather than merely unverified.
//
// FIDELITY LIMIT: the rect is a fixed 1x1 placeholder and `getBoundingClientRect`
// is left as jsdom's all-zeros. A mounted `Workbench` therefore measures
// `shellWidth === 0`, so every `workbench-split` decision it makes — the clamp,
// the divider bounds, whether a `SplitHandle` renders at all — runs at a width
// no browser reports. Those rules have their own node-project suite; nothing
// here should be read as covering them.

HTMLElement.prototype.getClientRects = function getClientRects(
  this: HTMLElement,
): DOMRectList {
  const rects =
    this.isConnected && !displayHidden(this) ? [new DOMRect(0, 0, 1, 1)] : [];
  return Object.assign(rects, {
    item: (index: number): DOMRect | null => rects[index] ?? null,
  }) as unknown as DOMRectList;
};

// ---------------------------------------------------------------------------
// Element.prototype.scrollIntoView
// ---------------------------------------------------------------------------
//
// Same missing layout engine once more: jsdom implements no scrolling at all
// and ships NO `scrollIntoView`, so calling it is a `TypeError` rather than a
// no-op. `Workbench`'s narrow-width reveal calls it on the docked Preview, and
// without a shim the only way to keep the suite green would be to delete the
// call or wrap it in a capability test — i.e. to reshape the component so it
// stops asking the platform, which is the one thing this file exists to avoid.
//
// It is deliberately a `vi.fn`-able plain method rather than a recorder: a test
// that wants to observe the call spies on it (`vi.spyOn(Element.prototype,
// "scrollIntoView")`) and gets both the arguments and a per-test reset.
//
// FIDELITY LIMIT: it scrolls nothing, because there is nothing to scroll.
// `scrollTop`, `scrollY` and every rect stay at zero afterwards, so "the column
// is now visible" is not observable here — only that the shell asked for it.
// Whether the CSS actually leaves somewhere to scroll TO is pinned as a rule in
// the stylesheet scan, not here.
Element.prototype.scrollIntoView = function scrollIntoView(): void {};

// ---------------------------------------------------------------------------
// document.visibilityState
// ---------------------------------------------------------------------------
//
// jsdom's `visibilityState` is a read-only accessor pinned to "visible", and
// both `DataVersionWatcher` and `useSidecarStatus` branch on it at mount and on
// every `visibilitychange`. Redefining it on the document instance is what lets
// a test mount into a hidden tab at all.

/** Set the reported visibility WITHOUT firing an event (for state at mount). */
export function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  // `document.hidden` is the other half of the same fact, and jsdom pins it to
  // `false` independently. Both components under test happen to read
  // `visibilityState`, so leaving this behind would pass today and quietly
  // assert nothing the moment a component reads the equally idiomatic
  // `document.hidden` — a "does not poll while hidden" test that never puts the
  // tab in the background.
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => state !== "visible",
  });
}

/** Set the reported visibility AND fire `visibilitychange`, as a browser does. */
export function fireVisibilityChange(state: DocumentVisibilityState): void {
  setVisibilityState(state);
  document.dispatchEvent(new Event("visibilitychange"));
}
