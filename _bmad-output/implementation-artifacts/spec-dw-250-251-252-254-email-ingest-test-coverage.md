---
title: 'Pin the four unobserved email-ingest surfaces named by DW-250, DW-251, DW-252, and DW-254'
type: 'chore'
created: '2026-08-20'
status: 'done'
baseline_revision: 'b53cb983b9e265f1f8bdb1171013023b1df8579a'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized, multiple-goals]
deferred:
  - summary: >-
      The second copy of the site-URL trim -- the one that builds the
      sender-visible acknowledgement links -- is pinned by nothing.
    evidence: |-
      `workers/email-ingest/index.ts` computes
      `(env.YOPEDIA_SITE_URL || "").replace(/\/+$/, "")` twice: at :325 for the
      forwarded request (now pinned by the new transport case) and again at :386
      for the `Page:` / `Track it under Recent ingests:` lines in the reply.
      Reverting only the :386 trim leaves both Worker suites green, so a sender
      would receive `https://host///u/yopedia/slug`. The new `///` fixture
      already drives the worker with a trailing-slash site and discards
      `msg.reply` instead of asserting it.
    location: >-
      workers/email-ingest/index.ts:386
    severity: low
  - summary: >-
      The Worker's two misconfiguration early-returns -- missing service token and
      missing site URL -- produce sender-visible replies that no test observes.
    evidence: |-
      `workers/email-ingest/index.ts:255-263` replies "the ingest service is not
      configured" and returns without forwarding when `YOPEDIA_SERVICE_TOKEN` is
      absent; :326 throws `YOPEDIA_SITE_URL is missing`, caught by the
      surrounding try/catch into the "could not queue this email" reply. Neither
      branch is exercised anywhere, so deleting either -- and forwarding an
      unauthenticated request, or one to a relative URL -- fails nothing. The new
      `forwardedRequest(siteUrl)` helper already parameterises the site, so the
      second is one fixture away.
    location: >-
      workers/email-ingest/index.ts:255-263
    severity: medium
  - summary: >-
      `assetFromArchive` still indexes the unzipped file map with a raw
      `files[target]`, one line above the `ownLookup` call added to close exactly
      that pattern.
    evidence: |-
      `src/lib/document-extract.ts:458` does `const bytes = files[target]`, where
      `target` is resolved from a relationship `Target` attribute inside an
      attacker-supplied archive. `resolveArchiveTarget` can produce a bare
      `constructor` (e.g. from `../constructor`), which would answer an inherited
      function. It is unreachable today only because `mediaTypeFor` rejects an
      extensionless name first and the `!bytes || !mediaType` guard short-circuits
      -- an accident of ordering, not a guard. Routing it through `ownLookup`
      would make it match its neighbour.
    location: >-
      src/lib/document-extract.ts:458
    severity: low
  - summary: >-
      The route's `MAX_EMAIL_CONTENT_CHARS` 400 branch is unexercised -- the same
      defect class as DW-250, two gates above it.
    evidence: |-
      `src/app/api/email/ingest/route.ts:152-157` returns 400 with
      "Email body exceeds 100,000 characters" for an over-long body. Nothing in
      the repo posts a body above the cap, so the branch and its `toLocaleString`
      copy could be deleted or inverted with the suite green. The Worker
      truncates at the same number before forwarding, so -- like DW-250's branch
      -- this is a route contract for direct callers.
    location: >-
      src/app/api/email/ingest/route.ts:152
    severity: low
  - summary: >-
      The route's "no text body or supported document attachment" 400 asserts only
      its status, in the same file as a new block arguing at length that the copy
      must be pinned.
    evidence: |-
      `src/lib/__tests__/email-ingest-route.test.ts`'s
      "rejects attachment-only email when its file type is unsupported" checks
      `status === 400` and that nothing was enqueued, leaving
      "The email has no text body or supported document attachment to ingest"
      (`route.ts:146-151`) unmatched by anything in the repo -- the same gap
      DW-250 named for the neighbouring branch.
    location: >-
      src/app/api/email/ingest/route.ts:146
    severity: low
---

<intent-contract>

## Intent

