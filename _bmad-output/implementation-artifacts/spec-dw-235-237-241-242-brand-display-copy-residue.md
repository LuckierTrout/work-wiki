---
title: 'DW-235/237/241/242: brand display-copy residue and a durable identifier-freeze fact'
type: 'chore'
created: '2026-08-20'
status: 'done'
baseline_revision: '9876d2eeb033dbd8df667acbd58679d4b6fb6db6'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      The browser clipper's shipped product name has no positive coverage: manifest.json's
      name, description and action.default_title, and popup.html's title and heading, are
      read only by the negative brand scans, which pass when a name is absent.
    evidence: |-
      brand-copy.test.ts pins browser-clipper/{popup.html,manifest.json,service-worker.js}
      into the scan corpus, but only for saysStaleDisplayName / strayWorkwiki / strayYopedia,
      all of which fail on a WRONG name and stay silent on a MISSING one. A reviewer edited
      manifest.json to "name": "Clipper" / "default_title": "Save to the app" and popup.html
      to "Save to the app", and the full suite still passed with zero `work-wiki` left in
      either file. This is the same half-renamed state DW-235/DW-237 recorded, on the surface
      with the widest audience — the Chrome extensions list and context menu, persisted inside
      already-installed extensions. Out of this bundle's scope: the intent names only
      scripts/setup-cloudflare.sh and the two Worker READMEs.
    location: >-
      integrations/browser-clipper/manifest.json
    severity: low
  - summary: >-
      AGENTS.md's frozen list still omits three yopedia-side identifiers that IDENTIFIER_ALLOWLIST
      waives: the X-Yopedia-* wire headers and the two deployment origins.
    evidence: |-
      IDENTIFIER_ALLOWLIST (src/lib/__tests__/brand-copy.test.ts) waives X-Yopedia-* headers,
      yopedia.yolog.dev and yopedia.yuanhao-li.workers.dev. The workers.dev origin is what
      skills/work-wiki-mcp/SKILL.md publishes as the MCP endpoint outside agents connect to,
      so renaming it is as breaking as anything already listed. DW-241 scoped completeness to
      the four WORKWIKI_* members only, so the yopedia half was never audited for the same gap.
    location: >-
      AGENTS.md
    severity: low
---

<intent-contract>

## Intent

**Problem:** Two operator-facing surfaces still print the pre-rebrand display name — `scripts/setup-cloudflare.sh:113` banners "yopedia — Cloudflare Infrastructure Setup", and `workers/email-ingest/README.md` says "Yopedia" three times while its sibling `workers/sandbox-runner/README.md` says "work-wiki", so the two Worker READMEs disagree on the product name. Separately, `AGENTS.md:12`'s `WORKWIKI_*` freeze list omits four live members a rename would break, and the whole freeze fact sits inside the `bmad:context` managed block whose own header says inside-block edits are replaced on refresh.

**Approach:** Rewrite only the display-copy occurrences (leaving every Cloudflare resource name and `YOPEDIA_*`/`workwiki-*` identifier byte-for-byte intact), re-pin the two per-occurrence entries in `YOPEDIA_PROSE_EXEMPT`, and move the identifier-freeze statement out of the managed block into its own section below the closing marker, extended with the four call-site-verified members.

## Boundaries & Constraints

**Always:**
- Only these `yopedia`/`Yopedia` occurrences are display copy and may change: `scripts/setup-cloudflare.sh:113`, and `workers/email-ingest/README.md` lines 1, 5 and 20. Every other occurrence in those files is a frozen Cloudflare resource name (`yopedia-raw`, `yopedia-embeddings-bge-m3`, the `yopedia` Pages project on lines 158-163/240/247, `yopedia-email-ingest`) or an env/binding name (`YOPEDIA_CONFIG`, `YOPEDIA_SEARCH`, `YOPEDIA_SERVICE_TOKEN`) and must stay byte-for-byte.
- The replacement display name is `work-wiki`, matching `scripts/setup-cloudflare.sh:2`, `:179` and `workers/sandbox-runner/README.md:1`.
- `YOPEDIA_PROSE_EXEMPT` in `src/lib/__tests__/brand-copy.test.ts` is a per-occurrence pin that fails in both directions: after the edits `scripts/setup-cloudflare.sh` carries 6 and `workers/email-ingest/README.md` carries 0, so the script's count drops to 6 and the README's entry is deleted (a 0-count entry is not allowed — the file rejoins the strict scan).
- Every `WORKWIKI_*` family member added to AGENTS.md prose must be verified at its call site first and must already be waived by `WORKWIKI_IDENTIFIER_ALLOWLIST` in `src/lib/__tests__/brand-copy.test.ts` — the allowlist is the enforcing half, the prose is the explaining half.
- AGENTS.md is inside the brand scan's root-markdown listing, so any identifier spelled out in the new prose must survive `strayWorkwiki`/`strayYopedia`.

