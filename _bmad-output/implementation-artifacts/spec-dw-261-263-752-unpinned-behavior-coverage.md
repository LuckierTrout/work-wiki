---
title: 'Pin the shell head, ChatWorkspace save outcomes, and the /api/v1 file-door slug gates'
type: 'chore'
created: '2026-09-05'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      ChatWorkspace's saveAnswer clears the saved banner but never clears the
      error alert, so a save that succeeds after one that failed renders the
      unconfirmed sentence directly above its own "Saved as" banner.
    evidence: |-
      `saveAnswer` (src/components/ChatWorkspace.tsx:246-271) opens with
      `setSavedMessage(null)` and has no matching `setError(null)`; nothing else
      on this surface clears `error` except `openConversation`. Both blocks
      render unconditionally at :296-299, so the owner sees a red "Nothing came
      back to confirm whether the attempt to save the answer went through" beside
      a green "Saved as <slug>" for the write that just succeeded. Surfaced by
      this run's review; not named by DW-263, which covers only the two failure
      branches themselves. Production behaviour, so out of scope for a
      tests-only bundle.
    location: >-
      src/components/ChatWorkspace.tsx:248
    severity: low
baseline_revision: 'f1535257ca159f78398d948cc2d6e99829afd47a'
---

<intent-contract>

## Intent

**Problem:** Three shipped behaviours are unobserved. `src/app/layout.tsx`'s `metadata` export and its pre-paint theme script are guarded only by `readFile` source regexes, so deleting either leaves the suite green; `ChatWorkspace.saveAnswer`'s slug-less-response and rejection branches have no test at all (every `/api/query/save` stub in the suite is ok-with-slug); and the two `/api/v1` file doors assert their `v1SlugGate` forward with `expect.anything()` or not at all, so both could stop applying the caller's slug gate with a green suite.

**Approach:** Add data assertions on the exported `metadata` object and execute the head-injected theme script under three `localStorage` states in the suite that already mounts the layout; add a focused ChatWorkspace suite covering the two untested save outcomes; and replace the wildcard gate assertions in `epic8-v1-routes.test.ts` with `expect.objectContaining` on a derived `readableSlugs`/`hiddenSlugs` pair, matching the shape the rescan door already uses.

## Boundaries & Constraints

**Always:** Tests only — no production behaviour changes. Assert the derived gate against a NON-EMPTY listing, so a route hardcoding `readableSlugs: new Set(), hiddenSlugs: new Set()` fails. Reach the theme script through the `<script>` the mounted layout injects into `document.head`, so deleting the injection fails the test. Follow each file's existing harness conventions (`cleanup()` first in `afterEach`, `fireEvent` over raw DOM clicks, route-table `fetch` stub).

**Block If:** The layout's theme script or metadata export would have to be restructured to be reachable from a test — that is a production change this spec does not authorize.

**Never:** Do not export new symbols from `src/app/layout.tsx` (Next rejects unknown Layout export fields at build type-check). Do not change `src/lib/v1-route.ts`, either `/api/v1` route file, or `src/components/ChatWorkspace.tsx`. Do not edit the deferred-work ledger. Do not add save-outcome cases to `owner-scoped-anchors.test.tsx`, whose subject is anchors.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Theme chosen | `localStorage.theme = "dark"` | `document.documentElement` gains `dark`, not `light` | No error expected |
| Theme unset | no `theme` key | `documentElement` gains `light`, not `dark` | No error expected |
| Storage denied | `localStorage.getItem` throws | script swallows it; neither class added; no throw escapes | `try/catch` in the script |
| Save returns no slug | `/api/query/save` → `{}` | no "Saved as" banner renders | No error expected |
| Save rejects | `/api/query/save` throws a `TypeError` | error alert carries `unconfirmedWriteMessage("save the answer")`; no banner | `writeFailure` |
| Files door | `listReadableWikiPages` → agent-scoped + plain page | `listWorkbenchFilePaths` 3rd arg contains the derived pair | No error expected |
| Content door | same listing, in-scope text path | `readWorkbenchFile` 4th arg contains the derived pair | No error expected |

