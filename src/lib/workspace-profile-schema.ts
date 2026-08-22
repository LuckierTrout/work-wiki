export const WORKSPACE_SCENARIOS = [
  "general",
  "research",
  "reading",
  "personal-growth",
  "business",
  "custom",
] as const;

export type WorkspaceScenario = (typeof WORKSPACE_SCENARIOS)[number];

export interface WorkspaceProfileInput {
  scenario: WorkspaceScenario;
  purpose: string;
  keyQuestions: string[];
  inScope: string[];
  outOfScope: string[];
  outputLanguage: string;
  pageConventions: string;
}

export interface WorkspaceScenarioTemplate extends WorkspaceProfileInput {
  name: string;
  description: string;
}

/**
 * Clean-room work-wiki templates. These describe broadly useful workflows in
 * work-wiki's own language and do not reproduce the reference application's
 * GPL-licensed template text.
 */
export const WORKSPACE_SCENARIO_TEMPLATES: Record<
  Exclude<WorkspaceScenario, "custom">,
  WorkspaceScenarioTemplate
> = {
  general: {
    scenario: "general",
    name: "General knowledge",
    description: "A flexible, evidence-linked memory for documents, decisions, and ideas.",
    purpose:
      "Maintain a trustworthy private working memory that turns incoming material into concise, connected, source-backed knowledge.",
    keyQuestions: [
      "What is genuinely new or changed?",
      "How does this connect to existing knowledge?",
      "What needs a decision, follow-up, or verification?",
    ],
    inScope: ["Useful facts, decisions, concepts, relationships, and action-relevant context"],
    outOfScope: ["Unsupported inference, duplicate restatement, and low-value boilerplate"],
    outputLanguage: "English",
    pageConventions:
      "Prefer durable concept pages over one-off summaries. Keep claims close to their evidence and state uncertainty plainly.",
  },
  research: {
    scenario: "research",
    name: "Research",
    description: "Evidence comparison around a defined question or decision.",
    purpose:
      "Develop a defensible answer to a defined research question by comparing sources, tracking disagreements, and separating evidence from inference.",
    keyQuestions: [
      "What does the strongest available evidence support?",
      "Where do sources disagree, and why?",
      "What unanswered question would most change the conclusion?",
    ],
    inScope: ["Claims, methods, findings, limitations, counterevidence, and open questions"],
    outOfScope: ["Conclusions that cannot be traced to evidence"],
    outputLanguage: "English",
    pageConventions:
      "Distinguish findings, methods, hypotheses, and synthesis. Record contrary evidence instead of smoothing it away.",
  },
  reading: {
    scenario: "reading",
    name: "Reading",
    description: "Connected notes for books, articles, and long-form material.",
    purpose:
      "Build a lasting understanding of long-form reading by tracking people, ideas, themes, arguments, and changes across the work.",
    keyQuestions: [
      "What is the author trying to establish?",
      "Which ideas or themes recur and evolve?",
      "What is worth remembering or connecting to other material?",
    ],
    inScope: ["Arguments, themes, people, examples, chapter-level developments, and quotations with context"],
    outOfScope: ["Plot or argument details invented to fill gaps"],
    outputLanguage: "English",
    pageConventions:
      "Preserve sequence when it matters, but connect recurring ideas across chapters or sections. Label interpretation as interpretation.",
  },
  "personal-growth": {
    scenario: "personal-growth",
    name: "Personal growth",
    description: "Private reflection that connects goals, patterns, and experiments.",
    purpose:
      "Turn private reflections and learning into a compassionate, practical record of goals, patterns, experiments, and progress.",
    keyQuestions: [
      "What pattern or need is visible here?",
      "What small experiment or commitment follows from it?",
      "What evidence would show progress or change?",
    ],
    inScope: ["Owner-authored reflections, goals, habits, lessons, experiments, and progress evidence"],
    outOfScope: ["Diagnosis, moral judgment, or commitments the owner did not make"],
    outputLanguage: "English",
    pageConventions:
      "Use non-judgmental language. Treat sensitive material as private and distinguish observations from interpretations.",
  },
  business: {
    scenario: "business",
    name: "Business",
    description: "Operational memory for projects, decisions, commitments, and risks.",
    purpose:
      "Maintain an accountable operating memory that links projects, decisions, commitments, risks, people, and the evidence behind them.",
    keyQuestions: [
      "What was decided, by whom, and on what evidence?",
      "What commitment, dependency, or risk needs attention?",
      "What changed since the last accepted record?",
    ],
    inScope: ["Projects, organizations, people, decisions, commitments, dependencies, risks, metrics, and dates"],
    outOfScope: ["Speculative ownership, dates, status, or business conclusions"],
    outputLanguage: "English",
    pageConventions:
      "Prefer explicit owners, dates, status, and source excerpts. Keep tentative proposals separate from accepted decisions.",
  },
};

export const EMPTY_WORKSPACE_PROFILE: WorkspaceProfileInput = {
  scenario: "custom",
  purpose: "",
  keyQuestions: [],
  inScope: [],
  outOfScope: [],
  outputLanguage: "",
  pageConventions: "",
};

const SCENARIO_SET = new Set<string>(WORKSPACE_SCENARIOS);
const MAX_LIST_ITEMS = 30;

function text(value: unknown, name: string, max: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error(`${name} must be text`);
  return value.trim().replace(/\r\n?/g, "\n").slice(0, max);
}

function textList(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${name} must be a list of text values`);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const cleaned = item.trim().replace(/\s+/g, " ").slice(0, 500);
    const key = cleaned.toLocaleLowerCase();
    if (!cleaned || seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
    if (result.length >= MAX_LIST_ITEMS) break;
  }
  return result;
}

export function parseWorkspaceProfileInput(value: unknown): WorkspaceProfileInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Workspace profile must be an object");
  }
  const body = value as Record<string, unknown>;
  if (typeof body.scenario !== "string" || !SCENARIO_SET.has(body.scenario)) {
    throw new Error("Choose a valid workspace scenario");
  }
  return {
    scenario: body.scenario as WorkspaceScenario,
    purpose: text(body.purpose, "Purpose", 8_000),
    keyQuestions: textList(body.keyQuestions, "Key questions"),
    inScope: textList(body.inScope, "In-scope items"),
    outOfScope: textList(body.outOfScope, "Out-of-scope items"),
    outputLanguage: text(body.outputLanguage, "Output language", 80).replace(/\s+/g, " "),
    pageConventions: text(body.pageConventions, "Page conventions", 8_000),
  };
}

export function workspaceProfileHasGuidance(profile: WorkspaceProfileInput): boolean {
  return Boolean(
    profile.purpose ||
      profile.keyQuestions.length ||
      profile.inScope.length ||
      profile.outOfScope.length ||
      profile.outputLanguage ||
      profile.pageConventions,
  );
}
