/**
 * Enqueue meeting Todo extract, or run it inline when TASK_QUEUE is absent.
 *
 * Post-compile callers must not fail the ingest if extract throws — the Page
 * and Source are already written. The extract-todo-candidates task itself
 * still throws so the queue can retry.
 */

import { getErrorMessage } from "./errors";
import { logger } from "./logger";
import { meetingExtractTarget, setSourceMeeting } from "./source-meeting";
import { enqueueTask } from "./tasks";
import { extractTodoCandidatesFromMeeting } from "./todo-extract";
import { recordTodoExtractError } from "./todos";

export async function dispatchMeetingTodoExtract(
  owner: string,
  input: { origin?: "plaud"; sourcePath?: string; slug: string },
  options: { failSoft?: boolean } = {},
): Promise<"queued" | "ran" | "skipped"> {
  const handle = owner.trim();
  const slug = input.slug.trim();
  if (!handle || !slug) return "skipped";
  const meeting = await meetingExtractTarget(handle, { ...input, slug });
  if (!meeting) return "skipped";
  const sourcePath = meeting.sourcePath ?? input.sourcePath?.trim();
  if (input.origin === "plaud" && sourcePath) {
    await setSourceMeeting(handle, sourcePath, true).catch((error) => {
      logger.warn("todos", `plaud meeting flag failed for "${sourcePath}"`, error);
    });
  }
  const task = {
    kind: "extract-todo-candidates" as const,
    slug,
    owner: handle,
    ...(sourcePath ? { sourcePath } : {}),
  };
  try {
    if (await enqueueTask(task)) return "queued";
  } catch (error) {
    logger.warn(
      "todos",
      `todo-candidate extract enqueue failed for slug="${slug}": ${getErrorMessage(error)}`,
    );
  }
  try {
    await extractTodoCandidatesFromMeeting(handle, slug, sourcePath);
    return "ran";
  } catch (error) {
    try {
      await recordTodoExtractError(handle, {
        message: getErrorMessage(error),
        slug,
        ...(sourcePath ? { sourcePath } : {}),
      });
    } catch (writeErr) {
      logger.warn("todos", "failed to record todo extract error", writeErr);
    }
    if (options.failSoft) {
      logger.warn(
        "todos",
        `todo-candidate extract failed for slug="${slug}": ${getErrorMessage(error)}`,
      );
      return "skipped";
    }
    throw error;
  }
}
