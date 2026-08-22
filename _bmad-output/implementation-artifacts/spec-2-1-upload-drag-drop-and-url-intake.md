---
title: 'Story 2.1: Upload, drag-drop, and URL Intake'
type: 'feature'
created: '2026-08-22'
status: 'done'
baseline_revision: 'f93bae14fd0a1097e6a8a2c1a65a595cc9326b8b'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
warnings: ['oversized']
deferred:
  - summary: >-
      `syncSiloForPage` / `removeSiloForPage` still copy and delete only
      `raw/sources/<slug>.md`, not hashed Intake trees at
      `raw/sources/<slug>/<rawId>.md`.
    evidence: |-
      Intake mirrors hashed keys at write time via `{ owner }`. Ingest's
      `saveRawSourceFor` callers still omit owner. Page delete therefore
      leaves hashed silo leftovers; reconcile does not pick them up.
      Cascade delete is Story 2.10.
    location: >-
      src/lib/silo.ts
    severity: medium
  - summary: >-
      An identical re-arrival still creates an Ingest job even though the
      Source bytes are not rewritten.
    evidence: |-
      `storeAndQueue` always `createIngestJob` + `enqueueOrInline` after
      `saveRawSourceFor`. Same content hash is a no-op write, not a skip
      of Analysis/Generation. SHA256 skip is Story 2.7.
    location: >-
      src/app/api/workbench/intake/route.ts
    severity: medium
  - summary: >-
      `listRawSources` is still non-recursive, so CLI/lint listings miss
      hashed `raw/sources/<slug>/<id>.md` arrivals.
    evidence: |-
      Spec allowed the recursive Files walk as the observed surface.
      `listRawSources` still skips subdirectories under `raw/sources/`.
    location: >-
      src/lib/raw.ts
    severity: low
  - summary: >-
      `alreadyStored` then `writeFile` is not exclusive, so two concurrent
      stores of a new key can overwrite.
    evidence: |-
      `storeRawSource` checks existence then writes. No create-only
      compare-and-swap. Rare under the serial client batch.
    location: >-
      src/lib/raw.ts
    severity: low
  - summary: >-
      The client's 15s `send`/`sendForm` deadline wraps a server URL fetch
      that already uses the same 15s budget.
    evidence: |-
      A slow but valid HTML fetch can surface as an unconfirmed write
      while the route still finishes and stores.
    location: >-
      src/lib/workbench-request.ts, src/lib/fetch.ts
    severity: medium
  - summary: >-
      When store succeeds and enqueue returns `queued: false`, the batch
      sentence still says "Ingest is queued."
    evidence: |-
      The route now answers 202 with `{ queued: false, path }` so the
      tree refreshes, but `submitIntakeFile` treats any 2xx as stored()
      and `intakeReport` always uses `intakeStoredCopy`.
    location: >-
      src/lib/workbench-intake-client.ts
    severity: low
  - summary: >-
      `fetchUrlContent` skips the content-type allowlist when the
      response omits Content-Type.
    evidence: |-
      Pre-existing: `if (mimeType && !allowed.includes)` — a missing
      header is treated as acceptable. This story only passed a
      narrowed list; it did not change empty-header behaviour.
    location: >-
      src/lib/fetch.ts
    severity: low
---

<intent-contract>

## Intent

**Problem:** The Workbench can list a tenant-silo `raw/` tree (DW-40) but cannot take a Source in. Sources mode is a stub sentence; there is no Import/Upload, no shell drop, and no in-app URL. Arrival is supposed to store under `raw/sources/` and auto-queue Ingest without a second click (FR-41). Today those bytes still go to flat `raw/<slug>.md` via `saveRawSource`, which Workbench will not show, and which `bumpDataVersion` never sees (Story 1.7 leftover).

**Approach:** Add Workbench Intake — file pick, shell drag-drop, and in-app URL — that stores immutable Source bytes under `raw/sources/` through `saveRawSource` / `saveRawSourceFor`, mirrors them into the owner's raw silo so Files/Preview can see them, bumps `dataVersion`, and enqueues Ingest. Office/ebook types fail visibly. HTML URLs become Markdown via the existing Readability + `htmlToMarkdown` path.

## Boundaries & Constraints

