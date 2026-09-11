import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PreviewColumn } from "../PreviewColumn";
import { buildFileTree } from "@/lib/workbench-tree";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/workbench-request", async (original) => ({ ...await original<object>(), send }));
const path = "raw/sources/notes/a.md";
const files = buildFileTree([path]);
const ignore = () => {};
const pane = (hidden: boolean) => <PreviewColumn id="meeting-preview" selection={{ kind: "file", path }} knowledge={[]} files={files} onOpenPage={ignore} onOpenFile={ignore} onDirtyChange={ignore} dataVersion={0} hidden={hidden} />;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => act(async () => {});
beforeEach(() => {
  send.mockReset().mockResolvedValue({ path, meeting: false });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ name: "a.md", path, format: "markdown", body: "Meeting notes", truncated: false, editable: false }), { status: 200 })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("source Preview meeting status while withdrawn (DW-422)", () => {
  it("delays the first meeting read until the source Preview is visible", async () => {
    const view = render(pane(true));
    await flush();
    expect(send).not.toHaveBeenCalled();
    view.rerender(pane(false));
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Mark as meeting" })).toBeTruthy();
  });

  it.each(["success", "failure"])("ignores an obsolete %s through the return read", async (outcome) => {
    const old = deferred<{ path: string; meeting: boolean }>();
    const current = deferred<{ path: string; meeting: boolean }>();
    send.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const view = render(pane(false));
    await flush();
    view.rerender(pane(true));
    const before = document.querySelector(".wb-mark-meeting")!.textContent;
    await act(async () => {
      if (outcome === "success") old.resolve({ path, meeting: false });
      else old.reject(new Error("obsolete read"));
    });
    expect(document.querySelector(".wb-mark-meeting")!.textContent).toBe(before);
    view.rerender(pane(false));
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(document.querySelector(".wb-mark-meeting")!.textContent).toBe(before);
    await act(async () => current.resolve({ path, meeting: false }));
    expect(screen.getByRole("button", { name: "Mark as meeting" })).toBeTruthy();
  });

  it.each(["success", "failure"])("retains a hidden mark %s without replaying the write", async (outcome) => {
    const mutation = deferred<{ path: string; meeting: boolean }>();
    send.mockImplementation((_url: string, init?: RequestInit) => init?.method === "POST" ? mutation.promise : Promise.resolve({ path, meeting: outcome !== "failure" }));
    send.mockResolvedValueOnce({ path, meeting: false });
    const view = render(pane(false));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Mark as meeting" }));
    view.rerender(pane(true));
    const before = document.querySelector(".wb-mark-meeting")!.textContent;
    await act(async () => {
      if (outcome === "success") mutation.resolve({ path, meeting: true });
      else mutation.reject(new Error("Meeting mark refused"));
    });
    expect(document.querySelector(".wb-mark-meeting")!.textContent).toBe(before);
    view.rerender(pane(false));
    await flush();
    expect(send.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(send.mock.calls.filter(([, init]) => init?.method === "GET")).toHaveLength(2);
    if (outcome === "success") expect(screen.queryByRole("button", { name: "Mark as meeting" })).toBeNull();
    else {
      expect(screen.getByText("Meeting mark refused")).toBeTruthy();
      expect((screen.getByRole("button", { name: "Mark as meeting" }) as HTMLButtonElement).disabled).toBe(false);
    }
  });
});
