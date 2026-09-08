---
title: 'MCP/REST door parity for batch ingest and lint fix (DW-395, DW-455, DW-456, DW-457)'
type: 'bugfix'
created: '2026-08-29'
status: 'done'
baseline_revision: '207b95fa74d4b3713c2700cf83256cda3f5d67d7'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['multiple-goals', 'oversized']
deferred:
  - summary: >-
      Every other `ToolDef.run` in `MCP_TOOLS` still spreads-and-casts
      `tools/call` arguments with no runtime check, because `dispatchMcp`
      validates nothing generically -- DW-455 closed this for `fix_lint_issue`
      alone.
    evidence: |-
      `dispatchMcp` hands `params.arguments` to `tool.run` unvalidated, and
      roughly nine sibling handlers do `a as Parameters<typeof handler>[0]`
      (src/lib/mcp-http.ts lines ~370, 466, 576, 577, 629, 644, 667, 691, 704,
      721). Concrete: `batch_ingest_urls` with `urls: "https://x"` reaches
      `handleBatchIngest`, where a string's `.length` and index access make it
      look array-like and it reports `Malformed URLs at indices 0, 1, 2...`;
      `urls: undefined` throws. The stdio door catches both at
      `z.array(z.string())`. Every `ToolDef` already declares a JSON Schema with
      a `required` list, so `dispatchMcp` could validate generically once.
      DW-455's title scopes it to `fix_lint_issue`, so the rest was left alone.
    location: >-
      src/lib/mcp-http.ts (dispatchMcp + every ToolDef.run)
    severity: medium
  - summary: >-
      The REST lint-fix door names the field `targetSlug` while both MCP doors
      name it `target`, so an agent's request body is not portable between the
      two surfaces the bundle set out to bring to one contract.
    evidence: |-
      `LINT_FIX_REQUEST` (src/app/api/lint/fix/route.ts:29-34) declares
      `targetSlug`; `src/mcp.ts`'s registered schema and
      `src/lib/mcp-http.ts`'s `inputSchema` both declare `target`, and
      `handleFixLintIssue` forwards `args.target` into `fixLintIssue`'s
      `targetSlug` parameter. Pre-existing and untouched by DW-455/DW-457, but
      it now means the two doors' new "Invalid request field `...`" messages
      name different fields for the same value. `src/app/api/lint/workbench-fix/route.ts:27-32`
      already accepts BOTH names, which is the precedent for an alias.
    location: >-
      src/app/api/lint/fix/route.ts:32 vs src/lib/mcp-http.ts:509
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Four spots where the MCP doors and the REST doors enforce different contracts for the same operation. `handleIngestBatch` re-resolves the Workspace Purpose and re-reads the Names & Terms dictionary for every URL of one agent action (DW-395); the HTTP MCP `fix_lint_issue` gates only `type` and casts `slug`/`target`/`message` through unchecked, so a non-string `slug` surfaces as a 404 naming `[object Object]` (DW-455); `POST /api/lint/fix` never passes the resolved owner as `author`, so every REST lint fix is attributed to the default `"lint-fix"` (DW-456); and `missing-concept-page` is unreachable over both MCP transports because both require a `slug` for the one type that reads `message` alone (DW-457).

**Approach:** Four localized fixes at the doors that already own the correct behaviour on the other transport: mint one `createGuidanceCache()` per batch handler call; runtime-check the three string fields in the HTTP MCP tool's `run`; thread `principal.handle` into `fixLintIssue`'s fifth argument; make `slug` optional in both MCP schemas and in `handleFixLintIssue`, converting an absent slug to `""` exactly as the REST door's `slug ?? ""` does. Cover each with a test.

## Boundaries & Constraints

**Always:**
- The `GuidanceCache` handle is CALLER-OWNED and PER-OPERATION (see `src/lib/guidance-cache.ts` docstring): one per `handleIngestBatch` CALL, never module-level, never reused across calls.
- Absent `slug` reaches `fixLintIssue` as `""`, not `undefined` — its signature takes `slug: string` and every slug-requiring handler answers `"Missing required field: slug"`, which is a better error than a schema's.
- `type` stays gated exactly as today on both MCP doors (SDK `z.enum` on stdio, `autoFixRefusal` in `run` on HTTP). Nothing in this change loosens or duplicates that gate.
- A refused non-string field must be refused BEFORE `handleFixLintIssue` is reached — the call record (`spiedFixLintIssue`) is what proves it.
- Existing assertions that pin `fixLintIssue`'s call shape must be updated, not deleted, when the arity changes.

