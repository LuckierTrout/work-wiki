---
title: 'DW-622/DW-623 — honest config read on /api/status, and setText through the shared text decision'
type: 'bugfix'
created: '2026-09-01'
status: 'done'
baseline_revision: 'acf565cc9175f2484d8a6a1d7a5e25a1a82a40a2'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** `GET /api/status` awaits `loadConfig()` (`src/app/api/status/route.ts:7`), which flattens `readStoredConfig`'s `unreadable` answer to `{}`, so a config that exists but could not be parsed is served exactly like one that was never saved — the conflation DW-549 closed for `yopedia status` and left standing on the web (DW-622). Separately, `applyWorkbenchSettings`'s `setText` resolves a non-string to `""` and then reads `""` as a delete (`src/lib/config.ts:2259-2262`), so the `workbench` half of a settings body would erase a stored key where the flat half — through `flatTextFieldAction` — leaves it untouched (DW-623).

**Approach:** Read through `readConfig()` in the status route and report the unreadable store as its own flag on the served body; collapse `setText` onto the already-shared `flatTextFieldAction` decision so both halves of the settings body answer identically about the same stored key.

## Boundaries & Constraints

**Always:**
- The status body carries a BOOLEAN caveat only. No error text, no parser snippet, no bytes: the config file holds `customApiKey`, `embeddingApiKey` and `firecrawlApiKey`, and V8's `JSON.parse` message quotes the offending bytes back (AD-23 — the same rule that keeps the R2 etag internal). The detail is already `logger.warn`-ed inside `readStoredConfig`.
- One read, one round-trip: `readConfig()` replaces `loadConfig()`, is not added beside it, and warms the sync cache identically before `getProviderInfo()` runs (the DW-502 warm this route exists to perform is unchanged).
- `readConfig()` returns its failure rather than throwing, so the route's existing 500 catch branch keeps its meaning and its `satisfies` guard.
- Every reachable `setText` arm behaves exactly as today: absent keeps, `null`/`""`/whitespace deletes, any other string stores TRIMMED.
- `flatTextFieldAction` stays the single expression of that decision — `config.ts` imports it, it is not re-implemented there.

**Block If:**
- Serving the caveat would require `ProviderInfo` itself to gain the field: `POST /api/settings/test` spreads `getProviderInfo()` and performs no config read, so it could not answer one — HALT rather than making a shared type carry a field one of its two producers must guess at.

**Never:**
- Do not change `/api/status` status codes (no 503 arm) or the shape `getProviderInfo()` returns.
- Do not add the flag to `ProviderInfo` in `src/lib/types.ts`, to `useSettings`'s `ProviderStatus`, or to the settings page — `GET /api/settings` already answers 503 with `CONFIG_UNREADABLE_COPY` for this condition, and that surface is not conflating anything.
- Do not widen `setText`'s parameter type; the non-string arm stays unreachable by construction and is exercised through `flatTextFieldAction`'s own suite.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Store readable, or absent (ENOENT) | `readConfig()` → `status: "ok"` | 200; body is the whole `ProviderInfo` plus `configUnreadable: false` | No error expected |
| Store unreadable (bad JSON, non-object, storage failure) | `readConfig()` → `status: "unreadable"` | 200; body is the env-resolved `ProviderInfo` plus `configUnreadable: true`, and carries no error text | Detail stays in the existing `logger.warn` |
| Resolver throws after the read | `getProviderInfo()` throws | 500; the complete hand-written `ProviderInfo` body, plus `configUnreadable` as read and the existing `error` string | 500 unchanged |
| Badge sees the caveat | `/api/status` → `configUnreadable: true` | One caveat line renders in BOTH the connected and the not-configured states | No error expected |
| `setText` non-string (unreachable by types) | `applyWorkbenchSettings({embeddingModel:"m"}, {embeddingModel: 42} as …)` | The stored key is LEFT AS IT WAS | No error expected |
| `setText` reachable arms | absent / `null` / `""` / `"  x  "` | keep / delete / delete / store `"x"` | No error expected |

</intent-contract>

## Code Map

