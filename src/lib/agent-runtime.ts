import { stepCountIs, tool, ToolLoopAgent } from "ai";
import { z } from "zod";
import { proposeActionItems } from "./action-items";
import { createMemoryChangeProposal } from "./memory-proposals";
import { getAgent, listAgents, registerAgent } from "./agents";
import { isEnoent } from "./errors";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter";
import { getConfiguredModel } from "./llm";
import { withFileLock } from "./lock";
import { buildContext, selectPagesForQuery } from "./query";
import { resolveScopeSlugs } from "./search";
import { getStorage } from "./storage";
import {
  isArtifactType,
  listReadableWikiPages,
  tenantForOwner,
  tenantWikiRelPath,
  validateTenant,
} from "./wiki";
import type { AgentProfile } from "./types";
import { recordOperationSafe } from "./operation-ledger";
import { buildWorkspaceGuidance } from "./workspace-profile";
import { buildAgentSkillGuidance } from "./agent-skills";
import {
  createAgentInteraction,
  createAgentSandboxApproval,
  recordAgentRunWorkspace,
  type AgentInteractionField,
} from "./agent-workspaces";
import { logger } from "./logger";

export type AgentRunTrigger = "manual" | "after-ingest" | "daily" | "weekly";

export interface AgentActivity {
  id: string;
  agentId: string;
  trigger: AgentRunTrigger;
  prompt: string;
  output: string;
  sourceSlug?: string;
  toolsUsed: string[];
  mode?: "execute" | "dry-run";
  status?: "completed" | "failed" | "awaiting-input";
  retrievedSlugs?: string[];
  proposedTaskIds?: string[];
  proposedMemoryIds?: string[];
  expectedChanges?: string[];
  provider?: string;
  model?: string;
  finishReason?: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  estimatedCostUsd?: number;
  durationMs?: number;
  error?: string;
  workspaceId?: string;
  interactionIds?: string[];
  sandboxApprovalIds?: string[];
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

type RuntimeToolName =
  | "searchWiki"
  | "proposeTasks"
  | "proposeMemory"
  | "requestInput"
  | "runSandbox";

function grantedTools(agent: AgentProfile): RuntimeToolName[] {
  const grants = agent.allowedTools ?? ["search-wiki"];
  const active: RuntimeToolName[] = [];
  if (grants.includes("search-wiki")) active.push("searchWiki");
  if (grants.includes("propose-tasks")) active.push("proposeTasks");
  if (grants.includes("propose-memory")) active.push("proposeMemory");
  if (grants.includes("request-input")) active.push("requestInput");
  if (grants.includes("run-sandbox")) active.push("runSandbox");
  return active;
}

function estimatedCostUsd(usage: { inputTokens: number; outputTokens: number }): number | undefined {
  const inputRate = Number(process.env.LLM_INPUT_COST_PER_MILLION);
  const outputRate = Number(process.env.LLM_OUTPUT_COST_PER_MILLION);
  if (!Number.isFinite(inputRate) || !Number.isFinite(outputRate)) return undefined;
  return (usage.inputTokens * inputRate + usage.outputTokens * outputRate) / 1_000_000;
}

export async function runSpecializedAgent(input: {
  agentId: string;
  owner: string;
  trigger: AgentRunTrigger;
  prompt?: string;
  sourceSlug?: string;
  dryRun?: boolean;
}): Promise<AgentActivity> {
  const agent = await getAgent(input.agentId);
  if (!agent || agent.owner?.toLowerCase() !== input.owner.toLowerCase()) {
    throw new Error("Agent not found or not owned by you");
  }
  if (input.trigger !== "manual" && !agent.enabled) {
    throw new Error("Automatic agent is disabled");
  }

  const principal = { id: `agent-owner:${input.owner}`, handle: input.owner };
  const runId = crypto.randomUUID();
  const startedAt = Date.now();
  const retrievedSlugs = new Set<string>();
  const proposedTaskIds: string[] = [];
  const proposedMemoryIds: string[] = [];
  const expectedChanges: string[] = [];
  const interactionIds: string[] = [];
  const sandboxApprovalIds: string[] = [];
  const runArtifacts: Array<{ filename: string; content: string; mediaType?: string }> = [];
  const workspaceGuidance = await buildWorkspaceGuidance(input.owner);
  const skillGuidance = await buildAgentSkillGuidance(input.owner, agent.id);
  const model = await getConfiguredModel({
    ...(agent.provider ? { provider: agent.provider } : {}),
    ...(agent.model ? { model: agent.model } : {}),
  });
  const searchWiki = tool({
    description:
      "Search the owner's readable WorkWiki knowledge and return the most relevant cited page excerpts.",
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
      for (const slug of slugs) retrievedSlugs.add(slug);
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
    execute: async ({ tasks }) => {
      if (input.dryRun) {
        expectedChanges.push(...tasks.map((task) => `Task proposal: ${task.title}`));
        return { dryRun: true, wouldCreate: tasks.length };
      }
      const created = await proposeActionItems(input.owner, tasks);
      proposedTaskIds.push(...created.map((item) => item.id));
      return { created: created.length, ids: created.map((item) => item.id) };
    },
  });
  const proposeMemory = tool({
    description:
      "Propose a complete replacement body for an existing owner page. The proposal enters Review and never changes memory directly.",
    inputSchema: z.object({
      targetSlug: z.string().min(1).max(240),
      title: z.string().min(1).max(240),
      summary: z.string().min(1).max(1_000),
      reason: z.string().min(1).max(2_000),
      proposedBody: z.string().min(1).max(200_000),
      evidenceIds: z.array(z.string().min(1).max(160)).max(50).optional(),
      risk: z.enum(["low", "medium", "high"]).default("medium"),
    }),
    execute: async ({ targetSlug, title, summary, reason, proposedBody, evidenceIds, risk }) => {
      if (input.dryRun) {
        expectedChanges.push(`Memory proposal: ${targetSlug} — ${summary}`);
        return { dryRun: true, targetSlug, summary };
      }
      const currentContent = await getStorage().readFile(
        tenantWikiRelPath(tenantForOwner(input.owner), `${targetSlug}.md`),
      );
      const current = parseFrontmatter(currentContent);
      if (
        typeof current.data.owner !== "string" ||
        tenantForOwner(current.data.owner) !== tenantForOwner(input.owner)
      ) {
        throw new Error("The agent may only propose changes to its owner's pages");
      }
      const proposal = await createMemoryChangeProposal(input.owner, {
        targetSlug,
        title,
        summary,
        reason,
        proposedContent: serializeFrontmatter(current.data, proposedBody),
        evidenceIds,
        actor: agent.id,
        risk,
      });
      proposedMemoryIds.push(proposal.id);
      return { proposalId: proposal.id, status: proposal.status };
    },
  });
  const requestInput = tool({
    description:
      "Pause for structured owner input. Create one concise form only when a required fact or decision is missing, then stop the run and wait for the owner.",
    inputSchema: z.object({
      title: z.string().min(1).max(240),
      description: z.string().max(1_000).optional(),
      fields: z.array(z.object({
        id: z.string().regex(/^[a-z0-9_-]{1,80}$/i),
        label: z.string().min(1).max(160),
        type: z.enum(["text", "textarea", "number", "date", "select", "checkbox"]),
        required: z.boolean().optional(),
        options: z.array(z.string().min(1).max(160)).max(30).optional(),
        help: z.string().max(500).optional(),
      })).min(1).max(20),
    }),
    execute: async ({ title, description, fields }) => {
      if (input.dryRun) {
        expectedChanges.push(`Input request: ${title}`);
        return { dryRun: true, wouldPause: true };
      }
      const interaction = await createAgentInteraction({
        owner: input.owner,
        agentId: agent.id,
        runId,
        title,
        description,
        fields: fields as AgentInteractionField[],
      });
      interactionIds.push(interaction.id);
      return { interactionId: interaction.id, status: interaction.status, instruction: "Stop and wait for the owner." };
    },
  });
  const runSandbox = tool({
    description:
      "Request owner approval for one bounded command in the isolated Cloudflare Sandbox. Nothing executes until the owner approves the exact command docket. After requesting approval, stop the run and wait.",
    inputSchema: z.object({
      purpose: z.string().max(500).optional(),
      command: z.string().min(1).max(4_000),
      files: z.record(
        z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/),
        z.string().max(200_000),
      ).optional(),
      outputFiles: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/)).max(20).optional(),
      timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
    }),
    execute: async ({ purpose, command, files, outputFiles, timeoutMs }) => {
      if (input.dryRun) {
        expectedChanges.push(`Sandbox command: ${command.slice(0, 160)}`);
        return { dryRun: true, wouldRequestApproval: command };
      }
      const approval = await createAgentSandboxApproval({
        owner: input.owner,
        agentId: agent.id,
        runId,
        purpose,
        command,
        files,
        outputFiles,
        timeoutMs,
      });
      sandboxApprovalIds.push(approval.id);
      return {
        approvalId: approval.id,
        status: approval.status,
        instruction: "Stop and wait for the owner to approve or reject this command.",
      };
    },
  });

  const activeTools = grantedTools(agent);
  const runtime = new ToolLoopAgent({
    model,
    instructions:
      `${agent.instructions || agent.description}\n\n` +
      "You operate only inside the owner's WorkWiki account. Use searchWiki before making factual claims about their knowledge. " +
      "Use proposeTasks only for concrete actions supported by source material; proposals remain owner-controlled. " +
      "Never claim that a task has been completed or sent to an external system." +
      (workspaceGuidance ? `\n\n${workspaceGuidance}` : "") +
      (skillGuidance ? `\n\n${skillGuidance}` : ""),
    tools: { searchWiki, proposeTasks, proposeMemory, requestInput, runSandbox },
    maxOutputTokens: agent.maxOutputTokens ?? 2_500,
    activeTools,
    stopWhen: stepCountIs(agent.maxSteps ?? 8),
  });
  const prompt =
    input.prompt?.trim() ||
    (input.sourceSlug
      ? `Review the newly ingested page ${input.sourceSlug}. Search it and perform your configured role.`
      : `Run your ${input.trigger} review of the owner's knowledge and perform your configured role.`);
  let result;
  try {
    result = await runtime.generate({
      prompt,
      timeout: agent.timeoutMs ?? 90_000,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const activity: AgentActivity = {
      id: runId,
      agentId: agent.id,
      trigger: input.trigger,
      prompt,
      output: "Run failed before producing a final response.",
      ...(input.sourceSlug ? { sourceSlug: input.sourceSlug } : {}),
      toolsUsed: [],
      mode: input.dryRun ? "dry-run" : "execute",
      status: "failed",
      retrievedSlugs: [...retrievedSlugs],
      proposedTaskIds,
      proposedMemoryIds,
      expectedChanges,
      provider: agent.provider ?? "app-default",
      model: agent.model ?? "app-default",
      durationMs: Date.now() - startedAt,
      error: message.slice(0, 2_000),
      interactionIds,
      sandboxApprovalIds,
      createdAt: new Date().toISOString(),
    };
    try {
      const workspace = await recordAgentRunWorkspace({
        owner: input.owner,
        agentId: agent.id,
        runId,
        prompt,
        output: activity.output,
        status: "failed",
        metadata: { error: activity.error, toolsUsed: activity.toolsUsed },
        extraArtifacts: runArtifacts,
      });
      activity.workspaceId = workspace.id;
    } catch (workspaceError) {
      logger.warn("agent-runtime", "Could not persist failed-run workspace", workspaceError);
    }
    await recordActivity(input.owner, activity);
    await recordOperationSafe(input.owner, {
      kind: "agent",
      operation: input.dryRun ? "dry-run" : "run",
      status: "failed",
      subjectId: agent.id,
      actor: agent.id,
      provider: activity.provider,
      model: activity.model,
      durationMs: activity.durationMs,
      detail: message,
    });
    throw error;
  }
  const toolsUsed = [...new Set(
    result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName)),
  )];
  const usage = {
    inputTokens: result.totalUsage.inputTokens ?? 0,
    outputTokens: result.totalUsage.outputTokens ?? 0,
    totalTokens: result.totalUsage.totalTokens ?? 0,
  };
  const estimatedCost = estimatedCostUsd(usage);
  const activity: AgentActivity = {
    id: runId,
    agentId: agent.id,
    trigger: input.trigger,
    prompt,
    output: result.text || "Run completed without a text summary.",
    ...(input.sourceSlug ? { sourceSlug: input.sourceSlug } : {}),
    toolsUsed,
    mode: input.dryRun ? "dry-run" : "execute",
    status: interactionIds.length > 0 || sandboxApprovalIds.length > 0 ? "awaiting-input" : "completed",
    retrievedSlugs: [...retrievedSlugs],
    proposedTaskIds,
    proposedMemoryIds,
    expectedChanges,
    provider: agent.provider ?? "app-default",
    model: agent.model ?? "app-default",
    finishReason: result.finishReason,
    usage,
    ...(estimatedCost !== undefined ? { estimatedCostUsd: estimatedCost } : {}),
    durationMs: Date.now() - startedAt,
    interactionIds,
    sandboxApprovalIds,
    createdAt: new Date().toISOString(),
  };
  try {
    const workspace = await recordAgentRunWorkspace({
      owner: input.owner,
      agentId: agent.id,
      runId,
      prompt,
      output: activity.output,
      status: activity.status ?? "completed",
      metadata: {
        toolsUsed,
        retrievedSlugs: [...retrievedSlugs],
        proposedTaskIds,
        proposedMemoryIds,
        interactionIds,
        sandboxApprovalIds,
        usage,
      },
      extraArtifacts: runArtifacts,
    });
    activity.workspaceId = workspace.id;
  } catch (workspaceError) {
    logger.warn("agent-runtime", "Could not persist agent workspace", workspaceError);
  }
  await recordActivity(input.owner, activity);
  await recordOperationSafe(input.owner, {
    kind: "agent",
    operation: input.dryRun ? "dry-run" : "run",
    status: "succeeded",
    subjectId: agent.id,
    actor: agent.id,
    provider: activity.provider,
    model: activity.model,
    inputTokens: activity.usage?.inputTokens,
    outputTokens: activity.usage?.outputTokens,
    estimatedCostUsd: activity.estimatedCostUsd,
    durationMs: activity.durationMs,
    detail: `${proposedTaskIds.length} task proposals; ${proposedMemoryIds.length} memory proposals`,
  });
  if (!input.dryRun) agent.lastRunAt = activity.createdAt;
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
