/**
 * The one place an extract-required arrival is turned into work, and the one
 * place extracted text is turned back into an Ingest (Story 7.1).
 *
 * FOUR DOORS FEED THIS: the Workbench drop, inbound email, a Plaud pull and the
 * vault's document/PDF upload. Before Epic 7 three of them parsed binaries
 * inline on the Worker and the fourth refused them outright, which is exactly
 * the parallel-write-path drift `.yoyo/learnings.md` warns about — four copies
 * of "store the bytes, get some text, start a compile" that were already
 * disagreeing about which formats existed. So the sequence lives here once and
 * every door calls it.
 *
 * THE ORDER IS THE CONTRACT:
 *
 *   1. bytes → `raw/sources/<slug>/<sha256>.<ext>`, immutable, first-write-only;
 *   2. an ingest job, created `queued` under `kind: "extract"` so Activity shows
 *      `Extract` and nothing enqueues a compile for text that does not exist;
 *   3. an extract record the sidecar can claim.
 *
 * Step 1 happening first is what makes "the Source survives a failed extract"
 * structural rather than a promise: every failure path below this line marks
 * jobs, never deletes bytes.
 */

import { getErrorMessage } from "./errors";
import { ingest, type IngestOptions } from "./ingest";
import { enqueueOrInline } from "./ingest-async";
import { createIngestJob, getIngestJob, updateIngestJob } from "./ingest-jobs";
import { logger } from "./logger";
import {
  saveParsedMarkdown,
  saveRawSourceBytes,
  saveRawSourceFor,
} from "./raw";
import { workbenchSourcePath } from "./source-delete";
import { setSourceMeeting } from "./source-meeting";
import {
  claimExtractJob,
  completeExtractJob,
  createExtractJob,
  failExtractJob,
  findExtractJobForIngest,
  getExtractJob,
  requeueExtractJob,
  EXTRACT_EMPTY_TEXT_COPY,
  EXTRACT_SIDECAR_DOWN_COPY,
  type ExtractJob,
} from "./extract-jobs";
import { isExtractPollerLive } from "./extract-heartbeat";
import { type ExtractSourceType, type Task } from "./tasks";
import type { IntakeExtractFormat } from "./workbench-intake";

/** Queue-message cap headroom — matches the Intake door's own inline limit. */
const MAX_INLINE_CONTENT_CHARS = 96000;

export interface EnqueueExtractInput {
  owner: string;
  actor?: string;
  /** `raw/sources/<slug>/` segment, already slugified by the calling door. */
  slug: string;
  /** SHA-256 hex of the raw bytes. Doubles as the stored id and the cache key. */
  bytesSha256: string;
  /** Lower-case extension the bytes are stored under (`pdf`, `docx`, …). */
  ext: string;
  format: IntakeExtractFormat;
  filename: string;
  title: string;
  bytes: ArrayBuffer;
  sourceUrl?: string;
  origin?: "plaud";
  /** Inbound-email provenance, carried onto the ingest job for Activity. */
  email?: import("./email-ingest").EmailIngestMetadata;
  /** Vault the vault door filed this upload into. Applied after extract. */
  vaultId?: string;
  /** Tags the arriving door was given. Applied after extract. */
  tags?: string[];
  /**
   * Reuse an ingest job that already exists instead of minting one.
   *
   * Only the queue consumer passes this, and only for a task that was enqueued
   * by an older build which still staged a binary for Worker-side parsing. The
   * owner is already watching that row in Activity; minting a second job would
   * leave the one they can see stuck at `extracting` forever while a row they
   * never asked for did the work.
   */
  ingestJobId?: string;
}

export interface EnqueueExtractResult {
  /** Workbench path of the stored bytes. Present even when queueing failed. */
  path: string;
  jobId: string;
  extractId: string;
  /** False when the bytes were already stored under this exact key. */
  storedBytes: boolean;
  /** Set when the bytes landed but the job records could not be written. */
  error?: string;
  /**
   * No sidecar had polled recently, so the record was failed closed with
   * {@link EXTRACT_SIDECAR_DOWN_COPY}. The bytes are still stored, and the
   * record is re-offered the moment a poller comes back.
   */
  sidecarDown?: boolean;
}

/**
 * Store one binary arrival and park a compile behind a sidecar extract job.
 *
 * Never throws for a queueing failure: by the time that could happen the bytes
 * are already in the vault, and reporting a total failure would tell the
 * caller to re-poll nothing while a Source it cannot see sits on disk. The
 * caller reads `error` and answers 202.
 */
