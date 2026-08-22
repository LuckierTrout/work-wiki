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
  INTAKE_URL_REQUIRED_COPY,
  classifyIntakeFile,
  intakeStoredCopy,
  isIntakeUrl,
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

/** What became of ONE arrival. */
export interface IntakeOutcome {
  /** What the owner called it: the filename, or the URL they typed. */
  readonly name: string;
  /** `null` when the Source was stored and Ingest queued. */
  readonly error: string | null;
  /**
   * NOTHING IS KNOWN about this arrival — see `WriteFailure.unconfirmed`. The
   * caller must reconcile (ask the watcher to re-poll) rather than tell the
   * owner it failed: the bytes may be stored and the job queued already.
   */
  readonly unconfirmed: boolean;
}

function stored(name: string): IntakeOutcome {
  return { name, error: null, unconfirmed: false };
}

/**
 * Did the browser hand us this file because a FOLDER was dropped or picked?
 *
 * `webkitRelativePath` is the platform's own marker: it is `""` for a file the
 * owner dropped directly, and `"notes/plan.md"` for one the engine expanded out
 * of a directory. Recursive folder import is Story 2.2 (see
 * {@link INTAKE_FOLDER_COPY}), so those arrivals are skipped rather than stored.
 *
 * Typed defensively — the property is non-standard, so a browser that does not
 * implement it leaves it `undefined` and every file reads as a direct one, which
 * is the pre-existing behaviour rather than a refusal of everything.
 */
export function isFolderExpandedFile(file: File): boolean {
  const relative = (file as File & { webkitRelativePath?: unknown })
    .webkitRelativePath;
  return typeof relative === "string" && relative.length > 0;
}

/**
 * Split a pick or a drop into the files this door will take and the count it is
 * skipping because they came out of a folder.
 *
 * A PURE function in the lib module for the reason the module note gives: this
 * is the rule that decides whether an owner's drop is refused, and inside a drop
 * handler it could only be grepped for. It also has to answer the mixed case —
 * two loose files dragged along with a folder — where the loose two are stored
 * and the refusal is still said.
 */
export function partitionIntakeFiles(files: readonly File[]): {
  readonly files: readonly File[];
  readonly skippedFolderFiles: number;
} {
  const direct = files.filter((file) => !isFolderExpandedFile(file));
  return { files: direct, skippedFolderFiles: files.length - direct.length };
}

/** The refusal for a folder drop, as one outcome the batch report can carry. */
export function folderRefusedOutcome(): IntakeOutcome {
  // Unnamed: the sentence is about the ACTION, not about one of the leaves the
  // browser happened to expand, and naming one of a hundred would mislead.
  return { name: "", error: INTAKE_FOLDER_COPY, unconfirmed: false };
}

/**
 * Store and queue one picked or dropped file.
 *
 * The type is classified HERE as well as in the route. Not belt-and-braces: an
 * office file dropped on the shell should fail on the spot with the same
 * sentence rather than after a round trip that uploads it first, and a drop can
 * carry a dozen files of which only some are text. The route refuses
 * independently, because a client check is not a gate.
 */
export async function submitIntakeFile(file: File): Promise<IntakeOutcome> {
  const verdict = classifyIntakeFile(file.name, file.type);
  if (!verdict.ok) {
    return { name: file.name, error: verdict.reason, unconfirmed: false };
  }
  const form = new FormData();
  form.append("file", file);
  try {
    await sendForm(INTAKE_ROUTE, form);
    return stored(file.name);
  } catch (cause) {
    const failure = writeFailure(cause, INTAKE_FILE_ACTION);
    return { name: file.name, error: failure.message, unconfirmed: failure.unconfirmed };
  }
}

/** Store and queue one in-app URL. */
export async function submitIntakeUrl(url: string): Promise<IntakeOutcome> {
  const trimmed = url.trim();
  if (!isIntakeUrl(trimmed)) {
    // An empty field or a non-http(s) string invents no Source and makes no
    // request — the failure belongs to the action the owner took.
    return { name: trimmed, error: INTAKE_URL_REQUIRED_COPY, unconfirmed: false };
  }
  try {
    await send(INTAKE_ROUTE, { method: "POST", body: JSON.stringify({ url: trimmed }) });
    return stored(trimmed);
  } catch (cause) {
    const failure = writeFailure(cause, INTAKE_URL_ACTION);
    return { name: trimmed, error: failure.message, unconfirmed: failure.unconfirmed };
  }
}

/**
 * Store and queue each file in turn. N files → N Sources → N queue items.
 *
 * The folder partition happens HERE rather than in the caller, so the pick and
 * the drop cannot disagree about it: both reach this function, and a shell that
 * forgot the filter would upload an expanded directory through one of its two
 * entry points. A skipped folder still produces its own outcome, so a drop of
 * nothing but a directory reports a refusal instead of a silent no-op.
 */
export async function submitIntakeFiles(
  files: readonly File[],
): Promise<IntakeOutcome[]> {
  const { files: direct, skippedFolderFiles } = partitionIntakeFiles(files);
  const outcomes: IntakeOutcome[] = [];
  for (const file of direct) {
    outcomes.push(await submitIntakeFile(file));
  }
  // ONE sentence however many leaves the browser expanded: a folder of forty
  // files is one thing the owner did, not forty failures to read.
  if (skippedFolderFiles > 0) outcomes.push(folderRefusedOutcome());
  return outcomes;
}

/** Did anything land? Decides whether the trees are worth re-polling. */
export function intakeStoredCount(outcomes: readonly IntakeOutcome[]): number {
  return outcomes.filter((outcome) => outcome.error === null).length;
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
 * A drop of five files where the DOCX among them was refused must say both
 * halves: reporting only the four that landed hides a refusal, and reporting
 * only the refusal hides four Sources that are already compiling. So a mixed
 * batch reads "Stored 4 sources. Ingest is queued. plan.docx: DOCX is not a
 * Markdown, text, or HTML source."
 *
 * Failures are NAMED. With one item the name is redundant, but with several the
 * bare reason leaves the owner to guess which of the things they dropped it was
 * about — and a URL's name is the URL, which is the only handle it has.
 */
export function intakeReport(outcomes: readonly IntakeOutcome[]): string {
  // Nothing was attempted — a drag that carried no files, a batch the caller
  // filtered to nothing. "Stored 0 sources" would report an arrival that never
  // happened.
  if (outcomes.length === 0) return "";
  const stored = intakeStoredCount(outcomes);
  const failures = outcomes
    .filter((outcome) => outcome.error !== null)
    .map((outcome) => (outcome.name ? `${outcome.name}: ${outcome.error}` : outcome.error))
    .join(" ");
  if (!failures) return intakeStoredCopy(stored);
  return stored === 0 ? failures : `${intakeStoredCopy(stored)} ${failures}`;
}
