---
title: 'DW-612/613: canonical owner sessions across storage and controls'
type: 'bugfix'
created: '2026-09-09'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'd26dd53c502a63881145290bdd5108bd8cd4ba5d'
context:
  - /private/tmp/work-wiki-canonical-owner-session/AGENTS.md
  - /private/tmp/work-wiki-canonical-owner-session/_bmad-output/implementation-artifacts/owner-session-addressing-map.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Stable-id owners whose username changes can write into a tenant canonical readers never use. Client controls independently match the old public handle, disagreeing with server ownership.

**Approach:** Route all session-derived owner storage consistently through the configured canonical owner handle, preserving actual actor identity. Supply server-computed owner flags to the three client islands. The user approved this complete scope and preservation of old-handle data for separate reconciliation on 2026-09-09; this new contract supersedes the contradictory scope in the historical DW-612/613 spec without editing it.

## Boundaries & Constraints

**Always:** Add ownerTenantHandle using existing isOwnerPrincipal and getOwnerHandle. Return principal?.handle ?? "" unchanged unless the principal is already the deployment owner and a canonical handle exists. Preserve strict auth/read-only/realm gates, statuses and identity predicates. Canonicalize session-derived namespace ownership and matching ownership checks together; keep author/actor/triggeredBy as actual identity. Pass required server-computed isSiteOwner to NavHeader, ArticleActions and RevisionHistory. Preserve Clerk loading rules, framework control flow and content-addressed targets. Existing old-handle bytes remain untouched and are not automatically imported or shown in the canonical workspace.

**Ask First:** Changing non-owner/service authorization, redefining explicit content targets, real-data reconciliation or external effects, merge or deployment.

**Never:** Rewrite getPrincipal or global request identity, expose the owner user id to clients, rename existing records/resources/identifiers, migrate/copy/delete/replay old data, edit the ledger or old frozen specs, change protected configuration/dependencies, or add global request-scoped storage state. No automatic reconciliation or production acceptance claim.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
| --- | --- | --- | --- |
| Stable-id owner | Changed handle or username absent; canonical handle configured | All session-owned storage and ownership checks use canonical namespace; actor remains actual handle | Existing operation errors |
| Fallbacks | Handle-only owner, no canonical handle, non-owner, or no principal | Existing helper/authorization behavior; no default-tenant invention | Existing unauthenticated refusal |
| Controls | Drifted owner versus different id holding old owner handle | Server owner flags agree with server authority in all three islands | Read-only and other guards retained |
| Connected operations | Create/list/activate Wiki; artifact save/read; first paint; other owner-store families | Every operation addresses the same canonical tenant | No successful write followed by wrong-tenant empty read |
| Old data | Distinct canonical and drifted-tenant fixtures | New operations use canonical; old bytes stay identical | Reconciliation remains explicit pending work |
| Separate roles | Intake/save/review with live actor and canonical owner | Storage/record owner canonical; authorship/audit actor unchanged | No accidental identity substitution |
| Explicit targets | URL/frontmatter tenant, named extract owner, service-only path | Targets and service behavior unchanged; mismatched session owner requests refuse | No implicit old-handle alias |

</frozen-after-approval>

## Code Map

