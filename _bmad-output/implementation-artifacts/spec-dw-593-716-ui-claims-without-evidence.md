---
title: 'UI claims without evidence: cascade-deleted Source chip and the unanswered Skill scan'
type: 'bugfix'
created: '2026-09-04'
status: 'in-review'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
baseline_revision: 'dfad5121d54c76007e1823fe35906290117e9e74'
---

<intent-contract>

## Intent

**Problem:** Two surfaces state as fact something their probe never established. `ActionInbox` never reads `ActionItem.sourceMissing` — set by `markSourceMissing` when the cited Source was cascade-deleted — so a to-do still renders a live `source · <slug>` link into a page that is gone (DW-593). `probeLoopbackApiPane` swallows a failed Skills scan into `skills: []`, and `SettingsApiMcpPane` appends `${skills.length} Skills on disk.` to whichever health sentence it chose, so a wiki whose sidecar is not started reads "The sidecar is not running on 127.0.0.1:19828. 0 Skills on disk." — the count is "the scan did not answer", not zero (DW-716).

**Approach:** Make each surface say only what its data supports. `ActionInbox` renders the cited slug as a plain, non-navigating receipt that names the source as missing when `item.sourceMissing` is set, and keeps the link otherwise. `probeLoopbackApiPane` returns `skills: null` for a scan that did not answer (rejected, non-OK, or unparseable) and an array only for one that did; the pane renders the count through one exhaustive sentence builder beside `loopbackHealthSentence`, which has its own sentence for the unknown case. This is the same false-claim class DW-633 fixed for the health sentence alone.

## Boundaries & Constraints

**Always:**
- A cascade-deleted Source is named as missing in `ActionInbox` and its slug stops being a navigable anchor; a present Source keeps the existing owner-scoped `hrefForSlug` link, unchanged (`owner-scoped-anchors.test.tsx` still passes).
- Only a successful Skills scan carrying an array produces a count. Every other outcome is "the scan did not answer".
- The Skill sentence lives in `src/lib/workbench-loopback-health.ts` beside `loopbackHealthSentence`, exhaustive over its input, with its copy exported as a named constant.
- `SettingsApiMcpPane` keeps its posture pins: no `fetch(` and no `"/api/` literal of its own, one probe on mount.
- Both changes get mounted DOM coverage in the `dom` project (`*.test.tsx` under a `__tests__` directory).

**Block If:** No blocking decisions are expected. If the existing case "reads a rejected probe as unreachable with no Skills" turns out to be pinned by a second suite whose intent is that zero is the correct claim, HALT — the two would be asserting opposite contracts.

**Never:**
- Do not change `probeLoopbackApiPane`'s `/health` half, `classifyLoopbackHealth`, or any `loopbackHealthSentence` copy — DW-633 settled those.
- Do not touch `ChatCanvas`'s independent Skills read: it makes no count claim and "no list" is already the right silent outcome there.
- Do not change the storage contract — `markSourceMissing` in `src/lib/action-items.ts` and `src/lib/todos.ts` already behave correctly; this is a render-side fix only.
- Do not drop or reword `TodosCanvas`'s existing "Source missing" span.
- Do not add a second probe, a retry, or an error banner to either surface.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Live source | `ActionItem` with `sourceSlug: "target"`, no `sourceMissing` | `source · target` renders as a link to `hrefForSlug("target")` | No error expected |
| Cascade-deleted source | `ActionItem` with `sourceSlug: "target"`, `sourceMissing: true` | The slug is named and marked missing, with NO anchor for it in the row | No error expected |
| No cited source | `ActionItem` with no `sourceSlug` | Neither chip renders | No error expected |
| Skills scan answered | Scan responds 200 with `{ skills: [a, b] }` | "2 Skills on disk." beside the health sentence; one Skill renders singular | No error expected |
| Skills scan answered empty | Scan responds 200 with `{ skills: [] }` | "0 Skills on disk." — a real count of zero is still stated | No error expected |
| Skills scan did not answer | Scan rejects, or responds non-OK, or the body has no `skills` array | The unknown-count sentence; no digit-and-"Skills on disk" claim | Swallowed as before — no banner, no retry |

