---
title: 'Names & Terms: frozen read type, corrupt-file degrade, saved-entry shape guard'
type: 'bugfix'
created: '2026-09-05'
status: 'done'
baseline_revision: 'aa1ef3b1b6a052c7233553e6aa91aec3859061f7'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Three defects in one dictionary. (DW-498) `listNamesTerms` returns entries frozen at `resolveSortedEntries`, but its `Promise<NamesTermEntry[]>` type advertises them as mutable, so a consumer can be written against a contract the runtime refuses. (DW-499) `resolveSortedEntries` sorts BEFORE the non-object skip, so one bad element in a hand-edited `names-terms.json` throws a `TypeError` out of the comparator (or, for a field-less entry, out of `renderNamesTermsGuidance`) and the whole read fails instead of degrading to the valid subset. (DW-747) `NamesTermsSettings.save` pushes `data.entry` into state with no 2xx shape guard, and `readJsonBody` resolves `{}` for a 2xx that merely fails to parse, so `undefined` reaches the row map and `Cannot read properties of undefined (reading 'canonical')` blanks the whole section.

**Approach:** Split the read type — a new exported `FrozenNamesTermEntry` becomes the return type of `listNamesTerms` and the parameter type of the three pure helpers that consume a read result, while `NamesTermEntry` stays mutable for `create`/`update`. Filter to readable entries at the read boundary in `readEntries`, so every downstream layer (sort, freeze, render, canonicalize) sees only elements it can dereference. Add the 2xx shape guard `save` is missing, in the idiom every sibling adopter already uses.

## Boundaries & Constraints

**Always:**
- `NamesTermEntry` stays mutable and stays the type of `createNamesTerm` / `updateNamesTerm` returns and of `NamesTermInput` cleaning.
- The read-boundary filter is a pure predicate — it never coerces, repairs, or rewrites an element.
- The filter keeps exactly the elements the read pipeline dereferences without a guard: an object with a string `kind`, a string `canonical`, and an `aliases` array whose members are all strings. Anything else is dropped from the read.
- `readEntries` keeps its existing ENOENT-to-`[]` and rethrow-everything-else behaviour; a `JSON.parse` `SyntaxError` still propagates.
- The `save` guard throws inside the existing `try`, so the existing `writeFailure` catch composes the sentence — no new error-reporting path.
- Comments that assert current behaviour must be corrected where this change falsifies them (`resolveSortedEntries`, `listNamesTerms`, and the `merge.ts` dictionary-probe docblock).

**Block If:**
- Adopting `FrozenNamesTermEntry` requires widening a WRITE-path signature (`readEntries`, `writeEntries`, `assertNoConflicts`, `cleanInput`) to keep `tsc` green — that would ripple the freeze into the write surface, which DW-498's decision explicitly rules out.

**Never:**
- Do not make `NamesTermEntry` itself readonly.
- Do not add a shape guard to `NamesTermsSettings.load` or any other call site in that file — DW-747 names `save`; the sibling GET is out of scope.
- Do not change the wire type the component declares (`NamesTermEntry` for deserialized JSON) — the frozen type describes the server-side read result, not the client's own copy.
- Do not add validation of `kind` against `NAMES_TERM_KINDS`, of `id`, or of any optional field at the read boundary. Only throw-sources are filtered.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Valid dictionary | `[{kind,canonical,aliases:[…]}, …]` | `listNamesTerms` resolves the sorted, frozen entries as today | No error expected |
| Corrupt element beside a real one | `names-terms.json` = `[null, entry]` | Resolves `[entry]` — the valid subset, not a throw | No error expected |
| Field-less element | `[{"kind":"project","canonical":"X"}]` (no `aliases`) | Resolves `[]`; `renderNamesTermsGuidance` returns `""` instead of throwing | No error expected |
| Non-string alias | `[{kind,canonical,aliases:[1]}]` | Element dropped; read resolves `[]` | No error expected |
| Unparseable file | `names-terms.json` = `{not json` | `JSON.parse` `SyntaxError` still propagates from `readEntries` | Caller's existing catch (e.g. `merge.ts` probe) handles it |
| Missing file | no `names-terms.json` | `[]`, unchanged | ENOENT degrades |
| Write through a read result | `(await listNamesTerms(o))[0].canonical = "x"` | Fails `tsc` | Compile error, pinned by `@ts-expect-error` |
| Save, 2xx that fails to parse | POST answers 200, body is not JSON | Guard throws; feedback banner carries the sentence; the entries list stays rendered | `writeFailure` reports it; `unconfirmed` is false, so no refetch |
| Save, 2xx with a valid entry | POST answers 200 `{entry}` | Entry appended and list re-sorted, unchanged | No error expected |

