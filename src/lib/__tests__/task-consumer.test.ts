import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../../workers/task-consumer/index";

function message(attempts = 1) {
  return {
    id: "message-1",
    attempts,
    body: {
      kind: "ingest",
      email: {
        from: "owner@example.com",
        to: "ingest@workwiki.app",
        subject: "Quarterly notes",
        messageId: "<message-1@example.com>",
        attachmentNames: ["deck.pptx"],
      },
      attachments: [{ key: "raw/uploads/j/deck.pptx", filename: "deck.pptx" }],
    },
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function env(response: Response) {
  return {
    YOPEDIA_URL: "https://yopedia.example.com",
    YOPEDIA_SITE_URL: "https://yopedia.example.com",
    YOPEDIA_SERVICE_TOKEN: "test-token",
    YOPEDIA_EMAIL_FROM: "ingest@workwiki.app",
    YOPEDIA: { fetch: vi.fn(async () => response) },
    EMAIL: { send: vi.fn(async () => ({ messageId: "receipt-1" })) },
  };
}

describe("task consumer email receipts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends a completion receipt after a successful email ingest", async () => {
    const entry = message();
    const bindings = env(Response.json({ ok: true, slug: "quarterly-notes" }));
    await worker.queue({ queue: "yopedia-tasks", messages: [entry] }, bindings);
    expect(entry.ack).toHaveBeenCalledOnce();
    expect(entry.retry).not.toHaveBeenCalled();
    expect(bindings.EMAIL.send).toHaveBeenCalledWith(expect.objectContaining({
      to: "owner@example.com",
      subject: "Ready: Quarterly notes",
      text: expect.stringContaining("/wiki/quarterly-notes"),
    }));
  });

  it("sends a failure receipt for a permanently rejected email ingest", async () => {
    const entry = message();
    const bindings = env(Response.json({ error: "The attachment is corrupt" }, { status: 422 }));
    await worker.queue({ queue: "yopedia-tasks", messages: [entry] }, bindings);
    expect(entry.ack).toHaveBeenCalledOnce();
    expect(bindings.EMAIL.send).toHaveBeenCalledWith(expect.objectContaining({
      subject: "Could not import: Quarterly notes",
      text: expect.stringContaining("attachment is corrupt"),
    }));
  });

  it("sends the final failure receipt before the last transient retry reaches the DLQ", async () => {
    const entry = message(4);
    const bindings = env(new Response("provider unavailable", { status: 503 }));
    await worker.queue({ queue: "yopedia-tasks", messages: [entry] }, bindings);
    expect(entry.retry).toHaveBeenCalledOnce();
    expect(bindings.EMAIL.send).toHaveBeenCalledWith(expect.objectContaining({
      subject: "Could not import: Quarterly notes",
    }));
  });
});
