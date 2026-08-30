---
title: 'Research store: wrap the registry JSON.parse, guard completion sources, pin the URL caps'
type: 'bugfix'
created: '2026-08-30'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `commitResearchPage`'s `completion?.sources?.length` fallbacks persist a truthy
      non-array `sources` forward before the drain guard can refuse it.
    evidence: |-
      `src/lib/research-completion.ts:536` writes `sources: project.completion?.sources?.length
      ? project.completion.sources : sources`, so a stored `completion: { phase: "page",
      sources: "https://example.com/a" }` is rewritten to `phase: "sources"` KEEPING the
      string, with `progress.message` reporting the string's character count as a source
      count ("Ingesting 21 sources."). Only the drain immediately after refuses it. The two
      lines cannot simply be routed through `requireCompletionSources`: a missing or empty
      list there is the ordinary first-commit path, so guarding them as written would refuse
      an ordinary commit. Closing this needs a "completion exists but its sources are not a
      list" test distinct from "no completion yet". Pre-existing; DW-579 named the
      `findIndex`/`map` dereferences, not this write. Now named accurately in the
      `requireCompletionSources` docblock.
    location: >-
      src/lib/research-completion.ts:536
    severity: low
  - summary: >-
      The drain's follow-up mutator guard is defense-in-depth that no test can reach.
    evidence: |-
      `requireCompletionSources(project.completion).map(...)` at
      `src/lib/research-completion.ts:921` re-reads the row inside the post-ingest CAS, so it
      fires only when a concurrent writer corrupts `completion.sources` after the loop guard
      at `:908` has already read it AND after every `checkpointSource` in the loop has
      finished. An independent mutation check confirmed reverting it alone leaves all four
      research suites green. The sibling guard at `:692` is now pinned (a mid-drain
      corruption row added during review); this one still is not, and the window it protects
      is narrow enough that a later edit could strip it unnoticed.
    location: >-
      src/lib/research-completion.ts:921
    severity: low
  - summary: >-
      `requireCompletionSources` validates only `Array.isArray`, so an array of wrong-shaped
      ELEMENTS reproduces DW-579's failure class one level down.
    evidence: |-
      `["https://example.com/a"]`, `[null]` and `[{}]` all pass the guard and then reach
      `source.url === url` in `checkpointSource` and `meta.url` / `meta.slug` in the drain
      loop — undefined-keyed `byUrl` lookups and the same opaque `TypeError` class DW-579
      set out to remove, one level in. The limit is deliberate and now named in the helper's
      docblock: a per-element notion of "valid completion source" belongs beside
      `isResearchProject`, not as a second divergent one here. Closing it means deciding
      whether the registry guard should start validating nested optional structures, which
      its own docblock currently declines to do.
    location: >-
      src/lib/research-completion.ts:89
    severity: low
  - summary: >-
      `cleanUrls`' 2000-character slice and its slice-before-dedupe order are silent data
      loss, now pinned as expected behaviour by characterization tests.
    evidence: |-
      The slice stores a DIFFERENT, still-parseable URL that resolves somewhere else than
      the one the provider returned, and because `cleanList` slices before it dedupes, two
      distinct URLs agreeing on their first 2000 characters collapse into one stored entry —
      two sources become one with nothing said. The new DW-603 rows
      (`src/lib/__tests__/research-projects.test.ts`) document both and say so in their own
      comments ("Documented, not desired"); this bundle's `Never` clause forbade changing the
      behaviour. The 40-item cap has the same silence and is the exposure DW-603's reason
      actually names: the Studio's "Collect N URLs" reports N with nothing saying the tail
      was dropped.
    location: >-
      src/lib/research-projects.ts:181
    severity: low
  - summary: >-
      `markResearchDeliveryBlocked` tells the operator to "Repair the reported lock" for
      every drain fault, and its Retry re-hits a shape refusal forever.
    evidence: |-
      `src/lib/research-runtime.ts:246-270` writes `progress.message: "Research delivery is
      blocked. Repair the reported lock, then retry."` and surfaces the caught message as
      `error`. Both drain call sites (`:606-613`, `:1310-1314`) route through it, so the new
      `Research completion sources are not a list.` refusal is presented under an
      instruction naming a lock that is not involved, pointing at a Retry that re-enters the
      same refusal. Separately `:498` and `:500` swallow drain faults with
      `.catch(() => undefined)`, so cancel and retire silently no-op against a corrupt
      completion. Pre-existing for every fault class this path already carried; the shape
      refusal only makes the mismatch easier to hit.
    location: >-
      src/lib/research-runtime.ts:246
    severity: low
