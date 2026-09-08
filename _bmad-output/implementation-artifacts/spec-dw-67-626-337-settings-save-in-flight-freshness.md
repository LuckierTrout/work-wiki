---
title: 'Settings canvas: freeze the form while a save is in flight, and stop the substitution note describing pre-edit state'
type: 'bugfix'
created: '2026-09-01'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
baseline_revision: '6679cac4ce93d287e9b71a441e07d06805ab5b47'
deferred: []
---

<intent-contract>

## Intent

**Problem:** `SettingsCanvas.save` captures `draftRef.current` before up to two sequential `REQUEST_TIMEOUT_MS` awaits (the DW-555 recovery read, then the PUT) and a landed save re-seeds the whole draft from the answered payload, while every field keys its refusal only off `readOnly`/`envPinned` — so anything typed during that window is neither sent nor kept, and nothing says so (DW-67, DW-626). Separately, the model row's substitution note is payload-derived while the two sentences beside it are draft-derived, so an owner correcting the model still reads "Not in effect. This deployment embeds with …" about pre-edit server state (DW-337).

**Approach:** Name one standing refusal on the canvas — read-only OR a save in flight — and route every editable control's refusal and every `aria-describedby` through it, with the save bar's standing sentence gaining a third state that says why the form is inert. Suppress the substitution note while `embeddingModel` or `embeddingProvider` is dirty, decided by a new pure predicate in `@/lib/workbench-settings`.

## Boundaries & Constraints

**Always:**
- The freeze covers the WHOLE save window, including the DW-555 recovery read: `setSaving(true)` already precedes it, so the predicate must key off `saving` and nothing narrower.
- Refusal conventions stay as this surface already spells them: `readOnly` for text/secret inputs, `aria-disabled` + a handler that commits nothing for selects, checkboxes and `.wb-set-action` buttons. Never `disabled` for a value-bearing control.
- Every control the freeze refuses announces WHY: its description routes through `describedBy`, which appends the save bar's note.
- Every decision stays a pure function in `@/lib/workbench-settings`; the component applies rules, it does not restate them.
- `SettingsApiMcpPane`'s controls edit the same draft and ride the same PUT, so they freeze too — via a prop, not a second predicate.
- The source scans in `src/lib/__tests__/workbench-settings.test.ts` that count and quote these predicates are part of the change: update them to the new spelling and counts, keeping their reasoning intact.

**Block If:**
- Freezing the form would require changing `save`'s request sequence or the re-seed itself — it must not.

**Never:**
- Do not merge, diff or replay edits typed during the window; the recorded decision is to freeze, not to merge.
- Do not withdraw `aria-invalid` while saving — a momentary request does not make a wrong value unfixable, and flickering the mark would be noise.
- Do not touch the DW-555 recovery read's own logic, the version handling, or the copy of `settingsModelSubstitutedCopy` (three surfaces pin it character-identical).
- No new `fetch(`, no `"/api/` literal and no third `fetchWorkbenchSettings(` call in the canvas.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Save in flight | Writable deployment, PUT pending | Text/secret inputs `readOnly`, selects and checkboxes `aria-disabled="true"`, `.wb-set-action` buttons refused; a change event commits nothing | No error expected |
| Recovery-read window | Held payload carries no version, Save clicked, GET pending | Same inert state, from the click through both awaits | No error expected |
| Save lands | PUT resolves ok | Fields writable again, draft re-seeded from the answered payload | No error expected |
| Save refused | PUT resolves non-ok | Fields writable again, every edit still on screen, the server's sentence shown | Server sentence, unchanged |
| Frozen control announced | Save in flight, control focused | The control's own hint plus the save bar's in-flight sentence | No error expected |
| Substitution, clean draft | `embeddingModelOverridden`, `embeddingModelInEffect` set | The model row announces the substitution note as today | No error expected |
| Substitution, dirty identity | Owner edits the embedding model (or provider) box | The note is withheld until a save lands and re-seeds; the env sentence and gate complaint stay | No error expected |

</intent-contract>

## Code Map

