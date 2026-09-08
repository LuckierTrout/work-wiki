/**
 * The aliased door to the `dom` project's shim controls (DW-112).
 *
 * THIS FILE IMPLEMENTS NOTHING. Every shim — `window.matchMedia`, the declared
 * element rects, `offsetParent`, `getClientRects`, `scrollIntoView`,
 * `document.visibilityState`, and `localStorage`/`sessionStorage` — lives in
 * `vitest.setup.dom.ts`, which is the `dom` project's `setupFiles` entry and
 * the only place a shim may be defined.
 * All this module does is re-export the controls under `@/…` so a mounted suite
 * reaches them by one stable specifier instead of a `../../../..` ladder whose
 * length encodes the suite's own directory depth — a ladder that silently
 * resolves to the wrong module (or to nothing) the moment a file moves.
 *
 * It is a RE-EXPORT, not a copy, so both halves of the run share ONE module
 * instance: the setup file's `afterEach` resets the very registries a suite
 * writes through here, and `setMediaQuery`'s "nothing has observed this query"
 * guard still sees the observations the component under test made.
 *
 * Named `dom-helpers.ts`, not `*.test.ts(x)`: `vitest.config.ts` collects
 * `src/**\/__tests__/**\/*.test.ts` into the `node` project and
 * `src/**\/__tests__/**\/*.test.tsx` into the `dom` project, and its config-load
 * guard refuses any `*.test.tsx` sitting outside that include.
 */
export {
  setMediaQuery,
  resetMediaQueries,
  setElementRect,
  resetElementRects,
  setVisibilityState,
  fireVisibilityChange,
  resetDomStorage,
} from "../../vitest.setup.dom";
export type { DeclaredRect } from "../../vitest.setup.dom";
