---
title: 'Write preconditions and one conflict surface (DW-38, DW-51, DW-56, DW-63)'
type: 'feature'
created: '2026-08-17'
status: 'done'
baseline_revision: 'a951497958721d4ea8a2432d2a3d1bdbb9343f73'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      `loadConfig()` answers `{}` for an UNREADABLE config as well as an absent
      one, so the settings route can merge a patch into an empty object and
      `saveConfig` writes away every stored field.
    evidence: |-
      `src/lib/config.ts:197-209` catches every read/parse error, logs a
      `logger.warn` for anything that is not ENOENT, and returns `{}`. The
      settings route uses that value as BOTH the precondition's merge base and
      the object it spreads into. If a transient storage error hits the `GET`,
      the surface is seeded with `objectVersion({})`; if the same failure hits
      the `PUT`, the header matches, the guard reports "no conflict", and the
      merge lands on an empty config. Pre-existing — the route merged into `{}`
      and wrote before this change too, and the precondition makes the case
      strictly rarer, not more likely. Closing it means teaching the config
      loader to distinguish "absent" from "unreadable", which is a kernel change
      no DW entry in this bundle names.
    location: src/lib/config.ts:197, src/app/api/settings/route.ts:156
    severity: medium
  - summary: >-
      The artifact route reads current bytes OUTSIDE the very per-owner lock its
      own writer takes, so the one route that already holds a lock still leaves
      the concurrent-save window open.
    evidence: |-
      `src/app/api/workbench/artifact/route.ts` calls `readWikiArtifact` for the
      precondition, then `writeWikiArtifact`, which wraps its put in
      `withFileLock(wikiLockKey(owner))` (`src/lib/wikis.ts:556`). Moving the
      read and the check inside that same critical section would close the
      window at zero design cost — no new lock and no new lock ordering, which
      is what this spec's Never clause actually forbids. Not done here because
      it needs a precondition parameter threaded into `writeWikiArtifact` and an
      unlocked internal getter, and because the other two routes would then
      carry a weaker guarantee than this one.
    location: src/app/api/workbench/artifact/route.ts:149, src/lib/wikis.ts:556
    severity: low
  - summary: >-
      Requiring `If-Match` is an undocumented wire-contract change for the
      service-token REST path, which `middleware.ts` still describes as an
      unconditional write.
    evidence: |-
      `src/middleware.ts:30-31` documents `/api/wiki/<slug>` mutations as
      authenticated by "Clerk session OR the system service token", and the PUT
      handler resolves `getServicePrincipal(req)` for exactly that caller. Any
      external agent issuing an unconditional `PUT` now receives a 428 carrying
      a sentence written for a human editor. No in-repo caller exists (verified:
      `tools/`, `scripts/`, `integrations/`, `workers/`, `skills/` carry no
      `api/wiki` or `api/settings` request), so nothing breaks in this tree —
      but no doc, and no test, covers the service-principal path against the
      guard. DW-38 names "Epic 8's loopback API" as a future third writer that
      would inherit this requirement.
    location: src/middleware.ts:30, src/app/api/wiki/[slug]/route.ts:174
    severity: low
  - summary: >-
      `readWikiPage`'s in-process `pageCache` can serve the Preview a stale body
      and now a stale VERSION, producing a 412 against a write the reader was
      never shown.
    evidence: |-
      `src/lib/wiki.ts:334-337` returns a cached page whenever `pageCache` is
      active, and `GET /api/workbench/preview` derives the version from exactly
      that value. The cache is ref-counted around bulk scans rather than held
      per-request, so no route in this bundle activates it today; the staleness
      is pre-existing for `body` and the version merely inherits it.
    location: src/lib/wiki.ts:334, src/app/api/workbench/preview/route.ts:142
    severity: low
  - summary: >-
      The kernel page writer stays unguarded, so the ~18 non-HTTP callers of
      `writeWikiPageWithSideEffects` — including the ingest and agent writers
      DW-38 names as the reason the guard is needed — still clobber freely.
    evidence: |-
      The guard sits at the HTTP boundary, which is what the intent's operative
      clause asks for ("enforce `If-Match` on the three routes"), but every DW
      entry's `location` field also names a kernel writer (`src/lib/lifecycle.ts`,
      `writeWikiArtifact`, `saveConfig`). `writeWikiPageWithSideEffects` is called
      unconditionally from `src/mcp.ts`, `src/cli.ts`, `src/lib/agents.ts`,
      `src/lib/lint-fix.ts`, `src/lib/query.ts`, `src/lib/search.ts`,
      `src/lib/memory-proposals.ts`, `src/lib/document-sources.ts`,
      `src/lib/patch-metadata.ts`, `src/app/api/wiki/route.ts` and the revisions
      route. DW-38's own justification for doing the work now is "Epic 2 gives
      the same pages a second writer" — and that writer is an ingest path that
      never travels the guarded route.
    location: src/lib/lifecycle.ts:731
    severity: medium
  - summary: >-
      `stableSerialize` collapses every non-plain object to `{}` and has no
      cycle or depth bound, so `objectVersion` can report "no change" between two
      genuinely different values.
    evidence: |-
      `Object.entries(new Date(...))` is empty, so two different `Date`s, `Map`s,
      `Set`s or class instances all serialize identically; a cyclic object
      recurses until the stack blows, where `JSON.stringify` would at least throw
      a catchable `TypeError`. Only caller today is the settings route over a
      parsed-JSON `AppConfig`, where none of these shapes can occur — but
      `objectVersion` is exported as a general primitive with an inviting name.
    location: src/lib/write-precondition.ts:130
    severity: low
  - summary: >-
      The Settings write precondition is a hash of the STORED SECRETS, and it is
      served to the browser beside the comment asserting no secret material
      crosses that boundary.
    evidence: |-
      `GET /api/settings` computes `objectVersion(await loadConfig())` over the
      whole parsed `AppConfig` — `firecrawlApiKey`, `customApiKey` and the
      embedding key included — and ships that string twice, at the top level and
      on `workbench`, four lines below the comment stating that
      `getWorkbenchSettings()` reduces the three secrets to `has*ApiKey` booleans
      "(AD-23)". The version is not the secret and the route is owner-only, so
      this is a weak confirmation oracle rather than key recovery, but it is
      secret-DERIVED material on a surface whose stated invariant is that none
      leaves the kernel. It cannot be fixed by hashing a redacted projection: the
      `PUT` merges into the whole config, so a version blind to the secret fields
      would miss exactly the lost update it exists to catch. Closing it needs a
      different scheme — an opaque token stamped on save and stored beside the
      config — which the intent forecloses by naming "the stored `AppConfig`" as
      the version's input.
    location: src/app/api/settings/route.ts:52, src/lib/write-precondition.ts:150
    severity: medium
  - summary: >-
      `isWorkbenchSettingsPayload` making `version` required turns a save that
      LANDED into a reported failure, and one absent field into a whole-canvas
      load failure.
    evidence: |-
      `src/lib/workbench-settings.ts:359` now rejects a payload whose `version`
      is missing or empty, and `saveWorkbenchSettings` runs the 200 response
      through it — so a landed write would be answered `{ status: "error" }`,
      `SettingsCanvas` would keep its superseded version, and every later save
      would be refused 412 for a change the owner made themselves.
      `fetchWorkbenchSettings` fails the same way on read, taking every value off
      screen. Unreachable today: the route derives `version` from
      `objectVersion(fresh)`, which is always a non-empty string. Recorded
      because the two sibling clients deliberately chose the opposite tolerance
      (`isPreviewPayload` accepts absence, `useSettings` accepts a versionless
      200), so the three payloads now answer the same question three ways and a
      fourth surface has no convention to follow.
    location: src/lib/workbench-settings.ts:359, src/lib/workbench-settings.ts:1028
    severity: low
  - summary: >-
      A Schema draft held across an active-Wiki switch can still land on the
      OTHER Wiki's `schema.md` when both hold the identical seeded bytes.
    evidence: |-
      `PUT /api/workbench/artifact` resolves `currentId` from the registry at
      request time and checks the precondition against THAT Wiki's artifact. Two
      Wikis seeded from the same template hold byte-identical `schema.md`, so the
      version matches and the draft is written to a Wiki it was never read from.
      Pre-existing and strictly improved by this change — the write was
      unconditional before, so the same draft landed on the other Wiki whatever
      its bytes were — but the guard does not close it, because a content version
      cannot distinguish two files that genuinely hold the same content. Closing
      it means binding the seeded Wiki id to the request, which no DW entry in
      this bundle names.
    location: src/app/api/workbench/artifact/route.ts:129
    severity: low