**Block If:**
- Making `slug` optional would require changing `fixLintIssue`'s own signature in `src/lib/lint-fix.ts` (it must not — the `?? ""` conversion belongs at the doors).

**Never:**
- Do not add `author` to the STDIO `fix_lint_issue` door. Stdio MCP is unauthenticated and deployment-trusted (`src/mcp.ts:111`, and the service-principal fallbacks around `src/mcp.ts:288`); it has no principal to pass, and `"lint-fix"` is the honest attribution there. (DW-456's reason line says both MCP doors pass `p!.handle`; only `src/lib/mcp-http.ts` does. Fix the REST door only — that is what the entry's title and `location` scope.)
- Do not give the QUEUED path in `POST /api/ingest/batch` a guidance handle; a queued task is a later request and must resolve fresh.
- Do not widen `AUTO_FIXABLE_CHECK_TYPES` or touch any other lint check type.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Batch ingest, N URLs | `handleIngestBatch({ urls: [a, b, c] })` | All three `ingestUrl` calls receive the SAME `guidanceCache` object (identity, not shape) | No error expected |
| Two batch calls | Two separate `handleIngestBatch` calls | Second call's handle is NOT the first call's | No error expected |
| HTTP MCP, non-string slug | `fix_lint_issue { type: "orphan-page", slug: { x: 1 } }` | `isError` result naming the `slug` field; `fixLintIssue` never called | Error text names `slug` |
| HTTP MCP, non-string target/message | `fix_lint_issue { type: "missing-crossref", slug: "p", target: 7 }` | `isError` result naming the offending field; `fixLintIssue` never called | Error text names the field |
| REST lint fix, owner resolved | `POST /api/lint/fix { type: "orphan-page", slug: "p" }` as owner `LuckierTrout` | `fixLintIssue("orphan-page", "p", undefined, undefined, "LuckierTrout")` | Unchanged status codes |
| Slug-less missing-concept-page, stdio | `fix_lint_issue { type: "missing-concept-page", message: "…" }` | Passes schema validation, reaches the handler | Handler's own parse error, not a schema error |
| Slug-less missing-concept-page, HTTP MCP | same, over `dispatchMcp` | `fixLintIssue("missing-concept-page", "", undefined, message, "alice")` | Handler's own parse error |
| Slug-less slug-requiring type | `fix_lint_issue { type: "orphan-page" }` on either MCP door | Reaches handler, which answers `"Missing required field: slug"` | Handler error, not schema error |

</intent-contract>

## Code Map

