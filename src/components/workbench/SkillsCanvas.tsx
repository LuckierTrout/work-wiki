"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { send } from "@/lib/workbench-request";
import { workbenchMode } from "@/lib/workbench-modes";
import {
  SKILLS_SCAN_FAILED_COPY,
  SKILLS_SCAN_HINT_COPY,
  SKILL_DISABLED_NOTE_COPY,
  SKILL_SCAN_URL,
  skillScopeLabel,
  skillToggleLabel,
  type SkillSummary,
} from "@/lib/chat-agent";
import {
  fetchWorkbenchSettings,
  saveWorkbenchSettings,
  SETTINGS_LOAD_FAILED_COPY,
  SETTINGS_SAVE_FAILED_COPY,
} from "@/lib/workbench-settings";

/**
 * The Skills rail: every `SKILL.md` on disk, and the switch that hides one
 * (Story 8.6).
 *
 * A SCAN, NOT AN INVENTORY. The list comes from the sidecar every time this
 * canvas becomes active, so a pack the owner dropped into `skills/` a minute ago
 * is here without a reinstall and without a rebuild — that is the acceptance
 * criterion, and it is why nothing on this surface is cached across visits.
 *
 * THE SWITCH WRITES TO THE KERNEL, not to the sidecar. `skillEnablement` lives
 * on `AppConfig` beside the API switch: the sidecar reads it on its settings
 * poll, so one store holds the decision and the Agent, the `/skill` picker and
 * this list cannot disagree about it. Writing it to the sidecar would put the
 * owner's decision on the one process that does not survive a restart.
 *
 * Absent from the map means ENABLED, so the switch only ever writes the single
 * id it touched — see `AppConfig.skillEnablement`. A full map sent from a stale
 * scan would drop decisions about packs this list never saw.
 */
export interface SkillsCanvasProps {
  /** The Skills rail is showing. A hidden canvas does not scan. */
  active: boolean;
  readOnly?: boolean;
}

export function SkillsCanvas({ active, readOnly = false }: SkillsCanvasProps) {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * The loopback token, read the same way Chat reads it.
   *
   * The scan is a sidecar route behind the API switch, and this browser is a
   * client of its own door — see `ChatCanvas`'s `doorToken`.
   */
  const doorToken = useRef<string | null>(null);

  const scan = useCallback(async (signal?: AbortSignal) => {
    try {
      const settings = await send<{ token?: string | null }>(
        "/api/v1/loopback-settings",
        { method: "GET" },
      );
      doorToken.current =
        typeof settings.token === "string" && settings.token ? settings.token : null;
    } catch {
      doorToken.current = null;
    }
    try {
      // A raw fetch: the sidecar is another origin, and `send` is the kernel's
      // parsed-body helper.
      const read = await fetch(SKILL_SCAN_URL, {
        cache: "no-store",
        ...(signal ? { signal } : {}),
        headers: doorToken.current
          ? { authorization: `Bearer ${doorToken.current}` }
          : {},
      });
      if (!read.ok) {
        setError(SKILLS_SCAN_FAILED_COPY);
        setSkills([]);
        return;
      }
      const body = (await read.json()) as { skills?: SkillSummary[] };
      setError(null);
      setSkills(Array.isArray(body.skills) ? body.skills : []);
    } catch {
      if (signal?.aborted) return;
      // Sidecar down or API off. Named, unlike in Chat: this surface exists to
      // answer "which Skills do I have", and a silent empty list would read as
      // "none" when the truth is "nobody asked".
      setError(SKILLS_SCAN_FAILED_COPY);
      setSkills([]);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void scan(controller.signal);
    return () => controller.abort();
  }, [active, scan]);

  /**
   * Flip one Skill.
   *
   * THE VERSION IS RE-READ per click rather than held, because the Settings pane
   * writes the same file: a version cached when the rail opened would make the
   * first toggle after a save a 412 the owner cannot explain. The write carries
   * one id, and `updateConfig` merges it key-by-key.
   */
  async function toggle(skill: SkillSummary) {
    if (readOnly || busy) return;
    setBusy(skill.id);
    setError(null);
    try {
      const seeded = await fetchWorkbenchSettings();
      const version = seeded.status === "ok" ? seeded.payload.version : undefined;
      if (!version) {
        // REFUSED RATHER THAN SENT. `PUT /api/settings` requires `If-Match` and
        // answers 428 without one, so a version-less write would fail anyway —
        // and it would fail with a precondition sentence about a header the
        // owner never saw. Saying the read failed is the actionable half.
        setError(SETTINGS_LOAD_FAILED_COPY);
        return;
      }
      const result = await saveWorkbenchSettings(
        { skillEnablement: { [skill.id]: !skill.enabled } },
        { version },
      );
      if (result.status !== "ok") {
        setError(result.status === "error" ? result.message : SETTINGS_SAVE_FAILED_COPY);
        return;
      }
      // Re-scanned rather than patched in place: the scan is the source of truth
      // for this list, and a local flip would show an enablement the sidecar has
      // not read yet.
      await scan();
    } catch {
      setError(SETTINGS_SAVE_FAILED_COPY);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="wb-skills">
      <p className="wb-skills-hint">{SKILLS_SCAN_HINT_COPY}</p>
      {error ? (
        <p className="wb-skills-error" role="status">
          {error}
        </p>
      ) : null}
      {skills !== null && skills.length === 0 && !error ? (
        <p className="wb-empty">{workbenchMode("skills").emptyState}</p>
      ) : null}
      {skills !== null && skills.length > 0 ? (
        <ul className="wb-skills-list">
          {skills.map((skill) => (
            <li
              key={skill.id}
              className={`wb-skill${skill.enabled ? "" : " wb-skill--off"}`}
            >
              <div className="wb-skill-head">
                <strong className="wb-skill-name">{skill.name}</strong>
                <span className="wb-skill-scope">{skillScopeLabel(skill.scope)}</span>
              </div>
              {skill.description ? (
                <p className="wb-skill-desc">{skill.description}</p>
              ) : null}
              {skill.enabled ? null : (
                <p className="wb-skill-note">{SKILL_DISABLED_NOTE_COPY}</p>
              )}
              <button
                type="button"
                className="wb-skill-toggle"
                disabled={readOnly || busy !== null}
                aria-disabled={readOnly || busy !== null}
                onClick={() => void toggle(skill)}
              >
                {skillToggleLabel(skill)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
