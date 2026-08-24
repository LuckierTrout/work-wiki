/**
 * Client-safe Workbench Lint contracts. Runtime lint execution stays in
 * `workbench-lint.ts` so the canvas never imports the storage stack.
 */

import type { LintIssue } from "./types";

export const WORKBENCH_LINT_IDLE = "Run lint to check wiki health.";

export type WorkbenchLintType =
  | LintIssue["type"]
  | "inbound-orphan"
  | "renamed-slug"
  | "insight-pointer";

export type WorkbenchLintFixKind =
  | "renamed-slug"
  | "dangling-wikilink"
  | "orphan-page"
  | "stale-index";

export interface WorkbenchLintIssue {
  type: WorkbenchLintType;
  slug: string;
  target?: string;
  message: string;
  severity: LintIssue["severity"];
  suggestion?: string;
  fix?: WorkbenchLintFixKind;
}

/** Mechanical classes Story 5.9 exposes on Workbench. `broken-link` is only
 *  the dangling `[[slug]]` rewrite — markdown links stay for the report. */
export const WORKBENCH_MECHANICAL_FIX = new Set<WorkbenchLintType>([
  "renamed-slug",
  "broken-link",
  "orphan-page",
  "stale-index",
]);

export function workbenchCanAutoFix(issue: WorkbenchLintIssue, readOnly: boolean): boolean {
  return !readOnly && issue.fix !== undefined;
}
