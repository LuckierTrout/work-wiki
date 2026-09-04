---
title: 'Rescue an empty settle frame''s citations, and pin the sidecar''s last hand-typed Settings destination'
type: 'bugfix'
created: '2026-09-04'
baseline_revision: '1a52a7ce549a90926599590a587f8c649e5acce9'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [multiple-goals, oversized]
deferred:
  - summary: >-
      An Agent turn that ends in a refusal — a denied shell command, a cancelled Skill form —
      reaches the owner as the coverage sentence instead of the refusal the sidecar actually sent.
    evidence: |-
      Pre-existing and untouched by this bundle: it is the FULL-array branch of the same read,
      and it survives unchanged under both `??` and the new length test. The two copies of
      `sanitizeCitedAnswer` disagree. The sidecar's takes a fourth `allowUncited` argument
      (`sidecar/chat-transport.mjs:44-47,76-82`) and `runToolTurn` passes
      `allowUncited: result.outputs.length > 0 || result.toolCalls.length > 0` (`:376-379`), so an
      answer with no `[n]` marker survives when the turn ran a tool. The browser's copy
      (`src/lib/chat-citations.ts:19-56`) has NO such parameter: `used.size === 0` returns
      `CHAT_COVERAGE_MISSING_COPY` with `citations: []` unconditionally. So the frame the sidecar
      settles is re-sanitized on arrival under a stricter rule than it was emitted under, and its
      content is replaced. VERIFIED during this run's review with a throwaway `node`-project probe
      (since removed) composing the real functions: the sidecar emits
      `{"content":"Denied. The command did not run.","citations":[{"n":1,…}],"coverage":true}`,
      and `settleTurn` renders `"Wiki has no coverage for this. Ingest a source or run Deep
      Research."` — the owner denies a command and is told the wiki has no coverage. The same path
      carries `FORM_CANCELLED_COPY` (`sidecar/agent.mjs:776,795`), `SHELL_DENIED_COPY` (`:829`),
      `"No command given."` (`:850`) and `SHELL_PATH_CHANGED_COPY` (`:890`).
      `epic8-chat-agent.test.ts:828` asserts the sidecar RETURNS the denial sentence; nothing
      asserts it survives the client seam, so the whole suite is green over it.
    location: >-
      src/lib/chat-pending-turn.ts:155 (the `sanitizeCitedAnswer` call), against
      src/lib/chat-citations.ts:52-58 and sidecar/chat-transport.mjs:76-82
    severity: low
---

<intent-contract>

## Intent

**Problem:** Two contracts have drifted from the code that is supposed to honour them. `settleTurn` reads `frame.citations ?? turn.fallbackCitations` (`src/lib/chat-pending-turn.ts:139`), but every sidecar settle path emits a `citations` array rather than omitting the field (`sidecar/chat-transport.mjs:573`, `:619`, `:396`), so the `??` branch never fires and `OpenTurn.fallbackCitations` is dead code the surface still populates (`ChatCanvas.tsx:488`) (DW-585). Separately, `sidecar/mcp.mjs`'s `MCP_INSTRUCTIONS` (`:53-54`) hand-types the `api-mcp` category label — the last copy of the destination DW-504 derived — and nothing asserts its content, so renaming the category in `SETTINGS_CATEGORIES` leaves the standing instruction every MCP client reads naming a nav row that no longer exists, with the whole suite green (DW-629).

**Approach:** Change the settle read to a length test so a frame carrying an empty array falls back to the citations the assemble already resolved, and pin that branch with an executable row that settles an empty array and asserts the fallback reaches the rendered turn. For the sidecar sentence, add a pin rather than a shared constant: `epic8-chat-agent.test.ts` already imports sidecar `.mjs` modules directly, so importing `MCP_INSTRUCTIONS` and asserting it contains `settingsPointer("api-mcp", SETTINGS_LABEL)` reaches the copy without the sidecar importing `src/lib` (AD-6). Amend the three comments that assert the pre-change state so none of them outlives its truth.

## Boundaries & Constraints

