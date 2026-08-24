import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/workbench-request", () => ({ send }));

import { useReviewBadge } from "../useReviewBadge";

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function Harness({
  wikiId,
  version = 0,
  initialCount = 7,
}: {
  wikiId: string | null;
  version?: number;
  initialCount?: number;
}) {
  const [count, onCountChange] = useReviewBadge(wikiId, version, initialCount);
  return <button type="button" onClick={() => onCountChange(4)}>{count}</button>;
}

describe("Review badge scope", () => {
  it("clears the prior Wiki on failure and fences its stale response", async () => {
    let resolveA: ((value: unknown) => void) | undefined;
    const pendingA = new Promise((resolve) => { resolveA = resolve; });
    send.mockImplementation((url: string) => {
      if (url.includes("wiki-a")) return pendingA;
      return Promise.reject(new Error("wiki-b unavailable"));
    });
    const view = render(<Harness wikiId="wiki-a" />);
    view.rerender(<Harness wikiId="wiki-b" />);
    await waitFor(() => expect(screen.getByRole("button").textContent).toBe("0"));
    resolveA?.({ pendingCount: 9 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole("button").textContent).toBe("0");
  });

  it("keeps a canvas update when an older request lands afterward", async () => {
    let resolveRequest: ((value: unknown) => void) | undefined;
    send.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));
    render(<Harness wikiId="wiki-a" />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button").textContent).toBe("4");
    resolveRequest?.({ pendingCount: 9 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole("button").textContent).toBe("4");
  });

  it("uses the successful count from the active scoped request", async () => {
    send.mockResolvedValue({ pendingCount: 3 });
    render(<Harness wikiId="wiki-a" />);
    await waitFor(() => expect(screen.getByRole("button").textContent).toBe("3"));
    expect(send).toHaveBeenCalledWith("/api/review-queue?wikiId=wiki-a", {
      method: "GET",
    });
  });

  it("refreshes the scoped count when dataVersion changes", async () => {
    send
      .mockResolvedValueOnce({ pendingCount: 2 })
      .mockResolvedValueOnce({ pendingCount: 6 });
    const view = render(<Harness wikiId="wiki-a" version={1} />);
    await waitFor(() => expect(screen.getByRole("button").textContent).toBe("2"));
    view.rerender(<Harness wikiId="wiki-a" version={2} />);
    await waitFor(() => expect(screen.getByRole("button").textContent).toBe("6"));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("invalidates an older request when the supplied initial count changes", async () => {
    let resolveOld: ((value: unknown) => void) | undefined;
    send
      .mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }))
      .mockRejectedValueOnce(new Error("refresh unavailable"));
    const view = render(<Harness wikiId="wiki-a" initialCount={1} />);
    view.rerender(<Harness wikiId="wiki-a" initialCount={5} />);
    await waitFor(() => expect(screen.getByRole("button").textContent).toBe("5"));
    resolveOld?.({ pendingCount: 9 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole("button").textContent).toBe("5");
  });

  it("keeps a valid new-Wiki initial count when its refresh fails", async () => {
    send.mockImplementation((url: string) => {
      if (url.includes("wiki-a")) return new Promise(() => undefined);
      return Promise.reject(new Error("wiki-b unavailable"));
    });
    const view = render(<Harness wikiId="wiki-a" initialCount={7} />);
    view.rerender(<Harness wikiId="wiki-b" initialCount={2} />);
    await waitFor(() => expect(screen.getByRole("button").textContent).toBe("2"));
  });

  it("stays at zero and makes no unscoped request without a Wiki", () => {
    render(<Harness wikiId={null} initialCount={8} />);
    expect(screen.getByRole("button").textContent).toBe("0");
    expect(send).not.toHaveBeenCalled();
  });

  it("ignores malformed response counts", async () => {
    send.mockResolvedValue({ pendingCount: 2.5 });
    render(<Harness wikiId="wiki-a" initialCount={7} />);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button").textContent).toBe("7");
  });
});
