/**
 * work-wiki agent task-queue consumer.
 *
 * A thin dispatcher: drains the `yopedia-tasks` Cloudflare Queue and POSTs each
 * message to the main work-wiki app's `/api/tasks/run` endpoint with the system
 * token. The actual work runs in the main app, which has the full `src/lib` +
 * OpenNext request context. The queue carries the `Task` union defined in
 * `src/lib/tasks.ts` (the single source of truth — don't restate the kinds
 * here): async ingestion, knowledge extraction/compilation, agent and research
 * runs, source-monitor and integration/digest delivery, backups, and autonomous
 * `maintain` upkeep. Dispatch itself is kind-agnostic — it forwards whatever it
 * drains — with one exception: an `ingest` task carrying email metadata also
 * gets a "Ready"/"Could not import" receipt mailed back (`notifyEmailReceipt`).
 * It imports NO `src/lib` code, since that would transitively pull Clerk/Next
 * and the OpenNext context a standalone worker can't provide.
 *
 * Ack/retry maps straight onto Cloudflare Queues semantics:
 *   - 2xx  → ack (done).
 *   - 400/404/422 → poison (malformed / not-found) → ack + drop.
 *   - other 4xx / 5xx / network → retry (then DLQ after max_retries).
 */

interface Env {
  YOPEDIA_URL?: string;
  YOPEDIA_SITE_URL?: string;
  YOPEDIA_SERVICE_TOKEN?: string;
  YOPEDIA_EMAIL_FROM?: string;
  YOPEDIA?: { fetch(request: Request): Promise<Response> };
  EMAIL?: {
    send(message: {
      from: string;
      to: string;
      subject: string;
      text: string;
    }): Promise<unknown>;
  };
}

// Minimal Cloudflare Queues consumer types (avoid pulling @cloudflare/workers-types).
interface QueueMessage<T = unknown> {
  readonly id: string;
  readonly body: T;
  readonly attempts: number;
  ack(): void;
  retry(): void;
}
interface MessageBatch<T = unknown> {
  readonly queue: string;
  readonly messages: QueueMessage<T>[];
}
interface ScheduledEvent {
  readonly scheduledTime: number;
  readonly cron: string;
}

const MAX_DELIVERY_ATTEMPTS = 4;

async function runTask(
  env: Env,
  message: QueueMessage,
): Promise<void> {
  const base = (env.YOPEDIA_URL ?? "").replace(/\/+$/, "");
  const token = env.YOPEDIA_SERVICE_TOKEN!;
  const taskUrl = `${base}/api/tasks/run`;
  const requestInit: RequestInit = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      // WIRE PROTOCOL — `src/app/api/tasks/run/route.ts` reads this exact
      // name to drive retry accounting and the terminal-failure branch.
      // AD-7: `X-Yopedia-*` headers are runtime identifiers, never renamed.
      "X-Yopedia-Queue-Attempt": String(message.attempts),
    },
    body: JSON.stringify(message.body),
  };
  let res: Response;
  try {
    res = env.YOPEDIA
      ? await env.YOPEDIA.fetch(
          // Service bindings choose the destination Worker; the Request URL is
          // still visible to the target app. Preserve its configured origin so
          // host-aware middleware does not reject/cancel the internal request.
          new Request(taskUrl, requestInit),
        )
      : await fetch(taskUrl, requestInit);
  } catch (err) {
    console.error(`task-consumer: fetch failed for ${message.id} — retry`, err);
    if (message.attempts >= MAX_DELIVERY_ATTEMPTS) {
      await notifyEmailReceipt(env, message.body, {
        status: "failed",
        detail: "work-wiki could not finish processing the message after several attempts.",
      }).catch((error) =>
        console.error(`task-consumer: final failure email failed for ${message.id}`, error),
      );
    }
    message.retry();
    return;
  }

  if (res.status >= 200 && res.status < 300) {
    const result = (await res.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    await notifyEmailReceipt(env, message.body, {
      status: "done",
      result,
    }).catch((error) =>
      console.error(`task-consumer: completion email failed for ${message.id}`, error),
    );
    message.ack();
    return;
  }
  if (res.status === 400 || res.status === 404 || res.status === 422) {
    // Permanently-bad task — don't retry it forever.
    const snip = (await res.text().catch(() => "")).slice(0, 200).replace(/\s+/g, " ");
    console.warn(`task-consumer: poison ${message.id} (${res.status}): ${snip}`);
    await notifyEmailReceipt(env, message.body, {
      status: "failed",
      detail: snip || `work-wiki rejected the message (${res.status}).`,
    }).catch((error) =>
      console.error(`task-consumer: failure email failed for ${message.id}`, error),
    );
    message.ack();
    return;
  }
  // Other 4xx (notably auth/rate-limit) and 5xx are operational/transient;
  // retry instead of silently dropping a valid task on configuration drift.
  console.warn(`task-consumer: transient ${message.id} (${res.status}) — retry`);
  if (message.attempts >= MAX_DELIVERY_ATTEMPTS) {
    const snip = (await res.text().catch(() => "")).slice(0, 200).replace(/\s+/g, " ");
    await notifyEmailReceipt(env, message.body, {
      status: "failed",
      detail: snip || "work-wiki could not finish processing the message after several attempts.",
    }).catch((error) =>
      console.error(`task-consumer: final failure email failed for ${message.id}`, error),
    );
  }
  message.retry();
}

