---
title: 'DW-604 / DW-605 / DW-607 — the sidecar origin contract, reachable outside the source'
type: 'feature'
created: '2026-09-03'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
baseline_revision: '9be2e2d7894ae09c5ae73b717b11a50ebb1180c9'
deferred:
  - summary: >-
      Settings and the icon rail still assert "not running" for a sidecar that is
      running but refused, so the two surfaces now contradict Chat on the same
      screen.
    evidence: |-
      `SETTINGS_API_HEALTH_UNREACHABLE_COPY`
      (src/lib/workbench-loopback-health.ts:26) is "The sidecar is not running on
      127.0.0.1:19828." and `IconRail.tsx:83` is "Sidecar not running". Both are
      decided by the same origin-blind browser fetch this change concedes cannot
      report WHY it failed: `probeLoopbackApiPane` collapses any rejected fetch —
      including the bare 403 with no `Access-Control-Allow-Origin` — to
      `unreachable`. On a deployed unconfigured origin Chat now correctly says the
      sidecar may be running and simply refused, while Settings, one panel away,
      flatly asserts it is not running; the pane's own comment
      (SettingsApiMcpPane.tsx:165) says such a claim beside a running sidecar "is
      worse than no claim at all". Pre-existing — both sentences were equally
      wrong before this change — and outside this bundle's intent, which named
      `CHAT_SIDECAR_DOWN_COPY` alone. `isSidecarDefaultAdmittedOrigin` is now
      exported and is the piece a fix would reuse. Existing pins assert the
      current sentences from loopback jsdom/e2e origins
      (settings-api-mcp-pane.test.tsx:305, icon-rail.test.tsx:163), so nothing
      currently fails.
    location: >-
      src/lib/workbench-loopback-health.ts:26
    severity: low
---

<intent-contract>

## Intent

**Problem:** The cross-origin contract DW-25 built is explicable only from source. `WORKWIKI_SIDECAR_ALLOWED_ORIGINS` appears in a JSDoc in `sidecar/server.mjs` and a module comment in `src/lib/sidecar.ts` and nowhere an operator reads (DW-604); `LOOPBACK_ORIGIN_RE` admits `127.0.0.1` and `localhost` but not `[::1]`, so a dev server on IPv6 loopback — the same machine, often the same server `localhost` already resolves to — is refused by default (DW-605); and `CHAT_SIDECAR_DOWN_COPY` tells every owner to "Start the local sidecar", including the one whose sidecar is running and whose deployed origin is simply not configured (DW-607).

**Approach:** Document the env in `.env.example` and in `DEPLOY.md`'s troubleshooting; admit `[::1]` alongside the other two loopback hostnames; and split the fail-closed Chat sentence in two, selected by a pure function of the page's own origin — the one thing the browser knows for certain about which of the two failures it can be.

## Boundaries & Constraints

**Always:**
- The loopback widening is `[::1]` ONLY — the IPv6 loopback literal, exactly as trustworthy as `127.0.0.1`. Not `::1` unbracketed, not any other IPv6 address, not `127.0.0.0/8`.
- Origin selection for the copy is EXACT: the same normalized-origin discipline the door uses, never a `startsWith`, `includes` or hostname substring.
- `sidecar/*.mjs` must not import `src/lib` (AD-6), and nothing the browser ships may import `sidecar/*.mjs`. The predicate is therefore mirrored in `src/lib/sidecar.ts` and held to the door's answer by a test that imports both.
- With nothing configured and a page on a loopback origin, the rendered sentence stays byte-identical to today's `CHAT_SIDECAR_DOWN_COPY`.
- Copy has one definition in `src/lib/workbench-modes.ts`; no sentence is inlined in a component.
- The page origin is read AFTER mount, so the server render and the first client render agree.
- Env name stays `WORKWIKI_SIDECAR_ALLOWED_ORIGINS`, already waived by the `WORKWIKI_[A-Z0-9_]*` shape in `brand-copy.test.ts`.

**Block If:**
- Distinguishing the two failures would require the probe to report WHY it failed — a browser gives `fetch` no way to tell a refused connection from a CORS refusal, and inventing one would mean a second request or a same-origin server route.

