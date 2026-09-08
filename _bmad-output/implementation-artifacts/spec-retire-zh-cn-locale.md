---
title: 'Retire the zh-CN locale and its runtime plumbing'
type: 'chore'
created: '2026-08-16'
status: 'done'
baseline_revision: 'b973abc7c3fee446e3122cb02d85b134f18da017'
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `pnpm` cannot run any script in this repo, so the documented verification
      commands (`pnpm test`, `pnpm lint`) are unusable.
    evidence: |-
      `pnpm test` exits with `ERROR packages field missing or empty`. The cause is
      a stray `/Users/christianlee/pnpm-workspace.yaml` (an `allowBuilds:` stub
      with no `packages:` key) that pnpm picks up as a workspace root for every
      project under the home directory. Pre-existing and machine-local — not
      introduced by this change. Verification here ran the verbatim script bodies
      (`npx vitest run`, `npx eslint`) instead.
    location: >-
      /Users/christianlee/pnpm-workspace.yaml
    severity: medium
  - summary: >-
      `<html lang>` is now unconditionally `"en"` while the wiki deliberately
      stores CJK and other non-English source content, so assistive technology
      announces those pages as English.
    evidence: |-
      `src/lib/slugify.ts`, `src/lib/bm25.ts` and `src/lib/ingest.ts` all preserve
      CJK by design, and nothing sets `lang` on the article or Preview subtree.
      Pre-existing rather than caused by this change — the old value tracked the
      UI locale, not the content language, so it was equally wrong — but the
      retirement removes the last place where a per-content `lang` could have been
      derived.
    location: >-
      src/app/layout.tsx:70
    severity: low
  - summary: >-
      The `walk()` test helper is now copy-pasted across five suites with
      inconsistent directory exclusions, so the scans silently cover different
      file sets.
    evidence: |-
      `brand-copy.test.ts`, `single-ia.test.ts`, `workbench-left-column.test.ts`,
      `workbench-data-version.test.ts` and the new `english-only.test.ts` each
      define their own `walk()`; only some skip `node_modules`, and the include
      filters differ. A shared `__tests__` helper would stop a future scan from
      looking thorough while reading a narrower tree.
    location: >-
      src/lib/__tests__/
    severity: low
  - summary: >-
      No test renders the root layout or the nav, so the app shell's provider
      tree is guarded only by source-text reads.
    evidence: |-
      `src/app/layout.tsx` is re-nested by hand whenever a provider is added or
      removed, but no suite imports it — the only assertions that touch it are
      `readFile` scans in `brand-copy.test.ts` and `english-only.test.ts`. If
      `<ClerkProvider>` or `<ClientProviders>` were dropped along with a wrapper,
      `npx tsc --noEmit`, `npx eslint` and the full Vitest run all stay green.
      The same holds for `NavHeader`, which no test renders. Pre-existing: the
      shell has never had a mounted test. The repo already has a jsdom vitest
      project (`vitest.config.ts`, `name: "dom"`) with four mounted suites, so
      the missing coverage is a gap, not a constraint.
    location: >-
      src/app/layout.tsx
    severity: medium
---

<intent-contract>

## Intent

**Problem:** `src/lib/i18n.ts` ships a zh-CN catalog keyed on exact English source strings. The chrome was renamed, so keys like "The commons", "What is WorkWiki" and "Browse all" no longer match and silently fall back to English; keys for deleted UI are unreachable; and line 43 still ships the stale "WorkWiki" brand as rendered copy — hidden from the brand scan only by a path exemption in `brand-copy.test.ts`. The recorded user preference (AGENTS.md) is English-only, so the module is dead weight that degrades to English anyway.

**Approach:** Delete the localisation feature outright — the `i18n` module, `LocaleProvider`, `LocaleSwitcher`, the locale cookie read and provider wrapper in the root layout, the `.locale-switcher` stylesheet rules, the now-inert `data-no-localize` opt-out markers that existed solely for `LocaleProvider`'s DOM observer, and the brand-scan path exemption that shielded `i18n.ts`.

## Boundaries & Constraints

