---
title: 'Make three suites execute the premise they claim to test'
type: 'bugfix'
created: '2026-09-03'
baseline_revision: 'fe21a31cf0c412cf1494f10781b68a4e02ba3dc6'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      The two sibling /api/v1 file doors still assert their v1SlugGate forward with
      expect.anything(), so both could stop applying the caller's slug gate with a green suite.
    evidence: |-
      DW-537 is now pinned at the rescan door, but `v1SlugGate` returns a PAIR precisely so the
      three `/api/v1` doors cannot drift (DW-32). `files/route.ts:46` spreads
      `{ ...slugGate, limit: V1_MAX_TREE_NODES }` into `listWorkbenchFilePaths` and
      `files/content/route.ts:62` passes `slugGate` into `readWorkbenchFile`; the only tests that
      import either route module live in `src/lib/__tests__/epic8-v1-routes.test.ts`, and their
      assertions are `expect(listPaths).toHaveBeenCalledWith("alice", "wiki-1", expect.anything())`
      (l.207, l.214, l.241) with `readWorkbenchFile`'s gate argument never inspected at all
      (l.349, l.361). VERIFIED during this run's review: replacing `...slugGate` with
      `readableSlugs: new Set(), hiddenSlugs: new Set()` in BOTH route files leaves the suite at
      35/35 green. `epic8-remediation.test.ts` touches the two sets only by calling
      `workbench-files` directly, never through these routes. Consequence: the doors an agent
      actually talks to could serve a hidden page's `wiki/` paths and refuse nothing under `raw/`
      while the suite that exists to pin that contract stays green. Pre-existing: this bundle's
      ledger entry located DW-537 at the rescan route only. The fix shape is the one this run
      used one door over -- seed `listReadableWikiPages` with an `agent-knowledge` entry beside a
      plain one, then assert `expect.objectContaining({ hiddenSlugs, readableSlugs })` on what
      each door hands its lister/reader.
    location: >-
      src/lib/__tests__/epic8-v1-routes.test.ts:207 (and l.214, l.241, l.349, l.361)
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Three suites assert against a premise they never actually reach. (DW-581) The DW-26 mode-switch block in `wiki-canvas-persistence.test.tsx` clicks rail controls with a live Create Wiki backdrop on screen — the unreachable pointer path DW-511 removed from the Settings suite; in a browser those clicks land on the `z-[120]` overlay whose `onMouseDown` cancels the dialog, so the mode switch never happens and the draft the block exists to preserve is discarded. (DW-586) `stopTurn()` and the unmount effect abort `abortRef`, but no mounted test presses Stop or unmounts mid-turn, so nothing asserts an in-flight turn is really aborted now that the abort hop crosses into `chat-session-transport.ts`. (DW-537) `epic8-v1-routes.test.ts` mocks `rescanSources`, so nothing drives the rescan route's `v1SlugGate` → `hiddenSlugs` derivation through the POST door a real caller hits.

**Approach:** Re-route only the unreachable hop in each case and pin the premise executably. Reach Chat from an open dialog by BACK — browser chrome a modal neither covers nor traps — after seeding the mode entry while the rail is still reachable; keep the rail as the return control, which is reachable because the dialog is withdrawn by then. Add mounted Stop and unmount cases driving a signal-honouring gated stream. Assert the rescan route's derived gate on the arguments `rescanSources` actually receives, and pin its ordering against the route's own `raw/sources/` scope check.

## Boundaries & Constraints

**Always:** Keep every existing assertion in the four dialog-holding DW-26 cases intact — this changes how Chat is *reached*, not what is checked. Every new or reworded comment must say why the traversal is the opener rather than merely that it is. New test scaffolding must model what a real runtime does (a fetch body that errors on abort; a history entry a rail press really wrote), never a shortcut that fakes the outcome.

**Block If:** The Back traversal cannot reproduce the state an existing DW-26 assertion needs (no `popstate`, or the mode does not move) after one honest attempt to fix the seeding. Or aborting the gated stream does not propagate out of `runSidecarTurn` into `ChatCanvas`, meaning the abort hop is broken in product code rather than merely unpinned.

