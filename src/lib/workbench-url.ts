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
 * ONE READER PER PARAM, and this module is where a client query read BELONGS
 * (DW-166) — a direction for the next one, NOT a claim about the tree it ships
 * in. What is actually true and enforced today is narrower: this module holds
 * the shell's own params AND the graph canvas's lens (`?scope=`, read by
 * {@link readScopeFromSearch}), and `retired-surfaces.test.ts` pins
 * `src/app/wiki/graph/page.tsx` to that reader — it must name it, and must
 * carry no `new URLSearchParams(` of its own.
 *
 * The graph page earned that pin because it had hand-rolled its own read under
 * the very rationale this module exists for — reading `window.location`
 * directly to avoid the `useSearchParams` client-rendering bailout — so the
 * repo carried two conventions for one job with neither referencing the other.
 *
 * OTHER HAND-ROLLED READS ARE STILL OUT THERE, and pretending otherwise would
 * make this paragraph the third convention. `src/app/query/page.tsx:136` is the
 * graph page's TWIN — the same expression under the same comment, for the same
 * `?scope=` — and `:154-159` reads `q`, `ask` and `scope` again a few lines
 * down; `ActionInbox.tsx:105` reads `source`, `ReviewDesk.tsx:158` reads
 * `proposal`, and `useChatConversations.ts:144` reads `conversation`. None of
 * them was in DW-166's scope, which named the graph page's call site alone.
 *
 * The `/query` twin is the outstanding one, and it is a behaviour question
 * rather than a move: it reads the same key as the graph lens but misses to a
 * DIFFERENT default (the public commons, not `mine`), so the reader is
 * shareable and the fallback is not — which is exactly the shape
 * {@link readScopeFromSearch} is already built for.
 *
 * A param whose vocabulary belongs to somewhere else still gets its reader
 * here; what it does NOT get here is a validator (see the bottom of this
 * comment).
 *
 * THREE things go in the URL for the shell: the active mode (`?mode=`, DW-27),
 * whether the Settings SURFACE is open over it (`?settings=1`, DW-167), and
 * which PANE that surface is open on (`?category=`, DW-514). Settings is a
 * surface, never a mode value — the mode underneath it is still named, so
 * closing Settings has somewhere to land, and
 * `readModeFromSearch("?mode=settings")` stays `null`.
 *
 * All three param KEYS are named here — `WORKBENCH_MODE_PARAM`,
 * `WORKBENCH_SETTINGS_PARAM` and `WORKBENCH_SETTINGS_CATEGORY_PARAM` — and
 * {@link surfaceHref} is the only thing that assembles a query string from
 * them, which is what the shell calls. The one other query in this file is
 * {@link KNOWLEDGE_TREE_HREF}, a static literal that
 * interpolates `WORKBENCH_MODE_PARAM` directly rather than routing through the
 * builder: it names a fixed destination for copy and `href`s, has no location to
 * merge into, and `retired-surfaces.test.ts` pins it back through
 * `readModeFromSearch` so a renamed param cannot leave it spelling a dead route.
 *
 * The tree tab, the selection, the collapse flag and the column widths stay
 * browser-local in `workbench-state.ts` and are deliberately NOT here: DW-27 is
 * about linking and bookmarking a surface, and about Back returning to one, not
 * about serialising the layout. None of them is announced, and putting any of
 * them here would turn an ordinary click into a history entry the owner has to
 * Back through. Settings crossed that line for one reason the others do not
 * share — with the surface missing from the URL a copied link reopened the
 * canvas underneath it, and Back on the first entry left the app holding an
 * unsaved Settings draft.
 *
 * THE SETTINGS CATEGORY IS, and that REVERSES what this header used to say
 * (DW-514). The old rule was "`?settings=1` names the SURFACE, not which pane it
 * opens on — same boundary as the tree tab one column over". What broke it is
 * that the pane is not silent the way a tree tab is: the shell's live region
 * announces `settingsAnnouncement(settingsCategory(id).label)` — "Settings,
 * Embeddings" — so a link copied off that surface reopened on
 * `DEFAULT_SETTINGS_CATEGORY` while the sentence the sender had just heard
 * named a different pane. The address bar and the announced surface have to
 * agree, and the pane is the one position-inside-a-surface the shell says out
 * loud.
 *
 * It follows the FLAG's rules exactly, not the mode's: written only when the
 * surface is open on a NON-DEFAULT pane, and deleted whenever the surface is
 * closed. The default pane is the ordinary state for the same reason a closed
 * surface is, so the ordinary URL is the one without the param — which is what
 * keeps `?mode=chat&settings=1` (a string several suites pin) meaning exactly
 * what it has always meant, and keeps {@link surfaceHref} a fixed point.
 *
 * The FLAG still has exactly one accepted spelling and deliberately does not
 * carry the pane as its value (see {@link readSettingsFromSearch}); the pane is
 * a separate key, so a hand-edited `?category=nope` degrades to the default
 * rather than closing the surface.
 *
 * Settings is also the one thing here with no stored counterpart: there is no
 * Settings preference in `workbench-state.ts` and there must not be one, because
 * a reload must not land the owner in a form they have no context for. The param
 * is the whole of its persistence, which is why a restore from it is silent.
 *
 * NO VALIDATOR IS WRITTEN HERE. A query param is exactly as untrusted as a
 * hand-edited storage value, and the narrower for each vocabulary already lives
 * in the module that owns it: `isWorkbenchModeId` in `workbench-modes.ts` (it
 * is what the localStorage read uses) and `isSettingsCategoryId` in
 * `workbench-settings.ts`. Restating either list beside its reader would be a
 * second copy that nothing forces to agree with the first.
 *
 * That second narrower COSTS something, and it is recorded rather than
 * discovered later. `isSettingsCategoryId` and `DEFAULT_SETTINGS_CATEGORY` are
 * runtime values, not types, so the import cannot be erased — every importer of
 * this module now pulls `workbench-settings.ts` in with it, and that module's
 * own chain (`providers`, `v1-contract`, `workbench-request`,
 * `write-precondition`) behind it. The graph page previously inherited only
 * `workbench-modes.ts`. Paid deliberately: all of it is client-safe by its own
 * header, none of it runs at import time, and the alternative — the category
 * list restated beside its reader — is the drift this module's whole "one
 * definition" posture exists to prevent. If the weight ever matters, the move
 * is to split the vocabulary out of `workbench-settings.ts`, not to copy it.
 *
 * {@link readScopeFromSearch} narrows NOTHING, and that is the same rule rather
 * than an exception to it: a lens is an owner handle or a vault id, so the
 * vocabulary is the DEPLOYMENT's and no client can enumerate it. There is no
 * module here that owns the list, which is precisely why no narrower belongs
 * here — the routes the value reaches (`/api/wiki/graph`, and `/query`'s own)
 * each gate what they will answer for. A client-side guess would be a validator
 * with no owner, rejecting a legitimate link on the way to a route that would
 * have declined it correctly anyway.
 */

import {
  DEFAULT_SETTINGS_CATEGORY,
  isSettingsCategoryId,
  type SettingsCategoryId,
} from "@/lib/workbench-settings";
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
 * The query key the open Settings surface's PANE is mirrored into (DW-514).
 *
 * A third key rather than a value on the flag: the flag has exactly one
 * accepted spelling ({@link SETTINGS_ON}) and giving it a payload would mean
 * `?settings=embeddings` had to be read as both "open" and "Embeddings", so a
 * hand-edited pane name would close the surface instead of degrading to the
 * default. Named `category` because that is what the vocabulary in
 * `workbench-settings.ts` calls it (`SettingsCategoryId`), and a URL that
 * spelled it something else would be a fourth name for one thing.
 */
export const WORKBENCH_SETTINGS_CATEGORY_PARAM = "category";

/**
 * The query key a graph LENS is read from (DW-166).
 *
 * Not a Workbench param — the shell never writes it, and no surface here is
 * built from it. It is not the graph page's private one either: `/query` reads
 * the same `?scope=` for the same kind of value, and defaults a miss to the
 * public commons where `/wiki/graph` defaults to `mine`. So the KEY is shared
 * and the fallback is each page's own, which is exactly why
 * {@link readScopeFromSearch} answers `null` on a miss rather than picking a
 * lens: the reader can be one, the default cannot.
 *
 * `/query` still hand-rolls its own read of it; see the header for why that is
 * outstanding rather than done.
 */
export const GRAPH_SCOPE_PARAM = "scope";

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
 * closed — and a closed surface carries no pane, so the mode is the whole of
 * what it needs to say — while which tree tab is showing and
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
 * Which Settings PANE this search string names, or `null` when it names none
 * (DW-514).
 *
 * The {@link readModeFromSearch} shape, for the same reason: absent, empty and
 * unknown collapse into one answer because the caller's next move is identical
 * in all three — fall back to `DEFAULT_SETTINGS_CATEGORY`. Narrowed through
 * `isSettingsCategoryId`, which is `workbench-settings.ts`'s, so the accepted
 * list has exactly one definition.
 *
 * It says nothing about whether the SURFACE is open. `?category=embeddings`
 * with no flag beside it is a stray param on a closed surface, and the caller —
 * not this reader — is what declines to act on it; keeping the two reads
 * independent is what lets the mount seed delete the stray in the same write
 * that names the mode.
 */
export function readSettingsCategoryFromSearch(search: string): SettingsCategoryId | null {
  const raw = new URLSearchParams(search).get(WORKBENCH_SETTINGS_CATEGORY_PARAM);
  return isSettingsCategoryId(raw) ? raw : null;
}

/**
 * The graph lens this search string names, or `null` when it names none
 * (DW-166).
 *
 * VALIDATES NOTHING, on purpose: a lens is `mine`, `vault:<id>` or
 * `owner:<handle>`, and the ids behind the last two are the deployment's, not a
 * list this module could hold. `/api/wiki/graph` already gates what it will
 * answer for, so a second guess here would reject a legitimate link on the way
 * to a route that would have declined it correctly anyway.
 *
 * Absent and EMPTY collapse to `null` together — `?scope=` is not a lens — so
 * the graph page's one `?? "mine"` covers every miss, exactly as the hand-rolled
 * read it replaces did with `|| undefined`. The fallback stays at the CALL SITE
 * because it is not shared: `/query` reads the same key and misses to the public
 * commons instead (see {@link GRAPH_SCOPE_PARAM}).
 */
export function readScopeFromSearch(search: string): string | null {
  return new URLSearchParams(search).get(GRAPH_SCOPE_PARAM) || null;
}

/**
 * The same location with `mode` set to `mode`, the Settings flag SET or DELETED,
 * and the Settings PANE set or deleted with it. Every other param keeps its
 * VALUE and its position; the query string itself is NORMALIZED.
 *
 * ONE builder for all three params, not three chained ones: the shell compares
 * this against {@link locationHref} to decide whether a history write is needed
 * at all, and separate builders would give it several answers to reconcile —
 * plus a window in which the URL named a surface that was half applied.
 *
 * The flag is DELETED when Settings is closed rather than written `settings=0`.
 * A closed surface is the ordinary state, so the ordinary URL is the one without
 * it; `?mode=chat&settings=0` would also make the closed state two strings
 * instead of one and break the fixed point below.
 *
 * The PANE follows that rule twice over (DW-514): omitted at
 * `DEFAULT_SETTINGS_CATEGORY`, because the default pane is the ordinary state
 * the same way a closed surface is, and deleted outright whenever the surface is
 * closed, because a pane of a surface that is not showing is not a state the
 * shell can be in. Both branches are deterministic, so the fixed point survives.
 *
 * `settingsCategory` is REQUIRED rather than defaulted: every call site is
 * looking at a live pane, and a default would let a new one silently drop the
 * owner's back to General while the surface stayed open on something else.
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
  settingsCategory: SettingsCategoryId,
): string {
  const params = new URLSearchParams(loc.search);
  params.set(WORKBENCH_MODE_PARAM, mode);
  if (settingsOpen) {
    params.set(WORKBENCH_SETTINGS_PARAM, SETTINGS_ON);
    // The default pane is the ordinary state, so the ordinary URL is the one
    // without the param — the flag's own rule one line up, applied a level in.
    // Writing `category=general` instead would give `?mode=chat&settings=1` a
    // second spelling and cost the fixed point the comparison above depends on.
    if (settingsCategory === DEFAULT_SETTINGS_CATEGORY) {
      params.delete(WORKBENCH_SETTINGS_CATEGORY_PARAM);
    } else {
      params.set(WORKBENCH_SETTINGS_CATEGORY_PARAM, settingsCategory);
    }
  } else {
    params.delete(WORKBENCH_SETTINGS_PARAM);
    // A pane with no surface open over it is not a state — so a closed surface
    // takes the stray with it, in the SAME write. Two params, one moment: there
    // is never a URL naming a pane of a surface that is not showing.
    params.delete(WORKBENCH_SETTINGS_CATEGORY_PARAM);
  }
  return `${loc.pathname}?${params.toString()}${loc.hash}`;
}
