---
title: 'Per-Wiki workspace profiles'
type: 'refactor'
created: '2026-08-17'
status: 'done'
baseline_revision: '5d02c9e3a5a17762724195beec0e8ab07f1b2c20'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      The Workspace Purpose form never refetches after the active Wiki changes, so it can
      keep naming and editing a Wiki that is no longer current.
    evidence: |-
      `WorkspacePurposeSettings.tsx` loads the active Wiki in a `useEffect` with an empty
      dependency array, and `router.refresh()` from the Wiki switcher re-renders server
      components without remounting a client component. The save is now safe — the route
      refuses on a `wikiId` mismatch — but the owner sees a stale Wiki name until reload.
    location: >-
      src/components/WorkspacePurposeSettings.tsx
    severity: medium
  - summary: >-
      The legacy tenant-global profile is read through by every pre-change Wiki in a tenant,
      so one purpose appears under all of them until each is individually saved.
    evidence: |-
      `getWorkspaceProfile` falls back to `tenants/<t>/workspace-profile.json` whenever a
      Wiki has no file of its own. Intentional and documented for the migration window, but
      it has no end date, no backfill, and no removal milestone.
    location: >-
      src/lib/workspace-profile.ts
    severity: low
  - summary: >-
      `docs/llm-wiki-functional-parity-roadmap.md` still describes the Workspace Purpose
      editor as owner-scoped rather than per-Wiki.
    evidence: |-
      Line 101 predates this change; the roadmap is not a spec surface this run owns, but the
      sentence is now wrong.
    location: >-
      docs/llm-wiki-functional-parity-roadmap.md:101
    severity: low
  - summary: >-
      `putWorkspaceProfile` is an exported unlocked writer whose only guard is a docblock.
    evidence: |-
      It must be exported so `seedWikiArtifacts` can write inside the non-reentrant
      `wikis:<tenant>` lock, but a future caller that is NOT holding that lock can write a
      profile with no serialization and nothing in the suite or the type system flags it.
      The module-private `putWikiArtifact` does not have this exposure.
    location: >-
      src/lib/workspace-profile.ts
    severity: low
  - summary: >-
      `PUT /api/workspace-profile` has no explicit invalid-JSON branch, so a malformed body
      surfaces a raw parser message as the 400.
    evidence: |-
      `/api/wikis/current` catches this and answers "Invalid JSON body."; this route lets
      `request.json()` throw into the generic catch. Pre-existing behaviour, unchanged here.
    location: >-
      src/app/api/workspace-profile/route.ts
    severity: low
  - summary: >-
      `buildWorkspaceGuidance` now performs two storage reads per call, uncached, at seven
      call sites including three in `ingest.ts`.
    evidence: |-
      It resolves `wikis.json` through `getCurrentWiki` and then reads the profile. Resolving
      the active Wiki once per request and passing it down would halve the I/O.
    location: >-
      src/lib/workspace-guidance.ts
    severity: low
  - summary: >-
      The Settings no-Wiki and load-failed states offer no CTA, no retry, and no aria-live
      announcement, and `loadFailed` is never reset.
    evidence: |-
      "Create a wiki first" does not link to where a Wiki is created, and a transient GET
      failure leaves the form permanently disabled until a full reload — `WikiWorkbench` at
      least says "Reload to try again".
    location: >-
      src/components/WorkspacePurposeSettings.tsx
    severity: low
  - summary: >-
      A failure of the profile write in `seedWikiArtifacts` leaves `schema.md` on the new
      template and the profile on the old one.
    evidence: |-
      The three writes are sequential and untransacted. Pre-existing ordering, not introduced
      here, and unreachable without a storage fault mid-seed.
    location: >-
      src/lib/wikis.ts
    severity: low
  - summary: >-
      A corrupt per-Wiki `workspace-profile.json` blocks the re-template that would have
      overwritten it.
    evidence: |-
      `getWorkspaceProfile` rethrows a `SyntaxError` from its own file (only the legacy
      fallback degrades), and `putWorkspaceProfile` reads existing state before writing.
      Pre-existing shape — the old tenant-global store behaved the same way.
    location: >-
      src/lib/workspace-profile.ts
    severity: low
  - summary: >-
      Two tabs editing the SAME Wiki's Workspace Purpose still last-write-wins with
      no warning.
    evidence: |-
      The PUT guard compares Wiki identity only, so a drift check passes when both
      tabs name the same Wiki. The profile already carries `updatedAt` and the form
      already tracks `savedAt`, so an `If-Match`-style precondition was available;
      the store has never had one, so this is pre-existing shape, not new here.
    location: >-
      src/app/api/workspace-profile/route.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** The workspace profile is a tenant-global singleton at `tenants/<t>/workspace-profile.json`, so creating or re-templating a Wiki (`seedWikiArtifacts` → `saveWorkspaceProfile`) silently replaces a Workspace Purpose the owner hand-authored in Settings (DW-14), switching the active Wiki performs the same destructive write from a bare unguarded `<select>` (DW-21), and the write crosses two lock keys — `wikis:<tenant>` wrapping `workspace-profile:<tenant>` — so a concurrent Settings save can interleave and leave `schema.md` naming one template while the profile names another (DW-22).