- `owner-session-addressing-map.md` is the investigation map: complete family scope, mixed owner/actor wrappers, client roots, preservation and test requirements. Revalidate remaining handle uses; do not blindly apply string replacement.
- `src/lib/owner.ts`, `v1-route.ts`, `extract-auth.ts`: canonical storage helper and shared session boundaries; preserve original Principal objects and import-light owner module.
- `src/app/page.tsx`, `src/app/api/**`, `src/app/vault/**`, owner-page evidence and the mapped `src/lib` helpers: all session storage, including Chat, jobs, agents, backups and integration state, not merely the historical four doors.
- `src/components/{ArticleView,ArticleActions,RevisionHistory,NavHeader}.tsx`, `src/app/layout.tsx`: server flags and canonical Graphify page-owner comparison without a broader Graphify grant. Existing loading/read-only/contributor expressions stay meaningful.
- Historical specs and Phase 0 are read-only evidence. Read `.yoyo/learnings.md` before touching ingest/write-path helpers; preserve architecture AD-2/3/7 and lifecycle ownership.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/owner.ts` and mapped session boundaries: implement canonical storage addressing and preserve fallback/auth behavior.
- [x] Mapped server routes/helpers: convert the connected reader/writer/ownership set, splitting mixed actor values; record remaining uses and exclusions in the addressing map.
- [x] Mapped server/client components: thread required owner flags and repair persistent identity disagreement without broader permissions.
- [x] Relevant existing tests and new owner-session composition suites under `src/**/__tests__/`: execute every matrix row, real local-storage composition and each converted family; update obsolete guards, preserve old-data sentinels, and verify actor separation.
- [x] This spec/addressing map: record verification, review and reconciliation limits; leave historical artifacts and ledger unchanged.

**Acceptance Criteria:**
- Given a drifted stable-id owner, when using any session-owned reader or writer, then the storage namespace agrees with canonical owner readers and no newly created object disappears between sibling doors.
- Given divergent server/client handle facts, when controls render after identity resolves, then site-owner affordances match the server and never admit a stale-handle impostor.
- Given old-handle data, when exercising the new flows, then its original bytes and identities remain preserved for separately approved reconciliation.

## Spec Change Log

- 2026-09-09: Implemented the approved canonical session namespace across the connected families. The frozen intent block is unchanged. Call-path inspection also split artifact revision, Source cascade and extract-record actor attribution; legacy callers/records retain their owner defaults.

## Verification

Run focused owner/route/mounted composition tests, `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm test`, `pnpm build`, and `git diff --check`. Use installed local tooling; loopback permission may be needed for synthetic test servers. Record exact collection/results and existing skips. Review all changed and remaining session handle uses. No remote or real-data operations.

### Implementation verification — 2026-09-09

- Focused run: **16 files, 610 tests passed**, no skips, 5.76s. Owner helper/gate/single-reader; Wiki routes/schema/artifact revisions; Workbench preview/connected routes; new owner-session composition/actor suites; mounted ArticleView, RootLayout, read-only, anchor and E2E identity suites. Log: `/private/tmp/owner-focused-final.log`.
- Full `pnpm test`: **403 files passed; 10,050 tests passed, 1 skipped**, 131.96s. The existing skip is the live Tavily contract case when `TAVILY_API_KEY` is absent. Local synthetic sidecar servers ran with loopback permission. Log: `/private/tmp/owner-full-final.log`.
- `pnpm exec tsc --noEmit`: exit 0 after the build completed. Log: `/private/tmp/owner-tsc-final.log`. An earlier concurrent invocation raced Next's regeneration of `.next/types`; the sequential post-build run is the authoritative result.
- `pnpm lint`: exit 0. Existing jsx-ast-utils `TSNonNullExpression` diagnostics remain, without lint findings. Log: `/private/tmp/owner-lint-final.log`.
- `pnpm build`: exit 0; optimized compilation completed in 14.3s, followed by type/lint validation, page-data collection and prerender completion. The environment supplied only a synthetic public Clerk publishable key for `clerk.fixture.invalid`; no real secrets were loaded. Public build-time font fetching was authorized. Node emitted its existing `module.register()` deprecation warning. Log: `/private/tmp/owner-build-final.log`.
- `git diff --check`: exit 0. No ledger, historical frozen spec, protected configuration, dependency manifest or identifier edits. All code remains local and unmerged.
- Initial verification found obsolete client/source assertions and one new test variable violating Next's lint rule; these were corrected before the successful gates above. The final focused run also covers subsequent test/comment-only clarifications.

The addressing map records the completed handle-use audit, actor exceptions, synthetic old-data preservation and release limits. Independent BMAD review status is recorded in the remediation section below; these results establish local implementation verification, not production acceptance. Reconciliation of actual old-handle data remains explicitly separate, unperformed work.

### Review remediation — 2026-09-09

Two confirmed medium findings were repaired within the preservation and actor contract:

- Source summaries now reuse only a matching storage owner's page. A matching source path/raw id owned by another tenant gets a distinct slug under the existing numeric collision rules. The equivalent overview takeover is also prevented: a foreign overview stays unchanged; the new owner gets a reusable numbered overview. The existing open page-type field marks generated overviews for bookkeeping exclusions in overview counts, Source indexing/cascade and orphan lint. Ordinary globally visible pages remain visible.
- Review create claims persist the initiating `claimActor`. Initial writes, synchronous lifecycle repair and expired-claim recovery use that actor; legacy claims without it retain the owner fallback. Abandoned claims clear it, and recovery that restores a reset row restores the original actor as well.

The real-storage regressions preserve old summary/overview slugs, indexed ownership and flat/tenant bytes across two canonical compiles; verify reuse and bookkeeping treatment of the new pages; and execute a drifted-owner Review route that loses publication after the primary write, then recovers from a persisted claim with correct revision attribution. A separate legacy-claim case verifies fallback compatibility.

Post-patch gates all completed successfully:

- Focused: **19 files / 760 tests passed**, no skips, 15.38s. Log: `/private/tmp/owner-review-focused.log`.
- Full `pnpm test`: **403 files passed; 10,053 tests passed, 1 skipped (10,054 total)**, 119.52s. The skip remains the existing absent-key live Tavily contract case. Synthetic loopback servers ran with the required permission. Log: `/private/tmp/owner-review-full.log`.
- `pnpm build`: exit 0; compilation 13.4s, followed by successful type/lint validation and prerender completion. The same synthetic public Clerk key (`clerk.fixture.invalid`) and public-font access were used, with no real secrets or configuration changes. Existing Node deprecation warning only. Log: `/private/tmp/owner-review-build.log`.
- Sequential post-build `pnpm exec tsc --noEmit`: exit 0. Log: `/private/tmp/owner-review-tsc.log`.
- `pnpm lint`: exit 0; the same three existing jsx-ast-utils `TSNonNullExpression` diagnostics, no lint findings. Log: `/private/tmp/owner-review-lint.log`.
- `git diff --check`: exit 0. Ledger SHA-256 remains `383e6c1110e550015797c5e3520c8a2115afbd54944d4de5c85a321323f20740`; no protected, historical frozen spec or dependency changes.

The blind review’s two medium findings were addressed and edge-case review returned no findings. The final verification-review disposition is recorded below. No production claim is made here.

### Final verification-review remediation — 2026-09-09

The user explicitly waived fresh context for the unavailable third reviewer and approved reusing the edge-case reviewer for the final verification-gap pass. That pass returned one medium coverage finding: the Chat family test executed only GET, while existing Chat route/store tests did not connect drifted-owner POST routing to real persistence.

The new `owner-session-composition.test.ts` case creates a conversation through the actual collection POST, stores supplied user/assistant frames through the actual messages POST (no provider call), reopens local storage, and reloads collection/detail routes. It verifies the stored conversation and messages in `tenants/canonical/chat-conversations.json` and byte-for-byte preservation of a distinct old-handle conversation with its own prior turn. No production change was required.

Mutation verification independently reverted the namespace argument of each POST writer to `principal.handle`: **both mutants failed the new case** at the expected persistence 404; each production file was restored immediately. Logs: `/private/tmp/owner-chat-mutant-create.log` and `/private/tmp/owner-chat-mutant-persist.log`. The unmutated composition suite passed **23/23 tests**, 1.14s (`/private/tmp/owner-chat-composition.log`). Final gates all passed:

- Focused Chat/owner composition, actor, route and store suites: **4 files / 49 tests passed**, no skips, 12.68s (`/private/tmp/owner-chat-focused.log`).
- Full `pnpm test`: **403 files passed; 10,054 passed, 1 existing live Tavily skip (10,055 total)**, 119.53s (`/private/tmp/owner-chat-full.log`). Synthetic loopback servers used the required permission.
- `pnpm build`: exit 0, compilation 13.7s; the same synthetic public Clerk fixture key and public-font access, no real secrets or config changes (`/private/tmp/owner-chat-build.log`).
- Sequential post-build `pnpm exec tsc --noEmit`: exit 0 (`/private/tmp/owner-chat-tsc.log`).
- `pnpm lint`: exit 0 with the same three existing jsx-ast-utils diagnostics and no lint findings (`/private/tmp/owner-chat-lint.log`).
- `git diff --check`: exit 0. Ledger hash unchanged. No frozen-intent, protected-file or dependency changes.

The medium verification-gap finding is addressed by executed composition and mutation proof. All three review passes are complete under the explicit reviewer-reuse waiver; no unresolved findings remain. This is local implementation acceptance, not production acceptance.

## Approval record

The user approved canonical routing for all session-derived owner reads/writes and preserving old-handle data. This spec makes that approved scope executable; no repeat permission request is needed. No epic story key applies.

## Review disposition

The blind reviewer returned two medium patch findings, both fixed with executed regressions. The edge-case reviewer returned no findings. The verification-gap pass returned one medium patch finding, fixed with real Chat persistence coverage and two demonstrated failing routing mutants. All three findings are resolved; no intent change, review loopback or deferred-work row was required.

The third context-free reviewer initially failed to launch with `agent thread limit reached`. The user explicitly approved reusing the existing edge-case reviewer for that pass, waiving fresh context only. The [verification-gap result](review-owner-session-verification-gap.md) records that limitation and the completed outcome; this is three review passes, not three independent reviewers.

The final source and tests passed the recorded gates before this documentation-only closure. The historical frozen specs, approved intent, protected files, dependencies and orchestrator-owned ledger remain unchanged. No story key applies, so sprint-status synchronization is skipped. The workflow is complete locally; publishing, merge, deployment and real-data reconciliation remain separate actions.

## Suggested Review Order

**Canonical storage and unchanged identity**

- Keep storage addressing separate from the authenticated principal.
  [owner.ts:106](../../src/lib/owner.ts#L106)

- Use the same namespace for first paint and subsequent operations.
  [page.tsx:75](../../src/app/page.tsx#L75)

- Connect Chat creation and reload to canonical storage.
  [route.ts:15](../../src/app/api/chat/conversations/route.ts#L15)

**Attribution and preserved data**

- Pass actual actors beside canonical storage owners.
  [route.ts:115](../../src/app/api/workbench/intake/route.ts#L115)

- Keep foreign summaries and overviews intact during canonical ingest.
  [ingest-bookkeeping.ts:30](../../src/lib/ingest-bookkeeping.ts#L30)

- Persist the initiating actor for interrupted Review creation.
  [review-queue.ts:615](../../src/lib/review-queue.ts#L615)

**Server authority in client controls**

- Resolve site ownership on the server for navigation.
  [layout.tsx:113](../../src/app/layout.tsx#L113)

- Pass owner authority and canonical Graphify ownership into article controls.
  [ArticleView.tsx:538](../../src/components/ArticleView.tsx#L538)

**Executed evidence**

- Exercise Wiki and Chat writes through real routes and storage.
  [owner-session-composition.test.ts:72](../../src/lib/__tests__/owner-session-composition.test.ts#L72)

- Prove old-data preservation and actor recovery after interruption.
  [owner-session-actors.test.ts:72](../../src/lib/__tests__/owner-session-actors.test.ts#L72)

- Trace every converted family and the deliberately unchanged boundaries.
  [owner-session-addressing-map.md:1](owner-session-addressing-map.md#L1)
