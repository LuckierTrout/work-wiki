/**
 * Extract jobs — the kernel half of the sidecar extract path (Story 7.1).
 *
 * THE WORKER NEVER PARSES A BINARY. It cannot reach `127.0.0.1`, and the Rust
 * extractors live on the owner's machine, so extract cannot be an inline step
 * inside `/api/tasks/run`. Instead the arrival door stores the raw bytes first
 * and enqueues one of these records; the sidecar polls `/api/extract/jobs`,
 * claims a record, fetches the bytes, runs the crate, and POSTs the extracted
 * text back. Only then does two-step Ingest start.
 *
 * A record here is NOT a second vault: it holds an owner, the storage key the
 * bytes already occupy, and the ingest job that is waiting on the text. The
 * bytes stay where Intake put them whatever happens to this record — a failed
 * extract loses the compile, never the Source.
 *
 * Shaped after `./ingest-jobs`: one JSON file per job, owner-stamped, claimed
 * through a compare-and-swap so two sidecars (or one sidecar polling twice)
 * cannot both run the same document.
 */

import { getStorage } from "./storage";
import { isEnoent } from "./errors";
import { withFileLock } from "./lock";
import { logger } from "./logger";

/**
 * What Activity shows when extract could not run because nothing was listening
 * on the loopback port.
 *
 * CHARACTER-LOCKED by the spec and pinned by `extract-jobs.test.ts`: the owner
 * is told which half of the system is missing, because the fix ("start the
 * sidecar") is theirs to make and no other sentence names it.
 */
export const EXTRACT_SIDECAR_DOWN_COPY =
  "Extract is unavailable — the sidecar is down.";

/** The Source bytes survived; only the compile did not. Shown beside a failure. */
export const EXTRACT_BYTES_KEPT_COPY = "The stored source was kept.";

/**
 * What a record is failed with when the extractor produced nothing.
 *
 * A PDF whose text layer is empty is the complex-layout case MinerU exists
 * for, so the sentence points at the setting rather than merely reporting that
 * something was empty.
 */
export const EXTRACT_EMPTY_TEXT_COPY =
  "Extract produced no text. For a scanned or complex PDF, try MinerU in Settings.";

/** A binary arrived that no extractor in the sidecar crate can read. */
export function extractUnsupportedCopy(label: string): string {
  return `${label} could not be extracted.`;
}

export type ExtractJobStatus = "queued" | "claimed" | "done" | "failed";

/**
 * How long a claim is honoured before the record is offered again.
 *
 * A sidecar that is killed mid-parse never writes a terminal status, and the
 * owner would otherwise be left with a Source that says "Extract" forever.
 * Generous enough for a large PDF on a busy laptop.
 */
export const EXTRACT_CLAIM_TTL_MS = 10 * 60 * 1000;

