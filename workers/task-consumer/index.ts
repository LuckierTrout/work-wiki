/**
 * yopedia agent task-queue consumer.
 *
 * A thin dispatcher: drains the `yopedia-tasks` Cloudflare Queue and POSTs each
 * message to the main yopedia app's `/api/tasks/run` endpoint with the system
 * token. The actual work (reconcile / ingest) runs in the main app, which has
 * the full `src/lib` + OpenNext request context. This worker imports NO `src/lib`
 * code — that would transitively pull Clerk/Next and the OpenNext context a
 * standalone worker can't provide.
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
    message.retry();
    return;
  }

  if (res.status >= 200 && res.status < 300) {
    const result = (await res.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    await notifyEmailCompletion(env, message.body, result).catch((error) =>
      console.error(`task-consumer: completion email failed for ${message.id}`, error),
    );
    message.ack();
    return;
  }
  if (res.status === 400 || res.status === 404 || res.status === 422) {
    // Permanently-bad task — don't retry it forever.
    const snip = (await res.text().catch(() => "")).slice(0, 200).replace(/\s+/g, " ");
    console.warn(`task-consumer: poison ${message.id} (${res.status}): ${snip}`);
    message.ack();
    return;
  }
  // Other 4xx (notably auth/rate-limit) and 5xx are operational/transient;
  // retry instead of silently dropping a valid task on configuration drift.
  console.warn(`task-consumer: transient ${message.id} (${res.status}) — retry`);
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

async function notifyEmailCompletion(
  env: Env,
  body: unknown,
  result: Record<string, unknown> | null,
): Promise<void> {
  const email = emailMetadata(body);
  const from = env.YOPEDIA_EMAIL_FROM;
  const slug = typeof result?.slug === "string" ? result.slug : "";
  if (!email || !env.EMAIL || !from || !slug) return;

  const site = (env.YOPEDIA_SITE_URL || env.YOPEDIA_URL || "").replace(/\/+$/, "");
  const pageUrl = site ? `${site}/wiki/${encodeURIComponent(slug)}` : slug;
  const attachmentNote = email.processedAttachmentCount
    ? `\n\n${email.processedAttachmentCount} supported attachment${email.processedAttachmentCount === 1 ? " was" : "s were"} included in the page.`
    : "";
  await env.EMAIL.send({
    from,
    to: email.from,
    subject: `Ready: ${email.subject}`,
    text: `Yopedia finished processing your email.\n\n${pageUrl}${attachmentNote}`,
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

  // Autonomous-maintenance cron (Q2). POSTs the scanner, which enqueues
  // `maintain` tasks — or dry-runs (logs only) when AUTONOMOUS_MAINTENANCE isn't
  // "on" in the main app. So this is safe to run on schedule before it's enabled.
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
