---
title: 'DW-161 / DW-164 — atomic filesystem writes and research-registry create parity'
type: 'bugfix'
created: '2026-08-19'
status: 'done'
baseline_revision: 'c6479a8a7a1d22073d96957d32c82272e9108992'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [multiple-goals, oversized]
deferred:
  - summary: >-
      A tmp file stranded by process death is hidden from every listing surface
      and nothing ever reclaims it.
    evidence: |-
      `atomicWrite`'s cleanup only covers a REJECTED write inside a live
      process. A SIGKILL between `fs.open(tmp)` and `fs.rename` leaves a
      `.tmp-<uuid>.tmp` on disk, and the new `listFiles` filter now hides it
      from all ~20 listing call sites, from `sweepOrphans` (which only considers
      directories matching `WIKI_ID_RE`) and from backups. Nothing sweeps them,
      so they accumulate silently. Closing it means a reaper — its own story,
      the way DW-162 was for the orphan-directory sweep.
    location: >-
      src/lib/storage/filesystem.ts
    severity: low
  - summary: >-
      Every whole-file write now costs a real fsync, and nothing bounds that on
      the production paths that write in a loop.
    evidence: |-
      Measured under the full parallel suite: contributors 27ms -> 5091ms, lint
      35ms -> 4854ms, query-history 102ms -> 24204ms. The same per-write cost is
      paid by `portable-archive.ts` on import (one write per archive entry),
      `backups.ts` on restore (one per asset), `embeddings.ts` on rebuild (each
      `upsertEmbedding` rewrites AND fsyncs the whole `.indexes/embeddings.json`)
      and by ingest. The cost is the durability guarantee working as specified,
      not a defect — but no benchmark, batching, or bound exists for those paths.
    location: >-
      src/lib/storage/filesystem.ts
    severity: medium
  - summary: >-
      `POST /api/research` has no `isReadOnly()` gate, unlike ~20 sibling write
      routes.
    evidence: |-
      `src/app/api/wikis/route.ts` refuses creates with 403 when the deployment
      is read-only and most write routes do the same. The research create writes
      to storage and does not. Pre-existing; this change touched only the error
      classification in the same handler.
    location: >-
      src/app/api/research/route.ts
    severity: medium
  - summary: >-
      `POST /api/research` answers 500 for a malformed or non-object JSON body.
    evidence: |-
      `await request.json()` sits inside the handler's `try`, and a parser
      message contains neither "required" nor "invalid", so a caller-fault parse
      error is reported as a server fault and the raw parser message is echoed
      to the client. `src/app/api/wikis/route.ts` handles this with an explicit
      400. Pre-existing; unchanged by this work.
    location: >-
      src/app/api/research/route.ts
    severity: low
  - summary: >-
      The `/required|invalid/i` message regex still routes genuine server faults
      to 400.
    evidence: |-
      The regex matches `EINVAL: invalid argument, ...` and any storage or
      library error mentioning "invalid", so a 5xx can be reported as a 400 the
      client will retry forever. The clean fix is small and was deliberately not
      taken here: `cleanInput`'s two plain `Error` throws could become
      `ClientInputError`, after which the regex can be deleted entirely.
    location: >-
      src/app/api/research/route.ts:50
    severity: low
  - summary: >-
      `readProjects` degrades a non-array registry JSON to an empty list, so a
      corrupt registry passes the new cap check and is then overwritten.
    evidence: |-
      `Array.isArray(parsed) ? parsed : []` treats a registry that parsed as an
      object, string or number as "no projects". The create then sees 0, clears
      the `MAX_PROJECTS` guard, and `writeProjects` replaces the file — the same
      shape as the `normalizeRegistry` degradation DW-161 was raised about, one
      module over. Pre-existing and untouched by this change.
    location: >-
      src/lib/research-projects.ts:110
    severity: low
  - summary: >-
      `writeProjects`' `slice(-MAX_PROJECTS)` can still silently evict for a
      legacy over-cap registry reached through update or delete.
    evidence: |-
      The create guard added here makes the slice unreachable on the create
      path, but `updateResearchProject`/`deleteResearchProject` still route
      through it, so a registry that is already over cap (only reachable if
      `MAX_PROJECTS` is ever lowered) loses its oldest entries with no error and
      no log. Left deliberately: removing the backstop changes behaviour no
      ledger entry asks about.
    location: >-
      src/lib/research-projects.ts:117
    severity: low
---

<intent-contract>

