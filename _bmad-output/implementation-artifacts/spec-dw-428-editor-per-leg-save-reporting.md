---
title: 'The edit form reports a two-leg save per leg: a landed body prefixes the metadata refusal'
type: 'bugfix'
created: '2026-09-01'
baseline_revision: '793e0a9c287d90c426accd41a2203bb49f67f797'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      A `PATCH` whose `fetch` REJECTS after the body `PUT` landed still shows a bare transport
      message, so the exact harm DW-428 exists to prevent is live on that one branch.
    evidence: |-
      `handleSave`'s prefix sits inside the metadata leg's `!res.ok` branch, so a dropped or
      aborted `PATCH` falls straight to the outer `catch` and the owner reads only
      "Failed to fetch" over a body that is already on disk — and retypes or reloads over it,
      which is the whole harm the change exists to remove. The omission is deliberate and
      argued (`partialSaveMessage`'s docblock, and the case
      `makes no claim about a metadata leg whose fetch never came back`): the decision's frozen
      sentence asserts "the metadata change was not", which nobody can claim about a request
      that never came back, and it interpolates a `<served error>` that branch does not have.
      Saying only the provable half — that the text was saved, and that the metadata outcome is
      unknown — needs a SECOND owner-facing sentence, which is an intent-level copy decision
      the 2026-08-22 decision did not open.
    location: >-
      src/components/WikiEditor.tsx (handleSave outer catch) and src/components/__tests__/page-write-read-only.test.tsx
    severity: medium
---

<intent-contract>

## Intent

**Problem:** `WikiEditor.handleSave` fires two writes — `PUT /api/wiki/[slug]` for the body, then `PATCH` for the metadata — but reports only one outcome: the served sentence of whichever leg failed (`src/components/WikiEditor.tsx:297-304`). When the `PUT` has already landed and the `PATCH` is refused, the owner reads a bare refusal whose own wording asserts nothing was changed (`READ_ONLY_REFUSAL.pageMetadata`, a 400 on a bad field, a 404, a 403 `NOT_OWNER`), so a page whose body IS now stored looks like a save that did nothing — and the natural response is to retype or reload and lose the body that landed.

**Approach:** Apply the recorded 2026-08-22 decision "Per-leg client reporting". Track, within one save attempt, that the body leg landed, and when the metadata leg is then refused, prefix the served sentence with the client-owned sentence `Your text was saved; the metadata change was not — <served error>`. One composing helper owns the wording. No server copy changes, no shared write-failure surface changes.

## Boundaries & Constraints

**Always:** "The body leg landed" is exactly what the component already acts on — `bodyDirty` was true and the `PUT` answered `res.ok` — the same predicate that already lets execution reach the `PATCH` and already re-stamps `version` (`WikiEditor.tsx:261-288`). No second, narrower notion of landed is introduced. The prefix is composed by ONE exported helper in `WikiEditor.tsx` and applied at exactly one place: the `!res.ok` branch of the metadata leg. The served sentence is relayed unchanged after the prefix, including the existing `metadata save failed (<status>)` fallback when the refusal body will not parse — the status line still proves the metadata was not applied. Everything else about the failed-save path is unchanged: form stays open, the whole draft stays on screen, `version` keeps the value the landed `PUT` answered, no navigation.

**Block If:** the metadata leg no longer has a single `!res.ok` branch that composes the owner-facing sentence; or `PUT` failure no longer short-circuits before the `PATCH` fires (which would make "the body leg landed" ambiguous at the prefix site).