/** Terminal records are garbage-collected on the same schedule as ingest jobs. */
export const EXTRACT_JOB_GC_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ExtractJob {
  extractId: string;
  /** The handle whose Source this is. Only they (or the service token) may act. */
  owner: string;
  status: ExtractJobStatus;
  /** Workbench path of the stored bytes, e.g. `raw/sources/plan/<sha>.pdf`. */
  sourceRel: string;
  /**
   * The `raw/sources/<slug>/` segment the bytes live under.
   *
   * Carried rather than re-parsed out of {@link sourceRel}: the completion door
   * writes the extracted Markdown to `<slug>/<bytesSha256>.md`, and deriving a
   * write path by string-splitting a stored path is how a traversal gets in.
   */
  slug: string;
  /** Storage-relative key the bytes actually occupy (what `readAsset` takes). */
  storageKey: string;
  /** Original filename, so the extractor can pick a parser by extension. */
  filename: string;
  /** The document format the Intake door recognised (`pdf`, `docx`, …). */
  format: string;
  /**
   * SHA-256 of the RAW BYTES, and the key the extract crate caches under.
   *
   * The cache itself is the Rust binary's — `sidecar/extract/src/main.rs`
   * reads and writes `<cache-dir>/<sha>.md` — not the claim loop's, which only
   * passes the directory down. Named here because this is where the digest is
   * computed: the crate is handed the kernel's hash rather than hashing the
   * bytes again, so the two cannot disagree about what "the same document" is.
   */
  bytesSha256: string;
  /** Byte length, so a poller can skip something it cannot hold in memory. */
  size: number;
  /** The ingest job parked in `extracting` until this record goes terminal. */
  ingestJobId: string;
  /** Display title carried through to Activity. */
  title: string;
  /**
   * Compile options the ARRIVING door knew and the completing door cannot
   * rediscover: the vault the upload was filed into, the tags typed beside it.
   *
   * Parked on the record rather than on the ingest job because the ingest job
   * is rewritten when the text lands, and a door that dropped them would turn
   * "file this PDF into my vault" into "store this PDF" with nothing saying so.
   */
  vaultId?: string;
  tags?: string[];
  /** Where the extracted text landed, once `done`. */
  textRel?: string;
  /** Failure reason, once `failed`. Verbatim in Activity. */
  error?: string;
  /** Set when the sidecar reported it served the text from its parse cache. */
  cacheHit?: boolean;
  /** How many times this record has been claimed. */
  attempts: number;
  claimedAt?: string;
  createdAt: string;
  updatedAt: string;
}

const JOBS_PREFIX = "extract-jobs";

/** ids are UUIDs; reject anything else so a crafted id cannot escape the prefix. */
function relPathFor(extractId: string): string {
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(extractId)) {
    throw new Error(`invalid extract job id: ${extractId}`);
  }
  return `${JOBS_PREFIX}/${extractId}.json`;
}

export interface CreateExtractJobInput {
  extractId: string;
  owner: string;
  sourceRel: string;
  slug: string;
  storageKey: string;
  filename: string;
  format: string;
  bytesSha256: string;
  size: number;
  ingestJobId: string;
  title: string;
  vaultId?: string;
  tags?: string[];
}

