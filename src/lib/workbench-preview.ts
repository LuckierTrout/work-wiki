/**
 * The Workbench Preview's vocabulary: what the body can be, how big it may get,
 * what the route answers with, and every sentence the column can show.
 *
 * Pure and client-safe, the same rule `workbench-tree.ts` follows — the route
 * imports it on the server, the column imports it in the browser, and the node
 * suite executes it. One module owns the vocabulary so no shape and no sentence
 * is spelled twice across the client/server boundary.
 */

import { isEditableArtifactFile, type EditableArtifactFile } from "./wiki-scenarios";
import type { TreeSelection } from "./workbench-tree";
import { IF_MATCH_HEADER, formatIfMatch } from "./write-precondition";

// ---------------------------------------------------------------------------
// What the body can be
// ---------------------------------------------------------------------------

/**
 * How the body should be rendered. `markdown` goes through GFM + wikilinks,
 * `text` renders verbatim in a `<pre>`, and `unsupported` renders a sentence
 * instead of bytes — the Preview is a reader, not a binary viewer.
 */
export type PreviewFormat = "markdown" | "text" | "unsupported";

/**
 * Decide a display path's format from its extension alone.
 *
 * Extension, not sniffing: the walk that produced the path never `stat`s or
 * reads a file, and a reader that guesses from bytes would have to read a PDF
 * before it could refuse to show one.
 */
export function previewFileKind(path: string): PreviewFormat {
  if (typeof path !== "string") return "unsupported";
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  // A leading dot is a dotfile, not an extension — `.md` names no format.
  if (dot <= 0) return "unsupported";
  switch (name.slice(dot)) {
    case ".md":
    case ".markdown":
      return "markdown";
    case ".txt":
      return "text";
    default:
      return "unsupported";
  }
}

/**
 * Hard cap on the characters the route will send.
 *
 * A compiled Page is a few kilobytes; an imported source under `raw/` has no
 * ceiling at all. The cap is enforced SERVER-side so an oversized file costs one
 * bounded response rather than a browser tab, and the column says it truncated
 * rather than silently showing a prefix.
 */
export const PREVIEW_MAX_CHARS = 200_000;

/**
 * Cut a body to {@link PREVIEW_MAX_CHARS} without splitting a character.
 *
 * `String.prototype.slice` counts UTF-16 code UNITS, so a cut that lands
 * between the two halves of a surrogate pair ships a lone surrogate — which is
 * not a character, does not survive `JSON.stringify` → parse as what it was,
 * and renders as a replacement glyph. Any emoji or CJK-extension character at
 * the boundary hits this. Stepping back one unit costs at most one character
 * and cannot produce an invalid string.
 */
export function capPreviewBody(body: string): { body: string; truncated: boolean } {
  if (body.length <= PREVIEW_MAX_CHARS) return { body, truncated: false };
  let end = PREVIEW_MAX_CHARS;
  const last = body.charCodeAt(end - 1);
  // A HIGH surrogate as the final unit means its partner is on the other side.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { body: body.slice(0, end), truncated: true };
}

// ---------------------------------------------------------------------------
// The wire shape
// ---------------------------------------------------------------------------

/** `/api/workbench/preview` — one route, addressed by the tree's own selection. */
export const PREVIEW_ROUTE = "/api/workbench/preview";

export interface PreviewPayload {
  /** What the column's header shows: the page title, or the file's last segment. */
  name: string;
  /** The path the frontmatter strip prints — the tree's display path. */
  path: string;
  /**
   * The page this body belongs to, when there is one. Present for a Page
   * selection and for a `wiki/<slug>.md` file selection, because those are the
   * same bytes reached two ways — and it is what the editor `PUT`s to.
   */
  slug?: string;
  /**
   * The seeded Wiki artifact this body IS, when it is one (Story 1.8). Present
   * only for a file selection naming an artifact the owner may write —
   * `schema.md` today — and never together with `slug`: an artifact has no slug,
   * no page-index entry and no file under `wiki/`, which is precisely why it is
   * written through its own route rather than through `PUT /api/wiki/[slug]`.
   */
  artifact?: EditableArtifactFile;
  format: PreviewFormat;
  /**
   * What the column renders and what the editor is seeded with.
   *
   * For a PAGE this is the markdown BODY with the YAML block already stripped,
   * because `PUT /api/wiki/[slug]` owns frontmatter end-to-end. For an
   * {@link PreviewPayload.artifact} it is the WHOLE file, block included:
   * `PUT /api/workbench/artifact` stores `content` verbatim and owns no
   * frontmatter, so stripping here would hand the editor a body whose next save
   * deletes the block. Read and write agree on which bytes they mean, per kind.
   */
  body: string;
  /** The body was longer than {@link PREVIEW_MAX_CHARS} and was sliced. */
  truncated: boolean;
  /**
   * The WRITE PRECONDITION for these bytes — `contentVersion` of the whole
   * stored file, which for a page is the YAML block INCLUDED even though
   * {@link PreviewPayload.body} strips it (DW-38/51/56).
   *
   * Optional because a payload can exist for bytes that were never read: an
   * `unsupported` format is answered from a existence check alone, and there is
   * no editor for it, so no save can start from it. Every payload the editor can
   * open carries one, and {@link savePreviewBody} sends it back as `If-Match`.
   *
   * `null` is accepted as another spelling of ABSENT — a serializer, a proxy or
   * a future route that normalizes an omitted optional to `null` must not take
   * the whole column down to "unreachable" over a field the BODY does not
   * depend on. Every consumer treats a falsy version as "no precondition to
   * send", which is answered 428 rather than applied blindly.
   */
  version?: string | null;
  /** The confirm-gated editor is offered only when this is true. */
  editable: boolean;
}

