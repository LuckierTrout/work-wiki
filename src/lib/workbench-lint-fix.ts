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

/**
 * `author` stays `"lint-fix"` and `triggeredBy` carries whoever asked (DW-447):
 * the Workbench door is the fourth of the same class as REST and the two MCP
 * transports, and it used to hand its resolved principal down as the `author` of
 * a machine-generated edit. See the note at the top of `./lint-fix`.
 */
export async function fixWorkbenchLintIssue(
  type: string,
  slug: string,
  targetSlug?: string,
  author = "lint-fix",
  triggeredBy?: string,
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
    return fixRenamedSlug(slug, targetSlug ?? "", author, triggeredBy);
  }
  if (type === "broken-link") {
    if (live.fix !== "dangling-wikilink") {
      throw new FixValidationError("This broken-link report has no mechanical Workbench fix.");
    }
    return fixDanglingWikilink(slug, targetSlug ?? "", author, triggeredBy);
  }
  return fixLintIssue(type, slug, targetSlug, undefined, author, triggeredBy);
}