**Block If:**
- A `WORKWIKI_*` member named in DW-241 cannot be found at the call site the ledger cites, or is not covered by `WORKWIKI_IDENTIFIER_ALLOWLIST`.

**Never:**
- Do not rename any Cloudflare resource, env/secret, binding, storage key, context-menu id, manifest `format` string, route pattern, or filename prefix — this bundle is display copy and documentation only.
- Do not touch `workers/task-consumer/README.md`, `workers/task-consumer/wrangler.jsonc`, `README.md`, `BACKLOG.md`, `docs/trusted-memory-roadmap.md` or root `wrangler.jsonc`; their Yopedia prose is grandfathered history outside this bundle.
- Do not widen `WORKWIKI_IDENTIFIER_ALLOWLIST` or `IDENTIFIER_ALLOWLIST`; both already cover everything in scope.
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Setup banner | Operator runs `scripts/setup-cloudflare.sh` | Banner reads `🐙 work-wiki — Cloudflare Infrastructure Setup`; every later line still names `yopedia-raw`, `YOPEDIA_CONFIG`, `yopedia-embeddings-bge-m3` and the `yopedia` Pages project unchanged | No error expected |
| Worker README parity | Reader opens both `workers/*/README.md` | Both name the product `work-wiki`; `YOPEDIA_CONFIG`, `yopedia-email-ingest` and `YOPEDIA_SERVICE_TOKEN` remain as written | No error expected |
| Exemption pin, script | `brand-copy.test.ts` counts non-allowlisted `yopedia` in `scripts/setup-cloudflare.sh` | 6, matching the pinned count | Test names the file and both counts |
| Exemption pin, README | `brand-copy.test.ts` iterates `YOPEDIA_PROSE_EXEMPT` | `workers/email-ingest/README.md` is absent from the map and passes the strict scan with 0 strays | Test fails if a dead 0-count entry is left behind |
| AGENTS.md scan | Brand scan reads AGENTS.md from the root markdown listing | New freeze prose is clean: `workwiki-actions.ics`, `workwiki-*.zip`, `workwikiDefaultTags`, `save-to-workwiki`, `www.workwiki.app` are all waived spellings | Scan reports the stray token if a new spelling is invented |

</intent-contract>

## Code Map

- `scripts/setup-cloudflare.sh:113` -- the one display-copy line: `echo "  🐙 yopedia — Cloudflare Infrastructure Setup"`. Lines 119-163 (`yopedia-raw`, `YOPEDIA_CONFIG`/`YOPEDIA_SEARCH`, `yopedia-embeddings-bge-m3`, Pages project `yopedia`) and the summary at 240/247 are frozen. Verified stray count today: 7 (line 113 plus six bare `yopedia` Pages-project references at 158, 159, 160, 163, 240, 247).
- `workers/email-ingest/README.md:1,5,20` -- the three display-copy uses ("Yopedia inbound email Worker", "the main Yopedia Worker", "under Yopedia **Settings → Email ingestion**"). Line 4 `YOPEDIA_CONFIG`, line 21 `yopedia-email-ingest`, line 22 `YOPEDIA_SERVICE_TOKEN` are frozen. Verified stray count today: 3.
- `workers/sandbox-runner/README.md:1,4` -- the sibling that already says `work-wiki` while keeping `YOPEDIA_SANDBOX*`; the wording to match. Read-only.
- `src/lib/__tests__/brand-copy.test.ts:368-377` -- `YOPEDIA_PROSE_EXEMPT`, ROOT-relative path → today's stray count. `:373` is the script (7), `:374` the email-ingest README (3). `:573-595` is the both-directions pin test; `:565-572` is the strict scan that an un-exempted file must pass.
- `src/lib/__tests__/brand-copy.test.ts:190-206` -- `WORKWIKI_IDENTIFIER_ALLOWLIST`. Already waives all four DW-241 members: `/\.?workwiki-(?:source-sync|backups|portable-archive|archive|actions\.ics|[*.$0-9])/` covers `workwiki-actions.ics` and the `workwiki-$`/`workwiki-*` archive prefix, `/\bworkwikiDefaultTags\b/`, `/\bsave-to-workwiki\b/`, `/workwiki\.app/`. No change needed.
- `src/lib/__tests__/prose-inventory-parity.test.ts:215` -- reads `workers/email-ingest/README.md` via the anchor `/([^.<>]+) attachments are forwarded/`, which lives on lines 7-8. The three edited lines do not touch it; do not disturb the "…attachments are forwarded" sentence.
- `AGENTS.md:1-2,30` -- managed-block markers. Line 2: "edits inside this block are replaced on refresh. Keep anything you want preserved outside the markers." Line 30 is `<!-- /bmad:context -->`.
- `AGENTS.md:12` -- the current freeze bullet, inside the managed block.
- Call sites to verify before freezing in prose (all confirmed present today, read-only):
  - `src/app/api/integrations/calendar/route.ts:28` -- `Content-Disposition: attachment; filename="workwiki-actions.ics"` on the iCalendar feed.
  - `src/app/api/archive/export/route.ts:14` -- `filename="workwiki-${date}.zip"`, the same prefix `tools/work-wiki-sync.mjs:57` mints and `:93`'s prune regex `/^workwiki-.*\.zip$/` matches — a second producer of one shared prefix contract.
  - `integrations/browser-clipper/popup.js:12,13,25` -- `chrome.storage.local` key `workwikiDefaultTags`; `integrations/browser-clipper/service-worker.js:3` -- context-menu id `save-to-workwiki`. Both persist inside installed extensions.
  - `wrangler.jsonc:23` -- the `www.workwiki.app` custom-domain route, a separate entry from `workwiki.app` at `:19`.

