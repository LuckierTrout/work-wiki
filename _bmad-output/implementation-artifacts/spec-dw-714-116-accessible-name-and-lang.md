---
title: 'Separate the SourceBadge from its label text, and declare the content language on the body subtrees'
type: 'bugfix'
created: '2026-09-03'
baseline_revision: '523f5d83fb2f96380f48b7cb806f4fec5576c5ea'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Two things assistive technology is told wrongly. (1) `SourceBadge` renders its badge span immediately after the label text with no whitespace text node between them — `ml-2` is visual spacing only — so every `SourceBadge`-bearing label on `/settings` computes an accessible name of the two strings run together ("Modelfrom environment", "Ollama Base URLfrom environment"), which `provider-form.test.tsx` currently pins verbatim (DW-714). (2) `<html lang="en">` is unconditional while `slugify.ts`, `bm25.ts` and `ingest.ts` all preserve CJK by design and nothing declares a language on the rendered page body, so a Chinese, Japanese or Korean page is announced as English (DW-116).

**Approach:** Emit the separating whitespace inside `SourceBadge` itself, so no call site can forget it and the `none` branch still contributes nothing. Add one pure helper that reports the dominant script of a body as a BCP-47 primary tag, and read it into `lang` on exactly two nodes: `ArticleView`'s `<article>` and the Workbench Preview's `.wb-preview-body`. `<html lang="en">` stays as the chrome's language; no schema change, no stored field, no picker.

## Boundaries & Constraints

**Always:** The badge's separator is a real text node, not a CSS margin — the accessible name of each `/settings` label reads "Model from environment", "Ollama Base URL from environment", "Provider from config" and so on. The language helper is a pure function over a string, exhaustively unit-tested in the `node` project, and both subtrees are asserted MOUNTED. Latin-dominant and empty bodies resolve to `"en"`, so the default never changes for the English content this deployment mostly holds. `pnpm test` and `pnpm lint` pass.

**Block If:** Setting `lang` on the article or the Preview body turns out to change what an existing suite asserts about those subtrees in a way that cannot be reconciled with the recorded 2026-08-28 decision.

**Never:** Do not change `<html lang="en">` in `src/app/layout.tsx`, and do not read request state, a cookie, a header or `navigator` to choose a language — `english-only.test.ts` guards all of that and must stay green. Do not add an i18n mechanism, a translation catalog, a language picker, or a stored per-page language field. Do not assign `lang` at runtime through `element.lang =` or `setAttribute("lang", …)` — the declaration is a JSX attribute on a rendered element. Do not set `lang` on the page header, the chrome, or any node other than the two named. Do not edit the deferred-work ledger.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Env-pinned model label | `settings.modelSource === "env"` | The `label[for=model]` accessible name is `"Model from environment"`, and the `<output id="model">` resolves by that name | No error expected |
| Badge absent | `settings === null`, or source `"none"` | The label's name is `"Model"` — no stray separator is contributed | No error expected |
| Chinese body | Body is predominantly Han | Helper returns `"zh"`; the article and the Preview body carry `lang="zh"` | No error expected |
| Japanese body | Body contains kana | Helper returns `"ja"` — kana decides, even though kanji are Han | No error expected |
| Korean body | Body contains hangul, no kana | Helper returns `"ko"` | No error expected |
| English body | Latin-dominant prose | Helper returns `"en"`; both subtrees carry `lang="en"` | No error expected |
| Mixed body | More Latin letters than CJK | Helper returns `"en"` — ties and Latin-majority both resolve to the default | No error expected |
| No letters at all | Empty body, digits, punctuation only | Helper returns `"en"` | No error expected |

</intent-contract>

## Code Map

