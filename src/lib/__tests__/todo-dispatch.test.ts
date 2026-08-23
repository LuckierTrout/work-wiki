import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../tasks", () => ({ enqueueTask: vi.fn(async () => false) }));
vi.mock("../todo-extract", () => ({
  extractTodoCandidatesFromMeeting: vi.fn(async () => []),
}));
vi.mock("../todos", () => ({
  recordTodoExtractError: vi.fn(async () => {}),
}));
vi.mock("../source-meeting", () => ({
  meetingExtractTarget: vi.fn(
    async (_owner: string, input: { origin?: string; sourcePath?: string }) =>
      input.origin === "plaud" || input.sourcePath
        ? { sourcePath: input.sourcePath ?? "raw/sources/meet/a.md" }
        : null,
  ),
  setSourceMeeting: vi.fn(async (path: string) => ({ path, meeting: true })),
}));

import { enqueueTask } from "../tasks";
import { extractTodoCandidatesFromMeeting } from "../todo-extract";
import { recordTodoExtractError } from "../todos";
import { meetingExtractTarget } from "../source-meeting";
import { dispatchMeetingTodoExtract } from "../todo-dispatch";

const mockedEnqueue = vi.mocked(enqueueTask);
const mockedExtract = vi.mocked(extractTodoCandidatesFromMeeting);
const mockedRecord = vi.mocked(recordTodoExtractError);
const mockedTarget = vi.mocked(meetingExtractTarget);

describe("dispatchMeetingTodoExtract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedEnqueue.mockResolvedValue(false);
    mockedExtract.mockResolvedValue([]);
    mockedTarget.mockImplementation(
      async (_owner: string, input: { origin?: string; sourcePath?: string }) =>
        input.origin === "plaud" || input.sourcePath
          ? { sourcePath: input.sourcePath ?? "raw/sources/meet/a.md" }
          : null,
    );
  });

  it("skips non-meeting compiles", async () => {
    mockedTarget.mockResolvedValueOnce(null);
    await expect(
      dispatchMeetingTodoExtract("alice", { slug: "notes" }),
    ).resolves.toBe("skipped");
    expect(mockedEnqueue).not.toHaveBeenCalled();
    expect(mockedExtract).not.toHaveBeenCalled();
  });

  it("enqueues when the queue is available", async () => {
    mockedEnqueue.mockResolvedValueOnce(true);
    await expect(
      dispatchMeetingTodoExtract("alice", {
        origin: "plaud",
        slug: "meet",
        sourcePath: "raw/sources/meet/a.md",
      }),
    ).resolves.toBe("queued");
    expect(mockedExtract).not.toHaveBeenCalled();
  });

  it("runs extract inline when the queue is absent", async () => {
    await expect(
      dispatchMeetingTodoExtract("alice", {
        origin: "plaud",
        slug: "meet",
        sourcePath: "raw/sources/meet/a.md",
      }),
    ).resolves.toBe("ran");
    expect(mockedExtract).toHaveBeenCalledWith(
      "alice",
      "meet",
      "raw/sources/meet/a.md",
    );
  });

  it("records a visible error and stays fail-soft after compile", async () => {
    mockedExtract.mockRejectedValueOnce(new Error("no key"));
    await expect(
      dispatchMeetingTodoExtract(
        "alice",
        { origin: "plaud", slug: "meet", sourcePath: "raw/sources/meet/a.md" },
        { failSoft: true },
      ),
    ).resolves.toBe("skipped");
    expect(mockedRecord).toHaveBeenCalledWith(
      "alice",
      expect.objectContaining({ message: "no key", slug: "meet" }),
    );
  });
});