## Intent

**Problem:** `src/lib/storage/types.ts:21-23` promises that `writeFile` is atomic from the caller's view and that "the filesystem provider uses write-to-tmp + rename", but `FilesystemStorageProvider.writeFile` is a bare `fs.writeFile` that truncates the destination in place (DW-161). A torn write (ENOSPC, process death) therefore leaves a truncated file — including `wikis.json`, which `normalizeRegistry` then degrades to an empty registry, the exact failure DW-20's compensation reasons about but cannot detect. Separately, `createResearchProject` (`src/lib/research-projects.ts:135-154`) never got the create discipline its sibling registry received (DW-164): it pushes and writes with no cap check, so at `MAX_PROJECTS` the `slice(-MAX_PROJECTS)` in `writeProjects` silently deletes the tenant's oldest research project and reports success.

**Approach:** Give the filesystem provider one private atomic-write helper — same-directory tmp file, write, `fsync`, `rename` — and route every whole-file write through it, keeping stray tmp files out of directory listings. Then bring `createResearchProject` to `createWiki`'s standard: refuse at the cap before anything is written, so the create can no longer destroy pre-existing registry entries, and pin that a failed registry write leaves the stored registry exactly as it was.

## Boundaries & Constraints

**Always:**
- The tmp file lives in the destination's own directory (same filesystem, so `rename` is atomic) and carries a name no real file can have: `.tmp-<uuid>.tmp`.
- The tmp file is fsynced and closed before the rename, and removed again on any failure, so a rejected write leaves neither a tmp artifact nor a changed destination.
- `listFiles` never reports a tmp artifact. It keeps reporting every other dot-prefixed entry — `.discarded` is a real marker `sweepOrphans` depends on.
- Overwriting an existing file preserves that file's mode; a new file gets the same default mode `fs.writeFile` would have given it.
- `createResearchProject` refuses with a `ClientInputError` when the tenant is already at `MAX_PROJECTS`, before any read result is mutated and before any write — the `createWiki`/`MAX_WIKIS` shape at `src/lib/wikis.ts:816-821`.
- `POST /api/research` classifies a `ClientInputError` as 400, matching `src/app/api/wikis/route.ts:57`; every other failure stays 500.

**Block If:**
- Honouring the contract would require changing the `StorageProvider` interface. It must not: this is a provider-internal change and `src/lib/storage/r2.ts` (single-object PUT) is already atomic.

**Never:**
- No journal, write-ahead log, or two-phase commit — DW-20 ruled that route out and this does not reopen it.
- `appendFile` stays a plain append; append-only `log.md` cannot be tmp-and-renamed without reading the whole file back.
- Do not touch `src/lib/storage/r2.ts`, and do not change `writeProjects`'s `slice(-MAX_PROJECTS)` — with the create guard in place it is unreachable on the create path, and removing it would change `updateResearchProject`/`deleteResearchProject` behaviour for legacy over-cap data, which no ledger entry asks for.
- Do not add a compensating undo to `createResearchProject`. Its create writes exactly one file and seeds no sibling artifacts, so once `writeFile` is atomic there is nothing to undo — see Design Notes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Overwrite an existing file | `writeFile("a.md", "new")` over "old" | New bytes readable; the destination's inode is a NEW one, so a reader holding the old file still sees "old" | No error expected |
| Successful write leaves no residue | any `writeFile` | The directory contains only the destination — no `.tmp-*.tmp` | No error expected |
| Write cannot complete | destination path is an existing non-empty directory | Rejects; the directory and its contents are untouched; no `.tmp-*.tmp` is left in the parent | Original fs error propagates |
| Mode is preserved | file chmod'ed `0o600`, then overwritten | Mode is still `0o600` after the write | No error expected |
| Concurrent writes to one path | 10 concurrent `writeFile` calls, distinct contents | All resolve; final content is exactly one of the ten, never a blend or a short file | No error expected |
| Leftover tmp from a crash | a `.tmp-<uuid>.tmp` file sitting beside `page.md` and `.discarded` | `listFiles` returns `page.md` and `.discarded` only | No error expected |
| Other whole-file writes | `writeAsset`, `writeFileIfMatch`, `putIndex`, `upsertEmbedding` | Each replaces its destination by rename (new inode), same as `writeFile` | No error expected |
| Create at the cap | tenant already holds `MAX_PROJECTS` projects | Rejects with a `ClientInputError`; the stored registry is byte-identical; no project is evicted | 400 from `POST /api/research` |
| Create when the registry write fails | `writeFile` rejects for `research-projects.json` | Rejects with that error; `listResearchProjects` is unchanged; the stored bytes are byte-identical | Original storage error propagates |
| Create below the cap | tenant holds fewer projects | Unchanged: the project is appended and returned | No error expected |

