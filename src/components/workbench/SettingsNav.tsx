"use client";

import {
  SETTINGS_CATEGORIES,
  type SettingsCategoryId,
} from "@/lib/workbench-settings";

/**
 * Settings' own nav — the left column's SECOND list (UX-DR14), rendered in place
 * of the Knowledge/Files trees while the Settings surface is open.
 *
 * The left column is where the shell already puts a mode's navigation, so
 * Settings does not invent a third column or a second overlay level for it. Each
 * row is a real `<button>`, never a link: opening a category is a state change on
 * the one mounted shell, exactly as a mode switch is, and a route change here is
 * what `epics.md:367` forbids for a surface switch.
 *
 * The vocabulary is `SETTINGS_CATEGORIES` — this component restates no list of
 * its own, so "which categories exist" stays a thing the node suite can execute.
 *
 * `data-no-localize` for the same reason the rail carries it: `src/lib/i18n.ts`
 * holds an entry for "Settings", and LocaleProvider's body-wide observer would
 * rewrite these rows while the rail control beside them — already opted out —
 * stayed English.
 */

export interface SettingsNavProps {
  category: SettingsCategoryId;
  onSelect: (category: SettingsCategoryId) => void;
}

export function SettingsNav({ category, onSelect }: SettingsNavProps) {
  return (
    <nav className="wb-set-nav" aria-label="Settings categories" data-no-localize>
      {SETTINGS_CATEGORIES.map((item) => {
        const active = item.id === category;
        return (
          <button
            key={item.id}
            type="button"
            className={`wb-set-nav-item${active ? " wb-set-nav-item--active" : ""}`}
            // Marked, not merely washed: colour alone is not a state (UX-DR21).
            aria-current={active ? "page" : undefined}
            onClick={() => onSelect(item.id)}
          >
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
