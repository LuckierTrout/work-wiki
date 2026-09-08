---
title: 'Workspace Purpose route preconditions (DW-140, DW-145)'
type: 'bugfix'
created: '2026-08-20'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      A storage failure inside `saveWorkspaceProfile` is still answered 400 by
      `PUT /api/workspace-profile`, telling the owner their edit was rejected
      when the write merely could not reach storage.
    evidence: |-
      The route's own comment above the registry read states the rule: "a
      registry that cannot be READ is not the caller's input being wrong. GET
      answers 500 for that exact condition, and answering 400 here would tell
      the owner their edit was rejected when storage was merely unreadable."
      This pass gave the precondition READ its own 500 branch, but
      `saveWorkspaceProfile` still throws into the generic `catch` that returns
      400 — so an unwritable store (an EACCES, a full disk, a lock timeout)
      surfaces as a raw machine-authored sentence at 400, the same class of
      message DW-140 removed from this route. Pre-existing: the write has thrown
      into that catch since the route was written, and this change did not move
      it.
    location: >-
      src/app/api/workspace-profile/route.ts
    severity: low
baseline_revision: 'eda408158e282c9a9c62651f817228e624cb942c'
---

<intent-contract>

## Intent

**Problem:** `PUT /api/workspace-profile` is the one editor-facing write in this app with neither of the two preconditions its siblings have: a malformed body falls into the generic catch and answers 400 with a raw `JSON.parse` message (DW-140), and the only drift check is `claimed !== wiki.id`, so two tabs editing the SAME Wiki's Workspace Purpose still last-write-wins silently (DW-145).

**Approach:** Give the route the explicit invalid-JSON branch `/api/wikis` already has, and wire the existing `src/lib/write-precondition.ts` guard through it — the route publishes a `version` for the profile it serves, the form returns it as `If-Match`, and a stale save is refused with the same 412/428 shape and copy the page, artifact and settings writes already answer.

## Boundaries & Constraints

**Always:**
- The version is `objectVersion()` from `src/lib/write-precondition.ts`, computed over the SAME `WorkspaceProfile` object the route just read via `getWorkspaceProfile(handle, wiki.id)` — the function GET seeds the form from, so both sides describe one value.
- The route publishes that version in the GET body and in the PUT response, and the client sends it back in the `If-Match` header — the `/api/settings` convention (`src/app/api/settings/route.ts:85,101,259,429`, `src/hooks/useSettings.ts:155,266,294`). The client never derives a version itself.
- Refusal order inside PUT: 401 → 403 read-only → 500 unreadable registry → 400 invalid JSON → 400 no wiki → 400 wiki drift → 400 invalid profile field → 428/412 precondition → write. A request that would be refused anyway must not learn a version (`IF_MATCH_HEADER` docblock).
- Refusal copy is relayed verbatim from `WRITE_CONFLICT_COPY` / `WRITE_PRECONDITION_REQUIRED_COPY` as the routes' existing `{ error }`. No sentence is typed at a render site.
- A failed GET must clear the client's version to `null`, so the next save is refused 428 (truthful) and not 412 (a change nobody made).

**Block If:** the existing `wikiId` cross-Wiki guard would have to be weakened or removed to fit the new precondition — the two are independent refusals and both must survive.

**Never:**
- Do not use `updatedAt` as the version: it is `null` for a never-saved profile and has millisecond resolution, so two saves in one tick would agree.
- Do not derive a version over `.llm-wiki-config.json` or any store holding key material (AD-23); this change touches only `workspace-profile.json`, which holds none.
- Do not take a lock, move the check inside `saveWorkspaceProfile`, or change the storage layer. The residual two-requests-in-the-same-instant window stays open, exactly as `checkWritePrecondition`'s docblock records.
- No new endpoint, no schema change, no change to the legacy tenant-global read-through.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| GET publishes the version | Signed in, active Wiki with a stored profile | 200 `{ profile, readOnly, wiki, version }` where `version === objectVersion(profile)` | No error expected |
| GET with no Wiki | Registry empty | 200, `wiki: null`, `version` still present for the profile shown | No error expected |
| Fresh save | PUT carries matching `If-Match` and matching `wikiId` | 200 `{ profile, wiki, version }`; `version` is that of the profile just written | No error expected |
| Malformed body (DW-140) | PUT body is not JSON | 400 `{ error: "Invalid JSON body." }`; nothing read, nothing written | Explicit branch, not the generic catch |
| Stale save, same Wiki (DW-145) | Two tabs on one Wiki; tab B saved first; tab A PUTs its older `If-Match` | 412 `{ error: WRITE_CONFLICT_COPY }`; `saveWorkspaceProfile` not called | Draft survives on screen |
| No precondition at all | PUT with no `If-Match` (or `*`, unquoted, weak, or a list) | 428 `{ error: WRITE_PRECONDITION_REQUIRED_COPY }`; nothing written | `parseIfMatch` treats all of these as absent |
| Stale AND invalid | Stale `If-Match` plus `scenario: "other"` | 400 for the field, not 412 | Field refusal comes first, by design |
| Wiki drifted | `wikiId` names a different Wiki, any `If-Match` | 400 `WIKI_DRIFTED`, before any version is computed | Existing guard, unchanged |

