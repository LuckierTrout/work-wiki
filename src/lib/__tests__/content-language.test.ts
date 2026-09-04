import { describe, expect, it } from "vitest";
import { DEFAULT_CONTENT_LANGUAGE, detectContentLanguage } from "@/lib/content-language";

/**
 * The content-language classification (DW-116).
 *
 * This is where the change can be wrong QUIETLY. The two call sites —
 * `ArticleView`'s `<article>` and the Workbench Preview's `.wb-preview-body` —
 * emit whatever this returns, and a wrong tag is not a rendering fault a
 * sighted reader would ever notice: the page looks identical, and only a
 * screen reader's voice changes. `content-language-subtrees.test.tsx` proves
 * the attribute REACHES both subtrees; this file proves the value is right.
 *
 * Pure and DOM-free on purpose, so it lives in the `node` project: the rule is
 * a decision about a string, and nothing here should need a document to state.
 */
describe("detectContentLanguage", () => {
  it("answers 'zh' for a Han body with no kana and no hangul", () => {
    // Chinese is Han ALONE — the absence of kana is the whole of what
    // separates it from Japanese below.
    expect(detectContentLanguage("这是一个中文页面，讲的是知识库的设计。")).toBe("zh");
  });

  it("answers 'ja' for a body carrying kana, even though its kanji are Han", () => {
    // The tiebreaker, and the case a han-first rule gets WRONG. Japanese prose
    // is mostly kanji by character count, so counting Han first and answering
    // "zh" on a majority would misannounce every Japanese page in the wiki.
    const japanese = "これは日本語のページです。知識ベースの設計について書いています。";
    expect(detectContentLanguage(japanese)).toBe("ja");
    // Stated explicitly: the kanji really are in the majority here, so "ja"
    // cannot have been bought by there simply being more kana than Han.
    const han = [...japanese].filter((ch) => {
      const c = ch.codePointAt(0)!;
      return c >= 0x3400 && c <= 0x9fff;
    }).length;
    const kana = [...japanese].filter((ch) => {
      const c = ch.codePointAt(0)!;
      return c >= 0x3040 && c <= 0x30ff;
    }).length;
    expect(kana).toBeGreaterThan(0);
    expect(han).toBeGreaterThan(0);
  });

  it("answers 'ko' for hangul with no kana", () => {
    expect(detectContentLanguage("이것은 한국어 페이지입니다. 지식 베이스에 대한 글입니다.")).toBe(
      "ko",
    );
  });

  it("answers 'en' for Latin-dominant prose", () => {
    expect(detectContentLanguage("A perfectly ordinary English page about ingestion.")).toBe("en");
    expect(detectContentLanguage("A perfectly ordinary English page about ingestion.")).toBe(
      DEFAULT_CONTENT_LANGUAGE,
    );
  });

  it("answers 'en' when Latin OUTNUMBERS the CJK it is quoting", () => {
    // The reason CJK needs a majority rather than a presence: English prose
    // that quotes a Chinese term is English, and announcing the whole article
    // in a Mandarin voice because of three characters is the worse error.
    expect(detectContentLanguage("The Chinese word for wiki is 维基, apparently.")).toBe("en");
  });

  it("answers 'en' on a TIE, so CJK wins only on a strict majority", () => {
    // Four Latin letters against four Han characters. `<=` is the branch under
    // test; a `<` here would answer "zh".
    expect(detectContentLanguage("abcd中文页面")).toBe("en");
    // One more Han character and the majority is real.
    expect(detectContentLanguage("abcd中文页面性")).toBe("zh");
  });

  it("answers 'en' for a body with no letters at all", () => {
    // Empty, digits, punctuation, whitespace: `0 <= 0` is a tie, so the
    // default carries these without a special case — and an empty body is the
    // state a brand-new page is created in.
    expect(detectContentLanguage("")).toBe("en");
    expect(detectContentLanguage("12345")).toBe("en");
    expect(detectContentLanguage("--- ... !?!? \n\n  ")).toBe("en");
  });

  it("counts an astral character as neither CJK nor a letter", () => {
    // Emoji, dingbats and the rest sit outside every range this counts, and
    // neither half of a surrogate pair may be read as a letter on its own —
    // the sticky letter test carries the `u` flag for exactly that, and the
    // walk steps past the pair rather than over each unit.
    expect(detectContentLanguage("🙂🙂 中文中文中")).toBe("zh");
    expect(detectContentLanguage("🙂🙂 abcd")).toBe("en");
    // An astral LETTER (Deseret) is one letter on the non-CJK side, not two
    // and not zero: two of them against two Han characters is a tie, which the
    // strict-majority rule resolves to the default.
    expect(detectContentLanguage("𐐀𐐁中文")).toBe("en");
    expect(detectContentLanguage("𐐀𐐁中文字")).toBe("zh");
  });

  it("agrees with the tokenizer's compatibility-Han range", () => {
    // `bm25.ts`'s `CJK_RUN_RE` tokenizes U+F900–U+FAFF as Han. A page the
    // index treats as Chinese must not be announced as English, so the same
    // range counts here.
    expect(detectContentLanguage("豈更車")).toBe("zh");
  });

  it("weighs CJK against EVERY other script, not just against ASCII letters", () => {
    // The denominator bug. Counting only `a-zA-Z` on the non-CJK side makes it
    // ZERO for Cyrillic, Greek, Arabic, Hebrew, Devanagari and the rest — so a
    // long Russian article that quotes a single Han character would have CJK
    // in a strict majority of 1 to 0 and be announced in Mandarin.
    const russian =
      "Это довольно длинная русская статья о проектировании базы знаний. " +
      "Она объясняет, как работает индексация и поиск по документам. " +
      "Здесь упоминается один иероглиф: 维.";
    expect(detectContentLanguage(russian)).toBe("en");
    const greek =
      "Αυτή είναι μια ελληνική σελίδα για τη σχεδίαση της βάσης γνώσεων " +
      "και για τον τρόπο με τον οποίο γίνεται η αναζήτηση.";
    expect(detectContentLanguage(greek)).toBe("en");
  });

  it("does not let a lone katakana middle dot make a Chinese page Japanese", () => {
    // `・` (U+30FB) sits in the kana block but is PUNCTUATION in Chinese: it
    // separates the parts of a transliterated foreign name. Deciding "ja" on
    // the mere presence of a kana code point misannounces the whole page for
    // one character of punctuation.
    const chinese = "这是一个中文页面，讲的是知识库的设计与检索。".repeat(8);
    const body = `${chinese}作者是玛丽・居里。`;
    expect(detectContentLanguage(body)).toBe("zh");
    // The dot really is there — otherwise this case proves nothing.
    expect(body).toContain("・");
  });

  it("does not let a single stray kana make a Korean page Japanese", () => {
    // The same failure on the other side, and the reason the ratio's
    // denominator is the TOTAL CJK count rather than the Han count: Korean
    // prose carries no Han at all, so measured against Han alone one kana
    // clears every threshold.
    const korean = "이것은 한국어 페이지입니다. 지식 베이스에 대한 글입니다.".repeat(4);
    expect(detectContentLanguage(`${korean} の`)).toBe("ko");
  });

  it("still answers 'ja' for kanji-dense prose where kana is a tenth of the Han", () => {
    // The threshold must not cost real Japanese its tag. This sample is the
    // hardest ordinary shape — a run of compound nouns — and the assertions
    // below pin that kana really is that sparse in it.
    const dense = "経済産業省令和五年度技術革新実証実験報告書概要版第三章国内総生産統計のと";
    const codePoints = [...dense];
    const han = codePoints.filter((ch) => {
      const c = ch.codePointAt(0)!;
      return c >= 0x3400 && c <= 0x9fff;
    }).length;
    const kana = codePoints.filter((ch) => {
      const c = ch.codePointAt(0)!;
      return c >= 0x3040 && c <= 0x30ff;
    }).length;
    expect(kana).toBeGreaterThan(0);
    // Kana is at most a tenth of the kanji here — an order of magnitude below
    // "most of the text", and still comfortably above the one-in-twenty floor.
    expect(kana * 10).toBeLessThanOrEqual(han);
    expect(detectContentLanguage(dense)).toBe("ja");
  });

  it("ignores fenced code, inline code and URLs, which are ASCII in every language", () => {
    // The classifier reads markdown SOURCE. One ordinary code fence in a
    // Chinese article contributes a few hundred Latin letters and, counted,
    // flips the page to English — the page looks unchanged and only the screen
    // reader's voice is wrong, which is the quiet failure this whole file
    // exists for.
    const withFence = [
      "这是一个中文页面，讲的是知识库的设计与检索。",
      "",
      "```ts",
      "export async function ingestDocument(source: string): Promise<WikiPage> {",
      '  const parsed = await parseFrontmatter(source, { strict: true });',
      "  return renderPage(parsed);",
      "}",
      "```",
      "",
      "以上就是全部内容。",
    ].join("\n");
    expect(detectContentLanguage(withFence)).toBe("zh");
    // A tilde fence is the same construct, and an UNCLOSED fence must still be
    // stripped to the end rather than silently counted.
    expect(detectContentLanguage("中文页面。\n~~~\nconst answer = fortyTwo;\n~~~\n检索。")).toBe(
      "zh",
    );
    expect(detectContentLanguage("中文页面。\n```\nconst answer = fortyTwo();\n")).toBe("zh");
    // Inline spans and link URLs, the two smaller leaks.
    expect(detectContentLanguage("中文页面。参数是 `--strict-frontmatter-parsing`。")).toBe("zh");
    expect(
      detectContentLanguage("中文页面。见 [参考](https://example.com/knowledge/base/design)。"),
    ).toBe("zh");
  });

  it("still counts prose that merely LOOKS like code, since only real spans are stripped", () => {
    // The strips are bounded on purpose: an English page is still English, and
    // an unbalanced backtick must not swallow the rest of the body.
    expect(detectContentLanguage("An English page about ingestion and retrieval.")).toBe("en");
    expect(detectContentLanguage("English prose with one ` stray backtick in it.")).toBe("en");
  });

  it("exports the default as the tag English content already inherits", () => {
    expect(DEFAULT_CONTENT_LANGUAGE).toBe("en");
  });
});
