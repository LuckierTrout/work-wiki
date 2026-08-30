---
title: 'DW-336: pin the embedding-substitution sentence across its two surfaces'
type: 'chore'
created: '2026-08-30'
status: 'done'
baseline_revision: '7d170fe87a7ec226e2257129b8f4893bc7397717'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The embedding-substitution sentence exists as two hand-maintained twins — the flat `/settings` page's JSX in `EmbeddingSettings.tsx` and the canvas's `settingsModelSubstitutedCopy` in `workbench-settings.ts` — and nothing pins that they keep saying the same thing. Their one deliberate difference ("the model above" vs "the model that is set") is argued in both files, but every OTHER clause is duplicated by hand, so a reword to either side leaves the other stale with every existing test green.

**Approach:** The two surfaces must keep wording that one clause differently (the canvas box is empty whenever `EMBEDDING_MODEL` owns the value, so it cannot point at a control), so a single shared copy function is ruled out. Instead add a parity suite that pins both surfaces against one shared clause list plus the one recorded difference, following the repo's existing `read-only-copy-parity.test.ts` idiom: the flat sentence is read from a MOUNT (what the owner actually reads), the canvas sentence from the copy function, and the two are asserted character-identical once the divergent clause is normalized.

## Boundaries & Constraints

**Always:**
- Read the flat sentence out of a rendered mount (`EmbeddingSettings`), never out of the `.tsx` source text — the claim is what the owner reads, not what the file spells.
- Read the canvas sentence by calling `settingsModelSubstitutedCopy`, the module that owns it.
- The one divergent clause is pinned as a RECORDED DIFFERENCE, both directions: the flat sentence says "the model above" and NOT "the model that is set"; the canvas sentence the reverse.
- Every shared clause is asserted against BOTH sentences from one list, so a reword to either side fails until both are considered.
- Whitespace-normalize the mounted text (`/\s+/g` → single space, trimmed) before comparing — JSX indentation is not part of the sentence.
- Mounted suite ⇒ `*.test.tsx` under a `__tests__` directory (dom project). `workbench-settings.ts` is client-safe, so the dom project can import it.

**Block If:**
- Making the two sentences character-identical would require changing either surface's shipped wording. This is a pinning task; the deliberate divergence stands.

**Never:**
- Do not merge the two surfaces onto one shared copy function, and do not change either shipped sentence.
- Do not export a clause list from shipped code purely for the test's benefit — the list lives in the test.
- Do not touch `settings-vector-namespace.test.tsx`'s hand-typed `substituted()` helper: it is a MOUNTED restatement of the canvas sentence and already fails loudly on a canvas reword, which is why it is deliberate there.
- Do not weaken or rewrite the existing assertions in `embedding-settings-override.test.tsx`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Both surfaces agree | `EmbeddingSettings` mounted with `overridden: true, modelInEffect: "@cf/baai/bge-m3"`; `settingsModelSubstitutedCopy("@cf/baai/bge-m3")` | Every shared clause appears in both; the two sentences are equal once "the model above" is rewritten to "the model that is set" | No error expected |
| Divergent clause held both ways | The same two sentences | Flat contains "the model above" and not "the model that is set"; canvas the reverse | No error expected |
| Model name carried | in-effect model `"nomic-embed-text"` | Both sentences contain that exact model id, and neither contains the model that is SET | No error expected |
| Either side reworded | A clause edited on one surface only | The shared-clause assertion for that clause fails, and the normalized-equality assertion fails | Failure is the point |

</intent-contract>

## Code Map

- `src/components/EmbeddingSettings.tsx:281-291` -- the flat `/settings` twin: a `<p id={OVERRIDE_NOTE_ID}>` (id literal `"embeddingModelOverride"`, line 96) rendered when `showOverrideNote = overridden && modelInEffect !== null` (line 161). The model name sits in `<span className="font-mono">`; the clause reads "the model above". Component and `EmbeddingSettingsProps` are exported (lines 28+).
- `src/lib/workbench-settings.ts:571-578` -- `settingsModelSubstitutedCopy(modelInEffect)`, the canvas twin. Its JSDoc (lines 549-570) is the argued record of why the two differ; module is client-safe by its own header.
- `src/components/workbench/SettingsCanvas.tsx:562` -- the only caller; joins the string into the model row's `aria-describedby` hint.
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- the idiom to follow: a dedicated seam file, character-identical where the surfaces mirror, differences pinned EXPLICITLY (see the "Revert is narrower … on purpose" case, ~line 90) so a real drift never reads as an intended one.
- `src/components/__tests__/embedding-settings-override.test.tsx` -- the flat side's existing mount suite; the gap is here: it asserts only `toContain("Not in effect")` plus the model id (lines ~96-99), so the tail clauses are unpinned. Its `props()` factory (line ~21) is the shape the new suite mounts.
- `src/components/workbench/__tests__/settings-vector-namespace.test.tsx:365-382` -- the canvas side's mount suite; `substituted()` restates the sentence verbatim ON PURPOSE and already fails on a canvas reword. Read-only for this task.
- `AGENTS.md` "Test environments" -- `*.test.tsx` ⇒ dom project (jsdom, RTL); must live under `__tests__`; `vitest.config.ts` throws at config load if a `*.test.tsx` falls outside the dom include.