## Tasks & Acceptance

**Execution:**
- `scripts/setup-cloudflare.sh` -- replace `yopedia` with `work-wiki` on line 113 only -- it is the operator-facing banner, and the file header at line 2 already says `work-wiki`.
- `workers/email-ingest/README.md` -- replace the product name `Yopedia` with `work-wiki` on lines 1, 5 and 20 only -- ends the half-renamed disagreement with `workers/sandbox-runner/README.md:1`.
- `src/lib/__tests__/brand-copy.test.ts` -- lower the `scripts/setup-cloudflare.sh` exemption from 7 to 6 and delete the `workers/email-ingest/README.md` entry entirely -- the pin fails in both directions, and a file with 0 strays must rejoin the strict scan rather than keep a dead waiver.
- `AGENTS.md` -- move the identifier-freeze statement out of the managed block into a new `## Frozen identifiers` section placed immediately after `<!-- /bmad:context -->`, leaving the in-block Policy entry as a fact-free pointer to it -- line 2 declares inside-block content replaceable on refresh, so the durable copy must live outside the markers and must not be duplicated where the two could drift.
- `AGENTS.md` -- in that relocated statement, add the four verified `WORKWIKI_*` members, each with its call site: `workwiki-actions.ics` (`src/app/api/integrations/calendar/route.ts:28`), the `workwiki-<date>.zip` export filename prefix as the second producer of the archive-prefix contract (`src/app/api/archive/export/route.ts:14`), the clipper's `workwikiDefaultTags` storage key and `save-to-workwiki` context-menu id (`integrations/browser-clipper/`), and the `www.workwiki.app` route variant (`wrangler.jsonc:23`); name `WORKWIKI_IDENTIFIER_ALLOWLIST` in `src/lib/__tests__/brand-copy.test.ts` as the machine-checked enforcing half -- prose alone does not stop a rename.

**Acceptance Criteria:**
- Given the edited `scripts/setup-cloudflare.sh`, when the file is read, then line 113 names `work-wiki` and the strings `yopedia-raw`, `YOPEDIA_CONFIG`, `YOPEDIA_SEARCH`, `yopedia-embeddings-bge-m3` and the six bare `yopedia` Pages-project references are unchanged.
- Given the edited `workers/email-ingest/README.md`, when the file is read, then no `Yopedia` display name remains, `YOPEDIA_CONFIG`, `yopedia-email-ingest` and `YOPEDIA_SERVICE_TOKEN` are unchanged, and the sentence anchored by `attachments are forwarded` is untouched.
- Given `pnpm test src/lib/__tests__/brand-copy.test.ts`, when the suite runs, then every test passes, including the both-directions exemption pin and the strict `yopedia` scan that `workers/email-ingest/README.md` now falls under.
- Given `AGENTS.md`, when the region between `<!-- bmad:context -->` and `<!-- /bmad:context -->` is read, then it contains no copy of the freeze list — only a pointer — and the full statement appears below the closing marker.
- Given the relocated statement, when it is read, then it names all four previously omitted members with their call sites alongside the members already listed, and points at `WORKWIKI_IDENTIFIER_ALLOWLIST` as the enforcing half.
- Given `pnpm test` and `pnpm lint`, when both run, then neither reports a new failure.