baseline_revision: 'fcd677f2c00fa70e8bff64ec7e60bfd2ad61226f'
---

<intent-contract>

## Intent

**Problem:** Three unhardened spots in the research store. (1) `parseRegistry` calls `JSON.parse(raw)` bare, so truncated or non-JSON registry bytes escape as a raw `SyntaxError` (`Unexpected token } in JSON at position 41`) instead of the domain refusal the sibling `parseSlots` throws for the lease file. (2) `research-completion.ts` reaches `project.completion.sources` after only a `phase` check, so a stored `completion: { phase: "sources" }` with no `sources` array dies in `.findIndex(...)`/`.map(...)` with the same opaque `TypeError` DW-476 removed from the registry sort — and a non-array truthy `sources` (a string) is iterated character by character. (3) `cleanUrls`' 40-item cap, 2000-character slice and dedupe are untested on the run's `sourceUrls` patch, which since DW-442 is the only write path for a project's source URLs; the store tests cover only the `javascript:` protocol filter.

**Approach:** Wrap `parseRegistry`'s `JSON.parse` and throw the plain-`Error` domain refusal the rest of that helper throws, mirroring `parseSlots`' "unreadable" message. Add a named `ResearchCompletionShapeError` plus one `requireCompletionSources` helper in `research-completion.ts`, and route every array dereference of a stored `completion.sources` through it so a wrong shape refuses loudly at the read. Extend `research-projects.test.ts` with rows pinning the cap, the slice and the dedupe on the patch path.

## Boundaries & Constraints

**Always:**
- The registry parse failure stays a plain `Error` (a wrong-shaped stored file is a 500, never a `ClientInputError`) and mirrors the sibling wording: `"Research projects file is unreadable."`, matching `parseSlots`' `"Research lease file is unreadable."`.
- The completion refusal is a named class — `extends Error` with `this.name` set, the repo's `ResearchProjectNotFoundError` / `ResearchLeaseError` idiom — so a duplicated module graph cannot un-classify it.
- Fail closed: a wrong-shaped `completion.sources` refuses. Never coerce it to `[]`, never skip the bad value, never repair it in place.
- `isEnoent`-based "no file yet ⇒ empty registry" behaviour in `readProjects` is unchanged; only the parse fault is retyped.
- New tests go in `src/lib/__tests__/research-projects.test.ts` (node project, `*.test.ts`) using its existing `seedRawRegistry` / `createResearchProject` fixtures.

**Block If:**
- Making a completion guard refuse requires changing which HTTP status any research door already answers.

**Never:**
- Do not add a repair or recovery route for a corrupt registry, and do not change `isResearchProject` to validate nested optional structures.
- Do not change `cleanUrls`' cap, slice length, dedupe rule or protocol filter — this bundle only pins the current behaviour with tests.
- Do not touch `research-concurrency.ts`, the run route error typing, or the `ClientInputError` `instanceof` sites; they are other ledger entries.
- Do not relax `parseRegistry`'s existing non-array or per-element refusals.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Truncated registry bytes | `research-projects.json` holds `{"id":` | Every read and write door for that owner refuses | Throws `Error("Research projects file is unreadable.")`, not a `SyntaxError` |
| Non-JSON registry bytes | file holds `not json at all` | Same refusal | Same message |
| Well-formed registry | valid JSON array of rows | Rows parse and are returned | No error |
| Missing registry file | no file on disk | `readProjects` returns `[]` | ENOENT still swallowed |
| Completion with no `sources` | stored `completion: { phase: "sources", pageSlug: "p" }` | Source checkpoint / drain refuse | Throws `ResearchCompletionShapeError`, `name === "ResearchCompletionShapeError"` |
| Completion with non-array `sources` | stored `completion.sources` is a string | Same refusal — never iterated per character | Same named error |
| Run patch over 40 unique URLs | `updateResearchProject` patch with 45 distinct http URLs | Stored `sourceUrls` holds the first 40 in order | No error |
| Run patch with an over-long URL | patch URL longer than 2000 chars | Stored value is the first 2000 characters | No error |
| Run patch with duplicates | patch `[a, b, a]` | Stored `[a, b]`, first-seen order | No error |

</intent-contract>

## Code Map