</intent-contract>

## Code Map

- `src/lib/storage/filesystem.ts:78-82` `writeFile` — DW-161's named target, the bare `fs.writeFile`. `:66-68` `ensureParent` already creates the parent; the tmp file must be created after it.
- `src/lib/storage/filesystem.ts:136-140` `writeAsset`, `:166-189` `writeFileIfMatch`, `:211-215` `putIndex`, `:257-261` `saveEmbeddings` — the other four whole-file writes; same torn-write property, same helper. `:114-118` `appendFile` is the one that must stay as it is.
- `src/lib/storage/filesystem.ts:88-103` `listFiles` — where the tmp filter goes; `:217-235` `listIndexKeys` already requires a `.json` suffix, which the `.tmp` suffix cannot satisfy.
- `src/lib/storage/types.ts:21-23` — the contract this makes true; `:116-121` the `writeFile` docblock.
- `src/lib/wikis.ts:386-389` and `:913-924` — two comments that state in prose that the provider does NOT honour the contract (the second says so at length). Both become false with this change and must be corrected; nothing else in `wikis.ts` moves.
- `src/lib/research-projects.ts:53` `MAX_PROJECTS`, `:117-122` `writeProjects` (the silent `slice(-MAX_PROJECTS)`), `:135-154` `createResearchProject` — DW-164's target. `:1` imports `isEnoent` from `./errors`; `ClientInputError` joins it.
- `src/lib/wikis.ts:812-846` `createWiki` — the precedent to mirror: cap check throws `ClientInputError` before any write, deliberately outside the compensation.
- `src/app/api/research/route.ts:44-46` — POST's catch, currently classifying by message regex only; `src/app/api/wikis/route.ts:57` is the `ClientInputError ? 400 : 500` idiom to adopt.
- `src/lib/errors.ts:20-26` `ClientInputError` — "a route should surface as a 4xx".
- `src/lib/__tests__/storage-fs.test.ts:7-22` — temp-dir provider recipe (`mkdtemp` + `FilesystemStorageProvider`) and the raw-`fs` assertions style to extend.
- `src/lib/__tests__/research-projects.test.ts:16-30` — `DATA_DIR` + `_resetStorage()`/`_resetLocks()` recipe. Fault injection follows `src/lib/__tests__/wikis.test.ts:1300-1313` (`vi.spyOn(getStorage(), "writeFile")`, path-suffix conditional).
- Read-only evidence: `src/lib/__tests__/storage.test.ts` (provider selection), `src/lib/__tests__/concurrency.test.ts` (`writeFileIfMatch` CAS), `src/lib/__tests__/wikis.test.ts` (48+ storage-fault rows) — all must keep passing unchanged.

## Tasks & Acceptance

**Execution:**
- `src/lib/storage/filesystem.ts` — add a private `atomicWrite(abs, data)` (same-directory `.tmp-<uuid>.tmp`, mode carried over from an existing destination, write → `fsync` → close → `rename`, unlink the tmp on any failure) and route `writeFile`, `writeAsset`, `writeFileIfMatch`, `putIndex` and `saveEmbeddings` through it; filter tmp artifacts out of `listFiles` — one helper so the five writes cannot drift apart.
- `src/lib/storage/types.ts` — extend the `writeFile` contract note to say what the guarantee is and is not (no torn file; the rename itself is not fsynced, so power loss can still lose the newest bytes) — the doc is what DW-161 measured the code against, so it must not become the next contradiction.
- `src/lib/wikis.ts` — correct the two comments that assert the provider leaves a torn-write gap — they are now false, and DW-20's compensation rests on the claim they qualify.
- `src/lib/research-projects.ts` — add the `MAX_PROJECTS` refusal to `createResearchProject` before the push, throwing `ClientInputError`, and document why this registry needs no post-write undo — the create can no longer destroy a stored project, which is the only wreckage it could ever cause.
- `src/app/api/research/route.ts` — classify `ClientInputError` as 400 in POST's catch — otherwise a cap refusal is reported as a server fault.
- `src/lib/__tests__/storage-fs.test.ts` — add a describe block covering every provider row of the I/O matrix: inode identity across an overwrite, no residue after success, cleanup after a failed write, mode preservation, concurrent writes, the `listFiles` tmp filter (with `.discarded` as the control), and rename-replacement for the four sibling writes.
- `src/lib/__tests__/research-projects.test.ts` — add the cap-refusal row (registry byte-identical, nothing evicted) and the failed-registry-write row (original error, `listResearchProjects` unchanged).
- `src/lib/__tests__/research-route.test.ts` — new file pinning `POST /api/research`'s failure classification: 400 for the cap refusal, 500 for a storage failure, 400 still for the pre-existing validation throws — the matrix's cap row states an HTTP status, and no test covered that route.
- `src/lib/__tests__/query-history.test.ts` — raise the per-test budget on the 208-sequential-append row, with a comment naming the fsync as the cause — the assertions are untouched; only the clock moved.

