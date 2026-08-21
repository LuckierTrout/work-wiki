/**
 * A page read that FAILED, told apart from a page that is ABSENT (DW-378,
 * DW-380) — one owner for the sentence, the status and the classifier.
 *
 * `readWikiPage` answers `null` for both conditions, so `PUT /api/wiki/[slug]`
 * turned a storage blip into `page not found: <slug>` — a 404 about existence,
 * answered before the write precondition was ever consulted, for a page that
 * exists and whose bytes nobody could read. `writeWikiArtifact` one layer over
 * already rethrows a non-ENOENT read failure for exactly this reason. This
 * module is the other half of that contract, for the PAGE reads that back a
 * write precondition.
 *
 * IT APPLIES TO THE `fresh` READ, AND ONLY THAT. ~40 callers depend on the
 * unqualified read's `null`, which stays exactly as it is: warn, widen to the
 * flat file, cache the negative entry, return `null`. A precondition-bearing
 * read is the one that cannot afford either lie — neither "absent" for a file
 * it could not read, nor a version computed over a DIFFERENT file than the one
 * the write will target, which is what widening from a FAILED silo read to the
 * flat fallback produces (DW-380).
 *
 * ENOENT IS NOT A FAILURE. A missing page is still `null` in both modes and
 * still a 404 at the door. Only a non-ENOENT error becomes this refusal.
 *
 * THE REFUSAL TRAVELS AS A THROWN ERROR, not a return value, because
 * `readWikiPage`'s return type is the thing that cannot distinguish the two
 * cases — a new nullable shape would have to be destructured at every call
 * site, and silently ignored at most of them.
 *
 * ZERO DEPENDENCIES ON PURPOSE. Every consumer of a fresh read imports this
 * module, and since the DW-379 sweep that is no longer two doors: `PUT` and
 * `GET /api/workbench/preview` were the first pair, and `PATCH /api/wiki/[slug]`,
 * `POST /api/wiki/[slug]/revisions` (the revert) and `POST /api/lint/fix` now
 * classify the same refusal, with `wiki.ts` throwing it and `merge.ts` catching
 * it to re-word its own abort. Nothing here pulls the wiki, storage or config
 * graph, so the import costs a route nothing it does not already carry — which
 * is what lets the set grow without any of them paying for it.
 *
 * {@link isPageUnreadableError} matches on `err.name` rather than `instanceof`,
 * exactly as {@link import("./read-only").isReadOnlyError} and
 * {@link import("./write-precondition").isWriteConflictError} do: an error
 * thrown by a SECOND copy of this module — vitest's two projects, a bundler
 * splitting server and edge chunks, the stdio MCP entry point compiled
 * separately — fails `instanceof` against the copy the route imported, and the
 * 503 would silently become a 500 only in production.
 */

/**
 * The one sentence a refused-because-unreadable page answers with.
 *
 * Modelled on {@link import("./config").CONFIG_UNREADABLE_COPY}, the precedent
 * `PUT /api/settings` already serves for an unreadable STORE — same condition,
 * same recovery. It is not imported from there because that copy names the
 * settings store; the recovery half is word for word because the owner's
 * situation is identical: a draft is on screen, reloading destroys it, and
 * copying it out first is the only thing that saves it.
 *
 * "Could not be read" rather than "not found": the whole point of this bundle
 * is that the page is not known to be absent.
 *
 * IT REACHES THE OWNER ON THE WRITE DOORS. "So nothing was changed" is a
 * WRITE-shaped sentence, and `PUT /api/wiki/[slug]` is where it is read:
 * `savePreviewBody` relays a served `{ error }` verbatim, and 503 is
 * deliberately excluded from `UNCONFIRMED_STATUSES` precisely so it is treated
 * as a verdict rather than an unknown outcome. There the sentence is exactly
 * true — the draft is on screen and nothing was written.
 *
 * SINCE DW-379 THREE MORE WRITE DOORS SERVE IT, and the sentence is exactly as
 * true at each: `PATCH /api/wiki/[slug]`, the revert, and `POST /api/lint/fix`
 * all refuse on the MERGE-BASE read, before their writer is reached, so nothing
 * was changed at any of them either. What differs is only who is reading: those
 * three are answered by an API client, the MCP tools or the lint UI rather than
 * by the Preview's save path, so the recovery half ("copy anything you have
 * unsaved") is advice about a draft only the `PUT` caller actually holds. It
 * costs those callers nothing and it keeps one sentence for one condition,
 * which is the whole reason this constant is imported rather than re-worded.
 *
 * ONE CONSUMER DELIBERATELY DOES NOT RELAY IT: `merge.ts` catches the refusal
 * and rethrows its own `merge aborted: backlink source …` message, because a
 * merge that fails PART WAY through re-pointing backlinks has already written
 * some of them — "nothing was changed" would be false there, and the accurate
 * sentence names the page and the merge.
 *
 * ON `GET /api/workbench/preview` THE STATUS IS THE PAYLOAD, NOT THE SENTENCE.
 * That door serves the same 503 and the same body, but nothing renders it:
 * `fetchPreview` maps every non-ok response to `{ status: "unreachable" }` and
 * drops the body entirely. So what the GET buys is the status CLASS — stale
 * bytes kept on screen and a Retry offered, rather than the Preview clearing
 * itself as it would for a 404 — and the write-shaped half of the sentence
 * never reaches anyone. That is why one constant serves both doors instead of
 * the read growing a second, read-shaped one it would have no way to display.
 * The same asymmetry {@link import("./config").CONFIG_UNREADABLE_COPY}
 * documents for the settings store, for the same reason: a read must grant no
 * oracle, so its body is honest rather than rendered.
 */
export const PAGE_UNREADABLE_COPY =
  "This page could not be read, so nothing was changed. This is usually temporary — copy anything you have unsaved, then reload and try again.";

/**
 * The status a page whose bytes could not be read answers with.
 *
 * 503, not 500 and not 404. `PUT /api/settings` already answers 503 with
 * {@link import("./config").CONFIG_UNREADABLE_COPY} for exactly this condition
 * — a store that is temporarily unavailable — and `workbench-preview.ts`
 * documents 503 as deliberately EXCLUDED from `UNCONFIRMED_STATUSES` because
 * this app's own routes emit it as a definite verdict. So `savePreviewBody`
 * relays the sentence above verbatim and keeps the owner's draft, with no
 * client change at all. A 500 would be read as a server fault; a 404 is the lie
 * this bundle removes.
 */
export const PAGE_UNREADABLE_STATUS = 503;

/**
 * Thrown by a FRESH {@link import("./wiki").readWikiPage} when storage failed
 * with something other than ENOENT.
 *
 * `name` is set explicitly (rather than relying on class identity) because
 * {@link isPageUnreadableError} is what routes classify on — see the module
 * note.
 *
 * The original failure is preserved as `cause` so a log line or a debugger
 * still reaches the EIO underneath, while the message the owner sees stays the
 * one sentence this module owns.
 */
export class PageUnreadableError extends Error {
  constructor(message: string = PAGE_UNREADABLE_COPY, options?: { cause?: unknown }) {
    super(message);
    this.name = "PageUnreadableError";
    if (options && "cause" in options) {
      // Assigned rather than passed to `super`: the runtime target here predates
      // the `cause` constructor option, and this keeps the property present
      // either way.
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * Is this the "the page could not be read" refusal?
 *
 * Matches on `name`, not `instanceof` — see the module note.
 */
export function isPageUnreadableError(err: unknown): boolean {
  return err instanceof Error && err.name === "PageUnreadableError";
}