**Never:**
- Do not admit an origin because it resembles the deployment; the allowlist stays exact-match, and `Access-Control-Allow-Origin: *` stays forbidden.
- Do not change `probeSidecar`, `SIDECAR_ORIGIN`, the probe timeout, the 403 body, the PNA answer, or the gate's position ahead of every route.
- Do not add `Access-Control-Allow-Credentials` or cookies.
- Do not widen `LOOPBACK_ORIGIN_RE` beyond `[::1]`, and do not touch `src/lib/url-safety.ts` — its `::1` block is SSRF defence on a different surface and must stay a block.
- Do not touch the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| IPv6 loopback admitted | `Origin: http://[::1]:3000`, nothing configured | `GET /api/v1/health` → 200, that origin echoed, `Vary: Origin` | No error expected |
| IPv4 loopback unchanged | `Origin: http://localhost:3000` / `http://127.0.0.1:19828`, nothing configured | 200, echoed, exactly as before | No error expected |
| Lookalike still refused | `Origin: http://[::1].evil.test`, `https://evil.example`, nothing configured | 403 `{"error":"origin_not_allowed"}`, no `Access-Control-Allow-Origin` | Fails closed |
| Copy on a loopback page | page origin `http://localhost:3000`, sidecar not `up` | `CHAT_SIDECAR_DOWN_COPY`, byte-identical to today | No error expected |
| Copy on a deployed page | page origin `https://app.example`, sidecar not `up` | `CHAT_SIDECAR_UNREACHABLE_COPY` — names both causes and the env | No error expected |
| Copy before the origin is known | page origin `null` (server render, first client render) | `CHAT_SIDECAR_DOWN_COPY` — the conservative answer, no hydration mismatch | No error expected |
| Unparseable page origin | `""`, `"null"`, `"not a url"` | `CHAT_SIDECAR_DOWN_COPY` | Never throws |
| Operator looks for the knob | `.env.example`, `DEPLOY.md` | Both name `WORKWIKI_SIDECAR_ALLOWED_ORIGINS`, its comma-separated shape and a worked value | No error expected |

</intent-contract>

## Code Map

