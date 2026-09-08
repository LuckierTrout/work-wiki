---
title: 'DW-460/461/462/473: harden four pins that can pass while what they protect is gone'
type: 'refactor'
created: '2026-08-29'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
baseline_revision: 'a34c4fee0fbae07ea363ffdf4d3cedc742d6781a'
context: []
warnings: [oversized, multiple-goals]
deferred:
  - summary: >-
      The whole vitest `dom` project is broken on Node 26: `window.localStorage`
      is undefined, so 13 files / 233 mounted tests fail before asserting
      anything.
    evidence: |-
      `pnpm test` fails 233 tests across 13 dom-project files with
      `TypeError: Cannot read properties of undefined (reading 'clear')` at
      `window.localStorage.clear()`. Node prints
      `ExperimentalWarning: localStorage is not available because
      --localstorage-file was not provided` — Node 26.8.1 ships its own
      `globalThis.localStorage` getter, which shadows the one vitest's jsdom
      environment would otherwise expose (jsdom 30.0.1 supplies it correctly
      when constructed directly). Confirmed pre-existing: stashing this whole
      change and re-running
      `src/components/workbench/__tests__/workbench-split-wiring.test.tsx`
      reproduces the identical 29/29 failure on baseline a34c4fee. Counts are
      identical with and without this bundle's new suite. The fix is a
      repo-level decision (pin Node, or shim Storage in
      `vitest.setup.dom.ts`), not something a test-pin bundle should make.
    location: >-
      vitest.setup.dom.ts (and every mounted suite that reads
      window.localStorage)
    severity: high
  - summary: >-
      The DW-356 AGENTS.md parity test is per-PATTERN, so a member added to or
      dropped from a multi-member enumeration never has to be documented.
    evidence: |-
      `brand-copy.test.ts`'s "AGENTS.md's yopedia prose and IDENTIFIER_ALLOWLIST
      agree in both directions" asserts only that each allowlist PATTERN matches
      at least one backticked spelling in the frozen-identifier section. Both
      enumerated families are one pattern each, so a fifth `X_YOPEDIA_HEADERS`
      member — or a fifteenth `YOPEDIA_HYPHEN_IDENTIFIERS` member — satisfies
      direction 2 on the strength of a sibling and is never forced into the
      prose. The minimality sweep forces a member to exist in the shipped TREE,
      not in AGENTS.md. Pre-existing since DW-352 created the first enumerated
      family; DW-473 extends it to a second. A per-member parity assertion would
      close it for both at once.
    location: >-
      src/lib/__tests__/brand-copy.test.ts (AGENTS.md yopedia parity test)
    severity: medium
---

<intent-contract>

## Intent

**Problem:** Four guards are satisfied by a tree that no longer holds the property they exist for.
`canvasSpan()`/`canvasFallback()` stop the `<canvas>` opening tag at the first `>`, so any `>` inside
a prop turns the fallback assertions into measurements of attribute text (DW-460). All nine DW-131
assertions read `page.tsx` as text, so `aria-hidden="true" tabIndex={-1}` on the visible `<Link>`
prunes the only reachable escape hatch with all tests green (DW-461). Nothing pins the Knowledge
**tab** — `TREE_TABS`, `DEFAULT_TREE_TAB`, `TreePanel`, `buildKnowledgeTree` are unreferenced — so
renaming or removing it keeps the copy's promise of "a text list of this wiki's pages" unkept
(DW-462). And `IDENTIFIER_ALLOWLIST`'s `X-Yopedia-` entry is still an unanchored SHAPE, so
`strayYopedia("See X-Yopedia-Style-Guide for the docs")` reports zero (DW-473).

**Approach:** Make each pin observe the thing itself. Replace the opening-tag regex with a
brace/quote-aware scanner and unit-test it against a `>`-carrying prop. Add ONE mounted `.test.tsx`
under the existing jsdom `dom` project that renders the graph page and asserts a reachable
`getByRole("link", { name: /Knowledge tree/ })` outside the canvas. Pin the Knowledge tab in
`retired-surfaces.test.ts` through the pure `workbench-tree` exports plus a source pin on
`TreePanel.tsx`. Narrow the `X-Yopedia-` waiver to the closed enumeration
(`Queue-Attempt`, `Payload-Bytes`, `Signature`, `*`) with shared boundaries and a minimality sweep,
exactly the way DW-352 narrowed the lowercase-hyphen family.

