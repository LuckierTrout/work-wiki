/**
 * The composer's non-render concerns, extracted out of `ChatCanvas.tsx`
 * (DW-587).
 *
 * Three things happen at the composer that are not rendering: the Skill scan
 * that fills the picker, the attach that sends bytes through Intake, and the
 * decision about whether what was typed is a `/skill` command or a message.
 * Each is a rule with an outcome, and each is asserted here in the `node`
 * project rather than by mounting Chat and typing into a textarea.
 *
 * Framework-free: no React, no state. Every function below answers a question
 * and the surface performs the writes.
 */

import {
  SKILL_SCAN_URL,
  matchSkills,
  parseSkillCommand,
  type SkillSummary,
} from "./chat-agent";
import { loopbackFetch } from "./loopback-client";
import {
  intakeReport,
  intakeShouldRefresh,
  submitIntakeFiles,
} from "./workbench-intake-client";

/**
 * The Skills on disk right now, or `null` when there is no list to apply.
 *
 * `null` IS NOT `[]`, and the difference is the whole point: `[]` says "there
 * are no Skills", `null` says "the scan said nothing". A caller must leave the
 * list it already has alone on the second, and handing back `[]` would make a
 * failed scan WRITE an empty list and render.
 *
 * A NON-OK ANSWER AND A THROWN FETCH are `null` exactly as they were at
 * `c19a5a29`, where both simply `return`ed without calling `setSkills`. THE
 * THIRD BRANCH IS A DELIBERATE NARROWING, not a pure move: an ok response whose
 * `skills` is not an array used to be read as `[]`. It is `null` here because a
 * malformed body is the scan failing to answer rather than a wiki with no
 * Skills, and the two now have different words. Recorded in the DW-587 spec's
 * Spec Change Log; unobservable in practice, because the scan runs once on
 * mount against a list that starts empty.
 *
 * SKILLS ARE SCANNED, NOT INSTALLED (Story 8.6): this asks the sidecar what is
 * on disk right now, so a `SKILL.md` the owner dropped in a minute ago appears
 * without a reinstall and without a rebuild. A failure is silent on purpose —
 * no Skills is the normal state, and an error banner for it would greet every
 * owner who has never written one.
 */
export async function scanSkills(
  signal?: AbortSignal,
): Promise<SkillSummary[] | null> {
  try {
    const scan = await loopbackFetch(SKILL_SCAN_URL, { cache: "no-store", signal });
    if (!scan.ok) return null;
    const body = (await scan.json()) as { skills?: SkillSummary[] };
    return Array.isArray(body.skills) ? body.skills : null;
  } catch {
    // Sidecar down, API off, or no Skills. All three mean "no list".
    return null;
  }
}

/** What an attach leaves behind: a sentence to show, and a refresh to ask for. */
export interface AttachOutcome {
  /** Intake's report for the batch. Empty means there is nothing to say. */
  note: string;
  /** Whether the trees are worth re-polling — a `requestDataVersionCheck`. */
  refresh: boolean;
}

/**
 * Attach files from the composer (Story 8.5).
 *
 * THROUGH INTAKE, the one arrival path for bytes (FR-2): the file lands under
 * `raw/sources/` and auto-queues a compile, exactly as a drop on the Sources
 * tree does. A Chat-local upload would be a second door with no pipeline behind
 * it, and the Agent would then be asked about a Source that was never compiled.
 *
 * The outcome is REPORTED rather than swallowed: a refused CSV has to say so,
 * or the owner will ask about a file that is not there. The refresh is returned
 * rather than performed, because nudging the watchers is a surface effect and
 * this module causes none.
 */
export async function attachThroughIntake(
  files: readonly File[],
): Promise<AttachOutcome> {
  const outcomes = await submitIntakeFiles(files);
  return { note: intakeReport(outcomes), refresh: intakeShouldRefresh(outcomes) };
}

/** What the composer's text turns out to be. */
export type SkillCommandOutcome =
  /** Not a command. Send it as a message. */
  | { kind: "none" }
  /** Select this Skill, or `null` to run without one. */
  | { kind: "pick"; id: string | null }
  /** Open the picker, filtered to this term. */
  | { kind: "picker"; term: string };

/**
 * `/skill` — a command, not a message.
 *
 * Decided BEFORE the send so it never reaches a provider. A bare `/skill` with
 * Skills available opens the picker rather than clearing blind — "which Skills
 * do I have" is the likelier question, and Clear is one press away inside it —
 * and with none enabled there is nothing to show, so it clears.
 *
 * `/skill <term>` completes against ENABLED Skills only. An exact name wins
 * outright, a single match is taken as meant, and anything else opens the
 * picker on the term. A disabled Skill matches nothing, which is what makes the
 * switch real rather than cosmetic.
 */
export function skillCommandOutcome(
  text: string,
  skills: readonly SkillSummary[],
): SkillCommandOutcome {
  const command = parseSkillCommand(text);
  if (command.kind === "none") return { kind: "none" };
  if (command.kind === "clear") {
    return skills.some((skill) => skill.enabled)
      ? { kind: "picker", term: "" }
      : { kind: "pick", id: null };
  }
  const matches = matchSkills(skills, command.term);
  const exact = matches.find(
    (skill) => skill.name.toLowerCase() === command.term.toLowerCase(),
  );
  if (exact) return { kind: "pick", id: exact.id };
  if (matches.length === 1) return { kind: "pick", id: matches[0].id };
  return { kind: "picker", term: command.term };
}

/**
 * What a hint button leaves in the composer.
 *
 * PREPENDED, and only once: the hint is an instruction for this turn, and a
 * second press adding a second copy would read as emphasis the Agent has no way
 * to honour. Whatever the owner already typed is kept, because the hint is a
 * prefix to their question rather than a replacement for it.
 */
export function composerHintText(current: string, hint: string): string {
  return current.startsWith(hint) ? current : hint + current;
}
