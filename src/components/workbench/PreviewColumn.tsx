"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  previewFetchPlan,
  requestDataVersionCheck,
} from "@/lib/workbench-data-version";
import {
  PREVIEW_CANCEL_COPY,
  PREVIEW_EDIT_CONFIRM_LABEL,
  PREVIEW_EDIT_COPY,
  PREVIEW_EMPTY_COPY,
  PREVIEW_FAILED_COPY,
  PREVIEW_LOADING_COPY,
  PREVIEW_SAVE_COPY,
  PREVIEW_SAVING_COPY,
  PREVIEW_RETRY_COPY,
  PREVIEW_TRUNCATED_COPY,
  PREVIEW_TIMEOUT_REASON,
  PREVIEW_UNREACHABLE_COPY,
  PREVIEW_UNSUPPORTED_COPY,
  canEditPreview,
  fetchPreview,
  previewBodyState,
  previewEditCopy,
  previewRefreshAnnouncement,
  previewRequestUrl,
  previewStaleNotice,
  previewWriteTarget,
  savePreviewBody,
  type PreviewPayload,
  type PreviewWriteTarget,
} from "@/lib/workbench-preview";
import {
  findKnowledgePage,
  readableSlugsFromKnowledge,
  selectionName,
  type FileNode,
  type KnowledgeGroup,
  type TreeSelection,
} from "@/lib/workbench-tree";
import { PreviewBody } from "./PreviewBody";

/**
 * The docked Preview column: header, frontmatter strip, and the body.
 *
 * `mockups/chat-cited.html:194-208` splits Preview into `header`, `.fm` and
 * `.body`, and UX-DR2 draws the type line at exactly the same seam — chrome face
 * above, reading face below. Story 1.4 shipped the two halves it had the data
 * for; this story fills `.body` from a route, because nothing in the shell could
 * fetch a file's bytes at all until now.
 *
 * VIEW-FIRST. The body renders; it does not edit. `Edit` opens
 * {@link ConfirmDialog}, and only a confirm swaps the body for a raw-markdown
 * `<textarea>`. There is no rich-text mode, no formatting bar, no autosave, and
 * no way to reach the editor around the dialog.
 *
 * ONE editor, TWO targets (Story 1.8). A Page saves through
 * `PUT /api/wiki/[slug]` — i.e. `writeWikiPageWithSideEffects`, the one page
 * write path — and the Wiki's `schema.md` saves through
 * `PUT /api/workbench/artifact`, which is the only writer for bytes the page
 * route cannot address. WHICH of the two, and which sentences the dialog shows,
 * are `previewWriteTarget` and `previewEditCopy`: functions the node suite
 * executes, because this repo has no DOM test environment and a rule typed into
 * JSX here could only ever be grepped for.
 *
 * The field names in the strip are the page's own frontmatter keys, not authored
 * labels — the same convention the mockup's `.fm` block uses.
 */

export interface PreviewColumnProps {
  selection: TreeSelection | null;
  knowledge: readonly KnowledgeGroup[];
  files: readonly FileNode[];
  /**
   * Follow a resolved `[[wikilink]]`: re-point the shell's selection at a page.
   * Not navigation — see the module docblock on why this is a button.
   */
  onOpenPage: (slug: string) => void;
  /**
   * The refresh signal the shell's current server render was built from
   * (Story 1.7). The Preview's bytes come from a client read, not from that
   * render, so re-running the server render alone would leave this column
   * showing the bytes it read before somebody else's write. It is a DEPENDENCY of the
   * fetch effect rather than a trigger the column acts on: what a re-run may
   * touch is `previewFetchPlan`'s answer, never a condition typed in here.
   */
  dataVersion: number;
  /**
   * Forwarded onto the `<aside>` so the SHELL can scroll the docked column into
   * view below 900px (DW-34), where it is a stacked fourth row rather than a
   * column beside the canvas. The shell owns the dock, so it owns the reveal;
   * this column never reads the viewport and never scrolls itself.
   */
  ref?: Ref<HTMLElement>;
}

