/**
 * Enqueue embed-all when vector search turns on (Story 2.9).
 *
 * Same ingest Task + job record — not a second queue. Progress rides the
 * Activity row.
 */

import { enqueueOrInline } from "./ingest-async";
import { createIngestJob, updateIngestJob } from "./ingest-jobs";
import { getErrorMessage } from "./errors";
import { ACTIVITY_EMBED_TITLE } from "./workbench-activity";
import { logger } from "./logger";

export async function enqueueEmbeddingBackfill(owner: string): Promise<string> {
  const jobId = crypto.randomUUID();
  await createIngestJob({
    jobId,
    owner,
    title: ACTIVITY_EMBED_TITLE,
    kind: "embed",
  });
  try {
    await enqueueOrInline(
      jobId,
      {
        kind: "ingest",
        owner,
        jobId,
        rebuildEmbeddings: true,
        title: ACTIVITY_EMBED_TITLE,
      },
      async () => {
        const { rebuildVectorStore } = await import("./embeddings");
        await rebuildVectorStore(async (done, total) => {
          await updateIngestJob(jobId, {
            progressDone: done,
            progressTotal: total,
            stage: "indexing",
          });
        });
        return { primarySlug: "" };
      },
    );
  } catch (error) {
    const message = getErrorMessage(error);
    await updateIngestJob(jobId, { status: "failed", error: message }).catch((writeErr) =>
      logger.warn("ingest-embed", "failed to mark embed job failed", writeErr),
    );
    logger.warn("ingest-embed", "embed backfill enqueue failed", error);
  }
  return jobId;
}
