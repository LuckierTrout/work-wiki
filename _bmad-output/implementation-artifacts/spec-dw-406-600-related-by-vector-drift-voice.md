---
title: 'Withdraw the superseded embedding-drift re-arm spec, and record that relatedByVector already speaks'
type: 'chore'
created: '2026-09-01'
baseline_revision: '9ef733cd986a7570a7f87fe0ecc276392028265a'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** `_bmad-output/implementation-artifacts/spec-dw-404-405-406-embedding-drift-rearm-gate.md` still reads `status: 'in-review'` although it was never implemented, and it prescribes a re-arm predicate (`matches.length > 0 && matches.every((m) => m.metadata.model === model)`) that contradicts the shipped gate the two 2026-08-22 human decisions produced — so a later automated run routing on that `in-review` status would re-derive the contradicting predicate and silently reopen settled work (DW-600). The other half of this bundle, DW-406, describes `relatedByVector` as mute; that description is stale — the door's warn and re-arm shipped in `aa427ff3` and its own spec `spec-dw-406-related-by-vector-drift-parity.md` is `status: 'done'`.

**Approach:** Retire the superseded spec in place — flip its status to `withdrawn` and add one prominent note, above its own contract, that names the decisions and the commits that closed DW-404, DW-405 and DW-406 — and record DW-406 as already resolved with the shipped evidence rather than re-implementing anything. No source file changes.

## Boundaries & Constraints

**Always:**
- The withdrawal note sits between the frontmatter and `<intent-contract>` of `spec-dw-404-405-406-embedding-drift-rearm-gate.md`, so a reader meets it before the prescription it invalidates.
- The note names full canonical commit hashes obtained from git, and states for each of DW-404, DW-405 and DW-406 where the shipped behaviour lives.
- The note says explicitly that the spec's prescribed predicate contradicts the shipped gate and must not be re-derived.
- The existing body of the withdrawn spec is left byte-identical below the note — it stays readable as the historical proposal it was.
- DW-406 is closed on evidence read from `HEAD`, not on a code change.

**Block If:**
- `spec-dw-404-405-406-embedding-drift-rearm-gate.md` turns out to carry a `<frozen-after-approval>` marker (it does not at the baseline revision) — a frozen human-owned contract may not be edited unattended.
- The shipped `relatedByVector` at `HEAD` is found to lack either the warn or the re-arm, which would make DW-406 live work rather than an already-resolved entry.

