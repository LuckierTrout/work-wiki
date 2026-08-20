---
title: 'Wiki workbench client hardening (DW-148, DW-174, DW-175, DW-177, DW-255, DW-256)'
type: 'refactor'
created: '2026-08-19'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['multiple-goals', 'oversized']
deferred:
  - summary: >-
      The Wiki canvas card reads `WorkbenchData` but ignores its `readOnly` flag, so on a
      read-only deployment `Create Wiki` and `Change template` still open and only meet a 403
      after the destructive confirm.
    evidence: |-
      `page.tsx` feeds `readOnly: isReadOnly()` into the provider the card now destructures, and
      `WikiSwitcher` adopts the same flag with `if (readOnly) return`, `aria-disabled` and
      `WIKI_READ_ONLY_COPY`. The card does neither, so the header refuses up front while the canvas
      walks the owner into "This overwrites purpose.md, Schema, and the Workspace Purpose" before
      the route answers 403. Pre-existing (the card never had the flag as a prop either); this
      change made it available one line away without wiring it. Every fixture that mounts the card
      hard-codes `readOnly: false`, so no suite can express the case.
    location: >-
      src/components/WikiWorkbench.tsx:152-194
    severity: medium
  - summary: >-
      A write that aborts on the 15s deadline is reported as a flat failure even though the server
      may have applied it, and no refresh reconciles the screen.
    evidence: |-
      `failureMessage` maps `TimeoutError`/`AbortError` onto the caller's sentence — "Couldn't apply
      the template." / "Couldn't create the wiki." — and the catch path deliberately skips
      `router.refresh()`. A re-template that took longer than the client deadline has still rewritten
      purpose.md, schema.md and the Workspace Purpose, so the owner is told it failed over a write
      that landed and may retry it. `WikiSwitcher` has shipped this behaviour since the deadline was
      introduced; this change extended it to the card's two writes, so a fix belongs to both.
    location: >-
      src/lib/workbench-request.ts (failureMessage) with WikiWorkbench.tsx:91,118
    severity: medium
  - summary: >-
      The Rename and Change-template confirms never name the wiki they act on, which is the same
      premise DW-148 fixed for the pickers.
    evidence: |-
      DW-148's premise is that a bare name does not identify a wiki. The Delete confirm leans
      entirely on its `<select>`, and the Rename and Change-template bodies say "this wiki" with no
      target named at all — so the two confirms that rewrite or rename an artifact set identify
      their target less precisely than the picker that chooses it.
    location: >-
      src/components/workbench/WikiSwitcher.tsx (Rename body) and WikiWorkbench.tsx (template body)
    severity: low
  - summary: >-
      `No wiki yet.` and `Your wikis couldn't be loaded. Reload to try again.` are still inline
      literals in the card while every other sentence it shows is an exported constant.
    evidence: |-
      DW-177 named only the preview sentence, and extracting it leaves the card the one component
      that both imports a copy constant and restates two sentences of its own. `TREE_NO_WIKI_COPY`
      and `TREE_UNAVAILABLE_COPY` already exist in `workbench-tree.ts` for the left column's
      versions of the same two states, so the card is a second definition of both wordings.
    location: >-
      src/components/WikiWorkbench.tsx:151,146
    severity: low
  - summary: >-
      A network-level `fetch` rejection reaches the owner verbatim as "Failed to fetch", the same
      class of defect `failureMessage`'s abort branch exists to prevent.
    evidence: |-
      `failureMessage` special-cases `TimeoutError`/`AbortError` because those name the mechanism
      rather than the thing that failed, then returns `cause.message` for anything else. An offline
      browser rejects with `TypeError: Failed to fetch` (or `NetworkError when attempting to fetch
      resource`), which is exactly as mechanism-named and sails straight through to the dialog.
      Carried over verbatim from `WikiSwitcher`; nothing covers a `TypeError` rejection.
    location: >-
      src/lib/workbench-request.ts (failureMessage)
    severity: low
baseline_revision: 'ac1a6a2f86d6f4509c7a13cf59e54bae80c8c347'
---

<intent-contract>

## Intent