## Boundaries & Constraints

**Always:**
- Every new/changed assertion must FAIL on the defect it names. Prove it by temporarily introducing
  the defect locally, observing the failure, and reverting — do not ship an assertion you have not
  seen fail.
- The mounted suite lives at `src/**/__tests__/**/*.test.tsx` so `vitest.config.ts`'s `DOM_INCLUDE`
  collects it; its `afterEach` calls `cleanup()` as its first statement (the `vitest.setup.dom.ts`
  convention).
- No `@testing-library/jest-dom` — it is not installed. Use plain DOM reads
  (`getAttribute`, `.tabIndex`, `.closest()`).
- The narrowed `X-Yopedia-` pattern keeps `IDENTIFIER_ALLOWLIST.length` at 12 and must still match a
  backticked spelling inside AGENTS.md's `## Frozen identifiers` section (the DW-356 parity test
  checks both directions).
- The header minimality sweep takes evidence only from the shipped tree, excluding `FREEZE_PROSE`
  (`AGENTS.md`) — the same self-certification exclusion the hyphen family uses.

**Block If:**
- A narrowed `X-Yopedia-` enumeration cannot be made to pass `every remaining "yopedia" is a runtime
  identifier` without raising a `YOPEDIA_PROSE_EXEMPT` count — that would be waiving new display
  prose, not narrowing a shape.
- The graph page cannot be mounted in jsdom without reshaping `src/app/wiki/graph/page.tsx` itself.
  Test-only shims (mocking `@clerk/nextjs`, `next/navigation`, `@/hooks/useGraphSimulation`) are
  fine; changing the component to be testable is not.

**Never:**
- Do not change `src/app/wiki/graph/page.tsx`, `src/lib/workbench-url.ts`, `src/lib/workbench-tree.ts`
  or any production module to make a test pass. This bundle hardens pins; the code under them is
  already correct.
- Do not delete or weaken any existing assertion in `retired-surfaces.test.ts` or
  `brand-copy.test.ts`. The source-scan pins stay; the mounted check is added BESIDE them.
- Do not widen `SKIPPED_DIRS`, `SOURCE_TEXT`, or any scan root.
- Do not touch the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Canvas prop carries `>` | `<canvas onClick={(e) => f(e)} aria-label="x">fallback</a></canvas>` source | `canvasFallback()` returns only the child markup, never the prop text | n/a |
| Self-closing canvas | `<canvas ref={r} />` | `canvasSpan()` fails with "must carry a fallback child, not be self-closing" | assertion failure |
| Two canvases | source with two `<canvas` opening tags | `canvasSpan()` fails on the count assertion | assertion failure |
| Quoted `>` in an attribute | `<canvas aria-label="a > b">child</canvas>` | opening tag ends at the real `>`; fallback is `child` | n/a |
| Escape hatch pruned | visible `<Link>` gains `aria-hidden="true"` | mounted `getAllByRole("link", …)` finds no reachable link → fail | assertion failure |
| Escape hatch unfocusable | visible `<Link>` gains `tabIndex={-1}` | mounted tabIndex assertion fails | assertion failure |
| Knowledge tab renamed | `TREE_TABS` knowledge label → `"Pages"` | the graph-copy/tab-label coupling assertion fails | assertion failure |
| `DEFAULT_TREE_TAB` moved | `DEFAULT_TREE_TAB = "files"` | the landing-tab assertion fails | assertion failure |
| Stray header prose | `"See X-Yopedia-Style-Guide for the docs"` | `hasStrayYopedia()` is `true` | n/a |
| Frozen header | `'headers.set("X-Yopedia-Payload-Bytes", n)'` | `hasStrayYopedia()` is `false` | n/a |
| Retired header name | a member no shipped file spells any more | header minimality sweep fails naming it | assertion failure |

</intent-contract>

## Code Map

- `src/lib/__tests__/retired-surfaces.test.ts` — DW-460 + DW-462 land here. `markup()` at `:202`
  already strips comments. `canvasSpan()` `:225`, `canvasFallback()` `:239`, `canvasAriaLabel()`
  `:244` are the three closures to rework; `LINK_TO_CONSTANT` `:212` and the nine `it()`s at
  `:255`–`:352` stay. Imports `../workbench-url` at `:7`; add `../workbench-tree`.
