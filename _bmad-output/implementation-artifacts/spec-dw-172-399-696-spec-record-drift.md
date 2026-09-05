---
title: 'DW-172/399/696 — Spec record drift corrections'
type: 'chore'
created: '2026-09-05'
status: 'done' # draft | ready-for-dev | in-progress | in-review | done | blocked
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The same strict-reads spec still plans work on `src/cli.ts:431` that
      already landed with the opposite handling, so its plan sections carry the
      second half of DW-696's hazard that this bundle's Never clause held out
      of scope.
    evidence: |-
      DW-696's ledger reason names two stale items in
      `spec-dw-495-496-497-merge-base-strict-reads.md`. This bundle fixed the
      first (the `:366` Never-list entry). The second is untouched: `:65` reads
      "`src/cli.ts:431` -> `:468` -- `runUpdate` ... A rethrow reaches
      `main().catch` at `:816` ... correct already, no repair needed", and `:94`
      instructs "pass the option at `:431`". Both are false against HEAD and
      contradict each other. `runUpdate` is now declared at `src/cli.ts:441`,
      converts at `:465` with `{ fresh: true, strict: true }`, and has its own
      local catch at `:466`-`:472` printing
      `Error: could not read page "<slug>": ... Nothing was written.` -- the
      distinct message the earlier bundle required, not the `main().catch`
      relay `:65` prescribes. A later sweep acting on `:65` could remove it.
      DW-495/496/497 are all `done` in the ledger, so nothing else will revisit
      that record.
    location: >-
      _bmad-output/implementation-artifacts/spec-dw-495-496-497-merge-base-strict-reads.md:65
    severity: low
baseline_revision: 'e7c7f1e6ba8886162331517cc371ed9f51661871'
---

<intent-contract>

## Intent

**Problem:** Three completed or superseded spec records under `_bmad-output/implementation-artifacts/` carry stale content that can mislead a later sweep. (DW-172) The DW-30 AC edit inserted two lines at `epics.md:399`, so four line-addressed citations below it — `spec-1-6:246` → `epics.md:440`, `spec-1-5:383` → `:423`, `spec-1-5:391` → `:413`/`:414`, `spec-1-4:136` → `:530` — each land two lines short. (DW-399) `spec-dw-66-72-settings-credential-fidelity.md:5` still reads `status: 'in-progress'` under a per-provider embedding-keying approach that was superseded and never landed, while all six entries it names are terminal in the ledger. (DW-696) `spec-dw-495-496-497-merge-base-strict-reads.md:37` lists `src/cli.ts:366` in its **Never** clause as a "pure display read"; that site is `runCreate`'s create-conflict guard, since moved to `:378` and already converted to a strict read under DW-425, so a later sweep acting on that clause could revert the guard.

**Approach:** Correct each record in place and record the correction in that record's own `## Spec Change Log`. Bump the four citations to their current `epics.md` lines. Mark the superseded settings spec `withdrawn` with a `## Withdrawal Note` above its preserved `<intent-contract>`, following the precedent in `spec-dw-404-405-406-embedding-drift-rearm-gate.md`. Drop `` `:366` `` from the strict-reads Never list. These are record corrections, not amendments of approved content: no approved decision, acceptance criterion, or design ruling changes meaning.

## Boundaries & Constraints

**Always:**
- Every correction is documentation only. No file under `src/`, no test, and no configuration changes.
- Each of the four citation bumps is a digit change to the line number alone; the surrounding sentence, the quoted text and the claim it supports stay byte-identical.
- Each corrected line's new target must be verified against the current `_bmad-output/planning-artifacts/epics.md` before the edit, and must quote or entail the same clause the old citation quoted.
- Each of the three touched records gains one dated entry in its own `## Spec Change Log` stating that this was a record correction, not an amendment of approved content.
- `spec-dw-66-72-settings-credential-fidelity.md`'s `<intent-contract>` block and everything after it stay byte-for-byte as written; only frontmatter `status` changes and a new section is inserted above the contract.

**Block If:**
- A citation's new target line does not carry the clause the old citation quoted (i.e. the shift is not a clean +2 for that site) — that would mean the record is wrong about more than a line number, which is a content question this correction cannot settle.

