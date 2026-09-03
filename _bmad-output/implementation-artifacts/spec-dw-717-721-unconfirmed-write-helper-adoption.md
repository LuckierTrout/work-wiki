---
title: 'One owner for the unconfirmed-body gate across the eighteen hand-rolled parses, and a create latch that shuts both wiki surfaces'
type: 'bugfix'
created: '2026-09-03'
baseline_revision: 'e88311652028360a58d90dd9aa9e9754804648f0'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `NamesTermsSettings.save` has no 2xx shape guard, so a save whose body fails to parse
      pushes `undefined` into `entries` and the row map throws, blanking the whole section.
    evidence: |-
      `readJsonBody` resolves `{}` for a 2xx that merely fails to PARSE — the answer arrived and
      was shapeless — and every other adopting site has its own guard for that (`if (!wiki?.id)
      throw …` on the wiki surfaces, `if (!data.queued || !data.jobId)` in `BulkDocumentImport`).
      `save` has none: it pushes `data.entry` straight into `entries`, so `undefined` reaches the
      row map and `Cannot read properties of undefined (reading 'canonical')` takes the section
      down. Found while drafting a "2xx that merely fails to parse" case for that surface; the
      case was dropped because the crash is pre-existing and outside this spec's scope.
    location: >-
      src/components/NamesTermsSettings.tsx (save, success branch)
    severity: low
---

<intent-contract>

## Intent

**Problem:** (DW-717) Eighteen components and libs carry their own copy of `send`'s body parse with
the bare `response.json().catch(() => ({}))`, and none of them imports `workbench-request`: on a 2xx
whose body read DIES mid-stream — an abort, a fired deadline, a `TypeError` off a dropped socket —
the parse resolves `{}`, so the destructure that follows reports a landed write as a failure or as a
shapeless success, and the catch beside it tells the owner a flat "couldn't do it" about a write that
may have gone through in full. (DW-721) A create that SUCCEEDS on either wiki surface leaves the
other surface's create fully live for the length of `router.refresh()`: `WikiWorkbench.create`'s
success path raises the component-local `awaitingCreate`, `WikiSwitcher.create`'s success path raises
nothing at all, both surfaces stay mounted together and both POST `/api/wikis`, and nothing enforces
unique wiki names — so one click there seeds the duplicate wiki the shared latch exists to prevent
and moves every prompt onto its template.

**Approach:** Lift `send`'s ok-plus-`unconfirmedCause` gate into ONE exported body reader in
`workbench-request.ts` that `send` and `sendForm` themselves use, and route all eighteen parses
through it, so a dead 2xx body read is rethrown as the missing confirmation it is rather than
flattened to `{}`. Report each of those sites' WRITE catches through `writeFailure`, and on
`unconfirmed` reconcile the surface instead of claiming the write failed. Separately, give the shared
wiki latch a second, SENTENCE-LESS dimension for a create that succeeded and raise it from BOTH
success branches, so one pending create shuts the create control on both surfaces.

## Boundaries & Constraints

**Always:** The gate keeps its shipped shape verbatim — rethrow only when `response.ok` AND
`unconfirmedCause(cause)`; every non-2xx branch still resolves `{}` so the status line stays the
verdict. `send` and `sendForm` keep their observable behaviour unchanged (deadline, JSON content
type, `RequestFailedError` and its message) and are re-expressed through the extracted reader, so the
gate has exactly one copy in the repo. Each named site keeps its OWN fetch — its own deadline, its
own headers, its own signal — and adopts the reader alone. A write catch that reports to the owner
composes its sentence with `writeFailure(cause, action)` from one action phrase, and where
`unconfirmed` is true it reconciles through that surface's existing refetch (`load()`,
`router.refresh()`, a re-list) and never tells the owner the write failed. The wiki latch's
message-carrying half stays the UNCONFIRMED half; the create-succeeded half carries no sentence and
shuts only create controls. Every raise of either half is mirrored into the ref its release effect
reads, on the adjacent line, and release stays idempotent and gated on that ref.

**Block If:** Adopting the gate at a named site cannot be done without changing that call's deadline,
authorization headers, content type, or streaming behaviour to keep it working.

