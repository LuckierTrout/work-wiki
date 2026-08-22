/**
 * The Workbench's URL rules (DW-27) — which mode a location names, which mode
 * wins on load, and what href the shell should be sitting on.
 *
 * Pure and client-safe, exactly like `workbench-modes.ts` and
 * `workbench-split.ts`: the shell imports it in the browser and the node suite
 * imports it to EXECUTE these rules. Nothing here touches `window` — the caller
 * hands in a `{ pathname, search, hash }`, which `window.location` already is
 * structurally — so the module can be imported on the server and the whole rule
 * runs as a plain function in the `node` project. That is why the precedence
 * lives here rather than inside the mount effect: the `dom` project mounts the
 * shell, but the rule itself is executed directly, on its own, with a literal
 * location.
 *
 * The mode is the ONLY thing that goes in the URL. Settings, the tree tab, the
 * selection, the collapse flag and the column widths stay browser-local in
 * `workbench-state.ts` — DW-27 is about linking and bookmarking a mode, and
 * about Back returning to one, not about serialising the layout.
 *
 * There is no second validator here: `isWorkbenchModeId` already narrows an
 * untrusted string (it is what the localStorage read uses), and a query param is
 * exactly as untrusted as a hand-edited storage value.
 */

import { isWorkbenchModeId, type WorkbenchModeId } from "@/lib/workbench-modes";

/** The query key the active mode is mirrored into. */
export const WORKBENCH_MODE_PARAM = "mode";

/**
 * The mode the Knowledge tree lives in. Typed as a {@link WorkbenchModeId}, and
 * deliberately NOT `DEFAULT_WORKBENCH_MODE`: the tree is a property of Wiki mode
 * whatever mode the shell happens to open on by default.
 */
const KNOWLEDGE_TREE_MODE: WorkbenchModeId = "wiki";

/**
 * The href of the Workbench in Wiki mode — the surface whose left column
 * carries the Knowledge tree, the text list of the active Wiki's pages.
 *
 * The href guarantees the SURFACE, not the tab. By DW-27 the mode is the only
 * thing that goes in the URL: which tree tab is showing and whether the left
 * column is collapsed are per-browser values in `workbench-state.ts`
 * (`WORKBENCH_TREE_TAB_KEY`, `WORKBENCH_COLLAPSED_KEY`), so a first-time
 * visitor lands on the Knowledge tab (`DEFAULT_TREE_TAB`) while a returning
 * owner lands wherever they left off. Copy pointing here should name the
 * Knowledge tree as something this surface has, not promise a rendered list.
 *
 * This is the ONE place in `src/` that spells that route. Anything offering a
 * readable alternative to a visual surface — the graph canvas's `aria-label`
 * and its `<canvas>` fallback, for instance — imports this rather than writing
 * a path, because the previous hand-written target (`/wiki`) was retired into
 * `RETIRED_SURFACES` (`src/lib/retired.ts`) and quietly became a 404 that
 * only a screen-reader user would ever hit. `retired-surfaces.test.ts` pins
 * this constant's pathname against that same list, so the next retirement
 * fails a test instead.
 *
 * Built from {@link WORKBENCH_MODE_PARAM} and {@link KNOWLEDGE_TREE_MODE}, so
 * renaming either moves the href with it at compile time.
 */
export const KNOWLEDGE_TREE_HREF = `/?${WORKBENCH_MODE_PARAM}=${KNOWLEDGE_TREE_MODE}`;

/**
 * The parts of a location these rules read. `window.location` satisfies it
 * structurally, so the shell passes the real thing and the suite passes a
 * literal — one implementation, no adapter, and no DOM in the node project.
 */
export interface WorkbenchLocation {
  pathname: string;
  search: string;
  hash: string;
}

/**
 * The mode this search string names, or `null` when it names none.
 *
 * `null` covers all three ways that happens — the param is absent, empty, or
 * carries a value this build has no mode for — because the caller's answer is
 * the same in every case: fall back to storage. `URLSearchParams` accepts the
 * leading `?` and a bare string alike.
 */
export function readModeFromSearch(search: string): WorkbenchModeId | null {
  const raw = new URLSearchParams(search).get(WORKBENCH_MODE_PARAM);
  return isWorkbenchModeId(raw) ? raw : null;
}

/**
 * Which mode the shell should be in, given a location and what storage
 * remembers.
 *
 * The URL WINS. A deep link is an explicit instruction from whoever followed it;
 * the stored mode is a preference from an earlier session, and letting it
 * override the link would make `?mode=chat` unlinkable for anyone who had ever
 * used another mode. `stored` is already `readStoredMode()`'s answer, so it has
 * had its own fallback to `DEFAULT_WORKBENCH_MODE` applied — which is why this
 * takes a mode rather than a nullable one and needs no third branch.
 *
 * This is the rule for LOAD and for `popstate` both: a traversal lands on an
 * entry the same way a fresh load lands on a URL, so one function answers both
 * and the two can never drift.
 */
export function initialMode(search: string, stored: WorkbenchModeId): WorkbenchModeId {
  return readModeFromSearch(search) ?? stored;
}

/** The href a location currently is — path, query and fragment, as written. */
export function locationHref(loc: WorkbenchLocation): string {
  return `${loc.pathname}${loc.search}${loc.hash}`;
}

/**
 * The same location with `mode` set to `mode`. Every other param keeps its VALUE
 * and its position; the query string itself is NORMALIZED.
 *
 * Other params survive because they belong to other features (the Wiki id in
 * `?wiki=`, a future deep link into a mode), and the hash survives because it is
 * a scroll target the shell has no business discarding. `URLSearchParams.set`
 * updates an existing key IN PLACE, so a URL that already carries `mode` keeps
 * its param order and only the value moves.
 *
 * "Normalized" is `URLSearchParams.toString()`, which re-encodes rather than
 * echoing the input: `?q=a%20b` comes back as `?q=a+b`, a valueless `?flag` as
 * `?flag=`, and `?tags=x,y` as `?tags=x%2Cy`. Each of those parses back to the
 * same value, so nothing is lost — but they are different STRINGS, which has one
 * visible consequence: on such a URL the mount seed's `seeded !== locationHref`
 * comparison is true purely from the re-encoding, and the query string is
 * rewritten once on load even though the mode was already correct. A cosmetic
 * one-off `replaceState`, not a second history entry.
 *
 * Idempotent by construction, which is what lets the shell compare this against
 * `locationHref` and skip the history write when they already agree — the
 * comparison is only meaningful if applying the rule twice cannot produce a
 * third string. The normalization is what makes that true: it is a fixed point
 * after the first pass.
 */
export function modeHref(loc: WorkbenchLocation, mode: WorkbenchModeId): string {
  const params = new URLSearchParams(loc.search);
  params.set(WORKBENCH_MODE_PARAM, mode);
  return `${loc.pathname}?${params.toString()}${loc.hash}`;
}
