---
title: 'Brand scan coverage: Yopedia dimension, stray-workwiki parity, unified roots and filter'
type: 'refactor'
created: '2026-08-20'
status: 'done'
baseline_revision: 'ab553226cc51f6a4c0fa16d7ab794d84c3971eb3'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      workers/email-ingest/README.md:20 documents a live app menu path with the
      retired brand ("the address entered under Yopedia **Settings -> Email
      ingestion**"), so the exemption freezes wrong operator documentation.
    evidence: |-
      The file is in YOPEDIA_PROSE_EXEMPT because three of its "Yopedia"
      mentions are deployment history, but this one names a UI path the display
      rename should have updated. This bundle's intent authorises exemptions,
      not copy corrections, and the spec's Never list forbids editing it.
    location: >-
      workers/email-ingest/README.md:20
    severity: low
  - summary: >-
      .github/workflows/ carries brand strings and is read by no scan.
    evidence: |-
      Reviewer found hits at infra-setup.yml:52, deploy-cloudflare.yml:4,79,97,98
      and seed-yoyo.yml:4-18,36,92-102. Neither source list reaches the tree.
      AGENTS.md marks .github/ protected, so folding it in is a decision the
      intent did not authorise; seed-yoyo.yml:93 also names a second workers.dev
      subdomain (yopedia.christianlee-flightwall.workers.dev) that the current
      single-host allowlist entry would not cover.
    location: >-
      .github/workflows/
    severity: low
  - summary: >-
      Root non-Markdown files beyond the four AGENTS.md freezes stay unread.
    evidence: |-
      maintainerSources() names wrangler.jsonc, package.json, mcp.json and
      Dockerfile because the root listing is non-recursive markdown-only. That
      leaves docker-compose.yml, .env.example, next.config.ts, open-next.config.ts,
      tailwind.config.ts, vitest.config.ts, eslint.config.mjs and postcss.config.mjs
      unscanned. Widening the root listing to SOURCE_TEXT would cover them but
      also pull in pnpm-lock.yaml, which needs its own decision.
    location: >-
      src/lib/__tests__/brand-copy.test.ts
    severity: low
  - summary: >-
      IDENTIFIER_ALLOWLIST's /yopedia-[a-z-]+/g swallows display prose, the way
      the workwiki family did before it was anchored.
    evidence: |-
      strayYopedia("the yopedia-first workflow") returns no match, so that prose
      would pass the scan. The workwiki side guards the identical case with its
      anchored alternation and a "the workwiki-first approach" slip case. The
      pattern is pre-existing and narrowing it needs evidence about which real
      Cloudflare resource names depend on it, so the new yopedia case table pins
      today's behaviour rather than changing it.
    location: >-
      src/lib/__tests__/brand-copy.test.ts:52
    severity: medium
  - summary: >-
      Named single files and newly walked roots surface as ENOENT rather than a
      pin failure when renamed or removed.
    evidence: |-
      scannedSources() pushes src/mcp.ts and src/middleware.ts by literal path,
      maintainerSources() pushes four root config files the same way, and walk()
      calls readdir() on skills/, public/, journal-site/ and .opencode/commands/
      without an existence check. A rename throws from inside a content
      assertion instead of failing the pin test with its diagnostic message.
      The stat-based pattern already used by the scripts.sync test is the fix.
    location: >-
      src/lib/__tests__/brand-copy.test.ts
    severity: low
  - summary: >-
      .agents/skills/ is tracked installer-generated markdown that no scan reads,
      while the comparable .opencode/commands/ was folded in.
    evidence: |-
      The test's own comment concedes .opencode/commands/ holds
      BMAD-installer-generated docs; .agents/skills/ is the same class, several
      hundred tracked markdown files, currently brand-clean. The split is
      undocumented either way. The intent named .opencode/commands/ and not this
      root.
    location: >-
      .agents/skills/
    severity: low
---

<intent-contract>

## Intent

**Problem:** `src/lib/__tests__/brand-copy.test.ts` claims to guard the repo's brand strings but each of its three dimensions reads a different slice of the tree: the yopedia check runs over `scannedSources()` only (so "Yopedia" display prose can return to any maintainer surface with CI green), the stronger `strayWorkwiki` predicate runs over `maintainerSources()` only (so `// Workwiki local sync` in a component stays green), whole roots (`skills/`, `wrangler.jsonc`, `workers/*/wrangler.jsonc`, `package.json`, `mcp.json`, `Dockerfile`) are read by neither list, and three overlapping extension filters each omit types the others cover, so adding a file of an uncovered type shrinks coverage with no test failure.

**Approach:** Run all three predicates over the union of both source lists, collapse the three extension filters into one shared `SOURCE_TEXT` definition used by every walk, add the unread roots, and give the yopedia dimension a small per-path exemption set for the maintainer files whose "Yopedia" mentions are grandfathered deployment prose — with a pin test that fails when an exemption stops being needed, so the list cannot rot into a blanket waiver.

## Boundaries & Constraints

**Always:**
- Keep the rebrand freeze in AGENTS.md intact: never rewrite a `yopedia`/`WORKWIKI_*` runtime identifier, resource name, origin, or upstream link to make a scan pass. Widen the allowlist or exempt the path instead.
- Every new allowlist pattern must be anchored tightly enough that display prose is not swallowed — the existing `tells a frozen operator identifier apart from a display-brand slip` case table is the contract for that and must keep passing.
- Every root added to a source list must be pinned against vacuity (a named file, or a non-empty-contribution assertion when naming a file would be brittle).
- Reading a file must never decode binary: the shared extension filter stays an allowlist of text types (no `.ttf`, `.png`).

**Block If:**
- A file in the widened scan carries a genuine display-brand slip (not a frozen identifier, not grandfathered deployment prose) — fixing shipped copy is outside this bundle.

**Never:**
- Do not edit `README.md`, `BACKLOG.md`, `docs/trusted-memory-roadmap.md`, `workers/*/README.md`, `wrangler.jsonc`, or `scripts/setup-cloudflare.sh` to remove their "Yopedia" prose. They are exempted, not corrected.
- Do not add a fourth divergent extension filter. `MARKDOWN` (root non-recursive listing) and `ANY_FILE` (`tools/`, `scripts/`) stay as they are — they are listing selectors, not source-type filters.
- Do not walk `_bmad-output/`, `.next/`, `node_modules/`, `.git/`, or `journal-site/dist/`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Yopedia prose returns to a maintainer surface | `# Yopedia sandbox runner` planted at `workers/sandbox-runner/README.md:1` | yopedia test fails naming that path | No error expected |
| Yopedia prose returns to a newly folded root | `<title>Yopedia Growth Journal</title>` in `journal-site/build.mjs`; `# Using Yopedia as an agent` in `public/agent-api.md` | yopedia test fails naming those paths | No error expected |
| Stray workwiki in the app tree | `// Workwiki local sync` planted in `src/components/LocalSyncPanel.tsx` | stray-workwiki test fails, offender line names the token | No error expected |
| Frozen identifier in the app tree | `workwikiDefaultTags`, `save-to-workwiki`, `https://hooks.example.com/workwiki`, `filename="workwiki-actions.ics"` | All pass — allowlisted | No error expected |
| Frozen deployment origin | `https://yopedia.yuanhao-li.workers.dev/api/mcp` in `skills/work-wiki-mcp/SKILL.md` | Passes — allowlisted identifier | No error expected |
| Exemption goes stale | An exempt path loses its last stray "Yopedia" | Exemption pin test fails, demanding the entry be deleted | No error expected |
| Exemption names a path no scan reads | Typo or moved file in the exemption set | Exemption pin test fails | No error expected |

</intent-contract>

## Code Map

- `src/lib/__tests__/brand-copy.test.ts` -- the only file this bundle changes. Anchors: `IDENTIFIER_ALLOWLIST` :22-36, `TS_SOURCES` :39, `CLIPPER_SOURCES` :46, `walk()` :54-72, `scannedSources()` :98-113, `MARKDOWN`/`ANY_FILE` :116-117, `TEXT_SOURCES` :123, `WORKWIKI_IDENTIFIER_ALLOWLIST` :131-140, `saysStaleDisplayName` :147-149, `strayWorkwiki` :157-161, `maintainerSources()` :185-207, clipper pin :210-218, scanned-WorkWiki :220-228, maintainer pin :230-255, maintainer-WorkWiki :257-265, maintainer-stray :267-279, predicate case table :281-314, scanned-yopedia :316-324.
- `AGENTS.md` :12 -- read-only. Freezes `YOPEDIA_*`, `WORKWIKI_*`, `workwiki.app`, the `workwiki-*` on-disk family, and "every resource name in both wrangler.jsonc files".

Evidence gathered during planning (a scan harness replaying the proposed lists and predicates over the working tree):

- Union of the widened lists = 540 scanned + 23 maintainer files. Extensions present: `.tsx .ts .css .svg .md .jsonc .json .yaml .html .js .mjs` (+ `Dockerfile`).
- Stray-`workwiki` offenders in the widened scan, all frozen identifiers needing allowlist entries: `integrations/browser-clipper/popup.js:12,13,25` (`workwikiDefaultTags`), `integrations/browser-clipper/service-worker.js:3` (`save-to-workwiki`), `src/components/IntegrationDesk.tsx:114` (`https://hooks.example.com/workwiki`), and one the ledger did not name: `src/app/api/integrations/calendar/route.ts:28` (`filename="workwiki-actions.ics"` — the on-disk export family already covered by the anchored `workwiki-…` pattern, which just needs `actions` in its alternation).
- Stale-`WorkWiki` literal offenders in the widened scan: none.
- `yopedia` offenders after `IDENTIFIER_ALLOWLIST`, once `yopedia.yuanhao-li.workers.dev` is allowlisted (the deployment origin, same class as the already-allowlisted `yopedia.yolog.dev`): `BACKLOG.md:1,3`; `README.md:186,208`; `docs/trusted-memory-roadmap.md:4,94`; `workers/email-ingest/README.md:1,5,20`; `workers/task-consumer/README.md:3,146`; `workers/task-consumer/wrangler.jsonc:2,3,5,13,48`; `wrangler.jsonc:2,92`; `scripts/setup-cloudflare.sh:113,158,159,160,163,240,247`. Exactly these eight paths need exemptions; nothing else in the union offends.
- Roots confirmed to contribute zero yopedia and zero workwiki offenders, so they fold into `scannedSources()` at no cost: `public/`, `journal-site/` (minus `dist/`), `.opencode/commands/` (67 `.md`), `skills/` (one file: `skills/work-wiki-mcp/SKILL.md`).
- Root files DW-243 names: `wrangler.jsonc` (offends → exempt), `package.json`, `mcp.json`, `Dockerfile` (all clean). `workers/*/wrangler.jsonc` and `workers/sandbox-runner/Dockerfile` arrive automatically once `workers/` is walked with the shared filter.
- Non-text assets that must stay excluded: `public/fonts/noto-sc-subset.ttf`, `public/yoyo.png`, `docs/*.png`.
- `vitest.config.ts` -- read-only. `node` project collects `src/**/__tests__/**/*.test.ts`, so this suite runs under `pnpm test`.

## Tasks & Acceptance

**Execution:**
- `src/lib/__tests__/brand-copy.test.ts` -- replace `TS_SOURCES`, `CLIPPER_SOURCES` and `TEXT_SOURCES` with a single `SOURCE_TEXT` regex covering the union of all three plus the types DW-244 names as missing (`.tsx`, `.jsx`, `.mdx`, `.webmanifest`, `.toml`) and the extensionless `Dockerfile`; make it `walk()`'s default `include`. Rationale: one definition means a new file type can no longer be covered by one scan and invisible to another. Keep `MARKDOWN` and `ANY_FILE` — they select listings, not source types.
- `src/lib/__tests__/brand-copy.test.ts` -- extend `scannedSources()` with `public/`, `journal-site/` (skipping `dist/`), `.opencode/commands/` and `skills/`, and let the shared filter widen the existing `workers/` and `integrations/` walks. Rationale: DW-239/DW-240 — each of these roots ships owner- or agent-facing copy and returns zero offenders today, so the strictest scan can hold them.
- `src/lib/__tests__/brand-copy.test.ts` -- drop `public/`, `journal-site/`, `.opencode/commands/` and the `workers/` markdown walk from `maintainerSources()` (now covered by `scannedSources()`), and add the frozen root config files `wrangler.jsonc`, `package.json`, `mcp.json`, `Dockerfile` as an explicit named list. Rationale: DW-243 — the root listing is markdown-only, so AGENTS.md's frozen resource names were read by nothing; root is not walked, so extensionless/`.jsonc` files must be named.
- `src/lib/__tests__/brand-copy.test.ts` -- add a `allBrandSources()` helper returning the de-duplicated union of both lists, and run `saysStaleDisplayName`, `strayWorkwiki` and the yopedia-identifier check over it, replacing the four current per-list scan tests. Rationale: DW-236/DW-238 — a predicate that reads only half the tree is the defect; one union removes the asymmetry by construction rather than by remembering to update two lists.
- `src/lib/__tests__/brand-copy.test.ts` -- add to `WORKWIKI_IDENTIFIER_ALLOWLIST`: a camelCase-identifier pattern covering `workwikiDefaultTags`, the `save-to-workwiki` context-menu id, the `hooks.example.com/workwiki` webhook placeholder, and `actions` in the existing anchored on-disk-artifact alternation for `workwiki-actions.ics`. Rationale: DW-238 — the only real `workwiki` tokens in the app tree; each must be anchored so prose like `the workwiki-first approach` still trips.
- `src/lib/__tests__/brand-copy.test.ts` -- add `yopedia.yuanhao-li.workers.dev` to `IDENTIFIER_ALLOWLIST`. Rationale: the deployment origin derived from the frozen Cloudflare project name, identical in class to the already-listed `yopedia.yolog.dev`; without it `skills/work-wiki-mcp/SKILL.md` could not join the strict scan.
- `src/lib/__tests__/brand-copy.test.ts` -- add `YOPEDIA_PROSE_EXEMPT`, a set of the eight ROOT-relative paths listed in the Code Map, skipped by the yopedia check only (never by the two workwiki checks). Rationale: DW-236 — these carry the deployment's own historical prose, which AGENTS.md tells maintainers not to "fix".
- `src/lib/__tests__/brand-copy.test.ts` -- add an exemption pin test asserting every `YOPEDIA_PROSE_EXEMPT` entry is present in `allBrandSources()` and still carries at least one non-allowlisted `yopedia`. Rationale: an exemption that outlives its need is a silent blanket waiver; this makes removing it the failing path.
- `src/lib/__tests__/brand-copy.test.ts` -- update the two vacuity pin tests to the new lists: keep the clipper canary on `scannedSources()`, move the `public/agent-api.md`, `journal-site/build.mjs`, `workers/sandbox-runner/README.md` and `.opencode/commands` non-empty assertions to the scanned side, add `skills/work-wiki-mcp/SKILL.md`, `wrangler.jsonc` and `workers/task-consumer/wrangler.jsonc`, and keep `tools/…`, `BACKLOG.md`, `docs/…`, `scripts/setup-cloudflare.sh` pinned on `maintainerSources()`. Rationale: every root this bundle adds or moves must fail loudly if it stops contributing.
- `src/lib/__tests__/brand-copy.test.ts` -- extend the `tells a frozen operator identifier apart from a display-brand slip` case table with the four new frozen workwiki spellings and matching near-miss slips (e.g. `the workwiki dashboard`, `Workwiki actions`). Rationale: each widened pattern needs a case proving it did not also start waving prose through.
- `src/lib/__tests__/brand-copy.test.ts` -- update the file's header and per-section comments so they describe the union scan, the shared filter, and the exemption contract. Rationale: the existing comments assert the old split as the reason for the design and would read as false documentation.

**Acceptance Criteria:**
- Given the working tree unchanged, when `pnpm vitest run src/lib/__tests__/brand-copy.test.ts` runs, then every test passes.
- Given `# Yopedia sandbox runner` is planted at `workers/sandbox-runner/README.md:1`, when the suite runs, then the yopedia test fails and its offender list names `workers/sandbox-runner/README.md`.
- Given `// Workwiki local sync` is planted in `src/components/LocalSyncPanel.tsx`, when the suite runs, then the stray-workwiki test fails and names that file with the offending token.
- Given an exempt path is edited so it no longer carries any non-allowlisted `yopedia`, when the suite runs, then the exemption pin test fails.
- Given a `.toml` or `.webmanifest` file carrying `WorkWiki` is added under any scanned root, when the suite runs, then the stale-display-name test fails.
- Given the full suite runs (`pnpm test`), then no other test regresses.

## Design Notes

The shared filter is what forces the union. Once `workers/` is walked with a filter that includes `.md` and `.jsonc`, the workers READMEs and `wrangler.jsonc` land in `scannedSources()` — and they carry grandfathered Yopedia deployment prose. Keeping two lists with two different yopedia rules would mean re-introducing a per-root divergence in the same change that removes one. So the exemption set, not the list membership, is what distinguishes "Yopedia is allowed here" from "it is not", and it is a single visible inventory of every place the old brand survives.

Sketch of the two new pieces:

```ts
const SOURCE_TEXT =
  /(?:^Dockerfile$|\.(?:tsx?|jsx?|mjs|cjs|md|mdx|json|jsonc|css|html|svg|txt|ya?ml|sh|toml|webmanifest)$)/;

/** ROOT-relative paths whose "Yopedia" is this deployment's own history. */
const YOPEDIA_PROSE_EXEMPT = new Set([
  "BACKLOG.md",
  "README.md",
  "wrangler.jsonc",
  path.join("docs", "trusted-memory-roadmap.md"),
  path.join("scripts", "setup-cloudflare.sh"),
  path.join("workers", "email-ingest", "README.md"),
  path.join("workers", "task-consumer", "README.md"),
  path.join("workers", "task-consumer", "wrangler.jsonc"),
]);
```

Offender paths in the union tests should be reported ROOT-relative so one message format covers both lists.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/brand-copy.test.ts` -- expected: all tests pass.
- `pnpm test` -- expected: full node+dom run stays green, no regression elsewhere.
- `pnpm lint` -- expected: no new errors in the changed file.
- Plant-and-revert each of the four I/O matrix regression rows (`workers/sandbox-runner/README.md`, `journal-site/build.mjs`, `public/agent-api.md`, `src/components/LocalSyncPanel.tsx`), confirm the suite fails with the offender named, then `git checkout --` the planted file -- expected: red then green, working tree clean afterwards.

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** `src/lib/__tests__/brand-copy.test.ts` no longer runs its three brand predicates over different slices of the repo. `TS_SOURCES`, `CLIPPER_SOURCES` and `TEXT_SOURCES` collapse into one `SOURCE_TEXT` filter that is `walk()`'s default (adding `.tsx`, `.jsx`, `.mdx`, `.webmanifest`, `.toml` and the extensionless `Dockerfile`); `scannedSources()` gains `public/`, `journal-site/`, `.opencode/commands/` and `skills/`, and its widened `workers/` and `integrations/` walks now read READMEs, `wrangler.jsonc` and `Dockerfile`; `maintainerSources()` sheds the roots that moved and gains the four frozen root config files; and stale-`WorkWiki`, stray-`workwiki` and stray-`yopedia` all run over `allBrandSources()`, the de-duplicated union of both lists. Grandfathered Yopedia deployment prose lives in `YOPEDIA_PROSE_EXEMPT`, a path→occurrence-count map pinned in both directions. Allowlists gained the deployment origin `yopedia.yuanhao-li.workers.dev` and four frozen `workwiki` identifiers (`workwikiDefaultTags`, `save-to-workwiki`, the `hooks.example.com/workwiki` placeholder, `workwiki-actions.ics`), each with a frozen case and a near-miss slip in the case tables. 15 tests, up from 12.

**Files changed.**
- `src/lib/__tests__/brand-copy.test.ts` -- the entire change: one shared source-type filter, widened root lists, union scan, yopedia exemption inventory, widened allowlists, and the vacuity/near-miss pins that keep all of it honest.

**Review findings breakdown.** 8 patches applied (2 high, 2 medium, 4 low); 6 items deferred (1 medium, 5 low, recorded in frontmatter `deferred`); 6 items rejected as noise or pre-existing-and-deliberate (per-test memoisation, symlinked directories, `ANY_FILE`'s binary exposure on `tools/`+`scripts/`, generalising the workers.dev host pattern — which review demonstrated would weaken the guard, `strayYopedia` returning a boolean, and the "allowlist widenings beyond the intent's three" objection, since the fourth identifier and the origin are evidence-backed frozen names without which the named roots cannot be scanned at all). No intent gaps, no spec repairs, no loopbacks.

**Follow-up review recommended: true.** Patched severities: high 2, medium 2, low 4. High count is non-zero, so the flag is true regardless of the score (`3 × 2 + 1 × 4 = 10`, also ≥ 5).

**Verification performed.**
- `./node_modules/.bin/vitest run src/lib/__tests__/brand-copy.test.ts` -- 15/15 pass, 231 ms.
- `./node_modules/.bin/vitest run` -- 259 files, 5599 tests, all pass.
- `./node_modules/.bin/eslint src/lib/__tests__/brand-copy.test.ts` -- exit 0. `./node_modules/.bin/tsc --noEmit` -- exit 0.
- Plant-and-revert, each red-then-green with the offender named: `# Yopedia sandbox runner` in `workers/sandbox-runner/README.md`; `<title>Yopedia Growth Journal</title>` in `journal-site/build.mjs`; `# Using Yopedia as an agent` in `public/agent-api.md`; `// Workwiki local sync` in `src/components/LocalSyncPanel.tsx`; `.toml`/`.webmanifest`/`docs/*.mdx` probes carrying `WorkWiki`.
- Guard-bites-back checks re-run independently after the patch pass: deleting `tsx?|` from `SOURCE_TEXT` → 5 failures naming `src/app/layout.tsx`; narrowing `scanBrandSources()` to `scannedSources()` → 3 failures ("read 541 files but not tools/work-wiki-sync.mjs"); appending a new Yopedia line to `workers/email-ingest/README.md` → exemption count pin fails. All experiments reverted; working tree clean afterwards.
- `pnpm vitest …` fails in this environment with `ERROR packages field missing or empty` (a pnpm invocation quirk unrelated to the change), so the binaries were run directly from `node_modules/.bin`.

**Residual risks.**
- `strayWorkwiki`'s tokeniser was rewritten from `rest.match(/\S*workwiki\S*/gi)` to a whitespace split, because the union feeds it ~370 KB single-run generated vendor bundles and the regex form backtracked quadratically (69 s, past vitest's 5 s per-test timeout). The two select the same substrings and the case table still pins the predicate, but this is a change the spec did not anticipate.
- The union now reads generated and vendored text (`src/lib/vendor/*.generated.ts`, `workers/sandbox-runner/worker-configuration.d.ts`, `workers/sandbox-runner/pnpm-lock.yaml`). They are brand-clean today and offender tokens are truncated, but they contribute most of the scan's read volume.
- The eight exempt paths are still whole-file waivers for their pinned occurrence counts: a maintainer could swap one grandfathered "Yopedia" line for a different one and keep the count. Line-range exemptions would close that; the count pin was the proportionate step here.