- `src/components/workbench/SettingsCanvas.tsx` — the whole surface. `save` at :254 (`const current = draftRef.current` :255, `setSaving(true)` :257), the DW-555 recovery read at :306-315, the PUT and re-seed at :318-345. Refusal sites to move onto the new predicate: `textRow` `readOnly=` :599 and its `onChange` :594; `providerRow` `aria-disabled=` :647 and guard :649; `secretRow` `readOnly=` :703 and the Remove button :725; `researchProviderRow` :788/:790; the embedding provider select :956/:958; `vectorRefused` :490; Intake keep-parsed :1178; MinerU enable :1203 and mode :1234. `describedBy` :540, `readOnlyNoteId` :523, the bar note :1387-1396, Save button :1414. `modelSubstitution` :504, rendered into the model row's hint at :1044.
- `src/components/workbench/SettingsApiMcpPane.tsx` — owns no draft; takes `stored`, `field`, `describedBy`, `apply` from the canvas. Freeze sites: `apiEnabled` checkbox :173/:175, `allowUnauthenticated` checkbox :201/:203, the Generate-token button :249-260. Props interface at :75-91.
- `src/lib/workbench-settings.ts` — copy and pure rules. `SETTINGS_SAVE_BAR_COPY` :192, `SETTINGS_SAVING_COPY` :195, `SETTINGS_READ_ONLY_COPY` :242, `settingsModelSubstitutedCopy` :588, `settingsDirty` :2803 (the shape the new predicate mirrors: compare against `settingsDraftFromPayload(payload)`, not against the payload).
- `src/lib/__tests__/workbench-settings.test.ts` — the node suite. Source scans that pin the exact predicate spellings and counts at :5320-5510 (`aria-disabled={stored.readOnly || undefined}` ×4 canvas / ×2 pane, `aria-disabled={stored.readOnly || envPinned || undefined}` ×2, `if (stored.readOnly || envPinned) return;` ×2, `if (stored.readOnly) return;`, `disabled={` ×3, `aria-describedby={describedBy(` ×9 canvas / ×2 pane, `const readOnlyNoteId = field("bar-note");`, the `vectorRefused` regex, `apiPane).not.toMatch(/(?<![-\w])disabled=\{/)`). Draft/dirty cases at :1503-1533; `draftEmbeddingKeyStored` describe at :6215 is the shape for the new predicate's describe.
- `src/components/workbench/__tests__/settings-harness.tsx` — the shared mount harness: `settingsPayload()`, `installSettingsFetchMock()` (call once at module top level, hold the mock), `mountSettings(category, stored)`, `announcedFor(control)`.
- `src/components/workbench/__tests__/settings-embedding-provider-switch.test.tsx` :213-250 — the `mockImplementation` one-response-per-call idiom for driving real PUTs from a mount.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` :365-478 — the DW-312 describe that owns the substitution render, with its hand-typed `substituted()` sentence. The DW-337 case belongs here.
- `src/components/workbench/__tests__/settings-read-only.test.tsx` :335-350 — "leaves every control interactive on a writable deployment", the no-stray-`aria-disabled="false"` pin the new attribute must not break.
- `src/app/globals.css` :4902 (`.wb-set-input[readonly]`), the `[aria-disabled="true"]` faces for `.wb-set-select`, `.wb-set-check input` and `.wb-set-action` — all already exist; the freeze needs no new CSS.
- `DEPLOY.md` :396-403 — the operator prose claiming both surfaces withhold the note "on the same rule". Read-only evidence: the block quote at :391-394 is pinned character-identical by `src/components/__tests__/embedding-substitution-copy-parity.test.tsx`; the surrounding prose is not, so amend the prose and leave the quote alone.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-settings.ts` — add `SETTINGS_SAVING_NOTE_COPY` (the save bar's in-flight sentence, parallel in shape to `SETTINGS_READ_ONLY_COPY`) and a pure predicate `draftEmbeddingIdentityDirty(draft, payload)` answering whether `embeddingModel` or `embeddingProvider` has moved since seeding — mirroring `settingsDirty`'s comparison against `settingsDraftFromPayload(payload)` so "typed and undone" is correctly clean. Document why the substitution note is the one thing on that row that has to yield to the draft.
- `src/components/workbench/SettingsCanvas.tsx` — name the standing refusal once (read-only OR `saving`) beside `vectorRefused`, route every editable control's refusal attribute AND its handler guard through it, rename `readOnlyNoteId` to a name that fits the three-state note, make the bar note say the in-flight sentence while saving, and gate `modelSubstitution` on the new predicate. Leave `aria-invalid`, the recovery read, the version handling and the re-seed untouched.
- `src/components/workbench/SettingsApiMcpPane.tsx` — take the canvas's refusal as a prop and apply it to both checkboxes and the Generate-token button, keeping the pane free of `disabled={`.
- `src/lib/__tests__/workbench-settings.test.ts` — update the source scans to the new spellings and counts, extend their comments to say what the freeze is, and add a describe for `draftEmbeddingIdentityDirty` (clean when seeded, dirty on either field, clean again when reverted, unmoved by an unrelated edit).
- `src/components/workbench/__tests__/settings-save-in-flight.test.tsx` — new mounted suite (dom project): the fields are inert from the click through the PUT, inert through the DW-555 recovery read on a versionless payload, a change event during the window commits nothing and is not in the sent body, the refusal is announced, and everything is writable again after the save lands and after a refusal.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` — add the DW-337 edit-then-read case to the DW-312 describe: the note is announced on a clean draft, withheld the moment the model box (and, separately, the provider select) moves, with the env sentence and gate complaint still on the row.
- `DEPLOY.md` — amend the prose beside the pinned block quote so it states the canvas's extra suppression rule instead of claiming both surfaces withhold on the same one.

**Acceptance Criteria:**
- Given a writable deployment with a save in flight, when the owner focuses any editable Settings control, then its description includes the save bar's in-flight sentence rather than only the standing "Changes apply after saving".
- Given a save in flight, when a change event reaches any Settings field on any category (including API + MCP), then the draft does not move and the sent PUT body does not carry that value.
- Given a payload holding no version, when Save is clicked, then the form is inert from the click until the PUT settles — the recovery read's window included — and `fetch` is still called exactly twice for that save.
- Given a save that lands, when the re-seed completes, then every control is interactive again and carries no `aria-disabled` attribute at all.
- Given a save that is refused, when the sentence arrives, then every control is interactive again and every edit is still on screen.
- Given a payload reporting a substitution, when the owner edits the embedding model box or moves the provider select, then the substitution note is no longer announced on the model row while the env sentence and the gate complaint still are; when the draft is put back to the stored values, the note returns.

## Design Notes

One named predicate, not `|| saving` sprinkled per control — the same argument `vectorRefused` already makes in this file: the attribute that announces a refusal and the handler that enforces it must not be able to drift. The source scans exist to make an added control impossible to slip past the convention, so moving their counts and spellings is the intended cost of the change, not collateral.

`readOnly` is what freezes a text box for a sighted owner; the handler guard is what makes the freeze enforceable and observable in jsdom, where a programmatic change event is not stopped by the attribute. Both, therefore, everywhere.

The substitution note is deliberately payload-derived (it is a server-resolved fact the browser cannot compute), and that stays true — the change is only that it goes quiet while the two fields it describes hold something the server has not seen. The env sentence and the gate complaint on the same row are draft-derived and unaffected, so the row never mixes freshness contracts again.

## Verification

**Commands:**
- `pnpm exec vitest run --project dom src/components/workbench/__tests__/settings-save-in-flight.test.tsx src/components/workbench/__tests__/settings-vector-namespace.test.tsx src/components/workbench/__tests__/settings-read-only.test.tsx src/components/workbench/__tests__/settings-embedding-provider-switch.test.tsx src/components/workbench/__tests__/settings-api-mcp-pane.test.tsx` — expected: all pass.
- `pnpm exec vitest run --project node src/lib/__tests__/workbench-settings.test.ts` — expected: all pass, including the updated source scans.
- `pnpm test` — expected: the full two-project run passes.
- `pnpm lint` and `pnpm exec tsc --noEmit` — expected: no new errors.

## Auto Run Result

Status: done
Blocking condition: none

### Implemented change

The Settings canvas now names one standing refusal — `editRefused = stored.readOnly || saving` — and routes every editable control's refusal attribute **and** its handler guard through it, so the whole form is inert for the save request's duration, the DW-555 recovery read's leg included (`setSaving(true)` precedes it, so keying on `saving` covers both awaits by construction). Text and secret boxes go `readOnly`, selects, checkboxes and `.wb-set-action` buttons carry `aria-disabled` with a handler that commits nothing; nothing value-bearing uses native `disabled`. The save bar's standing sentence gained a third state, `SETTINGS_SAVING_NOTE_COPY`, which `describedBy` appends to every refused control so the freeze announces its reason instead of reading as "dimmed". `SettingsApiMcpPane` takes the same term as a prop rather than deriving a second one. Separately, the payload-derived substitution note is withheld while the embedding identity is dirty (`draftEmbeddingIdentityDirty`), with the `EMBEDDING_MODEL`-owned case carved out — there the variable wins over the box, so the note stays true whatever is typed and only a provider move withholds it.

### Files changed

- `src/lib/workbench-settings.ts` — `SETTINGS_SAVING_NOTE_COPY`; `draftEmbeddingIdentityDirty(draft, payload)`.
- `src/components/workbench/SettingsCanvas.tsx` — `editRefused` named once and wired through every control; `readOnlyNoteId` → `barNoteId` with a three-state bar note; `describedBy` keyed on the new term; `modelSubstitution` gated; `save` wrapped in `try`/`finally` so the freeze cannot strand the form.
- `src/components/workbench/SettingsApiMcpPane.tsx` — new `editRefused` prop applied to both switches and the Generate-token button, which now announces its refusal.
- `src/components/workbench/__tests__/settings-save-in-flight.test.tsx` — new mounted suite (8 cases) driving a hand-released PUT so the window is a place assertions can stand in.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx` — three DW-337 mounted cases in the DW-312 describe.
- `src/lib/__tests__/workbench-settings.test.ts` — source scans moved to the new spellings and counts, with new negative pins; `draftEmbeddingIdentityDirty` describe.
- `DEPLOY.md` — operator prose for the canvas's extra suppression rule and its `EMBEDDING_MODEL` limit, replacing the claim that both surfaces withhold on the same rule.

### Review findings breakdown

- Patches applied: 8 (medium 2, low 6) — the `EMBEDDING_MODEL`-owned regression in the new predicate; `try`/`finally` around `save`; the Remove button announcing the refusal only; its missing mounted announcement assertion; a mounted `embeddings` case for the two compound predicates (mutation-checked: reverting `vectorRefused` fails it and only it); one term for the bar note's read-only arm; "in flight" → "in progress"; and the false `DEPLOY.md` claim about the flat page, corrected and put back into third person.
- Items deferred: 0.
- Items rejected: 10 — chiefly the flat `/settings` surface carrying the same two defects (a sibling surface no ledger entry names), a proactive live-region announcement at the moment the freeze begins (a design choice beyond the recorded decision, and the controls announce on focus), the note staying withheld after a refused save (the rule as decided), and several test-ergonomics notes about idioms this repo already uses.
- Follow-up review recommended: **true** — patched severities high 0, medium 2, low 6; score `3 × 2 + 1 × 6 = 12`, which is ≥ 5.

### Verification

- `pnpm exec vitest run --project dom` over the five Settings suites — 115 passed.
- `pnpm exec vitest run --project node src/lib/__tests__/workbench-settings.test.ts` — 274 passed.
- `pnpm exec tsc --noEmit` — clean. `pnpm lint` — exit 0 (only the pre-existing `jsx-ast-utils` `TSNonNullExpression` notices).
- `pnpm test` — 8870 passed, 1 skipped, with 2 failures in `src/lib/__tests__/storage-fs.test.ts > reapStrandedScratchFiles`. Pre-existing and load-sensitive: the same test fails on the untouched baseline (verified by stashing this work and running the full suite there), passes in isolation on this tree, and passed in one of the full runs made here. This bundle touches no storage code.
- Every I/O matrix row is covered by a test that ran and passed in the runs above.

### Residual risks

- The freeze is verified in jsdom, where a programmatic change event is not stopped by `readOnly` or `aria-disabled`; the suite therefore pins "nothing commits if something is typed" and both the attribute and the guard separately. What a real browser refuses at the box is not executable here.
- `AGENTS.md` was modified in this working copy by another process during the run (Workbench/Clerk redirect facts and a `max_parallel = 1` warning about concurrent `bmad-loop` runs on one checkout). It is not part of this change and was deliberately left uncommitted.

## Review Triage Log

### 2026-09-01 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 2, low 6)
- defer: 0
- reject: 10
- addressed_findings:
  - `[medium]` `[patch]` `draftEmbeddingIdentityDirty` suppressed the substitution note on a model edit the env owns, hiding a still-true sentence — `embeddingModelAnswer` prefers `getEmbeddingModelOverride()`, so the stored box does not resolve while `EMBEDDING_MODEL` is set. The model leg now counts only when `payload.envEmbeddingModel === null`, with node and mounted cases for both directions.
  - `[medium]` `[patch]` `DEPLOY.md` claimed the flat page's note is "a standalone paragraph … rather than part of a mixed description"; `EmbeddingSettings.tsx` joins `OVERRIDE_NOTE_ID` into the model input's own `aria-describedby`. Replaced with the divergence stated as fact, and the paragraph put back into third person.
  - `[low]` `[patch]` `save` had no `try`/`finally`, so a future throw would leave the whole form permanently inert rather than merely disabling Save. Wrapped, with the sequence untouched and a source-scan pin.
  - `[low]` `[patch]` `secretRow`'s Remove button carried `describedBy(hintId)`, permanently duplicating the input's hint on an idle deployment; it now carries `describedBy(undefined)`, i.e. the refusal alone.
  - `[low]` `[patch]` The Remove button's in-flight announcement was pinned only by a source-scan count; the mounted suite now asserts it before, during and after the window.
  - `[low]` `[patch]` The mounted suite exercised only `llm-models` and `api-mcp`, leaving `vectorRefused` and the two `editRefused || envPinned` selects on source scans alone. Added an `embeddings` case; reverting `vectorRefused` fails it and only it.
  - `[low]` `[patch]` The bar note read `payload.readOnly` while `editRefused` read `stored.readOnly` — the same object under two names, in the one place the change argues must not drift.
  - `[low]` `[patch]` `SETTINGS_SAVING_NOTE_COPY` said "while a save is in flight", transport vocabulary the surface uses nowhere else; now "while a save is in progress".
