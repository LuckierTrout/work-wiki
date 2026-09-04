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
  CHAT_COMPOSER_PLACEHOLDER,
  CHAT_COVERAGE_MISSING_COPY,
  CHAT_SIDECAR_DOWN_COPY,
  CHAT_SIDECAR_UNREACHABLE_COPY,
  CHAT_SIDECAR_UP_COPY,
  DEFAULT_WORKBENCH_MODE,
  GRAPH_NARROW_COPY,
  TODOS_NON_MEETING_COPY,
  WORKBENCH_MODES,
  badgeAccessibleName,
  chatSidecarDownCopy,
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
    expect(CHAT_COVERAGE_MISSING_COPY).toBe(
      "Wiki has no coverage for this. Ingest a source or run Deep Research.",
    );
    expect(CHAT_COMPOSER_PLACEHOLDER).toBe("Type a message…");
    expect(GRAPH_NARROW_COPY).toBe("The graph needs a wider window.");
    expect(TODOS_NON_MEETING_COPY).toBe(
      "This Source is not a meeting. Mark as meeting to extract Todos.",
    );
  });

  /**
   * DW-607 — the fail-closed sentence is now a CHOICE, and the rule is pure.
   *
   * `CHAT_SIDECAR_DOWN_COPY` told every owner to start a process, including the
   * one whose sidecar was already running and whose deployed origin the door
   * simply refuses. The probe cannot say which failure it met — a refused
   * connection and a CORS refusal are the same rejected fetch — so the sentence
   * is selected from the one fact the page holds for free: its own origin.
   * Executed here rather than argued from a mount, because it is a function.
   */
  it("chooses the fail-closed sentence from the page's own origin", () => {
    // The value is UNCHANGED: on a loopback page the old sentence is still the
    // right one, byte for byte.
    expect(CHAT_SIDECAR_DOWN_COPY).toBe(
      "Start the local sidecar on 127.0.0.1:19828 to use Chat.",
    );
    // The new sibling names the port AND the knob, and neither cause alone.
    expect(CHAT_SIDECAR_UNREACHABLE_COPY).toContain("127.0.0.1:19828");
    expect(CHAT_SIDECAR_UNREACHABLE_COPY).toContain(
      "WORKWIKI_SIDECAR_ALLOWED_ORIGINS",
    );
    expect(CHAT_SIDECAR_UNREACHABLE_COPY).not.toBe(CHAT_SIDECAR_DOWN_COPY);
    expect(CHAT_SIDECAR_UNREACHABLE_COPY).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(CHAT_SIDECAR_UNREACHABLE_COPY).not.toMatch(/!/);

    // Every row of the copy half of the I/O matrix.
    for (const origin of [
      "http://localhost:3000",
      "http://127.0.0.1:19828",
      "http://[::1]:3000",
      "https://localhost",
    ]) {
      expect(chatSidecarDownCopy(origin)).toBe(CHAT_SIDECAR_DOWN_COPY);
    }
    for (const origin of [
      "https://app.example",
      "http://app.example:8080",
      "https://localhost.evil.test",
    ]) {
      expect(chatSidecarDownCopy(origin)).toBe(CHAT_SIDECAR_UNREACHABLE_COPY);
    }
    // Before the origin is known, and for anything that is not an origin at
    // all, the answer degrades to the sentence that is true more often — which
    // is also what keeps the server render and the first client render equal.
    // `http://[::1].evil.test` belongs here rather than above: the door refuses
    // it, but no browser can be SERVED from it — it does not parse as a URL —
    // so as a page origin it is unknown, not deployed.
    for (const origin of [
      null,
      undefined,
      "",
      "   ",
      "null",
      "not a url",
      "http://[::1].evil.test",
      "file:///Users/owner/page.html",
    ]) {
      expect(chatSidecarDownCopy(origin)).toBe(CHAT_SIDECAR_DOWN_COPY);
    }
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