- `src/app/api/status/route.ts:1-31` — the whole route. Line 7 is the `await loadConfig()` to replace; the catch branch's `satisfies ProviderInfo & { error: string }` (line 27) is the convention to extend, not remove. A Next `route.ts` may export nothing but its HTTP verbs, so the body type is a local, non-exported `type`.
- `src/lib/config.ts:1004` `readConfig()` → `readStoredConfig()` (`:874`): ENOENT is `ok` with `{}`; parse failure, non-object parse and any other storage error are `{ status: "unreadable", error }`, each already `logger.warn`-ed. It primes `_configCache` on the ok path exactly as `loadConfig()` does (`:1036` is the lossy wrapper).
- `src/lib/config.ts:2255-2266` — `applyWorkbenchSettings`'s `setText`, the closure to collapse; its ~25 call sites follow at `:2324-2390`.
- `src/lib/workbench-settings.ts:1739-1778` — `FlatTextFieldAction` / `flatTextFieldAction`, the shared decision and its docblock. `config.ts` already imports from this module (`src/lib/config.ts:12-26`) and the dependency runs one way, so no cycle.
- `src/app/api/settings/route.ts:157-184` — `applyFlatTextField`, the existing "decision in the module, mutation at the key" split to mirror.
- `src/components/StatusBadge.tsx:6-20, 55-72` — the local hand-duplicated `ProviderInfo` interface and the two render states; `ollamaBaseUrlIssue` (DW-402) is the precedent for a served caveat this component renders.
- `src/components/__tests__/status-badge.test.tsx` — dom project; `status()` fixture at `:22` and `stubFetch()` at `:33` are the harness to reuse.
- `src/lib/__tests__/workbench-settings.test.ts:3167-3229` — the `applyWorkbenchSettings` describe; `:1933` is `flatTextFieldAction`'s own describe.
- `src/app/api/__tests__/` — node project, holds `mcp-route.test.ts`; the new route suite belongs here as `*.test.ts`.
- Read-only evidence: `POST /api/settings/test` spreads a whole `ProviderInfo` (`src/hooks/useSettings.ts:88-97` states the contract), which is why the flag must not join that type.

## Tasks & Acceptance

**Execution:**
- `src/app/api/status/route.ts` -- replace `await loadConfig()` with `await readConfig()`, carry `configUnreadable: read.status !== "ok"` onto both response bodies through a local `type` extending `ProviderInfo`, and document why the flag is a boolean (secret material) and why it is not on `ProviderInfo` -- the honest read is the fix; the flag is what makes it observable.
- `src/lib/config.ts` -- import `flatTextFieldAction` and rewrite `setText` as `ignore` / `delete` / `{ store }`, replacing the `typeof … ? … : ""` collapse; note that the reachable arms are unchanged and the non-string arm now leaves the key alone, matching the flat branch -- DW-623's symmetry.
- `src/components/StatusBadge.tsx` -- add `configUnreadable: boolean` to the local interface and render one caveat line in both the connected and not-configured states -- the browser operator is the reader `/api/status` actually has.
- `src/app/api/__tests__/status-route.test.ts` -- NEW node suite mocking `@/lib/config` and `@/lib/llm`: cover the readable, unreadable and resolver-throws rows, and assert the unreadable body carries no error text.
- `src/components/__tests__/status-badge.test.tsx` -- extend the fixture with the flag and cover the caveat in both render states.
- `src/lib/__tests__/workbench-settings.test.ts` -- add the non-string case to the `applyWorkbenchSettings` describe (cast through `unknown`), pinning that the stored key survives.

**Acceptance Criteria:**
- Given a stored config whose bytes do not parse, when `GET /api/status` is served, then the response is 200 and `configUnreadable` is `true` while the other five fields still report what the environment resolves.
- Given a readable or absent store, when `GET /api/status` is served, then the body is byte-for-byte what it was before plus `configUnreadable: false`, and the config is read exactly once.
- Given `/api/status` answers `configUnreadable: true`, when `StatusBadge` renders — connected or not configured — then the caveat line is present, and it names no file, error or value.
- Given a settings body whose `workbench` half carries a non-string for a text field, when `applyWorkbenchSettings` merges it, then the stored key is unchanged — the same answer `flatTextFieldAction` gives the flat half.

## Spec Change Log

_No bad_spec loopback occurred; nothing amended._

## Review Triage Log

### 2026-09-01 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 0, low 6)
- defer: 0
- reject: 12: (high 0, medium 0, low 12)
- addressed_findings:
  - `[low]` `[patch]` `CONFIG_UNREADABLE_BADGE_COPY` claimed the reading "reflects the environment only", which is false on a long-lived server: `readStoredConfig` does not re-prime the cache on its unreadable branch, so the previous generation can still be warm behind `loadConfigSync()`. Reworded to "may not reflect them" and the warm-cache reason recorded in the constant's docblock.
  - `[low]` `[patch]` The 500 branch reported `configUnreadable: false` when the awaited read itself rejected — "unknown" served as "clean". The flag now starts `true` and is overwritten only by a read that answered; new route case pins it.
  - `[low]` `[patch]` `applyWorkbenchSettings`'s clear-on-switch still read `patch.embeddingProvider` raw, so a non-string deleted `embeddingApiKey` and `embeddingBaseUrl` in the same merge where `setText` now leaves the provider alone. Routed through `flatTextFieldAction`; no reachable arm moves.
  - `[low]` `[patch]` The whitespace-only delete arm was pinned only through `flatTextFieldAction`'s suite, not through the merge that was rewritten. Added to the `applyWorkbenchSettings` describe.
  - `[low]` `[patch]` Test-fixture hygiene: dropped `okRead`'s unused `config` parameter, and the badge leak case now asserts on rendered text as well as on the exported constant.
  - `[low]` `[patch]` Comment accuracy: `StatusBadge` records that nothing imports it today (the live reader of the flag is the `/api/status` body) and why the mounted settings page has no conflation to fix; the route's `StatusBody` docblock names the tension with `CONFIG_UNREADABLE_COPY`'s no-oracle rule and why it does not bite here.

