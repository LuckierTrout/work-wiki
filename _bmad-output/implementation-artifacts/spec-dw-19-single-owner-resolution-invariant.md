---
title: 'DW-19 — pin and annotate the single-owner Schema resolution invariant'
type: 'chore'
created: '2026-08-17'
status: 'done'
baseline_revision: '75236a728d098f7450f8c910e5d422e44640f155'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `readActiveWikiSchema()`'s catch branch — warn and fall back to the root
      Schema on an unreadable or unparseable registry — has no test.
    evidence: |-
      src/lib/wikis.ts logs `logger.warn("wikis", ...)` and returns null when
      `getCurrentWiki`/`readWikiArtifact` throws. The sibling fallbacks (no
      owner, no Wiki, missing schema.md, empty conventions section) are all
      covered in `wiki-schema-source.test.ts`; this one is not. A corrupt
      `tenants/<t>/wikis.json` would serve the root SCHEMA.md forever, which is
      exactly the silent-misconfiguration case the warn line exists for.
      Pre-existing — the branch predates this change.
    location: >-
      src/lib/wikis.ts
    severity: low
  - summary: >-
      Owner-handle case normalization is load-bearing for the single-owner
      invariant but untested at the Schema path.
    evidence: |-
      `getOwnerHandle()` returns the raw trimmed env value while `isOwnerHandle()`
      compares case-insensitively; the two only stay consistent because
      `ownerToTenant()` (src/lib/links.ts) lowercases before the value becomes a
      storage key. Nothing pins that `NEXT_PUBLIC_OWNER_HANDLE="Alice"` resolves
      alice's Wiki. Pre-existing, and adjacent to the invariant this change pins.
    location: >-
      src/lib/links.ts:80
    severity: low
  - summary: >-
      The backup scheduler re-implements `getOwnerHandle()` inline, so the owner
      env var has two readers and a `getOwnerHandle` grep misses one.
    evidence: |-
      src/app/api/tasks/scan/route.ts:139 reads
      `process.env.NEXT_PUBLIC_OWNER_HANDLE?.trim()` directly into `backupOwner`
      and passes it to `isOwnerBackupDue()` and `enqueueTask({ owner })` — both
      tenant-keyed. Routing it through `getOwnerHandle()` would leave exactly one
      reader of the env var. Pre-existing.
    location: >-
      src/app/api/tasks/scan/route.ts:139
    severity: low
  - summary: >-
      Neither `lint-checks.ts` detector has any test that it resolves the ACTIVE
      Wiki's Schema — a mutation pinning both to the repo-root file passes the
      entire suite.
    evidence: |-
      `checkContradictions()` and `checkMissingConceptPages()` call the
      no-argument `loadPageConventions()`. The only lint-side conventions test,
      `src/lib/__tests__/lint.test.ts:670`, writes a bare `SCHEMA.md` into its
      tmpdir and never sets `NEXT_PUBLIC_OWNER_HANDLE` or calls `createWiki`, so
      it exercises only the repo-root fallback branch. Replacing both detector
      calls with `loadPageConventions(`${process.cwd()}/SCHEMA.md`)` — lint
      permanently ignoring the active Wiki's seeded Schema — leaves lint.test.ts
      (73), wiki-schema-source.test.ts and cli.test.ts (83) all green, 170 tests
      passing. Pre-existing: this is Wiki-vs-root precedence (Story 1.2 / AD-10),
      not DW-19 tenancy, and the gap predates this change. DW-19's own pins are
      at the loader plus the two call sites that carry a principal; the lint
      detectors carry none, so there is no non-owner caller to pin them with.
    location: >-
      src/lib/lint-checks.ts:414 and src/lib/lint-checks.ts:570
    severity: medium
  - summary: >-
      `POST /api/wikis` is gated on sign-in but not ownership, so a non-owner can
      create a Wiki that every downstream surface then treats as inert.
    evidence: |-
      `src/app/api/wikis/route.ts` checks `getPrincipal()` and `isReadOnly()`,
      then calls `createWiki(principal.handle, …)` — no `isOwnerHandle` gate. The
      resulting Wiki's Schema is never resolved (`readActiveWikiSchema()` reads
      `NEXT_PUBLIC_OWNER_HANDLE`) and its Schema edits are 403'd at
      `src/app/api/workbench/artifact/route.ts:82`, whose own comment reasons
      about exactly this inertness for the save path. So the "second tenant"
      state DW-19 treats as hypothetical is reachable in production today; the
      creation path is the one door left open. Pre-existing, and a product
      decision (gate creation, or accept inert non-owner Wikis) rather than a
      defect of this change.
    location: >-
      src/app/api/wikis/route.ts:37
    severity: low