**Never:**
- Do not touch `src/lib/embeddings.ts` or any other source or test file. DW-406 needs no code.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`; the orchestrator records resolution.
- Do not edit `spec-dw-406-related-by-vector-drift-parity.md`, `spec-dw-404-drift-rearm-whole-window.md`, or `spec-dw-405-drift-rearm-labelled-proof.md` — all three are `done` and are the record the note points at.
- Do not delete the withdrawn spec, and do not rewrite its Intent, Boundaries, Design Notes or Verification to agree with the shipped gate — a withdrawn proposal is preserved as written, not retrofitted.
- Do not widen into `spec-dw-598-599-602-vector-drift-rearm-soundness.md`, the uncommitted in-flight spec for the drift re-arm's remaining soundness gaps; it is another session's work.

</intent-contract>

## Code Map

- `_bmad-output/implementation-artifacts/spec-dw-404-405-406-embedding-drift-rearm-gate.md` -- **the only file this spec edits.** 122 lines. Frontmatter `status: 'in-review'` on line 6; `<intent-contract>` opens on line 14. No `<frozen-after-approval>` marker. Its `## Design Notes` (line 97) is where the contradicting predicate is argued for.
- `src/lib/embeddings.ts` -- **read-only evidence.** `searchByVector` opens at line 1043; its re-arm PREDICATE is at line 1073 — `kept.length === matches.length && kept.some((m) => m.metadata.model === currentModel)`, the shipped gate, `some` not `every` (line 1095 is that branch's `rearmWarningAbout` CALL, not the gate). `relatedByVector` opens at line 1137 and already carries the full door: the stale-anchor `warnOnceAbout` at line 1151, its own re-arm predicate at line 1172 — `kept.length === others.length && kept.some((m) => m.metadata.model === currentModel)`, read over `others = matches.filter((m) => m.id !== slug)` at line 1170 so the anchor cannot vouch for itself — the shared-key `rearmWarningAbout(\`drift:${currentModel}\`)` at line 1178, and the dropped-every-match `warnOnceAbout` at line 1180. Both doors share the one key `drift:<active model>`.
- `src/lib/__tests__/embeddings.test.ts` -- **read-only evidence.** The `describe("relatedByVector")` block at lines 486–939 pins that door's drift sentences. The some-vs-every discriminator sits OUTSIDE that block, at line 1338 — `it("DOES re-arm on a window holding an ACTIVE-model vector beside an unlabelled one")`, inside `describe("searchByVector")` (opens line 1083) — and is the pin the withdrawal note cites, since its comment names `matches.every(...)` as the rejected alternative. 190 tests pass at the baseline revision.
- `_bmad-output/implementation-artifacts/spec-dw-406-related-by-vector-drift-parity.md` -- `status: 'done'`, `<frozen-after-approval>`. The spec DW-406 was actually built from; the note points readers here.
- `_bmad-output/implementation-artifacts/spec-dw-404-drift-rearm-whole-window.md`, `spec-dw-405-drift-rearm-labelled-proof.md` -- both `status: 'done'`. The specs the 2026-08-22 decisions were built from.
- Closing commits, full hashes verified with `git log`:
  - DW-404 → `945de9bfb9b40aa863b9a9a4a93a60223648b1db`
  - DW-405 → `0349df96eea85b82adc933ac2c0845bb92d9c4ad`
  - DW-406 → `aa427ff33b4b4cc36ee73602fa94334a017808bd` (code, tests AND `spec-dw-406-related-by-vector-drift-parity.md` at +108/−0, all in one sweep commit under another bundle's message) and `a858dcb506bc9939984fac709f470338462e77e7` (the later docs follow-up that amended that same spec file at +50/−1 and records why the two commits are split)
- `.bmad-loop/decisions.json` -- holds the 2026-08-29 `DW-600` decision ("Withdraw the spec") that this spec executes. Read-only.

## Tasks & Acceptance

**Execution:**
- `_bmad-output/implementation-artifacts/spec-dw-404-405-406-embedding-drift-rearm-gate.md` -- change frontmatter `status: 'in-review'` to `status: 'withdrawn'` -- an `in-review` status is a routable state; it is what would make a later run pick this spec up and re-derive its predicate.
- `_bmad-output/implementation-artifacts/spec-dw-404-405-406-embedding-drift-rearm-gate.md` -- insert a `## Withdrawal Note` section between the closing `---` of the frontmatter and the `<intent-contract>` line, recording: (a) that DW-404 and DW-405 were settled by the two 2026-08-22 human decisions and closed by `945de9bf` and `0349df96`; (b) that DW-406 was closed separately by `aa427ff3` with its spec artifact in `a858dcb5`, and that `relatedByVector` now carries both the warn and the re-arm on the shared `drift:<active model>` key; (c) that this spec's `matches.every(...)` predicate contradicts the shipped `kept.some(...)` gate and must not be re-derived from this document -- a status flip alone leaves the contradicting prescription unlabelled for the next reader.

**Acceptance Criteria:**
- Given `spec-dw-404-405-406-embedding-drift-rearm-gate.md` after the change, when its frontmatter is parsed, then `status` is `withdrawn` and no other frontmatter field has changed.
- Given a reader opening that file, when they reach the `<intent-contract>` line, then they have already passed a `## Withdrawal Note` naming all four closing commits by full hash and stating that the prescribed predicate contradicts the shipped gate.
- Given the file after the change, when its content from `<intent-contract>` to end of file is compared with the baseline revision, then it is byte-identical.
- Given the repository after the change, when `git status --porcelain` is inspected, then no file under `src/` is modified.
- Given `HEAD` at the baseline revision, when `relatedByVector` in `src/lib/embeddings.ts` is read, then it calls both `warnOnceAbout` and `rearmWarningAbout` on the key `drift:<active model>` — the evidence on which DW-406 is recorded resolved rather than implemented.
- Given the file after the change, when its `## Withdrawal Note` headings are counted, then exactly one exists — a re-run over an already-withdrawn file must not append a second note.

## Spec Change Log

## Review Triage Log

### 2026-09-01 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 11: (high 0, medium 3, low 8)
- defer: 0
- reject: 14: (high 0, medium 0, low 14)
- addressed_findings:
  - `[medium]` `[patch]` The withdrawal note claimed one predicate at "both doors"; `relatedByVector` reads its window over `others` (anchor excluded, `src/lib/embeddings.ts:1170`), not `matches`. Quoted each door's gate separately with the anchor-exclusion clause.
  - `[medium]` `[patch]` The note reversed DW-406's provenance. `aa427ff3` landed code, tests AND the parity spec (+108/-0) in one sweep commit; `a858dcb5` amended that spec (+50/-1). Corrected in the note and in the Code Map.
  - `[medium]` `[patch]` The note asserted shipped behaviour with no as-of anchor while DW-598/DW-599/DW-602 stay open against this same gate. Anchored every code claim to `9ef733cd` and named the open residue.
  - `[low]` `[patch]` The two 2026-08-22 decisions had no pointer and are not in `.bmad-loop/decisions.json`. Cited `deferred-work-archive.md:3458` and `:3471` by decision label.
  - `[low]` `[patch]` "Pinned by tests" named no test. Cited `embeddings.test.ts:1338` — the some-vs-every discriminator — by name and line.
  - `[low]` `[patch]` The rebuttal of the withdrawn spec's mutation check was a strawman (it referred to a pin that spec would have written, not one in the tree). Rephrased to the accurate inverse-pin point.
  - `[low]` `[patch]` "An automated run falls through" was an unverified universal; no schema reads spec status. Scoped the claim to build-auto's spec-file route, in both the note and the Design Notes.
  - `[low]` `[patch]` Code Map line anchors were wrong — the predicate is at `embeddings.ts:1073`, not 1095 (that is the `rearmWarningAbout` call); `relatedByVector` opens at 1137. Corrected and added the 1172/1170 anchors.
  - `[low]` `[patch]` Test-evidence citation excluded the pin it depended on. Recut to `describe("relatedByVector")` 486–939 plus the discriminator at 1338.
  - `[low]` `[patch]` Design Notes inverted the DW-600 decision ("anticipated this"). Rewritten: the decision scoped DW-406 out, the bundle intent pairs it back in, baseline evidence makes closing-on-read the honest disposition.
  - `[low]` `[patch]` Re-run behaviour was unpinned and the four-hash check was misfiled as manual. Added an AC and a command asserting exactly one `## Withdrawal Note` heading, and promoted the `git cat-file -t` loop into Verification > Commands.

  Applying the patch set left a duplicated stale copy of the note in the target file (the byte-identity check could not see it, since the orphaned fragment no longer began with a bare `<intent-contract>` line). Removed the 47 orphaned lines and re-ran the full verification set.

## Design Notes

Why the note goes above `<intent-contract>` rather than at the end: everything below that line is a machine-readable contract that downstream skills lift verbatim. A trailing note is read last, if at all, and does not travel with the block that carries the wrong predicate. Placing it first costs nothing and puts the correction in front of the prescription.

Why `withdrawn` and not `done` or `blocked`: `done` would claim the work shipped as specified, which is exactly the false reading to prevent; `blocked` invites a retry. `withdrawn` is the status the 2026-08-29 human decision names, and it is deliberately outside the `draft | ready-for-dev | in-progress | in-review | done | blocked` set that build-auto's spec-file route resumes from, so that route does not pick the spec up. No schema or validator reads spec status — the consumers are LLM-executed skill instructions — so the claim is scoped to that route rather than asserted of every reader.

Why the body is preserved verbatim: the spec is a record of a proposal made under two decisions that could not both be applied literally. Its Design Notes reason that out. Rewriting it to match the shipped gate would destroy the reasoning while leaving the artifact looking authoritative.

On DW-406: the bundle intent describes `relatedByVector` as having "no `warnOnceAbout`/`rearmWarningAbout` call anywhere in the function" at lines 1086 and 1097. Those anchors are from an older revision. At the baseline revision the function carries three drift branches, its own spec is `done`, and 190 embedding tests pass — the entry is stale, not live.

Why that is recorded here rather than deferred: the 2026-08-29 decision scoped DW-406 OUT of the withdrawal, leaving it "to be re-filed on its own terms if it is still wanted". It did not anticipate that DW-406 was already closed; it simply declined to rule on it. The bundle intent then pairs DW-406 back in with DW-600, so this spec has to say something about it. Since the evidence at the baseline revision shows the work already shipped, the honest disposition is to record it closed on read evidence — not to re-file it as live work, and not to re-implement it.

## Verification

**Commands:**
- `sed -n '1,20p' _bmad-output/implementation-artifacts/spec-dw-404-405-406-embedding-drift-rearm-gate.md` -- expected: `status: 'withdrawn'` in frontmatter, then a `## Withdrawal Note` heading, then `<intent-contract>`.
- `git diff --stat` -- expected: exactly one tracked file changed, `spec-dw-404-405-406-embedding-drift-rearm-gate.md`, with insertions only apart from the one status line.
- `git diff -- _bmad-output/implementation-artifacts/spec-dw-404-405-406-embedding-drift-rearm-gate.md` -- expected: one `-status: 'in-review'` / `+status: 'withdrawn'` pair plus one contiguous added block before `<intent-contract>`; no other removed lines.
- `git status --porcelain -- src` -- expected: empty.
- `grep -c '^## Withdrawal Note$' _bmad-output/implementation-artifacts/spec-dw-404-405-406-embedding-drift-rearm-gate.md` -- expected: `1` exactly — backs the re-run acceptance criterion; a second run must not append a duplicate note.
- `for h in 945de9bfb9b40aa863b9a9a4a93a60223648b1db 0349df96eea85b82adc933ac2c0845bb92d9c4ad aa427ff33b4b4cc36ee73602fa94334a017808bd a858dcb506bc9939984fac709f470338462e77e7; do git cat-file -t $h; done` -- expected: four lines, each `commit` — this is the only check backing the Always constraint that the note names full canonical hashes obtained from git.
- `npx vitest run src/lib/__tests__/embeddings.test.ts` -- expected: 190 passed, unchanged from baseline — confirms this run altered no behaviour and that the DW-406 pins hold.

## Auto Run Result

Status: done

### Implemented change

DW-600 is executed as specified by its 2026-08-29 human decision: `spec-dw-404-405-406-embedding-drift-rearm-gate.md` moves from `status: 'in-review'` to `status: 'withdrawn'`, and a `## Withdrawal Note` is inserted above its `<intent-contract>` so a reader meets the correction before the prescription it invalidates. The note names the two 2026-08-22 decisions and where they are archived, the four closing commits by full hash, both doors' shipped predicates as of `9ef733cd`, the test that discriminates `some` from `every`, and the DW-598/DW-599/DW-602 residue that may yet supersede the quoted code. Everything from `<intent-contract>` to EOF is byte-identical to the baseline.

DW-406 required no code. At the baseline revision `relatedByVector` already carries the whole drift door — a `warnOnceAbout` at the stale-anchor early return (`src/lib/embeddings.ts:1151`), a `rearmWarningAbout` on a window that proves a rebuild (`:1178`), and a `warnOnceAbout` when the model filter drops every other match (`:1180`) — all on the `drift:<active model>` key `searchByVector` uses. Its own spec `spec-dw-406-related-by-vector-drift-parity.md` is `status: 'done'`. The ledger entry's premise ("no `warnOnceAbout`/`rearmWarningAbout` call anywhere in the function", at lines 1086 and 1097) is stale: it was written against a revision predating `aa427ff3`. DW-406 is therefore recorded resolved on read evidence, not re-implemented.

### Files changed

- `_bmad-output/implementation-artifacts/spec-dw-404-405-406-embedding-drift-rearm-gate.md` -- status flipped to `withdrawn`; `## Withdrawal Note` inserted above the contract. +79 / -1.
- `_bmad-output/implementation-artifacts/spec-dw-406-600-related-by-vector-drift-voice.md` -- this spec (new).
- No source or test file touched.

### Review findings

- Patches applied: 11 (high 0, medium 3, low 8).
- Items deferred: 0.
- Items rejected: 14 — chiefly findings directed at the deferred-work ledger (orchestrator-owned and explicitly forbidden to this run), a request for an I/O matrix on a doc-only change, and frontmatter/formatting cosmetics.
- Follow-up review recommended: **true**. Patched severities: high 0, medium 3, low 8 → score `3x3 + 1x8 = 17`, at or above the threshold of 5.

### Verification performed

- `sed -n '1,20p'` on the target -- PASS: `status: 'withdrawn'`, then `## Withdrawal Note`, then the note body.
- `git diff --stat` -- PASS: one tracked file, 79 insertions / 1 deletion.
- `git diff` on the target -- PASS: the sole removed line is `-status: 'in-review'`.
- `git status --porcelain -- src` -- PASS: empty.
- `grep -c '^## Withdrawal Note$'` -- PASS: `1`.
- Four-hash `git cat-file -t` loop -- PASS: four x `commit`.
- Tail byte-identity, `<intent-contract>` to EOF, baseline vs working tree -- PASS: both `decd41328796e5e355dc467d08c5ed143c05becf`.
- `npx vitest run src/lib/__tests__/embeddings.test.ts` -- PASS: 190 passed, unchanged from baseline.

### Residual risks

- `withdrawn` is unprecedented in this repository (235 spec artifacts otherwise use `done`, `in-review`, `in-progress`). It is what the human decision prescribes, and no schema or validator reads spec status, but the fall-through behaviour is a property of LLM-executed skill instructions rather than of enforced code.
- DW-598, DW-599 and DW-602 remain open against the same re-arm gate, and a spec for them was in flight in this working tree during this run. The note is anchored to `9ef733cd` and names that residue, but its quoted predicates will need a refresh if that work lands.
- The deferred-work ledger still reads `status: open` for DW-406 and DW-600, with DW-406's stale reason text intact. That is orchestrator-owned by instruction; DW-406 in particular is closed on read evidence rather than on a diff, which is not the signal a sweep normally consumes.
- That in-flight sibling spec contains a parenthetical describing this target as "still `in-review`", now stale. It belongs to another session and was not touched.