**Never:** Do not touch server copy — `READ_ONLY_REFUSAL`, `WRITE_CONFLICT_COPY`, `WRITE_PRECONDITION_REQUIRED_COPY`, `unconfirmedWriteMessage` or anything in `src/lib/read-only.ts`, `src/lib/write-precondition.ts`, `src/lib/workbench-request.ts`. Do not spell either frozen precondition sentence in `WikiEditor.tsx` (`write-precondition.test.ts`'s participant scan reads this file). Do not prefix a `PUT` failure, a metadata leg that never fired because the body was clean, or a `PATCH` whose `fetch` REJECTED — a dropped connection leaves the metadata outcome unknown, and "the metadata change was not" would be a claim nobody can make; that branch keeps today's message. Do not add a success/partial-success banner, a retry-just-the-metadata affordance, or any `unconfirmed`-style verdict field. Do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Body landed, metadata refused with a served sentence | body + metadata both dirty; `PUT` → `ok: true`; `PATCH` → 403 `{ error: READ_ONLY_REFUSAL.pageMetadata }` | Alert reads `Your text was saved; the metadata change was not — Page metadata cannot be changed while this deployment is read-only.` | Form open, whole draft on screen, no navigation |
| Body landed, metadata refusal body unparseable | `PUT` → `ok: true`; `PATCH` → 500, `json` rejects | Prefix + the existing `metadata save failed (500)` fallback | Same |
| Metadata-only save refused | body clean, metadata dirty; only a `PATCH` fires, refused 400 | Served sentence ALONE — no prefix; nothing was saved | Same |
| Body leg refused | body dirty; `PUT` → 412 | Served sentence alone, unchanged; no `PATCH` fires | Same |
| Metadata leg's `fetch` rejects | `PUT` → `ok: true`; `PATCH` `fetch` rejects with `TypeError` | Unchanged: the thrown message alone, no prefix | Same |
| Both legs land | `PUT` and `PATCH` both `ok` | Unchanged: navigate to the page, no alert | No error expected |
| Retry after a prefixed partial failure | owner presses Save again; `PUT` lands, `PATCH` refused again | Prefixed again, and the retry's `If-Match` is the version the FIRST landed `PUT` answered | Same |

</intent-contract>

## Code Map

- `src/components/WikiEditor.tsx` -- the only fix site. `EDIT_PAGE_READ_ONLY_COPY` :30-31 is the house precedent for a client-owned exported sentence with a docblock stating why the wording lives here. `handleSave` :245-313: `bodyDirty` guard :260, the `PUT` :261-270, `if (!res.ok)` body-leg throw :271-276, the landed-version adopt :277-288 (the comment there already argues "a `PUT` that lands followed by a `PATCH` that does not" — the new prefix is the owner-facing half of that same fact, so point at it rather than restate it), `if (metadataDirty)` :291, the `PATCH` :292-296, and the `!res.ok` metadata throw :297-304 — THE prefix site. Outer `catch` :309-312 (`setError(getErrorMessage(err, "unknown error"))`) is where every message, prefixed or not, reaches the screen; leave it alone. The `version` docblock :221-231 states the two-leg fact this change reports on.
- `src/lib/workbench-request.ts` -- READ-ONLY reference for VOICE only. `unconfirmedWriteMessage` :195-215 is the house shape to mirror: one exported composing function, a docblock saying what the sentence may and may not claim, no transport vocabulary. Do not import from it and do not add to it — `WriteFailure`/`unconfirmed` is a different surface's verdict.
- `src/lib/read-only.ts` -- READ-ONLY. `READ_ONLY_REFUSAL.pageMetadata` :226-227 is the served sentence the first matrix row wraps. Named so the implementer does not "fix" the server sentence instead.
- `src/app/api/wiki/[slug]/route.ts` -- READ-ONLY. `PATCH` :380-448: the refusals that can arrive after a landed `PUT` — 403 read-only :388-394, 400 shapes :396-419, and the catch ladder :432-447 (`LIFECYCLE_FIELD` 400, `NOT_OWNER` 403, `NOT_FOUND` 404, else 500). Evidence that the prefix branch is reachable by more than one status.
- `src/components/__tests__/page-write-read-only.test.tsx` -- where the pins land and where two EXISTING tests must be updated. `describe("Edit page — the write precondition")` :266; `mountEditor` :277-287, `save()` :289-291, `rewriteBody` :293-295, `touchMetadata` :298-300, `headersOf` :302-304. Two existing cases assert the metadata refusal's text with a bare `getByText` and therefore FAIL once it is prefixed: :325 "retries on the version the LANDED save answered…" (`getByText("confidence must be a number")` :352-354) and :367 "keeps the seeded version when a landed save answers no version at all" (`getByText("nope")` :391). `refuseThePut` :413-428 is the shape to copy for a metadata-leg refusal helper. `describe("Edit page, on a read-only deployment")` :151 already covers "neither the PUT nor the PATCH" :204-224.
- `src/lib/__tests__/write-precondition.test.ts` -- READ-ONLY constraint. The participant scan :562-601 lists `components/WikiEditor.tsx` and fails if the first 40 characters of `WRITE_CONFLICT_COPY` or `WRITE_PRECONDITION_REQUIRED_COPY` appear in it. The new sentence shares no such prefix; keep it that way.

## Tasks & Acceptance

**Execution:**
- `src/components/WikiEditor.tsx` -- add ONE exported helper that composes the sentence (e.g. `partialSaveMessage(served: string)`), with a docblock in `unconfirmedWriteMessage`'s voice: what it states (the body leg was answered, the metadata leg was refused), why it must not be a server sentence (the server saw one leg; only this form knows there were two), and the one thing it must not be used for (a metadata leg whose outcome is unknown). Track within `handleSave` that the body leg landed — a plain local that starts `false` and is set only after the `PUT`'s `res.ok` check passes, so it cannot survive into a later attempt — and wrap the metadata leg's `!res.ok` message in the helper when it is set. Say in a comment at the prefix site that the `PATCH` refusals that reach it (403 read-only, 400, 404) each read as "nothing was changed", which is true of the metadata and false of the page.
- `src/components/__tests__/page-write-read-only.test.tsx` -- update the two existing assertions listed in the Code Map to expect the prefixed sentence (leaving each test's own subject — the retry version, the kept seed — untouched), and add a describe for the reporting itself covering: the prefixed served sentence on a read-only 403 with the whole draft still on screen and no navigation; the prefixed `metadata save failed (500)` fallback when the refusal body will not parse; the metadata-only save (body clean) showing the served sentence with NO prefix and firing exactly one request; a refused `PUT` showing its sentence with no prefix and firing exactly one request; and a `PATCH` whose `fetch` rejects showing no prefix. Assert the prefix text through the exported helper, never by typing the sentence twice.

**Acceptance Criteria:**
- Given a body-and-metadata save whose `PUT` lands and whose `PATCH` is refused, when the alert appears, then it names both legs — the body as saved and the metadata as not — followed by the server's own sentence verbatim, and the owner's full draft is still on screen with nothing navigated away.
- Given a save where only the metadata leg ran, or only the body leg ran and was refused, when the alert appears, then it is exactly the sentence that surface showed before this change.
- Given the sentence is needed anywhere twice, when it is read from the code, then there is exactly one expression of it — the exported helper — and no frozen precondition sentence appears in `WikiEditor.tsx`.

## Spec Change Log

## Review Triage Log

### 2026-09-01 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 1, low 4)
- defer: 1: (high 0, medium 1, low 0)
- reject: 8: (high 0, medium 2, low 6)
- addressed_findings:
  - `[medium]` `[patch]` Every assertion on the composed sentence built its expectation by
    calling `partialSaveMessage`, so the helper was only ever compared against itself. The
    reviewer demonstrated the mutation: replacing the helper body with a sentence that DROPS the
    `served` relay left all 25 tests green, `tsc` clean and only an unused-variable lint warning
    — losing the one half of the message that tells the owner what to fix, with the suite that
    exists to pin it reporting pass. The composed sentence is now typed out once as
    `PREFIXED_READ_ONLY` (client prefix + the imported `READ_ONLY_REFUSAL.pageMetadata`, so no
    second copy of server copy enters the file) and the mounted 403 case anchors to it three
    ways that do not route through the helper. Re-run of the same mutation now fails exactly
    that case.
  - `[low]` `[patch]` The both-legs-land case promised "No alert of any kind" but asserted only
    `queryByText(/the metadata change was not/)` — which re-typed a fragment of the wording the
    block's own header forbids duplicating, and would have passed on a bare served sentence.
    `Alert variant="error"` renders a plain `div` with no ARIA role, so `queryByRole("alert")`
    would have been vacuously null; an `errorAlert(container)` element helper is used in BOTH
    directions instead, so a selector that stops matching fails the cases expecting a sentence
    rather than quietly excusing the one expecting none.
  - `[low]` `[patch]` `const served = body.error ?? ...` sat behind an unchecked cast and `??`
    catches only null/undefined, so `{"error": ""}` composed a sentence ending on a dangling em
    dash and a non-string `error` spliced `[object Object]` into it. `served` is now the status
    fallback unless `body.error` is a non-empty string, with a case pinning the empty-string
    body.
  - `[low]` `[patch]` `landThePutRefuseThePatch` refuses every non-`PUT` request without reading
    the URL, so a metadata leg sent to the wrong route or with the wrong verb would still have
    been reported as a metadata refusal. The main partial-save case now pins call 1 as a `PATCH`
    to `/api/wiki/alpha`.
  - `[low]` `[patch]` The `res.ok` reading of "landed" — `bodyLanded` set one line BEFORE the
    `PUT`'s own body read, so an unparseable 200 still reports "Your text was saved" — was
    argued in the spec's Design Notes and pinned only incidentally, by the pre-existing
    `keeps the seeded version when a landed save answers no version at all` case. A reviewer
    read the new describe and concluded it was pinned by nothing. That case now names itself as
    the pin and says what fails if the assignment moves.

## Design Notes

The claim is split because the FACTS are split, and each half is provable on its own:

```ts
// body clean, or the PUT refused → nothing landed, the served sentence stands alone
setError(served);
// the PUT was answered ok, the PATCH was REFUSED → two facts, one sentence
setError(partialSaveMessage(served));  // "Your text was saved; the metadata change was not — " + served
// the PATCH's fetch REJECTED → the metadata outcome is unknown; no claim about it
setError(getErrorMessage(err, "unknown error"));
```

The prefix belongs on the client and nowhere else: each route handled one request and can only speak about that one. Only this form knows a save was two writes, so only this form can say which half survived. That is also why nothing is added to `WriteFailure`/`unconfirmed` — those describe ONE write whose outcome nobody knows, and here the outcome of each leg is known separately.

"Landed" stays the component's existing `res.ok`, deliberately. A 2xx from an intermediary is not proof the route ran, but this component already treats `res.ok` as landed everywhere it matters — it is what lets the `PATCH` fire at all and what makes the form adopt the answered version — and a second, stricter notion of landed used only by the sentence would let the same save be "landed" for the version it holds and "not landed" for what it tells the owner.

## Verification

**Commands:**
- `npx vitest run src/components/__tests__/page-write-read-only.test.tsx src/lib/__tests__/write-precondition.test.ts src/app/u/\[handle\]/\[slug\]/edit/__tests__/edit-denial-copy.test.tsx` -- expected: all pass
- `npx tsc --noEmit` -- expected: clean
- `npx eslint src/components/WikiEditor.tsx src/components/__tests__/page-write-read-only.test.tsx` -- expected: clean


## Auto Run Result

Status: done
Blocking condition: none

### What was implemented

`WikiEditor`'s Save is two writes — `PUT /api/wiki/[slug]` for the body, then `PATCH` for the
metadata — and it reported only the served sentence of whichever leg failed. Every `PATCH`
refusal is worded as "nothing was changed", so a save whose body was already stored read as a
save that did nothing, and the owner's natural response — retype, or reload — threw away the
body that landed. Per the recorded 2026-08-22 "Per-leg client reporting" decision, a landed body
leg now prefixes the metadata refusal: `Your text was saved; the metadata change was not —
<served error>`. Server copy is untouched; the frozen 412/428 sentences are neither typed nor
paraphrased in the changed files.

### Files changed

- `src/components/WikiEditor.tsx` — added the exported `partialSaveMessage(served)` helper (the
  one owner of the wording) with a docblock stating what it asserts and the one branch it must
  not cover; added a per-attempt `bodyLanded` local set on the `PUT`'s `res.ok`; hardened the
  metadata leg's `served` to a non-empty string and applied the prefix at that single site.
- `src/components/__tests__/page-write-read-only.test.tsx` — updated the two existing assertions
  the new wording breaks, and added `describe("Edit page — a save that half landed")` with seven
  cases covering every I/O matrix row plus the literal-sentence anchor.

### Review findings breakdown

Four review layers (blind hunter, edge-case hunter, verification-gap, intent-alignment).
Patches applied: 5 (1 medium, 4 low) — see the Review Triage Log for each. Deferred: 1 (medium).
Rejected: 8.

Follow-up review recommended: **true**. Patched-only counts: high 0, medium 1, low 4 →
`3 × 1 + 1 × 4 = 7`, which is ≥ 5.

### Verification performed

- `npx vitest run src/components/__tests__/page-write-read-only.test.tsx src/lib/__tests__/write-precondition.test.ts src/app/u/[handle]/[slug]/edit/__tests__/edit-denial-copy.test.tsx`
  — **89 passed, 3 files** (the editor suite went 19 → 26 tests). The `write-precondition.test.ts`
  participant scan is in that run, so neither frozen sentence entered `WikiEditor.tsx`.
- `npx tsc --noEmit` — clean.
- `npx eslint src/components/WikiEditor.tsx src/components/__tests__/page-write-read-only.test.tsx`
  — clean.
- Matrix audit: all seven I/O rows are covered by a case that ran and passed in that output.
- Mutation check, run independently after the patches: replacing `partialSaveMessage`'s body
  with a sentence that drops the `served` relay — green across all 25 tests before the patch —
  now fails `names both legs, relays the server's sentence, and keeps the draft`, and only that
  case. The source file was restored and the suite re-run green.

### Residual risks

- **A 5xx metadata refusal does not prove the metadata was not applied, and the sentence says it
  was not.** `patchMetadata` → `writeWikiPageWithSideEffects` writes the page file
  (`src/lib/lifecycle.ts:583-587`) before the index step at `:719`, which is **not** swallowed
  the way the embedding, alias and commons steps are — so a throw there reaches the route's
  catch-all `status = 500` (`src/app/api/wiki/[slug]/route.ts:439-447`) with the metadata
  already on disk. Verified in the source this run. Not filed: the decision hands down ONE
  sentence for "the PATCH failure" undifferentiated, so discriminating the prefix by status is
  not a reading its own wording supports, and the owner's corrective action — press Save again,
  which re-sends the full 7-key payload — is idempotent and self-correcting, so the cost is one
  unnecessary retry rather than lost work or wrong stored state.
- **"Your text was saved" rests on `res.ok` alone**, so a `PUT` answering 200 with an unreadable
  body still produces the claim. Deliberate and argued in the Design Notes; the case
  `keeps the seeded version when a landed save answers no version at all` is the pin, and now
  says so.
- The error `Alert` carries no `role`/`aria-live`, so this sentence — like every other error on
  this form — is not announced. Pre-existing on `src/components/Alert.tsx` and unchanged here.
- The body stays `bodyDirty` after a landed `PUT`, so the `(modified)` marker sits beside the
  "your text was saved" alert until the metadata leg succeeds. Re-baselining the body would
  change the retry semantics the existing `If-Match` cases pin; out of this decision's scope.
