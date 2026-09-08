---
title: 'Research store: validate every registry entry, classify input faults at the remaining doors, count only visible rows against the cap'
type: 'bugfix'
created: '2026-08-29'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `parseRegistry`'s bare `JSON.parse` still lets a raw `SyntaxError` escape, unlike
      the `parseSlots` it mirrors.
    evidence: |-
      `research-projects.ts` calls `JSON.parse(raw)` unwrapped, so truncated or non-JSON
      registry bytes surface as `Unexpected token } in JSON at position 41` — the same
      opaque-error-far-from-the-cause shape DW-476 existed to kill. The sibling
      `parseSlots` (`research-concurrency.ts:88-94`) wraps it and throws
      "Research lease file is unreadable." The per-element message was mirrored; this
      first one was not. Pre-existing since DW-297.
    location: >-
      src/lib/research-projects.ts:221
    severity: low
  - summary: >-
      `GET /api/research/[id]/run` has no catch, so a refused registry escapes as a
      framework 500 with no `{ error }` body.
    evidence: |-
      The handler calls `getResearchProject` outside any try block. Since DW-297 that
      call throws on a wrong-shaped registry, and DW-476 widens which registries throw,
      so this door answers a bare framework error rather than the JSON error body every
      sibling door returns. Pre-existing hole opened by DW-297, not by this change.
    location: >-
      src/app/api/research/[id]/run/route.ts:105
    severity: low
  - summary: >-
      `POST /api/research/[id]/run` still classifies by message regex and has no
      `ClientInputError` branch.
    evidence: |-
      The catch decides 404/409/500 with `/not found/i` and `/already running/i` against
      the error message — the exact anti-pattern DW-296 deleted from
      `POST /api/research`, where a storage `EINVAL: invalid argument` was mislabelled as
      the caller's fault. This door is not named by the DW-478 intent, so it was left
      alone; the regex is pre-existing.
    location: >-
      src/app/api/research/[id]/run/route.ts:88
    severity: low
  - summary: >-
      `ClientInputError` is classified by `instanceof` at ~16 route sites, the mechanism
      `read-only.ts` documents as unreliable across a duplicated module graph.
    evidence: |-
      `src/lib/read-only.ts:20-22` states `isReadOnlyError` matches on `err.name` rather
      than `instanceof` "so a duplicated module graph (vitest's two projects, bundler
      chunking, the stdio MCP entry point) cannot turn a route's 403 back into a 500."
      The identical failure mode applies to every `error instanceof ClientInputError`
      site and would degrade silently to 500 in production with no test able to see it.
      A `isClientInputError(err)` helper beside the class in `errors.ts` would close it
      repo-wide. Pre-existing across every such site; this change added four more.
    location: >-
      src/lib/errors.ts:21
    severity: low
  - summary: >-
      `research-completion.ts` dereferences `project.completion.sources` after only a
      phase check, so a wrong-shaped `completion` still dies with an opaque TypeError.
    evidence: |-
      A stored `completion: { phase: "sources" }` with no `sources` array reaches
      `.findIndex(...)` / `.map(...)` and throws the same class of error DW-476 removed
      from the sort. `isResearchProject` deliberately does not validate nested optional
      structures, so the registry guard does not cover this path. Pre-existing.
    location: >-
      src/lib/research-completion.ts:649
    severity: low
  - summary: >-
      The v1 façade answers 4xx with machine tokens everywhere except the new
      `deep_research` 400, which emits an English sentence.
    evidence: |-
      `v1-contract.ts` supplies `unknown_action` / `not_found` / `wiki_not_found`, and the
      route's other 4xx bodies use them, so an agent switch-casing on `error` gets a
      token — except this branch, which passes the store's prose through
      `getErrorMessage`. Nothing in the repo pins a v1 4xx vocabulary and the door's 403
      already emits a sentence, so this is an inconsistency in the façade's error
      contract rather than a broken one. Worth one focused pass over v1 error bodies.
    location: >-
      src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts:167
    severity: low
baseline_revision: '8d6693466c7cf12dc5fa7c36d3f692a437fb56b2'
---

<intent-contract>

## Intent