- `src/app/wiki/graph/page.tsx` — READ-ONLY. Visible `<Link href={KNOWLEDGE_TREE_HREF}>` at `:171`
  (text "Workbench Knowledge tree"); `<canvas role="img" aria-label=…>` at `:177`–`:191` with the
  fallback `<a>` at `:189`. Client component: `useUser` (`@clerk/nextjs`), `useRouter`
  (`next/navigation`), `useGraphSimulation` (`@/hooks/useGraphSimulation`), and a `fetch("/api/vaults")`
  effect gated on `isSignedIn`. The link renders only on the `!loading && !fetchError && !empty` branch.
- `src/hooks/useGraphSimulation.ts:29` — returns `{ loading, empty, fetchError, canvasBg,
  handleMouseMove, handleMouseLeave, handleClick }`. Mock this shape; jsdom has no 2D context.
- `vitest.config.ts:5` — `DOM_INCLUDE = "src/**/__tests__/**/*.test.tsx"`, and `:41`–`:69` HARD-FAIL
  the config load if a `.test.tsx` sits outside a `__tests__` directory. Put the new file inside one.
- `vitest.setup.dom.ts:25` — the backstop `cleanup()`; each suite still calls `cleanup()` first in
  its own `afterEach`.
- `src/components/__tests__/owner-scoped-anchors.test.tsx:72` — the `vi.mock("@clerk/nextjs", …)`
  idiom to copy. `src/components/__tests__/single-main-landmark-mounted.test.tsx:25` — the
  `vi.mock("next/navigation", …)` idiom and the document-level (not container-level) query rationale.
- `src/lib/workbench-tree.ts` — `DEFAULT_TREE_TAB = "knowledge"` `:57`, `TREE_TABS` `:65`
  (`Knowledge`, `Files`), `buildKnowledgeTree()` `:596` (pure; groups `IndexEntry[]` by `type`, drops
  agent-scoped, untyped group first). `IndexEntry` is `src/lib/types.ts:10` (`slug`/`title`/`summary`
  required).
- `src/components/workbench/TreePanel.tsx:382` — `{TREE_TABS.map(...)}` inside
  `role="tablist"` with `aria-label="Left column trees"`. Source-pin target for DW-462.
- `src/lib/__tests__/brand-copy.test.ts` — DW-473 lands here. `YOPEDIA_HYPHEN_IDENTIFIERS` `:79`,
  `YOPEDIA_HYPHEN_BOUNDS` `:123`, `YOPEDIA_HYPHEN_PATTERN` `:125`, `YOPEDIA_HYPHEN_MEMBER_PATTERNS`
  `:146` are the exact template to mirror. `IDENTIFIER_ALLOWLIST` `:157` — the entry to narrow is
  `:161`. `strayYopedia()` `:463`. `FREEZE_PROSE` `:628`. The hyphen minimality test
  ("keeps every waived yopedia resource name earning its place") `:917` — mirror its
  `scanBrandSources` + `expectUnionCorpus` + `sawFreezeProse` shape. The frozen/slip case tables are
  at `:824` (frozen) and `:895` (slips).
- Header evidence in the scanned corpus (`__tests__` and `_bmad-output/` are NOT scanned):
  `X-Yopedia-Queue-Attempt` — `src/app/api/tasks/run/route.ts:195`, `workers/task-consumer/index.ts:73`;
  `X-Yopedia-Payload-Bytes` — `src/lib/sandbox-service.ts:65`, `workers/sandbox-runner/src/index.ts:82`;
  `X-Yopedia-Signature` — `src/lib/integration-outbox.ts:315`;
  `X-Yopedia-*` (literal wildcard prose) — `src/lib/brand.ts:3`, `workers/task-consumer/index.ts:72`,
  `AGENTS.md:134`. Those four spellings are the whole closed set.
- `AGENTS.md:134` — the frozen-identifier bullet whose "The whole `X-Yopedia-*` wire-header family is
  frozen with it" clause stops being true once the waiver is a closed set. Parity test at
  `brand-copy.test.ts:1282` reads backticked spellings out of this section in BOTH directions.

## Tasks & Acceptance

**Execution:**