/**
 * What the column is CURRENTLY showing, as far as "may this be edited" is
 * concerned (DW-181).
 *
 * Two facts, not one, because the column deliberately holds them apart: a 404
 * KEEPS the last-good payload (DW-54's decision — `gone` replaces the BODY, it
 * does not clear what was read), so `payload` alone cannot answer this. It
 * still describes bytes that were editable, and every derivation built on it
 * alone goes on saying so over a body a 404 has already replaced.
 */
export interface PreviewEditInput {
  /** The route answered 404 for the row on screen: there is nothing to write to. */
  gone: boolean;
  /** The last payload that landed — kept across a 404, hence the flag above. */
  payload: PreviewPayload | null;
}

/**
 * THE write-target derivation: where `Save` would go for what is on screen, or
 * `null` when there is nowhere.
 *
 * {@link previewWriteTarget} answers the same question about a PAYLOAD; this
 * one answers it about the COLUMN, and the difference is the whole of DW-181. A
 * refresh that answers 404 leaves the payload standing on purpose, so
 * `previewWriteTarget(payload)` stays non-null over a body that now reads
 * `This file couldn’t be loaded.` — the header went on offering `Edit`, and
 * `save()`'s guard, which compares against that same stale payload, passed and
 * posted a body to a row the server had already deleted.
 *
 * One derivation rather than a `gone` term added at each site: the affordance,
 * the confirm copy, `startEditing` and BOTH of `save()`'s guards ask this, so
 * the control and the write can only ever refuse together. A `gone` check typed
 * beside the button alone would withdraw the affordance and leave the write.
 */
export function previewEditTarget(input: PreviewEditInput): PreviewWriteTarget | null {
  if (input.gone) return null;
  return previewWriteTarget(input.payload);
}

/**
 * May the confirm-gated editor be offered for what the column is showing?
 *
 * Exactly "is there somewhere for `Save` to go", which is
 * {@link previewEditTarget}. Expressing it that way rather than as a second
 * list of conditions is what keeps the truncation rule ATTACHED to the decision
 * instead of sitting beside it: the editor is seeded with `payload.body`, which
 * for a capped file is a PREFIX, and saving that replaces a whole page — or,
 * since Story 1.8, a whole executable Schema — with its first
 * {@link PREVIEW_MAX_CHARS} characters. Inline in JSX, deleting half of the old
 * pair left the entire suite green.
 *
 * Takes the same {@link PreviewEditInput} as the target it is defined from, so
 * the two cannot be asked different questions (DW-181).
 */
export function canEditPreview(input: PreviewEditInput): boolean {
  return previewEditTarget(input) !== null;
}

/**
 * Is the open editor holding text that would be LOST (DW-36)?
 *
 * The one bit the column reports up to the shell, which needs it to decide
 * whether a tree pick may be applied. A bit rather than the draft itself: a
 * shell that could read the text would be a second owner of the editor's state,
 * and the only question it has is "may I destroy this".
 *
 * `seed` is the string the editor was SEEDED with when it opened, captured at
 * that moment rather than re-derived from the payload — a silent same-row
 * refresh (Story 1.7) can replace the payload underneath an open editor, and
 * comparing against the new bytes would report an owner who typed nothing as
 * dirty and an owner who typed exactly the new bytes as clean.
 *
 * Both refusals are their own fact, not one condition wearing two names:
 *
 * - a CLOSED editor holds nothing at all, and a stale `draft` from the last
 *   session of editing must never gate a pick made minutes later;
 * - a `null` seed means the editor is open with nothing recorded to compare
 *   against, which is not evidence of unsaved text. Answering `true` there would
 *   put a discard confirm in front of a pick the owner has typed nothing into —
 *   the one failure of this feature that costs a click on every single pick.
 */
export function previewDraftDirty(input: {
  editing: boolean;
  draft: string;
  seed: string | null;
}): boolean {
  if (!input.editing) return false;
  if (input.seed === null) return false;
  return input.draft !== input.seed;
}

/**
 * Which of the five things the body area shows.
 *
 * The branch ORDER is the whole content of this decision — `loading` before
 * `gone`, a missing payload folded into `failed`, `unsupported` before
 * `empty` because a blob this reader cannot render has no body to be empty —
 * and inline in JSX it could only ever be grepped for. Inverting one test there
 * (`payload.body.trim().length === 0` → `> 0`) rendered `This file is empty.`
 * for every readable file and an empty column for an empty one, with the whole
 * suite green; deleting the `loading` branch left `Loading…` unreachable. A pure
 * function is what lets the node suite RUN all five, which is the same move
 * `fetchPreview` and `canEditPreview` already made out of this component.
 */
export type PreviewBodyState =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "unsupported" }
  | { kind: "empty" }
  | { kind: "body"; payload: PreviewPayload };

