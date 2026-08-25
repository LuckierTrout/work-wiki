/**
 * The browser half of Workbench Intake: one arrival per request, and the
 * sentence to show when one of them fails.
 *
 * A LIB MODULE rather than logic inside the component, for the reason the rest
 * of `workbench-*.ts` gives: vitest runs `environment: "node"` with no DOM, so
 * anything written inside an event handler could only be grepped for. `fetch`
 * is the global here (through {@link sendForm} / {@link send}), which a test
 * stubs — nothing opens a socket.
 *
 * ONE REQUEST PER ITEM. The route stores and enqueues exactly one Source, so a
 * drop of N files is N calls and N outcomes: a refused item cannot take its
 * neighbours down with it, and there is no partial-batch response shape for the
 * caller to interpret. Sequential rather than parallel — the arrivals share a
 * serial compile queue downstream, and N simultaneous multipart posts buy
 * nothing but a burst.
 */

import {
  INTAKE_FOLDER_COPY,
  INTAKE_PATH_COLLISION_COPY,
  INTAKE_URL_REQUIRED_COPY,
  classifyIntakeFile,
  intakeRefusedCopy,
  intakeSkippedCopy,
  intakeStoredCopy,
  intakeStoredNotQueuedCopy,
  isIntakeTextFormat,
  isIntakeUrl,
  sanitizeIntakeRelativePath,
} from "./workbench-intake";
import { send, sendForm, writeFailure } from "./workbench-request";

/** The one door. Both shapes (multipart file, JSON url) post here. */
export const INTAKE_ROUTE = "/api/workbench/intake";

/**
 * The phrase {@link writeFailure} composes its sentences from — one per door,
 * so an unconfirmed outcome reads "…the attempt to store that file went
 * through…" rather than naming a transport.
 */
export const INTAKE_FILE_ACTION = "store that file";
export const INTAKE_URL_ACTION = "store that URL";

export type IntakeDisposition =
  | "queued"
  | "skipped"
  | "not_queued"
  | "refused"
  | "failed"
  | "unconfirmed";

/** What became of ONE arrival. */
export interface IntakeOutcome {
  /** What the owner called it: the filename, or the URL they typed. */
  readonly name: string;
  /** `null` when the Source was stored, skipped, or queued. */
  readonly error: string | null;
  /**
   * NOTHING IS KNOWN about this arrival — see `WriteFailure.unconfirmed`. The
   * caller must reconcile (ask the watcher to re-poll) rather than tell the
   * owner it failed: the bytes may be stored and the job queued already.
   */
  readonly unconfirmed: boolean;
  readonly disposition: IntakeDisposition;
}

function stored(name: string): IntakeOutcome {
  return { name, error: null, unconfirmed: false, disposition: "queued" };
}

interface IntakeResponseBody {
  queued?: unknown;
  skipped?: unknown;
  refused?: unknown;
  error?: unknown;
  path?: unknown;
}

function outcomeFromBody(name: string, body: IntakeResponseBody): IntakeOutcome {
  if (body.refused === true) {
    const error =
      typeof body.error === "string" && body.error.trim()
        ? body.error
        : INTAKE_PATH_COLLISION_COPY;
    return { name, error, unconfirmed: false, disposition: "refused" };
  }
  if (body.skipped === true) {
    return { name, error: null, unconfirmed: false, disposition: "skipped" };
  }
  if (body.queued === false) {
    return { name, error: null, unconfirmed: false, disposition: "not_queued" };
  }
  return stored(name);
}

/**
 * Did the browser hand us this file because a FOLDER was dropped or picked?
 *
 * `webkitRelativePath` is the platform's own marker: it is `""` for a file the
 * owner dropped directly, and `"papers/energy/note.md"` for one the engine
 * expanded out of a directory. Folder-expanded files take the tree writer;
 * loose files keep the 2.1 hash key.
 *
 * Typed defensively — the property is non-standard, so a browser that does not
 * implement it leaves it `undefined` and every file reads as a direct one.
 */
export function isFolderExpandedFile(file: File): boolean {
  const relative = (file as File & { webkitRelativePath?: unknown })
    .webkitRelativePath;
  return typeof relative === "string" && relative.length > 0;
}

/** The platform relative path, or `undefined` for a loose file. */
export function intakeFileRelativePath(file: File): string | undefined {
  const relative = (file as File & { webkitRelativePath?: unknown })
    .webkitRelativePath;
  return typeof relative === "string" && relative.length > 0 ? relative : undefined;
}

/**
 * Every file in the pick or drop is a candidate. Folder-expanded leaves are
 * no longer skipped — each is its own Source (Story 2.2).
 */
export function partitionIntakeFiles(files: readonly File[]): {
  readonly files: readonly File[];
  readonly skippedFolderFiles: number;
} {
  return { files, skippedFolderFiles: 0 };
}

/** The Folder action expanded to nothing. No Source is invented for it. */
export function emptyFolderOutcome(): IntakeOutcome {
  return {
    name: "",
    error: INTAKE_FOLDER_COPY,
    unconfirmed: false,
    disposition: "refused",
  };
}

/**
 * Store and queue one picked or dropped file.
 *
 * The type is classified HERE as well as in the route. Not belt-and-braces: a
 * `.csv` dropped on the shell should fail on the spot with the same sentence
 * rather than after a round trip that uploads it first, and a drop can carry a
 * dozen files of which only some are readable. The route refuses
 * independently, because a client check is not a gate.
 *
 * A folder-expanded BINARY keeps its bytes and loses its path. The tree writer
 * takes a string keyed on the sanitized path, so only a text leaf can hold a
 * folder location; a PDF inside a dropped folder posts loose and lands as a
 * content-hashed Source. Refusing it to preserve the tree shape would throw
 * away the file to keep a breadcrumb.
 */