function emailMetadata(body: unknown): {
  from: string;
  subject: string;
  attachmentNames: string[];
  processedAttachmentCount: number;
} | null {
  if (!body || typeof body !== "object") return null;
  const email = (body as Record<string, unknown>).email;
  if (!email || typeof email !== "object") return null;
  const value = email as Record<string, unknown>;
  if (typeof value.from !== "string" || typeof value.subject !== "string") {
    return null;
  }
  return {
    from: value.from,
    subject: value.subject,
    attachmentNames: Array.isArray(value.attachmentNames)
      ? value.attachmentNames.filter(
          (name): name is string => typeof name === "string",
        )
      : [],
    processedAttachmentCount: Array.isArray((body as Record<string, unknown>).attachments)
      ? ((body as Record<string, unknown>).attachments as unknown[]).length
      : 0,
  };
}

async function notifyEmailReceipt(
  env: Env,
  body: unknown,
  receipt:
    | { status: "done"; result: Record<string, unknown> | null }
    | { status: "failed"; detail: string },
): Promise<void> {
  const email = emailMetadata(body);
  const from = env.YOPEDIA_EMAIL_FROM;
  if (!email || !env.EMAIL || !from) return;

  if (receipt.status === "failed") {
    const detail = receipt.detail.replace(/[\r\n]+/g, " ").trim().slice(0, 300);
    await env.EMAIL.send({
      from,
      to: email.from,
      subject: `Could not import: ${email.subject}`,
      text: `work-wiki could not finish processing your email.\n\n${detail || "Open Recent ingests in Settings for more detail."}`,
    });
    return;
  }

  const slug = typeof receipt.result?.slug === "string" ? receipt.result.slug : "";
  if (!slug) return;

  const site = (env.YOPEDIA_SITE_URL || env.YOPEDIA_URL || "").replace(/\/+$/, "");
  // The public commons URL `/wiki/<slug>` is retired (404). Workers cannot
  // import `src/lib`, so the owner-scoped form is inlined here: addressing a
  // page through the default tenant `yopedia` is safe because
  // `/u/[handle]/[slug]` 308-redirects a mismatched handle to the page's real
  // tenant (the same mechanism `slugPath()` relies on).
  const pageUrl = site ? `${site}/u/yopedia/${encodeURIComponent(slug)}` : slug;
  const attachmentNote = email.processedAttachmentCount
    ? `\n\n${email.processedAttachmentCount} supported attachment${email.processedAttachmentCount === 1 ? " was" : "s were"} included in the page.`
    : "";
  await env.EMAIL.send({
    from,
    to: email.from,
    subject: `Ready: ${email.subject}`,
    text: `work-wiki finished processing your email.\n\n${pageUrl}${attachmentNote}`,
  });
}

export default {
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    const token = env.YOPEDIA_SERVICE_TOKEN;
    const base = (env.YOPEDIA_URL ?? "").replace(/\/+$/, "");
    if (!base || !token) {
      // Misconfiguration — retry the whole batch so nothing is lost.
      console.error(
        "task-consumer: missing YOPEDIA_URL or YOPEDIA_SERVICE_TOKEN — retrying batch",
      );
      for (const m of batch.messages) m.retry();
      return;
    }

    // Sequential (not Promise.all): each task triggers an LLM call in the main
    // app; serial processing keeps us within provider rate limits.
    for (const message of batch.messages) {
      await runTask(env, message);
    }
  },

  // Autonomous-maintenance cron (Q2). POSTs the scanner. Only its `maintain`
  // tasks are gated on AUTONOMOUS_MAINTENANCE — they dry-run (logs only) while
  // the flag is off in the main app. The scan's other enqueues (`run-agent`,
  // `monitor-source`, digest/outbox delivery, backups) are gated on `?dry=1`
  // alone, so they fire on every tick regardless of the flag; see
  // `src/app/api/tasks/scan/route.ts`. Safe to schedule before enabling the
  // flag in the sense that no autonomous page edits happen — not in the sense
  // that the scan does nothing.
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const base = (env.YOPEDIA_URL ?? "").replace(/\/+$/, "");
    const token = env.YOPEDIA_SERVICE_TOKEN;
    if (!base || !token) {
      console.error("task-consumer cron: missing YOPEDIA binding/URL or service token");
      return;
    }
    try {
      const requestInit: RequestInit = {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      };
      const res = env.YOPEDIA
        ? await env.YOPEDIA.fetch(
            new Request(`${base}/api/tasks/scan`, requestInit),
          )
        : await fetch(`${base}/api/tasks/scan`, requestInit);
      const body = (await res.text().catch(() => "")).slice(0, 400);
      console.log(`task-consumer cron: scan → ${res.status} ${body}`);
    } catch (err) {
      console.error("task-consumer cron: scan failed", err);
    }
  },

  // Health check (no task triggering — not an open relay).
  async fetch(): Promise<Response> {
    return new Response("yopedia task-consumer ok\n", {
      headers: { "content-type": "text/plain" },
    });
  },
};
