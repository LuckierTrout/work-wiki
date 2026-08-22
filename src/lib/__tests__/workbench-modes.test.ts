/**
 * Story 1.3 — the rail's vocabulary is a contract, not a preference.
 *
 * Order is fixed by the AC and `epics.md`; five of the empty-state sentences
 * are quoted from the UX handoff (`EXPERIENCE.md` State Patterns) and must
 * match character-exact, because "improving" one of them silently diverges the
 * product from the design of record. The rest are authored to the same voice:
 * one unsentimental sentence, no emoji, no encouragement.
 */
import { describe, expect, it } from "vitest";
import {
  BADGE_MODE_NOUNS,
  CHAT_SIDECAR_DOWN_COPY,
  CHAT_SIDECAR_UP_COPY,
  DEFAULT_WORKBENCH_MODE,
  GRAPH_NARROW_COPY,
  WORKBENCH_MODES,
  badgeAccessibleName,
  isWorkbenchModeId,
  workbenchMode,
} from "../workbench-modes";

/** Quoted from `EXPERIENCE.md` — do not retype, copy. */
const HANDOFF_COPY: Record<string, string> = {
  chat: "Start a new conversation. Click New Chat to begin.",
  search: "Press Enter to search.",
  lint: "Run lint to check wiki health.",
  review: "No pending cards.",
  research: "No research tasks yet. Enter a topic above or click Deep Research in Review.",
  todos: "No candidates. Meeting ingest will propose them.",
};

describe("rail order and labels", () => {
  it("is the ten modes in the AC's order", () => {
    expect(WORKBENCH_MODES.map((mode) => mode.id)).toEqual([
      "wiki",
      "chat",
      "sources",
      "search",
      "graph",
      "lint",
      "todos",
      "review",
      "research",
      "skills",
    ]);
    expect(WORKBENCH_MODES.map((mode) => mode.label)).toEqual([
      "Wiki",
      "Chat",
      "Sources",
      "Search",
      "Graph",
      "Lint",
      "Todos",
      "Review",
      "Deep Research",
      "Skills",
    ]);
  });

  it("defaults to Wiki", () => {
    expect(DEFAULT_WORKBENCH_MODE).toBe("wiki");
    expect(workbenchMode("wiki").label).toBe("Wiki");
  });
});

describe("empty-state copy", () => {
  it("gives every unbuilt mode exactly one plain sentence", () => {
    for (const mode of WORKBENCH_MODES) {
      if (mode.id === "wiki") {
        // Wiki's canvas is Story 1.2's real surface — an empty sentence here
        // would render on top of it.
        expect(mode.emptyState).toBeNull();
        continue;
      }
      const copy = mode.emptyState ?? "";
      expect(copy.length).toBeGreaterThan(0);
      expect(copy.trim()).toBe(copy);
      expect(copy.endsWith(".")).toBe(true);
      // No illustration, no emoji, no encouragement (UX-DR23).
      expect(copy).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(copy).not.toMatch(/!/);
    }
  });

  it("quotes the UX handoff character-exact", () => {
    for (const [id, expected] of Object.entries(HANDOFF_COPY)) {
      const mode = WORKBENCH_MODES.find((item) => item.id === id);
      expect(mode?.emptyState).toBe(expected);
    }
  });

  it("names the sidecar port in the fail-closed Chat sentence", () => {
    // The port is the only actionable detail: the Worker cannot reach
    // localhost, so there is nothing else to tell the owner to do.
    expect(CHAT_SIDECAR_DOWN_COPY).toContain("127.0.0.1:19828");
    expect(CHAT_SIDECAR_UP_COPY).toBe(HANDOFF_COPY.chat);
    expect(GRAPH_NARROW_COPY).toBe("The graph needs a wider window.");
  });
});

describe("badge accessible names", () => {
  it("carries count and noun, not colour alone", () => {
    expect(badgeAccessibleName("Review", 62, "pending reviews")).toBe(
      "Review, 62 pending reviews",
    );
    expect(badgeAccessibleName("Todos", 3, "todo candidates")).toBe(
      "Todos, 3 todo candidates",
    );
  });

  it("supplies a noun for exactly the two badged modes", () => {
    expect(Object.keys(BADGE_MODE_NOUNS).sort()).toEqual(["review", "todos"]);
    expect(BADGE_MODE_NOUNS.todos).toBe("todo candidates");
    expect(BADGE_MODE_NOUNS.review).toBe("pending reviews");
  });
});

describe("isWorkbenchModeId", () => {
  it("accepts every shipped id and nothing else", () => {
    for (const mode of WORKBENCH_MODES) expect(isWorkbenchModeId(mode.id)).toBe(true);
    for (const value of ["chatt", "", "Wiki", "[1,2]", null, undefined, 3, {}]) {
      expect(isWorkbenchModeId(value)).toBe(false);
    }
  });
});
