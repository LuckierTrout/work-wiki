---
title: 'Research store: an owner-only registry repair route, and a reported source-URL drop'
type: 'feature'
created: '2026-08-31'
status: 'done'
review_loop_iteration: 0
baseline_revision: 'f5c6e1fc007c1ff16db711dc0bcfc9888407ca44'
followup_review_recommended: true
context: []
warnings: [multiple-goals, oversized]
deferred:
  - summary: >-
      A wedged tenant is told to issue `POST /api/research/repair` by hand; no
      control anywhere in the product performs it.
    evidence: |-
      `REPAIR_HINT` now ends every `parseRegistry` refusal, and the Studio's
      research fetch surfaces the server's `error` sentence verbatim in its
      banner (`KnowledgeStudio.tsx`), so a non-technical owner meets
      "Research projects file is unreadable. Repair it with POST
      /api/research/repair, then retry." with nothing to press. Grepping `src`
      for `research/repair` finds only the route file and its test — no client
      fetch, no button, and the Workbench's `ResearchCanvas` shows the same
      sentence with the same absence. The recorded DW-477 decision names a
      route and a 500 body that names it, and both shipped; the ledger entry's
      own title says "no IN-PRODUCT repair path", and that half is still open.
      A Repair control on the research desk's error banner would close it.
    location: >-
      src/components/KnowledgeStudio.tsx (research error banner), src/lib/research-projects.ts (REPAIR_HINT)
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Two silences in the research store. (DW-477) An unreadable `tenants/<t>/research-projects.json` makes `parseRegistry` refuse at both read sites, so every research door 500s for that owner — the deletes that could shrink the file included — and the 500 body names no way out; `research-projects.ts:299/:317` concede the omission in prose. (DW-655) `cleanList` slices each URL to `maxChars` *before* it dedupes, so under `cleanUrls`' 40/2000 caps a run's tail URLs are dropped, over-long URLs are stored truncated (pointing somewhere else), and two distinct URLs sharing a 2000-character prefix collapse into one — all with nothing said; the Studio's `Collect N URLs` reports the survivors as if they were everything.

**Approach:** Add `repairResearchRegistry` plus an owner-only `POST /api/research/repair` that quarantines the unreadable bytes to a timestamped key and starts a fresh empty registry, and have every `parseRegistry` refusal name that route. Separately, have `cleanUrls` count what it discarded and shortened, record those two counts on the row, and surface them as a sentence beside the Studio's Collect control. The 40/2000 caps and the slice-before-dedupe order are NOT changed.

## Boundaries & Constraints

**Always:**
- The repair re-parses through the same `parseRegistry` every read uses and quarantines ONLY when that parse throws. A readable registry — healthy, `[]`, or fully tombstoned — leaves byte-identical with nothing written.
- The quarantine copy is written BEFORE the live file is replaced, and its failure propagates. Nothing prunes or reaps a `.corrupt-*` sibling.
- The live-file replacement is a `writeFileIfMatch` against the etag read in the same call, so a concurrent writer that fixed the file is never blind-written over.
- Repair is read-only gated in the kernel (`assertWritable`) and at the door, both on `READ_ONLY_REFUSAL.researchMutate`.
- The tenant path comes from `principal.handle` alone; no request field names a registry.
- `parseRegistry`'s three sentences keep their existing leading diagnosis verbatim and gain the hint as a SUFFIX.
- The URL counts are derived by the store, never accepted from a caller's patch.

**Block If:**
- `POST /api/research/repair` cannot be routed ahead of the sibling `[id]` segment.