**Always:** The app renders English only; `<html lang>` is the literal `"en"`. After the change, no file under `src/` references `i18n`, `LocaleProvider`, `LocaleSwitcher`, `InterfaceLocale`, `data-no-localize`, or `workwiki_locale`. The brand scan in `brand-copy.test.ts` must cover every file it previously exempted — the exemption is removed, never replaced by a widened allowlist. `pnpm test` and `pnpm lint` pass.

**Block If:** A surface turns out to depend on `LocaleProvider`'s context for something other than translation (i.e. removing it changes non-locale behaviour).

**Never:** Do not add a replacement i18n mechanism, a language picker, or a second locale. Do not touch the Settings "Interface → Language" row, which already reads a static "English" with no picker. Do not edit the deferred-work ledger. Do not widen `IDENTIFIER_ALLOWLIST` in `brand-copy.test.ts`. Do not rename runtime identifiers (`yopedia` stays).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Fresh visit | No cookies | Page renders English; `<html lang="en">` | No error expected |
| Stale locale cookie | Browser still holds `workwiki_locale=zh-CN` | Cookie is never read; page renders English; nothing throws | No error expected |
| Brand scan | `src/lib/i18n.ts` deleted, exemption removed | `no scanned source says "WorkWiki"` passes with an empty offender list over the full unexempted file set | Test fails loudly if any scanned source still says "WorkWiki" |

</intent-contract>

## Code Map

- `src/lib/i18n.ts` -- DELETE. Whole module: `InterfaceLocale`, `INTERFACE_LOCALE_COOKIE` (`"workwiki_locale"`), the `zhCN` map (:5-168, stale "WorkWiki" at :43), `normalizeInterfaceLocale`, `translateInterface`. No importers remain after the edits below.
- `src/lib/__tests__/i18n.test.ts` -- DELETE. Only tests the deleted module.
- `src/components/LocaleProvider.tsx` -- DELETE. Exports `LocaleProvider`, `useInterfaceLocale`, `LocalizedSurface` (:191, verified zero importers repo-wide). :44 is the sole reader of `[data-no-localize]`.
- `src/components/LocaleSwitcher.tsx` -- DELETE. Only consumer of `useInterfaceLocale`.
- `src/components/NavHeader.tsx` -- Drop the `LocaleSwitcher` import (:13) and its render site (:135).
- `src/app/layout.tsx` -- Drop the `LocaleProvider` import (:10), the `next/headers` `cookies` import (:11, no other use), the `i18n` import (:12), the cookie read (:78), and the `<LocaleProvider>` wrapper (:92, :102). Set `lang="en"` at :81. `RootLayout` has no remaining `await` — drop `async`.
- `src/app/globals.css` -- Delete `.locale-switcher` (:3-6), `.locale-switcher select` (:174-184) and `.locale-switcher select:focus-visible` (:186-189). No other consumer.
- `src/lib/__tests__/brand-copy.test.ts` -- Delete `BRAND_SCAN_EXEMPT` (:92) with its doc comment (:86-91) and the `.filter(...)` at :109 so `scannedSources()` returns the full list.
- `data-no-localize` sites (attribute only, plus the comments that name the deleted modules): `src/components/workbench/IconRail.tsx` (:21 comment, :92), `SettingsNav.tsx` (:21-23 comment, :34), `ModeCanvas.tsx` (:49-51 and :63-66 comments, :73), `SettingsCanvas.tsx` (:556), `WikiSwitcher.tsx` (:146), `SplitHandle.tsx` (:80), `PreviewColumn.tsx` (:390), `TreePanel.tsx` (:261), `Workbench.tsx` (:507, :570, :650).
- `src/lib/__tests__/workbench-chrome.test.ts` -- :68-70 asserts `data-no-localize` on IconRail; remove that assertion and its comment. Leave the rest of the `IconRail` case intact.
- `src/lib/__tests__/workbench-settings.test.ts` -- :1529 asserts `data-no-localize` on SettingsNav; remove that line. Its `:1560-1565` "Language as English with no picker" case already asserts `not.toContain("zh-CN")` / `not.toContain("InterfaceLocale")` — KEEP, it now guards the retirement.
- `src/lib/__tests__/english-only.test.ts` -- NEW. Covers matrix rows 1 and 2 (literal `lang="en"`; no locale cookie read anywhere) and pins the retirement against reintroduction, in the same source-scan style as `single-ia.test.ts`.
- Read-only evidence: `AGENTS.md:34` records the English-only preference. `src/components/workbench/SettingsCanvas.tsx:471-481` already renders Language as static English with no picker — no change needed.

