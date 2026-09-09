/**
 * Workbench Lint report: reuse kernel lint, add inbound-wikilink orphans
 * and renamed-slug detection. Semantic (LLM) classes stay behind a toggle.
 * Gap classes point at Graph Insights — they are not a second gap product.
 */

import { parseFrontmatter } from "./frontmatter";
import { resolveAlias } from "./alias-index";
import { extractAllInternalLinks } from "./links";
import { lint } from "./lint";
import { INFRASTRUCTURE_FILES, getOnDiskSlugs } from "./lint-checks";
import { hasMarkdownLinkTarget, hasWikilinkTarget } from "./markdown-link-rewrite";
import { listWikiPages, readWikiPage } from "./wiki";
import type { LintIssue } from "./types";
import {
  WORKBENCH_LINT_IDLE,
  WORKBENCH_MECHANICAL_FIX,
  workbenchCanAutoFix,
  type WorkbenchLintIssue,
  type WorkbenchLintType,
} from "./workbench-lint-types";

export {
  WORKBENCH_LINT_IDLE,
  WORKBENCH_MECHANICAL_FIX,
  workbenchCanAutoFix,
  type WorkbenchLintIssue,
  type WorkbenchLintType,
};

const BOOKKEEPING = new Set(["purpose", "schema", "index", "log", "overview"]);

const BASE_CHECKS: LintIssue["type"][] = [
  "disputed-page",
  "broken-link",
  "stale-page",
  "duplicate-entity",
  "orphan-page",
  "stale-index",
];

/** Semantic classes that stay on Lint. Gap rows are Insights, not this list. */
const SEMANTIC_CHECKS: LintIssue["type"][] = ["contradiction", "uncited-claims"];

const GAP_POINTER: WorkbenchLintIssue = {
  type: "insight-pointer",
  slug: "",
  message: "Knowledge gaps are listed under Graph Insights.",
  severity: "info",
  suggestion: "Open Graph → Insights for isolated, sparse, and bridge pages.",
};

export async function checkInboundWikilinkOrphans(
  diskSlugs: readonly string[],
): Promise<WorkbenchLintIssue[]> {
  const overviews = new Set<string>();
  const inbound = new Map(diskSlugs.map((slug) => [slug, 0]));
  for (const slug of diskSlugs) {
    const page = await readWikiPage(slug);
    if (!page) continue;
    if (parseFrontmatter(page.content).data.type === "overview") overviews.add(slug);
    for (const { targetSlug } of extractAllInternalLinks(page.content)) {
      const canonical = (await resolveAlias(targetSlug)) ?? targetSlug;
      if (canonical === slug) continue;
      if (!inbound.has(canonical)) continue;
      inbound.set(canonical, (inbound.get(canonical) ?? 0) + 1);
    }
  }
  const issues: WorkbenchLintIssue[] = [];
  for (const slug of diskSlugs) {
    if (BOOKKEEPING.has(slug.toLowerCase()) || overviews.has(slug)) continue;
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
    const source = await readWikiPage(issue.slug);
    const hasWikilink = source ? hasWikilinkTarget(source.content, issue.target) : false;
    const hasMarkdownLink = source ? hasMarkdownLinkTarget(source.content, issue.target) : false;
    if (
      canonical &&
      canonical !== issue.target &&
      diskSlugs.has(canonical) &&
      (hasWikilink || hasMarkdownLink)
    ) {
      out.push({
        type: "renamed-slug",
        slug: issue.slug,
        target: issue.target,
        message: `Page "${issue.slug}.md" still links to renamed slug "${issue.target}" (now "${canonical}")`,
        severity: "warning",
        suggestion: `Rewrite the link to "${canonical}.md".`,
        fix: "renamed-slug",
      });
      continue;
    }
    out.push(hasWikilink ? { ...issue, fix: "dangling-wikilink" } : issue);
  }
  return out;
}

export async function validateWorkbenchLintIssue(
  type: string,
  slug: string,
  target?: string,
): Promise<WorkbenchLintIssue | undefined> {
  if (type === "broken-link") {
    if (!target) return undefined;
    const [source, destination] = await Promise.all([
      readWikiPage(slug, { fresh: true, strict: true }),
      readWikiPage(target, { fresh: true, strict: true }),
    ]);
    if (!source || destination || !hasWikilinkTarget(source.content, target)) return undefined;
    return {
      type: "broken-link",
      slug,
      target,
      message: `Page "${slug}.md" links to missing page "${target}.md"`,
      severity: "warning",
      fix: "dangling-wikilink",
    };
  }
  if (type === "renamed-slug") {
    if (!target) return undefined;
    const canonical = await resolveAlias(target);
    if (!canonical || canonical === target) return undefined;
    const [source, destination] = await Promise.all([
      readWikiPage(slug, { fresh: true, strict: true }),
      readWikiPage(canonical, { fresh: true, strict: true }),
    ]);
    if (
      !source ||
      !destination ||
      (!hasWikilinkTarget(source.content, target) &&
        !hasMarkdownLinkTarget(source.content, target))
    ) {
      return undefined;
    }
    return {
      type: "renamed-slug",
      slug,
      target,
      message: `Page "${slug}.md" still links to renamed slug "${target}" (now "${canonical}")`,
      severity: "warning",
      suggestion: `Rewrite the link to "${canonical}.md".`,
      fix: "renamed-slug",
    };
  }
  if (type === "orphan-page" || type === "stale-index") {
    const [page, entries] = await Promise.all([
      readWikiPage(slug, { fresh: true, strict: true }),
      listWikiPages({ strict: true }),
    ]);
    const indexed = entries.some((entry) => entry.slug === slug);
    if (type === "orphan-page" && page && !indexed) {
      return {
        type,
        slug,
        message: `Page "${slug}.md" is not listed in index.md`,
        severity: "warning",
        fix: "orphan-page",
      };
    }
    if (type === "stale-index" && !page && indexed) {
      return {
        type,
        slug,
        message: `index.md lists missing page "${slug}.md"`,
        severity: "warning",
        fix: "stale-index",
      };
    }
  }
  return undefined;
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
  const combined: WorkbenchLintIssue[] = [
    ...result.issues.map((issue): WorkbenchLintIssue => {
      if (issue.type === "orphan-page") return { ...issue, fix: "orphan-page" };
      if (issue.type === "stale-index") return { ...issue, fix: "stale-index" };
      return issue;
    }),
    ...inbound,
  ];
  if (options.semantic) combined.push(GAP_POINTER);
  return promoteRenamedSlugs(combined, diskSet);
}
