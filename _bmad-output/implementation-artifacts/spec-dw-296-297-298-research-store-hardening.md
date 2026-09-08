---
title: 'Research project store: refuse a corrupt registry, stop silent eviction, classify input faults by type'
type: 'bugfix'
created: '2026-08-27'
baseline_revision: '0ec6468a09da86eecbc4b7e19350243a36960046'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `parseRegistry` refuses a non-array registry but validates no element, so an
      array of non-project entries still crashes later with an opaque TypeError.
    evidence: |-
      `[1,2,3]` or `[{}]` passes `Array.isArray`, is cast to `ResearchProject[]`, and
      dies in `listResearchProjects`' sort at `b.updatedAt.localeCompare(a.updatedAt)`.
      The sibling `parseSlots` in `research-concurrency.ts` validates every element
      with `isSlot`; this helper does not. Pre-existing shape, unchanged by DW-297.
    location: >-
      src/lib/research-projects.ts:184
    severity: medium
  - summary: >-
      A non-list registry now wedges a tenant with no in-product repair path.
    evidence: |-
      Every research operation for that owner refuses, including the deletes that
      could shrink the file, and the 500 body carries no remediation. The lease
      equivalent tells the operator what to do (`research-runtime.ts:886`:
      "Repair the lease state, then retry."). Refusing is the intended DW-297
      behaviour; the missing half is a recovery route.
    location: >-
      src/lib/research-projects.ts:184
    severity: medium
  - summary: >-
      `PATCH`/`DELETE /api/research/[id]` and the v1 `deep_research` action still map
      `ClientInputError` to 500, the same misclassification DW-296 fixed one door over.
    evidence: |-
      `src/app/api/research/[id]/route.ts:77` and `:96` catch-all at 500 with no
      `ClientInputError` branch, and
      `src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts:157-161` maps every
      non-read-only error to 500 while passing `item.title` straight into
      `createResearchProject`. So the MAX_PROJECTS refusal and `cleanInput`'s
      newly-typed blank-title refusal both surface there as server faults.
    location: >-
      src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts:157
    severity: medium
  - summary: >-
      `retireResearchProject`'s soft delete counts against the create cap while the
      panel hides those rows.
    evidence: |-
      `retireResearchProject` sets `deleteRequested` when a worker is live;
      `createResearchProject` counts `projects.length` including those rows, while
      `filterResearchProjects` (research-projects.ts:250) hides them. A tenant with
      stuck `deleteRequested` rows is refused at the cap while the UI shows fewer
      than MAX_PROJECTS. Pre-existing, surfaced by the cap work.
    location: >-
      src/lib/research-runtime.ts:453
    severity: medium
  - summary: >-
      `POST /api/research/[id]/run` still classifies failures by message regex.
    evidence: |-
      `/not found/i` -> 404 and `/already running/i` -> 409 at
      `src/app/api/research/[id]/run/route.ts:93-99` — the exact idiom DW-296 retired
      on the create route, in the same feature.
    location: >-
      src/app/api/research/[id]/run/route.ts:93
    severity: low
  - summary: >-
      Sibling `/required|invalid/i` status regexes remain on three other routes.
    evidence: |-
      `src/app/api/monitors/route.ts:53`,
      `src/app/api/system/evaluations/route.ts:58` and
      `src/app/api/review/proposals/route.ts:78` each 400 any message matching
      `/required|invalid|.../i`, so a storage `EINVAL` is reported as the caller's
      fault there for the same reason DW-296 named.
    location: >-
      src/app/api/monitors/route.ts:53
    severity: low
  - summary: >-
      A corrupt registry now makes a `run-research` task retry to the DLQ instead of
      poisoning on first delivery, and the task classifier has no row for a store fault.
    evidence: |-
      Before DW-297 a non-list registry made `getResearchProject` return null, so
      `runResearchProject` threw "Research project not found", which
      `src/app/api/tasks/run/route.ts:918` poisons at 422. The new throw matches
      neither `/not found/i` nor `ClientInputError`, so it falls to the 500 at `:932`
      and the queue re-delivers up to `max_retries: 3` before the DLQ. Bounded and
      arguably the correct classification for a repairable server fault, but it is an
      unpinned behaviour change with no test at the task surface.
    location: >-
      src/app/api/tasks/run/route.ts:932
    severity: low