**Never:**
- Do not change `cleanUrls`/`cleanList`'s 40-item cap, 2000-character slice, or its slice-before-dedupe order. DW-655 asks for a REPORT, not a behaviour change; the DW-603 characterization rows in `research-projects.test.ts` must keep passing unedited.
- Do not make the repair selective (dropping only bad rows). The recorded decision says empty restart.
- Do not add a download/restore-from-quarantine door.
- Do not carve a read-only exception for the repair.
- Do not touch `research-concurrency.ts`'s `parseSlots` or `review-queue.ts`'s quarantine.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Repair a wedged registry | Stored bytes are `{"projects":[]}`; writable | 200 `{repaired:true,quarantinedPath:"tenants/<t>/research-projects.json.corrupt-<ms>"}`; quarantine holds the original bytes verbatim; live file is `[]`; reads answer again | No error expected |
| Repair truncated bytes | Stored bytes are not JSON | Same as above — `JSON.parse`'s `SyntaxError` is a repair case | No error expected |
| Repair a healthy registry | Registry parses | 409 `"The research projects file reads fine; there is nothing to repair."`; no `writeFile`/`writeFileIfMatch` call | Refusal, not a fault |
| Repair with no registry | ENOENT | Same 409; no file created | ENOENT is "nothing to repair" |
| Repair loses the CAS | Live file changed between read and write | 503, message `"Research projects were busy; retry the request."`; quarantine copy may exist and is harmless | `ResearchProjectBusyError` |
| Repair, storage read fault | `readFileWithEtag` throws EACCES | 500, store's own message; nothing written | Rethrown untouched |
| Repair unauthenticated / read-only | No principal / `YOPEDIA_READONLY` set | 401 `"Sign in required."` / 403 `READ_ONLY_REFUSAL.researchMutate`; store never called | Gate order: 401, then 403 |
| Refusal names the route | Registry is a JSON object | Every research door's 500 body ends `" Repair it with POST /api/research/repair, then retry."` after its existing sentence | Still `StoreFaultError` |
| Run patch drops the tail | 45 distinct http URLs | 40 stored (unchanged); row records `sourceUrlLoss:{dropped:5,truncated:0}` | No error |
| Run patch truncates + collapses | Two 4000-char URLs sharing their first 2000 chars | 1 stored (unchanged); `sourceUrlLoss:{dropped:1,truncated:1}` | No error |
| Run patch loses nothing | 3 distinct short URLs, one repeated | 3 stored; `sourceUrlLoss` absent from the row | No error |
| Studio shows the loss | Row has `sourceUrls` ×40 and `sourceUrlLoss:{dropped:5,truncated:0}` | A note beside Collect: `5 of the 45 URLs this run collected were not stored.` | No error |

</intent-contract>

## Code Map

- `src/lib/research-projects.ts` — the whole store. `cleanList` :233 (slice-then-dedupe, do not touch), `cleanUrls` :246 (40/2000, http/https filter), `ResearchProject` :123, `isResearchProject` :314 (structural; optional fields deliberately unchecked — a new optional field needs no row here), `parseRegistry` :393 with its docblock at :334 (two prose concessions about "no repair route" at :360 and :388 to correct), `projectPath` :223, `lockKey` :229, `serializeProjects` :438, `applyResearchProjectMutation` :510 (CAS idiom to mirror), `ResearchProjectBusyError` :98 and its busy sentence :521, `mutateProjectOrRefusal` :827 — the ONE `cleanUrls` call site at :856.
- `src/app/api/research/repair/route.ts` — NEW. Static segment beside `[id]`, so Next routes it first.
- `src/app/api/research/route.ts` — the door idiom: 401, then `isReadOnly()` 403 before any work, then `try` with type-only classification.
- `src/app/api/research/[id]/run/route.ts:121-134` — the `ResearchProjectBusyError` → 503 precedent to mirror.
- `src/lib/read-only.ts:321` — `READ_ONLY_REFUSAL.researchMutate`, reused (repairing is "change my research").
- `src/lib/storage/types.ts:151` — `StorageProvider`; `FileWithEtag` :89 is re-exported from `src/lib/storage/index.ts:177`. `writeFile` is atomic-from-the-caller's-view; `writeFileIfMatch` is the CAS.
- `src/lib/review-queue.ts:397` — `quarantine()`, the `${path}.corrupt-${Date.now()}` key shape to match.
- `src/lib/research-panel.ts` — pure, client-safe research copy (`researchTaskLine` :133 is the shape to follow). Home for the new note.
- `src/components/KnowledgeStudio.tsx:941` — the `Collect ${project.sourceUrls.length} URLs` button; :944 `project.progress` note is the rendering slot to sit beside.
- `src/lib/research-runtime.ts:1949-1957` — the one writer of `sourceUrls` (`updateResearchAttempt({results, sourceUrls})`), patched once per query.
- `src/lib/__tests__/research-projects.test.ts` — `seedRawRegistry` :29, `seedRow` :36, real-FS `DATA_DIR` harness :73. DW-603 rows :174-248 pin current `cleanUrls` behaviour — leave them. Refusal rows :390/:500 use `toThrow(substring)`, so the suffix is safe; its "with no repair route" comment at :505 needs correcting.
- `src/lib/__tests__/read-only-copy-parity.test.ts:390` — the route/refusal-key table a new door must join.
- `src/lib/__tests__/store-fault-routes.test.ts:165` — constructs its own `StoreFaultError` literal, so it is unaffected by the suffix.
- `src/lib/__tests__/research-panel.test.ts`, `src/components/__tests__/studio-research-read-only.test.tsx` (project fixture :48) — homes for the copy and render rows.
- Test-project rule (`AGENTS.md`): `*.test.ts` ⇒ node, `*.test.tsx` ⇒ jsdom. Mounted rows must be `.tsx`.

## Tasks & Acceptance