**Always:**
- Workbench Intake (upload, drop, in-app URL) stores bytes or fetched clip Markdown under `raw/sources/` via `saveRawSource` / `saveRawSourceFor` only. No second raw-source writer.
- After DW-40, Workbench lists/reads raw silo-only. Intake writes must be visible at `tenants/<owner>/raw/sources/…` (and the flat `raw/sources/` key those helpers address). An empty owner silo must not list another tenant's or the shared flat tree's files.
- Sources are immutable after save (FR-2): a later Intake must not overwrite stored bytes. Distinct arrivals use distinct keys (`saveRawSourceFor` hash id).
- Each accepted file or URL is its own queue item and is enqueued automatically (`enqueueOrInline` / existing ingest task). No separate “Ingest” click.
- HTML URLs fetch through `fetchUrlContent` → Readability + `htmlToMarkdown` (AD-16). Do not add Turndown.
- PDF, DOCX, and other office/ebook types fail visibly on this door — no silent drop, no sidecar extract, no success path that runs `ingestDocument` extract (Epic 7).
- Tree-panel chrome uses Import/Upload, never “Open project folder” (UX-DR5). Folder picker is Story 2.2.
- Intake writes bump `dataVersion` so `DataVersionWatcher` refreshes trees without a full reload. Client nudges via `requestDataVersionCheck` after a local success.
- Auth: signed-in principal; `isReadOnly()` refuses before staging. Display copy is work-wiki; runtime ids stay `yopedia`. English only.
- Empty Sources canvas stays one muted sentence plus at most one primary (`DESIGN.md`). No illustration or emoji.

**Block If:**
- Satisfying an AC requires building folder import, Capture/bookmarklet, Plaud, Activity, two-step Analysis/Generation UI, or sidecar extract.
- A Workbench drop of PDF/DOCX would have to succeed (contradicts this story; that is Epic 7).
- A write would rename a frozen identifier (`yopedia`, `YOPEDIA_*`, `WORKWIKI_*`, `workwiki.app`, clipper keys).

**Never:**
- “Open project folder”, OS folder-watch, or mounting `BulkDocumentImport` / `/ingest` tabs into the Workbench shell.
- Activity panel, progressive Sources virtualization (2.11), Capture (2.3), Plaud (2.4), SHA256 skip UI (2.7), cascade delete (2.10), ZIP (2.12).
- Silent drop of unsupported types; inventing a Source on empty/blocked URL; mutating stored Source bytes.
- Changing Knowledge|Files tab labels, rail order, or Preview Georgia/chrome SF type.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Upload text | Signed-in owner; pick `.md`/`.txt`/`.html` via Import/Upload | Bytes at `raw/sources/` (silo-visible); ingest job enqueued; Files tree can show `raw/sources/…` after `dataVersion` refresh | No error expected |
| Shell drop | Drop one or more supported text files on `.wb-shell` (any mode) | N files → N stored Sources and N queue items | Per-item fail; successes still store/queue |
| In-app HTML URL | Submit `https://…` that returns HTML | Clip Markdown via Readability + `htmlToMarkdown`; stored + queued; Source immutable | Fetch/parse fail → visible error; no Source |
| Plain URL | URL returns `text/plain` or `text/markdown` | Body stored as Source + queued | Same visible fail if empty |
| Office drop | PDF, DOCX, PPTX, XLSX, EPUB, MOBI, or other office/ebook | No Source written; no enqueue; visible error on the intake action | Never silent; never extract |
| PDF URL | In-app URL whose response is `application/pdf` | Same as office drop | Visible error; no Source |
| Empty/blocked URL | Empty field, blocked fetch, or no extractable text | No Source invented | Failure on the URL action |
| Read-only | `YOPEDIA_READONLY` | 403; no staging, no silo write, no queue | `READ_ONLY_REFUSAL.ingest` (or equivalent already used on ingest doors) |
| Unsigned | No session | Page → sign-in; API → 401 | No write |
| Re-arrival | Same filename/bytes as an existing Source | First bytes unchanged; new arrival does not overwrite | Distinct key or refuse-overwrite; never mutate |
| Tenant isolation | Owner A intake; owner B empty silo | B's Files `raw/` stays empty | No flat `raw/` fallback |