## Tasks & Acceptance

**Execution:**
- `src/app/layout.tsx` -- remove the three locale-related imports, the cookie read, and the provider wrapper; hard-code `lang="en"`; make `RootLayout` non-async -- the layout is the only server-side entry point for the locale cookie.
- `src/components/NavHeader.tsx` -- remove the `LocaleSwitcher` import and render site -- the picker is the only way to set the retired locale.
- `src/components/LocaleSwitcher.tsx`, `src/components/LocaleProvider.tsx`, `src/lib/i18n.ts`, `src/lib/__tests__/i18n.test.ts` -- delete -- the feature and its test go together.
- `src/app/globals.css` -- delete the three `.locale-switcher` rules -- rules for a deleted component.
- The nine workbench components listed in the Code Map -- delete each `data-no-localize` attribute and rewrite/remove the comments that explain it -- the attribute's only reader was `LocaleProvider`; leaving it leaves comments pointing at deleted files.
- `src/lib/__tests__/workbench-chrome.test.ts`, `src/lib/__tests__/workbench-settings.test.ts` -- drop the two `data-no-localize` assertions -- they assert the opt-out contract of a deleted provider.
- `src/lib/__tests__/brand-copy.test.ts` -- delete `BRAND_SCAN_EXEMPT`, its doc comment, and the filter -- the scan must cover everything that remains.
- `src/lib/__tests__/english-only.test.ts` -- add -- unit-tests the I/O matrix rows (literal `lang`, inert stale cookie) and pins the retirement, with a non-vacuity canary on the scanned set.

**Acceptance Criteria:**
- Given the app is built, when the root layout renders, then `<html>` carries the literal `lang="en"` and no cookie is read for locale.
- Given a grep over `src/`, when searching for `i18n`, `LocaleProvider`, `LocaleSwitcher`, `InterfaceLocale`, `data-no-localize`, `workwiki_locale`, or `locale-switcher`, then there are no matches (`localeCompare` and unrelated `locale` identifiers are not matches).
- Given `brand-copy.test.ts` no longer exempts any path, when `pnpm test` runs, then the `no stale brand strings in rendered copy` suite passes with an empty offender list.
- Given the full suite, when `pnpm test` and `pnpm lint` run, then both pass with no new failures relative to the pre-change baseline.

## Spec Change Log

## Review Triage Log

### 2026-08-16 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7: (high 0, medium 2, low 5)
- defer: 3: (high 0, medium 1, low 2)
- reject: 10: (high 0, medium 1, low 9)
- addressed_findings:
  - `[medium]` `[patch]` `docs/llm-wiki-functional-parity-roadmap.md:65` still reported the English/Chinese selector as current state and prescribed "add translation-catalog tooling" as the next step, contradicting `AGENTS.md:34` — row rewritten to record the retirement and a next step of "none".
  - `[medium]` `[patch]` `src/lib/__tests__/english-only.test.ts` scanned only four subtrees, leaving `src/middleware.ts` (the conventional home for cookie-based locale negotiation), `src/mcp.ts` and `src/cli.ts` unscanned — the walk now starts at `src/` and `middleware.ts` joined the non-vacuity canary.
  - `[low]` `[patch]` `docs/llm-wiki-functional-parity-roadmap.md:169-170` still described the persistent selector as shipped behaviour — corrected, KaTeX clause preserved.
  - `[low]` `[patch]` `BACKLOG.md:178` still listed "English/Chinese interface translation" among delivered capability — amended.
  - `[low]` `[patch]` The non-vacuity canary lived inside one `it`, leaving the other scans unguarded — hoisted into a shared `scannedSources()` helper every scan funnels through.
  - `[low]` `[patch]` `not.toContain("cookies(")` banned all cookie reads (over-broad for future auth/theme reads) and `not.toMatch(/lang=\{/)` pinned syntax rather than the property — replaced with a locale-shopping cookie-name scan, a `next/headers` import check, and an assertion that the `lang` value references no request state; added a guard against runtime `document.documentElement.lang` assignment.
  - `[low]` `[patch]` Nothing pinned the deletions by path, no scan covered `globals.css`, the module regex missed relative `./i18n` imports, and the header comment cited line 43 of a deleted file — all four closed.

