---
title: 'Read-only refusal parity: kernel gates, route classification, one-owner settings copy, widened door registry'
type: 'bugfix'
created: '2026-08-27'
status: 'in-review'
baseline_revision: '0ec6468a09da86eecbc4b7e19350243a36960046'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Read-only mode is half-finished. Three stores (`research-projects.ts`, `names-terms.ts`, `email-ingest.ts`) carry no `assertWritable`, so a CLI/MCP/agent-runtime caller writes them on a read-only deployment; five wiki-lifecycle handlers classify a `ReadOnlyError` as 500 instead of 403; `/settings` states three unowned read-only sentences for one deployment state; three surfaces compose a write in front of a door that now 403s with no affordance; and `read-only-door-coverage.test.ts` registers only four kernel writers, so ~30 gated exports are invisible to the scan that guards tomorrow's doors.

**Approach:** Widen the door registry first (it re-derives the route map), then close each gap in the order the registry surfaces: kernel `assertWritable` on the three stores, `isReadOnlyError → 403` on every gate-only route that now reaches a gated kernel, one `READ_ONLY_REFUSAL` owner for the settings sentences with client mirrors pinned by the parity suite, read-only affordances on the three unmirrored surfaces, and a DEPLOY.md note that `POST /api/tasks/scan` 403s on every cron pass.

## Boundaries & Constraints

**Always:**
- Every sentence in `READ_ONLY_REFUSAL` satisfies the parity suite's existing rules: starts capitalised, ends `.`, and contains the exact substring `while this deployment is read-only.`
- Every client refusal constant is either CHARACTER-IDENTICAL to the server sentence it mirrors, or recorded in `read-only-copy-parity.test.ts` as a deliberate divergence with the reason asserted (the `REVERT_READ_ONLY_COPY` idiom).
- A route keeps its early `isReadOnly()` gate; the `isReadOnlyError` branch is ADDED beside it, never instead of it.
- Client components learn read-only from a server-served flag, never from `isReadOnly()` — `@/lib/read-only` imports `./config` and must not enter a browser bundle.
- Standing refusals use `aria-disabled` + a handler early-return, never `disabled` (which is reserved for transient state) and never `<fieldset disabled>`.
- Test-file extension picks the project: mounted suites are `*.test.tsx`, source scans and string comparisons are `*.test.ts`.

**Block If:**
- The widened registry surfaces a route reaching a gated kernel with NEITHER treatment and adding one would change that route's response contract (not merely its status code for an unreachable branch).
- Gating a store export makes an existing suite fail in a way that shows a live read path writes on a read-only deployment (i.e. the gate exposes a real behavioural dependency rather than a dead branch).

**Never:**
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.
- Do not gate the research CAS primitives `applyResearchProjectMutation`, `updateResearchProjectIf`, `mutateResearchProject` — they are an in-flight run's own progress recorders, reached only from `research-runtime`/`research-completion` behind doors that already refuse, and `GET /api/research` already skips reconciliation entirely when read-only.
- Do not add read-only affordances to `KnowledgeStudio`'s non-research panels (vaults, skills, portability, connections) — out of bundle scope.
- Do not rename `YOPEDIA_READONLY` (frozen identifier) or edit `llm-wiki.md`.
- No new e2e specs; no changes to `.github/` or `.yoyo/yoyo.toml`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Direct library write, read-only | `YOPEDIA_READONLY=1`, call `createResearchProject` / `createNamesTerm` / `updateNamesTerm` / `deleteNamesTerm` / `saveEmailIngestConfig` / `updateResearchProject` / `deleteResearchProject` | Throws `ReadOnlyError` with the matching `READ_ONLY_REFUSAL` sentence; nothing is written | Error name is `ReadOnlyError` so `isReadOnlyError` matches across module copies |
| Direct library write, writable | `YOPEDIA_READONLY` unset | Writes as before, unchanged | No error expected |
| Wiki-lifecycle flip race | Flag flips between a wiki route's `isReadOnly()` gate and the kernel call | 403 with the kernel sentence, not 500 | `isReadOnlyError(error)` branch in the catch, ordered before the `ClientInputError` 400 fallback |
| Settings door, read-only | `PUT /api/settings`, `PUT /api/workspace-profile` | 403 `READ_ONLY_REFUSAL.settingsWrite` | Same sentence from both doors — one deployment state, one sentence |
| Rebuild embeddings, read-only | `POST /api/settings/rebuild-embeddings` | 403 `READ_ONLY_REFUSAL.embeddingRebuild` | — |
| Names & Terms surface, read-only | `/settings` served `readOnly: true`, owner presses Save or Remove | No request is made; the panel's own read-only sentence is on screen and `aria-describedby` resolves to it | Handler early-returns; controls are `aria-disabled`, still focusable |
| Research panel, read-only | `GET /api/research` serves `readOnly: true` | Create / Run / Cancel / Delete / Collect refuse before fetch; the matching sentence is rendered | Handler early-returns |
| Door-coverage scan | A `src/lib/*.ts` export gains `assertWritable` and is not in `KERNEL_WRITERS` | The suite fails naming that export | Derivation case, not a hand list |