- `src/components/SourceBadge.tsx` -- the whole component; three `<span className="ml-2 …">` branches plus a `null` branch for `"none"`. The separator belongs here.
- `src/components/ProviderForm.tsx:281,345,466` -- the three `SourceBadge`-bearing labels (Provider, Model, Ollama Base URL). READ-ONLY for this change: with the separator inside the badge the call sites need no edit.
- `src/components/EmbeddingSettings.tsx:239` -- `Embedding Model{" "}` before its `(optional)` span. The settled precedent for a real whitespace node in a label; carries no `SourceBadge`, so it needs no change.
- `src/components/__tests__/provider-form.test.tsx:820-830,949-951,986-994` -- the two verbatim pins of the run-together names, and the comment claiming the label's own text is `"Ollama Base URLfrom environment"`. Update the pins and the prose that argues for them.
- `src/app/settings/__tests__/settings-page-read-only-controls.test.tsx:116-123` -- comment citing `"Providerconfig"` as the artefact name. Becomes false with this change; correct it. No assertion there depends on the name.
- `src/app/layout.tsx:105` -- `<html lang="en">`. READ-ONLY: the chrome's language stays.
- `src/lib/bm25.ts:33-34` -- `CJK_RUN_RE`, the repo's existing CJK range set (`㐀-鿿`, `豈-﫿`, `぀-ヿ`, `가-힯`). Reuse the same ranges so the language declaration and the tokenizer agree on what CJK is; do not import the tokenizer.
- `src/components/ArticleView.tsx:435` -- the `<article>` wrapping the markdown / slides / html-preview branches. `page.body` (the full body, ahead of `stripLeadingH1`) is the string to classify.
- `src/components/workbench/PreviewColumn.tsx:1360` -- `<div className="wb-preview-body" ref={bodyRef}>` wrapping `<PreviewBody>` on the `kind === "body"` branch. `state.payload.body` is the string. The truncation `<p>` above it is English chrome and stays outside.
- `src/lib/__tests__/english-only.test.ts:104-108,90-101` -- the guards this must stay green under: no `.lang =` / `setAttribute("lang"` anywhere under `src/`, `workers/`, `integrations/`; no `i18n`-shaped import string; `layout.tsx` still `lang="en"` with no request-derived value.
- `src/components/__tests__/owner-scoped-anchors.test.tsx:90-127,206-232` -- the proven way to mount `ArticleView` (an async server component: await it, then `render`), with the `@clerk/nextjs` stub and the PARTIAL `@/lib/wiki` mock it needs.
- `src/components/workbench/__tests__/uncovered-scroll-surfaces.test.tsx:117-134,700-712` -- the proven way to mount `PreviewColumn` standalone: five props plus a `fetch` stub answering `/api/workbench/preview` with a payload.
- `AGENTS.md` "Test environments" -- `.test.tsx` ⇒ `dom` project, `.test.ts` ⇒ `node` project; suites live under `__tests__`.

## Tasks & Acceptance