### 2026-08-16 — Review pass (follow-up)
- intent_gap: 0
- bad_spec: 0
- patch: 8: (high 0, medium 0, low 8)
- defer: 1: (high 0, medium 1, low 0)
- reject: 12: (high 0, medium 2, low 10)
- addressed_findings:
  - `[low]` `[patch]` `docs/llm-wiki-functional-parity-roadmap.md:279` still listed "Internationalize the interface" as Phase 6 planned work, directly contradicting the parity row this change rewrote — the item is now struck and marked declined.
  - `[low]` `[patch]` The rewritten parity row asserted "the recorded owner preference" while the doc's own parity clause 3 requires a divergence be *recorded*; the row now names `AGENTS.md` → Learned User Preferences and uses the doc's disposition wording ("Declined (recorded decision)") instead of the one-off status "Deliberate divergence".
  - `[low]` `[patch]` `BACKLOG.md:178` left an orphan short line mid-paragraph and gave no date or reason for the retirement — reflowed, dated, and pointed at the recorded preference.
  - `[low]` `[patch]` `english-only.test.ts`'s runtime-language guard matched only `document.documentElement.lang =`, which the repo's own prevailing style (`const root = document.documentElement`) and `setAttribute("lang", …)` both evade — it now bans the assignment in either spelling regardless of receiver.
  - `[low]` `[patch]` The cookie guard was simultaneously over-broad (any `.get("…language…")`, which the live workspace output-language preference could legitimately add) and under-broad (`cookieStore.get(UI_LANGUAGE_COOKIE)`, `req.cookies.get(…)` and `document.cookie` parsing all passed) — re-anchored to a cookie accessor with a locale/lang token nearby.
  - `[low]` `[patch]` The module scan required an import path *ending* in `i18n`, so `@/lib/i18n/catalog` passed, and no off-the-shelf catalog was named — directory imports plus `next-intl`/`i18next`/`react-intl`/`@formatjs` are now offenders.
  - `[low]` `[patch]` The scan read only `.ts`/`.tsx` under `src/`, so a `.js` catalog was invisible and the browser clipper — which ships its own document and UI outside the Next tree, the exact blind spot `brand-copy.test.ts` was widened for — was unscanned; the walk now covers `src/`, `workers/` and `integrations/` across js/ts/css/html, and the stylesheet check scans every stylesheet rather than `globals.css` alone.
  - `[low]` `[patch]` The non-vacuity canary pinned four paths but set no floor, so a collapsed walk covering only those four would still pass — a minimum scanned-file count now backs the named paths, which were extended to cover the widened trees.


## Design Notes

Scope note: the intent enumerated `i18n.ts`, `LocaleSwitcher`, `LocaleProvider`, the layout plumbing, and the brand-scan exemption. Three consequences follow that the enumeration did not name and this spec absorbs, because leaving them would be residue of the retired feature: the `.locale-switcher` CSS rules, the `data-no-localize` markers (whose only reader is `LocaleProvider.tsx:44`, and whose in-source comments name `src/lib/i18n.ts` and `LocaleProvider` by path), and `src/lib/__tests__/i18n.test.ts`.

`LocalizedSurface` is exported from `LocaleProvider.tsx` but has zero importers — verified by repo-wide grep — so it dies with the file rather than needing a home.

## Verification

**Commands:**
- `pnpm test` -- expected: full Vitest run passes; `brand-copy` and both workbench suites green.
- `pnpm lint` -- expected: clean, in particular no unused-import or unused-variable errors in `layout.tsx` and `NavHeader.tsx`.
- `npx tsc --noEmit -p tsconfig.json` -- expected: no errors (catches any missed importer of the deleted modules).
- `grep -rniE "localeswitcher|localeprovider|interfacelocale|data-no-localize|workwiki_locale|locale-switcher|lib/i18n" src` -- expected: no output.

