---
title: 'DW-137 — backfill the legacy tenant profile, then retire the read-through'
type: 'refactor'
created: '2026-08-20'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred: []
baseline_revision: '01cd2c1fd08a05fb9c0b7e64901f841b0b8ecfc3'
---

<intent-contract>

## Intent

**Problem:** `getWorkspaceProfile` still chains `readOwnProfile ?? readLegacyTenantProfile ?? empty`, so in a tenant that holds `tenants/<t>/workspace-profile.json` ONE purpose appears under every pre-change Wiki, forever — the migration courtesy has no end date, no backfill and no removal milestone (DW-137).

**Approach:** Write a one-time, idempotent backfill that copies the legacy tenant profile onto every Wiki lacking its own, run it from the maintenance scan, and delete the read-through and `legacyProfilePath` from `workspace-profile.ts` — the legacy address survives only inside the migration module.

## Boundaries & Constraints

**Always:**
- The backfill writes ONLY to Wikis with no own profile file. A Wiki whose own file exists — usable or corrupt — is left untouched.
- Copied bytes preserve the legacy `createdAt`/`updatedAt`: the backfill relocates an existing profile, it does not author a new one.
- Every profile write stays inside `withWikiLock(owner, …)` and goes through a putter demanding `WikiLockHeld`; `assertWritable(READ_ONLY_REFUSAL.wikiFileWrite)` is called BEFORE the lock is taken.
- The backfill is fail-soft end to end: an unusable legacy file, a per-Wiki failure, or a read-only deployment answers 0 with a warn, never a throw that could fail a scan.
- After this change no live read path — `getWorkspaceProfile`, `GET /api/workspace-profile`, `workspace-guidance.ts` — knows the legacy address.

**Block If:**
- The legacy read cannot be given a single owning module without an import cycle (`workspace-profile.ts` must not import `wikis.ts`).

**Never:**
- Never re-add a read-through, a lazy on-read migration, or a second `workspace-profile.json` literal outside the migration module.
- Never overwrite a Wiki's own profile, and never delete the legacy file before its bytes have landed on every Wiki in a non-empty registry.
- Never change the profile schema, the Settings UI contract, or `putWorkspaceProfile`'s existing stamping rules.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Nothing to migrate | No legacy file | 0 copied; no write, no delete | No error expected |
| Ordinary backfill | Legacy file, wiki A has own profile, wiki B does not | 1 copied — B's file equals the legacy profile, timestamps included; A untouched; legacy file removed | No error expected |
| Second run | State after the row above | 0 copied; nothing written | No error expected |
| Corrupt own file | Legacy file, wiki B's own file is unparseable | 0 copied — B HAS a file; legacy file kept (a Wiki still lacks nothing) | No error expected |
| Unusable legacy | `tenants/<t>/workspace-profile.json` is bad JSON or a directory | 0 copied; legacy file left alone | Warn, resolve 0 |
| No wikis yet | Legacy file, empty registry | 0 copied; legacy file KEPT for a later scan | No error expected |
| Read-only deployment | `YOPEDIA_READONLY=1`, legacy file present | 0 copied; no bytes written or deleted | No error expected |
| Per-Wiki write failure | Legacy file, one Wiki's write throws | The other Wikis still copied; count reflects successes; legacy file KEPT | Warn per Wiki, continue |
| No wiki + guidance | Owner with legacy file and no Wiki asks for guidance | `buildWorkspaceGuidance` returns `""` | No error expected |
| No wiki + Settings GET | Same owner opens Settings | `profile` is `emptyWorkspaceProfile()`, `wiki: null` | No error expected |

</intent-contract>

## Code Map