</intent-contract>

## Code Map

- `src/app/layout.tsx:36-52` -- the `metadata` export (metadataBase, title default/template, description, openGraph, twitter); values come from `APP_NAME`/`APP_ORIGIN`/`APP_TITLE` in `src/lib/brand.ts`. READ-ONLY here.
- `src/app/layout.tsx:54-67` -- `themeScript`, a module-local const injected at `:109` as `<script dangerouslySetInnerHTML>` inside `<head>`. NOT exported, and must not become one. Verified: mounting `RootLayout` renders exactly one `<script>` into the real `document.head`, and its `textContent` is the script source — that is the seam.
- `src/app/__tests__/app-shell.test.tsx` -- the suite that already mounts the layout (mocks `next/navigation`, `next/font/google`, `posthog-js`, Clerk). `mountLayout()` currently lives inside `describe("RootLayout, mounted")` at :238; hoist it to the Harness section so a new describe can use it. `afterEach` runs `cleanup()` first, then unstubs.
- `vitest.setup.dom.ts:421-494` -- `localStorage` is a shared `MemoryStorage` instance defined on both `window` and `globalThis`, cleared by `resetDomStorage()` in the setup file's `afterEach`. Spying on `window.localStorage.getItem` therefore also affects the script's free `localStorage` reference.
- `src/components/ChatWorkspace.tsx:246-271` -- `saveAnswer`: `json()` maps an unparseable-but-ok body to `{}`, so `result.slug ? … : null` keeps the banner hidden; the `catch` sets `writeFailure(reason, "save the answer").message`. Banner and alert render at `:296-299` via `<Alert>` (a plain `div`, no role — assert on text).
- `src/lib/workbench-request.ts:239-320` -- `unconfirmedCause` treats a `TypeError` as unconfirmed, so `writeFailure` answers `unconfirmedWriteMessage("save the answer")`. Import that helper rather than retyping the sentence.
- `src/components/__tests__/owner-scoped-anchors.test.tsx:120-410` -- the reuse model for the new ChatWorkspace suite: `ok()` helper, per-test `routes` table, `unexpected fetch` guard, `loadSlugTenants()` warm-up, and the `openThread()` mount-then-open sequence at :364-376. Do not add cases to this file.
- `src/hooks/useSlugTenants.ts` -- exports `loadSlugTenants` and `_resetSlugTenants`; `ChatWorkspace` reads `/api/wiki/routes` through it.
- `src/lib/__tests__/epic8-v1-routes.test.ts:222,229,256` -- the three `expect(listPaths).toHaveBeenCalledWith(..., expect.anything())` assertions, inside `describe("{id} resolution")`.
- `src/lib/__tests__/epic8-v1-routes.test.ts:380-417` -- the `files/content` cases that DO reach storage (`413s an oversize text file`, `404s a path the gate allowed`, `serves text with its byte count`); none inspects `readWorkbenchFile`'s 4th argument.
- `src/lib/__tests__/epic8-v1-routes.test.ts:886-936` -- the exemplar: the `entry()` helper (currently local to the rescan describe) and `expect(rescan).toHaveBeenCalledWith(expect.objectContaining({ hiddenSlugs: new Set(["agentpage"]), readableSlugs: new Set(["alpha"]) }))`. `@/lib/workbench-tree` is unmocked, so the real derivation runs; only `listReadableWikiPages` is stubbed (root `beforeEach` resets it to `[]` at :173).
- `src/lib/v1-route.ts:94-99` -- `v1SlugGate` = `listReadableWikiPages` → `buildKnowledgeTree` → `workbenchSlugGate`, returning the PAIR (DW-32). READ-ONLY.
- `src/app/api/v1/projects/[wikiId]/files/route.ts:42-46` -- spreads `{ ...slugGate, limit: V1_MAX_TREE_NODES }` as the 3rd arg to `listWorkbenchFilePaths`. READ-ONLY.
- `src/app/api/v1/projects/[wikiId]/files/content/route.ts:57-63` -- passes `slugGate` as the 4th arg to `readWorkbenchFile`. READ-ONLY.
- `vitest.config.ts` -- two projects: `.test.ts` → node, `.test.tsx` → jsdom under `src/**/__tests__/`. A new `.test.tsx` must live in a `__tests__` directory or config load throws.