</intent-contract>

## Code Map

- `src/lib/names-terms.ts` -- the whole of DW-498/DW-499.
  - `NamesTermEntry` (:17-29) -- stays mutable; the new `FrozenNamesTermEntry` is declared beside it.
  - `readEntries` (:187-195) -- today validates only `Array.isArray`; this is the read boundary the filter lands at.
  - `resolveSortedEntries` (:272-286) -- sorts at :273-275 (comparator dereferences `a.kind` / `a.canonical`), then the non-object skip at :281 which the filter makes dead. Return type becomes `Promise<FrozenNamesTermEntry[]>`. Its docblock (:253-271) asserts the skip exists because `readEntries` only checks `Array.isArray` — now false.
  - `NamesTermsCache` (:246) -- `Map<string, Promise<NamesTermEntry[]>>`; must follow the read type.
  - `listNamesTerms` (:308-337) -- return type; docblock at :302-303 says "The exported types stay mutable, so the failure is at runtime" — now false for the read.
  - `canonicalizeNamesTerm` (:407-423), `applyNamesTermsToGeneratedText` (:429-447), `renderNamesTermsGuidance` (:470-484) -- pure helpers taking `readonly NamesTermEntry[]`; they must accept the frozen read result. `NamesTermEntry` is assignable to `FrozenNamesTermEntry` (mutable → readonly widens), so widening these parameters keeps the write-path callers compiling.
  - Write path that must NOT change type: `writeEntries` (:197), `assertNoConflicts` (:165), `cleanInput` (:139), `createNamesTerm` (:339), `updateNamesTerm` (:371), `deleteNamesTerm` (:395).
- `src/lib/merge.ts:492-537` -- the pre-fold dictionary probe. Its docblock (:501-510) states that `renderNamesTermsGuidance` throws on "a `null` or a field-less entry" because "nothing filtered" them — the exact claim this change falsifies. Behaviour change: a layer-2 corrupt dictionary now degrades to the valid subset instead of dropping the whole owner (Purpose included); only layer 1 (`JSON.parse`) still drops it.
- `src/components/NamesTermsSettings.tsx` -- `save` (:178-229); the unguarded push is `data.entry` at :202-209. Guard idiom to copy: `BulkDocumentImport.tsx:230` (`if (!data.queued || !data.jobId) throw new Error(…)`) and `WikiWorkbench.tsx:333,414` (`if (!wiki?.id) throw new Error(…)`).
- `src/lib/workbench-request.ts` -- `readJsonBody` (:127) resolves `{}` for a 2xx `SyntaxError` and documents that "the caller's own shape guard says what it always said"; `writeFailure` (:305) relays a thrown `Error.message` with `unconfirmed: false`. Read-only: do not change.
- Read-only consumers of `listNamesTerms` (all use inferred types, so they follow the new return type with no edit): `src/lib/action-items.ts:102,180`, `src/lib/action-extractor.ts:42`, `src/lib/structured-knowledge.ts:335`, `src/lib/monitor-digests.ts:437`, `src/lib/ingest.ts:2149`, `src/app/api/names-terms/route.ts:19`.
- `src/lib/__tests__/names-terms.test.ts:390-413` -- "does not throw on a non-object element" pins `[null]` resolving to LENGTH 1 and states in its comment that two-or-more already throws. Both the assertion and the comment are superseded.
- `src/lib/__tests__/merge.test.ts:1431-1475` -- `CORRUPT_DICTIONARIES` runs three cases through one assertion block that expects the Purpose dropped. Layers now diverge: only `"{not json"` still drops the owner.
- `src/components/__tests__/names-terms-unconfirmed-write.test.tsx` -- the mounted DW-717 harness for this exact component (`listAnswer`, `saveNewEntry`, `bannerText`, `posts`/`reads`). The DW-747 case belongs here.
- Test project split (AGENTS.md): `*.test.ts` ⇒ node, `*.test.tsx` ⇒ jsdom. Do not rename.