## Spec Change Log

## Review Triage Log

### 2026-08-20 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 0, medium 3, low 7)
- defer: 2: (high 0, medium 0, low 2)
- reject: 7: (high 0, medium 0, low 7)
- addressed_findings:
  - `[medium]` `[patch]` The banner assertion read the whole script with `toContain`, so a commented-out or dead-code banner passed and a failure dumped 250 lines — now matches the live `echo "…"` line, with a message naming the file and the banner it read.
  - `[medium]` `[patch]` The Worker README list was a restated literal two lines below a docstring disclaiming restated literals — now derived from `readdir(workers/)` with `task-consumer` as the single named exclusion and a floor assertion, so a Worker added later fails closed.
  - `[medium]` `[patch]` DW-242's placement was verified by nothing (no test in the repo reads AGENTS.md) — added a test asserting the `## Frozen identifiers` heading sits below the closing `bmad:context` marker, that the section names at least ten backticked `workwiki` spellings, and that `WORKWIKI_IDENTIFIER_ALLOWLIST` waives each one.
  - `[low]` `[patch]` Five volatile `:NN` line pins in the section built to outlive refreshes — dropped; paths and the exact identifier strings remain, and the two `work-wiki-sync.mjs` references are now named by behaviour (archive namer, prune regex).
  - `[low]` `[patch]` The family list documented six of the seven waived spellings — added the `hooks.example.com/workwiki` IntegrationDesk placeholder, labelled waived-but-not-frozen so the extra allowlist entry does not read as drift.
  - `[low]` `[patch]` The `yopedia` bullet named no enforcing constant while the `WORKWIKI_*` bullet did — `IDENTIFIER_ALLOWLIST` now named in the same sentence style.
  - `[low]` `[patch]` "each pinned at its call site" overstated what exists, in the section whose own closing line says prose does not pin anything — reworded to "each verified at its call site".
  - `[low]` `[patch]` The title check assumed line 1 and passed on `# Yopedia work-wiki inbound email Worker` — now finds the first ATX heading after stripping a BOM and requires both stale spellings absent, and the test is renamed to what it proves.
  - `[low]` `[patch]` Path construction was inconsistent inside one block (`ROOT` vs `path.resolve(SRC, "..")`) — `ROOT` used throughout.
  - `[low]` `[patch]` The block docstring read as a complete inventory of operator surfaces — now states what it covers and names the browser clipper as a known uncovered surface; the file header, which framed the suite as entirely negative, gained a paragraph on the positive checks.

## Design Notes

Why the email-ingest README's exemption is deleted rather than set to 0: the pin test looks up each exempt path in the scanned corpus and asserts `strayYopedia(...).length === expected`; an entry at 0 is explicitly called out in the failure message as "delete the entry if it reached 0 so the file rejoins the scan", and leaving it would mean the file is skipped by the strict `every remaining "yopedia" is a runtime identifier` test forever.

Why the freeze fact is moved rather than copied: the managed-block header promises replacement on refresh, so a copy inside the block is a second source of truth with a scheduled expiry. A fact-free pointer inside the block can go stale in only one way — disappearing — which is harmless.

## Verification

**Commands:**
- `pnpm test src/lib/__tests__/brand-copy.test.ts` -- expected: all tests pass, including `keeps every Yopedia prose exemption earning its place, occurrence by occurrence` and both `workwiki` scans over AGENTS.md.
- `pnpm test src/lib/__tests__/prose-inventory-parity.test.ts` -- expected: passes; the email-ingest README anchor still matches exactly once.
- `pnpm test` -- expected: no new failures relative to the pre-change baseline.
- `pnpm lint` -- expected: clean.
- `git diff --stat` -- expected: exactly four files touched (`scripts/setup-cloudflare.sh`, `workers/email-ingest/README.md`, `src/lib/__tests__/brand-copy.test.ts`, `AGENTS.md`).

## Auto Run Result

Status: done
Blocking condition: none

**Implemented change.** Cleared the last two brand-residue surfaces in display copy and made the AGENTS.md identifier freeze both complete and durable. `scripts/setup-cloudflare.sh` no longer banners the pre-rebrand name at the operator's terminal; `workers/email-ingest/README.md` no longer disagrees with its sibling about the product name; the `WORKWIKI_*` freeze list gained the four members DW-241 named, each checked at its call site first; and the whole freeze statement moved out of the `bmad:context` managed block, which its own header declares replaceable on refresh, into a `## Frozen identifiers` section below the closing marker. Every Cloudflare resource name, env/secret name, storage key, context-menu id, manifest `format` string and route pattern is byte-for-byte unchanged — this bundle touched copy and documentation only.