## Tasks & Acceptance

**Execution:**
- `src/app/__tests__/app-shell.test.tsx` -- hoist `mountLayout()` (with its docblock) to the Harness section; add a describe asserting the exported `metadata` data (metadataBase href, title default + template, description, openGraph title/siteName/type, twitter card/title) against `APP_NAME`/`APP_ORIGIN`/`APP_TITLE`; add a describe that reads the injected `<head>` script and executes it via `new Function` under the three storage states -- DW-261: the metadata half needs no mount, and the script half must fail if the injection is deleted.
- `src/components/__tests__/chat-workspace-save-outcomes.test.tsx` -- new focused suite mounting `ChatWorkspace`, opening a thread, and clicking "Save to wiki" against a `{}` response (no banner) and a `TypeError`-throwing route (the unconfirmed sentence in an error alert, still no banner) -- DW-263: both branches are currently unexecuted.
- `src/lib/__tests__/epic8-v1-routes.test.ts` -- hoist `entry()` to module scope, add shared `GATED_ENTRIES` / `DERIVED_GATE` fixtures, seed the listing in `describe("{id} resolution")`, replace the three `expect.anything()` gate arguments with WHOLE-ARGUMENT `toHaveBeenCalledWith` on `{ ...DERIVED_GATE, limit: V1_MAX_TREE_NODES }` (NOT `expect.objectContaining`, which cannot compare `Set` members and is vacuous here -- see the first Spec Change Log entry), and add a `files/content` case asserting `readWorkbenchFile`'s 4th argument. Each door's gate assertion is paired with `expect(listReadable).toHaveBeenCalledWith(expect.objectContaining({ handle: "alice" }))`, because the listing stub ignores its argument and the pair alone cannot witness WHICH principal the gate was derived for -- DW-752: both file doors must forward the CALLER's derived pair.

**Acceptance Criteria:**
- Given the mounted layout, when the `<script>` React put in `document.head` is executed with `localStorage.theme` set to `dark`, unset, and with `getItem` throwing, then `document.documentElement` carries `dark`, `light`, and neither class respectively, and no case throws.
- Given `src/app/layout.tsx` with its `<script>` injection or its `metadata` fields removed, when the suite runs, then `app-shell.test.tsx` fails.
- Given a mounted `ChatWorkspace` with an open thread, when "Save to wiki" is clicked and `/api/query/save` answers `{}`, then no "Saved as" banner appears and no error alert appears.
- Given the same, when `/api/query/save` rejects with a `TypeError`, then the error alert shows `unconfirmedWriteMessage("save the answer")` and no banner appears.
- Given `listReadableWikiPages` returning one agent-scoped and one plain entry, when either `/api/v1` file door is called, then the gate argument it forwards contains `readableSlugs: new Set(["alpha"])` and `hiddenSlugs: new Set(["agentpage"])`.
- Given either route file's `slugGate` replaced by empty sets, when the suite runs, then `epic8-v1-routes.test.ts` fails.

## Spec Change Log