- `src/mcp.ts:531-541` -- `handleIngestBatch`'s `for (const url of urls)` loop; the options literal passed to `ingestUrl` is where `guidanceCache` goes (DW-395). Mint the handle ONCE above the loop.
- `src/app/api/ingest/batch/route.ts:119-136` -- the REST precedent, including the block comment that states the "one user action, one consistent set of guidance" scope. Reuse its reasoning, not its text.
- `src/lib/guidance-cache.ts:52` -- `createGuidanceCache()`. Its docstring's "Scope today:" paragraph (lines 28-31) names only `ingest()` and the batch route; extend it to name the MCP batch handler.
- `src/lib/ingest.ts:1350` -- `IngestOptions.guidanceCache?: GuidanceCache`; `src/lib/ingest.ts:1770` -- `options?.guidanceCache ?? createGuidanceCache()`, the seam that adopts a caller handle.
- `src/mcp.ts:1210-1217` -- `handleFixLintIssue`; `slug: string` becomes optional and is converted with `?? ""` when calling `fixLintIssue` (DW-457).
- `src/mcp.ts:2494-2513` -- the stdio `fix_lint_issue` `inputSchema`: `slug: z.string()` becomes `.optional()` with a description saying why (DW-457).
- `src/lib/mcp-http.ts:505-509` -- the HTTP MCP `inputSchema`: `["type", "slug"]` becomes `["type"]` (DW-457).
- `src/lib/mcp-http.ts:512-529` -- the tool's `run`: currently `autoFixRefusal(a.type, …)` then a blind `a as {…}` cast. Add the runtime string checks here (DW-455). `src/lib/mcp-http.ts:408` (`reingest`) is the in-file precedent for `typeof a.slug === "string"`.
- `src/lib/mcp-http.ts:139-148` -- `str`/`schema` helpers, and `attributed` at line 150; `ToolDef.run` receives `(args: Record<string, unknown>, principal)`. `dispatchMcp` does NOT validate `tools/call` arguments — the tool's `run` is the only gate.
- `src/app/api/lint/fix/route.ts:150-152` -- `principal` is resolved at line 92; `fixLintIssue(type, slug ?? "", targetSlug, message)` is missing the fifth `author` argument (DW-456).
- `src/lib/lint-fix.ts:932-947` -- `fixLintIssue(type, slug, targetSlug?, message?, author = "lint-fix")`. READ-ONLY: do not change this signature.
- `src/lib/lint-fix.ts:799-800` -- `"missing-concept-page": ({ message, author }) => fixMissingConceptPage(message ?? "", author)` — it genuinely never reads `slug`. `fixMissingConceptPage` (line 328) throws `FixValidationError("Could not parse concept name from lint message")` on an unparseable message, which is how a test proves the request got PAST the schema.
- `src/lib/__tests__/lint-fix-route.test.ts:196-256` -- three `toHaveBeenCalledWith(...)` assertions pinning `fixLintIssue`'s 4-arg shape. These BREAK on the DW-456 fix and must gain a fifth `"LuckierTrout"` (the handle `beforeEach` sets at line 72).
- `src/lib/__tests__/mcp-http.test.ts:721-846` -- `describe("dispatchMcp — fix_lint_issue")` and its inner `describe("the type gate")` with the `call`/`errorText` helpers, `spiedFixLintIssue`, and `ALICE` (`{ id: "agent:a--yoyo", handle: "alice" }`). New DW-455/DW-457 rows go here.
- `src/lib/__tests__/mcp.test.ts:2744-2843` (`describe("fix_lint_issue")`, handler-level, real storage via `writeTestPage`/`writeIndex`, `callLLM` mocked at line 100) and `2860-2949` (`describe("fix_lint_issue — the stdio door")`, real `InMemoryTransport` client). New DW-457 rows go in both.
- `src/lib/__tests__/ingest-routes.test.ts:646-711` -- the DW-324 guidance-cache rows for the REST batch route: the identity/fresh-per-request assertion shape to mirror for DW-395.
- `src/lib/__tests__/mcp.test.ts:1651-1740` -- the existing `batch_ingest_urls` suite. It does NOT mock `@/lib/ingest` (it drives the real pipeline with `fetchUrlContent` mocked), so the DW-395 identity assertion cannot live here — it needs its own file that module-mocks `@/lib/ingest`.

## Tasks & Acceptance

**Execution:**

