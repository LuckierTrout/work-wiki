import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/workbench-request", () => ({ send }));

import { ActivityDock } from "../ActivityDock";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
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
});