**Problem:** Four email-ingest behaviours survive deletion or inversion with the suite green (DW-250, DW-251, DW-252, DW-254): the route's `MAX_EMAIL_DOCUMENTS` 400 branch (no test posts more than three parts, and no test in the repo matches "Attach no more than 10 supported documents"); the forwarded request's `Authorization: Bearer ${serviceToken}` header and `${site}/api/email/ingest` target (both Worker suites read only `formData()` off the captured `Request`); the Worker's `|| "application/octet-stream"` Blob-type fallback (erased by the multipart serializer, so no `Request`-boundary assertion can see it); and `mediaTypeFor`'s `ownLookup` prototype-chain fix in `src/lib/document-extract.ts`, reachable only through an archive entry named e.g. `logo.constructor`.

**Approach:** Add assertions only — no production behaviour changes. Extend `email-ingest-route.test.ts` with a cap-boundary pair (at the cap accepted, one above rejected with the literal copy); extend `email-ingest-worker.test.ts` with the transport assertion (method, URL, `Authorization`), threaded from non-default env bindings so a hardcoded literal cannot pass; observe the Blob type in `email-ingest-worker-normalization.test.ts` at the Worker's own `FormData.append` call, the innermost surface at which the fallback is still visible; and add a DOCX fixture to `document-extract.test.ts` whose `word/media` entry is named `logo.constructor`, alongside a real PNG that must still survive.

## Boundaries & Constraints

**Always:**
- Assert at the outermost surface that can still observe the fact. For the Blob type that is the Worker's `FormData.append` call, because the multipart/form-data serializer is spec-required to write `application/octet-stream` for an empty-typed entry — the existing comment at `email-ingest-worker-normalization.test.ts` records exactly this. Every other assertion stays at the captured `Request`, the `POST` return value, or `extractDocumentText`'s return value.
- Every new assertion must fail under the mutation it exists to catch. The four mutations are: deleting/inverting the route's `attachments.length > MAX_EMAIL_DOCUMENTS` branch; replacing the forwarded `Authorization` header or target URL; deleting `|| "application/octet-stream"`; and reverting `ownLookup(IMAGE_MEDIA_TYPES, ext)` to `IMAGE_MEDIA_TYPES[ext] ?? null`.
- Derive counts from `MAX_EMAIL_DOCUMENTS`/`MAX_EMAIL_ATTACHMENTS` rather than restating `10`, so a cap change moves the fixture. The user-facing message string itself IS pinned verbatim — that is the half DW-250 says nothing in the repo matches.
- Reuse the existing helpers: `multipartRequest`'s `files` array, the worker suite's `message()`/`env()`/`forwardedForm`, the normalization suite's `parseMock` and `forwardedAttachments`, and `document-extract.test.ts`'s `office()` zip builder.
- A `FormData.prototype.append` spy must snapshot `spy.mock.calls` BEFORE `mockRestore()` — vitest's `mockRestore` also resets recorded calls, so reading after it yields an empty array and a silently vacuous test.

**Block If:** Closing DW-251 at the `FormData.append` surface would require changing `workers/email-ingest/index.ts` to expose the Blob some other way.

**Never:** Do not change any production behaviour — this run adds tests only. Do not raise, lower, or re-home `MAX_EMAIL_DOCUMENTS`/`MAX_EMAIL_ATTACHMENTS`. Do not weaken or delete the existing assertions in the four suites. Do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Route at the cap | Multipart POST with exactly `MAX_EMAIL_DOCUMENTS` supported files | 200, `supportedAttachmentCount` equal to the cap, job enqueued | No error expected |
| Route above the cap | Multipart POST with `MAX_EMAIL_DOCUMENTS + 1` supported files | 400 with body error `Attach no more than 10 supported documents`; nothing staged, nothing enqueued | 400 at the route |
| Cap counts supported files only | `MAX_EMAIL_DOCUMENTS` supported files plus two unsupported (`.exe`) parts | 200 — the unsupported parts are filtered before the cap comparison, so they cannot trip it | No error expected |
| Forwarded transport | Worker forwards an attachment email with `YOPEDIA_SERVICE_TOKEN`/`YOPEDIA_SITE_URL` set to values distinct from the suite defaults | Captured `Request` is `POST` to `<site>/api/email/ingest` with `Authorization: Bearer <token>` | No error expected |
| Blob type fallback | Mocked parsed attachment with `mimeType: ""` and a supported extension | The `Blob` the Worker appends carries `type === "application/octet-stream"`; a typed sibling part keeps its own type | No error expected |
| Prototype-named archive entry | DOCX whose rels point one `a:blip` at `media/logo.constructor` and another at `media/chart.png` | Exactly one asset — `chart.png`, `image/png`; no asset named `logo.constructor` and no asset whose `mediaType` is not an `image/*` string | No error expected |