- **Gate assertions use the WHOLE argument, not `expect.objectContaining`.** The
  Approach named `expect.objectContaining` on the derived pair, "matching the
  shape the rescan door already uses". That matcher cannot carry this claim:
  `ObjectContaining.asymmetricMatch` compares each sampled property WITHOUT
  `iterableEquality`, and a `Set` has no own enumerable properties — so
  `objectContaining({ readableSlugs: new Set(["alpha"]) })` matches an EMPTY
  set. Verified on this vitest (3.2.4) by applying the spec's own mutation
  check: with `...slugGate` replaced by
  `{ readableSlugs: new Set(), hiddenSlugs: new Set() }` in both `/api/v1` file
  routes, every `objectContaining` gate assertion still passed. The named
  exemplar at `epic8-v1-routes.test.ts:886-936` (DW-537) was therefore ALSO
  vacuous, so the two rescan assertions were converted alongside the new ones.
  All six now assert the full call argument through `toHaveBeenCalledWith`,
  which does carry `iterableEquality` and compares set MEMBERS -- three
  `listPaths` calls in `{id} resolution`, one `readWorkbenchFile` call in
  `files/content`, and the two `rescan` calls. The Acceptance
  Criterion this serves — "Given either route file's `slugGate` replaced by
  empty sets, … `epic8-v1-routes.test.ts` fails" — now holds (4 failures);
  under the spec's literal wording it did not.
- **Each file door's gate assertion carries a PROVENANCE sibling.** `DERIVED_GATE`
  alone cannot witness DW-752: `listReadableWikiPages` is stubbed with a
  resolved value that ignores its argument, so the same pair comes back
  whichever principal `v1SlugGate` was handed. Demonstrated by replacing
  `v1SlugGate(caller.principal)` with `v1SlugGate({ id: "mallory", handle:
  "mallory" } as never)` in `files/route.ts`: 38/38 still green. Both file-door
  cases now also assert
  `expect(listReadable).toHaveBeenCalledWith(expect.objectContaining({ handle: "alice" }))`
  -- the sibling the rescan case already carried -- and each door's mutation now
  fails its own case.
- **A third ChatWorkspace case was added as a control.** The two specified cases
  are both NEGATIVE (no banner), and a negative assertion is only sound if the
  same settle point can observe a positive. `banners a saved answer` presses
  Save through the identical `clickSave()` helper against a slug-bearing
  response, so "nothing rendered" is distinguishable from "not yet rendered".
  No production behaviour is touched by it.

## Review Triage Log

### 2026-09-05 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 1, low 2)
- defer: 1: (high 0, medium 0, low 1)
- reject: 17: (high 0, medium 0, low 17)
- addressed_findings:
  - `[medium]` `[patch]` Neither file door's gate assertion observed WHICH principal the gate was derived for -- `listReadable`'s stub ignores its argument, so replacing `v1SlugGate(caller.principal)` with a hardcoded foreign principal left the suite 38/38 green. Added the rescan case's sibling `expect(listReadable).toHaveBeenCalledWith(expect.objectContaining({ handle: "alice" }))` to one `{id} resolution` case and to the new `files/content` gate case; each door's mutation now fails its own case (verified: both mutated => 2 failed / 36 passed, reverted => 38/38).
  - `[low]` `[patch]` The spec's `## Tasks & Acceptance` Execution bullet still prescribed `expect.objectContaining(DERIVED_GATE)` -- the form the Spec Change Log documents as vacuous over `Set` values. Rewritten to name whole-argument `toHaveBeenCalledWith` and cross-reference that entry. Nothing inside `<intent-contract>` was touched.
  - `[low]` `[patch]` The Spec Change Log undercounted the converted assertions as "five"; there are six (three `listPaths`, one `readWorkbenchFile`, two `rescan`). Corrected.

## Auto Run Result

Status: done

**Implemented change.** Tests only -- no production file differs from the baseline. Three shipped behaviours that were guarded by source scans, nothing at all, or wildcard matchers are now pinned by executable assertions.

