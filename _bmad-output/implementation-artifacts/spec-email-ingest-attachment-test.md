---
title: 'Pin the email-ingest worker attachment byte-copy with a test'
type: 'chore'
created: '2026-08-16'
status: 'done'
baseline_revision: '96b441a5ab0f1834eac0dba16e63145e824d97ae'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred:
  - summary: >-
      The email-ingest route's own byte handoff to `stageBytes` is unverified, so the
      empty-attachment harm DW-12 names is still reachable one hop past the worker.
    evidence: |-
      `src/app/api/email/ingest/route.ts:191-203` reads `await file.arrayBuffer()` and
      passes it to `stageBytes`. `src/lib/__tests__/email-ingest-route.test.ts:21-24`
      mocks `@/lib/ingest-staging` with `stageBytes: vi.fn(async (_jobId, filename) => ...)`
      — the mock ignores the bytes argument entirely, and the attachment assertions
      (lines 206, 211) check only `supportedAttachmentCount` and `filename`.
      Demonstrated: replacing `bytes: await file.arrayBuffer()` with `new ArrayBuffer(0)`
      leaves the full suite green (206 files / 4301 tests). The worker half of the path is
      now pinned; the route half is not.
    location: >-
      src/app/api/email/ingest/route.ts:194
    severity: medium
  - summary: >-
      The worker's supported-attachment allowlist has drifted from the app's document
      extractor, so formats the app can read are rejected at the email door.
    evidence: |-
      `workers/email-ingest/index.ts:42-68` omits `odt`, `ods`, `odp`, `epub`, `org`,
      `rtf`, `mobi` and `text/x-markdown`, all of which `src/lib/document-extract.ts:7-64`
      supports — so those emailed files draw a "not supported" reply even though ingestion
      would have worked. The worker also matches `mimeType.toLowerCase()` whole, while
      `detectDocumentFormat` strips `;` parameters first, so a `text/csv; charset=utf-8`
      part matches only via its extension. Nothing pins the two lists in agreement, and
      deleting the worker's filter at `index.ts:193-195` outright leaves the suite green.
    location: >-
      workers/email-ingest/index.ts:42-73
    severity: medium
  - summary: >-
      The `attachmentName` FormData fields the worker sends are unobserved, so names of
      unsupported attachments can vanish from ingest job metadata undetected.
    evidence: |-
      `workers/email-ingest/index.ts:225` appends every attachment name (supported or not);
      `src/app/api/email/ingest/route.ts:58-60` reads them back and persists them into the
      job's `email` metadata. Demonstrated: deleting the append loop leaves the full suite
      green. The route's union of names only recovers the *supported* files' names, so
      anything filtered out at `index.ts:193-195` is lost with nothing failing. The new
      worker test already parses the outgoing FormData but reads only `getAll("attachments")`.
    location: >-
      workers/email-ingest/index.ts:225
    severity: medium
  - summary: >-
      Only the ArrayBuffer branch of the worker's attachment-content normalization is
      exercised — including, ironically, not the branch the defensive copy exists for.
    evidence: |-
      `workers/email-ingest/index.ts:228-238` has three branches: string content via
      `TextEncoder`, `ArrayBuffer`, and a typed-array view reconstructed from
      `.buffer/.byteOffset/.byteLength`. Probing the installed `postal-mime@2.7.5` with a
      base64 part yields an `ArrayBuffer`, so only `index.ts:230-231` runs. The view branch
      carries the byteOffset arithmetic most prone to silent corruption, and the copy's own
      comment names the SharedArrayBuffer view as its reason for existing.
    location: >-
      workers/email-ingest/index.ts:228-238
    severity: low
  - summary: >-
      Multi-attachment behaviour is unobserved — the 10-attachment cap, per-index
      filename/bytes pairing, and both fallbacks are untested.
    evidence: |-
      The fixture carries exactly one named attachment with an explicit mimeType, so
      `.slice(0, 10)` (`index.ts:195`), the `attachment-${index + 1}` filename fallback
      (`index.ts:227`) and the `"application/octet-stream"` mimeType fallback
      (`index.ts:243`) never run. Demonstrated: narrowing the cap to `.slice(0, 1)` leaves
      the full suite green — a regression that forwards only the first of ten attached
      documents, or pairs attachment i's bytes with attachment j's filename (and therefore
      the wrong extractor at `route.ts:237-239`), would ship undetected. The `10` also
      duplicates the route's `MAX_EMAIL_DOCUMENTS` with nothing pinning them in agreement.
    location: >-
      workers/email-ingest/index.ts:193-246
    severity: low
  - summary: >-
      The acknowledgement copy a sender receives about their attachments is unpinned.
    evidence: |-
      `workers/email-ingest/index.ts:287-292` builds the "N supported attachment(s) were
      queued" and "N unsupported attachment(s) were recorded but skipped" lines, including
      their singular/plural branches. Demonstrated: blanking those lines leaves the full
      suite green. The two existing tests assert on reply text but drive a no-attachment
      fixture; the new test drives an attachment fixture but reads only the outgoing request.
    location: >-
      workers/email-ingest/index.ts:287-292
    severity: low
  - summary: >-
      Base64 expansion makes the route's 10 MB per-document limit unreachable via email,
      and neither cap is tested against the other.
    evidence: |-
      The worker rejects on `message.rawSize > MAX_RAW_EMAIL_BYTES` (10 MB,
      `index.ts:39/147`) — a raw-message measurement taken *before* MIME decoding. Base64
      inflates payloads by roughly a third, so the effective per-attachment ceiling over
      email is about 7.5 MB, while `MAX_DOCUMENT_SIZE` in `src/lib/constants.ts` is 10 MB.
      The gap is undocumented and untested in both directions.
    location: >-
      workers/email-ingest/index.ts:39
    severity: low