## Tasks & Acceptance

**Execution:**
- `src/lib/names-terms.ts` -- export `FrozenNamesTermEntry` (`Readonly<Omit<NamesTermEntry, "aliases">> & { readonly aliases: readonly string[] }`) with a docblock saying why the READ type differs from the write type (DW-498) -- expresses at compile time what `Object.freeze` enforces at runtime.
- `src/lib/names-terms.ts` -- add a module-private `isReadableEntry` type predicate and filter `readEntries`' parsed array through it (DW-499), documenting that the filter is what lets sort/freeze/render dereference without a guard, and that a dropped element is not written back on the next create/update/delete -- moves the degrade to the boundary instead of the comparator.
- `src/lib/names-terms.ts` -- retype `resolveSortedEntries`, `NamesTermsCache` and `listNamesTerms` to the frozen entry, delete the now-unreachable non-object skip in the freeze loop, and correct both docblocks (the `Array.isArray`-only claim and the "exported types stay mutable" claim) -- a comment that states the opposite of the code is the next defect.
- `src/lib/names-terms.ts` -- widen `canonicalizeNamesTerm`, `applyNamesTermsToGeneratedText` and `renderNamesTermsGuidance` to `readonly FrozenNamesTermEntry[]` -- they are the only functions a read result is passed into; mutable entries still satisfy them, so no write-path caller changes.
- `src/lib/merge.ts` -- correct the dictionary-probe docblock: the render layer no longer throws on a null or field-less entry because `readEntries` filters, so only an unparseable file still drops the owner and its Purpose -- the comment is the only record of why the probe is `buildNamesTermsGuidance` rather than `listNamesTerms`, and it must state the true reason.
- `src/components/NamesTermsSettings.tsx` -- in `save`, guard the 2xx body shape before `setEntries` and throw a sentence (DW-747), with a comment naming what the guard prevents -- stops `undefined` reaching the row map and blanking the section.
- `src/lib/__tests__/names-terms.test.ts` -- replace the `[null]`-resolves-to-1 test with the degrade cases from the I/O matrix (corrupt element beside a real one, field-less element, non-string alias, unparseable still throwing), and add an `@ts-expect-error` pin that a write through a `listNamesTerms` result does not compile -- executes DW-498's "pin that a write through a read result fails to compile" and DW-499's valid-subset degrade.
- `src/lib/__tests__/merge.test.ts` -- split `CORRUPT_DICTIONARIES` by layer: an unparseable file still folds unguided with the Purpose dropped; a layer-2 file now folds WITH the Purpose and without a dictionary block -- pins the behaviour change the filter causes at the surface that motivated the probe.
- `src/components/__tests__/names-terms-unconfirmed-write.test.tsx` -- add the DW-747 row: a POST answering 2xx whose body fails to PARSE leaves the entries list on screen and puts the guard's sentence in the banner, with no refetch -- the crash was found while drafting exactly this case.

**Acceptance Criteria:**
- Given a consumer holding a `listNamesTerms` result, when it assigns to `entry.canonical` or pushes onto `entry.aliases`, then `tsc` rejects it, while `createNamesTerm` / `updateNamesTerm` results stay assignable.
- Given `names-terms.json` holds one unreadable element and one valid entry, when any read path resolves (cached or uncached, `listNamesTerms` or `buildNamesTermsGuidance`), then it yields the valid entry alone and never throws.
- Given a merge whose survivor owner has a layer-2 corrupt dictionary, when `mergePages` runs, then the fold succeeds and the survivor's Workspace Purpose is still in the prompt.
- Given the Names & Terms editor with entries on screen, when a save answers 2xx with an unparseable body, then the entries list is still rendered and the feedback banner states the entry was not confirmed.

## Design Notes

The read/write asymmetry in one line:

```ts
export type FrozenNamesTermEntry = Readonly<Omit<NamesTermEntry, "aliases">> & {
  readonly aliases: readonly string[];
};
```

Widening the three pure helpers costs nothing at the call sites: TypeScript treats `string[]` as assignable to `readonly string[]` and ignores `readonly` property modifiers for assignability, so `NamesTermEntry` still satisfies `FrozenNamesTermEntry` and the write path compiles untouched. The direction that must NOT work — a frozen entry where a mutable one is expected — is what the `@ts-expect-error` pin holds.

