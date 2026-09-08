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
  RAIL_SIDECAR_DOWN_LABEL,
  RAIL_SIDECAR_REFUSED_LABEL,
  TODOS_NON_MEETING_COPY,
  WORKBENCH_MODES,
  badgeAccessibleName,
  chatSidecarDownCopy,
  isWorkbenchModeId,
  railSidecarDownLabel,
  workbenchMode,
} from "../workbench-modes";
/**
 * The THIRD surface the origin rule is spelled out on (DW-750). Imported into
 * this file rather than asserted in its own, because the property below is a
 * correspondence between the three and has no home inside any one of them.
 */
import {
  SETTINGS_API_HEALTH_UNREACHABLE_COPY,
  loopbackHealthSentence,
} from "../workbench-loopback-health";

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

  /**
   * DW-750 — the RAIL dot's half of the same question.
   *
   * The dot said "Sidecar not running" for every `down`, decided by the same
   * origin-blind probe the sentence above already concedes cannot report why it
   * failed — so on a deployed page the rail flatly denied what Chat, from the
   * same probe on the same screen, correctly allowed. Same rule, same degrade,
   * shorter sentence: a dot has no room for the knob, and Chat's paragraph is
   * beside it for the owner who wants the remedy.
   */
  it("chooses the rail dot's down label from the same origin rule", () => {
    // The loopback answer is UNCHANGED, byte for byte — it is what
    // `IconRail.tsx` inlined before the selector existed.
    expect(RAIL_SIDECAR_DOWN_LABEL).toBe("Sidecar not running");
    // The deployed one denies nothing it cannot see, and stays a DOT LABEL:
    // short, no port, no knob, no punctuation a `title` would carry oddly.
    expect(RAIL_SIDECAR_REFUSED_LABEL).toBe("Sidecar not reachable");
    expect(RAIL_SIDECAR_REFUSED_LABEL).not.toBe(RAIL_SIDECAR_DOWN_LABEL);
    expect(RAIL_SIDECAR_REFUSED_LABEL).not.toMatch(/\p{Extended_Pictographic}/u);

    for (const origin of [
      "http://localhost:3000",
      "http://127.0.0.1:19828",
      "http://[::1]:3000",
      "https://localhost",
    ]) {
      expect(railSidecarDownLabel(origin), origin).toBe(RAIL_SIDECAR_DOWN_LABEL);
    }
    for (const origin of [
      "https://app.example",
      "http://app.example:8080",
      "https://localhost.evil.test",
    ]) {
      expect(railSidecarDownLabel(origin), origin).toBe(RAIL_SIDECAR_REFUSED_LABEL);
    }
    // The conservative degrade, for exactly the same reasons: the server render,
    // the first client render, and everything that is not an origin at all.
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
      expect(railSidecarDownLabel(origin), String(origin)).toBe(
        RAIL_SIDECAR_DOWN_LABEL,
      );
    }
  });

  /**
   * ALL THREE selectors agree on every input, which is the property DW-750 is
   * about — one probe, one screen, and no surface allowed to contradict another
   * about what a failed probe means.
   *
   * THREE, not two. The origin rule is spelled out three times: here in
   * `chatSidecarDownCopy` and `railSidecarDownLabel`, and again inline on
   * `loopbackHealthSentence`'s `unreachable` arm over in
   * `workbench-loopback-health.ts`. A pair-wise assertion would let a future
   * origin form be added to two of the three and leave the Settings health line
   * disagreeing with both, green — the exact drift this entry closes. So the
   * Settings surface is a row of the correspondence, not a separate suite.
   *
   * Asserted as a correspondence rather than by re-listing each rule's expected
   * output: those rows are pinned per-selector above and in
   * `loopback-health-sentence.test.ts`. What this adds is that the three answer
   * the same QUESTION the same way, whatever the rows become.
   */
  it("keeps all three origin-sensitive surfaces in agreement about every origin", () => {
    for (const origin of [
      "http://localhost:3000",
      "http://127.0.0.1:19828",
      "http://[::1]:3000",
      "https://localhost",
      "https://app.example",
      "http://app.example:8080",
      "https://localhost.evil.test",
      null,
      undefined,
      "",
      "   ",
      "null",
      "not a url",
      "http://[::1].evil.test",
      "file:///Users/owner/page.html",
    ]) {
      // "Does this origin get the CONSERVATIVE sentence?", asked of each
      // surface in its own vocabulary.
      const railSaysDown = railSidecarDownLabel(origin) === RAIL_SIDECAR_DOWN_LABEL;
      const chatSaysDown = chatSidecarDownCopy(origin) === CHAT_SIDECAR_DOWN_COPY;
      const paneSaysDown =
        loopbackHealthSentence("unreachable", origin) ===
        SETTINGS_API_HEALTH_UNREACHABLE_COPY;
      expect(railSaysDown, String(origin)).toBe(chatSaysDown);
      expect(paneSaysDown, String(origin)).toBe(chatSaysDown);
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
