import { stepCountIs, tool, ToolLoopAgent } from "ai";
import { z } from "zod";
import { proposeActionItems } from "./action-items";
import { getAgent, listAgents, registerAgent } from "./agents";
import { isEnoent } from "./errors";
import { getConfiguredModel } from "./llm";
import { withFileLock } from "./lock";
import { buildContext, selectPagesForQuery } from "./query";
import { resolveScopeSlugs } from "./search";
import { getStorage } from "./storage";
import {
  isArtifactType,
  listReadableWikiPages,
  tenantForOwner,
  validateTenant,
} from "./wiki";
import type { AgentProfile } from "./types";

export type AgentRunTrigger = "manual" | "after-ingest" | "daily" | "weekly";

export interface AgentActivity {
  id: string;
  agentId: string;
  trigger: AgentRunTrigger;
  prompt: string;
  output: string;
  sourceSlug?: string;
  toolsUsed: string[];
  createdAt: string;
}

const MAX_ACTIVITY = 200;

function activityPath(owner: string): string {
  const tenant = tenantForOwner(owner);
  validateTenant(tenant);
  return `tenants/${tenant}/agent-activity.json`;
}

function activityLock(owner: string): string {
  return `agent-activity:${tenantForOwner(owner)}`;
}

async function readActivity(owner: string): Promise<AgentActivity[]> {
  try {
    const parsed = JSON.parse(await getStorage().readFile(activityPath(owner)));
    return Array.isArray(parsed) ? (parsed as AgentActivity[]) : [];
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

async function recordActivity(owner: string, activity: AgentActivity): Promise<void> {
  await withFileLock(activityLock(owner), async () => {
    const entries = await readActivity(owner);
    entries.push(activity);
    await getStorage().writeFile(
      activityPath(owner),
      JSON.stringify(entries.slice(-MAX_ACTIVITY), null, 2),
    );
  });
}

export async function listAgentActivity(
  owner: string,
  agentId?: string,
): Promise<AgentActivity[]> {
  return (await readActivity(owner))
    .filter((entry) => !agentId || entry.agentId === agentId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function grantedTools(agent: AgentProfile): Array<"searchWiki" | "proposeTasks"> {
  const grants = agent.allowedTools ?? ["search-wiki"];
  const active: Array<"searchWiki" | "proposeTasks"> = [];
  if (grants.includes("search-wiki")) active.push("searchWiki");
  if (grants.includes("propose-tasks")) active.push("proposeTasks");
  return active;
}

export async function runSpecializedAgent(input: {
  agentId: string;
  owner: string;
  trigger: AgentRunTrigger;
  prompt?: string;
  sourceSlug?: string;
}): Promise<AgentActivity> {
  const agent = await getAgent(input.agentId);
  if (!agent || agent.owner?.toLowerCase() !== input.owner.toLowerCase()) {
    throw new Error("Agent not found or not owned by you");
  }
  if (input.trigger !== "manual" && !agent.enabled) {
    throw new Error("Automatic agent is disabled");
  }

  const principal = { id: `agent-owner:${input.owner}`, handle: input.owner };
  const model = await getConfiguredModel({
    ...(agent.provider ? { provider: agent.provider } : {}),
    ...(agent.model ? { model: agent.model } : {}),
  });
  const searchWiki = tool({
    description:
      "Search the owner's readable Yopedia knowledge and return the most relevant cited page excerpts.",
    inputSchema: z.object({ query: z.string().min(1).max(2_000) }),
    execute: async ({ query }) => {
      const { scopeSlugs, error } = await resolveScopeSlugs(
        agent.knowledgeScope || undefined,
        principal,
      );
      if (error) return { error };
      const entries = (await listReadableWikiPages(principal)).filter(
        (entry) => !isArtifactType(entry.type),
      );
      const selected = await selectPagesForQuery(query, entries, scopeSlugs);
      const { context, slugs } = await buildContext(selected);
      return { slugs, context };
    },
  });
  const proposeTasks = tool({
    description:
      "Place concrete action proposals into the owner's private task inbox. Proposals require owner acceptance.",
    inputSchema: z.object({
      tasks: z.array(z.object({
        title: z.string().min(1).max(240),
        details: z.string().max(2_000).optional(),
        assignee: z.string().max(160).optional(),
        dueDate: z.string().max(40).optional(),
        priority: z.enum(["low", "medium", "high"]).optional(),
        sourceSlug: z.string().max(240).optional(),
        sourceExcerpt: z.string().max(800).optional(),
      })).max(25),
    }),
    execute: async ({ tasks }) => ({
      created: (await proposeActionItems(input.owner, tasks)).length,
    }),
  });

  const activeTools = grantedTools(agent);
  const runtime = new ToolLoopAgent({
    model,
    instructions:
      `${agent.instructions || agent.description}\n\n` +
      "You operate only inside the owner's Yopedia account. Use searchWiki before making factual claims about their knowledge. " +
      "Use proposeTasks only for concrete actions supported by source material; proposals remain owner-controlled. " +
      "Never claim that a task has been completed or sent to an external system.",
    tools: { searchWiki, proposeTasks },
    activeTools,
    stopWhen: stepCountIs(8),
  });
  const prompt =
    input.prompt?.trim() ||
    (input.sourceSlug
      ? `Review the newly ingested page ${input.sourceSlug}. Search it and perform your configured role.`
      : `Run your ${input.trigger} review of the owner's knowledge and perform your configured role.`);
  const result = await runtime.generate({ prompt });
  const toolsUsed = [...new Set(
    result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName)),
  )];
  const activity: AgentActivity = {
    id: crypto.randomUUID(),
    agentId: agent.id,
    trigger: input.trigger,
    prompt,
    output: result.text || "Run completed without a text summary.",
    ...(input.sourceSlug ? { sourceSlug: input.sourceSlug } : {}),
    toolsUsed,
    createdAt: new Date().toISOString(),
  };
  await recordActivity(input.owner, activity);
  agent.lastRunAt = activity.createdAt;
  agent.lastUpdated = activity.createdAt;
  await registerAgent(agent);
  return activity;
}

export async function listDueScheduledAgents(
  now: Date = new Date(),
): Promise<AgentProfile[]> {
  const candidates = (await listAgents()).filter(
    (agent) =>
      agent.owner &&
      agent.enabled &&
      (agent.trigger === "daily" || agent.trigger === "weekly"),
  );
  return candidates.filter((agent) => {
    if (!agent.lastRunAt) return true;
    const elapsed = now.getTime() - new Date(agent.lastRunAt).getTime();
    const interval = agent.trigger === "weekly" ? 7 * 86_400_000 : 86_400_000;
    return Number.isFinite(elapsed) && elapsed >= interval;
  });
}
