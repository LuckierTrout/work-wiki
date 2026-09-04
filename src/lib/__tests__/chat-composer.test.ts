/**
 * The composer's non-render concerns (DW-587).
 *
 * The Skill scan, the attach, and the `/skill` decision are rules with
 * outcomes, and every one of them used to be reachable only by mounting Chat
 * and typing into a textarea. The two doors are mocked at their own modules —
 * `loopbackFetch` for the sidecar scan and `submitIntakeFiles` for Intake — so
 * a second door opened around either would be visible here rather than silently
 * passing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loopbackFetch, submitIntakeFiles } = vi.hoisted(() => ({
  loopbackFetch: vi.fn(),
  submitIntakeFiles: vi.fn(),
}));
vi.mock("../loopback-client", () => ({ loopbackFetch }));
// Only the DOOR is replaced: `intakeReport` and `intakeShouldRefresh` are
// Intake's own rules, and a copy of them here would be a second sentence to
// drift from the one the owner actually reads.
vi.mock("../workbench-intake-client", async () => {
  const actual =
    await vi.importActual<typeof import("../workbench-intake-client")>(
      "../workbench-intake-client",
    );
  return { ...actual, submitIntakeFiles };
});

import { SKILL_SCAN_URL, type SkillSummary } from "../chat-agent";
import {
  attachThroughIntake,
  composerHintText,
  scanSkills,
  skillCommandOutcome,
} from "../chat-composer";
import { intakeStoredCopy } from "../workbench-intake";

const SKILLS: SkillSummary[] = [
  {
    id: "recap-id",
    name: "recap",
    description: "Write a meeting recap",
    scope: "project",
    enabled: true,
  },
  {
    id: "recall-id",
    name: "recall",
    description: "Recall a decision",
    scope: "project",
    enabled: true,
  },
  {
    id: "offsite-id",
    name: "offsite",
    description: "Plan an offsite",
    scope: "user",
    enabled: false,
  },
];

beforeEach(() => {
  loopbackFetch.mockReset();
  submitIntakeFiles.mockReset();
});

describe("scanning the Skills on disk", () => {
  it("reads the sidecar's scan door and hands back the list", async () => {
    loopbackFetch.mockResolvedValue(
      new Response(JSON.stringify({ skills: SKILLS }), { status: 200 }),
    );
    await expect(scanSkills()).resolves.toEqual(SKILLS);
    expect(loopbackFetch.mock.calls[0]?.[0]).toBe(SKILL_SCAN_URL);
    // `no-store`, because "what is on disk right now" is the whole point of a
    // scan the owner expects to reflect a `SKILL.md` written a minute ago.
    expect(loopbackFetch.mock.calls[0]?.[1]?.cache).toBe("no-store");
  });

  it("forwards the caller's signal so an unmount ends the scan", async () => {
    const controller = new AbortController();
    loopbackFetch.mockResolvedValue(
      new Response(JSON.stringify({ skills: [] }), { status: 200 }),
    );
    await scanSkills(controller.signal);
    expect(loopbackFetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("answers null — not an empty list — when the door refuses", async () => {
    // NULL IS "NO LIST TO APPLY". An empty array would make the surface WRITE a
    // fresh empty list and render, which the silent path never did.
    loopbackFetch.mockResolvedValue(new Response("{}", { status: 503 }));
    await expect(scanSkills()).resolves.toBeNull();
  });

  it("answers null when the fetch itself throws", async () => {
    loopbackFetch.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(scanSkills()).resolves.toBeNull();
  });

  it("answers null when the body's skills is not an array", async () => {
    loopbackFetch.mockResolvedValue(
      new Response(JSON.stringify({ skills: "recap" }), { status: 200 }),
    );
    await expect(scanSkills()).resolves.toBeNull();
    loopbackFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    await expect(scanSkills()).resolves.toBeNull();
  });

  it("answers an empty list when the scan genuinely found no Skills", async () => {
    // The one case that IS a list: no Skills is the normal state, and the
    // surface is entitled to render it as such.
    loopbackFetch.mockResolvedValue(
      new Response(JSON.stringify({ skills: [] }), { status: 200 }),
    );
    await expect(scanSkills()).resolves.toEqual([]);
  });
});

describe("attaching through Intake", () => {
  /** Real files, so "which bytes went through the door" is actually asserted. */
  const NOTES = new File(["# notes\n"], "notes.md", { type: "text/markdown" });
  const ROWS = new File(["a,b\n"], "rows.csv", { type: "text/csv" });

  it("hands Intake exactly the files it was given, in order", async () => {
    // The whole function is a forward, so the ARGUMENT is the thing that can be
    // wrong: dropping a file, reordering, or passing nothing would leave every
    // assertion about the returned report true and the attach broken.
    submitIntakeFiles.mockResolvedValue([]);
    await attachThroughIntake([NOTES, ROWS]);
    expect(submitIntakeFiles).toHaveBeenCalledTimes(1);
    expect(submitIntakeFiles.mock.calls[0]?.[0]).toEqual([NOTES, ROWS]);
    expect(
      (submitIntakeFiles.mock.calls[0]?.[0] as File[]).map((file) => file.name),
    ).toEqual(["notes.md", "rows.csv"]);
  });

  it("reports the batch and asks for a refresh when something landed", async () => {
    submitIntakeFiles.mockResolvedValue([
      { name: "notes.md", error: null, unconfirmed: false, disposition: "queued" },
      {
        name: "rows.csv",
        error: "CSV is not a source this wiki can read.",
        unconfirmed: false,
        disposition: "refused",
      },
    ]);
    const outcome = await attachThroughIntake([NOTES, ROWS]);
    expect(submitIntakeFiles.mock.calls[0]?.[0]).toEqual([NOTES, ROWS]);
    // BOTH HALVES: reporting only the file that landed would hide a refusal,
    // and reporting only the refusal would hide a Source that is compiling.
    expect(outcome.note).toContain(intakeStoredCopy(1));
    expect(outcome.note).toContain("rows.csv: CSV is not a source this wiki can read.");
    expect(outcome.refresh).toBe(true);
  });

  it("owes no refresh when nothing arrived", async () => {
    submitIntakeFiles.mockResolvedValue([
      {
        name: "rows.csv",
        error: "CSV is not a source this wiki can read.",
        unconfirmed: false,
        disposition: "refused",
      },
    ]);
    const outcome = await attachThroughIntake([ROWS]);
    expect(submitIntakeFiles.mock.calls[0]?.[0]).toEqual([ROWS]);
    expect(outcome.refresh).toBe(false);
  });

  it("has nothing to say for an empty report", async () => {
    submitIntakeFiles.mockResolvedValue([]);
    await expect(attachThroughIntake([NOTES])).resolves.toEqual({
      note: "",
      refresh: false,
    });
    expect(submitIntakeFiles.mock.calls[0]?.[0]).toEqual([NOTES]);
  });

  it("lets Intake's own failure reach the caller", async () => {
    submitIntakeFiles.mockRejectedValue(new Error("Attach failed."));
    await expect(attachThroughIntake([NOTES])).rejects.toThrow("Attach failed.");
  });
});

