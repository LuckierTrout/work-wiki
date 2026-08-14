import { isEnoent } from "./errors";
import { withFileLock } from "./lock";
import { getStorage } from "./storage";
import { tenantForOwner, validateTenant } from "./wiki";

export interface LocalSyncClient {
  id: string;
  owner: string;
  label: string;
  mode: "archive" | "sources";
  operation: string;
  state: "ok" | "watching" | "failed";
  itemCount?: number;
  message?: string;
  createdAt: string;
  lastSeenAt: string;
}

function tenant(owner: string): string {
  const value = tenantForOwner(owner);
  validateTenant(value);
  return value;
}

function clientsPath(owner: string): string {
  return `tenants/${tenant(owner)}/local-sync-clients.json`;
}

function cleanId(value: string): string {
  const id = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
  if (id.length < 2) throw new Error("Sync client id must contain at least two letters or numbers.");
  return id;
}

async function readClients(owner: string): Promise<LocalSyncClient[]> {
  try {
    const parsed = JSON.parse(await getStorage().readFile(clientsPath(owner)));
    return Array.isArray(parsed) ? parsed as LocalSyncClient[] : [];
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

export async function listLocalSyncClients(owner: string): Promise<LocalSyncClient[]> {
  return (await readClients(owner)).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export async function recordLocalSyncHeartbeat(input: {
  owner: string;
  clientId: string;
  label?: string;
  mode: LocalSyncClient["mode"];
  operation: string;
  state: LocalSyncClient["state"];
  itemCount?: number;
  message?: string;
}): Promise<LocalSyncClient> {
  const id = cleanId(input.clientId);
  return withFileLock(`local-sync-clients:${tenant(input.owner)}`, async () => {
    const clients = await readClients(input.owner);
    const existing = clients.find((client) => client.id === id);
    const now = new Date().toISOString();
    const client: LocalSyncClient = {
      id,
      owner: input.owner,
      label: input.label?.trim().slice(0, 120) || existing?.label || id,
      mode: input.mode,
      operation: input.operation.trim().slice(0, 120) || "sync",
      state: input.state,
      ...(Number.isFinite(input.itemCount) ? { itemCount: Math.max(0, Math.floor(input.itemCount!)) } : {}),
      ...(input.message?.trim() ? { message: input.message.trim().slice(0, 500) } : {}),
      createdAt: existing?.createdAt ?? now,
      lastSeenAt: now,
    };
    const next = clients.filter((candidate) => candidate.id !== id);
    next.push(client);
    await getStorage().writeFile(clientsPath(input.owner), JSON.stringify(next.slice(-100), null, 2));
    return client;
  });
}

export async function removeLocalSyncClient(owner: string, id: string): Promise<boolean> {
  return withFileLock(`local-sync-clients:${tenant(owner)}`, async () => {
    const clients = await readClients(owner);
    const clean = cleanId(id);
    if (!clients.some((client) => client.id === clean)) return false;
    await getStorage().writeFile(
      clientsPath(owner),
      JSON.stringify(clients.filter((client) => client.id !== clean), null, 2),
    );
    return true;
  });
}
