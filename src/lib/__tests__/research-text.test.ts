import { describe, expect, it } from "vitest";
import { appendThinkingLines, extractThinking, restrictResearchCitations } from "../research-text";

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
});

describe("appendThinkingLines", () => {
  it("keeps the newest bounded lines", () => {
    expect(appendThinkingLines(["old"], "new line\n\n", 2)).toEqual(["old", "new line"]);
  });
});