**Never:**
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md` or `deferred-work-archive.md` — the orchestrator owns resolution recording.
- Do not edit `_bmad-output/planning-artifacts/epics.md`. The AC text is correct; the citations are what drifted.
- Do not correct `epics.md:<line>` citations in records this bundle does not name (`epic-1-retro-2026-08-22.md`, `epic-2-retro-2026-08-22.md`, `spec-dw-127-309-doc-drift-corrections.md`, `spec-dw-30-wiki-lens-copy-and-invariant.md`), and do not touch `src/lib/workbench-split.ts:45`, already corrected to `:442`.
- Do not change `spec-dw-495-496-497-merge-base-strict-reads.md`'s own `status`, its `## Code Map` line 65, its `## Tasks & Acceptance` line 94, or any entry other than the `:366` item in the Never list.
- Do not restate or re-derive the superseded per-provider keying plan in the Withdrawal Note, and do not re-open any terminal ledger entry.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 320px floor citation | `spec-1-6:246` cites `epics.md:440` | Reads `epics.md:442`; `epics.md:442` is "**Then** Chat (when visible) cannot go below 320px" | No error expected |
| Edit-control copy source | `spec-1-5:383` cites `epics.md:423` | Reads `epics.md:425`; `epics.md:425` is "**Given** I choose Edit" | No error expected |
| Empty-Preview sentence | `spec-1-5:391` cites `epics.md:413` and `:414` | Reads `:415` and `:416`; those lines carry "copy is “Select a file to preview.”" and "Preview is not a third column until a tree pick" | No error expected |
| Story 2.1 tree-header ban | `spec-1-4:136` cites `epics.md:530` | Reads `epics.md:532`; `epics.md:532` is "tree header uses Import/Upload, not “Open project folder” (UX-DR5)" | No error expected |
| Superseded settings spec | `spec-dw-66-72:5` reads `status: 'in-progress'` | Reads `status: 'withdrawn'`; a `## Withdrawal Note` above `<intent-contract>` names the superseding spec per entry | No error expected |
| Stale Never clause | `spec-dw-495-496-497:37` lists `src/cli.ts:366` | `:366` is gone from the list; `:279` and `:327` remain; a change-log entry says why | No error expected |
| Sweep re-scan | Any later grep for `src/cli.ts:366` in the strict-reads spec | No hit — the create-conflict guard cannot be read back as a pure display read | No error expected |

</intent-contract>

## Code Map

Documentation only. Every path below is a record under `_bmad-output/`; no source file is in scope.

- `_bmad-output/planning-artifacts/epics.md` — READ ONLY, the citation target. The DW-30 edit (`1efde5ef`) replaced one line — old `:400`, Story 1.4's `**Then** the trees show that Wiki’s files` — with three, so every line at or below the old `:401` shifted +2. (The Intent above says `:399`; the edit site is `:400`. The net +2 and all five corrected targets are unaffected, and each was verified against the current file rather than derived from the shift.) Verified current lines: `:415` "copy is “Select a file to preview.”", `:416` "Preview is not a third column until a tree pick", `:425` "**Given** I choose Edit", `:442` "**Then** Chat (when visible) cannot go below 320px", `:532` "tree header uses Import/Upload, not “Open project folder” (UX-DR5)".
- `_bmad-output/implementation-artifacts/spec-1-6-drag-resize-and-durable-layout.md` (`status: 'done'`) — `:246`, in `## Design Notes` (outside `<intent-contract>`, which closes at `:152`). `## Spec Change Log` at `:199` is currently empty.
- `_bmad-output/implementation-artifacts/spec-1-5-view-first-preview-with-gfm-and-wikilinks.md` (`status: 'done'`) — `:383` is a Copy-table row in `## Design Notes`; `:391` is a Design Notes paragraph. Both sit past `</intent-contract>` at `:206`. `## Spec Change Log` at `:268` has existing entries — append only.
- `_bmad-output/implementation-artifacts/spec-1-4-knowledge-tree-and-file-tree.md` (`status: 'done'`) — `:136` is a **Never** bullet INSIDE `<intent-contract>` (`:106`–`:164`). This is the one citation bump that touches contract text; the recorded DW-172 decision authorizes it explicitly as a citation correction. `## Spec Change Log` at `:217` has existing entries — append only.
- `_bmad-output/implementation-artifacts/spec-dw-66-72-settings-credential-fidelity.md` (`status: 'in-progress'`, 158 lines) — committed alone in `ee382ec2` with zero source changes, so nothing from it landed. `src/lib/config.ts:95,97` still declare flat `embeddingBaseUrl?`/`embeddingApiKey?` with no per-provider maps, confirming the plan is dead. `<intent-contract>` opens at `:27`. Ledger: DW-66 `done 2026-08-29`, DW-67 `done 2026-09-01`, DW-69 `done 2026-08-21`, DW-70 `done 2026-09-01`, DW-71 `done 2026-08-20`, DW-72 `done 2026-08-21`.
- Superseding records, all `status: 'done'` — DW-66 → `spec-dw-66-559-env-locked-credential-affordances.md`; DW-67 → `spec-dw-67-626-337-settings-save-in-flight-freshness.md`; DW-69 and DW-72 → `spec-dw-69-72-embedding-provider-secret-isolation.md`; DW-70 → `spec-dw-68-70-embedding-config-plumbing.md`; DW-71 → `spec-dw-71-326-272-settings-config-resolution-hardening.md`.
- `_bmad-output/implementation-artifacts/spec-dw-404-405-406-embedding-drift-rearm-gate.md` — REUSE, the shape to copy: `status: 'withdrawn'` in frontmatter plus a `## Withdrawal Note` section between the frontmatter and `<intent-contract>`, with a bolded do-not-implement sentence and a per-entry list of what actually settled each one.
- `_bmad-output/implementation-artifacts/spec-dw-495-496-497-merge-base-strict-reads.md` (`status: 'in-review'`) — `:37` is the Never bullet listing pure display reads. Leave its `status` alone; DW-495/496/497 are all `done` in the ledger but that spec's own status is not this bundle's to change.
- `src/cli.ts` — READ ONLY, the evidence. `:279` (inside `runReingest`, declared at `:272`) and `:327` (inside `runRead`, declared at `:325`) are still option-less display reads, so they stay in the Never list. The create-conflict guard is now `:378`, `await readWikiPage(slug, { fresh: true, strict: true })`, with a DW-195/DW-378 comment block at `:366`–`:375` and a catch at `:379` printing `Error: could not read page "<slug>": … Nothing was created.` — i.e. `:366` is a comment line today, and the read it guards is already strict.

