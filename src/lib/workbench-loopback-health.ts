/**
 * Live classification of whatever answers on 127.0.0.1:19828.
 *
 * Settings used to only link `/health`. A foreign process on that port has to
 * be named `port_conflict` here, not inferred by the branded skill alone.
 */

import { SKILL_SCAN_URL, type SkillSummary } from "./chat-agent";
import { loopbackFetch } from "./loopback-client";
import { LOOPBACK_HEALTH_URL, LOOPBACK_STATUSES, type LoopbackStatus } from "./v1-contract";

export type ClassifiedLoopbackHealth = LoopbackStatus | "unreachable";

export function classifyLoopbackHealth(payload: unknown): ClassifiedLoopbackHealth {
  if (!payload || typeof payload !== "object") return "error";
  const status = (payload as { status?: unknown }).status;
  if (
    typeof status === "string" &&
    (LOOPBACK_STATUSES as readonly string[]).includes(status)
  ) {
    return status as LoopbackStatus;
  }
  return "port_conflict";
}

export const SETTINGS_API_HEALTH_UNREACHABLE_COPY =
  "The sidecar is not running on 127.0.0.1:19828.";
export const SETTINGS_API_HEALTH_PORT_CONFLICT_COPY =
  "Something else owns port 19828. That process is not this wiki.";
export const SETTINGS_API_HEALTH_RUNNING_COPY =
  "The sidecar is running on 127.0.0.1:19828.";
/**
 * `starting` is a listener that has NOT BOUND YET — see `LOOPBACK_STATUSES`.
 *
 * It had no sentence of its own until DW-633, and the pane's ternary answered
 * for `port_conflict` and the two dead states and then fell through to
 * "running" — so a sidecar still coming up was described as serving, and an
 * owner whose first call got a refused connection had been told the door was
 * open. The two facts an owner needs here are that the process EXISTS and that
 * it is not answering yet, which is neither of the sentences above.
 */
export const SETTINGS_API_HEALTH_STARTING_COPY =
  "The sidecar is starting on 127.0.0.1:19828. It is not answering calls yet.";

/**
 * The one sentence that describes a classified health, for every value of it.
 *
 * An exhaustive `switch` rather than the pane's chain of ternaries, for the
 * reason DW-633 exists: a chain has a fallthrough arm, and whatever status
 * nobody thought about lands there silently. Here the `never` assignment below
 * is a COMPILE error the moment `ClassifiedLoopbackHealth` grows a fifth value,
 * so a new status cannot ship being described as running.
 *
 * `error` and `unreachable` share a sentence deliberately: a listener that died
 * and a connection that was refused are the same fact to the owner — nothing is
 * serving on 19828 — and the remedy is the same one.
 */
export function loopbackHealthSentence(health: ClassifiedLoopbackHealth): string {
  switch (health) {
    case "starting":
      return SETTINGS_API_HEALTH_STARTING_COPY;
    case "running":
      return SETTINGS_API_HEALTH_RUNNING_COPY;
    case "port_conflict":
      return SETTINGS_API_HEALTH_PORT_CONFLICT_COPY;
    case "error":
    case "unreachable":
      return SETTINGS_API_HEALTH_UNREACHABLE_COPY;
    default: {
      const unhandled: never = health;
      throw new Error(`Unhandled loopback health: ${String(unhandled)}`);
    }
  }
}

/**
 * What the pane says when the Skills scan DID NOT ANSWER (DW-716).
 *
 * The scan used to be swallowed into `skills: []` on all three of its failure
 * paths, and the pane appended `${skills.length} Skills on disk.` to whatever
 * health sentence it had chosen — so a wiki with no sidecar running read "The
 * sidecar is not running on 127.0.0.1:19828. 0 Skills on disk.", which states
 * as a counted fact something nothing ever counted. An owner with a folder full
 * of Skills was being told they had none.
 *
 * Carries NO digit, deliberately: "unknown" must not be spelled like a count.
 */
export const SETTINGS_API_SKILLS_UNKNOWN_COPY =
  "The Skills scan did not answer, so the number on disk is unknown.";

/**
 * The one sentence the pane makes about Skills on disk, for every outcome.
 *
 * The same shape as `loopbackHealthSentence` above and for the same reason: the
 * count claim lives in ONE place that has to answer for every value its input
 * can take. `null` is the scan that did not answer; an array — including an
 * EMPTY one — is a scan that did, and a real zero is still a fact worth saying.
 * The `never` assignment is a compile error the moment the argument grows a
 * third shape, so a new outcome cannot ship being counted.
 */
export function loopbackSkillCountSentence(skills: SkillSummary[] | null): string {
  if (skills === null) return SETTINGS_API_SKILLS_UNKNOWN_COPY;
  if (Array.isArray(skills)) {
    return skills.length === 1 ? "1 Skill on disk." : `${skills.length} Skills on disk.`;
  }
  const unhandled: never = skills;
  throw new Error(`Unhandled Skills scan outcome: ${String(unhandled)}`);
}

export async function probeLoopbackApiPane(): Promise<{
  health: ClassifiedLoopbackHealth;
  /** `null` is "the scan did not answer" — NEVER an empty list (DW-716). */
  skills: SkillSummary[] | null;
}> {
  let health: ClassifiedLoopbackHealth = "unreachable";
  try {
    const response = await loopbackFetch(LOOPBACK_HEALTH_URL, { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    health = classifyLoopbackHealth(payload);
  } catch {
    health = "unreachable";
  }
  // Starts UNKNOWN and is only ever written by a scan that actually answered
  // with a list. A rejected call, a non-OK response and a body carrying no
  // `skills` array are three ways of not knowing, and none of them is zero.
  let skills: SkillSummary[] | null = null;
  try {
    const response = await loopbackFetch(SKILL_SCAN_URL, { cache: "no-store" });
    if (response.ok) {
      const body = (await response.json()) as { skills?: SkillSummary[] };
      if (Array.isArray(body.skills)) skills = body.skills;
    }
  } catch {
    skills = null;
  }
  return { health, skills };
}