**Problem:** Three tails DW-296/297/298 left on the research store. (1) DW-476: `parseRegistry` refuses a non-array but validates no element, so `[1,2,3]` or `[{}]` is cast to `ResearchProject[]` and dies later with an opaque `TypeError` in `listResearchProjects`' sort. (2) DW-478: `PATCH`/`DELETE /api/research/[id]` and the v1 `deep_research` action catch-all at 500 with no `ClientInputError` branch, so the `MAX_PROJECTS` refusal and `cleanInput`'s blank-title/question refusal surface as server faults at those doors. (3) DW-479: `createResearchProject` counts `projects.length` including soft-deleted (`deleteRequested`) rows while `filterResearchProjects` hides them, so a tenant with stuck tombstones is refused at the cap while the panel shows fewer than `MAX_PROJECTS`.

**Approach:** Give `parseRegistry` a per-element `isResearchProject` guard mirroring `isSlot`/`parseSlots` in `research-concurrency.ts`. Add the `error instanceof ClientInputError ? 400 : 500` branch that `research/route.ts` already has to the three remaining catch blocks. Count the cap against the same visible set the panel renders, by reusing `filterResearchProjects`.

## Boundaries & Constraints

**Always:**
- A wrong-shaped stored registry is a SERVER fault: the per-element refusal throws a plain `Error`, never a `ClientInputError`, so the doors keep answering 500. Same rule `parseRegistry`'s existing non-array throw already states.
- Both read sites keep refusing together — the guard lives inside the one shared `parseRegistry`, so `readProjects` and the CAS read in `applyResearchProjectMutation` can never disagree.
- A refused registry leaves the stored bytes byte-identical: the throw happens before any mutate or write, exactly as the DW-297 rows already pin.
- The route classification is by TYPE alone (`error instanceof ClientInputError`), never by message matching — the settled idiom at `src/app/api/research/route.ts:137` and `src/app/api/wikis/route.ts:83`.
- The read-only 403 branch stays FIRST in the v1 catch: a `ReadOnlyError` must not be reclassified.
- The cap and the panel read the same visible set. `filterResearchProjects(projects, null)` is that set; the cap counts its length so the two can never drift again.

**Block If:**
- Adding the per-element guard makes any existing suite refuse a registry the app itself wrote (i.e. a status literal or required field this repo emits is rejected). That would mean the guard is stricter than the writer and needs an intent decision, not a quiet loosening.

**Never:**
- Do not add a recovery/repair route for a wedged registry — that is the still-open sibling ledger entry, out of scope here.
- Do not introduce a new exported error class; nothing needs to catch these distinctly.
- Do not change `MAX_PROJECTS`, `serializeProjects` (still writes verbatim, evicts nothing), or the read-only gates.
- Do not make the cap reap or rewrite tombstoned rows; it only stops counting them.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Registry of non-objects | stored bytes `[1,2,3]` | every read/create/update/delete for that owner rejects; stored bytes unchanged | plain `Error`, not `ClientInputError` (500) |
| Registry of wrong-shaped objects | stored bytes `[{}]` or a row missing `updatedAt` | same refusal, before any sort or write | plain `Error` (500) |
| Registry of unknown status | a row whose `status` is `"archived"` | refused — an unrecognized status is not silently treated as "not editable" | plain `Error` (500) |
| Healthy registry | well-formed rows | reads, creates, updates and deletes behave exactly as today | No error expected |
| PATCH hits a store input fault | stored row has a blank `question`, body patches only `title` | `PATCH /api/research/[id]` answers 400 with the store's message | `ClientInputError` → 400 |
| DELETE hits a server fault | `retireResearchProject` throws a storage `Error` | still 500 | plain `Error` → 500 |
| v1 `deep_research` at the cap | tenant already at `MAX_PROJECTS` | `PATCH /api/v1/.../reviews/[reviewId]` answers 400, not 500 | `ClientInputError` → 400 |
| v1 `deep_research` read-only | deployment read-only | 403, unchanged — the read-only branch is checked first | `ReadOnlyError` → 403 |
| Cap with tombstones | `MAX_PROJECTS` rows of which 2 are `deleteRequested` | the create is ACCEPTED and appends | No error expected |
| Cap with no tombstones | `MAX_PROJECTS` visible rows | the create is refused before any write, as today | `ClientInputError` → 400 |

