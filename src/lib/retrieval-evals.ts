import { isEnoent } from "./errors";
import { withFileLock } from "./lock";
import { query } from "./query";
import { getStorage } from "./storage";
import { tenantForOwner, validateSlug, validateTenant } from "./wiki";
import { recordOperationSafe } from "./operation-ledger";

export interface RetrievalEvalCase {
  id: string;
  owner: string;
  label: string;
  question: string;
  expectedSlugs: string[];
  forbiddenSlugs: string[];
  requiredPhrases: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RetrievalEvalCaseResult {
  caseId: string;
  label: string;
  sources: string[];
  retrievedSources: string[];
  sourceRecall: number;
  citationPrecision: number;
  privacyPass: boolean;
  requiredLanguagePass: boolean;
  groundedAnswerPass: boolean;
  answerExcerpt: string;
}

export interface RetrievalEvalRun {
  id: string;
  owner: string;
  createdAt: string;
  caseCount: number;
  sourceRecall: number;
  citationPrecision: number;
  privacyPassRate: number;
  groundedAnswerRate: number;
  results: RetrievalEvalCaseResult[];
}

const MAX_CASES = 100;
const MAX_RUNS = 50;

function tenant(owner: string): string {
  const value = tenantForOwner(owner);
  validateTenant(value);
  return value;
}

function casesPath(owner: string): string {
  return `tenants/${tenant(owner)}/retrieval-eval-cases.json`;
}

function runsPath(owner: string): string {
  return `tenants/${tenant(owner)}/retrieval-eval-runs.json`;
}

function lockKey(owner: string): string {
  return `retrieval-evals:${tenant(owner)}`;
}

async function readArray<T>(path: string): Promise<T[]> {
  try {
    const parsed = JSON.parse(await getStorage().readFile(path));
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

export async function listRetrievalEvalCases(owner: string): Promise<RetrievalEvalCase[]> {
  return readArray<RetrievalEvalCase>(casesPath(owner));
}

export async function listRetrievalEvalRuns(owner: string): Promise<RetrievalEvalRun[]> {
  return (await readArray<RetrievalEvalRun>(runsPath(owner)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function saveRetrievalEvalCase(
  owner: string,
  input: {
    id?: string;
    label: string;
    question: string;
    expectedSlugs: string[];
    forbiddenSlugs?: string[];
    requiredPhrases?: string[];
  },
): Promise<RetrievalEvalCase> {
  const label = input.label.trim().slice(0, 200);
  const question = input.question.trim().slice(0, 2_000);
  if (!label || !question) throw new Error("Evaluation label and question are required");
  for (const slug of [...input.expectedSlugs, ...(input.forbiddenSlugs ?? [])]) validateSlug(slug);
  return withFileLock(lockKey(owner), async () => {
    const cases = await listRetrievalEvalCases(owner);
    const now = new Date().toISOString();
    const existing = input.id ? cases.find((item) => item.id === input.id) : undefined;
    const value: RetrievalEvalCase = {
      id: existing?.id ?? `eval_${crypto.randomUUID()}`,
      owner,
      label,
      question,
      expectedSlugs: [...new Set(input.expectedSlugs)].slice(0, 30),
      forbiddenSlugs: [...new Set(input.forbiddenSlugs ?? [])].slice(0, 30),
      requiredPhrases: [...new Set(input.requiredPhrases ?? [])]
        .map((phrase) => phrase.trim().slice(0, 120))
        .filter(Boolean)
        .slice(0, 20),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const position = cases.findIndex((item) => item.id === value.id);
    if (position === -1) cases.push(value);
    else cases[position] = value;
    await getStorage().writeFile(casesPath(owner), JSON.stringify(cases.slice(-MAX_CASES), null, 2));
    return value;
  });
}

export async function deleteRetrievalEvalCase(owner: string, id: string): Promise<boolean> {
  return withFileLock(lockKey(owner), async () => {
    const cases = await listRetrievalEvalCases(owner);
    const next = cases.filter((item) => item.id !== id);
    if (next.length === cases.length) return false;
    await getStorage().writeFile(casesPath(owner), JSON.stringify(next, null, 2));
    return true;
  });
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 1;
}

export async function runRetrievalEvaluation(
  owner: string,
  answer: (question: string) => Promise<{ answer: string; sources: string[]; retrievedSources?: string[] }> = (question) =>
    query(question, "prose", "mine", { id: `eval:${owner}`, handle: owner }),
): Promise<RetrievalEvalRun> {
  const cases = await listRetrievalEvalCases(owner);
  if (cases.length === 0) throw new Error("Add at least one retrieval evaluation case first");
  const results: RetrievalEvalCaseResult[] = [];
  for (const item of cases) {
    const response = await answer(item.question);
    const sources = [...new Set(response.sources)];
    const retrievedSources = [...new Set(response.retrievedSources ?? sources)];
    const expected = new Set(item.expectedSlugs);
    const retrievalMatches = retrievedSources.filter((slug) => expected.has(slug)).length;
    const citationMatches = sources.filter((slug) => expected.has(slug)).length;
    const lowerAnswer = response.answer.toLowerCase();
    const insufficient = /not enough information|doesn.t contain|cannot answer/i.test(response.answer);
    results.push({
      caseId: item.id,
      label: item.label,
      sources,
      retrievedSources,
      sourceRecall: item.expectedSlugs.length ? retrievalMatches / item.expectedSlugs.length : 1,
      citationPrecision: sources.length ? citationMatches / sources.length : item.expectedSlugs.length ? 0 : 1,
      privacyPass: ![...retrievedSources, ...sources].some((slug) => item.forbiddenSlugs.includes(slug)),
      requiredLanguagePass: item.requiredPhrases.every((phrase) => lowerAnswer.includes(phrase.toLowerCase())),
      groundedAnswerPass: sources.length > 0 || insufficient,
      answerExcerpt: response.answer.slice(0, 500),
    });
  }
  const run: RetrievalEvalRun = {
    id: `run_${crypto.randomUUID()}`,
    owner,
    createdAt: new Date().toISOString(),
    caseCount: results.length,
    sourceRecall: average(results.map((result) => result.sourceRecall)),
    citationPrecision: average(results.map((result) => result.citationPrecision)),
    privacyPassRate: average(results.map((result) => result.privacyPass ? 1 : 0)),
    groundedAnswerRate: average(results.map((result) => result.groundedAnswerPass ? 1 : 0)),
    results,
  };
  await withFileLock(lockKey(owner), async () => {
    const runs = await listRetrievalEvalRuns(owner);
    runs.push(run);
    await getStorage().writeFile(runsPath(owner), JSON.stringify(runs.slice(-MAX_RUNS), null, 2));
  });
  await recordOperationSafe(owner, {
    kind: "evaluation",
    operation: "retrieval-quality",
    status: results.every((result) => result.privacyPass) ? "succeeded" : "failed",
    subjectId: run.id,
    detail: `recall ${run.sourceRecall.toFixed(2)}; citation precision ${run.citationPrecision.toFixed(2)}; privacy ${run.privacyPassRate.toFixed(2)}`,
  });
  return run;
}