/**
 * A request that never settles would leave a busy flag true for the rest of the
 * session with no error to explain it. `finally` cannot rescue a promise that
 * never resolves, so the deadline is the rescue — the idiom `WikiSwitcher`
 * already uses for the same reason.
 */
const REQUEST_TIMEOUT_MS = 15_000;

export function PreviewColumn({
  selection,
  knowledge,
  files,
  onOpenPage,
  dataVersion,
  ref,
}: PreviewColumnProps) {
  // No selection, no column — the shell already decides this with
  // `shouldDockPreview`, and this keeps the component honest on its own. The
  // hooks all live in `PreviewPane` so none of them sits behind this branch.
  if (!selection) return null;
  return (
    <PreviewPane
      selection={selection}
      knowledge={knowledge}
      files={files}
      onOpenPage={onOpenPage}
      dataVersion={dataVersion}
      ref={ref}
    />
  );
}

function PreviewPane({
  selection,
  knowledge,
  files,
  onOpenPage,
  dataVersion,
  ref,
}: PreviewColumnProps & { selection: TreeSelection }) {
  const [payload, setPayload] = useState<PreviewPayload | null>(null);
  // What is on screen RIGHT NOW, readable from an async callback that closed
  // over an older render. Assigned during render, the `useDialogA11y` idiom.
  const payloadRef = useRef<PreviewPayload | null>(null);
  payloadRef.current = payload;
  // The route answered 404: the row is not there. Replaces the body.
  const [gone, setGone] = useState(false);
  // The read did not land at all — a blip, a 5xx, the deadline, a body that was
  // not a payload. Two flags rather than one, because they are two facts and a
  // single `failed` is what made a dropped packet look like a deletion (DW-54).
  const [unreachable, setUnreachable] = useState(false);
  const [loading, setLoading] = useState(true);
  // Bumped by the `Retry` control and read as a fetch-effect DEPENDENCY, which
  // is what makes a retry go through exactly the same plan as every other read
  // — including the rule that an open editor defers it — instead of becoming a
  // second request path with its own reset semantics.
  const [retryNonce, setRetryNonce] = useState(0);
  // What the column's OWN polite region says. Separate from the shell's, which
  // reports which surface is showing; a body swapped underneath a reader is a
  // change to what they are reading, not to where they are (DW-50).
  const [refreshAnnouncement, setRefreshAnnouncement] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  // The write target the open editor was SEEDED from — the URL Save posts to
  // AND the key that says which thing the draft came from. Captured when the
  // editor opens rather than derived from `payload` when Save is pressed,
  // because those two differ exactly when a pick landed while the editor was
  // open — and reading the current payload there would write file A's draft to
  // file B's route. The selection effect closes the editor, so this should never
  // disagree; it is a ref precisely so that "should" is not the only thing
  // holding.
  const editingTargetRef = useRef<PreviewWriteTarget | null>(null);
  // Armed only when the owner LEAVES the editor themselves. A selection change
  // also closes the editor, and pulling focus back to `Edit` there would steal
  // it from the tree row they just clicked.
  const restoreEditFocus = useRef(false);
  // Which row the effect last read bytes FOR. The effect now re-runs for two
  // different reasons — a pick, and a bump — and only this ref can tell them
  // apart: `selection` is already the new one by the time the effect runs, so
  // comparing it to itself would answer "same row" for both. Both reading it
  // and updating it are `previewFetchPlan`'s job; see the effect below.
  const shownSelectionRef = useRef<TreeSelection | null>(null);
  const editorId = useId();

  // Wikilinks resolve against the same set the Knowledge tab renders, so a link
  // is actionable exactly when the row it would select is visible.
  const readableSlugs = useMemo(() => readableSlugsFromKnowledge(knowledge), [knowledge]);

  useEffect(() => {
    // WHY this effect is running, and therefore what it may touch — decided by
    // an executed function, never by conditions typed here. A bump that lands
    // while the owner is mid-edit must not take their draft, and a bump that
    // lands while they are reading must not flash `Loading…` at them; both of
    // those are `previewFetchPlan`'s answers, which the node suite runs.
    const plan = previewFetchPlan({
      shown: shownSelectionRef.current,
      next: selection,
      editing,
    });
    // The row this run leaves recorded is the PLAN's answer, not an assignment
    // sequenced against the comparison above: `shownSelectionRef.current =
    // selection` written by hand here would make every run look like the same
    // row the moment somebody hoisted it, and a pick made while the editor is
    // open would then keep row A's bytes and A's draft under row B's header.
    shownSelectionRef.current = plan.shown;
    // The open editor is never disturbed. `editing` is in the deps below, so
    // closing it lets the deferred read happen instead of losing it.
    if (!plan.fetch) return;
    const controller = new AbortController();
    // The deadline is armed here rather than through `AbortSignal.timeout` so
    // one controller carries both reasons to stop: the owner picking another
    // row, and the request taking too long. They are NOT the same outcome — a
    // superseded pick is silent because another answer is coming, while a
    // deadline means nothing else is, so it must clear `loading` and say so.
    // `fetchPreview` tells them apart by the reason passed here.
    const deadline = setTimeout(
      () => controller.abort(PREVIEW_TIMEOUT_REASON),
      REQUEST_TIMEOUT_MS,
    );
    if (plan.reset) {
      setLoading(true);
      setGone(false);
      setUnreachable(false);
      setPayload(null);
      // A new row has nothing to have been updated FROM, and the shell already
      // announced the dock. Clearing keeps a sentence about the previous row
      // from being re-read when this region next changes.
      setRefreshAnnouncement("");
      // A pick abandons an open editor: the column is about to show another
      // file's bytes, and a textarea holding this one's draft over that one's
      // header is the state `save`'s target check also refuses.
      setEditing(false);
      editingTargetRef.current = null;
      setConfirmOpen(false);
      setSaveError(null);
    }

    // One branch per outcome, and no decision of its own: whether a response is
    // stale (the owner picked another row mid-flight), gone (a 404) or merely
    // unreachable is decided by `fetchPreview`, which the node suite executes
    // with a stubbed fetch. Left inline here it could only ever be grepped for.
    void fetchPreview(previewRequestUrl(selection), controller.signal).then((result) => {
      if (result.status === "stale") return;
      // Both flags are cleared EXPLICITLY, not only via the reset block above: a
      // silent refresh starts from whatever the last read left behind, so a row
      // that failed once would keep saying so after it began answering again —
      // and that clearing is exactly what makes an unreachable read self-heal
      // on the next read that already happens, with no timer anywhere.
      if (result.status === "ok") {
        // WHETHER this swap is worth a sentence is an executed function, not a
        // comparison typed here: a bump fires for every write in the system, so
        // an unguarded announcement would chatter at a reader whose screen did
        // not change. `??` to the empty string, because a live region's content
        // is a string and `null` would render the word.
        setRefreshAnnouncement(
          previewRefreshAnnouncement({
            reset: plan.reset,
            shown: payloadRef.current,
            next: result.payload,
          }) ?? "",
        );
        setPayload(result.payload);
        setGone(false);
        setUnreachable(false);
      } else if (result.status === "gone") {
        // A page another actor just deleted must not keep rendering as if it
        // were there — the body is replaced, and no stale strip appears over a
        // replacement that is not stale.
        setGone(true);
        setUnreachable(false);
      } else {
        // The read could not be reached. The last-good bytes STAY: they are the
        // most recent true thing this column knows, and replacing them with a
        // failure sentence because of one dropped packet is the bug DW-54 is.
        setUnreachable(true);
      }
      setLoading(false);
    });

    return () => {
      clearTimeout(deadline);
      controller.abort();
    };
  }, [selection, dataVersion, editing, retryNonce]);

  // Confirming the dialog unmounts the `Edit` button that opened it, so
  // `useDialogA11y`'s restore has nothing to return focus to. The caret belongs
  // in the editor anyway; leaving is the mirror image. Parent effects run after
  // the dialog's own cleanup, so this is the last word on focus either way.
  useEffect(() => {
    if (editing) {
      editorRef.current?.focus();
      return;
    }
    if (restoreEditFocus.current) {
      restoreEditFocus.current = false;
      editRef.current?.focus();
    }
  }, [editing]);

  const startEditing = useCallback(() => {
    if (!payload) return;
    // The target is captured HERE, from the payload the body was rendered from
    // — not re-derived at Save. `canEditPreview` is the same predicate, so the
    // `Edit` control was on screen only when this was non-null WHEN IT WAS
    // PRESSED — but a silent same-row refresh (Story 1.7) can replace the
    // payload while this dialog is open, and the new one may be truncated or no
    // longer editable. Opening the editor then would seed `editingTargetRef`
    // with `null`, and `Save` would neither write nor say why: the outcome
    // `previewWriteTarget` documents as the worst of the three. So the dialog
    // closes and the column stays view-first instead.
    const target = previewWriteTarget(payload);
    if (!target) {
      setConfirmOpen(false);
      return;
    }
    // The editor is seeded with the SAME string the body rendered, which is the
    // same string the write route expects — for a page the route stripped the
    // YAML block before it ever reached the browser, and for an artifact there
    // is no block to strip.
    setDraft(payload.body);
    editingTargetRef.current = target;
    setSaveError(null);
    setConfirmOpen(false);
    setEditing(true);
  }, [payload]);

  const save = useCallback(async () => {
    const target = editingTargetRef.current;
    if (!target || saving) return;
    // The column must still be showing the thing this draft came from, compared
    // by the SAME key the save is about to post to — a check against some other
    // expression of "same row" could pass while the URL points elsewhere. It
    // always is — the selection effect closes the editor — and the check is here
    // so that a change to the effect cannot turn the editor into a cross-file
    // overwrite without something refusing.
    if (previewWriteTarget(payloadRef.current)?.key !== target.key) return;
    setSaving(true);
    setSaveError(null);
    // The request, the write route and the "server's sentence, else the Copy
    // table's" rule all live in `workbench-preview`, where a stubbed fetch can
    // run them. `savePreviewBody` RESOLVES on a rejected save rather than
    // throwing, because the only correct response is to keep the editor open.
    const result = await savePreviewBody(target.url, draft, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      fallback: previewEditCopy(target).saveFallback,
    });
    // Busy flag first, on every exit path including the superseded one below.
    setSaving(false);
    // The owner may have picked another row while this was in flight. The
    // column is showing that row now, so stamping this draft onto its payload
    // would put file A's text under file B's header — and the focus restore
    // would pull focus off whatever they just clicked. The write is done and
    // the shell will notice it either way — the bump already landed.
    if (previewWriteTarget(payloadRef.current)?.key !== target.key) return;
    if (result.status === "ok") {
      // Back to view-first showing what was saved. The body is the text that
      // just went over the wire, so no second read is needed to be truthful.
      setPayload((current) => (current ? { ...current, body: draft } : current));
      restoreEditFocus.current = true;
      setEditing(false);
      // The trees carry the page's title and `updated`, both of which this write
      // may have changed — but this column does not refresh anything itself.
      // The write bumped `dataVersion` at the kernel's one tail like every other
      // write in the system, so the owner's own save is not a special case: it
      // just asks the watcher to look NOW instead of on the next tick, and the
      // answer still comes from the server's integer.
      requestDataVersionCheck();
    } else {
      // The editor stays open holding the owner's text — a failed save must
      // never be the thing that loses it.
      setSaveError(result.message);
    }
  }, [draft, saving]);

  const page = selection.kind === "page" ? findKnowledgePage(knowledge, selection.slug) : null;
  // WHAT to call this pick is `selectionName`, in `workbench-tree` where the
  // node suite runs it — not a ternary here. The shell speaks the same name in
  // its dock announcement (DW-34), and two derivations of one name is how the
  // sentence a screen reader hears starts naming something other than what this
  // header shows.
  const name = selectionName(selection, knowledge, files);

  // Every condition lives in one executed function — see `canEditPreview`, which
  // is `previewWriteTarget(payload) !== null`. Left inline, dropping the
  // truncation half kept the whole suite green.
  const canEdit = canEditPreview(payload);
  // WHICH sentences the confirm dialog shows — a page's or the Schema's —
  // decided by an executed function rather than a ternary in the JSX below. A
  // dialog that promised to update "its index and links" while overwriting the
  // Schema is a wording bug no source scan can see.
  const editCopy = previewEditCopy(previewWriteTarget(payload));

  function body() {
    // WHICH state this is, decided by an executed function rather than by four
    // conditions spelled inline — see `previewBodyState`. Left here, inverting
    // the empty test showed `This file is empty.` for every readable file with
    // the whole suite green, because a source scan is all a node suite can do
    // to a component. This function only maps a state to its element.
    const state = previewBodyState({ loading, gone, payload });
    if (state.kind === "loading") {
      return <p className="wb-preview-note">{PREVIEW_LOADING_COPY}</p>;
    }
    if (state.kind === "failed") {
      return (
        <p className="wb-preview-note" role="alert">
          {PREVIEW_FAILED_COPY}
        </p>
      );
    }
    if (state.kind === "unsupported") {
      return <p className="wb-preview-note">{PREVIEW_UNSUPPORTED_COPY}</p>;
    }
    if (state.kind === "empty") {
      return <p className="wb-preview-note">{PREVIEW_EMPTY_COPY}</p>;
    }
    return (
      <>
        {/* ABOVE the body, not after it: below 200,000 characters of prose the
            sentence is only reachable by scrolling to the end of a page whose
            end is exactly what was cut off — and it is also the explanation for
            the `Edit` control being absent, which is visible from the top. */}
        {state.payload.truncated && (
          <p className="wb-preview-note">{PREVIEW_TRUNCATED_COPY}</p>
        )}
        <div className="wb-preview-body">
          <PreviewBody
            format={state.payload.format}
            content={state.payload.body}
            readableSlugs={readableSlugs}
            onOpenPage={onOpenPage}
          />
        </div>
      </>
    );
  }

  return (
    <aside className="wb-preview" aria-label="Preview" ref={ref}>
      <header className="wb-preview-head">
        <strong className="wb-preview-title">Preview</strong>
        <span className="wb-preview-name">{name}</span>
        {canEdit && !editing && (
          <button
            type="button"
            ref={editRef}
            className="wb-preview-edit"
            onClick={() => setConfirmOpen(true)}
          >
            {PREVIEW_EDIT_COPY}
          </button>
        )}
      </header>

      <div className="wb-preview-fm">
        {selection.kind === "page" ? (
          <>
            {/* No `title:` row — the header above already carries it, and
                printing it twice one line apart reads as two different fields. */}
            <p className="wb-preview-fm-row">
              <code className="wb-preview-path">wiki/{selection.slug}.md</code>
            </p>
            {page?.type && <p className="wb-preview-fm-row">type: {page.type}</p>}
            {page?.updated && <p className="wb-preview-fm-row">updated: {page.updated}</p>}
            {typeof page?.sourceCount === "number" && (
              <p className="wb-preview-fm-row">sources: {page.sourceCount}</p>
            )}
          </>
        ) : (
          <p className="wb-preview-fm-row">
            <code className="wb-preview-path">{selection.path}</code>
          </p>
        )}
      </div>

      {/* ABOVE the body, because it is a statement ABOUT the body: the bytes
          below are the last ones that arrived, not the ones the last read asked
          for. WHETHER it shows is `previewStaleNotice` — never over a missing
          body, never during a read, never over a 404's replacement, and never
          while the editor is open, where `previewFetchPlan` defers every read
          and `Retry` could only be a control that silently does nothing. All
          five conditions live in that one executed function; none is typed
          here. It is transient rather than dismissible, so the next read that
          already happens takes it away. No `role="alert"`: nothing was lost,
          and nothing was deleted. */}
      {previewStaleNotice({ loading, gone, unreachable, editing, payload }) && (
        <div className="wb-preview-stale">
          <p className="wb-preview-stale-note">{PREVIEW_UNREACHABLE_COPY}</p>
          <button
            type="button"
            className="wb-preview-retry"
            // Bumps a dependency of the fetch effect rather than calling a
            // reader of its own: one request path, one plan, one set of reset
            // rules. `Date.now()` would also be a new value every press, and a
            // counter cannot collide with itself twice in the same millisecond.
            onClick={() => setRetryNonce((nonce) => nonce + 1)}
          >
            {PREVIEW_RETRY_COPY}
          </button>
        </div>
      )}

      {/* The column's OWN polite region. Inside the column, not the shell's:
          the shell reports which SURFACE is showing, and a body replaced
          underneath a reader is a change to what they are reading. Empty
          whenever there is nothing to report, so a restore, a pick and an
          unchanged refresh are all silent. */}
      <p className="wb-sr-only" aria-live="polite">
        {refreshAnnouncement}
      </p>

      {editing ? (
        <div className="wb-preview-editor">
          {/* Raw markdown, and only raw markdown: no formatting controls of any
              kind, and no YAML — the block never left the server. */}
          <label className="wb-sr-only" htmlFor={editorId}>
            {name}
          </label>
          <textarea
            id={editorId}
            ref={editorRef}
            className="wb-preview-textarea"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            // `readOnly`, not `disabled`: disabling the element that currently
            // has focus moves focus to `<body>`, so a slow save would drop the
            // caret and, on failure, hand the owner back an editor they are no
            // longer in. The two buttons below still disable — losing focus on
            // a button the owner just pressed costs nothing.
            readOnly={saving}
            aria-busy={saving}
          />
          {saveError && (
            <p role="alert" className="wb-preview-error">
              {saveError}
            </p>
          )}
          <div className="wb-preview-actions">
            <button
              type="button"
              className="wb-preview-action"
              onClick={() => {
                restoreEditFocus.current = true;
                setEditing(false);
                setSaveError(null);
              }}
              disabled={saving}
            >
              {PREVIEW_CANCEL_COPY}
            </button>
            <button
              type="button"
              className="wb-preview-action wb-preview-action--primary"
              onClick={() => void save()}
              // An empty body is a 400 from the write route, whose message is a
              // developer string in no Copy table and one keystroke away. The
              // control says so instead of the server having to.
              disabled={saving || draft.trim().length === 0}
            >
              {saving ? PREVIEW_SAVING_COPY : PREVIEW_SAVE_COPY}
            </button>
          </div>
        </div>
      ) : (
        body()
      )}

      {/* The one overlay level (UX-DR17). Esc and Cancel both leave view-first
          with nothing written; only Confirm opens the editor. */}
      <ConfirmDialog
        open={confirmOpen}
        title={editCopy.confirmTitle}
        body={editCopy.confirmBody}
        confirmLabel={PREVIEW_EDIT_CONFIRM_LABEL}
        cancelLabel={PREVIEW_CANCEL_COPY}
        onConfirm={startEditing}
        onCancel={() => setConfirmOpen(false)}
        fallbackFocusRef={editRef}
      />
    </aside>
  );
}