</intent-contract>

## Code Map

- `src/app/api/email/ingest/route.ts:158-163` -- the DW-250 branch: `attachments.length > MAX_EMAIL_DOCUMENTS` returns 400 with `` `Attach no more than ${MAX_EMAIL_DOCUMENTS} supported documents` ``. `attachments` (:132-134) is already filtered by `isSupportedDocument`, so unsupported parts never count toward it. The oversized-file gate (:164-169) runs after, and the config/sender gates (:172-187) after that — a fixture of small in-allowlist files reaches none of them. Who can reach this 400: NOT an emailing sender. `MAX_EMAIL_ATTACHMENTS === MAX_EMAIL_DOCUMENTS` (pinned at `src/lib/__tests__/email-ingest-allowlist-parity.test.ts:139`) and the Worker slices to its own cap at `workers/email-ingest/index.ts:300` before forwarding, so a forwarded message can never arrive over the cap; a sender would only ever see this string relayed back through the Worker's `safeError`. The branch is the route's contract for direct service-principal callers, and defence-in-depth should the two caps drift.
- `src/lib/email-ingest.ts` -- exports `MAX_EMAIL_DOCUMENTS`. The route suite mocks `@/lib/email-ingest` with `...(await original())`, so the constant is importable in-test unchanged.
- `src/lib/__tests__/email-ingest-route.test.ts` -- `multipartRequest` (:75-108) already accepts `files: File[]`, `unforwardedNames`, and `messageId`; `beforeEach` (:111-127) wires the principal, config, and `mockedGetJob.mockResolvedValue(null)`. `mockedStageBytes` (:57) records its calls. Each case needs its own `messageId`: `getIngestJob` is mocked to `null`, so duplicates are not a hazard, but distinct ids keep the fixtures readable, matching the existing convention.
- `workers/email-ingest/index.ts:358-366` -- the DW-252 transport: `env.YOPEDIA.fetch(new Request(\`${site}/api/email/ingest\`, { method: "POST", headers: { Authorization: \`Bearer ${serviceToken}\` }, body: form }))`. `site` is `(env.YOPEDIA_SITE_URL || "").replace(/\/+$/, "")` (:325); `serviceToken` is `env.YOPEDIA_SERVICE_TOKEN`, already gated as missing at :255-263.
- `workers/email-ingest/index.ts:352-356` -- the DW-251 fallback: `new Blob([bytes], { type: attachment.mimeType || "application/octet-stream" })` appended as `form.append("attachments", blob, filename)`.
- `src/lib/__tests__/email-ingest-worker.test.ts` -- `message(raw, subject)` (:106-119) and `env(response)` (:120-133) helpers; `env()` returns a plain object literal, so a case can spread it and override `YOPEDIA_SERVICE_TOKEN`/`YOPEDIA_SITE_URL`. `forwardedForm` (:396-409) captures the `Request` but returns only `formData()` and the reply — the transport case needs the `Request` itself, i.e. `bindings.YOPEDIA.fetch.mock.calls[0][0]`, as the `ATTACHMENT_EMAIL` case ("forwards the attachment bytes to the ingest service unchanged", :173-192) already does.
- `src/lib/__tests__/email-ingest-worker-normalization.test.ts` -- `parseMock` + `vi.mock("postal-mime")` (:29-33), and `forwardedAttachments()` (:78-88) which runs the worker and reads the wire. The comment to update is anchored by content, not line number, because this file is itself being edited: inside the test named `"still forwards a part that reports no MIME type, typed octet-stream"`, the comment that begins `The worker writes ...` and states that deleting the `||` does NOT change the bytes on the wire. That comment is the record of DW-251 and must be updated, not deleted, once the append-surface assertion exists.
- `src/lib/document-extract.ts:447-450` -- `mediaTypeFor` = `ownLookup(IMAGE_MEDIA_TYPES, ext)`; `IMAGE_MEDIA_TYPES` at :64-74; `ownLookup` at `src/lib/document-formats.ts:153-155`. Two independent gates consume it: `archiveEntryKind` (:382 for `word/media`, :392 for `ppt/media`, two independent call sites so a fixture covering one does not cover the other) admits a `word|ppt/media/*` entry into the unzip filter only when `mediaTypeFor` is truthy, and `assetFromArchive` (:452-460) returns null without one.
- `src/lib/__tests__/document-extract.test.ts` -- `office(filename, files)` (:10-23) builds a zip with `zipSync`/`strToU8` and calls `extractDocumentText`; the existing DOCX-image case ("preserves DOCX embedded images with their relationship and context", :52-67) shows the exact `<a:blip r:embed>` + `word/_rels/document.xml.rels` + `word/media/*` wiring a fixture needs, including the `bytes` and `context` assertions a new case should match. The existing PPTX case shows the `ppt/presentation.xml` + `ppt/slides/_rels/slideN.xml.rels` + `ppt/media/*` equivalent for the second call site.
- Read-only evidence, measured on this tree before planning:
  - Reverting `mediaTypeFor` to `IMAGE_MEDIA_TYPES[ext] ?? null` against a two-image DOCX fixture yields `[{filename: "logo.constructor", mediaType: <function Object>}, {filename: "chart.png", mediaType: "image/png"}]`; with `ownLookup` in place only `chart.png` survives. Both the asset count and the `typeof mediaType` discriminate.
  - Deleting `|| "application/octet-stream"` leaves the appended Blob at `type: ""` while the wire still reads `application/octet-stream` — confirming both that the append surface discriminates and that the `Request` surface does not.
  - `vi.spyOn(FormData.prototype, "append")` does capture the Worker's calls (it calls through by default), but `spy.mockRestore()` clears `spy.mock.calls`; a first attempt that restored before reading recorded zero calls and still passed. `spy.mock.contexts` is populated in vitest 3.2.4 and preserves instance identity, so appends can be scoped to the single form the Worker built; it is cleared by `mockRestore()` on the same terms and must be snapshotted alongside `mock.calls`.
  - Route cap, measured against the pre-change suite: deleting the `attachments.length > MAX_EMAIL_DOCUMENTS` branch and inverting it to `>=` both leave every existing route test green, and no test in the repo matches the string `Attach no more than 10 supported documents`. Moving the comparison ahead of the `isSupportedDocument` filter (comparing `payload.attachments.length`) is likewise invisible to every fixture posting three parts or fewer.
  - Transport, measured against the pre-change suite: replacing `` `Bearer ${serviceToken}` `` with a literal, deleting the `headers` object outright, hardcoding the target URL, and dropping the `.replace(/\/+$/, "")` trailing-slash trim each leave both Worker suites green, because both read only `formData()` off the captured `Request`.