- `src/lib/__tests__/retired-surfaces.test.ts` — replace the opening-tag regex with a brace- and
  quote-aware scanner (DW-460). Add one closure that, from the single `<canvas` index, walks forward
  tracking `{}` depth and `"`/`'`/`` ` `` string state and returns the opening tag's end index plus
  whether it self-closes; rebuild `canvasSpan()`, `canvasFallback()` and `canvasAriaLabel()` on it.
  Keep the existing count assertion and both failure messages verbatim. Rationale: a `>` inside a
  prop currently truncates the tag and silently redirects the fallback/copy assertions at attribute
  text.
- `src/lib/__tests__/retired-surfaces.test.ts` — add tests that execute the scanner against synthetic
  sources covering every Matrix row for it: an arrow-prop `>`, a quoted `>`, a self-closing canvas,
  and two canvases. Rationale: the scanner is now the load-bearing part of nine assertions, so it
  needs its own evidence rather than being trusted.
- `src/lib/__tests__/retired-surfaces.test.ts` — add the DW-462 Knowledge-tab pins, importing
  `TREE_TABS`, `DEFAULT_TREE_TAB` and `buildKnowledgeTree` from `../workbench-tree`: (a) the tab the
  href lands on is `DEFAULT_TREE_TAB` and it is a real `TREE_TABS` member; (b) that member's label is
  the word the graph page's own copy names, read out of the graph source rather than written twice;
  (c) `buildKnowledgeTree` over a fixture `IndexEntry[]` actually lists those pages by title, so the
  copy's "text list of this wiki's pages" is a fact; (d) a source pin that `TreePanel.tsx` renders
  `TREE_TABS` in its tablist. Rationale: the route is pinned, the tree it promises is not.
- `src/app/wiki/graph/__tests__/graph-escape-hatch-mounted.test.tsx` — NEW. Mount `GraphPage` with
  `@clerk/nextjs`, `next/navigation` and `@/hooks/useGraphSimulation` mocked, then assert a link
  named `/Knowledge tree/` exists OUTSIDE the `<canvas>` (`.closest("canvas") === null`), that its
  `href` is `KNOWLEDGE_TREE_HREF`, and that it is keyboard-reachable (`tabIndex >= 0`). Rationale:
  DW-461 — `aria-hidden`/`tabIndex={-1}` prunes the hatch while every source scan stays green.
- `src/lib/__tests__/brand-copy.test.ts` — narrow the `X-Yopedia-` waiver (DW-473). Add
  `X_YOPEDIA_HEADERS` (`Queue-Attempt`, `Payload-Bytes`, `Signature`, `*`), shared bounds
  `(?<![A-Za-z0-9_-])X-Yopedia-` / `(?![A-Za-z0-9_-])`, the built pattern, and per-member patterns —
  mirroring `YOPEDIA_HYPHEN_*`. Replace `IDENTIFIER_ALLOWLIST[:161]` with the built pattern. Add a
  minimality `it()` mirroring "keeps every waived yopedia resource name earning its place", and add
  the header cases to the frozen table (`:824`) and the slip table (`:895`) — including
  `X-Yopedia-Style-Guide`. Rationale: a shape waives display prose the enumeration would catch.
- `AGENTS.md` — replace the "The whole `X-Yopedia-*` wire-header family is frozen with it" clause
  with the three backticked header names now enumerated, keeping `X-Yopedia-Queue-Attempt` and
  `X-Yopedia-*` spelled as they are. Rationale: prose that promises a family-wide freeze while the
  allowlist waives a closed set is the drift the DW-356 parity test exists to catch.

**Acceptance Criteria:**

- Given a `<canvas>` whose opening tag contains `onClick={(e) => f(e)}`, when `canvasFallback()` runs,
  then it returns only the element's children and no attribute text.
- Given the visible `<Link>` in `src/app/wiki/graph/page.tsx` gains `aria-hidden="true"` or
  `tabIndex={-1}`, when `pnpm test` runs, then the mounted suite fails.
- Given `DEFAULT_TREE_TAB` is changed to `"files"`, or the `knowledge` tab's label is renamed away
  from the word the graph page's copy uses, when `pnpm test` runs, then `retired-surfaces.test.ts`
  fails.
- Given prose reading `See X-Yopedia-Style-Guide for the docs`, when `strayYopedia()` runs, then it
  reports at least one occurrence.
- Given a member of `X_YOPEDIA_HEADERS` that no shipped file outside `AGENTS.md` spells, when
  `pnpm test` runs, then the header minimality test fails naming that member.
- Given the full suite on an unmodified tree, when `pnpm test` and `pnpm lint` run, then both pass
  and no `YOPEDIA_PROSE_EXEMPT` count changed.

## Spec Change Log

## Review Triage Log

### 2026-08-29 — Review pass

- intent_gap: 0
- bad_spec: 0
- patch: 20: (high 0, medium 4, low 16)
- defer: 2: (high 1, medium 1, low 0)
- reject: 11
- addressed_findings:
  - `[medium]` `[patch]` The new `canvasAriaLabel` "read the opening tag alone" rule was unpinned — reverting the helper to the old span-wide search left 65/65 green, and with it reverted a canvas could lose its own `aria-label` to a fallback descendant and still pass. Added two scanner cases (label only on a descendant throws; label on both returns the tag's own). Confirmed: the reversion now fails 2 tests.
  - `[medium]` `[patch]` `reachableTreeLinks()` used `getAllByRole`, so the suite's own "no reachable Knowledge tree link" message could never fire in the pruned state it was written for, and `[0]` was indexed unguarded (TypeError instead of an assertion). Switched to `queryAllByRole` behind a `theReachableLink()` helper that asserts length 1 and returns the element.
  - `[medium]` `[patch]` The `TreePanel` source pin was satisfied by a `TREE_TABS.map(` anywhere later in the module — the exact failure it claimed to prevent. Bounded to the tablist element's own children; verified the old form passes a hand-spelled-tablist mutation and the new one fails it.
  - `[medium]` `[patch]` `canvasAriaLabel` sliced with an unvalidated `tag.end`, so an unterminated opening tag made `src.slice(start, -1)` scan almost the whole file and return another element's `aria-label`. Now asserts the tag terminates before slicing.
  - `[low]` `[patch]` "Every case below FAILS under the regex this replaced" was false for three of the five scanner cases; the comment now names which cases are new evidence and which carry the pre-existing guarantee forward.
  - `[low]` `[patch]` The scanner doc claimed the graph page's own `onClick={(e) => handleClick(e)}` already defeats the old pattern; the real page is `onClick={handleClick}`. Restated as a latent defect, one ordinary prop away.
  - `[low]` `[patch]` "Nine assertions above" miscounted — only four of the nine `it()`s call the canvas closures. Corrected.
  - `[low]` `[patch]` Added a `depth < 0` bail to `canvasOpeningTag` so a stray `}` fails immediately and correctly rather than by never terminating the tag.
  - `[low]` `[patch]` Added the scanner cases for branches nothing executed: single-quoted `>`, template-literal prop, backslash-escaped quote, stray `}`, and the distinct "no `</canvas>`" branch.
  - `[low]` `[patch]` "builds a text list of this wiki's pages, by title" sorted the evidence away. Now asserts `buildKnowledgeTree`'s own output order — untyped group first, typed by label, pages by title.
  - `[low]` `[patch]` Added a test that the unfiltered role query returns BOTH links with exactly one in-canvas, so the `.closest("canvas")` filter cannot silently become a no-op.
  - `[low]` `[patch]` The `useGraphSimulation` mock was an untyped object literal that could drift from the hook. Now `satisfies UseGraphSimulationReturn`; verified a hook field addition becomes a `tsc` error.
  - `[low]` `[patch]` The mounted suite hard-coded `/Knowledge tree/`, duplicating the label its sibling deliberately derives. Now derived from `TREE_TABS`/`DEFAULT_TREE_TAB`.
  - `[low]` `[patch]` Corrected the cross-reference `single-main-landmark-mounted.test.ts` to `.tsx`.
  - `[low]` `[patch]` Added wildcard near-misses for the `*` member, which was the only enumerated member with no boundary evidence.
  - `[low]` `[patch]` `escapeHeader` was introduced while its documented mirror kept two inlined `.`-only escapes. Both families now share one `escapeIdentifier`.
  - `[low]` `[patch]` The "longest alternative first" ordering comment claimed an invariant the trailing lookahead makes irrelevant. Restated truthfully.
  - `[low]` `[patch]` Documented the thin evidence behind two members — `Signature` occurs on one shipped line, `*` only in two code comments — so the next reader knows why the minimality sweep is touchy.
  - `[low]` `[patch]` The AGENTS.md bullet had grown to a 1,252-character line carrying a ticket number, a test path and sweep internals in a section that is a contract about identifiers. Split into four sub-bullets of 99-289 chars carrying only names, call sites and the closed-enumeration clause.
  - `[low]` `[patch]` Boundary and verification docs aligned with what the code actually does throughout both suites.

One substitution, accepted: the review asked for `X-Yopedia-**` as a slip case. The implementer correctly declined — the boundary class deliberately admits `*` and `.`, so that spelling stays waived on the strength of the member before it, exactly as `yopedia-r2.log` does for the sibling family. A case that does hold (prose naming the family with no header name) was added instead, and the `*`/`.` residual documented, mirroring the hyphen family's trailing-`.` note.

Rejected (11); the load-bearing ones: a report that `src/app/wiki/graph/page.tsx` had been modified — verified false, it was another reviewer's in-flight mutation, and `git diff` on all three production modules is empty; the claim that DW-462 should pin the RENDERED knowledge tree rather than the tab constants — the ledger entry's stated harm is "removing or renaming the Knowledge tab, or changing `DEFAULT_TREE_TAB`", which the new pins catch, and the rendered tree body is already covered by the mounted workbench suites; `canvasSpan` sharing one message across three no-fallback failures (documented as deliberate); merging the two minimality sweeps (the repo's house style is explicit near-duplication with its own commentary); and six contrived-input edges that all fail safely rather than passing falsely.

## Design Notes

The opening-tag scanner, in shape (the whole of DW-460):

```
// from the index just past `<canvas`, with depth/quote state:
//   in a string  -> only its own closing quote (unescaped) ends it
//   `{`/`}`      -> depth++/depth--            (arrow props live in here)
//   `>` at depth 0 -> the opening tag ends; `/` before it means self-closing
```

`markup()` already removed `{/* … */}` and `//` comments before this runs, so the scanner only has
to survive props and attribute strings.