- `src/lib/research-projects.ts:307` -- `parseRegistry(raw)`; line 308 is the bare `JSON.parse(raw)` to wrap. Its docblock (lines ~271-306) already states why the throw is a plain `Error` and that it matches `parseSlots` — extend that prose, do not restate it.
- `src/lib/research-projects.ts:319` -- `readProjects` is the only caller besides the CAS read; it catches `isEnoent` only, so a retyped parse error propagates unchanged.
- `src/lib/research-concurrency.ts:88-94` -- `parseSlots`, the try/catch + message shape to mirror verbatim in spirit ("Research lease file is unreadable.").
- `src/lib/research-projects.ts:181-201` -- `cleanUrls` / `cleanList`: `cleanList(values, 40, 2_000)` then the `new URL` http/https filter. `cleanList` trims, collapses whitespace, slices to `maxChars`, dedupes on the CLEANED string, and `break`s once `result.length >= maxItems`.
- `src/lib/research-projects.ts:563-577` -- `mutateResearchProject`; `createResearchProject` (line ~487) already throws from inside a mutator, so a throw from a mutate callback propagates through `lockedMutation` without being retried as CAS contention.
- `src/lib/research-projects.ts:122-146` -- `ResearchCompletionSource` and `ResearchCompletion` interfaces (import the types).
- `src/lib/research-projects.ts:15-49` -- `ResearchProjectNotFoundError` / `ResearchProjectConflictError`: the named-error idiom to copy (plain `extends Error`, `this.name` assigned, docblock explaining why it is narrow).
- `src/lib/research-completion.ts:641-660` -- `checkpointSource`; line 649 `findIndex`, 651 index read, 654 `slice()` — guards only `if (!project.completion)`. The DW-579 anchor.
- `src/lib/research-completion.ts:862-871` -- `drainResearchOutbox`'s `for (const meta of completion.sources)`, reached after the `phase === "page"` branch only.
- `src/lib/research-completion.ts:872-890` -- the follow-up mutator's `project.completion.sources.map(...)`.
- `src/lib/research-completion.ts:473-475` and `:493` -- `completion?.sources?.length ? … : …`. Deliberately LEFT ALONE: falsy-length already falls back to the outbox, and the one shape that slips through (a truthy non-array) is caught by the new guard at `:864`. Note this in the helper's docblock rather than changing these lines.
- `src/lib/research-completion.ts:342` -- `completionSourcesFromOutbox`; name the new helper differently (`requireCompletionSources`).
- `src/lib/__tests__/research-projects.test.ts:114-133` -- the existing DW-442 "lands a run's collected source URLs through the patch" row and its `javascript:` assertion; the new cap/slice/dedupe rows belong beside it.
- `src/lib/__tests__/research-projects.test.ts:21-31` -- `registryPath` / `seedRawRegistry`, the only raw-bytes writer, for the unreadable-registry rows.
- `src/lib/__tests__/research-projects.test.ts:307-341` -- the "a registry that is not a list" describe: the established shape for asserting one refusal across several doors.
- `src/lib/research-runtime.ts:1557-1560` -- the run's `{ results, sourceUrls }` patch, the sole `sourceUrls` writer DW-603 wants covered. Read-only here.
- `AGENTS.md` "Test environments" -- suites live under `__tests__`; `*.test.ts` is the node project. Both touched suites already are.

## Tasks & Acceptance

**Execution:**
- `src/lib/research-projects.ts` -- wrap `parseRegistry`'s `JSON.parse` in try/catch and throw `new Error("Research projects file is unreadable.")`; extend the existing docblock with one short paragraph naming why the first throw is now typed like the others -- unwrapped `SyntaxError` is the opaque-error-far-from-the-cause shape DW-476 existed to kill, and `parseSlots` already wraps its own.
- `src/lib/research-completion.ts` -- add an exported `ResearchCompletionShapeError` (plain `extends Error`, `this.name` set) and a module-private `requireCompletionSources(completion)` returning `ResearchCompletionSource[]` or throwing it; import the `ResearchCompletion` type -- one named refusal replaces three separate opaque `TypeError`s.
- `src/lib/research-completion.ts` -- route `checkpointSource`'s `findIndex`/index read/`slice`, `drainResearchOutbox`'s `for (const meta of …)`, and the follow-up mutator's `.map(…)` through `requireCompletionSources` -- these are the three reachable dereferences of a stored `completion.sources`.
- `src/lib/__tests__/research-projects.test.ts` -- add an "a registry whose bytes are not JSON" describe covering truncated and non-JSON bytes across at least a read door and a write door, plus rows pinning `cleanUrls`' 40-item cap, 2000-character slice and dedupe on the `updateResearchProject` patch -- these are the matrix rows for this file.
- `src/lib/__tests__/research-completion.test.ts` -- add rows for a stored `completion` whose `sources` is missing and one where it is a string, asserting the named refusal on the drain path -- pins that a wrong shape refuses instead of dying in `findIndex`/`map` or iterating a string per character.