**Problem:** `WikiWorkbench`'s client half never received the hardening `WikiSwitcher` got: its `send()` has no request deadline and no timeout-aware message and spreads `...init` after `headers`, so a hung create or re-template strands `busy` for the session; the card seeds `useState` from props behind a wiki-id key, so a header Rename leaves it naming the old wiki until a reload; both Wiki option lists render `wiki.name` alone even though names are not unique and Delete is irreversible; and `Select a file to preview.` is an inline literal while every sibling sentence is an exported constant.

**Approach:** Extract one shared request helper (`send` + `failureMessage` + the deadline) into a client-safe `src/lib` module and consume it from both components; make the canvas card read `wikis`/`currentWikiId`/`registryUnavailable` from `WorkbenchDataProvider` and drop its props and `page.tsx`'s remount key; render a shared disambiguated option label in both `<select>`s; export the preview sentence as a constant; and add the missing pins — a handler-level `if (busy) return` on `rename()`/`remove()` driven through `ConfirmDialog`, plus mounted assertions for the malformed-2xx `!wiki?.id` guards in `applyTemplate`, `rename` and `remove`.

## Boundaries & Constraints

**Always:**
- One request helper module, client-safe (no node/server imports), owning the `Content-Type` header, `AbortSignal.timeout(REQUEST_TIMEOUT_MS)` and the `...init` FIRST spread order; both components import it and neither keeps a local copy.
- `WikiWorkbench` derives everything it renders from `useWorkbenchData()`. No local `wikis`/`currentId` state, no `replace()`, no props.
- `router.refresh()` stays the only way the card's data moves after a write — the same non-optimistic contract `WikiSwitcher.create` already documents.
- Every existing user-visible sentence stays byte-identical; extracting a literal to a constant must not reword it.
- Retarget, never delete, an assertion the refactor invalidates: a source scan that pinned a literal in a moved location must be re-pointed at its new home.
- Copy constants live in `src/lib`; components import them.

**Block If:**
- The provider seam cannot carry a fact the card needs without adding a new server read or route.