export function previewBodyState(input: {
  loading: boolean;
  /**
   * The route answered 404 — the row is not there any more, or never was
   * (DW-54). Named `gone` rather than `failed` because a read that merely could
   * not be REACHED is {@link previewStaleNotice}'s business and must leave the
   * last-good bytes on screen: one flag meaning both is exactly the conflation
   * that let a network blip replace the page the owner was reading.
   */
  gone: boolean;
  payload: PreviewPayload | null;
}): PreviewBodyState {
  if (input.loading) return { kind: "loading" };
  // No payload and not loading is a failure whether or not the flag was set:
  // there is nothing to render, and nothing else true to say about it.
  if (input.gone || input.payload === null) return { kind: "failed" };
  const payload = input.payload;
  if (payload.format === "unsupported") return { kind: "unsupported" };
  if (payload.body.trim().length === 0) return { kind: "empty" };
  return { kind: "body", payload };
}

/**
 * Where the column fetches a selection's bytes from.
 *
 * Built here rather than in the component so the route and its one caller
 * cannot drift on a parameter name — the route parses exactly these two shapes.
 */
export function previewRequestUrl(selection: TreeSelection): string {
  const params =
    selection.kind === "page"
      ? new URLSearchParams({ kind: "page", slug: selection.slug })
      : new URLSearchParams({ kind: "file", path: selection.path });
  return `${PREVIEW_ROUTE}?${params.toString()}`;
}

/**
 * The one write path FOR A PAGE. `PUT /api/wiki/[slug]` goes through
 * `writeWikiPageWithSideEffects`, so index, cross-references, backlinks and the
 * activity log all stay consistent. Named here so the Preview cannot grow a
 * second markdown writer by typing a different URL.
 *
 * Story 1.8 adds {@link ARTIFACT_WRITE_ROUTE} beside it — not a second writer
 * for the same bytes, but the only writer for a class of bytes this route
 * cannot address at all. Which of the two a payload uses is
 * {@link previewWriteTarget}'s answer and nothing else's.
 */
export const PAGE_WRITE_ROUTE = "/api/wiki";

export function pageWriteUrl(slug: string): string {
  return `${PAGE_WRITE_ROUTE}/${encodeURIComponent(slug)}`;
}

/**
 * The OTHER write path, and the only other one there is: `PUT
 * /api/workbench/artifact` (Story 1.8).
 *
 * A Wiki artifact is not a Page — no slug, no page-index entry, nothing under
 * `tenants/<t>/wiki/` — so it cannot travel through {@link PAGE_WRITE_ROUTE}
 * without acquiring all three. It goes to a route of its own that writes through
 * `writeWikiArtifact`, which fires the two side effects an artifact actually has
 * (the activity log and the refresh counter).
 */
export const ARTIFACT_WRITE_ROUTE = "/api/workbench/artifact";

/**
 * The browser never names a Wiki, a tenant or a storage key — only WHICH
 * artifact. The route re-derives everything else from the session, so this URL
 * carries exactly one parameter and nothing a caller could widen.
 */
export function artifactWriteUrl(file: EditableArtifactFile): string {
  return `${ARTIFACT_WRITE_ROUTE}?path=${encodeURIComponent(file)}`;
}

/**
 * Where an open editor's `Save` posts, and how to tell whether the column is
 * still showing the thing the draft came from.
 *
 * ONE value carrying both, because the column needs both and they must agree:
 * a `key` compared against a URL derived somewhere else is exactly how a pick
 * made mid-save writes one file's draft to another file's route. `key` is
 * namespaced (`page:` / `artifact:`) so a page whose slug happens to read
 * `schema.md` can never collide with the artifact.
 */
export type PreviewWriteTarget =
  | { kind: "page"; key: string; url: string }
  | { kind: "artifact"; key: string; url: string };

/**
 * Decide the write target for a payload, or `null` when there is none.
 *
 * A pure function rather than a branch typed into the component: this suite runs
 * `environment: "node"` with no DOM, so a rule living inside a React effect can
 * only ever be grepped for — and "which URL does Save go to" is precisely the
 * kind of rule a rewrite keeps the wording of while changing the behaviour.
 *
 * `truncated` is refused here, for both kinds, for the reason
 * {@link canEditPreview} documents. `editable` is the SERVER's judgement and is
 * required: the column decides nothing about what may be written, it only asks
 * where. And a payload that is `editable` with neither a slug nor an artifact
 * returns `null` rather than a target — otherwise the editor opens, `Save`
 * enables, and pressing it neither writes nor says why.
 */
