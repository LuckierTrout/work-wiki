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
  /** The confirm-gated editor is offered only when this is true. */
  editable: boolean;
}

/**
 * May the confirm-gated editor be offered for this payload?
 *
 * Exactly "is there somewhere for `Save` to go", which is
 * {@link previewWriteTarget}. Expressing it that way rather than as a second
 * list of conditions is what keeps the truncation rule ATTACHED to the decision
 * instead of sitting beside it: the editor is seeded with `payload.body`, which
 * for a capped file is a PREFIX, and saving that replaces a whole page — or,
 * since Story 1.8, a whole executable Schema — with its first
 * {@link PREVIEW_MAX_CHARS} characters. Inline in JSX, deleting half of the old
 * pair left the entire suite green.
 */
export function canEditPreview(payload: PreviewPayload | null): boolean {
  return previewWriteTarget(payload) !== null;
}

/**
 * Which of the five things the body area shows.
 *
 * The branch ORDER is the whole content of this decision — `loading` before
 * `failed`, a missing payload folded into `failed`, `unsupported` before
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
  failed: boolean;
  payload: PreviewPayload | null;
}): PreviewBodyState {
  if (input.loading) return { kind: "loading" };
  // No payload and not loading is a failure whether or not the flag was set:
  // there is nothing to render, and nothing else true to say about it.
  if (input.failed || input.payload === null) return { kind: "failed" };
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
 * `stale` is deliberately its own outcome rather than a flavour of `failed`: a
 * pick that lost a race is not an error, and reporting it as one would flash
 * "This file couldn’t be loaded." on a column that is about to show the row the
 * owner actually wants. A DEADLINE abort is the opposite case — nothing else is
 * coming, so it must not be silent — and resolves to `failed`.
 */
export type PreviewFetchResult =
  | { status: "ok"; payload: PreviewPayload }
  | { status: "stale" }
  | { status: "failed" };

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
    (payload.format === "markdown" ||
      payload.format === "text" ||
      payload.format === "unsupported")
  );
}

/** Which kind of abort was this? See {@link PREVIEW_TIMEOUT_REASON}. */
function abortOutcome(signal: AbortSignal): PreviewFetchResult {
  return signal.reason === PREVIEW_TIMEOUT_REASON
    ? { status: "failed" }
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
    if (!response.ok) return { status: "failed" };
    const payload: unknown = await response.json();
    if (signal.aborted) return abortOutcome(signal);
    if (!isPreviewPayload(payload)) return { status: "failed" };
    return { status: "ok", payload };
  } catch {
    // An abort is the caller's own doing; anything else is a real failure. No
    // message is derived here at all: every read failure shows one sentence
    // ({@link PREVIEW_FAILED_COPY}), so a transport string can never reach the
    // owner as copy nobody wrote.
    return signal.aborted ? abortOutcome(signal) : { status: "failed" };
  }
}

/** What a save produced. `message` is always something a person can act on. */
export type PreviewSaveResult =
  | { status: "ok" }
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
  } = {},
): Promise<PreviewSaveResult> {
  const send = options.fetchImpl ?? fetch;
  const fallback = options.fallback ?? PREVIEW_SAVE_FAILED_COPY;
  try {
    const response = await send(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (response.ok) return { status: "ok" };
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const served = typeof body?.error === "string" ? body.error.trim() : "";
    return { status: "error", message: served || fallback };
  } catch {
    // Deliberately discards the cause's message — see the docblock.
    return { status: "error", message: fallback };
  }
}
