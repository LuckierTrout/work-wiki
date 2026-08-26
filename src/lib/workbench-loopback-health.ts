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