**Acceptance Criteria:**
- Given a tenant registry file holding bytes that are not JSON, when any research door reads it, then it fails with `Research projects file is unreadable.` and never with a raw `SyntaxError` message.
- Given a stored project whose `completion.sources` is not an array, when the completion drain runs, then it throws an error whose `name` is `ResearchCompletionShapeError` and the registry is left unchanged.
- Given a valid registry and a normal completion, when the existing research suites run, then every previously passing assertion still passes — the guards add refusals only for shapes that already failed.
- Given the run's `sourceUrls` patch, when it carries more than 40 unique URLs, an over-long URL, or duplicates, then the stored list is capped at 40 in first-seen order, each entry is at most 2000 characters, and duplicates appear once.

## Spec Change Log

## Review Triage Log

### 2026-08-30 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 2, low 4)
- defer: 5: (high 0, medium 0, low 5)
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - `[medium]` `[patch]` The DW-579 ledger anchor — `checkpointSource`'s guard — was unreachable from every test: all rows seeded `phase: "sources"` and refused at the drain loop's guard first, and an independent mutation check confirmed reverting `checkpointSource` alone left all four research suites green. Added a mid-drain corruption row that seeds a two-source outbox with a valid `sources` array and corrupts the stored row to a string through the existing `enqueueTask` mock seam during the first source's dispatch, so the second source's `checkpointSource` is what refuses. Mutation-verified: reverting that one guard now fails exactly this row.
  - `[medium]` `[patch]` DW-603's 40-item cap was pinned only against an all-valid list, missing where the cap actually bites: `cleanList` caps and `break`s BEFORE `cleanUrls`' http/https filter, so `["javascript:alert(1)", ...40 valid https URLs]` stores 39, not 40. Added a characterization row pinning that a provider returning one unusable URL silently costs a good one.
  - `[low]` `[patch]` `requireCompletionSources`' docblock opened "The one read of a stored `completion.sources`" while four unguarded dereferences remained (`:516`, `:517`, `:536`, `:703`), and claimed a truthy non-array slipping past the `commitResearchPage` fallbacks "is caught by this guard on the drain immediately after" — true of the refusal, false of the state, since `:536` persists the string forward first. Reworded to state what is actually guarded, what is not and why, and to name the `Array.isArray`-only limit the guard accepts.
  - `[low]` `[patch]` `parseRegistry`'s new `catch` discarded the original `SyntaxError` outright, destroying the byte offset the same docblock argues an operator needs. Preserved it as `{ cause: error }`; message and plain-`Error` type unchanged.
  - `[low]` `[patch]` The "leaves the stored row and the outbox untouched" row read as a whole-row no-write guarantee, but `drainResearchOutbox` mints `deliveryAttemptId` before reaching the guard. Retitled and re-commented to separate what is guaranteed from what is not, and added assertions pinning the one field a refusing drain does write.
  - `[low]` `[patch]` The `it.each` refusal row called `drainResearchOutbox` three times to assert three properties of one error, silently assuming an idempotence the `deliveryAttemptId` write breaks. Now catches once and asserts `name`, `instanceof` and message against that single value; added a `sources: null` case.

## Design Notes

The helper, mirroring `parseSlots`' fail-closed discipline:

```ts
export class ResearchCompletionShapeError extends Error {
  constructor(message = "Research completion sources are not a list.") {
    super(message);
    this.name = "ResearchCompletionShapeError";
  }
}

function requireCompletionSources(completion: ResearchCompletion): ResearchCompletionSource[] {
  if (!Array.isArray(completion.sources)) throw new ResearchCompletionShapeError();
  return completion.sources;
}
```

