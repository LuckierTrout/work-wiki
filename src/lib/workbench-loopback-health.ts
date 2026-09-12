import { SIDECAR_PAIRING_COPY } from "./sidecar-pairing";
/**
 * Live classification of whatever answers on 127.0.0.1:19828.
 *
 * Settings used to only link `/health`. A foreign process on that port has to
 * be named `port_conflict` here, not inferred by the branded skill alone.
 */

import { SKILL_SCAN_URL, type SkillSummary } from "./chat-agent";
import { loopbackFetch } from "./loopback-client";
import { LOOPBACK_HEALTH_URL, LOOPBACK_STATUSES, type LoopbackStatus } from "./v1-contract";
/**
 * The origin predicates the Chat canvas already selects its fail-closed sentence
 * with (DW-607/DW-750). Imported rather than re-derived so the two surfaces
 * degrade identically; `workbench-modes` reaches only `sidecar.ts`, which
 * imports nothing, so there is no cycle back into this module.
 */
import { isPageOrigin } from "./workbench-modes";
import { isSidecarDefaultAdmittedOrigin } from "./sidecar";

export type ClassifiedLoopbackHealth = LoopbackStatus | "unreachable" | "pairing_mismatch";

export function classifyLoopbackHealth(payload: unknown): ClassifiedLoopbackHealth {
  if (!payload || typeof payload !== "object") return "error";
  const status = (payload as { status?: unknown }).status;
  if (status === "pairing_mismatch") return status;
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
/**
 * The same failed probe, on a page the sidecar does not admit by default
 * (DW-750).
 *
 * `unreachable` is a browser fetch that REJECTED, and DW-607 already conceded
 * that such a rejection cannot report why: a refused connection and a CORS
 * refusal reach the page as the same opaque failure. On a loopback origin the
 * door is open without configuration, so the sentence above is the honest one.
 * Anywhere else the sidecar may be running and simply refusing this origin —
 * and the pane was flatly asserting a dead process while the Chat canvas, from
 * the same probe on the same screen, said the opposite.
 *
 * NAMES BOTH CAUSES AND THE KNOB, unlike the rail's two-word dot label: this is
 * a paragraph in Settings, which is exactly where an owner has come to fix the
 * thing, and `WORKWIKI_SIDECAR_ALLOWED_ORIGINS` is the remedy for the half they
 * cannot otherwise guess.
 */
export const SETTINGS_API_HEALTH_UNREACHABLE_ORIGIN_COPY =
  "Nothing answered on 127.0.0.1:19828 from this page. Either the sidecar is " +
  "not running, or it is running and refused this page’s origin — add it to " +
  "WORKWIKI_SIDECAR_ALLOWED_ORIGINS.";
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
 *
 * ONLY `unreachable` READS THE ORIGIN (DW-750). `error` is a health payload that
 * ARRIVED: the request completed, so the door admitted this page and its origin
 * says nothing more about what is wrong — describing an answered probe as a
 * possible CORS refusal would be a worse claim than the shared one. The other
 * three states are the listener's own report of itself and are origin-blind for
 * the same reason.
 *
 * @param pageOrigin — this page's own origin, or nothing. Absent, unparseable
 * and loopback all degrade to {@link SETTINGS_API_HEALTH_UNREACHABLE_COPY}, the
 * sentence this function has always answered — so a caller that does not pass it
 * renders byte-identically to before the argument existed, and the pane's first
 * client render matches the server's.
 */
export function loopbackHealthSentence(
  health: ClassifiedLoopbackHealth,
  pageOrigin?: string | null,
): string {
  switch (health) {
    case "pairing_mismatch":
      return SIDECAR_PAIRING_COPY;
    case "starting":
      return SETTINGS_API_HEALTH_STARTING_COPY;
    case "running":
      return SETTINGS_API_HEALTH_RUNNING_COPY;
    case "port_conflict":
      return SETTINGS_API_HEALTH_PORT_CONFLICT_COPY;
    case "unreachable":
      return isSidecarDefaultAdmittedOrigin(pageOrigin) || !isPageOrigin(pageOrigin)
        ? SETTINGS_API_HEALTH_UNREACHABLE_COPY
        : SETTINGS_API_HEALTH_UNREACHABLE_ORIGIN_COPY;
    case "error":
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
  if (health === "pairing_mismatch") return { health, skills };
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