## Tasks & Acceptance

**Execution:**
- `_bmad-output/implementation-artifacts/spec-1-6-drag-resize-and-durable-layout.md` — at `:246` change `` `epics.md:440` `` to `` `epics.md:442` ``; add the first `## Spec Change Log` entry recording the citation correction.
- `_bmad-output/implementation-artifacts/spec-1-5-view-first-preview-with-gfm-and-wikilinks.md` — at `:383` change `` `epics.md:423` `` to `` `epics.md:425` ``; at `:391` change `` `epics.md:413` `` to `` `epics.md:415` `` and `` `epics.md:414` `` to `` `epics.md:416` ``; append one `## Spec Change Log` entry covering both lines.
- `_bmad-output/implementation-artifacts/spec-1-4-knowledge-tree-and-file-tree.md` — at `:136` change `` `epics.md:530` `` to `` `epics.md:532` ``; append one `## Spec Change Log` entry noting the bullet sits inside `<intent-contract>` and that a citation correction is not an amendment of the approved content.
- `_bmad-output/implementation-artifacts/spec-dw-66-72-settings-credential-fidelity.md` — set frontmatter `status` to `'withdrawn'`; insert a `## Withdrawal Note` between the frontmatter and `<intent-contract>` naming, per entry, the ledger closure date and the spec that actually settled it, and stating that nothing from this spec landed (evidence: `ee382ec2` carries no source change; `src/lib/config.ts` is still flat). Leave the contract and everything below it byte-for-byte.
- `_bmad-output/implementation-artifacts/spec-dw-495-496-497-merge-base-strict-reads.md` — at `:37` remove `` `:366` `` from the `src/cli.ts` group in the Never bullet, leaving `` `src/cli.ts:279`, `:327` ``; add a `## Spec Change Log` entry recording the removal, that `:366` was `runCreate`'s create-conflict guard (now `:378`) already converted to a strict read under DW-425, and that the record correction changes no approved decision.

