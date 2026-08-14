import { contentHash } from "./embeddings";
import { isEnoent } from "./errors";
import { withFileLock } from "./lock";
import { getStorage } from "./storage";
import { tenantForOwner, validateTenant } from "./wiki";

export interface AgentArtifact {
  id: string;
  filename: string;
  mediaType: string;
  size: number;
  sha256: string;
  createdAt: string;
}

export interface AgentRunWorkspace {
  id: string;
  owner: string;
  agentId: string;
  runId: string;
  prompt: string;
  status: "completed" | "failed" | "awaiting-input";
  artifacts: AgentArtifact[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentInteractionField {
  id: string;
  label: string;
  type: "text" | "textarea" | "number" | "date" | "select" | "checkbox";
  required?: boolean;
  options?: string[];
  help?: string;
}

export interface AgentInteractionRequest {
  id: string;
  owner: string;
  agentId: string;
  runId: string;
  title: string;
  description: string;
  fields: AgentInteractionField[];
  status: "pending" | "submitted" | "cancelled";
  values?: Record<string, string | number | boolean>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSandboxApproval {
  id: string;
  owner: string;
  agentId: string;
  runId: string;
  purpose: string;
  command: string;
  files: Array<{ filename: string; size: number }>;
  outputFiles: string[];
  timeoutMs: number;
  status: "pending" | "executing" | "completed" | "failed" | "rejected";
  result?: {
    exitCode?: number;
    stdout: string;
    stderr: string;
    artifacts: string[];
    durationMs: number;
  };
  createdAt: string;
  updatedAt: string;
}

function tenant(owner: string): string {
  const value = tenantForOwner(owner);
  validateTenant(value);
  return value;
}

function cleanId(value: string, label: string): string {
  const cleaned = value.trim();
  if (!/^[a-z0-9_-]{4,180}$/i.test(cleaned)) throw new Error(`Invalid ${label}`);
  return cleaned;
}

function workspaceIndexPath(owner: string): string {
  return `tenants/${tenant(owner)}/agent-workspaces.json`;
}

function workspaceRoot(owner: string, agentId: string, runId: string): string {
  return `tenants/${tenant(owner)}/agent-workspaces/${cleanId(agentId, "agent id")}/${cleanId(runId, "run id")}`;
}

function interactionsPath(owner: string): string {
  return `tenants/${tenant(owner)}/agent-interactions.json`;
}

function sandboxApprovalsPath(owner: string): string {
  return `tenants/${tenant(owner)}/agent-sandbox-approvals.json`;
}

function sandboxApprovalPayloadPath(owner: string, id: string): string {
  return `tenants/${tenant(owner)}/agent-sandbox-approvals/${cleanId(id, "approval id")}.json`;
}

async function readJsonArray<T>(path: string): Promise<T[]> {
  try {
    const parsed = JSON.parse(await getStorage().readFile(path));
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

async function sha256(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function recordAgentRunWorkspace(input: {
  owner: string;
  agentId: string;
  runId: string;
  prompt: string;
  output: string;
  status: AgentRunWorkspace["status"];
  metadata?: Record<string, unknown>;
  extraArtifacts?: Array<{ filename: string; content: string; mediaType?: string }>;
}): Promise<AgentRunWorkspace> {
  const root = workspaceRoot(input.owner, input.agentId, input.runId);
  const now = new Date().toISOString();
  const safeExtra = (input.extraArtifacts ?? []).slice(0, 20).map((artifact, index) => ({
    filename: artifact.filename.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120) || `artifact-${index + 1}.txt`,
    mediaType: artifact.mediaType?.trim().slice(0, 120) || "text/plain",
    content: artifact.content.slice(0, 500_000),
  }));
  const files = [
    { filename: "response.md", mediaType: "text/markdown", content: input.output },
    {
      filename: "run.json",
      mediaType: "application/json",
      content: JSON.stringify({
        runId: input.runId,
        agentId: input.agentId,
        prompt: input.prompt,
        status: input.status,
        ...input.metadata,
      }, null, 2),
    },
    ...safeExtra,
  ];
  const artifacts: AgentArtifact[] = [];
  for (const file of files) {
    await getStorage().writeFile(`${root}/artifacts/${file.filename}`, file.content);
    artifacts.push({
      id: `art_${contentHash(`${input.runId}:${file.filename}`)}`,
      filename: file.filename,
      mediaType: file.mediaType,
      size: new TextEncoder().encode(file.content).byteLength,
      sha256: await sha256(file.content),
      createdAt: now,
    });
  }
  const workspace: AgentRunWorkspace = {
    id: `aws_${contentHash(`${input.agentId}:${input.runId}`)}`,
    owner: input.owner,
    agentId: input.agentId,
    runId: input.runId,
    prompt: input.prompt.slice(0, 4_000),
    status: input.status,
    artifacts,
    createdAt: now,
    updatedAt: now,
  };
  await getStorage().writeFile(`${root}/manifest.json`, JSON.stringify(workspace, null, 2));
  await withFileLock(`agent-workspaces:${tenant(input.owner)}`, async () => {
    const current = await readJsonArray<AgentRunWorkspace>(workspaceIndexPath(input.owner));
    const next = current.filter((item) => item.id !== workspace.id);
    next.push(workspace);
    await getStorage().writeFile(workspaceIndexPath(input.owner), JSON.stringify(next.slice(-500), null, 2));
  });
  return workspace;
}

export async function listAgentRunWorkspaces(
  owner: string,
  agentId?: string,
): Promise<AgentRunWorkspace[]> {
  return (await readJsonArray<AgentRunWorkspace>(workspaceIndexPath(owner)))
    .filter((workspace) => !agentId || workspace.agentId === agentId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function readAgentArtifact(
  owner: string,
  workspaceId: string,
  artifactId: string,
): Promise<{ artifact: AgentArtifact; content: string } | null> {
  const workspace = (await listAgentRunWorkspaces(owner)).find((item) => item.id === workspaceId);
  const artifact = workspace?.artifacts.find((item) => item.id === artifactId);
  if (!workspace || !artifact) return null;
  const content = await getStorage().readFile(
    `${workspaceRoot(owner, workspace.agentId, workspace.runId)}/artifacts/${artifact.filename}`,
  );
  return { artifact, content };
}

export async function deleteAgentRunWorkspace(owner: string, workspaceId: string): Promise<boolean> {
  return withFileLock(`agent-workspaces:${tenant(owner)}`, async () => {
    const current = await readJsonArray<AgentRunWorkspace>(workspaceIndexPath(owner));
    const workspace = current.find((item) => item.id === workspaceId);
    if (!workspace) return false;
    const root = workspaceRoot(owner, workspace.agentId, workspace.runId);
    await Promise.all([
      ...workspace.artifacts.map((artifact) =>
        getStorage().deleteFile(`${root}/artifacts/${artifact.filename}`).catch(() => undefined)),
      getStorage().deleteFile(`${root}/manifest.json`).catch(() => undefined),
    ]);
    await getStorage().writeFile(
      workspaceIndexPath(owner),
      JSON.stringify(current.filter((item) => item.id !== workspaceId), null, 2),
    );
    return true;
  });
}

export async function createAgentInteraction(input: {
  owner: string;
  agentId: string;
  runId: string;
  title: string;
  description?: string;
  fields: AgentInteractionField[];
}): Promise<AgentInteractionRequest> {
  if (input.fields.length === 0 || input.fields.length > 20) throw new Error("Interaction requires 1-20 fields");
  const now = new Date().toISOString();
  const seen = new Set<string>();
  const fields = input.fields.map((field) => {
    const id = cleanId(field.id, "field id").slice(0, 80);
    if (seen.has(id)) throw new Error("Interaction field ids must be unique");
    seen.add(id);
    const options = field.type === "select"
      ? (field.options ?? []).map((value) => value.trim().slice(0, 160)).filter(Boolean).slice(0, 30)
      : undefined;
    if (field.type === "select" && !options?.length) throw new Error("Select fields require options");
    return {
      id,
      label: field.label.trim().slice(0, 160) || id,
      type: field.type,
      ...(field.required ? { required: true } : {}),
      ...(options ? { options } : {}),
      ...(field.help?.trim() ? { help: field.help.trim().slice(0, 500) } : {}),
    };
  });
  const request: AgentInteractionRequest = {
    id: `air_${crypto.randomUUID()}`,
    owner: input.owner,
    agentId: cleanId(input.agentId, "agent id"),
    runId: cleanId(input.runId, "run id"),
    title: input.title.trim().slice(0, 240) || "Input required",
    description: input.description?.trim().slice(0, 1_000) || "",
    fields,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  await withFileLock(`agent-interactions:${tenant(input.owner)}`, async () => {
    const entries = await readJsonArray<AgentInteractionRequest>(interactionsPath(input.owner));
    entries.push(request);
    await getStorage().writeFile(interactionsPath(input.owner), JSON.stringify(entries.slice(-500), null, 2));
  });
  return request;
}

export async function listAgentInteractions(
  owner: string,
  status?: AgentInteractionRequest["status"],
): Promise<AgentInteractionRequest[]> {
  return (await readJsonArray<AgentInteractionRequest>(interactionsPath(owner)))
    .filter((request) => !status || request.status === status)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function submitAgentInteraction(
  owner: string,
  id: string,
  values: Record<string, string | number | boolean>,
): Promise<AgentInteractionRequest | null> {
  return withFileLock(`agent-interactions:${tenant(owner)}`, async () => {
    const entries = await readJsonArray<AgentInteractionRequest>(interactionsPath(owner));
    const request = entries.find((item) => item.id === id);
    if (!request || request.status !== "pending") return null;
    const allowed = new Map(request.fields.map((field) => [field.id, field]));
    const cleaned: Record<string, string | number | boolean> = {};
    for (const [fieldId, value] of Object.entries(values)) {
      const field = allowed.get(fieldId);
      if (!field) continue;
      if (field.type === "checkbox" && typeof value === "boolean") cleaned[fieldId] = value;
      else if (field.type === "number" && typeof value === "number" && Number.isFinite(value)) cleaned[fieldId] = value;
      else if (typeof value === "string") {
        const text = value.trim().slice(0, 4_000);
        if (field.type === "select" && !field.options?.includes(text)) throw new Error(`Invalid option for ${field.label}`);
        cleaned[fieldId] = text;
      }
    }
    for (const field of request.fields) {
      if (field.required && (cleaned[field.id] === undefined || cleaned[field.id] === "")) {
        throw new Error(`${field.label} is required`);
      }
    }
    request.values = cleaned;
    request.status = "submitted";
    request.updatedAt = new Date().toISOString();
    await getStorage().writeFile(interactionsPath(owner), JSON.stringify(entries, null, 2));
    return request;
  });
}

function safeArtifactName(filename: string, fallback: string): string {
  return filename.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120) || fallback;
}

export async function createAgentSandboxApproval(input: {
  owner: string;
  agentId: string;
  runId: string;
  purpose?: string;
  command: string;
  files?: Record<string, string>;
  outputFiles?: string[];
  timeoutMs?: number;
}): Promise<AgentSandboxApproval> {
  const id = `asa_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const fileContents = Object.fromEntries(
    Object.entries(input.files ?? {}).slice(0, 20).map(([filename, content], index) => [
      safeArtifactName(filename, `input-${index + 1}.txt`),
      content.slice(0, 200_000),
    ]),
  );
  const approval: AgentSandboxApproval = {
    id,
    owner: input.owner,
    agentId: cleanId(input.agentId, "agent id"),
    runId: cleanId(input.runId, "run id"),
    purpose: input.purpose?.trim().slice(0, 500) || "Run a bounded command for this agent task.",
    command: input.command.trim().slice(0, 4_000),
    files: Object.entries(fileContents).map(([filename, content]) => ({
      filename,
      size: new TextEncoder().encode(content).byteLength,
    })),
    outputFiles: (input.outputFiles ?? []).slice(0, 20).map((filename, index) =>
      safeArtifactName(filename, `output-${index + 1}.txt`)),
    timeoutMs: Math.max(1_000, Math.min(120_000, input.timeoutMs ?? 30_000)),
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  await getStorage().writeFile(
    sandboxApprovalPayloadPath(input.owner, id),
    JSON.stringify({ files: fileContents }),
  );
  await withFileLock(`agent-sandbox-approvals:${tenant(input.owner)}`, async () => {
    const entries = await readJsonArray<AgentSandboxApproval>(sandboxApprovalsPath(input.owner));
    entries.push(approval);
    await getStorage().writeFile(sandboxApprovalsPath(input.owner), JSON.stringify(entries.slice(-500), null, 2));
  });
  return approval;
}

export async function listAgentSandboxApprovals(
  owner: string,
  status?: AgentSandboxApproval["status"],
): Promise<AgentSandboxApproval[]> {
  return (await readJsonArray<AgentSandboxApproval>(sandboxApprovalsPath(owner)))
    .filter((approval) => !status || approval.status === status)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function claimAgentSandboxApproval(
  owner: string,
  id: string,
): Promise<{ approval: AgentSandboxApproval; files: Record<string, string> } | null> {
  return withFileLock(`agent-sandbox-approvals:${tenant(owner)}`, async () => {
    const entries = await readJsonArray<AgentSandboxApproval>(sandboxApprovalsPath(owner));
    const approval = entries.find((item) => item.id === id);
    if (!approval || approval.status !== "pending") return null;
    const payload = JSON.parse(await getStorage().readFile(sandboxApprovalPayloadPath(owner, id))) as {
      files?: Record<string, unknown>;
    };
    const files = Object.fromEntries(
      Object.entries(payload.files ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
    approval.status = "executing";
    approval.updatedAt = new Date().toISOString();
    await getStorage().writeFile(sandboxApprovalsPath(owner), JSON.stringify(entries, null, 2));
    return { approval, files };
  });
}

export async function finishAgentSandboxApproval(input: {
  owner: string;
  id: string;
  status: "completed" | "failed";
  result: NonNullable<AgentSandboxApproval["result"]>;
}): Promise<AgentSandboxApproval | null> {
  return withFileLock(`agent-sandbox-approvals:${tenant(input.owner)}`, async () => {
    const entries = await readJsonArray<AgentSandboxApproval>(sandboxApprovalsPath(input.owner));
    const approval = entries.find((item) => item.id === input.id);
    if (!approval || approval.status !== "executing") return null;
    approval.status = input.status;
    approval.result = input.result;
    approval.updatedAt = new Date().toISOString();
    await getStorage().writeFile(sandboxApprovalsPath(input.owner), JSON.stringify(entries, null, 2));
    await getStorage().deleteFile(sandboxApprovalPayloadPath(input.owner, input.id)).catch(() => undefined);
    return approval;
  });
}

export async function rejectAgentSandboxApproval(
  owner: string,
  id: string,
): Promise<AgentSandboxApproval | null> {
  return withFileLock(`agent-sandbox-approvals:${tenant(owner)}`, async () => {
    const entries = await readJsonArray<AgentSandboxApproval>(sandboxApprovalsPath(owner));
    const approval = entries.find((item) => item.id === id);
    if (!approval || approval.status !== "pending") return null;
    approval.status = "rejected";
    approval.updatedAt = new Date().toISOString();
    await getStorage().writeFile(sandboxApprovalsPath(owner), JSON.stringify(entries, null, 2));
    await getStorage().deleteFile(sandboxApprovalPayloadPath(owner, id)).catch(() => undefined);
    return approval;
  });
}

export async function appendAgentRunArtifacts(input: {
  owner: string;
  agentId: string;
  runId: string;
  artifacts: Array<{ filename: string; content: string; mediaType?: string }>;
}): Promise<AgentRunWorkspace | null> {
  return withFileLock(`agent-workspaces:${tenant(input.owner)}`, async () => {
    const current = await readJsonArray<AgentRunWorkspace>(workspaceIndexPath(input.owner));
    const workspace = current.find((item) => item.agentId === input.agentId && item.runId === input.runId);
    if (!workspace) return null;
    const root = workspaceRoot(input.owner, input.agentId, input.runId);
    const existing = new Set(workspace.artifacts.map((artifact) => artifact.filename));
    for (const [index, candidate] of input.artifacts.slice(0, 20).entries()) {
      const base = safeArtifactName(candidate.filename, `sandbox-artifact-${index + 1}.txt`);
      let filename = base;
      let suffix = 2;
      while (existing.has(filename)) {
        const dot = base.lastIndexOf(".");
        filename = dot > 0 ? `${base.slice(0, dot)}-${suffix}${base.slice(dot)}` : `${base}-${suffix}`;
        suffix += 1;
      }
      existing.add(filename);
      const content = candidate.content.slice(0, 500_000);
      await getStorage().writeFile(`${root}/artifacts/${filename}`, content);
      workspace.artifacts.push({
        id: `art_${contentHash(`${input.runId}:${filename}`)}`,
        filename,
        mediaType: candidate.mediaType?.trim().slice(0, 120) || "text/plain",
        size: new TextEncoder().encode(content).byteLength,
        sha256: await sha256(content),
        createdAt: new Date().toISOString(),
      });
    }
    workspace.updatedAt = new Date().toISOString();
    await getStorage().writeFile(`${root}/manifest.json`, JSON.stringify(workspace, null, 2));
    await getStorage().writeFile(workspaceIndexPath(input.owner), JSON.stringify(current, null, 2));
    return workspace;
  });
}
