---
title: 'DW-233/704 — machine doors answer a miss the way the UI does'
type: 'bugfix'
created: '2026-09-05'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['multiple-goals', 'oversized']
deferred:
  - summary: >-
      A SILO-ONLY orphan the DELETE ladder now admits still cannot be deleted:
      `deleteWikiPage` re-reads the page without the owner hint the probe used,
      so the kernel throws and the row lands in `failed[]` unchanged.
    evidence: |-
      Verified empirically against the real kernel in a tmpdir (not through the
      suite's `@/lib/wiki` mock). For a page written only to
      `tenants/<t>/wiki/silo-only.md` — no flat copy, no page-index row —
      `readWikiPageWithFrontmatter(slug, {fresh, strict, owner: "alice"})`
      resolves it, so `readableOnDisk` admits it, but
      `deleteWikiPage("silo-only", "alice")` rejects with
      `page not found: silo-only`. Cause: `deleteWikiPage` reads
      `readWikiPage(slug, { fresh: true, strict: true })` with no `owner`
      option (`src/lib/lifecycle.ts`, the capture-the-title read), and
      `readWikiPage` consults the caller's silo only when
      `options?.owner !== undefined` (`src/lib/wiki.ts`, the ENOENT branch).
      The other orphan shape — a flat `wiki/<slug>.md` the index lost, which is
      the shape DW-704's ledger entry names — deletes end to end; the same
      probe confirmed that. Out of scope here on the intent's own authority:
      the bundle names the two DELETE gates, and closing this means giving the
      lifecycle delete owner-hinted resolution, a shared writer reached by
      REST, MCP, the CLI, the agent runtime and lint-fix. The route's DELETE
      doc comment states the residue and a test pins the observable outcome.
    location: >-
      src/lib/lifecycle.ts (deleteWikiPage's capture-the-title read); consumed by
      src/app/api/ingest/history/route.ts DELETE
    severity: medium
  - summary: >-
      Sibling miss-404s on the same URL family still carry no `canonicalSlug`,
      so a client that follows one door's hint gets nothing from the next.
    evidence: |-
      `GET`/`POST /api/wiki/<slug>/revisions`
      (`src/app/api/wiki/[slug]/revisions/route.ts`) answer the byte-identical
      `{ error: "page not found: <slug>" }`, and
      `src/app/api/wiki/[slug]/lineage/route.ts` and
      `GET /api/workbench/preview` answer their own fixed miss bodies. Their UI
      counterpart `/u/<handle>/<slug>` does 308. Deliberately out of scope: the
      recorded 2026-08-28 decision names "both routes", meaning
      `/api/raw/<slug>` and `/api/wiki/<slug>` themselves, and `SCHEMA.md` now
      enumerates which doors carry the field and which do not — so the
      asymmetry is documented rather than silent. Closing it is a follow-up
      decision about how wide the hint should travel, not a defect in this one.
    location: >-
      src/app/api/wiki/[slug]/revisions/route.ts; src/app/api/wiki/[slug]/lineage/route.ts;
      src/app/api/workbench/preview/route.ts
    severity: low
  - summary: >-
      The bulk-delete ACL loop's page read is non-strict, so a transient storage
      fault reads as "already gone" and silently clears a terminal job record
      whose page is still on disk.
    evidence: |-
      `src/app/api/ingest/history/route.ts`, the ACL loop's
      `readWikiPageWithFrontmatter(slug)` followed by
      `if (!page) continue; // Already gone`. Without `strict`, a non-ENOENT
      failure returns `null` rather than throwing, which is indistinguishable
      from an absent page — the same class DW-378 hardened on
      `/api/wiki/<slug>`'s write doors and DW-691 hardened inside
      `deleteWikiPage`. Pre-existing: that read and its `null` branch predate
      this change, which only added a second call site for the same read on the
      index-hidden rung, deliberately matching the existing one rather than
      diverging from it. The probe path is already correct here — a probe that
      throws is reported `failed`, never `absent`.
    location: >-
      src/app/api/ingest/history/route.ts (the ACL loop's plain read)
    severity: low
baseline_revision: '39ca33d8c29dc4bc8a55ee5b1f8e98806e6017d6'
---

<intent-contract>

## Intent

**Problem:** Two machine doors give agents a worse answer than the UI gives a browser. (a) `GET /api/raw/[slug]` and the write verbs on `/api/wiki/[slug]` hard-404 a merged-away slug naming no survivor, while the `/u/<handle>/<slug>/edit` and `/u/<handle>/raw/<slug>` page components 308 through `aliasTargetForMissing` — so an MCP client holding an old bookmark has no way to follow. (b) `DELETE /api/ingest/history` gates both of its selection checks (`route.ts:444` preflight, `route.ts:528` DW-270 read gate) on the index-backed `readable` set, while `GET` has admitted index-missing-but-readable rows since DW-432 via `readableOnDisk` — so the owner sees a listed row whose delete always answers "not found".

**Approach:** (a) Per the recorded 2026-08-28 decision, keep the 404 status and add a `canonicalSlug` field to the error envelope of every miss-404 on those two routes, projected from the same `aliasTargetForMissing` gate, and document the field in `SCHEMA.md`. (b) Per the recorded 2026-09-03 decision, run both DELETE gates through the same `readableOnDisk` probe the listing walk uses, under one shared `MAX_ORPHAN_PROBES` budget per request, explicitly superseding `spec-dw-393`'s "do not add a disk fallback for orphan slugs" delete-path constraint and recording that supersession in the route and in `spec-dw-393` itself.

## Boundaries & Constraints

**Always:**
- Every miss-404 keeps status 404 and its existing `error` sentence verbatim; `canonicalSlug` is an ADDITIVE field, present only when the gate resolves a survivor.
- The hint is projected from `aliasTargetForMissing` — principal-aware, fail-closed, `canonical !== slug` — so it can never become a private-page existence oracle. An existing-but-unreadable page (the ACL-cloak 404s) resolves to itself and therefore carries no hint.
- The hint carries the survivor SLUG only, never a tenant or handle: both doors are slug-keyed.
- The DELETE fallback runs the SAME three-step ladder GET runs, in this order: in `readable` → admitted; in `indexed` but not `readable` → refused with NO disk read (a dirty slug the index forced private must stay hidden); otherwise → one `readableOnDisk` probe.
- Probe verdicts (positive AND negative) are memoized per slug and share one `MAX_ORPHAN_PROBES` budget across both DELETE gates in a request; an exhausted budget fails CLOSED to `SELECTION_NOT_FOUND`.
- A slug admitted by the disk fallback is ACL-checked and deleted against the bytes the probe read (the owner-hinted read), never a second unhinted read — a fallback-admitted slug must not fall into the "already gone" cleanup branch and be reported as deleted.
- `SELECTION_NOT_FOUND` stays the one sentence for every refusal family DW-393 made per-entry, and `failed[]` keeps its `{ id, kind, error }` shape and submission order.
- The DW-187 read-only 403, the whole-batch delete-ACL 403 and the whole-batch queued/processing 409 are unchanged.

**Block If:** closing either gap would require distinguishing "does not exist" from "you may not read it" in any caller-visible way.

**Never:**
- Do not 308/redirect either API route — the recorded decision is "keep the 404 status".
- Do not change `GET /api/ingest/history`'s observable behaviour (listing set, read counts, its one-warn-per-request rule, its exhausted-budget warn).
- Do not put the new `SCHEMA.md` prose inside `## Page conventions` or `## Page templates` — both are sliced into runtime ingest prompts by `src/lib/schema.ts`.
- Do not touch `_bmad-output/implementation-artifacts/deferred-work.md`.
- Do not widen `readableOnDisk`'s predicate, its owner hint, or its `{ fresh: true, strict: true }` read mode.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Raw door, merged-away slug | `GET /api/raw/old-slug`; `old-slug` aliases readable `survivor`, no raw blob at `old-slug` | 404 `{ error, canonicalSlug: "survivor" }` | 404 unchanged |
| Raw door, unknown slug | `GET /api/raw/ghost`; nothing aliases it | 404 `{ error }`, no `canonicalSlug` | 404 unchanged |
| Raw door, private survivor, anonymous caller | `GET /api/raw/old-slug`; survivor is private, no principal | 404 `{ error }`, no `canonicalSlug` | Fail closed |
| Write door, merged-away slug | `PUT`/`PATCH`/`DELETE /api/wiki/old-slug` with a resolvable survivor | 404 `{ error: "page not found: old-slug", canonicalSlug: "survivor" }` | 404 unchanged |
| Write door, ACL cloak | `DELETE /api/wiki/locked`; page exists, caller may not read it | 404 `{ error }`, no `canonicalSlug` (slug resolves to itself) | No oracle |
| Delete an orphan ledger row | `DELETE {ingestIds:["ing-orphan"]}`; `page-orphan` absent from the index, readable on disk | 200; page deleted, `deletedIngestIds` contains `ing-orphan`, `failed` empty; exactly ONE probe read | Per-entry |
| Indexed-but-unreadable row | `DELETE {ingestIds:["ing-hidden"]}`; slug IS in the index, not in `readable` | 200; `failed` = one `SELECTION_NOT_FOUND` row; NO page read for that slug | Per-entry |
| Orphan unreadable on disk | `DELETE {ingestIds:["ing-orphan"]}`; probe answers not readable (or throws) | 200; `failed` = `SELECTION_NOT_FOUND`; nothing deleted | Fail closed |
| Job whose slug is an orphan | `DELETE {jobIds:["job-1"]}`; done job, slug index-missing but readable on disk | 200; page deleted and job record cleared | Per-entry |
| Same orphan slug in both gates | one batch where the preflight and the ACL loop both ask about `page-orphan` | exactly ONE `readableOnDisk` read for that slug | Memoized |

</intent-contract>

## Code Map

- `src/app/api/raw/[slug]/route.ts` -- `GET` only. Two 404 exits: the `canReadSlug` cloak (:25) and the catch-all (:44). `slug` is declared inside the `try`, so the catch needs it hoisted before the hint can be attached there.
- `src/app/api/wiki/[slug]/route.ts` -- NO `GET` handler (the DW-233 entry's premise has drifted). Miss-404s live in `DELETE` (:69 absent page, :88 ACL cloak, :113 catch when the message starts `page not found`), `PUT` (:232, :251) and `PATCH` (the `code === "NOT_FOUND"` arm at :444). `slug`/`principal` are `try`-scoped in `DELETE` and `PATCH`; hoist them for the catch arms. `PUT`'s catch never answers 404 — leave it alone.
- `src/lib/page-redirect.ts` -- owns the gate. `aliasTargetForMissing` (:46) returns `{tenant, canonical} | null`, principal-aware and fail-closed; `aliasRedirectForMissing` (:83) is the page-shaped projection. Add the envelope-shaped projection beside it — the third projection of one gate, so no route re-derives the predicate.
- `src/app/api/ingest/history/route.ts` -- `MAX_BULK_DELETE = 50` (:34), `MAX_ORPHAN_PROBES = MAX_BULK_DELETE` (:51), `SELECTION_NOT_FOUND` (:85), `ProbeResult` (:112-126), `readableOnDisk` (:181-201), `GET`'s inline ladder + memo + budget + one-warn (:266-338), `DELETE`'s `readable` set from `listReadableWikiPages` (:436-438), gate 1 (:444), the ACL loop's unhinted read (:488) and gate 2 (:528). GET's doc comment (:241-246) and DELETE's (:369-375) both state the listing-only scope that this change retires.
- `src/lib/wiki.ts` -- `listWikiPages` (:967) is what `listReadableWikiPages` (:1016) itself calls and filters; deriving both sets from one `listWikiPages()` call in DELETE is the same one-listing arrangement GET already documents.
- `src/lib/__tests__/ingest-history-delete-route.test.ts` -- the enforcing half. `beforeEach` stubs BOTH `listReadableWikiPages` (:130) and `listWikiPages` (:137); DELETE cases stub only the former (:185, :217, :260, :282, :320, :360, :469, :602, :640, :694) so they must move to `mockedListWikiPages`. The DW-393 case at :208 pins `expect(mockedReadPage).not.toHaveBeenCalledWith("page-orphan")` — that is the exact assertion this change overturns. GET's DW-432 block (:813-1179) must keep every current assertion green.
- `src/lib/__tests__/edit-raw-alias-forwarding.test.ts` -- the UI half of DW-233's parity, with a ready tmpdir + `resetAliasIndex()` harness and `@/lib/auth` mocked. The API-door cases belong here beside it.
- `SCHEMA.md` -- `## Page conventions` runs :29-125 and ends with "Alias resolution at ingest time"; `src/lib/schema.ts` slices that heading (and `## Page templates`) into runtime ingest prompts, so the new prose must be its OWN `##` section — placing it at :126, immediately before `## Talk pages (Phase 2)`, leaves the sliced body byte-identical.
- `_bmad-output/implementation-artifacts/spec-dw-393-bulk-ingest-delete-per-entry-outcomes.md` -- carries the superseded Never clause ("Do not add a disk fallback for orphan slugs").

## Tasks & Acceptance

**Execution:**
- `src/lib/page-redirect.ts` -- add an exported envelope-shaped projection of `aliasTargetForMissing` returning the spreadable `{ canonicalSlug }` (or an empty object), documented as the machine-door counterpart of `aliasRedirectForMissing` -- one gate, three projections, so no route re-derives the fail-closed predicate.
- `src/app/api/raw/[slug]/route.ts` -- hoist `slug`/`principal` out of the `try` and spread the hint into both 404 envelopes -- the catch is the exit a merged-away slug with no raw blob actually takes.
- `src/app/api/wiki/[slug]/route.ts` -- spread the hint into the miss-404s of `DELETE` (both in-body exits + the catch's 404 arm), `PUT` (both in-body exits) and `PATCH` (the `NOT_FOUND` arm), hoisting `slug`/`principal` in `DELETE` and `PATCH`; note in the file header that this route has no `GET` -- the DW-233 entry named one that does not exist.
- `src/app/api/ingest/history/route.ts` -- extract GET's ladder (readable → indexed → probe) plus its memo, shared budget and one-warn into a per-request prober used by BOTH handlers; have the probe carry back the page it read; switch `DELETE` to one `listWikiPages()` call for `indexed`+`readable`, run both gates through the prober, and reuse a fallback-admitted slug's probed page for the ACL check instead of the unhinted re-read -- record in the two doc comments that the 2026-09-03 decision supersedes DW-393's delete-path constraint.
- `src/lib/__tests__/ingest-history-delete-route.test.ts` -- move the DELETE cases' listing stubs to `listWikiPages`, rewrite the DW-393 orphan case to the new outcome, and add the matrix's DELETE rows (orphan deleted, indexed-but-unreadable never read, probe-negative and probe-throws refused, job-path orphan, one probe for a slug both gates ask about) -- the suite is where the superseded constraint was pinned, so it is where the supersession must be re-pinned.
- `src/lib/__tests__/edit-raw-alias-forwarding.test.ts` -- add a describe for the two machine doors covering the matrix's raw and write-door rows, including the no-hint cases (unknown slug, anonymous caller + private survivor, ACL cloak) -- the parity claim is only real if the UI and API halves are asserted against the same seeded alias.
- `SCHEMA.md` -- add a new `##` section at :126 documenting `canonicalSlug`: which doors emit it, that the status stays 404, that it is absent unless a readable survivor resolves, and that it is slug-only.
- `_bmad-output/implementation-artifacts/spec-dw-393-bulk-ingest-delete-per-entry-outcomes.md` -- annotate the superseded Never clause in place with the 2026-09-03 decision and this spec's filename -- a future reader of that clause must not act on a constraint that has been overturned.

**Acceptance Criteria:**
- Given a merged-away slug whose survivor the caller may read, when any of the six machine-door miss-404s answers, then the body carries `canonicalSlug` naming the survivor and the status is still 404.
- Given a page that exists but the caller may not read, when a write door cloaks it as 404, then the body carries no `canonicalSlug`.
- Given a ledger row `GET /api/ingest/history` lists only through its orphan fallback, when its owner selects it for `DELETE`, then the page is deleted and the row is reported in `deletedIngestIds`, not in `failed[]`.
- Given a slug the page index knows but the caller may not read, when `DELETE` evaluates it, then it is refused with `SELECTION_NOT_FOUND` and no page read is spent on it.
- Given `pnpm test`, when the suite runs, then every pre-existing `GET /api/ingest/history` DW-432 assertion is still green.

## Spec Change Log

## Review Triage Log

### 2026-09-05 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 11: (high 0, medium 4, low 7)
- defer: 3: (high 0, medium 1, low 2)
- reject: 8: (high 0, medium 0, low 8)
- addressed_findings:
  - `[medium]` `[patch]` The job-path orphan test modelled the SILO-ONLY shape (`options?.owner ? page : null`) and then asserted the page was deleted — a claim only the `deleteWikiPage` mock could satisfy, since the real kernel throws for that shape. Re-fixtured to the flat index-missing orphan the kernel really deletes, keeping (and tightening) what the case existed to pin.
  - `[medium]` `[patch]` The silo-only residue was undocumented and unpinned. Added a "what the ladder knowingly leaves behind" paragraph to the DELETE doc comment naming the kernel's unhinted re-read, plus a test asserting the observable outcome: the ladder admits, `deleteWikiPage` is attempted and throws, `failed[]` carries the kernel's own message (not `SELECTION_NOT_FOUND` — a delete-time throw has always been its own family), and the batch is not vetoed.
  - `[medium]` `[patch]` The recorded 2026-09-03 decision asks to pin that "a row the same route just listed can be selected and cleared", but GET and DELETE were asserted in separate describes over independently built stubs. Added a round-trip case over ONE set of stubs.
  - `[medium]` `[patch]` A fallback-admitted orphan that is readable but NOT writable is a newly reachable whole-batch 403 (the intended parity with indexed pages) with nothing pinning it. Added the case.
  - `[low]` `[patch]` `MAX_BULK_DELETE` still called the two bounds "TWO unrelated things" while the same block built DELETE's no-exhaustion argument out of their relationship; `MAX_ORPHAN_PROBES` still called itself "an unrelated bound". Both reconciled.
  - `[low]` `[patch]` `readableOnDisk`'s `principal` comment named only `GET` as the caller whose 401 makes the non-null claim true. Names both doors now.
  - `[low]` `[patch]` The exhausted-budget warn was listing-shaped ("ledger row(s) … stayed hidden") but now fires from DELETE too, where the units are selected ids and the outcome is a refusal. The prober takes a door label and the line reports accurate units for both.
  - `[low]` `[patch]` Three suite comments still described the removed gate (`listReadableWikiPages`, the deleted `readable.has(slug)` expression) and the DW-270 job case's "the page never reaches the ACL", which the rung-3 probe now contradicts. All brought to what the code does.
  - `[low]` `[patch]` The new `SCHEMA.md` section's parenthetical pointed a machine reader at `GET /api/workbench/preview`, which carries no hint, directly under "which doors emit it". Replaced with explicit does/does-not lists.
  - `[low]` `[patch]` Three doc sites justified the field with "an MCP client holding a merged-away bookmark", but MCP tools dispatch through `src/lib/mcp-http.ts` → `src/mcp.ts` and never reach these handlers. Reworded to the callers this actually serves, with the MCP surface named as uncovered.
  - `[low]` `[patch]` The `DELETE /api/wiki/<slug>` catch's 404 arm carried no note, unlike its inert siblings. It is narrow rather than inert — reaching it means the page was merged away mid-request — and now says so.

## Design Notes

The two halves share one shape: a gate that already exists is projected to a second caller instead of being re-derived.

DW-233 — `aliasTargetForMissing` returns PARTS precisely so each surface builds its own answer. The page routes build URLs; the machine doors build an envelope field. So the new projection sits beside `aliasRedirectForMissing`:

```ts
// The envelope-shaped projection ... slug only: both doors are slug-keyed.
export async function canonicalSlugHintForMissing(slug, principal) {
  const target = await aliasTargetForMissing(slug, principal);
  return target ? { canonicalSlug: target.canonical } : {};
}
```

Spread at each 404 site (`{ error: msg, ...hint }`), it is inert wherever the gate answers `null` — which is exactly the ACL-cloak case, since the alias index maps every live slug to itself.

DW-704 — GET's ladder is the shared thing, not just `readableOnDisk`. Copying the memo/budget/one-warn into DELETE is how the two answers drift; a per-request prober holding `indexed`, `readable`, the memo and the budget gives both handlers one ladder and one budget. DELETE's batch cap (`MAX_BULK_DELETE = 50`) already bounds its distinct slugs at or below `MAX_ORPHAN_PROBES`, so the budget cannot bite there today — it is kept because the constants are documented as separable, and it fails closed if they ever diverge.

The subtle half is the ACL loop's read. It reads unhinted (`readWikiPageWithFrontmatter(slug)`) and treats `null` as "already gone, clear the record". A silo-only orphan — the case the probe's `owner` hint exists for — answers `null` there, so without reusing the probed page the owner would be told the row was deleted while `GET` keeps listing it. Carrying the page out of `ProbeResult` fixes that and removes a second read.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/ingest-history-delete-route.test.ts src/lib/__tests__/edit-raw-alias-forwarding.test.ts src/lib/__tests__/wiki-routes.test.ts` -- expected: all green, including every pre-existing DW-432 GET assertion.
- `pnpm test` -- expected: no new failures against the baseline.
- `pnpm lint` -- expected: clean.
- `pnpm exec tsc --noEmit` -- expected: clean.

## Auto Run Result

Status: done

### Summary

Two machine doors now answer a miss the way the UI already does.

**DW-233** — `GET /api/raw/<slug>` and the write verbs on `/api/wiki/<slug>` keep their 404 (per the recorded 2026-08-28 decision — an API caller is not a browser) and add an additive `canonicalSlug` field naming the survivor, projected from the same principal-aware, fail-closed `aliasTargetForMissing` gate the page routes redirect through. Six 404 sites carry it; the ACL-cloak arms resolve to themselves and stay silent, so no existence oracle is created. The entry's premise had drifted — `/api/wiki/<slug>` has no `GET` handler — and the route header now records that.

**DW-704** — GET's three-rung admission ladder (`readable` → `indexed` → one `readableOnDisk` probe), its memo, its shared `MAX_ORPHAN_PROBES` budget and its one-warn-per-request rules were extracted into `createOrphanProber` and are now run by both handlers. `DELETE`'s two gates therefore ask the same question the listing asks, so a ledger row `GET` surfaces through its orphan fallback can be selected and cleared. The probe carries its bytes out, so a fallback-admitted slug is ACL-checked and deleted against what the probe read rather than a second unhinted read. The supersession of `spec-dw-393`'s "do not add a disk fallback for orphan slugs" is recorded in both route doc comments and struck through in place in that spec.

### Files changed

- `src/lib/page-redirect.ts` — added `canonicalSlugHintForMissing`, the envelope-shaped third projection of the one alias gate.
- `src/app/api/raw/[slug]/route.ts` — hoisted `slug`/`principal` so the catch (the exit a merged-away slug actually takes) can answer, and spread the hint into both 404s.
- `src/app/api/wiki/[slug]/route.ts` — hint on `DELETE`'s three 404 arms, `PUT`'s two and `PATCH`'s `NOT_FOUND` arm; header records that this route has no `GET`.
- `src/app/api/ingest/history/route.ts` — extracted `createOrphanProber`; `ProbeResult` gained `absent` and `page`; `DELETE` derives `indexed`+`readable` from one `listWikiPages()` call and runs both gates through the ladder; index-hidden slugs keep the already-gone cleanup read.
- `src/lib/__tests__/ingest-history-delete-route.test.ts` — DELETE stubs moved to `listWikiPages`; the DW-393 assertion this change overturns rewritten; new cases for the orphan delete, the indexed-but-unreadable rung, probe-negative, probe-throws, the job path, the GET→DELETE round trip, the readable-but-unwritable 403, the silo-only residue and the stale-index cleanup.
- `src/lib/__tests__/edit-raw-alias-forwarding.test.ts` — new machine-door describe covering all DW-233 matrix rows against the same seeded alias as the UI half.
- `SCHEMA.md` — new `## Alias hints on API misses (canonicalSlug)` section, placed outside the headings `src/lib/schema.ts` slices into runtime ingest prompts.
- `_bmad-output/implementation-artifacts/spec-dw-393-bulk-ingest-delete-per-entry-outcomes.md` — the superseded Never clause struck through in place with the date and this spec's filename.

### Review findings breakdown

- Patches applied: 11 (medium 4, low 7). See the Review Triage Log entry above.
- Items deferred: 3 (medium 1, low 2) — recorded in frontmatter `deferred`.
- Items rejected: 8. Notably: the claim that a batch can name 100 distinct slugs against a 50-probe budget (the handler rejects `ingestIds.length + jobIds.length > MAX_BULK_DELETE`, so the argument in the constants' doc comments holds); the raw door answering 200 with an archived blob for a merged-away slug (deliberate, and the same gating the raw page component uses); inlining the `canReadEntry` filter in DELETE (GET does exactly this — the shared arrangement is the point); a timing-oracle hypothesis with no evidence.
- Follow-up review recommended: **false** — 0 patched findings were high severity (4 medium, 7 low).

### Verification

- `pnpm exec vitest run --project node src/lib/__tests__/ingest-history-delete-route.test.ts src/lib/__tests__/edit-raw-alias-forwarding.test.ts src/lib/__tests__/wiki-routes.test.ts` — 170 passed, 0 failed.
- `pnpm test` — 386 files, 9714 passed, 1 skipped, 0 failed.
- `pnpm lint` — clean (only the pre-existing `jsx-ast-utils` TSNonNullExpression notices).
- `pnpm exec tsc --noEmit` — clean.
- Matrix test audit: all ten I/O matrix rows have a covering test that ran and passed.
- Out-of-band check against the REAL kernel (throwaway suite in a tmpdir, since the route suite mocks `@/lib/wiki`): a flat index-missing orphan is deleted by `deleteWikiPage`; a silo-only orphan is not. That result drove two of the patches above and the medium deferred finding.

### Residual risks

- The silo-only orphan remains undeletable (deferred, medium). The ladder admits it for parity with the listing, the kernel refuses it, and the row lands in `failed[]` with the kernel's own message — an honest failure rather than the previous "not found", but still not cleared. The DELETE doc comment and a test state this rather than leaving it implicit.
- `SCHEMA.md` is loaded into runtime ingest prompts, but only its `## Page conventions` and `## Page templates` sections. The new section is a sibling `##` placed after the former's body, so both sliced bodies are byte-identical to before; the full suite (which scans this file for brand and English-only rules) is green.