**Acceptance Criteria:**
- Given `epics.md` as it stands today, when every `epics.md:<line>` citation in `spec-1-4`, `spec-1-5` and `spec-1-6` is resolved against it, then each cited line carries the clause its surrounding sentence quotes or relies on.
- Given someone scanning `_bmad-output/implementation-artifacts/` for open work, when they read `spec-dw-66-72-settings-credential-fidelity.md`'s frontmatter, then it does not claim work is under way, and the reason plus the superseding record for each named entry is on the page.
- Given a later sweep looking for reads it must not convert, when it reads `spec-dw-495-496-497-merge-base-strict-reads.md`'s Never clause, then `src/cli.ts`'s create-conflict guard is not listed there and cannot be reverted on that authority.
- Given all edits are applied, when the repository is diffed, then the only changes are to the five named records under `_bmad-output/implementation-artifacts/` plus this spec file itself (new in that same directory); nothing under `src/`, no test, no configuration and no ledger file has changed.

## Spec Change Log

## Review Triage Log

### 2026-09-05 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 0, low 6)
- defer: 1: (high 0, medium 0, low 1)
- reject: 8
- addressed_findings:
  - `[low]` `[patch]` `spec-dw-66-72:5` read `status: 'withdrawn'` beside an inline legend that excludes that value, so the record contradicted itself — trailing comment dropped to match the `spec-dw-404-405-406` precedent.
  - `[low]` `[patch]` The Withdrawal Note opened "as a record correction under DW-399", presenting an open ledger observation as a recorded ruling — reworded to credit the `spec-record-drift` sweep bundle and to state that no decision was entered against DW-399.
  - `[low]` `[patch]` The change-log entry written into `spec-dw-495-496-497:117` attributed the conversion to DW-195/DW-378 while this spec's task text said DW-425 — now names the `dw3-create-conflict-fresh-reads` sweep (`f1c69c6a`) as the landing commit, DW-195/DW-378 as the reasons the guard's comment gives, and warns that the id the ledger currently numbers DW-425 is an unrelated Settings observation.
  - `[low]` `[patch]` `## Code Map` annotated `src/cli.ts:279` as "(`runShow`-side)"; no `runShow` exists — corrected to `runReingest` (`:272`) and `runRead` (`:325`).
  - `[low]` `[patch]` Acceptance Criterion 4 claimed nothing outside the five named records changed, which this spec's own new file contradicts — reworded to admit it, matching what the `git status` command already expects.
  - `[low]` `[patch]` Two **Always** clauses had no covering command — added a `git diff -U0` check proving each citation bump is digit-only with the surrounding sentence byte-identical, and a `grep -c` proving each of the three records gained exactly one dated change-log entry. The first draft of the diff check filtered headers with `^[-+][-+]`, which silently swallowed the `spec-1-4:136` list bullet; the filter now matches `+++ `/`--- ` exactly and the trap is documented inline.

Deferred: the second half of DW-696's hazard — `spec-dw-495-496-497`'s `## Code Map:65` and `## Tasks & Acceptance:94` still plan `src/cli.ts:431` work that landed with the opposite handling. Real, and named by DW-696's own reason, but this bundle's intent scoped the deliverable to the Never clause and its **Never** forbids touching those two lines.

Rejected: the `## Intent`'s `epics.md:399` for the DW-30 edit site (actually `:400`; already corrected in `## Code Map`, no target derived from it, and the contract is read-only at review); the other anchors in the strict-reads Never bullet resolving to unrelated text at HEAD (that spec states its anchors are at `868d2009`, and every other entry is out of this bundle's scope); same-shape `epics.md` citation drift in the retro records and `spec-dw-127-309` (excluded by the intent by name); adding the quoted clause beside each corrected citation to survive the next shift (that would amend contract text past the digit-only limit this spec sets); concurrent-edit risk on the `in-review` strict-reads spec (DW-495/496/497 are all `done`; no session is in flight); the "one clean +2" phrasing not accounting for `e679ef66`'s later edit at `epics.md:1466` (below every corrected target, and each target was verified directly rather than derived); `build-auto`'s spec-file route having no branch for `withdrawn` (it HALTs `blocked` on an unrecognized status, which is the safe outcome and is true of the precedent too); and the absence of a lint or test preventing recurrence (a tooling change the intent does not ask for).

## Design Notes

**Why a citation correction is not an amendment.** The recorded DW-172 decision ("Correct the citations … recording that a citation correction is not an amendment of the approved content") draws the line this work stays on: the pointer moves, the claim does not. `spec-1-4:136`'s bullet still bans Import/Upload in the tree header for the same reason and on the same authority; only the address of that authority is repaired. That is what makes the one bump inside a `done` spec's `<intent-contract>` safe — and it is also the limit. If a target line no longer carried the quoted clause, the record would be wrong about substance, and that is a Block If, not an edit.