---

<intent-contract>

## Intent

**Problem:** `loadPageConventions()` called with no argument resolves the active Wiki's `schema.md` deployment-globally, via `readActiveWikiSchema()` → `getOwnerHandle()` → `NEXT_PUBLIC_OWNER_HANDLE`. That is correct for the single-owner deployment shipping today, but it sits directly beside per-caller guidance (`buildWorkspaceGuidance(owner)`, whose `owner` can be `"system"`, an agent handle, or a monitor's owner) at every one of its four call sites, and none of those sites says so. Only the `readActiveWikiSchema()` docstring names the constraint; nothing pins it, so a second tenant could be introduced and the deployment-global resolution silently kept — handing a non-owner caller the site owner's Scenario Template conventions.

**Approach:** Documentation and a regression pin only. Annotate each no-argument `loadPageConventions()` call site with the invariant and with what must change when a second tenant arrives (thread a tenant into the loader), strengthen the `readActiveWikiSchema()` docstring to state the invariant explicitly rather than as an aside, and add tests in the existing Schema-source suite that fail if the resolution is made tenant-aware or another tenant's Wiki starts winning.

## Boundaries & Constraints

**Always:** Behavior stays byte-identical — this is comments plus new tests. Existing tests keep passing unchanged. New tests live in the existing `src/lib/__tests__/wiki-schema-source.test.ts` suite and follow its `DATA_DIR` + `NEXT_PUBLIC_OWNER_HANDLE` env-swap fixture. Comment wording names the concrete fix (pass a tenant/owner argument through `loadPageConventions()` → `readActiveWikiSchema()`) rather than a vague "revisit for multi-tenancy".

**Block If:** The intent would require changing resolution behavior — it does not; the recorded decision is "Keep, document the constraint".

**Never:** Do not thread an owner argument into `loadPageConventions()` or `readActiveWikiSchema()`. Do not change `getOwnerHandle()`, `isOwnerHandle()`, or `src/lib/owner.ts`. Do not touch the `loadPageTemplates()` path. Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Owner has an active Wiki, another tenant also has one | `NEXT_PUBLIC_OWNER_HANDLE=alice`; `alice` has a `reading` Wiki, `bob` has a `business` Wiki | `loadPageConventions()` returns alice's conventions; bob's never appear | No error expected |
| Only a non-owner tenant has a Wiki | `NEXT_PUBLIC_OWNER_HANDLE=alice`; only `bob` has a Wiki | Falls back to repo-root `SCHEMA.md` conventions — never bob's | No error expected |
| Resolution made tenant-aware | A required owner/tenant parameter is added to `readActiveWikiSchema()` | Arity pin fails, forcing the change to be explicit | Test failure, not silent |

</intent-contract>

## Code Map

- `src/lib/wikis.ts:741-748` -- `readActiveWikiSchema()` docstring; already mentions single-owner resolution as an aside. Line 749-751 is the `getOwnerHandle()` call — the ONLY place in the repo where that value becomes a storage key. Restate as an explicit invariant + migration note.
- `src/lib/schema.ts:39-53` -- `loadPageConventions(schemaPath?)`. The no-argument branch calls `readActiveWikiSchema()`. Its docstring (lines 10-37) explains Wiki-vs-root precedence but not tenancy.
- `src/lib/query.ts:219` -- no-argument call site, inside the query system-prompt builder. `buildWorkspaceGuidance(owner)` is 5 lines below (`:225`) with a per-caller `owner` — the exact adjacency DW-19 names.
- `src/lib/ingest.ts:1218` -- no-argument call site in `buildIngestSystemPrompt(owner?)`. Same adjacency: `buildWorkspaceGuidance(owner)` at `:1239`.
- `src/lib/lint-checks.ts:403` -- no-argument call site for the contradiction detector.
- `src/lib/lint-checks.ts:548` -- no-argument call site for the missing-concept detector.
- `src/lib/owner.ts:16` -- `getOwnerHandle()`; read-only, do not change. Its module docstring already states work-wiki is single-owner and build-time inlined.
- `src/lib/__tests__/wiki-schema-source.test.ts` -- existing suite that owns this behavior (fixture at lines 22-45: `OWNER = "alice"`, tmp `DATA_DIR`, `_resetLocks()`/`_resetStorage()`). Line 116-122 already covers "no owner handle → root fallback". Add the new pins here.
- `src/lib/wikis.ts` `createWiki(owner, {name, scenario})` -- takes an explicit owner, so a second tenant's Wiki is creatable in a test without any production change. `"reading"` seeds "Preserve sequence when it matters"; `"business"` seeds "Prefer explicit owners" (both strings already asserted at test lines 64 and 105).

