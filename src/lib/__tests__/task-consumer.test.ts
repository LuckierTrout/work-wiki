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
    // Params are declared so `mock.calls[0]` is typed — the receipt-URL and
    // wire-header assertions below inspect what the worker actually sent.
    YOPEDIA: { fetch: vi.fn(async (_request: Request) => response) },
    EMAIL: {
      send: vi.fn(async (_message: { from: string; to: string; subject: string; text: string }) => ({
        messageId: "receipt-1",
      })),
    },
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
      // `/wiki/<slug>` is retired (404) — the receipt links the owner-scoped
      // form, which 308s to the page's real tenant.
      text: expect.stringContaining("/u/yopedia/quarterly-notes"),
    }));
  });

  it("never links the retired commons URL in a receipt", async () => {
    const entry = message();
    const bindings = env(Response.json({ ok: true, slug: "quarterly-notes" }));
    await worker.queue({ queue: "yopedia-tasks", messages: [entry] }, bindings);
    const sent = bindings.EMAIL.send.mock.calls[0]![0] as unknown as { text: string };
    expect(sent.text).not.toContain("/wiki/");
  });

  // AD-7 wire protocol: `src/app/api/tasks/run/route.ts` reads this exact header
  // to drive retry accounting. Renaming it silently breaks the terminal-failure
  // branch, so pin the literal name on the sending side.
  it("sends the queue attempt as the X-Yopedia-Queue-Attempt header", async () => {
    const entry = message(3);
    const bindings = env(Response.json({ ok: true, slug: "quarterly-notes" }));
    await worker.queue({ queue: "yopedia-tasks", messages: [entry] }, bindings);
    const request = bindings.YOPEDIA.fetch.mock.calls[0]![0] as unknown as Request;
    expect(request.headers.get("X-Yopedia-Queue-Attempt")).toBe("3");
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
