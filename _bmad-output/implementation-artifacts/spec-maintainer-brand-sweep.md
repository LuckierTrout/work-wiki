---
title: 'Maintainer brand sweep: finish WorkWiki → work-wiki display rename (DW-10)'
type: 'chore'
created: '2026-08-16'
status: 'done'
baseline_revision: '2a40851efa70e10ef6d6e697f3fff4137b151c29'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred:
  - summary: >-
      tools/WORKWIKI_SYNC.md filename still carries the old WORKWIKI brand after the sweep.
    evidence: |-
      DW-10's bundle intent authorized renaming only the sync script file. Nothing references
      the doc's path anywhere (repo-wide grep), so renaming it is safe whenever a wider
      filename cut is taken; until then it is the last maintainer-visible old-brand filename
      and the content-only scan can never flag it.
    location: >-
      tools/WORKWIKI_SYNC.md
    severity: low
  - summary: >-
      workers/sandbox-runner/README.md H1 still reads "Yopedia sandbox runner" — stale display
      prose invisible to both brand scans.
    evidence: |-
      DW-10 covers only "WorkWiki" strings. Workers markdown is scanned only by the new
      WorkWiki-only maintainer scan, and the yopedia-identifier test walks workers *.ts only,
      so this heading can never fail a test.
    location: >-
      workers/sandbox-runner/README.md:1
    severity: low
  - summary: >-
      AGENTS.md's frozen-identifier list omits the WORKWIKI_* operator family.
    evidence: |-
      AGENTS.md enumerates only yopedia/YOPEDIA_* identifiers as frozen. WORKWIKI_* env vars,
      .workwiki-source-sync.json, the workwiki-*.zip archive prefix, and the workwiki.app
      origin are equally load-bearing for existing operator setups, and a future brand sweep
      could "fix" them and silently break every operator's environment.
    location: >-
      AGENTS.md:12
    severity: low
  - summary: >-
      public/ served static copy (e.g. public/agent-api.md) is outside both brand scans.
    evidence: |-
      public/agent-api.md is served at the production origin and carries brand-adjacent
      strings (workwiki.app base URL, yopedia identifier examples), but neither
      scannedSources() nor maintainerSources() reads public/, so a stale display-brand
      regression there would ship unseen. Pre-existing coverage gap, not introduced by this
      change.
    location: >-
      public/agent-api.md
    severity: low
  - summary: >-
      DW-91's recorded premise ("nothing references the doc's path") is now stale — the sweep's
      vacuity-guard test pins tools/WORKWIKI_SYNC.md by literal path.
    evidence: |-
      The pin-by-name test in brand-copy.test.ts asserts maintainerSources() contains
      tools/WORKWIKI_SYNC.md, so the future filename cut DW-91 anticipates must also update
      that pin list. The failure would be loud and self-locating, but the ledger entry's
      "safe to rename, nothing references it" evidence no longer holds as written. Existing
      ledger entries are orchestrator-owned, so this is recorded here instead of amending
      DW-91.
    location: >-
      src/lib/__tests__/brand-copy.test.ts
    severity: low
  - summary: >-
      Maintainer-facing surfaces outside the four scan roots remain unscanned: scripts/,
      journal-site/, and .opencode/commands/*.md.
    evidence: |-
      maintainerSources() covers tools/, root markdown, docs/ markdown, and workers/ markdown
      per the bundle intent. scripts/*.sh|*.mjs, journal-site/*.mjs, and .opencode/commands
      markdown are the same class of maintainer tooling and are clean today (repo-wide grep),
      but a "WorkWiki" reintroduced there would be invisible to every test — same class of
      gap as the public/ item already ledgered from this spec.
    location: >-
      src/lib/__tests__/brand-copy.test.ts
    severity: low
  - summary: >-
      A stray empty ~/pnpm-workspace.yaml (outside the repo) breaks every `pnpm <cmd>` on
      this dev machine, including all of this spec's documented verification commands.
    evidence: |-
      pnpm resolves /Users/christianlee/pnpm-workspace.yaml as the workspace root and fails
      with "packages field missing or empty" before running any script. Confirmed during this
      review pass; CI on fresh checkouts is unaffected. Workaround used: invoke
      ./node_modules/.bin/vitest and `node tools/work-wiki-sync.mjs` directly. Deleting or
      populating that stray file restores `pnpm test` / `pnpm sync` / `pnpm lint` locally.
    location: >-
      /Users/christianlee/pnpm-workspace.yaml
    severity: low
---

<intent-contract>

## Intent

**Problem:** The display rename to `work-wiki` (`src/lib/brand.ts:5` APP_NAME) skipped maintainer-facing files: `tools/workwiki-sync.mjs`, `tools/WORKWIKI_SYNC.md`, `BACKLOG.md`, `docs/llm-wiki-functional-parity-roadmap.md`, and `workers/sandbox-runner/README.md` still say "WorkWiki", and the brand scan in `brand-copy.test.ts` never reads those files, so regressions are invisible (DW-10).

**Approach:** Replace every "WorkWiki" display string in those five files with `work-wiki`, rename `tools/workwiki-sync.mjs` → `tools/work-wiki-sync.mjs` (nothing external invokes it by path — only the `package.json` `sync` script does), and add a maintainer-facing scan to `brand-copy.test.ts` that asserts no "WorkWiki" in `tools/`, root markdown, `docs/` markdown, and `workers/` markdown.

## Boundaries & Constraints

**Always:**
- Display copy only. Every runtime identifier stays exactly as shipped: `WORKWIKI_*` env vars, `workwiki.app` origin, `workwiki-backups` default dir, the `workwiki-<timestamp>.zip` archive prefix and its prune regex `/^workwiki-.*\.zip$/`, `.workwiki-source-sync.json`, and all `YOPEDIA_*`/`yopedia` identifiers (AD-7: renaming orphans production data and user setups).
- Rename the script with `git mv` so history follows.
- The new maintainer scan asserts only the absence of `"WorkWiki"` (case-sensitive). Do NOT add these directories to `scannedSources()`: root markdown legitimately carries capital-Y "Yopedia" prose and `yologdev/yopedia` upstream links (AGENTS.md says never "fix" them), which would fail the existing yopedia-identifier test.
- Keep the existing exemption style: exemptions by path, never by widening the identifier allowlist.

**Block If:**
- Any file outside the five listed files plus `package.json` and `src/lib/__tests__/brand-copy.test.ts` would need a content change for the new scan to pass.
- Evidence emerges that something outside the repo invokes `tools/workwiki-sync.mjs` by literal path.

**Never:**
- Don't rename `tools/WORKWIKI_SYNC.md` — the intent authorizes renaming only the sync script file; the doc's all-caps name matches the `WORKWIKI_SYNC_*` env prefix and a case-sensitive "WorkWiki" scan never flags it.
- Don't touch `src/lib/i18n.ts:43` (path-exempt; removal is scheduled with the English-only cleanup), `names-terms.test.ts` fixtures (`__tests__` is excluded from scans), `_bmad-output/`, `.yoyo/`, or the deferred-work ledger.
- Don't fix "Yopedia" prose anywhere (e.g. `workers/sandbox-runner/README.md:1`, `BACKLOG.md:1`) — out of DW-10 scope.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Maintainer scan, clean tree | post-sweep repo | new `"WorkWiki"` assertion passes | No error expected |
| Maintainer scan regression | a scanned file reintroduces "WorkWiki" | test fails listing the offending relative path | vitest failure names offender |
| Existing yopedia test | root markdown NOT in `scannedSources()` | yopedia-identifier test still passes untouched | unchanged |
| `pnpm sync` (no args) | after rename | prints usage headed `work-wiki local sync companion`, exit 0 | unchanged fallback branch |

</intent-contract>

## Code Map

- `tools/workwiki-sync.mjs` — rename target. 4 display strings: L32 `WorkWiki returned ${status}`, L52 `WorkWiki sync status could not be updated`, L167 `WorkWiki pages are never deleted…`, L261 usage header `WorkWiki local sync companion`. All `WORKWIKI_*`/lowercase `workwiki-*` strings in it are identifiers — keep.
- `package.json:15` — `"sync": "node tools/workwiki-sync.mjs"` — the ONLY path reference to the script (verified: no hits in `.github/`, docs use `pnpm sync`, `src/components/LocalSyncPanel.tsx:43-52` emits only env vars + `pnpm sync`).
- `tools/WORKWIKI_SYNC.md` — content fixes: L1 heading, L7 + L14 example path `/Volumes/EncryptedBackup/WorkWiki` → `/Volumes/EncryptedBackup/work-wiki`, L49 "delete WorkWiki pages". Keep env vars, `.workwiki-source-sync.json`, `workwiki-archive.zip`, `YOPEDIA_SERVICE_TOKEN`.
- `BACKLOG.md:168` — one occurrence: "keeping WorkWiki cloud-first".
- `docs/llm-wiki-functional-parity-roadmap.md` — 9 occurrences on L3, L8, L10, L26, L32, L74 (×2), L92 ("WorkWiki-origin window"), L160.
- `workers/sandbox-runner/README.md:4` — "The main WorkWiki Worker".
- `src/lib/__tests__/brand-copy.test.ts` — scan lives here. `walk()` (L48) takes an `include` regex and skips `__tests__`/`node_modules`; `scannedSources()` (L95-110) covers src trees + workers `.ts` + clipper — leave it untouched. Add a `maintainerSources()` beside it and a new `it()` in the `"no stale brand strings in rendered copy"` describe block. Repo root = `path.resolve(SRC, "..")`.
- Verified clean besides the five files: repo-wide `WorkWiki` grep matches only them plus intentionally-excluded `src/lib/i18n.ts`, `__tests__` fixtures, and `_bmad-output/` artifacts.

## Tasks & Acceptance

**Execution:**
1. `tools/workwiki-sync.mjs` — fix the 4 display strings, then `git mv tools/workwiki-sync.mjs tools/work-wiki-sync.mjs` — display rename + filename cut authorized by DW-10 bundle.
2. `package.json` — point `sync` at `tools/work-wiki-sync.mjs` — only path reference.
3. `tools/WORKWIKI_SYNC.md` — replace the 4 "WorkWiki" occurrences (heading, 2 example paths, prose) — display copy.
4. `BACKLOG.md`, `docs/llm-wiki-functional-parity-roadmap.md`, `workers/sandbox-runner/README.md` — replace remaining "WorkWiki" occurrences with `work-wiki` — display copy.
5. `src/lib/__tests__/brand-copy.test.ts` — add `maintainerSources()` (tools/ all files; root `*.md` non-recursive; `docs/**/*.md`; `workers/**/*.md`) and a test asserting no scanned maintainer file contains `"WorkWiki"`, offenders reported as relative paths — makes DW-10 durable; scan roots per bundle intent.

**Acceptance Criteria:**
- Given the swept tree, when `grep -rn "WorkWiki" tools/ docs/ workers/ *.md` runs at repo root, then it returns no matches.
- Given the swept tree, when `pnpm vitest run src/lib/__tests__/brand-copy.test.ts` runs, then every test passes, including the new maintainer scan and the untouched yopedia-identifier test.
- Given the rename, when `pnpm sync` runs with no arguments, then it exits 0 printing usage headed "work-wiki local sync companion".
- Given the new maintainer test with "WorkWiki" temporarily planted in a scanned file (e.g. `BACKLOG.md`), when the brand test runs, then the new assertion fails naming that file (verify once, then revert the plant).

## Spec Change Log

## Review Triage Log

### 2026-08-16 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 2, low 1)
- defer: 4: (high 0, medium 0, low 4)
- reject: 11: (high 0, medium 0, low 11)
- addressed_findings:
  - `[medium]` `[patch]` The new maintainer scan had no vacuity guard — added a pin-by-name test asserting `maintainerSources()` contains all five swept surfaces, mirroring the clipper canary.
  - `[medium]` `[patch]` `package.json` `scripts.sync` ↔ renamed script wiring was pinned by nothing — added a test that resolves the script path from `scripts.sync` and asserts the file exists on disk; either half-reverted side now fails loudly.
  - `[low]` `[patch]` `maintainerSources()` doc comment omitted why the root markdown listing is non-recursive — extended it to record that `_bmad-output/` process artifacts legitimately carry "WorkWiki".

### 2026-08-16 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 1: (high 0, medium 0, low 1)
- defer: 3: (high 0, medium 0, low 3)
- reject: 15: (high 0, medium 0, low 15)
- addressed_findings:
  - `[low]` `[patch]` The `scripts.sync` ↔ script wiring test assumed the command is exactly `node <path>`: a missing `scripts.sync` died with a TypeError and an added runner flag died with a raw ENOENT instead of a named assertion. Rewrote it to guard the entry's presence with a message, resolve the `.mjs` token from the command regardless of flags, and explain the contract on failure.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/brand-copy.test.ts src/lib/__tests__/names-terms.test.ts` — expected: all pass.