</intent-contract>

## Code Map

- `src/lib/raw.ts:9-40` -- `saveRawSource` writes `raw/<id>.md` and overwrites; `saveRawSourceFor` writes `raw/<slug>/<hex>.md`. Both must address `raw/sources/…`, remain the only writers, and stop mutating an existing blob. `listRawSources` (`:120`) is non-recursive and will miss a `sources/` directory until updated or Workbench listing is the observed surface (Files walk is recursive).
- `src/lib/wiki.ts:57-58` / `src/lib/paths.ts:16-40` -- `rawRelPath` / `tenantRawRelPath`. Silo display root is `tenants/<t>/raw/`.
- `src/lib/silo.ts:11-15,99-100` -- DW-40: Workbench never falls back to flat raw. `syncSiloForPage` only copies `raw/<slug>.md`, not `raw/sources/…`. Intake must land silo bytes itself (or extend this sync) or Files stays empty.
- `src/lib/workbench-files.ts:157-180` -- silo-only raw resolve. Proof that a successful Intake is listed under `raw/sources/`.
- `src/lib/data-version.ts:95` -- `bumpDataVersion`. Raw writes do not bump today (1.7 deferred). Intake save must bump.
- `src/lib/ingest.ts:1741,1796` -- current callers of the two writers. Keep them on the same helpers after the path change; do not add a parallel writer.
- `src/lib/ingest-async.ts:33-59` -- `enqueueOrInline`. Reuse. Do not build Activity.
- `src/app/api/ingest/route.ts` -- `{ url }` / text already queues `ingestUrl`. Reuse for in-app URL/text. `isReadOnly` + principal already gated.
- `src/app/api/ingest/document/route.ts:51-56` -- accepts PDF/DOCX/…. **Do not** use this allowlist as the Workbench door. Vault `/ingest` page is out of scope.
- `src/lib/fetch.ts:54-62,287-293` -- `ALLOWED_CONTENT_TYPES` includes `application/pdf`; HTML path is Readability + `htmlToMarkdown`. Workbench URL door must fail PDF/office, not extract.
- `src/lib/html-parse.ts:122,321` -- `htmlToMarkdown`, `extractWithReadability`. Reuse; no Turndown.
- `src/lib/document-formats.ts:19-36` -- full office table. Workbench Intake needs a narrower text/html/markdown allowlist (new leaf or gated helper). Do not shrink the vault document table.
- `src/lib/workbench-request.ts:57-74` -- `send()` forces JSON `Content-Type`. Multipart upload cannot use it as-is; use a sibling fetch or extend without dropping the 15s deadline / `writeFailure` sentences.
- `src/lib/workbench-data-version.ts` -- `requestDataVersionCheck` after local success. Do not `router.refresh()` inside `Workbench.tsx`.
- `src/components/workbench/Workbench.tsx:1035-1141` -- `.wb-shell` has no drop handlers. Wiki-only `TreePanel`; other modes (incl. Sources) are a `.wb-left-surface` label. Attach shell `drag/drop` here; add Import/Upload + URL on tree chrome and Sources left column.
- `src/components/workbench/TreePanel.tsx` -- Knowledge\|Files only. Header actions belong with this chrome (UX-DR5), not the rail.
- `src/lib/workbench-modes.ts:42` -- Sources empty: `"No sources yet. Ingest a file to add one."` Keep unless a single primary (“Upload”) is added on the canvas. Copy stays English and one-sourced.
- `src/components/workbench/ConfirmDialog.tsx` -- single overlay for URL submit / errors. No modal stack.
- `src/components/BulkDocumentImport.tsx` -- pattern reference only; do not mount in the shell.
- `src/lib/__tests__/raw.test.ts`, `workbench-tree.test.ts` (DW-40), `workbench-left-column.test.ts:656-664` (banned “Open project folder”), `fetch.test.ts`, `ingest-async.test.ts` -- extend; do not weaken silo isolation or the folder-copy ban.
- `e2e/workbench-owner.spec.ts` -- owner fixture exists; add intake journeys if a headless file/URL path is practical. Not a substitute for unit coverage of the I/O matrix.

## Tasks & Acceptance