---

<intent-contract>

## Intent

**Problem:** The research project store degrades silently in three places. A registry JSON that parses but is not an array is treated as "no projects" by both `readProjects` (`src/lib/research-projects.ts:171`) and the CAS read (`:220`), so a corrupt registry clears the `MAX_PROJECTS` guard (`:286`) and is then overwritten by the CAS write (`:226-228`); `serializeProjects` (`:194`) still truncates with `slice(-MAX_PROJECTS)`, so a legacy over-cap registry reached through update or delete silently loses its oldest entries; and `POST /api/research`'s `/required|invalid/i` message regex (`src/app/api/research/route.ts:130`) reports genuine server faults (`EINVAL: invalid argument, …`) as 400s the client retries forever.

**Approach:** Parse the registry through one shared helper that throws when the parsed JSON is not an array, so both read sites refuse together and no write path can overwrite a corrupt file. Drop the truncation from `serializeProjects` so a write never destroys stored entries — the create-path cap stays the only enforcement. Convert the three plain validation throws in `research-projects.ts` (`:156`, `:157`, `:393`) to `ClientInputError` and delete the message regex, leaving classification by type alone.

## Boundaries & Constraints

**Always:** Both registry read sites share one parse helper. A non-array registry throws; a missing file still returns `[]` via `isEnoent`; an unparseable file keeps throwing as it does today. The corrupt-registry throw must be a plain `Error` (a server fault → 500), never a `ClientInputError`. Behaviour comments in the touched files must be updated to match the new code — stale rationale is a defect here.

**Block If:** Removing `slice(-MAX_PROJECTS)` would let any create path exceed the cap (it must not — the `projects.length >= MAX_PROJECTS` guard runs before the push).

**Never:** Do not add a `ClientInputError` branch to `src/app/api/research/[id]/route.ts`, do not change `MAX_PROJECTS`, do not touch the sibling `Array.isArray(parsed) ? … : []` degradations in other `src/lib/*.ts` modules, and do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Healthy list | Registry is a JSON array | Projects returned newest-updated first | No error expected |
| Missing registry | No registry file (ENOENT) | `[]`; create writes a fresh file | No error expected |
| Corrupt registry read | Registry JSON is an object/string/number | `listResearchProjects` / `getResearchProject` reject | Plain `Error`, message names the registry as not a list |
| Corrupt registry create | Same, plus a create attempt | Create rejects; stored bytes byte-identical afterwards | Same throw, raised before any write |
| Over-cap legacy registry | `MAX_PROJECTS + 2` stored, one deleted | `MAX_PROJECTS + 1` remain; no oldest entry dropped | No error expected |
| Blank title/question create | `title: "   "` | Create rejects; `POST /api/research` returns 400 | `ClientInputError` |
| Server fault on create | Store throws `Error("EINVAL: invalid argument")` | `POST /api/research` returns 500 | Message passed through unchanged |

</intent-contract>

## Code Map

- `src/lib/research-projects.ts` -- the whole change lives here. `cleanInput` (`:153-166`) holds the two plain throws; `readProjects` (`:168-176`) and `applyResearchProjectMutation` (`:206-232`) hold the two `Array.isArray(parsed) ? … : []` degradations; `serializeProjects` (`:178-195`) holds the `slice` and the doc comment explaining it as a backstop; `mutateProject` (`:392-395`) holds the `"Invalid research status"` throw. `ClientInputError` is already imported at `:1`.
- `src/lib/research-concurrency.ts:94-107` -- reuse pointer: `parseSlots` is the sibling precedent — a non-array lease file throws (`"Research lease file is not a list."`) instead of degrading. Match its shape and message style; do NOT introduce a new exported error class, nothing needs to catch this distinctly.
- `src/app/api/research/route.ts:123-134` -- the POST catch block: delete the regex from the `status` ternary and rewrite the comment above it (it currently says the regex "stays for the validation throws in `cleanInput`").
- `src/app/api/research/[id]/route.ts:77-78, :96-97` -- read-only evidence: PATCH/DELETE classify every throw as 500 and stay unchanged; a `ClientInputError` from `:393` is still a 500 there, which is out of scope.
- `src/lib/research-runtime.ts`, `src/lib/research-completion.ts` -- read-only evidence: heavy `getResearchProject`/`listResearchProjects` consumers. They already propagate the existing `JSON.parse` throw from a malformed registry, so the new non-array throw is the same failure class, not a new one.
- `src/lib/__tests__/research-projects.test.ts` -- store suite (node project). `seedProjects` (`:24-40`) and `registryPath` (`:21-23`) are the reuse points for seeding raw registry bytes; the `create discipline at the cap` block (`:103-176`) is the pattern for "rejects and writes nothing", including the `vi.spyOn(storage, "writeFile")` proof.
- `src/lib/__tests__/research-route.test.ts:143-147` -- `keeps 400ing the validation throws that predate ClientInputError` pins the regex and MUST be replaced; the header comment (`:1-9`) also asserts the regex "still stands".

