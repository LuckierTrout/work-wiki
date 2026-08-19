---
title: 'Brand scan coverage and residue: finish the maintainer sweep (DW-91..DW-96)'
type: 'chore'
created: '2026-08-19'
baseline_revision: '462ec7648325e3d43eb23bb097696e5960c7672a'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      scripts/setup-cloudflare.sh:113 prints the stale display brand
      "yopedia — Cloudflare Infrastructure Setup" to the operator's terminal.
    evidence: |-
      Same class as the `# Yopedia sandbox runner` heading this bundle fixed, but in a
      root the intent authorized scanning, not editing. The surrounding `yopedia-raw`,
      `yopedia-embeddings-bge-m3` etc. on lines 119-163 are Cloudflare resource names and
      must stay frozen; only the line-113 banner is display copy.
    location: >-
      scripts/setup-cloudflare.sh:113
    severity: low
  - summary: >-
      DW-92's fix has no regression guard — "Yopedia" display prose can return to any
      maintainer surface with CI green.
    evidence: |-
      Both maintainer scans test only `workwiki` spellings. Confirmed during review by
      restoring `# Yopedia sandbox runner` at workers/sandbox-runner/README.md:1 and by
      planting `<title>Yopedia Growth Journal</title>` in journal-site/build.mjs and
      `# Using Yopedia as an agent` in public/agent-api.md: all 12 tests still passed. A
      Yopedia dimension over maintainer roots needs per-path exemptions for the prose in
      README.md:186,208, BACKLOG.md:1,3, docs/trusted-memory-roadmap.md:4,94 and
      workers/email-ingest/README.md:1,5,19, which this bundle's intent does not authorize.
    location: >-
      src/lib/__tests__/brand-copy.test.ts
    severity: medium
  - summary: >-
      workers/email-ingest/README.md still says "Yopedia", so the two Worker READMEs in
      workers/ now disagree on the product name.
    evidence: |-
      Lines 1, 5 and 19. Out of this bundle's scope — the intent names only
      workers/sandbox-runner/README.md:1 — but the pair now reads half-renamed.
    location: >-
      workers/email-ingest/README.md:1
    severity: low
  - summary: >-
      The stronger stray-workwiki rule guards only maintainer docs; the shipped app tree
      still uses the case-sensitive literal check.
    evidence: |-
      `hasStrayWorkwiki` runs over `maintainerSources()` only, while `scannedSources()`
      (src/app, src/components, workers/, the browser clipper) keeps `saysStaleDisplayName`
      alone. Confirmed by planting `// Workwiki local sync` in
      src/components/LocalSyncPanel.tsx: suite stayed green. Extending the predicate to
      `scannedSources()` needs three more allowlist entries for real identifiers found
      there: `workwikiDefaultTags` (integrations/browser-clipper/popup.js:12,13,25),
      `save-to-workwiki` (integrations/browser-clipper/service-worker.js:3), and the
      `https://hooks.example.com/workwiki` placeholder (src/components/IntegrationDesk.tsx:114).
    location: >-
      src/lib/__tests__/brand-copy.test.ts
    severity: medium
  - summary: >-
      This spec's stated reason for keeping the four new roots out of scannedSources() is
      wrong for three of them.
    evidence: |-
      The intent-contract says they "carry capital-Y Yopedia prose and yologdev/yopedia
      links that would fail the yopedia-identifier test". Running IDENTIFIER_ALLOWLIST over
      each root during review gave zero offenders for public/, journal-site/ and
      .opencode/commands/ — journal-site/build.mjs:11-12's yologdev/yopedia links are
      already allowlisted. Only scripts/setup-cloudflare.sh actually offends. The exclusion
      still stands on the intent's authority (it says extend maintainerSources()), but
      public/ and journal-site/ could be folded into scannedSources() today at no cost.
    location: >-
      src/lib/__tests__/brand-copy.test.ts
    severity: low
  - summary: >-
      skills/work-wiki-mcp/SKILL.md is hand-authored, brand-named, and read by no scan.
    evidence: |-
      Tracked in git and literally named for the product, yet skills/ is in neither
      scannedSources() nor maintainerSources(). Same class as the public/ gap this bundle
      closed; the root simply was not named in the intent.
    location: >-
      skills/work-wiki-mcp/SKILL.md
    severity: low
  - summary: >-
      AGENTS.md's frozen list still omits four live WORKWIKI_* family members.
    evidence: |-
      `workwiki-actions.ics` (src/app/api/integrations/calendar/route.ts:28), the export
      filename prefix (src/app/api/archive/export/route.ts:14), the clipper's
      `workwikiDefaultTags` storage key and `save-to-workwiki` context-menu id
      (integrations/browser-clipper/), and the `www.workwiki.app` variant. The intent
      enumerated four items; `workwiki-portable-archive` was patched in during review
      because a rename there breaks re-import of archives already on disk. The rest need
      per-item verification before being frozen in prose.
    location: >-
      AGENTS.md:12
    severity: low
  - summary: >-
      The DW-93 freeze fact lives inside a managed block whose own header says
      inside-block edits are replaced on refresh.
    evidence: |-
      AGENTS.md:2 reads "edits inside this block are replaced on refresh. Keep anything you
      want preserved outside the markers", while bmad-project-context's Refresh step
      re-verifies existing lines rather than regenerating. The intent asked for the managed
      block, so placement follows the intent; but whether the fact survives depends on
      which behavior the next refresh actually has. The machine-checked
      WORKWIKI_IDENTIFIER_ALLOWLIST is the durable half of the guard.
    location: >-
      AGENTS.md:2
    severity: low
  - summary: >-
      wrangler.jsonc files and root non-markdown are unscanned though AGENTS.md freezes
      their resource names.
    evidence: |-
      maintainerSources() walks workers/ for markdown only, and the root listing is
      markdown-only, so wrangler.jsonc, workers/*/wrangler.jsonc, package.json, mcp.json
      and Dockerfile are read by nothing. AGENTS.md explicitly calls "every resource name
      in both wrangler.jsonc files" frozen.
    location: >-
      src/lib/__tests__/brand-copy.test.ts
    severity: low
  - summary: >-
      Three overlapping extension filters with no shared definition; each omits types the
      others cover.
    evidence: |-
      TEXT_SOURCES covers .svg but not .tsx/.mdx/.webmanifest/.toml; CLIPPER_SOURCES covers
      .js/.html but not .svg, so a clipper icon carrying brand text goes unread. Because
      the pin test anchors only one file per root, adding a file of an uncovered type
      shrinks coverage with no test failure.
    location: >-
      src/lib/__tests__/brand-copy.test.ts:116
    severity: low
  - summary: >-
      tools/work-wiki-sync.md is reachable from nothing but the test's pin list.
    evidence: |-
      No README, DEPLOY.md, AGENTS.md or UI surface links to the operator sync doc;
      src/components/LocalSyncPanel.tsx:42-44 emits the env commands inline and points
      nowhere. Pre-existing under the old filename too, but the rename was the natural
      moment to add the one link that makes it discoverable.
    location: >-
      tools/work-wiki-sync.md
    severity: low
---

<intent-contract>

## Intent

**Problem:** The DW-10 maintainer brand sweep left residue its own scans structurally cannot see: `tools/WORKWIKI_SYNC.md` still carries the old brand in its *filename* (DW-91), `workers/sandbox-runner/README.md:1` still reads "Yopedia sandbox runner" (DW-92), AGENTS.md's frozen-identifier list names only the `yopedia`/`YOPEDIA_*` family and omits the equally load-bearing `WORKWIKI_*` operator family (DW-93), and `maintainerSources()` never reads `public/`, `scripts/`, `journal-site/`, or `.opencode/commands/` (DW-94, DW-96). DW-95 records that DW-91's "nothing references the doc's path" premise is stale — `brand-copy.test.ts:161` pins it by literal path.

**Approach:** Cut the last old-brand filename (`git mv` + move its pin in the same change), fix the one Yopedia display heading this bundle authorizes, record the `WORKWIKI_*` family as frozen in AGENTS.md's managed block, and widen `maintainerSources()` over the four missing roots — strengthening its assertion from the literal `"WorkWiki"` to any `workwiki` spelling that is not a frozen operator identifier, with that family whitelisted by string.

## Boundaries & Constraints

**Always:**
- Every runtime identifier stays byte-identical (AD-7): `WORKWIKI_*` env names, the `workwiki.app` origin, `.workwiki-source-sync.json`, `workwiki-backups`, the `workwiki-<timestamp>.zip` prefix and its prune regex, and all `YOPEDIA_*`/`yopedia` identifiers.
- Rename the doc with `git mv` so history follows, and update `brand-copy.test.ts`'s pin list in the same change (DW-95) so the suite never goes red between the two edits.
- AGENTS.md's frozen list is edited **inside** the `<!-- bmad:context -->` managed block, on the existing display-only policy line — a `bmad-project-context` refresh re-verifies that line rather than dropping it, so the fact survives.
- The new AGENTS.md text must itself use only allowlisted spellings, because root markdown is a scanned maintainer source.

**Block If:**
- Any file outside those named in the Code Map would need a content change for the widened scan to pass.
- Evidence emerges that something outside the repo references `tools/WORKWIKI_SYNC.md` by literal path.

**Never:**
- Don't fix "Yopedia" prose anywhere except `workers/sandbox-runner/README.md:1` — `BACKLOG.md:1`, `README.md`, `docs/trusted-memory-roadmap.md`, and `workers/email-ingest/README.md` keep theirs (out of scope, and AGENTS.md says never "fix" upstream links).
- Don't add these roots to `scannedSources()` — they carry capital-Y "Yopedia" prose and `yologdev/yopedia` links that would fail the yopedia-identifier test.
- Don't touch `_bmad-output/`, `.yoyo/`, the deferred-work ledger, or `src/lib/i18n.ts`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Widened scan, clean tree | post-change repo | all `brand-copy.test.ts` tests pass | No error expected |
| Frozen identifier present | `public/agent-api.md` carries `https://workwiki.app` | allowlisted, not an offender | No error expected |
| Display regression, new root | `"WorkWiki"` planted in `public/agent-api.md` | scan fails naming `public/agent-api.md` | vitest failure names offender |
| Case-variant regression | `"Workwiki"` planted in `scripts/setup-cloudflare.sh` | frozen-identifier scan fails naming it | vitest failure names offender |
| Root goes vacuous | a filter stops matching a new root | pin test fails naming the missing root | vitest failure names the root |

</intent-contract>

## Code Map

- `tools/WORKWIKI_SYNC.md` — rename target → `tools/work-wiki-sync.md` (pairs with `tools/work-wiki-sync.mjs`). Content is already brand-clean; its `WORKWIKI_SYNC_*` env vars, `.workwiki-source-sync.json`, and `workwiki-archive.zip` are frozen identifiers — keep verbatim.
- Path references to that doc, repo-wide: **exactly one** — `src/lib/__tests__/brand-copy.test.ts:161`. Verified: `src/components/LocalSyncPanel.tsx:43-44` and `tools/work-wiki-sync.mjs` mention only the `WORKWIKI_SYNC_*` env prefix, never the doc path; remaining hits are `_bmad-output/` artifacts (out of scope).
- `workers/sandbox-runner/README.md:1` — `# Yopedia sandbox runner` → `# work-wiki sandbox runner`. Lines 11/15-18 (`YOPEDIA_SANDBOX*`) and line 16's backticked `` `yopedia` `` Worker name are identifiers — keep.
- `AGENTS.md:12` — the display-only policy line inside the managed block; currently lists only the `yopedia` family. Append the frozen `WORKWIKI_*` operator family here.
- `src/lib/__tests__/brand-copy.test.ts` — `walk()` L48 (skips `__tests__`/`node_modules`), `MARKDOWN`/`ANY_FILE` L105-106, `maintainerSources()` L121-131, pin test L154-168, `'no maintainer-facing file says "WorkWiki"'` L170-178. `IDENTIFIER_ALLOWLIST` L22-36 is the style to mirror for the new allowlist. Leave `scannedSources()` untouched.
- New-root survey (evidence for the whitelist): the only `workwiki` spelling in `public/`, `scripts/`, `journal-site/`, `.opencode/commands/` is `public/agent-api.md:11` `` `https://workwiki.app` ``. Zero `"WorkWiki"` hits in all four.
- Existing-root survey: every `workwiki` spelling across `tools/`, root `*.md`, `docs/`, `workers/` falls in one of four shapes — `WORKWIKI_[A-Z0-9_]*` (env), `workwiki.app` (origin), `workwiki-<lowercase>` (`.workwiki-source-sync.json`, `workwiki-backups`, `workwiki-*.zip`, the prune regex), and nothing else.
- Generated output: `journal-site/dist/` is gitignored build output that a recursive walk would read locally but never in CI — exclude it.

## Tasks & Acceptance

**Execution:**
1. `tools/WORKWIKI_SYNC.md` — `git mv tools/WORKWIKI_SYNC.md tools/work-wiki-sync.md`; content unchanged — cuts the last old-brand filename (DW-91).
2. `src/lib/__tests__/brand-copy.test.ts` — in the pin list, replace `path.join("tools", "WORKWIKI_SYNC.md")` with `path.join("tools", "work-wiki-sync.md")` — same change as task 1 so the suite is never red between them (DW-95).
3. `workers/sandbox-runner/README.md` — L1 heading `Yopedia` → `work-wiki` — display prose (DW-92).
4. `AGENTS.md` — extend the managed-block display-only policy line with the frozen `WORKWIKI_*` operator family: env names, `.workwiki-source-sync.json`, `workwiki-backups`, the `workwiki-*.zip` prefix, and the `workwiki.app` origin — stops a future sweep from breaking operator setups (DW-93).
5. `src/lib/__tests__/brand-copy.test.ts` — add a text-file filter and extend `maintainerSources()` with `public/`, `scripts/` (all files, like `tools/`), `journal-site/`, and `.opencode/commands/*.md`; skip `dist` in `walk()`; add a `WORKWIKI_IDENTIFIER_ALLOWLIST` and a test asserting every remaining `workwiki` spelling is a frozen identifier; extend the pin test with one anchor per new root — closes DW-94 and DW-96.

**Acceptance Criteria:**
- Given the changed tree, when `vitest run src/lib/__tests__/brand-copy.test.ts src/lib/__tests__/names-terms.test.ts` runs, then every test passes, including the untouched `scannedSources()` yopedia-identifier test.
- Given the changed tree, when `git log --follow --oneline tools/work-wiki-sync.md` runs, then history predating the rename is listed.
- Given the changed tree, when `grep -rn "WORKWIKI_SYNC.md" src/ tools/ workers/ docs/ *.md` runs, then it returns no matches.
- Given `AGENTS.md` after task 4, when the widened maintainer scan runs, then AGENTS.md is not an offender (its new text uses only allowlisted spellings).
- Given `"WorkWiki"` temporarily planted in `public/agent-api.md`, when the brand test runs, then the maintainer scan fails naming `public/agent-api.md` (verify once, then revert the plant).

## Spec Change Log

## Review Triage Log

### 2026-08-19 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 9: (high 0, medium 2, low 7)
- defer: 11: (high 0, medium 2, low 9)
- reject: 10: (high 0, medium 0, low 10)
- addressed_findings:
  - `[medium]` `[patch]` `/workwiki-[a-z-]*/g` was a wildcard that silently allowlisted display prose ("workwiki-first") while its comment named three artifacts — anchored it to the documented shapes.
  - `[medium]` `[patch]` `/\bWORKWIKI[A-Z0-9_]*\b/g` waved a shouted display name ("## WORKWIKI SETUP") through, and "display copy is never shouted" stops holding once markdown roots are scanned — required the env-name underscore.
  - `[low]` `[patch]` The `dist` skip was global, so a future `dist/` under `src/`, `integrations/` or `workers/` would drop out of `scannedSources()` unnoticed — made it a per-call `skipDirs` argument used only by the `journal-site` walk, and moved its rationale comment off the pre-existing `__tests__`/`node_modules` line.
  - `[low]` `[patch]` `'no scanned source says "WorkWiki"'` kept an inline `.includes("WorkWiki")` after the rule was extracted — routed it through `saysStaleDisplayName` so one definition governs both scans.
  - `[low]` `[patch]` The stray-workwiki scan reported bare file paths, leaving the reader to re-grep for the offending token — added `strayWorkwiki()` returning the surviving matches, now included in each offender entry.
  - `[low]` `[patch]` The predicate test asserted only the `hasStrayWorkwiki` half of its own strict-subset claim — added the `saysStaleDisplayName` negatives and a `workwiki-first` case that guards the tightened regex.
  - `[low]` `[patch]` The vacuity pin named `.opencode/commands/bmad-build.md`, an installer-owned filename whose upstream rename would fail this suite for a non-brand reason — replaced with a named non-emptiness assertion for that root.
  - `[low]` `[patch]` The `maintainerSources()` comment claimed the journal site's CSS and JS carry rendered headings; only `build.mjs` does — reworded.
  - `[low]` `[patch]` AGENTS.md's new frozen list omitted `workwiki-portable-archive`, the archive manifest `format` string whose rename breaks re-import of archives already on operators' disks — added with its file reference and failure mode.

## Design Notes

The widened assertion mirrors the existing yopedia-identifier test: strip allowlisted identifier spellings, then fail on anything left.

```ts
const WORKWIKI_IDENTIFIER_ALLOWLIST = [
  /\bWORKWIKI[A-Z0-9_]*\b/g,  // env/secret names — display copy is never shouted
  /workwiki\.app/g,           // the production origin
  /workwiki-[a-z-]*/g,        // .workwiki-source-sync.json, workwiki-backups, workwiki-*.zip
];
```

`"WorkWiki"` matches none of them, so the old literal check stays a strict subset — keep that test too, since it gives the common regression a crisper failure message.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/brand-copy.test.ts src/lib/__tests__/names-terms.test.ts` — expected: all pass. (Local workaround: `./node_modules/.bin/vitest run …` — a stray `~/pnpm-workspace.yaml` breaks `pnpm` on this machine; CI is unaffected.)
- `git status --porcelain` after the `git mv` — expected: shows `R  tools/WORKWIKI_SYNC.md -> tools/work-wiki-sync.md`.
- `pnpm lint` — expected: no new errors.