- `sidecar/server.mjs:88` — `LOOPBACK_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i`. The ONE edit here: add the bracketed IPv6 loopback literal as a third alternative (escape the brackets). `allowSidecarOrigin(origin, allowedOrigins = [])` (~line 258) tests it first and is otherwise untouched; `normalizeOrigin` (~line 205) already returns `http://[::1]:3000` unchanged for that input, so `cors` echoes it correctly with no further change.
- `src/lib/sidecar.ts` — the contract prose. Lines 23–27 currently assert IPv6 loopback is NOT admitted; that sentence is now wrong and must be rewritten. This file gains the mirrored predicate (see Design Notes). 106 lines today; `probeSidecar` (line ~63) is read-only.
- `src/lib/workbench-modes.ts:76–81` — `CHAT_SIDECAR_DOWN_COPY`, unchanged in value. The new sibling constant and the selector go beside it, above `CHAT_COVERAGE_MISSING_COPY`.
- `src/components/workbench/ModeCanvas.tsx:5, 272` — imports `CHAT_SIDECAR_DOWN_COPY` and renders it in the `sidecar !== "up"` chat branch. Already `"use client"` (line 1) and already uses hooks (`useLayoutEffect`, line 3).
- `.env.example` — 150 lines of `# --- Section ---` blocks with commented-out `KEY=value` lines; the tail (PostHog, line 143) is where a new `# --- Local sidecar (optional) ---` block goes. Scanned by `brand-copy.test.ts` (`SOURCE_TEXT`, line ~299 names it explicitly).
- `DEPLOY.md` — `## Troubleshooting` at line 723 holds three `###` symptom entries. A fourth goes there. `read-only-copy-parity.test.ts:650` and `workbench-settings.test.ts:6240` already pin quoted DEPLOY.md copy against constants — the precedent for the doc pin below. Read-only otherwise.
- `src/lib/__tests__/sidecar.test.ts` — the DW-25 suite. `sidecarHarness`/`settingsSource` come from `./sidecar-harness` (the shared `listen()`, DW-606); `describe("sidecar cross-origin contract (DW-25)")` at line 122 owns the env save/restore and `listen(allowedOrigins?)`; `describe("allowSidecarOrigin with a configured list")` at line 463 holds the pure pins.
- `src/lib/__tests__/workbench-modes.test.ts:96–99` — the fail-closed sentence pin; extend, do not replace.
- `src/lib/__tests__/workbench-chrome.test.ts:319, 330` and `src/lib/__tests__/workbench-epic3.test.ts:297` — three source scans asserting `ModeCanvas.tsx` contains the literal `CHAT_SIDECAR_DOWN_COPY`. They break when the component switches to the selector; retarget them to the selector name so the "no inlined sentence" claim survives.
- `src/lib/__tests__/workbench-epic3.test.ts:407–413` — the one-argument `allowSidecarOrigin` pins. Read-only; they must keep passing.
- `src/components/workbench/__tests__/` — dom project (`.test.tsx`). No file mounts `ModeCanvas` directly today; the new one does. Per-file jsdom origin is available via a `@vitest-environment-options { "url": "…" }` docblock (verified against this repo's vitest 3.2.4).
- `src/lib/url-safety.ts:22, 63` — blocks `::1` for SSRF. Different surface, opposite direction. Read-only.

## Tasks & Acceptance

**Execution:**
- `sidecar/server.mjs` -- add the bracketed IPv6 loopback literal as a third alternative in `LOOPBACK_ORIGIN_RE`, with a comment saying why it belongs with the other two (same machine, same "potentially trustworthy" carve-out, and `localhost` frequently resolves to it already) and why the widening stops there -- a dev server on IPv6 loopback is refused today for no reason the contract can defend.
- `src/lib/sidecar.ts` -- rewrite the now-false IPv6 sentence in cause 1 of the contract comment, and export a pure `isSidecarDefaultAdmittedOrigin(origin)` that answers whether an origin is admitted with NO configuration, documented as the browser-side mirror of `LOOPBACK_ORIGIN_RE` and as the only thing the browser can know about which failure it is looking at -- the contract file is where the door's rule is explained, so the mirror belongs beside the prose it mirrors.
- `src/lib/workbench-modes.ts` -- add `CHAT_SIDECAR_UNREACHABLE_COPY` naming BOTH causes and `WORKWIKI_SIDECAR_ALLOWED_ORIGINS`, and a pure `chatSidecarDownCopy(pageOrigin: string | null | undefined)` returning it only for an origin the door does not admit by default, `CHAT_SIDECAR_DOWN_COPY` otherwise -- an owner whose sidecar is already running must not be told to start it, and an unknown origin must degrade to the sentence that is true more often.
- `src/components/workbench/ModeCanvas.tsx` -- hold the page origin in state, set from `window.location.origin` in a mount effect, and render `chatSidecarDownCopy(pageOrigin)` in the chat fail-closed branch -- reading during render would make the server's `null` and the client's real origin disagree at hydration.
- `.env.example` -- add a `# --- Local sidecar (optional) ---` block documenting `WORKWIKI_SIDECAR_ALLOWED_ORIGINS`: what it admits, that loopback needs no entry, the comma-separated bare-origin shape, that a bad entry is dropped rather than fatal, and that naming an origin exposes every `/api/v1` route behind the loopback token, not just health -- this is the file an operator greps for env names.
- `DEPLOY.md` -- add a `### Chat says the sidecar is down` entry under `## Troubleshooting` covering the three causes in `src/lib/sidecar.ts`'s order, with the env line to set and the note that Safari cannot be fixed by configuration -- the symptom is what the owner arrives with.
- `src/lib/__tests__/sidecar.test.ts` -- pin (a) a bound sidecar admitting `http://[::1]:3000` with nothing configured and echoing it, (b) `[::1]`-lookalikes still refused, (c) `isSidecarDefaultAdmittedOrigin` agreeing with one-argument `allowSidecarOrigin` over a shared table of loopback, IPv6, deployed, malformed and `"null"` origins, and (d) `.env.example` and `DEPLOY.md` both containing `SIDECAR_ALLOWED_ORIGINS_ENV` read from the module -- (c) is what stops the two definitions drifting and (d) is what stops a rename stranding the operator docs.
- `src/lib/__tests__/workbench-modes.test.ts` -- extend the fail-closed pin: `CHAT_SIDECAR_DOWN_COPY` unchanged, `CHAT_SIDECAR_UNREACHABLE_COPY` names the port and the env, and `chatSidecarDownCopy` returns the right sentence for every row of the copy half of the I/O matrix -- the selector is a pure rule, so it is executed here rather than argued from a mount.
- `src/components/workbench/__tests__/sidecar-down-copy.test.tsx` -- new dom suite with a `@vitest-environment-options { "url": "https://app.example/" }` docblock; mount `ModeCanvas` with `mode="chat"` and a non-`up` sidecar and assert the unreachable sentence renders and the "Start the local sidecar" sentence does not -- reading the REAL `window.location.origin` is the only way to see that the component is wired to the selector rather than to a constant.
- `src/lib/__tests__/workbench-chrome.test.ts`, `src/lib/__tests__/workbench-epic3.test.ts` -- retarget the three `ModeCanvas.tsx` source pins from `CHAT_SIDECAR_DOWN_COPY` to `chatSidecarDownCopy`, and add a `not.toContain("Start the local sidecar")` so the pins still say what they were there to say -- the claim is that no sentence is typed in the component, and the selector is now how that is satisfied.

**Acceptance Criteria:**
- Given a sidecar with nothing configured, when the one-argument `allowSidecarOrigin` pins in `workbench-epic3.test.ts` and the 403 pin in `epic8-remediation.test.ts` run, then they pass unchanged.
- Given an owner on a deployed HTTPS page whose sidecar is running but whose origin is unconfigured, when Chat fails closed, then the sentence on screen does not tell them to start a process that is already running, and it names the env that would admit them.
- Given an operator who has only the repository and a page reporting the sidecar down, when they read `.env.example` and `DEPLOY.md`, then they can learn the knob exists, its shape, and the one failure no configuration can fix, without opening `sidecar/server.mjs` or `src/lib/sidecar.ts`.
- Given the whole change, when `pnpm test` and `pnpm exec tsc --noEmit` run, then there are no new failures and no type errors.

## Spec Change Log

## Review Triage Log

### 2026-09-03 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 0, low 7)
- defer: 1: (high 0, medium 0, low 1)
- reject: 4: (high 0, medium 0, low 4)
- addressed_findings:
  - `[low]` `[patch]` `sidecar/server.mjs` — `allowSidecarOrigin`'s docblock still claimed "`LOOPBACK_ORIGIN_RE` is untouched" directly under the regex this change widened. Reworded to keep its point (the two tests stay separate; a deployed page is admitted by being NAMED) without the false claim.
  - `[low]` `[patch]` `src/lib/sidecar.ts` — the mirror trims and the door does not, an undocumented second divergence. Kept the trim, and named both divergences (`""` and padding) in the docblock with the reason each side reads a different kind of value.
  - `[low]` `[patch]` `src/lib/__tests__/sidecar.test.ts` — the parity suite claimed "one table, both sides" while enumerating only `""`. Added a padded row and replaced the ad-hoc branch with an enumerated `DIVERGENT` map of `{door, mirror}` answers, so an unlisted disagreement is a drift rather than an exemption.
  - `[low]` `[patch]` `src/lib/__tests__/workbench-chrome.test.ts`, `src/lib/__tests__/workbench-epic3.test.ts` — the three retargeted pins banned only the OLD sentence, so `CHAT_SIDECAR_UNREACHABLE_COPY` could have been inlined with all three green. Each now also refuses `WORKWIKI_SIDECAR_ALLOWED_ORIGINS` in the component.
  - `[low]` `[patch]` `src/lib/__tests__/workbench-chrome.test.ts` — nothing caught a hardcoded or omitted page origin, which still passes the deployed-origin mount while giving every loopback page the wrong sentence. The "fails Chat closed" pin now requires `window.location.origin` in `ModeCanvas.tsx` and names that regression.
  - `[low]` `[patch]` `.env.example` — the file header directs values to `.env.local` / `.dev.vars` / Worker vars, none of which reach the sidecar. The new block now opens by saying it is read by the sidecar PROCESS from the repo root's `.env`/`.env.local` (shell wins), and that a Worker secret or var does nothing.
  - `[low]` `[patch]` `DEPLOY.md` — the section told the reader to confirm "the process is actually running" without naming it. It now names `sidecar/server.mjs` / `pnpm sidecar`, says it runs on the owner's host machine rather than the container or Worker, and explains why the variable is linked to rather than added to `### Additional Settings`.

## Design Notes

The browser cannot ask `fetch` why it failed — a refused connection and a CORS refusal are the same rejected promise — so the copy is selected by the one fact the page holds for free: its OWN origin. On an origin the door admits with no configuration, `down` can only mean nothing answered. On any other origin it is genuinely ambiguous, and the honest sentence says both.

The mirror in `src/lib/sidecar.ts` is a duplication of `LOOPBACK_ORIGIN_RE`, and deliberately so: AD-6 forbids the sidecar importing `src/lib`, and the browser bundle must not import `sidecar/*.mjs`. What keeps them together is the parity test, not a shared module.

```ts
const DEFAULT_ADMITTED_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

export function isSidecarDefaultAdmittedOrigin(origin: string | null | undefined): boolean {
  return typeof origin === "string" && DEFAULT_ADMITTED_ORIGIN_RE.test(origin.trim());
}
```

Anchored at both ends, so `http://[::1].evil.test` and `https://localhost.evil.test` fail — the same reason the door compares normalized origins rather than substrings.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/sidecar.test.ts src/lib/__tests__/workbench-modes.test.ts src/lib/__tests__/workbench-chrome.test.ts src/lib/__tests__/workbench-epic3.test.ts src/lib/__tests__/epic8-remediation.test.ts src/lib/__tests__/brand-copy.test.ts` -- expected: all pass, including the new IPv6, parity and doc pins, with the pre-existing one-argument and 403 pins untouched.
- `pnpm exec vitest run --project dom src/components/workbench/__tests__/sidecar-down-copy.test.tsx` -- expected: the deployed-origin mount renders the unreachable sentence.
- `pnpm test` -- expected: no NEW failures against the `9be2e2d7` baseline. Confirm the `dom` project is green before and after; it was reported red on 2026-08-29 for an unrelated `localStorage` reason and is green again at this baseline (`workbench-mode-url.test.tsx`, 21/21 on 2026-09-03).
- `pnpm exec tsc --noEmit` -- expected: no type errors.
- `pnpm exec eslint src/lib/sidecar.ts src/lib/workbench-modes.ts src/components/workbench/ModeCanvas.tsx` -- expected: clean.

## Auto Run Result

Status: done
Blocking condition: none

### Summary

The cross-origin contract DW-25 built is now reachable without opening a source file. `WORKWIKI_SIDECAR_ALLOWED_ORIGINS` is documented in the two places an operator actually looks, and both say the thing the file headers around them get wrong: the value is read by the sidecar PROCESS on the owner's machine, not by the Worker. The door admits `[::1]` alongside `localhost` and `127.0.0.1` — the same machine, the same Secure Contexts carve-out, and the address `localhost` frequently resolves to already — while staying anchored, so `http://[::1].evil.test` is still refused. And Chat's fail-closed sentence is now chosen by the page's own origin: on a page the door admits with nothing configured, `down` can only mean nothing answered and the old sentence is still exactly right; anywhere else the sidecar may be running and simply refused, so the sentence says both and names the knob. Nothing about a remote origin got easier, and loopback behaviour with nothing configured is byte-identical.

### Files changed

- [sidecar/server.mjs](../../sidecar/server.mjs) — `LOOPBACK_ORIGIN_RE` gained `\[::1\]` as a third anchored alternative (DW-605), with a docblock on why it belongs beside the other two and where the widening stops. `allowSidecarOrigin`, `normalizeOrigin`, `cors`, the 403 body and the PNA answer are unchanged.
- [src/lib/sidecar.ts](../../src/lib/sidecar.ts) — rewrote the now-false cause-1 sentence; added the exported pure `isSidecarDefaultAdmittedOrigin`, documented as the deliberate browser-side mirror of the door's regex (AD-6 forbids a shared module) with its two enumerated divergences.
- [src/lib/workbench-modes.ts](../../src/lib/workbench-modes.ts) — `CHAT_SIDECAR_DOWN_COPY` unchanged in value; new `CHAT_SIDECAR_UNREACHABLE_COPY` and the pure `chatSidecarDownCopy(pageOrigin)`, which degrades to the shorter sentence for an absent or unparseable origin.
- [src/components/workbench/ModeCanvas.tsx](../../src/components/workbench/ModeCanvas.tsx) — holds the page origin in state, set from `window.location.origin` after mount so the server render and the first client render agree, and renders the selector's answer.
- [.env.example](../../.env.example) — new `# --- Local sidecar (optional) ---` block (DW-604): what is admitted with nothing set, the comma-separated bare-origin shape, that a bad entry is dropped rather than fatal, that naming an origin opens every `/api/v1` route, and where the value must actually live.
- [DEPLOY.md](../../DEPLOY.md) — new `### Chat says the sidecar is down` under Troubleshooting: what the sidecar is and how to start it, then the three causes in the contract's own order, with the one no configuration can fix marked as such.
- [src/lib/\_\_tests\_\_/sidecar.test.ts](../../src/lib/__tests__/sidecar.test.ts) — a bound sidecar admitting and echoing `http://[::1]:3000`; lookalikes still 403 bare; a 20-row parity suite running the mirror against one-argument `allowSidecarOrigin` with the two intended divergences enumerated; and doc pins reading the env name from the module.
- [src/lib/\_\_tests\_\_/workbench-modes.test.ts](../../src/lib/__tests__/workbench-modes.test.ts) — the copy half of the I/O matrix, executed as a pure rule.
- [src/components/workbench/\_\_tests\_\_/sidecar-down-copy.test.tsx](../../src/components/workbench/__tests__/sidecar-down-copy.test.tsx) — new dom suite running at a deployed jsdom origin, so `ModeCanvas` reads a REAL `window.location.origin` rather than a value a test handed it.
- [src/lib/\_\_tests\_\_/workbench-chrome.test.ts](../../src/lib/__tests__/workbench-chrome.test.ts), [src/lib/\_\_tests\_\_/workbench-epic3.test.ts](../../src/lib/__tests__/workbench-epic3.test.ts) — three source pins retargeted to the selector, each now refusing BOTH sentences in the component, plus the `window.location.origin` wiring pin.

### Review findings breakdown

- Patches applied: 7 (high 0, medium 0, low 7).
- Items deferred: 1 (low) — see frontmatter `deferred`.
- Items rejected: 4 — an uncompressed IPv6 origin (`http://[0:0:0:0:0:0:0:1]:3000`) that no browser ever serializes; naming Safari's mixed-content block in the one-line empty state (DEPLOY.md carries all three causes, and the intent asked for two states); the pre-probe `unknown` state rendering an assertive sentence (unchanged by this diff, and the rail already reasons the other way); and a load-sensitive budget assertion in `workbench-intake.test.ts` that passed in both full runs here.
- Follow-up review recommended: **false**. Patched severities: high 0, medium 0, low 7 → no high-severity patch, so no further iteration.

### Verification performed

- `pnpm exec vitest run --project node` over sidecar + workbench-modes + workbench-chrome + workbench-epic3 + epic8-remediation + brand-copy — 211 passed. The pre-existing one-argument `allowSidecarOrigin` pins, the existing 403 pin and the brand scan all pass unchanged.
- `pnpm exec vitest run --project dom src/components/workbench/__tests__/sidecar-down-copy.test.tsx` — 4 passed.
- `pnpm test` — 375 files, 9387 passed, 1 skipped, 0 failed. Run before and after the review patches with the same result; the `dom` project is green at this baseline, so the red-`dom` note carried in the DW-25 spec no longer applies.
- `pnpm exec tsc --noEmit` — clean. `pnpm exec eslint` over the four changed TypeScript files — clean.
- Matrix audit: all eight I/O rows are covered by tests that ran and passed — the three door rows in `sidecar.test.ts`, the four copy rows in `workbench-modes.test.ts` (with the deployed row also mounted in `sidecar-down-copy.test.tsx`), and the operator-docs row by the `.env.example` / `DEPLOY.md` pins.

### Residual risks

- **Node's `fetch` is not a CORS or PNA agent**, unchanged from DW-25. The `[::1]` pin proves the sidecar admits and echoes that origin; only a real browser can prove the handshake completes.
- **The copy distinguishes a fact about the PAGE, not about the sidecar.** That is the only distinction available — `fetch` reports a refused connection and a CORS refusal identically — but it means a loopback page whose failure is a wedged process still reads "Start the local sidecar", and a correctly-allowlisted deployed page blocked by Safari or a Chrome Local Network Access prompt is told to add an origin it already added. `DEPLOY.md` is where that reader is sent.
- **Two other surfaces still speak the old, origin-blind sentence** — the Settings API + MCP health note and the rail's status label. They are pre-existing and outside this bundle's named scope; recorded in frontmatter `deferred`.
- **The mirror in `src/lib/sidecar.ts` is a second copy of the door's regex.** Only the parity suite keeps them together; a change to one that skips `pnpm test` would ship a disagreement no type checker can see.
