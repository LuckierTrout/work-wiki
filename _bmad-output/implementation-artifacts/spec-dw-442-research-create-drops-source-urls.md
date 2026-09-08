---
title: 'DW-442: research creation stops accepting sourceUrls'
type: 'refactor'
created: '2026-08-29'
status: 'done'
baseline_revision: '0349df96eea85b82adc933ac2c0845bb92d9c4ad'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: []
deferred:
  - summary: >-
      `cleanUrls`' 40-item and 2000-character caps and its dedupe are untested on
      what is now the only write path for a project's source URLs.
    evidence: |-
      Since DW-442 the run's patch is the sole writer of `project.sourceUrls`
      (`research-runtime.ts:1559` -> `updateResearchProject`). The store tests
      cover only the `javascript:` protocol filter. A run whose provider returns
      more than 40 unique results silently stores 40, and the Studio's
      "Collect N URLs" then ingests 40 of them with nothing saying so. The cap
      predates this change; only its exposure is new.
    location: >-
      src/lib/research-projects.ts:140
    severity: low
---

<intent-contract>

## Intent

**Problem:** Research creation still accepts a caller-supplied `sourceUrls` list — the Knowledge Studio form collects it, `POST /api/research` validates and forwards it, and `createResearchProject` stores it — but the first automated run overwrites `project.sourceUrls` with the provider's own results (`research-runtime.ts:1559`). The field is collected, stored, then silently discarded.

**Approach:** Drop `sourceUrls` from the creation path only: remove it from `ResearchProjectInput`, from the create route's forwarded body, and from the Studio form. The stored `ResearchProject.sourceUrls` field stays — it is the run's own output — so it moves to the update patch type, whose only writer is the run. A create body that still carries `sourceUrls` is refused with an explicit 400 rather than quietly ignored, so a caller who expects seeds learns the field is gone.

## Boundaries & Constraints

**Always:** `ResearchProject.sourceUrls` remains a required `string[]` on every stored row — `createResearchProject` writes `[]` — so the `isResearchProject` registry guard (`research-projects.ts:210`) keeps accepting rows it accepts today. `updateResearchProject` must still apply a `sourceUrls` patch, and must apply it whether or not the same patch also changes `title`/`question`, because the run patches results and URLs together.

**Block If:** A stored-row migration would be needed (it is not: existing rows keep their `sourceUrls`).