## Tasks & Acceptance

**Execution:**
- `src/components/__tests__/embedding-substitution-copy-parity.test.tsx` -- NEW dom suite. Header comment states the seam: two surfaces, one fact, two sentences, and what drift it catches. Define one `SHARED_CLAUSES` array (the wording both surfaces must carry: `"Not in effect."`, `"This deployment embeds with"`, `"the embedding provider cannot serve"`, `"so it uses its own default instead."`, `"Vectors are tagged with the model that produced them"`, `"an index built with a different model needs rebuilding."`). Add a `flatSentence(model)` helper that renders `EmbeddingSettings` with `overridden: true` and reads `document.getElementById("embeddingModelOverride")?.textContent` whitespace-normalized, and read the canvas side via `settingsModelSubstitutedCopy(model)`. Cases: (1) every shared clause appears in both; (2) the divergent clause is held both directions; (3) the two are character-identical once the flat "the model above" is rewritten to "the model that is set"; (4) both name the in-effect model and neither names the model that is set. `cleanup()` in `afterEach`.
- `src/lib/workbench-settings.ts` -- amend the `settingsModelSubstitutedCopy` JSDoc's "NOT shared verbatim with `EmbeddingSettings.tsx`" paragraph to name the new parity suite as the thing that now holds the two together. Wording only; no behavior change.
- `src/components/EmbeddingSettings.tsx` -- add one line to the comment above the override note pointing at the same parity suite, so a reader editing the JSX learns there is a twin before rewording it. Wording only; no behavior change.

**Acceptance Criteria:**
- Given both surfaces unchanged, when the suite runs, then it passes.
- Given a clause reworded in `EmbeddingSettings.tsx`'s override note only, when the suite runs, then it fails.
- Given a clause reworded in `settingsModelSubstitutedCopy` only, when the suite runs, then it fails.
- Given the whole suite, when it runs, then no assertion reads either sentence out of source-file text.
- Given the full test run, when `pnpm test` completes, then every previously passing suite still passes and no shipped sentence changed.

## Spec Change Log

## Review Triage Log

### 2026-08-30 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 0, low 5)
- defer: 0
- reject: 9: (high 0, medium 0, low 9)
- addressed_findings:
  - `[low]` `[patch]` The character-identical case could be defanged: `flat.replace(FLAT_CLAUSE, CANVAS_CLAUSE)` is a no-op if the flat side drifts onto the canvas clause, so the two compare equal and it passes. Added `expect(flat).toContain(FLAT_CLAUSE)` inside that case, so the teeth no longer depend on the sibling divergence case existing.
  - `[low]` `[patch]` `flatSentence()` defaulted to `overridden: true` with `modelSource: "none"` and `effectiveModel: null` — a pair `getEffectiveSettings` cannot produce — so three of four cases claimed parity about an unshippable state. Defaulted to the literal DW-274 pairing (`modelSource: "env"` with a real `effectiveModel`).
  - `[low]` `[patch]` `flatSentence()` rendered without cleanup and read through the global `document.getElementById`; two calls in one `it` would return the FIRST of two duplicate-id notes and compare a stale sentence as fresh. Now queries the container `render()` returned.
  - `[low]` `[patch]` Both new comments overstated what is pinned, and the suite header argued mount-superiority for the flat side while calling the function for the canvas without saying so. Comments now name the third copy (`DEPLOY.md`), state that the canvas RENDER hop is held by `settings-vector-namespace.test.tsx` rather than here, use a repo-rooted path on both ends, and attach a direction to the divergence.
  - `[low]` `[patch]` `DEPLOY.md:358-361` block-quotes the canvas variant verbatim with nothing pinning it, so a canvas reword left the operator doc stale and green. Added a case mirroring the repo's DW-222 idiom (`workbench-settings.test.ts:5349`): un-wrap every `>` block, whitespace-normalize, and compare for STRICT equality against the copy function handed a backticked ellipsis, which reproduces the quote exactly.

## Design Notes

The normalized-equality assertion is the teeth; the clause list is the legibility. Equality alone fails with an unreadable diff of two 250-character strings, and a clause list alone lets a re-punctuated sentence through. Both, in one suite:

```ts
const CANVAS_CLAUSE = "the model that is set";
const FLAT_CLAUSE = "the model above";
// …
expect(flatSentence(MODEL).replace(FLAT_CLAUSE, CANVAS_CLAUSE)).toBe(
  settingsModelSubstitutedCopy(MODEL),
);
```

