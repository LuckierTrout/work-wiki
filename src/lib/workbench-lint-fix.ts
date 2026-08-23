/**
 * Workbench auto-fix: mechanical classes only.
 * renamed-slug, dangling [[slug]] / broken-link, index.md drift.
 */

import {
  FixValidationError,
  fixLintIssue,
  fixRenamedSlug,
  type FixResult,
} from "./lint-fix";
import { WORKBENCH_MECHANICAL_FIX, type WorkbenchLintType } from "./workbench-lint";

export async function fixWorkbenchLintIssue(
  type: string,
  slug: string,
  targetSlug?: string,
  author = "lint-fix",
): Promise<FixResult> {
  if (!WORKBENCH_MECHANICAL_FIX.has(type as WorkbenchLintType)) {
    throw new FixValidationError(
      "Workbench auto-fix is mechanical only. This issue class has no Workbench auto-fix.",
    );
  }
  if (type === "renamed-slug") {
    return fixRenamedSlug(slug, targetSlug ?? "", author);
  }
  return fixLintIssue(type, slug, targetSlug, undefined, author);
}