The filter defines "readable" as exactly the fields the read pipeline dereferences with no guard of its own: the comparator reads `kind` and `canonical`, and `[entry.canonical, ...entry.aliases]` appears in `canonicalizeNamesTerm`, `expandQueryWithNamesTerms` and `renderNamesTermsGuidance`. Nothing wider — `id`, `kind`-in-`NAMES_TERM_KINDS`, optional fields — is validated, because dropping an element the pipeline could have handled is data loss on the next write.

## Verification

**Commands:**
- `pnpm exec tsc --noEmit` -- expected: clean, and the `@ts-expect-error` in `names-terms.test.ts` reports no "unused" error (which would mean the write compiled).
- `pnpm exec vitest run src/lib/__tests__/names-terms.test.ts src/lib/__tests__/names-terms-routes.test.ts src/lib/__tests__/merge.test.ts src/lib/__tests__/read-only-store-gate.test.ts` -- expected: all pass.
- `pnpm exec vitest run --project dom src/components/__tests__/names-terms-unconfirmed-write.test.tsx src/components/__tests__/names-terms-read-only.test.tsx` -- expected: all pass.
- `pnpm test` -- expected: full suite green.
- `pnpm lint` -- expected: clean.
</content>
</invoke>

## Spec Change Log

No entries — no `bad_spec` loopback occurred.

## Review Triage Log

### 2026-09-05 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 2, low 1)
- defer: 0
- reject: 7: (high 0, medium 1, low 6)
- addressed_findings:
  - `[medium]` `[patch]` The new `save` guard checked only `id` and `canonical`, but `setEntries`' comparator runs `localeCompare` on `kind` and `canonical`, the row map reads `aliases.length`, and `beginEdit` calls `aliasesText(entry.aliases)` — so a parseable 2xx carrying a PARTIAL entry still blanked the section the guard exists to keep on screen. Widened the guard to every field the component dereferences unguarded (`id`, `canonical`, string `kind`, array `aliases`), rewrote the comment to say why those four and no more, and added a mounted row pinning a partial-entry 2xx as refused with the list still rendered.
  - `[medium]` `[patch]` `readEntries` is the read half of `createNamesTerm`/`updateNamesTerm`/`deleteNamesTerm`, so the DW-499 filter changed the write path too and nothing asserted it: a create over a corrupt dictionary now succeeds where it used to throw out of `assertNoConflicts` into the route's 500, and the unreadable element is then permanently gone from the bytes. Moving the filter down into `resolveSortedEntries` would have left every test green while breaking the write door. Added a test seeding an unreadable element beside a real entry, calling `createNamesTerm`, and asserting both the resolved read and the rewritten bytes; added `assertNoConflicts` to `isReadableEntry`'s list of dereference sites.
  - `[low]` `[patch]` Three new comments (the `merge.ts` probe, `listNamesTerms`' docblock, the new merge test's docblock) claimed the `JSON.parse` `SyntaxError` was "the ONLY way the probe rejects", while stating one line away that `readEntries` rethrows everything but ENOENT — an EACCES, an EIO or a Workers-adapter storage failure still rejects and still costs the owner their Purpose. Corrected all three to name what `readEntries` actually propagates.

## Auto Run Result

Status: done
Blocking condition: none

### Implemented change

Three defects in the Names & Terms dictionary, resolved together (DW-498, DW-499, DW-747).

- **DW-498 — the read type.** New exported `FrozenNamesTermEntry` (`Readonly<Omit<NamesTermEntry, "aliases">> & { readonly aliases: readonly string[] }`) is now the return type of `listNamesTerms` and `resolveSortedEntries`, the value type of `NamesTermsCache`, and the parameter type of the three pure helpers a read result is passed into. `NamesTermEntry` stays mutable for the create/update path; mutable widens to frozen, so no write-path signature moved. A never-invoked closure carries two `@ts-expect-error` directives that fail the typecheck the moment a write through a read result starts compiling.
- **DW-499 — the read boundary.** `readEntries` now filters the parsed array through a module-private `isReadableEntry` predicate: an object with a string `kind`, a string `canonical`, and an `aliases` array of strings — exactly what the sort comparator, the freeze, `assertNoConflicts` and the render helpers dereference with no guard. A corrupt file degrades to its valid subset instead of throwing out of the comparator, and the now-unreachable non-object skip in `resolveSortedEntries` is gone. ENOENT still degrades to `[]`; every other read error, including an unparseable file, still propagates.
- **DW-747 — the save shape guard.** `NamesTermsSettings.save` now refuses a 2xx whose body does not carry the four fields the section dereferences, throwing inside the existing `try` so `writeFailure` composes the sentence with `unconfirmed: false` — the list stays on screen and is not refetched.

