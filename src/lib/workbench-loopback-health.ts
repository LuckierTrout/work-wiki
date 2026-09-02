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

export async function probeLoopbackApiPane(): Promise<{
  health: ClassifiedLoopbackHealth;
  skills: SkillSummary[];
}> {
  let health: ClassifiedLoopbackHealth = "unreachable";
  try {
    const response = await loopbackFetch(LOOPBACK_HEALTH_URL, { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    health = classifyLoopbackHealth(payload);
  } catch {
    health = "unreachable";
  }
  let skills: SkillSummary[] = [];
  try {
    const response = await loopbackFetch(SKILL_SCAN_URL, { cache: "no-store" });
    if (response.ok) {
      const body = (await response.json()) as { skills?: SkillSummary[] };
      if (Array.isArray(body.skills)) skills = body.skills;
    }
  } catch {
    skills = [];
  }
  return { health, skills };
}