export async function enqueueExtract(
  input: EnqueueExtractInput,
): Promise<EnqueueExtractResult> {
  const stored = await saveRawSourceBytes(
    input.slug,
    input.bytesSha256,
    input.ext,
    input.bytes,
    // The owner's silo is the ONLY place the Files tree and the media door look
    // for a `raw/` key (DW-40); a Source stored flat-only is invisible in both.
    { owner: input.owner },
  );
  const path = workbenchSourcePath(stored.path) ?? stored.path;

  const jobId = input.ingestJobId ?? crypto.randomUUID();
  const extractId = crypto.randomUUID();
  try {
    const record = {
      owner: input.owner,
      title: input.title,
      kind: "extract" as const,
      // `extracting` is the durable stage for "text does not exist yet". The
      // row WORD comes from the kind, not from this — see `activityDisplayStatus`.
      stage: "extracting" as const,
      sourceRel: path,
      sourceType: "text" as const,
      contentSha256: input.bytesSha256,
      ...(input.sourceUrl ? { url: input.sourceUrl } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.email ? { source: "email" as const, email: input.email } : {}),
    };
    if (input.ingestJobId) {
      await updateIngestJob(jobId, { ...record, status: "queued", error: "" });
    } else {
      await createIngestJob({ jobId, ...record });
    }
    await createExtractJob({
      extractId,
      owner: input.owner,
      ...(input.actor !== undefined ? { actor: input.actor } : {}),
      sourceRel: path,
      slug: input.slug,
      storageKey: stored.rel,
      filename: input.filename,
      format: input.format,
      bytesSha256: input.bytesSha256,
      size: input.bytes.byteLength,
      ingestJobId: jobId,
      title: input.title,
      ...(input.vaultId ? { vaultId: input.vaultId } : {}),
      ...(input.tags?.length ? { tags: input.tags } : {}),
    });
  } catch (error) {
    const message = getErrorMessage(error);
    logger.error(
      "extract",
      `stored "${path}" but could not queue extract`,
      error,
    );
    return {
      path,
      jobId,
      extractId,
      storedBytes: stored.created,
      error: message,
    };
  }

  // FAIL CLOSED, AFTER the records exist. Checking first and skipping the
  // write would leave the arrival with nothing for Activity to show, which is
  // the silent drop this epic forbids; failing a record that is already on
  // disk gives the owner a row, the locked sentence, and a Source they can
  // re-drive when they start the sidecar.
  if (!(await isExtractPollerLive(input.owner))) {
    await failExtract({
      extractId,
      owner: input.owner,
      error: EXTRACT_SIDECAR_DOWN_COPY,
    }).catch((error) =>
      logger.warn("extract", `could not fail ${extractId} closed`, error),
    );
    return {
      path,
      jobId,
      extractId,
      storedBytes: stored.created,
      sidecarDown: true,
    };
  }

  return { path, jobId, extractId, storedBytes: stored.created };
}

/**
 * Claim a record for a poller, and put the owner's row back in `Extract`.
 *
 * The second half is what {@link claimExtractJob} on its own cannot do. A
 * record failed closed for a sidecar that was down also marked the INGEST job
 * failed, because that is the record Activity reads — so a sidecar starting up
 * and draining the backlog would otherwise leave every revived row showing the
 * stale sentence while its document was actively being parsed.
 */
export async function claimExtract(
  extractId: string,
  owner: string,
): Promise<ExtractJob | null> {
  const job = await claimExtractJob(extractId, owner);
  if (!job) return null;
  await updateIngestJob(job.ingestJobId, {
    kind: "extract",
    stage: "extracting",
    status: "queued",
    error: "",
  }).catch((error) =>
    logger.warn(
      "extract",
      `claimed ${extractId} but could not revive ingest job ${job.ingestJobId}`,
      error,
    ),
  );
  return job;
}

/**
 * Re-offer the extract behind one Activity row, for the owner's Retry button.
 *
 * WHY THIS EXISTS AT ALL. Retry's generic path reads the stored Source with
 * `readFile` and hands the string to `ingest` — correct for the text arrivals
 * it was written for, and wrong in a way that is hard to see for a binary:
 * `readFile` DECODES UTF-8, so retrying a failed PDF compiled a page of
 * replacement characters instead of re-running the extract. The bytes are
 * already stored and the record still names them, so the retry is a re-offer,
 * not a re-upload.
 *
 * Returns `false` when there is no extract record to re-offer, which is the
 * caller's signal to refuse rather than to fall through to the text path.
 */
