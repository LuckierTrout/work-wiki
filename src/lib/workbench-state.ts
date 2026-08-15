/**
 * Browser-local memory of the Workbench's layout state: which mode was last
 * active and whether the left column was collapsed (FR-8).
 *
 * These are per-browser view preferences, not owner data, so they live in
 * localStorage rather than the kernel store. The keys keep the `yopedia`
 * runtime prefix (AD-7): the rebrand is display-only, and renaming a storage
 * key silently drops a returning owner back to the default.
 *
 * Shape follows `recent-ingests.ts`: SSR guard first, try/catch around every
 * access (private mode and quota both throw), and runtime narrowing of the
 * value read back — anything unrecognised degrades to the default.
 */

import {
  DEFAULT_WORKBENCH_MODE,
  isWorkbenchModeId,
  type WorkbenchModeId,
} from "@/lib/workbench-modes";

export const WORKBENCH_MODE_KEY = "yopedia_workbench_mode";
export const WORKBENCH_COLLAPSED_KEY = "yopedia_workbench_left_collapsed";

/** The only stored value that means "collapsed"; everything else is expanded. */
const COLLAPSED_TRUE = "1";

export function readStoredMode(): WorkbenchModeId {
  if (typeof window === "undefined") return DEFAULT_WORKBENCH_MODE;
  try {
    const raw = window.localStorage.getItem(WORKBENCH_MODE_KEY);
    // A mode id from an older build (or a hand-edited value) must not select a
    // mode that no longer exists — the rail would render with nothing active.
    return isWorkbenchModeId(raw) ? raw : DEFAULT_WORKBENCH_MODE;
  } catch {
    return DEFAULT_WORKBENCH_MODE;
  }
}

export function writeStoredMode(mode: WorkbenchModeId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WORKBENCH_MODE_KEY, mode);
  } catch {
    // localStorage unavailable (private mode / quota) — the mode still works
    // for this session; only the restore on reload is lost.
  }
}

export function readStoredCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(WORKBENCH_COLLAPSED_KEY) === COLLAPSED_TRUE;
  } catch {
    return false;
  }
}

export function writeStoredCollapsed(collapsed: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WORKBENCH_COLLAPSED_KEY, collapsed ? COLLAPSED_TRUE : "0");
  } catch {
    // Non-critical: the column stays collapsed for this session.
  }
}