**Acceptance Criteria:**
- Given any successful whole-file write through the filesystem provider, when it returns, then the destination was replaced by a rename rather than truncated in place — observable as a changed inode and as an unchanged view through a file handle opened before the write.
- Given a write that cannot complete, when the caller awaits it, then it rejects with the underlying fs error, the destination is exactly what it was, and no `.tmp-*.tmp` file remains in that directory.
- Given a directory holding a leftover tmp artifact, when any caller lists it through `listFiles`, then the artifact is absent from the result while every other entry, dot-prefixed ones included, is present.
- Given a tenant already at `MAX_PROJECTS`, when a create is attempted, then it rejects with a `ClientInputError`, `POST /api/research` answers 400, and `listResearchProjects` returns the same projects it did before the attempt.
- Given the whole existing suite, when it runs, then every prior assertion still passes — this change alters no observable behaviour except the four above.

## Spec Change Log

## Review Triage Log

### 2026-08-20 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 14: (high 0, medium 4, low 10)
- defer: 7: (high 0, medium 2, low 5)
- reject: 9: (high 0, medium 0, low 9)
- addressed_findings:
  - `[medium]` `[patch]` `atomicWrite`'s cleanup could REPLACE the failure it was cleaning up after: `fs.rm(tmp, {force:true})` suppresses only ENOENT, so an EPERM/EACCES unlink turned an ENOSPC into an unrelated error — at every caller that branches on error identity (`wikis.ts`'s DW-20 compensation, the research-registry rows asserting the very object). Cleanup now cannot change what propagates, and `storage-fs-fault-identity.test.ts` mocks `node:fs/promises` to pin it; mutation-verified (rethrowing the cleanup error fails the row).
  - `[medium]` `[patch]` `handle.sync()` was unpinned — deleting it left all 46 storage rows green, so the intent's "fsync-then-rename ... and pin it" was half-delivered. The fsync has no in-process observable, so it is pinned structurally against the comment-stripped source, asserting the sync PRECEDES the rename. Mutation-verified both ways (deleted, and moved after the rename).
  - `[medium]` `[patch]` Two more write-loop rows sat at the edge of the 5s default with no budget: `contributors.test.ts` (27ms -> 5091ms under the full suite) and `lint.test.ts` (35ms -> 4854ms). Both now carry explicit budgets naming the fsync as the cause; the query-history budget was raised again after it measured 24.2s against its 30s. No assertion weakened.
  - `[medium]` `[patch]` The atomicity contract was written for `writeFile` only, while `writeAsset`, `writeFileIfMatch`, `putIndex` and `upsertEmbedding` now provide it and the tests pin it — a second provider could satisfy the docs and fail the suite. Added per-method notes, recorded `appendFile`'s deliberate exclusion and its consequence for `log.md` readers, and documented that a provider must not surface its own scratch artifacts (until now an undocumented secret of the filesystem provider).
  - `[low]` `[patch]` A `finally { await handle.close() }` let a close rejection replace an in-flight write/sync error. The first error now wins, while a close failure on the clean path still surfaces AND still throws before the rename, so an unclosable handle is never published. Pinned by two mutation-verified rows.
  - `[low]` `[patch]` The `TMP_ARTIFACT` docblock asserted as FACT that no real stored file can have the `.tmp-<uuid>.tmp` shape. `portable-archive.ts` writes a caller-supplied `entry.path` verbatim through `writeAsset`, so a crafted archive entry with that name would be written and then be permanently unlistable. Restated as an unenforced convention naming that hole — the same doc-asserts-what-code-does-not defect DW-161 itself was.
  - `[low]` `[patch]` `atomicWrite`'s docblock said nothing about what replacing-by-rename changes: new inode (hard links detach, a destination symlink is replaced rather than written through), only `mode & 0o777` carried over, and the need for directory write permission plus transient space for both copies. All three recorded.
  - `[low]` `[patch]` `MAX_PROJECTS` was module-private and the test declared its own copy, so two spellings of one cap had to agree by hand — the opposite of the `MAX_WIKIS`/`wikis.test.ts` precedent being mirrored. Exported and imported.
  - `[low]` `[patch]` The cap row's "not even a reserialization landed" was unpinned: `seedProjects` writes exactly the bytes `writeProjects` produces, so a read-reserialize-rewrite implementation passed it. Added a `writeFile` spy asserting zero writes; mutation-verified.
  - `[low]` `[patch]` `writeProjects`' docblock said the slice keeps "the newest" entries; it keeps the last INSERTED, while `listResearchProjects` orders by `updatedAt` — different sets after any update. Corrected, with a "not an LRU" warning.
  - `[low]` `[patch]` The query-history budget comment claimed the row runs "an order of magnitude longer than the default 5s budget allows"; solo it is ~3.9s, i.e. under it. Replaced the wrong magnitude with the real risk (no headroom, flaky under load and on slower CI).
  - `[low]` `[patch]` A storage test explained its fault as "a non-empty directory is a destination `rename` can never replace" — non-emptiness is irrelevant; renaming a file onto ANY directory fails. Explanation corrected; the row was right.
  - `[low]` `[patch]` The corrected `wikis.ts` comment was left with a ragged rewrap mid-paragraph. Reflowed; prose unchanged.
  - `[low]` `[patch]` This spec's Design Notes snippet omitted the `ensureParent` call the real helper opens with, so the documented version would fail on a missing parent directory. Added.