**Execution:**
- `src/components/SourceBadge.tsx` -- return each rendered branch as a fragment whose first child is a `{" "}` text node before the span; leave `ml-2` and the `none`-returns-`null` branch alone -- the separator has to be in the accessible name, and putting it in the component means no present or future call site can omit it while `none` still contributes nothing.
- `src/lib/content-language.ts` -- NEW. Export a pure `detectContentLanguage(body: string): string` returning `"ja" | "ko" | "zh" | "en"`, plus the default as a named constant. One pass over the code points counting Latin letters and the three CJK groups; CJK wins only on a strict majority, then kana ⇒ `ja`, else hangul ⇒ `ko`, else Han ⇒ `zh` -- a per-content language declaration needs a decision that is testable without a DOM, and the module name deliberately avoids the `i18n` spelling `english-only.test.ts` bans.
- `src/components/ArticleView.tsx` -- set `lang={detectContentLanguage(page.body)}` on the `<article>` at :435 -- the recorded 2026-08-28 decision: the article subtree carries the content language, the chrome keeps `en`.
- `src/components/workbench/PreviewColumn.tsx` -- set `lang` from `state.payload.body` on the `.wb-preview-body` div at :1360 -- the Preview is the second surface that renders a page body, and it is the one an owner reads most.
- `src/lib/__tests__/content-language.test.ts` -- NEW (`node` project). Cover every I/O-matrix row for the helper: zh, ja (kana over kanji), ko, en, Latin-majority mixed, tie, empty, punctuation-only -- the classification rule is where this change can be wrong quietly.
- `src/components/__tests__/content-language-subtrees.test.tsx` -- NEW (`dom` project). Mount `ArticleView` over a Han body and assert the rendered `<article>` carries `lang="zh"`; mount `PreviewColumn` over a payload whose body is Han and assert `.wb-preview-body` carries `lang="zh"`, then over an English body and assert `lang="en"` -- a helper with no call site would pass its own suite while both subtrees stayed unannounced.
- `src/components/__tests__/provider-form.test.tsx` -- update the two pinned names to `"Model from environment"` and `"Ollama Base URL from environment"`, rewrite the three comments that argue the names run together, and add the badge-absent pair (no `settings` at all, and a `none` source where the badge returns `null`) asserting the label's raw `textContent` is exactly `"Model"` -- the pins are the mounted evidence for DW-714, and the second pair is what makes putting the separator inside the badge rather than at the call sites observable.
- `src/app/settings/__tests__/settings-page-read-only-controls.test.tsx` -- correct the `field()` comment's example name to the separated spelling -- it is the one other place that describes the old artefact.

**Acceptance Criteria:**
- Given `/settings` renders with any non-`none` source, when a browser computes the accessible name of a `SourceBadge`-bearing label, then the label text and the badge text are separated by whitespace.
- Given the app is built, when the root layout renders, then `<html>` still carries the literal `lang="en"` and no request state is consulted for it.
- Given a grep over `src/` for `element.lang =`, `setAttribute("lang"`, an `i18n`-shaped import, a locale cookie read or a language picker, when `english-only.test.ts` runs, then it reports no offenders.

## Design Notes

The classification is deliberately coarse: four outcomes, decided by counting, with `"en"` as the answer whenever CJK is not in the strict majority. Han alone cannot separate Chinese from Japanese, so kana is the tiebreaker that runs first — a Japanese page is mostly kanji by character count but always carries kana, while a Chinese page carries none.

```ts
// One pass, no allocation: bodies reach 200,000 characters and this runs on
// every article render.
for (const ch of body) {
  const c = ch.codePointAt(0)!;
  if (kana(c)) kanaCount++;
  else if (hangul(c)) hangulCount++;
  else if (han(c)) hanCount++;
  else if (latin(c)) latinCount++;
}
const cjk = kanaCount + hangulCount + hanCount;
if (cjk <= latinCount) return "en";
return kanaCount > 0 ? "ja" : hangulCount > 0 ? "ko" : "zh";
```