- `src/lib/workspace-profile.ts` — `legacyProfilePath` :72, `readLegacyTenantProfile` :169, and the read-through chain in `getWorkspaceProfile` :212-220 are what this story deletes. `toProfile` :88 is the shared parser (promote to an export for the migration module); `readOwnProfile` :130 already answers `null` only for ENOENT — that is the "lacks its own" predicate. `putWorkspaceProfile` :251 is the guarded putter to model the new copier on (`assertWikiLockHeld` then `assertWritable`, then `wikiProfilePath`). Module header and several docblocks describe the read-through and must be rewritten, not left stale.
- `src/lib/wiki-lock.ts` — `withWikiLock` is the ONLY sanctioned way to take `wikis:<tenant>`; it mints the `WikiLockHeld` the putters demand. `withFileLock` is not reentrant, so the backfill takes the lock ONCE and threads the token per Wiki.
- `src/lib/wikis.ts` — `listWikis(owner)` :827 enumerates the registry. `sweepOrphanWikiDirectories` :1332 is the precedent for a locked, scheduled maintenance operation. This module imports `workspace-profile.ts`, so the backfill (which needs both) must live in its own module above them.
- `src/lib/wiki-paths.ts` — `wikiProfilePath(owner, wikiId)` :133 is the one live address helper. Storage-free leaf; do not import back into it.
- `src/lib/maintenance.ts` — `sweepOrphanWikiDirs` :316 is the fail-soft wrapper shape to copy (`getOwnerHandle()` guard, `await import(...)` to keep the module graph loose, `logger.error` → 0).
- `src/app/api/tasks/scan/route.ts` — the only scheduled trigger. `orphanWikiDirsRemoved` :164-171 shows where a byte-touching step goes: inside `if (!forceDry)`, not gated by `AUTONOMOUS_MAINTENANCE`, reported in the JSON body and the `logger.info` line.
- `src/app/api/workspace-profile/route.ts` :51,:64-69 — GET's no-Wiki legacy branch; becomes `emptyWorkspaceProfile()`.
- `src/lib/workspace-guidance.ts` :21,:28-38 — the no-Wiki legacy branch; becomes `return ""`.
- `src/lib/__tests__/workspace-profile.test.ts` — legacy cases at :104 (read-through), :146 (unusable legacy), :173 (legacy `createdAt`), :212 (corrupt-own does not read through), :299 (schema-rejected + legacy), and the guidance case at :543 ("still renders a legacy purpose").
- `src/lib/__tests__/workspace-profile-routes.test.ts` :10,:27,:58,:100,:195,:388 — mocks and cases for the removed export.
- `src/lib/__tests__/wiki-schema-edit.test.ts` :1110-1121 — asserts `workspace-profile.ts` holds EXACTLY ONE `workspace-profile.json` literal (the legacy one). Becomes 0; the migration module becomes the one place that spells it.
- `src/lib/__tests__/read-only-kernel-gate.test.ts` :429-459 — the "gate precedes the lock" source scan and its explicit `[module, fn]` list.
- `src/lib/__tests__/scan-route.test.ts` :4-10,:63-77 — `vi.mock("@/lib/maintenance", …)` is an explicit factory; a new export called by the route MUST be added there or it is `undefined` at call time.
- `src/lib/__tests__/wikis.test.ts` :705-782 — scans all of `src/` for modules taking the wiki key outside `wiki-lock.ts`; the new module must use `withWikiLock`.
- `src/components/__tests__/workspace-purpose-settings.test.tsx` :347 — the "legacy tenant-wide purpose" client case; the route can no longer produce that body.

## Tasks & Acceptance

