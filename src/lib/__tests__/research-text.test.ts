import { describe, expect, it } from "vitest";
import {
  appendThinkingLines,
  extractThinking,
  hasAllowedResearchCitation,
  restrictResearchCitations,
} from "../research-text";

describe("extractThinking", () => {
  it("collects every block and drops stray closers", () => {
    expect(extractThinking(
      "<thinking>one</thinking>\nvisible\n<thinking>two</thinking>\n</thinking>",
    )).toEqual({
      thinking: "one\n\ntwo",
      content: "visible",
    });
  });

  it("treats an unmatched opener as thinking so a truncated stream cannot publish it", () => {
    expect(extractThinking("<thinking>secret plan\n# Leaked")).toEqual({
      thinking: "secret plan\n# Leaked",
      content: "",
    });
  });
});

describe("restrictResearchCitations", () => {
  it("keeps fetched URLs and strips invented ones", () => {
    const markdown = "See [ok](https://example.com/a) and [nope](https://evil.example/x).";
    expect(restrictResearchCitations(markdown, ["https://example.com/a"]))
      .toBe("See [ok](https://example.com/a) and nope.");
  });

  it("rescans link labels and permissive raw HTML for invented URLs", () => {
    const fenced = restrictResearchCitations([
      "[https://evil.example/label](https://evil.example/dest)",
      "![https://evil.example/alt](https://evil.example/img)",
      '<a href = "https://evil.example/html">claim</a>',
      '<img src="https://evil.example/image">',
    ].join("\n"), ["https://example.com/allowed"]);

    expect(fenced).not.toContain("evil.example");
  });

  it("strips autolinks, images, reference links, HTML anchors, and bare URLs", () => {
    const markdown = [
      "See <https://evil.example/auto> and ![pic](https://evil.example/img).",
      "[ref][gone] and [kept][ok].",
      "[gone]: https://evil.example/ref",
      "[ok]: https://example.com/a",
      '<a href="https://evil.example/html">html</a>',
      "Bare https://evil.example/bare and https://example.com/a",
    ].join("\n");
    const fenced = restrictResearchCitations(markdown, ["https://example.com/a"]);
    expect(fenced).not.toContain("evil.example");
    expect(fenced).toContain("https://example.com/a");
    expect(fenced).toContain("html");
  });

  it("preserves allowed link titles and surrounding punctuation", () => {
    const markdown = "Evidence: [launch](https://example.com/a \"Primary source\"), then [claim](https://evil.example/x \"Invented\").";

    expect(restrictResearchCitations(markdown, ["https://example.com/a"]))
      .toBe("Evidence: [launch](https://example.com/a \"Primary source\"), then claim.");
  });
});

describe("hasAllowedResearchCitation", () => {
  it("requires at least one exact fetched URL", () => {
    expect(hasAllowedResearchCitation(
      "See [evidence](https://example.com/a).",
      ["https://example.com/a"],
    )).toBe(true);
    expect(hasAllowedResearchCitation("# Brief\n\nFacts.", ["https://example.com/a"]))
      .toBe(false);
    expect(hasAllowedResearchCitation(
      "See https://example.com/other.",
      ["https://example.com/a"],
    )).toBe(false);
  });

  it("requires a rendered citation rather than hidden or example text", () => {
    const allowed = ["https://example.com/a"];
    expect(hasAllowedResearchCitation("<!-- https://example.com/a -->", allowed)).toBe(false);
    expect(hasAllowedResearchCitation("```text\nhttps://example.com/a\n```", allowed)).toBe(false);
    expect(hasAllowedResearchCitation("`https://example.com/a`", allowed)).toBe(false);
    expect(hasAllowedResearchCitation("[unused]: https://example.com/a", allowed)).toBe(false);
    expect(hasAllowedResearchCitation("See [source][used].\n\n[used]: https://example.com/a", allowed)).toBe(true);
    expect(hasAllowedResearchCitation("Visible https://example.com/a", allowed)).toBe(true);
    expect(hasAllowedResearchCitation('<a href="https://example.com/a">Source</a>', allowed)).toBe(true);
  });
});

describe("appendThinkingLines", () => {
  it("keeps the newest bounded lines", () => {
    expect(appendThinkingLines(["old"], "new line\n\n", 2)).toEqual(["old", "new line"]);
  });
});