**Never:** Do not change `.wb-rail` stacking in `globals.css`, `CreateWikiDialog.tsx`, `ConfirmDialog.tsx`, `useDialogA11y.ts`, `Workbench.tsx`, `ChatCanvas.tsx`, `chat-session-transport.ts`, `source-rescan.ts`, or the rescan route — all three entries are located in tests and no product behaviour is wrong. Do not close or unmount a dialog to make the rail reachable. Do not extract a shared `traverse`/test-helper module: each suite carries its own documented copy, which is this repo's established convention. Do not unmock `@/lib/source-rescan` for the whole `epic8-v1-routes` suite. Do not add a new `.test.tsx` file for DW-586.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Seed then Back to Chat | Shell mounted in Wiki; rail Chat then rail Wiki pressed (no dialog open); Create Wiki dialog opened; `history.back()` | `popstate` applies `mode=chat`, `.wb-canvas-mode` goes `hidden` with the dialog and its draft inside it, focus is not moved | `traverse` rejects if no `popstate` within 1000ms |
| Rail returns to Wiki | Chat showing over the withdrawn canvas, no backdrop on screen | `clickRail("Wiki")` re-shows the canvas, re-arms `useDialogA11y`, focuses the dialog container | No error expected |
| Backdrop pin | Create Wiki dialog open in the Wiki canvas | The dialog's overlay parent is `fixed inset-0 z-[N]`, does not contain `.wb-rail`, and `mouseDown` on it cancels the dialog | Level that will not parse fails the case |
| Stop mid-turn | Gated SSE turn streaming; `Stop` pressed | The signal handed to the sidecar POST is aborted, the stream errors with `AbortError`, streaming ends, no error alert is shown | AbortError is swallowed by `sendTurn`, not surfaced |
| Unmount mid-turn | Gated SSE turn streaming; component unmounted | The same signal is aborted by the cleanup effect | No error expected |
| Hidden page → gate | `listReadableWikiPages` returns one `agent-knowledge` entry plus one plain entry; `POST .../sources/rescan` with no `paths` | `rescanSources` is called with `hiddenSlugs` containing the agent-scoped slug and `readableSlugs` containing only the plain one | No error expected |
| Scope check precedes the gate | Same seed; `paths: ["wiki/alpha.md"]` | 403 `file_out_of_scope`; `rescanSources` never called and `listReadableWikiPages` never called | No error expected |

</intent-contract>

## Code Map