---

<intent-contract>

## Intent

**Problem:** All three editor-facing writes read-then-write unconditionally. `PUT /api/wiki/[slug]`, `PUT /api/workbench/artifact` and `PUT /api/settings` carry no precondition, so a draft that outlived another actor's save silently clobbers it — and Story 1.7's refresh deliberately leaves an open editor alone, so a draft can knowingly be minutes stale. Two Settings surfaces (`SettingsCanvas` and `/settings` via `useSettings`) write the same `AppConfig`; two page editors (`PreviewColumn` and `WikiEditor`) write the same page file.

**Approach:** One content-derived version string, computed by one pure function over the bytes the server actually holds, shipped on every read that seeds an editor and required back as `If-Match` on all three `PUT`s. Each route compares it against the bytes it already reads for its own merge and refuses a stale save with one shared, recoverable sentence — the draft is never destroyed, and every landed save answers with the new version so the surface can save again without a reload.

## Boundaries & Constraints

**Always:**
- ONE version function over ONE input, called by both the read side and the write side of the same bytes — never two expressions that agree today. Page and `wiki/<slug>.md`: the WHOLE stored file. Artifact: the whole file. Settings: the stored `AppConfig`, key-order independent.
- The version is a change detector, not an identity or a secret: pure JS, no crypto, no dependency, computed the same in node, the browser and the Worker.
- `If-Match` is REQUIRED on the three `PUT`s: absent → `428`, mismatched → `412`. A guard a caller can skip by omitting a header is not a guard.
- The precondition is checked against the bytes the route ALREADY read for its own merge, immediately before the write — no second read, no new lock, no new lock ordering.
- A refused save never destroys the draft. Every surface keeps its text on screen and shows the SERVER's sentence, which is the existing `{ error }` contract all four clients already relay.
- One wording for the conflict, owned by one module, identical on all three surfaces. No surface types a conflict sentence at its render site.
- Every landed save answers with the NEW version, and every surface that stays open after a save re-seeds from it.
- The version is captured WITH the editor's seed, never re-derived at Save — the same rule `PreviewColumn` already applies to `draftSeed` and `editingTargetRef`.