DW-462's (b) is the coupling that makes the pin non-redundant with `workbench-tree.test.ts:1648`:
read the label out of `TREE_TABS` and assert the graph page's own copy contains it. Renaming the tab
then fails HERE, at the escape hatch, rather than only in the tree suite that has no opinion about
the promise the graph page makes.

For DW-461, `role="img"` prunes the canvas subtree in a real a11y tree but jsdom still holds the
fallback `<a>` as DOM, so filter by `.closest("canvas")` rather than asserting a single link.
`getByRole` already honours `aria-hidden`; `tabIndex` needs its own read.

## Verification

**Commands:**
- `pnpm test` — expected: full run green, both `node` and `dom` projects reported, dom count up by
  the new suite.
- `pnpm vitest run src/lib/__tests__/retired-surfaces.test.ts src/lib/__tests__/brand-copy.test.ts` —
  expected: green.
- `pnpm vitest run --project dom src/app/wiki/graph/__tests__/graph-escape-hatch-mounted.test.tsx` —
  expected: green, and collected (not 0 files).
- `pnpm lint` — expected: clean.
- Mutation checks (introduce, observe the named failure, revert): `aria-hidden="true"` on the visible
  `<Link>`; `tabIndex={-1}` on it; `onClick={(e) => handleClick(e)}` inlined on the `<canvas>`;
  `DEFAULT_TREE_TAB = "files"`; a fifth member added to `X_YOPEDIA_HEADERS`.

