---
title: 'Read-only kernel-writer coverage: the umbrella sentence, the widened door registry, the two putter backstops'
type: 'chore'
created: '2026-08-30'
baseline_revision: 'a7e26208e32984d8da19ed95ffa29f80f45e4cf4'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The door-coverage registry still omits every gated store writer outside the
      wiki-lifecycle family, so a future route importing one untreated stays
      invisible to the scan.
    evidence: |-
      `KERNEL_WRITERS` in `read-only-door-coverage.test.ts` now names the
      page/artifact, wiki-lifecycle and workspace-profile writers. Still absent
      and still carrying `assertWritable`: `createNamesTerm`, `updateNamesTerm`,
      `deleteNamesTerm` (`src/lib/names-terms.ts:322,354,378`),
      `createResearchProject` / `deleteResearchProject`
      (`src/lib/research-projects.ts`), `saveEmailIngestConfig`
      (`src/lib/email-ingest.ts:107`), plus `lifecycle.ts`'s
      `pruneStaleIndexEntry` (:1118) and `deleteWikiPageWhileLocked` (:1205).
      Their doors are enumerated by name in `read-only-copy-parity.test.ts`
      rather than derived, so nothing is broken today — the gap is prospective,
      the same one DW-315 named for the wiki-lifecycle writers. The new
      `KERNEL_WRITERS` docblock records the omission explicitly, so this is a
      recorded scope boundary rather than an oversight. Out of this bundle's
      intent, which names only the wiki-lifecycle and workspace-profile writers.
    location: >-
      src/lib/__tests__/read-only-door-coverage.test.ts:36
    severity: low
---

<intent-contract>

## Intent