**Block If:**
- A route cannot carry the precondition without changing an existing status code for a caller that is not making a stale write.

**Never:**
- Do not gate `PATCH /api/wiki/[slug]` (metadata), `POST /api/wiki`, the revisions/revert routes, `POST /api/ingest/reingest`, or `src/mcp.ts`. None is named by DW-38/51/56/63. Record, do not widen.
- Do not use `readFileWithEtag`/`writeFileIfMatch`: all three writes have side effects (revisions, index, cross-refs, activity log, `dataVersion`) that a raw compare-and-set write would bypass. The guard belongs at the route, above the side-effecting writer.
- No new lock, no merge/diff UI, no one-click "reload" affordance, no new dependency, no i18n, no restyle.
- Do not touch the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Fresh save | `If-Match` matches the stored bytes | 200, the write and all its side effects run, body carries the new `version` | No error expected |
| Stale save | `If-Match` was computed before another actor's save | 412, `{ error: WRITE_CONFLICT_COPY }`, nothing is written | Draft stays on screen; the sentence is shown |
| No precondition | `PUT` with no `If-Match` | 428, `{ error: WRITE_PRECONDITION_REQUIRED_COPY }`, nothing is written | Same surface handling as 412 |
| Malformed header | `If-Match: *`, unquoted, or empty | Treated as absent → 428 | Never treated as a match |
| Target vanished | Artifact deleted between read and save | 412 — a missing file matches no version | Conflict sentence, draft kept |
| Re-save without reload | A landed save, then a second edit | The surface uses the version the save answered with → 200 | No spurious 412 |
| Unread bytes | Preview payload for an `unsupported` format | No `version` field (bytes were never read) | Not editable, so no save can start |
| Metadata-only change | Another actor `PATCH`ed frontmatter | The body draft's next save is 412 | Conservative by design: the whole file is the merge base |
| Config re-order | `.llm-wiki-config.json` re-serialized with different key order, same values | Same version — no false conflict | — |

