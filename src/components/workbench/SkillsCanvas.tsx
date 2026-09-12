"use client";

import { SIDECAR_PAIRING_COPY } from "@/lib/sidecar-pairing";

import { useCallback, useEffect, useRef, useState } from "react";
import { SurfacePresentation, useSurfaceVisible } from "@/hooks/useSurfaceVisibility";
import { loopbackFetch } from "@/lib/loopback-client";
import { workbenchMode } from "@/lib/workbench-modes";
import {
  SKILLS_SCAN_FAILED_COPY,
  SKILLS_SCAN_HINT_COPY,
  SKILL_DISABLED_NOTE_COPY,
  SKILL_SCAN_URL,
  skillScopeLabel,
  skillToggleLabel,
  skillsScanRefusalCopy,
  type SkillSummary,
} from "@/lib/chat-agent";
import {
  fetchWorkbenchSettings,
  saveWorkbenchSettings,
  SETTINGS_LOAD_FAILED_COPY,
  SETTINGS_SAVE_FAILED_COPY,
  verdictClearsHeldVersion,
} from "@/lib/workbench-settings";

/** The door's one-word `error`, or undefined when the body is not its JSON. */
async function doorError(read: Response): Promise<string | undefined> {
  try {
    const body = (await read.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
}

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
  const visible = useSurfaceVisible(active);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const scanSeq = useRef(0);
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  /**
   * Re-read the sidecar.
   *
   * `quiet` means "replace the list only if one was actually read; write no
   * message and blank nothing". It exists for the re-scan {@link toggle} runs
   * after a failed save: `scan` otherwise owns the rail's message on its own
   * behalf — clearing it on success, writing {@link SKILLS_SCAN_FAILED_COPY} on
   * failure — and either would swallow the sentence about the toggle, which is
   * the one the owner is waiting to read.
   *
   * BLANKING NOTHING IS THE OTHER HALF, and it covers THREE ways a re-scan can
   * come back with no list: a non-ok status, a thrown read, and a 200 whose body
   * carries no `skills` array — an error envelope, a proxy page, a login body.
   * The last one is not a scan that found nothing; it is a scan that found
   * nothing it can read, and answering it with `[]` would empty a rail that was
   * listing packs a moment ago. An empty rail reads as "no Skills" and would
   * send the owner to write a `SKILL.md` they already have — the wrong answer
   * this module's own docblock names. Non-quiet behaviour is unchanged: there
   * the shapeless 200 still yields `[]`, because that path also writes the
   * message that goes with it.
   */
  const scan = useCallback(
    async (options: { signal?: AbortSignal; quiet?: boolean } = {}) => {
      if (!visibleRef.current) return;
      const seq = ++scanSeq.current;
      const { signal, quiet = false } = options;
      try {
        const read = await loopbackFetch(SKILL_SCAN_URL, {
          cache: "no-store",
          ...(signal ? { signal } : {}),
        });
        if (!visibleRef.current || signal?.aborted || seq !== scanSeq.current) return;
        if (!read.ok) {
          if (quiet) return;
          const refusal = await doorError(read);
          if (!visibleRef.current || signal?.aborted || seq !== scanSeq.current) return;
          setError(refusal === "sidecar_pairing_mismatch" ? SIDECAR_PAIRING_COPY : skillsScanRefusalCopy(refusal));
          setSkills([]);
          return;
        }
        const body = (await read.json()) as { skills?: SkillSummary[] };
        if (!visibleRef.current || signal?.aborted || seq !== scanSeq.current) return;
        const listed = Array.isArray(body.skills) ? body.skills : null;
        if (quiet) {
          // Replaced only when a list was actually READ — reading it is the
          // whole point of the re-scan — and the message is never touched.
          if (listed) setSkills(listed);
          return;
        }
        setError(null);
        setSkills(listed ?? []);
      } catch {
        if (!visibleRef.current || signal?.aborted || seq !== scanSeq.current) return;
        if (quiet) return;
        // Sidecar down or API off. Named, unlike in Chat: this surface exists to
        // answer "which Skills do I have", and a silent empty list would read as
        // "none" when the truth is "nobody asked".
        setError(SKILLS_SCAN_FAILED_COPY);
        setSkills([]);
      }
    },
    [],
  );

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    void scan({ signal: controller.signal });
    return () => { scanSeq.current += 1; controller.abort(); };
  }, [visible, scan]);

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
        // THE LIST MAY ALREADY HAVE MOVED (DW-625). Asked through
        // `verdictClearsHeldVersion` rather than by testing verdict names here:
        // that helper answers "may the store have moved past what you are
        // holding?" with an exhaustive `switch`, so a fourth verdict cannot
        // inherit an answer silently. This rail holds no version — it re-reads
        // one per click — but it holds a rendered VIEW of the enablement, and
        // that goes stale for exactly the reason the verdict names: an
        // unconfirmed or unreadable save may well have stored the flip, and the
        // pre-toggle state would sit on screen until something else scanned.
        // A refusal arrived and applied nothing, so the list is still true.
        //
        // THE SENTENCE FIRST, THEN THE RE-SCAN. `loopbackFetch` carries no
        // deadline, so a sidecar that accepts the connection and never answers
        // would otherwise hold this branch open forever: the owner would never
        // read the sentence about their own click, and `busy` would stay set
        // and disable every switch on the rail — worse than the stale list this
        // re-scan exists to fix. Ordering it this way is safe precisely because
        // the quiet re-scan writes NO message on any path, so it cannot
        // overwrite what was just put on screen.
        setError(result.status === "error" ? result.message : SETTINGS_SAVE_FAILED_COPY);
        if (verdictClearsHeldVersion(result.verdict)) await scan({ quiet: true });
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
    <SurfacePresentation active={active}>
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
    </SurfacePresentation>
  );
}
