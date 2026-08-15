/**
 * The Workbench Preview's vocabulary: what the body can be, how big it may get,
 * what the route answers with, and every sentence the column can show.
 *
 * Pure and client-safe, the same rule `workbench-tree.ts` follows — the route
 * imports it on the server, the column imports it in the browser, and the node
 * suite executes it. One module owns the vocabulary so no shape and no sentence
 * is spelled twice across the client/server boundary.
 */

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
  format: PreviewFormat;
  /** Markdown BODY — never the YAML block, which the server strips. */
  body: string;
  /** The body was longer than {@link PREVIEW_MAX_CHARS} and was sliced. */
  truncated: boolean;
  /** The confirm-gated editor is offered only when this is true. */
  editable: boolean;
}

/**
 * May the confirm-gated editor be offered for this payload?
 *
 * THREE conditions, and they travel together. `editable` is the route's judgement
 * that a write path exists (a compiled Page, never an artifact or a source).
 * `!truncated` is the one that is easy to drop and expensive to lose: the editor
 * is seeded with `payload.body`, which for a capped page is a PREFIX, and saving
 * it would replace the whole page with that prefix through
 * `writeWikiPageWithSideEffects`. A pure function so a test executes the pair —
 * inline in JSX, deleting half of it left the whole suite green.
 */
export function canEditPreview(payload: PreviewPayload | null): boolean {
  if (payload === null) return false;
  // A THIRD condition, and the reason it is here rather than assumed: the editor
  // saves to `pageWriteUrl(slug)`, so a payload that is `editable` without a
  // slug can open the editor, enable `Save`, and then do nothing at all when it
  // is pressed — the worst of the three outcomes, because it neither writes nor
  // says why. The route never emits that pair; `isPreviewPayload` does not check
  // it either, so nothing else refuses it.
  if (typeof payload.slug !== "string" || payload.slug.length === 0) return false;
  return payload.editable && !payload.truncated;
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
 * The ONE write path. `PUT /api/wiki/[slug]` goes through
 * `writeWikiPageWithSideEffects`, so index, cross-references, backlinks and the
 * activity log all stay consistent. Named here so the Preview cannot grow a
 * second markdown writer by typing a different URL.
 */
export const PAGE_WRITE_ROUTE = "/api/wiki";

export function pageWriteUrl(slug: string): string {
  return `${PAGE_WRITE_ROUTE}/${encodeURIComponent(slug)}`;
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
 * Save an edited body through {@link PAGE_WRITE_ROUTE}.
 *
 * `content` is the markdown BODY with no YAML: that route documents the field
 * that way and owns frontmatter end-to-end, so handing it a full file would
 * double the block.
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
  slug: string,
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
    const response = await send(pageWriteUrl(slug), {
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