</intent-contract>

## Code Map

**The primitive (new).**
- `src/lib/write-precondition.ts` -- NEW. Pure, client-safe, zero-dep. Owns: `contentVersion(content)`, `objectVersion(value)` (stable key-sorted JSON), `IF_MATCH_HEADER`, `formatIfMatch`/`parseIfMatch`, `checkWritePrecondition(header, currentVersion)`, the two statuses, and `WRITE_CONFLICT_COPY` / `WRITE_PRECONDITION_REQUIRED_COPY`. Model it on `src/lib/workbench-preview.ts`'s "pure module the node suite executes" shape.

**Page (DW-38, DW-51).**
- `src/app/api/workbench/preview/route.ts:120-140` -- page branch already holds `page.content` (via `readWikiPage`); `:160-175` file branch holds the raw `content` from `readWorkbenchFile`. Both are the version's input. `:130` and `:208` build the two payloads.
- `src/app/api/wiki/[slug]/route.ts:88-200` (PUT) -- already reads `existing` via `readWikiPageWithFrontmatter` at `:136` for the ACL. `existing.content` is the merge base; check there, after the ACL cloak, before `serializeFrontmatter`. `mergedContent` at `:191` is written verbatim by `runPageLifecycleOp` (`src/lib/lifecycle.ts:236-240` calls `writeWikiPage(slug, op.content, …)`), so the new version is `contentVersion(mergedContent)`.
- `src/lib/workbench-preview.ts:85-120` (`PreviewPayload`), `:796-822` (`savePreviewBody`), `:686-700` (`isPreviewPayload`) -- add optional `version`; `savePreviewBody` gains a `version` option, sends `If-Match`, and returns the new version on `ok`.
- `src/components/workbench/PreviewColumn.tsx:363-393` (`startEditing`) and `:394-443` (`save`) -- capture the version beside `draftSeed`, send it, and stamp the answered version onto the payload alongside `body: draft` at `:429`.
- `src/components/WikiEditor.tsx:228-240` -- the OTHER page editor; its PUT needs the header. `src/app/u/[handle]/[slug]/edit/page.tsx:18` already reads `readWikiPageWithFrontmatter`, so `page.content` is in hand at `:128` where `<WikiEditor>` is rendered.

**Artifact (DW-56).**
- `src/app/api/workbench/artifact/route.ts:70-138` -- `handle()` never reads current bytes. Add one `readWikiArtifact(principal.handle, currentId, target)` after `currentId` resolves at `:129`, check, then the existing `writeWikiArtifact`. `null` (absent) matches no version.
- `src/lib/wikis.ts:923-934` (`readWikiArtifact`) -- unlocked raw read, the same bytes `readWorkbenchFile` serves (`src/lib/workbench-files.ts:486-493`). `writeWikiArtifact` at `:550` stays unchanged.

