/**
 * The Workbench's URL rules (DW-27) — which mode a location names, which mode
 * wins on load, and what href the shell should be sitting on.
 *
 * Pure and client-safe, exactly like `workbench-modes.ts` and
 * `workbench-split.ts`: the shell imports it in the browser and the node suite
 * imports it to EXECUTE these rules. Nothing here touches `window` — the caller
 * hands in a `{ pathname, search, hash }`, which `window.location` already is
 * structurally — so the module can be imported on the server and the whole rule
 * can be run in an environment that has no DOM. A precedence typed into the
 * mount effect instead could only ever be grepped for.
 *
 * TWO things go in the URL: the active mode (`?mode=`, DW-27) and whether the
 * Settings SURFACE is open over it (`?settings=1`, DW-167). Settings is a
 * surface, never a mode value — the mode underneath it is still named, so
 * closing Settings has somewhere to land, and
 * `readModeFromSearch("?mode=settings")` stays `null`.
 *
 * Both param KEYS are named here — `WORKBENCH_MODE_PARAM` and
 * `WORKBENCH_SETTINGS_PARAM` — and {@link surfaceHref} is the only thing that
 * assembles a query string from them, which is what the shell calls. The one
 * other query in this file is {@link KNOWLEDGE_TREE_HREF}, a static literal that
 * interpolates `WORKBENCH_MODE_PARAM` directly rather than routing through the
 * builder: it names a fixed destination for copy and `href`s, has no location to
 * merge into, and `retired-surfaces.test.ts` pins it back through
 * `readModeFromSearch` so a renamed param cannot leave it spelling a dead route.
 *
 * The tree tab, the selection, the collapse flag and the column widths stay
 * browser-local in `workbench-state.ts` and are deliberately NOT here: DW-27 is
 * about linking and bookmarking a surface, and about Back returning to one, not
 * about serialising the layout. Settings crossed that line for one reason the
 * others do not share — with the surface missing from the URL a copied link
 * reopened the canvas underneath it, and Back on the first entry left the app
 * holding an unsaved Settings draft.
 *
 * NOR IS THE SETTINGS CATEGORY. `?settings=1` names the SURFACE, not which pane
 * it opens on: a copied link reopens Settings on `DEFAULT_SETTINGS_CATEGORY`,
 * whatever the sender was reading. Same boundary as the tree tab one column
 * over — a pane is a position inside a surface, and the shell links to surfaces.
 * (It is also the one param whose value the flag deliberately does not carry, so
 * the flag has exactly one accepted spelling; see {@link readSettingsFromSearch}.)
 *
 * Settings is also the one thing here with no stored counterpart: there is no
 * Settings preference in `workbench-state.ts` and there must not be one, because
 * a reload must not land the owner in a form they have no context for. The param
 * is the whole of its persistence, which is why a restore from it is silent.
 *
 * There is no second validator here: `isWorkbenchModeId` already narrows an
 * untrusted string (it is what the localStorage read uses), and a query param is
 * exactly as untrusted as a hand-edited storage value.
 */

import { isWorkbenchModeId, type WorkbenchModeId } from "@/lib/workbench-modes";

/** The query key the active mode is mirrored into. */
export const WORKBENCH_MODE_PARAM = "mode";

/**
 * The query key the open Settings surface is mirrored into (DW-167).
 *
 * A SEPARATE param rather than a `mode` value: `?mode=settings` would destroy
 * the mode underneath the surface, so closing Settings would have nowhere to
 * land, and `isWorkbenchModeId` narrows it to `null` anyway
 * (`workbench-url.test.ts`).
 */
export const WORKBENCH_SETTINGS_PARAM = "settings";

/**
 * The ONE spelling that means "open". Written by {@link surfaceHref} and the
 * only value {@link readSettingsFromSearch} accepts, so the flag has exactly one
 * form in an address bar and a hand-edited `?settings=true` is simply not it.
 */
const SETTINGS_ON = "1";

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
 * The href guarantees the SURFACE, not the tab. It names Wiki mode with Settings
 * closed — the two things the URL carries — while which tree tab is showing and
 * whether the left column is collapsed are per-browser values in
 * `workbench-state.ts`
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
 * Is the Settings surface open on this search string?
 *
 * ONE accepted spelling — `settings=1`, {@link SETTINGS_ON}. Absent, empty,
 * `0`, `yes`, `true` and anything else are all `false`, for the same reason
 * {@link readModeFromSearch} collapses its three misses into `null`: the
 * caller's next move is identical in every case, and a flag with several
 * spellings is a flag whose writer and reader can drift apart.
 *
 * There is no storage fallback to reach for here — Settings is deliberately not
 * a stored preference — so this answers from the URL alone.
 */
export function readSettingsFromSearch(search: string): boolean {
  return new URLSearchParams(search).get(WORKBENCH_SETTINGS_PARAM) === SETTINGS_ON;
}

/**
 * The same location with `mode` set to `mode` and the Settings flag SET or
 * DELETED. Every other param keeps its VALUE and its position; the query string
 * itself is NORMALIZED.
 *
 * ONE builder for both params, not two chained ones: the shell compares this
 * against {@link locationHref} to decide whether a history write is needed at
 * all, and two builders would give it two answers to reconcile — plus a window
 * in which the URL named a surface that was half applied.
 *
 * The flag is DELETED when Settings is closed rather than written `settings=0`.
 * A closed surface is the ordinary state, so the ordinary URL is the one without
 * it; `?mode=chat&settings=0` would also make the closed state two strings
 * instead of one and break the fixed point below.
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
export function surfaceHref(
  loc: WorkbenchLocation,
  mode: WorkbenchModeId,
  settingsOpen: boolean,
): string {
  const params = new URLSearchParams(loc.search);
  params.set(WORKBENCH_MODE_PARAM, mode);
  if (settingsOpen) params.set(WORKBENCH_SETTINGS_PARAM, SETTINGS_ON);
  else params.delete(WORKBENCH_SETTINGS_PARAM);
  return `${loc.pathname}?${params.toString()}${loc.hash}`;
}
