import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { MAX_DELIVERY_ATTEMPTS } from "../../../workers/task-consumer/index";
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
    // The LAST attempt Cloudflare delivers, taken from the worker rather than
    // retyped: staged as a literal `4`, this row keeps passing when the
    // constant drops to 3 — it just drives an attempt number the queue would
    // never reach, and stops exercising the boundary it is named for.
    const entry = message(MAX_DELIVERY_ATTEMPTS);
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
    // the `attempts = MAX_DELIVERY_ATTEMPTS` case below on its own, so the
    // silence of every earlier attempt is pinned here rather than assumed.
    expect(bindings.EMAIL.send).not.toHaveBeenCalled();
  });

  it("still retries a read-only 403 on the last delivery attempt, mailing the failure receipt", async () => {
    // Parking is the QUEUE's job, not the consumer's: on the final attempt the
    // consumer still retries and Cloudflare routes the message to the DLQ, so
    // the work survives the read-only window. The receipt goes out on that same
    // attempt — the noise `DEPLOY.md` warns about, pinned so it is a known cost
    // rather than a surprise. Read from the worker, not retyped, so the row
    // keeps landing ON the boundary when the constant moves.
    const entry = message(MAX_DELIVERY_ATTEMPTS);
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

/**
 * Strip JSONC comments without disturbing string literals.
 *
 * `wrangler.jsonc` holds `"YOPEDIA_URL": "https://workwiki.app"`, so a naive
 * `//`-to-end-of-line strip would truncate the file mid-string and leave
 * `JSON.parse` looking at garbage — reporting a broken config for a file that
 * is perfectly fine. Tracking in-string state (and backslash escapes) is the
 * whole requirement; the repo carries no JSONC parser and one two-file reader
 * does not earn a dependency.
 */
function stripJsonComments(source: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (inLine) {
      if (char === "\n") {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false;
        i += 1;
      } else if (char === "\n") {
        // Keep the line count intact so a parse error points at the real line.
        out += char;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        // The escaped character cannot close the string, whatever it is.
        out += next ?? "";
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLine = true;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * Drop trailing commas, which JSONC allows and `JSON.parse` rejects.
 *
 * Run AFTER comment stripping, so a comma followed by a comment and then the
 * closing brace is still seen as trailing. Without this a perfectly valid
 * `wrangler.jsonc` — one `wrangler deploy` reads without complaint — would
 * fail every assertion in this block under a message claiming the file is
 * malformed.
 */
function stripTrailingCommas(source: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      out += char;
      if (char === "\\") {
        out += source[i + 1] ?? "";
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      // Look ahead past whitespace: a comma whose next token closes the
      // container is trailing.
      let j = i + 1;
      while (j < source.length && /\s/.test(source[j])) j += 1;
      if (source[j] === "}" || source[j] === "]") continue;
    }
    out += char;
  }
  return out;
}

/** How `DEPLOY.md` spells the attempt count in prose. */
const ATTEMPT_WORDS: Record<number, string> = {
  2: "two",
  3: "three",
  4: "four",
  5: "five",
  6: "six",
};

/**
 * DW-730. The consumer's retry BEHAVIOUR is pinned above — a 403 retries, it is
 * never acked away. What makes that retry mean "the message survives" rather
 * than "the message is redelivered a few times and then vanishes" lives in
 * config no test read: `dead_letter_queue` and `max_retries` in
 * `workers/task-consumer/wrangler.jsonc`. Delete the DLQ line and every message
 * a read-only window refuses is discarded at the end of its retries; bump
 * `max_retries` and the worker mails its final failure receipt on an attempt
 * that is no longer the last. Either edit left the whole suite green while
 * inverting DEPLOY.md's "queued work is replayable, not lost".
 *
 * Three things move together, so all three are compared rather than restated:
 * the config's `max_retries`, the worker's `MAX_DELIVERY_ATTEMPTS`, and the
 * attempt count DEPLOY.md publishes. Any one of them moving alone fails here.
 */
describe("task consumer queue configuration", () => {
  const CONFIG_PATH = "workers/task-consumer/wrangler.jsonc";

  function readConsumerConfig(): Record<string, unknown> {
    // ONE spelling of the path: the messages below name `CONFIG_PATH`, so
    // reading a separately-typed literal would let the two drift and point a
    // reader at a file the test never opened.
    const raw = readFileSync(
      new URL(`../../../${CONFIG_PATH}`, import.meta.url),
      "utf8",
    );
    try {
      return JSON.parse(
        stripTrailingCommas(stripJsonComments(raw)),
      ) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `${CONFIG_PATH} did not parse as JSONC after comment stripping ` +
          `(${String(error)}). Either the file is malformed — in which case ` +
          `\`wrangler deploy\` is broken too — or it grew a construct the ` +
          `stripper above mishandles.`,
      );
    }
  }

  function tasksConsumer(): Record<string, unknown> {
    const config = readConsumerConfig();
    const queues = config.queues as { consumers?: unknown } | undefined;
    const consumers = queues?.consumers;
    expect(
      Array.isArray(consumers),
      `${CONFIG_PATH} declares no \`queues.consumers\` array. Without it the ` +
        `worker is deployed with no queue attached and nothing drains ` +
        `\`yopedia-tasks\` at all.`,
    ).toBe(true);
    const matching = (consumers as unknown[]).filter(
      // Guarded, so a `null` or a bare string in the list reaches the
      // explanatory assertion below instead of throwing a raw TypeError that
      // names neither the file nor the queue.
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as Record<string, unknown>).queue === "yopedia-tasks",
    );
    expect(
      matching.length,
      `Expected exactly one \`yopedia-tasks\` consumer in ${CONFIG_PATH}, ` +
        `found ${matching.length}. Zero means this whole block is asserting ` +
        `about a queue that is no longer wired up.`,
    ).toBe(1);
    return matching[0];
  }

  it("strips comments without reaching inside string literals", () => {
    // The stripper, exercised directly rather than only through the real file
    // — including the block-comment branch, which `wrangler.jsonc` does not
    // currently use and which would otherwise be dead code nothing checks.
    const fixture = [
      "{",
      "  // a line comment",
      '  "url": "https://example.test/a//b", // trailing comment',
      "  /* a block",
      "     comment */",
      '  "escaped": "a \\" // not a comment"',
      "}",
    ].join("\n");
    const stripped = stripJsonComments(fixture);
    expect(
      stripped.split("\n"),
      `The stripper must blank comments in place, not delete their lines: a ` +
        `parse error's reported line number is only useful if it still ` +
        `matches the file on disk.`,
    ).toHaveLength(fixture.split("\n").length);
    const parsed = JSON.parse(stripped) as Record<string, string>;
    expect(parsed.url).toBe("https://example.test/a//b");
    expect(parsed.escaped).toBe('a " // not a comment');

    // And the same property on the REAL file: the `//` in YOPEDIA_URL is what
    // a naive stripper would truncate. Asserted as a shape, not as a specific
    // host — the subject here is comment stripping, and freezing the hostname
    // would fail this test for a legitimate domain change under a message
    // blaming the stripper.
    const config = readConsumerConfig();
    expect(
      (config.vars as Record<string, unknown> | undefined)?.YOPEDIA_URL,
      `YOPEDIA_URL in ${CONFIG_PATH} no longer reads as a whole https:// URL. ` +
        `If it looks truncated at "https:", the stripper has stopped ` +
        `respecting string literals and every value parsed from this file is ` +
        `suspect.`,
    ).toMatch(/^https:\/\/[^/\s]+/);
  });

  it("parks exhausted messages in the dead-letter queue instead of discarding them", () => {
    expect(
      tasksConsumer().dead_letter_queue,
      `${CONFIG_PATH}'s \`yopedia-tasks\` consumer must keep ` +
        `\`dead_letter_queue: "yopedia-tasks-dlq"\`. Without it Cloudflare ` +
        `DELETES a message once its retries are exhausted, so every task ` +
        `queued during a read-only deployment — the 403s the cases above ` +
        `prove are retried rather than acked — is lost at the end of its ` +
        `retries, and DEPLOY.md's "queued work is replayable, not lost" ` +
        `becomes false.`,
    ).toBe("yopedia-tasks-dlq");
  });

  it("ties max_retries to the worker's final-attempt constant", () => {
    const maxRetries = tasksConsumer().max_retries;
    expect(
      typeof maxRetries,
      `${CONFIG_PATH}'s \`yopedia-tasks\` consumer must declare a numeric ` +
        `\`max_retries\`; omitting it takes Cloudflare's default rather than ` +
        `the count the worker and DEPLOY.md are written against.`,
    ).toBe("number");
    expect(
      (maxRetries as number) + 1,
      `The queue's \`max_retries: ${String(maxRetries)}\` in ${CONFIG_PATH} ` +
        `means ${(maxRetries as number) + 1} delivery attempts (one delivery ` +
        `plus the retries), but the worker's MAX_DELIVERY_ATTEMPTS is ` +
        `${MAX_DELIVERY_ATTEMPTS}. The worker uses that constant to recognise ` +
        `the LAST attempt and mail the final failure receipt, so a mismatch ` +
        `either mails the receipt early — while retries are still running and ` +
        `may yet succeed — or never mails it at all, and the submitter hears ` +
        `nothing about a message that went to the DLQ.`,
    ).toBe(MAX_DELIVERY_ATTEMPTS);
  });

  it("keeps DEPLOY.md's published attempt count and dead-letter promise in step", () => {
    const doc = readFileSync(
      new URL("../../../DEPLOY.md", import.meta.url),
      "utf8",
    );
    // The doc wraps mid-sentence, so compare against a single-spaced copy —
    // and drop inline markdown, so bolding the count (`up to **four**
    // delivery attempts`) is a formatting edit rather than a failure claiming
    // the number changed.
    const prose = doc.replace(/[*_`]/g, "").replace(/\s+/g, " ");
    const word = ATTEMPT_WORDS[MAX_DELIVERY_ATTEMPTS];
    expect(
      word,
      `MAX_DELIVERY_ATTEMPTS is now ${MAX_DELIVERY_ATTEMPTS}, which this test ` +
        `has no English spelling for. Add it to ATTEMPT_WORDS — do not delete ` +
        `this assertion, or DEPLOY.md is free to keep publishing the old ` +
        `count to operators.`,
    ).toBeDefined();
    expect(
      prose,
      `DEPLOY.md no longer says "up to ${word} delivery attempts". Its ` +
        `read-only section is what an operator reads before setting ` +
        `YOPEDIA_READONLY; a stale count there tells them a paused ` +
        `deployment can absorb more (or fewer) retries than ` +
        `${CONFIG_PATH} actually grants it.`,
    ).toContain(`up to ${word} delivery attempts`);
    expect(
      prose,
      `DEPLOY.md stopped naming the dead-letter queue. The DLQ is the entire ` +
        `reason "queued work is replayable, not lost" holds; prose that drops ` +
        `it reads as though exhausted messages simply disappear.`,
    ).toContain("dead-letter queue");
  });
});