describe("reading the composer as a /skill command", () => {
  it("opens the picker on a bare /skill when there are Skills to show", () => {
    expect(skillCommandOutcome("/skill", SKILLS)).toEqual({ kind: "picker", term: "" });
  });

  it("clears the Skill on a bare /skill when none is enabled", () => {
    const disabled = SKILLS.filter((skill) => !skill.enabled);
    expect(skillCommandOutcome("/skill", disabled)).toEqual({ kind: "pick", id: null });
    expect(skillCommandOutcome("/skill", [])).toEqual({ kind: "pick", id: null });
  });

  it("picks the Skill an exact name names", () => {
    expect(skillCommandOutcome("/skill recap", SKILLS)).toEqual({
      kind: "pick",
      id: "recap-id",
    });
  });

  it("picks a term's single enabled match", () => {
    expect(skillCommandOutcome("/skill recall", SKILLS)).toEqual({
      kind: "pick",
      id: "recall-id",
    });
  });

  it("matches no disabled Skill, so a term that only names one opens the picker", () => {
    // THE ACCEPTANCE CRITERION, not a nicety: `offsite` is the only Skill whose
    // name contains `offs`, and it is disabled. Offering it would make it
    // selectable, store it on the Conversation, and then have `readSkill` refuse
    // it on every turn — a switch that appears to do nothing until the Agent
    // behaves as if the Skill were missing.
    expect(skillCommandOutcome("/skill offs", SKILLS)).toEqual({
      kind: "picker",
      term: "offs",
    });
    // Even the exact name does not select it.
    expect(skillCommandOutcome("/skill offsite", SKILLS)).toEqual({
      kind: "picker",
      term: "offsite",
    });
  });

  it("opens the picker on the term when the term is ambiguous", () => {
    expect(skillCommandOutcome("/skill rec", SKILLS)).toEqual({
      kind: "picker",
      term: "rec",
    });
  });

  it("treats anything else as a message to send", () => {
    expect(skillCommandOutcome("recap the call", SKILLS)).toEqual({ kind: "none" });
    expect(skillCommandOutcome("ask about /skill later", SKILLS)).toEqual({
      kind: "none",
    });
    expect(skillCommandOutcome("", SKILLS)).toEqual({ kind: "none" });
  });
});

describe("what a hint button leaves in the composer", () => {
  const HINT = "Search the web for this if the wiki does not cover it: ";

  it("prepends the hint to what the owner already typed", () => {
    expect(composerHintText("How is revenue?", HINT)).toBe(`${HINT}How is revenue?`);
    expect(composerHintText("", HINT)).toBe(HINT);
  });

  it("adds it once, however many times the button is pressed", () => {
    const once = composerHintText("How is revenue?", HINT);
    expect(composerHintText(once, HINT)).toBe(once);
  });
});