Reading the flat side from a mount rather than from the `.tsx` source is deliberate: the JSX splits the sentence across a `<span>` and four source lines, so a source-text scan would pin the file's formatting rather than the sentence, and would keep passing if the `<p>` stopped rendering at all.

## Verification

**Commands:**
- `pnpm exec vitest run --project dom src/components/__tests__/embedding-substitution-copy-parity.test.tsx` -- expected: all cases pass.
- `pnpm exec vitest run --project dom src/components/__tests__/embedding-settings-override.test.tsx src/components/workbench/__tests__/settings-vector-namespace.test.tsx` -- expected: unchanged, all pass.
- `pnpm test` -- expected: full suite green, no new failures.
- `pnpm exec tsc --noEmit` -- expected: clean (there is no `typecheck` script in `package.json`).

**Manual checks (if no CLI):**
- Temporarily reword one clause on each side in turn and confirm the new suite fails each time; revert both.

## Auto Run Result

Status: done
Blocking condition: none

**Summary.** DW-336 is closed by pinning rather than merging. The two surfaces must keep wording one clause differently — the canvas box is empty whenever `EMBEDDING_MODEL` owns the value, so its sentence cannot point at a control — so a single shared copy function was ruled out, which is the branch the intent itself offers. A new parity suite now holds the sentence across every copy of it: shared clauses asserted against both surfaces from one list, the two compared character-identical once "the model above" is normalized to "the model that is set", that divergence pinned in both directions, and — found in review — `DEPLOY.md`'s block quote pinned against the copy function too. No shipped sentence changed.

**Files changed.**
- `src/components/__tests__/embedding-substitution-copy-parity.test.tsx` — NEW dom suite (10 tests): the seam. Reads the flat side from a MOUNT (not source text, which would keep passing if the `<p>` stopped rendering), the canvas side from `settingsModelSubstitutedCopy`, and the operator doc from `DEPLOY.md`.
- `src/lib/workbench-settings.ts` — comment only: the `settingsModelSubstitutedCopy` JSDoc now names what holds the wording together, names the third copy, and states what the suite does NOT hold (the `SettingsCanvas.tsx` render hop, pinned by `settings-vector-namespace.test.tsx`).
- `src/components/EmbeddingSettings.tsx` — comment only: the JSX comment above the override note now names the twin, the third copy, and which surface says which clause.

**Review findings breakdown.** 5 patches applied (all low, listed in the triage log above); 0 deferred; 9 rejected as noise — a completeness guard on `SHARED_CLAUSES` (the equality case already carries the teeth, so a shrinking list cannot let a reword through), the near-tautological canvas half of the model-name case, the duplicated `props()` factory (the repo's shared-test-helper set is a closed, test-enforced list of six), pinning the `<span className="font-mono">` (styling, not wording), per-assertion labels in `it.each` (the test title already names the clause), an `it.each` over `modelSource` (the note does not branch on it), a no-note guard case (covered by `embedding-settings-override.test.tsx`), an empty-model canvas edge (guarded at `SettingsCanvas.tsx:562` and pre-existing), and ledger/spec housekeeping (orchestrator-owned).

**Follow-up review recommendation.** true. Patched findings by severity: high 0, medium 0, low 5. Score = 3×0 + 1×5 = 5, which is ≥ 5.

**Verification.**
- `pnpm exec vitest run --project dom src/components/__tests__/embedding-substitution-copy-parity.test.tsx` — 10/10 pass.
- `pnpm exec vitest run --project dom src/components/__tests__/embedding-settings-override.test.tsx src/components/workbench/__tests__/settings-vector-namespace.test.tsx` — 46/46 pass, both untouched.
- `pnpm exec tsc --noEmit` — clean, exit 0.
- `pnpm test` — 351 files, 8190 passed, 1 skipped (pre-existing), 0 failures.
- Negative control, run independently of the implementer and reverted each time: rewording `"needs rebuilding."` in `EmbeddingSettings.tsx` failed 2 cases; the same reword in `settingsModelSubstitutedCopy` failed 3 (clause, equality, `DEPLOY.md`); the same reword in `DEPLOY.md` failed 1. Working tree confirmed clean after each revert.

**Residual risks.**
- The `DEPLOY.md` pin depends on the doc writing the model placeholder as a backticked `…`. Changing that placeholder fails the case as a wording drift when no wording moved. The failure is loud and its fix is one string; strict equality is what buys the guarantee that no other clause drifted, so loosening it was declined.
- The character-identical comparison assumes `textContent` whitespace collapses to the canvas string. That holds while the `<p>`'s only intra-sentence markup is the inline `<span>`. A block-level element added inside it could fail the case for a formatting reason — again loudly, not silently.
- The canvas RENDER is still held only by `settings-vector-namespace.test.tsx`, not by this seam. That is stated in both the suite header and the copy function's JSDoc rather than left to be discovered.