**Never:** Do not migrate the eighteen sites onto `send` itself — it arms `REQUEST_TIMEOUT_MS` and
forces a JSON content type, and several of these calls are long-running or carry their own signal and
`Authorization` (`callHermes` at 90 s, the chat answer, research/graphify/monitor runs), so `send`
would convert succeeding requests into aborts. Do not add a deadline to any site that has none today.
Do not touch `writeFailure`, `unconfirmedWriteMessage`, `UNCONFIRMED_STATUSES` or any wording they
compose, and add no copy constant for the create-succeeded latch — a succeeded create shuts its
control silently, exactly as the card's local `awaitingCreate` already does. Do not widen the
create-succeeded latch to rename, delete or switch, and do not make either wiki surface optimistic.
Do not touch parse sites the ledger does not name (`RevisionHistory`, `AgentManager`, `VaultManager`,
`SaveToVaultButton`, `DeletePageButton`, `AgentTokenPanel`, `VaultExportButton`, `BatchIngestForm`,
`useSettings`, `useStreamingQuery`, `workbench-preview`, `workbench-settings`, and every server route
reading `request.json()`). Do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 2xx body read dies at a named site | `POST` answers 200, `response.json()` rejects with `TimeoutError`/`AbortError`/`TypeError` | The cause is rethrown, not flattened to `{}`; the catch composes `unconfirmedWriteMessage`, `unconfirmed` is true, the surface refetches | Owner is never told the write failed |
| 2xx body merely fails to PARSE | 200 whose body is `not json` (`SyntaxError`) | Still resolves `{}`, exactly as today — the answer arrived, it was just unreadable | Existing shape guard reports it |
| Non-2xx whose body read dies | 500 whose body read rejects | Resolves `{}` and the site's existing `Request failed (500)`/`{ error }` branch fires unchanged | Stated refusal, `unconfirmed` false |
| Gateway status at a named site | 502/504 answered by a proxy | `writeFailure` reports an unknown outcome and the surface refetches | Body ignored, no proxy error page shown |
| Stated refusal at a named site | 400 with `{ error: "…" }` | The route's own sentence, unchanged, and no refetch | `unconfirmed` false |
| Card create succeeds, header watching | `WikiWorkbench.create` resolves 2xx, both surfaces mounted | The header's `New Wiki` dialog opens with a DEAD `Create`; no second `POST /api/wikis` from either surface | Both live again on a server render |
| Header create succeeds, card watching | `WikiSwitcher.create` resolves 2xx, both surfaces mounted | The card's empty-state `Create Wiki` is `disabled`; no second `POST /api/wikis` | Released on the arriving render |
| Create-succeeded latch is mute | Either create succeeded, no unconfirmed write anywhere | The dimmed create control gains NO new sentence and no alert; the picker is not `aria-disabled` | Nothing failed, nothing to explain |
| Rename/delete/switch under a pending create | Card create succeeded, owner opens Rename | Rename and Delete confirms stay LIVE | Unaffected |
| Bare-mounted switcher | `WikiSwitcher` with no provider above it | Raises, holds and releases the create-succeeded half locally, exactly as with a provider | No error expected |

</intent-contract>

## Code Map

- `src/lib/workbench-request.ts` -- the owner. `send` :110-134 and `sendForm` :150-170 hold two
  verbatim copies of the gate (`response.json().catch(cause => { if (response.ok &&
  unconfirmedCause(cause)) throw cause; return {}; })`); extract it once and call it from both.
  `unconfirmedCause` :232-237, `writeFailure` :293-301, `RequestFailedError` :88-96 are READ-ONLY.
- `src/lib/__tests__/workbench-request.test.ts` -- the gate's existing pins: :207 (2xx read that
  dies), :230 (2xx that merely fails to parse), :247 (non-2xx left alone), :269 (multipart). All must
  stay green through the extraction; the new reader gets its own cases beside them.