export async function retryExtract(
  owner: string,
  ingestJobId: string,
): Promise<boolean> {
  const record = await findExtractJobForIngest(owner, ingestJobId);
  if (!record) return false;
  const requeued = await requeueExtractJob(record.extractId, owner);
  if (!requeued) return false;
  // The ingest job goes back to what an arrival looks like: `extract` kind, so
  // Activity says `Extract` rather than `Analysis` for a document nothing has
  // analysed yet, and `queued`, so the row is live again.
  await updateIngestJob(ingestJobId, {
    kind: "extract",
    stage: "extracting",
    status: "queued",
    error: "",
  }).catch((error) =>
    logger.warn("extract", `re-offered ${record.extractId} but could not revive its row`, error),
  );
  return true;
}

/**
 * The extract record's stored format, as a provenance type the compile takes.
 *
 * {@link ExtractJob.format} is a plain `string` on the record — it is whatever
 * the arriving door wrote — so it is checked rather than cast. Anything
 * unrecognised falls back to `text`, which is what this path did for every
 * format before: a widened door produces vaguer provenance, never a task the
 * queue validator silently drops.
 */
function extractSourceType(format: string): ExtractSourceType | "text" {
  return Object.prototype.hasOwnProperty.call(EXTRACT_SOURCE_TYPES, format)
    ? (format as ExtractSourceType)
    : "text";
}

const EXTRACT_SOURCE_TYPES: Record<ExtractSourceType, true> = {
  pdf: true,
  docx: true,
  pptx: true,
  xlsx: true,
  xls: true,
  ods: true,
  epub: true,
  mobi: true,
};

export interface CompleteExtractInput {
  extractId: string;
  owner: string;
  /** The Markdown the sidecar produced. */
  text: string;
  /** The sidecar served this from its own parse cache rather than re-parsing. */
  cacheHit?: boolean;
  /** Keep a copy under `raw/parsed/` (the Intake pane's checkbox). */
  keepParsed?: boolean;
}

export type CompleteExtractResult =
  | { ok: true; job: ExtractJob; textRel: string; queued: boolean }
  | { ok: false; reason: "not-found" | "empty" | "wrong-state" };

/**
 * Write extracted text into the kernel and start the two-step Ingest.
 *
 * The text lands at `raw/sources/<slug>/<sha256>.md` — beside the bytes it came
 * from, keyed on the same hash — so a Source is one identity with two
 * representations rather than two Sources that happen to be related.
 *
 * EMPTY TEXT IS A FAILURE, not a compile of nothing: a PDF whose built-in
 * extract found no glyphs is exactly the "complex layout" case MinerU exists
 * for, and silently compiling an empty page would hide it.
 */