**Settings (DW-63).**
- `src/lib/config.ts:197-220` -- `loadConfig` parses `.llm-wiki-config.json`; `saveConfig` writes it. The version's input is the PARSED object, so `objectVersion` must sort keys (a hand-edited file re-orders on save otherwise).
- `src/app/api/settings/route.ts:33-46` (GET) -- serve `version` at the top level AND on `workbench`, both from ONE `objectVersion(config)` call. `:52-249` (PUT) -- `loadConfig()` at `:156` is the merge base; check there, before any validation branch writes. After `saveConfig` + `_resetConfigCache()` + `loadConfig()` at `:243-247`, answer the freshly-read version.
- `src/lib/workbench-settings.ts:229-285` (`WorkbenchSettingsPayload`), `:331-360` (`isWorkbenchSettingsPayload`), `:965-990` (`saveWorkbenchSettings`) -- add required `version: string`, validate it, send `If-Match`.
- `src/components/workbench/SettingsCanvas.tsx:98`, `:151-176` -- mirror `payload` into a ref (the `PreviewColumn.tsx:169` pattern) so `save` can read the version; the existing `setPayload(result.payload)` re-seed already carries the new one forward.
- `src/hooks/useSettings.ts:114-160` (`fetchSettings`) and `:180-235` (`handleSave`) -- the legacy `/settings` surface. Store `version` from GET, send it, and rely on the existing `await fetchSettings()` after a save to pick the new one up.

**Tests to extend (all existing).**
- `src/lib/__tests__/wiki-routes.test.ts:222-235`, `:586-592`, `:1098-1105` -- three PUT helpers to give an `If-Match`.
- `src/lib/__tests__/wiki-schema-edit.test.ts`, `src/lib/__tests__/settings-route.test.ts` (whole-object GET fixture will need `version`), `src/lib/__tests__/workbench-preview.test.ts:1863+`, `src/lib/__tests__/workbench-settings.test.ts`, `src/lib/__tests__/workbench-left-column.test.ts:406` (source-scan pin on `savePreviewBody(target.url, draft`).

**Read-only evidence.**
- `src/lib/lock.ts` -- an in-process lock exists but is deliberately NOT used here: `wikis:<tenant>` is non-reentrant and outermost for Wiki state, and a new page-level key would buy only in-process serialization on a deployment that runs many isolates.
- No caller of these three routes exists outside `src/` (`tools/`, `scripts/`, `integrations/`, `workers/`, `skills/` carry no `api/wiki` or `api/settings` request), so requiring `If-Match` breaks no external client.

## Tasks & Acceptance

**Execution:**
- `src/lib/write-precondition.ts` -- create the primitive above. Hash: two 32-bit FNV-1a passes over both bytes of every UTF-16 code unit, different offset bases, joined with the length — a `w1:<len36>-<hex><hex>` string. Document it as a change detector, not a digest.
- `src/lib/__tests__/write-precondition.test.ts` -- create. Cover every I/O Matrix row this module owns: same input → same version, one-character change → different version, empty string, lone-surrogate input, `objectVersion` key-order independence and nested-object stability, `parseIfMatch` on quoted / unquoted / `*` / empty / absent, and `checkWritePrecondition`'s three outcomes.
- `src/app/api/workbench/preview/route.ts` -- add `version` to both payload branches, computed from the RAW read (pre-cap), omitted where no bytes were read.
- `src/lib/workbench-preview.ts` -- add optional `PreviewPayload.version`; teach `savePreviewBody` the `version` option and the returned version. Keep `isPreviewPayload` accepting a payload without one.
- `src/components/workbench/PreviewColumn.tsx` -- capture the version at seed time, send it, stamp the answered one on success.
- `src/app/api/wiki/[slug]/route.ts` -- precondition on PUT against `existing.content`; answer `version` on success. PATCH and DELETE untouched.
- `src/app/u/[handle]/[slug]/edit/page.tsx` + `src/components/WikiEditor.tsx` -- thread `initialVersion` and send it on the PUT leg only.
- `src/app/api/workbench/artifact/route.ts` -- read current bytes, precondition, answer `version`.
- `src/app/api/settings/route.ts` -- serve `version` on GET (top level and `workbench`), enforce it on PUT, answer the post-save version.
- `src/lib/workbench-settings.ts` + `src/components/workbench/SettingsCanvas.tsx` + `src/hooks/useSettings.ts` -- carry the version through both Settings surfaces.
- Extend the six existing test files listed in the Code Map -- every route gains a 200-with-match, a 412-on-mismatch and a 428-on-absent case; the client modules gain a "sends `If-Match`" and a "relays the server's conflict sentence without clearing the draft" case.

