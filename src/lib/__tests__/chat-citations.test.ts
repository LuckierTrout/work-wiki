import { describe, expect, it } from "vitest";
import {
  citationPathAllowed,
  isCoverageSentence,
  sanitizeCitedAnswer,
} from "../chat-citations";
import { CHAT_COVERAGE_MISSING_COPY } from "../workbench-modes";

describe("sanitizeCitedAnswer", () => {
  it("keeps only mapped markers and drops unused rows", () => {
    const result = sanitizeCitedAnswer("See [2] only.", [
      { n: 1, path: "wiki/alpha.md", title: "Alpha", type: "page" },
      { n: 2, path: "raw/sources/a.md", title: "A", type: "source" },
    ]);
    expect(result).toEqual({
      content: "See [2] only.",
      coverage: true,
      citations: [{ n: 2, path: "raw/sources/a.md", title: "A", type: "source" }],
    });
  });

  it("turns an uncited positive answer into the coverage sentence", () => {
    const result = sanitizeCitedAnswer("I remember this from training.", [
      { n: 1, path: "wiki/alpha.md", title: "Alpha", type: "page" },
    ]);
    expect(result.content).toBe(CHAT_COVERAGE_MISSING_COPY);
    expect(result.citations).toEqual([]);
    expect(result.coverage).toBe(false);
    expect(isCoverageSentence(result.content)).toBe(true);
  });

  it("allows wiki and raw source citation paths", () => {
    expect(citationPathAllowed("wiki/queries/cited-answer.md")).toBe(true);
    expect(citationPathAllowed("raw/sources/meet/abc.md")).toBe(true);
    expect(citationPathAllowed("tenants/alice/secret.md")).toBe(false);
  });
});