**Execution:**
- `src/lib/research-projects.ts` -- add `REPAIR_HINT` and suffix all three `parseRegistry` throws; correct the docblock's two "no repair route" concessions; add `ResearchRegistryRepair` union and `export async function repairResearchRegistry(owner)` per Design Notes -- DW-477's recovery half, and the refusal that names it.
- `src/lib/research-projects.ts` -- change `cleanUrls` to return `{urls, dropped, truncated}`; add optional `sourceUrlLoss?: {dropped:number;truncated:number}` to `ResearchProject`; at the single call site set it, deleting the key when both counts are 0 -- DW-655's report, with the caps and the slice order untouched.
- `src/app/api/research/repair/route.ts` -- NEW `POST`: 401 → read-only 403 (`READ_ONLY_REFUSAL.researchMutate`) → 200/409/503/500 per the matrix -- the owner-facing door the 500 body names.
- `src/lib/research-panel.ts` -- add `researchSourceUrlNote(project): string | null` composing the two clauses in Design Notes -- one testable sentence, no React.
- `src/components/KnowledgeStudio.tsx` -- render the note in a `studio-note` beside the Collect button when non-null -- the surface DW-655 names.
- `src/lib/__tests__/research-repair-route.test.ts` -- NEW: door-mapping rows for every matrix line (auth mocked, `repairResearchRegistry` stubbed over the real module) -- pins status codes and bodies.
- `src/lib/__tests__/research-projects.test.ts` -- add store rows against real bytes for the repair matrix lines and the three `sourceUrlLoss` lines; correct the stale "no repair route" comments -- pins behaviour, not the door.
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- add `["research/repair/route.ts", "researchMutate"]` -- keeps the new door in the copy table.
- `src/lib/__tests__/research-panel.test.ts` -- rows for `researchSourceUrlNote`'s four shapes (neither / dropped / truncated / both) -- pins the sentences.
- `src/components/__tests__/studio-research-read-only.test.tsx` -- a row asserting the note renders beside Collect for a lossy row and is absent otherwise -- pins the surface.

**Acceptance Criteria:**
- Given a tenant whose registry is unreadable, when the owner POSTs `/api/research/repair` and then GETs `/api/research`, then the GET answers 200 with an empty project list and the quarantine key returned by the repair still holds the original bytes verbatim.
- Given a tenant whose registry parses, when `repairResearchRegistry` runs, then no `writeFile`, `writeFileIfMatch` or `writeFileIfAbsent` is called and the stored bytes are byte-identical.
- Given the DW-603 characterization rows in `research-projects.test.ts` unedited, when the suite runs, then they all pass — the stored URL lists are unchanged by this work.
- Given a run patch whose collected URLs exceed the caps, when the panel re-reads the project, then the stored row carries `sourceUrlLoss` and the Studio renders a sentence naming how many were not stored.

## Design Notes

`repairResearchRegistry(owner)` — `assertWritable(READ_ONLY_REFUSAL.researchMutate)` first, then inside `withFileLock(lockKey(owner), …)`:

```ts
let read: FileWithEtag;
try { read = await storage.readFileWithEtag(path); }
catch (error) { if (isEnoent(error)) return { quarantined: false }; throw error; }
try { parseRegistry(read.content); return { quarantined: false }; } catch { /* unreadable */ }
const quarantinePath = `${path}.corrupt-${Date.now()}`;
await storage.writeFile(quarantinePath, read.content);          // copy FIRST
if (!await storage.writeFileIfMatch(path, serializeProjects([]), read.etag)) {
  throw new ResearchProjectBusyError("Research projects were busy; retry the request.");
}
return { quarantined: true, path: quarantinePath };
```

A discriminated union rather than a message, because the door has to tell a refusal from a fault (DW-296 deleted message matching from these doors). The busy throw is the EXISTING typed class and sentence, and the new door answers it 503 — the `[id]/run` precedent. No existing door's status changes.

`cleanUrls` counts against a "wanted" set computed from the SAME inputs with no slice and no cap: trim + collapse whitespace, dedupe on the full value, keep http/https. `dropped = wanted.length - urls.length` (so a legitimate duplicate is not loss, but a cap tail-drop, a slot consumed by an unusable entry, and a slice-collapse all are); `truncated` = stored entries whose pre-slice source was longer than 2000 characters.

