/**
 * The Research Panel's vocabulary.
 *
 * Pure functions, asserted without mounting: these are the sentences the
 * acceptance criteria are written about, and a status word composed inline in
 * JSX is a string only a render test can see.
 */
import { describe, expect, it } from "vitest";
import {
  RESEARCH_ACTIVE_STATUSES,
  RESEARCH_POLL_MS,
  parseResearchQueries,
  researchStatusLabel,
  researchTaskLine,
} from "../research-panel";
import type { ResearchProject, ResearchProjectStatus } from "../research-projects";

const project = (extra: Partial<ResearchProject>): ResearchProject => ({
  id: "p1",
  title: "Launch evidence",
  question: "What supports the launch date?",
  queries: ["launch evidence"],
  sourceUrls: [],
  pageSlugs: [],
  status: "draft",
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z",
  ...extra,
} as ResearchProject);

describe("research panel vocabulary", () => {
  it("polls while a run is queued, collecting or synthesizing", () => {
    // `queued` is the one that matters: the fourth start is queued, and a panel
    // that polled only while `collecting` would show it frozen at "waiting"
    // until the owner reloaded.
    expect([...RESEARCH_ACTIVE_STATUSES].sort())
      .toEqual(["collecting", "queued", "ready"]);
    expect(RESEARCH_ACTIVE_STATUSES).not.toContain("draft");
    expect(RESEARCH_ACTIVE_STATUSES).not.toContain("complete");
    expect(RESEARCH_POLL_MS).toBeGreaterThan(0);
  });

  it("never shows the store's own state-machine words to an owner", () => {
    // `ready` reads to an owner as "the result is ready" when it means the
    // opposite — the search finished and the writing has not.
    expect(researchStatusLabel("ready")).toBe("Synthesizing");
    expect(researchStatusLabel("queued")).toBe("Waiting");
    expect(researchStatusLabel("collecting")).toBe("Searching");
    const statuses: ResearchProjectStatus[] = [
      "draft", "queued", "collecting", "ready", "complete", "failed", "cancelled",
    ];
    for (const status of statuses) {
      expect(researchStatusLabel(status)).toMatch(/^[A-Z]/);
    }
  });

  it("prefers the runtime's own sentence and appends the counters", () => {
    // The runtime writes the sentence that knows what it is doing; re-deriving
    // one here would produce a second, vaguer account of the same moment.
    expect(researchTaskLine(project({
      status: "collecting",
      progress: { completedQueries: 1, totalQueries: 3, message: "Reading source 3 of 8." },
    }))).toBe("Reading source 3 of 8. (1 of 3)");
  });

  it("says what a waiting run is waiting behind", () => {
    expect(researchTaskLine(project({
      status: "queued",
      progress: {
        completedQueries: 0,
        totalQueries: 1,
        message: "Waiting for a free research slot (3 of 3 running).",
      },
    }))).toContain("3 of 3 running");
  });

  it("never renders an empty line for a project with no progress record", () => {
    expect(researchTaskLine(project({ status: "draft" }))).toMatch(/Not started/);
    expect(researchTaskLine(project({ status: "failed" }))).toMatch(/Nothing was written/);
    expect(researchTaskLine(project({ status: "cancelled" }))).toBe("Cancelled.");
    expect(researchTaskLine(project({ status: "complete" }))).toMatch(/0 sources cited/);
    expect(researchTaskLine(project({ status: "collecting" }))).toMatch(/In progress/);
  });

  it("counts the queries a Start button is about to send, not the textarea's lines", () => {
    // A Start enabled by three blank lines is the disagreement this prevents.
    expect(parseResearchQueries("\n\n   \n")).toEqual([]);
    expect(parseResearchQueries("one\n  two  \none\n")).toEqual(["one", "two"]);
    expect(parseResearchQueries("a\t\tb")).toEqual(["a b"]);
  });
});
