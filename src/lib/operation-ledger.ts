import { isEnoent } from "./errors";
import { withFileLock } from "./lock";
import { getStorage } from "./storage";
import { tenantForOwner, validateTenant } from "./wiki";

export type OperationKind =
  | "ingest"
  | "review"
  | "monitor"
  | "agent"
  | "integration"
  | "backup"
  | "evaluation";
export type OperationStatus = "started" | "succeeded" | "failed";

export interface OperationRecord {
  id: string;
  owner: string;
  kind: OperationKind;
  operation: string;
  status: OperationStatus;
  subjectId?: string;
  actor?: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  durationMs?: number;
  detail?: string;
  createdAt: string;
}

const MAX_OPERATIONS = 2_000;

function ledgerPath(owner: string): string {
  const tenant = tenantForOwner(owner);
  validateTenant(tenant);
  return `tenants/${tenant}/operation-ledger.json`;
}

function lockKey(owner: string): string {
  return `operation-ledger:${tenantForOwner(owner)}`;
}

async function readLedger(owner: string): Promise<OperationRecord[]> {
  try {
    const parsed = JSON.parse(await getStorage().readFile(ledgerPath(owner)));
    return Array.isArray(parsed) ? parsed as OperationRecord[] : [];
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

export async function recordOperation(
  owner: string,
  input: Omit<OperationRecord, "id" | "owner" | "createdAt"> & { id?: string; createdAt?: string },
): Promise<OperationRecord> {
  return withFileLock(lockKey(owner), async () => {
    const entries = await readLedger(owner);
    const record: OperationRecord = {
      id: input.id ?? crypto.randomUUID(),
      owner,
      kind: input.kind,
      operation: input.operation.slice(0, 160),
      status: input.status,
      ...(input.subjectId ? { subjectId: input.subjectId.slice(0, 240) } : {}),
      ...(input.actor ? { actor: input.actor.slice(0, 160) } : {}),
      ...(input.provider ? { provider: input.provider.slice(0, 80) } : {}),
      ...(input.model ? { model: input.model.slice(0, 240) } : {}),
      ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
      ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
      ...(input.estimatedCostUsd !== undefined ? { estimatedCostUsd: input.estimatedCostUsd } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.detail ? { detail: input.detail.slice(0, 2_000) } : {}),
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    entries.push(record);
    await getStorage().writeFile(
      ledgerPath(owner),
      JSON.stringify(entries.slice(-MAX_OPERATIONS), null, 2),
    );
    return record;
  });
}

export async function listOperations(
  owner: string,
  limit = 100,
): Promise<OperationRecord[]> {
  return (await readLedger(owner))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, Math.min(limit, 500)));
}

/** Record a secondary audit receipt without making the primary operation fail. */
export async function recordOperationSafe(
  owner: string,
  input: Omit<OperationRecord, "id" | "owner" | "createdAt"> & { id?: string; createdAt?: string },
): Promise<OperationRecord | null> {
  try {
    return await recordOperation(owner, input);
  } catch {
    return null;
  }
}
