/**
 * Workbench Lint report: reuse kernel lint, add inbound-wikilink orphans
 * and renamed-slug detection. Semantic (LLM) classes stay behind a toggle.
 */

import { resolveAlias } from "./alias-index";
import { extractAllInternalLinks } from "./links";
import { lint } from "./lint";
import { INFRASTRUCTURE_FILES, getOnDiskSlugs } from "./lint-checks";
import { readWikiPage } from "./wiki";
import type { LintIssue } from "./types";

export const WORKBENCH_LINT_IDLE = "Run lint to check wiki health.";

export type WorkbenchLintType =
  | LintIssue["type"]
  | "inbound-orphan"
  | "renamed-slug";

export interface WorkbenchLintIssue {
  type: WorkbenchLintType;
  slug: string;
  target?: string;
  message: string;
  severity: LintIssue["severity"];
  suggestion?: string;
}

export const WORKBENCH_MECHANICAL_FIX = new Set<WorkbenchLintType>([
  "renamed-slug",
  "broken-link",
  "orphan-page",
  "stale-index",
]);

const BOOKKEEPING = new Set(["purpose", "schema", "index", "log", "overview"]);

const BASE_CHECKS: LintIssue["type"][] = [
  "disputed-page",
  "broken-link",
  "stale-page",
  "duplicate-entity",
  "orphan-page",
  "stale-index",
];

const SEMANTIC_CHECKS: LintIssue["type"][] = [
  "contradiction",
  "missing-concept-page",
  "incomplete-coverage",
  "uncited-claims",
];

export function workbenchCanAutoFix(type: WorkbenchLintType, readOnly: boolean): boolean {
  return !readOnly && WORKBENCH_MECHANICAL_FIX.has(type);
}

export async function checkInboundWikilinkOrphans(
  diskSlugs: readonly string[],
): Promise<WorkbenchLintIssue[]> {
  const inbound = new Map(diskSlugs.map((slug) => [slug, 0]));
  for (const slug of diskSlugs) {
    const page = await readWikiPage(slug);
    if (!page) continue;
    for (const { targetSlug } of extractAllInternalLinks(page.content)) {
      if (!inbound.has(targetSlug)) continue;
      inbound.set(targetSlug, (inbound.get(targetSlug) ?? 0) + 1);
    }
  }
  const issues: WorkbenchLintIssue[] = [];
  for (const slug of diskSlugs) {
    if (BOOKKEEPING.has(slug.toLowerCase())) continue;
    if (INFRASTRUCTURE_FILES.has(`${slug}.md`)) continue;
    if ((inbound.get(slug) ?? 0) > 0) continue;
    issues.push({
      type: "inbound-orphan",
      slug,
      message: `Page "${slug}.md" has no inbound wikilinks`,
      severity: "info",
      suggestion: "Link this page from a related topic so it is reachable from the wiki.",
    });
  }
  return issues;
}

async function promoteRenamedSlugs(
  issues: WorkbenchLintIssue[],
  diskSlugs: ReadonlySet<string>,
): Promise<WorkbenchLintIssue[]> {
  const out: WorkbenchLintIssue[] = [];
  for (const issue of issues) {
    if (issue.type !== "broken-link" || !issue.target) {
      out.push(issue);
      continue;
    }
    const canonical = await resolveAlias(issue.target);
    if (canonical && canonical !== issue.target && diskSlugs.has(canonical)) {
      out.push({
        type: "renamed-slug",
        slug: issue.slug,
        target: issue.target,
        message: `Page "${issue.slug}.md" still links to renamed slug "${issue.target}" (now "${canonical}")`,
        severity: "warning",
        suggestion: `Rewrite the link to "${canonical}.md".`,
      });
      continue;
    }
    out.push(issue);
  }
  return out;
}

export async function runWorkbenchLint(options: {
  semantic?: boolean;
}): Promise<WorkbenchLintIssue[]> {
  const checks: LintIssue["type"][] = [
    ...BASE_CHECKS,
    ...(options.semantic ? SEMANTIC_CHECKS : []),
  ];
  const [result, diskSlugs] = await Promise.all([
    lint({ checks }),
    getOnDiskSlugs(),
  ]);
  const diskSet = new Set(diskSlugs);
  const inbound = await checkInboundWikilinkOrphans(diskSlugs);
  const combined: WorkbenchLintIssue[] = [...result.issues, ...inbound];
  return promoteRenamedSlugs(combined, diskSet);
}
