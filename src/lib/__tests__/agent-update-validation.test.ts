import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("@/lib/auth", () => ({
  getPrincipal: async () => ({ id: "user_alice", handle: "alice" }),
}));

import { PUT } from "@/app/api/agents/[id]/route";
import { dispatchMcp } from "../mcp-http";
import { handleUpdateAgent } from "@/mcp";
import { agentIdFor, getAgent, registerAgent, updateAgent } from "../agents";
import type { UpdateAgentOptions } from "../agents";
import { _resetStorage, getStorage } from "../storage";
import { _resetLocks } from "../lock";
import { ensureDirectories, readWikiPage } from "../wiki";
import { ClientInputError } from "../errors";

let directory: string;
const id = agentIdFor("alice");
const page = (type: string, slug = `update-${type}`) => ({ slug, title: "Agent page", type, content: "Synthetic guidance." });
const initial = {
  id, owner: "alice", name: "Original", description: "Synthetic agent",
  identityPages: ["old-identity"], learningPages: [], socialPages: [],
  registered: "2026-09-09T00:00:00.000Z", lastUpdated: "2026-09-09T00:00:00.000Z",
};

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-update-validation-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.stubEnv("WIKI_DIR", path.join(directory, "wiki"));
  vi.stubEnv("RAW_DIR", path.join(directory, "raw"));
  vi.stubEnv("NEXT_PUBLIC_OWNER_HANDLE", "alice");
  vi.stubEnv("YOPEDIA_OWNER_USER_ID", "user_alice");
  vi.stubEnv("YOPEDIA_READONLY", "");
  _resetStorage(); _resetLocks();
  await ensureDirectories();
  await registerAgent(structuredClone(initial));
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); _resetStorage(); _resetLocks();
  await fs.rm(directory, { recursive: true, force: true });
});

async function invoke(door: string, options: Record<string, unknown>) {
  if (door === "REST") {
    const response = await PUT(new Request(`http://localhost/api/agents/${id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(options),
    }), { params: Promise.resolve({ id }) });
    return { status: response.status, body: await response.json() };
  }
  if (door === "HTTP MCP") {
    const response = await dispatchMcp({ id: 1, method: "tools/call", params: {
      name: "update_agent", arguments: options,
    } }, { id: "user_alice", handle: "alice" });
    return response?.result;
  }
  return handleUpdateAgent({ agent_id: id, ...options } as Parameters<typeof handleUpdateAgent>[0]);
}

describe("agent update validation through real kernel and storage", () => {
  it.each(["REST", "HTTP MCP", "shared MCP handler"])("%s rejects a later invalid type before any earlier page or profile write", async (door) => {
    const write = vi.spyOn(getStorage(), "writeFile");
    const options = { name: "Must not land", removePages: ["old-identity"], addPages: [page("identity"), page("bogus")] };
    const message = "Page at index 1 has invalid 'type' — must be one of: identity, learnings, social";
    if (door === "shared MCP handler") {
      await expect(invoke(door, options)).rejects.toThrow(ClientInputError);
    } else if (door === "REST") {
      expect(await invoke(door, options)).toEqual({ status: 400, body: { error: message } });
    } else {
      expect(await invoke(door, options)).toMatchObject({ isError: true, content: [{ type: "text", text: `Error: ${message}` }] });
    }
    expect(write).not.toHaveBeenCalled();
    expect(await getAgent(id)).toEqual(initial);
    expect(await readWikiPage("update-identity")).toBeNull();
    expect(await readWikiPage("update-bogus")).toBeNull();
  });

  it.each([null, {}, "identity", [null], [{}], [page("IDENTITY")], [page("")]])("rejects malformed addPages without writes: %j", async (addPages) => {
    const write = vi.spyOn(getStorage(), "writeFile");
    await expect(updateAgent(id, { addPages } as unknown as UpdateAgentOptions)).rejects.toThrow(ClientInputError);
    expect(write).not.toHaveBeenCalled();
    expect(await getAgent(id)).toEqual(initial);
  });

  it.each(["REST", "HTTP MCP"])("%s still writes all three valid types to their proper lists", async (door) => {
    const response = await invoke(door, { addPages: [page("identity"), page("learnings"), page("social")] });
    if (door === "REST") expect(response).toMatchObject({ status: 200 });
    else expect(response).not.toHaveProperty("isError");
    expect(await getAgent(id)).toMatchObject({
      identityPages: ["old-identity", "update-identity"], learningPages: ["update-learnings"], socialPages: ["update-social"],
    });
    for (const type of ["identity", "learnings", "social"]) expect((await readWikiPage(`update-${type}`))?.content).toContain("Synthetic guidance.");
  });

  it("preserves empty batches and missing-agent lookup behavior", async () => {
    expect(await updateAgent("missing", { addPages: [page("bogus")] } as UpdateAgentOptions)).toBeNull();
    expect(await updateAgent(id, { addPages: [] })).toMatchObject({ identityPages: ["old-identity"] });
  });
});