**Why `withdrawn` and not `done` for the settings spec.** `done` would claim its plan shipped. It did not: `ee382ec2` landed the 158-line spec with no source change, and `src/lib/config.ts` still declares one flat `embeddingApiKey` and one flat `embeddingBaseUrl`. The repo already has exactly one precedent for "the entries closed, but by a different approach than this record prescribes" — `spec-dw-404-405-406-embedding-drift-rearm-gate.md` — and it is the right shape here for the same reason: the danger is not that the record is idle, it is that its contract reads as a live instruction. Preserving `<intent-contract>` untouched under a note that says "do not implement this, and do not re-derive it" keeps the reasoning as history without keeping it as an order.

**Why only `:366` leaves the strict-reads Never list.** `:279` and `:327` are still option-less `readWikiPageWithFrontmatter` calls whose answers only get printed, so the clause is right about them. `:366` is the one member that was never a display read: it is inside `runCreate`'s guard block, whose `null` is the sole authorization for the create below, and the read there is already `{ fresh: true, strict: true }`. Deleting the whole bullet would discard a correct constraint; deleting one entry from it is the smallest edit that removes the revert hazard.

## Verification

**Commands:**
- `grep -n 'epics\.md:' _bmad-output/implementation-artifacts/spec-1-4-knowledge-tree-and-file-tree.md _bmad-output/implementation-artifacts/spec-1-5-view-first-preview-with-gfm-and-wikilinks.md _bmad-output/implementation-artifacts/spec-1-6-drag-resize-and-durable-layout.md` — expected: `:442`, `:425`, `:415`, `:416`, `:532` present; no `:440`, `:423`, `:413`, `:414`, `:530` in these three files.
- `sed -n '442p;425p;415p;416p;532p' _bmad-output/planning-artifacts/epics.md` — expected: each line carries the clause its citing sentence quotes.
- `grep -n "^status:" _bmad-output/implementation-artifacts/spec-dw-66-72-settings-credential-fidelity.md` — expected: `status: 'withdrawn'`.
- `git diff -- _bmad-output/implementation-artifacts/spec-dw-66-72-settings-credential-fidelity.md` — expected: exactly one changed line (`status`) plus the inserted `## Withdrawal Note`; no hunk at or below `<intent-contract>`.
- `grep -n 'cli\.ts:366' _bmad-output/implementation-artifacts/spec-dw-495-496-497-merge-base-strict-reads.md` — expected: no output.
- `sed -n '37p' _bmad-output/implementation-artifacts/spec-dw-495-496-497-merge-base-strict-reads.md` — expected: the bullet still reads `src/cli.ts:279`, `:327` and still bans converting pure display reads.
- `git diff e7c7f1e6ba8886162331517cc371ed9f51661871 -U0 -- _bmad-output/implementation-artifacts/spec-1-4-knowledge-tree-and-file-tree.md _bmad-output/implementation-artifacts/spec-1-5-view-first-preview-with-gfm-and-wikilinks.md _bmad-output/implementation-artifacts/spec-1-6-drag-resize-and-durable-layout.md | grep -E '^[-+]' | grep -vE '^(\+\+\+|---) ' | grep 'epics\.md:'` — expected: exactly four `-`/`+` pairs (one per citation site); within each pair the two lines are identical except for the cited line number, proving the bump is a digit change and the surrounding sentence, quoted text and claim are byte-identical. (The header filter must match `+++ `/`--- ` exactly: `spec-1-4:136` is a markdown list bullet, so its diff lines read `+- `/`-- ` and a `^[-+][-+]` filter would silently drop that site.)
- `grep -c 'Record correction, 2026-09-05' _bmad-output/implementation-artifacts/spec-1-4-knowledge-tree-and-file-tree.md _bmad-output/implementation-artifacts/spec-1-5-view-first-preview-with-gfm-and-wikilinks.md _bmad-output/implementation-artifacts/spec-1-6-drag-resize-and-durable-layout.md` — expected: `1` for each of the three files, proving each gained exactly one dated `## Spec Change Log` entry for this correction.
- `git status --porcelain` — expected: only the five named records under `_bmad-output/implementation-artifacts/` plus this spec.

## Auto Run Result

Status: done

**Summary.** Corrected three classes of stale content in completed or superseded spec records under `_bmad-output/implementation-artifacts/`, each of which could mislead a later sweep. Documentation only — no file under `src/`, no test, no configuration, and no ledger file was touched.

