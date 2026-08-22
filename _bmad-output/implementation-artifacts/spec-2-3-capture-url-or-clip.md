---
title: 'Story 2.3: Capture URL or clip'
type: 'feature'
created: '2026-08-22'
status: 'done'
baseline_revision: '9c65d7ca6ab358b48a2923905e4653754d2e8ce4'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
warnings: []
deferred:
  - summary: >-
      A long bookmarklet selection can make the `/save` query exceed the
      browser URL length, so the popup never opens.
    evidence: |-
      `buildBookmarklet` concatenates `encodeURIComponent(getSelection())`
      into a GET query with no cap. Typical selections fit; a whole-page
      select may not.
    location: >-
      src/lib/share-target.ts
    severity: low
  - summary: >-
      `isIntakeUrl` rejects a non-lowercase `HTTP://` scheme, so Capture
      can treat a resolved URL as missing.
    evidence: |-
      Pre-existing 2.1 helper. Bookmarklet `location.href` is usually
      lowercase; a hand-typed share is the rare case.
    location: >-
      src/lib/workbench-intake.ts
    severity: low
  - summary: >-
      A loose-file identical re-arrival still creates an Ingest job after
      the hash writer declines the rewrite. Content-hash skip remains
      Story 2.7.
    evidence: |-
      Capture uses `saveRawSourceFor`. Same residual as spec-2-1 and
      spec-2-2 on the hash door.
    location: >-
      src/app/api/workbench/intake/route.ts
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Bookmarklet, share, and `/save` still POST `/api/ingest` (vault queue). A page Christian is reading never becomes a Workbench Source under `raw/sources/`. In-app URL already uses Intake (2.1); Capture does not.

**Approach:** Point Capture at the same Intake door. A URL fetches to clean Markdown; a non-empty clip stores that text. Both carry the captured URL as provenance. Empty or blocked Capture fails on that action and invents no Source.

## Boundaries & Constraints

**Always:**
- Same door as 2.1/2.2: signed-in principal, `isReadOnly()` before any write, `saveRawSourceFor` (hash key), silo + `dataVersion` bump, `enqueueOrInline`, English copy, frozen `yopedia` / `WORKWIKI_*` ids.
- Provenance `sourceUrl` on the ingest Task / `IngestOptions`. A clip still requires a captured URL (FR-25).
- Unsigned Capture stays fail-closed (existing `/save` sign-in). Read-only answers the same 403 sentence as Intake.
- Surfaces stay bookmarklet, PWA/share/`/save`, and the Sources URL field. Capture is not a rail icon.
- Empty or blocked: visible sentence on the Capture action; no Source, no job.

**Block If:**
- Satisfying an AC requires Activity (2.5), two-step Analysis UI (2.6), SHA256 skip UI (2.7), Plaud (2.4), sidecar extract, or mounting `BulkDocumentImport`.
- A write would rename a frozen identifier (including clipper `workwikiDefaultTags` / `save-to-workwiki`).

**Never:**
- `SaveCapture` posting `/api/ingest`, or filing through `IngestVaultPicker` / Capture tags.
- A Capture rail icon, Chrome Web Store work, or retargeting `integrations/browser-clipper/`.
- Inventing a Source when the URL is missing, the fetch is blocked, or the clip/page body is empty.
- Changing Knowledge|Files labels, rail order, or Preview type.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| URL Capture | Bookmarklet/share/`/save?url=` or Sources URL | Fetch → clean Markdown at `raw/sources/<slug>/<hash>.md`; one job; Task has `sourceUrl` | No error expected |
| Clip + URL | Selection or share `text` besides the URL | Store the clip text (no fetch); same hash writer; `sourceUrl` set | No error expected |
| Empty | No URL, or empty clip+fetch body | No Source; sentence on the Capture action | No invented Source |
| Blocked | Fetch fails (blocked host, PDF/office type) | 400 sentence on Capture; no write | Never silent |
| Unsigned | No session on `/save?url=` | Sign-in; no write | Fail closed |
| Read-only | `YOPEDIA_READONLY` | 403 Intake sentence; no write | Existing copy |

</intent-contract>

## Code Map

- `src/components/SaveCapture.tsx:41-49` -- POSTs `/api/ingest` with `vaultId`/`tags`. Retarget to `INTAKE_ROUTE` via `submitIntakeUrl` (clip in the JSON). Drop `IngestVaultPicker`, tags, and `rememberRecentJob`. Show the Intake error on this action. Dismiss to `/`, not `/ingest`.
- `src/lib/workbench-intake-client.ts:131-146` -- `submitIntakeUrl` sends `{ url }` only. Accept optional `clip`; POST `{ url, clip }` when the clip is non-empty.
- `src/app/api/workbench/intake/route.ts:156-200` -- `intakeUrl` always fetches. If JSON `clip` is a non-empty string, store that text with `sourceUrl` and skip `fetchUrlContent`. Empty clip keeps the 2.1 fetch. Cap clip size with `MAX_DOCUMENT_SIZE`. Missing/non-string `clip` is absent, not hashed.
- `src/lib/share-target.ts:15-23,45-52` -- Bookmarklet sends url+title only. Add `getSelection()` as `text`. Add a helper that returns clip text after stripping the resolved URL (share leftover / selection). `resolveSharedUrl` stays the URL resolver.
- `src/app/save/page.tsx:27-33` -- Passes only `url`/`title`/`tags` into `SaveCapture`. Pass the resolved clip; drop tags. No-URL query still must not invent a Source — show Capture with the empty sentence rather than silently opening only the guide when `text` was a clipless non-URL.
- `src/components/SaveGuide.tsx` -- Keep the three no-extension surfaces. Do not add an extension install path.
- `src/app/manifest.ts:27-31` -- `share_target` already GETs `/save` with url/text/title. Leave the shape; do not add a rail icon.
- `src/lib/__tests__/workbench-intake.test.ts:695+` -- Add clip-stores-without-fetch, clip+url provenance, empty clip still fetches, blocked fetch still invents nothing.
- `src/lib/__tests__/share-target.test.ts:42-50` -- Pin bookmarklet `getSelection` / `text=` and the clip helper.
- `src/lib/__tests__/workbench-left-column.test.ts` -- Still no Capture rail icon; still ban “Open project folder”.
- `integrations/browser-clipper/` -- Read-only. Frozen keys.