**Approach:** Store one profile per Wiki at `tenants/<t>/wikis/<wikiId>/workspace-profile.json` alongside that Wiki's `purpose.md` and `schema.md`. Prompt guidance resolves the ACTIVE Wiki's profile, so switching swaps which profile is live instead of overwriting a shared one; `setCurrentWiki` stops writing profiles entirely; and every write under `wikis/<id>/` plus the registry serializes on the single `wikis:<tenant>` key, retiring `workspace-profile:<tenant>` and the nesting hazard with it.

## Boundaries & Constraints

**Always:**
- The profile file is a sibling of the seeded artifacts but NOT a member of `WIKI_ARTIFACT_FILES` — that list drives the Files-tab tree (`workbench-files.ts:261`) and the dialog copy, and a JSON file must not appear there.
- One lock key, `wikis:<tenant>`, owns the registry AND everything under `tenants/<t>/wikis/<id>/`. `withFileLock` is not reentrant, so code already holding it writes through an UNLOCKED internal putter (the existing `putWikiArtifact` pattern). Document this ordering rule where a future caller will meet it.
- No import cycle. `wikis.ts` imports `workspace-profile.ts` today, so shared path/lock helpers move to a new leaf module and active-Wiki-aware guidance moves to a new module that imports both.
- A pre-existing tenant-global `tenants/<t>/workspace-profile.json` must keep working: a Wiki with no per-Wiki profile yet reads through to it. Read-only fallback; never delete or rewrite the legacy file.
- Preserve the existing house style: explanatory doc comments that say WHY, `ClientInputError` for 400-able input, fail-soft degradation with `logger.warn`.

**Block If:**
- The active-Wiki-scoped Settings route would need an auth/tenant model change (it must not — `getPrincipal().handle` already scopes it).

**Never:**
- Do not reconcile the profile with `schema.md` in either direction (a Settings edit still does not rewrite `schema.md`) — DW-14 assigns that to Story 1.8.
- Do not partition Pages or Sources per Wiki; do not write under `tenants/<t>/wiki/` or `tenants/<t>/raw/`.
- Do not add a confirm dialog to the Wiki `<select>` — the fix for DW-21 is that the switch stops being destructive.
- Do not rename runtime identifiers (`yopedia` stays).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Hand-authored profile survives a create | Wiki A current, its profile hand-edited in Settings; `createWiki(B)` | A's profile bytes unchanged; B seeded with its template profile; B becomes current | No error expected |
| Switch swaps, never overwrites | A (edited) and B exist, B current; `setCurrentWiki(A)` | Only `wikis.json` is written; both profiles unchanged; `buildWorkspaceGuidance` now renders A's | Unknown id → `null`, pointer unmoved |
| Re-template rewrites only its own Wiki | A and B exist; `applyScenarioTemplate(A, "reading")` | A's `purpose.md`, `schema.md`, profile rewritten; B's profile untouched | Unknown id → `null`, nothing written |
| Guidance with no active Wiki | Empty registry | `buildWorkspaceGuidance(owner)` returns `""` | Registry read failure → `""`, warn |
| Legacy tenant-global profile | Wiki created before this change, no per-Wiki file | `getWorkspaceProfile(owner, wikiId)` returns the legacy profile; next save writes the per-Wiki file | Legacy missing too → empty profile |
| Settings GET/PUT with no active Wiki | Empty registry | GET returns empty profile with `wiki: null`; PUT is refused | PUT → 400, "Create a wiki…", nothing written |

</intent-contract>

## Code Map