---

<intent-contract>

## Intent

**Problem:** `workers/email-ingest/index.ts:239-243` copies each supported attachment's bytes into a fresh `Uint8Array` and wraps it in a `Blob` for the `attachments` FormData part, but nothing tests that path — `email-ingest-worker.test.ts` is the only test importing the worker and its fixture is a plain-text message with no attachment, asserting only on `msg.reply` text. Zeroing or emptying that copy would still yield a correctly-sized buffer, a `{ ok: true, slug }` response and an identical acknowledgement email, so every emailed PDF/DOCX would ingest empty with the suite green.

**Approach:** Add a worker-level test that drives `worker.email` with a MIME fixture carrying a base64 binary attachment, captures the `Request` handed to the `YOPEDIA` service-binding fetch stub, and asserts the forwarded `attachments` FormData part is byte-for-byte identical to the source attachment bytes (plus its filename and content type).

## Boundaries & Constraints

**Always:** Assert on the bytes the worker actually forwarded — read them back off the captured `Request` via `request.formData()` and compare every byte to the fixture's source bytes. The fixture's byte payload must contain non-zero, non-ASCII values spanning the full 0x00–0xFF range so a zeroed copy, a truncated copy, or a text-decode of the payload all fail.

**Block If:** The existing two acknowledgement tests in `email-ingest-worker.test.ts` cannot keep passing unchanged alongside the new test — that would mean the shared helpers were reshaped destructively rather than extended.