</intent-contract>

## Code Map

- `src/app/api/workspace-profile/route.ts` -- the whole change. `GET` at :39 (add `version`); `PUT` at :60 — `request.json()` at :86 currently throws into the generic catch at :110-111 (DW-140); the `claimed !== wiki.id` guard at :95-101 is the only drift check (DW-145). `NO_WIKI`/`WIKI_DRIFTED` copy constants at :30-36.
- `src/lib/write-precondition.ts` -- reuse, do not extend: `objectVersion` (this route is now its one production caller — its docblock names this exact case, "a parsed object rather than a byte string … when the file it guards is rewritten by its own serializer"), `IF_MATCH_HEADER`, `checkWritePrecondition`, `WRITE_CONFLICT_COPY`, `WRITE_PRECONDITION_REQUIRED_COPY`.
- `src/app/api/settings/route.ts:250-266` -- the pattern to copy verbatim in shape: read, then `checkWritePrecondition(request.headers.get(IF_MATCH_HEADER), read.version)`, then relay `{ error: precondition.error }` at `precondition.status`.
- `src/app/api/wikis/route.ts:45-51` -- the exact invalid-JSON branch to mirror (`catch { … "Invalid JSON body." … 400 }`), placed before the guard try.
- `src/components/WorkspacePurposeSettings.tsx` -- `savedAt` state at :66, GET at :110-143 (add `version` capture; the `.catch` at :128 must clear it), `save()` at :167-214 (add the `If-Match` header at :185-193, adopt `data.version` at :195). The `request<T>` helper at :45-50 already throws `body.error`, so both refusal sentences surface through the existing `feedback` banner with no render-site change.
- `src/lib/workspace-profile.ts` -- read only. `getWorkspaceProfile` is the read to version; `saveWorkspaceProfile` stays exactly as it is (the lock, `createdAt` preservation, read-only backstop are all untouched).
- `src/lib/__tests__/workspace-profile-routes.test.ts` -- route suite; `putRequest()` at :53-59 needs an optional header argument, and the `toEqual` GET assertions at :81-85 and :146-164 gain `version`.
- `src/components/__tests__/workspace-purpose-settings.test.tsx` -- mounted-form suite; `stubGet` at :33-40 seeds the GET body and must carry `version`.
- `src/hooks/useSettings.ts:196-201` -- read-only evidence for why a failed read clears the version rather than keeping it.

## Tasks & Acceptance

**Execution:**
- `src/app/api/workspace-profile/route.ts` -- parse the body in its own `try`/`catch` before the guard try, answering `{ error: "Invalid JSON body." }` at 400; then, after the wiki/drift/field refusals, read the current profile with `getWorkspaceProfile`, compute `objectVersion` over it, run `checkWritePrecondition` against `If-Match` and relay its `{ error, status }`; add `version` to the GET body and to the PUT response (the version of what was just written) -- one route, both preconditions, no new module.
- `src/components/WorkspacePurposeSettings.tsx` -- hold a `version` state seeded from GET and cleared when GET fails, send it as `If-Match` on the PUT, and adopt the version the PUT answers -- otherwise the form's second save in one session is refused for a change the owner made themselves.
- `src/lib/__tests__/workspace-profile-routes.test.ts` -- extend `putRequest` with headers and cover every row of the I/O matrix: version published on GET, 400 invalid JSON, 412 stale, 428 absent/`*`/malformed header, 400-before-412 ordering, drift-before-version ordering, and that `saveWorkspaceProfile` is not called on any refusal.
- `src/components/__tests__/workspace-purpose-settings.test.tsx` -- assert the mounted form sends `If-Match` built from the GET's `version`, sends none after a failed GET, adopts the PUT's version for a second save, and renders the 412 conflict sentence verbatim without losing the draft.

**Acceptance Criteria:**
- Given a signed-in owner with an active Wiki, when GET `/api/workspace-profile` answers, then the body carries a `version` equal to `objectVersion()` of the profile in the same body.
- Given two tabs on the SAME Wiki and tab B has saved, when tab A PUTs with its seeded `If-Match`, then the response is 412 with `WRITE_CONFLICT_COPY`, `saveWorkspaceProfile` is never called, and tab A's on-screen draft is intact.
- Given a save composed against a Wiki that is no longer active, when it PUTs with a perfectly valid `If-Match`, then it is still refused 400 with `WIKI_DRIFTED` — the cross-Wiki guard is not superseded by the new one.
- Given the form has loaded and saved once, when the owner saves a second time without reloading, then the save succeeds because the client adopted the version the first PUT answered.

## Design Notes

