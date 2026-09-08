// ---------------------------------------------------------------------------
// Content language — the BCP-47 primary tag a rendered page BODY is announced
// in (DW-116)
// ---------------------------------------------------------------------------

/**
 * `<html lang="en">` is the CHROME's language and stays unconditional: the
 * interface is English only, and nothing here reads request state, a cookie, a
 * header or `navigator` to decide otherwise (`english-only.test.ts` guards all
 * of that). But `slugify.ts`, `bm25.ts` and `ingest.ts` all preserve CJK by
 * design, so a Chinese, Japanese or Korean page is real content this
 * deployment holds — and inherited from `<html>` it is announced by a screen
 * reader in an English voice, which renders it unintelligible.
 *
 * This module is the whole of the fix: one pure classification over the body
 * text, read into `lang` on exactly two rendered subtrees (the `<article>` in
 * `ArticleView` and the Workbench Preview's `.wb-preview-body`). No
 * internationalization mechanism, no translation catalog, no locale provider,
 * no picker, no stored per-page field — and the module is named for the
 * content it describes rather than for the retired machinery, whose import
 * shape `english-only.test.ts` bans outright.
 */

/**
 * The answer for everything that is not CJK-dominant, including an empty body.
 *
 * Named rather than inlined so the "what English content already gets" case is
 * one value both the helper and its suite refer to.
 */
export const DEFAULT_CONTENT_LANGUAGE = "en";

/** The four outcomes. Deliberately coarse — see `detectContentLanguage`. */
export type ContentLanguage = "ja" | "ko" | "zh" | "en";

// The SAME ranges `bm25.ts`'s `CJK_RUN_RE` tokenizes on (Han incl. Ext-A +
// compatibility, kana, hangul), restated as code-point bounds rather than
// imported: the tokenizer's export is a stateful `/g` regex and this is a
// counting loop, but the two must agree on what CJK is or a page the index
// treats as Chinese would be announced as English.
const HAN_LO = 0x3400;
const HAN_HI = 0x9fff;
const HAN_COMPAT_LO = 0xf900;
const HAN_COMPAT_HI = 0xfaff;
const KANA_LO = 0x3040;
const KANA_HI = 0x30ff;
const HANGUL_LO = 0xac00;
const HANGUL_HI = 0xd7af;

/**
 * Any letter, tested AT an index with no substring allocated.
 *
 * Sticky (`y`) plus Unicode (`u`): `lastIndex` is set to the position under
 * the cursor and the test matches exactly the code point there. `\p{L}` rather
 * than `a-zA-Z` because the counter it feeds is the denominator of the
 * majority rule below — an ASCII-only test makes that denominator ZERO for
 * Cyrillic, Greek, Arabic, Hebrew, Devanagari and every other non-Latin
 * script, so a ten-sentence Russian article quoting one Han character would
 * classify as Chinese and be read aloud in Mandarin.
 */
const LETTER_AT = /\p{L}/uy;

/**
 * Markdown that is NOT prose, removed before anything is counted.
 *
 * The classifier runs over markdown SOURCE, and code is written in ASCII
 * whatever the page is written in: one ordinary TypeScript fence in a Chinese
 * article contributes a few hundred Latin letters to the non-CJK side and
 * flips the whole page to `"en"`. Same for inline code spans (identifiers,
 * paths, flags) and for URLs, which are Latin even in a link whose visible
 * text is Han.
 *
 * Order matters: fences first, so the backticks they are delimited by cannot
 * be re-read as inline spans.
 */
const FENCED_CODE_RE = /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]{0,3}\1[ \t]*$|$(?![\s\S]))/gm;
const INLINE_CODE_RE = /(`+)[^`]*\1/g;
const URL_RE = /\bhttps?:\/\/\S+/gi;

/**
 * How much of the CJK in a body a script has to account for before it is
 * allowed to DECIDE which CJK language this is: one character in twenty.
 *
 * Presence alone is wrong in both directions. `・` (U+30FB, the katakana
 * middle dot) is standard punctuation in Chinese for separating the parts of a
 * transliterated foreign name, so a 160-character Chinese page carrying one
 * would be announced as Japanese; and a single stray kana anywhere in a Korean
 * page would do the same to it. Neither is a script — they are a rounding
 * error against the body's CJK, which is what this ratio names.
 *
 * The denominator is the TOTAL CJK count, not the Han count: measured against
 * Han alone the threshold is vacuous for hangul-only Korean, where Han is
 * zero and one kana therefore clears any ratio at all.
 *
 * Twenty is chosen against real Japanese: kanji-dense prose still runs about
 * one kana per two or three kanji, an order of magnitude clear of this.
 */
const DECIDING_SCRIPT_RATIO = 20;

/**
 * The dominant script of `body`, as a BCP-47 primary language subtag.
 *
 * The counting is ONE pass over the code points with no per-character string
 * allocated — an index walk that steps past surrogate pairs itself, and a
 * sticky regex for the letter test. (The three strips above do each copy the
 * string once; bodies reach 200,000 characters, so the Preview call site
 * memoizes this and the article call site runs it once per server render.)
 *
 * CJK has to win on a STRICT majority of the letters — a mixed body with as
 * many non-CJK letters as CJK characters is prose ABOUT CJK, not prose in it,
 * so ties and non-CJK-majority both resolve to `"en"`, and the default
 * therefore never changes for the English content this deployment mostly
 * holds.
 *
 * Kana is then the tiebreaker that runs FIRST, because Han alone cannot
 * separate Chinese from Japanese: a Japanese page is mostly kanji by character
 * count but always carries kana, while a Chinese page carries none — subject
 * to `DECIDING_SCRIPT_RATIO`, which keeps a lone punctuation mark from
 * counting as a script.
 */
export function detectContentLanguage(body: string): ContentLanguage {
  const text = body
    .replace(FENCED_CODE_RE, "\n")
    .replace(INLINE_CODE_RE, " ")
    .replace(URL_RE, " ");

  let kana = 0;
  let hangul = 0;
  let han = 0;
  let other = 0;

  for (let i = 0; i < text.length; ) {
    const c = text.codePointAt(i)!;
    const start = i;
    i += c > 0xffff ? 2 : 1;
    if (c >= KANA_LO && c <= KANA_HI) kana++;
    else if (c >= HANGUL_LO && c <= HANGUL_HI) hangul++;
    else if ((c >= HAN_LO && c <= HAN_HI) || (c >= HAN_COMPAT_LO && c <= HAN_COMPAT_HI)) han++;
    else {
      LETTER_AT.lastIndex = start;
      if (LETTER_AT.test(text)) other++;
    }
  }

  const cjk = kana + hangul + han;
  // Also the no-letters-at-all case: `0 <= 0`.
  if (cjk <= other) return DEFAULT_CONTENT_LANGUAGE;
  if (kana * DECIDING_SCRIPT_RATIO >= cjk) return "ja";
  if (hangul * DECIDING_SCRIPT_RATIO >= cjk) return "ko";
  return "zh";
}