**Execution:**
- `src/lib/workspace-profile.ts` -- delete `legacyProfilePath` and `readLegacyTenantProfile`; reduce `getWorkspaceProfile` to `readOwnProfile ?? emptyWorkspaceProfile`; export the parser (`toProfile` → `parseStoredWorkspaceProfile`); add `copyWorkspaceProfileIfAbsent(held, owner, wikiId, profile)` — `assertWikiLockHeld`, `assertWritable`, skip when `readOwnProfile` is non-null, else write the profile verbatim and return whether it wrote; rewrite the module header and the `readOwnProfile`/`getWorkspaceProfile`/`putWorkspaceProfile` docblocks that describe the read-through -- the read-through is what DW-137 ends, and stale prose is the next author's map.
- `src/lib/workspace-profile-backfill.ts` -- NEW. Owns the legacy address and its never-throwing reader, plus `backfillLegacyWorkspaceProfiles(owner)`: return 0 on read-only or absent/unusable legacy or empty registry; otherwise gate, then `withWikiLock` once, copy onto each Wiki lacking its own (per-Wiki try/catch + warn), and delete the legacy file only when no Wiki was skipped by failure -- one module for the whole migration, so retiring it later is one delete.
- `src/lib/workspace-guidance.ts` -- drop the legacy import and the no-Wiki fallback; no Wiki now renders nothing -- the read-through is gone, so guidance must not keep a second copy of it.
- `src/app/api/workspace-profile/route.ts` -- GET with no Wiki answers `emptyWorkspaceProfile()`; drop the import and rewrite the branch comment -- the form is disabled either way and there is no legacy address left to read.
- `src/lib/maintenance.ts` -- add `backfillWorkspaceProfiles()`, the fail-soft wrapper beside `sweepOrphanWikiDirs` (owner guard, dynamic import, `logger.error` → 0) -- byte-writing upkeep belongs beside the other scan steps, not inside the read-only `scanForMaintenance`.
- `src/app/api/tasks/scan/route.ts` -- call it inside `if (!forceDry)`, report `workspaceProfilesBackfilled` in the body and the info log, and document it in the route docblock -- this scan is the migration's only scheduled trigger.
- `src/lib/__tests__/workspace-profile-backfill.test.ts` -- NEW. Cover every row of the I/O matrix against a real temp-`DATA_DIR` provider, including timestamp preservation, idempotence on a second run, and that a corrupt own profile is not overwritten.
- `src/lib/__tests__/workspace-profile.test.ts` -- delete the legacy read-through cases and the legacy half of the DW-144 cases; keep every corrupt-own-file assertion; replace the guidance legacy case with one pinning `""` for an owner with a legacy file and no Wiki -- the deleted behavior must not leave a green test claiming it.
- `src/lib/__tests__/workspace-profile-routes.test.ts` -- drop the `readLegacyTenantProfile` mock, its import and the no-Wiki legacy case; assert GET answers the empty profile with `wiki: null`; retitle the version case off "legacy read-through".
- `src/lib/__tests__/wiki-schema-edit.test.ts` -- expect ZERO `workspace-profile.json` literals in `workspace-profile.ts` and exactly one in `workspace-profile-backfill.ts`, with the comment updated -- the invariant is "one literal, in the migration module".
- `src/lib/__tests__/read-only-kernel-gate.test.ts` -- add `workspace-profile-backfill` / `backfillLegacyWorkspaceProfiles` to the gate-precedes-lock list.
- `src/lib/__tests__/scan-route.test.ts` -- add the new export to the maintenance mock factory and assert it runs on a normal scan, is skipped under `?dry=1`, and is reported in the body.
- `src/components/__tests__/workspace-purpose-settings.test.tsx` -- retitle/reword the legacy case as the client's own no-Wiki guard (a body with no wiki is never dated "Last saved") -- the client guard survives; only the claim that the route produces that body goes.

**Acceptance Criteria:**
- Given a tenant with a legacy profile and Wikis both with and without their own file, when the maintenance scan runs, then only the Wikis lacking a file are written, their bytes match the legacy profile including `createdAt`/`updatedAt`, and the legacy file is gone afterwards.
- Given the same tenant on a read-only deployment, when the scan runs, then no file under `tenants/<t>/` changes and the scan still completes.
- Given a Wiki that has never had its own profile and a legacy file still present, when `getWorkspaceProfile` is called before any backfill, then it answers the empty profile — the read-through no longer exists.
- Given `grep -rn "readLegacyTenantProfile\|legacyProfilePath" src`, when run after the change, then the only hits are inside `src/lib/workspace-profile-backfill.ts` and its test.
- Given `?dry=1`, when the scan runs, then the backfill does not run and `workspaceProfilesBackfilled` is 0.

## Design Notes

Layering forces the split: `wikis.ts` imports `workspace-profile.ts`, so the module that needs `listWikis` AND the profile store cannot be either of them — the same reason `workspace-guidance.ts` exists. The new module sits above both and is the only place the retired address is spelled.

The lock is taken ONCE for the whole pass and the token threaded per Wiki, because `withFileLock` is not reentrant:

```ts
return withWikiLock(owner, async (held) => {
  for (const wiki of wikis) {
    if (await copyWorkspaceProfileIfAbsent(held, owner, wiki.id, legacy)) copied += 1;
  }
});
```

