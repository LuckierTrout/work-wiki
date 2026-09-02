"use client";

import { useEffect, useState } from "react";
import {
  SETTINGS_API_BASE_URL_LABEL,
  SETTINGS_API_COPIED_COPY,
  SETTINGS_API_COPY,
  SETTINGS_API_ENABLED_COPY,
  SETTINGS_API_ENABLE_COPY,
  SETTINGS_API_ENABLE_LABEL,
  SETTINGS_API_MCP_COPY,
  SETTINGS_API_MCP_COPY_COPY,
  SETTINGS_API_MCP_HEADING,
  SETTINGS_API_OPEN_HEALTH_COPY,
  SETTINGS_API_SKILL_COPY,
  SETTINGS_API_SKILL_COPY_COPY,
  SETTINGS_API_SKILL_HEADING,
  SETTINGS_API_TOKEN_ABSENT_COPY,
  SETTINGS_API_TOKEN_COPY_COPY,
  SETTINGS_API_TOKEN_ENV_COPY,
  SETTINGS_API_TOKEN_GENERATE_COPY,
  SETTINGS_API_TOKEN_HIDE_COPY,
  SETTINGS_API_TOKEN_LABEL,
  SETTINGS_API_TOKEN_NEW_COPY,
  SETTINGS_API_TOKEN_SHOW_COPY,
  SETTINGS_API_TOKEN_STORED_COPY,
  SETTINGS_API_UNAUTH_LABEL,
  SETTINGS_API_UNAUTH_OFF_COPY,
  SETTINGS_API_UNAUTH_WARNING_COPY,
  brandedSkillInstallCommand,
  draftApiTokenMissing,
  draftApiUnauthenticated,
  loopbackMcpConfig,
  maskToken,
  settingsDraftAfterApiEnabled,
  settingsDraftAfterTokenGenerated,
} from "@/lib/workbench-api-mcp-settings";
import type {
  SettingsDraft,
  WorkbenchSettingsPayload,
} from "@/lib/workbench-settings";
import {
  LOOPBACK_BASE_URL,
  LOOPBACK_HEALTH_URL,
  newLoopbackApiToken,
} from "@/lib/v1-contract";
import {
  probeLoopbackApiPane,
  SETTINGS_API_HEALTH_PORT_CONFLICT_COPY,
  SETTINGS_API_HEALTH_RUNNING_COPY,
  SETTINGS_API_HEALTH_UNREACHABLE_COPY,
  type ClassifiedLoopbackHealth,
} from "@/lib/workbench-loopback-health";
import type { SkillSummary } from "@/lib/chat-agent";

/**
 * The API + MCP category's pane — the loopback door, its token, and the two
 * snippets that point a client at it.
 *
 * Its own component (DW-445) for the same reason the category has its own lib
 * module: the pane is the only part of the Settings surface with LIVE state of
 * its own — a health probe and a reveal toggle — and inline in `SettingsCanvas`
 * those sat beside the surface's read, draft and save, where no mounted suite
 * ever reached them. Split out, they get a suite that renders this pane.
 *
 * It owns NO draft. `apply` is the one edit gesture, passed down from the
 * canvas because it is what clears the status and the refusal; `field` and
 * `describedBy` come down too, so every control id stays inside the canvas's
 * one `useId` namespace and the read-only sentence still appends to each hint.
 * The clipboard is the canvas's as well, shared with Intake's Copy button so
 * one confirmation cannot contradict the other.
 *
 * Router-free, storage-free and `fetch`-free: the one network call it makes is
 * `probeLoopbackApiPane`, which goes through the shared loopback client and
 * swallows every error itself.
 */
export interface SettingsApiMcpPaneProps {
  /** The DRAFT, narrowed by the canvas after its load guards. */
  values: SettingsDraft;
  /** The STORED payload the draft was seeded from. */
  stored: WorkbenchSettingsPayload;
  /** The canvas's id builder, so these controls share its `useId` namespace. */
  field: (suffix: string) => string;
  /** The canvas's `aria-describedby` resolver, which appends the bar's note. */
  describedBy: (hintId: string | undefined) => string | undefined;
  /**
   * The canvas's STANDING REFUSAL: read-only, or a save in flight (DW-67).
   *
   * A prop rather than a predicate of this pane's own, because this pane owns
   * neither the draft nor the save. Its controls edit the canvas's draft and
   * ride the canvas's one PUT, so anything typed here during the save window is
   * dropped exactly as it is on every other category — and the sentence that
   * says so is the canvas's bar note, which `describedBy` above is already
   * appending. Re-deriving the condition here would give the pane a second
   * answer to one question, free to disagree with the sentence it announces.
   */
  editRefused: boolean;
  /** The one edit gesture — it is what clears `status` and `saveError`. */
  apply: (rule: (current: SettingsDraft) => SettingsDraft) => void;
  /** Whether the last Copy landed. Shared with Intake's Copy button. */
  copied: boolean;
  /** Put text on the clipboard and record whether that worked. */
  onCopy: (text: string) => Promise<void>;
}

