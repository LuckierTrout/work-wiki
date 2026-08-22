"use client";

import { forwardRef } from "react";
import {
  BADGE_MODE_NOUNS,
  WORKBENCH_MODES,
  badgeAccessibleName,
  type WorkbenchModeId,
} from "@/lib/workbench-modes";
import type { SidecarStatus } from "@/lib/sidecar";
import { ChevronLeftIcon, RAIL_ICONS, SettingsIcon } from "./RailIcons";

/**
 * The 48px icon rail (UX-DR3): ten modes above a flexible spacer, then the
 * sidecar status dot, Settings, and the left-column collapse chevron.
 *
 * Every control is a real `<button>` or `<a>` with both `title` (pointer
 * affordance) and `aria-label` (the icon carries no text), and the active mode
 * is marked `aria-current="page"` rather than by colour alone.
 */

export interface IconRailProps {
  /** Stable id so the narrow-viewport sheet trigger can `aria-controls` it. */
  id: string;
  /** Id of the left column, so the chevron's `aria-expanded` names its region. */
  leftColumnId: string;
  mode: WorkbenchModeId;
  onSelect: (mode: WorkbenchModeId) => void;
  /**
   * Story 1.9: Settings is a surface on this shell, not a route — and it
   * TOGGLES, because the control below marks itself current while it is showing.
   */
  onToggleSettings: () => void;
  /**
   * Settings is showing. Exactly one rail control is ever `aria-current`, so a
   * mode's own active state is suppressed while this is true — the mode is still
   * what the shell will return to, but it is not what is on screen.
   */
  settingsActive: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  sidecar: SidecarStatus;
  todoCount?: number;
  reviewCount?: number;
}

/**
 * Keyed by mode id, not by `string`: a typo here would otherwise compile and
 * silently resolve to a count of 0, which is indistinguishable from "no badge".
 */
const COUNTS: Partial<Record<WorkbenchModeId, "todoCount" | "reviewCount">> = {
  todos: "todoCount",
  review: "reviewCount",
};

export const IconRail = forwardRef<HTMLElement, IconRailProps>(function IconRail(
  {
    id,
    leftColumnId,
    mode,
    onSelect,
    onToggleSettings,
    settingsActive,
    collapsed,
    onToggleCollapsed,
    sidecar,
    todoCount = 0,
    reviewCount = 0,
  },
  ref,
) {
  const counts = { todoCount, reviewCount };
  // "unknown" is not "up": the dot only goes live on an affirmative probe, so
  // it never promises a sidecar that has not answered. It is not "down"
  // either — reporting a sidecar dead before anything has asked is a false
  // accusation, and a tab that starts in the background never probes at all,
  // so that lie would stand indefinitely. Three states, three labels.
  const live = sidecar === "up";
  const sidecarLabel =
    sidecar === "up"
      ? "Sidecar running"
      : sidecar === "down"
        ? "Sidecar not running"
        : "Checking sidecar";

  return (
    <nav className="wb-rail" id={id} aria-label="Modes" ref={ref}>
      {WORKBENCH_MODES.map((item) => {
        const Glyph = RAIL_ICONS[item.id];
        const noun = BADGE_MODE_NOUNS[item.id];
        const countKey = COUNTS[item.id];
        const count = countKey ? counts[countKey] : 0;
        // Hidden at 0 (DESIGN.md `badge-count`): a zero pill is noise, and its
        // accessible name would announce a set the owner has no reason to open.
        const showBadge = Boolean(noun) && count > 0;
        const label =
          showBadge && noun ? badgeAccessibleName(item.label, count, noun) : item.label;
        // While Settings is open the mode is remembered but not SHOWING, so no
        // mode carries `aria-current` — two current controls would describe two
        // surfaces the owner cannot both be looking at.
        const active = !settingsActive && item.id === mode;
        return (
          <button
            key={item.id}
            type="button"
            className={`wb-rail-item${active ? " wb-rail-item--active" : ""}`}
            title={item.label}
            aria-label={label}
            aria-current={active ? "page" : undefined}
            onClick={() => onSelect(item.id)}
          >
            <Glyph />
            {showBadge && (
              <span className="wb-rail-badge" aria-hidden="true">
                {count}
              </span>
            )}
          </button>
        );
      })}

      <span className="wb-rail-spacer" />

      {/* A live region announces CONTENT mutations, not attribute changes, so
          an empty span whose only text is `aria-label` announces nothing when
          the sidecar comes up. The label is real (visually hidden) content. */}
      <span
        role="status"
        className={`wb-status${live ? " wb-status--live" : ""}`}
        title={sidecarLabel}
      >
        <span className="wb-sr-only">{sidecarLabel}</span>
      </span>

      {/* Story 1.9 brought Settings inside the shell, so this is a BUTTON, not a
          link: the epic requires the surface to open on the one mounted shell,
          and a route change for a surface switch is what `epics.md:367` forbids
          (it would unmount everything above the canvas, typed Chat input
          included). Settings is deliberately not a mode — `WORKBENCH_MODES` is
          the rail's ten, pinned by `workbench-modes.test.ts` — so it carries its
          own active state rather than joining the map above. */}
      <button
        type="button"
        className={`wb-rail-item${settingsActive ? " wb-rail-item--active" : ""}`}
        title="Settings"
        aria-label="Settings"
        aria-current={settingsActive ? "page" : undefined}
        onClick={onToggleSettings}
      >
        <SettingsIcon />
      </button>

      <button
        type="button"
        className="wb-rail-item wb-rail-chevron"
        title={collapsed ? "Expand left column" : "Collapse left column"}
        aria-label={collapsed ? "Expand left column" : "Collapse left column"}
        aria-expanded={!collapsed}
        // `aria-expanded` with nothing named is a state without a subject; the
        // sheet trigger already points at what it opens, and so must this.
        aria-controls={leftColumnId}
        onClick={onToggleCollapsed}
      >
        <ChevronLeftIcon />
      </button>
    </nav>
  );
});
