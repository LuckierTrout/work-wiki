---
title: 'DW-25 — sidecar cross-origin contract for a deployed HTTPS page'
type: 'feature'
created: '2026-08-29'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
baseline_revision: '19ec07f7cde10162f0eba3c06144fa78cdc14a8a'
deferred:
  - summary: >-
      No operator-facing surface documents WORKWIKI_SIDECAR_ALLOWED_ORIGINS, so an
      owner whose deployed page reports down has nowhere outside the source to
      learn the knob exists.
    evidence: |-
      The env is described only in a JSDoc in sidecar/server.mjs and the module
      comment in src/lib/sidecar.ts. `.env.example` and DEPLOY.md carry no sidecar
      variables at all, so there is no existing convention this change skipped —
      but the whole point of DW-25 is explainability to the owner, and the two
      places it is explained are both source files.
    location: >-
      .env.example
    severity: low
  - summary: >-
      LOOPBACK_ORIGIN_RE admits only 127.0.0.1 and localhost, so a dev server on
      IPv6 loopback (http://[::1]:3000) is refused with no configuration.
    evidence: |-
      sidecar/server.mjs:88 is `^https?://(127\.0\.0\.1|localhost)(:\d+)?$`.
      Pre-existing since Epic 3 and deliberately untouched here (the intent forbids
      widening the regex); the new contract prose now states the limit explicitly
      rather than fixing it.
    location: >-
      sidecar/server.mjs:88
    severity: low
  - summary: >-
      The `listen()` test harness is now duplicated in three suites, which will
      drift.
    evidence: |-
      Near-verbatim copies live in src/lib/__tests__/sidecar.test.ts,
      src/lib/__tests__/workbench-epic8.test.ts and
      src/lib/__tests__/epic8-remediation.test.ts, `as never` casts included.
      AGENTS.md's test-infra conventions call for one shared helper per concern
      (the DW-117 precedent for `walkFiles`); extracting one is a separate change
      touching three suites.
    location: >-
      src/lib/__tests__/sidecar.test.ts
    severity: low
  - summary: >-
      An owner on an unconfigured deployed origin still sees "Start the local
      sidecar..." for a sidecar that is running — the product copy cannot
      distinguish "not running" from "running but unreachable from this origin".
    evidence: |-
      CHAT_SIDECAR_DOWN_COPY (src/lib/workbench-modes.ts:81) is unchanged and
      useSidecarStatus still collapses every failure into "down". This change makes
      that state configurable away and explicable to a reader of the source, but
      not to the owner in the product. The recorded 2026-08-28 decision names only
      sidecar/server.mjs, src/lib/sidecar.ts and the pins, so distinguishing the
      two states in copy is beyond it.
    location: >-
      src/lib/workbench-modes.ts:81
    severity: medium
---

<intent-contract>

## Intent

**Problem:** `allowSidecarOrigin` (`sidecar/server.mjs`) admits only origins matching `LOOPBACK_ORIGIN_RE`, so a browser on a deployed HTTPS page is refused at the door, the probe answers `down` forever, and Chat tells the owner to "Start the local sidecar on 127.0.0.1:19828 to use Chat." while the sidecar is already running. Nothing anywhere states the cross-origin contract an HTTPS page must satisfy to reach `http://127.0.0.1:19828`, so the failure is unexplainable from the copy.

**Approach:** Per the recorded 2026-08-28 decision, add a configured allowed-origin list to `sidecar/server.mjs` alongside the loopback default, answer Chrome's Private Network Access preflight for an allowed origin, and write the full response contract — CORS headers, PNA, Safari mixed-content — into `src/lib/sidecar.ts` beside the fail-closed note it already carries. Pin in tests that a non-loopback CONFIGURED origin passes the probe while an unconfigured one still fails closed.

## Boundaries & Constraints

**Always:**
- Loopback stays admitted with no configuration: an empty/absent allowed-origin list must behave exactly as today.
- Still an ALLOWLIST that echoes the request's own origin — never `Access-Control-Allow-Origin: *`, and never a wildcard or suffix match in the configured list.
- Fail closed: an origin that is neither loopback nor configured gets `403 {"error":"origin_not_allowed"}` with no `Access-Control-Allow-Origin` and no PNA header.
- The list is parsed by a pure function that ignores malformed entries rather than throwing; a bad env value must never stop the sidecar from binding.
- The configured list is read at server construction, not at module load — `loadSidecarEnvFromFiles` runs after import, so a top-level read would miss `.env`/`.env.local`.
- `sidecar/*.mjs` must not import `src/lib` (AD-6); the contract prose lives in `src/lib/sidecar.ts` and is duplicated nowhere as code.
- Env name stays in the frozen `WORKWIKI_*` family (already waived by the `WORKWIKI_[A-Z0-9_]*` shape in `brand-copy.test.ts`).

**Block If:**
- Making this work would require the sidecar to serve HTTPS, mint a certificate, or bind anything other than `127.0.0.1:19828`.

**Never:**
- Do not add `Access-Control-Allow-Credentials`, cookies, or any credentialed mode — the loopback token travels in a header.
- Do not widen `LOOPBACK_ORIGIN_RE` itself, and do not admit an origin because it "looks like" the deployment.
- Do not change `probeSidecar`, `SIDECAR_ORIGIN`, the probe timeout, or the Chat fail-closed copy.
- Do not attempt to defeat Safari/Firefox mixed-content blocking — document it as a known limit of the contract.
- Do not touch the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Loopback unchanged | `Origin: http://localhost:3000`, no configured list | `GET /api/v1/health` → 200, `Access-Control-Allow-Origin: http://localhost:3000`, `Vary: Origin` | No error expected |
| No Origin header | `curl` with no `Origin` | Admitted as today; no `Access-Control-Allow-Origin` echoed | No error expected |
| Configured deployed origin | `Origin: https://app.example`, list `["https://app.example"]` | `GET /api/v1/health` → 200 with the origin echoed — the probe answers `up` | No error expected |
| Unconfigured deployed origin | `Origin: https://app.example`, empty list | 403 `{"error":"origin_not_allowed"}`, no `Access-Control-Allow-Origin` | Fails closed; probe answers `down` |
| PNA preflight, allowed | `OPTIONS` + `Access-Control-Request-Private-Network: true`, configured origin | 204 with `Access-Control-Allow-Private-Network: true`, echoed origin, methods and headers | No error expected |
| PNA preflight, refused | Same preflight from an unconfigured origin | 403 `origin_not_allowed`, no PNA header | Fails closed before CORS |
| Preflight without PNA request | `OPTIONS`, allowed origin, no PNA request header | 204 with CORS headers and NO `Access-Control-Allow-Private-Network` | No error expected |
| Malformed configuration | `"*, https://a.example/path, ftp://x, HTTPS://B.Example:443/, , https://b.example"` | Wildcard, pathful, non-http(s) and empty entries dropped; `https://b.example` admitted once (case/trailing-slash normalized, deduped) | Invalid entries ignored, never thrown |

</intent-contract>

## Code Map

- `sidecar/server.mjs` — the HTTP shell. `LOOPBACK_ORIGIN_RE` (~line 88); `allowSidecarOrigin(origin)` (~line 156) exported and unit-tested one-arg; `cors(req, res)` (~line 175) sets `Access-Control-Allow-Origin`/`Vary`/methods/headers; `createSidecarServer({...})` (~line 320) does the 403 origin refusal (~line 347) and the `OPTIONS` 204 (~line 356) BEFORE health, load gate and token gate — that order is the contract and must not move. `productionWikiRegistry` (~line 296) shows the `env` -> option wiring convention; `isMain` block calls `loadSidecarEnvFromFiles` before `createSidecarServer`.
- `sidecar/loopback.mjs` — `parseWikiRoots` (line 577) is the parse-a-comma-separated-env convention to mirror: skip bad entries, never throw. `LOOPBACK_TOKEN_HEADER` is re-used by `cors`. Pure rules live here, but DW-25's decision names `server.mjs` as the home for the origin list — keep it there beside `allowSidecarOrigin`.
- `src/lib/sidecar.ts` — 106 lines; the loopback-contract doc comment (lines 1–13) and `probeSidecar` (line 63) whose `catch` already treats CORS failure as `down`. This is where the response contract prose goes. Read-only for behaviour: no probe change.
- `src/lib/__tests__/sidecar.test.ts` — Story 1.3 fail-closed suite, `node` project. New cross-origin describe block lands here.
- `src/lib/__tests__/epic8-remediation.test.ts` — `listen()` helper (lines 94–119) is the pattern for booting `createSidecarServer` on port 0 with a stub settings source; its "rejects a disallowed Origin" test (line 601) is the existing 403 pin. Read-only.
- `src/lib/__tests__/workbench-epic3.test.ts` — line 409 calls `allowSidecarOrigin` with ONE argument for loopback/evil cases. Read-only: the new signature must keep those four assertions passing.
- `src/lib/workbench-modes.ts:81` — the "Start the local sidecar…" copy the DW cites. Read-only.
- `src/lib/__tests__/brand-copy.test.ts:486` — `WORKWIKI_IDENTIFIER_ALLOWLIST` already waives `WORKWIKI_[A-Z0-9_]*`, so a new env name needs no allowlist edit. Read-only.

## Tasks & Acceptance

**Execution:**
- `sidecar/server.mjs` -- add `SIDECAR_ALLOWED_ORIGINS_ENV = "WORKWIKI_SIDECAR_ALLOWED_ORIGINS"` and an exported pure `parseSidecarAllowedOrigins(value)` that splits on commas, trims, normalizes each entry through `new URL()` to a bare `scheme://host[:port]` origin, keeps only `http:`/`https:` entries with no path/query/credentials, rejects any entry containing `*`, dedupes, and returns `[]` for absent/garbage input -- a configured deployment origin must be admissible without widening the loopback regex, and a bad env value must not stop the bind.
- `sidecar/server.mjs` -- widen `allowSidecarOrigin(origin, allowedOrigins = [])` so loopback still passes on the default and a normalized member of `allowedOrigins` also passes; thread an `allowedOrigins = parseSidecarAllowedOrigins(process.env[SIDECAR_ALLOWED_ORIGINS_ENV])` option through `createSidecarServer` into both the 403 refusal and `cors(req, res, allowedOrigins)` -- the default-arg keeps the existing one-arg call sites honest while the server gets the configured list, and evaluating the default at construction time picks up `.env` loaded after import.
- `sidecar/server.mjs` -- in `cors`, set `Vary: Origin` unconditionally and add `Access-Control-Max-Age`; in the `OPTIONS` branch, echo `Access-Control-Allow-Private-Network: true` when the request carries `access-control-request-private-network: true` and the origin was admitted -- Chrome forces a public-to-private preflight for the health GET, and a preflight without that header fails the request before the route is ever reached.
- `src/lib/sidecar.ts` -- extend the header doc comment with the full response contract beside the fail-closed note: the CORS headers the sidecar must return (echoed `Access-Control-Allow-Origin`, `Vary: Origin`, allowed methods/headers, never `*`), Chrome's PNA preflight and its `Access-Control-Allow-Private-Network: true` answer, the env that configures a non-loopback origin, and Safari/Firefox mixed-content blocking of an `http://127.0.0.1` subresource from an HTTPS page — which makes `down` the honest answer there no matter what the sidecar returns -- so the probe's permanent `down` is explainable from the one file that owns the contract.
- `src/lib/__tests__/sidecar.test.ts` -- add a `describe` covering every row of the I/O matrix: boot `createSidecarServer` on port 0 with an injected `allowedOrigins`, assert 200 + echoed origin for a configured non-loopback origin, 403 `origin_not_allowed` with no `Access-Control-Allow-Origin` for an unconfigured one, the PNA preflight answers, and the `parseSidecarAllowedOrigins` normalization/rejection cases -- this is the pin the decision asks for.

**Acceptance Criteria:**
- Given a sidecar built with no configured origins, when the existing loopback and `https://evil.example` assertions in `workbench-epic3.test.ts` and the 403 test in `epic8-remediation.test.ts` run, then they pass unchanged.
- Given a sidecar whose configured list contains a deployed HTTPS origin, when a browser on that origin runs the Story 1.3 probe against `/api/v1/health`, then the request is admitted with that origin echoed and the rail can report `up`.
- Given `src/lib/sidecar.ts`, when a reader asks why a deployed page's probe reports `down`, then the file names the three causes — origin not configured, unanswered PNA preflight, mixed-content block — without the reader opening `sidecar/server.mjs`.
- Given the whole change, when `pnpm test` runs, then the suite passes with no new failures.

## Design Notes

Origin normalization is what keeps the allowlist an allowlist. Compare normalized origin strings, never substrings:

```js
function normalizeOrigin(value) {
  try {
    const url = new URL(String(value).trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}
```

`https://app.example.evil.test` must not match `https://app.example`, which a `startsWith`/`includes` check would let through.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/sidecar.test.ts` -- expected: all tests pass, including the new cross-origin describe.
- `pnpm exec vitest run --project node src/lib/__tests__/workbench-epic3.test.ts src/lib/__tests__/epic8-remediation.test.ts src/lib/__tests__/brand-copy.test.ts` -- expected: pass, proving the widened signature and the new env name broke neither the existing origin pins nor the brand scan.
- `pnpm test` -- expected: no NEW failures. Recorded 2026-08-29: the `dom` project fails 233 tests across 13 `.test.tsx` files with `TypeError: Cannot read properties of undefined (reading 'clear')` on `window.localStorage`. This is PRE-EXISTING and unrelated — reproduced identically at baseline `19ec07f7` with all three DW-25 edits stashed (`workbench-split-wiring.test.tsx`, 29/29 failing either way). The `node` project, where every line this spec touches runs, is green: 7062 passed, 1 skipped.
- `pnpm exec tsc --noEmit` -- expected: no type errors.

## Auto Run Result

Status: done
Blocking condition: none

### Summary

The sidecar door now admits a NAMED non-loopback origin alongside the loopback default, answers Chrome's Private Network Access preflight for it, and `src/lib/sidecar.ts` carries the full response contract beside the fail-closed note it already had. Loopback behaviour with nothing configured is byte-identical to before. The allowlist is exact-match on a normalized origin — never a wildcard, a suffix, or `*` — so `https://app.example.evil.test` is refused however much it resembles a configured entry, and an unconfigured origin still gets a bare `403 origin_not_allowed` with no CORS or PNA headers.

### Files changed

- [sidecar/server.mjs](../../sidecar/server.mjs) — `SIDECAR_ALLOWED_ORIGINS_ENV`, `normalizeOrigin`, the pure `parseSidecarAllowedOrigins`, a widened `allowSidecarOrigin(origin, allowedOrigins)`, an `allowedOrigins` option on `createSidecarServer` normalized once at construction, `Vary: Origin` on both the echo and the 403, preflight-only `Access-Control-Max-Age`, the PNA answer, and startup reporting of dropped entries and the effective allowlist.
- [src/lib/sidecar.ts](../../src/lib/sidecar.ts) — doc comment only. The three causes of a permanent `down` (origin not configured, unanswered PNA preflight, Safari mixed-content block), the exact CORS headers, the env name, the blast radius of naming an origin, the `http://` downgrade risk, the revocation lag, and the no-`Origin` case. No behaviour change.
- [src/lib/__tests__/sidecar.test.ts](../../src/lib/__tests__/sidecar.test.ts) — 35 tests (was 8): every I/O-matrix row, the env wiring, the token gate behind an admitted origin, `probeSidecar` against a real bound server, and the parse normalization/rejection/dedupe cases.

### Review findings breakdown

- Patches applied: 21 (medium 7, low 14).
- Items deferred: 4 (medium 1, low 3) — see frontmatter `deferred`.
- Items rejected: 2 (a `Host`-header DNS-rebinding check, already covered for browsers by the Origin gate; and a duplicate-assertion complaint about the deliberate one-argument `allowSidecarOrigin` pin).
- Follow-up review recommended: **true**. Patched severities: high 0, medium 7, low 14 → score `3 x 7 + 1 x 14 = 35`, which is at or above the threshold of 5.

### Verification performed

- `pnpm exec vitest run --project node src/lib/__tests__/sidecar.test.ts` — 35 passed.
- `pnpm exec vitest run --project node` over sidecar + workbench-epic3 + epic8-remediation + brand-copy — 149 passed; the pre-existing one-argument `allowSidecarOrigin` pins, the existing 403 pin, and the brand scan all pass unchanged.
- `pnpm exec vitest run --project node` (whole node project) — 282 files, 7071 passed, 1 skipped.
- `pnpm exec tsc --noEmit` — clean.
- Mutation checks on the four findings whose original complaint was "a reviewer reverted this and the suite stayed green" (env constant renamed, `Vary` made conditional, raw origin echoed, max-age moved back into `cors()`) — each now fails at least one assertion.
- `pnpm test` — 233 failures, all in the `dom` project, all `TypeError: Cannot read properties of undefined (reading 'clear')` on `window.localStorage`. PRE-EXISTING and unrelated: reproduced identically at baseline `19ec07f7` with all three DW-25 edits stashed (`workbench-split-wiring.test.tsx`, 29/29 failing either way). Not touched here.

### Residual risks

- **Node's `fetch` is not a CORS or PNA agent.** The tests prove the sidecar EMITS the right headers; they cannot prove a browser accepts the handshake. Items 1 and 2 of the documented contract are enforced only by real engines, and item 3 (mixed content) is untestable at any surface this change touches. The `e2e/` Playwright suite is where that would be witnessed, and it is not extended here.
- **The `dom` project is red for an unrelated reason** across the whole repository, so `pnpm test` cannot currently be used as a single green gate by anything downstream.
- **Chrome's PNA story is moving.** The header pair answered here is the header-based design; a Local Network Access permission prompt may additionally gate public-to-local requests in a future Chrome, which no response header can satisfy. The doc comment says so, but the claim will need re-verifying against a real browser before an operator relies on it.