Behaviour change worth naming: a layer-2 corrupt dictionary no longer costs a merging owner their Workspace Purpose. `merge.ts`'s pre-fold probe only rejects for what `readEntries` propagates now, so a corrupt element costs the owner nothing but the element.

### Files changed

- `src/lib/names-terms.ts` — `FrozenNamesTermEntry`, `isReadableEntry`, the `readEntries` filter, the retyped read path, and the corrected docblocks.
- `src/lib/merge.ts` — pre-fold dictionary-probe docblock corrected: the render layer no longer throws, and what still rejects is what `readEntries` propagates.
- `src/components/NamesTermsSettings.tsx` — `save`'s 2xx shape guard.
- `src/lib/__tests__/names-terms.test.ts` — four read-degrade rows, the unparseable-still-rejects row, the write-over-a-degraded-dictionary row asserting the bytes, and the `@ts-expect-error` type pin.
- `src/lib/__tests__/merge.test.ts` — `CORRUPT_DICTIONARIES` split by layer: unparseable still drops the owner; a corrupt element keeps the Purpose.
- `src/components/__tests__/names-terms-unconfirmed-write.test.tsx` — the shapeless-body row, the partial-entry row, and a well-formed 2xx control.

### Review findings

- Patches applied: 3 (medium 2, low 1).
- Items deferred: 0.
- Items rejected: 7 — a non-object 2xx body reaching `data.entry` (degrades to the unconfirmed sentence, and is the shared shape of every sibling adopter); requiring `id` in the predicate (pre-existing ghost-entry behaviour, unchanged); validating `kind` against `NAMES_TERM_KINDS` (ruled out by the intent contract); logging dropped elements (addition, not a defect); `route.ts` and the client component keeping `NamesTermEntry` for the wire shape (deliberate — deserialized JSON is mutable); `pnpm test` alone not enforcing the type pin (CI runs `tsc --noEmit`, which does); `isReadableEntry` narrowing to `NamesTermEntry` without checking `kind` membership (no regression — the prior code cast the whole array unchecked).
- Follow-up review recommended: **false** — patched severities were medium 2, low 1, high 0.

### Verification

- `pnpm exec tsc --noEmit` — clean, exit 0; both `@ts-expect-error` directives consumed, so the mutations genuinely fail to compile.
- `pnpm exec vitest run` over `names-terms`, `names-terms-routes`, `merge`, `read-only-store-gate` — 144 passed.
- `pnpm exec vitest run --project dom` over `names-terms-unconfirmed-write`, `names-terms-read-only` — 16 passed.
- `pnpm test` — 388 files, 9750 passed / 1 skipped, exit 0.
- `pnpm lint` — exit 0 (only the pre-existing `jsx-ast-utils` `TSNonNullExpression` notices, unchanged from baseline).
- Matrix audit: all nine I/O rows are covered by tests that ran and passed in the runs above; the happy-path save row needed new coverage and got it (the pre-existing control test only asserted the request went out, not that the entry landed on the list).

### Residual risks

- A write over a dictionary holding an unreadable element permanently drops that element from `names-terms.json`. This is what "filter at the read boundary in `readEntries`" implies, it is documented in the `readEntries` docblock and now pinned by a test — but it is the opposite of what the comparable stores in this repo (`query-history`, `workspace-profile`, `research-projects`) guarantee for corrupt bytes. It also means such an element cannot be removed through `DELETE /api/names-terms/[id]`, which returns 404 for it until an unrelated write erases it.
- `NamesTermsSettings.load` still has the DW-747 crash shape: `setEntries(data.entries)` with no guard, so a shapeless 2xx on the mount read blanks the section. Out of scope by the intent, which names `save` alone; left untouched and unpinned.