**Never:** Do not touch the unrelated `sourceUrls` on graph/retrieval types (`graph-relevance.ts`, `graph-build.ts`, `wiki-retrieve.ts`, `query-search.ts`) — same name, different concept (a page's cited sources). Do not remove the Studio's **Collect N URLs** button or `collect()`; it pushes a completed run's collected URLs into ingest and stays. Do not change how a run collects or overwrites URLs. Do not edit `_bmad-output/implementation-artifacts/deferred-work.md` or the historical `spec-6-1-through-6-5-deep-research.md` record.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Ordinary create | `POST /api/research` with `title`, `question`, `queries` | 201, project stored with `sourceUrls: []` | No error expected |
| Legacy create | Same body plus `sourceUrls: ["https://example.com/report"]` | 400 `sourceUrls is no longer accepted — an automated run collects its own sources.`, store never called | Explicit refusal, not a silent drop |
| Legacy create, empty list | Body plus `sourceUrls: []` | 400, same message | Field presence is what is refused, not its contents |
| Read-only deployment | Body carrying `sourceUrls` on `YOPEDIA_READONLY=1` | 403 read-only refusal (unchanged ordering: read-only wins over body checks) | No error expected |
| Run collects sources | Run patches `{ results, sourceUrls }` | `project.sourceUrls` becomes the provider URLs | No error expected |
| Run patches title and URLs together | Patch carries `title` and `sourceUrls` | Both land; the title branch does not drop the URL patch | No error expected |

</intent-contract>

## Code Map

- `src/lib/research-projects.ts:106-113` -- `ResearchProjectInput`; delete its `sourceUrls?: readonly string[]` line. `ResearchProject.sourceUrls` at line 33 stays untouched.
- `src/lib/research-projects.ts:154-170` -- `cleanInput`; drop the `sourceUrls: cleanUrls(input.sourceUrls)` line. It must not return the key at all: `mutateProject` `Object.assign`s its result onto a live project, so returning `[]` here would wipe a run's collected URLs on any title edit.
- `src/lib/research-projects.ts:423-451` -- `createResearchProject`; the project literal spreads `cleaned`, so add an explicit `sourceUrls: []` (before the spread is fine — no key collides now).
- `src/lib/research-projects.ts:455-475` -- `updateResearchProject`'s patch type is `Partial<ResearchProjectInput> & {…}`; add `sourceUrls?: readonly string[];` to the intersection object so the run's patch still type-checks.
- `src/lib/research-projects.ts:517-536` -- `mutateProject`; the `title`/`question` branch currently folds `sourceUrls` through `cleanInput`, the `else` branch handles it directly. Lift `if (patch.sourceUrls !== undefined) project.sourceUrls = cleanUrls(patch.sourceUrls);` out of the `else` so it runs after both branches. `cleanUrls` stays in use.
- `src/app/api/research/route.ts:99-101` -- shape-check loop over `["queries", "sourceUrls", "pageSlugs"]`; narrow it to `["queries", "pageSlugs"]` and add the explicit refusal for a present `sourceUrls`, placed after the `title`/`question` check and before the queries check.
- `src/app/api/research/route.ts:115-121` -- `createResearchProject` call; drop the `sourceUrls: body.sourceUrls as string[] | undefined` line.
- `src/components/KnowledgeStudio.tsx:717` -- `const [sourceUrls, setSourceUrls] = useState("")`; delete the state.
- `src/components/KnowledgeStudio.tsx:756-763` -- `createProject`; drop `sourceUrls: parseLines(sourceUrls)` from the POST body and the `setSourceUrls("")` reset.
- `src/components/KnowledgeStudio.tsx:867` -- the `Source URLs · one per line` `<label>`/`<textarea>`; delete the whole label. No test asserts this field.
- `src/components/KnowledgeStudio.tsx:772-779` -- `collect()`'s "Add at least one source URL to this brief before collecting." nudge; nothing can add one any more, so it must name the run instead. The read-only early return above it stays first.
- `src/lib/__tests__/research-projects.test.ts:89-100` -- "persists a source plan and synthesis per owner" passes `sourceUrls` on create and asserts the `javascript:` filter; it is the one store test that must change.
- `src/lib/__tests__/research-route.test.ts` -- route handler with a mocked store (`request(body)` helper, `BODY` fixture, `mockedCreate`); the home for the refusal test.
- `src/lib/research-runtime.ts:1557-1561` -- `updateResearchAttempt({ results, sourceUrls })`, the only writer of the field. Read-only reference; do not change.
- `src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts:141` and `src/components/workbench/{ResearchCanvas,ReviewCanvas,GraphCanvas}.tsx` and `KnowledgeStudio.tsx:623` -- the other create callers. Verified: none sends `sourceUrls`, so none is affected.

## Tasks & Acceptance

**Execution:**
- `src/lib/research-projects.ts` -- remove `sourceUrls` from `ResearchProjectInput` and `cleanInput`; write `sourceUrls: []` in `createResearchProject`; add `sourceUrls?: readonly string[]` to the `updateResearchProject` patch type; lift the `sourceUrls` patch line in `mutateProject` so it applies in both branches -- creation stops accepting the field while the run keeps writing it.
- `src/app/api/research/route.ts` -- drop `sourceUrls` from the array shape-check loop and from the `createResearchProject` call; 400 with `sourceUrls is no longer accepted — an automated run collects its own sources.` when `body.sourceUrls !== undefined` -- the refusal is what makes the removal explicit instead of silent.
- `src/components/KnowledgeStudio.tsx` -- delete the `sourceUrls` state, the form field and the POST body entry; retarget `collect()`'s empty-list nudge at running the research -- the form stops collecting a value nothing reads.
- `src/lib/__tests__/research-route.test.ts` -- add tests for the I/O matrix rows: legacy body 400s with the message and `createResearchProject` is never called, an empty `sourceUrls: []` 400s the same way, the ordinary body still 201s, and a read-only deployment still 403s a body carrying the field.
- `src/lib/__tests__/research-projects.test.ts` -- update the create test to stop passing `sourceUrls` and assert a created project has `sourceUrls: []`; add a test that a run-style patch of `{ sourceUrls }` lands, and one that a patch carrying `title` **and** `sourceUrls` lands both.

**Acceptance Criteria:**
- Given the Knowledge Studio research desk on a writable deployment, when the owner opens the create form, then no Source URLs field is rendered and the submitted body has no `sourceUrls` key.
- Given a brief with no collected sources, when the owner clicks **Collect 0 URLs**, then the feedback names running the research as the way to get sources, not adding a URL.
- Given a project whose run has collected provider URLs, when the desk renders it, then the **Collect N URLs** button and its ingest behaviour are unchanged.
- Given `pnpm test` and `pnpm lint`, when they run, then both pass with no `sourceUrls`-related type or lint error anywhere in the repo.

## Spec Change Log

## Design Notes

Why refuse rather than ignore: the intent allows either, and a 400 is the one that cannot be mistaken for the old behaviour. A caller sending seeds today gets a 201 and a project that discards them — exactly DW-442. Ignoring the field would keep that shape; refusing tells them.

Why `cleanInput` must lose the key rather than return `[]`:

```ts
// mutateProject, title/question branch
const cleaned = cleanInput({ title: …, question: …, queries: …, pageSlugs: … });
Object.assign(project, cleaned);           // no sourceUrls key -> collected URLs survive
// after BOTH branches, so a title edit carrying URLs still lands them:
if (patch.sourceUrls !== undefined) project.sourceUrls = cleanUrls(patch.sourceUrls);
```

`cleanUrls` keeps its `http`/`https`-only filter and its 40×2000 cap; it is now reached only through the patch path, which is the run.

The historical `deferred:` note in `spec-6-1-through-6-5-deep-research.md` and the DW-442 ledger entry are left as written — the orchestrator records resolution.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/research-route.test.ts src/lib/__tests__/research-projects.test.ts src/lib/__tests__/research-runtime.test.ts src/components/__tests__/studio-research-read-only.test.tsx` -- expected: all pass
- `pnpm test` -- expected: no new failures versus the pre-change baseline
- `pnpm lint` -- expected: clean
- `npx tsc --noEmit` -- expected: no errors (catches any remaining `sourceUrls` input-site)
- `grep -rn "sourceUrls" src/app/api/research/route.ts src/components/KnowledgeStudio.tsx` -- expected: no match in the create form or the create body; matches remain only where a stored project's URLs are read (the Collect button, the signals row)

## Auto Run Result

Status: done

**Change.** DW-442: research creation no longer accepts a caller-supplied `sourceUrls` list. The field is gone from `ResearchProjectInput`, from `POST /api/research`'s forwarded body, and from the Knowledge Studio create form. A create body that still carries the key — empty list included — is refused with an explicit 400 rather than stored and silently overwritten by the first automated run. The stored `ResearchProject.sourceUrls` is unchanged in shape and is now written only by the run, through `updateResearchProject`'s patch.

**Files changed**
- `src/lib/research-projects.ts` — `sourceUrls` off `ResearchProjectInput` and out of `cleanInput` (the key must be absent, not `[]`, because `mutateProject` `Object.assign`s that result onto a live project); `createResearchProject` writes `sourceUrls: []`; the field moves onto the update patch type; the `cleanUrls` patch line lifted out of the `else` so a `title` + `sourceUrls` patch lands both.
- `src/app/api/research/route.ts` — explicit 400 on a present `sourceUrls`, ordered after the read-only 403 and the title/question check; field dropped from the shape-check loop and the store call.
- `src/components/KnowledgeStudio.tsx` — Source URLs state, field and body entry deleted; collect nudge retargeted at the run and exported as `RESEARCH_COLLECT_EMPTY_COPY`; provider-less and evidence-signal copy corrected.
- `src/lib/__tests__/research-route.test.ts` — refusal for a seed list and for `[]`, a 201 control asserting no `sourceUrls` key is forwarded, and a read-only 403 on a body carrying the field.
- `src/lib/__tests__/research-projects.test.ts` — create stores `[]`; a run-style patch lands; a `title` + `sourceUrls` patch lands both; a title-only edit preserves collected URLs.
- `src/components/__tests__/studio-research-read-only.test.tsx` — writable-deployment coverage for the two UI acceptance criteria.

**Review findings:** 7 patches applied (2 medium, 5 low), 1 deferred (low — `cleanUrls` caps untested on the now-sole write path), 11 rejected.

**Follow-up review recommended:** true. Patched severities: high 0, medium 2, low 5; score = 3×2 + 1×5 = 11 (threshold 5).

**Verification**
- `npx vitest run src/lib/__tests__/research-route.test.ts src/lib/__tests__/research-projects.test.ts src/lib/__tests__/research-runtime.test.ts src/components/__tests__/studio-research-read-only.test.tsx` — 177 passed, 1 skipped, 0 failed.
- `npx vitest run` (full) — 7756 passed, 233 failed. The 233 are pre-existing: a clean `git stash` baseline run on the same machine gave 233 failed / 7747 passed, all in `src/components/workbench/__tests__/*` dying at `window.localStorage.clear()`. This change adds 9 passing tests and no failures.
- `npx tsc --noEmit` — exit 0. `npx eslint` — exit 0.
- `grep -rn "sourceUrls" src/app/api/research/route.ts src/components/KnowledgeStudio.tsx` — no match in the create form or create body; remaining matches are the refusal, comments, and the three read sites of a stored project's URLs.
- Every I/O matrix row is covered by a test that ran and passed; the two UI criteria were mutation-checked against the restored old behaviour.

**Residual risks**
- A browser still running the pre-deploy bundle posts `sourceUrls: []` and now meets the 400 on every create until it reloads. The refusal is loud and self-clearing; the intent-contract pins presence, not contents, as what is refused.
- Briefs created before this change may still hold owner-typed seed URLs. The first run overwrites them, as it always did — the human decision (Drop the field) accepts that rather than honouring seeds.
- A deployment with no research provider configured now has no way at all to put URLs on a brief. That is the intended consequence of dropping the field; the desk's copy was corrected to stop advertising the removed manual path.