**Execution:**
- `src/lib/raw.ts` (and `rawRelPath` helpers they call) -- Retarget `saveRawSource` / `saveRawSourceFor` to `raw/sources/…`; do not overwrite existing bytes; write the owner's silo `tenants/<t>/raw/sources/…` so DW-40 listing sees the file; bump `dataVersion` on a successful new write -- AC path, immutability, silo visibility, and tree refresh all hang on these helpers.
- `src/lib/silo.ts` -- Stop assuming raw snapshots live only at `raw/<slug>.md` when Intake uses `raw/sources/` -- otherwise later `syncSiloForPage` and Workbench diverge.
- `src/lib/workbench-intake.ts` (new) -- Pure allowlist + reject reasons for Workbench file/URL Intake (text/markdown/html only; office/ebook/PDF fail with a sentence). Keep `document-formats.ts` vault table unchanged.
- `src/app/api/ingest/route.ts` and/or a Workbench intake route -- File/URL doors that call the helpers above then `enqueueOrInline`; refuse office/PDF URL; 401/403 before staging. Do not widen `/api/ingest/document` into this story's success path.
- `src/components/workbench/Workbench.tsx` -- Shell-level drop on `.wb-shell`; Sources left-column Import/Upload + in-app URL control; `requestDataVersionCheck` after success; visible per-item errors (`writeFailure` / dialog `error`).
- `src/components/workbench/TreePanel.tsx` -- Import/Upload in the tree-panel header (UX-DR5). No “Open project folder”. No folder-directory picker.
- `src/lib/workbench-modes.ts` -- Only if Sources empty copy gains one primary; otherwise leave the pinned sentence.
- `src/lib/__tests__/raw.test.ts` -- I/O matrix: `raw/sources/` path, silo visibility, no overwrite, dataVersion bump.
- `src/lib/__tests__/workbench-intake.test.ts` (new) -- Office/PDF/empty URL reject; HTML URL uses Readability + `htmlToMarkdown`; N files → N jobs; read-only/401.
- `src/lib/__tests__/workbench-left-column.test.ts` -- Header contains Import/Upload; still bans “Open project folder”.
- `src/lib/__tests__/workbench-tree.test.ts` -- After Intake, owner Files list includes `raw/sources/…`; empty silo still cannot see flat/legacy raw.

**Acceptance Criteria:**
- Given I am in the Workbench, when I upload, drag-drop, or submit an in-app URL, then bytes or fetched clip Markdown land under `raw/sources/` via `saveRawSource` / `saveRawSourceFor`, each item is queued for Ingest automatically, and the tree header uses Import/Upload, not “Open project folder”.
- Given I drop a PDF, DOCX, or other office/ebook type, when Intake runs, then it fails visibly, no Source is stored, and no sidecar extract job is created.
- Given the URL is HTML, when the kernel fetches it, then it becomes clean Markdown via Readability + `htmlToMarkdown`, and the stored Source is immutable after save.

## Spec Change Log

## Review Triage Log

### 2026-08-22 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 11: (high 1, medium 4, low 6)
- defer: 7: (high 0, medium 3, low 4)
- reject: 10
- addressed_findings:
  - `[high]` `[patch]` Files depth cap 3 hid `raw/sources/<slug>/<hash>.md`; raised to 4 and the join test now calls `saveRawSourceFor`
  - `[medium]` `[patch]` Overlapping pick/drop/URL while busy; gated on `intakeBusy`, disabled hidden input, `onDragEnd` overlay reset
  - `[medium]` `[patch]` Browser-expanded folder drops skipped with a visible refusal (`partitionIntakeFiles`)
  - `[medium]` `[patch]` Intake status moved onto the shell so a drop outside Wiki/Sources is visible
  - `[medium]` `[patch]` Store-then-enqueue failure now returns 202 `{ queued: false, path }` so trees refresh
  - `[low]` `[patch]` Read-only no longer lights the drop overlay
  - `[low]` `[patch]` URL draft is no longer cleared before the outcome
  - `[low]` `[patch]` Hidden file input `disabled` + `aria-hidden`
  - `[low]` `[patch]` JSON `null` body coalesced before `.url`
  - `[low]` `[patch]` `sendForm` deadline asserted in `workbench-request.test.ts`
  - `[low]` `[patch]` `silo.test.ts` covers `raw/sources/<slug>.md` sync and remove