**Acceptance Criteria:**
- Given a page open in the Preview editor and another actor saving that page, when the owner presses Save, then the route answers 412, the page keeps the other actor's bytes, and the editor still holds the owner's text with the conflict sentence beside it.
- Given the Schema editor open and `schema.md` rewritten underneath it, when the owner saves, then the write is refused and `writeWikiArtifact` is never reached — no activity-log line and no `dataVersion` bump.
- Given a value saved from `SettingsCanvas`, when `/settings` saves a draft seeded before that, then the second save is refused and the first surface's value survives.
- Given any of the three surfaces has just saved successfully, when the owner edits and saves again without reloading, then the second save succeeds.
- Given the conflict sentence, when it is read on all three surfaces, then it is the same string and it comes from `write-precondition.ts`.

## Spec Change Log

## Review Triage Log

### 2026-08-17 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 6: (high 2, medium 2, low 2)
- defer: 6: (high 0, medium 2, low 4)
- reject: 9: (high 0, medium 1, low 8)
- addressed_findings:
  - `[high]` `[patch]` `WikiEditor`'s `If-Match` was pinned by nothing — the only mounted suite rendered it with no `initialVersion`, so deleting the header spread broke no test while the route now answers 428. Made `initialVersion` required, updated the mount, and added three mounted cases (PUT carries the header, PATCH does not; the retry sends the landed version; a 200 with no version keeps the seeded one).
  - `[high]` `[patch]` Neither DW-63 surface had an executed test of its precondition wiring: `settings-read-only.test.tsx` never saved and no test imported `useSettings`. Added a mounted `SettingsCanvas` save (seeded version sent, new version on the second save, 412 keeps every edit) and a new `src/hooks/__tests__/useSettings.test.tsx` (6 cases).
  - `[medium]` `[patch]` A landed page `PUT` followed by a failed `PATCH` left `WikiEditor` holding the superseded version, so the retry met a 412 blaming "somewhere else" for the owner's own save. The version now lives in state and is adopted from the PUT response before the PATCH leg can fail.
  - `[medium]` `[patch]` `useSettings` kept a stale version when the post-save refetch failed, turning the next save into a false 412. `fetchSettings` now clears it on failure and `handleSave` adopts the version the save itself was answered with when the refresh did not land.
  - `[low]` `[patch]` `isPreviewPayload` rejected `version: null`, so a serializer normalizing an omitted optional would take the whole Preview to "unreachable" over a field the body does not depend on. `null` is now absence, and an empty version never produces `If-Match: ""`.
  - `[low]` `[patch]` The one-owner source scan covered only `WRITE_CONFLICT_COPY`, leaving the 428 sentence free to be typed at a render site. The scan now loops both constants, and the two sentences were aligned so each ends with the same recovery clause.