- `src/lib/wikis.ts` — `templateProfile():263`, `seedWikiArtifacts():308` (the create/re-template profile write, line 326), `putWikiArtifact():291` (UNLOCKED-on-purpose pattern to copy), `lockKey():122`, `WIKI_ID_RE`/`validateWikiId():103-111`, `wikiArtifactPath():114`, `createWiki():419`, `applyScenarioTemplate():454`, `setCurrentWiki():483-517` (the DW-21 write + rollback to delete), module docblock lines 17-20.
- `src/lib/workspace-profile.ts` — `profilePath():26`, `lockKey():30` (the `workspace-profile:<tenant>` key to retire), `getWorkspaceProfile():46`, `saveWorkspaceProfile():66`, `renderWorkspaceGuidance():85`, `buildWorkspaceGuidance():106` (moves out).
- `src/lib/workspace-profile-schema.ts` — pure, client-safe; `parseWorkspaceProfileInput`, `EMPTY_WORKSPACE_PROFILE`. **Read-only.**
- `src/lib/lock.ts` — `withFileLock` chains per key and is NOT reentrant (lines 37-53); the lock-ordering rule belongs in its header. `_resetLocks()` is the test hook.
- `buildWorkspaceGuidance` consumers (import path changes only): `src/lib/ingest.ts:32`, `query.ts:27`, `chat.ts:22`, `agent-runtime.ts:22`, `action-extractor.ts:12`, `structured-knowledge.ts:23`, `source-monitors.ts:11`.
- `src/app/api/workspace-profile/route.ts` — GET/PUT; must resolve the active Wiki. Catch-all returns 400 on PUT, 500 on GET.
- `src/components/WorkspacePurposeSettings.tsx` — fetches `/api/workspace-profile`; `placeProfile():49`, header block lines 138-158.
- `src/components/WikiWorkbench.tsx` — `switchWiki():108` and its stale comment 116-117; comments at 32-33, 98-99, 166 claim a switch/create "rewrites the tenant workspace profile"; confirm-dialog copy line 291. `<select>` at 216-231 stays as-is.
- `src/components/CreateWikiDialog.tsx:112` — create copy.
- `src/lib/workbench-files.ts:98-101,247-271` — lists ONLY `WIKI_ARTIFACT_FILES` names from the Wiki dir, so a new JSON sibling stays out of the tree. **Read-only evidence; do not change.**
- Tests to update: `src/lib/__tests__/wikis.test.ts` (84-87, 302, 342-380), `workspace-profile.test.ts` (all), `workspace-profile-routes.test.ts` (mocks + 63-77), `create-wiki-ui.test.ts` (50, 145 pin dialog copy verbatim).

## Tasks & Acceptance

**Execution:**
- `src/lib/wiki-paths.ts` — NEW leaf module: move `WIKI_ID_RE`, `validateWikiId`, `wikiArtifactPath`, add `wikiDirPath(owner, wikiId)` and `wikiLockKey(owner)` (`wikis:<tenant>`) — so `workspace-profile.ts` can address the Wiki dir and take the Wiki lock without importing `wikis.ts`. Imports only `errors`, `wiki`, and the `WikiArtifactFile` type.
- `src/lib/wikis.ts` — import the helpers from `wiki-paths` and re-export `wikiArtifactPath` (six existing importers must keep compiling); write the seeded profile through the new UNLOCKED putter inside `seedWikiArtifacts`; delete the `saveWorkspaceProfile` call, `previousId` rollback and warn branch from `setCurrentWiki`; refresh the module docblock and the `applyScenarioTemplate`/`setCurrentWiki` docblocks to state per-Wiki ownership.
- `src/lib/workspace-profile.ts` — key storage by `(owner, wikiId)`: path from `wikiDirPath`, `getWorkspaceProfile(owner, wikiId)` with the documented legacy tenant-global read-through, `saveWorkspaceProfile(owner, wikiId, input)` under `wikiLockKey`, and an exported UNLOCKED `putWorkspaceProfile(owner, wikiId, input)` for the seeder. Retire the `workspace-profile:<tenant>` key. Move `buildWorkspaceGuidance` out; keep `renderWorkspaceGuidance`/`emptyWorkspaceProfile`.
- `src/lib/workspace-guidance.ts` — NEW: `buildWorkspaceGuidance(owner)` resolves `getCurrentWiki(owner)`, returns `""` when there is none, else renders that Wiki's profile. Fail-soft on a registry read error (warn + `""`).
- `src/lib/{ingest,query,chat,agent-runtime,action-extractor,structured-knowledge,source-monitors}.ts` — repoint the `buildWorkspaceGuidance` import to `./workspace-guidance`; no call-site changes.
- `src/lib/lock.ts` — document the lock-ordering rule in the header: `wikis:<tenant>` is the outermost lock for Wiki state and covers `wikis.json` plus everything under `tenants/<t>/wikis/<id>/`; never take a second key while holding it.
- `src/app/api/workspace-profile/route.ts` — resolve the active Wiki; GET returns `{ profile, readOnly, wiki: {id,name} | null }` (empty profile when there is no Wiki); PUT with no active Wiki answers 400 with a "create a wiki first" message and writes nothing.
- `src/components/WorkspacePurposeSettings.tsx` — consume `wiki` from the GET payload: name the Wiki the purpose belongs to in the section intro, and when it is null show that a Wiki is needed and keep the form disabled.
- `src/components/WikiWorkbench.tsx` + `src/components/CreateWikiDialog.tsx` — correct the stale "rewrites the tenant workspace profile" comments; name the Workspace Purpose in both dialogs' copy (create and re-template both write the Wiki's own profile).
- `src/lib/__tests__/workspace-profile.test.ts` — per-Wiki signatures; two Wikis keep independent profiles; legacy tenant-global read-through; guidance follows the active Wiki and is `""` with no Wiki; keep the ingest/query prompt-injection assertions.
- `src/lib/__tests__/wikis.test.ts` — assert the DW-14, DW-21 and DW-22 behaviors in the I/O matrix; delete the obsolete "re-seeds the workspace profile" and "leaves the pointer where it was when the profile re-seed fails" tests (that write no longer exists).
- `src/lib/__tests__/workspace-profile-routes.test.ts`, `create-wiki-ui.test.ts` — update mocks/assertions for the active-Wiki route shape and the amended dialog copy.