export function previewWriteTarget(
  payload: PreviewPayload | null,
): PreviewWriteTarget | null {
  if (payload === null || !payload.editable || payload.truncated) return null;
  if (typeof payload.slug === "string" && payload.slug.length > 0) {
    return { kind: "page", key: `page:${payload.slug}`, url: pageWriteUrl(payload.slug) };
  }
  if (isEditableArtifactFile(payload.artifact)) {
    return {
      kind: "artifact",
      key: `artifact:${payload.artifact}`,
      url: artifactWriteUrl(payload.artifact),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Copy — every user-visible sentence the Preview body can show
// ---------------------------------------------------------------------------

/** The bytes are on their way. */
export const PREVIEW_LOADING_COPY = "Loading…";

/**
 * The read failed or was refused. Deliberately the same register as the tree's
 * `Your files couldn’t be loaded.`, and deliberately identical for "gated out"
 * and "absent" — the route answers both with one indistinguishable 404, so the
 * column must not be able to tell the owner which it was either.
 */
export const PREVIEW_FAILED_COPY = "This file couldn’t be loaded.";

/** The file exists and holds nothing. Not an error, and not "couldn't load". */
export const PREVIEW_EMPTY_COPY = "This file is empty.";

/**
 * Nothing is picked yet — the Wiki canvas card's undocked stand-in for the
 * Preview column, and mutually exclusive with it: `wb-canvas-preview-note` is
 * hidden by CSS while `.wb-shell` carries `data-preview="true"` (DW-39),
 * because the canvas reaches the shell as `children` and cannot read that state
 * as a prop.
 *
 * Here rather than inline in `WikiWorkbench.tsx` so it sits beside the three
 * sentences the docked column shows in its place — one module owns every
 * sentence that can occupy that slot, and rewording it is one edit.
 */
export const PREVIEW_UNSELECTED_COPY = "Select a file to preview.";

/** A format this reader does not render — a PDF, an image, an extensionless blob. */
export const PREVIEW_UNSUPPORTED_COPY = "This file can’t be previewed here.";

/**
 * The body was capped. The numeral is derived from {@link PREVIEW_MAX_CHARS}
 * rather than typed, so the sentence cannot outlive the cap it describes; the
 * locale is pinned because this build is English-only.
 */
export const PREVIEW_TRUNCATED_COPY = `Preview truncated at ${new Intl.NumberFormat(
  "en-US",
).format(PREVIEW_MAX_CHARS)} characters.`;

/**
 * Appended, visually hidden, to a wikilink whose target is not a readable page.
 * The visible state is a style; a screen reader needs the word.
 */
export const WIKILINK_MISSING_COPY = "(missing page)";

/**
 * What the shell's live region says when the Preview DOCKS (DW-34).
 *
 * Mirrors `settingsAnnouncement`'s `Settings, <category>` shape, because
 * this is the same event: a surface appeared and it is showing a named thing
 * (EXPERIENCE.md:175). Docking and undocking are silent layout changes
 * otherwise — the column simply exists, or stops existing, and a screen-reader
 * user is told nothing about either.
 *
 * A function rather than a template typed at the call site: there are two call
 * sites (a tree pick and a followed wikilink) and one wording, and the name is
 * {@link selectionName}'s answer at both.
 */
export function previewDockAnnouncement(name: string): string {
  return `Preview, ${name}`;
}

/**
 * …and when it UNDOCKS because the owner re-clicked the row they were on.
 *
 * No name in it. The column is gone, so naming what it used to show reads as a
 * report that something opened.
 */
export const PREVIEW_CLOSED_COPY = "Preview closed";

/**
 * The other way it undocks (DW-53): the row left the tree while the Preview was
 * on it, so the shell closed the column without being asked.
 *
 * Says WHY, because this one is not the owner's own action — a column that
 * simply vanished mid-read is indistinguishable from a bug. Deliberately
 * "removed" rather than "deleted": all the shell knows is that a refreshed tree
 * no longer contains the row.
 */
export const PREVIEW_REMOVED_COPY = "Preview closed — that item was removed.";

/**
 * A silent same-row refresh swapped the body underneath the reader (DW-50).
 *
 * Announced from the COLUMN's own polite region rather than the shell's: the
 * shell's region reports which surface is showing, and a body swap does not
 * change that. Polite, and never `role="alert"` — nothing failed.
 */
export const PREVIEW_UPDATED_COPY = "Preview updated";

/**
 * The read could not be reached — a transport failure, the deadline, a 5xx, or
 * a 200 whose body is not a payload (DW-54).
 *
 * Deliberately NOT {@link PREVIEW_FAILED_COPY}: that sentence replaces the body,
 * and shown for a blip it would tell the owner their page is gone while the
 * bytes are still on screen. This one sits ABOVE bytes that are still true, so
 * it says what is stale rather than what is missing.
 */
export const PREVIEW_UNREACHABLE_COPY =
  "Couldn’t refresh — showing the last version that loaded.";

/**
 * The SPOKEN form of the strip above (DW-183).
 *
 * Built FROM {@link PREVIEW_UNREACHABLE_COPY} rather than written out a second
 * time, so the sentence a reader hears and the sentence on screen cannot drift
 * into two accounts of one fact.
 *
 * Prefixed, and that is the only difference: the strip is read in place, above
 * the bytes it is about, and the column header is right there. A live-region
 * announcement arrives with no surroundings at all — "Couldn’t refresh" alone
 * could be about the trees, the Wiki switcher or a save, so it has to name
 * which surface it is about, exactly as the shell's own dock sentence does.
 */
export const PREVIEW_STALE_ANNOUNCEMENT_COPY = `Preview: ${PREVIEW_UNREACHABLE_COPY}`;

/** The one control beside it. Self-healing means this is a shortcut, not the cure. */
export const PREVIEW_RETRY_COPY = "Retry";

/**
 * …and what that control says while the read it started is still in flight
 * (DW-184).
 *
 * The same shape as {@link PREVIEW_SAVING_COPY}: the label is the busy report
 * a sighted owner gets, `aria-busy` and `disabled` are the rest of it, and a
 * slow retry stops being indistinguishable from a broken button.
 */
export const PREVIEW_RETRYING_COPY = "Retrying…";

/** The escape hatch out of view-first. */
export const PREVIEW_EDIT_COPY = "Edit";

/** The confirm gate — Preview is view-first, so editing is always a decision. */
export const PREVIEW_EDIT_CONFIRM_TITLE = "Edit this page?";
export const PREVIEW_EDIT_CONFIRM_BODY =
  "Preview is view-first. Editing opens the raw markdown — there is no rich-text editor. Saving writes through the wiki and updates its index and links.";
export const PREVIEW_EDIT_CONFIRM_LABEL = "Edit markdown";

/**
 * The same gate for the Schema, which is not a page and does not behave like
 * one. The consequence sentence is the whole reason this copy differs: a page
 * edit changes what one page says, and a Schema edit changes what every future
 * ingest, chat and lint prompt is told to do.
 */
export const PREVIEW_EDIT_SCHEMA_CONFIRM_TITLE = "Edit this Wiki’s Schema?";
export const PREVIEW_EDIT_SCHEMA_CONFIRM_BODY =
  "Preview is view-first. Editing opens the raw markdown — there is no rich-text editor. The Schema is executable: its Page conventions section is read by every ingest, chat and lint that runs after you save.";

/**
 * The OTHER gate, and the mirror image of the one above (DW-36): editing is a
 * decision, so leaving an edit unsaved is a decision too.
 *
 * Shown when a tree pick arrives while the editor holds unsaved text. The pick
 * is HELD behind this rather than applied, because applying it closes the editor
 * — a stray click on a row used to destroy the owner's markdown with no dialog,
 * no undo and nothing said.
 *
 * The body names the LOSS rather than the mechanism: which of the two ways the
 * pick reaches the editor (another row, or the same row deselecting) is not a
 * distinction the owner has to reason about, and both end with the textarea
 * unmounted. "Discard" is the destructive word, on the destructive button, so
 * the two labels can be told apart without reading the sentence above them.
 */
export const PREVIEW_DISCARD_CONFIRM_TITLE = "Discard your unsaved edits?";
export const PREVIEW_DISCARD_CONFIRM_BODY =
  "The Preview editor is holding text you haven’t saved. Changing what the Preview shows closes the editor, and that text is discarded.";
export const PREVIEW_DISCARD_CONFIRM_LABEL = "Discard edits";

/** The way back out of it — the pick is dropped and nothing at all changes. */
export const PREVIEW_KEEP_EDITING_COPY = "Keep editing";

/** Editor actions. `Cancel` is shared with the confirm dialog. */
export const PREVIEW_CANCEL_COPY = "Cancel";
export const PREVIEW_SAVE_COPY = "Save";
export const PREVIEW_SAVING_COPY = "Saving…";

/**
 * The save was refused or never landed. Distinct from {@link PREVIEW_FAILED_COPY}
 * — that sentence is about reading, and shown for a failed write it would tell
 * the owner their text was lost when the editor is still holding it. Used only
 * as the FALLBACK: a message the server supplied is always preferred.
 */
export const PREVIEW_SAVE_FAILED_COPY = "This page couldn’t be saved.";

/** The same fallback for the Schema, which is not a page. */
export const PREVIEW_SCHEMA_SAVE_FAILED_COPY = "This Schema couldn’t be saved.";

/** Every sentence the editor needs, chosen by what it is about to write. */
export interface PreviewEditCopy {
  confirmTitle: string;
  confirmBody: string;
  /** Shown only when the server supplied no sentence of its own. */
  saveFallback: string;
}

/**
 * Which of the two copy sets the confirm dialog and the save show.
 *
 * A function the node suite executes rather than a ternary typed into JSX, for
 * the same reason {@link previewWriteTarget} is one: with no DOM environment, a
 * branch in the component can only be matched as source text, and "the dialog
 * says page when it is about to overwrite the Schema" is a wording bug a source
 * scan cannot see.
 *
 * A `null` target answers the PAGE copy — the dialog is unreachable without a
 * target (`canEditPreview` is the same predicate), so this only has to be
 * total, not meaningful.
 */
export function previewEditCopy(target: PreviewWriteTarget | null): PreviewEditCopy {
  if (target?.kind === "artifact") {
    return {
      confirmTitle: PREVIEW_EDIT_SCHEMA_CONFIRM_TITLE,
      confirmBody: PREVIEW_EDIT_SCHEMA_CONFIRM_BODY,
      saveFallback: PREVIEW_SCHEMA_SAVE_FAILED_COPY,
    };
  }
  return {
    confirmTitle: PREVIEW_EDIT_CONFIRM_TITLE,
    confirmBody: PREVIEW_EDIT_CONFIRM_BODY,
    saveFallback: PREVIEW_SAVE_FAILED_COPY,
  };
}

// ---------------------------------------------------------------------------
// The two refresh decisions (DW-50, DW-54)
// ---------------------------------------------------------------------------

/**
 * Does the transient "couldn’t refresh" strip show?
 *
 * The SET of conditions is the whole content of the decision — unlike
 * {@link previewBodyState}, whose branch order is what carries its meaning, this
 * one is a conjunction in which every term is independent and none can be
 * dropped. Never over a body that is not there: with no payload the column
 * already shows
 * {@link PREVIEW_FAILED_COPY}, and a `Retry` beside it would promise to restore
 * bytes it never had. Never while `loading` either — a read is in flight, so
 * the previous one's failure is already being answered — and never while
 * {@link previewBodyState} is reporting `gone`, because a 404 replaces the body
 * and a strip above the replacement would claim the bytes underneath are merely
 * stale.
 *
 * Never while the EDITOR is open either, and that one is about the control
 * rather than the sentence: `previewFetchPlan` answers `fetch: false` for every
 * run while `editing`, so the strip's `Retry` would be a button that silently
 * does nothing on every press. The strip and its one control arrive and leave
 * together — closing the editor lets the deferred read happen, which is what
 * decides whether the strip comes back.
 *
 * Self-healing falls out of this being a pure read of current state rather than
 * a dismissible banner: the next read that already happens (a `dataVersion`
 * bump, a pick, or the `Retry` control) clears `unreachable` and the strip goes
 * with it. There is no timer and no polling loop.
 */
export function previewStaleNotice(input: {
  loading: boolean;
  gone: boolean;
  unreachable: boolean;
  editing: boolean;
  payload: PreviewPayload | null;
}): boolean {
  return (
    input.unreachable &&
    !input.loading &&
    !input.gone &&
    !input.editing &&
    input.payload !== null
  );
}

/**
 * What the COLUMN's polite live region should say after a read settled, or
 * `null` for "say nothing" (DW-50).
 *
 * Only a SILENT same-row refresh announces. The three silences each have their
 * own reason:
 *
 * - `reset` is a fresh pick, and the shell's own live region already said
 *   `Preview, <name>` when it docked — a second sentence about the same event
 *   reports it twice;
 * - no `shown` payload means nothing was swapped out from under anybody: the
 *   column was empty or failed, and arriving bytes are the first bytes;
 * - an identical body is not an update. A `dataVersion` bump fires for every
 *   write in the system, most of which are about some other page, and
 *   announcing each one would make the region chatter at a reader who is
 *   looking at an unchanged screen.
 *
 * What is compared is what the reader can PERCEIVE, which is the body and the
 * truncation flag — not the whole payload. `truncated` earns its place because
 * flipping it adds or removes {@link PREVIEW_TRUNCATED_COPY} above the bytes and
 * takes the `Edit` control with it ({@link canEditPreview} refuses a prefix), so
 * a page that grew past {@link PREVIEW_MAX_CHARS} changes the column visibly
 * even when the first 200,000 characters are byte-identical. Everything else in
 * {@link PreviewPayload} is IDENTITY rather than content: `name`, `path`,
 * `slug`, `artifact` and `format` all follow from the row this read was for —
 * which, on the only path that reaches here, is the row already showing — and
 * `editable` follows from that same row plus deployment-level facts
 * (`isReadOnly()`, the owner handle) that do not move between two reads of one
 * session. Comparing them could only announce a change nobody can perceive.
 */
export function previewRefreshAnnouncement(input: {
  reset: boolean;
  shown: PreviewPayload | null;
  next: PreviewPayload;
}): string | null {
  if (input.reset) return null;
  if (input.shown === null) return null;
  const same =
    input.shown.body === input.next.body && input.shown.truncated === input.next.truncated;
  return same ? null : PREVIEW_UPDATED_COPY;
}

/**
 * How many CONSECUTIVE unreachable reads it takes before the column says so
 * out loud (DW-183).
 *
 * Two, not one. A single failed read is the ordinary case this feature was
 * built for — a dropped packet, a proxy hiccup, one bad `dataVersion` bump —
 * and it heals on the next read that already happens, with the bytes on screen
 * unchanged throughout. Announcing it would put a failure sentence in a
 * reader's ear for a condition that was over before they finished hearing it,
 * on a screen where nothing moved.
 *
 * Two in a row is different: the first read's self-healing did not happen, so
 * the strip is going to keep standing, and a reader who cannot see it is now
 * reading bytes they have no way of knowing are stale.
 */
export const PREVIEW_UNREACHABLE_STREAK = 2;

/**
 * What the COLUMN's polite region should say about a read that could not be
 * reached, or `null` for "say nothing" (DW-183).
 *
 * `failures` is the length of the CURRENT run of unreachable results — reset
 * by any read that lands, `ok` or `gone`, and by a fresh pick.
 *
 * Exactly ON the threshold, never at-or-above: the sentence is said ONCE per
 * run. `>=` would re-announce on every subsequent failure, and since the region
 * re-announces a repeated sentence now (DW-182's mark), that would be a reader
 * told the same thing on every `dataVersion` bump in the system for as long as
 * the outage lasted — chatter with no new information in it, which is the
 * failure mode `previewRefreshAnnouncement` already refuses for the `ok` case.
 *
 * `payload` is the SAME term {@link previewStaleNotice} takes, and it is here so
 * the spoken form and the strip can only ever agree. A row whose very FIRST read
 * failed holds no payload: the body is {@link PREVIEW_FAILED_COPY} and no strip
 * appears, because there is no last version that loaded. A second consecutive
 * failure on that row still reaches the threshold, and without this term the
 * region would say "showing the last version that loaded" over a body that says
 * the file could not be loaded at all — a sentence contradicting the screen, and
 * the exact conflation DW-54 drew the strip's two states apart to prevent.
 *
 * The other four terms of `previewStaleNotice` are deliberately NOT here.
 * `unreachable` is what this branch is; `gone` and `loading` are settled by the
 * time a result is being classified; and `editing` cannot be true for a read
 * that ran at all, because `previewFetchPlan` answers `fetch: false` for every
 * run while the editor is open. `payload` is the one that can genuinely
 * disagree.
 *
 * Polite, and it lands in the column's OWN region beside `Preview updated` —
 * never `role="alert"`. Nothing was lost: the bytes are still on screen and
 * still the most recent true thing this column knows.
 */
export function previewUnreachableAnnouncement(input: {
  failures: number;
  payload: PreviewPayload | null;
}): string | null {
  if (input.payload === null) return null;
  return input.failures === PREVIEW_UNREACHABLE_STREAK
    ? PREVIEW_STALE_ANNOUNCEMENT_COPY
    : null;
}

// ---------------------------------------------------------------------------
// The two request decisions
// ---------------------------------------------------------------------------
//
// Both functions below exist so the DECISIONS they carry are executed by a test
// rather than grepped for inside a React effect. This repo has no DOM test
// environment and this story is forbidden from adding one, so a rule that lives
// in a component body can only ever be pinned by matching its source text — and
// the two rules here are exactly the kind a rewrite would keep the wording of
// while changing the behaviour: "a response that arrives after the owner picked
// another row must not reach state" and "a rejected save shows the server's
// sentence, never the transport's". Same technique the shell already uses for
// `shouldDockPreview` and `readableSlugsFromKnowledge`.
//
// Still pure and client-safe: no React, no storage, and `fetch` is a parameter
// so the node suite drives them with a stub and never opens a socket.

/** The subset of a `Response` these functions read. */
export interface PreviewResponseLike {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

/** The subset of `fetch` these functions call. The global satisfies it. */
export type PreviewFetch = (
  url: string,
  init?: {
    signal?: AbortSignal;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<PreviewResponseLike>;

/**
 * The reason a caller passes to `controller.abort()` when its own DEADLINE
 * fired, as opposed to the owner picking another row.
 *
 * Both stop the same request through the same controller, and without a way to
 * tell them apart every abort reads as "superseded" — so the caller stays
 * silent, `loading` is never cleared, and a hung request shows `Loading…` for
 * the rest of the session. That is precisely the state a deadline exists to
 * prevent, so the two reasons must produce different outcomes.
 */
export const PREVIEW_TIMEOUT_REASON = "preview-request-timeout";

/**
 * What a preview read produced.
 *
 * `stale` is deliberately its own outcome rather than a flavour of a failure: a
 * pick that lost a race is not an error, and reporting it as one would flash
 * "This file couldn’t be loaded." on a column that is about to show the row the
 * owner actually wants. A DEADLINE abort is the opposite case — nothing else is
 * coming, so it must not be silent — and resolves to `unreachable`.
 *
 * `gone` and `unreachable` are two facts, not two names for one (DW-54). A
 * single `failed` meant all five of "deleted", "gated out", "the server erred",
 * "the network blipped" and "the body was not a payload" — so a dropped packet
 * replaced the page the owner was reading with `This file couldn’t be loaded.`
 * and never healed. Split here rather than at the caller because the caller's
 * only input is this value: a component holding one boolean cannot recover a
 * distinction the read already threw away.
 *
 * The seam is 4xx versus everything else, and it is drawn where it is because
 * the two sides differ in whether RETRYING COULD EVER HELP:
 *
 * - `gone` is a 4xx the next attempt would meet again. The 404 is the route's
 *   "there is nothing here for you", deliberately indistinguishable between
 *   absent and refused per {@link PREVIEW_FAILED_COPY}; a 400 is a request this
 *   build will keep sending identically; a 401 or 403 is an expired or
 *   insufficient session. In every case the answer will not change on its own,
 *   so the body is replaced with the one sentence rather than left behind a
 *   `Retry` that can never succeed and a strip that never heals.
 * - `unreachable` is a 5xx, a transport throw, the deadline, an unparseable
 *   body, a 200 carrying JSON that is not a payload — and the three 4xx that
 *   are explicitly statements about TIMING rather than about the row. It keeps
 *   the body.
 */
export type PreviewFetchResult =
  | { status: "ok"; payload: PreviewPayload }
  | { status: "stale" }
  | { status: "gone" }
  | { status: "unreachable" };

/**
 * The statuses that will answer the same way next time.
 *
 * See {@link PreviewFetchResult}: a client-error status is a refusal this
 * browser cannot argue with, and holding stale bytes over one promises a
 * recovery that is not coming.
 *
 * The three exceptions are the 4xx that say WHEN rather than WHAT: 408 is the
 * server giving up on waiting, 425 is "you asked too early", and 429 is a rate
 * limiter — none of them a statement that the row is not there, and all three
 * answer differently on the next attempt by definition. A CDN or platform
 * limiter in front of this route is exactly the kind of intermediary DW-54
 * exists to stop mistaking for a deletion, so a throttled refresh keeps the
 * bytes the owner is reading and offers the `Retry` that will actually work.
 */
function isDeterministicRefusal(status: number): boolean {
  if (status === 408 || status === 425 || status === 429) return false;
  return status >= 400 && status < 500;
}

/**
 * Is this parsed body actually a {@link PreviewPayload}?
 *
 * A 200 is not a promise about shape. An interstitial, a proxy, or a future
 * change to the route can all put valid JSON on a 200, and the column reads
 * `payload.body.trim()` during render — where a non-string throws and takes the
 * whole column down with it rather than showing the one sentence a failed read
 * is supposed to show. Only the fields the column actually reads are checked.
 */
function isPreviewPayload(value: unknown): value is PreviewPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  return (
    typeof payload.body === "string" &&
    typeof payload.truncated === "boolean" &&
    typeof payload.editable === "boolean" &&
    // Optional, and checked only for TYPE when present: a payload without one
    // is still a payload (an `unsupported` format never carries one), and
    // `null` is that same absence spelled by a serializer. What is refused is a
    // NUMBER or an object — something that would be sent back as `If-Match` and
    // refused as a conflict the owner cannot explain.
    (payload.version === undefined ||
      payload.version === null ||
      typeof payload.version === "string") &&
    (payload.format === "markdown" ||
      payload.format === "text" ||
      payload.format === "unsupported")
  );
}

/**
 * Which kind of abort was this? See {@link PREVIEW_TIMEOUT_REASON}.
 *
 * A deadline is `unreachable`, never `gone`: a request that took too long says
 * nothing whatsoever about whether the row still exists, and answering `gone`
 * would delete a page from the owner's screen because their connection stalled.
 */
function abortOutcome(signal: AbortSignal): PreviewFetchResult {
  return signal.reason === PREVIEW_TIMEOUT_REASON
    ? { status: "unreachable" }
    : { status: "stale" };
}

/**
 * Read one selection's bytes.
 *
 * The abort check is made TWICE — once when the response lands and once after
 * the body is parsed — because both awaits are points at which the owner may
 * have picked another row, and a write from either would put one selection's
 * bytes under another selection's header.
 */
export async function fetchPreview(
  url: string,
  signal: AbortSignal,
  fetchImpl: PreviewFetch = fetch,
): Promise<PreviewFetchResult> {
  try {
    const response = await fetchImpl(url, { signal });
    if (signal.aborted) return abortOutcome(signal);
    // A refusal the next attempt will meet again replaces the body; a server
    // that erred or a hop that dropped is a read that did not land.
    if (isDeterministicRefusal(response.status)) return { status: "gone" };
    if (!response.ok) return { status: "unreachable" };
    const payload: unknown = await response.json();
    if (signal.aborted) return abortOutcome(signal);
    // A 200 carrying something else is a proxy, an interstitial or a future
    // route change — none of which is evidence that the row was removed.
    if (!isPreviewPayload(payload)) return { status: "unreachable" };
    return { status: "ok", payload };
  } catch {
    // An abort is the caller's own doing; anything else could not be reached.
    // No message is derived here at all: neither outcome carries one, so a
    // transport string can never reach the owner as copy nobody wrote.
    return signal.aborted ? abortOutcome(signal) : { status: "unreachable" };
  }
}

/**
 * What a save produced. `message` is always something a person can act on.
 *
 * `version` is the version of the bytes the write LANDED, answered by both write
 * routes so a surface that stays open can save again without a reload
 * (DW-38/51/56). Optional so a 200 from an older deployment, or a body that will
 * not parse, is still a landed save rather than an error — the next save then
 * refuses rather than clobbering, which is the safe direction.
 */
export type PreviewSaveResult =
  | { status: "ok"; version?: string }
  | { status: "error"; message: string };

/**
 * Save an edited body to a write target's URL.
 *
 * ONE save client for both write paths. The URL is the caller's — always
 * {@link previewWriteTarget}'s `url`, i.e. {@link pageWriteUrl} or
 * {@link artifactWriteUrl} — rather than a slug this function turns into a
 * route, because the moment the column had to choose between two routes the
 * alternative was a second `fetch` in the component, which is the state the
 * whole module exists to prevent. Both routes take `PUT` with `{ content }` and
 * answer `{ error }` on refusal, so nothing else here branches.
 *
 * `content` is the markdown BODY with no YAML: `PUT /api/wiki/[slug]` documents
 * the field that way and owns frontmatter end-to-end, so handing it a full file
 * would double the block. An artifact has no frontmatter at all, so its bytes
 * are the whole file.
 *
 * A rejected save resolves — it does not throw — because the caller's only
 * correct response is to keep the editor open with the owner's text and show
 * the message.
 *
 * ONLY a server-supplied `{ error }` sentence is relayed. A THROWN error never
 * is: `Failed to fetch`, `signal timed out` and `NetworkError when attempting
 * to fetch resource` are all transport vocabulary that no Copy table contains
 * and that tells the owner nothing they can act on. Those, an unparseable body
 * and a blank message all show `fallback`. A genuine 403 or 404 sentence still
 * reaches the owner verbatim, because only the server knows which it was.
 */
export async function savePreviewBody(
  url: string,
  content: string,
  options: {
    signal?: AbortSignal;
    fetchImpl?: PreviewFetch;
    fallback?: string;
    /**
     * The {@link PreviewPayload.version} the editor was SEEDED with — never one
     * re-derived at Save. Sent as `If-Match`; both write routes REQUIRE it and
     * answer 428 without it, so omitting it is a refusal rather than an
     * unconditional write.
     *
     * `null`, `undefined` and `""` are all "there is none". The empty string
     * matters: `If-Match: ""` is a malformed header rather than an absent one,
     * and sending it would be this client asserting a precondition it does not
     * have.
     */
    version?: string | null;
  } = {},
): Promise<PreviewSaveResult> {
  const send = options.fetchImpl ?? fetch;
  const fallback = options.fallback ?? PREVIEW_SAVE_FAILED_COPY;
  try {
    const response = await send(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        // Spread rather than a conditional value: a header whose value is
        // `undefined` is still a header, and `fetch` stringifies it.
        ...(options.version ? { [IF_MATCH_HEADER]: formatIfMatch(options.version) } : {}),
      },
      body: JSON.stringify({ content }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (response.ok) {
      // The landed version, so the surface can save again without a reload. A
      // body that will not parse or carries none leaves it absent — the save
      // still landed, and the NEXT one is refused rather than blind.
      const landed = (await response.json().catch(() => null)) as {
        version?: unknown;
      } | null;
      return typeof landed?.version === "string" && landed.version.length > 0
        ? { status: "ok", version: landed.version }
        : { status: "ok" };
    }
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const served = typeof body?.error === "string" ? body.error.trim() : "";
    return { status: "error", message: served || fallback };
  } catch {
    // Deliberately discards the cause's message — see the docblock.
    return { status: "error", message: fallback };
  }
}