**Files changed.**
- `scripts/setup-cloudflare.sh` — line 113 banner now names `work-wiki`, matching the file header at line 2. The six bare `yopedia` Pages-project references and every `yopedia-*`/`YOPEDIA_*` resource name are untouched.
- `workers/email-ingest/README.md` — the three display-copy uses (title, "the main … Worker", the Settings pointer) now say `work-wiki`; `YOPEDIA_CONFIG`, `yopedia-email-ingest` and `YOPEDIA_SERVICE_TOKEN` untouched, and the "…attachments are forwarded" sentence that `prose-inventory-parity.test.ts` anchors on is undisturbed.
- `AGENTS.md` — the in-block Policy entry is now a fact-free pointer; the full statement lives in a new `## Frozen identifiers` section below `<!-- /bmad:context -->`, extended with `workwiki-actions.ics`, the `workwiki-*.zip` export filename as the archive-prefix contract's second producer, the clipper's `workwikiDefaultTags` key and `save-to-workwiki` id, and the `www.workwiki.app` route, plus the `hooks.example.com/workwiki` placeholder marked waived-but-not-frozen and both enforcing constants named.
- `src/lib/__tests__/brand-copy.test.ts` — `YOPEDIA_PROSE_EXEMPT` re-pinned (script 7→6; the email-ingest README entry deleted so the file rejoins the strict scan), plus a new `operator-facing surfaces name the product` suite. That suite is the positive counterpart the negative scans lacked: they fail on a wrong name and are silent on a missing one, which is how half a rename stayed green. No allowlist was widened.

**Review findings.** 10 patched (3 medium, 7 low), 2 deferred, 7 rejected. The patches hardened the new tests against going vacuous (a dead banner line, a collapsed `readdir`, a title on line 2), made AGENTS.md's placement and its prose-vs-allowlist claim machine-checked rather than asserted, and removed five volatile line pins from the section whose whole purpose is to outlive edits. Rejected findings were either out of scope on the intent's authority (guarding `setup-cloudflare.sh:2`/`:179`, surfacing `YOPEDIA_PROSE_EXEMPT` in AGENTS.md) or already answered in the design (the in-block pointer is deliberately the disposable half; a duplicated fact inside the block would be a second source of truth with a scheduled expiry).

**Follow-up review recommendation.** true — patched counts high 0, medium 3, low 7; score = 3×3 + 1×7 = 16, at or above the threshold of 5.

**Verification performed.**
- `npx vitest run src/lib/__tests__/brand-copy.test.ts` — 18 passed, including the both-directions exemption pin, both `workwiki` scans over AGENTS.md, and the three new positive checks.
- `npx vitest run src/lib/__tests__/prose-inventory-parity.test.ts` — 16 passed; the email-ingest README anchor still matches exactly once.
- `npx vitest run` — 259 files / 5602 tests, all passing.
- `npx eslint` — exit 0, no errors or warnings.
- `git diff --stat` — the four files this spec names, and no others.
- Mutation checks by the implementer, each planted and reverted: commenting out the banner `echo` fails the banner test; moving `## Frozen identifiers` back inside the markers fails the AGENTS.md test; retitling the README `# Yopedia work-wiki inbound email Worker` fails both the title test and the strict yopedia scan.
- Every matrix row is covered by a test that ran and passed: the banner and README rows by the new positive suite, the two exemption rows by the both-directions pin, the AGENTS.md row by the union `workwiki` scans plus the new placement test.

**Residual risks.**
- `pnpm test` and `pnpm lint` fail in this checkout with `ERROR packages field missing or empty` — a stray `/Users/christianlee/pnpm-workspace.yaml` in the home directory makes pnpm treat the repo as an empty workspace. Pre-existing and environmental; the same suites were run through `npx` instead. Worth deleting that file if it is not intentional, since it breaks `pnpm <script>` for every project under that home directory.
- The durability guard proves the section sits below the marker; it cannot stop a refresh from deleting it. If `bmad-project-context` ever does regenerate rather than re-verify, the in-block pointer disappears and the section is reachable only by reading the file — which is how agents read AGENTS.md anyway.
- The clipper's shipped product name remains covered only by the negative scans (deferred item 1), so a name deleted there still ships green.