**Acceptance Criteria:**
- Given a Wiki whose Workspace Purpose was hand-authored in Settings, when another Wiki is created or re-templated, then the first Wiki's stored profile is byte-identical and Settings still shows it once that Wiki is active again.
- Given two Wikis, when the owner switches with the `<select>`, then the only file written is `wikis.json`, and the ingest/chat/query prompts carry the newly active Wiki's profile and its `schema.md` together.
- Given the codebase after the change, when `withFileLock` keys are surveyed, then no call takes `workspace-profile:<tenant>`, every write under `tenants/<t>/wikis/<id>/` is reached under `wikis:<tenant>` exactly once, and `lock.ts` states the ordering rule.
- Given `pnpm test` and `pnpm build`, when run, then both pass with no new type, lint, or test failures.

## Spec Change Log

_No spec amendments — no `bad_spec` finding was raised._

## Review Triage Log

### 2026-08-17 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 1, medium 4, low 5)
- defer: 9: (high 0, medium 1, low 8)
- reject: 7: (high 0, medium 0, low 7)
- addressed_findings:
  - `[high]` `[patch]` The Settings PUT re-resolved the active Wiki per request while the form resolved it once at mount, so a pointer that moved in between wrote one Wiki's on-screen bytes over another's stored profile — the same silent cross-Wiki overwrite this story removes, relocated from the seeder to the route. The PUT contract now carries `wikiId` and refuses on a mismatch; the client sends it and adopts the `wiki` the responses return.
  - `[medium]` `[patch]` An unparseable or `EISDIR` legacy tenant-global file escaped `readLegacyTenantProfile` and rejected `createWiki`/`applyScenarioTemplate` tenant-wide. An unusable legacy file is now treated as absent, with a warn.
  - `[medium]` `[patch]` An owner with a hand-authored legacy profile and no Wiki yet lost it from every prompt and from Settings — on the exact upgrade the fallback exists to protect. `buildWorkspaceGuidance` and the Settings GET now fall back to the legacy profile when there is no active Wiki, read-only.
  - `[medium]` `[patch]` The DW-22 test could not fail for the reason it named: both calls enqueued synchronously in call order, its `else` branch was unreachable, and it passed under the old two-key arrangement. Replaced with a discriminator that holds `wikis:<tenant>` from the test, plus a source scan pinning that no `workspace-profile:` lock key survives anywhere in `src`.
  - `[medium]` `[patch]` None of the new Settings gating (disabled fieldset/submit with no Wiki, `no wiki` vs `unavailable` states, the per-Wiki intro copy) had executable coverage. Added a mounted DOM test covering all three GET outcomes and the drift cases.
  - `[low]` `[patch]` A newly seeded Wiki inherited `createdAt` from the retired singleton, because the write path read existing state through the legacy fallback. The write path now reads only the Wiki's own file.
  - `[low]` `[patch]` `workbench-files.ts` still reconstructed the Wiki directory by slicing `wikiArtifactPath`; it calls `wikiDirPath` directly now.
  - `[low]` `[patch]` The `wikiArtifactPath` re-export comment miscounted its consumers; corrected, with the modules named individually so it stays checkable.
  - `[low]` `[patch]` `setCurrentWiki`'s docblock implied the profile and `schema.md` now agree; within one Wiki they can still name different templates. It now says what remains divergent and that reconciling it is Story 1.8's.
  - `[low]` `[patch]` The re-template confirm named the files but not the loss, while the comment above it did. The copy now says a purpose written in Settings will be replaced.