## Design Notes

Workbench Intake is a **narrower door** than vault `/api/ingest/document`. That route's allowlist is Epic 7 / leftover `/ingest` UI. This story's surface must fail office even though the kernel can extract.

`saveRawSource` today is “latest blob per slug” and overwrites (`raw.test.ts`). FR-2 forbids that for Sources. Prefer hash-keyed `saveRawSourceFor` for new arrivals; if `saveRawSource` remains, it must refuse when the destination already exists.

`workbench-request.send` cannot POST multipart without breaking its JSON content-type invariant. File upload needs its own fetch that still uses the 15s deadline and the same unknown-outcome sentences.

Golden path (text file): picker/drop → allowlist → `saveRawSource*` → silo `raw/sources/` → `bumpDataVersion` → `enqueueOrInline` → `{ queued, jobId }` → `requestDataVersionCheck`. Files tab can show `raw/sources/<file>` without Activity (2.5).

## Verification

**Commands:**
- `pnpm exec vitest run src/lib/__tests__/raw.test.ts src/lib/__tests__/workbench-intake.test.ts src/lib/__tests__/workbench-left-column.test.ts src/lib/__tests__/workbench-tree.test.ts src/lib/__tests__/fetch.test.ts src/lib/__tests__/brand-copy.test.ts` -- expected: pass; new I/O cases green; no “Open project folder”; brand scan clean
- `pnpm exec vitest run src/lib/__tests__/ingest-document-route.test.ts` -- expected: pass (vault document allowlist unchanged)

## Auto Run Result

Status: done

**Summary:** Workbench Intake stores immutable Source bytes under `raw/sources/` via `saveRawSource` / `saveRawSourceFor`, mirrors them into the owner silo, bumps `dataVersion`, and auto-queues Ingest. Import/Upload and shell drop are in the Workbench; the in-app URL lives on Sources. Office/ebook types fail visibly. HTML URLs clip through Readability + `htmlToMarkdown`.

**Files:**
- `src/lib/raw.ts` — `raw/sources/` writers, no overwrite, silo mirror, `dataVersion` bump
- `src/lib/silo.ts` — sync/remove `raw/sources/<slug>.md` plus legacy flat
- `src/lib/workbench-intake.ts` — Workbench allowlist and copy
- `src/lib/workbench-intake-client.ts` — one request per item, folder partition, refresh rule
- `src/lib/workbench-request.ts` — `sendForm` multipart sibling
- `src/lib/fetch.ts` — caller-narrowed content-type list
- `src/lib/workbench-tree.ts` — Files depth cap 4 so hashed Intake keys list
- `src/app/api/workbench/intake/route.ts` — Workbench door; 202 if store succeeds and queue fails
- `src/components/workbench/IntakeControls.tsx` — Import/Upload + URL field
- `src/components/workbench/TreePanel.tsx` — header slot
- `src/components/workbench/Workbench.tsx` — shell drop, single-flight, shell status
- `src/app/globals.css` — intake chrome
- Tests: `workbench-intake.test.ts` (new), plus `raw`, `workbench-tree`, `workbench-left-column`, `fetch`, `silo`, `workbench-request`, `wiki`, `workbench-data-version`, `workbench-preview`

**Review:** 11 patches applied (1 high, 4 medium, 6 low). 7 deferred. 10 rejected (empty-copy keep, HTML-file vs URL clip, vault error-copy drift, unused `data-drop` comment, client size cap, `text/x-markdown`, all-fetch-as-400, oversized buffer, no mounted e2e, title-only readings).

**Follow-up review recommended:** true — patched high 1, medium 4, low 6; score `3×4 + 1×6 = 18` (≥ 5) and a high patch.

**Verification:**
- Spec command 1: 256 passed (6 files)
- Spec command 2: `ingest-document-route.test.ts` 4 passed
- Also: `workbench-request.test.ts` 25 passed; `silo.test.ts` 12 passed

**Residual risks:** Hashed Intake trees are not page-synced; identical re-arrival still enqueues (2.7); `queued: false` still reads “Ingest is queued.”; client 15s deadline can race the URL fetch.