## Tasks & Acceptance

**Execution:**
- `src/lib/research-projects.ts` -- add a module-private `parseRegistry(raw: string): ResearchProject[]` that `JSON.parse`s and throws a plain `Error` when the result is not an array; call it from both `readProjects` and the CAS read in `applyResearchProjectMutation` -- one helper is what makes the two sites refuse together, which is the whole point (a create that still saw `[]` would overwrite the corrupt file).
- `src/lib/research-projects.ts` -- drop `slice(-MAX_PROJECTS)` from `serializeProjects` and rewrite its doc comment: the create guard is the cap, and a write never evicts -- delete/update must be able to bring a legacy over-cap registry back down instead of silently shedding its oldest rows.
- `src/lib/research-projects.ts` -- change the three plain throws at `cleanInput`'s title/question checks and `mutateProject`'s status check to `ClientInputError` -- these are caller-supplied-input faults and typing them is what lets the route stop string-matching.
- `src/app/api/research/route.ts` -- delete `/required|invalid/i` from the POST catch's status ternary and rewrite the comment to state classification is by type only -- the regex mapped storage `EINVAL` faults to 400.
- `src/lib/__tests__/research-projects.test.ts` -- add rows for the Matrix's corrupt-registry read, corrupt-registry create (bytes unchanged + `writeFile` never called), over-cap delete/update retention, and blank-title `ClientInputError` -- these are the four store behaviours the change turns from silent to honest.
- `src/lib/__tests__/research-route.test.ts` -- replace the regex row with two: a `ClientInputError` from the store is 400, and a plain `Error("EINVAL: invalid argument, open …")` is 500; update the header comment so it no longer claims the regex stands.

**Acceptance Criteria:**
- Given a stored registry whose JSON is an object, when any read, create, update or delete runs for that owner, then it rejects and the stored bytes are unchanged.
- Given a registry holding `MAX_PROJECTS + 2` projects, when one is deleted, then `MAX_PROJECTS + 1` remain and the oldest-inserted entry is still present.
- Given a create whose title is blank, when `POST /api/research` handles it, then the response is 400; given a create that fails with a plain `Error` mentioning "invalid", then the response is 500.
- Given the full suite, when `pnpm test` runs, then it passes with no new failures.

## Review Triage Log

### 2026-08-27 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 2, low 3)
- defer: 7: (high 0, medium 4, low 3)
- reject: 9: (high 0, medium 2, low 7)
- addressed_findings:
  - `[medium]` `[patch]` The `create discipline at the cap` docblock still described the deleted `slice(-MAX_PROJECTS)` truncation in the present tense — rewritten to past tense, now naming the create guard as the only cap.
  - `[medium]` `[patch]` Acceptance criterion 1 covers "any read, create, update or delete" but only read and create were pinned — added rows asserting `updateResearchProject` and `deleteResearchProject` also reject on a non-list registry with the stored bytes unchanged.
  - `[low]` `[patch]` Two docblocks named a nonexistent `writeProjects` and the wrong storage primitive — corrected to `applyResearchProjectMutation` / `writeFileIfAbsent`+`writeFileIfMatch` and to `serializeProjects`.
  - `[low]` `[patch]` The route comment asserted an observed client retry loop the only in-repo caller does not have — restated as the conditional the ledger makes.
  - `[low]` `[patch]` `seedProjects` duplicated `seedRawRegistry`'s mkdir+write — now delegates, one writer in the file.

