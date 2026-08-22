/**
 * Agent task queue — the producer side.
 *
 * A durable queue of asynchronous agent work (Cloudflare Queues). Producers in
 * the main app enqueue {@link Task}s; a thin consumer worker
 * (`workers/task-consumer/`) drains the queue and POSTs each task back to the
 * main app's `/api/tasks/run` endpoint, where it executes with the full lib +
 * OpenNext context. See `work-wiki-concept.md` / the task-queue plan.
 *
 * This module is the **producer**: `enqueueTask` sends to the `TASK_QUEUE`
 * binding when on the Workers runtime, and is a logged no-op off-Workers (local
 * dev, `next start`, vitest) — mirroring `getWorkersAiBinding` — so nothing
 * crashes where the binding is absent.
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { Queue } from "@cloudflare/workers-types";
import { logger } from "./logger";
import type { EmailIngestMetadata } from "./email-ingest";

/**
 * A unit of asynchronous agent work. Discriminated by `kind` so the executor
 * (`/api/tasks/run`) can dispatch. Keep payloads small (ids/slugs, not bodies) —
 * Cloudflare Queues caps a message at 128 KB.
 */
export type Task =
  | {
      /** Async ingestion. Every interactive/API ingest dispatches through this
       *  Task type (enqueued on Workers; run inline off-Workers via
       *  `enqueueOrInline`). Exactly ONE source: `url`, `content`, or `staged`
       *  (re-ingest is the exception — it runs synchronously, never enqueued). */
      kind: "ingest";
      url?: string;
      title?: string;
      content?: string;
      owner?: string;
      author?: string;
      tags?: string[];
      /** When set, the consumer records this async job's status (queued →
       *  processing → done/failed) so the UI can poll the outcome. */
      jobId?: string;
      /** URL-based PDF/image: routes the consumer to ingestPdf/ingestImage on the
       *  `url` (a plain `url` would go to ingestUrl). Uploaded bytes use `staged`. */
      source?: "pdf" | "image";
      /** Uploaded bytes (or oversized pasted text) staged to R2 first, since a
       *  queue message caps at 128 KB. The consumer reads the blob, ingests, then
       *  deletes it. `key` is the R2/storage-relative path; `kind` picks the
       *  ingest path. */
      staged?: {
        key: string;
        kind: "pdf" | "image" | "text" | "document";
        filename?: string;
        contentType?: string;
        /** Browser folder / Obsidian-vault relative path. */
        relativePath?: string;
      };
      /** Supported email attachments staged separately in R2. They may coexist
       *  with an inline/staged email body and are folded into the same page. */
      attachments?: Array<{
        key: string;
        filename: string;
        contentType?: string;
      }>;
      /** Optional vault to auto-file the resulting page into (fail-soft). */
      vaultId?: string;
      /** Agent ingests: the page `type` (scoped knowledge/identity), so the page
       *  stays out of the public commons/feed. */
      pageType?: "agent-knowledge" | "agent-identity";
      /** Provenance actor; when absent the executor falls back to `author`. Lets
       *  an agent ingest attribute `triggeredBy` to the human owner while `author`
       *  stays the agent. */
      triggeredBy?: string;
      /** Provenance URL for a text ingest (the original source link). */
      sourceUrl?: string;
      /** Explicit source classification (e.g. agent `asOwner` ingests set
       *  x-mention/url/text); when absent the pipeline derives it. Intentionally a
       *  SUBSET of `IngestOptions["sourceType"]` — image/pdf/youtube are set
       *  internally by the ingest functions, never carried over the queue. */
      sourceType?: "x-mention" | "url" | "text" | "email";
      /**
       * Folder-import relative path for an inline text ingest (Story 2.2).
       * Staged uploads already carry this on `staged.relativePath`; a small
       * folder file must not be forced through staging just to keep the path.
       */
      relativePath?: string;
      /** Inbound-email metadata used for owner-only activity and completion
       *  notifications. Attachment bytes are referenced through staged keys. */
      email?: EmailIngestMetadata;
      /** Agent id to attach the resulting page to as one of its learning pages
       *  (agent-scoped ingests). */
      learningFor?: string;
    }
  | {
      /** Extract owner-only action proposals from a newly ingested page. */
      kind: "extract-actions";
      slug: string;
      owner: string;
    }
  | {
      /** Derive source-linked structured records from an accepted page revision. */
      kind: "extract-knowledge";
      slug: string;
      owner: string;
      /** Whole-wiki Graphify job whose durable progress this page advances. */
      graphifyJobId?: string;
    }
  | {
      /** Run pass two: source contribution ledger + cross-page compilation.
       *  Any proposed page change is routed to Review, never written directly. */
      kind: "compile-knowledge";
      slug: string;
      owner: string;
    }
  | {
      /** Execute one owner-configured specialized agent. */
      kind: "run-agent";
      agentId: string;
      owner: string;
      trigger: "manual" | "after-ingest" | "daily" | "weekly";
      sourceSlug?: string;
      prompt?: string;
    }
  | {
      /** Execute a durable provider-backed deep-research project. */
      kind: "run-research";
      projectId: string;
      owner: string;
    }
  | {
      /** Check an owner-configured source monitor and create a review proposal
       *  when the source changed meaningfully. Never writes the page directly. */
      kind: "monitor-source";
      monitorId: string;
      owner: string;
    }
  | {
      /** Deliver one persisted source-monitor digest through the owner's
       *  configured email channel. The digest id is the idempotency key. */
      kind: "deliver-monitor-digest";
      digestId: string;
      owner: string;
    }
  | {
      /** Deliver one durable, idempotent integration-outbox event. */
      kind: "deliver-integration";
      outboxId: string;
      owner: string;
    }
  | {
      /** Snapshot one tenant and verify it through an isolated restore prefix. */
      kind: "create-backup";
      owner: string;
    }
  | {
      /** Autonomous maintenance, enqueued by the scan cron (Q2). `staleness`
       *  re-ingest an expired page from its source; `fix` apply a deterministic
       *  lint auto-fix (`lintType`). `lintType` is required for `fix`;
       *  `targetSlug` for `broken-link` (identifies which dead link to
       *  remove) and `missing-crossref` (identifies which page to link to). */
      kind: "maintain";
      op: "staleness" | "fix";
      slug: string;
      lintType?: MaintainFixType;
      /** The target slug for `broken-link` (dead link to remove) or
       *  `missing-crossref` (page that should be linked to). */
      targetSlug?: string;
    };