- `src/mcp.ts` -- in `handleIngestBatch`, mint `const guidanceCache = createGuidanceCache();` once above the `for (const url of urls)` loop and add `guidanceCache` to the `ingestUrl` options literal; import `createGuidanceCache` from `./lib/guidance-cache`. Add a short comment stating the scope (one agent action = one consistent set of guidance) and citing DW-395. -- One agent action must not pay N Workspace-Purpose resolutions and N dictionary reads.
- `src/lib/guidance-cache.ts` -- extend the "Scope today:" paragraph to name the MCP batch handler alongside `ingest()` and `POST /api/ingest/batch`. -- The docstring is the only inventory of who mints a handle; leaving it stale is the drift this fix would otherwise introduce.
- `src/mcp.ts` -- widen `handleFixLintIssue`'s `args.slug` to optional and call `fixLintIssue(args.type, args.slug ?? "", …)`; change the stdio `fix_lint_issue` schema's `slug` to `z.string().optional()` and say in its `.describe()` that `missing-concept-page` reads `message` alone. -- DW-457: the one type whose fix takes no slug must be callable without inventing a dummy one.
- `src/lib/mcp-http.ts` -- drop `slug` from the `fix_lint_issue` required list, match the stdio `slug` description, and in `run` reject a present-but-non-string `slug`, `target` or `message` before `handleFixLintIssue` with an error naming the field; pass the checked values through explicitly instead of the blind `a as {…}` cast. -- DW-455 + DW-457: `dispatchMcp` validates nothing, so this `run` is the only gate, and it must enforce the same four-field contract `LINT_FIX_REQUEST` does.
- `src/app/api/lint/fix/route.ts` -- pass `principal.handle` as `fixLintIssue`'s fifth `author` argument. -- DW-456: the owner is resolved three statements above; attributing their fix to `"lint-fix"` loses the real actor in revisions and the activity trail.
- `src/lib/__tests__/lint-fix-route.test.ts` -- add `"LuckierTrout"` to the three existing `toHaveBeenCalledWith` assertions, and add a row asserting the author reaching the dispatcher is the resolved principal's handle (not the `"lint-fix"` default). -- The arity change breaks the existing rows; the new row is DW-456's only observer.
- `src/lib/__tests__/mcp-http.test.ts` -- add rows: a non-string `slug` (and `target`, and `message`) is refused with an error naming the field and `spiedFixLintIssue` is never called; a slug-less `missing-concept-page` reaches the dispatcher as `("missing-concept-page", "", undefined, <message>, "alice")`; `tools/list` advertises `required: ["type"]` for `fix_lint_issue`. -- DW-455 and DW-457 on the HTTP transport.
- `src/lib/__tests__/mcp.test.ts` -- add rows: `handleFixLintIssue({ type: "missing-concept-page", message: 'Concept "Vector Search" is mentioned in …' })` with no `slug` creates the stub page; over the real client transport a slug-less `missing-concept-page` passes schema validation (an unparseable message yields the handler's parse error, not a schema error); the registered schema marks `slug` optional. -- DW-457 on the stdio transport, plus the first coverage this type has had on either.
- `src/lib/__tests__/mcp-batch-guidance-cache.test.ts` (new) -- module-mock `@/lib/ingest` and assert `handleIngestBatch` hands every `ingestUrl` call the SAME handle within one call, and a different handle across two calls. -- DW-395's only observer; the existing `batch_ingest_urls` suite drives the real pipeline and cannot see the option object.

**Acceptance Criteria:**
- Given a `missing-concept-page` lint issue, when an agent calls `fix_lint_issue` over either MCP transport with `message` and no `slug`, then the call is accepted and the stub page is created — no dummy slug required.
- Given the owner posts to `/api/lint/fix`, when the fix writes the page, then the revision and ledger attribute it to the owner's handle rather than `"lint-fix"`.
- Given an agent calls the HTTP MCP `fix_lint_issue` with a non-string `slug`, `target` or `message`, then it is told which field is wrong and the dispatcher is never reached — no 404 naming `[object Object]`.
- Given one `batch_ingest_urls` agent action over N URLs, when the batch runs, then the Workspace Purpose is resolved and the Names & Terms dictionary read once for the whole batch, not once per URL.

## Spec Change Log

_No bad_spec loopbacks._

## Review Triage Log

### 2026-08-29 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 2, low 6)
- defer: 2: (high 0, medium 2, low 0)
- reject: 11: (high 0, medium 0, low 11)
- addressed_findings:
  - `[medium]` `[patch]` `optionalString` in `src/lib/mcp-http.ts` treated an explicit `null` as absent, but zod 4.4.2's `z.string().optional()` REFUSES `null` — so `{"type":"orphan-page","slug":null}` was a 400 at the REST door and a silent success at the MCP one, and both the code comment and a new test comment asserted a parity that did not exist. Narrowed "absent" to a missing key or `undefined`; `null` now falls through to the field-naming refusal. Comments corrected, control row switched to a genuinely absent field, and a row added pinning the `null` refusal.
  - `[medium]` `[patch]` Both `fix_lint_issue` tool descriptions still read "Takes the issue type, slug, and optional target/message" — the first prose an agent reads, contradicting the newly-optional `slug`. Updated in `src/lib/mcp-http.ts` and `src/mcp.ts`, leaving the two sentences existing tests pin intact.
  - `[low]` `[patch]` The comment "Explicit fields, no blind cast: only what this gate checked is passed" sat directly above `type: a.type as string`, the one field the gate does not check. Rewritten to state that `type` is gated by `autoFixRefusal` (which refuses every non-string), so the cast records a proved narrowing.
  - `[low]` `[patch]` The DW-456 test read `spiedFixLintIssue.mock.calls[0][4]`, which throws a TypeError rather than failing an assertion when the dispatcher is never reached. Switched to the file's own `toHaveBeenCalledWith` idiom.
  - `[low]` `[patch]` The stdio `fix_lint_issue` registration keeps the `"lint-fix"` default with nothing saying why, one file from a new comment calling that default a defect. Added a comment: the transport is unauthenticated, and `"lint-fix"` is an `AUTOMATION_ACTORS` member that `normalizeActor` folds into the agent.
  - `[low]` `[patch]` Hoisting the `call`/`errorText`/`beforeEach` helpers in `mcp-http.test.ts` stranded the DW-348 `type`-gate docblock above them. Moved back onto the describe it explains; helpers given their own comment.
  - `[low]` `[patch]` `expect(handles[0]).toBeDefined()` in the new batch suite passed for any truthy value, including `guidanceCache: true`. Replaced with an assertion that the handle carries `workspace` and `namesTerms`.
  - `[low]` `[patch]` The new suite was the only one in `src/lib/__tests__/` importing via `@/`; switched to the sibling convention (`../ingest`, `../logger`, `../../mcp`).

## Design Notes

The HTTP MCP `run` gate, mirroring `LINT_FIX_REQUEST`'s four fields with the same optionality:

```ts
const optionalString = (a: Record<string, unknown>, field: string): string | undefined => {
  const v = a[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`Invalid request field \`${field}\`: expected string`);
  return v;
};
```

Then `slug`/`target`/`message` are read through it, `autoFixRefusal(a.type, slug ?? "")` keeps the existing `type` gate, and `handleFixLintIssue` is called with the checked values plus `author: p!.handle` — no blind cast.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/mcp-http.test.ts src/lib/__tests__/mcp.test.ts src/lib/__tests__/lint-fix-route.test.ts src/lib/__tests__/lint-fix.test.ts src/lib/__tests__/mcp-batch-guidance-cache.test.ts src/lib/__tests__/ingest-routes.test.ts` -- expected: all pass, including the new rows.
- `pnpm exec tsc --noEmit` -- expected: no errors (the `handleFixLintIssue` optional-`slug` widening and the removed cast are the type-sensitive edits).
- `pnpm lint` -- expected: clean.
- `pnpm vitest run` -- expected: full suite green; the arity change touches every assertion pinning `fixLintIssue`'s call shape.