</intent-contract>

## Code Map

- `src/lib/read-only.ts:94-238` -- `READ_ONLY_REFUSAL`, the one owner. Add `settingsWrite` and `embeddingRebuild`. Module docstring at :24-69 states the client-boundary and wiki-literal decisions and must be amended, not contradicted.
- `src/lib/__tests__/read-only-door-coverage.test.ts:36-111` -- `KERNEL_WRITERS` (4 names), `WRITER_EXPORTS` (17 modules), `WRITER_MODULES` (10). The `it("names every writer-reaching export")` case at :177 re-derives from `KERNEL_WRITERS` × `WRITER_MODULES` using top-level `function` spans; the `it("the four kernel writers still call assertWritable")` case at :224 is the floor.
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- the seam. `routeSource`/`servedAs` helpers at :52-69; the "Settings are read-only in this deployment." literal appears twice (:144, :186) and must become `READ_ONLY_REFUSAL.settingsWrite`; `WIKI_READ_ONLY_COPY` has no case at all (DW-302).
- `src/lib/workbench-tree.ts:133` -- `WIKI_READ_ONLY_COPY`, the switcher's four-verb sentence (create/switch/rename/delete). Rendered at `src/components/workbench/WikiSwitcher.tsx:455`; the dimmed Rename button at :470-482 and Delete at :483-505 point at it via `aria-describedby`, which IS `wikiRename`'s client counterpart (DW-318's second half).
- `src/lib/workbench-settings.ts:217-219` -- `SETTINGS_READ_ONLY_COPY` = "Settings are read-only in this deployment.", the Workbench canvas's client sentence, unpinned. Reword to mirror `settingsWrite`; ~15 DOM tests reference the CONSTANT, none the literal (verified by grep), so rewording is safe.
- `src/app/api/wikis/route.ts:56-59`, `src/app/api/wikis/[id]/route.ts:43-46` and `:75-78`, `src/app/api/wikis/[id]/template/route.ts:46-49`, `src/app/api/wikis/current/route.ts:43-46` -- the five `ClientInputError ? 400 : 500` catches (DW-316).
- `src/app/api/settings/route.ts:152-157`, `src/app/api/settings/rebuild-embeddings/route.ts:14-19`, `src/app/api/workspace-profile/route.ts:90-95` -- the three inline settings literals (DW-387; workspace-profile is the fourth copy of the same sentence).
- `src/app/settings/page.tsx:147-155` -- the read-only banner; `readOnly`/`describedBy` at :60-61 are already threaded to `ProviderForm`, `StructuredKnowledgeSettings`, `EmbeddingSettings` at :182/:196/:217. `NamesTermsSettings` and `EmailIngestSettings` are rendered prop-less at :283-284.
- `src/lib/research-projects.ts:280`, `:304`, `:477` -- `createResearchProject`, `updateResearchProject`, `deleteResearchProject`. `GET /api/research` already skips `reconcileResearchProjects` when read-only (`src/app/api/research/route.ts:41-49`), so gating these strands no read path.
- `src/lib/names-terms.ts:284/:308/:330`, `src/lib/email-ingest.ts:106` -- the other four ungated writers. Only their routes call them (verified).
- `src/components/NamesTermsSettings.tsx` -- `save()` at :103, `remove()` at :144 (a `window.confirm` in front of the 403), submit button at ~:308, Edit/Remove at ~:386-397. No `readOnly` anywhere.
- `src/components/EmailIngestSettings.tsx` -- `save()` at :71, submit at :279-285. No `readOnly`.
- `src/components/KnowledgeStudio.tsx` -- `refresh()` reads `/api/research` at :150; `InsightsPanel.research()` at :524; `ResearchPanel` create/collect/run/cancel/remove at :615-700 and its button row at :733-736.
- `src/components/WorkspacePurposeSettings.tsx:17-31, 936-943` -- the affordance pattern to follow (exported constant, `useId` note, `aria-describedby`, handler early-return).
- `DEPLOY.md:219-230` -- the only read-only prose; it documents Workbench settings affordances and never mentions the scan. `YOPEDIA_READONLY` is absent from the Additional Settings table at :51-59.
- `AGENTS.md` "Test environments" -- `pnpm test` is one `vitest run` over a `node` (`*.test.ts`) and a `dom` (`*.test.tsx`) project; the extension picks it.

## Tasks & Acceptance

**Execution:**
1. `src/lib/__tests__/read-only-door-coverage.test.ts` -- widen `KERNEL_WRITERS` to every `src/lib` export that carries `assertWritable` (~30 names, enumerated by the derivation case below); widen `WRITER_EXPORTS` with `@/lib/wikis`, `@/lib/workspace-profile`, `@/lib/workspace-profile-backfill`, `@/lib/todos`, `@/lib/source-meeting`, `@/lib/graph-insight-dismissals`, `@/lib/research-projects`, `@/lib/research-runtime`, `@/lib/names-terms`, `@/lib/email-ingest`, plus the newly surfaced `@/lib/lifecycle:pruneStaleIndexEntry,deleteWikiPageWhileLocked`, `@/lib/lint-fix:fixStaleIndex`, `@/lib/review-queue:skipReviewItem,reopenReviewItem,enqueueReviewFromAnalysis,enqueueReviewAfterIngest,drainReviewOutbox`; widen `WRITER_MODULES` to match; ADD a derivation case that re-derives `KERNEL_WRITERS` from every `src/lib/*.ts` exported function whose body calls `assertWritable(`, so the registry cannot go stale; generalise the floor case from "the four kernel writers" to every registered writer -- this is the scan that guards tomorrow's doors, and it must be widened first because it re-derives the route map.
2. `src/lib/read-only.ts` -- add `settingsWrite: "Settings cannot be changed while this deployment is read-only."` and `embeddingRebuild: "Embeddings cannot be rebuilt while this deployment is read-only."`; amend the module docstring to record the settings one-owner decision and that the wiki routes now CLASSIFY as well as gate -- one deployment state must not have three sentences.
3. `src/lib/research-projects.ts`, `src/lib/names-terms.ts`, `src/lib/email-ingest.ts` -- open `createResearchProject`/`updateResearchProject`/`deleteResearchProject` with `assertWritable(READ_ONLY_REFUSAL.researchCreate | .researchMutate)` and the three Names & Terms writers and `saveEmailIngestConfig` with their sentences; comment why the CAS primitives are deliberately left open -- a route gate is not enough when a CLI, MCP or agent-runtime caller reaches the store with no route in front.
4. `src/app/api/wikis/route.ts`, `src/app/api/wikis/[id]/route.ts`, `src/app/api/wikis/[id]/template/route.ts`, `src/app/api/wikis/current/route.ts` -- add an `isReadOnlyError(error) → 403` branch ahead of the `ClientInputError` 400 in all five handlers -- a refusal reported as a server fault is the defect.
5. `src/app/api/research/route.ts`, `src/app/api/names-terms/route.ts`, `src/app/api/names-terms/[id]/route.ts`, `src/app/api/email/settings/route.ts`, `src/app/api/workspace-profile/route.ts` -- same branch beside the existing gate, since task 3 makes their kernels throw (names-terms' catches answer 400 today, which is worse than 500).
6. `src/app/api/settings/route.ts`, `src/app/api/settings/rebuild-embeddings/route.ts`, `src/app/api/workspace-profile/route.ts` -- serve `READ_ONLY_REFUSAL.settingsWrite` / `.embeddingRebuild` instead of the three inline literals.
7. `src/lib/workbench-settings.ts` -- reword `SETTINGS_READ_ONLY_COPY` to mirror `settingsWrite` character-for-character and say in its docstring that the parity suite pins it.
8. `src/app/settings/page.tsx` -- render `SETTINGS_READ_ONLY_COPY` inside the banner (keeping the `<strong>Read-only mode</strong> — ` label so existing assertions hold), and pass `readOnly` to `NamesTermsSettings` and `EmailIngestSettings`.
9. `src/components/NamesTermsSettings.tsx` -- accept `readOnly`, export `NAMES_TERMS_READ_ONLY_COPY` = `READ_ONLY_REFUSAL.namesTerms`'s wording, early-return in `save`/`remove` (before the `window.confirm`), mark Save/Edit/Remove `aria-disabled` with `aria-describedby` pointing at a rendered note -- the surface must not open a confirm onto a 403.
10. `src/components/EmailIngestSettings.tsx` -- same shape with `EMAIL_INGEST_READ_ONLY_COPY` mirroring `.emailSettings`.
11. `src/app/api/research/route.ts` -- add `readOnly: isReadOnly()` to the GET body, the `/api/workspace-profile` idiom, so the studio can learn the flag without importing `@/lib/read-only`.
12. `src/lib/knowledge-studio-copy.ts` (new) -- own the three studio sentences (`RESEARCH_CREATE_READ_ONLY_COPY`, `RESEARCH_MUTATE_READ_ONLY_COPY`, `RESEARCH_COLLECT_READ_ONLY_COPY`) mirroring `.researchCreate`, `.researchMutate`, `.ingest`; they cannot live in `KnowledgeStudio.tsx` because the node-project parity suite would then pull `react-markdown`, `katex` and Mermaid to read a string -- the `workbench-tree.ts` precedent.
13. `src/components/KnowledgeStudio.tsx` -- thread `readOnly` from `refresh()` into `InsightsPanel` and `ResearchPanel`; early-return in `research`, `createProject`, `collect`, `runAutomated`, `cancel`, `remove`; `aria-disabled` + `aria-describedby` on those controls and render the notes -- a half-dimmed action row is a fresh inconsistency.
14. `src/lib/__tests__/read-only-copy-parity.test.ts` -- add cases: `WIKI_READ_ONLY_COPY` recorded as a deliberate four-verb divergence covering create/switch/rename/delete (and therefore `wikiRename`'s client counterpart, DW-302/DW-318); `SETTINGS_READ_ONLY_COPY` === `settingsWrite`; the settings, rebuild-embeddings and workspace-profile doors serve their constants by NAME; the five studio/settings client constants against their server sentences. Replace both `"Settings are read-only in this deployment."` literals.
15. `src/app/settings/__tests__/settings-page-read-only-controls.test.tsx` (or a sibling `*.test.tsx`) and a new mounted suite for the two settings panels -- assert each refused control is `aria-disabled`, still focusable, resolves `aria-describedby` to the rendered sentence, and issues NO request when activated; assert `window.confirm` is never reached on `NamesTermsSettings` remove.
16. `src/lib/__tests__/` -- node-project cases that flip `YOPEDIA_READONLY` and assert each newly gated store export throws `ReadOnlyError` with its sentence and writes nothing, and that the wiki routes' catch maps a `ReadOnlyError` to 403 (source-scan or handler invocation, matching whichever idiom the neighbouring wiki route suites already use).
17. `DEPLOY.md` -- add `YOPEDIA_READONLY` to the Additional Settings table and a read-only subsection stating that `POST /api/tasks/scan` answers 403 on every cron pass, so a monitor treating non-2xx as failure alerts once per tick, and that the workspace-profile backfill and orphan-directory sweep therefore never run while the flag is set.

**Acceptance Criteria:**
- Given `YOPEDIA_READONLY=1` and a direct library call to any of the seven newly gated store exports, when it runs, then it throws `ReadOnlyError` carrying that door's `READ_ONLY_REFUSAL` sentence and the stored file is byte-identical afterwards.
- Given a `ReadOnlyError` raised inside any of the five wiki-lifecycle handlers, when the catch runs, then the response is 403 with that error's message, not 500.
- Given the parity suite, when it runs, then every `READ_ONLY_REFUSAL` value contains `while this deployment is read-only.` and every client constant is either identical to its server sentence or has an assertion recording why it differs — including `WIKI_READ_ONLY_COPY`.
- Given a `src/lib` export that calls `assertWritable` and is absent from `KERNEL_WRITERS`, when `read-only-door-coverage.test.ts` runs, then it fails naming that export.
- Given `/settings` served `readOnly: true`, when the owner tabs through Names & Terms and Email ingestion, then every write control is reachable, announced as dimmed, and describes itself with that panel's read-only sentence; activating one issues no network request.
- Given the Knowledge Studio research panel with `readOnly: true`, when the owner presses Create / Run / Cancel / Delete / Collect, then no request is made and the matching sentence is on screen.
- Given `DEPLOY.md`, when an operator searches it for the scan, then it states the 403-per-tick behaviour and its two consequences.
- Given `pnpm lint` and `pnpm test`, when both run, then both pass with no pre-existing suite rewritten to accommodate a reworded sentence (constants moved, assertions not loosened).

## Design Notes

**Registry first, deliberately.** The widened scan was pre-simulated against the working tree: with all ~30 gated exports registered, 44 route files are reached (up from 20+) and ZERO are untreated. So task 1 is safe to land first and is what proves tasks 4-5 are complete rather than sampled.

**Why `settingsWrite` is shared by two doors.** `PUT /api/settings` and `PUT /api/workspace-profile` refuse the same deployment state and today spell it identically; making them share one constant removes the fourth loose copy instead of creating a fifth. `WORKSPACE_PURPOSE_READ_ONLY_COPY` stays the recorded narrowing beside a form that edits one thing — its existing divergence assertions just re-point at the constant.

**`WIKI_READ_ONLY_COPY` is a divergence, not a bug.** Follow the `REVERT_READ_ONLY_COPY` case: assert it differs from each of `wikiCreate`/`wikiSwitch`/`wikiRename`/`wikiDelete`, that it names all four verbs, and that it names read-only — so a future edit that narrows it to one door has to come back and decide which door owns it.

```ts
// The shape every one of the ten route edits takes — beside the gate, never instead of it.
} catch (error) {
  if (isReadOnlyError(error)) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
  }
  const status = error instanceof ClientInputError ? 400 : 500;
  return NextResponse.json({ error: getErrorMessage(error) }, { status });
}
```

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/read-only-door-coverage.test.ts src/lib/__tests__/read-only-copy-parity.test.ts` -- expected: pass, with the new derivation and parity cases present.
- `pnpm exec vitest run --project dom` -- expected: pass, including the new mounted read-only suites.
- `pnpm test` -- expected: full pass over both projects.
- `pnpm lint` -- expected: clean.
- `grep -rn "Settings are read-only in this deployment" src` -- expected: no matches.