## Tasks & Acceptance

**Execution:**
- `src/lib/wikis.ts` -- Rewrite the `readActiveWikiSchema()` docstring so the single-owner tenancy resolution is stated as a named INVARIANT, not an aside: it resolves the tenant deployment-globally from `NEXT_PUBLIC_OWNER_HANDLE`, unlike every other tenant-scoped read/write (`workspace-profile.ts`, `research-projects.ts`, `portable-archive.ts`) which takes a passed-in owner; name the migration (thread a tenant argument through `loadPageConventions()` and every call site) and point at the pinning tests by name. -- The invariant's home is the function that embodies it.
- `src/lib/schema.ts` -- Add a short paragraph to the `loadPageConventions()` docstring stating that the no-argument form is deployment-global, not per-caller, and that a tenant parameter is the multi-tenant migration. -- This is the function the four call sites actually see.
- `src/lib/query.ts` -- Annotate the `loadPageConventions()` call at `:219` with the invariant and the fact that the `owner` used 5 lines below is per-caller. -- Removes the unmarked adjacency DW-19 flags.
- `src/lib/ingest.ts` -- Same annotation at the `:1218` call in `buildIngestSystemPrompt(owner?)`, noting `owner` can be `"system"` or an agent handle. -- Same rationale.
- `src/lib/lint-checks.ts` -- Same annotation at both `:403` and `:548`. -- Lint runs owner-gated today; the note records that the conventions come from the site owner regardless.
- `src/lib/__tests__/wiki-schema-source.test.ts` -- Add a `describe` block pinning the single-owner invariant with three tests: (1) a second tenant's Wiki never wins over the owner's, (2) a non-owner tenant's Wiki alone still falls back to the repo-root Schema, (3) an arity pin asserting `readActiveWikiSchema.length === 0` and `loadPageConventions.length === 1`, with a comment stating that adding a required tenant parameter must be a deliberate, test-updating change. -- Makes a silent multi-tenant slide impossible.

**Acceptance Criteria:**
- Given the site owner and a second tenant each have an active Wiki seeded from different Scenario Templates, when `loadPageConventions()` is called with no argument, then it returns the site owner's conventions and contains none of the second tenant's template prose.
- Given only a non-owner tenant has a Wiki, when `loadPageConventions()` is called with no argument, then it returns exactly the repo-root `SCHEMA.md` conventions.
- Given a developer adds a required tenant parameter to `readActiveWikiSchema()` or `loadPageConventions()`, when the suite runs, then the arity pin fails.
- Given the full test suite is run, when it completes, then every pre-existing test still passes and no runtime behavior has changed (diff to non-test source is comments only).

## Design Notes

The arity pin uses `Function.prototype.length`, which stops counting at the first *default-valued* or rest parameter. A TypeScript `schemaPath?: string` compiles to a plain parameter and still counts, so `loadPageConventions.length` is `1` today and `readActiveWikiSchema.length` is `0`. Pinning both to their exact current values trips on any added tenant parameter, required or optional — stricter than the acceptance criterion needs, and the strictness is welcome. The behavioral pins carry the rest: a tenant-aware loader that honored a caller's tenant would break "another tenant's Wiki never wins".

Sketch of the behavioral pin, in the existing fixture's idiom:

```ts
const OTHER_TENANT = "bob";

it("a second tenant's active Wiki never wins over the site owner's", async () => {
  await createWiki(OTHER_TENANT, { name: "Ops", scenario: "business" });
  await createWiki(OWNER, { name: "Shelf", scenario: "reading" });
  const active = await loadPageConventions();
  expect(active).toContain("Preserve sequence when it matters");
  expect(active).not.toContain("Prefer explicit owners");
});
```

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/wiki-schema-source.test.ts` -- expected: all tests pass, including the new single-owner invariant block.
- `pnpm test` -- expected: no new failures relative to the pre-change baseline.
- `pnpm lint` -- expected: clean.
- `git diff -- src/lib/wikis.ts src/lib/schema.ts src/lib/query.ts src/lib/ingest.ts src/lib/lint-checks.ts` -- expected: comment/docstring lines only, no executable statement changed.

Note: `pnpm test`/`pnpm lint` fail in this working copy with `ERR_PNPM_IGNORED_BUILDS`-adjacent workspace errors, so the equivalents were run as `npx vitest run` and `npx eslint`, plus `npx tsc --noEmit`.

## Spec Change Log

_No bad_spec loopback occurred. One factual correction was made to the Design Notes during implementation: `Function.prototype.length` stops counting at the first default-valued or rest parameter, not at the first optional one, so `loadPageConventions.length` is `1` rather than `0`. Review then found that the `.length` pin this note described could not fail on a defaulted tenant parameter at all; the pin was replaced with a declared-parameter-list check (see the Review Triage Log)._

## Review Triage Log

### 2026-08-17 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 1, medium 3, low 4)
- defer: 3: (high 0, medium 0, low 3)
- reject: 7: (high 0, medium 0, low 7)
- addressed_findings:
  - `[high]` `[patch]` The arity pin could not fail on the most likely multi-tenant migration shape: `Function.prototype.length` stops counting at the first default-valued parameter, so `readActiveWikiSchema(tenant = getOwnerHandle())` plus a defaulted tenant on `loadPageConventions()` would have left every assertion green while the call sites started threading per-caller owners. Replaced the `.length` assertions with a `declaredParams()` source-text check that catches required, optional and defaulted parameters alike, and added two consumer-surface tests (`buildIngestSystemPrompt(OTHER_TENANT)`, `buildQuerySystemPrompt(..., OTHER_TENANT)`) asserting a non-owner caller still gets the site owner's conventions section. Mutation-verified: applying the migration shape fails the signature pin and the ingest consumer pin.
  - `[medium]` `[patch]` `wikis.ts` claimed `readActiveWikiSchema()` is "the only place in the repo where that env value becomes a storage key" — false; `src/app/api/tasks/scan/route.ts:139` also reads it and passes it to tenant-keyed storage. Narrowed the claim to the Schema path and named the backup scheduler as the other reader.
  - `[medium]` `[patch]` The MIGRATION paragraph claimed every call site "already has a per-caller `owner` in scope or nearby" — false for both lint detectors, which take only `diskSlugs`. Split the paragraph: `query.ts`/`ingest.ts` have a per-caller principal in scope; the two `lint-checks.ts` detectors need a tenant threaded down through `lint()` from both entry points.
  - `[medium]` `[patch]` The `ingest.ts` annotation contradicted itself — it warned that `owner` may be `"system"` or an agent handle, then prescribed "passing `owner` here" on migration. It now says to pass the caller's tenant, which is not necessarily `owner`.
  - `[low]` `[patch]` "Lint is owner-gated today so the two coincide" held only for the HTTP route; `runLint` in `src/cli.ts` runs with no principal. Both lint comments now locate the gate and name the ungated path.
  - `[low]` `[patch]` `query.ts` said "the `owner` used 5 lines below", a line distance that rots on the next edit. It now names the `if (owner)` guidance block.
  - `[low]` `[patch]` Added `DW-19` tags in `wikis.ts` and `schema.ts` for ledger traceability, extended the test file's header (it still framed the suite as Story 1.2 / AD-10 only), and dropped a creation-order rationale in a test comment that claimed more than the per-tenant registry layout supports.
  - `[low]` `[patch]` The root-fallback assertion could pass vacuously with both sides `""`; added a `toContain("## Page conventions")` non-vacuity guard.

Rejected as noise or out of scope on the intent's authority: the objection that six near-identical annotation paragraphs duplicate one another (the intent explicitly asks for an annotation at *each* call site); extracting the Scenario Template marker strings into named constants (a pre-existing convention across this suite); an `expect(OTHER_TENANT).not.toBe(OWNER)` guard; a source-scan assertion enforcing the "four call sites" count; the observation that `readActiveWikiSchema` was imported only to read `.length` (moot after the high-severity patch); the ledger's stale `location:` field (ledger edits are forbidden in this run); and a guard at `src/lib/owner.ts` that would trip when multi-tenancy *arrives* rather than when the Schema resolution changes (the intent scopes the pin to the resolution).

### 2026-08-17 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 0, medium 3, low 3)
- defer: 2: (high 0, medium 1, low 1)
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - `[medium]` `[patch]` The `declaredParams()` signature pin returned an empty list — i.e. passed — for two reachable refactors of the function it pins. Verified in node: a bound or wrapped `readActiveWikiSchema` stringifies to `[native code]` with no parameter text, and an arrow with one unparenthesized parameter (`async tenant => { … getOwnerHandle() … }`) has no parameter parens, so the first `(...)` matched was a call inside the body. `declaredParams` now anchors on a `function` declaration and rejects `[native code]`, throwing a directive error rather than reporting "no parameters" for a form it cannot parse. Mutation-verified against five signatures: plain declaration and one-parameter forms parse; defaulted and optional tenant parameters trip the pin; arrow and bound forms now throw.
  - `[medium]` `[patch]` The `wikis.ts` MIGRATION paragraph dated the hazard to "the moment more than one owner can hold Wikis in one deployment" — but more than one owner can hold Wikis *today*: `POST /api/wikis` (`src/app/api/wikis/route.ts:37`) gates on `getPrincipal()`, not `isOwnerHandle`. Restated: the data condition is already reachable, what is absent is multi-tenant *serving* (such a Wiki is inert — this function never resolves it, and `src/app/api/workbench/artifact/route.ts` 403s its Schema edits), so the migration trigger is "a non-owner's Wiki must actually serve that non-owner". The creation-path gap itself is deferred, not fixed here.
  - `[medium]` `[patch]` Every new test held `NEXT_PUBLIC_OWNER_HANDLE` at `alice`, so the whole block was equally consistent with a resolution hardcoded to `alice` or picking the first tenant it found — it never proved the env var *is* the resolution. Added a test that repoints the site owner at the second tenant and asserts their conventions now win. Mutation-verified: replacing `getOwnerHandle()` with a literal `"alice"` fails this test.
  - `[low]` `[patch]` The new test block's own docstring still claimed all four call sites "sit beside a per-caller `owner`" — the same false premise corrected in `wikis.ts` and `lint-checks.ts` during the previous pass, left uncorrected in this one copy. It now separates the two sites with a principal in scope (pinned at their consumer surface) from the two lint detectors that have none.
  - `[low]` `[patch]` All three cross-tenant tests created the non-owner's Wiki first and the site owner's second, so the owner's was also the newest in the deployment — a drift to a global, non-owner-keyed "current Wiki" registry would have passed. Reversed the ordering in both the behavioral pin and `seedBothTenants()`, with the rationale recorded inline.
  - `[low]` `[patch]` The `schema.ts` TENANCY block prescribed "adding a tenant parameter here" without saying that the existing `schemaPath` argument is not that parameter — the obvious escape hatch a migrating developer would reach for. It now states that `schemaPath` names a file, bypasses tenant resolution entirely, and stays test-only.

Rejected this pass, in addition to the prior pass's list: loosening or dropping the `/^schemaPath\b/` parameter-name assertion to survive a rename (the name check is what separates "one parameter, the test-only override" from "one parameter, a tenant" — dropping it reopens the hole the pin exists to close); the objection that the pin cannot catch a tenant threaded via `AsyncLocalStorage` or module state (true, and the comment already scopes its claim to *parameters*); consolidating the five near-duplicate annotation blocks behind a single pointer (rejected on the same intent authority as last pass); importing the Scenario Template marker strings as constants (same); an `expect(process.env.NEXT_PUBLIC_OWNER_HANDLE).toBe(OWNER)` premise guard (subsumed by the new env-follows test, which exercises the fixture directly); naming the positional arguments of `buildQuerySystemPrompt(...)` in the consumer pin (TypeScript catches the reorders that matter); expanding the MIGRATION note with the upstream callers that supply the principal (`chat.ts`, the query stream route, `synthesizeBody`) — out of the intent's scope, and the docstring already carries an `oversized` warning; swapping `fs.readFile` for `readWikiArtifact` in `seedBothTenants` to survive a non-filesystem storage provider (the whole suite is built on the `DATA_DIR` + tmpdir fixture); and a permutation test for "owner's Wiki present but `schema.md` unreadable while a second tenant holds one" (the existing missing-schema test plus the "other tenant alone → root" pin already fix that outcome).


## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** DW-19's decision was "Keep, document the constraint", so this is documentation plus a regression pin — no behavior change. `readActiveWikiSchema()`'s docstring now states the single-owner tenancy resolution as a named INVARIANT with a MIGRATION recipe; `loadPageConventions()` carries a TENANCY paragraph; all four no-argument call sites are annotated with the invariant and with what the caller's per-caller principal is (and is not); and a new `single-owner Schema resolution invariant` describe block pins the behavior, the two consumer surfaces that carry a principal, and the signatures of both resolution entry points.

**Files changed.**
- `src/lib/wikis.ts` — `readActiveWikiSchema()` docstring: INVARIANT, MIGRATION (with the per-site readiness split and the corrected trigger condition), and a pointer to the pinning tests.
- `src/lib/schema.ts` — TENANCY paragraph on `loadPageConventions()`, including that `schemaPath` is not the tenant parameter.
- `src/lib/query.ts` — annotation at the no-argument call site, naming the `if (owner)` guidance block as the per-caller half.
- `src/lib/ingest.ts` — same at `buildIngestSystemPrompt`, noting `owner` is a principal (`"system"`, an agent handle) and not necessarily a tenant.
- `src/lib/lint-checks.ts` — same at both detectors, locating the `isOwnerHandle` gate on the HTTP route and naming `runLint` in `src/cli.ts` as the ungated path.
- `src/lib/__tests__/wiki-schema-source.test.ts` — the invariant block: two behavioral pins, an env-follows pin, two consumer-surface pins (ingest, query), and a `declaredParams()`-based signature pin.

**Review findings breakdown.** This pass: 6 patches applied (medium 3, low 3), 2 deferred (medium 1, low 1), 10 rejected. No intent_gap, no bad_spec; `review_loop_iteration` stayed at 0. Cumulative across both passes: 14 patches, 5 deferred, 17 rejected.

**Follow-up review recommendation:** `true`. Patched findings this pass: high 0, medium 3, low 3 → score `3×3 + 1×3 = 12`, which is ≥ 5. No high-severity patch was needed, so the recommendation rests on volume rather than on an intolerable finding.

**Verification performed.**
- `npx vitest run src/lib/__tests__/wiki-schema-source.test.ts` — 15 passed (was 14; one test added this pass).
- `npx vitest run` — 4451 passed across 215 files, no failures.
- `npx tsc --noEmit` — clean. `npx eslint` over all six changed files — clean.
- Comments-only check: `git diff 75236a7 -- src/lib/{wikis,schema,query,ingest,lint-checks}.ts` filtered to non-comment lines returns nothing, so no executable statement changed outside the test file.
- Mutation checks. (1) Signature pin, exercised against five function shapes: plain declaration and the current one-parameter form parse; defaulted and optional tenant parameters trip it; arrow-with-unparenthesized-parameter and bound/wrapped forms now throw instead of reporting an empty list. (2) Replacing `getOwnerHandle()` with a literal `"alice"` in `readActiveWikiSchema()` fails 2 tests including the new env-follows pin; mutation reverted and the revert confirmed by diff.
- `pnpm test` / `pnpm lint` still fail in this working copy for the pre-existing workspace reason recorded under Verification; the `npx` equivalents above were run in their place.

**Residual risks.**
- The two `lint-checks.ts` call sites have no consumer-surface pin, because those detectors take no principal that could steer resolution — there is nothing to pass them. A mutation pointing lint at the repo-root Schema passes the whole suite, but that is Wiki-vs-root precedence (Story 1.2 / AD-10) rather than DW-19 tenancy, and the gap predates this change. Deferred with the mutation evidence.
- The signature pin reads emitted-JavaScript source text, not the TypeScript type surface where "takes no tenant" is actually expressed. It now fails loudly on forms it cannot parse, but a tenant introduced through module state or request context — not a parameter — would still pass every pin. The comment scopes its claim to parameters accordingly.
- Pinning `loadPageConventions`'s parameter *name* means a pure rename of `schemaPath` fails the DW-19 pin with no tenancy content. Kept deliberately: without the name check, swapping that parameter for a tenant would leave arity at 1 and the pin green.
- The invariant text is now transcribed at six sites. A future correction has to land in all of them or the copies disagree — accepted on the intent's explicit instruction to annotate each call site.