export function SettingsApiMcpPane({
  values,
  stored,
  field,
  describedBy,
  editRefused,
  apply,
  copied,
  onCopy,
}: SettingsApiMcpPaneProps) {
  /**
   * Is the freshly generated loopback token shown in the clear?
   *
   * Masked by default and NOT persisted anywhere, so the pane can sit open on a
   * shared screen or in a recording. It lives HERE rather than on the canvas,
   * which means leaving the category discards it while leaving the DRAFT token
   * alone — a return visit renders masked again and Show brings the value
   * straight back. That is the safer half of the two: "shown once" is what this
   * pane's own copy promises, and re-entering is not the moment to re-reveal a
   * credential nobody asked for.
   */
  const [revealToken, setRevealToken] = useState(false);
  const [apiLive, setApiLive] = useState<{
    health: ClassifiedLoopbackHealth;
    skills: SkillSummary[];
  } | null>(null);
  // ONE probe, on mount — which is now exactly once per visit to this category,
  // because the pane unmounts when the owner leaves it. Nothing is shown until
  // it lands, so a second visit never flashes the previous visit's verdict at a
  // door whose state may have changed since.
  useEffect(() => {
    let cancelled = false;
    void probeLoopbackApiPane().then((live) => {
      if (!cancelled) setApiLive(live);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <p className="wb-set-note">{SETTINGS_API_COPY}</p>
      <p className="wb-set-row">
        <span className="wb-set-label">{SETTINGS_API_BASE_URL_LABEL}</span>
        <span className="wb-set-static">{LOOPBACK_BASE_URL}</span>
        {/* A LINK, not a probe. This pane must not tell the owner the
            sidecar is up or down: it runs in the browser, the answer
            changes the moment they start the process, and a stale "not
            reachable" beside a running sidecar is worse than no claim at
            all. Opening `/health` shows them the live payload, which is
            the honest answer and the one the branded skill reads. */}
        <a
          className="wb-set-action"
          href={LOOPBACK_HEALTH_URL}
          target="_blank"
          rel="noreferrer"
        >
          {SETTINGS_API_OPEN_HEALTH_COPY}
        </a>
      </p>
      {apiLive ? (
        <p className="wb-set-note" role="status">
          {apiLive.health === "port_conflict"
            ? SETTINGS_API_HEALTH_PORT_CONFLICT_COPY
            : apiLive.health === "unreachable" || apiLive.health === "error"
              ? SETTINGS_API_HEALTH_UNREACHABLE_COPY
              : SETTINGS_API_HEALTH_RUNNING_COPY}{" "}
          {apiLive.skills.length === 1
            ? "1 Skill on disk."
            : `${apiLive.skills.length} Skills on disk.`}
        </p>
      ) : null}

      <p className="wb-set-row">
        <label className="wb-set-check" htmlFor={field("apiEnabled")}>
          <input
            id={field("apiEnabled")}
            type="checkbox"
            checked={values.apiEnabled}
            aria-disabled={editRefused || undefined}
            onChange={(event) => {
              if (editRefused) return;
              // NOT a plain field write. Shutting the door also clears the
              // unauthenticated switch, so a later re-open cannot silently
              // re-open it unauthenticated — the pure rule the node suite
              // executes, not a branch typed into this JSX.
              apply((current) =>
                settingsDraftAfterApiEnabled(current, event.target.checked),
              );
            }}
            aria-describedby={describedBy(field("apiEnabled-hint"))}
          />
          {SETTINGS_API_ENABLE_LABEL}
        </label>
        <span className="wb-set-hint" id={field("apiEnabled-hint")}>
          {values.apiEnabled ? SETTINGS_API_ENABLED_COPY : SETTINGS_API_ENABLE_COPY}
        </span>
      </p>

      {values.apiEnabled && (
        <>
          <p className="wb-set-row">
            <label className="wb-set-check" htmlFor={field("allowUnauthenticated")}>
              <input
                id={field("allowUnauthenticated")}
                type="checkbox"
                checked={values.allowUnauthenticated}
                aria-disabled={editRefused || undefined}
                onChange={(event) => {
                  if (editRefused) return;
                  apply((current) => ({
                    ...current,
                    allowUnauthenticated: event.target.checked,
                  }));
                }}
                aria-describedby={describedBy(field("allowUnauthenticated-hint"))}
              />
              {SETTINGS_API_UNAUTH_LABEL}
            </label>
            {/* The warning is this control's OWN description, read off the
                DRAFT — the same shape and the same reason as the MinerU
                Cloud warning on the Intake pane: it has to appear when the
                owner TICKS the box, before the Save that opens the door. A
                note rendered merely beside the control would never be
                announced. */}
            <span
              className={
                draftApiUnauthenticated(values)
                  ? "wb-set-hint wb-set-warn"
                  : "wb-set-hint"
              }
              id={field("allowUnauthenticated-hint")}
            >
              {draftApiUnauthenticated(values)
                ? SETTINGS_API_UNAUTH_WARNING_COPY
                : SETTINGS_API_UNAUTH_OFF_COPY}
            </span>
          </p>

          <p className="wb-set-row">
            <span className="wb-set-label" id={field("apiToken-label")}>
              {SETTINGS_API_TOKEN_LABEL}
            </span>
            {/* SHOWN, once, in plaintext — and only while the draft holds
                a token this pane just minted. Nothing serves it back after
                Save, so this is the single moment it can be copied, and
                hiding it behind a reveal toggle would add a click to the
                one interaction that has to succeed. */}
            {values.loopbackApiToken ? (
              <code className="wb-set-static">
                {revealToken
                  ? values.loopbackApiToken
                  : maskToken(values.loopbackApiToken)}
              </code>
            ) : null}
            {stored.loopbackTokenSource !== "env" && !stored.readOnly && (
              // Refused in place while a save is in flight, never removed
              // (DW-67): `stored.readOnly` above already keeps the button off a
              // deployment that can never mint one, and a save is a moment
              // rather than a state. Minting during the window would put a
              // token on screen that the re-seed then discards — the pane
              // promises "shown once", and that once would have been a lie.
              // `describedBy` is what turns the refusal into a sentence.
              <button
                type="button"
                className="wb-set-action"
                aria-disabled={editRefused || undefined}
                aria-describedby={describedBy(field("apiToken-label"))}
                onClick={() => {
                  if (editRefused) return;
                  apply((current) =>
                    settingsDraftAfterTokenGenerated(current, newLoopbackApiToken()),
                  );
                }}
              >
                {SETTINGS_API_TOKEN_GENERATE_COPY}
              </button>
            )}
            {values.loopbackApiToken && (
              <>
                <button
                  type="button"
                  className="wb-set-action"
                  aria-describedby={field("apiToken-label")}
                  aria-pressed={revealToken}
                  onClick={() => setRevealToken((current) => !current)}
                >
                  {revealToken
                    ? SETTINGS_API_TOKEN_HIDE_COPY
                    : SETTINGS_API_TOKEN_SHOW_COPY}
                </button>
                <button
                  type="button"
                  className="wb-set-action"
                  aria-describedby={field("apiToken-label")}
                  onClick={() => void onCopy(values.loopbackApiToken ?? "")}
                >
                  {SETTINGS_API_TOKEN_COPY_COPY}
                </button>
              </>
            )}
            <span className="wb-set-hint" id={field("apiToken-hint")}>
              {stored.loopbackTokenSource === "env"
                ? SETTINGS_API_TOKEN_ENV_COPY
                : values.loopbackApiToken
                  ? SETTINGS_API_TOKEN_NEW_COPY
                  : stored.hasLoopbackApiToken
                    ? SETTINGS_API_TOKEN_STORED_COPY
                    : SETTINGS_API_TOKEN_ABSENT_COPY}
            </span>
          </p>

          {/* The door is on, the token is required, and there is none —
              so every caller gets 401. Not an error and not a block on
              Save: it is a real, safe state, and saying so is the
              difference between an owner understanding their agent's 401
              and hunting it. */}
          {draftApiTokenMissing(values, stored) && (
            <p className="wb-set-note wb-set-warn" role="status">
              {SETTINGS_API_TOKEN_ABSENT_COPY}
            </p>
          )}
        </>
      )}

      <h3 className="wb-set-heading">{SETTINGS_API_MCP_HEADING}</h3>
      <p className="wb-set-note">{SETTINGS_API_MCP_COPY}</p>
      {/* The token is SUBSTITUTED only when the draft is holding a freshly
          generated one; otherwise the config carries the placeholder,
          because the server never serves the stored value back. */}
      <pre className="wb-set-pre">
        {loopbackMcpConfig(values.loopbackApiToken, stored.loopbackMcpEntry)}
      </pre>
      <p className="wb-set-row">
        <button
          type="button"
          className="wb-set-action"
          onClick={() =>
            void onCopy(
              loopbackMcpConfig(values.loopbackApiToken, stored.loopbackMcpEntry),
            )
          }
        >
          {SETTINGS_API_MCP_COPY_COPY}
        </button>
      </p>

      <h3 className="wb-set-heading">{SETTINGS_API_SKILL_HEADING}</h3>
      <p className="wb-set-note">{SETTINGS_API_SKILL_COPY}</p>
      <pre className="wb-set-pre">{brandedSkillInstallCommand()}</pre>
      <p className="wb-set-row">
        <button
          type="button"
          className="wb-set-action"
          onClick={() => void onCopy(brandedSkillInstallCommand())}
        >
          {SETTINGS_API_SKILL_COPY_COPY}
        </button>
      </p>

      {/* Polite and visible, exactly as the Intake copy confirmation is:
          the clipboard gives no feedback of its own. */}
      <p className="wb-set-note" aria-live="polite">
        {copied ? SETTINGS_API_COPIED_COPY : ""}
      </p>
    </>
  );
}