## Auto Run Result

Status: done

### Summary

Four test pins that could pass while the property they exist for was gone now
observe that property directly. DW-460: the `<canvas>` opening tag is found by a
brace- and quote-aware scanner instead of `<canvas\b[^>]*>`, so a `>` inside a
prop can no longer redirect the fallback and copy assertions at attribute text.
DW-461: a mounted suite renders the graph page and asserts a Knowledge-tree link
that is actually reachable — outside the canvas, in the accessibility tree, and
in the keyboard order. DW-462: the Knowledge TAB is pinned at the escape hatch
through `TREE_TABS`, `DEFAULT_TREE_TAB` and `buildKnowledgeTree`, with the tab's
label read out of the constant and required in the graph page's own copy, so a
rename fails where the promise is made. DW-473: the `X-Yopedia-` waiver is a
closed enumeration with shared boundaries and a minimality sweep, the way DW-352
narrowed its sibling family, so display prose about a style guide no longer
passes the brand scan as a wire header.

### Files changed

- `src/lib/__tests__/retired-surfaces.test.ts` — brace/quote-aware
  `canvasOpeningTag()` scanner replacing the opening-tag regex, with
  `canvasSpan`/`canvasFallback`/`canvasAriaLabel` rebuilt on it; a
  `describe` executing the scanner against arrow-prop, quoted, single-quoted,
  template-literal, escaped-quote, stray-brace, self-closing, unterminated,
  missing-close and two-canvas sources; and a `describe` pinning the Knowledge
  tab (landing tab, label/copy coupling, `buildKnowledgeTree` output order,
  bounded `TreePanel` tablist pin). 65 tests -> 74.