**Always:** Keep every existing assertion in `src/lib/__tests__/chat-pending-turn.test.ts` and `src/lib/__tests__/epic8-chat-agent.test.ts` passing unchanged. The new pointer assertion must DERIVE the string via `settingsPointer("api-mcp", SETTINGS_LABEL)` — never retype `"Settings → API + MCP"` in the test, or the pin is the drift it exists to catch. Both new rows go in the existing suites, next to the assertions they extend. Comments say *why* in each file's established voice.

**Block If:** Importing `sidecar/mcp.mjs` from the `node` vitest project turns out to start the stdio server or otherwise have a load-time side effect, meaning the pin cannot be reached without a shared `.mjs` constant.

**Never:** Do not change `sidecar/chat-transport.mjs`, `sidecar/agent.mjs`, or `src/components/workbench/ChatCanvas.tsx` — the sidecar's `citations: []` emissions are the wire contract this fix accommodates, not a bug to fix at the emitter. Do not change the wording of `MCP_INSTRUCTIONS` itself, nor make `sidecar/mcp.mjs` import `src/lib` (AD-6), nor introduce a shared `.mjs` copy of the label — the pin is the sanctioned resolution here. Do not touch `sanitizeCitedAnswer` in either copy, `settingsPointer`, or `SETTINGS_CATEGORIES`. Do not add a new test file, a new exported symbol, or a new copy constant. Do not remove `OpenTurn.fallbackCitations` — reviving it is the point.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Empty settle rescued (DW-585) | `settleTurn(openTurn(), { content: "Alpha says so [1]." , citations: [] })` with `fallbackCitations` = the assemble's `[{ n: 1, path: "wiki/alpha.md", … }]` | settled; assistant content keeps `Alpha says so [1].` and `citations` equals the assemble's rows | No error expected |
| Omitted citations still rescued | frame with no `citations` key (existing row at `chat-pending-turn.test.ts:132`) | unchanged: assemble's citations stand in | No error expected |
| Frame's own citations still win | frame with a non-empty `citations` array (existing row at `:153`) | unchanged: the frame's rows are used, not the assemble's | No error expected |
| Nothing to fall back to | frame `citations: []`, `fallbackCitations: []`, content `"Certainly [9]."` | coverage sentence, `citations: []` — the length test cannot invent evidence | No error expected |
| MCP instructions pinned (DW-629) | `MCP_INSTRUCTIONS` imported from `sidecar/mcp.mjs` | contains `settingsPointer("api-mcp", SETTINGS_LABEL)` | No error expected |

</intent-contract>

## Code Map

- `src/lib/chat-pending-turn.ts:139` -- the single edit for DW-585, inside `settleTurn`; the second argument to `sanitizeCitedAnswer`. `OpenTurn.fallbackCitations` is declared at `:37`.
- `src/lib/chat-citations.ts:19-56` -- `sanitizeCitedAnswer` (browser copy, three params, no `allowUncited`). READ-ONLY. When no valid marker is used it returns `CHAT_COVERAGE_MISSING_COPY` with `citations: []`, which is why an empty-array frame loses a genuinely cited answer today.
- `src/components/workbench/ChatCanvas.tsx:488` -- the only producer of `fallbackCitations` (`assembled.citations`). READ-ONLY: evidence the field is populated and therefore worth reviving.
- `sidecar/chat-transport.mjs:573`, `:396`, `:619` -- the settle paths that always send an array. READ-ONLY: evidence the `??` branch is unreachable.
- `sidecar/agent.mjs:776,795,829,850,890` -- `citations: []` on the `AgentTurn` refusal returns. READ-ONLY: same evidence, one layer in.
- `src/lib/__tests__/chat-pending-turn.test.ts` -- `ASSEMBLED` at `:22`, `openTurn()` at `:30`. The `describe("a done frame that writes the turn down")` block starts at `:131`; the row to sit beside is `"prefers the frame's own citations over the assemble's"` at `:153`.
- `sidecar/mcp.mjs:42-61` -- the `MCP_INSTRUCTIONS` doc block and array; the literal is on `:54`. `:344-350` registers it on the `McpServer`. `:346` (module tail) guards the stdio start on `process.argv[1].endsWith("mcp.mjs")`, so an `import` from a test starts nothing — VERIFIED by `node -e "import('./sidecar/mcp.mjs')"`, which resolved and printed the instructions.
- `src/lib/__tests__/epic8-chat-agent.test.ts:1937-1984` -- `describe("chat-agent copy derives its Settings destination")`, the DW-504 block. `const pointer = settingsPointer("api-mcp", SETTINGS_LABEL)` at `:1939` is the exact string the new row needs. The file already imports `sidecar/agent.mjs`, `sidecar/skills.mjs`, `sidecar/workspace.mjs` and `sidecar/shell.mjs` at `:38-61` — the established idiom, and proof AD-6 runs one way only. The comment at `:1966-1971` currently declares `sidecar/mcp.mjs` "not in scope here" and must stop saying so.
- `src/lib/chat-agent.ts:33-38` -- the doc block claiming a rename "still has exactly one other place to visit, by design". True after this change, but it should say the suite now catches a missed visit instead of leaving the reader to assume it does not.
- `src/lib/workbench-settings.ts:83-101,119,176-181` -- `SETTINGS_CATEGORIES`, `SETTINGS_LABEL`, `settingsPointer`. READ-ONLY.
- `vitest.config.ts` -- the `node` project collects `src/**/__tests__/**/*.test.ts`; both suites are already in it.

