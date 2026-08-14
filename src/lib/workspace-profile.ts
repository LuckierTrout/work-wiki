import { isEnoent } from "./errors";
import { withFileLock } from "./lock";
import { getStorage } from "./storage";
import { tenantForOwner, validateTenant } from "./wiki";
import {
  EMPTY_WORKSPACE_PROFILE,
  parseWorkspaceProfileInput,
  workspaceProfileHasGuidance,
  type WorkspaceProfileInput,
} from "./workspace-profile-schema";

export interface WorkspaceProfile extends WorkspaceProfileInput {
  version: 1;
  createdAt: string | null;
  updatedAt: string | null;
}

const MAX_PROMPT_CHARS = 20_000;

function tenant(owner: string): string {
  const value = tenantForOwner(owner);
  validateTenant(value);
  return value;
}

function profilePath(owner: string): string {
  return `tenants/${tenant(owner)}/workspace-profile.json`;
}

function lockKey(owner: string): string {
  return `workspace-profile:${tenant(owner)}`;
}

export function emptyWorkspaceProfile(): WorkspaceProfile {
  return {
    version: 1,
    ...EMPTY_WORKSPACE_PROFILE,
    keyQuestions: [],
    inScope: [],
    outOfScope: [],
    createdAt: null,
    updatedAt: null,
  };
}

export async function getWorkspaceProfile(owner: string): Promise<WorkspaceProfile> {
  try {
    const parsed = JSON.parse(await getStorage().readFile(profilePath(owner))) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return emptyWorkspaceProfile();
    }
    const record = parsed as Record<string, unknown>;
    const cleaned = parseWorkspaceProfileInput(record);
    return {
      version: 1,
      ...cleaned,
      createdAt: typeof record.createdAt === "string" ? record.createdAt : null,
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
    };
  } catch (error) {
    if (isEnoent(error)) return emptyWorkspaceProfile();
    throw error;
  }
}

export async function saveWorkspaceProfile(
  owner: string,
  input: WorkspaceProfileInput,
): Promise<WorkspaceProfile> {
  const cleaned = parseWorkspaceProfileInput(input);
  return withFileLock(lockKey(owner), async () => {
    const existing = await getWorkspaceProfile(owner);
    const now = new Date().toISOString();
    const profile: WorkspaceProfile = {
      version: 1,
      ...cleaned,
      createdAt: existing.createdAt ?? now,
      updatedAt: now,
    };
    await getStorage().writeFile(profilePath(owner), JSON.stringify(profile, null, 2));
    return profile;
  });
}

export function renderWorkspaceGuidance(profile: WorkspaceProfileInput): string {
  if (!workspaceProfileHasGuidance(profile)) return "";
  const lines = [
    "WORKSPACE PURPOSE",
    "Use this owner-authored profile to decide what matters, how to organize generated knowledge, and what to leave out. It guides prioritization but never overrides source evidence, privacy rules, or required citations. Do not alter quotations or claim the source said something merely because the profile asks about it.",
    profile.purpose ? `Purpose:\n${profile.purpose}` : "",
    profile.keyQuestions.length
      ? `Key questions:\n${profile.keyQuestions.map((item) => `- ${item}`).join("\n")}`
      : "",
    profile.inScope.length
      ? `In scope:\n${profile.inScope.map((item) => `- ${item}`).join("\n")}`
      : "",
    profile.outOfScope.length
      ? `Out of scope:\n${profile.outOfScope.map((item) => `- ${item}`).join("\n")}`
      : "",
    profile.outputLanguage ? `Preferred output language: ${profile.outputLanguage}` : "",
    profile.pageConventions ? `Page conventions:\n${profile.pageConventions}` : "",
  ].filter(Boolean);
  return lines.join("\n\n").slice(0, MAX_PROMPT_CHARS);
}

export async function buildWorkspaceGuidance(owner: string): Promise<string> {
  return renderWorkspaceGuidance(await getWorkspaceProfile(owner));
}