- `src/components/workbench/__tests__/wiki-canvas-persistence.test.tsx` (372 lines) -- DW-581's only target. `rail(label)` ~l.107; `openCreateWith` ~l.136; `clickRail` ~l.143. The DW-26 `describe` starts ~l.150. FOUR dialog-holding cases drive Chat with a live backdrop and must be re-routed: "keeps the typed name and the shown error across Chat and back" (`fireEvent.click(rail("Chat"))` ~l.178), "is HIDDEN rather than unmounted while another mode is showing" (~l.198), "holds neither the body scroll lock nor the Tab trap while hidden" (~l.230), "keeps the opener across the hide…" (`clickRail("Chat")` ~l.274). The RETURN hops — `rail("Wiki")` ~l.183, ~l.250 and `clickRail("Wiki")` ~l.279 — stay: by then `.wb-canvas-mode` is `hidden`, the dialog is withdrawn and no backdrop is on screen, so the rail really is reachable (the same carve-out DW-511 kept for its closer). The last three cases ("never puts a second #wb-canvas", "shows exactly one surface heading", "labels the canvas") open NO dialog and are untouched. `readFile` + `path` are already imported (~l.2-3) and `path.resolve(__dirname, "../../../app/globals.css")` is this file's established stylesheet read (~l.339).
- `src/components/workbench/__tests__/settings-canvas-persistence.test.tsx` -- READ-ONLY reference for the shape only. `seedSettingsEntry` l.350 (guards "no dialog mounted yet", asserts each press really pushed via `window.history.length`), `openFromHistory` l.401, `traverse` l.422, and the pin block `"the rail is not an opener while a dialog backdrop is on screen (DW-511)"` l.1377 — whose `backdropLevelOver` helper and `mouseDown`-cancels-the-dialog assertion are the "executable backdrop pin" this entry copies in miniature. Its full `globals.css` rail-family stacking scan stays THERE and is cross-referenced, not duplicated.
- `src/components/workbench/__tests__/workbench-mode-url.test.tsx:206-235` -- READ-ONLY. The second local `traverse` copy; confirms per-suite duplication with a cross-referencing docblock is the convention, not a shared module.
- `src/components/workbench/Workbench.tsx` -- READ-ONLY. `pushSurface` l.751 writes one entry only when the href changes; `selectMode` l.766 = `applyMode` + `pushSurface(next,false)`, so each rail mode press pushes one entry; the `popstate` listener l.786-818 re-applies mode+settings, returns early when NEITHER moved, and bumps `canvasFocusNonce` only when the *settings* flag moved — so a mode-only traversal moves no focus at all, which is what makes "hiding must not move focus" observable across it. The mount seed (l.479) uses `replaceState`. History for a seeded case is `[?mode=wiki] → [?mode=chat] → [?mode=wiki]`.
- `src/components/workbench/ChatCanvas.tsx` -- READ-ONLY. `abortRef` l.153; unmount cleanup l.213-217; `stopTurn()` l.278; `driveTurn` l.523 creates the controller and forwards `controller.signal` to `runSidecarTurn` l.527; `sendTurn`'s catch l.494-500 calls `clearOptimistic()` then returns silently on `AbortError` (no `setError`), and its `finally` clears `streaming`. The `Stop` button renders at l.1230-1232 while `streaming`.
- `src/lib/chat-session-transport.ts:156-190` -- READ-ONLY. `runSidecarTurn` passes `signal` to `loopbackFetch` and then reads `response.body`; an abort is only observable if the stubbed body errors, which is what a real fetch body does.
- `src/components/workbench/__tests__/chat-live-stream.test.tsx` (174 lines) -- DW-586's target: DW-444's own mounted file, already scaffolded for a mid-flight turn. `gatedTurn()` l.75-96 builds the held-open SSE body; the `fetch` stub l.127-137 routes `/chat` to it; `afterEach` l.139 releases the gate. Needs: the stream controller exposed so the body can be errored, and the `/chat` `init.signal` captured.
- `src/lib/__tests__/epic8-v1-routes.test.ts` (888 lines) -- DW-537's target. `vi.mock("@/lib/source-rescan")` l.52-55 is PARTIAL (spreads orig, replaces `rescanSources` only). `@/lib/wiki` l.36-43 is partial too and already exposes `listReadableWikiPages: vi.fn(async () => [])` — the seam that feeds `v1SlugGate`. `@/lib/workbench-tree` is NOT mocked, so `buildKnowledgeTree` → `workbenchSlugGate` runs for real. `const rescan = vi.mocked(rescanSources)` l.124; `beforeEach` l.145-160 resets it; `send()` l.138; `params()` l.132. The `describe("sources/rescan")` block is l.796-888; its "403s a path outside raw/" case l.822 already asserts `rescan` was never called.
- `src/app/api/v1/projects/[wikiId]/sources/rescan/route.ts` -- READ-ONLY. Path scope check l.75-82 (`isV1FileInScope` + `!path.startsWith("raw/sources/")` → 403) runs BEFORE `const slugGate = await v1SlugGate(caller.principal)` l.90 and its spread into `rescanSources` l.91-98. That ordering is the composition DW-537 asks to pin.
- `src/lib/v1-route.ts:94-99` -- READ-ONLY. `v1SlugGate` = `listReadableWikiPages(principal)` → `workbenchSlugGate(entries, buildKnowledgeTree(entries))`.
- `src/lib/workbench-tree.ts:653-682, 890-900` -- READ-ONLY. `buildKnowledgeTree` skips `isAgentScopedType(entry.type)` (any `agent-` prefix, `page-types.ts:21`), so an `agent-knowledge` entry lands in `hiddenSlugs` and nothing else does. `src/lib/__tests__/assets-route.test.ts:47-56, 156-176` is the READ-ONLY precedent for seeding exactly that entry shape.
- Test runner: `node_modules/vitest/vitest.mjs` under Node 22 (`~/.nvm/versions/node/v22.16.0/bin/node`). This machine's default Node 26.8.1 fails the whole `dom` project at `window.localStorage.clear()` on an unmodified baseline; CI pins Node 22.

## Tasks & Acceptance