## Tasks & Acceptance

**Execution:**
- `src/lib/chat-pending-turn.ts` -- replace `frame.citations ?? turn.fallbackCitations` at `:139` with `frame.citations?.length ? frame.citations : turn.fallbackCitations`, and add a short comment saying why a LENGTH test rather than `??`: the sidecar sends `citations: []` rather than omitting the field, so nullish coalescing left `fallbackCitations` dead.
- `src/lib/__tests__/chat-pending-turn.test.ts` -- add one `it` beside `:153` that settles `{ content: "Alpha says so [1].", citations: [] }` and asserts the assistant leg keeps the marker and carries `ASSEMBLED.citations`; add one asserting an empty fallback still settles to the coverage sentence. Pin the branch both ways so the rescue cannot become an unconditional override.
- `sidecar/mcp.mjs` -- leave the sentence's wording alone; extend the `MCP_INSTRUCTIONS` doc block with the one fact a reader renaming the category needs: this label is derived nowhere (AD-6) and is held to `SETTINGS_CATEGORIES` by a named test in `src/lib/__tests__/epic8-chat-agent.test.ts`.
- `src/lib/__tests__/epic8-chat-agent.test.ts` -- import `MCP_INSTRUCTIONS` from `../../../sidecar/mcp.mjs` and add an `it` to the DW-504 describe asserting it contains `pointer`; amend the `:1966-1971` comment so it no longer says the sidecar copy is out of scope.
- `src/lib/chat-agent.ts` -- amend the doc block at `:33-38` to record that the surviving hand-typed copy is now pinned by that test, so a rename fails loudly rather than silently.

**Acceptance Criteria:**
- Given a settle frame whose `citations` is an empty array and an open turn whose `fallbackCitations` are the assemble's rows, when `settleTurn` runs, then the assistant leg is cited from the assemble instead of being reduced to the coverage sentence.
- Given `api-mcp`'s label is changed in `SETTINGS_CATEGORIES` and `sidecar/mcp.mjs` is left untouched, when `pnpm test` runs, then a named row in `epic8-chat-agent.test.ts` fails.
- Given the full suite, when `pnpm test` runs, then every pre-existing assertion in both suites still passes and no test file was added.

## Spec Change Log

## Review Triage Log