**Problem:** Three read-only test gaps around the kernel writers. `WIKI_READ_ONLY_COPY` (the switcher's four-verb sentence) is the one client refusal constant `read-only-copy-parity.test.ts` never compares, though that suite's header promises every one is either character-identical to its door or recorded as a deliberate divergence. `read-only-door-coverage.test.ts` still names only four kernel writers, so the wiki-lifecycle and workspace-profile writers gated since DW-266/DW-314 are invisible to the scan that guards tomorrow's routes. And the two byte putters' `assertWritable` calls (`putWikiArtifact`, `putWorkspaceProfile`) are shadowed by every current caller's entry gate, so deleting either leaves the whole suite green.

**Approach:** Three test-only changes, no production behaviour touched. Add a `WIKI_READ_ONLY_COPY` case to the parity suite recording it as a deliberate umbrella over four doors, in the shape the Revert / Create page cases already use. Widen `KERNEL_WRITERS`, `WRITER_EXPORTS` and `WRITER_MODULES` in the door-coverage suite to the gated wiki-lifecycle and workspace-profile writers so both the route scan and the staleness re-derivation cover them. Add two cases to `read-only-kernel-gate.test.ts` that reach each putter with its entry gate already passed, asserting BYTES so neither case can be satisfied by a different gate firing.

## Boundaries & Constraints

**Always:**
- Test-only. No `src/lib/*.ts` or `src/app/**` production edit, and no change to any refusal sentence.
- Every added case must go RED if the gate it names is deleted, and the assertion must be on observable state (bytes, or the specific constant) — not merely `rejects.toThrow`, which a shadowing gate would also satisfy.
- New cases follow the file they land in: the parity suite's "recorded divergence" comment idiom, and `read-only-kernel-gate.test.ts`'s byte-snapshot helper.
- `putWikiArtifact` stays MODULE-PRIVATE and keeps taking no `WikiLockHeld` — that privacy is the documented reason it needs no token (`src/lib/wikis.ts:28-34`). Reach it through a real caller, never by exporting it for a test.
- `.test.ts` (node project) for all three files — they are string comparisons, source scans and library calls; none mounts a component.

**Block If:**
- Widening the door registry surfaces an API route that reaches one of the newly named writers with NEITHER an `isReadOnly()` gate nor an `isReadOnlyError(...)` branch — adding a treatment there is a production change outside this bundle.
- Pinning either putter cannot be done without exporting `putWikiArtifact` or otherwise weakening the `WikiLockHeld` proof.

**Never:**
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.
- Do not add `sweepOrphanWikiDirectories` to the registry: its only caller is `maintenance.ts`'s fail-soft dynamic-import wrapper, and reaching it would mean adding `@/lib/maintenance` to `WRITER_EXPORTS` — a different widening.
- Do not mock `assertWritable`, `isReadOnly` or `read-only.ts` to force a gate open. A stubbed gate proves nothing about the real one.
- Do not rename `YOPEDIA_READONLY` (frozen identifier); do not edit `llm-wiki.md`, `.github/` or `.yoyo/yoyo.toml`.
- No new e2e specs.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Umbrella sentence vs. its four doors | `WIKI_READ_ONLY_COPY` against `READ_ONLY_REFUSAL.wikiCreate` / `.wikiSwitch` / `.wikiRename` / `.wikiDelete` | Differs from all four, names all four verbs, names `read-only`; distinct from `WIKI_CREATE_READ_ONLY_COPY` and `WIKI_TEMPLATE_READ_ONLY_COPY` | Recorded divergence, not a failure |
| Widened route scan | Every `src/app/api/**/route.ts` importing a newly named writer | Each carries `isReadOnly()` or `isReadOnlyError(...)`; `untreated` stays `[]` | A hit here is the Block If above |
| Widened staleness re-derivation | `src/lib/wikis.ts` + `src/lib/workspace-profile.ts` scanned for exports calling a kernel writer | Every such export is already in `WRITER_EXPORTS`; `missing` stays `[]` | Failure names the export |
| `putWikiArtifact` backstop | `renameWiki` called while writable, `YOPEDIA_READONLY=1` set before its locked body runs | `retitlePurpose` swallows the `ReadOnlyError`; `wikis.json` moved, `purpose.md` heading UNCHANGED | Rename still resolves — the swallow is by design (`src/lib/wikis.ts:1349-1354`) |
| `putWorkspaceProfile` backstop | `YOPEDIA_READONLY=1`, direct call under a live `withWikiLock` token | Rejects with `ReadOnlyError` carrying `READ_ONLY_REFUSAL.wikiFileWrite`; the stored profile bytes are unchanged | `isReadOnlyError` matches |
| Writable control | Same two calls with `YOPEDIA_READONLY` unset | The heading IS retitled; the profile IS written | No error expected |

</intent-contract>

## Code Map

- `src/lib/__tests__/read-only-copy-parity.test.ts` -- target for DW-302. Header at :1-20 states the "character-identical OR recorded" rule. Idiom to copy: `it("Revert is narrower than the kernel sentence behind it, on purpose")` and `it("Create page is narrower…")`. Add `WIKI_READ_ONLY_COPY` to the existing `../workbench-tree` import at :25-28.
- `src/lib/workbench-tree.ts:118-134` -- `WIKI_READ_ONLY_COPY` = "Wikis cannot be created, switched, renamed or deleted while this deployment is read-only." Its docblock already states the four-verb intent; the test records it.
- `src/lib/read-only.ts:158-212` -- `wikiCreate`, `wikiTemplate`, `wikiRename`, `wikiDelete`, `wikiSwitch`, `wikiDirectorySweep`, `wikiFileWrite`. The four the umbrella covers are create/switch/rename/delete.
- `src/lib/__tests__/read-only-door-coverage.test.ts` -- target for DW-315. `KERNEL_WRITERS` :35-40, `WRITER_EXPORTS` :56-93 (`@/lib/wikis` currently `["writeWikiArtifact"]`), `WRITER_MODULES` :96-107 (no `wikis`, no `workspace-profile`), the third case's hand-written module→writers pairs :226-238.
- `src/lib/wikis.ts` -- gated entry points: `writeWikiArtifact`:902/924, `createWiki`:1089/1100, `applyScenarioTemplate`:1200/1210, `setCurrentWiki`:1304/1314, `renameWiki`:1413/1424, `deleteWiki`:2007/2019 (`export` line / `assertWritable` line — all within the third case's 1200-char head window). `putWikiArtifact`:355-363 is module-private; `retitlePurpose`:1356-1383 is its only caller that does NOT also reach `putWorkspaceProfile`, and its `catch` swallows (`:1381-1383`).
- `src/lib/workspace-profile.ts` -- `putWorkspaceProfile`:269-277 (exported, `assertWikiLockHeld` then `assertWritable(READ_ONLY_REFUSAL.wikiFileWrite)`), `saveWorkspaceProfile`:305-322 (gates at :318, then `withWikiLock`), `getWorkspaceProfile`:186, `emptyWorkspaceProfile`:68.
- `src/lib/wiki-lock.ts:95-110` -- `withWikiLock(owner, fn)` mints the `WikiLockHeld` token and retires it in `finally`. The only sanctioned way for a test to hold one.
- `src/lib/__tests__/read-only-kernel-gate.test.ts` -- target for DW-317. Env/tmpdir harness :44-80 (`YOPEDIA_READONLY` in `ENV_KEYS`, deleted in `beforeEach`), byte-snapshot helper :82+, existing lifecycle describe :312-518.
- Read-only evidence: all five wiki/workspace routes already carry BOTH treatments (`src/app/api/wikis/route.ts`, `wikis/current/route.ts`, `wikis/[id]/route.ts`, `wikis/[id]/template/route.ts`, `workspace-profile/route.ts`), so the widened scan is expected to stay green.

## Tasks & Acceptance

**Execution:**
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- import `WIKI_READ_ONLY_COPY` and add one case recording it as a deliberate four-verb umbrella: differs from each of the four server sentences, contains all four verbs and `read-only`, and is distinct from the two narrower constants on the same surface -- DW-302: the suite's own rule says every client constant is compared or recorded, and this one was neither.
- `src/lib/__tests__/read-only-door-coverage.test.ts` -- add `createWiki`, `applyScenarioTemplate`, `renameWiki`, `deleteWiki`, `setCurrentWiki` and `saveWorkspaceProfile` to `KERNEL_WRITERS`; add the matching `@/lib/wikis` and `@/lib/workspace-profile` entries to `WRITER_EXPORTS`; add `wikis` and `workspace-profile` to `WRITER_MODULES`; re-derive the third case's module→writers pairs from `KERNEL_WRITERS` instead of restating four by hand, and amend the file header and the "four kernel writers" wording it no longer matches -- DW-315: the staleness guard re-derives only from `KERNEL_WRITERS`, so a future route importing `createWiki` untreated would ship a 500 unnoticed.
- `src/lib/__tests__/read-only-kernel-gate.test.ts` -- add a `describe` for the two putter backstops: one case reaching `putWikiArtifact` through `renameWiki` with the flag set after its entry gate has run, asserting `purpose.md`'s heading is unchanged while `wikis.json` moved; one calling `putWorkspaceProfile` directly under a live `withWikiLock` token, asserting the rejection sentence and unchanged profile bytes; plus the writable control for both -- DW-317: both gates are shadowed by every current caller and are pinned by inspection only.

**Acceptance Criteria:**
- Given `read-only-copy-parity.test.ts`, when every exported `*_READ_ONLY_COPY` constant it imports is enumerated, then each appears in at least one assertion — `WIKI_READ_ONLY_COPY` included.
- Given `KERNEL_WRITERS` is the file's only hand-written list of writers, when the third case checks each writer still opens with `assertWritable`, then it iterates that list rather than a second hand-written copy of part of it.
- Given the `assertWritable` line is deleted from `putWikiArtifact`, when `pnpm exec vitest run --project node src/lib/__tests__/read-only-kernel-gate.test.ts` runs, then it fails.
- Given the `assertWritable` line is deleted from `putWorkspaceProfile`, when the same command runs, then it fails.
- Given `pnpm test` on the unmodified tree, when it completes, then every project passes and no production file has changed.

## Spec Change Log

## Review Triage Log

### 2026-08-30 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 0, medium 1, low 9)
- defer: 1: (high 0, medium 0, low 1)
- reject: 12: (high 0, medium 0, low 12)
- addressed_findings:
  - `[medium]` `[patch]` `@/lib/workspace-profile` was registered with only `saveWorkspaceProfile`; a probe route importing `putWorkspaceProfile` or `copyWorkspaceProfileIfAbsent` untreated passed the scan. Both added to `KERNEL_WRITERS` and `WRITER_EXPORTS`; mutation-confirmed live (deleting either gate now reddens the door-coverage case as well).
  - `[low]` `[patch]` The new `KERNEL_WRITERS` docblock claimed "Every exported library function that carries the refusal", which the roll does not hold. Reworded to state what it holds and to record the DW-385 store writers and `lifecycle.ts`'s two internals as deliberate omissions.
  - `[low]` `[patch]` Same docblock claimed the staleness case re-derives `WRITER_EXPORTS`; it re-derives only which writers each `WRITER_MODULES` entry reaches. Claim corrected.
  - `[low]` `[patch]` The rewritten `assertWritable` case dropped the `expect(start).toBeGreaterThan(-1)` guard before `source.slice(start, …)`. Guard restored.
  - `[low]` `[patch]` The `defining` derivation recognises only `export async function <name>(`, but its failure message named only "renamed or dropped". Message and comment now name a respelled declaration as the third cause.
  - `[low]` `[patch]` The `WRITER_EXPORTS` comment read as though the scan demanded both treatments. Reworded against the header's "ONE of the two".
  - `[low]` `[patch]` `read-only-kernel-gate.test.ts`'s docstring still said the door-coverage roll "keeps `KERNEL_WRITERS` at four on purpose" in a way that contradicted the widened constant. Rewritten so both files answer "is `renameWiki` a kernel writer?" the same way.
  - `[low]` `[patch]` The `putWikiArtifact` case observed only the unchanged heading, which any swallowed error inside `retitlePurpose` would also produce. It now spies `logger.warn` and asserts the swallowed error set is exactly `[READ_ONLY_REFUSAL.wikiFileWrite]`; verified by replacing the gate with a plain `throw`, which the case now catches.
  - `[low]` `[patch]` Copy-parity substring guards were case- and boundary-naive ("Templates" passed the negative, "recreated" satisfied "created"). Lowercased haystack for the negative, word-boundary regexes for the four verbs.
  - `[low]` `[patch]` Two comment-accuracy fixes in the umbrella case: the "both name the deployment state" comment now sits beside the assertions it describes, and the case names the two sibling cases that pin all four keys against route source.

## Design Notes

**Why `renameWiki` is the path to `putWikiArtifact`.** The putter is module-private on purpose, so "a direct call" is not available. Of its callers, `seedWikiArtifacts` also reaches `putWorkspaceProfile` — whose gate raises the SAME sentence, so deleting only the artifact gate would leave that test green. `retitlePurpose` reaches the artifact putter alone, and it swallows the error, so the observable difference is the file's heading:

```ts
// Entry gate runs synchronously at call time, while still writable.
let pending!: Promise<WikiRecord | null>;
await withWikiLock(OWNER, async () => {
  pending = renameWiki(OWNER, wikiId, "Renamed");   // gates, then blocks on this lock
  process.env.YOPEDIA_READONLY = "1";               // flag flips mid-operation
});
expect(await pending).not.toBeNull();               // the registry write landed
expect(await readWikiArtifact(OWNER, wikiId, "purpose.md")).toContain("# Original");
```

Gate present ⇒ heading unchanged. Gate deleted ⇒ heading becomes `# Renamed` and the case is red. Nothing is mocked; this is the real mid-request flip the codebase already recognises (DW-319).

**Scope of the registry widening.** DW-315 names four writers; `deleteWiki` and `setCurrentWiki` were gated later (DW-314) and sit behind the same two already-treated routes. Including them costs nothing and avoids re-filing the identical gap. `sweepOrphanWikiDirectories` is deliberately excluded — see **Never**.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/read-only-copy-parity.test.ts src/lib/__tests__/read-only-door-coverage.test.ts src/lib/__tests__/read-only-kernel-gate.test.ts` -- expected: all pass.
- `pnpm test` -- expected: both projects pass, no regression elsewhere.
- `pnpm lint` -- expected: clean.
- `git diff --stat` -- expected: exactly the three `src/lib/__tests__/*.test.ts` files.

**Manual checks (if no CLI):**
- Temporarily delete `assertWritable(READ_ONLY_REFUSAL.wikiFileWrite)` from `putWikiArtifact`, then from `putWorkspaceProfile`, re-running `read-only-kernel-gate.test.ts` each time: each deletion must fail the suite. Restore both.

## Auto Run Result

Status: done

**Implemented change.** Three test-only edits closing the read-only coverage gaps DW-302, DW-315 and DW-317. No production file changed; no refusal sentence changed; `putWikiArtifact` stays module-private and token-free.

**Files changed:**
- `../../src/lib/__tests__/read-only-copy-parity.test.ts` -- new case recording `WIKI_READ_ONLY_COPY` as a deliberate four-verb umbrella over `wikiCreate`/`wikiSwitch`/`wikiRename`/`wikiDelete`, distinct from the two narrower constants on the same surface (DW-302).
- `../../src/lib/__tests__/read-only-door-coverage.test.ts` -- `KERNEL_WRITERS` widened from 4 to 12 (the wiki-lifecycle writers, `saveWorkspaceProfile` and the two workspace-profile putters), matching `WRITER_EXPORTS` and `WRITER_MODULES` entries, and the `assertWritable` case re-derived from that one roll instead of a second hand-written list (DW-315).
- `../../src/lib/__tests__/read-only-kernel-gate.test.ts` -- new describe pinning both byte-putter backstops with the entry gate already passed: a mid-rename flag flip through `renameWiki` for `putWikiArtifact` (heading bytes plus the error `retitlePurpose` swallowed), a direct call under a live `withWikiLock` token for `putWorkspaceProfile`, and a writable control for both (DW-317).

**Review findings:** 10 patches applied (1 medium, 9 low), 1 item deferred (low), 12 rejected, 0 intent gaps, 0 spec repairs.

**Follow-up review recommendation:** true. Patched this pass: high 0, medium 1, low 9 -> score 3x1 + 1x9 = 12, at or above the threshold of 5.

**Verification performed:**
- `pnpm exec vitest run --project node` over the three suites -- 48 passed.
- `pnpm test` -- 353 files, 8251 passed, 1 skipped (pre-existing).
- `pnpm lint` -- exit 0 (only the pre-existing `jsx-ast-utils` stderr notices).
- Mutation checks, run twice (before and after the review patches). Deleting `assertWritable` at `src/lib/wikis.ts:361` reddens exactly the `putWikiArtifact` case; deleting it at `src/lib/workspace-profile.ts:276` reddens the `putWorkspaceProfile` case and, after the patches, the door-coverage `assertWritable` case too. Both production files restored and `git status` confirmed clean of them each time.
- Matrix audit: all six I/O rows are covered by cases that ran and passed.

**Residual risks:**
- The `putWikiArtifact` case is indirect by necessity — the putter is module-private and takes no token, so no direct call exists. It is therefore coupled to two properties outside the gate: that `renameWiki` gates before taking the lock (pinned separately by `describe("the read-only gate precedes the wiki lock")`) and that `retitlePurpose` stays fail-soft. Changing either fails the case for a reason unrelated to the gate; the case comment says so.
- The widened registry changes no assertion outcome today — every route reaching the newly named writers already carries both treatments. Its value is prospective, which is what DW-315 asked for.
- The staleness case's span arithmetic attributes a docblock to the exported function preceding it, so prose spelling a writer name followed by `(` inside a comment in `wikis.ts` or `workspace-profile.ts` would produce a spurious red. Nothing matches today; the failure would be loud and named, not silent.