/**
 * Every top-level {@link Task} `kind`, as a runtime list.
 *
 * The union above is types-only, so nothing outside the type system can name
 * the set of kinds — and `workers/task-consumer/README.md` enumerates them in
 * prose. `prose-inventory-parity.test.ts` compares that prose (and
 * `parseTask`'s dispatch switch) against this list, which needs a runtime value
 * to compare against.
 *
 * NOT the nested `staged.kind` (pdf/image/text/document) — a different axis.
 *
 * The two assertions below pin this list to the union in both directions and
 * are enforced by CI's `pnpm exec tsc --noEmit`:
 *   - `satisfies readonly Task["kind"][]` rejects a kind that the union does
 *     not have (no extras);
 *   - `_NoTaskKindMissingFromList` resolves to `never` only while every union
 *     arm appears here, and a non-`never` residue fails `AssertNever` (no
 *     omissions).
 */
export const TASK_KINDS = [
  "ingest",
  "extract-actions",
  "extract-knowledge",
  "compile-knowledge",
  "run-agent",
  "run-research",
  "monitor-source",
  "deliver-monitor-digest",
  "deliver-integration",
  "create-backup",
  "maintain",
] as const satisfies readonly Task["kind"][];

export type TaskKind = (typeof TASK_KINDS)[number];

/** Compile-time `Exclude<…> === never` check; see {@link TASK_KINDS}. */
type AssertNever<T extends never> = T;
type _NoTaskKindMissingFromList = AssertNever<Exclude<Task["kind"], TaskKind>>;

/** Deterministic, no-LLM lint fixes the maintenance scan may auto-apply. */
export type MaintainFixType =
  | "unmigrated-page"
  | "stale-index"
  | "supersedes-dangling"
  | "broken-link"
  | "orphan-page"
  | "empty-page"
  | "missing-crossref"
  | "stale-page";

const MAINTAIN_FIX_TYPES = new Set<MaintainFixType>([
  "unmigrated-page",
  "stale-index",
  "supersedes-dangling",
  "broken-link",
  "orphan-page",
  "empty-page",
  "missing-crossref",
  "stale-page",
]);

