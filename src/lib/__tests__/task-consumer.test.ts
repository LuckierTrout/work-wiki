import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../../workers/task-consumer/index";
// The worker imports nothing from `src/lib`, so the refusal sentence is pulled
// from its owner here rather than retyped — which also ties this fixture to the
// body `DEPLOY.md` publishes and `tasks-route.test.ts` asserts.
import { READ_ONLY_REFUSAL } from "../read-only";

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
  /**
   * DW-647. `DEPLOY.md` publishes "queued work is replayable, not lost" for a
   * read-only deployment, and the whole claim rests on 403 NOT being in the
   * consumer's poison set (`400`, `404`, `422` → ack and drop). Nothing drove a
   * 403 through here, so appending `|| res.status === 403` to that condition
   * stayed green while inverting the documented outcome: every queued message
   * would be silently discarded instead of retried.
   *
   * Read the CODE, not the prose, if the two disagree. The comments that used
   * to say 4xx acks and drops — the JSDoc status contract and the read-only
   * gate comment in `src/app/api/tasks/run/route.ts`, the read-only comment in
   * `src/app/api/tasks/scan/route.ts`, and the `?dry=1` rationale in
   * `scan-route.test.ts` — were all corrected under DW-645 to scope the ack to
   * 400/404/422; this case pins what the consumer actually does.
   */
  it("retries a read-only 403 rather than acking it away", async () => {
    const entry = message();
    const bindings = env(
      Response.json({ error: READ_ONLY_REFUSAL.queuedWork }, { status: 403 }),
    );
    await worker.queue({ queue: "yopedia-tasks", messages: [entry] }, bindings);
    expect(entry.retry).toHaveBeenCalledOnce();
    // Both halves: an ack here is the message dropped, which is exactly the
    // outcome the doc promises does not happen.
    expect(entry.ack).not.toHaveBeenCalled();
    // …and nothing is mailed yet. The failure receipt is guarded by
    // `attempts >= MAX_DELIVERY_ATTEMPTS`; moving it out of that guard would
    // send the submitter FOUR failure receipts per queued message and satisfy
    // the `attempts = 4` case below on its own, so the silence of attempts 1-3
    // is pinned here rather than assumed.
    expect(bindings.EMAIL.send).not.toHaveBeenCalled();
  });

  it("still retries a read-only 403 on the last delivery attempt, mailing the failure receipt", async () => {
    // Parking is the QUEUE's job, not the consumer's: at `attempts = 4` the
    // consumer still retries and Cloudflare routes the message to the DLQ, so
    // the work survives the read-only window. The receipt goes out on that same
    // attempt — the noise `DEPLOY.md` warns about, pinned so it is a known cost
    // rather than a surprise.
    const entry = message(4);
    const bindings = env(
      Response.json({ error: READ_ONLY_REFUSAL.queuedWork }, { status: 403 }),
    );
    await worker.queue({ queue: "yopedia-tasks", messages: [entry] }, bindings);
    expect(entry.retry).toHaveBeenCalledOnce();
    expect(entry.ack).not.toHaveBeenCalled();
    expect(bindings.EMAIL.send).toHaveBeenCalledWith(expect.objectContaining({
      subject: "Could not import: Quarterly notes",
      // The submitter is told the REAL reason, not a generic failure: the
      // consumer snips the 403 body into the receipt's `detail`, so a paused
      // deployment reads as a paused deployment.
      text: expect.stringContaining(READ_ONLY_REFUSAL.queuedWork),
    }));
  });
});