export async function completeExtract(
  input: CompleteExtractInput,
): Promise<CompleteExtractResult> {
  const job = await getExtractJob(input.extractId);
  if (!job || job.owner !== input.owner) return { ok: false, reason: "not-found" };
  if (job.status === "done") return { ok: false, reason: "wrong-state" };

  const text = input.text.trim();
  if (!text) {
    // FAILED, not merely refused. The record was `claimed` when this arrived,
    // and returning without touching it left the row saying `Extract` forever:
    // a claimed record is not claimable again until its TTL expires, so the
    // owner watched a document that had already finished failing. The sentence
    // names the case MinerU exists for, which is the next thing they can do.
    await failExtract({
      extractId: input.extractId,
      owner: input.owner,
      error: EXTRACT_EMPTY_TEXT_COPY,
    }).catch((error) =>
      logger.warn("extract", `could not fail ${input.extractId} on empty text`, error),
    );
    return { ok: false, reason: "empty" };
  }

  const storedPath = await saveRawSourceFor(
    job.slug,
    job.bytesSha256,
    text,
    { owner: job.owner },
  );
  const textPath = workbenchSourcePath(storedPath) ?? storedPath;
  if (input.keepParsed) {
    await saveParsedMarkdown(job.slug, job.bytesSha256, text);
  }

  await completeExtractJob(input.extractId, input.owner, {
    textRel: textPath,
    ...(input.cacheHit ? { cacheHit: true } : {}),
  });

  // The compile is enqueued against the TEXT path, and only now — this line is
  // the acceptance criterion "two-step Ingest started only after that text
  // existed" expressed as code.
  await updateIngestJob(job.ingestJobId, {
    kind: "ingest",
    stage: "queued",
    status: "queued",
    sourceRel: textPath,
    error: "",
  });

  // PROVENANCE THE COMPLETING DOOR IS THE LAST TO KNOW. `sourceType: "text"`
  // was landing every extracted document in the ledger and in `sources[]` as a
  // paste: an emailed contract and a typed note were indistinguishable a week
  // later. The arriving door's email metadata lives on the ingest job, and the
  // format lives on the extract record, so both are read back here.
  const arrival = await getIngestJob(job.ingestJobId).catch(() => null);
  const email = arrival?.email;
  // `email` WINS over the format, and must: `tasks.ts` refuses a task whose
  // `sourceType` is `email` without the metadata or vice versa, and "this came
  // from the inbox" is the more useful of the two facts. The format is not lost
  // — the stored Source still has its extension, and the page still cites it.
  const sourceType = email ? ("email" as const) : extractSourceType(job.format);

  const options: IngestOptions = {
    owner: job.owner,
    author: job.actor ?? job.owner,
    triggeredBy: job.actor ?? job.owner,
    sourceType,
    contentSha256: job.bytesSha256,
    sourcePath: textPath,
    jobId: job.ingestJobId,
    ...(job.tags?.length ? { tags: job.tags } : {}),
  };

  const base = {
    kind: "ingest" as const,
    title: job.title,
    owner: job.owner,
    author: job.actor ?? job.owner,
    triggeredBy: job.actor ?? job.owner,
    sourceType,
    contentSha256: job.bytesSha256,
    sourcePath: textPath,
    jobId: job.ingestJobId,
    ...(email ? { email } : {}),
    ...(job.vaultId ? { vaultId: job.vaultId } : {}),
    ...(job.tags?.length ? { tags: job.tags } : {}),
  };
  const task: Task =
    text.length <= MAX_INLINE_CONTENT_CHARS
      ? { ...base, content: text }
      : base;

  let queued = false;
  try {
    const response = await enqueueOrInline(job.ingestJobId, task, async () => {
      const result = await ingest(job.title, text, options);
      // The INLINE arm has to do the vault filing itself: `vaultId` on the
      // task is read by the queue consumer, and off-Workers there is no queue
      // consumer. Best-effort, exactly as the vault doors do it — a filing
      // that failed must not lose a Page that was written.
      if (job.vaultId) {
        const { addToVault } = await import("./vault");
        await addToVault(job.vaultId, result.primarySlug).catch((error) =>
          logger.warn("extract", `vault filing failed: ${getErrorMessage(error)}`),
        );
      }
      return result;
    });
    queued = response.ok;
  } catch (error) {
    logger.error(
      "extract",
      `extracted "${job.sourceRel}" but could not queue Ingest`,
      error,
    );
    await updateIngestJob(job.ingestJobId, {
      status: "failed",
      error: getErrorMessage(error),
    });
  }

  return { ok: true, job, textRel: textPath, queued };
}

/**
 * Record that extract could not produce text, on BOTH records.
 *
 * The extract record is the sidecar's view and the ingest job is the owner's,
 * and the reason has to reach the second one or Activity shows a row that
 * simply stops moving. The message travels verbatim — the sidecar-down
 * sentence, a corrupt-DOCX message from the crate, a MinerU timeout.
 */
export async function failExtract(input: {
  extractId: string;
  owner: string;
  error: string;
}): Promise<ExtractJob | null> {
  const job = await failExtractJob(input.extractId, input.owner, input.error);
  if (!job) return null;
  await updateIngestJob(job.ingestJobId, {
    status: "failed",
    error: input.error,
  }).catch((error) =>
    logger.warn(
      "extract",
      `could not mark ingest job ${job.ingestJobId} failed`,
      error,
    ),
  );
  return job;
}

/**
 * Plaud-origin arrivals stay meeting-eligible after an extract hop.
 *
 * Story 7.6 pulls transcripts as text, so this is only reached when a Plaud
 * recording arrives as a binary — but Epic 4's rule is about the SOURCE, not
 * about which door it came through, and losing the flag on the extract path
 * would silently drop Todo Candidates for exactly one kind of arrival.
 */
export async function rememberExtractMeeting(
  owner: string,
  sourcePath: string,
  origin?: "plaud",
): Promise<void> {
  if (origin !== "plaud") return;
  await setSourceMeeting(owner, sourcePath, true).catch((error) => {
    logger.warn("extract", `plaud meeting flag failed for "${sourcePath}"`, error);
  });
}