</intent-contract>

## Code Map

- `src/lib/research-projects.ts` -- all three library changes. `parseRegistry` (`:185-191`) is the one shared parse helper called by `readProjects` (`:193-200`) and the CAS read in `applyResearchProjectMutation` (`:264`); its docblock (`:171-184`) already explains why the throw is a plain `Error` and cites `parseSlots` — extend it, do not rewrite that reasoning. `STATUSES` (`:116-118`) is the existing status set to validate against. `filterResearchProjects` (`:290-297`) is the visible-set definition (`!project.deleteRequested`, then optional wiki scope) to reuse for the cap. `createResearchProject`'s cap guard is at `:338-342` (`if (projects.length >= MAX_PROJECTS)`); its docblock (`:307-330`) explains why the cap is checked first and must stay true.
- `src/lib/research-concurrency.ts:77-102` -- reuse pointer and the shape to mirror: `isSlot` type-guards each required field, `parseSlots` calls `parsed.every(isSlot)` and throws its own third message (`"Research lease entry is invalid."`). Match that structure and message family; do NOT copy `ResearchLeaseError` — this module throws plain `Error`.
- `src/app/api/research/[id]/route.ts:77-79` (PATCH catch) and `:96-98` (DELETE catch) -- the two catch-alls to fix. `ClientInputError` is NOT yet imported here; `getErrorMessage` is (`:4`).
- `src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts:156-162` -- the v1 catch. `isReadOnlyError` branch first (`:157-159`), then the 500. `item.title` flows straight into `createResearchProject` at `:140`. `ClientInputError` is not yet imported.
- `src/app/api/research/route.ts:127-139` -- the reference branch to mirror verbatim in shape (`const status = error instanceof ClientInputError ? 400 : 500;`) plus its "classification by TYPE alone" comment.
- `src/lib/__tests__/research-projects.test.ts` -- store suite (node project). `seedRawRegistry` (`:28-32`) writes raw bytes; `seedProjects` (`:34-48`) seeds well-formed rows; `registryPath` (`:21-23`); the `a registry that is not a list` block (`:192-267`) is the exact table-driven pattern the new element rows extend; the `create discipline at the cap` block (`:112-183`) is the pattern (including the `vi.spyOn(storage, "writeFile")` "never wrote" proof) for the tombstone-cap rows.
- `src/lib/__tests__/research-run-route.test.ts:188-293` -- `describe("PATCH and DELETE /api/research/[id]")`. Store already mocked at the library seam (`:20-24`); `mockedUpdate` = `updateResearchProjectIf`, `mockedDelete` = `retireResearchProject`; `patchRequest` helper at `:189-194`. Add the classification rows here.
- `src/lib/__tests__/epic8-v1-routes.test.ts` -- v1 façade suite. `createResearchProject` is mocked at `:76` and bound as `research` at `:126`; the `deep_research` rows at `:515-555` show `getItem`/`research` setup and `patchReview` invocation.
- `src/lib/__tests__/research-route.test.ts:120-170` -- read-only evidence and the recipe the two route suites above follow: a `ClientInputError` is 400, a plain `Error("EINVAL: …")` is 500.
- `src/lib/research-runtime.ts:454-516` -- read-only evidence: `retireResearchProject` is what sets `deleteRequested`; unchanged by this work. Its tail already reaps the row when no worker holds it, so tombstones are transient by design.

## Tasks & Acceptance