The attribute is emitted on both subtrees unconditionally, `"en"` included. An omitted attribute would be indistinguishable from deleted wiring, and inheriting `en` from `<html>` is exactly what the emitted value says.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/content-language.test.ts src/lib/__tests__/english-only.test.ts` -- expected: all pass.
- `pnpm exec vitest run --project dom src/components/__tests__/content-language-subtrees.test.tsx src/components/__tests__/provider-form.test.tsx src/app/settings/__tests__/settings-page-read-only-controls.test.tsx` -- expected: all pass.
- `pnpm test` -- expected: the full run passes.
- `pnpm lint` -- expected: clean.

## Auto Run Result

Status: done

**Implemented change.** Two things assistive technology was told wrongly are corrected. `SourceBadge` now emits a real whitespace text node ahead of its span, so every `SourceBadge`-bearing label on `/settings` is named "Model from environment" rather than "Modelfrom environment"; the separator is written once, inside the component, so no call site and no future source kind can lose it. Separately, a new pure helper reports the dominant script of a page body as a BCP-47 primary tag, and that tag is declared on exactly two subtrees — `ArticleView`'s `<article>` and the Workbench Preview's `.wb-preview-body`. `<html lang="en">` is untouched: it remains the chrome's language, and nothing reads request state to choose one.

**Files changed**
- `src/components/SourceBadge.tsx` -- one `BADGES` table, one separator, one span; `none` still renders nothing.
- `src/lib/content-language.ts` -- NEW. `detectContentLanguage` + `DEFAULT_CONTENT_LANGUAGE`: strip code/URLs, one allocation-free index pass counting kana/hangul/Han against every other letter, strict CJK majority, then a deciding-script ratio.
- `src/components/ArticleView.tsx` -- `<article lang={…}>` from the full `page.body`, with the html/iframe limit recorded.
- `src/components/workbench/PreviewColumn.tsx` -- `bodyLanguage` memoized on `payload?.body`, read into `.wb-preview-body`.
- `src/lib/__tests__/content-language.test.ts` -- NEW (`node`). 16 cases: every I/O-matrix row plus the Cyrillic/Greek denominator, the lone middle dot, the stray kana in Korean, kanji-dense Japanese, code fences and astral letters.
- `src/components/__tests__/content-language-subtrees.test.tsx` -- NEW (`dom`). Both subtrees mounted, asserted on the rendered attribute, Han and English bodies each.
- `src/components/__tests__/provider-form.test.tsx` -- names re-pinned with the separator, a table over all three sources, a literal-string name query, and the badge-absent pair.
- `src/app/settings/__tests__/settings-page-read-only-controls.test.tsx` -- comment corrected to the separated spelling.

**Review findings breakdown.** 6 patched (2 medium, 4 low), 0 deferred, 10 rejected. Rejected as out of scope on the intent's own authority — the recorded 2026-08-28 decision names the article and Preview subtree only: the page title and summary rendered outside `<article>`, the Preview's edit-mode `<textarea>`, and the other surfaces that render stored bodies (`WorkspacePreview`, `VaultExplorer`, `RawSourceBrowser`, `wiki/log`). Rejected as noise: a runtime `typeof body` guard the types already give, supplementary-plane Han / Jamo / halfwidth kana (deliberately the same ranges `bm25.ts` tokenizes), classifying only a truncated payload's prefix, a source-scan guard against tokenizer-range drift, the slightly wider visual gap now that `ml-2` sits on a real space, and the call-site-versus-component reading of DW-714 (both produce the same DOM).

**Follow-up review recommendation:** false. Patched findings by severity: high 0, medium 2, low 4 — no patched finding was high.

**Verification.**
- `pnpm exec vitest run --project node …content-language.test.ts …english-only.test.ts` -- 22 passed.
- `pnpm exec vitest run --project dom …content-language-subtrees …provider-form …settings-page-read-only-controls` -- 56 passed.
- `pnpm test` -- 378 files, 9449 passed, 1 skipped, 0 failed.
- `pnpm lint` -- exit 0 (the three `jsx-ast-utils` `TSNonNullExpression` notices are pre-existing). `npx tsc --noEmit` -- exit 0.
- Matrix audit: all eight I/O rows are covered by cases that ran and passed in the runs above.
- One unrelated flake was seen on an earlier full run (`workbench-intake.test.ts` overshot a wall-clock budget by 1 ms under load) and did not reproduce on either subsequent full run.

**Residual risks.**
- Non-CJK, non-Latin bodies (Cyrillic, Greek, Arabic, Hebrew, Thai, Devanagari) resolve to `"en"`. DW-116's title names "other non-English source content", so this half is knowingly unaddressed: script does not determine language outside the three CJK cases, and asserting a guessed tag would be a new wrongness. The announced result is unchanged from before; only the claim moved from inherited to declared.
- On `pageType === "html"` and HTML decks the classified string is markup, and the content renders inside a `srcDoc` iframe that inherits nothing — so the attribute describes the `<article>` element only there.
- The helper restates `bm25.ts`'s CJK ranges rather than importing them; the agreement is evidenced by one compatibility-Han case, not pinned against the tokenizer's regex, so a future widening of `CJK_RUN_RE` could drift silently.
