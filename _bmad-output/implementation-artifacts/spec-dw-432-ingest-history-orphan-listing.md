---
title: 'DW-432 decision — bounded per-page read fallback for the ingest-history listing'
type: 'bugfix'
created: '2026-09-01'
status: 'done'
review_loop_iteration: 1
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      A ledger row the listing now surfaces because its page is on disk but
      missing from the page index is still refused by DELETE, so the owner sees
      a row that can never be cleared.
    evidence: |-
      GET now admits an index-missing slug whose page the caller can read
      (src/app/api/ingest/history/route.ts, the orphan probe in the ledger
      walk). DELETE was deliberately left alone: its `ingestIds` preflight and
      its DW-270 read gate both test the index-backed `readable` set built from
      `listReadableWikiPages`, so the same row answers `SELECTION_NOT_FOUND` and
      lands in `failed[]`. The owner therefore gets a visible, selectable row
      whose delete always fails with a sentence that says it was "not found",
      which is a wrong answer about a row the same route just listed. The gap is
      the second half of this bundle's own decision ("orphan rows list AND
      become deletable"); it was not shipped because that decision also says "on
      this listing path only", and `spec-dw-393-bulk-ingest-delete-per-entry-outcomes.md`
      shipped the opposing constraint for the delete path ("Do not add a disk
      fallback for orphan slugs -- the ledger/index contract stays as-is").
      Closing it means overturning a shipped human decision, which an unattended
      run must not do alone.
    location: >-
      src/app/api/ingest/history/route.ts (DELETE ingestIds preflight and the
      DW-270 read gate)
    severity: medium
baseline_revision: 'd39b66fea401554bb6be1bc202fdf11e868c4fae'
---

<intent-contract>

## Intent

**Problem:** `GET /api/ingest/history` scopes the ledger with `readable.has(e.primary_slug)`, where `readable` is built solely from the page INDEX (`listReadableWikiPages`). An ORPHAN page — on disk but absent from the index, the drift `checkOrphanPages` exists for — therefore has its ledger row silently dropped from the list, so the owner never sees the row and can never select it, and the `ingestIds` delete path for that row is unreachable from the UI.

**Approach:** On this listing path only, when a ledger entry's `primary_slug` is missing from the index, fall back to a per-page read of that slug and admit the entry only if the page exists AND the caller may read its frontmatter — spending at most `MAX_BULK_DELETE` such reads per request so the cost stays bounded. The read-scoping guarantee is unchanged: the fallback re-derives the SAME predicate (`canReadPage`) from frontmatter that `canReadEntry` derives from an index entry, so no page becomes visible that the index would not have shown had it been indexed.

## Boundaries & Constraints

**Always:**
- The fallback admits a slug ONLY when `readWikiPageWithFrontmatter(slug)` returns a page AND `canReadFrontmatter(page.frontmatter, principal)` is true. A missing page, a throwing read, and an unreadable page all fail CLOSED (entry stays hidden), exactly as today.
- At most `MAX_BULK_DELETE` (50) fallback page reads per GET, counted over DISTINCT slugs; a slug probed once is not re-read for a second ledger row naming it. Entries whose slug is missing from the index after the budget is spent stay hidden — same outcome as today, never an error.
- Entries whose slug IS in the index take the index answer with zero extra reads, so the common request performs the same work it performs today.
- Ledger order (most-recent-first) and the `limit` slice semantics are preserved: at most `limit ?? 50` entries returned, in ledger order.
- The response shape stays `{ entries, readOnly }`; `readOnly: isReadOnly()` (DW-265) still rides along on every 200.
- The 401 for an absent principal and the 400 for a non-positive/NaN `limit` both still answer BEFORE any ledger or page read.

**Block If:** making an orphan row deletable would require distinguishing "does not exist" from "you may not read it" in any caller-visible way.

**Never:**
- Do not add the fallback to `DELETE /api/ingest/history`. The decision scopes it to "this listing path only", and `spec-dw-393-bulk-ingest-delete-per-entry-outcomes.md` shipped the opposite constraint for the delete path ("Do not add a disk fallback for orphan slugs... the ledger/index contract stays as-is"). Overturning a shipped decision is not this bundle's call — the residual gap is recorded as deferred work instead.
- Do not change `listReadableWikiPages`, `canReadPage`/`canReadEntry`/`canReadFrontmatter`, the page index, or any other list-consuming surface (browse, graph, search, query, export, trail, profiles). The whole point of "this listing path only" is that the disk fallback does not spread to them.
- Do not change `SELECTION_NOT_FOUND`, `WRITE_DENIAL*`, `READ_ONLY_REFUSAL`, or any DELETE-side behaviour, and do not touch `src/components/RecentIngests.tsx` — orphan rows arrive as ordinary `LedgerEntry` objects and need no client change.
- Do not touch `.github/` (protected by AGENTS.md) or `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Indexed page (unchanged) | ledger `ing-a`→`page-a`; `page-a` in index | 200; entry listed; `readWikiPageWithFrontmatter` NOT called | No error |
| Readable orphan | `ing-orphan`→`page-orphan`; index empty; disk page owned by caller | 200; entry listed; exactly one page read for `page-orphan` | No error |
| Unreadable orphan | `page-bob` on disk, `visibility: private`, `owner: "bob"`; caller `owner` | 200; entry NOT listed | Fail closed |
| Deleted page | slug absent from index AND `readWikiPageWithFrontmatter` → `null` | 200; entry NOT listed (the "once a page is gone" rule) | Fail closed |
| Read throws | `readWikiPageWithFrontmatter` rejects for one slug | 200; that entry NOT listed; other entries unaffected; no 500 | Caught per slug |
| Budget exhausted | 60 distinct index-missing slugs, all readable on disk | 200; at most 50 page reads; only entries resolved within budget listed | No error |
| Repeated slug | two ledger rows share one index-missing readable slug | 200; both rows listed; that slug read exactly ONCE | No error |
| Limit honoured | `?limit=1` with a readable indexed row first | 200; one entry; no more reads than needed | No error |
| Unauthenticated | no principal | 401 `{ error: "Unauthorized" }`; no ledger or page read | Unchanged |
| Bad limit | `?limit=0` / `?limit=abc` | 400 `limit must be a positive integer`; no ledger or page read | Unchanged |
| Read-only deployment | `YOPEDIA_READONLY=1` | 200 with `readOnly: true` and the entries — the READ is never refused | Unchanged |

</intent-contract>

## Code Map

- `src/app/api/ingest/history/route.ts` -- the whole change. `MAX_BULK_DELETE` (L21) is the cap the human decision names by name; keep it as the source of truth and add a `const MAX_ORPHAN_PROBES = MAX_BULK_DELETE;` alias beside it so the listing budget reads as its own concept at its use site without inventing a second number. `GET` (L94-137): the doc comment at L82-93 claims "O(1) page index + in-memory canReadEntry" and must be amended. The filter is L114-119 (`readable` set -> `.filter(...)` -> `.slice(0, limit ?? 50)`); replace with a single ledger walk. The outer `try/catch` (L130-136) stays. `DELETE` (L152-423) is UNTOUCHED -- including its own `listReadableWikiPages` call at L211-213, its `ingestIds` preflight at L217-227, and the DW-270 read gate at L303-306.
- **`readable` is NOT the index.** `listReadableWikiPages` (`src/lib/wiki.ts:865`) is `listWikiPages().filter(canReadEntry)` -- index membership AND readability, collapsed into one set. Probing every slug absent from THAT set probes every indexed page the caller may not read (other users' private ingests -- the exact population this route's scoping exists to hide), which is a per-request read regression on the busiest multi-user path and burns the budget on rows that will be hidden anyway. GET must derive the two sets separately from ONE `listWikiPages()` call: `indexed` = every slug it returns, `readable` = the subset passing `canReadEntry(entry, principal)` (`src/lib/authz.ts:115`). Probe only slugs absent from `indexed`.
- **The probe must use the index's own authoritative read.** `listWikiPages` re-reads every dirty slug with `{ fresh: true, strict: true }` and, when that read throws or returns null, forces `visibility: "private"` so a non-owner cannot see it (`src/lib/wiki.ts:830-846`, "Missing/unreadable authoritative bytes are not permission to expose a stale public row"). A plain cached read can succeed where that hardening failed -- `pageCache` is module-global and ref-counted across bulk scans (`src/lib/wiki.ts:338-368`) -- so the fallback would list a row the index deliberately hid, breaking the Always invariant that no page becomes visible here that the index would not have shown. The probe therefore reads `{ fresh: true, strict: true, owner: principal.handle }` and treats BOTH `null` and a throw as not-readable, which is the same fail-closed direction `listWikiPages` takes.
- **`owner` is what finds the orphan at all.** `ReadWikiPageOptions.owner` (`src/lib/wiki.ts:392-398`) checks the caller's tenant silo only after global Page identity (page index, then the flat copy) finds nothing, and its documented purpose is verbatim "Ingest uses this to recover its own crash-left silo without allowing that hint to displace another owner's committed same-slug Page". A crash-left silo orphan is the main orphan class this fix targets and is invisible without it. It cannot displace anyone else's page, and `canReadFrontmatter` still gates the result.
- `src/lib/authz.ts:123` `canReadFrontmatter` -- the exact per-page counterpart of `canReadEntry` (both delegate to `canReadPage`, L89). Import both; do NOT restate the predicate. Type the principal parameter with the exported `Reader` type that `canReadPage`/`canReadEntry`/`canReadSlug` already use, not `Parameters<typeof ...>`.
- `src/lib/wiki.ts:558` `readWikiPageWithFrontmatter` -- returns `{ frontmatter, body, ... } | null`; already imported by this route for the DELETE ACL loop. `src/lib/wiki.ts:816` `listWikiPages` -- the unfiltered index listing to import.
- `src/lib/ingest.ts:176` `LedgerEntry` (`ingest_id`, `primary_slug`, ...) and `readLedger` (L201, most-recent-first) -- the shape and order the walk preserves.
- `src/lib/__tests__/ingest-history-delete-route.test.ts` -- the pins, node project (`.test.ts`). The `@/lib/wiki` mock (L15-24) is a PARTIAL stub and must gain `listWikiPages`; every existing case that stubs only `listReadableWikiPages` still drives DELETE, which is untouched, so give `listWikiPages` a `beforeEach` default consistent with the existing `[page-a]` fixture. `@/lib/authz` is mocked with an `importOriginal` spread (L39-42), so `canReadEntry`/`canReadFrontmatter` are already REAL. `beforeEach` is L110-143. `describe("GET ...serves the read-only fact")` (L747-782) and every DELETE case (L155-737) must stay green UNCHANGED.
- `src/components/RecentIngests.tsx:126` -- read-only evidence: consumes `entries` verbatim from this GET. No change needed.

## Tasks & Acceptance

**Execution:**
- `src/app/api/ingest/history/route.ts` -- add `MAX_ORPHAN_PROBES` (aliasing `MAX_BULK_DELETE`) and a module-local helper resolving ONE index-missing slug via `readWikiPageWithFrontmatter(slug, { fresh: true, strict: true, owner: principal.handle })` + `canReadFrontmatter`, with `null` and any throw both answering `false` and the throw logged through `logger.warn` (the swallow is otherwise the only silent one on this path) -- one named seam, stating the predicate once and matching the index's own authoritative read.
- `src/app/api/ingest/history/route.ts` -- in `GET`, derive `indexed` and `readable` from ONE `listWikiPages()` call plus `canReadEntry`, then replace the filter+slice with a ledger walk that: skips entries with no `primary_slug` without spending budget; admits `readable` slugs free; skips `indexed`-but-not-`readable` slugs free (never probes them); memoizes BOTH verdicts per slug; spends at most `MAX_ORPHAN_PROBES` probes; `continue`s (never `break`s) when the budget is spent; and stops once `limit ?? 50` entries are collected. Use `budget <= 0` for the exhaustion guard. Amend the GET doc comment to state the fallback, that it fires only for slugs the index does not know at all, the cap, why the read scope is unchanged, and that `limit` bounds the ANSWER while the probe budget bounds the WORK (a page of entirely unlistable rows still spends the full budget) -- delivers the decision without regressing the indexed path or the index's fail-closed hardening.
- `src/lib/__tests__/ingest-history-delete-route.test.ts` -- add a `describe` for the GET listing fallback covering every I/O matrix row PLUS these mutation-killing cases, each of which a reviewer demonstrated survives without them: (a) an indexed-but-unreadable ledger row is hidden with ZERO page reads; (b) a readable indexed row positioned AFTER the budget is fully spent is still listed and the walk did not `break`; (c) two rows naming one UNREADABLE slug cost exactly one probe (negative memoization) and leave the rest of the budget available; (d) the capped result's ids are asserted exactly, not just by length, so ledger order is pinned; (e) a row with an empty `primary_slug` is skipped without spending budget; (f) a probe is called with `{ fresh: true, strict: true, owner: <handle> }`; (g) a probe that THROWS hides its row while a sibling still lists -- the matrix is the contract and an unpinned budget, memo, or read-mode silently regresses.

**Acceptance Criteria:**
- Given a ledger row whose page is on disk (flat or in the caller's own tenant silo), readable by the caller, and absent from the page index, when the owner loads `/ingest`, then the row appears in Recent Ingests with no client change.
- Given every ledger row names a slug the page index knows -- whether or not the caller may read it -- when `GET /api/ingest/history` is served, then no page read occurs and the answer is byte-identical to today's.
- Given a slug the page index hides because its authoritative read failed, when the GET is served, then its ledger row is still absent from `entries` -- the fallback never overrides that hardening.
- Given more index-missing slugs than `MAX_ORPHAN_PROBES`, when the GET is served, then at most `MAX_ORPHAN_PROBES` page reads occur, the request answers 200, and readable indexed rows after the budget wall are still listed.
- Given a page the caller may not read, when the GET is served, then its ledger row is absent from `entries` and the answer is indistinguishable from the row simply not existing.

## Spec Change Log

### 2026-09-01 — bad_spec repair (review pass 1)

**Triggering findings.** (1) `[high]` The probe gate used `readable.has(slug)`, so it fired for every INDEXED page the caller cannot read, not only for index-missing slugs — a per-request read regression on multi-user deployments (up to 50 disk reads where there were 0), a budget starved by rows that will be hidden anyway, and a bypass of `listWikiPages`' dirty-slug hardening (`src/lib/wiki.ts:830-846`), which forces `visibility: "private"` when a slug's authoritative `{fresh,strict}` read fails; a plain cached re-read can succeed there and list a row the index deliberately hid, contradicting the intent-contract's own Always invariant. (2) `[medium]` The plain, cached, non-strict probe read can be served from the module-global `pageCache` held open across a bulk scan, admitting a row from superseded bytes. (3) `[medium]` The probe omitted `{ owner: principal.handle }`, so a crash-left tenant-silo orphan — per `ReadWikiPageOptions.owner`'s own doc the ingest case, and the main orphan class here — was never found. (4) `[medium]` Two mutants survived the suite: `continue` → `break` at budget exhaustion, and memoizing only positive verdicts.

**What was amended.** Code Map, Tasks & Acceptance and Design Notes only — `<intent-contract>` is untouched and was already correct ("Entries whose slug IS in the index take the index answer with zero extra reads"). The Design Notes sketch was the root cause: it spelled the gate as `readable.has(slug)` and asserted the plain read was correct, and the implementer followed it faithfully. The sketch now derives `indexed` and `readable` separately from one `listWikiPages()` call, probes only `!indexed.has(slug)`, and reads `{ fresh: true, strict: true, owner: principal.handle }`. The Tasks list now names the seven mutation-killing tests by hand.

**Known-bad state avoided.** A listing that silently costs 50 disk reads per request on every multi-user deployment while exposing ledger rows (`source_url` + slug) for pages the page index had deliberately hidden — the precise failure the hardening at `src/lib/wiki.ts:830-846` exists to prevent — behind a test suite that cannot see either problem.

**KEEP (must survive re-derivation).** The single-pass ledger walk with a per-slug memo and an early stop at `limit ?? 50`, in ledger order. Budget exhaustion hides a row and never errors. The `readableOnDisk`-style named seam that states the predicate once by delegating to `canReadFrontmatter` rather than restating `canReadPage`. The doc-comment substance explaining WHY the read scope is unchanged (`canReadFrontmatter` and `canReadEntry` both call `canReadPage`) and why the fallback is deliberately NOT in `DELETE`. The ten existing new tests — index-only path, readable orphan, unreadable orphan, deleted page, throwing read, 50-read cap, positive memo, limit short-circuit, 401 and 400 preflights — all of which were correct; the amendment ADDS to them, it does not replace them.

## Review Triage Log

### 2026-09-01 — Review pass 2
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 2, low 5)
- defer: 1: (high 0, medium 1, low 0)
- reject: 11: (high 0, medium 2, low 9)
- addressed_findings:
  - `[medium]` `[patch]` The probe's doc comment claimed the fallback "only adds rows the index WOULD have shown". False once `owner: principal.handle` is passed: the probe is slug-scoped and caller-relative, so a caller holding their own crash-left silo file at slug `s` can surface another user's ledger row for `s`. Comment rewritten in the DW-270 "knowingly leaves behind" register, stating the property actually proven, the cross-silo residue and why it is a deliberate trade, the admin flip side, and an `@see canReadSlug` explaining why that helper is not reused.
  - `[medium]` `[patch]` The headline case (a crash-left tenant-silo orphan) rides entirely on `readWikiPage`'s owner-hint branch (`src/lib/wiki.ts:487-491`), which had no POSITIVE test anywhere in the repo — the three existing owner-hint tests all assert the negative direction, and this route's suite mocks `@/lib/wiki` wholesale. Added the positive twin in `src/lib/__tests__/lifecycle.test.ts`: a silo-only page absent from index and flat path is returned with the hint and `null` without it. Mutation-confirmed — deleting the branch reddens exactly that one test.
  - `[low]` `[patch]` Probe failures logged once per probe (up to 50 warn lines per request under a systemic storage fault) and budget exhaustion logged not at all (index drift indistinguishable from no orphans). Helper now returns a `ProbeResult`; the walk logs the first fault only, plus one warn when the budget is spent with rows left unprobed.
  - `[low]` `[patch]` `readableOnDisk`'s principal narrowed to `NonNullable<Reader>` — GET 401s before the walk, so a `null` caller silently losing the silo branch is now a compile error.
  - `[low]` `[patch]` `MAX_ORPHAN_PROBES` alias documented at both sites; the suite's hardcoded `50`/`60`/`49` replaced by named constants. Export was attempted and is a hard `tsc` error against Next.js generated route types, so the suite restates it under the same name — the same arrangement `SELECTION_NOT_FOUND` already uses, and self-policing via the read-count assertions.
  - `[low]` `[patch]` `DELETE`'s docstring was stale ("GET no longer returns its ledger entries because the readability filter excludes it"); exclusion now needs absence from the index AND from disk. GET's deferred-work pointer reworded to name this spec's `deferred` frontmatter rather than implying the ledger.
  - `[low]` `[patch]` Missing pins added: one-warn-per-request under two throwing probes, the budget-exhaustion warn and its no-warn discriminator, and the "ONE index listing" invariant (`listWikiPages` called exactly once, `listReadableWikiPages` never called by GET).

### 2026-09-01 — Review pass
- intent_gap: 0
- bad_spec: 4: (high 1, medium 3, low 0)
- patch: 4: (high 0, medium 0, low 4)
- defer: 1: (high 0, medium 1, low 0)
- reject: 8: (high 0, medium 2, low 6)
- addressed_findings:
  - `[high]` `[bad_spec]` Probe gate was `readable.has(slug)` (index ∩ readable), so it fired for every indexed page the caller cannot read — read regression on the multi-user path, budget starvation, and a bypass of `listWikiPages`' dirty-slug fail-closed hardening. Spec Design Notes/Code Map amended to derive `indexed` and `readable` separately from one `listWikiPages()` call and probe only `!indexed.has(slug)`; code reverted for re-derivation.
  - `[medium]` `[bad_spec]` Plain cached non-strict probe read can be served from the module-global `pageCache`. Spec amended to require `{ fresh: true, strict: true }`, failing closed on both `null` and a throw.
  - `[medium]` `[bad_spec]` Probe omitted `{ owner: principal.handle }`, so crash-left tenant-silo orphans — the main orphan class — were never found. Spec amended to require it.
  - `[medium]` `[bad_spec]` Two mutants survived the suite (`continue`→`break` at budget exhaustion; memoizing only positive verdicts). Spec Tasks now name seven mutation-killing tests explicitly.
  - `[low]` `[patch]` Comment claimed `limit` bounds both answer and work; it bounds only the answer. Folded into the amended doc-comment instruction.
  - `[low]` `[patch]` `budget === 0` narrowed to `budget <= 0`.
  - `[low]` `[patch]` `Parameters<typeof canReadFrontmatter>[1]` replaced by the exported `Reader` type; probe `catch` now logs via `logger.warn` instead of swallowing silently.
  - `[low]` `[patch]` `MAX_ORPHAN_PROBES` alias added so the listing budget reads as its own concept while `MAX_BULK_DELETE` stays the value the human decision names.

## Design Notes

The fallback is a per-page restatement of the SAME authorization the index path applies — `canReadEntry(entry)` and `canReadFrontmatter(fm)` both call `canReadPage` — read through the SAME authoritative options the index path uses for a slug it cannot trust. That pairing is what makes it safe: the only rows it adds are rows the index WOULD have shown had it not drifted, and none that the index hid on purpose.

```ts
const all = await listWikiPages();
const indexed = new Set(all.map((p) => p.slug));
const readable = new Set(
  all.filter((e) => canReadEntry(e, principal)).map((e) => e.slug),
);

const wanted = limit ?? 50;
const probed = new Map<string, boolean>();
let budget = MAX_ORPHAN_PROBES;
const entries: LedgerEntry[] = [];
for (const entry of await readLedger()) {
  if (entries.length >= wanted) break;
  const slug = entry.primary_slug;
  if (!slug) continue;
  if (readable.has(slug)) { entries.push(entry); continue; }
  if (indexed.has(slug)) continue;   // index already answered: hidden, no read
  let ok = probed.get(slug);
  if (ok === undefined) {
    if (budget <= 0) continue;       // budget spent: hide, keep walking
    budget -= 1;
    ok = await readableOnDisk(slug, principal);
    probed.set(slug, ok);            // BOTH verdicts, so a repeated slug costs one probe
  }
  if (ok) entries.push(entry);
}
```

`continue`, not `break`, at the budget wall: a readable indexed row further down the ledger must still list. And `limit` bounds the ANSWER, not the WORK — a page whose rows are all unlistable still spends the full budget, which the doc comment must say rather than claim `limit` bounds both.

**The half this bundle deliberately does not ship.** The decision's prose says orphan rows should "list and become deletable". Listing is delivered here. Deletability is NOT: `DELETE`'s `ingestIds` preflight and its DW-270 read gate both test the index-backed `readable` set, so a listed orphan still answers `SELECTION_NOT_FOUND`. Closing that needs the same fallback in `DELETE`, which this decision's own "on this listing path only" excludes and which DW-393's shipped spec forbids outright ("Do not add a disk fallback for orphan slugs"). It is recorded in this spec's frontmatter `deferred` list rather than resolved by overturning a shipped decision unattended.

## Verification

**Commands:**
- `pnpm test -- src/lib/__tests__/ingest-history-delete-route.test.ts` -- expected: all cases pass, including every pre-existing DELETE and GET case unchanged.
- `pnpm lint` -- expected: no new errors or warnings in `src/app/api/ingest/history/route.ts`.
- `npx tsc --noEmit` -- expected: no new type errors.

## Auto Run Result

Status: done

### Implemented change

`GET /api/ingest/history` scoped its ledger rows with a single set from `listReadableWikiPages` — index membership AND readability collapsed together — so an ORPHAN page (on disk but absent from the page index, the drift `checkOrphanPages` exists for) had its ledger row dropped silently and its owner could never see or select it. GET now derives TWO sets from one `listWikiPages()` call: `indexed` (every slug the index knows) and `readable` (the `canReadEntry` subset). One ledger walk in ledger order admits `readable` slugs free, skips `indexed`-but-unreadable slugs free, and for a slug the index does not know at all spends one authoritative `readWikiPageWithFrontmatter(slug, { fresh: true, strict: true, owner: principal.handle })` probe gated by `canReadFrontmatter` — memoizing both verdicts per slug, capped at `MAX_ORPHAN_PROBES` (= `MAX_BULK_DELETE`, the constant the human decision names), `continue`-not-`break` at exhaustion, and stopping at `limit ?? 50`. `DELETE` is unchanged.

### Files changed

- `src/app/api/ingest/history/route.ts` — the whole functional change: `MAX_ORPHAN_PROBES`, the `readableOnDisk` probe seam returning a `ProbeResult`, the GET ledger walk, and the doc comments recording why the read scope is unchanged, what the caller-relative owner hint knowingly leaves behind, and why the fallback is deliberately not in `DELETE`.
- `src/lib/authz.ts` — `type Reader` → `export type Reader`. Type-only; no predicate touched.
- `src/lib/__tests__/ingest-history-delete-route.test.ts` — `listWikiPages` added to the partial `@/lib/wiki` mock, plus 20 GET cases covering every I/O-matrix row and the mutation-killers (indexed-but-unreadable costs no read; the walk keeps going past the budget wall; negative memoization; authoritative read options; one fault log per request; the budget-exhaustion warn and its discriminator; the one-index-listing invariant). Every pre-existing DELETE and read-only GET case is unchanged and green.
- `src/lib/__tests__/lifecycle.test.ts` — the positive owner-hint twin: a page existing only at `tenants/<tenantForOwner("alice")>/wiki/<slug>.md`, absent from `index.md` and the flat path, is returned with `{ fresh, strict, owner }` and `null` without the hint. This pins `readWikiPage`'s owner-hint branch, which this feature's headline case depends on and which nothing pinned positively before.

### Review findings breakdown

Two review passes, four layers each (blind hunter, edge-case hunter, verification-gap, intent-alignment).

- **Pass 1** — intent_gap 0, bad_spec 4 (1 high, 3 medium), patch 4 low, defer 1 medium, reject 8. The high finding: the probe gate was `readable.has(slug)`, so it fired for every indexed page the caller cannot read — a per-request read regression on the multi-user path, a starved budget, and a bypass of `listWikiPages`' dirty-slug fail-closed hardening (`src/lib/wiki.ts:830-846`) that could list a row the index deliberately hid. Code was reverted, the spec's Code Map / Tasks / Design Notes amended (the Design Notes sketch was the root cause — it spelled the gate as `readable.has(slug)` and asserted the plain cached read was correct), and the implementation re-derived.
- **Pass 2** — intent_gap 0, bad_spec 0, patch 7 (2 medium, 5 low), defer 1 medium, reject 11. All seven patches applied; see the triage log.
- **Patches applied: 11** (across both passes). **Deferred: 1.** **Rejected: 19.**

### Follow-up review recommendation

`true`. Patched this pass: high 0, medium 2, low 5 → score `3×2 + 1×5 = 11`, which is ≥ 5.

### Verification performed

- `pnpm test -- src/lib/__tests__/ingest-history-delete-route.test.ts src/lib/__tests__/lifecycle.test.ts` → 119 passed.
- `npx vitest run` (full suite) → 359 files, 8674 passed, 1 skipped, 0 failed.
- `npx tsc --noEmit` → clean. `pnpm lint` → clean (only the pre-existing `jsx-ast-utils` `TSNonNullExpression` notices, on unrelated JSX files).
- Matrix test audit: all 11 I/O-matrix rows are covered by a test that ran and passed.
- Mutation-tested guards, each injected, run and reverted: `continue`→`break` at the budget wall; positive-only memoization; dropping the `indexed` short-circuit; the plain cached read in place of `{ fresh, strict, owner }`; logging every probe failure; silencing the budget warn; re-introducing a second index listing; and deleting `readWikiPage`'s owner-hint branch. Every one is killed by its intended test.

### Residual risks

- **The bundle's ledger entry does not match its decision.** `deferred-work.md`'s DW-432 body is about `.github/workflows/deploy-cloudflare.yml`'s `paths:` filter omitting `pnpm-workspace.yaml`; the `decision:` line stamped under it, and `.bmad-loop/decisions.json`'s DW-432 record, are both about this ingest-history fallback. This run implemented the human decision (the only half that is actionable — `.github/` is protected by AGENTS.md:11 and the human was never asked about it). The workflow `paths:` defect is still live and unaddressed; DW-432's `status: open` is not earned by this change. The ledger is orchestrator-owned and was not edited.
- **Deletability is not shipped** — the one deferred item above. A newly listed orphan row is selectable and always answers `SELECTION_NOT_FOUND`.
- **The orphan probe is caller-relative.** `owner: principal.handle` opens the caller's own tenant silo, so (a) a caller holding a crash-left silo file at slug `s` can surface another user's ledger row for `s` (its `source_url` and ids, never its bytes) where `s` is absent from both the index and the flat path, and (b) an admin does not see another owner's silo-only orphan. Both are documented at the probe; closing (a) would require persisting an owner on every ledger entry, the migration this route's own doc comment already scopes out.
- **Latency under real index drift.** A drifted deployment pays up to 50 sequential cache-bypassing reads per GET on a list `RecentIngests` re-polls while a job is in flight. Bounded per request by the cap the human decision named, but it is a genuine latency change on `/ingest` that did not exist before.
- `MAX_ORPHAN_PROBES` cannot be exported (Next.js route modules may export only handlers and framework config names), so the suite restates the value under the same name — the arrangement `SELECTION_NOT_FOUND` already uses, kept honest by the read-count assertions.