### 2026-09-04 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 0, low 3)
- defer: 1: (high 0, medium 0, low 1)
- reject: 8: (high 0, medium 0, low 8)
- addressed_findings:
  - `[low]` `[patch]` The DW-585 comments in `chat-pending-turn.ts` and its new test row claimed a live bug ("a genuinely cited answer arriving beside an empty array was reduced to the coverage sentence", "THE SHAPE THE WIRE ACTUALLY SENDS") that the current emitters cannot produce — `chat-transport.mjs:375` already falls back to the caller's assemble rows before emitting, so `citations: []` only ever ships beside content whose unmapped markers were stripped. Both comments rewritten to claim no more than is true: the key is always sent, so `??` was unreachable and `fallbackCitations` dead; the frame under test is hand-built; no frame the current sidecar emits settles differently under the two operators; what is restored is the field's contract, load-bearing the moment a path emits without re-sanitizing.
  - `[low]` `[patch]` `sidecar/mcp.mjs`'s new doc block claimed the destination was "the only copy of that label outside `src/lib`". `grep -rn "API + MCP"` also finds `skills/work-wiki/{README,SKILL,examples,api-reference}.md`, an `e2e/workbench-owner.spec.ts:111` role name and a `src/app/api/v1/loopback-settings/route.ts:19` doc comment. Claim narrowed to the grep-verified scope (the only copy under `sidecar/`) and a second paragraph added stating the pin does not make a rename safe repo-wide, naming what it does not cover.
  - `[low]` `[patch]` `expect(MCP_INSTRUCTIONS).toContain(pointer)` passed only because the destination happens to sit inside one element of a hand-wrapped, `\n`-joined array: a longer label re-wrapped to fit would straddle a line break and fail the row with no drift, whose obvious fix is to retype the literal — the one thing the row exists to prevent. Now asserts against `MCP_INSTRUCTIONS.replace(/\\s+/g, " ")`; `pointer` stays derived. Confirmed by a third mutation (array re-wrapped so the raw string no longer contains the pointer): the row stays green, and would have failed before the patch.

## Design Notes

The DW-585 change is deliberately conservative: `?.length` keeps `undefined`, `null` and `[]` all falling through to the assemble, and a frame with real rows is still preferred. It does not touch the coverage substitution — an answer with no usable marker still becomes `CHAT_COVERAGE_MISSING_COPY`, because the fallback supplies evidence, not markers.

For DW-629, a test pin was chosen over a shared `.mjs` constant because the shared-constant route would move a `src/lib`-owned label into the sidecar tree and give the repo two owners for one string. The pin keeps `SETTINGS_CATEGORIES` the single owner and makes the sidecar's copy a *checked* duplicate:

```ts
it("holds the sidecar's MCP instructions to the same derived pointer", () => {
  expect(MCP_INSTRUCTIONS).toContain(pointer);
});
```

## Verification

**Commands:**
- `pnpm vitest run --project node src/lib/__tests__/chat-pending-turn.test.ts src/lib/__tests__/epic8-chat-agent.test.ts` -- expected: all pass, including the new rows.
- `git stash && pnpm vitest run --project node src/lib/__tests__/chat-pending-turn.test.ts; git stash pop` -- not required; instead, confirm the DW-585 row is a real regression pin by temporarily reverting `:139` to `??` and observing the new row fail, then restoring.
- `pnpm test` -- expected: the whole suite green.
- `pnpm lint` -- expected: no new findings.

## Auto Run Result

Status: done

**Implemented change.** Two contract repairs, both low-severity ledger entries.

DW-585: `settleTurn` now reads `frame.citations?.length ? frame.citations : turn.fallbackCitations`. Every sidecar settle path SENDS the `citations` key rather than omitting it, so the old `??` was unreachable and `OpenTurn.fallbackCitations` was dead despite `ChatCanvas.tsx:488` populating it on every turn. The change is the ledger decision verbatim. Its honest scope is recorded in the code: no frame the current sidecar emits settles differently under the two operators, because `chat-transport.mjs:375` already falls back to the caller's assemble rows before emitting. What is restored is the field's contract — `[]`, `undefined` and `null` all mean "none of my own" — which becomes load-bearing the moment a settle path emits without re-sanitizing.