## Auto Run Result

Status: done

**Implemented change.** Four MCP/REST door-parity defects from bundle `mcp-rest-door-parity` (DW-395, DW-455, DW-456, DW-457), each closed at the door that lacked the contract its counterpart already enforced:

- **DW-395** — `handleBatchIngest` now mints one `createGuidanceCache()` per call and passes it to every `ingestUrl`, so one agent batch resolves the Workspace Purpose and reads the Names & Terms dictionary once instead of once per URL. Matches what `POST /api/ingest/batch` has done for its inline fallback since DW-324.
- **DW-455** — the HTTP MCP `fix_lint_issue` `run` now runtime-checks `slug`, `target` and `message` (present-but-non-string, `null` included) and refuses naming the field, before the dispatcher. `dispatchMcp` validates nothing, so this `run` was the only gate; a non-string `slug` previously travelled to `fixOrphanPage` and returned a 404 naming `[object Object]`.
- **DW-456** — `POST /api/lint/fix` passes the resolved owner's handle as `fixLintIssue`'s fifth `author` argument, so a REST lint fix is attributed to the person who made it rather than the `"lint-fix"` default. Brings it in line with `/api/lint/workbench-fix`, which already did.
- **DW-457** — `slug` is optional in both MCP schemas and in `handleFixLintIssue` (converted to `""`, the same conversion the REST door does), so `missing-concept-page` — the one type whose handler reads `message` alone — is reachable without inventing a dummy slug. It now has test coverage on both transports for the first time.

**Files changed**