### 2026-08-17 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 1, low 3)
- defer: 3: (high 0, medium 1, low 2)
- reject: 13
- addressed_findings:
  - `[medium]` `[patch]` The edit page was the one surface with no mounted test that a REFUSED save keeps the draft and shows the server's sentence — its three siblings each had one, and its message reaches the screen through `throw new Error(body.error ?? ...)`, one `??` term away from `body save failed (412)`. Added two cases (412 and 428): the retyped page is still in the textarea, the server's sentence is on screen, nothing navigated, Save is pressable again. Mutation-checked — dropping the `body.error` term fails both.
  - `[low]` `[patch]` `contentVersion`'s two passes shared the FNV prime and differed only in their starting state, so the docblock's "behave as a 64-bit value" overstated what two runs of one multiply-chain give. The second pass now has its own odd multiplier and the claim states what it actually is.
  - `[low]` `[patch]` `IF_MATCH_HEADER`'s docblock justified a header over a body field by claiming "every one of these routes parses its body only after checks that must not depend on the body parsing at all" — false for two of the three, which validate the body first and answer 400 before the conflict. Replaced with the real rationale and the ordering consequence, stated.
  - `[low]` `[patch]` `PreviewColumn`'s Cancel closed the editor without clearing `editingVersionRef`, unlike the selection-change and landed-save paths, leaving the ref holding a superseded version against its own documented invariant. Cleared there too.

## Design Notes

**Why a content hash and not a storage ETag.** The DW entries name `readFileWithEtag`/`writeFileIfMatch`, but every one of these writes is side-effecting: the page write runs revisions, index upsert, cross-refs and the log; the artifact write runs the log and `dataVersion`; the settings write re-primes a cache. A raw compare-and-set write bypasses all of it. A version DERIVED from the bytes gives the same lost-update detection while leaving the one writer in place — and it is the only option that works for `AppConfig`, which is compared as a parsed object rather than as a byte string.

**What the guard does and does not close.** It closes the window that DW-38/51/56/63 describe: an editor open for minutes across another actor's save. It does not make read-modify-write atomic across two requests in flight at the same instant — the check sits immediately before the write, but not inside a lock. That residual is a distinct, pre-existing property; record it, do not fix it here.