**Never:**
- Do not touch `SettingsCanvas.tsx` or `PreviewColumn.tsx` (they carry their own `REQUEST_TIMEOUT_MS` and are out of this bundle's scope).
- Do not reintroduce a switcher, a `New Wiki` control or an active-wiki write to the canvas card (DW-33).
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.
- No new API route, no client fetch of registry data.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Header Rename lands | Card mounted under the provider; provider value re-rendered with the renamed `WikiRecord`, same `currentWikiId` | The card's heading names the NEW name with no remount and no reload | No error expected |
| Hung create / re-template | `fetch` never settles | After `REQUEST_TIMEOUT_MS` the request aborts, the dialog shows the caller's fallback sentence (not "signal timed out"), and the confirm is pressable again | `TimeoutError`/`AbortError` → caller fallback via `failureMessage` |
| Caller passes its own headers | `send(url, { headers: { "X-Test": "1" } })` | Both `Content-Type: application/json` and the caller header are sent; the deadline is still armed | Caller cannot drop either invariant |
| Two wikis share a name | Registry holds two `Acme` records | Every `<option>` in the switcher AND the delete picker carries name + scenario + created date + id fragment, so the two rows differ | No error expected |
| Double-press Rename / Delete confirm | First request still in flight, second press on the same confirm | Exactly ONE request is issued; the confirm reads `Working…` and is disabled | Handler-level `if (busy) return` behind the button's `disabled` |
| Malformed 2xx from template/rename/delete | 200 with body `{}` | The dialog stays open showing `Couldn’t apply the template.` / `Couldn’t rename the wiki.` / `Couldn’t delete the wiki.`; no `router.refresh()`; no blank render | `!wiki?.id` guard throws into the catch |
| Registry read failed | Provider `registryUnavailable: true` | Card renders the alert sentence only — no `No wiki yet.`, no `Create Wiki`, no card, no preview sentence | Degraded render, not empty state |

</intent-contract>

## Code Map

- `src/components/workbench/WikiSwitcher.tsx` -- donor of the hardened helper: `REQUEST_TIMEOUT_MS` (:71-75), `send` (:77-88, `...init` FIRST), `failureMessage` (:90-101). `rename()` (:214-233) and `remove()` (:235-259) are the two handlers missing `if (busy) return` (`create()` has none either — add it there too for symmetry with `CreateWikiDialog.submit`). The switcher `<option>` is at :330-334; the delete-picker `<option>` at :519-523. Both currently render `{wiki.name}`.
- `src/components/WikiWorkbench.tsx` -- the unhardened `send` (:46-54); `useState(initialWikis)`/`useState(initialCurrentId)` (:62-63); `replace()` (:76-84); `create()` (:86-110) and `applyTemplate()` (:112-134) — `create` also uses `cause instanceof Error ? cause.message : …` instead of `failureMessage`; the inline `Select a file to preview.` (:210); the `WikiWorkbenchProps` interface (:33-44).
- `src/components/workbench/WorkbenchData.tsx` -- already carries `wikis`, `currentWikiId`, `registryUnavailable`; `useWorkbenchData()` at :99. `EMPTY_DATA` means a consumer outside a provider degrades rather than throwing.
- `src/app/page.tsx` -- :136-146 renders `<WikiWorkbench key=… initialWikis=… initialCurrentId=… unavailable=… />` inside the provider whose value (:110-131) already holds the same three facts. The key and all three props go away; the comment at :137-139 goes with them.
- `src/lib/workbench-preview.ts` -- the `Copy —` block at :329-347 (`PREVIEW_LOADING_COPY`, `PREVIEW_FAILED_COPY`, `PREVIEW_EMPTY_COPY`, `PREVIEW_UNSUPPORTED_COPY`). New sentence constant belongs here, beside `PREVIEW_EMPTY_COPY`.
- `src/lib/wiki-scenarios.ts` -- pure, client-safe; owns `SCENARIO_LABELS`, `CREATABLE_SCENARIOS`, `MAX_WIKI_NAME_CHARS`. Home for the shared option-label helper (structural param, so it needs no value import from `wikis.ts`).
- `src/lib/wikis.ts` -- `WikiRecord` (:73-79); ids are `crypto.randomUUID()` (:768) matching `WIKI_ID_RE` in `wiki-paths.ts:31`, which is why an id fragment is a real discriminator.
- `src/components/__tests__/wiki-switcher-lifecycle.test.tsx` -- mounted switcher suite (672 lines); `mount()` at :80. Home for the new DW-255 busy-gate and DW-256 malformed-2xx tests for rename/remove.
- `src/components/__tests__/dialog-busy-gate.test.tsx` -- the DW-107 gate suite, drives `WikiWorkbench` bare at :85 and :101; must wrap in a provider.
- `src/components/__tests__/create-wiki-flow.test.tsx` -- mounted canvas suite; bare renders at :69/:195/:207/:238/:256/:278; :225 asserts the card shows the new wiki right after create (optimistic state that is going away); :292 restates the preview sentence.
- `src/components/workbench/__tests__/wiki-canvas-duplication.test.tsx` -- `data()` factory at :120-138 already builds a `WorkbenchData`; `renderShell` :186-201; `keyedShell` :220-232 and the two key tests at :406 and :446 are the ones the provider seam replaces; bare renders at :510/:522; `PREVIEW_SENTENCE` literal at :50.
- `src/hooks/__tests__/useDialogA11y.test.tsx:204` -- one bare `WikiWorkbench` render.
- `src/lib/__tests__/create-wiki-ui.test.ts` -- source scans: :135 counts `fallbackFocusRef={headingRef}`, :144 pins the inline preview sentence, :190 `disabled={busy}`, :213-220 the DW-33 negatives (comment-stripped), :259 pins `unavailable={wikiRegistry.unavailable}` in `page.tsx`, :286 counts `router.refresh()` twice.
- `src/lib/__tests__/workbench-left-column.test.ts` -- :231 pins `AbortSignal.timeout(REQUEST_TIMEOUT_MS)` inside `WikiSwitcher.tsx`; :597 pins the `page.tsx` remount key.
- `src/lib/__tests__/workbench-chrome.test.ts` -- :522-525 pins `<WikiWorkbench` and `unavailable: true` in `page.tsx` (both survive); :536 pins `wb-canvas-pad`.
- `vitest.config.ts` -- two projects; `dom` collects `src/**/__tests__/**/*.test.tsx` only.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-request.ts` -- NEW client-safe module exporting `REQUEST_TIMEOUT_MS`, `send<T>(url, init)` and `failureMessage(cause, fallback)`, moved verbatim (with their docstrings) from `WikiSwitcher.tsx:71-101` -- one owner for the deadline, the JSON content type, the `...init` FIRST spread order and the timeout-message fallback.
- `src/components/workbench/WikiSwitcher.tsx` -- delete the three local definitions and import them from `@/lib/workbench-request`; add `if (busy) return;` as the first line of `create()`, `rename()` and `remove()`; render `wikiOptionLabel(wiki)` in both `<option>` lists -- DW-175/DW-255/DW-148.
- `src/components/WikiWorkbench.tsx` -- import `send`/`failureMessage` from the new module; drop `WikiWorkbenchProps`, `initialWikis`/`initialCurrentId`/`unavailable`, the two `useState`s and `replace()`, reading `{ wikis, currentWikiId, registryUnavailable }` from `useWorkbenchData()` instead; add `if (busy) return;` to `create()` and `applyTemplate()`; route both catches through `failureMessage`; render `PREVIEW_UNSELECTED_COPY` -- DW-174/DW-175/DW-177/DW-256.
- `src/app/page.tsx` -- render `<WikiWorkbench />` bare and delete the remount-key comment -- the provider is now the card's single source, so the key is dead weight and the stale-name defect it papered over is gone.
- `src/lib/workbench-preview.ts` -- add `PREVIEW_UNSELECTED_COPY = "Select a file to preview."` beside `PREVIEW_EMPTY_COPY`, with a docstring naming the DW-39 mutual exclusion -- DW-177.
- `src/lib/wiki-scenarios.ts` -- add `wikiOptionLabel({ id, name, scenario, createdAt })` returning name + scenario label + created date + id fragment -- DW-148, one spelling for both pickers.
- `src/components/__tests__/wiki-switcher-lifecycle.test.tsx` -- add a DW-255 test per handler that holds the request open and presses the confirm twice, asserting exactly one request; add DW-256 tests answering `rename`/`remove` with a 200 `{}` and asserting the dialog's own message, no `router.refresh()`, and no wiki removed from the list; add a DW-148 test asserting both option lists distinguish two same-named wikis.
- `src/components/workbench/__tests__/wiki-canvas-duplication.test.tsx` -- replace `keyedShell` and the two key tests with provider-driven equivalents (rerender the provider with a RENAMED wiki at the same id → card names the new name; rerender with a new `currentWikiId` → card follows and aims `Change template` at it); wrap the two bare DW-39 renders in a provider; source `PREVIEW_SENTENCE` from `PREVIEW_UNSELECTED_COPY`.
- `src/components/__tests__/create-wiki-flow.test.tsx`, `src/components/__tests__/dialog-busy-gate.test.tsx`, `src/hooks/__tests__/useDialogA11y.test.tsx` -- wrap every `WikiWorkbench` render in a `WorkbenchDataProvider` carrying the same fixture; retarget the post-create assertion from "the card now shows the new wiki" to "`router.refresh()` was called and the empty state is still the truth until the server answers"; add a DW-256 malformed-2xx test for `applyTemplate`.
- `src/lib/__tests__/create-wiki-ui.test.ts` -- retarget the preview-sentence scan onto `PREVIEW_UNSELECTED_COPY` (assert the constant's value AND that `WikiWorkbench.tsx` imports rather than restates it); drop the `unavailable={wikiRegistry.unavailable}` expectation in favour of the provider's `registryUnavailable`.
- `src/lib/__tests__/workbench-left-column.test.ts` -- retarget the `AbortSignal.timeout(REQUEST_TIMEOUT_MS)` scan onto `src/lib/workbench-request.ts` and assert `WikiSwitcher.tsx` imports it rather than redefining it; replace the `page.tsx` key expectation with one that the key is GONE and the card is provider-fed.

**Acceptance Criteria:**
- Given the card is mounted under a provider, when the provider re-renders with the same `currentWikiId` but a renamed `WikiRecord`, then the card's heading shows the new name without a remount.
- Given a create or re-template request that never settles, when `REQUEST_TIMEOUT_MS` elapses, then the request aborts, the dialog shows the caller's fallback sentence, and the confirm is enabled again.
- Given a caller passes `headers` or a `signal` in `init`, when `send` issues the request, then `Content-Type: application/json` and the timeout signal are still applied.
- Given two wikis with identical names, when the switcher and the delete picker render, then each `<option>`'s text distinguishes them.
- Given a Rename or Delete confirm whose request is in flight, when the confirm is pressed again, then exactly one request has been issued.
- Given `applyTemplate`, `rename` or `remove` receives a 200 whose body carries no `wiki.id`, when the response settles, then the dialog stays open with that operation's own sentence and `router.refresh()` was not called.
- Given `Select a file to preview.` is changed in `src/lib/workbench-preview.ts`, when the suite runs, then no test restates the old wording.
- Given `pnpm test` and `pnpm lint`, when run at the end, then both pass with no skipped or deleted coverage of the behaviours above.

## Spec Change Log

## Design Notes

`WikiWorkbench` loses its optimism deliberately. Today `create()` pushes the new record into local state so the card paints it before the refresh lands; once the provider is the single source, that write has nowhere to go, and `WikiSwitcher.create` already documents why not being optimistic is correct here (an id that is not yet in `wikis` would leave a control on a value matching no option). After a create the card keeps showing the empty state for the length of `router.refresh()` — the same window the header already accepts — so the tests that asserted the new name appear immediately must assert the refresh instead.

`unavailable` is not replaced by a prop: `page.tsx` already feeds the provider's `registryUnavailable` and the card's `unavailable` from the SAME `wikiRegistry.unavailable`, so reading the provider field removes a second wire rather than losing a distinction. `EMPTY_DATA`'s `registryUnavailable: false` keeps a card rendered outside a provider on the ordinary "nothing loaded" path.

Label shape, one spelling for both pickers:

```ts
// Name alone is not unique (nothing enforces it) and Delete is irreversible,
// so every option carries three more discriminators — the template it was made
// from, the day it was made, and the head of its UUID, which nothing else on
// screen repeats.
export function wikiOptionLabel(wiki: {
  id: string; name: string; scenario: CreatableScenario; createdAt: string;
}): string {
  return `${wiki.name} — ${SCENARIO_LABELS[wiki.scenario]} · ${wiki.createdAt.slice(0, 10)} · ${wiki.id.slice(0, 8)}`;
}
```

The date is sliced off the ISO string rather than formatted through `Intl`, so the label carries no ambient time zone and the tests cannot drift with the machine that runs them.

## Verification

**Commands:**
- `pnpm test` -- expected: both vitest projects green; the `dom` project still collects every `__tests__/**/*.test.tsx`.
- `pnpm lint` -- expected: clean.
- `npx tsc --noEmit -p tsconfig.json` -- expected: no type errors (the prop removal is a compile-time fan-out).
- `grep -rn "Select a file to preview." src` -- expected: exactly one occurrence, in `src/lib/workbench-preview.ts`.
- `grep -rn "initialWikis\|initialCurrentId" src` -- expected: no occurrences.

## Auto Run Result

Status: done
Blocking condition: none

### Summary

Brought `WikiWorkbench`'s client half up to the hardening `WikiSwitcher` already had, and pinned the guards that hold it. One shared request helper (`src/lib/workbench-request.ts`) now owns the JSON content type, `AbortSignal.timeout(REQUEST_TIMEOUT_MS)` and the `...init`-first spread order for both components (DW-175). The canvas card takes no props at all: it reads `wikis`, `currentWikiId` and `registryUnavailable` from `WorkbenchDataProvider`, so a header Rename reaches it on the next render instead of only on a reload, and `page.tsx`'s remount key is gone (DW-174). Both option lists render one shared `wikiOptionLabel` carrying scenario, created date and id head, so two same-named wikis are distinguishable at the moment of an irreversible delete (DW-148). `Select a file to preview.` is now `PREVIEW_UNSELECTED_COPY` beside its siblings, with one definition in `src` (DW-177). Handler-level busy guards were added to `rename()`/`remove()` (and to the three sibling handlers) with double-press tests driving `ConfirmDialog` through them (DW-255), and the malformed-2xx `!wiki?.id` guards in `applyTemplate`, `rename` and `remove` are now each pinned by a test (DW-256).

### Files changed

- `src/lib/workbench-request.ts` — NEW. The one client-safe request helper: `REQUEST_TIMEOUT_MS`, `send`, `failureMessage`.
- `src/lib/__tests__/workbench-request.test.ts` — NEW. Executes the helper's invariants — content type, spread order with caller headers, the deadline a caller cannot drop, server message vs. status fallback, both abort flavours.
- `src/lib/__tests__/wiki-option-label.test.ts` — NEW. `wikiOptionLabel` against a real `crypto.randomUUID()` id, an id-only difference, the ISO date slice at `23:59:59.999Z`, and separator characters in a name.
- `src/components/WikiWorkbench.tsx` — propless; reads the provider; shared helper; busy guards; dialog reset on an active-wiki change; template dialog gated on a non-null `current`; create-pending gate on the empty state's button; explicit heading refocus after a create; `PREVIEW_UNSELECTED_COPY`.
- `src/components/workbench/WikiSwitcher.tsx` — imports the shared helper instead of defining it; busy guards on `create`/`rename`/`remove`; both `<option>` lists render `wikiOptionLabel`.
- `src/app/page.tsx` — renders `<WikiWorkbench />` bare; remount key and its three props deleted.
- `src/lib/wiki-scenarios.ts` — `wikiOptionLabel`, structural param, ISO date slice (no `Intl`, no ambient time zone).
- `src/lib/workbench-preview.ts` — `PREVIEW_UNSELECTED_COPY` beside `PREVIEW_EMPTY_COPY`.
- `src/components/__tests__/create-wiki-flow.test.tsx` — provider-driven; DW-175 abort cases for create and re-template; DW-256 template case; component-boundary `signal` assertions; post-create expectations retargeted onto the refresh.
- `src/components/__tests__/wiki-switcher-lifecycle.test.tsx` — DW-255 double-press cases for Rename and Delete; DW-256 cases for both; DW-148 disambiguation for both pickers; boundary `signal` assertion.
- `src/components/__tests__/dialog-busy-gate.test.tsx`, `src/hooks/__tests__/useDialogA11y.test.tsx` — every `WikiWorkbench` render moved under a provider; expectations retargeted.
- `src/components/workbench/__tests__/wiki-canvas-duplication.test.tsx` — the two remount-key tests replaced by provider-driven equivalents (a rename in place at the same id, a switch followed through the provider), plus the P1 dialog-reset cases.
- `src/lib/__tests__/create-wiki-ui.test.ts`, `src/lib/__tests__/workbench-left-column.test.ts` — scans retargeted onto the new module and the provider seam; `if (busy) return;` guard counts pinned; the `page.tsx` key expectation inverted to key-is-gone.

### Review findings

- Patches applied: 7 (high 1, medium 3, low 3) — see the Review Triage Log entry for each.
- Items deferred: 5 (medium 2, low 3) — recorded in frontmatter `deferred`.
- Items rejected: 13.
- Follow-up review recommended: **true** — one patched finding was `high` severity (score `3 × 3 + 1 × 3 = 12`, threshold 5).

### Verification

- `npx vitest run` — 248 files, 5233 tests, all passed.
- `npx eslint` — exit 0.
- `npx tsc --noEmit -p tsconfig.json` — exit 0.
- `grep -rn "Select a file to preview." src` — one occurrence, `src/lib/workbench-preview.ts:358`.
- `grep -rn "initialWikis\|initialCurrentId" src` — no usages; the two hits are a comment explaining the removal and the scan asserting their absence.
- Every I/O matrix row is covered by a test that ran and passed.
- `pnpm test` / `pnpm lint` fail in this environment with `ERROR packages field missing or empty`, a pre-existing pnpm workspace-resolution quirk from a parent directory unrelated to this change; the `npx` equivalents above were run instead.

### Residual risks

- **The card's create is no longer optimistic.** After a successful create the empty state stays on screen for the length of `router.refresh()`, with its button gated until a server render lands. That is the price of the provider being the single source, and it matches `WikiSwitcher.create`, but it is a real user-visible window.
- **The five `if (busy) return;` guards are unreachable through the DOM** — `ConfirmDialog`'s confirm is `disabled={busy}` and the rename input has its own guard. They are defense in depth, held by a source-scan pin rather than by a mounted test; the mounted tests pin the dialog gate they sit behind.
- **`readOnly` is available to the card and still unwired** — deferred, not fixed. On a read-only deployment the canvas's two write doors still open onto a 403.