- `src/mcp.ts` — one guidance handle per batch call; `handleFixLintIssue` `slug` optional with `?? ""`; stdio `fix_lint_issue` schema `slug` optional; tool description and stdio attribution comment updated.
- `src/lib/mcp-http.ts` — `slug` dropped from `required`; `optionalString` gate over the three string fields; explicit fields in place of the spread-and-cast; tool and field descriptions updated.
- `src/app/api/lint/fix/route.ts` — `principal!.handle` threaded as `author`.
- `src/lib/guidance-cache.ts` — "Scope today:" inventory extended to name the MCP batch handler.
- `src/lib/__tests__/mcp-batch-guidance-cache.test.ts` (new) — DW-395: handle identity within a call, freshness across calls, other options preserved, identity held across a mid-batch failure.
- `src/lib/__tests__/mcp-http.test.ts` — DW-455 string-field gate rows (non-string `slug`/`target`/`message`, explicit `null`, check-before-type-gate ordering, absent-field control) and DW-457 slug-less rows.
- `src/lib/__tests__/mcp.test.ts` — DW-457 rows at the handler, on the registered schema, and over a real client transport.
- `src/lib/__tests__/lint-fix-route.test.ts` — three existing call-shape assertions gained the fifth argument; new DW-456 attribution row using a distinct handle.

**Review findings breakdown.** 8 patches applied (2 medium, 6 low), 2 items deferred (both medium — generic `tools/call` argument validation across the remaining `ToolDef.run` handlers, and the `targetSlug`/`target` field-name divergence between the doors), 11 rejected.

**Follow-up review recommendation:** `true`. Patched findings only: 0 high, 2 medium, 6 low. Score = 3x2 + 1x6 = 12, which is >= 5.

**Verification.**

- `pnpm exec tsc --noEmit` — clean, exit 0.
- `pnpm lint` — clean (only the pre-existing `jsx-ast-utils` TSNonNullExpression notices).
- Targeted set (`mcp-http`, `mcp`, `lint-fix-route`, `lint-fix`, `mcp-batch-guidance-cache`, `ingest-routes`) — 6 files, **531 passed**.
- `pnpm vitest run` — 13 failed / 327 passed files, 229 failed / 7614 passed / 1 skipped. **The failure count and file set are identical to the pre-change baseline**, which I measured directly by stashing every change and re-running (13 files / 229 tests, 7592 passing). All failures are in the `|dom|` jsdom project with `TypeError: Cannot read properties of undefined (reading 'clear')` on `window.localStorage`; those files pass individually, and no component file was touched. Net +22 passing.
- Matrix test audit: all 8 I/O matrix rows are covered by named tests that ran and passed.

**Residual risks.**

- The DW-395 suite module-mocks `@/lib/ingest`, so it observes the handle being handed over, not the read count falling. The seam that adopts a caller-supplied handle (`src/lib/ingest.ts:1770`) is pinned separately against the real pipeline by `src/lib/__tests__/ingest.test.ts` ("shares a CALLER-SUPPLIED handle across two whole documents"), so the chain is covered end to end across two suites rather than in one.
- `principal!.handle` in the REST route is a non-null assertion, not a narrowing — safe because `isOwnerHandle` is false for a null/undefined handle and the 403 above has returned, but a future edit that relaxes the owner gate would need to revisit it.
- DW-456 changes who appears in a fixed page's contributor list: `"lint-fix"` is an `AUTOMATION_ACTORS` member folded into the agent by `normalizeActor`, while a real owner handle passes through. That is the point of the entry, and `/api/lint/workbench-fix` already behaved this way, but it is a visible attribution change on existing pages going forward.
- The intent's ledger entries for DW-455 and DW-457 each carry a `decision:` line about `MAX_RAW_EMAIL_BYTES` and a Cloudflare Email Routing ceiling in `workers/email-ingest/` — unrelated to their own entry bodies and absent from the bundle's `## Intent` prose. They were treated as misfiled and nothing under `workers/` was touched. Worth correcting in the ledger.
- The intent's coordinates were stale in two places: the function is `handleBatchIngest`, not `handleIngestBatch`, and DW-456's reason claims both MCP doors pass `p!.handle` when only `src/lib/mcp-http.ts` does (stdio has no principal). Neither changed the work.