**Files changed.**
- `spec-1-4-knowledge-tree-and-file-tree.md` — the Story 2.1 citation in the `<intent-contract>` **Never** bullet bumped `epics.md:530` → `:532`, plus one dated change-log entry (DW-172).
- `spec-1-5-view-first-preview-with-gfm-and-wikilinks.md` — Design Notes citations bumped `epics.md:423` → `:425` and `:413`/`:414` → `:415`/`:416`, plus one dated change-log entry (DW-172).
- `spec-1-6-drag-resize-and-durable-layout.md` — the canvas-floor citation bumped `epics.md:440` → `:442`, plus the file's first change-log entry (DW-172).
- `spec-dw-66-72-settings-credential-fidelity.md` — `status: 'in-progress'` → `'withdrawn'` with a `## Withdrawal Note` above a byte-for-byte preserved `<intent-contract>`, naming the ledger closure date and superseding record for all six bundled entries (DW-399).
- `spec-dw-495-496-497-merge-base-strict-reads.md` — `` `:366` `` removed from the `src/cli.ts` group in the pure-display-read **Never** bullet, plus one change-log entry (DW-696).
- `spec-dw-172-399-696-spec-record-drift.md` — this spec (new).

**Review findings.** 6 patches applied (0 high, 0 medium, 6 low); 1 item deferred (low); 8 rejected. Follow-up review recommendation: **false** — patched severity score is 0 high, so no further iteration is warranted.

**Verification.** All nine `## Verification` commands ran and passed. The five `epics.md` targets (`:415`, `:416`, `:425`, `:442`, `:532`) each carry the exact clause their citing sentence quotes; no `:440`/`:423`/`:413`/`:414`/`:530` literal remains in the three story records; the two pre-existing citations above the DW-30 edit site (`epics.md:154`, `:157`, `:387`) are untouched. `git diff -U0` shows exactly four citation `-`/`+` pairs differing only in the cited digits, so no surrounding sentence, quoted text or claim moved. Each of the three records carries exactly one `Record correction, 2026-09-05` change-log entry. `spec-dw-66-72`'s diff is one deleted `status` line plus one insert above `<intent-contract>`; everything from the contract to EOF is byte-identical to `HEAD`. `grep 'cli.ts:366'` in the strict-reads spec returns nothing, and `:37` still lists `src/cli.ts:279`, `:327` under an intact ban. `git status --porcelain` shows only the five named records plus this spec.

**Evidence behind the withdrawal.** `ee382ec2` committed `spec-dw-66-72` alone with no source change, and `src/lib/config.ts:95,97` still declare flat `embeddingBaseUrl?`/`embeddingApiKey?` with no per-provider maps — so the store-shape change its Approach rests on was never made. All six entries are terminal in the ledger (DW-66 `2026-08-29`, DW-67 `2026-09-01`, DW-69 `2026-08-21`, DW-70 `2026-09-01`, DW-71 `2026-08-20`, DW-72 `2026-08-21`), each closed by a `status: 'done'` record, and the two embedding entries were settled by clearing the stored value on a provider switch — the deliberate opposite of the per-provider keying the withdrawn spec proposed.

**Residual risks.**
- The corrected citations are still bare line numbers with no tooling behind them. Another `epics.md` insertion above `:532` re-breaks all four. Adding the quoted clause beside each pointer would survive a shift but exceeds the digit-only limit this spec set for editing approved content, so it was rejected rather than smuggled in.
- One item is deferred: `spec-dw-495-496-497`'s `## Code Map:65` and `## Tasks & Acceptance:94` still plan `src/cli.ts:431` work that landed with the opposite handling. DW-696's ledger reason names it; this bundle's intent scoped the deliverable to the Never clause, so it is recorded in frontmatter `deferred` for the orchestrator rather than fixed here.
- Two ledger records claim the id DW-425 — the entry in `deferred-work.md` is a Settings keyboard observation, while `spec-dw-425-create-conflict-fresh-reads.md` and commit `f1c69c6a` use it for the create-conflict work. Pre-existing and not this bundle's to resolve; the change-log entry written into `spec-dw-495-496-497` tells a later reader to chase the commit rather than the id.
- `## Intent` says the DW-30 edit site is `epics.md:399`; it is `:400`. `## Code Map` records the discrepancy. No corrected target was derived from the shift — each was resolved against the current file — so nothing downstream depends on it.