### 2026-08-17 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 1, low 5)
- defer: 1: (high 0, medium 0, low 1)
- reject: 19: (high 0, medium 0, low 19)
- addressed_findings:
  - `[medium]` `[patch]` The PUT drift guard fired only when `wikiId` was a string, so a body carrying `wikiId: null` (or a number, or an object) slipped past it and wrote to whatever Wiki was active now — the same silent cross-Wiki overwrite the guard exists to refuse, reachable by a wrong-typed field. Present-but-wrong is now refused whatever its type; absent stays tolerated, with a route test covering all three shapes.
  - `[low]` `[patch]` `PUT` resolved the active Wiki inside its input-validation `try`, so an unreadable `wikis.json` answered 400 with a raw storage message while `GET` answered 500 for the identical condition. The registry read moved into its own guarded step that answers 500; a test pins it.
  - `[low]` `[patch]` The intent's Always-constraint that `workspace-profile.json` must not reach the Files tab had no executable coverage — no test ever put the file in the Wiki directory this change makes it live in. `workbench-tree.test.ts` now writes it beside the artifacts and asserts it appears in neither the paths nor the tree.
  - `[low]` `[patch]` The new mounted Settings test's `active` assertion matched the intro paragraph, not the status badge: the fixture has no `updatedAt`, so the badge actually read `not configured` and the assertion passed in every state. The badge is now read as an element and asserted exactly, with a saved-profile case added for the `active` branch.
  - `[low]` `[patch]` With no Wiki and a legacy tenant-global profile on disk, Settings showed "Last saved …" — dating a save no Wiki owns and the disabled form cannot repeat. The receipt is suppressed when `wiki` is null, and the migration state an existing owner actually upgrades into now has a mounted test.
  - `[low]` `[patch]` `readLegacyTenantProfile`'s docblock and one test comment still claimed, in the present tense, that the legacy address sits on every profile WRITE path — untrue since `putWorkspaceProfile` was corrected to read only the Wiki's own file, which left the test's stated rationale describing a coupling that no longer exists. Both restated.

## Design Notes

Why guidance moves to its own module: `wikis.ts` already imports `workspace-profile.ts`, so making the profile store ask for the current Wiki would close a cycle. Splitting the leaf helpers down (`wiki-paths.ts`) and the composed reader up (`workspace-guidance.ts`) keeps a strict layering: `wiki-paths` → `workspace-profile` → `workspace-guidance`, with `wikis.ts` between the first two.

Why one lock instead of nested locks: DW-22's obvious fix (nesting `workspace-profile:<t>` inside `wikis:<t>`) creates the ordering hazard it names. Once the profile is a per-Wiki file living in the Wiki's own directory, the Wiki lock already covers it, and the second key has nothing left to protect.

Legacy read-through, in `getWorkspaceProfile`:

```ts
// Wikis created before per-Wiki profiles have no file of their own. Read
// through to the retired tenant-global singleton so a hand-authored purpose
// is not silently lost at deploy; the next save writes the per-Wiki file and
// this branch stops being reached for that Wiki. Never written, never deleted.
if (isEnoent(error)) return (await readLegacyTenantProfile(owner)) ?? emptyWorkspaceProfile();
```

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/workspace-profile.test.ts src/lib/__tests__/wikis.test.ts src/lib/__tests__/workspace-profile-routes.test.ts src/lib/__tests__/create-wiki-ui.test.ts` -- expected: all pass
- `pnpm test` -- expected: no new failures versus the pre-change baseline
- `pnpm exec tsc --noEmit` and `pnpm lint` -- expected: clean
- `grep -rn "workspace-profile:" src` -- expected: no `withFileLock` key match remains


## Auto Run Result

Status: done
Blocking condition: none

### Summary

Follow-up review pass over the committed per-Wiki Workspace Purpose change (`9cf5bcf`, baseline `5d02c9e`). No intent gap and no spec defect: four review layers agreed the diff implements the intent's own reading — profile stored per Wiki at `tenants/<t>/wikis/<wikiId>/workspace-profile.json`, guidance following the `current` pointer, `setCurrentWiki` writing only `wikis.json`, and one `wikis:<tenant>` lock key covering the registry and everything under the Wiki directory. Six patches were applied: one closing a typed hole in the PUT drift guard, one correcting an infrastructure failure reported as a client error, two closing verification gaps (a Files-tab constraint with no executable coverage, and a badge assertion that matched prose instead of the badge), and two correcting a UI receipt and stale documentation.

### Files changed in this pass

- `src/app/api/workspace-profile/route.ts` — a present-but-wrong `wikiId` is refused whatever its type; the registry read moved out of the input-validation `try` so an unreadable `wikis.json` answers 500, as GET already does.
- `src/components/WorkspacePurposeSettings.tsx` — no "Last saved …" receipt when no Wiki owns the shown profile (the legacy read-through state).
- `src/lib/workspace-profile.ts` — `readLegacyTenantProfile`'s docblock restated: it no longer sits on the write path, and says why it still must not throw.
- `src/lib/__tests__/workspace-profile-routes.test.ts` — non-string `wikiId` refusal (null, number, object) and the 500-not-400 registry-failure case.
- `src/lib/__tests__/workbench-tree.test.ts` — `workspace-profile.json` written beside the artifacts and asserted absent from both the listing and the tree.
- `src/components/__tests__/workspace-purpose-settings.test.tsx` — badge read as an element and asserted exactly; `active` branch covered with a saved fixture; the legacy-profile-with-no-Wiki state covered.
- `src/lib/__tests__/workspace-profile.test.ts` — stale test rationale restated to describe what the case now pins.

### Review findings breakdown

Patches applied: 6 (0 high, 1 medium, 5 low). Items deferred: 1 (low) — appended to frontmatter `deferred`. Items rejected: 19.

Follow-up review recommended: **true** — patched counts by severity: high 0, medium 1, low 5; score `3 × 1 + 1 × 5 = 8` (threshold 5).

Rejected findings of note, with the reason: `wikiId` reaching storage through the payload (the route test exercises the real `parseWorkspaceProfileInput` and pins that only schema fields are saved); the DW-22 concurrency test being timing-flaky (the lock is held by the test, so neither operation can proceed regardless of the sleep, and `withFileLock` chains synchronously in call order); unused `logger`/`WIKI_ID_RE` imports in `wikis.ts` (both still have live uses); and six findings already recorded in `deferred` from the previous pass (legacy fallback lifetime, corrupt per-Wiki profile, exported unlocked putter, seed atomicity, Settings a11y, no-CTA states).

### Verification performed

- `npx vitest run` — 212 files / 4379 tests pass (4374 before this pass; 5 tests added).
- `npx vitest run` over the six affected suites — 113 pass.
- `npx tsc --noEmit` — exit 0.
- `npx eslint .` — exit 0 (only the pre-existing `jsx-ast-utils` TSNonNullExpression notices).
- `npx next build` — compiled successfully.
- `grep -rn "workspace-profile:" src` — five matches, all prose; no `withFileLock` key remains.
- `pnpm test` / `pnpm exec` still fail in this environment with `ERROR packages field missing or empty` — a pnpm workspace-resolution problem unrelated to this change; `pnpm test` maps to `vitest run`, which was run directly.

### Residual risks

- The `wikiId` drift guard remains advisory for callers that OMIT the field: a non-form client still writes to whatever Wiki is active. Making it mandatory would break scripted callers, so it is tolerated and documented — and now enforced for every value that is actually sent.
- Two tabs on the same Wiki still last-write-wins; the profile store has never had an `updatedAt` precondition. Deferred, not fixed here.
- The legacy tenant-global fallback is shared across all pre-change Wikis in a tenant and reachable with zero Wikis. Read-only on every path, with no backfill and no removal milestone.
- Within one Wiki, a Settings save still leaves the profile's `scenario` and that Wiki's `schema.md` naming different templates. Reconciling them is Story 1.8's, explicitly out of scope.