- `src/app/wiki/graph/__tests__/graph-escape-hatch-mounted.test.tsx` — NEW.
  Mounts `GraphPage` with Clerk, the router and the graph hook mocked; asserts a
  reachable Knowledge-tree link outside the canvas, its href, its keyboard
  order, and that the `.closest("canvas")` filter is load-bearing. 6 tests.
- `src/lib/__tests__/brand-copy.test.ts` — `X_YOPEDIA_HEADERS` /
  `X_YOPEDIA_BOUNDS` / `X_YOPEDIA_PATTERN` / `X_YOPEDIA_MEMBER_PATTERNS`
  replacing the unanchored shape in `IDENTIFIER_ALLOWLIST` (still 12 patterns),
  a header minimality sweep with the `FREEZE_PROSE` self-certification
  exclusion, frozen and slip cases including the ledger's own
  `X-Yopedia-Style-Guide` prose, and one shared `escapeIdentifier` now used by
  both enumerated families.
- `AGENTS.md` — the frozen-identifier bullet's family-wide freeze clause
  replaced by the closed enumeration: the three header names with their call
  sites plus the literal `X-Yopedia-*`.
- No production module changed. `git diff` on `src/app/wiki/graph/page.tsx`,
  `src/lib/workbench-tree.ts` and `src/components/workbench/TreePanel.tsx` is
  empty.

### Review findings

- Patches applied: 20 (medium 4, low 16, high 0).
- Deferred: 2 — the Node 26 `window.localStorage` breakage of the whole `dom`
  project (high), and the per-PATTERN DW-356 AGENTS.md parity gap that lets a
  new enumeration member skip documentation (medium). Both recorded in
  frontmatter `deferred`.
- Rejected: 11.
- Follow-up review recommended: **true**. Patched counts: high 0, medium 4,
  low 16; score = 3x4 + 1x16 = 28, which is >= 5.

### Verification

- `pnpm vitest run src/lib/__tests__/retired-surfaces.test.ts src/lib/__tests__/brand-copy.test.ts`
  — 96 passed (74 + 22).
- `pnpm vitest run --project dom src/app/wiki/graph/__tests__/graph-escape-hatch-mounted.test.tsx`
  — 6 passed, collected (not 0 files, so `DOM_INCLUDE` reaches the new
  directory).
- `pnpm lint` — exit 0. `npx tsc --noEmit` — exit 0.
- `pnpm test` — 233 tests across 13 `dom` files FAIL, all on
  `window.localStorage` being undefined. Confirmed pre-existing and unrelated:
  stashing the entire change reproduces the identical failure on baseline
  a34c4fee. See the first `deferred` item.
- Mutation checks run and reverted, each observed to fail where claimed:
  `aria-hidden="true"` on the visible `<Link>` (3 of 4 mounted tests fail while
  `retired-surfaces.test.ts` stayed 65/65 green — the exact DW-461 gap, verified
  independently of the implementer); `tabIndex={-1}`; `canvasAriaLabel` reverted
  to the span-wide search (2 tests fail, where it was silent before the patch
  pass); an unbounded `TreePanel` pin against a hand-spelled tablist;
  `DEFAULT_TREE_TAB = "files"`; the knowledge label renamed; a fifth
  `X_YOPEDIA_HEADERS` member; the old `X-Yopedia-` shape restored (misses 6 slip
  cases).

### Residual risks

- The full suite cannot be shown green on this machine until the Node 26
  localStorage issue is resolved. The bundle's own suites and the new mounted
  suite pass; nothing in this change contributes to those 233 failures.
- The DW-462 pins observe the tab CONSTANTS and `TreePanel`'s source, not a
  mounted knowledge tree. A `TreePanel` whose knowledge branch returned `null`
  would leave these pins green; the mounted workbench suites cover that case,
  and they are among the suites currently blocked by the Node issue above.
- `X-Yopedia-Signature` rests on one shipped line and the `*` member on two code
  comments, so the minimality sweep will fail on an ordinary comment reflow.
  This is documented in the enumeration's doc comment; it is the intended
  strictness, not a defect, but it is a real maintenance cost.