Refusing rather than coercing to `[]` is the point: an empty list would report a completion as having delivered nothing and let the drain mark it `done`, silently losing the sources — DW-297's "unreadable is not empty" mistake in a different file.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/research-projects.test.ts src/lib/__tests__/research-completion.test.ts src/lib/__tests__/research-completion-lifecycle.test.ts src/lib/__tests__/research-delivery.test.ts src/lib/__tests__/research-runtime.test.ts` -- expected: all pass, including the new cap/slice/dedupe, unreadable-registry and completion-shape rows.
- `pnpm exec tsc --noEmit` -- expected: no new type errors.
- `pnpm exec eslint src/lib/research-projects.ts src/lib/research-completion.ts src/lib/__tests__/research-projects.test.ts src/lib/__tests__/research-completion.test.ts` -- expected: clean.
- `pnpm test` -- expected: the full two-project run passes.

## Auto Run Result

Status: done

**Implemented change.** Three ledger entries against the research store, all fail-closed hardening plus coverage.

- **DW-575** — `parseRegistry`'s bare `JSON.parse` is wrapped; truncated or non-JSON registry bytes now refuse with `Research projects file is unreadable.` (a plain `Error`, so still a 500, mirroring the sibling `parseSlots`) instead of escaping as a raw `SyntaxError` naming a byte offset. The original error is kept as `{ cause }`.
- **DW-579** — a named `ResearchCompletionShapeError` and one `requireCompletionSources` helper now stand in front of all three reachable dereferences of a stored `completion.sources` (`checkpointSource`'s `findIndex`/index/`slice`, the drain loop, the post-ingest mutator's `map`). A wrong shape refuses by name rather than dying in `findIndex` — or, for a string, being iterated one character at a time.
- **DW-603** — `cleanUrls`' 40-item cap, 2000-character slice and dedupe are pinned on the run's `sourceUrls` patch, the only remaining writer of that field since DW-442.

**Files changed.**

- `../../src/lib/research-projects.ts` — `parseRegistry` wraps `JSON.parse` and preserves the cause; docblock extended with why the parse fault is typed like its two siblings.
- `../../src/lib/research-completion.ts` — new exported `ResearchCompletionShapeError` and module-private `requireCompletionSources`, routed into `checkpointSource` and both drain sites; docblock names what is guarded, what deliberately is not, and the `Array.isArray`-only limit.
- `../../src/lib/__tests__/research-projects.test.ts` — a "registry whose bytes are not JSON" describe (four byte fixtures across read, create, update and delete doors, with byte-identity and write-spy assertions), and a "run patch's source-URL bounds" describe pinning the cap, the slice, the dedupe, the slice-before-dedupe collapse and the cap-before-filter interaction.
- `../../src/lib/__tests__/research-completion.test.ts` — a "stored completion whose sources are not a list" describe: four bad shapes refusing by name on the drain, a fail-closed state row, a mid-drain corruption row that reaches `checkpointSource`'s guard, and a control row proving a real list still drains to `done`.

**Review findings breakdown.** 6 patches applied (2 medium, 4 low); 5 items deferred (all low, in frontmatter `deferred`); 10 rejected. No intent gaps and no spec defects — the four review layers (blind hunter, edge-case hunter, verification-gap, intent-alignment) converged on coverage and docblock-accuracy findings, not on the shape of the change.

**Follow-up review recommendation:** `true`. Patched findings only: high 0, medium 2, low 4 → 3 x 2 + 1 x 4 = 10, which is at or above the threshold of 5.

**Verification performed.**

- `pnpm exec vitest run --project node` over the five research suites — 195 passed, 1 skipped.
- `pnpm exec tsc --noEmit` — clean.
- `pnpm exec eslint` on the four touched files — clean.
- `pnpm test` (both projects) — 354 files, 8301 passed, 1 skipped.
- Mutation checks: reverting either guard fails only the rows written for it (10 registry-parse rows, 4 completion-shape rows, and the mid-drain row for `checkpointSource` specifically); files restored and re-verified green.
- Every I/O & Edge-Case Matrix row has at least one covering test that ran and passed.

**Residual risks.**

- A refusing drain still writes `deliveryAttemptId` and `updatedAt` before it reaches the guard, so "leaves the row untouched" holds for the completion payload and status but not byte-for-byte. Now asserted explicitly rather than implied.
- `commitResearchPage`'s two `completion?.sources?.length` fallbacks stay unguarded by design and can persist a truthy non-array forward before the drain refuses it — deferred, with the reason a naive guard there would refuse an ordinary first commit.
- The guard checks `Array.isArray` only; an array of wrong-shaped elements reproduces DW-579's failure class one level down — deferred.
- The DW-603 rows are characterization: the cap, the slice and the dedupe still lose data silently, and this bundle's scope forbade changing them. Deferred as one entry.