**Execution:**
- `src/lib/research-projects.ts` -- add a module-private `isResearchProject(value: unknown): value is ResearchProject` type guard checking the required fields (`id`, `title`, `question`, `createdAt`, `updatedAt` are strings; `queries`, `sourceUrls`, `pageSlugs` are string arrays; `status` is a string in `STATUSES`), and have `parseRegistry` reject with a plain `Error` when any element fails it -- one guard inside the one shared helper is what makes both read sites refuse together, the same reason the non-array check lives there.
- `src/lib/research-projects.ts` -- count the cap against `filterResearchProjects(projects, null).length` instead of `projects.length` in `createResearchProject`, and extend the cap docblock to say why: a `deleteRequested` row is hidden from the panel, so counting it refuses a create the UI says there is room for. Keep the guard's position (before any push or write) unchanged.
- `src/app/api/research/[id]/route.ts` -- import `ClientInputError` and give both the PATCH and DELETE catch blocks the `error instanceof ClientInputError ? 400 : 500` classification, with a short comment pointing at the `research/route.ts` idiom -- a store-side input refusal is the caller's fault at every door, not just the create door.
- `src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts` -- import `ClientInputError` and add a `400` branch to the catch AFTER the existing `isReadOnlyError` 403 branch -- `item.title` and the `MAX_PROJECTS` refusal both reach this catch, and an agent told "500" retries a request that will never succeed.
- `src/lib/__tests__/research-projects.test.ts` -- extend the corrupt-registry block with element rows (`[1,2,3]`, `[{}]`, a row missing `updatedAt`, a row with an unknown `status`) asserting the rejection is not a `ClientInputError` and the stored bytes are unchanged, plus a row proving a well-formed registry still reads; and add cap rows proving a tombstoned row does not count (create succeeds at `MAX_PROJECTS` rows when some are `deleteRequested`) while a fully visible registry still refuses.
- `src/lib/__tests__/research-run-route.test.ts` -- add rows to the `PATCH and DELETE /api/research/[id]` describe: a `ClientInputError` from the store is 400 and a plain `Error` is 500, for both verbs.
- `src/lib/__tests__/epic8-v1-routes.test.ts` -- add rows for `deep_research`: a `ClientInputError` from `createResearchProject` is 400 and a plain `Error` is 500, with the read-only 403 still winning.

**Acceptance Criteria:**
- Given a stored registry that is a list whose elements are not research projects, when any read, create, update or delete runs for that owner, then it rejects with a plain `Error` and the stored bytes are unchanged.
- Given a registry the app itself wrote, when the same operations run, then they behave exactly as before this change — no existing suite starts refusing.
- Given the full suite, when `pnpm test` runs, then it passes with no new failures.

## Spec Change Log

## Review Triage Log

### 2026-08-29 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 2, low 6)
- defer: 6: (high 0, medium 0, low 6)
- reject: 5: (high 0, medium 0, low 5)
- addressed_findings:
  - `[medium]` `[patch]` `serializeProjects`' docblock still asserted the retired invariant ("refuses when `projects.length >= MAX_PROJECTS` … so no create can grow the registry past it"), which the DW-479 change and its own new test directly contradict — rewritten to name the visible-set count and the transient over-cap stored array, with a guard-rail that it must never become eviction pressure.
  - `[medium]` `[patch]` `"Research project entry is invalid."` named neither the index nor the field, and with a repair route deliberately out of scope it is the operator's only handle on a registry that refuses every read and every write — the message now carries the first failing element's index.
  - `[low]` `[patch]` `isResearchProject` did not check `deleteRequested`, the one optional field this same change made load-bearing twice (panel visibility and the cap count); a stored `"false"` would hide a row forever and never count it — now type-checked, with a `badRegistries` row.
  - `[low]` `[patch]` The cap docblock claimed the tombstone residual was "transient" because `retireResearchProject` reaps promptly — it returns `true` with the row still stored on several paths, the follow-up reap only advances while someone is reading, and a `deliveryBlocked` row waits on an operator; softened and the operator-recovery case named.
  - `[low]` `[patch]` `isResearchProject`'s forward-compatibility claim covered extra fields but not a new `status` literal, which wedges the whole registry for an older isolate during a rolling deploy or rollback — the caveat and its two-phase mitigation are now recorded.
  - `[low]` `[patch]` `parseRegistry`'s docblock did not record why ONE bad element refuses the WHOLE registry — the change's largest blast-radius decision — so the `parseSlots` fail-closed discipline and the data-loss cost of row-skipping are now stated.
  - `[low]` `[patch]` The new `deep_research` block left `research.mockRejectedValue` in place past its own tests (the file-global `vi.clearAllMocks()` clears calls, not implementations), a trap for the next row added below it — reset in the block's own teardown.
  - `[low]` `[patch]` Only the corrupt-registry READ rows pinned `not.toBeInstanceOf(ClientInputError)`, so nothing caught a refactor that retypes the parse throw and flips create/update/delete from 500 to 400 — the assertion now covers those rows too.