`researchSourceUrlNote` joins the present clauses with a space, `total = project.sourceUrls.length + dropped`:
- dropped: `` `${dropped} of the ${total} URLs this run collected ${dropped === 1 ? "was" : "were"} not stored.` ``
- truncated: `` `${truncated} stored URL${truncated === 1 ? " was" : "s were"} shortened to 2,000 characters and may no longer resolve.` ``

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/research-projects.test.ts src/lib/__tests__/research-repair-route.test.ts src/lib/__tests__/research-panel.test.ts src/lib/__tests__/read-only-copy-parity.test.ts src/lib/__tests__/store-fault-routes.test.ts src/lib/__tests__/errors.test.ts` -- expected: all pass, DW-603 rows included.
- `pnpm exec vitest run --project dom src/components/__tests__/studio-research-read-only.test.tsx` -- expected: pass.
- `pnpm exec tsc --noEmit` -- expected: no errors.
- `pnpm lint` -- expected: no new errors.
- `pnpm test` -- expected: full suite green.

## Auto Run Result

Status: done
Blocking condition: none

### Implemented change

DW-477 — the research registry gained a recovery route. `repairResearchRegistry` re-parses the stored bytes through the same `parseRegistry` every read uses and, only when that throws, copies them to a `.corrupt-<ms>` key and compare-and-swaps a fresh `[]` into place; a registry that reads — healthy, empty, or fully tombstoned — and a missing one alike leave byte-identical with no write of any kind. `POST /api/research/repair` maps that discriminated union to 200/409, answers 503 for a lost CAS and 500 for a storage fault, and gates 401 then read-only 403 ahead of the store. Every `parseRegistry` refusal now ends by naming that route.

DW-655 — the source-URL drop is reported rather than silent. The 40-item cap, the 2,000-character slice and the slice-before-dedupe order are unchanged (the DW-603 characterization rows pass unedited); `cleanUrls` now also measures what the bounding cost against an unbounded read of the same inputs, the store records `sourceUrlLoss` on the row, and the Studio states it beside the Collect control and in the evidence drawer.

### Files changed

- `src/lib/research-projects.ts` — `REPAIR_HINT` on all three refusals; `ResearchRegistryRepair`, `repairResearchRegistry`, `claimQuarantineKey`; `cleanUrls` returns `{urls, dropped, truncated}`; `ResearchSourceUrlLoss` and `ResearchProject.sourceUrlLoss`; exported `URL_MAX_CHARS`; corrected the two "no repair route" docblock concessions.
- `src/app/api/research/repair/route.ts` — new owner-only `POST` door.
- `src/lib/research-runtime.ts` — the requeue mutator clears `sourceUrlLoss` with the other per-run facts.
- `src/lib/research-panel.ts` — `researchSourceUrlNote` and `researchSourceUrlTotal`.
- `src/components/KnowledgeStudio.tsx` — renders the note, associates it with Collect, and corrects the evidence-drawer signal.
- `src/lib/__tests__/research-repair-route.test.ts` — new door-mapping suite.
- `src/lib/__tests__/research-projects.test.ts`, `research-panel.test.ts`, `research-runtime.test.ts`, `read-only-copy-parity.test.ts`, `src/components/__tests__/studio-research-read-only.test.tsx` — store, copy, lifecycle, route-table and render coverage.

### Review findings breakdown

Patches applied 8 (medium 4, low 4). Deferred 1 (medium 1). Rejected 7 (low 7).

### Follow-up review recommendation

`true`. Patched counts: high 0, medium 4, low 4. Score = 3 x 4 + 4 = 16, which is >= 5.

### Verification

- `pnpm exec vitest run --project node` over `research-projects`, `research-repair-route`, `research-panel`, `research-runtime`, `read-only-copy-parity`, `store-fault-routes`, `errors` — 326 passed, 1 skipped.
- `pnpm exec vitest run --project dom src/components/__tests__/studio-research-read-only.test.tsx` — 20 passed.
- `pnpm exec tsc --noEmit` — exit 0.
- `pnpm lint` — exit 0; the three `TSNonNullExpression` plugin notices are pre-existing (confirmed against a stashed baseline).
- `pnpm test` — 356 files, 8560 passed / 1 skipped, exit 0.
- Matrix test audit — every I/O matrix row has at least one covering test that ran and passed in the runs above.

### Residual risks

- The spec's `Block If` (the static `repair` segment routing ahead of `[id]`) rests on Next's static-before-dynamic precedence and on `[id]` defining no `POST` at all. It is asserted in prose, not by a test; the repo has no route-manifest suite to join, and `pnpm build` was not run.
- Nothing reaps `.corrupt-*` siblings, by design — a tenant repaired repeatedly accumulates copies, and no door reads one back.
- The repair's `logger.warn` line rides below the suite's default log level, so it is exercised but not asserted.
- `sourceUrlLoss` is measured against the list the run's patch carried, which `uniqueResults` has already bounded upstream; the sentence's "this run collected" therefore means "handed to the store", not "seen by the provider".
- The recorded deferred item — a wedged owner is told to issue an HTTP POST with no control to press — is the half of DW-477's title the recorded decision did not ask for.