## Tasks & Acceptance

**Execution:**
- `src/lib/__tests__/email-ingest-route.test.ts` -- add a `MAX_EMAIL_DOCUMENTS` cap describe block: import the constant from `@/lib/email-ingest`, build `n` small in-allowlist `File`s from a helper, and assert (a) exactly the cap returns 200 with `supportedAttachmentCount` equal to the cap, (b) one above returns 400 whose JSON `error` is the verbatim `Attach no more than 10 supported documents` with `mockedStageBytes`/`mockedEnqueue`/`mockedCreateJob` untouched, and (c) the cap plus two `.exe` parts still returns 200 -- closes DW-250; the boundary pair kills both deletion and inversion, and the third case pins that the comparison counts supported files only.
- `src/lib/__tests__/email-ingest-worker.test.ts` -- add a transport describe block asserting the captured `Request`'s `method`, `url` and `Authorization` header, with `YOPEDIA_SERVICE_TOKEN`/`YOPEDIA_SITE_URL` overridden to values that appear nowhere else in the suite, and assert the URL is built from that overridden site with a trailing-slash form too -- closes DW-252; distinct env values mean a hardcoded literal or a dropped token fails.
- `src/lib/__tests__/email-ingest-worker-normalization.test.ts` -- add a helper that spies on `FormData.prototype.append`, runs the worker, snapshots `spy.mock.calls` before `mockRestore()`, and returns the appended `attachments` Blobs; assert the empty-`mimeType` part's Blob is `application/octet-stream` and a typed sibling keeps its own type; rewrite the `:154-162` comment so it records that the wire assertion is the route-visible half and the append assertion is the discriminating one -- closes DW-251.
- `src/lib/__tests__/document-extract.test.ts` -- add a DOCX case via `office()` with two `a:blip` references, one resolving to `media/logo.constructor` and one to `media/chart.png`, asserting exactly one asset (`chart.png`, `image/png`), that no asset is named `logo.constructor`, that every asset's `mediaType` is a string matching `/^image\//`, and that the text carries only the real image's `Embedded image:` line -- closes DW-254.