**Execution:**
- `src/components/workbench/__tests__/wiki-canvas-persistence.test.tsx` -- add a local `traverse(go)` (1000ms `popstate` deadline, docblock cross-referencing `workbench-mode-url.test.tsx`'s copy) and `seedChatEntry()` (press rail Chat then rail Wiki while no dialog is mounted; guard with an assertion that no `[role="dialog"][aria-modal="true"]` exists; assert each press moved `?mode=` and that `window.history.length` grew by two), plus `showChat()` (`await traverse(() => window.history.back())`, then assert the landed entry names `mode=chat` and that Chat is showing). -- The rail is reachable only while no backdrop is on screen; seeding first is the one ordering in which every press a real owner could make is a press this file makes.
- `src/components/workbench/__tests__/wiki-canvas-persistence.test.tsx` -- in the four dialog-holding cases, call `await seedChatEntry()` immediately after `renderShell(...)` and before the dialog opens, and replace each Chat hop with `await showChat()`. In "keeps the opener across the hide", capture `document.activeElement` before the traversal and assert it is unchanged after — and, specifically, is not the opener — replacing the assertion that focus sits on the clicked Chat rail control. -- Same state, same contract ("hiding must not move focus", "hiding must not restore to a withdrawn opener"), reached by the one route this state leaves open; the return `clickRail("Wiki")` still moves focus to the rail first, so the re-arm assertion after it stays meaningful.
- `src/components/workbench/__tests__/wiki-canvas-persistence.test.tsx` -- rewrite the DW-26 block's docblock (and the file header where it describes "a real rail click") to name BACK as the opener and state both halves of the refusal: the pointer half (the dialog's `fixed inset-0 z-[120]` backdrop covers a rail that declares no `z-index`) and the keyboard half (`aria-modal` inertness plus `useDialogA11y`'s Tab trap). Say that the rail remains the RETURN control and why that press is reachable. -- The stale claim is the defect this entry is filed against; leaving it would resolve nothing.
- `src/components/workbench/__tests__/wiki-canvas-persistence.test.tsx` -- add one `it` pinning the refusal executably (DW-581): with the Create Wiki dialog open, its overlay parent carries `fixed`, `inset-0` and a parseable `z-[N]`, does not contain `.wb-rail`, and `fireEvent.mouseDown(overlay)` cancels the dialog — leaving Wiki still showing, proving the press never reached the rail. Cross-reference the Settings suite for the `globals.css` rail-family stacking scan rather than duplicating it, and state the jsdom coverage limit in this file's own COVERAGE LIMIT style. -- Prose alone did not stop this file from clicking through a live overlay for as long as it did.
- `src/components/workbench/__tests__/chat-live-stream.test.tsx` -- make `gatedTurn()` expose its stream controller so the body can be errored, capture the `/chat` request's `init.signal` in the `fetch` stub, and wire that signal's `abort` event to error the body with a `DOMException(…, "AbortError")` — what a real fetch body does. Guard the gate's later `enqueue`/`close` so releasing it after an error is inert. -- Aborting a controller the stub ignores would assert nothing about the hop; the signal has to reach the bytes.
- `src/components/workbench/__tests__/chat-live-stream.test.tsx` -- add a `describe` with two cases (DW-586): pressing `Stop` mid-turn aborts the captured signal, ends streaming (the `Stop` button goes away), drops the optimistic user bubble and shows NO error alert; and unmounting mid-turn aborts the same captured signal. Both assert the signal was un-aborted while the turn was live, so a stub that arrived pre-aborted could not pass. -- `stopTurn()` and the cleanup effect are the only callers of `abortRef.current.abort()` that a mounted surface can reach, and the transport suite only checks that *whatever* signal it is handed is forwarded.
- `src/lib/__tests__/epic8-v1-routes.test.ts` -- add two cases to `describe("sources/rescan")` (DW-537): seed `listReadableWikiPages` with one `agent-knowledge` entry and one plain entry, POST the rescan with no `paths`, and assert `rescanSources` received `hiddenSlugs` containing the agent-scoped slug (and only it) with `readableSlugs` containing only the plain one; and, with the same seed, assert that a `paths` entry outside `raw/sources/` 403s with `file_out_of_scope` while neither `rescanSources` nor `listReadableWikiPages` is called. Import `listReadableWikiPages` for `vi.mocked` and reset it in `beforeEach` to the empty default. -- DW-493 pinned the forward one level below the door; what a real caller hits is the route's own derivation and its ordering against the scope check, and the suite's stated contract is exactly this seam ("status codes, field names, clamps and gates — not storage").

**Acceptance Criteria:**
- Given the DW-26 block, when its source is searched, then no case drives a rail control while a dialog backdrop is on screen, and every remaining rail press happens either before the dialog opens or while `.wb-canvas-mode` is `hidden`.
- Given the re-routed DW-26 cases, when the suite runs, then all prior assertions still hold: the draft and the 409 error survive the round trip, the dialog is `hidden` rather than unmounted, the scroll lock and Tab trap stand down and re-arm, and Cancel returns focus to the opener.
- Given a mounted shell with the Create Wiki dialog open, when the new DW-581 pin runs, then a `mouseDown` on the overlay cancels the dialog and the case fails if the overlay ever stops being a full-viewport layer that excludes the rail.
- Given a live turn, when Stop is pressed or the component unmounts, then the signal `ChatCanvas` handed `runSidecarTurn` is aborted, and replacing `stopTurn`'s body or deleting the unmount effect's `abort()` fails exactly those cases.
- Given a hidden page in the readable listing, when the rescan route is POSTed, then `rescanSources` is called with a non-empty `hiddenSlugs`, and replacing `...slugGate` in the route with nothing fails that case.
- Given the whole change, when `vitest run` executes both projects, then it passes with no product source file modified (`git status --porcelain -- src` lists only the three test files).

## Spec Change Log

## Review Triage Log

### 2026-09-03 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 2, low 7)
- defer: 1: (high 0, medium 1, low 0)
- reject: 13: (high 0, medium 1, low 12)
- addressed_findings:
  - `[medium]` `[patch]` The rewrite deleted the repo's only assertion that a pressed MODE rail control keeps the keyboard across the canvas swap (`workbench-mode-url.test.tsx` covers the Settings-close direction only, and its mode-only traversal case asserts the opposite policy). Added a no-dialog case pressing a mode rail control and asserting focus lands on it — the positive control for why the traversal replacement was needed at all.
  - `[medium]` `[patch]` The outbound ordering had an executable guard (`seedChatEntry`'s dialog-null assertion) while the RETURN press's reachability was defended only in prose. Added `returnToWikiOnRail()`, the same guard pointed the other way: the mode canvas carries `hidden`, no dialog is reachable by role, and the still-mounted `aria-modal` node has a `[hidden]` ancestor — checked immediately before every return click.
  - `[low]` `[patch]` The DW-586 block header claimed `stopTurn()` and the unmount cleanup are the only two `abortRef.current.abort()` call sites; there are four (`ChatCanvas.tsx:216`, `:279`, `:283`, `:321`). Corrected, naming the two this entry covers and stating that the other two stay uncovered mounted.
  - `[low]` `[patch]` `log()`'s docblock justified scoping away from the composer with "`onSend` puts the draft back", which nothing asserted. The Stop case now reads the composer back and expects the question restored.
  - `[low]` `[patch]` `seedChatEntry` said "`beforeEach` only rewrites the CURRENT entry"; this file's `beforeEach` pushes `/` and then rewrites it, so it adds one. Mechanism corrected, guard unchanged.
  - `[low]` `[patch]` The `traverse` docblock claimed three suites "cross-reference each other"; `workbench-mode-url.test.tsx` references nobody. Reworded to what is true of this copy.
  - `[low]` `[patch]` The focus case's outcome (activeElement left inside the `[hidden]` subtree) is a jsdom artifact — a browser applies the `display: none !important` this same file reads from `globals.css` and drops to `<body>`. Added a FIDELITY LIMIT paragraph saying the assertion is about what the shell does across the hide, not about where a browser leaves the keyboard.
  - `[low]` `[patch]` The new pre-gate ordering guarantee covered one of three refusals; added `expect(listReadable).not.toHaveBeenCalled()` to both halves of "400s a malformed paths value and 403s under read-only".
  - `[low]` `[patch]` No passing call had BOTH gates live (the gate case skipped the scope check, the ordering case was a 403). Added "clears the scope check and still forwards the derived gate": an in-scope `raw/sources/a.txt` path with the hidden-slug seed, expecting 200 and the derived pair forwarded.

## Design Notes

Why only the FIRST hop is re-routed. DW-511's rule was "keep the rail as the closer": the unreachability is a property of a live backdrop, not of the rail. Going Wiki → Chat with the dialog on screen is the unreachable press; coming back, the dialog is inside a `hidden` subtree, `useDialogA11y` has stood down and no overlay is painted, so `clickRail("Wiki")` is exactly what a real owner does. Re-routing the return hop too would be a change with no defect behind it, and would cost the "re-showing re-arms and focuses the dialog" assertion its meaning — a traversal moves no focus, so nothing would have to be taken back from the rail.

The seeded history, for the record (`beforeEach` resets the URL to `/`, then the mount seed `replaceState`s):

```
[?mode=wiki]     ← mount seed (replaceState)
[?mode=chat]     ← seedChatEntry(): rail Chat
[?mode=wiki]     ← seedChatEntry(): rail Wiki  (current)
   … dialog opened here …
back() → ?mode=chat    canvas withdrawn, dialog and draft inside it
clickRail("Wiki")      canvas back, dialog re-armed  (pushes a new entry)
```

`popstate` bumps `canvasFocusNonce` only when the *settings* flag moves, so a mode-only traversal is focus-neutral by design — which is why the focus case's "hiding must not move focus" survives as an identity assertion rather than needing a rewrite of what it means.

## Verification

**Commands:**
- `node node_modules/vitest/vitest.mjs run --project dom src/components/workbench/__tests__/wiki-canvas-persistence.test.tsx src/components/workbench/__tests__/chat-live-stream.test.tsx` -- expected: all cases pass, under Node 22.
- `node node_modules/vitest/vitest.mjs run --project node src/lib/__tests__/epic8-v1-routes.test.ts` -- expected: pass, including the two new gate cases.
- `node node_modules/vitest/vitest.mjs run` -- expected: the full two-project run passes.
- `node_modules/.bin/tsc --noEmit` and `node_modules/.bin/eslint <the three files>` -- expected: clean.
- Mutation checks, each reverted: move `seedChatEntry()` after `openCreateWith` (the guard must fail); empty `stopTurn()`'s body; delete the unmount effect's `abort()`; replace `...slugGate` in the rescan route with nothing. -- expected: each fails exactly the case that names it.
- `git status --porcelain -- src` -- expected: exactly three modified paths, all tests.

## Auto Run Result

Status: done

**Implemented change.** All three entries are located in tests, and that is where all three were fixed — no product source was modified. DW-581: the four DW-26 cases that held a live Create Wiki dialog no longer click a rail control through a `fixed inset-0 z-[120]` backdrop. They seed a Chat history entry with two rail presses *before* any dialog opens (`seedChatEntry`, which asserts that ordering rather than trusting it) and then leave Wiki by Back (`showChat`) — browser chrome, which a modal neither paints over nor traps. The rail stays the RETURN control, because by then `.wb-canvas-mode` is `hidden`, the dialog is withdrawn inside it and no overlay is on screen; `returnToWikiOnRail` now checks exactly that immediately before each return press. A new case pins the refusal executably: the overlay is a full-viewport layer at a stated level, the rail is outside it, and a `mouseDown` on it cancels the dialog — the cost a real pointer aimed at the rail would have imposed. DW-586: two mounted cases press Stop and unmount mid-turn against a gated SSE body that honours the signal the way a real fetch body does, and both read the signal captured at the fetch door — the far end of `driveTurn` → `runSidecarTurn` → `loopbackFetch`. DW-537: the rescan route's own `v1SlugGate` derivation now runs for real through the POST door (`@/lib/workbench-tree` is unmocked; only the storage listing is seeded), and three cases pin a non-empty `hiddenSlugs` being forwarded, the scope check returning above the derivation, and the two composing on a passing call.

**Files changed.**
- `src/components/workbench/__tests__/wiki-canvas-persistence.test.tsx` -- local `traverse`/`urlMode`/`seedChatEntry`/`showChat`/`returnToWikiOnRail`; the four dialog-holding DW-26 cases re-routed through Back; file header and block docblock rewritten to name Back as the opener and state both halves of the refusal; two new cases (the backdrop pin, and the no-dialog rail-press focus control).
- `src/components/workbench/__tests__/chat-live-stream.test.tsx` -- `gatedTurn()` gained `failBody`, the `/chat` stub captures `init.signal` and errors the body on abort, and a new block asserts Stop and unmount abort the turn's own signal, end streaming, hand the question back and report nothing.
- `src/lib/__tests__/epic8-v1-routes.test.ts` -- `listReadableWikiPages` seam exposed and reset per test; three new `sources/rescan` cases for the derived gate, the scope check's ordering, and the two composing; `listReadable` call-count assertions added to the sibling pre-gate refusals.

**Review findings breakdown.** 9 patches applied (high 0, medium 2, low 7); 1 item deferred (medium); 13 rejected. No intent_gap, no bad_spec, no loopback.

**Follow-up review recommendation:** false. Patched by severity: high 0, medium 2, low 7 — no high-severity patch, so no further iteration is recommended.

**Verification performed** (Node 22.16.0 via nvm — this machine's default Node 26.8.1 fails the whole `dom` project at `window.localStorage.clear()` on an unmodified baseline too, a pre-existing environment issue; CI pins Node 22, and `pnpm` is broken under the nvm shim here, so vitest was invoked as `node node_modules/vitest/vitest.mjs`):
- `vitest run --project dom wiki-canvas-persistence.test.tsx chat-live-stream.test.tsx` -- 13 passed (10 + 3); the wiki suite grew from 7 cases to 10, the chat suite from 1 to 3.
- `vitest run --project node epic8-v1-routes.test.ts` -- 36 passed, up from 33.
- Full `vitest run` -- 376 files, 9425 passed, 1 skipped.
- `tsc --noEmit` and `eslint` on the three files -- clean.
- `git status --porcelain -- src` -- exactly the three test files, before and after the patch pass.
- Mutation checks, each reverted afterwards and each re-run after the patches: `stopTurn()`'s body emptied (fails only the Stop case); the unmount effect's `abort()` deleted (fails only the unmount case); `...slugGate` removed from the rescan route (fails only the two gate cases); `seedChatEntry()` moved after `openCreateWith` (the ordering guard fires); `returnToWikiOnRail()` moved ahead of `showChat()` (the withdrawal guard fires); the `AbortError` swallow deleted from `sendTurn` (the Stop case sees "Chat failed." in `.wb-chat-error`).
- I/O matrix audit: all seven rows are covered by cases that ran and passed -- "Seed then Back to Chat" and "Rail returns to Wiki" by the four re-routed DW-26 cases, "Backdrop pin" by "covers the rail with the dialog's own backdrop, which eats the pointer", "Stop mid-turn" and "Unmount mid-turn" by the two new abort cases, "Hidden page → gate" by "hands the rescan the gate it derived from the caller's own listing", and "Scope check precedes the gate" by "runs the raw/sources scope check BEFORE deriving the gate".

**Residual risks.**
- The stacking argument is still a textual proxy in this file. jsdom does no layout and no hit-testing, so the new pin asserts the facts the unreachability is composed of — a full-viewport backdrop at a stated level that excludes the rail, plus the backdrop's `onMouseDown` interception. The `globals.css` rail-family scan is cross-referenced to `settings-canvas-persistence.test.tsx` rather than duplicated. Real pointer behaviour remains Playwright's, which is not in CI.
- The focus outcome after the traversal is a jsdom artifact, now stated in the case: `document.activeElement` ends up inside the `[hidden]` subtree because jsdom applies no stylesheet, where a browser would drop the keyboard to `<body>`. The assertion is about what the shell does across the hide (nothing), and the regression it names is still caught — removing `useDialogA11y`'s hide guard fails it.
- The abort's observability depends on the test double: the stub is what errors the body when the signal fires. That the real `loopbackFetch`/`fetch` honours `signal` is assumed, not asserted, and the two new cases pin different depths — Stop reaches the rendered surface, unmount stops at `signal.aborted`.
- Observed and deliberately not filed (it did not clear the leftover bar and the slot went to the higher-consequence gate-parity entry): an aborted turn leaves `liveRows` set. `setLiveRows([])` runs only on `driveTurn`'s settle path and in `switchConversation`, and the abort throws out of `driveTurn` before either, while the assistant block renders on `streaming || liveRows.length > 0` — so after Stop an orphan Assistant article keeps showing the turn's tool rows with no answer under it, until the next turn settles. Pre-existing product behaviour; the new Stop case is the first thing in the repo able to observe it, and asserts nothing about it rather than locking in either reading.