Deleting the legacy file at the end is what gives DW-137 the removal milestone it lacked: without it a Wiki that later loses its own file would silently inherit a purpose from a retired era, and every scan forever would re-enumerate the tenant. It is deleted only after a clean pass over a non-empty registry, so the bytes are on every Wiki before they leave their old home.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/workspace-profile-backfill.test.ts src/lib/__tests__/workspace-profile.test.ts src/lib/__tests__/workspace-profile-routes.test.ts src/lib/__tests__/scan-route.test.ts src/lib/__tests__/wiki-schema-edit.test.ts src/lib/__tests__/read-only-kernel-gate.test.ts src/lib/__tests__/wikis.test.ts` -- expected: all pass
- `pnpm vitest run src/components/__tests__/workspace-purpose-settings.test.tsx` -- expected: all pass
- `pnpm exec tsc --noEmit` -- expected: no errors
- `pnpm lint` -- expected: no new errors

## Auto Run Result

Status: done

**Implemented change.** DW-137: the tenant-global Workspace Purpose read-through is gone, replaced by a one-time backfill that relocates `tenants/<t>/workspace-profile.json` onto every Wiki lacking a file of its own and then deletes it. `getWorkspaceProfile` now reads a Wiki's own file or answers empty; the Settings GET and `buildWorkspaceGuidance` no longer know the legacy address at all. The migration runs from `POST /api/tasks/scan`, gated like the orphan-directory sweep: suppressed by `?dry=1`, not by `AUTONOMOUS_MAINTENANCE`, and reported as `workspaceProfilesBackfilled`.

**Files changed.**
- `../../src/lib/workspace-profile-backfill.ts` (new) — the whole migration: the only spelling of the retired address, a never-throwing reader, and `backfillLegacyWorkspaceProfiles(owner)` (read-only gate before the lock, one `withWikiLock` for the pass, per-Wiki failure isolation, conservative delete).
- `../../src/lib/workspace-profile.ts` — read-through, `legacyProfilePath` and `readLegacyTenantProfile` deleted; `toProfile` promoted to `parseStoredWorkspaceProfile`; new `copyWorkspaceProfileIfAbsent` (guarded, writes only into a gap, preserves timestamps).
- `../../src/lib/workspace-guidance.ts` — no Wiki now renders nothing.
- `../../src/app/api/workspace-profile/route.ts` — GET with no Wiki answers the empty profile.
- `../../src/lib/maintenance.ts` — fail-soft `backfillWorkspaceProfiles()` beside `sweepOrphanWikiDirs`.
- `../../src/app/api/tasks/scan/route.ts` — calls it inside `if (!forceDry)` and reports the count.
- Tests: new `../../src/lib/__tests__/workspace-profile-backfill.test.ts` (13 cases); `maintenance.test.ts`, `workspace-profile.test.ts`, `workspace-profile-routes.test.ts`, `scan-route.test.ts`, `wiki-schema-edit.test.ts`, `read-only-kernel-gate.test.ts` and `workspace-purpose-settings.test.tsx` updated.

**Review findings.** 9 patches applied (2 medium, 7 low); 0 deferred; 9 rejected. Rejected as out of scope or already answered by precedent: the unbounded-but-`MAX_WIKIS`-capped lock hold (same shape as the orphan sweep), the operator README (which documents no other byte-touching scan step), the DW-137 ledger entry (orchestrator-owned), a second trigger to close the deploy-to-first-scan window (the intent explicitly authorized "on read **or** as a maintenance op"), multi-tenant enumeration (single-owner invariant), naming, the 412 an owner with an open Settings form could see, richer ops signalling, and a grace period or rename in place of the delete.

**Follow-up review recommendation.** Patched: 0 high, 2 medium, 7 low → score `3x2 + 1x7 = 13` (>= 5) → `true`.

**Verification.**
- `./node_modules/.bin/vitest run` — 255 files / 5446 tests, all pass.
- `./node_modules/.bin/tsc --noEmit` — clean.
- `./node_modules/.bin/next lint --dir src` — no warnings or errors.
- Acceptance grep: `readLegacyTenantProfile|legacyProfilePath` hits only `src/lib/workspace-profile-backfill.ts`.
- Matrix audit: all ten I/O rows are covered by tests that ran and passed (rows 1-8 in `workspace-profile-backfill.test.ts`, row 9 in `workspace-profile.test.ts` and the backfill suite, row 10 in `workspace-profile-routes.test.ts`).
- `pnpm` itself is currently broken in this checkout ("packages field missing or empty"), so the spec's `pnpm ...` commands were run through `./node_modules/.bin/` — same binaries, same config.

**Residual risks.**
- Between deploy and the first successful scan, a pre-change Wiki with no file of its own reads an empty purpose. A deployment with no service token, no cron, or no `NEXT_PUBLIC_OWNER_HANDLE` never migrates at all — the scan is the migration's only trigger.
- An owner holding a legacy file who has not created a Wiki yet loses that purpose from Settings and from every prompt permanently: there is nothing to copy it onto, and no read path knows the address.
- A tenant whose Wikis all already have their own profiles never satisfies the delete condition, so the legacy file is retained and re-read once per scan indefinitely. Deliberate — deleting bytes no Wiki carries is unrecoverable.
