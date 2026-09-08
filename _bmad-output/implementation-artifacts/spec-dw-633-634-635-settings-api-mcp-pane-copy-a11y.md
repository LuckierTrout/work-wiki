---
title: 'SettingsApiMcpPane: starting health sentence, token hint wiring, absent-copy de-duplication'
type: 'bugfix'
created: '2026-09-01'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The Skill count is appended to the health line for every health, so a sidecar that
      never answered still renders "0 Skills on disk." as a statement of fact.
    evidence: |-
      `probeLoopbackApiPane` runs the Skills scan independently of `/health` and swallows
      its failure into `skills: []`. `SettingsApiMcpPane` then renders
      `${apiLive.skills.length} Skills on disk.` unconditionally beside whichever health
      sentence it chose. With nothing serving on 19828 — the ordinary state of a wiki whose
      sidecar is not started — the pane says "The sidecar is not running on 127.0.0.1:19828.
      0 Skills on disk.", asserting something about the machine that the failed scan could
      not establish: the count is "the scan did not answer", not zero. Same false-claim class
      as DW-633, which this bundle fixed for the health sentence only. Pre-existing and
      unchanged by this story; the count rides along with the sentence exactly as before.
    location: >-
      src/components/workbench/SettingsApiMcpPane.tsx (the apiLive health note's Skill count)
    severity: low
baseline_revision: '4078bd4c4ed9cbbaed43f103ac5e904aec5ad2bb'
---

<intent-contract>

## Intent

**Problem:** Three defects in `SettingsApiMcpPane` (all pre-existing, moved verbatim by DW-445): a `starting` sidecar falls through the health ternary and is described as running (DW-633); the token row's hint span carries an id no control references, so its env-pinned and "copy it now" sentences are announced to nobody (DW-634); and `SETTINGS_API_TOKEN_ABSENT_COPY` renders twice on one screen — as the hint fallback and as the `wb-set-warn` note (DW-635).

**Approach:** Mint a `starting` sentence and render the health line through an exhaustive helper so no status can fall through to "running"; point the three token controls' `aria-describedby` at the hint id as well as the label id; and split the one absent sentence into two that say different things — a field-state hint and a door-consequence note.

## Boundaries & Constraints

**Always:**
- The health sentence is selected by an exhaustive mapping over `ClassifiedLoopbackHealth`, so a fifth status cannot compile without its own sentence.
- Preserve today's `error` → `SETTINGS_API_HEALTH_UNREACHABLE_COPY` mapping verbatim; the bundle scopes only `starting`.
- The token controls keep announcing the row label (`Generate`/`Show`/`Copy` are their whole accessible names — "API token" is the context they'd otherwise lose); the hint is ADDED to the list, not swapped in.
- `Generate` keeps routing through `describedBy`, so the canvas's read-only / save-in-flight refusal still appends. The pane must still contain exactly three `aria-describedby={describedBy(` call sites, which `src/lib/__tests__/workbench-settings.test.ts` counts.
- All user-visible sentences stay exported constants in `src/lib/workbench-api-mcp-settings.ts` / `src/lib/workbench-loopback-health.ts`; no string literals in JSX.
- The pane stays router-free, storage-free and `fetch`-free apart from `probeLoopbackApiPane`.

**Block If:**
- Wiring the hint id would require the pane to build its own ids outside the canvas's `field` namespace.

**Never:**
- Do not re-classify `error`, add a status to `LOOPBACK_STATUSES`, or change `classifyLoopbackHealth`.
- Do not change `draftApiTokenMissing`'s predicate — only the sentence it renders.
- Do not block Save on a missing token; the no-way-in state stays a `role="status"` note.
- Do not touch `SettingsCanvas`'s `describedBy`, the draft, the save path, or any other pane.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Starting sidecar | `/health` answers `{status:"starting"}` | Health note renders the new starting sentence + Skill count; never the running sentence | No error expected |
| Running sidecar | `{status:"running"}` | Running sentence, unchanged | No error expected |
| Foreign process | unrecognised payload | Port-conflict sentence, unchanged | No error expected |
| Dead / absent listener | `{status:"error"}`, or the probe rejects | Unreachable sentence, unchanged | Probe swallows its own errors |
| Token controls announced | Door open, a freshly generated draft token | `Generate`, `Show` and `Copy` each announce the row label AND the hint sentence | No error expected |
| Refused while announcing | Same, with the canvas refusing edits | `Generate` announces label + hint + the bar's refusal sentence | No error expected |
| No way in | Door open, unauth off, no token anywhere | Hint says the token is not stored; the `wb-set-warn` note says the door is open with no way in — two DIFFERENT sentences, one node each | No error expected |
| Unauthenticated, no token | Door open, unauth ON, no token | Hint sentence only; no warn note | No error expected |

</intent-contract>

## Code Map

- `src/components/workbench/SettingsApiMcpPane.tsx` -- all three defects. Health ternary at ~:156-160 inside the `apiLive ?` block; token row at ~:245-320 (`apiToken-label` span :246, Generate's `describedBy(field("apiToken-label"))` :253, Show :268, Copy :279, hint span `id={field("apiToken-hint")}` :286-296); `draftApiTokenMissing` warn note :304.
- `src/lib/workbench-loopback-health.ts` -- owns `ClassifiedLoopbackHealth` (`LoopbackStatus | "unreachable"`) and the three `SETTINGS_API_HEALTH_*_COPY` constants. Add the starting sentence and the exhaustive selector here, beside them.
- `src/lib/v1-contract.ts:86` -- `LOOPBACK_STATUSES = ["starting","running","port_conflict","error"]`; its doc block defines `starting` as "a listener that has not bound yet". READ-ONLY.
- `src/lib/workbench-api-mcp-settings.ts:93-98` -- `SETTINGS_API_TOKEN_NEW_COPY`, `_STORED_COPY` ("A token is stored."), `_ABSENT_COPY`. `draftApiTokenMissing` at :248 gates the warn note. READ-ONLY apart from the copy constants.
- `src/components/workbench/SettingsCanvas.tsx:614` -- `describedBy(hintId)` returns `hintId` when not refused, else `` `${hintId} ${barNoteId}` ``. Plain concatenation, so a two-id string passes through correctly. READ-ONLY.
- `src/components/workbench/__tests__/settings-api-mcp-pane.test.tsx` -- the mounted suite. `mountPane(payload, {health})` routes `/api/v1/health` by URL; `healthLine()` finds the note by its Skill count; health cases at :196-282; the `getAllByRole("status").find(...)` workaround at :404-408 is DW-635's evidence and must become a plain `getByText`.
- `src/components/workbench/__tests__/settings-harness.tsx:174` -- `announcedFor(control)` resolves every `aria-describedby` id and joins their text. The assertion tool for DW-634.
- `src/lib/__tests__/workbench-settings.test.ts:5405-5477` -- the source scan. Asserts `apiPane.match(/aria-describedby=\{describedBy\(/g)` has length 3 and that every literal `<span className="wb-set-hint"` in the pane carries an id. Both must keep passing; the scan is also where the "id is referenced by a control" gap named in DW-634 is closed.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-loopback-health.ts` -- add `SETTINGS_API_HEALTH_STARTING_COPY` (a listener that has not bound yet: it is coming up and not answering calls yet) and an exported pure `loopbackHealthSentence(health: ClassifiedLoopbackHealth): string` using an exhaustive `switch` with a `never` exhaustiveness guard, mapping starting → the new sentence, running → running, port_conflict → port-conflict, error and unreachable → unreachable -- one place that owns the mapping, and a compile error rather than a silent "running" when a status is added.
- `src/lib/workbench-api-mcp-settings.ts` -- narrow `SETTINGS_API_TOKEN_ABSENT_COPY` to the field-state sentence that mirrors `SETTINGS_API_TOKEN_STORED_COPY`, and add a new constant for the `wb-set-warn` note that names the CONSEQUENCE (the door is open, callers get 401) and both remedies. Update the doc comments so each sentence's job is stated -- the hint describes the field, the note describes the door.
- `src/components/workbench/SettingsApiMcpPane.tsx` -- render the health note through `loopbackHealthSentence(apiLive.health)` instead of the ternary; introduce one local `aria-describedby` value combining `field("apiToken-label")` and `field("apiToken-hint")` and use it for Generate (through `describedBy`), Show and Copy; render the new consequence constant in the `draftApiTokenMissing` note -- three defects, one file, comments explaining each choice in the file's existing voice.
- `src/components/workbench/__tests__/settings-api-mcp-pane.test.tsx` -- add a `starting` health case; add a case asserting the three token controls announce label + hint (and, under refusal, the bar sentence too); replace the `getAllByRole("status").find(...)` workaround with `getByText` on the two now-distinct sentences and assert each renders exactly once -- cover every I/O matrix row.
- `src/lib/__tests__/workbench-settings.test.ts` -- extend the existing "describes every control whose constraint is not in its label" case so every `-hint` id the pane MINTS is also REFERENCED by a control there, closing the scan gap DW-634 names, while keeping the two existing pane assertions (3 `describedBy` call sites; every literal hint span identified).

**Acceptance Criteria:**
- Given the sidecar answers `/health` with `{status:"starting"}`, when the pane's probe lands, then the health note contains the starting sentence and does not contain `SETTINGS_API_HEALTH_RUNNING_COPY`.
- Given a fifth value is added to `ClassifiedLoopbackHealth`, when the project typechecks, then `loopbackHealthSentence` fails to compile rather than describing it as running.
- Given the door is open and the draft holds a freshly generated token, when `announcedFor` is applied to Generate, Show and Copy, then each announcement contains both `SETTINGS_API_TOKEN_LABEL` and the hint's current sentence.
- Given the same state with the surface refusing edits, when `announcedFor` is applied to Generate, then the announcement still contains the canvas's refusal sentence alongside the label and hint.
- Given the door is open, unauthenticated access is off and no token exists anywhere, when the pane renders, then the hint sentence and the `wb-set-warn` note are different strings and each appears exactly once in the document.
- Given the token source is `env`, or a token is stored, or one was just generated, when the pane renders, then the warn note is absent and the hint carries that branch's sentence, unchanged from today.
- Given the whole suite, when `npx vitest run` and `npx eslint` run, then both pass with no new failures.

## Spec Change Log

## Design Notes

`describedBy` is plain string concatenation, so the token controls can share one pre-built two-id value:

```tsx
// The row LABEL and the row HINT, in that order: "Generate"/"Show"/"Copy" are
// whole accessible names, so the label is the only thing that says WHICH token
// — and the hint is the sentence that was being announced by nothing (DW-634).
const tokenDescribedBy = `${field("apiToken-label")} ${field("apiToken-hint")}`;
```

Generate keeps `aria-describedby={describedBy(tokenDescribedBy)}` so the count of three `describedBy` call sites the source scan asserts is unchanged; Show and Copy take `tokenDescribedBy` directly, exactly as they take `field("apiToken-label")` today.

The two absent sentences answer different questions: the hint answers "what is in this field" (and is the sibling of "A token is stored."), the note answers "what happens to callers now". That is what makes them safe to render together.

## Verification

**Commands:**
- `npx vitest run src/components/workbench/__tests__/settings-api-mcp-pane.test.tsx src/lib/__tests__/workbench-settings.test.ts src/lib/__tests__/workbench-api-mcp-settings.test.ts` -- expected: all pass, including the new starting / announcement / de-duplication cases.
- `npx vitest run` -- expected: no new failures anywhere in the suite.
- `npx eslint src/components/workbench/SettingsApiMcpPane.tsx src/lib/workbench-loopback-health.ts src/lib/workbench-api-mcp-settings.ts` -- expected: clean.
- `npx tsc --noEmit` -- expected: clean (proves the exhaustiveness guard compiles).

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** Three corrections in the API + MCP pane. `starting` now has its own
sentence and the pane selects health copy through one exhaustive `switch` instead of a ternary
chain whose final arm answered "running" for anything unnamed. The token row's three controls
announce the row hint alongside the row label, so the env-pinned and "copy it now, never shown
again" sentences reach a screen reader. And the one absent-token sentence became two that answer
different questions: the hint says what is in the field, the `wb-set-warn` note says what happens
to callers.

**Files changed**
- `src/lib/workbench-loopback-health.ts` — added `SETTINGS_API_HEALTH_STARTING_COPY` and the
  exhaustive `loopbackHealthSentence`, whose `never` guard makes a fifth status a compile error.
- `src/lib/workbench-api-mcp-settings.ts` — narrowed `SETTINGS_API_TOKEN_ABSENT_COPY` to
  "No token is stored." and added `SETTINGS_API_TOKEN_NO_WAY_IN_COPY` for the warn note.
- `src/components/workbench/SettingsApiMcpPane.tsx` — health line through the selector; one
  shared `tokenDescribedBy` (label id + hint id) on Generate, Show and Copy; the new note copy.
- `src/components/workbench/__tests__/settings-api-mcp-pane.test.tsx` — `starting` and `error`
  health cases, three announcement cases including one under an in-flight save, and the
  `getAllByRole("status").find(...)` workaround replaced by exact-count `getAllByText` queries.
- `src/lib/__tests__/workbench-settings.test.ts` — the source scan now requires every `-hint` id
  the pane mints to be referenced, not merely declared.
- `e2e/workbench-owner.spec.ts` — the health locator learned the fourth sentence, so a sidecar
  caught mid-start no longer fails the owner journey.

**Review findings breakdown.** 2 patches applied (both low: the held-save gate narrowed to
`SETTINGS_ROUTE`; `releaseSave()` moved into a `finally`). 1 item deferred (low: the Skill count
is stated as fact beside a sidecar that never answered). 17 rejected — see the Review Triage Log
for the reasoning on the substantive ones.

**Follow-up review recommendation:** false. Patched findings — high 0, medium 0, low 2;
score 3x0 + 1x2 = 2, below 5.

**Verification**
- `npx vitest run src/components/workbench/__tests__/settings-api-mcp-pane.test.tsx
  src/lib/__tests__/workbench-settings.test.ts src/lib/__tests__/workbench-api-mcp-settings.test.ts`
  — 314 passed.
- `npx vitest run` — 8878 passed, 1 skipped, 1 failed:
  `FilesystemStorageProvider > reapStrandedScratchFiles > stops at STRANDED_SCRATCH_CANDIDATE_CAP`,
  a 5s-timeout case that plants 503 files. Confirmed PRE-EXISTING rather than assumed: the same
  case fails the same way on a clean worktree at the baseline revision under full-suite load, and
  passes in isolation (`storage-fs.test.ts` alone, 95 passed, 710ms).
- `npx tsc --noEmit` — clean. `npx eslint` on every touched file — clean.
- The exhaustiveness guard was proven empirically during implementation by temporarily adding a
  fifth value to `ClassifiedLoopbackHealth`, which produced `TS2322 ... not assignable to 'never'`.
- Playwright was not run (needs a live app); the e2e change is a locator widening only.

**Residual risks**
- The `error` status still shares the unreachable sentence. Deliberate, stated in the spec's
  Always list and now pinned by a test, but it is the mapping most likely to be revisited.
- The e2e widening is unverified by any command in this run.
- The working tree carried five files from outside this run (`.env.example`, `src/app/layout.tsx`,
  `src/app/sign-in/[[...sign-in]]/page.tsx`, `src/lib/__tests__/workbench-chrome.test.ts`,
  `wrangler.jsonc` — an unrelated Clerk sign-in redirect change). They appeared after this
  session's clean-tree check, were never part of this bundle, and were deliberately left
  uncommitted rather than folded into this story's commit.