## Auto Run Result

Status: done

**Implemented change.** The zh-CN localisation is retired: `src/lib/i18n.ts`, `LocaleProvider.tsx`, `LocaleSwitcher.tsx` and `i18n.test.ts` are deleted; the root layout no longer reads a locale cookie and declares a literal `lang="en"` (and is no longer `async`); the `.locale-switcher` stylesheet rules and every `data-no-localize` marker are gone; `brand-copy.test.ts` scans without a path exemption; and `english-only.test.ts` pins the retirement against reintroduction. This follow-up pass hardened that guard and closed the documentation contradictions the retirement left behind.

**Files changed in this pass:**
- `docs/llm-wiki-functional-parity-roadmap.md` -- Phase 6's "Internationalize the interface" struck and marked declined; the parity row restated with the doc's own clause-3 disposition and a citation of the recorded preference.
- `BACKLOG.md` -- retirement sentence reflowed, dated, and pointed at `AGENTS.md`.
- `src/lib/__tests__/english-only.test.ts` -- scan widened to `src/`, `workers/` and `integrations/` across js/ts/css/html; runtime-language, cookie-read and catalog-import guards re-shaped to pin the property rather than the retired spelling; non-vacuity canary given a file-count floor and the new trees.

**Review findings breakdown:** 8 patches applied (all low), 1 item deferred (medium), 12 rejected. No intent_gap or bad_spec findings — the diff implements the intent's approach, and the reviewers' scope objections all reduced to documentation consistency or test strength rather than deviation.

**Follow-up review recommendation:** `true`. Patched this pass: high 0, medium 0, low 8 → score = (3 × 0) + (1 × 8) = 8, which is ≥ 5.

**Verification performed:**
- `npx vitest run` -- 210 files / 4343 tests passed (script body for `pnpm test`, which is unusable on this machine — see the first deferred item).
- `npx eslint .` -- exit 0 (only upstream `jsx-ast-utils` notices).
- `npx tsc --noEmit -p tsconfig.json` -- exit 0.
- `grep -rniE "localeswitcher|localeprovider|interfacelocale|data-no-localize|workwiki_locale|locale-switcher|lib/i18n" src` -- no matches outside `src/lib/__tests__/`, where the names appear only inside the assertions that ban them.
- `npx next build` -- succeeded. Run because dropping the layout's `cookies()` call removes the app-wide dynamic-rendering trigger: `/wiki`, `/wiki/contributors`, `/wiki/graph`, `/wiki/new`, `/query` and `/vault/agents` are now prerendered. Each was inspected — they are `"use client"` pages, retired stubs, or a redirect, with no request-dependent server rendering — so the flip is benign.
- Guard non-vacuity checked directly: the widened regexes were exercised against the evasions they now have to catch (aliased `root.lang =`, `setAttribute("lang", …)`, `cookieStore.get(UI_LANGUAGE_COOKIE)`, `req.cookies.get("ui_locale")`, `document.cookie` parsing, `@/lib/i18n/catalog`, `next-intl`) and against legitimate near-misses that must stay clean (`formData.get("outputLanguage")`, `searchParams.get("language")`, `localeCompare`, `cookies().get("__session")`).

**Residual risks:**
- The English-only guarantee is still enforced by source scanning, not by rendering. A reintroduction under entirely new names in a file shape the walk does not read would ship green; the guards now pin the property (a language read, a runtime `lang` write, a catalog import) rather than only the retired identifiers, which narrows but does not close that gap.
- The app shell has no mounted test (deferred above), so this change's hand re-nest of the provider tree was verified by reading the diff and by a successful production build, not by an assertion.
- Browsers that visited before the retirement keep sending the year-long `workwiki_locale` cookie until it expires. Nothing reads it, so it is inert; the alternative — a one-time expiring `Set-Cookie` in middleware — would add locale plumbing the intent asked to delete.

