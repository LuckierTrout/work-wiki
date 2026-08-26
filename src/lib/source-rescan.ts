/**
 * Re-drive Ingest for Sources that are already on disk (Story 8.2).
 *
 * WHAT "RESCAN" IS: FR-2 says a Source's bytes are immutable and arrival
 * auto-queues a compile. So the only thing left for an external caller to ask
 * for is "compile these again" — after a template change, after a provider that
 * was down, after a compile that failed. It is NOT a re-upload and it never
 * touches stored bytes.
 *
 * WHAT IT IS NOT: it does not decide whether a Source is stale. `ingest()`
 * already dedupes by content digest and answers `deduped` for a Source whose
 * page is current, so a rescan of an unchanged Source is cheap and honest by
 * construction. A second staleness rule here would be a second opinion about
 * the same fact, and the pipeline's is the one that writes pages.
 *
 * BOUNDED, and the bound is visible: at most {@link RESCAN_MAX_SOURCES} per
 * call, with `remaining` reported so a caller draining a large tree knows to
 * call again rather than assuming it is finished.
 */

import { getErrorMessage } from "./errors";
import { abandonFreshIngestJob, createIngestJob } from "./ingest-jobs";
import { logger } from "./logger";
import { sourceSha256 } from "./source-sha256";
import { deleteStaged, stageText } from "./ingest-staging";
import { enqueueTask } from "./tasks";
import type { Task } from "./tasks";
import { isV1TextPath } from "./v1-contract";
import { listRawSourceFilePaths, readWorkbenchFile } from "./workbench-files";

/** One call's ceiling. A caller with more Sources calls again. */
export const RESCAN_MAX_SOURCES = 25;

/**
 * Above this the text is staged to storage instead of riding in the queue
 * message, the same threshold `/api/workbench/intake` uses for a large paste.
 */
const MAX_INLINE_CONTENT_CHARS = 96_000;

export interface SourceRescanOutcome {
  path: string;
  queued: boolean;
  jobId?: string;
  /** Present only when `queued` is false, and always a reason, never a guess. */
  reason?: string;
}

export interface SourceRescanResult {
  /** Candidates this call considered, after scoping and the cap. */
  requested: number;
  results: SourceRescanOutcome[];
  /** Candidates the cap left for the next call. */
  remaining: number;
  /** Offset for the next call, or null when this page finished the tree. */
  nextCursor: number | null;
}

export async function rescanSources(input: {
  owner: string;
  wikiId: string | null;
  readableSlugs: ReadonlySet<string>;
  /** Explicit display paths, or absent for "every Source in the tree". */
  paths?: readonly string[];
  limit?: number;
  cursor?: number;
}): Promise<SourceRescanResult> {
  const cap = Math.min(
    RESCAN_MAX_SOURCES,
    Math.max(1, Math.round(input.limit ?? RESCAN_MAX_SOURCES)),
  );
  const offset = Math.max(0, Math.round(input.cursor ?? 0));
  let batch: string[];
  let remaining: number;
  let nextCursor: number | null;
  if (input.paths !== undefined) {
    const all = [...input.paths];
    batch = all.slice(offset, offset + cap);
    const consumed = offset + batch.length;
    remaining = Math.max(0, all.length - consumed);
    nextCursor = consumed < all.length ? consumed : null;
  } else {
    // Implicit rescan pages `raw/sources/**` itself. The Files tab listing
    // spends its cap on `wiki/` and directory nodes and then reports no
    // cursor, which orphaned every Source past the first 5,000 tree entries.
    const page = await listRawSourceFilePaths(input.owner, {
      offset,
      limit: cap,
      allow: isV1TextPath,
    });
    batch = page.paths;
    remaining = page.remaining;
    nextCursor =
      page.more && page.paths.length > 0 ? offset + page.paths.length : null;
  }
  const results: SourceRescanOutcome[] = [];

  for (const path of batch) {
    // READ THROUGH THE SAME GATE as `files/content`. An explicit `paths` list
    // from the caller has to clear the read gate exactly as a listed path does,
    // or the rescan door would be a way to compile something unreadable.
    let text: string | null = null;
    try {
      const file = await readWorkbenchFile(input.owner, input.wikiId, path, {
        readableSlugs: input.readableSlugs,
      });
      text = file?.content ?? null;
    } catch (error) {
      logger.warn("rescan", `could not read "${path}"`, error);
    }
    if (text === null) {
      results.push({ path, queued: false, reason: "not_found" });
      continue;
    }
    if (!text.trim()) {
      // An empty Source has nothing to compile, and running two LLM calls to
      // discover that is the expensive way to answer it.
      results.push({ path, queued: false, reason: "empty" });
      continue;
    }

    const jobId = crypto.randomUUID();
    const title = path.split("/").pop() ?? path;
    let stagedKey: string | undefined;
    try {
      const digest = await sourceSha256(text);
      await createIngestJob({
        jobId,
        owner: input.owner,
        title,
        sourceRel: path,
        sourceType: "text",
        contentSha256: digest,
        ...(input.wikiId ? { wikiId: input.wikiId } : {}),
      });
      const base = {
        kind: "ingest" as const,
        title,
        owner: input.owner,
        author: input.owner,
        triggeredBy: input.owner,
        // `text`, because the bytes on disk ARE text by the time a rescan can
        // read them — a PDF reaches `raw/` as a PDF and only becomes text after
        // the extract loop wrote the parsed markdown this path points at.
        sourceType: "text" as const,
        contentSha256: digest,
        sourcePath: path,
        jobId,
      };
      const task: Task =
        text.length <= MAX_INLINE_CONTENT_CHARS
          ? { ...base, content: text }
          : { ...base, staged: { key: await stageText(jobId, text), kind: "text" } };
      if ("staged" in task && task.staged) stagedKey = task.staged.key;
      // ENQUEUE ONLY, never inline. A rescan of twenty-five Sources that ran the
      // compiles in-band would hold one HTTP request open across fifty LLM
      // calls; off-Workers, `enqueueTask` answers false and this reports
      // `queue_unavailable` rather than pretending the work is scheduled.
      const enqueued = await enqueueTask(task);
      if (!enqueued) {
        if (stagedKey) await deleteStaged(stagedKey).catch(() => {});
        await abandonFreshIngestJob(jobId, input.owner).catch(() => {});
        results.push({ path, queued: false, reason: "queue_unavailable" });
        continue;
      }
      results.push({ path, queued: true, jobId });
    } catch (error) {
      if (stagedKey) await deleteStaged(stagedKey).catch(() => {});
      await abandonFreshIngestJob(jobId, input.owner).catch(() => {});
      logger.error("rescan", `could not queue Ingest for "${path}"`, error);
      results.push({ path, queued: false, reason: getErrorMessage(error) });
    }
  }

  return {
    requested: batch.length,
    results,
    remaining,
    nextCursor,
  };
}