- **Group A — a local `send` clone taking `(url, init?)`, one per file.** Same three lines each:
  `src/components/SystemHealthDesk.tsx` :10-15, `LocalSyncPanel.tsx` :8-13, `ActionInbox.tsx` :53-58,
  `IntegrationDesk.tsx` :10-15, `ReviewDesk.tsx` :22-27, `SourceMonitorDesk.tsx` :13-18,
  `NamesTermsSettings.tsx` :64-69, `MonitorDigestPanel.tsx` :18-23, `AgentWorkspaceDesk.tsx` :10-15,
  `KnowledgeStudio.tsx` :175-180, `KnowledgeAtlas.tsx` :33-38. The parse line is the only thing that
  changes; the wrapper keeps its name, its optional `init`, and its `throw new Error(body.error || …)`.
- **Group B — the parse written inline at the call site.** `src/components/ChatWorkspace.tsx` :20-24
  (its helper takes a `Response`, the caller does the fetch); `BulkDocumentImport.tsx` :192 (multipart
  upload) and :238 (job poll); `ArticleActions.tsx` :165 (`graphifyPage`); `VaultExplorer.tsx` :267
  (preview read, `AbortController`-driven) and :299 (`removeSelected`, inside the `!response.ok`
  branch); `RecentIngests.tsx` :304 (bulk delete); `src/lib/chat-session-transport.ts` :173 (sidecar
  refusal branch, `loopbackFetch` + SSE); `src/lib/chat.ts` :751 (`callHermes`, its OWN 90 s signal
  and `Authorization` header — the clearest case for adopting the reader and not `send`).
- Write call sites that need `writeFailure` at the catch: `SystemHealthDesk` 5, `ActionInbox` 4,
  `SourceMonitorDesk` 4, `MonitorDigestPanel` 3, `AgentWorkspaceDesk` 3, `KnowledgeAtlas` 3,
  `ChatWorkspace` 5, `IntegrationDesk` 2, `ReviewDesk` 2, `LocalSyncPanel` 1, `NamesTermsSettings` 1,
  `KnowledgeStudio` 12, plus `ArticleActions.graphifyPage`, `VaultExplorer.removeSelected`,
  `RecentIngests` bulk delete and `BulkDocumentImport.uploadItem`. Each surface already owns the
  refetch the unconfirmed branch needs (`load()`, `refresh()`, `router.refresh()`).
- `src/components/workbench/WikiWriteLatch.tsx` -- DW-721's seam. `WikiWriteLatch` interface :50-60,
  `useLatchState` :72-85, provider :92-99, `useWikiWriteLatch` :109-113. Its docblock currently states
  the success half is NOT admitted here (:31-36) — that paragraph is what this change rewrites, and
  the reason it gave (no sentence to explain a dimming elsewhere) is why the new half is sentence-less
  rather than folded into `message`.
- `src/components/WikiWorkbench.tsx` -- `awaitingCreate` state :123-145 and `awaitingCreateRef`
  :146-161 (docblocks explain the ref-mirror rule); release effect :276-286; `create` guard :314 and
  success raise :332-333; opener `disabled` :486 and handler guard :505; `confirmDisabled` :603.
- `src/components/workbench/WikiSwitcher.tsx` -- `raisedLatchRef` :218, release effect :278-286,
  `create` :369-404 (guard :374, success branch :386-390 raises nothing), create dialog
  `confirmDisabled` :781. Needs the ref/raise pair the card already has.
- `src/lib/__tests__/workbench-left-column.test.ts` -- source scans that WILL BREAK: :410 (three
  `if (busy || latched) return;` in the switcher — create becomes the card's spelling), :485-492 (the
  card's guard counts and `confirmDisabled`), :520-533 (the DW-429 raise/ref parity counts, which
  must now count the create-succeeded raises per surface too).
- `src/components/__tests__/wiki-write-latch-parity.test.tsx` -- both surfaces under one
  `WorkbenchDataProvider`. `describe` :127, the two unconfirmed cross-surface cases :128-207, the
  release-gating case :404. The success-path rows belong here.
- `src/components/__tests__/wiki-switcher-lifecycle.test.tsx` -- the switcher mounted BARE, which is
  the local-degradation case; its create cases must stay green.