/**
 * Resolve the `TASK_QUEUE` producer binding (matches `queues.producers[].binding`
 * in wrangler.jsonc), or `null` when it isn't available
 * (off the Workers runtime, or the binding isn't bound). `getCloudflareContext`
 * throws outside the OpenNext request scope — expected in dev/tests.
 */
function getTaskQueue(): Queue<Task> | null {
  let env: { TASK_QUEUE?: Queue<Task> };
  try {
    ({ env } = getCloudflareContext() as unknown as {
      env: { TASK_QUEUE?: Queue<Task> };
    });
  } catch {
    return null; // off-Workers — expected
  }
  const q = env.TASK_QUEUE;
  return q && typeof q.send === "function" ? q : null;
}

/**
 * Enqueue a task for asynchronous processing. Returns `true` when it was sent to
 * the queue, `false` when the queue is unavailable (off-Workers) — in which case
 * it's a logged no-op so callers (routes, dev, tests) never crash. Callers that
 * need the work to definitely happen should check the return value.
 */
export async function enqueueTask(task: Task): Promise<boolean> {
  const queue = getTaskQueue();
  if (!queue) {
    logger.info(
      "tasks",
      `TASK_QUEUE unavailable (off-Workers) — skipped enqueue of "${task.kind}"`,
    );
    return false;
  }
  await queue.send(task);
  logger.info("tasks", `enqueued task "${task.kind}"`);
  return true;
}

export interface EnqueueTasksResult {
  available: boolean;
  enqueued: number;
  error?: string;
}

/**
 * Enqueue many small tasks with Cloudflare's native batch API. A result records
 * exactly how many complete batches were accepted so callers can mark only the
 * unsent tail as failed and offer a targeted retry.
 */
export async function enqueueTasks(tasks: readonly Task[]): Promise<EnqueueTasksResult> {
  if (tasks.length === 0) return { available: true, enqueued: 0 };
  const queue = getTaskQueue();
  if (!queue) {
    logger.warn("tasks", `TASK_QUEUE unavailable — skipped batch of ${tasks.length}`);
    return { available: false, enqueued: 0 };
  }

  const batchSize = 100;
  let enqueued = 0;
  try {
    for (let offset = 0; offset < tasks.length; offset += batchSize) {
      const batch = tasks.slice(offset, offset + batchSize);
      await queue.sendBatch(batch.map((body) => ({ body })));
      enqueued += batch.length;
    }
    logger.info("tasks", `enqueued ${enqueued} task(s) in batch`);
    return { available: true, enqueued };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Queue batch failed";
    logger.error("tasks", `batch enqueue stopped after ${enqueued}/${tasks.length}`, error);
    return { available: true, enqueued, error: message };
  }
}

/**
 * Validate + narrow an untrusted JSON body into a {@link Task}, or `null` if it
 * isn't a well-formed task. Used by `/api/tasks/run` to reject malformed
 * messages as poison (4xx → DLQ) rather than retrying them forever.
 */
