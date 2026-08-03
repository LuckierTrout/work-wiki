import { isEnoent } from "./errors";
import { withFileLock } from "./lock";
import { getStorage } from "./storage";
import { tenantForOwner, validateTenant } from "./wiki";

export type ActionItemStatus =
  | "inbox"
  | "accepted"
  | "dismissed"
  | "done";
export type ActionItemPriority = "low" | "medium" | "high";

export interface ActionItem {
  id: string;
  title: string;
  details?: string;
  assignee?: string;
  dueDate?: string;
  priority: ActionItemPriority;
  sourceSlug?: string;
  sourceExcerpt?: string;
  confidence?: number;
  status: ActionItemStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ActionItemProposal {
  title: string;
  details?: string;
  assignee?: string;
  dueDate?: string;
  priority?: ActionItemPriority;
  sourceSlug?: string;
  sourceExcerpt?: string;
  confidence?: number;
}

const MAX_ACTION_ITEMS = 1_000;

function actionItemsPath(owner: string): string {
  const tenant = tenantForOwner(owner);
  validateTenant(tenant);
  return `tenants/${tenant}/action-items.json`;
}

function lockKey(owner: string): string {
  return `action-items:${tenantForOwner(owner)}`;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function dedupeKey(item: Pick<ActionItemProposal, "title" | "sourceSlug">): string {
  return `${normalize(item.title)}::${normalize(item.sourceSlug ?? "")}`;
}

async function readItems(owner: string): Promise<ActionItem[]> {
  try {
    const parsed = JSON.parse(await getStorage().readFile(actionItemsPath(owner)));
    return Array.isArray(parsed) ? (parsed as ActionItem[]) : [];
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

async function writeItems(owner: string, items: ActionItem[]): Promise<void> {
  await getStorage().writeFile(
    actionItemsPath(owner),
    JSON.stringify(items.slice(-MAX_ACTION_ITEMS), null, 2),
  );
}

export async function listActionItems(
  owner: string,
  status?: ActionItemStatus,
): Promise<ActionItem[]> {
  const items = await readItems(owner);
  return items
    .filter((item) => !status || item.status === status)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function proposeActionItems(
  owner: string,
  proposals: readonly ActionItemProposal[],
): Promise<ActionItem[]> {
  const clean = proposals.filter(
    (proposal) => typeof proposal.title === "string" && proposal.title.trim(),
  );
  if (clean.length === 0) return [];

  return withFileLock(lockKey(owner), async () => {
    const items = await readItems(owner);
    const existing = new Set(items.map(dedupeKey));
    const created: ActionItem[] = [];

    for (const proposal of clean) {
      const key = dedupeKey(proposal);
      if (existing.has(key)) continue;
      existing.add(key);
      const now = new Date().toISOString();
      const item: ActionItem = {
        id: crypto.randomUUID(),
        title: proposal.title.trim().slice(0, 240),
        ...(proposal.details?.trim()
          ? { details: proposal.details.trim().slice(0, 2_000) }
          : {}),
        ...(proposal.assignee?.trim()
          ? { assignee: proposal.assignee.trim().slice(0, 160) }
          : {}),
        ...(proposal.dueDate?.trim() ? { dueDate: proposal.dueDate.trim() } : {}),
        priority: proposal.priority ?? "medium",
        ...(proposal.sourceSlug ? { sourceSlug: proposal.sourceSlug } : {}),
        ...(proposal.sourceExcerpt?.trim()
          ? { sourceExcerpt: proposal.sourceExcerpt.trim().slice(0, 800) }
          : {}),
        ...(typeof proposal.confidence === "number"
          ? { confidence: Math.max(0, Math.min(1, proposal.confidence)) }
          : {}),
        status: "inbox",
        createdAt: now,
        updatedAt: now,
      };
      items.push(item);
      created.push(item);
    }

    if (created.length > 0) await writeItems(owner, items);
    return created;
  });
}

export async function updateActionItem(
  owner: string,
  id: string,
  patch: Partial<
    Pick<
      ActionItem,
      "title" | "details" | "assignee" | "dueDate" | "priority" | "status"
    >
  >,
): Promise<ActionItem | null> {
  return withFileLock(lockKey(owner), async () => {
    const items = await readItems(owner);
    const item = items.find((candidate) => candidate.id === id);
    if (!item) return null;

    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (!title) throw new Error("Action item title cannot be empty");
      item.title = title.slice(0, 240);
    }
    if (patch.details !== undefined) {
      if (patch.details.trim()) item.details = patch.details.trim().slice(0, 2_000);
      else delete item.details;
    }
    if (patch.assignee !== undefined) {
      if (patch.assignee.trim()) item.assignee = patch.assignee.trim().slice(0, 160);
      else delete item.assignee;
    }
    if (patch.dueDate !== undefined) {
      if (patch.dueDate.trim()) item.dueDate = patch.dueDate.trim();
      else delete item.dueDate;
    }
    if (patch.priority !== undefined) item.priority = patch.priority;
    if (patch.status !== undefined) {
      item.status = patch.status;
      if (patch.status === "done") item.completedAt = new Date().toISOString();
      else delete item.completedAt;
    }
    item.updatedAt = new Date().toISOString();
    await writeItems(owner, items);
    return item;
  });
}

export async function deleteActionItem(
  owner: string,
  id: string,
): Promise<boolean> {
  return withFileLock(lockKey(owner), async () => {
    const items = await readItems(owner);
    const filtered = items.filter((item) => item.id !== id);
    if (filtered.length === items.length) return false;
    await writeItems(owner, filtered);
    return true;
  });
}
