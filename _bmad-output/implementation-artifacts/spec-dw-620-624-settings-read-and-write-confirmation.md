---
title: 'Settings: one config read per response, and an unconfirmed write reported as one (DW-620, DW-624)'
type: 'bugfix'
created: '2026-09-02'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
baseline_revision: '8162efabd080eeb13fd63875c90938ea32c0cbaf'
deferred:
  - summary: >-
      Eighteen components and libs carry their own hand-rolled copy of `send`'s
      body parse, each with the bare `.catch(() => ({}))` this bundle just
      replaced — so the DW-556 misclassification is still live on those
      surfaces.
    evidence: |-
      A repo-wide grep for the literal
      `response.json().catch(() => ({}))` finds it in
      `SystemHealthDesk.tsx`, `LocalSyncPanel.tsx`, `ActionInbox.tsx`,
      `SourceMonitorDesk.tsx`, `NamesTermsSettings.tsx`, `IntegrationDesk.tsx`,
      `MonitorDigestPanel.tsx`, `ReviewDesk.tsx`, `AgentWorkspaceDesk.tsx`,
      `BulkDocumentImport.tsx`, `ArticleActions.tsx`, `VaultExplorer.tsx`,
      `KnowledgeStudio.tsx`, `ChatWorkspace.tsx`, `KnowledgeAtlas.tsx`,
      `RecentIngests.tsx`, `chat-session-transport.ts` and `chat.ts` — none of
      which imports `workbench-request`. On each, a 2xx whose body read dies
      mid-stream resolves an empty object, so the destructure that follows
      reports a landed write as a failure (or a shapeless success), exactly the
      defect DW-624 names. The fix is `send`'s now-shipped gate:
      `if (response.ok && unconfirmedCause(cause)) throw cause;` plus a
      `writeFailure` at the catch. Not a call site of anything this bundle
      changed — these are independent copies of the helper.
    location: >-
      src/components/*.tsx (16 files), src/lib/chat-session-transport.ts,
      src/lib/chat.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** Two cross-cutting hygiene defects on the settings path. `GET`/`PUT /api/settings` build one response out of several independent entries into the 5 s config cache — `getEffectiveSettings()` at `route.ts:83`, then `getWorkbenchSettings(…, await inboundEmail())` at `:127` and `:682`, with `getWorkbenchSettings` doing its own `loadConfigSync()` plus a `getFirecrawlSettings()` and a `getResearchSettings()` that each read again — so one HTTP response can describe two or three config generations across the panes it renders (DW-620). And three sibling write clients still swallow a **2xx body read that dies mid-stream** and report a settled outcome anyway: `useSettings.ts:356` shows "Settings saved.", `WikiEditor.tsx:282` keeps going and navigates away, and `send`/`sendForm` (`workbench-request.ts:66,98`) fall back to `{}` so the caller's destructure reads a landed create/rename/delete as a failure (DW-624).

**Approach:** Thread the snapshot the route already holds (`read.config` on GET, `merged` on PUT) through `getEffectiveSettings` and `getWorkbenchSettings` using the file's established optional-trailing-`cfg` convention, and give `getFirecrawlSettings`/`getResearchSettings` the same parameter so the whole payload resolves from one generation. Then apply DW-556's already-shipped `unconfirmedCause` guard — rethrow a dying 2xx body read, keep answering for one that merely parses badly — to the three siblings, and route each one's failure sentence through `workbench-request`'s verdict helpers so the owner is told the outcome is unknown rather than that the write succeeded or failed.

## Boundaries & Constraints

**Always:**
- Every new `cfg` parameter is **optional and trailing**, defaulting to today's behaviour, so no existing call site (`src/cli.ts:691`, `research-providers.ts`, the test suites) changes.
- Resolver semantics are unchanged: same env-over-store precedence, same `nonEmpty` trimming, same returned fields. This is threading only.
- The 2xx guard is DW-556's exact three lines and exact distinction: a body that **parses badly** (`SyntaxError`, an HTML error page) is the route's arrived answer and keeps today's behaviour; a body read that **dies** (`unconfirmedCause`) is rethrown.
- The unconfirmed sentence has one owner: `unconfirmedWriteMessage` via `writeFailure` / `thrownWriteFailure`. No surface composes transport vocabulary ("Failed to fetch", "signal timed out") of its own.
- A caller that reports `unconfirmed` must reconcile or refuse to advance — `useSettings` re-reads `/api/settings`, `WikiEditor` stays on the form and does not `router.push`.
- In `send`/`sendForm` the rethrow is gated on `response.ok`: on a NON-2xx the status line already IS the verdict, so a dying refusal-body read must still yield `{}` and the existing `RequestFailedError(status)` path.

**Block If:** threading a `cfg` would require changing a resolver's precedence or return value to keep tests green — that is a behaviour change this bundle does not authorise.

**Never:**
- Do not thread `cfg` into `getVectorSearchSettings`. The ledger entry names it, but the current `getWorkbenchSettings` does not call it and no settings-payload path does; an unused parameter would be dead surface.
- Do not touch the embedding legs (`embeddingModelAnswer`, `getEmbeddingResolution`, `getLoopbackApiSettings`) — they already take the snapshot.
- Do not change `loadConfigSync`'s cold-cache `{}` answer, its 5 s TTL, or add a startup warm.
- Do not add test-only counters or exported instrumentation to production config state — the existing `withClockSpy` helper in `config.test.ts` is how read counts are measured.
- Do not widen `send`'s contract for the non-ok branch, and do not change `UNCONFIRMED_STATUSES`.
- Do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Settings payload, cache expires mid-call | `getWorkbenchSettings(false, undefined, cfg)` with a clock that jumps past the TTL after the first read | Every field answers from `cfg`; exactly ONE `loadConfigSync` entry | No error expected |
| GET builds one response | `GET /api/settings` after a save | Legacy fields and `workbench` fields both describe `read.config` | No error expected |
| PUT re-seeds from what it wrote | `PUT /api/settings` that lands | `effective` and `workbench` both resolve from `merged` | No error expected |
| `useSettings` 2xx body dies | `PUT` answers 200, `res.json()` rejects `TimeoutError` | `saveResult.ok === false`, message is `unconfirmedWriteMessage(SETTINGS_SAVE_ACTION)`; a reconciling GET is issued | Verdict is unknown, never "Settings saved." |
| `useSettings` 2xx body unparseable | `PUT` answers 200, `res.json()` rejects `SyntaxError` | Unchanged: "Settings saved.", version left to the refresh | No error expected |
| `WikiEditor` PUT body dies | `PUT /api/wiki/[slug]` answers 200, `res.json()` rejects `TypeError` | Form stays open, error is the unconfirmed sentence, no `router.push`, no PATCH | Verdict is unknown |
| `WikiEditor` PUT body unparseable | `PUT` answers 200, `res.json()` rejects `SyntaxError` | Unchanged: seeded version kept, PATCH still fires | No error expected |
| `send` 2xx body dies | 200 whose `json()` rejects `AbortError` | `send` rejects with that cause; caller's `writeFailure` answers `unconfirmed: true` | Never resolves `{}` |
| `send` non-2xx body dies | 500 whose `json()` rejects | Unchanged: `RequestFailedError("Request failed (500)", 500)` | Status is the verdict |

</intent-contract>

## Code Map

- `src/app/api/settings/route.ts` -- `GET` at :78-131 (`read = await readConfig()`, then `getEffectiveSettings()` :83, then `getWorkbenchSettings(hasWorkersAiBinding, await inboundEmail())` :127). `PUT` tail at :657-686 (`saveConfig(merged, read.etag)`, `getEffectiveProvider()` :674, `getWorkbenchSettings(…)` :682). `inboundEmail()` helper at :142. `ConfigRead.config` is the exact object `readStoredConfig` primes the cache with (`config.ts:931`), so it IS the snapshot.
- `src/lib/config.ts` -- `getWorkbenchSettings` :2145 (own `loadConfigSync()` at :2157, `getFirecrawlSettings()` :2158, `getResearchSettings()` :2159; already passes `cfg` to `embeddingModelAnswer` and `getLoopbackApiSettings`). `getFirecrawlSettings` :1940, `getResearchSettings` :1983 — each opens with `const cfg = loadConfigSync()` (:1941, :1984). `getEffectiveSettings` :2530 (:2531). Existing convention to copy: `getLoopbackApiSettings(cfg: AppConfig = loadConfigSync())` :1749, `getEffectiveProvider(cfg: AppConfig = loadConfigSync())` :1436. `getVectorSearchSettings` :1655 — NOT on this path, leave alone.
- `src/lib/workbench-request.ts` -- `send` :86 (one `.catch(() => ({}))` at :95 serving both the ok and non-ok branches), `sendForm` :121 (same at :127). `unconfirmedCause` :187, `unconfirmedWriteMessage` :209, `writeFailure` :260, `thrownWriteFailure` :281. Client-safe, so both React surfaces may import it.
- `src/lib/workbench-settings.ts` -- `SETTINGS_SAVE_ACTION = "save these settings"` :247; `saveWorkbenchSettings` :3615, whose 2xx guard at :3708-3711 is the REFERENCE implementation of the 2xx guard (`if (unconfirmedCause(cause)) throw cause; return null;`) with the argument written out in full.
- `src/lib/workbench-preview.ts` -- `savePreviewBody` :1523-1531, the second copy of that guard.
- `src/hooks/useSettings.ts` -- `handleSave` :322-400; the bare `.catch(() => null)` at :372 (the 2xx read; :366 is the refusal read and stays as it is); catch at :391 (`err.message`); `fetchSettings` :232-300 already nulls `version`/`workbench` on a failed read. Already imports from `@/lib/workbench-settings`.
- `src/components/WikiEditor.tsx` -- `handleSave` :267-357; `bodyLanded` :283; the bare `.catch(() => null)` at :312 (the 2xx read; :301 and :328 are refusal reads and stay as they are); catch at :353 (`getErrorMessage(err, "unknown error")`); copy constants `EDIT_PAGE_READ_ONLY_COPY` :30 and `partialSaveMessage` live in this file.
- `src/lib/__tests__/config.test.ts` -- `describe("single-read resolution")` from :2071: `withClockSpy` :2098, `frozen()` :2113, `jumpsAfterFirstRead()` :2124, and the `read counts` / `generation straddle` / `the cfg parameter` blocks. Extend, do not rewrite.
- `src/lib/__tests__/workbench-request.test.ts` -- `answer(body, {ok,status})` helper :38; existing `send`/`sendForm` coverage.
- `src/hooks/__tests__/useSettings.test.tsx` -- `stub(answers)` :80, `ok()` :100, `refused()` :104, `mount()`/`save()`/`result()` :107-121. Every answer is one `/api/settings` call in order.
- `src/components/__tests__/page-write-read-only.test.tsx` -- `describe("Edit page — the write precondition")` from :271; the `SyntaxError` case at ~:385 pins that an unparseable 200 keeps the seeded version and still fires the PATCH — that case must stay green.

## Tasks & Acceptance

**Execution:**
- `src/lib/config.ts` -- add an optional trailing `cfg: AppConfig = loadConfigSync()` to `getFirecrawlSettings`, `getResearchSettings` and `getEffectiveSettings`; add a trailing `cfg: AppConfig = loadConfigSync()` to `getWorkbenchSettings` (after `inboundEmail`) and use it for the two resolver calls in place of the local `loadConfigSync()` -- so one call resolves the whole payload from one generation.
- `src/app/api/settings/route.ts` -- in `GET`, hoist `await inboundEmail()` above the resolvers and pass `read.config` to both `getEffectiveSettings` and `getWorkbenchSettings`; in `PUT`, pass `merged` to `getEffectiveProvider` and `getWorkbenchSettings` and hoist its `await inboundEmail()` likewise -- so no `await` sits between the reads that compose one response.
- `src/lib/workbench-request.ts` -- in `send` and `sendForm`, replace the bare body `.catch(() => ({}))` with the DW-556 guard, gated on `response.ok`, and document why the non-ok branch keeps `{}` -- so a dying 2xx read reaches the caller's `writeFailure` as unconfirmed instead of an empty object.
- `src/hooks/useSettings.ts` -- guard the 2xx `res.json()` with `unconfirmedCause`, and report the catch through `writeFailure(err, SETTINGS_SAVE_ACTION)`, re-reading settings/status when the verdict is `unconfirmed` -- so a save whose confirmation never arrived is neither announced as saved nor described in transport vocabulary.
- `src/components/WikiEditor.tsx` -- guard the `PUT` leg's 2xx `res.json()` the same way, add an `EDIT_PAGE_SAVE_ACTION` copy constant beside the file's other copy, and report the catch through `writeFailure` -- so an unconfirmed body save stops the flow before `router.push` instead of navigating away on a pre-save version.
- `src/lib/__tests__/config.test.ts` -- extend `single-read resolution` with a read-count, a straddle and a `cfg`-parameter case for `getWorkbenchSettings` (and the two resolvers) -- so dropping an argument cannot leave the suite green.
- `src/lib/__tests__/workbench-request.test.ts` -- cover both `send`/`sendForm` body-read outcomes on 2xx and the unchanged non-2xx one.
- `src/hooks/__tests__/useSettings.test.tsx` -- add the dying-2xx and the unparseable-2xx save cases.
- `src/components/__tests__/page-write-read-only.test.tsx` -- add the dying-2xx PUT case beside the existing `SyntaxError` one.

**Acceptance Criteria:**
- Given a config saved and loaded, when `getWorkbenchSettings(false)` runs under a clock that expires the cache after its first read, then every returned field describes the saved config and exactly one `loadConfigSync` entry is made.
- Given `GET /api/settings`, when the response is composed, then the legacy fields and the `workbench` object are both resolved from the single `readConfig()` snapshot rather than from independent cache reads.
- Given a `PUT /api/settings` that lands, when the response is composed, then `effective` and `workbench` both describe the merged config that was just written.
- Given any of the three write clients receives a 2xx whose body read rejects with an abort, a `TypeError` or a timeout, when the failure is reported, then the owner is shown `unconfirmedWriteMessage(...)`, no success is claimed, and the surface reconciles (re-read) or refuses to advance (no navigation).
- Given any of the three receives a 2xx whose body merely fails to parse, when the failure is handled, then behaviour is byte-for-byte what it is today.
- Given a non-2xx whose body read rejects, when `send` reports it, then it still throws `RequestFailedError` carrying that status.

## Spec Change Log

## Review Triage Log

### 2026-09-02 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 1, low 7)
- defer: 1: (high 0, medium 0, low 1)
- reject: 10
- addressed_findings:
  - `[medium]` `[patch]` The gateway leg both new catch comments promised could never fire: `unconfirmedCause` reaches 502/504 only through `RequestFailedError`, and `useSettings` / `WikiEditor` still threw a plain `Error` from their non-ok branches, so a 504 read as "Save failed (504)" with no reconcile — while `saveWorkbenchSettings`, writing the same file through the same route, answers unconfirmed. All three non-ok branches now throw `RequestFailedError(<same message>, res.status)`; 504 cases added on both surfaces plus regression cases pinning 412/500 unchanged.
  - `[low]` `[patch]` PUT's hoisted `await inboundEmail()` sat between `getEffectiveProvider(merged)` and `getWorkbenchSettings(..., merged)`, inside the window its own comment forbids. Moved above both, matching GET.
  - `[low]` `[patch]` The `getWorkbenchSettings` `cfg` docblock and the matching `config.test.ts` comment both said FOUR cache entries; the real count was three (`embeddingModelAnswer` and `getLoopbackApiSettings` were already threaded), and it contradicted the straddle test below it. Corrected both.
  - `[low]` `[patch]` "`merged` is the object `saveConfig` persisted" was loose — `saveConfig` strips the two reserved keys into a local `stored` and persists that. Reworded to the merge base it was handed.
  - `[low]` `[patch]` The new PUT route test could not fail if the workbench snapshot regressed: it moved a flat legacy field with no `WorkbenchSettingsValues` counterpart, so `read.config` and `merged` produced identical output (mutation-checked green). Now moves `workbench.chatModel` and asserts the new value; the same mutation fails it.
  - `[low]` `[patch]` The `fetchStatus()` half of the unconfirmed reconcile was asserted by nothing — deleting it left every suite green, because the harness recorded only `/api/settings`. Harness now records `/api/status` and both unconfirmed cases assert the second read.
  - `[low]` `[patch]` `queryByText(partialSaveMessage(""))` looked for a string the component can never render. Replaced with a `/Your text was saved/` matcher in all four places.
  - `[low]` `[patch]` Recorded why the unconfirmed reconcile deliberately re-seeds the form from the store while the refused path deliberately does not, so the asymmetry is not read as a bug.

## Design Notes

The 2xx guard is already written twice in this repo; copy it rather than inventing a third shape:

```ts
const landed = (await res.json().catch((cause: unknown) => {
  if (unconfirmedCause(cause)) throw cause;
  return null;
})) as { version?: unknown } | null;
```

`send` is the one place it needs a gate, because a single parse serves both branches:

```ts
const body = (await response.json().catch((cause: unknown) => {
  // A NON-2xx already carries its verdict in the status line, so a refusal
  // body that dies is still an arrived answer — `{}` and the status win.
  if (response.ok && unconfirmedCause(cause)) throw cause;
  return {};
})) as T & { error?: string };
```

`WikiEditor` deliberately does NOT clear its held `version` on this path: the file already records the decision that an arrived-but-unreadable 200 leaves the seeded version in place so the next save is refused rather than blind, and a dying read is the same arrived 200.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/config.test.ts src/lib/__tests__/settings-runtime-wiring.test.ts src/lib/__tests__/settings-route.test.ts src/lib/__tests__/workbench-request.test.ts src/hooks/__tests__/useSettings.test.tsx src/components/__tests__/page-write-read-only.test.tsx` -- expected: all pass, including the new cases.
- `pnpm vitest run` -- expected: no new failures anywhere in the suite.
- `pnpm lint` -- expected: clean.
- `npx tsc --noEmit` -- expected: no type errors.

## Auto Run Result

Status: done

### Summary

Two hygiene defects on the settings path, closed together.

**DW-620** — `GET`/`PUT /api/settings` composed one response out of up to four independent entries into the 5 s-TTL config cache, with an `await inboundEmail()` sitting in the middle of them, so one response could describe two or three config generations across the panes it renders. `getFirecrawlSettings`, `getResearchSettings`, `getWorkbenchSettings` and `getEffectiveSettings` gained an optional trailing `cfg: AppConfig = loadConfigSync()` (the file's existing `getLoopbackApiSettings` / `getEffectiveProvider` convention, so no existing caller changed), `getWorkbenchSettings` threads its snapshot into both nested resolvers, and both verbs now hoist the `await` and pass the config they already hold — `read.config` on GET, the merge base `saveConfig` was handed on PUT. `getVectorSearchSettings` is deliberately untouched: the ledger names it, but nothing on the settings-payload path calls it, so a parameter there would be dead surface.

**DW-624** — three sibling write clients swallowed a 2xx body read that dies mid-stream and reported a settled outcome anyway. All three now apply DW-556's guard (rethrow an `unconfirmedCause`, keep today's answer for a body that merely parses badly), gated on `response.ok` in `send`/`sendForm` because one parse serves both branches there. Both React surfaces route their catch through `writeFailure`, so a fired deadline, a dropped socket or a gateway that gave up is reported as an unknown outcome in the one shared sentence rather than as "Save failed" or in transport vocabulary — and `useSettings` reconciles by re-reading settings and status, while `WikiEditor` refuses to advance (no `router.push`).

### Files changed

- `src/lib/config.ts` — optional trailing `cfg` on four resolvers; `getWorkbenchSettings` threads it into `getFirecrawlSettings`/`getResearchSettings` instead of each opening its own cache read.
- `src/app/api/settings/route.ts` — GET resolves both halves from `read.config`, PUT from `merged`; `await inboundEmail()` hoisted above the resolvers on both verbs.
- `src/lib/workbench-request.ts` — `send`/`sendForm` rethrow a dying 2xx body read; a non-2xx keeps `{}` and its `RequestFailedError`, because the status line is already the verdict.
- `src/hooks/useSettings.ts` — the 2xx guard; refusals throw `RequestFailedError` carrying the status; the catch reports through `writeFailure` and reconciles on an unknown outcome.
- `src/components/WikiEditor.tsx` — the same guard on the PUT leg, `RequestFailedError` on all three refusal branches, a new `EDIT_PAGE_SAVE_ACTION` phrase, and `writeFailure` at the catch.
- `src/lib/__tests__/config.test.ts` — read-count, generation-straddle and explicit-`cfg` cases for the widened resolvers.
- `src/lib/__tests__/settings-route.test.ts` — one-snapshot-per-response cases for both verbs.
- `src/lib/__tests__/workbench-request.test.ts` — both 2xx body-read outcomes and the unchanged non-2xx one, for `send` and `sendForm`.
- `src/hooks/__tests__/useSettings.test.tsx` — dying-2xx, unparseable-2xx, dying refusal body, 504, and the reconcile reads.
- `src/components/__tests__/page-write-read-only.test.tsx` — dying-2xx PUT, 504 on both legs, and the rewritten transport-vocabulary expectation.

### Review findings

- Patches applied: 8 (1 medium, 7 low) — see the triage log.
- Items deferred: 1 (low) — eighteen hand-rolled copies of `send`'s body parse elsewhere in the tree still carry the same defect.
- Items rejected: 10 — including `WikiEditor` not calling `router.refresh()` (the spec's reconciliation for that surface is refusing to advance), the unconfirmed sentence not carrying a partial-landed variant (new copy, beyond this intent), rendering the unknown outcome through the existing failure channel (the shape `SettingsCanvas` already uses), and the identical read-then-resolve shape in `src/cli.ts` and `/api/status` (sibling call sites).

### Follow-up review

Patched this pass: high 0, medium 1, low 7. Score = 3x1 + 1x7 = 10, which is >= 5, so `followup_review_recommended: true`.

### Verification

- `npx vitest run src/lib/__tests__/config.test.ts src/lib/__tests__/settings-runtime-wiring.test.ts src/lib/__tests__/settings-route.test.ts src/lib/__tests__/workbench-request.test.ts src/hooks/__tests__/useSettings.test.tsx src/components/__tests__/page-write-read-only.test.tsx src/lib/__tests__/storage-fs.test.ts` — 7 files, 464 passed.
- `npx vitest run` (full suite) — 8916+ passed, 1 skipped. The only failure seen across runs is `storage-fs.test.ts > reapStrandedScratchFiles > stops at STRANDED_SCRATCH_CANDIDATE_CAP`, a 5 s test-timeout in the filesystem scratch reaper: it passes in isolation (683 ms / 1182 ms), touches no code in this change, and one full run was completely green. Pre-existing and load-sensitive, not a regression.
- `npx tsc --noEmit` — clean.
- `pnpm lint` — clean (only the pre-existing `jsx-ast-utils` TSNonNullExpression notices).
- Mutation checks: dropping the `cfg` argument at any of the four route call sites fails the new route tests; dropping it inside `getWorkbenchSettings` fails three config cases; deleting `await fetchStatus()` fails both unconfirmed hook cases.

### Residual risks

- `send`'s rethrow is method-agnostic, so roughly twenty GET read paths that use the same helper now reject where they used to resolve `{}` on a dying 2xx body. Every unawaited call site has a `.catch`, so nothing becomes an unhandled rejection, but a read whose body dies now surfaces its load-failure sentence instead of rendering an empty payload. That is the honest direction and it is what the one-owner rule asks for; it is untested at the caller level.
- On `WikiEditor`, a transport failure in the metadata `PATCH` after the body `PUT` landed now reads as the flat unconfirmed sentence rather than DW-428's partial-save sentence. The claim is true — the page save as a whole was not confirmed — but the fact that the text specifically did land is no longer relayed. A partial-unconfirmed phrasing would be new copy, which this intent does not authorise.
- An unconfirmed save on `/settings` re-seeds the form from the store, so a write that did NOT land replaces what the owner had typed. Deliberate (the write may have landed, and the sentence sends the owner to the screen) and now recorded in the code, but it is the opposite of the refused-save path.