DW-629: `sidecar/mcp.mjs`'s `MCP_INSTRUCTIONS` keeps its hand-typed `Settings → API + MCP`, and is now held to `SETTINGS_CATEGORIES` from the `src/lib` side, which is the remedy the ledger entry names for an AD-6-forced copy. The sentence's wording is unchanged; no shared `.mjs` constant was introduced.

**Files changed.**
- `src/lib/chat-pending-turn.ts` -- the length test in `settleTurn` (`:157`), plus a comment stating exactly what it does and does not fix.
- `src/lib/__tests__/chat-pending-turn.test.ts` -- two rows: an empty frame array rescued by the assemble, and both sides empty still settling to the coverage sentence (so the rescue cannot become an unconditional override).
- `sidecar/mcp.mjs` -- doc block only: why the label cannot be derived, which test holds it, that re-wrapping the array is free, and what the pin does not cover.
- `src/lib/__tests__/epic8-chat-agent.test.ts` -- imports `MCP_INSTRUCTIONS` from `../../../sidecar/mcp.mjs` (the idiom the file already uses for four sidecar modules) and asserts the whitespace-collapsed instructions contain the derived `pointer`; the neighbouring comment no longer calls the sidecar copy out of scope.
- `src/lib/chat-agent.ts` -- doc block only: a rename that skips the sidecar now fails a named row.

**Review findings.** 3 patches applied (all low, listed in the Review Triage Log), 1 deferred (low — the two `sanitizeCitedAnswer` copies disagree on `allowUncited`, so an Agent refusal reaches the owner as the coverage sentence; pre-existing and unchanged by this bundle), 8 rejected.

**Follow-up review recommendation:** false. Patched findings by severity: high 0, medium 0, low 3. No patched finding was high, so no further loop.

**Verification.**
- `pnpm vitest run --project node src/lib/__tests__/chat-pending-turn.test.ts src/lib/__tests__/epic8-chat-agent.test.ts` -- 81 passed.
- `pnpm test` -- 381 files, 9475 passed, 1 skipped (pre-existing), 0 failed. Run twice: after implementation and again after the three patches.
- `pnpm lint` -- no findings; the three `jsx-ast-utils` `TSNonNullExpression` lines are pre-existing noise from untouched JSX files.
- Mutation A: reverting `:157` to `??` fails exactly `"falls back to the assemble when the frame's citations are an EMPTY array"` (80 passed, 1 failed).
- Mutation B: renaming `api-mcp`'s label in `SETTINGS_CATEGORIES` fails exactly `"holds the sidecar's MCP instructions to the same derived pointer"` (80 passed, 1 failed). Both mutations run independently, both restored; `workbench-settings.ts` and `chat-pending-turn.ts` are byte-identical to the reviewed state.
- Mutation C: re-wrapping `MCP_INSTRUCTIONS` so the destination straddles a newline leaves the row green, confirming the whitespace normalization removed a false-alarm mode without weakening the drift catch.
- `node -e "import('./sidecar/mcp.mjs')"` resolves and exits: the module tail guards its stdio connect on `process.argv[1].endsWith("mcp.mjs")`, so the new test import starts no server. The spec's Block If never triggered.
- Matrix audit: all five I/O rows are covered by rows that ran and passed — two new in `chat-pending-turn.test.ts`, two pre-existing at `:132` and `:153`, one new in `epic8-chat-agent.test.ts`.

**Residual risks.**
- The DW-585 branch is a contract repair, not an observed-bug fix. Nothing in the suite pins the emitter side, so if a future settle path stops re-sanitizing against the assemble, the new branch will start carrying real traffic silently. The code comment says so rather than leaving the next reader to discover it.
- The pointer pin covers `sidecar/mcp.mjs` only. The label is still hand-typed in `skills/work-wiki/*.md`, an `e2e` role name and a route doc comment; a rename must still visit those, and the e2e one fails as a selector timeout rather than as a named drift row. Stated in the doc block rather than implied away.
- `src/lib/chat-agent.ts:33` still opens "ONE hand-typed copy survives outside `src/lib`", which is true of runtime code that renders the pointer but not of the repo's prose. Pre-existing, outside the intent, and left rather than widened into.