export function parseTask(body: unknown): Task | null {
  if (!body || typeof body !== "object") return null;
  const t = body as Record<string, unknown>;
  switch (t.kind) {
    case "ingest": {
      const hasUrl = typeof t.url === "string" && t.url.trim() !== "";
      const hasContent = typeof t.content === "string" && t.content.trim() !== "";
      // Validate a staged-upload descriptor: a non-empty key + an allowed kind.
      let staged: Extract<Task, { kind: "ingest" }>["staged"];
      if (t.staged && typeof t.staged === "object") {
        const s = t.staged as Record<string, unknown>;
        const kindOk =
          s.kind === "pdf" ||
          s.kind === "image" ||
          s.kind === "text" ||
          s.kind === "document";
        if (typeof s.key === "string" && s.key.trim() !== "" && kindOk) {
          staged = {
            key: s.key,
            kind: s.kind as "pdf" | "image" | "text" | "document",
            ...(typeof s.filename === "string" ? { filename: s.filename } : {}),
            ...(typeof s.contentType === "string"
              ? { contentType: s.contentType }
              : {}),
            ...(typeof s.relativePath === "string" && s.relativePath.trim()
              ? { relativePath: s.relativePath.slice(0, 1_000) }
              : {}),
          };
        }
      }
      // URL-based PDF/image carry an explicit source so the consumer routes to
      // ingestPdf/ingestImage rather than ingestUrl.
      const source =
        t.source === "pdf" || t.source === "image" ? t.source : undefined;
      let attachments: Extract<Task, { kind: "ingest" }>["attachments"];
      if (t.attachments !== undefined) {
        if (!Array.isArray(t.attachments) || t.attachments.length > 10) return null;
        attachments = [];
        for (const value of t.attachments) {
          if (!value || typeof value !== "object") return null;
          const attachment = value as Record<string, unknown>;
          if (
            typeof attachment.key !== "string" ||
            attachment.key.trim() === "" ||
            typeof attachment.filename !== "string" ||
            attachment.filename.trim() === ""
          ) return null;
          attachments.push({
            key: attachment.key,
            filename: attachment.filename,
            ...(typeof attachment.contentType === "string"
              ? { contentType: attachment.contentType }
              : {}),
          });
        }
        if (attachments.length === 0) attachments = undefined;
      }
      if (!hasUrl && !hasContent && !staged && !attachments) return null; // need a source
      // Reject incoherent combinations so the consumer's branch-order precedence
      // is an ENFORCED invariant, not a silent "first match wins". `staged` is
      // exclusive (it's its own source); `source` only qualifies a `url`.
      if (staged && (hasUrl || hasContent)) return null;
      if (source && !hasUrl) return null;
      const tags =
        Array.isArray(t.tags) && t.tags.every((x) => typeof x === "string")
          ? (t.tags as string[])
          : undefined;
      let email: EmailIngestMetadata | undefined;
      if (t.email && typeof t.email === "object") {
        const e = t.email as Record<string, unknown>;
        if (
          typeof e.from !== "string" ||
          typeof e.to !== "string" ||
          typeof e.subject !== "string" ||
          typeof e.messageId !== "string" ||
          !Array.isArray(e.attachmentNames) ||
          !e.attachmentNames.every((name) => typeof name === "string")
        ) {
          return null;
        }
        email = {
          from: e.from,
          to: e.to,
          subject: e.subject,
          messageId: e.messageId,
          attachmentNames: e.attachmentNames as string[],
        };
      }
      const sourceType =
        t.sourceType === "x-mention" ||
        t.sourceType === "url" ||
        t.sourceType === "text" ||
        t.sourceType === "email"
          ? t.sourceType
          : undefined;
      if ((sourceType === "email") !== Boolean(email)) return null;
      if (attachments && sourceType !== "email") return null;
      if (attachments && staged && staged.kind !== "text") return null;
      return {
        kind: "ingest",
        ...(hasUrl ? { url: t.url as string } : {}),
        ...(typeof t.title === "string" ? { title: t.title } : {}),
        ...(hasContent ? { content: t.content as string } : {}),
        ...(typeof t.owner === "string" ? { owner: t.owner } : {}),
        ...(typeof t.author === "string" ? { author: t.author } : {}),
        ...(tags && tags.length > 0 ? { tags } : {}),
        ...(typeof t.jobId === "string" ? { jobId: t.jobId } : {}),
        ...(source ? { source } : {}),
        ...(staged ? { staged } : {}),
        ...(attachments ? { attachments } : {}),
        ...(typeof t.vaultId === "string" && t.vaultId.trim() !== ""
          ? { vaultId: t.vaultId }
          : {}),
        ...(t.pageType === "agent-knowledge" || t.pageType === "agent-identity"
          ? { pageType: t.pageType }
          : {}),
        ...(typeof t.triggeredBy === "string" && t.triggeredBy.trim() !== ""
          ? { triggeredBy: t.triggeredBy }
          : {}),
        ...(typeof t.sourceUrl === "string" && t.sourceUrl.trim() !== ""
          ? { sourceUrl: t.sourceUrl }
          : {}),
        ...(typeof t.relativePath === "string" && t.relativePath.trim()
          ? { relativePath: t.relativePath.slice(0, 1_000) }
          : {}),
        ...(sourceType ? { sourceType } : {}),
        ...(email ? { email } : {}),
        ...(typeof t.learningFor === "string" && t.learningFor.trim() !== ""
          ? { learningFor: t.learningFor }
          : {}),
      };
    }
    case "maintain": {
      if (typeof t.slug !== "string" || t.slug.trim() === "") return null;
      if (t.op === "staleness") {
        return { kind: "maintain", op: "staleness", slug: t.slug };
      }
      // `fix` needs an allowed (deterministic) lint type.
      if (t.op === "fix") {
        if (!MAINTAIN_FIX_TYPES.has(t.lintType as MaintainFixType)) return null;
        const lintType = t.lintType as MaintainFixType;
        // `broken-link` additionally requires a targetSlug (which dead link to remove).
        // `missing-crossref` additionally requires a targetSlug (which page to link to).
        if (lintType === "broken-link" || lintType === "missing-crossref") {
          if (typeof t.targetSlug !== "string" || t.targetSlug.trim() === "") return null;
          return {
            kind: "maintain",
            op: "fix",
            slug: t.slug,
            lintType,
            targetSlug: t.targetSlug,
          };
        }
        return {
          kind: "maintain",
          op: "fix",
          slug: t.slug,
          lintType,
        };
      }
      return null;
    }
    case "extract-actions":
      if (
        typeof t.slug !== "string" ||
        t.slug.trim() === "" ||
        typeof t.owner !== "string" ||
        t.owner.trim() === ""
      ) {
        return null;
      }
      return {
        kind: "extract-actions",
        slug: t.slug,
        owner: t.owner,
      };
    case "extract-knowledge":
      if (
        typeof t.slug !== "string" ||
        t.slug.trim() === "" ||
        typeof t.owner !== "string" ||
        t.owner.trim() === ""
      ) {
        return null;
      }
      if (
        t.graphifyJobId !== undefined &&
        (typeof t.graphifyJobId !== "string" ||
          !/^graphify_[a-f0-9-]{36}$/i.test(t.graphifyJobId))
      ) {
        return null;
      }
      return {
        kind: "extract-knowledge",
        slug: t.slug,
        owner: t.owner,
        ...(typeof t.graphifyJobId === "string"
          ? { graphifyJobId: t.graphifyJobId }
          : {}),
      };
    case "compile-knowledge":
      if (
        typeof t.slug !== "string" ||
        t.slug.trim() === "" ||
        typeof t.owner !== "string" ||
        t.owner.trim() === ""
      ) {
        return null;
      }
      return { kind: "compile-knowledge", slug: t.slug, owner: t.owner };
    case "run-agent":
      if (
        typeof t.agentId !== "string" ||
        t.agentId.trim() === "" ||
        typeof t.owner !== "string" ||
        t.owner.trim() === "" ||
        (t.trigger !== "manual" &&
          t.trigger !== "after-ingest" &&
          t.trigger !== "daily" &&
          t.trigger !== "weekly")
      ) {
        return null;
      }
      return {
        kind: "run-agent",
        agentId: t.agentId,
        owner: t.owner,
        trigger: t.trigger,
        ...(typeof t.sourceSlug === "string" && t.sourceSlug.trim()
          ? { sourceSlug: t.sourceSlug }
          : {}),
        ...(typeof t.prompt === "string" && t.prompt.trim()
          ? { prompt: t.prompt.slice(0, 4_000) }
          : {}),
      };
    case "run-research":
      if (
        typeof t.projectId !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(t.projectId) ||
        typeof t.owner !== "string" ||
        t.owner.trim() === ""
      ) {
        return null;
      }
      return { kind: "run-research", projectId: t.projectId, owner: t.owner };
    case "monitor-source":
      if (
        typeof t.monitorId !== "string" ||
        !/^mon_[a-z0-9-]{8,80}$/i.test(t.monitorId) ||
        typeof t.owner !== "string" ||
        t.owner.trim() === ""
      ) {
        return null;
      }
      return {
        kind: "monitor-source",
        monitorId: t.monitorId,
        owner: t.owner,
      };
    case "deliver-monitor-digest":
      if (
        typeof t.digestId !== "string" ||
        !/^mdg_[a-f0-9]{16}$/.test(t.digestId) ||
        typeof t.owner !== "string" ||
        t.owner.trim() === ""
      ) {
        return null;
      }
      return {
        kind: "deliver-monitor-digest",
        digestId: t.digestId,
        owner: t.owner,
      };
    case "deliver-integration":
      if (
        typeof t.outboxId !== "string" ||
        !/^out_[a-f0-9]{16,128}$/i.test(t.outboxId) ||
        typeof t.owner !== "string" ||
        t.owner.trim() === ""
      ) {
        return null;
      }
      return { kind: "deliver-integration", outboxId: t.outboxId, owner: t.owner };
    case "create-backup":
      if (typeof t.owner !== "string" || t.owner.trim() === "") return null;
      return { kind: "create-backup", owner: t.owner };
    default:
      return null;
  }
}
