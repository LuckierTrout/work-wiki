import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ModeCanvas } from "../ModeCanvas";
import { SurfaceVisibilityProvider } from "@/hooks/useSurfaceVisibility";
import { RESEARCH_POLL_MS } from "@/lib/research-panel";
import { clearLoopbackDoorToken } from "@/lib/loopback-client";
import type { WorkbenchModeId } from "@/lib/workbench-modes";
import { Workbench } from "../Workbench";
import { WorkbenchDataProvider, type WorkbenchData } from "../WorkbenchData";
const { router } = vi.hoisted(() => ({ router: { refresh: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/workbench-request", async (original) => ({ ...await original<object>(), send }));
const CONVERSATION = { id: "c1", name: "First conversation", messages: [], retrievalMode: "wiki", tokenBudget: 32000, historyDepth: 10 };
function tree(mode: WorkbenchModeId, hidden = false, version = 0, ancestor = true) {
  return <SurfaceVisibilityProvider visible={ancestor}><ModeCanvas mode={mode} sidecar="up" headingId="mode-heading" hidden={hidden} wikiId="wiki-1" dataVersion={version}><p>Wiki remains mounted</p></ModeCanvas></SurfaceVisibilityProvider>;
}
const flush = () => act(async () => {});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function defaults(url: string) {
  if (url === "/api/chat/conversations") return { conversations: [CONVERSATION] };
  if (url === "/api/chat/conversations/c1") return { conversation: CONVERSATION };
  if (url === "/api/v1/loopback-settings") return { token: "door" };
  return { items: [], projects: [], nodes: [], edges: [] };
}
beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  clearLoopbackDoorToken();
  send.mockReset().mockImplementation(async (url: string) => defaults(url));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ skills: [] }), { status: 200 })));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("mounted mode withdrawal (DW-422)", () => {
  it("keeps the visible rail and retained Todos unchanged after an obsolete successful read", async () => {
    const item = (id: string, title: string) => ({ id, title, wikiId: "wiki-1", sourceId: "raw/sources/meeting.md", createdAt: "2026-09-10T00:00:00Z", updatedAt: "2026-09-10T00:00:00Z" });
    const old = deferred<unknown>();
    const current = deferred<unknown>();
    let lists = 0;
    send.mockImplementation(async (url: string) => {
      if (url === "/api/todos") return { pendingCount: 1 };
      if (url === "/api/todos?tab=candidates") {
        lists += 1;
        if (lists === 1) return { items: [item("kept", "Retained candidate")], pendingCount: 1 };
        return lists === 2 ? old.promise : current.promise;
      }
      return defaults(url);
    });
    window.history.replaceState(null, "", "/?mode=todos");
    const data: WorkbenchData = { wikis: [], currentWikiId: "wiki-1", registryUnavailable: false, knowledge: [], knowledgeUnavailable: false, files: [], filesUnavailable: false, filesTruncated: false, dataVersion: 0, readOnly: false };
    render(<WorkbenchDataProvider value={data}><Workbench><p>Wiki remains mounted</p></Workbench></WorkbenchDataProvider>);
    await flush();
    expect(screen.getByText("Retained candidate")).toBeTruthy();
    const settings = () => fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    settings();
    settings();
    await flush();
    expect(lists).toBe(2);
    settings();
    await act(async () => old.resolve({ items: [item("old", "Obsolete candidate")], pendingCount: 9 }));
    expect(screen.getByRole("button", { name: "Todos, 1 todo candidates" })).toBeTruthy();
    settings();
    await flush();
    expect(lists).toBe(3);
    expect(screen.getByText("Retained candidate")).toBeTruthy();
    expect(screen.queryByText("Obsolete candidate")).toBeNull();
    await act(async () => current.resolve({ items: [item("current", "Current candidate")], pendingCount: 2 }));
    expect(screen.getByRole("button", { name: "Todos, 2 todo candidates" })).toBeTruthy();
    expect(screen.getByText("Current candidate")).toBeTruthy();
    expect(screen.queryByText("Retained candidate")).toBeNull();
  });

  it("does no passive initialization behind a hidden ancestor", async () => {
    const view = render(tree("chat", false, 0, false));
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    view.rerender(tree("chat"));
    await flush();
    expect(send.mock.calls.filter(([url]) => url === "/api/chat/conversations")).toHaveLength(1);
    expect(send.mock.calls.filter(([url]) => url === "/api/chat/conversations/c1")).toHaveLength(1);
  });

  it.each([
    ["todos", "/api/todos?tab=candidates"],
    ["graph", "/api/graph/workbench"],
    ["review", "/api/review-queue?wikiId=wiki-1"],
    ["research", "/api/research?wikiId=wiki-1"],
  ] as const)("rejects a late %s read and reads once on return", async (mode, path) => {
    const old = deferred<unknown>();
    send.mockImplementation((url: string) => url === path ? old.promise : Promise.resolve(defaults(url)));
    const view = render(tree(mode));
    await flush();
    expect(send.mock.calls.filter(([url]) => url === path)).toHaveLength(1);
    view.rerender(tree(mode, true, 1));
    view.rerender(tree(mode, true, 2));
    await act(async () => old.reject(new Error("obsolete passive failure")));
    expect(document.body.textContent).not.toContain("obsolete passive failure");
    send.mockImplementation(async (url: string) => defaults(url));
    view.rerender(tree(mode, false, 2));
    await flush();
    expect(send.mock.calls.filter(([url]) => url === path)).toHaveLength(2);
    expect(document.body.textContent).not.toContain("obsolete passive failure");
  });

  it("rejects a Skills response whose body ignores abort", async () => {
    const old = deferred<unknown>();
    vi.mocked(fetch).mockImplementationOnce(async () => ({ ok: true, json: () => old.promise }) as Response);
    const view = render(tree("skills"));
    await flush();
    view.rerender(tree("skills", true));
    await act(async () => old.resolve({ skills: [{ id: "stale", name: "Stale Skill", enabled: true }] }));
    expect(document.body.textContent).not.toContain("Stale Skill");
    view.rerender(tree("skills"));
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops Research polling while hidden and resumes one current read", async () => {
    vi.useFakeTimers();
    const path = "/api/research?wikiId=wiki-1";
    send.mockImplementation(async (url: string) => {
      if (url === path) throw new Error("Temporarily unavailable");
      return defaults(url);
    });
    const view = render(tree("research"));
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(RESEARCH_POLL_MS));
    expect(send.mock.calls.filter(([url]) => url === path)).toHaveLength(2);
    view.rerender(tree("research", true));
    await act(async () => vi.advanceTimersByTimeAsync(RESEARCH_POLL_MS * 3));
    expect(send.mock.calls.filter(([url]) => url === path)).toHaveLength(2);
    view.rerender(tree("research"));
    await flush();
    expect(send.mock.calls.filter(([url]) => url === path)).toHaveLength(3);
  });

  it("refreshes Chat's list without reloading its active conversation or composer", async () => {
    const view = render(tree("chat"));
    await flush();
    const composer = document.querySelector(".wb-chat-composer textarea") ?? document.querySelector("textarea");
    expect(composer).toBeTruthy();
    fireEvent.change(composer!, { target: { value: "Keep this draft" } });
    view.rerender(tree("chat", true));
    await flush();
    view.rerender(tree("chat"));
    await flush();
    expect(document.querySelector("textarea")).toBe(composer);
    expect((composer as HTMLTextAreaElement).value).toBe("Keep this draft");
    expect(send.mock.calls.filter(([url]) => url === "/api/chat/conversations/c1")).toHaveLength(1);
    expect(send.mock.calls.filter(([url]) => url === "/api/chat/conversations")).toHaveLength(2);
  });

  it("retains an explicit Search result for return without replaying the request", async () => {
    const result = deferred<unknown>();
    send.mockImplementation((url: string) => url.endsWith("/search") ? result.promise : Promise.resolve(defaults(url)));
    const view = render(tree("search"));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "alpha" } });
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" });
    view.rerender(tree("search", true));
    await act(async () => result.resolve({ hits: [{ title: "Retained answer", path: "wiki/alpha.md", snippet: "Search result", score: 1 }] }));
    expect(document.body.textContent).not.toContain("Retained answer");
    view.rerender(tree("search"));
    expect(screen.getByText("Retained answer")).toBeTruthy();
    expect(send.mock.calls.filter(([url]) => url.endsWith("/search"))).toHaveLength(1);
  });

  it("retains an explicit semantic Lint result without running it on return", async () => {
    const result = deferred<unknown>();
    send.mockImplementation((url: string) => url === "/api/lint/workbench" ? result.promise : Promise.resolve(defaults(url)));
    const view = render(tree("lint"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Semantic" }));
    fireEvent.click(screen.getByRole("button", { name: "Run lint" }));
    view.rerender(tree("lint", true));
    await act(async () => result.resolve({ issues: [{ type: "test", slug: "alpha", message: "Retained lint result" }] }));
    expect(document.body.textContent).not.toContain("Retained lint result");
    view.rerender(tree("lint"));
    expect(screen.getByText("Retained lint result")).toBeTruthy();
    const calls = send.mock.calls.filter(([url]) => url === "/api/lint/workbench");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0][1].body).semantic).toBe(true);
  });
});