export async function createExtractJob(
  input: CreateExtractJobInput,
): Promise<ExtractJob> {
  const now = new Date().toISOString();
  const job: ExtractJob = {
    ...input,
    status: "queued",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
  await getStorage().writeFile(relPathFor(input.extractId), JSON.stringify(job));
  return job;
}

export async function getExtractJob(
  extractId: string,
): Promise<ExtractJob | null> {
  try {
    const raw = await getStorage().readFile(relPathFor(extractId));
    return JSON.parse(raw) as ExtractJob;
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

/**
 * Has this claim expired?
 *
 * Read-side rather than a sweeper: the only reader that cares is the next
 * claim attempt, and a record nobody is polling for does not need reviving.
 */
export function isClaimExpired(job: ExtractJob, now = Date.now()): boolean {
  if (job.status !== "claimed") return false;
  const claimedAt = Date.parse(job.claimedAt ?? job.updatedAt);
  return Number.isFinite(claimedAt) && now - claimedAt > EXTRACT_CLAIM_TTL_MS;
}

/**
 * Every record for one owner, newest first. Malformed or vanished entries are
 * skipped fail-soft — a poller must not stall on one unreadable file.
 */
export async function listExtractJobs(input: {
  /** `null` lists every owner — only the unscoped service caller passes it. */
  owner: string | null;
  status?: ExtractJobStatus;
  limit?: number;
}): Promise<ExtractJob[]> {
  const entries = await getStorage()
    .listFiles(JOBS_PREFIX)
    .catch((error) => {
      if (isEnoent(error)) return [];
      throw error;
    });
  const jobs: ExtractJob[] = [];
  for (const entry of entries) {
    if (entry.isDirectory || !entry.name.endsWith(".json")) continue;
    try {
      const raw = await getStorage().readFile(`${JOBS_PREFIX}/${entry.name}`);
      const job = JSON.parse(raw) as ExtractJob;
      if (input.owner !== null && job.owner !== input.owner) continue;
      if (input.status && job.status !== input.status) continue;
      jobs.push(job);
    } catch (error) {
      if (!isEnoent(error)) {
        logger.warn("extract-jobs", `list: failed to read ${entry.name}`, error);
      }
    }
  }
  // NEWEST FIRST, as the docblock says and as `./ingest-jobs` lists: a reader
  // that asks for 20 of 200 records wants the recent ones. The poller's own
  // listing needs the opposite and re-sorts for itself — see
  // {@link listClaimableExtractJobs} — rather than silently owning this order.
  jobs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return jobs.slice(0, Math.max(1, input.limit ?? 20));
}

/**
 * Was this record failed ONLY because nothing was listening at the time?
 *
 * A parse that failed on a corrupt DOCX is a fact about the document and must
 * stay failed until the owner retries it. A record the arrival door failed
 * closed because no sidecar had polled recently is a fact about the MACHINE,
 * and it stops being true the moment a sidecar starts — so the poller picks it
 * up rather than the owner having to hunt for rows they never caused.
 */
export function isSidecarDownFailure(job: ExtractJob): boolean {
  return job.status === "failed" && job.error === EXTRACT_SIDECAR_DOWN_COPY;
}

/**
 * What a poller is allowed to see: queued records, claims that expired, and
 * records failed closed for a sidecar that has since come back.
 *
 * Ordered oldest-first so a backlog drains in arrival order rather than
 * starving the first document behind everything dropped after it.
 */
export async function listClaimableExtractJobs(
  owner: string | null,
  limit = 20,
): Promise<ExtractJob[]> {
  const jobs = await listExtractJobs({ owner, limit: 200 });
  const now = Date.now();
  return jobs
    .filter(
      (job) =>
        job.status === "queued" ||
        isClaimExpired(job, now) ||
        isSidecarDownFailure(job),
    )
    // Re-sorted rather than inherited: {@link listExtractJobs} answers newest
    // first for readers, and a backlog drained in that order starves the first
    // document behind everything dropped after it.
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(0, Math.max(1, limit));
}

/**
 * Take ownership of a record for this poller, or answer `null`.
 *
 * Compare-and-swap on the record's own etag: two sidecars racing for one
 * document both read `queued`, and only the one whose write matches the etag
 * it read gets to parse. The loser sees `null` and moves to the next record
 * rather than duplicating an expensive parse.
 */
export async function claimExtractJob(
  extractId: string,
  owner: string,
): Promise<ExtractJob | null> {
  return withFileLock(`extract-job:${extractId}`, async () => {
    const storage = getStorage();
    const rel = relPathFor(extractId);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let read: Awaited<ReturnType<typeof storage.readFileWithEtag>>;
      try {
        read = await storage.readFileWithEtag(rel);
      } catch (error) {
        if (isEnoent(error)) return null;
        throw error;
      }
      const job = JSON.parse(read.content) as ExtractJob;
      if (job.owner !== owner) return null;
      if (
        job.status !== "queued" &&
        !isClaimExpired(job) &&
        !isSidecarDownFailure(job)
      ) {
        return null;
      }
      const now = new Date().toISOString();
      const claimed: ExtractJob = {
        ...job,
        status: "claimed",
        attempts: job.attempts + 1,
        claimedAt: now,
        // A record being re-offered after the sidecar came back carries the
        // stale refusal; leaving it set would keep the sentence on screen
        // beside a parse that is now running.
        error: "",
        updatedAt: now,
      };
      if (await storage.writeFileIfMatch(rel, JSON.stringify(claimed), read.etag)) {
        return claimed;
      }
    }
    throw new Error("Extract job was busy; retry the claim");
  });
}

/**
 * The extract record parked behind one ingest job, or `null`.
 *
 * Activity knows only the INGEST job — that is the row the owner clicks Retry
 * on — so re-offering the extract needs the reverse of the link
 * {@link ExtractJob.ingestJobId} records. Newest first, because a retried
 * arrival can leave more than one record pointing at the same ingest job and
 * the live one is the last written.
 */
export async function findExtractJobForIngest(
  owner: string,
  ingestJobId: string,
): Promise<ExtractJob | null> {
  const jobs = await listExtractJobs({ owner, limit: 500 });
  for (const job of jobs) {
    if (job.ingestJobId === ingestJobId) return job;
  }
  return null;
}

/**
 * Put a terminal record back in the queue for the next poller.
 *
 * Retry is not a claim: the sidecar may be down at this moment, and a record
 * moved straight to `claimed` by a browser click would then sit unclaimable
 * until its TTL expired. `queued` is the state a poller looks for.
 *
 * The previous `error` is cleared for the same reason {@link claimExtractJob}
 * clears it — a row that is waiting again must not still show why it failed
 * last time.
 */
export async function requeueExtractJob(
  extractId: string,
  owner: string,
): Promise<ExtractJob | null> {
  return patchExtractJob(extractId, owner, (job) => {
    const { claimedAt: _claimedAt, textRel: _textRel, ...rest } = job;
    return { ...rest, status: "queued", error: "" };
  });
}

/** Mark a claimed record done and record where the extracted text landed. */
export async function completeExtractJob(
  extractId: string,
  owner: string,
  input: { textRel: string; cacheHit?: boolean },
): Promise<ExtractJob | null> {
  return patchExtractJob(extractId, owner, (job) => ({
    ...job,
    status: "done",
    textRel: input.textRel,
    ...(input.cacheHit ? { cacheHit: true } : {}),
    error: "",
  }));
}

/**
 * Mark a record failed with the reason the owner will read.
 *
 * The message is stored VERBATIM: {@link EXTRACT_SIDECAR_DOWN_COPY} and an
 * extractor's own "this DOCX is corrupt" both reach Activity unchanged, which
 * is what makes "never a silent drop" observable rather than merely intended.
 */
export async function failExtractJob(
  extractId: string,
  owner: string,
  error: string,
): Promise<ExtractJob | null> {
  return patchExtractJob(extractId, owner, (job) => {
    // A `done` record is NOT failable. The text is already in the kernel and a
    // compile may already be running against it, so a late failure — a poller
    // that timed out after the completion landed, a retry racing a success —
    // would put a red row over a Source that extracted fine, and
    // `listClaimableExtractJobs` would then have nothing to re-offer because
    // the bytes were already turned into text. Terminal-success wins.
    if (job.status === "done") return job;
    return { ...job, status: "failed", error };
  });
}

async function patchExtractJob(
  extractId: string,
  owner: string,
  apply: (job: ExtractJob) => ExtractJob,
): Promise<ExtractJob | null> {
  return withFileLock(`extract-job:${extractId}`, async () => {
    const job = await getExtractJob(extractId);
    if (!job || job.owner !== owner) return null;
    const updated: ExtractJob = {
      ...apply(job),
      updatedAt: new Date().toISOString(),
    };
    await getStorage().writeFile(relPathFor(extractId), JSON.stringify(updated));
    return updated;
  });
}

/** Delete terminal records older than `ttlMs`. Returns how many were removed. */
export async function purgeStaleExtractJobs(
  ttlMs: number = EXTRACT_JOB_GC_TTL_MS,
): Promise<number> {
  const storage = getStorage();
  const entries = await storage.listFiles(JOBS_PREFIX).catch((error) => {
    if (isEnoent(error)) return [];
    throw error;
  });
  const cutoff = Date.now() - ttlMs;
  let deleted = 0;
  for (const entry of entries) {
    if (entry.isDirectory || !entry.name.endsWith(".json")) continue;
    const rel = `${JOBS_PREFIX}/${entry.name}`;
    try {
      const job = JSON.parse(await storage.readFile(rel)) as ExtractJob;
      if (job.status !== "done" && job.status !== "failed") continue;
      const updatedMs = Date.parse(job.updatedAt);
      if (!Number.isFinite(updatedMs) || updatedMs > cutoff) continue;
      await storage.deleteFile(rel);
      deleted += 1;
    } catch (error) {
      if (!isEnoent(error)) {
        logger.warn("extract-jobs", `GC: failed to process ${entry.name}`, error);
      }
    }
  }
  return deleted;
}