Why `objectVersion` and not the storage layer or `updatedAt`: `workspace-profile.json` is rewritten wholesale by `putWorkspaceProfile`'s own serializer, which is precisely the case `objectVersion`'s docblock reserves it for, and the profile holds no key material — the reason `/api/settings` had to move to an opaque token (AD-23, DW-198) does not apply here. `updatedAt` fails as a version for a never-saved profile (`null`) and at millisecond resolution.

Why the route reads the profile solely for the check: this write is a whole-object REPLACE, so unlike `/api/settings` there is no merge base already in hand. The read is taken immediately before the write, outside the lock — the same residual `checkWritePrecondition`'s docblock already records, not a new one. `getWorkspaceProfile` (not `readOwnProfile`) is the right read because it is what GET seeded the form from, legacy read-through included; using the other would answer 412 for a Wiki whose profile has only ever come from the retired tenant-global file.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/workspace-profile-routes.test.ts src/components/__tests__/workspace-purpose-settings.test.tsx` -- expected: all pass, including the new precondition and invalid-JSON cases.
- `pnpm vitest run src/lib/__tests__/read-only-copy-parity.test.ts src/lib/__tests__/workspace-profile.test.ts` -- expected: pass unchanged; the read-only 403 and the store's own behaviour are untouched.
- `pnpm test` -- expected: full suite green, no regression in the other `If-Match` suites.
- `pnpm lint` -- expected: clean.

## Auto Run Result

Status: done

**Implemented change.** `PUT /api/workspace-profile` gained the two preconditions its siblings already had. A body that is not JSON now gets its own branch answering `{ error: "Invalid JSON body." }` at 400 (DW-140) instead of relaying whatever `JSON.parse` threw. And the route now runs the shared write precondition (DW-145): it publishes `version: objectVersion(profile)` on GET and on the PUT it just wrote, the form returns it as `If-Match`, and a save composed against a superseded profile is refused 412 with `WRITE_CONFLICT_COPY` — one with no usable header, 428 with `WRITE_PRECONDITION_REQUIRED_COPY`. The refusal ladder is 401 → 403 read-only → 500 unreadable registry → 400 invalid JSON → 400 no wiki → 400 wiki drift → 400 invalid field → 500 unreadable profile → 428/412 → write. The pre-existing `wikiId` cross-Wiki guard is untouched and still fires before any version is computed; the two guards are independent.

**Files changed.**
- `src/app/api/workspace-profile/route.ts` — the invalid-JSON branch, the precondition check and its own 500 branch, and `version` on both responses.
- `src/components/WorkspacePurposeSettings.tsx` — a `version` state seeded from GET, cleared on a failed GET, sent as `If-Match`, and re-adopted from the PUT; both refusal sentences reach the existing feedback banner unchanged.
- `src/lib/write-precondition.ts` — docblock only: `objectVersion` now has a production caller and the module says so, with the AD-23/DW-198 contrast kept.
- `src/lib/__tests__/workspace-profile-routes.test.ts` — every I/O-matrix row plus the two 500 branches (21 tests).
- `src/components/__tests__/workspace-purpose-settings.test.tsx` — header formatting, version adoption across two saves, no-precondition cases, and the 412 sentence rendered with the draft intact (20 tests).
- `src/lib/__tests__/workspace-profile.test.ts` — the save/read-back version fixed point, against real bytes.
- `src/lib/__tests__/write-precondition.test.ts` — the new route and form added to the guard's participant registry.

**Review findings.** 5 patches applied (3 medium, 2 low); 1 item deferred (low); 16 rejected. Follow-up review recommended: **true** — patched severities were 0 high, 3 medium, 2 low, giving `3x3 + 1x2 = 11`, at or above the threshold of 5.

**Verification.** `vitest run` full suite: 254 files / 5431 tests passed (5429 before this change; +2 new store cases). Targeted suites — `workspace-profile-routes`, `workspace-purpose-settings`, `write-precondition`, `workspace-profile` — 91 tests passed. `read-only-copy-parity` passed unchanged. `tsc --noEmit` exit 0; `eslint` exit 0. Every row of the I/O & Edge-Case Matrix is covered by a named test that ran and passed. (`pnpm vitest` / `pnpm lint` abort in this environment on an unrelated stray `~/pnpm-workspace.yaml`; the same binaries were run directly from `node_modules/.bin`.)

**Residual risks.**
- The check sits immediately before the write and outside the Wiki lock, so two requests arriving in the same instant can still interleave. That residual is the one `checkWritePrecondition`'s own docblock records for every caller; this closes the window an open editor creates.
- A 412 leaves the form's held version stale, so retries keep refusing until the owner reloads — the recovery `WRITE_CONFLICT_COPY` names, and the same behaviour `useSettings` and `WikiEditor` have. This form has no reload affordance of its own; DW-142 already tracks that.
- The route now refuses any caller that sends no `If-Match`, including a non-form caller, which is the deliberate consequence of using the shared guard ("a guard a caller opts out of by omitting a header is not a guard"). The only in-repo HTTP caller is this form; the wiki seeder reaches the store in-process and never crosses this route.
