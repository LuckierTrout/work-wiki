---
title: 'Workspace-profile store hardening: lock token, write gate, corrupt-file degrade (DW-139, DW-144, DW-266)'
type: 'refactor'
created: '2026-08-20'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `deleteWiki`, `setCurrentWiki` and `sweepOrphanWikiDirectories` still write and
      delete bytes with no `assertWritable`, while their three sibling lifecycle doors
      now refuse.
    evidence: |-
      `deleteWiki` rewrites `wikis.json` and calls `getStorage().deleteDirectory(wikiDirPath(...))`
      — the most destructive operation in the module — and `setCurrentWiki` rewrites the
      registry; neither calls `assertWritable`. `sweepOrphanWikiDirectories` deletes
      directories and is reached from `src/app/api/tasks/scan/route.ts`, which carries no
      `isReadOnly()` gate at all, so it can delete on a timer on a read-only deployment.
      Their HTTP doors do gate (`src/app/api/wikis/[id]/route.ts:63`,
      `src/app/api/wikis/current/route.ts:19`), which is exactly the "route gates, kernel
      does not" shape DW-266 names. Out of scope here: the bundle's intent names
      `putWikiArtifact` and `putWorkspaceProfile`, and neither of these three writes
      through either putter.
    location: >-
      src/lib/wikis.ts (deleteWiki, setCurrentWiki, sweepOrphanWikiDirectories); src/app/api/tasks/scan/route.ts
    severity: medium
  - summary: >-
      `read-only-door-coverage.test.ts` still registers four kernel writers, so the newly
      refusing wiki-lifecycle exports are invisible to the scan that guards tomorrow's doors.
    evidence: |-
      `KERNEL_WRITERS` and `WRITER_EXPORTS` do not name `createWiki`,
      `applyScenarioTemplate`, `renameWiki` or `saveWorkspaceProfile`, and the file's
      staleness guard re-derives only from `KERNEL_WRITERS`. A future `route.ts` importing
      `createWiki` with neither treatment would serve the refusal as a 500 and the scan
      would not notice. Every route that reaches them today gates first, so nothing is
      broken now. Deliberately not fixed here: widening that registry re-derives a
      route-treatment map across the whole app.
    location: >-
      src/lib/__tests__/read-only-door-coverage.test.ts:36
    severity: low
  - summary: >-
      The three wiki lifecycle routes classify a `ReadOnlyError` as 500 rather than mapping
      it to 403.
    evidence: |-
      `src/app/api/wikis/route.ts`, `src/app/api/wikis/[id]/route.ts` and
      `src/app/api/wikis/[id]/template/route.ts` branch only on `ClientInputError` (400) and
      answer 500 for everything else. Every other read-only-aware route carries an
      `isReadOnlyError(error) -> 403` branch beside its early gate (see
      `src/app/api/workbench/artifact/route.ts:68`). Reachable only if `YOPEDIA_READONLY`
      flips between the route's own `isReadOnly()` gate and the kernel call. Route files
      were fenced out of this change.
    location: >-
      src/app/api/wikis/route.ts; src/app/api/wikis/[id]/route.ts; src/app/api/wikis/[id]/template/route.ts
    severity: low
  - summary: >-
      The two putter backstop gates are unreachable through every current caller, so no test
      observes them firing.
    evidence: |-
      `putWikiArtifact`'s `assertWritable` is shadowed by `writeWikiArtifact`'s gate and by
      the three lifecycle entry gates; `putWorkspaceProfile`'s is shadowed by
      `saveWorkspaceProfile`'s. Deleting either leaves the whole suite green, so they are
      pinned by inspection only and could be removed as dead code by a future reader. A
      direct call with a held token under `YOPEDIA_READONLY=1` would pin each.
    location: >-
      src/lib/wikis.ts (putWikiArtifact); src/lib/workspace-profile.ts (putWorkspaceProfile)
    severity: low
  - summary: >-
      Two sibling wiki doors own inline read-only literals with no constant and no parity
      assertion, and `wikiRename` has no client counterpart.
    evidence: |-
      `DELETE /api/wikis/[id]` ("Wikis cannot be deleted while this deployment is
      read-only.") and `PUT /api/wikis/current` ("The active wiki cannot be changed...")
      are spelled inline and compared against nothing, which is the drift
      `read-only-copy-parity.test.ts` exists to prevent. `wikiRename` also has no client
      constant beside a dimmed control, unlike `WIKI_CREATE_READ_ONLY_COPY` and
      `WIKI_TEMPLATE_READ_ONLY_COPY`.
    location: >-
      src/app/api/wikis/[id]/route.ts:63; src/app/api/wikis/current/route.ts:19
    severity: low
baseline_revision: '0f580f51143a5d1267ac5727de9e19e8a6f74b24'
---

<intent-contract>

## Intent

**Problem:** Three write-door claims in the Wiki store are docblock-only. `putWorkspaceProfile` (`src/lib/workspace-profile.ts:175`) is exported unlocked with nothing but prose asking callers to hold `wikis:<tenant>` (DW-139); `putWikiArtifact` (`src/lib/wikis.ts:316`) and `putWorkspaceProfile` are bare `writeFile`s with no `assertWritable`, so seeding and any direct CLI/MCP caller still writes on a read-only deployment even though `read-only.ts` claims every caller inherits the refusal (DW-266); and `readOwnProfile` (`src/lib/workspace-profile.ts:84-94`) rethrows a `SyntaxError` from the very file `putWorkspaceProfile` reads before writing, so a corrupt `workspace-profile.json` blocks the re-template that would have overwritten it (DW-144).

**Approach:** Introduce a minted `WikiLockHeld` token that only `withWikiLock` produces and that `putWorkspaceProfile` demands, so an unlocked caller fails to compile and a wrong-tenant token fails at runtime. Gate the wiki lifecycle writers (`createWiki`, `applyScenarioTemplate`, `renameWiki`, `saveWorkspaceProfile`) before they take the lock, and gate the two unlocked byte putters as backstops, with the refusal sentences owned by `READ_ONLY_REFUSAL`. Degrade a Wiki's OWN unparseable profile to an empty profile with a warn, while still rethrowing genuine storage read failures.

## Boundaries & Constraints

**Always:**
- `withFileLock` stays non-reentrant: a function that already holds `wikis:<tenant>` never takes it again. The token is what proves the hold, not a second acquisition.
- Entry-point gates run BEFORE the lock and before any byte is read, so no compensation path (`discardCreatedWikiDirectory`, `restoreSeededFiles`) ever runs on a read-only deployment.
- Every new `READ_ONLY_REFUSAL` sentence must start with a capital, end with `.`, contain `while this deployment is read-only.`, and be unique — pinned by `read-only-copy-parity.test.ts`.
- Route response bodies and client copy are unchanged. New kernel sentences reuse the exact strings the wiki routes already serve, and a test pins constant == route literal so the duplication cannot drift.
- `wiki-paths.ts` stays a storage-free leaf; the new lock module imports it, never the reverse.

**Block If:**
- A new refusal sentence would change what an owner reads in an existing 403 body or beside a dimmed control.

**Never:**
- Do not extend `KERNEL_WRITERS` in `read-only-door-coverage.test.ts`. That registry is the four page/artifact writers; widening it re-derives a route-treatment map across the whole app and is out of scope.
- Do not gate `deleteWiki`, `setCurrentWiki`, or `sweepOrphanWikiDirectories` — not named by this bundle.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.
- Do not rewrite the wiki route handlers' inline 403 bodies.
- Do not make the Wiki's own profile read swallow non-parse storage errors.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Locked profile write | `withWikiLock(owner, held => putWorkspaceProfile(held, owner, wikiId, input))` | Profile bytes land; `createdAt` preserved from this Wiki's own file | No error expected |
| Token for another tenant | token minted by `withWikiLock("other")`, passed with `owner` | Throws — the token's key does not match `wikiLockKey(owner)` | `Error` naming the mismatch; nothing written |
| Read-only create | `YOPEDIA_READONLY=1`, `createWiki(owner, …)` | Rejects with `READ_ONLY_REFUSAL.wikiCreate`; data dir byte-identical | `ReadOnlyError`, thrown before the lock |
| Read-only re-template | `YOPEDIA_READONLY=1`, `applyScenarioTemplate(…)` | Rejects with `READ_ONLY_REFUSAL.wikiTemplate`; no snapshot, no restore, no bytes | `ReadOnlyError`, thrown before the lock |
| Read-only rename | `YOPEDIA_READONLY=1`, `renameWiki(…)` | Rejects with `READ_ONLY_REFUSAL.wikiRename`; `wikis.json` and `purpose.md` unchanged | `ReadOnlyError`, thrown before the registry write |
| Read-only profile save | `YOPEDIA_READONLY=1`, `saveWorkspaceProfile(…)` | Rejects with `READ_ONLY_REFUSAL.wikiFileWrite`; profile bytes unchanged | `ReadOnlyError`, thrown before the lock |
| Corrupt own profile, read | `wikis/<id>/workspace-profile.json` = `{ not json` | `getWorkspaceProfile` answers `emptyWorkspaceProfile()`, does NOT read through to the legacy singleton | `logger.warn`, no throw |
| Corrupt own profile, write | same file, then `applyScenarioTemplate` / `saveWorkspaceProfile` | Succeeds; template bytes overwrite the corrupt file; `createdAt` stamped fresh | `logger.warn` on the read, no throw |
| Own profile unreadable | a directory in place of `workspace-profile.json` | `getWorkspaceProfile` rethrows | Non-ENOENT, non-parse read errors propagate — writing cannot fix them |

</intent-contract>

## Code Map

- `src/lib/wiki-lock.ts` -- NEW. Owns `WikiLockHeld` (branded by a module-private `unique symbol` carrying the held key), `withWikiLock(owner, fn)` wrapping `withFileLock(wikiLockKey(owner), …)` and minting the token, and `assertWikiLockHeld(held, owner)`. Layering: `wiki-lock` → `lock` + `wiki-paths`; imported by `wikis.ts` and `workspace-profile.ts`, so no cycle (see the `wiki-paths.ts` header diagram).
- `src/lib/wiki-paths.ts:146` -- `wikiLockKey`. Unchanged; after this change its only production caller is `wiki-lock.ts`. Keep the storage-free leaf rule stated in its header.
- `src/lib/lock.ts:22-26,29-40` -- header prose naming `putWikiArtifact`/`putWorkspaceProfile` as "unlocked internal putters" and the `wikis:<tenant>` ordering rule. Needs a sentence about the token.
- `src/lib/workspace-profile.ts:84-94` -- `readOwnProfile`, the DW-144 site. `:96-137` `readLegacyTenantProfile` is the degradation shape to mirror (split read-try / parse-try, `logger.warn`, return a usable value).
- `src/lib/workspace-profile.ts:139-153` -- `getWorkspaceProfile`: `readOwnProfile() ?? readLegacyTenantProfile() ?? empty`. A corrupt own file must return non-null here so it does NOT read through to the retired singleton.
- `src/lib/workspace-profile.ts:155-193` -- `putWorkspaceProfile`, the DW-139 + DW-266 site. `:195-215` `saveWorkspaceProfile` is the locked wrapper.
- `src/lib/wikis.ts:302-322` -- `putWikiArtifact`, the DW-266 site (module-private already, so no token needed — the docblock's own comparison).
- `src/lib/wikis.ts:355-377` -- `seedWikiArtifacts`, the only in-repo caller of `putWorkspaceProfile` outside `workspace-profile.ts`; must thread the token.
- `src/lib/wikis.ts:810-857` / `:894-940` / `:1035-1057` -- `createWiki`, `applyScenarioTemplate`, `renameWiki`: the three lifecycle entry points to gate. `:682` `writeWikiArtifact` is the existing `assertWritable`-before-the-lock template to copy.
- `src/lib/wikis.ts:978-1023` -- `retitlePurpose`: fail-soft `catch` that would SWALLOW a `ReadOnlyError` raised by `putWikiArtifact`. Gating `renameWiki` at its entry is what keeps that swallow unreachable.
- `src/lib/read-only.ts:60-104` -- `READ_ONLY_REFUSAL`. New keys go here; `assertWritable` at `:112` is the thrower.
- `src/app/api/wikis/route.ts:41-46`, `src/app/api/wikis/[id]/route.ts:24-29`, `src/app/api/wikis/[id]/template/route.ts:24-29`, `src/app/api/workspace-profile/route.ts:66-71` -- existing `isReadOnly()` early gates. READ-ONLY EVIDENCE: every HTTP door already refuses first, so the kernel gates are backstops for CLI/MCP/library callers and change no route behaviour. Do not edit these files.
- `src/lib/workbench-tree.ts:120-155` -- `WIKI_READ_ONLY_COPY`, `WIKI_TEMPLATE_READ_ONLY_COPY`, `WIKI_CREATE_READ_ONLY_COPY`: the client sentences already pinned against the route literals.
- `src/lib/__tests__/read-only-copy-parity.test.ts:87-102,118-135` -- pins route literal == client constant, and that every `READ_ONLY_REFUSAL` value names read-only and is unique. New keys must satisfy it.
- `src/lib/__tests__/read-only-kernel-gate.test.ts` -- the byte-snapshot harness (`snapshot()`, env setup that clears `YOPEDIA_READONLY`) to reuse for the new gate cases.
- `src/lib/__tests__/read-only-door-coverage.test.ts:35-40` -- `KERNEL_WRITERS`, deliberately left at four.
- `src/lib/__tests__/wikis.test.ts:705-729` -- source-scan asserting `workspace-profile.ts` contains `withFileLock(wikiLockKey(owner)`. WILL BREAK; must be re-pointed at the new spelling.
- `src/lib/__tests__/workbench-data-version.test.ts:660-670` -- source-scan locating `withFileLock(wikiLockKey(owner)` inside `writeWikiArtifact`/`createWiki`/`applyScenarioTemplate` to prove the bump is outside the lock. WILL BREAK; must accept the new spelling.
- `src/lib/__tests__/workspace-profile.test.ts:137-190` -- existing legacy-degradation and `createdAt` cases; the new DW-144 cases belong beside them.

## Tasks & Acceptance

**Execution:**
- `src/lib/wiki-lock.ts` -- CREATE the token module: a module-private `const WIKI_LOCK_HELD = Symbol(...)`, `export interface WikiLockHeld { readonly [WIKI_LOCK_HELD]: string }` (the value is the held lock key), `withWikiLock<T>(owner, fn: (held: WikiLockHeld) => Promise<T>)` that mints a frozen token and delegates to `withFileLock(wikiLockKey(owner), …)`, and `assertWikiLockHeld(held, owner)` throwing when the token's key !== `wikiLockKey(owner)`. Docblock: the token is compile-time proof plus a tenant-level runtime check, not a re-acquisition — `withFileLock` is still not reentrant. -- DW-139: the exposure is that nothing flags an unlocked caller; a minted token makes the type system flag it.
- `src/lib/workspace-profile.ts` -- (a) `putWorkspaceProfile` takes `held: WikiLockHeld` as its FIRST parameter, calls `assertWikiLockHeld(held, owner)` and `assertWritable(READ_ONLY_REFUSAL.wikiFileWrite)` before touching storage; (b) `saveWorkspaceProfile` gates with the same refusal before the lock and switches to `withWikiLock(owner, (held) => putWorkspaceProfile(held, …))`; (c) `readOwnProfile` splits read from parse — ENOENT → `null`, parse failure → `logger.warn` + `emptyWorkspaceProfile()`, any other read error → rethrow; (d) update the module and function docblocks so the "unlocked on purpose" prose names the token and the corrupt-file degradation. -- DW-139, DW-144, DW-266.
- `src/lib/read-only.ts` -- ADD `wikiCreate`, `wikiTemplate`, `wikiRename`, `wikiFileWrite` to `READ_ONLY_REFUSAL`, each with a docblock naming its owner, the first three using verbatim the sentences `POST /api/wikis`, `POST /api/wikis/[id]/template` and `PATCH /api/wikis/[id]` already serve. Note in the module docblock that these wiki-lifecycle routes keep their inline literals and that parity is pinned by test rather than by import. -- DW-266: one owner per server sentence.
- `src/lib/wikis.ts` -- (a) `putWikiArtifact` opens with `assertWritable(READ_ONLY_REFUSAL.wikiFileWrite)`; (b) `createWiki`, `applyScenarioTemplate`, `renameWiki` each open with `assertWritable` on their own refusal, before the lock and before any read; (c) `seedWikiArtifacts` takes and forwards the `WikiLockHeld`; (d) every `withFileLock(wikiLockKey(owner), …)` in this module becomes `withWikiLock(owner, …)` so one spelling exists and a future author cannot copy a form that cannot mint a token; (e) drop the now-unused `wikiLockKey` import; (f) update the module docblock and the `putWikiArtifact` / `seedWikiArtifacts` / `retitlePurpose` docblocks. -- DW-266 plus the consequence management that keeps `retitlePurpose`'s fail-soft catch from swallowing a refusal.
- `src/lib/lock.ts` -- AMEND the header: the unlocked internal putters are now reached with a `WikiLockHeld` minted by `withWikiLock`, which is the sanctioned way to prove the hold without re-acquiring. -- Keeps the one place that states the ordering rule accurate.
- `src/lib/__tests__/read-only-kernel-gate.test.ts` -- ADD a describe block for the wiki lifecycle doors: `createWiki`, `applyScenarioTemplate`, `renameWiki`, `saveWorkspaceProfile` each reject with their refusal under `YOPEDIA_READONLY` and leave the byte snapshot identical; assert `isReadOnlyError` classifies each. -- Bytes, not just a thrown error, per the file's own standard.
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- ADD assertions that `READ_ONLY_REFUSAL.wikiCreate` / `.wikiTemplate` equal the sentences `wikis/route.ts` and `wikis/[id]/template/route.ts` serve (reuse `servedAs`) and equal `WIKI_CREATE_READ_ONLY_COPY` / `WIKI_TEMPLATE_READ_ONLY_COPY`, and that `.wikiRename` is the sentence `wikis/[id]/route.ts` serves. -- Ties the duplicated literal to the constant so it cannot drift.
- `src/lib/__tests__/workspace-profile.test.ts` -- ADD DW-144 cases (corrupt own profile reads empty rather than throwing and rather than reading through to the legacy singleton; a re-template and a Settings save both overwrite it; a directory in its place still throws) and DW-139 cases (a token minted for another owner is rejected; `putWorkspaceProfile`'s signature takes `WikiLockHeld` first — source-scan pin). -- The I/O matrix rows.
- `src/lib/__tests__/wikis.test.ts` -- REPOINT the DW-22 source scan: `workspace-profile.ts` must contain `withWikiLock(owner`, and `wiki-lock.ts` must contain `withFileLock(wikiLockKey(owner)`; keep the "no `workspace-profile:` key anywhere" scan as is. -- The assertion's intent (the save takes the Wiki key) survives the new spelling.
- `src/lib/__tests__/workbench-data-version.test.ts` -- REPOINT the lock-open lookup so it finds either `withFileLock(wikiLockKey(owner)` or `withWikiLock(owner` and keeps proving the bump follows the lock's close. -- Same guarantee, new spelling.

**Acceptance Criteria:**
- Given a caller that does not hold `wikis:<tenant>`, when it calls `putWorkspaceProfile` without a `WikiLockHeld`, then the project's type check fails — the exposure DW-139 names is no longer invisible to the type system.
- Given `YOPEDIA_READONLY` is set, when any of `createWiki`, `applyScenarioTemplate`, `renameWiki`, `saveWorkspaceProfile` is called directly as a library function, then it throws a `ReadOnlyError` and the data directory is byte-for-byte unchanged.
- Given `YOPEDIA_READONLY` is unset, when the same four operations run, then behaviour is exactly as before this change and every pre-existing test stays green.
- Given a Wiki whose `workspace-profile.json` holds unparseable bytes, when a re-template or a Settings save runs, then it succeeds and replaces the corrupt file.
- Given the wiki routes are untouched, when the read-only copy parity suite runs, then each new `READ_ONLY_REFUSAL` sentence equals the literal its route already serves.

## Design Notes

The token is a brand, not a runtime capability system. `WikiLockHeld` is an interface keyed by a `unique symbol` that `wiki-lock.ts` does not export, so no other module can spell the key and a forgery needs a visible `as` cast. The value it carries is the lock key, which buys the one runtime mistake worth catching — a token minted for tenant A handed to a write for tenant B:

```ts
const WIKI_LOCK_HELD = Symbol("wiki-lock-held");
export interface WikiLockHeld { readonly [WIKI_LOCK_HELD]: string }

export function withWikiLock<T>(owner: string, fn: (held: WikiLockHeld) => Promise<T>): Promise<T> {
  const key = wikiLockKey(owner);
  const held: WikiLockHeld = Object.freeze({ [WIKI_LOCK_HELD]: key });
  return withFileLock(key, () => fn(held));
}
```

`readOwnProfile` degrades on PARSE failure only. A corrupt file is recoverable by the write that was about to overwrite it, so answering `emptyWorkspaceProfile()` unblocks it; a directory in its place or a storage outage is not recoverable by writing, and reporting it as an empty Workspace Purpose would show the owner a blank purpose while storage was merely failing. It answers empty rather than `null` so `getWorkspaceProfile` does NOT read through to the retired tenant-global singleton — a Wiki with a corrupt file HAS a file of its own, and the read-through exists only for Wikis that never wrote one. That also keeps `putWorkspaceProfile`'s `existing?.createdAt` correct: unknowable becomes "stamp now".

## Verification

**Commands:**
- `pnpm exec tsc --noEmit` -- expected: clean; in particular no error at the `putWorkspaceProfile` call sites, proving the token threads correctly.
- `pnpm exec vitest run src/lib/__tests__/workspace-profile.test.ts src/lib/__tests__/wikis.test.ts src/lib/__tests__/read-only-kernel-gate.test.ts src/lib/__tests__/read-only-copy-parity.test.ts src/lib/__tests__/read-only-door-coverage.test.ts src/lib/__tests__/workbench-data-version.test.ts src/lib/__tests__/workspace-profile-routes.test.ts src/lib/__tests__/wikis-routes.test.ts` -- expected: all pass.
- `pnpm test` -- expected: the full suite passes with no new failures.
- `pnpm lint` -- expected: no new errors.

## Auto Run Result

Status: done

### Implemented change

The Wiki store's write doors now enforce what their docblocks claimed. `putWorkspaceProfile` demands a `WikiLockHeld` token that only `withWikiLock` mints, so an unlocked caller fails to compile and a token for another tenant — or one that outlived its critical section — is refused at runtime (DW-139). The three wiki lifecycle entry points and both unlocked byte putters now call `assertWritable`, so a direct CLI, MCP or library caller inherits the read-only refusal the four API routes already answer (DW-266). And a Wiki's OWN unusable `workspace-profile.json` degrades to an empty profile with a warn instead of throwing, so the re-template or Settings save that would have replaced the bad bytes is no longer blocked by them — while genuine storage read failures still propagate (DW-144).

### Files changed

- `src/lib/wiki-lock.ts` (NEW) -- the `WikiLockHeld` brand (module-private `unique symbol` carrying the held key plus a liveness reader), `withWikiLock` as the sole minting site, and `assertWikiLockHeld` with distinct wrong-tenant and expired-proof refusals.
- `src/lib/workspace-profile.ts` -- `putWorkspaceProfile` takes the token first and gates on read-only; `saveWorkspaceProfile` gates before the lock and goes through `withWikiLock`; `readOwnProfile` splits read from parse (ENOENT to `null`, unusable bytes to an empty profile with a warn, any other read error rethrown).
- `src/lib/wikis.ts` -- `putWikiArtifact` gates; `createWiki`, `applyScenarioTemplate` and `renameWiki` gate at their entry before the lock; `seedWikiArtifacts` threads the token; every Wiki-lock call site re-spelled to `withWikiLock`.
- `src/lib/read-only.ts` -- four new refusal sentences (`wikiCreate`, `wikiTemplate`, `wikiRename`, `wikiFileWrite`); module note on why the wiki-lifecycle routes keep their inline literals and how the duplication is pinned.
- `src/lib/lock.ts` -- header records how an unlocked putter now proves the hold.
- `src/lib/wiki-artifact-revisions.ts` -- one stale prose reference to the old lock spelling.
- `src/lib/__tests__/read-only-kernel-gate.test.ts` -- new describe for the four gated wiki writers (byte-snapshot per door plus a writable control) and a source-order pin that the gate precedes the lock.
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- the new kernel sentences equal the literals their routes serve and the client constants beside the dimmed controls; the Settings-vs-`wikiFileWrite` divergence recorded.
- `src/lib/__tests__/workspace-profile.test.ts` -- DW-144 cases (corrupt own profile reads empty, does not read through to the legacy singleton, is overwritten by both a re-template and a Settings save, still throws when unreadable rather than merely unusable, schema-rejected bytes degrade too) and DW-139 cases (wrong-tenant token, expired token, signature pin).
- `src/lib/__tests__/wikis.test.ts` -- DW-22 scan re-pointed at the new spelling and extended to ban the bare `withFileLock(… wikiLockKey(` form outside `wiki-lock.ts`.
- `src/lib/__tests__/workbench-data-version.test.ts` -- lock-open lookup accepts the new spelling and defaults cleanly when neither matches.

### Review findings breakdown

- Patches applied: 8 (medium 1, low 7) -- see the Review Triage Log above.
- Items deferred: 5 (medium 1, low 4) -- recorded in frontmatter `deferred`.
- Items rejected: 6 -- `Symbol.for` for the brand key (breaks the `unique symbol` typing and makes the brand forgeable; tokens never cross module-graph copies); preserving corrupt profile bytes to a `.corrupt` sidecar and surfacing it to the owner (new feature, outside the intent); one-`it`-per-door test granularity; the `putWorkspaceProfile` signature source-scan called brittle (it is a deliberate pin); a redundant `read.purpose` assertion; and "gating before input validation changes which error wins" (deliberate and matching `writeWikiArtifact`'s existing placement — a read-only deployment refuses regardless of body validity).
- Follow-up review recommendation: patched counts high 0, medium 1, low 7; score = 3x1 + 1x7 = 10, which is 5 or more, so `followup_review_recommended: true`.

### Verification performed

- `npx tsc --noEmit` -- clean (`pnpm exec` is broken in this checkout, so the `npx`/`npm` equivalents were used).
- `npx vitest run` over the eight suites named in Verification -- 195 tests, all pass.
- `npm test` -- 254 files / 5414 tests pass, no new failures (5410 before this change; +4 new cases).
- `npm run lint` -- no errors; only the pre-existing `jsx-ast-utils` notices.
- Every I/O matrix row is covered by a named test that ran and passed, including the two DW-139 token cases and the four DW-144 corrupt-file cases.
- The two new source-scan pins were mutation-checked: reverting `sweepOrphanWikiDirectories` to the bare lock spelling fails the P6 scan, and moving `renameWiki`'s gate inside the lock body fails the P7 ordering pin.

### Residual risks

- The two putter backstops (`putWikiArtifact`, `putWorkspaceProfile`) are unreachable through every current caller because the entry gates fire first, so they are pinned by inspection rather than by a test and could be removed by a future reader as dead code. Deferred.
- `deleteWiki`, `setCurrentWiki` and `sweepOrphanWikiDirectories` remain ungated at the kernel — `deleteWiki` is the destructive one, and the scan route that reaches the sweep has no read-only gate at all. Deferred, and named explicitly in the module docblock rather than left implied.
- `READ_ONLY_REFUSAL.wikiCreate`/`.wikiTemplate`/`.wikiRename` duplicate literals the routes still spell inline. The duplication is pinned by `read-only-copy-parity.test.ts` rather than removed, because route bodies were out of scope.
- The three wiki lifecycle routes would serve a kernel `ReadOnlyError` as a 500 rather than a 403, reachable only if the flag flips mid-request. Deferred.