**Files changed:**
- `../../src/app/__tests__/app-shell.test.tsx` -- hoisted `mountLayout()` to the harness; added a `metadata` data suite (metadataBase origin, title default + template, one description reused across OG/Twitter, card/siteName/type) and a theme-script suite that reads the `<script>` React injects into `document.head` and executes it under `theme=dark`, unset, and a throwing `getItem`; added `vi.restoreAllMocks()` to `afterEach` so the storage spy cannot leak.
- `../../src/components/__tests__/chat-workspace-save-outcomes.test.tsx` (new) -- mounts `ChatWorkspace`, opens a thread, and presses "Save to wiki" against a slug-bearing control, a `{}` body (no banner, no alert), and a `TypeError` rejection (the unconfirmed sentence, still no banner).
- `../../src/lib/__tests__/epic8-v1-routes.test.ts` -- hoisted `entry()` to module scope with shared `GATED_ENTRIES` / `DERIVED_GATE` fixtures, seeded a non-empty listing in `{id} resolution`, converted six gate assertions to whole-argument `toHaveBeenCalledWith`, added a `files/content` gate case, and paired both file doors' gate assertions with the principal-provenance assertion the rescan door already carried.

**Review findings breakdown:** 3 patches applied (1 medium, 2 low), 1 item deferred (low), 17 items rejected. 0 intent gaps, 0 bad-spec loopbacks.

**Follow-up review recommendation:** false. Patched findings by severity -- high 0, medium 1, low 2; score is `false` because no patched finding was high severity.

**Verification performed:**
- `npx vitest run src/app/__tests__/app-shell.test.tsx src/components/__tests__/chat-workspace-save-outcomes.test.tsx src/lib/__tests__/epic8-v1-routes.test.ts` -- 69 passed.
- `npx tsc --noEmit` -- exit 0, no output.
- `npx eslint` on the three files -- exit 0, no output.
- `npx vitest run` -- 389 files, 9805 passed, 1 skipped.
- Mutation checks, each reverted and re-verified clean: deleting the `<script>` injection from `layout.tsx` -> 3 failures; stripping `metadataBase` / the title template / `siteName` / `summary_large_image` -> 3 failures; `setSavedMessage(result)` plus a flat error sentence in `ChatWorkspace` -> 2 failures; empty `Set`s for `slugGate` in both `/api/v1` file routes -> 4 failures; a foreign principal handed to `v1SlugGate` in both file routes -> 2 failures.
- Independently confirmed the `expect.objectContaining` + `Set` vacuity on vitest 3.2.4 with a throwaway probe before accepting the deviation from the spec's Approach.

**Residual risks:**
- The suite mocks `@/lib/workbench-files`, so what these doors are pinned on is the FORWARDING of the derived pair, not the withholding itself; the withholding stays pinned only by `epic8-remediation.test.ts`'s direct calls.
- jsdom does not execute a script inserted through `dangerouslySetInnerHTML`, so the theme cases run the injected source through `new Function`. Both of its free references (`localStorage`, `document`) resolve to the same globals a browser would supply, but head-position/pre-paint ordering itself is not observed -- only that exactly one non-empty inline script is in `document.head`.
- `metadata.description` is pinned by substring and by equality across `openGraph`/`twitter`, not character-for-character, so the sentence after the tagline could still change unobserved.

## Verification

**Commands:**
- `npx vitest run src/app/__tests__/app-shell.test.tsx src/components/__tests__/chat-workspace-save-outcomes.test.tsx src/lib/__tests__/epic8-v1-routes.test.ts` -- expected: all pass.
- `npx tsc --noEmit` -- expected: no errors.
- `npx eslint src/app/__tests__/app-shell.test.tsx src/components/__tests__/chat-workspace-save-outcomes.test.tsx src/lib/__tests__/epic8-v1-routes.test.ts` -- expected: clean.
- `npx vitest run` -- expected: the full suite stays green.

**Manual checks (if no CLI):**
- Mutation check: temporarily replace `...slugGate` with `readableSlugs: new Set(), hiddenSlugs: new Set()` in both `/api/v1` file route files and confirm `epic8-v1-routes.test.ts` now fails; revert.