**Acceptance Criteria:**
- Given the four suites, when `pnpm test` runs, then every existing assertion still passes and the new ones pass alongside them.
- Given each of the four mutations named under Boundaries, when it is applied in isolation and the affected suite is run, then at least one new assertion fails.
- Given this run, when `git diff --stat` is inspected, then only files under `src/lib/__tests__/` and the spec file changed — no production source.

## Review Triage Log

### 2026-08-20 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 0, medium 1, low 9)
- defer: 5: (high 0, medium 1, low 4)
- reject: 6: (high 0, medium 0, low 6)
- addressed_findings:
  - `[medium]` `[patch]` The spec filename and title read as the range "DW-250..DW-254", which a ledger sweep could take as closing DW-253 — a separate, still-open entry whose recorded human decision requires production changes this run forbids. Renamed to `spec-dw-250-251-252-254-email-ingest-test-coverage.md` and reworded the title to enumerate the four ids explicitly.
  - `[low]` `[patch]` The cap block derived every count from `MAX_EMAIL_DOCUMENTS` but pinned the copy with a bare `10`, so a legitimate cap change would fail as an opaque wording regression. Added an `expect(MAX_EMAIL_DOCUMENTS).toBe(10)` tripwire coupling the two.
  - `[low]` `[patch]` "the copy the sender reads" was factually wrong: the Worker slices to `MAX_EMAIL_ATTACHMENTS` (pinned equal to `MAX_EMAIL_DOCUMENTS`) before forwarding, so only a direct service-principal caller reaches that 400. Renamed the test and corrected the block comment.
  - `[low]` `[patch]` "counts only supported files toward the cap" never checked what was staged, so the two `.exe` parts could leak into staging unseen. Added a `stageBytes` call-count assertion.
  - `[low]` `[patch]` `email-ingest-worker.test.ts`'s header docblock still claimed "Two surfaces are pinned here" after a third was added. Rewritten to enumerate what the file now covers.
  - `[low]` `[patch]` The new helper's docblock called the append call site "innermost" where the spec calls the same choice "outermost". Reworded to the spec's framing, which is the correct one.
  - `[low]` `[patch]` `appendedAttachmentBlobs` spied on `FormData.prototype` and filtered by key alone, so a second form built during the run would fold its entries in. Scoped the calls to the single instance the worker built via `spy.mock.contexts`, snapshotted before `mockRestore()`; proven load-bearing against a decoy form.
  - `[low]` `[patch]` The new DOCX case asserted less than the existing image case beside it — no bytes, no context — so name-and-type-over-wrong-payload would pass. Added both.
  - `[low]` `[patch]` `archiveEntryKind` applies the same `mediaTypeFor` gate to `ppt/media/*` at `document-extract.ts:392` as to `word/media/*` at `:382`; that arm was unpinned. Added a PPTX `logo.constructor` fixture, confirmed to fail under the same mutation.
  - `[low]` `[patch]` Code Map line citations had drifted by one to three lines and one bullet pointed at a comment by a line number the change itself moved; the Verification mutation list omitted the pre-filter mutation the third route case exists to catch. Re-measured every production citation, re-anchored the test-file ones by name, added the fifth mutation, and recorded the missing read-only evidence.

## Verification