- `grep -rn "WorkWiki" tools/ docs/ workers/ *.md` — expected: exit 1, no output.
- `pnpm sync` — expected: exit 0, usage text with `work-wiki` header.
- `pnpm lint` — expected: no new errors.

## Auto Run Result

Status: done

**Summary of implemented change (this pass):** Follow-up review of the completed DW-10 maintainer brand sweep (four parallel review layers: blind hunter, edge-case hunter, verification-gap, intent-alignment). One low-severity patch applied; the swept change itself required no correction.

**Files changed this pass:**
- `src/lib/__tests__/brand-copy.test.ts` — hardened the `scripts.sync` ↔ script wiring test: presence guard with a message, flag-tolerant `.mjs` path resolution, self-explanatory failure text.
- `_bmad-output/implementation-artifacts/spec-maintainer-brand-sweep.md` — triage log entry, three new deferred items, this result.

**Review findings breakdown:** 1 patch applied (low), 3 deferred (all low: stale DW-91 premise now that the vacuity guard pins `tools/WORKWIKI_SYNC.md`; unscanned maintainer surfaces `scripts/`, `journal-site/`, `.opencode/commands/`; stray `~/pnpm-workspace.yaml` breaking local `pnpm`), 15 rejected (intent-mandated behaviors misread as defects — e.g. case-sensitive-scan scope, lowercase-brand prose — plus hypothetical edge cases and orchestrator-owned process-state observations).

**Follow-up review recommendation:** false — patched counts: high 0, medium 0, low 1; score = 3×0 + 1×1 = 1 (< 5).

**Verification performed (this pass):**
- `vitest run src/lib/__tests__/brand-copy.test.ts src/lib/__tests__/names-terms.test.ts` — 16/16 pass (invoked via `./node_modules/.bin/vitest`; see pnpm note below).
- `grep -rn "WorkWiki" tools/ docs/ workers/ *.md` — exit 1, no output.
- `node tools/work-wiki-sync.mjs` (no args) — exit 0, usage headed `work-wiki local sync companion`.
- `eslint` on the patched test file — clean.
- Mutation check re-performed by the verification-gap reviewer: "WorkWiki" planted in `BACKLOG.md` failed the maintainer scan naming the offender; plant reverted.

**Residual risks:**
- `pnpm <cmd>` fails machine-locally ("packages field missing or empty") because of an empty `/Users/christianlee/pnpm-workspace.yaml` outside the repo; CI is unaffected. Deferred for the owner to remove.
- The `pnpm sync` runtime path is verified manually, not by an automated exec test — a syntax error in the script would pass the static suite; tolerated per the intent's chosen verification mechanism.