## Design Notes

The flag is route-local because it is a READ-TIME fact, not a resolver one: `getProviderInfo()` is synchronous over the cache and cannot know how the last read went, and the route's catch branch already sets the precedent for a field this endpoint adds beside `ProviderInfo`.

```ts
type StatusBody = ProviderInfo & { configUnreadable: boolean };
```

`setText`, after the collapse — the decision is imported, only the typed mutation is local:

```ts
const action = flatTextFieldAction(value);
if (action === "ignore") return;
if (action === "delete") { delete updated[key]; return; }
(updated as Record<string, unknown>)[key as string] = action.store;
```

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/app/api/__tests__/status-route.test.ts src/lib/__tests__/workbench-settings.test.ts` -- expected: all pass, including the new rows.
- `pnpm exec vitest run --project dom src/components/__tests__/status-badge.test.tsx` -- expected: all pass.
- `pnpm test` -- expected: full suite green (source scans and brand/english copy scans included).
- `pnpm lint` -- expected: no new findings.

## Auto Run Result

Status: done

**Implemented change.** `GET /api/status` now reads through `readConfig()` instead of `loadConfig()` and carries a route-local `configUnreadable` boolean on both its 200 and 500 bodies, so a config that exists and could not be parsed is no longer served exactly like one that was never saved (DW-622). `applyWorkbenchSettings`'s `setText` — and, after review, its clear-on-switch input — now ask `flatTextFieldAction`, so the `workbench` half of a settings body answers about a non-string exactly as the flat half does: the stored key is left alone rather than erased (DW-623).

**Files changed.**
- `src/app/api/status/route.ts` — `readConfig()` in place of `loadConfig()`; `configUnreadable` on both bodies through a local `StatusBody` type; the flag starts `true` so a rejecting read is inert rather than wrong.
- `src/lib/config.ts` — `setText` collapsed onto `flatTextFieldAction`; the embedding clear-on-switch asks the same question; `loadConfigSync`'s docblock no longer names `loadConfig()` as what the status route awaits.
- `src/components/StatusBadge.tsx` — `configUnreadable` on the local wire interface and one shared caveat sentence rendered in both states; records that nothing imports this component today.
- `src/app/api/__tests__/status-route.test.ts` — NEW, 10 cases: read door and call count, read-before-resolve ordering, readable/absent/unreadable/storage-failure, the unreadable body's exact key set (no error text, no bytes), and the three 500 rows.
- `src/components/__tests__/status-badge.test.tsx` — fixture plus 4 cases across both render states.
- `src/lib/__tests__/workbench-settings.test.ts` — the non-string arm through the merge (including the untouched credential pair) and the whitespace-only delete.

**Review findings.** 6 patches applied (all low), 0 deferred, 12 rejected. Rejected as noise or as not this change's problem: `status !== "ok"` exhaustiveness (fails safe, matches the CLI), the three hand-duplicated views of this body, `useSettings`'s `ProviderStatus` docblock (still true — `/api/status` does serve a whole `ProviderInfo`), the latent `handleTest` overwrite (unreachable while `ProviderStatus` omits the field), adopting the flag on the settings page (that page reports the condition through `GET /api/settings`'s 503 and never renders a verdict over an unreadable store), the badge's missing live region and copy style (consistent with the file's existing lines), the unguarded boolean arms of `applyWorkbenchSettings` (pre-existing sibling arms behind the same validator), and a combined-caveat render case.

**Follow-up review recommendation.** Patched this pass: high 0, medium 0, low 6 → score `3×0 + 6 = 6` ≥ 5 → `true`.

**Verification.**
- `pnpm exec vitest run --project node src/app/api/__tests__/status-route.test.ts src/lib/__tests__/workbench-settings.test.ts` — 279 passed.
- `pnpm exec vitest run --project dom src/components/__tests__/status-badge.test.tsx` — 7 passed.
- `pnpm exec tsc --noEmit` — clean.
- `pnpm test` — 360 files, 8851 passed, 1 skipped.
- `pnpm lint` — unchanged from baseline (only the pre-existing `jsx-ast-utils` notices).
- Matrix audit: every I/O row is covered by a case that ran and passed in the runs above.

**Residual risks.**
- `src/lib/__tests__/storage-fs.test.ts > reapStrandedScratchFiles` fails intermittently under full-suite parallel load (5 s timeout, `ENOTEMPTY` on a temp dir). It passes standalone every time and passed in the green full runs above; it touches filesystem scratch reaping and nothing this change reaches. Pre-existing flake, not introduced here.
- `StatusBadge` is imported by nothing today, so the rendered half of DW-622 lands when something mounts it; the live reader of the flag is the `/api/status` body. This is recorded in the component and is the same standing condition two earlier specs in this directory note.