## Auto Run Result

Status: done

**Summary of implemented change:** Closed the DW-10 brand sweep's last residue and widened the maintainer scan so the same class of residue cannot return unseen. The old-brand doc filename is cut, the one authorized Yopedia heading is fixed, the `WORKWIKI_*` operator family is recorded as frozen in AGENTS.md's managed block, and `maintainerSources()` now reads `public/`, `scripts/`, `journal-site/` and `.opencode/commands/*.md` under a strengthened rule: any `workwiki` spelling that is not a frozen operator identifier is an offender, with the frozen family whitelisted by string rather than flagged.

**Files changed:**
- `tools/WORKWIKI_SYNC.md` → `tools/work-wiki-sync.md` — `git mv`, content byte-identical (`R100`); pairs the operator doc with `tools/work-wiki-sync.mjs` (DW-91).
- `src/lib/__tests__/brand-copy.test.ts` — moved the doc pin in the same change (DW-95); extended `maintainerSources()` over four new roots (DW-94, DW-96); added `WORKWIKI_IDENTIFIER_ALLOWLIST`, the `saysStaleDisplayName` / `strayWorkwiki` predicates, the frozen-identifier scan, a predicate-discrimination test, and one vacuity anchor per new root; gave `walk()` a per-call `skipDirs` for `journal-site/dist`.
- `workers/sandbox-runner/README.md` — H1 `Yopedia` → `work-wiki` (DW-92).
- `AGENTS.md` — the managed-block display-only policy line now also freezes the `WORKWIKI_*` family: env/secret names, the `workwiki.app` origin, `.workwiki-source-sync.json`, `workwiki-backups`, the `workwiki-*.zip` prefix with its prune regex, and the `workwiki-portable-archive` manifest format string (DW-93).

