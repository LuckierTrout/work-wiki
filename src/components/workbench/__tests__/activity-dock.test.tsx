import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/workbench-request", () => ({ send }));

import { ActivityDock } from "../ActivityDock";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const row = (jobId: string, title: string) => ({
  jobId,
  title,
  status: "queued" as const,
  displayStatus: "Queued",
  canCancel: false,
  canRetry: false,
});

beforeEach(() => {
  send.mockReset();
  window.localStorage.clear();
});

afterEach(() => cleanup());

describe("ActivityDock Wiki scope", () => {
  it("does not let a late response from the previous Wiki repaint the new Wiki", async () => {
    const wikiA = deferred<{ rows: ReturnType<typeof row>[] }>();
    const wikiB = deferred<{ rows: ReturnType<typeof row>[] }>();
    send.mockImplementation((url: string) =>
      url.includes("wiki-a") ? wikiA.promise : wikiB.promise);

    const view = render(<ActivityDock wikiId="wiki-a" />);
    view.rerender(<ActivityDock wikiId="wiki-b" />);

    await act(async () => {
      wikiB.resolve({ rows: [row("b", "Wiki B import")] });
      await wikiB.promise;
    });
    expect(screen.getByText("Wiki B import")).toBeTruthy();

    await act(async () => {
      wikiA.resolve({ rows: [row("a", "Wiki A import")] });
      await wikiA.promise;
    });
    expect(screen.queryByText("Wiki A import")).toBeNull();
    expect(screen.getByText("Wiki B import")).toBeTruthy();
  });

  it("closes and fences an in-flight cancel when the Wiki changes", async () => {
    const mutation = deferred<unknown>();
    send.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST") return mutation.promise;
      if (url.includes("wiki-a")) {
        return Promise.resolve({ rows: [{ ...row("a", "Wiki A import"), canCancel: true }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const view = render(<ActivityDock wikiId="wiki-a" />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel ingest" }));
    await waitFor(() => expect(send).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: "POST" }),
    ));

    view.rerender(<ActivityDock wikiId="wiki-b" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => {
      mutation.reject(new Error("Wiki A cancel failed"));
      await mutation.promise.catch(() => undefined);
    });
    expect(screen.queryByText("Wiki A cancel failed")).toBeNull();
  });
});
