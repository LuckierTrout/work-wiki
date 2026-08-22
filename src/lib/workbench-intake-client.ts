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
  const relative = intakeFileRelativePath(file);
  if (relative) {
    const path = sanitizeIntakeRelativePath(relative);
    if (!path.ok) {
      return { name: file.name, error: path.reason, unconfirmed: false };
    }
    form.append("relativePath", path.path);
  }
  try {
    await sendForm(INTAKE_ROUTE, form);
    return stored(file.name);
  } catch (cause) {
    const failure = writeFailure(cause, INTAKE_FILE_ACTION);
    return { name: file.name, error: failure.message, unconfirmed: failure.unconfirmed };
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
    return { name: trimmed, error: INTAKE_URL_REQUIRED_COPY, unconfirmed: false };
  }
  const clipText = typeof clip === "string" ? clip.trim() : "";
  const body = clipText
    ? { url: trimmed, clip: clipText }
    : { url: trimmed };
  try {
    await send(INTAKE_ROUTE, { method: "POST", body: JSON.stringify(body) });
    return stored(trimmed);
  } catch (cause) {
    const failure = writeFailure(cause, INTAKE_URL_ACTION);
    return { name: trimmed, error: failure.message, unconfirmed: failure.unconfirmed };
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
): Promise<IntakeOutcome[]> {
  if (files.length === 0) return [emptyFolderOutcome()];
  const outcomes: IntakeOutcome[] = [];
  for (const file of files) {
    outcomes.push(await submitIntakeFile(file));
  }
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