## Tasks & Acceptance

**Execution:**
- `src/app/api/workbench/intake/route.ts` -- Honor optional JSON `clip`; skip fetch when it has text; keep `sourceUrl` -- clip identity hangs here.
- `src/lib/workbench-intake-client.ts` -- `submitIntakeUrl(url, clip?)` posts clip when present.
- `src/lib/share-target.ts` -- Bookmarklet passes selection; helper isolates clip text from the URL.
- `src/app/save/page.tsx` / `src/components/SaveCapture.tsx` -- Same Intake door; no vault/tags/`/api/ingest`; errors stay on this action.
- `src/lib/__tests__/workbench-intake.test.ts` / `share-target.test.ts` -- I/O matrix: URL, clip+URL, empty, blocked.

**Acceptance Criteria:**
- Given Capture sends a URL or a clip with a URL, when the kernel receives it, then it is stored under `raw/sources/` and queued like any other arrival, and provenance includes the captured URL.
- Given the payload is empty or blocked, when Intake attempts store, then the failure is visible on the Capture action and no Source is invented.
- Given the icon rail, when I look for Capture, then it is not there.

## Spec Change Log

## Review Triage Log

### 2026-08-22 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 6, low 2)
- defer: 3: (high 0, medium 1, low 2)
- reject: 9
- addressed_findings:
  - `[medium]` `[patch]` Dead Title field never reached Intake; removed it from Capture
  - `[medium]` `[patch]` Clip-without-URL still enabled Save; Save is disabled and `save()` returns before POST
  - `[medium]` `[patch]` Unconfirmed Intake outcome no longer offers Retry
  - `[medium]` `[patch]` `isolateCaptureClip` strips URL tokens (not raw prefix split) and collapses whitespace
  - `[medium]` `[patch]` SaveGuide lede names selection as well as fetch
  - `[medium]` `[patch]` Tests pin `submitIntakeUrl(url, clip)` and `attempted ? <SaveCapture`
  - `[low]` `[patch]` Bookmarklet JSDoc/test title include `text=` / `getSelection()`
  - `[low]` `[patch]` Clip job title is sliced to 200 characters

## Design Notes

In-app URL (2.1) is already Intake. This story is the `/save` family using that door, plus an optional clip body so a selection or share leftover is not discarded.

A clip without a URL cannot satisfy FR-25 provenance — refuse it on the Capture action.

`/api/ingest` stays for leftover vault UI. Capture must not call it.

Golden path (URL): bookmarklet → `/save?url=` → confirm → `submitIntakeUrl` → `fetchUrlContent` → `saveRawSourceFor` → `enqueueOrInline` with `sourceUrl`.

Golden path (clip): selection on `text=` → same POST with `clip` → store clip, no fetch.

## Verification

**Commands:**
- `pnpm exec vitest run src/lib/__tests__/workbench-intake.test.ts src/lib/__tests__/share-target.test.ts src/lib/__tests__/workbench-left-column.test.ts src/lib/__tests__/brand-copy.test.ts` -- expected: pass; clip/URL cases green; no Capture rail icon; brand scan clean
- `pnpm exec vitest run src/lib/__tests__/ingest-document-route.test.ts` -- expected: pass (vault document door unchanged)

## Auto Run Result

Status: done

**Summary:** Capture (bookmarklet, share, `/save`) files through Workbench Intake. A URL fetches to clean Markdown; a non-empty clip is stored as that text. Both keep `sourceUrl`. Empty or blocked Capture fails on that action and invents no Source. Vault picker, tags, and `/api/ingest` are gone from this action.

**Files:**
- `src/app/api/workbench/intake/route.ts` — optional JSON `clip`; skip fetch; title cap 200
- `src/lib/workbench-intake-client.ts` — `submitIntakeUrl(url, clip?)`
- `src/lib/share-target.ts` — selection on bookmarklet; `isolateCaptureClip`; `captureFromQuery`
- `src/app/save/page.tsx` — Capture when `url`/`text` present, including clipless non-URL
- `src/components/SaveCapture.tsx` — Intake door; no vault/tags/title field; gated Save; unconfirmed has no Retry
- `src/components/SaveGuide.tsx` — lede mentions selection
- Tests: `workbench-intake`, `share-target`, `workbench-left-column`

**Review:** 8 patches applied (0 high, 6 medium, 2 low). 3 deferred. 9 rejected (share leftover as specified clip, discard-leftover UI, clip overflow restyle, URL-action copy, input/textarea selection, title-only share, Sources field must send clip, Chrome clipper, mounted RTL `/save` beyond source pins).

**Follow-up review recommended:** true — patched high 0, medium 6, low 2; score `3×6 + 1×2 = 20` (≥ 5).

**Verification:**
- Spec commands: 161 passed (5 files)

**Residual risks:** Long selections may overflow the bookmarklet query; share leftover commentary still stores as the clip (per the I/O matrix); `/api/ingest` remains for leftover vault UI.