**Never:** Do not modify `workers/email-ingest/index.ts` — the attachment path is pre-existing production behavior and this work only adds coverage for it. Do not test the `/api/email/ingest` route handler (route-level tests are out of scope; the gap is the worker's own copy). Do not add a new test file — extend the existing worker test file so the worker keeps a single test surface.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Binary attachment forwarded intact | Multipart message from an allowed sender with a text part and a base64 `application/pdf` part named `report.pdf` whose bytes span 0x00–0xFF | The captured request's FormData carries exactly one `attachments` part; its bytes equal the fixture bytes one-for-one, its filename is `report.pdf`, its type is `application/pdf` | No error expected |
| Zeroed / empty byte-copy | Same fixture, with the worker's `bytes.set(source)` copy defeated (zeroed or zero-length) | The byte comparison fails, so the suite is red | Test failure is the expected signal |

</intent-contract>

## Code Map

- `workers/email-ingest/index.ts:226-246` -- the untested path. Builds `filename` (falls back to `attachment-<n>`), normalizes `attachment.content` (string → `TextEncoder`; `ArrayBuffer` → `new Uint8Array(buf)`; else a view over `.buffer/.byteOffset/.byteLength`), then copies into `const bytes = new Uint8Array(source.byteLength); bytes.set(source);` and appends a `Blob([bytes], { type: attachment.mimeType || "application/octet-stream" })` as `attachments`. Read-only for this work.
- `workers/email-ingest/index.ts:193-195` -- `supportedAttachments` filters via `supportedAttachment()` then `.slice(0, 10)`; `application/pdf` / `.pdf` is in both `SUPPORTED_EXTENSIONS` and `SUPPORTED_MIME_TYPES`, so the fixture's part survives the filter.
- `workers/email-ingest/index.ts:247-255` -- the single `env.YOPEDIA.fetch(new Request(...))` call. The `YOPEDIA.fetch` stub is the only interception point: capture its `Request` argument to read the forwarded FormData.
- `src/lib/__tests__/email-ingest-worker.test.ts` -- the file to extend. Already holds `RAW_EMAIL`, `message()` (returns a `raw` stream via `new Blob([RAW_EMAIL]).stream()`, `rawSize`, `vi.fn()` `setReject`/`reply`) and `env(response)` (config KV enabled with `allowedSenders: ["owner@example.com"]`, `inboundAddress: "ingest@workwiki.app"`, `YOPEDIA.fetch` returning a fixed `response`, token, site URL). Two existing tests assert acknowledgement URLs and must keep passing untouched.
- `vitest.config.ts` -- `environment: "node"`, `include: ["src/**/__tests__/**/*.test.ts"]`. Node 24 supplies global `FormData`/`Blob`/`Request`/`File`, so `await request.formData()` round-trips the part as a `File`.
- Verified by probe against the installed `postal-mime@2.7.5`: a base64 `Content-Transfer-Encoding` part parses to `attachment.content` as an **`ArrayBuffer`**, so the worker takes its `instanceof ArrayBuffer` branch; `filename`/`mimeType` arrive as `report.pdf` / `application/pdf`, and the Blob→Request→`formData()` round-trip preserves all 256 byte values.

## Tasks & Acceptance

**Execution:**
- `src/lib/__tests__/email-ingest-worker.test.ts` -- add a byte-payload fixture builder and a multipart raw-email fixture carrying it as a base64 `application/pdf` attachment, generalize the existing `message()`/`env()` helpers to accept the raw source and to capture the forwarded `Request` (keeping their current call sites working unchanged), and add a `describe`d test asserting the forwarded `attachments` part matches the source bytes exactly along with its filename and content type -- covers the I/O matrix rows; without it a zeroed byte-copy ships green.

**Acceptance Criteria:**
- Given the extended test file, when the full suite runs, then the two pre-existing acknowledgement tests still pass with their assertions unmodified.
- Given the worker's attachment byte-copy is deliberately defeated (e.g. `bytes.set(source)` removed so the forwarded buffer is all zeros), when the suite runs, then the new test fails — confirming the assertion observes the copy rather than a proxy for it.
- Given the fixture attachment is unsupported-by-filter or absent, when the worker runs, then no `attachments` part is asserted on — the new test constrains only the supported-attachment path and does not weaken existing coverage.

## Spec Change Log

## Review Triage Log

### 2026-08-16 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 0, low 4)
- defer: 7: (high 0, medium 3, low 4)
- reject: 7: (high 0, medium 0, low 7)
- addressed_findings:
  - `[low]` `[patch]` `message()` reported `rawSize: raw.length`, a UTF-16 code-unit count standing in for the byte count the worker compares against `MAX_RAW_EMAIL_BYTES` — correct only because both fixtures are pure ASCII. Now `new TextEncoder().encode(raw).byteLength`.
  - `[low]` `[patch]` `message()` hardcoded `Headers({ subject: "Quarterly notes" })` for every fixture while `ATTACHMENT_EMAIL` declares `Subject: Quarterly report`, making the fixture inconsistent with its own MIME headers. The header subject is now a parameter defaulting to the original value, and the attachment test passes its own.
  - `[low]` `[patch]` `parts[0] as File` narrowed by cast, so a non-`File` entry would have surfaced as a confusing `undefined !== "report.pdf"`. Added `expect(parts[0]).toBeInstanceOf(File)` before the narrowing.
  - `[low]` `[patch]` The file-level docblock still framed the whole file as being about the acknowledgement page link, and the new `describe`-level comment restated the same reasoning. The header now introduces both pinned surfaces once; the `describe` comment keeps only the "assert on the request, not a proxy" rationale.

## Design Notes

The assertion must observe the outermost surface the worker controls: the `Request` body it hands to the service binding, not `parsed.attachments` or any internal. Capture shape:

```ts
let captured: Request | undefined;
const YOPEDIA = { fetch: vi.fn(async (request: Request) => { captured = request; return response; }) };
// ...
const part = (await captured!.formData()).getAll("attachments")[0] as File;
expect(new Uint8Array(await part.arrayBuffer())).toEqual(ATTACHMENT_BYTES);
```

Build the payload so every failure mode is caught: `ATTACHMENT_BYTES[i] = (i * 7 + 3) & 0xff` over 256 bytes covers all byte values including 0x00 and high bytes, so a zeroed copy, a short copy, and a UTF-8 decode/re-encode each diverge. Base64-encode it with CRLF line wrapping at 76 chars for a well-formed MIME part.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/email-ingest-worker.test.ts` -- expected: all tests pass, including the two pre-existing acknowledgement tests.
- `pnpm test` -- expected: full suite passes with no new failures.
- `npx tsc --noEmit` -- expected: no new type errors from the test file.

**Manual checks (if no CLI):**
- Temporarily defeat the copy in `workers/email-ingest/index.ts` (drop `bytes.set(source)`), re-run the worker test, confirm it FAILS, then restore the line verbatim and confirm it passes again.

## Auto Run Result

Status: done

**Implemented change.** `workers/email-ingest/index.ts:239-240` copies each supported attachment's bytes into a fresh `Uint8Array` before wrapping it in a `Blob` for the `attachments` FormData part, and nothing observed that copy — zeroing it would still produce a correctly-sized buffer, an `{ ok: true, slug }` response and a byte-identical acknowledgement email, so every emailed PDF/DOCX would have ingested empty with the suite green. The worker test now drives `worker.email` with a `multipart/mixed` fixture carrying a base64 `application/pdf` part whose 256-byte payload (`(i * 7 + 3) & 0xff`, a bijection over 0x00–0xFF) covers every byte value, pulls the forwarded `Request` off the `YOPEDIA.fetch` stub, and asserts via `request.formData()` that the single `attachments` part matches the source bytes exactly, plus its filename and content type. No production source was modified.

**Files changed.**
- `src/lib/__tests__/email-ingest-worker.test.ts` — adds the byte-payload fixture, a base64 MIME builder and the `email-ingest attachment forwarding` test; parameterizes `message()` on raw source and header subject; rescopes the file docblock. The two pre-existing acknowledgement tests keep their assertions and their inputs unchanged.
- `_bmad-output/implementation-artifacts/spec-email-ingest-attachment-test.md` — this spec.

**Review findings breakdown.** 4 patches applied (all low, listed in the Review Triage Log), 7 items deferred (3 medium, 4 low, recorded in frontmatter `deferred`), 7 rejected. No intent gaps and no spec defects — no repair loopback was needed. Rejected as noise: that substituting `Blob([source])` for `Blob([bytes])` goes undetected (the defensive-copy invariant is a separate property from byte fidelity, and the docblock does not claim to pin it); that the Execution line mentions generalizing `env()` when `env()` needed no change (its `vi.fn()` already records the `Request`); that the third acceptance criterion describes the absence of an assertion and so cannot be implemented as a test; an empty-payload guard for `base64Lines`, which has one caller passing a fixed 256 bytes; that the Verification section omits a lint command; that `workers/` has no vitest root of its own; and `toStrictEqual` over `toEqual` for the byte comparison.

**Follow-up review recommendation: false.** Patched findings this pass: 0 high, 0 medium, 4 low. Score = 3 × 0 + 1 × 4 = 4, below the threshold of 5, and no patched finding was high severity.

**Verification performed.**
- `./node_modules/.bin/vitest run src/lib/__tests__/email-ingest-worker.test.ts` — 3 passed.
- `./node_modules/.bin/vitest run` (full suite) — 206 files, 4301 tests, all passing, before and after the review patches.
- `./node_modules/.bin/tsc --noEmit` — clean, exit 0.
- Manual mutation check (the load-bearing one), run twice — once after implementation and again after the review patches: deleting `bytes.set(source)` from `workers/email-ingest/index.ts` turns the new test red with a 256-zero-byte diff while both acknowledgement tests stay green; the worker was then restored via `git checkout` and confirmed byte-identical (`git diff` empty) with the suite green again. This is what establishes that the assertion observes the copy rather than a proxy for it.
- The spec's `pnpm`-prefixed commands could not be used: a stray empty `~/pnpm-workspace.yaml` (dated well before this work) makes pnpm treat the home directory as a workspace root, so every `pnpm <script>` in this repo fails with `ERROR packages field missing or empty`. The local binaries above are the equivalent invocations. This is a machine-level environment defect outside the repository and was left alone.

**Residual risks.**
- The pinned property is worker-scoped by the intent's own framing ("a worker-level test", "the route-level tests never exercise the worker's copy"). The harm sentence — emailed documents ingesting empty — spans one hop further, and that hop is demonstrably unpinned: blanking the route's `file.arrayBuffer()` handoff leaves the whole suite green. Recorded as the first deferred item.
- The fixture reaches only the `instanceof ArrayBuffer` branch of the worker's content normalization, because that is what `postal-mime@2.7.5` returns for a base64 part. The typed-array-view branch — the one the defensive copy exists for — stays uncovered. Recorded as a deferred item.
- Single-attachment fixture, so the 10-attachment cap, per-index filename/bytes pairing and both fallbacks remain unobserved. Recorded as a deferred item.
- `AGENTS.md` was modified in the working tree by the concurrently-running bmad-loop orchestrator during this run (the tree was clean at the step-01 version-control check). It is unrelated to this work, was left untouched, and is deliberately excluded from this run's commit.