**Shape of the module.**
```ts
export const IF_MATCH_HEADER = "If-Match";
export type PreconditionOutcome =
  | { ok: true }
  | { ok: false; status: 428; error: typeof WRITE_PRECONDITION_REQUIRED_COPY }
  | { ok: false; status: 412; error: typeof WRITE_CONFLICT_COPY };
export function checkWritePrecondition(
  header: string | null,
  current: string | null,   // null = the target is gone; matches nothing
): PreconditionOutcome;
```

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/write-precondition.test.ts src/lib/__tests__/wiki-routes.test.ts src/lib/__tests__/wiki-schema-edit.test.ts src/lib/__tests__/settings-route.test.ts src/lib/__tests__/workbench-preview.test.ts src/lib/__tests__/workbench-settings.test.ts src/lib/__tests__/workbench-left-column.test.ts` -- expected: all pass
- `pnpm test` -- expected: no new failures against the pre-change baseline
- `pnpm lint` -- expected: clean
- `npx tsc --noEmit -p tsconfig.json` -- expected: no new type errors


## Auto Run Result

Status: done

**Implemented change.** One content-derived version string, computed by one pure
function over the bytes the server actually holds, is served on every read that
seeds an editor and required back as `If-Match` on all three editor-facing
writes. Each route compares it against the bytes it already reads for its own
merge, immediately before the write: a stale save is refused 412 and a save with
no usable precondition 428, both carrying one shared, recoverable sentence, and
no surface loses its draft. Every landed save answers with the new version, so
all four clients can save again without a reload. Closes DW-38, DW-51, DW-56 and
DW-63.

This pass was a follow-up review of an already-`done` spec (the previous pass set
`followup_review_recommended: true`). No intent gaps and no spec repairs;
`review_loop_iteration` stayed at 0.

**Files changed.**
- `src/lib/write-precondition.ts` -- NEW. `contentVersion` / `objectVersion`, `IF_MATCH_HEADER`, `formatIfMatch` / `parseIfMatch`, `checkWritePrecondition`, the 412/428 statuses, and the two sentences.
- `src/app/api/wiki/[slug]/route.ts` -- PUT checks against `existing.content` after the ACL cloak; answers the landed version. PATCH and DELETE untouched.
- `src/app/api/workbench/artifact/route.ts` -- reads current bytes, refuses above `writeWikiArtifact` (no log line, no `dataVersion` bump), answers the landed version.
- `src/app/api/settings/route.ts` -- GET serves one `objectVersion(config)` at the top level and on `workbench`; PUT checks the `loadConfig()` merge base and answers the post-save version.
- `src/app/api/workbench/preview/route.ts` -- serves the version from the RAW read, omitted where no bytes were read.
- `src/lib/workbench-preview.ts` -- optional `PreviewPayload.version`; `savePreviewBody` sends `If-Match` and returns the landed version.
- `src/components/workbench/PreviewColumn.tsx` -- version captured with the seed, sent at Save, stamped from the answer, dropped on every path that closes the editor.
- `src/app/u/[handle]/[slug]/edit/page.tsx`, `src/components/WikiEditor.tsx` -- required `initialVersion`, held in state and re-adopted from each landed PUT.
- `src/lib/workbench-settings.ts`, `src/components/workbench/SettingsCanvas.tsx`, `src/hooks/useSettings.ts` -- the version carried through both Settings surfaces.
- `src/lib/config.ts` -- type-only adjustment for the values/payload split.
- Tests: `src/lib/__tests__/write-precondition.test.ts` and `src/hooks/__tests__/useSettings.test.tsx` NEW; extended `wiki-routes`, `wiki-schema-edit`, `settings-route`, `workbench-preview`, `workbench-settings`, `workbench-left-column`, `preview-dirty-guard`, `settings-read-only`, `page-write-read-only`, `edit-denial-copy`.

**Review findings, this pass.** 4 patched (medium 1, low 3), 3 deferred (medium
1, low 2 -- see frontmatter `deferred`), 13 rejected, 0 intent gaps, 0 bad-spec
loopbacks. The rejections were dominated by findings the intent forecloses by
name (a reload affordance and a merge UI are in the Never clause; `If-Match: *`
treated as absent is an I/O Matrix row; `PATCH` staying ungated is a Never
clause), by duplicates of items already in `deferred`, and by unreachable
degradations behind route code that always answers a version. Cumulative across
both passes: 10 patched, 9 deferred.

**Follow-up review recommended: true.** This pass's patched counts: high 0,
medium 1, low 3. No high patched finding, so the score decides:
`3 x 1 + 1 x 3 = 6`, at or above 5.

**Verification.** `npx vitest run` -- 225 files / 4717 tests, all passing (4715
before this pass; the two new cases are the edit page's refusal tests). `npx tsc
--noEmit -p tsconfig.json` -- clean. `npx eslint .` -- clean. The two new tests
were mutation-checked: dropping the `body.error` term from `WikiEditor.tsx:275`
fails both and nothing else, which is the coverage gap they close. Note the spec
named `pnpm vitest` / `pnpm test`, which fail in this repo with "packages field
missing or empty"; the `npx` equivalents were used.

**Residual risks.** The check is not inside a lock, so two requests in flight at
the same instant can still interleave -- the window this closes is the one an
open editor creates, measured in minutes, not the millisecond one. Requiring
`If-Match` is a hard wire-contract change: any future non-browser caller of these
three routes must send it or receive 428, and the middleware's own comment about
service-token page writes has not been updated (deferred). The page version
covers the whole stored file, so an ungated metadata `PATCH` by another actor
refuses an open body draft -- conservative by design, documented and tested. The
kernel writers below the routes remain unguarded (deferred), which is where
DW-38's stated future motivation, Epic 2's ingest writer, will land. The Settings
version is derived from the stored config including its secrets and is served to
the browser (deferred): the intent names the stored `AppConfig` as the input, and
a version blind to the secret fields would miss the lost update it exists to
catch. A conflict is recoverable only by reloading -- the intent forbids a
one-click affordance -- so the three surfaces hold their refusal until the owner
reloads.