</intent-contract>

## Code Map

- `src/components/ActionInbox.tsx:423` -- the chip: `{item.sourceSlug && <Link href={hrefForSlug(item.sourceSlug)} className="receipt" …>source · {item.sourceSlug}</Link>}`, inside the `row` of receipts (`owner ·`, `due ·`, `% confidence`) at `:418-424`. `hrefForSlug` comes from `useSlugTenants()` at `:76`. This is the DW-593 site; nothing else in the file reads `sourceMissing`.
- `src/lib/action-items.ts:26` -- `sourceMissing?: boolean` with the comment "The cited Source was cascade-deleted. The todo itself is kept."; set at `:157-158`.
- `src/components/workbench/TodosCanvas.tsx:405` -- the ESTABLISHED precedent: `{item.sourceMissing && <span>Source missing</span>}` in `wb-todos-meta`. Match its vocabulary.
- `src/components/workbench/__tests__/todos-canvas.test.tsx:124-142` -- how that precedent is asserted (`findByText("Source missing")`).
- `src/components/__tests__/owner-scoped-anchors.test.tsx:573-604` -- the ONLY existing `ActionInbox` mount, pinning the live-source href. It carries file-wide `next/navigation` and `@clerk/nextjs` mocks; the new case needs its own suite rather than a graft, since this file's subject is anchors.
- `src/lib/workbench-loopback-health.ts:76-98` -- `probeLoopbackApiPane`; the Skills half is `:87-97` and has THREE swallow paths into `[]` (catch, non-OK, non-array). `loopbackHealthSentence` at `:58-72` is the exhaustive-switch shape to copy, with its `never` assignment.
- `src/components/workbench/SettingsApiMcpPane.tsx:137-155` -- `apiLive` state (typed `{ health; skills: SkillSummary[] }`) and the one mount probe; `:179-192` -- the health note `<p className="wb-set-note" role="status">` that concatenates the health sentence and the inline singular/plural count.
- `src/components/workbench/__tests__/settings-api-mcp-pane.test.tsx` -- the pane's mounted suite. `healthNote()` at `:172-176` finds the line by `/\d Skills? on disk\./`, which no longer matches the unknown case; `:305-310` is the case that currently ASSERTS "0 Skills on disk." for a rejected probe — the exact false claim, so it must be rewritten, not left. `routeFetch` at `:106-160` routes `/api/v1/health` and `/api/v1/skills` separately, so a scan failure is already expressible.
- `src/lib/__tests__/workbench-settings.test.ts:5789-5796, 6283-6300` -- source scans pinning that the pane holds no `fetch(` / `"/api/` and that the canvas holds no `apiLive`/`probeLoopbackApiPane`. Read-only constraints on the shape of the fix.
- `src/components/workbench/ChatCanvas.tsx:251-275` -- the other Skills reader. Out of scope by the Never clause: it never claims a count.
- `src/lib/__tests__/epic8-remediation.test.ts:2222-2225` -- the existing node-project assertions on `classifyLoopbackHealth`; a shared suite, so the probe's own `loopbackFetch` mock belongs in a dedicated file rather than grafted here.
- `AGENTS.md` "Test environments" -- `*.test.tsx` ⇒ `dom` project, must live under `__tests__`; `vitest.config.ts` throws at config load for a `*.test.tsx` outside the dom include.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-loopback-health.ts` -- widen `probeLoopbackApiPane`'s `skills` to `SkillSummary[] | null`, returning `null` from all three did-not-answer paths and an array only on a parsed 200; add an exported unknown-count copy constant and an exhaustive `loopbackSkillCountSentence(skills: SkillSummary[] | null): string` returning that constant for `null`, "1 Skill on disk." for one, and "N Skills on disk." otherwise -- one place owns every claim the pane makes about the door, so a new outcome cannot ship uncounted.
- `src/components/workbench/SettingsApiMcpPane.tsx` -- retype `apiLive.skills` and render `loopbackSkillCountSentence(apiLive.skills)` in place of the inline ternary -- the pane stops asserting a count the probe did not establish.
- `src/components/ActionInbox.tsx` -- render the cited-source receipt as a non-navigating span naming the slug as missing when `item.sourceMissing`, keeping the `Link` otherwise -- a to-do stops offering a live route into a page that is gone.
- `src/components/__tests__/action-inbox-source-missing.test.tsx` (new, `dom` project) -- mount `ActionInbox` over a routed `fetch` stub for `/api/wiki/routes` and `/api/action-items`; cover the three chip rows of the I/O matrix, asserting on `queryByRole("link", …)` so the anchor's ABSENCE is what fails -- the component's first coverage of this branch.
- `src/lib/__tests__/loopback-skill-count.test.ts` (new, `node` project) -- unit-pin `probeLoopbackApiPane`'s Skills half at the seam: an answered list, an answered empty list, and each of the three did-not-answer paths (rejected, non-OK, no `skills` array) plus an unparseable body; and `loopbackSkillCountSentence` over all three outcomes -- the mounted suite can only stage a whole-sidecar-down probe, so the non-OK and no-array swallows would otherwise be unpinned.
- `src/components/workbench/__tests__/settings-api-mcp-pane.test.tsx` -- widen `healthNote()` to find the line by either sentence; rewrite the rejected-probe case to assert the unknown sentence and that no `N Skills on disk.` claim is made; add a case for a scan that answers `{ skills: [] }` beside a running sidecar, so a real zero is still stated -- otherwise the fix could be over-applied into never counting.

**Acceptance Criteria:**
- Given a to-do whose cited Source was cascade-deleted, when the Proposed tab renders it, then the row contains no anchor addressing that slug and the row says the source is missing.
- Given a to-do whose cited Source is present, when the Proposed tab renders it, then the `source · <slug>` anchor still resolves through `hrefForSlug` exactly as `owner-scoped-anchors.test.tsx` pins it.
- Given nothing serving on 127.0.0.1:19828, when the API + MCP category mounts, then the health note says the sidecar is not running and makes no numeric Skills-on-disk claim.
- Given a sidecar that answers `/health` running and the Skills scan with an empty array, when the pane mounts, then the note still reads "0 Skills on disk." — a scan that answered zero is a fact.
- Given `ClassifiedLoopbackHealth` or the skills argument grows an unhandled shape, when the module is type-checked, then the `never` assignment fails the build rather than defaulting to a claim.

## Spec Change Log

## Review Triage Log

## Design Notes

The two halves share one rule: a value that means "unknown" must not be spelled the same as a value that means "zero" or "fine". `skills: []` conflated them; `null` separates them at the source, and the exhaustive sentence builder makes the separation impossible to lose at the render.

`ActionInbox` keeps the slug visible rather than hiding the chip: the owner needs to know WHICH source went away to judge the to-do, and a vanished chip would read as "this to-do never cited anything". Vocabulary follows `TodosCanvas` ("Source missing") so the two Todo surfaces say one thing.

## Verification

**Commands:**
- `pnpm exec vitest run --project dom src/components/__tests__/action-inbox-source-missing.test.tsx src/components/workbench/__tests__/settings-api-mcp-pane.test.tsx src/components/__tests__/owner-scoped-anchors.test.tsx` -- expected: all pass, including the pre-existing anchor case.
- `pnpm exec tsc --noEmit` -- expected: clean; the widened `skills` type surfaces every unguarded `.length`.
- `pnpm test` -- expected: full suite green, including `workbench-settings.test.ts`'s pane source scans.
- `pnpm exec eslint src/components/ActionInbox.tsx src/components/workbench/SettingsApiMcpPane.tsx src/lib/workbench-loopback-health.ts` -- expected: no errors.