## Design Notes

The two ledger entries meet at one question — what does a create owe the state that was already on disk — and they answer it in different layers.

DW-161 is the layer below. One helper, five callers:

```ts
private async atomicWrite(abs: string, data: string | Buffer): Promise<void> {
  await this.ensureParent(abs);
  const tmp = path.join(path.dirname(abs), `.tmp-${crypto.randomUUID()}.tmp`);
  try {
    const handle = await fs.open(tmp, "wx");
    try {
      const mode = await fs.stat(abs).then((st) => st.mode & 0o777, () => null);
      if (mode !== null) await handle.chmod(mode);
      await handle.writeFile(data);
      await handle.sync();   // the bytes are on disk BEFORE anything points at them
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, abs);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}
```

What this buys and what it does not: a reader can now never see a half-written file, because the name only ever points at a complete one. It is not crash-durability for the rename itself — that would need an fsync of the parent directory, which is not portable — so a power loss can still lose the newest bytes. Losing the newest bytes is a state DW-20's compensation already reasons about correctly; a truncated file was not.

DW-164 is the layer above, and the honest finding is that this registry's create needs no undo. `createWiki` needed one because it seeds three files into a directory before the registry write, so a fault strands them; `createResearchProject` writes exactly one file and the pushed array is function-local, so a rejected write leaves nothing behind — a fact worth a test rather than a try/catch. What `createResearchProject` did lack is the other half of its sibling's discipline: `createWiki` refuses at `MAX_WIKIS` before writing anything, while this one pushes past `MAX_PROJECTS` and lets `writeProjects`' `slice(-MAX_PROJECTS)` drop the tenant's oldest project on the floor. That is the create damaging pre-existing state, and no compensation can undo it after the fact — refusing first is the fix, and it is what makes the two registries stop diverging.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/storage-fs.test.ts src/lib/__tests__/research-projects.test.ts src/lib/__tests__/research-route.test.ts src/lib/__tests__/wikis.test.ts src/lib/__tests__/concurrency.test.ts src/lib/__tests__/query-history.test.ts` -- expected: all pass, including the new rows.
- `npx vitest run` -- expected: no regressions anywhere in the suite.
- `npx eslint` -- expected: exit 0.
- `npx tsc --noEmit` -- expected: exit 0.

`npx` rather than `pnpm` because `pnpm <script>` fails in this checkout with `ERR packages field missing or empty` — a pre-existing pnpm workspace-config fault, unrelated to this change. Same runner, same config.

## Auto Run Result

Status: done

**Implemented change.** `FilesystemStorageProvider` now honours the atomicity its own interface documents: one private `atomicWrite` helper writes a same-directory `.tmp-<uuid>.tmp`, carries the destination's mode over, fsyncs and closes it, then renames it into place, removing the tmp file on any failure without ever changing which error propagates (DW-161). All five whole-file writes route through it; `appendFile` is deliberately excluded. `listFiles` hides the provider's scratch artifacts while still returning `.discarded` and every other dot-entry. Separately, `createResearchProject` gained the create discipline its sibling registry has — a `MAX_PROJECTS` refusal before anything is read-mutated or written, so a create can no longer silently evict the tenant's oldest project via `writeProjects`' `slice`, with `POST /api/research` classifying that refusal as 400 by type (DW-164).

**Files changed.**
- `src/lib/storage/filesystem.ts` -- added `atomicWrite`; routed `writeFile`, `writeAsset`, `writeFileIfMatch`, `putIndex`, `saveEmbeddings` through it; added the `TMP_ARTIFACT` filter to `listFiles`.
- `src/lib/storage/types.ts` -- spelled out what the atomicity guarantee does and does not cover, per method, plus `appendFile`'s exclusion and the scratch-artifact rule for `listFiles`.
- `src/lib/wikis.ts` -- corrected the two comments that asserted the provider did not honour the contract; they were the change's own precondition and are now false.
- `src/lib/research-projects.ts` -- cap refusal in `createResearchProject`, exported `MAX_PROJECTS`, documented why this registry needs no post-write undo.
- `src/app/api/research/route.ts` -- `ClientInputError` -> 400 by type; the legacy message regex retained for the older validation throws.
- `src/lib/__tests__/storage-fs.test.ts` -- 14 rows covering the provider matrix, including the structural fsync-before-rename pin.
- `src/lib/__tests__/storage-fs-fault-identity.test.ts` -- new; mocks `node:fs/promises` to pin error identity when the cleanup unlink or the close itself fails.
- `src/lib/__tests__/research-projects.test.ts` -- cap refusal (no write at all), still-appends-below-cap, failed-registry-write leaves the stored bytes untouched.
- `src/lib/__tests__/research-route.test.ts` -- new; the 400/500 classification for `POST /api/research`.
- `src/lib/__tests__/query-history.test.ts`, `src/lib/__tests__/contributors.test.ts`, `src/lib/__tests__/lint.test.ts` -- explicit per-row budgets for three write-loop rows, with the fsync named as the cause. No assertion changed.

**Review findings.** 14 patches applied (medium 4, low 10); 7 items deferred (medium 2, low 5); 9 rejected. No intent gaps, no spec repairs.

**Follow-up review recommendation:** true. Patched this pass: high 0, medium 4, low 10 -> score 3x4 + 10 = 22, which is >= 5.

**Verification.**
- `npx vitest run` -- 251 files / 5306 tests pass (baseline before this work: 249 / 5298).
- `npx eslint` -- exit 0. `npx tsc --noEmit` -- exit 0.
- Mutation-checked the four claims most at risk of a green-but-inert test: deleting `handle.sync()` and moving it after the rename each fail the structural pin and nothing else; rethrowing the cleanup error fails the tmp-unlink identity row; restoring a plain `finally { close() }` fails the close-identity row; swallowing close errors fails the clean-path row; a reserializing write before the cap check fails the byte-identity row.
- `pnpm test`/`pnpm vitest` cannot run in this checkout (`ERR packages field missing or empty`, a pre-existing pnpm workspace-config fault); `npx` runs the same vitest with the same config.

**Residual risks.**
- Every whole-file write now pays a real fsync — measured at ~20ms per write under a loaded suite. That is the requested guarantee working, not a regression, but no production path that writes in a loop (archive import, backup restore, embeddings rebuild, ingest) has been profiled for user-visible latency. Deferred.
- A create at `MAX_PROJECTS` now returns 400 where it previously returned 201 while silently deleting the tenant's oldest project. This is a user-visible behaviour change, chosen because the alternative is undetectable data loss, and it is the discipline `createWiki` already applies.
- Crash-stranded tmp files are hidden from every listing and nothing reclaims them. Deferred; closing it needs a reaper, which is its own story.
- The `.tmp-<uuid>.tmp` reservation is a convention, not an enforced rule: `portable-archive.ts` writes caller-supplied names verbatim, so a crafted archive entry with that shape would be stored and then be invisible. Documented at the definition rather than fixed, since rejecting names on write is a new refusal no ledger entry asks for.