**Review findings breakdown:** 9 patches applied (medium 2, low 7), 11 deferred (medium 2, low 9), 10 rejected (all low — speculative brand spellings, pre-existing `walk()` ENOENT/symlink shapes, intent-mandated scope such as `.opencode/commands/*.md`, and a suggestion to restamp the managed block's `Verified …` provenance line, which would falsely claim a `bmad-project-context` run happened).

**Follow-up review recommendation:** true — patched counts: high 0, medium 2, low 7; score = 3×2 + 1×7 = 13 (≥ 5).

**Verification performed:**
- `vitest run src/lib/__tests__/brand-copy.test.ts src/lib/__tests__/names-terms.test.ts` — 18/18 pass.
- Full suite — 234 files, 4873 tests, all pass. `next lint` — no warnings or errors.
- `grep -rn "WORKWIKI_SYNC.md" src/ tools/ workers/ docs/ *.md` — no matches.
- `git status --porcelain` — shows the rename as `R  tools/WORKWIKI_SYNC.md -> tools/work-wiki-sync.md`.
- Mutation check on the new predicate test: adding `/workwiki/gi` to the allowlist failed that test and only that test, so it is not vacuous.
- Plant-and-revert probes, each reverted clean: `"WorkWiki"` in `public/agent-api.md` and `"Workwiki"` in `scripts/setup-cloudflare.sh` both fail the scans naming the file and the offending token; `"workwiki-first"` prose in `docs/` fails after the regex tightening; a `dist/` under `src/` is now caught while `journal-site/dist/` stays skipped; a filter matching nothing under `.opencode/commands` fails the named vacuity assertion.

**Residual risks:**
- `git log --follow tools/work-wiki-sync.md` only reports pre-rename history once the rename is committed; `git log -- tools/WORKWIKI_SYNC.md` confirms the ancestry it will pick up.
- The Yopedia display brand remains unguarded on every maintainer surface, and the stronger stray-workwiki rule still does not cover the shipped app tree — both ledgered above, both demonstrated during review rather than assumed.
- AGENTS.md's frozen-identifier prose sits inside a block its own header describes as regenerated on refresh; the test's allowlist is the durable half of that guard.