**Commands:**
- `npx vitest run src/lib/__tests__/email-ingest-route.test.ts src/lib/__tests__/email-ingest-worker.test.ts src/lib/__tests__/email-ingest-worker-normalization.test.ts src/lib/__tests__/document-extract.test.ts` -- expected: all pass.
- `pnpm lint` -- expected: no new errors.
- `pnpm test` -- expected: the full suite passes.
- Mutation checks (apply, run the suite, revert) -- expected: each fails at least one new assertion.
  1. Drop the route's `attachments.length > MAX_EMAIL_DOCUMENTS` branch (and, separately, invert it to `>=`).
  2. Move the cap comparison ahead of the `isSupportedDocument` filter, i.e. compare `payload.attachments.length` instead of `attachments.length` -- this is the mutation the third route case ("counts only supported files toward the cap") exists to catch, and neither the at-cap nor the over-cap case sees it.
  3. Swap the forwarded `Authorization` header for a literal (and, separately, hardcode the target URL).
  4. Delete `|| "application/octet-stream"` in the Worker's `Blob` construction.
  5. Revert `mediaTypeFor` to `IMAGE_MEDIA_TYPES[ext] ?? null` -- must fail BOTH the `word/media` and the `ppt/media` case.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** Tests only — no production source touched. Four assertions that previously did not exist now fail under the four mutations DW-250, DW-251, DW-252 and DW-254 name: the route's `MAX_EMAIL_DOCUMENTS` 400 branch is driven from both sides of the boundary with its copy pinned verbatim; the Worker's forwarded `Request` is asserted for method, target URL and `Authorization: Bearer <token>`, threaded from env values that appear nowhere else in the suite; the `|| "application/octet-stream"` Blob-type fallback is read at the Worker's own `form.append` call, the outermost surface at which it is still observable; and `mediaTypeFor`'s `ownLookup` guard is exercised through both archive arms by DOCX and PPTX fixtures carrying a `logo.constructor` media entry.

**Files changed.**
- `src/lib/__tests__/email-ingest-route.test.ts` -- new `supported-document cap` block: at the cap accepted, one above rejected with the verbatim copy and nothing staged, and the cap plus two `.exe` parts still accepted (DW-250).
- `src/lib/__tests__/email-ingest-worker.test.ts` -- new `email-ingest forwarded transport` block asserting the captured `Request`'s method, URL and credential, plus trailing-slash trimming of the configured site; stale header docblock rewritten (DW-252).
- `src/lib/__tests__/email-ingest-worker-normalization.test.ts` -- new `appendedAttachmentBlobs` helper reading Blob types at the `FormData.append` call, scoped to the worker's own form instance; new MIME-less-attachment case; the superseded comment rewritten rather than deleted (DW-251).
- `src/lib/__tests__/document-extract.test.ts` -- DOCX and PPTX cases whose rels point one `a:blip` at a `logo.constructor` media entry and another at a real PNG, asserting only the real image survives and every `mediaType` is an `image/*` string (DW-254).

**Review findings.** 10 patches applied (1 medium, 9 low); 5 items deferred (1 medium, 4 low); 6 rejected; 0 intent gaps; 0 spec repairs. Follow-up review recommended: **true** — patched severities were 0 high / 1 medium / 9 low, scoring `3x1 + 1x9 = 12`, at or above the threshold of 5.

**Verification.**
- `npx vitest run` (full suite): 259 files, 5629 tests, all pass.
- The four target suites alone: 55 tests, all pass.
- `npx eslint`: exit 0 (only pre-existing `jsx-ast-utils` warnings). `pnpm lint` fails in this environment with `ERROR packages field missing or empty` — a pnpm workspace-resolution problem that reproduces independently of this diff, so the underlying `eslint` invocation was run directly instead.
- All five mutations applied in isolation and reverted: drop the cap branch (1 failure); `>` to `>=` (2); compare `payload.attachments.length` ahead of the `isSupportedDocument` filter (1); freeze `Authorization` to a literal (1); hardcode the target URL (2); drop the site trim (1); delete `|| "application/octet-stream"` (1, while the pre-existing wire assertion stays green — confirming DW-251's premise); revert `mediaTypeFor` to `IMAGE_MEDIA_TYPES[ext] ?? null` (2, both archive arms).
- The `FormData` instance filter was itself proven load-bearing: a decoy form appending an `attachments` entry during the run is excluded, and weakening the filter back to key-only lets it leak in.
- `git status` after every mutation cycle: only the four test files modified plus this spec.

**Residual risks.**
- The `appendedAttachmentBlobs` helper is coupled to the Worker's specific `form.append("attachments", Blob, filename)` shape. A behaviour-preserving refactor (building the `FormData` from an entries array, or appending a `File`) would trip its guards with nothing on the wire changed. That coupling is the price of observing a fact the wire erases; the guards fail loudly rather than silently.
- The route's cap branch is unreachable through the email path, since the Worker truncates at the same number first. The new tests pin it as a route contract for direct service-principal callers; nothing pins the end-to-end relay of that 400 back to a sender through `safeError`.
- DW-253, which sits inside the numeric range this bundle spans, is deliberately untouched: it carries a recorded human decision requiring production changes, which this run's Never clause forbids. The spec filename and title enumerate the four ids explicitly so a ledger sweep cannot read the range as closing it.