export async function submitIntakeFile(
  file: File,
  options?: { origin?: "plaud" },
): Promise<IntakeOutcome> {
  const verdict = classifyIntakeFile(file.name, file.type);
  if (!verdict.ok) {
    return {
      name: file.name,
      error: verdict.reason,
      unconfirmed: false,
      disposition: "refused",
    };
  }
  const form = new FormData();
  form.append("file", file);
  if (options?.origin === "plaud") {
    form.append("origin", "plaud");
  }
  const relative = intakeFileRelativePath(file);
  if (relative && isIntakeTextFormat(verdict.format)) {
    const path = sanitizeIntakeRelativePath(relative);
    if (!path.ok) {
      return {
        name: file.name,
        error: path.reason,
        unconfirmed: false,
        disposition: "refused",
      };
    }
    form.append("relativePath", path.path);
  }
  try {
    const body = await sendForm<IntakeResponseBody>(INTAKE_ROUTE, form);
    return outcomeFromBody(file.name, body);
  } catch (cause) {
    const failure = writeFailure(cause, INTAKE_FILE_ACTION);
    return {
      name: file.name,
      error: failure.message,
      unconfirmed: failure.unconfirmed,
      disposition: failure.unconfirmed ? "unconfirmed" : "failed",
    };
  }
}

/** Store and queue one in-app URL, or a clip that still carries that URL. */
export async function submitIntakeUrl(
  url: string,
  clip?: string,
): Promise<IntakeOutcome> {
  const trimmed = url.trim();
  if (!isIntakeUrl(trimmed)) {
    // An empty field or a non-http(s) string invents no Source and makes no
    // request — the failure belongs to the action the owner took. A clip
    // without a URL cannot satisfy provenance either.
    return {
      name: trimmed,
      error: INTAKE_URL_REQUIRED_COPY,
      unconfirmed: false,
      disposition: "refused",
    };
  }
  const clipText = typeof clip === "string" ? clip : "";
  const payload = clipText.trim()
    ? { url: trimmed, clip: clipText }
    : { url: trimmed };
  try {
    const body = await send<IntakeResponseBody>(INTAKE_ROUTE, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return outcomeFromBody(trimmed, body);
  } catch (cause) {
    const failure = writeFailure(cause, INTAKE_URL_ACTION);
    return {
      name: trimmed,
      error: failure.message,
      unconfirmed: failure.unconfirmed,
      disposition: failure.unconfirmed ? "unconfirmed" : "failed",
    };
  }
}

/**
 * Store and queue each file in turn. N files → N Sources → N queue items.
 *
 * Folder-expanded files are posted with `relativePath` (the vault's multipart
 * field name — this door does not mount that component). An empty pick or drop
 * is the Folder action's visible sentence, not a silent no-op.
 */
export async function submitIntakeFiles(
  files: readonly File[],
  options?: { origin?: "plaud" },
): Promise<IntakeOutcome[]> {
  if (files.length === 0) return [emptyFolderOutcome()];
  const outcomes: IntakeOutcome[] = [];
  for (const file of files) {
    outcomes.push(await submitIntakeFile(file, options));
  }
  return outcomes;
}

/** Did anything land? Decides whether the trees are worth re-polling. */
export function intakeStoredCount(outcomes: readonly IntakeOutcome[]): number {
  return outcomes.filter(
    (outcome) =>
      outcome.error === null &&
      (outcome.disposition === "queued" ||
        outcome.disposition === "skipped" ||
        outcome.disposition === "not_queued"),
  ).length;
}

/**
 * Whether the trees should be re-checked after this batch.
 *
 * TRUE for an unconfirmed item as well as a stored one: an outcome nobody
 * answered for may have landed in full, and the reconciliation is exactly what
 * `WriteFailure.unconfirmed` obliges the caller to do.
 */
export function intakeShouldRefresh(outcomes: readonly IntakeOutcome[]): boolean {
  return outcomes.some((outcome) => outcome.error === null || outcome.unconfirmed);
}

/**
 * The ONE sentence to put in front of the owner for a whole batch.
 *
 * A drop of five files where the CSV among them was refused must say both
 * halves: reporting only the four that landed hides a refusal, and reporting
 * only the refusal hides four Sources that are already compiling. So a mixed
 * batch reads "Stored 4 sources. Ingest is queued. rows.csv: CSV is not a
 * source this wiki can read."
 *
 * Failures are NAMED. With one item the name is redundant, but with several the
 * bare reason leaves the owner to guess which of the things they dropped it was
 * about — and a URL's name is the URL, which is the only handle it has.
 */
export function intakeReport(outcomes: readonly IntakeOutcome[]): string {
  if (outcomes.length === 0) return "";
  const queued = outcomes.filter((o) => o.disposition === "queued").length;
  const skipped = outcomes.filter((o) => o.disposition === "skipped").length;
  const notQueued = outcomes.filter((o) => o.disposition === "not_queued").length;
  const refused = outcomes.filter((o) => o.disposition === "refused").length;
  const failures = outcomes
    .filter(
      (outcome) =>
        outcome.error !== null &&
        outcome.disposition !== "skipped" &&
        outcome.disposition !== "not_queued",
    )
    .map((outcome) =>
      outcome.name ? `${outcome.name}: ${outcome.error}` : outcome.error,
    )
    .join(" ");
  const parts: string[] = [];
  if (queued > 0) parts.push(intakeStoredCopy(queued));
  if (skipped > 0) parts.push(intakeSkippedCopy(skipped));
  if (notQueued > 0) parts.push(intakeStoredNotQueuedCopy(notQueued));
  if (refused > 0 && !failures) parts.push(intakeRefusedCopy(refused));
  if (failures) parts.push(failures);
  return parts.join(" ");
}