## Design Notes

The two read sites and the write are one bug, not three: the CAS read is what feeds `mutate`, so refusing only in `readProjects` would still let `createResearchProject` see `[]`, clear the cap guard and replace the file. A shared parse helper makes that drift impossible.

```ts
function parseRegistry(raw: string): ResearchProject[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Research projects file is not a list.");
  }
  return parsed as ResearchProject[];
}
```

ENOENT handling stays at the call sites — a missing registry is still an empty one; only a *present but wrong-shaped* file refuses.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/research-projects.test.ts src/lib/__tests__/research-route.test.ts` -- expected: all rows pass, including the new ones
- `pnpm exec tsc --noEmit` -- expected: no errors
- `pnpm lint` -- expected: no new errors
- `pnpm test` -- expected: full suite green

## Auto Run Result

Status: done

**Summary.** The research project registry now fails honestly at all three sites the bundle named. A registry JSON that parses to anything other than a list is refused by one shared `parseRegistry` helper used by BOTH read sites, so a corrupt file can no longer read as "no projects", clear the `MAX_PROJECTS` guard and be overwritten by the create's CAS write. `serializeProjects` no longer truncates, so an update or delete against a legacy over-cap registry evicts nothing — the create guard is the only cap. The three plain validation throws are `ClientInputError`s and the `/required|invalid/i` message regex is gone, so `POST /api/research` classifies by type alone and a storage `EINVAL` is a 500 rather than a 400.

**Files changed**
- `src/lib/research-projects.ts` — new `parseRegistry` shared by `readProjects` and the CAS read; `slice(-MAX_PROJECTS)` dropped from `serializeProjects`; `cleanInput`'s two throws and `mutateProject`'s status throw retyped `ClientInputError`; three docblocks rewritten to match.
- `src/app/api/research/route.ts` — POST catch classifies on `error instanceof ClientInputError` alone; regex deleted, comment rewritten.
- `src/lib/__tests__/research-projects.test.ts` — corrupt-registry rows for read, create, update and delete (bytes unchanged, no write attempted), over-cap retention through delete and update, blank title/question `ClientInputError`, and a `seedRawRegistry` helper `seedProjects` now delegates to.
- `src/lib/__tests__/research-route.test.ts` — regex row replaced by a 400-on-`ClientInputError` row and a 500-on-`EINVAL: invalid argument` row.

**Review findings** — 5 patched (2 medium, 3 low), 7 deferred (4 medium, 3 low, recorded in frontmatter `deferred`), 9 rejected. No intent gaps and no spec repairs; one review pass, no loopback.

**Follow-up review recommended: true.** Patched severities: high 0, medium 2, low 3 → 3x2 + 1x3 = 9, at or above the threshold of 5.

**Verification**
- `pnpm exec vitest run --project node src/lib/__tests__/research-projects.test.ts src/lib/__tests__/research-route.test.ts` — 42 passed (2 files).
- `pnpm exec tsc --noEmit` — clean, exit 0.
- `pnpm lint` — clean; only three pre-existing `jsx-ast-utils` warnings in unrelated files.
- `pnpm test` — 327 files, 7505 passed / 1 skipped, no failures.
- Non-vacuity: the production changes were temporarily reverted and the suites re-run; the new rows failed, then passed again on restore.
- Matrix audit: every I/O row has at least one covering test that ran and passed.

**Residual risks**
- A corrupt registry now refuses every research operation for that tenant, including the deletes that could shrink the file, and there is no in-product repair path (deferred).
- `parseRegistry` validates the container, not the elements: a list of non-project entries still reaches `listResearchProjects`' sort and throws a TypeError (deferred).
- A `run-research` task against a corrupt registry now retries to the DLQ (`max_retries: 3`) instead of poisoning on first delivery, because the store fault no longer masquerades as "not found" (deferred).
- `mutateProject`'s retyped status throw still lands as a 500 at `PATCH /api/research/[id]`, which the intent placed out of scope.
