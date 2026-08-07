import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";

describe("MarkdownRenderer math", () => {
  it("renders inline and display math with KaTeX", () => {
    const html = renderToStaticMarkup(createElement(MarkdownRenderer, {
      content: "Inline $E = mc^2$\n\n$$\n\\int_0^1 x^2 dx\n$$",
    }));
    expect(html).toContain("katex");
    expect(html).toContain("katex-display");
    expect(html).toContain("E = mc^2");
  });
});