## Design Notes

The element guard mirrors `parseSlots`, including the third message:

```ts
function isResearchProject(value: unknown): value is ResearchProject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  const isStrings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === "string");
  return typeof p.id === "string" && typeof p.title === "string"
    && typeof p.question === "string" && typeof p.createdAt === "string"
    && typeof p.updatedAt === "string"
    && isStrings(p.queries) && isStrings(p.sourceUrls) && isStrings(p.pageSlugs)
    && typeof p.status === "string" && STATUSES.has(p.status as ResearchProjectStatus);
}
```

Why the cap reuses `filterResearchProjects` rather than inlining `!p.deleteRequested`: the bug IS the two definitions of "visible" having drifted. One caller of one helper is the only shape that keeps them from drifting again. Passing `null` as the scope is deliberate — the cap is per tenant, across every Wiki.

The residual this accepts, named: a tenant whose tombstones never get reaped can hold more than `MAX_PROJECTS` stored rows. That is the correct trade — `retireResearchProject` reaps the row as soon as no worker holds it, so a tombstone is transient, whereas refusing a create the panel says there is room for is a dead end the owner cannot clear.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/research-projects.test.ts src/lib/__tests__/research-run-route.test.ts src/lib/__tests__/epic8-v1-routes.test.ts src/lib/__tests__/research-route.test.ts` -- expected: all rows pass, including the new ones
- `pnpm exec tsc --noEmit` -- expected: no errors
- `pnpm lint` -- expected: no new errors
- `pnpm test` -- expected: full suite green, no newly refused registry in any research suite

## Auto Run Result

Status: done

**Summary.** The three tails DW-296/297/298 left on the research project store are closed. `parseRegistry` now validates every ELEMENT, not just the list: a per-element `isResearchProject` guard mirroring `isSlot`/`parseSlots` refuses `[1,2,3]`, `[{}]`, a row missing `updatedAt`, an unknown `status` literal and a non-boolean `deleteRequested` with a plain `Error` naming the failing index — so a wrong-shaped registry can no longer be cast to `ResearchProject[]` and die far away in `listResearchProjects`' sort as an opaque `TypeError`. The guard lives in the one shared helper, so `readProjects` and the CAS read in `applyResearchProjectMutation` refuse together, before any mutate or write, leaving the stored bytes byte-identical. `PATCH`/`DELETE /api/research/[id]` and the v1 `deep_research` action now classify `ClientInputError` as 400 by TYPE alone, the idiom `POST /api/research` already had, with the v1 read-only 403 kept ahead of the new branch. And the create cap counts `filterResearchProjects(projects, null).length` instead of `projects.length`, so a tenant holding soft-deleted tombstones is no longer refused at a cap the panel says has room — the cap and the panel now read the one definition of "visible".

**Files changed**
- `src/lib/research-projects.ts` — new module-private `isResearchProject` guard; `parseRegistry` refuses any invalid element and names its index; `createResearchProject`'s cap counts the visible set; four docblocks extended (fail-closed rationale, the rolling-deploy `status`-literal caveat, the cap's visible-set reasoning and its named residual, and `serializeProjects`' retired invariant rewritten).
- `src/app/api/research/[id]/route.ts` — `ClientInputError` imported; both the PATCH and DELETE catches classify 400/500 by type.
- `src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts` — same branch added after the existing `isReadOnlyError` 403, with the ordering pinned by comment.
- `src/lib/__tests__/research-projects.test.ts` — `seedRow` helper and a `{ tombstoned }` option on `seedProjects`; a `badRegistries` table driving read, create, update and delete refusals (type asserted, write spies never called, bytes byte-identical); a positive row proving every status and optional field the app writes still parses; two cap rows (a tombstone does not count and is not reaped; an all-visible registry still refuses).
- `src/lib/__tests__/research-run-route.test.ts` — table-driven 400/500 classification rows for both PATCH and DELETE.
- `src/lib/__tests__/epic8-v1-routes.test.ts` — `deep_research` 400/500 rows plus a `ReadOnlyError` → 403 row proving the read-only branch still wins, with mock teardown so the rejecting implementation does not leak.

**Review findings breakdown**
- Patches applied: 8 (high 0, medium 2, low 6) — see the Review Triage Log entry above.
- Items deferred: 6 (all low) — the unwrapped `JSON.parse` in `parseRegistry`, the uncaught `GET /api/research/[id]/run`, the message-regex classification in `POST .../run`, the `instanceof` vs `err.name` question for `ClientInputError` repo-wide, the unguarded `completion.sources` dereference in `research-completion.ts`, and the v1 façade's mixed 4xx body vocabulary.
- Items rejected: 5 — adding a 403 branch to the `/api/research/[id]` catches (the mirror target named by the intent has none, and the door gates `isReadOnly()` ahead of the try, so there is no observable defect); the wiki-scope nuance in the cap docblock (already stated there); the `oversized` warning and empty bookkeeping sections (workflow-expected); the "identical classification table appears three times" duplication complaint (the tables pin three different doors); and the observation that two of the three new 400 branches are defensive uniformity (the intent asks for parity at all three named doors explicitly).
- Follow-up review recommended: **true**. Patched severities: high 0, medium 2, low 6 → score `3 × 2 + 1 × 6 = 12`, which is ≥ 5.

**Verification performed**
- `pnpm exec vitest run --project node src/lib/__tests__/research-projects.test.ts src/lib/__tests__/research-run-route.test.ts src/lib/__tests__/epic8-v1-routes.test.ts src/lib/__tests__/research-route.test.ts` — **124 passed**, 4 files.
- `pnpm exec tsc --noEmit` — clean, exit 0.
- `pnpm lint` — no errors; only the three pre-existing `jsx-ast-utils` `TSNonNullExpression` notices.
- `pnpm test` — **7663 passed, 229 failed, 1 skipped**. Every failure is in the 13 `src/components/workbench/__tests__/*.tsx` dom-project suites, all dying at `window.localStorage.clear()` with `TypeError: Cannot read properties of undefined (reading 'clear')`. Confirmed PRE-EXISTING and unrelated: stashing the whole change and re-running `workbench-split-wiring.test.tsx` at `8d6693466c7cf12dc5fa7c36d3f692a437fb56b2` fails identically (29/29). The spec's Verification line expects "full suite green", which this branch is not; its Acceptance Criterion — "passes with no new failures" — is met.
- Matrix test audit: all ten I/O matrix rows are covered by tests that ran and passed in the runs above.
- The spec's Block-If did not trigger: the adjacent store-driving suites (`research-runtime`, `research-completion`, `research-completion-lifecycle`, `read-only-store-gate`, `portable-archive`) pass, so no registry the app itself writes is refused by the new guard.

**Residual risks**
- The dom-project `localStorage` breakage is a real red on this branch, unrelated to this work and left untouched.
- The guard is fail-closed for the whole tenant: one malformed row now 500s every research door for that owner, including the panel, and the recovery/repair route for a wedged registry is explicitly out of scope here — it remains an open sibling ledger entry. The refusal now names the failing index, which is the only handle an operator has until that route exists.
- Requiring `STATUSES` membership means a newer deploy writing a status literal an older isolate does not know wedges that isolate's reads. Adding a status is therefore a two-phase change: teach the readers first, then write it. The trade and its mitigation are recorded in `isResearchProject`'s docblock.
- A registry restored from a portable archive produced by a build predating `queries`/`sourceUrls`/`pageSlugs` would now be refused rather than silently misread. That is the intended "refuse, don't misread" behaviour, but it has no repair path today (same open sibling entry).
- A tenant whose tombstones are never reaped can hold more than `MAX_PROJECTS` stored rows. Named in the cap docblock; nothing here reaps or rewrites a tombstone, the cap only stops counting it.
