import { isEnoent } from "./errors";
import { withFileLock } from "./lock";
import { getStorage } from "./storage";
import { tenantForOwner, validateTenant } from "./wiki";

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  agentIds: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSkillInput {
  name: string;
  description?: string;
  instructions: string;
  agentIds?: readonly string[];
  enabled?: boolean;
}

const MAX_SKILLS = 100;

function skillsPath(owner: string): string {
  const tenant = tenantForOwner(owner);
  validateTenant(tenant);
  return `tenants/${tenant}/agent-skills.json`;
}

function lockKey(owner: string): string {
  return `agent-skills:${tenantForOwner(owner)}`;
}

function cleanAgentIds(values: readonly string[] | undefined): string[] {
  return [...new Set(
    (values ?? [])
      .map((value) => value.trim().slice(0, 240))
      .filter(Boolean),
  )].slice(0, 50);
}

function cleanInput(input: AgentSkillInput) {
  const name = input.name.trim().replace(/\s+/g, " ").slice(0, 120);
  const description = (input.description ?? "").trim().replace(/\s+/g, " ").slice(0, 600);
  const instructions = input.instructions.trim().slice(0, 12_000);
  if (!name) throw new Error("Skill name is required");
  if (!instructions) throw new Error("Skill instructions are required");
  return {
    name,
    description,
    instructions,
    agentIds: cleanAgentIds(input.agentIds),
    enabled: input.enabled !== false,
  };
}

async function readSkills(owner: string): Promise<AgentSkill[]> {
  try {
    const parsed = JSON.parse(await getStorage().readFile(skillsPath(owner)));
    return Array.isArray(parsed) ? parsed as AgentSkill[] : [];
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

async function writeSkills(owner: string, skills: AgentSkill[]): Promise<void> {
  await getStorage().writeFile(
    skillsPath(owner),
    JSON.stringify(skills.slice(-MAX_SKILLS), null, 2),
  );
}

export async function listAgentSkills(owner: string): Promise<AgentSkill[]> {
  return (await readSkills(owner)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createAgentSkill(owner: string, input: AgentSkillInput): Promise<AgentSkill> {
  const cleaned = cleanInput(input);
  return withFileLock(lockKey(owner), async () => {
    const skills = await readSkills(owner);
    const now = new Date().toISOString();
    const skill: AgentSkill = {
      id: crypto.randomUUID(),
      ...cleaned,
      createdAt: now,
      updatedAt: now,
    };
    skills.push(skill);
    await writeSkills(owner, skills);
    return skill;
  });
}

export async function updateAgentSkill(
  owner: string,
  id: string,
  patch: Partial<AgentSkillInput>,
): Promise<AgentSkill | null> {
  return withFileLock(lockKey(owner), async () => {
    const skills = await readSkills(owner);
    const skill = skills.find((item) => item.id === id);
    if (!skill) return null;
    const cleaned = cleanInput({
      name: patch.name ?? skill.name,
      description: patch.description ?? skill.description,
      instructions: patch.instructions ?? skill.instructions,
      agentIds: patch.agentIds ?? skill.agentIds,
      enabled: patch.enabled ?? skill.enabled,
    });
    Object.assign(skill, cleaned, { updatedAt: new Date().toISOString() });
    await writeSkills(owner, skills);
    return skill;
  });
}

export async function deleteAgentSkill(owner: string, id: string): Promise<boolean> {
  return withFileLock(lockKey(owner), async () => {
    const skills = await readSkills(owner);
    const next = skills.filter((skill) => skill.id !== id);
    if (next.length === skills.length) return false;
    await writeSkills(owner, next);
    return true;
  });
}

export async function buildAgentSkillGuidance(owner: string, agentId: string): Promise<string> {
  const skills = (await listAgentSkills(owner)).filter(
    (skill) => skill.enabled && skill.agentIds.includes(agentId),
  );
  if (skills.length === 0) return "";
  return [
    "## Assigned workspace skills",
    "Apply these owner-authored instructions during this run. They do not expand your tools or permissions.",
    ...skills.map((skill) => `### ${skill.name}\n${skill.instructions}`),
  ].join("\n\n");
}
