import { isEnoent } from "./errors";
import { withFileLock } from "./lock";
import { getStorage } from "./storage";
import { tenantForOwner, validateTenant } from "./wiki";

export type ResearchProjectStatus =
  | "draft"
  | "queued"
  | "collecting"
  | "ready"
  | "complete"
  | "failed"
  | "cancelled";

export interface ResearchProjectResult {
  title: string;
  url: string;
  snippet: string;
  query: string;
  score?: number;
  publishedAt?: string;
}

export interface ResearchProject {
  id: string;
  title: string;
  question: string;
  queries: string[];
  sourceUrls: string[];
  pageSlugs: string[];
  vaultId?: string;
  status: ResearchProjectStatus;
  synthesis?: string;
  provider?: "tavily" | "serpapi" | "searxng";
  progress?: { completedQueries: number; totalQueries: number; message: string };
  results?: ResearchProjectResult[];
  proposalId?: string;
  cancelRequested?: boolean;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchProjectInput {
  title: string;
  question: string;
  queries?: readonly string[];
  sourceUrls?: readonly string[];
  pageSlugs?: readonly string[];
  vaultId?: string | null;
}

const MAX_PROJECTS = 100;
const STATUSES = new Set<ResearchProjectStatus>([
  "draft", "queued", "collecting", "ready", "complete", "failed", "cancelled",
]);

function projectPath(owner: string): string {
  const tenant = tenantForOwner(owner);
  validateTenant(tenant);
  return `tenants/${tenant}/research-projects.json`;
}

function lockKey(owner: string): string {
  return `research-projects:${tenantForOwner(owner)}`;
}

function cleanList(values: readonly string[] | undefined, maxItems: number, maxChars: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values ?? []) {
    const cleaned = value.trim().replace(/\s+/g, " ").slice(0, maxChars);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
    if (result.length >= maxItems) break;
  }
  return result;
}

function cleanUrls(values: readonly string[] | undefined): string[] {
  return cleanList(values, 40, 2_000).filter((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  });
}

function cleanInput(input: ResearchProjectInput) {
  const title = input.title.trim().replace(/\s+/g, " ").slice(0, 160);
  const question = input.question.trim().slice(0, 4_000);
  if (!title) throw new Error("Research title is required");
  if (!question) throw new Error("Research question is required");
  return {
    title,
    question,
    queries: cleanList(input.queries, 16, 500),
    sourceUrls: cleanUrls(input.sourceUrls),
    pageSlugs: cleanList(input.pageSlugs, 50, 240),
    ...(input.vaultId?.trim() ? { vaultId: input.vaultId.trim().slice(0, 240) } : {}),
  };
}

async function readProjects(owner: string): Promise<ResearchProject[]> {
  try {
    const parsed = JSON.parse(await getStorage().readFile(projectPath(owner)));
    return Array.isArray(parsed) ? parsed as ResearchProject[] : [];
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

async function writeProjects(owner: string, projects: ResearchProject[]): Promise<void> {
  await getStorage().writeFile(
    projectPath(owner),
    JSON.stringify(projects.slice(-MAX_PROJECTS), null, 2),
  );
}

export async function listResearchProjects(owner: string): Promise<ResearchProject[]> {
  return (await readProjects(owner)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getResearchProject(
  owner: string,
  id: string,
): Promise<ResearchProject | null> {
  return (await readProjects(owner)).find((project) => project.id === id) ?? null;
}

export async function createResearchProject(
  owner: string,
  input: ResearchProjectInput,
): Promise<ResearchProject> {
  const cleaned = cleanInput(input);
  return withFileLock(lockKey(owner), async () => {
    const projects = await readProjects(owner);
    const now = new Date().toISOString();
    const project: ResearchProject = {
      id: crypto.randomUUID(),
      ...cleaned,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };
    projects.push(project);
    await writeProjects(owner, projects);
    return project;
  });
}

export async function updateResearchProject(
  owner: string,
  id: string,
  patch: Partial<ResearchProjectInput> & {
    status?: ResearchProjectStatus;
    synthesis?: string | null;
    provider?: ResearchProject["provider"] | null;
    progress?: ResearchProject["progress"] | null;
    results?: ResearchProjectResult[] | null;
    proposalId?: string | null;
    cancelRequested?: boolean;
    error?: string | null;
  },
): Promise<ResearchProject | null> {
  return withFileLock(lockKey(owner), async () => {
    const projects = await readProjects(owner);
    const project = projects.find((item) => item.id === id);
    if (!project) return null;
    if (patch.title !== undefined || patch.question !== undefined) {
      const cleaned = cleanInput({
        title: patch.title ?? project.title,
        question: patch.question ?? project.question,
        queries: patch.queries ?? project.queries,
        sourceUrls: patch.sourceUrls ?? project.sourceUrls,
        pageSlugs: patch.pageSlugs ?? project.pageSlugs,
        vaultId: patch.vaultId === undefined ? project.vaultId : patch.vaultId,
      });
      Object.assign(project, cleaned);
    } else {
      if (patch.queries !== undefined) project.queries = cleanList(patch.queries, 16, 500);
      if (patch.sourceUrls !== undefined) project.sourceUrls = cleanUrls(patch.sourceUrls);
      if (patch.pageSlugs !== undefined) project.pageSlugs = cleanList(patch.pageSlugs, 50, 240);
      if (patch.vaultId !== undefined) {
        if (patch.vaultId?.trim()) project.vaultId = patch.vaultId.trim().slice(0, 240);
        else delete project.vaultId;
      }
    }
    if (patch.status !== undefined) {
      if (!STATUSES.has(patch.status)) throw new Error("Invalid research status");
      project.status = patch.status;
    }
    if (patch.synthesis !== undefined) {
      if (patch.synthesis?.trim()) project.synthesis = patch.synthesis.trim().slice(0, 200_000);
      else delete project.synthesis;
    }
    if (patch.provider !== undefined) {
      if (patch.provider) project.provider = patch.provider;
      else delete project.provider;
    }
    if (patch.progress !== undefined) {
      if (patch.progress) project.progress = {
        completedQueries: Math.max(0, Math.floor(patch.progress.completedQueries)),
        totalQueries: Math.max(0, Math.floor(patch.progress.totalQueries)),
        message: patch.progress.message.trim().slice(0, 500),
      };
      else delete project.progress;
    }
    if (patch.results !== undefined) {
      if (patch.results) project.results = patch.results.slice(0, 100).map((result) => ({
        ...result,
        title: result.title.trim().slice(0, 300),
        url: result.url.trim().slice(0, 2_000),
        snippet: result.snippet.trim().slice(0, 4_000),
        query: result.query.trim().slice(0, 1_000),
      }));
      else delete project.results;
    }
    if (patch.proposalId !== undefined) {
      if (patch.proposalId?.trim()) project.proposalId = patch.proposalId.trim().slice(0, 160);
      else delete project.proposalId;
    }
    if (patch.cancelRequested !== undefined) project.cancelRequested = patch.cancelRequested;
    if (patch.error !== undefined) {
      if (patch.error?.trim()) project.error = patch.error.trim().slice(0, 2_000);
      else delete project.error;
    }
    project.updatedAt = new Date().toISOString();
    await writeProjects(owner, projects);
    return project;
  });
}

export async function deleteResearchProject(owner: string, id: string): Promise<boolean> {
  return withFileLock(lockKey(owner), async () => {
    const projects = await readProjects(owner);
    const next = projects.filter((project) => project.id !== id);
    if (next.length === projects.length) return false;
    await writeProjects(owner, next);
    return true;
  });
}
