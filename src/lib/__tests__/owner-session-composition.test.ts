import React from "react";
/** Route → real kernel → local filesystem, with two deliberately distinct tenants. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const auth = vi.hoisted(() => ({ principal: null as { id: string; handle: string } | null }));
vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn(async () => auth.principal), getServicePrincipal: vi.fn(() => null) }));
vi.mock("@/components/WikiWorkbench", () => ({ WikiWorkbench: "wiki-workbench" }));
vi.mock("@/components/workbench/Workbench", () => ({ Workbench: "workbench" }));
vi.mock("@/components/workbench/WorkbenchData", () => ({ WorkbenchDataProvider: "workbench-data" }));
vi.mock("@/components/workbench/DataVersionWatcher", () => ({ DataVersionWatcher: "watcher" }));

import { formatIfMatch } from "../write-precondition";
import { ownerTenantHandle } from "../owner";
import { getStorage, _resetStorage } from "../storage";
import { _resetLocks } from "../lock";
import { createWiki, getWikiRegistry, readWikiArtifact } from "../wikis";
import { wikiArtifactPath } from "../wiki-paths";
import { resolveExtractCaller, extractOwnerFor } from "../extract-auth";
import { getServicePrincipal } from "../auth";
import { resolveV1Caller } from "../v1-route";
import { GET as listWikis, POST as createWikiRoute } from "@/app/api/wikis/route";
import { PUT as activate } from "@/app/api/wikis/current/route";
import { GET as preview } from "@/app/api/workbench/preview/route";
import { PUT as saveArtifact } from "@/app/api/workbench/artifact/route";
import { GET as history } from "@/app/api/workbench/artifact/revisions/route";
import Home from "@/app/page";

const request = (url: string, method = "GET", body?: unknown, headers?: Record<string, string>) =>
  new NextRequest(`http://localhost${url}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
let temp: string;
beforeEach(async () => {
  vi.stubGlobal("React", React);
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "owner-session-"));
  vi.stubEnv("DATA_DIR", temp);
  vi.stubEnv("WIKI_DIR", path.join(temp, "wiki"));
  vi.stubEnv("RAW_DIR", path.join(temp, "raw"));
  vi.stubEnv("NEXT_PUBLIC_OWNER_HANDLE", "canonical");
  vi.stubEnv("YOPEDIA_OWNER_USER_ID", "user_stable");
  vi.stubEnv("YOPEDIA_READONLY", "0");
  auth.principal = { id: "user_stable", handle: "changed" };
  _resetStorage(); _resetLocks();
});
afterEach(async () => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); _resetStorage(); _resetLocks();
  await fs.rm(temp, { recursive: true, force: true });
});

describe("canonical session namespace", () => {
  it("preserves every fallback without mutating identity or inventing a tenant", () => {
    const principal = Object.freeze({ id: "user_stable", handle: "changed" });
    expect(ownerTenantHandle(principal)).toBe("canonical");
    expect(principal.handle).toBe("changed");
    expect(ownerTenantHandle({ id: "user_stable", handle: "user_stable" })).toBe("canonical");
    expect(ownerTenantHandle({ id: "user_stable" })).toBe("canonical");
    expect(ownerTenantHandle({ id: "user_impostor", handle: "canonical" })).toBe("canonical");
    expect(ownerTenantHandle({ id: "user_else", handle: " Spaced " })).toBe(" Spaced ");
    expect(ownerTenantHandle({ id: "service:canonical", handle: "CANONICAL" })).toBe("canonical");
    expect(ownerTenantHandle(null)).toBe("");
    expect(ownerTenantHandle(undefined)).toBe("");
    vi.stubEnv("YOPEDIA_OWNER_USER_ID", "");
    expect(ownerTenantHandle({ handle: "CANONICAL" })).toBe("canonical");
    vi.stubEnv("NEXT_PUBLIC_OWNER_HANDLE", "");
    vi.stubEnv("YOPEDIA_OWNER_USER_ID", "user_stable");
    expect(ownerTenantHandle(principal)).toBe("changed");
    expect(ownerTenantHandle({ handle: "" })).toBe("");
  });

  it("creates, lists, activates, edits and previews one canonical Wiki on first paint; old bytes stay intact", async () => {
    const oldWiki = await createWiki("changed", { name: "Old retained data", scenario: "research" });
    const oldPath = wikiArtifactPath("changed", oldWiki.id, "schema.md");
    await getStorage().writeFile(oldPath, "OLD HANDLE SENTINEL\n");
    const oldRegistry = JSON.stringify(await getWikiRegistry("changed"));
    const create = await createWikiRoute(request("/api/wikis", "POST", { name: "Canonical workspace", scenario: "research" }));
    expect(create.status).toBe(201);
    const { wiki } = await create.json();
    expect((await listWikis()).status).toBe(200);
    expect((await (await listWikis()).json()).wikis.map((w: { id: string }) => w.id)).toEqual([wiki.id]);
    expect((await activate(request("/api/wikis/current", "PUT", { id: wiki.id }))).status).toBe(200);
    const before = await (await preview(request("/api/workbench/preview?kind=file&path=schema.md"))).json();
    const content = "# Canonical Schema\n\n## Page conventions\n\nCanonical fresh content.\n";
    const saved = await saveArtifact(request("/api/workbench/artifact?path=schema.md", "PUT", { content }, { "If-Match": formatIfMatch(before.version) }));
    expect(saved.status).toBe(200);
    expect(await readWikiArtifact("canonical", wiki.id, "schema.md")).toBe(content);
    expect((await (await preview(request("/api/workbench/preview?kind=file&path=schema.md"))).json()).body).toBe(content);
    const revisions = await (await history(request("/api/workbench/artifact/revisions?path=schema.md"))).json();
    expect(revisions.revisions[0].author).toBe("changed");
    const home = await Home();
    expect(home.props.value.currentWikiId).toBe(wiki.id);
    expect(home.props.value.wikis.map((w: { id: string }) => w.id)).toEqual([wiki.id]);
    expect(home.props.value.registryUnavailable).toBe(false);
    expect(home.props.value.filesUnavailable).toBe(false);
    const caller = await resolveV1Caller("current", request("/api/v1/projects/current"));
    expect(caller).toMatchObject({ ok: true, wikiId: wiki.id, principal: auth.principal });
    expect(await getStorage().readFile(oldPath)).toBe("OLD HANDLE SENTINEL\n");
    expect(JSON.stringify(await getWikiRegistry("changed"))).toBe(oldRegistry);
  });

  it("creates and persists a Chat turn through canonical routes while old conversation bytes stay intact", async () => {
    const chat = await import("../chat");
    const collection = await import("@/app/api/chat/conversations/route");
    const messages = await import("@/app/api/chat/conversations/[id]/messages/route");
    const detail = await import("@/app/api/chat/conversations/[id]/route");
    const frames = [
      { role: "user" as const, content: "What did the fixture record?" },
      { role: "assistant" as const, content: "The fixture recorded a decision [1].", citations: [{ n: 1, path: "wiki/fixture.md", title: "Fixture", type: "page" }] },
    ];
    const old = await chat.createChatConversation("changed", { title: "Retained old conversation" });
    await chat.persistChatTurn("changed", old.id, frames);
    const oldPath = "tenants/changed/chat-conversations.json";
    const oldBytes = await getStorage().readFile(oldPath);
    const created = await collection.POST(request("/api/chat/conversations", "POST", { title: "Canonical conversation" }));
    expect(created.status).toBe(201);
    const { conversation } = await created.json();
    const context = { params: Promise.resolve({ id: conversation.id }) };
    const saved = await messages.POST(request(`/api/chat/conversations/${conversation.id}/messages`, "POST", { persist: true, messages: frames }), context);
    expect(saved.status).toBe(200);
    // Reopen the actual store before sibling route reads; no writer/reader mocks.
    _resetStorage(); _resetLocks();
    const listing = await collection.GET();
    expect(listing.status).toBe(200);
    expect((await listing.json()).conversations.map((row: { id: string }) => row.id)).toEqual([conversation.id]);
    const reloaded = await detail.GET(request(`/api/chat/conversations/${conversation.id}`), context);
    expect(reloaded.status).toBe(200);
    const restored = (await reloaded.json()).conversation;
    expect(restored).toMatchObject({ id: conversation.id, title: "Canonical conversation", messages: frames });
    const canonicalRows = JSON.parse(await getStorage().readFile("tenants/canonical/chat-conversations.json"));
    expect(canonicalRows).toHaveLength(1);
    expect(canonicalRows[0]).toMatchObject({ id: conversation.id, messages: frames });
    expect(await getStorage().readFile(oldPath)).toBe(oldBytes);
    expect((await chat.listChatConversations("changed")).map((row) => row.id)).toEqual([old.id]);
  });

  it("refuses stale-handle impostors and unauthenticated writes", async () => {
    auth.principal = { id: "user_impostor", handle: "canonical" };
    expect((await createWikiRoute(request("/api/wikis", "POST", { name: "No", scenario: "research" }))).status).toBe(403);
    auth.principal = null;
    expect((await listWikis()).status).toBe(401);
  });

  it("keeps requested extract targets literal and the service branch unchanged", async () => {
    const req = request("/api/extract");
    expect(await resolveExtractCaller(req, null)).toEqual({ owner: "canonical", service: false });
    expect(await resolveExtractCaller(req, "changed")).toBeNull();
    expect(await resolveExtractCaller(req, "canonical")).toEqual({ owner: "canonical", service: false });
    expect(extractOwnerFor({ owner: "canonical", service: false }, "changed")).toBeNull();
    vi.mocked(getServicePrincipal).mockReturnValue({ id: "service:test", handle: "service" });
    expect(await resolveExtractCaller(req, "changed")).toEqual({ owner: "changed", service: true });
    expect(await resolveExtractCaller(req, null)).toEqual({ owner: null, service: true });
    expect(extractOwnerFor({ owner: null, service: true }, "changed")).toBe("changed");
  });
});

// These execute real route readers and their local stores. The spies observe the
// namespace at each family boundary; they do not replace the storage operation.
const families = [
  { name: "Chat", store: () => import("../chat"), reader: "listChatConversations", route: () => import("@/app/api/chat/conversations/route"), url: "/api/chat/conversations" },
  { name: "Todos", store: () => import("../todos"), reader: "listTodos", route: () => import("@/app/api/todos/route"), url: "/api/todos" },
  { name: "Action items", store: () => import("../action-items"), reader: "listActionItems", route: () => import("@/app/api/action-items/route"), url: "/api/action-items" },
  { name: "Names and terms", store: () => import("../names-terms"), reader: "listNamesTerms", route: () => import("@/app/api/names-terms/route"), url: "/api/names-terms" },
  { name: "Review", store: () => import("../review-queue"), reader: "reviewSnapshot", route: () => import("@/app/api/review-queue/route"), url: "/api/review-queue?wikiId=current" },
  { name: "Research", store: () => import("../research-projects"), reader: "listResearchProjects", route: () => import("@/app/api/research/route"), url: "/api/research" },
  { name: "Backups", store: () => import("../backups"), reader: "listBackupManifests", route: () => import("@/app/api/system/backups/route"), url: "/api/system/backups" },
  { name: "Evaluations", store: () => import("../retrieval-evals"), reader: "listRetrievalEvalCases", route: () => import("@/app/api/system/evaluations/route"), url: "/api/system/evaluations" },
  { name: "Agents", store: () => import("../agents"), reader: "listAgentsForOwner", route: () => import("@/app/api/agents/route"), url: "/api/agents?mine=1" },
  { name: "Agent workspaces", store: () => import("../agent-workspaces"), reader: "listAgentRunWorkspaces", route: () => import("@/app/api/agent-workspaces/route"), url: "/api/agent-workspaces" },
  { name: "Agent skills", store: () => import("../agent-skills"), reader: "listAgentSkills", route: () => import("@/app/api/agent-skills/route"), url: "/api/agent-skills" },
  { name: "Agent approvals", store: () => import("../agent-workspaces"), reader: "listAgentSandboxApprovals", route: () => import("@/app/api/agent-sandbox-approvals/route"), url: "/api/agent-sandbox-approvals" },
  { name: "Structured knowledge", store: () => import("../structured-knowledge"), reader: "getStructuredKnowledge", route: () => import("@/app/api/knowledge/route"), url: "/api/knowledge" },
  { name: "Integrations", store: () => import("../integration-outbox"), reader: "getIntegrationSettings", route: () => import("@/app/api/integrations/route"), url: "/api/integrations" },
  { name: "Monitors", store: () => import("../source-monitors"), reader: "listSourceMonitors", route: () => import("@/app/api/monitors/route"), url: "/api/monitors" },
  { name: "Graph insights", store: () => import("../graph-insight-dismissals"), reader: "listInsightDismissals", route: () => import("@/app/api/graph/insights/route"), url: "/api/graph/insights" },
  { name: "Sync", store: () => import("../local-sync-clients"), reader: "listLocalSyncClients", route: () => import("@/app/api/sync/status/route"), url: "/api/sync/status" },
  { name: "Vaults", store: () => import("../vault"), reader: "listVaults", route: () => import("@/app/api/vaults/route"), url: "/api/vaults" },
];
it.each(families)("addresses $name through the canonical session owner", async ({ store, reader, route, url }) => {
  const familyStore = await store();
  const spy = vi.spyOn(familyStore as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>, reader);
  try {
    const handler = (await route()).GET as (req: NextRequest) => Promise<Response>;
    const response = await handler(request(url));
    expect(response.status).toBe(200);
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls.every((args) => args[0] === "canonical")).toBe(true);
  } finally { spy.mockRestore(); }
});
