/**
 * Workbench auto-fix: mechanical classes only.
 * renamed-slug, dangling [[slug]] / broken-link, index.md drift.
 */

import { validateWorkbenchLintIssue } from "./workbench-lint";
import { WORKBENCH_MECHANICAL_FIX, type WorkbenchLintType } from "./workbench-lint-types";
import {
  FixValidationError,
  fixDanglingWikilink,
  fixLintIssue,
  fixRenamedSlug,
  type FixResult,
} from "./lint-fix";

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
  const live = await validateWorkbenchLintIssue(type, slug, targetSlug);
  if (!live) {
    throw new FixValidationError("This lint issue is no longer present. Run lint again.");
  }
  if (type === "renamed-slug") {
    return fixRenamedSlug(slug, targetSlug ?? "", author);
  }
  if (type === "broken-link") {
    if (live.fix !== "dangling-wikilink") {
      throw new FixValidationError("This broken-link report has no mechanical Workbench fix.");
    }
    return fixDanglingWikilink(slug, targetSlug ?? "", author);
  }
  return fixLintIssue(type, slug, targetSlug, undefined, author);
}