- Baseline: `pnpm test` is fully green at `e8831165` (372 files, 9326 tests, 1 skipped).

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-request.ts` -- export one body reader holding the ok-plus-`unconfirmedCause`
  gate verbatim, and call it from both `send` and `sendForm` in place of their inline copies.
  Document why it is exported: seventeen other call sites need the GATE without `send`'s deadline,
  content type and signal, and a gate with eighteen copies is the defect DW-717 names.
- `src/lib/__tests__/workbench-request.test.ts` -- add cases for the reader called directly: a 2xx
  read that dies rethrows each of the three causes, a 2xx that merely fails to parse still resolves
  `{}`, a non-2xx whose read dies resolves `{}`. Keep :207-289 green unchanged, which is what proves
  the extraction changed nothing `send` and `sendForm` promise.
- Group A (the eleven files listed above) -- replace each local helper's parse line with the shared
  reader and import it from `@/lib/workbench-request`. Leave the helper's signature, name, optional
  `init` and non-2xx throw alone, so no call site moves.
- Group B (the seven files listed above) -- route each inline parse through the shared reader,
  keeping that call's own fetch, signal, headers and deadline exactly as they are.
- Every write catch listed in the Code Map -- compose the owner-facing sentence with
  `writeFailure(cause, <action phrase>)`; on `unconfirmed`, refetch through the surface's existing
  path and do not render a failure claim. Reads keep their current handling — the gate alone is what
  they needed.
- `src/components/workbench/WikiWriteLatch.tsx` -- add a second, sentence-less dimension to the
  shared latch for "a create succeeded and its server render has not arrived", with a stable
  mark/clear pair beside `raise`/`release`. Rewrite the "what is not admitted here" paragraph: the
  success half is now shared BECAUSE both surfaces open the same `POST /api/wikis`, and it is kept
  out of `message` because nothing failed and there is no sentence to show.
- `src/components/WikiWorkbench.tsx` -- read the success half off the shared latch instead of local
  `useState`, keeping `awaitingCreateRef` as the release effect's gate and the adjacent-line mirror
  rule. The guard, opener `disabled` and `confirmDisabled` spellings stay as they are.
- `src/components/workbench/WikiSwitcher.tsx` -- raise the shared success half on `create`'s success
  branch with its own adjacent-line ref, shut `create`'s handler guard and the create dialog's
  `confirmDisabled` on it, and clear it from the release effect on the same `[wikis, currentWikiId]`
  render the latch releases on. Rename, delete and switch are untouched.
- `src/lib/__tests__/workbench-left-column.test.ts` -- retarget the guard-spelling, guard-count and
  DW-429 parity pins onto the new spellings, keeping each pin's stated reason true: the parity pin
  must still make "every raise is mirrored into its ref" enforceable, now counting both halves.
- `src/components/__tests__/wiki-write-latch-parity.test.tsx` -- add the cross-surface SUCCESS rows:
  a succeeded card create leaves the header's `Create` dead and issues no second POST; a succeeded
  header create leaves the card's `Create Wiki` disabled; both come back on a server render; the
  dimmed control gains no new sentence and the picker is not `aria-disabled`; rename and delete stay
  live throughout.

**Acceptance Criteria:**
- Given any of the eighteen named sites, when a 2xx body read dies mid-stream, then the cause reaches
  the catch and the owner is told the outcome is unknown rather than that the write failed.
- Given the repo after this change, when `response.json().catch(` is searched under `src/`, then no
  file among the eighteen still holds its own copy of the gate, and the gate itself has one owner.
- Given a create that succeeded on either wiki surface, when the owner presses the other surface's
  create before the server render lands, then no second `POST /api/wikis` is issued.
- Given `pnpm test`, when the suite runs, then every pre-existing test passes unchanged except the
  source-scan pins this spec names, which pass in their retargeted form.

## Spec Change Log

## Review Triage Log

### 2026-09-03 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 4, low 4)
- defer: 1: (high 0, medium 0, low 1)
- reject: 5
- addressed_findings:
  - `[medium]` `[patch]` The reconciling refetch's own catch overwrote the unknown-outcome sentence with raw transport vocabulary at four surfaces (`NamesTermsSettings`, `MonitorDigestPanel`, `AgentWorkspaceDesk`, `LocalSyncPanel`) — nine catches reordered to refetch-then-sentence, the false premise corrected in every comment, and a regression case added where the write AND its refetch both die.
  - `[medium]` `[patch]` `ChatWorkspace.removeConversation` re-listed the sidebar but left `active` on a thread the DELETE may have removed — the re-list now clears `active` when the refetched list no longer names it.
  - `[medium]` `[patch]` `VaultExplorer.removeSelected` reconciled with `router.refresh()`, which cannot move `entries` (`useState(initialEntries)`, no prop sync, no `key`) — replaced with a real re-list off `GET /api/vaults/[id]/pages`.
  - `[medium]` `[patch]` `BulkDocumentImport` filed an unconfirmed upload as `failed`, sweeping it into the one-click **Retry failed** bulk action — new `unknown` status that stays out of `failedItems` and claims no failure.
  - `[low]` `[patch]` Read paths leaked transport vocabulary the module refuses: `VaultExplorer`'s preview and `chat-session-transport`'s `ok`-but-bodyless branch now keep their own fallback sentence for an unconfirmed cause.
  - `[low]` `[patch]` `ReviewDesk.decide` reported a decision that provably landed as an unknown outcome when the follow-up read failed — the write's verdict is now scoped to the write.
  - `[low]` `[patch]` Comment drift: "seventeen" vs "eighteen" in `workbench-request.test.ts`, and `workbench-left-column.test.ts:488` still calling `awaitingCreate` local.
  - `[low]` `[patch]` The refetch-then-sentence ordering class had no executing case — new mounted suite at `SourceMonitorDesk`, so both orderings are pinned.

## Design Notes

The gate is extracted rather than adopted wholesale because `send` is three promises, not one: the
gate, a 20 s deadline, and a JSON content type. Seventeen of the eighteen sites want only the first —
`callHermes` runs on a deliberate 90 s signal with its own `Authorization` header, `ChatWorkspace`'s
send waits on an LLM answer, `chat-session-transport` fetches through `loopbackFetch` and reads SSE —
so calling `send` there would convert succeeding requests into aborts. One exported reader gives
DW-717 exactly what it asks for (one owner for the gate) at zero behavioural cost anywhere else.

The wiki latch grows a dimension rather than a message because the two halves answer different
questions. `message` means "a write's outcome is unknown, here is the sentence"; the new half means
"a create landed and the screen has not caught up". Folding the second into the first would either
invent copy for a control that has nothing to report, or dim the picker and the rename confirm for a
write that provably succeeded. Keeping it sentence-less preserves the card's shipped behaviour
(`awaitingCreate` dims one control silently) and merely extends it across the seam.

## Verification

**Commands:**
- `pnpm test` -- expected: 372+ files green, no pre-existing failure introduced; the retargeted
  source-scan pins and the new latch-parity rows pass.
- `pnpm lint` -- expected: clean.
- `pnpm exec tsc --noEmit` -- expected: clean.
- `grep -rn --include='*.tsx' --include='*.ts' 'json()\.catch(() => ({}))' src/components src/lib` --
  expected: none of the eighteen named files appears.

## Auto Run Result

Status: done

### Summary

DW-717: `send`'s ok-plus-`unconfirmedCause` gate was extracted into one exported `readJsonBody`, which `send` and `sendForm` are now expressed through, and all eighteen hand-rolled parses were routed onto it — each keeping its own fetch, deadline, headers and signal, because `send` also arms `REQUEST_TIMEOUT_MS` and forces a JSON content type and several of those calls are long-running. Every write catch at those sites now composes its sentence with `writeFailure` and reconciles on `unconfirmed` instead of claiming the write failed; the adopting helpers throw `RequestFailedError` so the status rides the error and a 502/504 is classified as the unknown outcome it is. DW-721: the shared wiki latch gained a second, sentence-less `awaitingCreate` dimension raised on BOTH create success branches, so a create that landed on either surface shuts the other's create until the server render arrives.

### Files changed

- `src/lib/workbench-request.ts` -- new exported `readJsonBody`; `send`/`sendForm` re-expressed through it, observable behaviour unchanged.
- `src/components/{SystemHealthDesk,LocalSyncPanel,ActionInbox,IntegrationDesk,ReviewDesk,SourceMonitorDesk,NamesTermsSettings,MonitorDigestPanel,AgentWorkspaceDesk,KnowledgeStudio,KnowledgeAtlas}.tsx` -- local helper adopts the reader and throws `RequestFailedError`; write catches report through `writeFailure` and reconcile.
- `src/components/{ChatWorkspace,BulkDocumentImport,ArticleActions,VaultExplorer,RecentIngests}.tsx` -- the same, for the inline parses; `ChatWorkspace` and `RecentIngests` gained the re-list their unconfirmed branch needed, `VaultExplorer` a real entry re-list, `BulkDocumentImport` an `unknown` row status.
- `src/lib/chat-session-transport.ts`, `src/lib/chat.ts` -- reader only; neither reports through `writeFailure`.
- `src/components/workbench/WikiWriteLatch.tsx` -- second, sentence-less latch dimension and the docblock that argues why it stays out of `message`.
- `src/components/WikiWorkbench.tsx`, `src/components/workbench/WikiSwitcher.tsx` -- both create success branches raise it, each with its own adjacent-line ref and release.
- `src/lib/__tests__/workbench-request.test.ts` -- four cases for the reader called directly.
- `src/lib/__tests__/workbench-left-column.test.ts` -- guard-spelling, guard-count and DW-429 raise/ref parity pins retargeted onto both latch halves.
- `src/components/__tests__/wiki-write-latch-parity.test.tsx` -- three cross-surface success rows.
- `src/components/__tests__/wiki-switcher-lifecycle.test.tsx` -- the bare-mounted (provider-less) success-latch row.
- `src/components/__tests__/names-terms-unconfirmed-write.test.tsx` -- NEW. The dying 2xx read, the gateway status, the stated refusal, and the refetch that dies too.
- `src/components/__tests__/source-monitor-unconfirmed-write.test.tsx` -- NEW. The same three rows at a refetch-then-sentence surface.

### Review findings

- patches applied: 8 (medium 4, low 4)
- items deferred: 1 (low 1) -- `NamesTermsSettings.save`'s missing 2xx shape guard, pre-existing.
- items rejected: 5 -- the deliberately mute dimmed create control (spec-sanctioned); `RecentIngests`' localStorage job rows (the polling effect reconciles them); `ChatWorkspace`'s unguarded `data.conversations` (same shape as the file's existing loads); the Never-list sibling files that still hand-roll the parse; a speculative timeout-bounded latch release.
- follow-up review recommended: false -- patched severities were medium 4, low 4, high 0.

### Verification

- `pnpm test` -- 374 files, 9341 passed, 1 skipped, 0 failed (baseline `e8831165`: 372 files, 9326 passed).
- `pnpm lint` -- exit 0; the three `jsx-ast-utils` notices are byte-identical on the baseline.
- `pnpm exec tsc --noEmit` -- exit 0.
- `grep -rn 'json().catch(() => ({}))' src/components src/lib` -- none of the eighteen named files appears; the remaining hits are all on the spec's Never list, plus `WikiEditor.tsx`, which the ledger does not name.
- Matrix audit: every I/O row has a covering test that ran and passed -- rows 2 and 3 in `workbench-request.test.ts`, rows 1, 4 and 5 at two adopting surfaces, rows 6-9 in `wiki-write-latch-parity.test.tsx`, row 10 in `wiki-switcher-lifecycle.test.tsx`.

### Residual risks

- Sixteen of the eighteen adopting surfaces still have no mounted case of their own: the gate is pinned in the library, the two orderings are each pinned at one surface, and the rest rest on the shape being identical. A per-site ordering slip elsewhere would be invisible to the suite.
- `RequestFailedError` at the adopting helpers changes what a 502/504 that DID arrive renders — the unknown-outcome sentence rather than the route's status line. That is the discipline being adopted, but it is a behaviour change on the non-2xx path, which the ledger's own two-line prescription did not name.
- `KnowledgeStudio` gained a `refresh` prop on five panels. No new fetch behaviour, but it is the widest structural edit in the change and its panels have no mounted unconfirmed case.
