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
import { SurfaceVisibilityProvider } from "@/hooks/useSurfaceVisibility";
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
  PREVIEW_HISTORY_COPY,
  PREVIEW_HISTORY_EMPTY_COPY,
  PREVIEW_HISTORY_HIDE_COPY,
  PREVIEW_HISTORY_LOADING_COPY,
  PREVIEW_HISTORY_READ_ONLY_COPY,
  PREVIEW_HISTORY_REVERTED_COPY,
  PREVIEW_HISTORY_REVERTING_COPY,
  PREVIEW_HISTORY_REVERT_CONFIRM_LABEL,
  PREVIEW_HISTORY_REVERT_CONFIRM_TITLE,
  PREVIEW_HISTORY_REVERT_COPY,
  PREVIEW_HISTORY_VIEW_COPY,
  PREVIEW_LOADING_COPY,
  PREVIEW_SAVE_COPY,
  PREVIEW_SAVING_COPY,
  PREVIEW_RETRY_COPY,
  PREVIEW_RETRYING_COPY,
  PREVIEW_TRUNCATED_COPY,
  PREVIEW_TIMEOUT_REASON,
  PREVIEW_UNREACHABLE_COPY,
  PREVIEW_UNSUPPORTED_COPY,
  artifactRevisionDate,
  artifactRevisionMeta,
  canEditPreview,
  fetchArtifactRevision,
  fetchArtifactRevisions,
  fetchPreview,
  previewBodyState,
  previewDraftDirty,
  previewEditCopy,
  previewEditTarget,
  previewHistoryRevertConfirmBody,
  previewHistoryTarget,
  previewRefreshAnnouncement,
  previewRequestUrl,
  previewStaleNotice,
  previewUnreachableAnnouncement,
  revertArtifactRevision,
  savePreviewBody,
  type ArtifactRevisionSummary,
  type PreviewPayload,
  type PreviewWriteTarget,
} from "@/lib/workbench-preview";
import { nextAnnouncement } from "@/lib/live-region";
import type { EditableArtifactFile } from "@/lib/wiki-scenarios";
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
 * are `previewEditTarget` and `previewEditCopy`: functions the node suite
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
   * Does the open editor hold text that has not been saved (DW-36)?
   *
   * Reported UP as one boolean and never as the draft: the shell's only question
   * is whether a tree pick may be applied, and a shell that could read the text
   * would become a second owner of this column's state. Required rather than
   * optional — a shell that forgot to wire it would silently go back to
   * destroying markdown on a stray click, which is the bug itself.
   *
   * Called from an effect, so it must be STABLE across renders; the shell
   * satisfies that with a `useCallback` writing a ref. The effect's cleanup
   * reports `false`, because an unmounted column has no draft and must not leave
   * the shell gating picks on one.
   */
  onDirtyChange: (dirty: boolean) => void;
  /**
   * `YOPEDIA_READONLY=1`, read on the server and already in the shell's scope
   * from `useWorkbenchData()` — no route and no client fetch for a fact the
   * process already holds, the same way `WikiSwitcher` receives it.
   *
   * It gates the History panel's Revert BEFORE the confirm (DW-149).
   * `POST /api/workbench/artifact/revisions` answers 403 on such a deployment
   * and `writeWikiArtifact` refuses behind it, so leaving this out would put a
   * destructive dialog in front of an owner to tell them, after they answered
   * it, that the deployment was never going to run it.
   *
   * Optional and defaulting to writable: every existing mount of this column
   * predates the prop, and a column that refused by default would withdraw a
   * control on a deployment that can write.
   */
  readOnly?: boolean;
  /**
   * The DOM id the `<aside>` carries (DW-45).
   *
   * The Preview divider is a `role="separator"`, and the ARIA window-splitter
   * pattern names the pane a separator resizes through `aria-controls`. The shell
   * owns both the handle and this column, so it owns the id that ties them
   * together — required rather than optional, because an `aria-controls` that
   * resolves to nothing is worse than none and a shell that forgot to pass it
   * should not compile.
   */
  id: string;
  /**
   * Another surface — Settings — is showing in this column's place (DW-412).
   *
   * The column stays MOUNTED and goes off screen, exactly as the mode canvas
   * does under DW-373, because it can be holding an unsaved markdown draft:
   * unmounting it for the visit discards that draft with no confirm and no way
   * back. Hiding is not closing — nothing here flips `editing`, clears the
   * payload or resets the selection.
   *
   * It is published through `SurfaceVisibilityProvider` as well as spelled on
   * the `<aside>`, because this column owns two `ConfirmDialog`s: `hidden`
   * withdraws their pixels, their accessibility-tree entries and their tab
   * order, and nothing they did to the DOCUMENT — the body scroll lock, the
   * capture-phase Tab trap — which is what `useDialogA11y` needs told.
   */
  hidden?: boolean;
  /**
   * Forwarded onto the `<aside>` so the SHELL can scroll the docked column into
   * view below the stacking breakpoint (DW-34), where it is a stacked fourth row
   * rather than a column beside the canvas. The shell owns the dock, so it owns
   * the reveal; this column never reads the viewport and never scrolls itself.
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
  onDirtyChange,
  readOnly = false,
  id,
  hidden = false,
  ref,
}: PreviewColumnProps) {
  // No selection, no column — the shell already decides this with
  // `shouldDockPreview`, and this keeps the component honest on its own. The
  // hooks all live in `PreviewPane` so none of them sits behind this branch.
  if (!selection) return null;
  return (
    // The withdrawal's second half (DW-412). `hidden` takes the pixels, the
    // accessibility tree and the tab order; the two `ConfirmDialog`s below can
    // still be holding a `document.body` scroll lock and a capture-phase Tab
    // trap, and only this tells `useDialogA11y` to stand those down. Wrapped
    // around the pane rather than declared inside it, so the provider cannot be
    // separated from the attribute by an early return.
    <SurfaceVisibilityProvider visible={!hidden}>
      <PreviewPane
        selection={selection}
        knowledge={knowledge}
        files={files}
        onOpenPage={onOpenPage}
        dataVersion={dataVersion}
        onDirtyChange={onDirtyChange}
        readOnly={readOnly}
        id={id}
        hidden={hidden}
        ref={ref}
      />
    </SurfaceVisibilityProvider>
  );
}

function PreviewPane({
  selection,
  knowledge,
  files,
  onOpenPage,
  dataVersion,
  onDirtyChange,
  readOnly = false,
  id,
  hidden = false,
  ref,
}: PreviewColumnProps & { selection: TreeSelection }) {
  const [payload, setPayload] = useState<PreviewPayload | null>(null);
  // What is on screen RIGHT NOW, readable from an async callback that closed
  // over an older render. Assigned during render, the `useDialogA11y` idiom.
  const payloadRef = useRef<PreviewPayload | null>(null);
  payloadRef.current = payload;
  // The route answered 404: the row is not there. Replaces the body.
  const [gone, setGone] = useState(false);
  // …and the same fact readable from an async callback, beside `payloadRef` and
  // for the same reason. It is HALF of the edit decision (DW-181): the `gone`
  // branch deliberately keeps the payload, so `save()`'s guards would otherwise
  // go on measuring a target derived from bytes a 404 has already replaced.
  const goneRef = useRef(false);
  goneRef.current = gone;
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
  // Is the read `Retry` started still in flight (DW-184)? Drives `aria-busy`,
  // `disabled` and the control's label. State rather than a ref because three
  // attributes render from it — the opposite of `failuresRef` below, which
  // nothing renders from.
  const [retrying, setRetrying] = useState(false);
  // How many unreachable reads have landed IN A ROW. Read and written inside
  // the same settle callback, and no element shows it, so a ref rather than
  // state: as state it would cost a render per failure for a value nothing
  // renders. WHETHER a run of this length is worth a sentence is
  // `previewUnreachableAnnouncement`, never a comparison typed here.
  const failuresRef = useRef(0);
  // What the column's OWN polite region says. Separate from the shell's, which
  // reports which surface is showing; a body swapped underneath a reader is a
  // change to what they are reading, not to where they are (DW-50).
  const [refreshAnnouncement, setRefreshAnnouncement] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // The string the editor was SEEDED with, kept beside the draft it is compared
  // against (DW-36). State rather than a ref because the dirty report is an
  // effect and a ref write would not re-run it — the seed is set in the same
  // commit as the draft, so a ref here would leave the first keystroke after an
  // open comparing against the PREVIOUS row's bytes.
  //
  // `null` is "no editor was seeded", which is not the same as "seeded with an
  // empty file": the empty file's draft is genuinely dirty the moment a
  // character is typed, and `previewDraftDirty` is where that distinction is
  // executed rather than inferred here.
  const [draftSeed, setDraftSeed] = useState<string | null>(null);
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
  // The WRITE PRECONDITION the open editor was seeded with (DW-38/51/56), taken
  // in the same breath as `draftSeed` and the target above and never re-derived
  // at Save — which is the whole point: a silent same-row refresh (Story 1.7)
  // deliberately leaves an open editor alone, so `payload.version` may already
  // describe another actor's bytes by the time Save is pressed. Reading it there
  // would send a version that matches, and the save would clobber exactly the
  // write this guard exists to notice.
  const editingVersionRef = useRef<string | null | undefined>(undefined);
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

  // ---- The History panel (DW-214) -----------------------------------------
  //
  // Every RULE about when it shows and what it says is in
  // `workbench-preview.ts`; what lives here is state and the three requests.
  //
  // Is the disclosure expanded? Collapsed is the default for the same reason
  // `RevisionHistory`'s is: history is a recovery path, not something an owner
  // reading a Schema asked to see, and fetching it unasked would put a request
  // behind every artifact row.
  const [historyOpen, setHistoryOpen] = useState(false);
  // `null` is "never fetched for this row", which is what makes the expand
  // fetch ONCE: a list that came back empty is `[]` and is not re-requested.
  const [revisions, setRevisions] = useState<ArtifactRevisionSummary[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  // ONE sentence slot for the panel — a listing that failed, a view that
  // failed, a revert that failed. They cannot overlap: each is the outcome of
  // the owner's last action in here, and a second slot would leave a stale
  // sentence from one action standing beside another's.
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [viewingTimestamp, setViewingTimestamp] = useState<number | null>(null);
  const [viewContent, setViewContent] = useState<string | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  // Which entry the confirm gate is about, or `null` for "no dialog". The
  // timestamp itself rather than a boolean beside it: the dialog and the write
  // must name the same revision, and two values are how they come to disagree.
  const [pendingRevert, setPendingRevert] = useState<number | null>(null);
  // WHICH entry is being written, not merely THAT one is. A boolean here put
  // `aria-busy` and the `Reverting…` label on every row's control at once, so a
  // reader was told all four revisions were busy and the label named none of
  // them. `null` is "no revert in flight".
  const [revertingTimestamp, setRevertingTimestamp] = useState<number | null>(null);
  // …and the same fact readable from a callback that closed over an older
  // render, so `startEditing` can refuse mid-revert without taking `reverting`
  // into its dependency array.
  const revertingRef = useRef(false);
  revertingRef.current = revertingTimestamp !== null;
  const historyId = useId();
  // One sentence for the whole list, pointed at by every Revert control — the
  // `readOnlyNoteId` idiom `RevisionHistory` already uses.
  const readOnlyNoteId = useId();
  const historyToggleRef = useRef<HTMLButtonElement>(null);
  // Is the panel expanded, readable from an async callback — `save`'s landed
  // branch decides between re-listing and merely invalidating with it.
  const historyOpenRef = useRef(false);
  historyOpenRef.current = historyOpen;
  // The current render's `refreshHistory`, so `save` — declared above the panel
  // state it would otherwise have to close over — can call it without taking
  // any of that state into its dependency array. Assigned during render, the
  // `payloadRef` idiom.
  const refreshHistoryRef = useRef<() => void>(() => {});

  /**
   * A monotonic token per KIND of history request, bumped by every new request
   * of that kind AND by a selection reset.
   *
   * The race this closes: a listing still in flight when the owner picks
   * another row resolves AFTER the reset block has set `revisions` back to
   * `null`, and latches the PREVIOUS row's history under the new row's header —
   * and because the expand-once rule keys off `revisions !== null`, the new row
   * would then never fetch its own. Same shape as `fetchPreview`'s `stale`
   * outcome, which is why the fix is the same one: compare after the await and
   * drop a result that is no longer for the current request.
   *
   * Three tokens rather than one, because the three requests genuinely overlap:
   * a shared counter would make opening an entry cancel the listing that is
   * still arriving.
   */
  const listRequestRef = useRef(0);
  const viewRequestRef = useRef(0);
  const revertRequestRef = useRef(0);

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
      // from being re-read when this region next changes. A plain `""` rather
      // than `nextAnnouncement`: clearing is a request for SILENCE, and the
      // repeat mark exists to make a sentence heard again.
      setRefreshAnnouncement("");
      // The failure run belongs to the row it was counted for. Carried across a
      // pick, one earlier failure elsewhere would make this row's FIRST blip
      // announce.
      failuresRef.current = 0;
      // A retry in flight for the previous row is not a retry for this one.
      setRetrying(false);
      // A pick abandons an open editor: the column is about to show another
      // file's bytes, and a textarea holding this one's draft over that one's
      // header is the state `save`'s target check also refuses.
      setEditing(false);
      editingTargetRef.current = null;
      editingVersionRef.current = undefined;
      setDraftSeed(null);
      setConfirmOpen(false);
      setSaveError(null);
      // …and the History panel with it (DW-214). A revision list belongs to the
      // file it was fetched for: left standing across a pick it would offer to
      // revert the PREVIOUS row's Schema from under the new row's header, and
      // `revisions !== null` would stop the expand from ever re-fetching. The
      // panel is closed rather than merely emptied, because "expanded" is the
      // owner's request about one file, not a preference.
      setHistoryOpen(false);
      setRevisions(null);
      setHistoryLoading(false);
      setHistoryError(null);
      setViewingTimestamp(null);
      setViewContent(null);
      setViewLoading(false);
      setPendingRevert(null);
      setRevertingTimestamp(null);
      // …and every request already in flight stops being this row's. Without
      // this a listing that resolves after the reset writes the PREVIOUS row's
      // revisions into a panel that has already been re-pointed, and the
      // expand-once rule then keeps the new row from ever fetching its own.
      listRequestRef.current += 1;
      viewRequestRef.current += 1;
      revertRequestRef.current += 1;
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
        //
        // Computed OUT HERE and only then handed to the updater: React invokes
        // an updater twice under StrictMode and requires it to be pure, so the
        // ref read belongs on this side of it. The updater itself is
        // `nextAnnouncement` and nothing else (DW-182) — writing the same
        // sentence into the region a second time is what a screen reader cannot
        // tell from not writing at all, so two consecutive silent refreshes
        // used to report as one.
        const sentence =
          previewRefreshAnnouncement({
            reset: plan.reset,
            shown: payloadRef.current,
            next: result.payload,
          }) ?? "";
        setRefreshAnnouncement((current) => nextAnnouncement(current, sentence));
        setPayload(result.payload);
        setGone(false);
        setUnreachable(false);
        // The read landed, so whatever run of failures preceded it is over.
        failuresRef.current = 0;
      } else if (result.status === "gone") {
        // A page another actor just deleted must not keep rendering as if it
        // were there — the body is replaced, and no stale strip appears over a
        // replacement that is not stale.
        setGone(true);
        setUnreachable(false);
        // A 404 takes the WHOLE edit path with it, dialog included (DW-181).
        // `Edit` unmounts on this render because `previewEditTarget` now
        // answers `null`, but a confirm the owner opened a moment ago would
        // otherwise go on standing — and its sentences come from that same
        // `null`, so a Schema dialog would silently re-title itself to the page
        // copy mid-read and offer to open an editor with nowhere to save to.
        setConfirmOpen(false);
        // …and the REVERT gate with it, for the identical reason (DW-214). A
        // 404 takes `previewHistoryTarget` to `null`, so the panel and its
        // controls unmount — but a confirm the owner opened a moment ago would
        // otherwise go on standing over `This file couldn’t be loaded.`, with
        // a `Restore this version` that `confirmRevert` refuses (its `file` is
        // now `null`) and a focus restore pointing at a button that no longer
        // exists.
        setPendingRevert(null);
        // A 404 is an ANSWER: the route was reached and said the row is not
        // there. It ends the run for the same reason `ok` does.
        failuresRef.current = 0;
      } else {
        // The read could not be reached. The last-good bytes STAY: they are the
        // most recent true thing this column knows, and replacing them with a
        // failure sentence because of one dropped packet is the bug DW-54 is.
        setUnreachable(true);
        // …but the strip that says so is purely visual, and a reader who cannot
        // see it goes on reading bytes with no way of knowing they are stale
        // (DW-183). WHEN that is worth saying is the executed
        // `previewUnreachableAnnouncement`: not on the first blip, which heals
        // on the next read that already happens, and not again on the third.
        failuresRef.current += 1;
        // `payloadRef.current` rather than `result`: this branch deliberately
        // leaves the payload alone, so what is on screen is what the last read
        // left — including `null`, on a row whose very first read failed. The
        // strip takes the same term, so the sentence and the strip cannot
        // disagree about whether there is a last version to be showing.
        const staleSentence = previewUnreachableAnnouncement({
          failures: failuresRef.current,
          payload: payloadRef.current,
        });
        // `null` LEAVES the region as it is rather than clearing it: silence is
        // what is being asked for, and this branch has no opinion about the
        // sentence some other branch put there.
        if (staleSentence !== null) {
          setRefreshAnnouncement((current) => nextAnnouncement(current, staleSentence));
        }
      }
      setLoading(false);
      // Whatever this read was, it SETTLED — so the control that may have
      // started it is pressable again. Cleared on every non-stale outcome, not
      // only the failing one: a retry that succeeds unmounts the strip anyway,
      // and a flag left true would come back with it.
      setRetrying(false);
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

  // Where focus goes when the revert confirm closes into a running write
  // (DW-214). `useDialogA11y` restores to the OPENER when it is still
  // connected — and it is: `confirmRevert` batches the dialog's close with
  // `setRevertingTimestamp`, so the Revert button is still in the DOM and is
  // now `disabled`. `.focus()` on a disabled button is a no-op, the
  // `fallbackFocusRef` branch is never reached, and focus sits on `<body>` for
  // the whole write. The disclosure is the obvious real target: it owns the
  // panel the outcome lands in, and it is never disabled.
  //
  // Only on the LEADING edge — a revert starting — so the effect cannot pull
  // focus back when the write settles and the owner has moved on.
  useEffect(() => {
    if (revertingTimestamp !== null) historyToggleRef.current?.focus();
  }, [revertingTimestamp]);

  // WHETHER there is unsaved text is one executed function (`previewDraftDirty`),
  // never a comparison typed here: this is the whole of what stands between a
  // stray click on a tree row and the owner's markdown, and inline it could only
  // ever be grepped for.
  const dirty = previewDraftDirty({ editing, draft, seed: draftSeed });

  // Reported UP in an effect rather than from the handlers that change it, so
  // the shell sees the state of the render that is actually on screen — a report
  // fired from `onChange` would be one keystroke behind on the path where React
  // batches, and one keystroke is the whole of the loss this prevents.
  //
  // The cleanup reports `false` on EVERY run, not only on unmount. A column the
  // shell just undocked (a mode, Wiki or tab change) takes its draft with it, and
  // a shell left holding `true` would gate the next pick — in another Wiki, on
  // another tab — behind a discard confirm for a textarea that no longer exists.
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  const startEditing = useCallback(() => {
    if (!payload) return;
    // The target is captured HERE, from what the column was showing — not
    // re-derived at Save. `canEditPreview` is the same predicate, so the `Edit`
    // control was on screen only when this was non-null WHEN IT WAS PRESSED —
    // but a silent same-row refresh (Story 1.7) can replace the payload while
    // this dialog is open, and the new one may be truncated, no longer editable,
    // or a 404 that left the old payload standing (DW-181). Opening the editor
    // then would seed `editingTargetRef` with `null`, and `Save` would neither
    // write nor say why: the outcome `previewWriteTarget` documents as the worst
    // of the three. So the dialog closes and the column stays view-first instead.
    const target = previewEditTarget({ gone, payload });
    if (!target) {
      setConfirmOpen(false);
      return;
    }
    // A revert is in flight, and it is ABOUT to replace these bytes (DW-214).
    // Seeding the editor from them now would capture the pre-revert draft AND
    // the pre-revert `version`, so the owner's own Save would come back as a
    // 412 conflict they caused by pressing a button in this column's own panel.
    // Refused here as well as at the opener, so the affordance and the action
    // cannot refuse at different strengths — DW-181's lesson.
    if (revertingRef.current) {
      setConfirmOpen(false);
      return;
    }
    // The editor is seeded with the SAME string the body rendered, which is the
    // same string the write route expects — for a page the route stripped the
    // YAML block before it ever reached the browser, and for an artifact there
    // is no block to strip.
    setDraft(payload.body);
    // The same string, recorded as the thing "dirty" is measured against. Taken
    // HERE and never re-derived: a silent same-row refresh can replace `payload`
    // while the editor is open, and comparing the draft against the new bytes
    // would call an owner who typed nothing dirty.
    setDraftSeed(payload.body);
    editingTargetRef.current = target;
    // Captured WITH the seed, for the reason `editingVersionRef` documents.
    editingVersionRef.current = payload.version;
    setSaveError(null);
    setConfirmOpen(false);
    setEditing(true);
  }, [gone, payload]);

  const save = useCallback(async () => {
    const target = editingTargetRef.current;
    if (!target || saving) return;
    // The column must still be showing the thing this draft came from, compared
    // by the SAME key the save is about to post to — a check against some other
    // expression of "same row" could pass while the URL points elsewhere. It
    // always is — the selection effect closes the editor — and the check is here
    // so that a change to the effect cannot turn the editor into a cross-file
    // overwrite without something refusing.
    //
    // The `gone` term is DEFENCE IN DEPTH, not the live refusal, and cannot fire
    // as the column stands: `previewFetchPlan` answers `fetch: false` for every
    // same-row run while `editing`, so no 404 can land under an open editor, and
    // a different-row run resets and closes the editor before any result
    // arrives. It is here because it is the same one derivation the affordance
    // reads (DW-181) — a rule the write asks in a weaker form than the button is
    // how the button came to be withdrawn while the write went on posting.
    if (
      previewEditTarget({ gone: goneRef.current, payload: payloadRef.current })?.key !==
      target.key
    )
      return;
    setSaving(true);
    setSaveError(null);
    // The request, the write route and the "server's sentence, else the Copy
    // table's" rule all live in `workbench-preview`, where a stubbed fetch can
    // run them. `savePreviewBody` RESOLVES on a rejected save rather than
    // throwing, because the only correct response is to keep the editor open.
    const result = await savePreviewBody(target.url, draft, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      fallback: previewEditCopy(target).saveFallback,
      // The phrase the UNKNOWN-outcome sentence is composed from, taken from the
      // SAME copy set as the fallback so the two cannot disagree about whether
      // this is a page or the Schema.
      action: previewEditCopy(target).saveAction,
      version: editingVersionRef.current,
    });
    // Busy flag first, on every exit path including the superseded one below.
    setSaving(false);
    // The owner may have picked another row while this was in flight. The
    // column is showing that row now, so stamping this draft onto its payload
    // would put file A's text under file B's header — and the focus restore
    // would pull focus off whatever they just clicked. The write is done and
    // the shell will notice it either way — the bump already landed.
    if (
      previewEditTarget({ gone: goneRef.current, payload: payloadRef.current })?.key !==
      target.key
    )
      return;
    if (result.status === "ok") {
      // Back to view-first showing what was saved. The body is the text that
      // just went over the wire, so no second read is needed to be truthful —
      // and the VERSION comes with it, so a second edit without a reload seeds
      // from bytes and a precondition that agree. Without the stamp the next
      // save would send the version this one just superseded and be refused as
      // a conflict with itself.
      //
      // A save that answered NO version clears it rather than keeping the old
      // one: what this column knows then is "the current version is unknown",
      // and the next save saying so (428) is truthful where a stale version
      // saying "somebody else changed this" (412) would not be.
      setPayload((current) =>
        current ? { ...current, body: draft, version: result.version } : current,
      );
      restoreEditFocus.current = true;
      setEditing(false);
      editingVersionRef.current = undefined;
      // Saved text is not unsaved text: the seed is dropped on every path that
      // closes the editor, or the shell would go on gating picks on a draft that
      // is already on disk and no longer on screen.
      setDraftSeed(null);
      // The trees carry the page's title and `updated`, both of which this write
      // may have changed — but this column does not refresh anything itself.
      // The write bumped `dataVersion` at the kernel's one tail like every other
      // write in the system, so the owner's own save is not a special case: it
      // just asks the watcher to look NOW instead of on the next tick, and the
      // answer still comes from the server's integer.
      requestDataVersionCheck();
      // A landed save CREATED a revision: `writeWikiArtifact` snapshots the
      // bytes it replaces before it writes (DW-59). The panel's cached list is
      // therefore missing the entry the owner is most likely to want back — and
      // because the expand-once rule keys off `revisions !== null`, collapsing
      // and re-expanding would not fetch it either. Assigned during render, so
      // this callback — which cannot depend on state declared below it — runs
      // the CURRENT render's closure rather than a stale one.
      refreshHistoryRef.current();
    } else {
      // The editor stays open holding the owner's text — a failed save must
      // never be the thing that loses it.
      setSaveError(result.message);
      if (result.unconfirmed) {
        // NOTHING came back, so the bytes may already be on disk (DW-376). The
        // editor stays open with the draft exactly as it is — re-seeding it from
        // a server that never answered is not something this column could do —
        // and the two things it CAN do both happen here.
        //
        // The held version is the only thing left that can be a lie: if the save
        // landed, the file has moved past it. Cleared for the reason the landed
        // branch above states in full — the next save is then refused as "this
        // could not be checked" (428) rather than as a conflict with an actor
        // that does not exist (412), and neither can clobber.
        editingVersionRef.current = undefined;
        // …and the write may have bumped `dataVersion` at the kernel's one tail,
        // which is how the tree, the header and every other reader of this file
        // find out. The same signal a landed save fires, for the same reason:
        // the answer still comes from the server's integer, not from this
        // column's guess about what happened.
        requestDataVersionCheck();
        // THE CACHED REVISION LIST IS NOW WRONG IN THE SAME WAY IT IS AFTER A
        // LANDED SAVE, and this is the one statement of why — the unconfirmed
        // revert below points here rather than restating it.
        //
        // `writeWikiArtifact` snapshots the bytes it replaces before it writes
        // (DW-59), so a save that DID land added an entry — and the missing
        // entry is the pre-write bytes, i.e. exactly the version an owner who
        // wants out of this wants back. The expand-once rule keys off
        // `revisions !== null`, so a stale list is not refetched by collapsing
        // and re-expanding either: the cache has to be invalidated here or it
        // never is. Leaving it would send the owner — whom the sentence above
        // just told to check what the screen shows — to a list that is one entry
        // short, with the missing entry the only one that matters.
        //
        // `refreshHistory` is the right shape for BOTH answers: it re-lists when
        // the panel is open and drops the cache when it is closed, so an
        // unconfirmed save costs no request the owner did not ask for. It is
        // also correct if the save did NOT land — a re-read that finds the same
        // list is the panel learning that, which is the whole point.
        refreshHistoryRef.current();
      }
    }
  }, [draft, saving]);

  // WHICH artifact the History panel is about, or `null` for no panel at all —
  // one executed derivation (`previewHistoryTarget`) read by the disclosure, the
  // list, the view and the revert alike. A `gone` or `editing` term typed beside
  // the button would withdraw the panel and leave the three requests reachable.
  const historyTarget = previewHistoryTarget({ gone, payload, editing });

  /**
   * (Re-)read the list. Called on the first expand, after a landed revert, and
   * after a landed save — both of which ADDED an entry, because both writers
   * snapshot the bytes they replace (DW-59).
   *
   * A failed listing leaves `revisions` at `null` rather than at `[]`, so the
   * next expand tries again instead of showing "no earlier versions" for a read
   * that never landed.
   *
   * TWO GUARDS AROUND THE AWAIT, and neither is optional. The DEADLINE is the
   * same one every other request in this column carries: `finally` cannot
   * rescue a promise that never settles, so without it a hung listing leaves
   * `historyLoading` true — `Loading earlier versions…` — for the rest of the
   * session. The TOKEN is the staleness check: a listing still in flight when
   * the owner picks another row would otherwise land the previous row's history
   * in a panel that has already been re-pointed, and the expand-once rule would
   * then keep the new row from ever fetching its own.
   */
  async function loadRevisions(file: EditableArtifactFile) {
    const token = ++listRequestRef.current;
    setHistoryLoading(true);
    setHistoryError(null);
    const result = await fetchArtifactRevisions(file, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // Superseded: another listing started, or the owner left this row. Not an
    // error and not an empty history — simply not this panel's answer any more.
    if (listRequestRef.current !== token) return;
    setHistoryLoading(false);
    if (result.status === "ok") setRevisions(result.revisions);
    else setHistoryError(result.message);
  }

  /**
   * What a landed WRITE through this column owes the panel.
   *
   * Both writers behind this surface snapshot what they replace, so after
   * either one the cached list is one entry short — and the missing entry is
   * the pre-write bytes, i.e. exactly the version an owner who changes their
   * mind wants back. Re-read when the panel is open; when it is closed, drop
   * the cache so the next expand fetches rather than serving a stale list.
   *
   * `payloadRef` rather than `historyTarget`: this runs on the save path, where
   * `previewHistoryTarget` answers `null` because the editor was open when the
   * write started.
   */
  function refreshHistory() {
    const file = payloadRef.current?.artifact;
    if (!file) return;
    if (historyOpenRef.current) void loadRevisions(file);
    else setRevisions(null);
  }
  refreshHistoryRef.current = refreshHistory;

  function toggleHistory() {
    const willOpen = !historyOpen;
    setHistoryOpen(willOpen);
    // ONCE per row: `revisions !== null` after any landed listing, and only a
    // selection reset or a landed write puts it back to `null`.
    if (willOpen && historyTarget && revisions === null && !historyLoading) {
      void loadRevisions(historyTarget);
    }
  }

  async function viewRevision(timestamp: number) {
    if (!historyTarget) return;
    // Pressing the open entry again collapses it — a toggle, not a second read.
    if (viewingTimestamp === timestamp) {
      setViewingTimestamp(null);
      setViewContent(null);
      return;
    }
    const token = ++viewRequestRef.current;
    setViewLoading(true);
    setViewingTimestamp(timestamp);
    setViewContent(null);
    setHistoryError(null);
    const result = await fetchArtifactRevision(historyTarget, timestamp, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // Superseded by a newer view, or by a pick. Dropping it here is what keeps
    // one entry's bytes from appearing under another entry's control.
    if (viewRequestRef.current !== token) return;
    setViewLoading(false);
    if (result.status === "ok") {
      setViewContent(result.content);
      return;
    }
    // The view CLOSES on failure rather than standing empty: an expanded entry
    // showing nothing is indistinguishable from a revision that is empty.
    setViewingTimestamp(null);
    setHistoryError(result.message);
  }

  function requestRevert(timestamp: number) {
    // BEFORE the confirm (DW-149), never after: a dialog the owner has to
    // answer is the harm, and their answer changes nothing on a deployment
    // whose route will refuse the write. The sentence saying why is already in
    // the panel beside the control.
    if (readOnly || revertingTimestamp !== null) return;
    // One overlay level (UX-DR17), enforced at the opener rather than left to
    // the fact that the other dialog traps focus.
    setConfirmOpen(false);
    setPendingRevert(timestamp);
  }

  async function confirmRevert() {
    const timestamp = pendingRevert;
    const file = historyTarget;
    if (timestamp === null || file === null || revertingTimestamp !== null) return;
    // The same refusal again, at the write rather than at the affordance: a
    // rule the action asks in a weaker form than the control is how a withdrawn
    // control comes to leave a live write behind it (DW-181's lesson).
    if (readOnly) {
      setPendingRevert(null);
      return;
    }
    const token = ++revertRequestRef.current;
    setPendingRevert(null);
    setRevertingTimestamp(timestamp);
    setHistoryError(null);
    const result = await revertArtifactRevision(file, timestamp, {
      // The deadline matters most on THIS request: without it a POST that never
      // settles leaves every Revert control disabled and the panel reporting a
      // write that is not happening, with no way back but a reload.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // The owner left this row while the write was in flight. The write itself is
    // done either way and the shell will notice it through `dataVersion`; what
    // must not happen is this result reaching a panel that is now about another
    // file — the same rule `save()` keeps for its own superseded case.
    if (revertRequestRef.current !== token) return;
    setRevertingTimestamp(null);
    if (result.status === "error") {
      if (result.unconfirmed) {
        // Nothing came back, so the revert may have LANDED (DW-376), and the
        // panel is now the least trustworthy thing on screen. Both of this
        // surface's already-wired reconciliations run, and neither loses
        // anything:
        //
        // the shell re-checks `dataVersion`, which is how the body, the tree and
        // the header find out about bytes this column did not confirm; and the
        // list is re-read for the reason the unconfirmed SAVE branch states in
        // full — a landed write snapshots what it replaces, so the cached list
        // is one entry short. `loadRevisions` directly rather than
        // `refreshHistory`: the revert came FROM this panel, so it is open by
        // construction, and the await is what lets the sentence be set after it.
        //
        // The sentence is set AFTER the re-list, not before: `loadRevisions`
        // clears `historyError` on entry, so setting it first would have the
        // reconciliation silently wipe the one thing the owner needs to read.
        // A listing that fails on the way past has its own message overwritten
        // here, which is the right way round — "the outcome of your write is
        // unknown" outranks "the list could not be loaded".
        //
        // No announcement: `PREVIEW_HISTORY_REVERTED_COPY` says a revert
        // HAPPENED, which is exactly what nobody knows.
        requestDataVersionCheck();
        await loadRevisions(file);
        // The re-list is an AWAIT, so the token has to be read again on the far
        // side of it: the owner can pick another row while it is in flight, and
        // the reset that follows a pick bumps this very ref precisely so a
        // straggler cannot write into a panel that has been re-pointed. Without
        // this, the previous row's revert message would be waiting inside the
        // new row's History the next time it was expanded.
        if (revertRequestRef.current !== token) return;
        setHistoryError(result.message);
        return;
      }
      // A refusal that ARRIVED means nothing was written. The panel stays open
      // holding the sentence — the same contract a failed save follows with the
      // editor.
      setHistoryError(result.message);
      return;
    }
    setViewingTimestamp(null);
    setViewContent(null);
    // A landed revert was SILENT for a reader (DW-214): the dialog vanished, the
    // body re-fetched, and every failure in this panel announces itself while
    // the one destructive success announced nothing. Polite, in the column's own
    // region beside `Preview updated`, and through `nextAnnouncement` so a
    // second revert is heard as a second revert (DW-182).
    setRefreshAnnouncement((current) =>
      nextAnnouncement(current, PREVIEW_HISTORY_REVERTED_COPY),
    );
    // The SAME signal a landed save fires. The revert bumped `dataVersion` at
    // the kernel's one tail, so this asks the watcher to look NOW and the new
    // bytes arrive through the column's single fetch effect — never through a
    // second read path belonging to this panel.
    requestDataVersionCheck();
    // …and the list has one more entry than it did: the bytes this revert
    // replaced were snapshotted by `writeWikiArtifact` behind the route.
    await loadRevisions(file);
  }

  const page = selection.kind === "page" ? findKnowledgePage(knowledge, selection.slug) : null;
  // WHAT to call this pick is `selectionName`, in `workbench-tree` where the
  // node suite runs it — not a ternary here. The shell speaks the same name in
  // its dock announcement (DW-34), and two derivations of one name is how the
  // sentence a screen reader hears starts naming something other than what this
  // header shows.
  const name = selectionName(selection, knowledge, files);

  // Every condition lives in one executed function — see `canEditPreview`, which
  // is `previewEditTarget({ gone, payload }) !== null`. Left inline, dropping the
  // truncation half kept the whole suite green.
  //
  // `gone` is an INPUT rather than a second condition beside it (DW-181): a 404
  // deliberately keeps the last payload, so asked about the payload alone this
  // stays true and the header goes on offering `Edit` over a body the 404 has
  // already replaced. The affordance and both of `save()`'s guards read the same
  // derivation, so they can only refuse together.
  const canEdit = canEditPreview({ gone, payload });
  // WHICH sentences the confirm dialog shows — a page's or the Schema's —
  // decided by an executed function rather than a ternary in the JSX below. A
  // dialog that promised to update "its index and links" while overwriting the
  // Schema is a wording bug no source scan can see.
  const editCopy = previewEditCopy(previewEditTarget({ gone, payload }));

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
    <aside id={id} className="wb-preview" hidden={hidden} aria-label="Preview" ref={ref}>
      <header className="wb-preview-head">
        <strong className="wb-preview-title">Preview</strong>
        <span className="wb-preview-name">{name}</span>
        {canEdit && !editing && (
          <button
            type="button"
            ref={editRef}
            className="wb-preview-edit"
            // The other half of the one-overlay-level rule the revert opener
            // states: whichever gate is asked for last is the only one open.
            onClick={() => {
              setPendingRevert(null);
              setConfirmOpen(true);
            }}
            // A revert is about to replace these bytes (DW-214), so the editor
            // must not be seeded from them — see `startEditing`, which refuses
            // the same thing at the action. The control says so rather than
            // opening a gate whose confirm silently does nothing.
            disabled={revertingTimestamp !== null}
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
          {/* The sentence does NOT change while the retry is in flight: the
              bytes below are still the last ones that loaded, which is exactly
              what it says, and rewriting it to `Refreshing…` would replace a
              true statement about the body with a report about the button. The
              control carries its own busy state instead. */}
          <p className="wb-preview-stale-note">{PREVIEW_UNREACHABLE_COPY}</p>
          <button
            type="button"
            className="wb-preview-retry"
            // Bumps a dependency of the fetch effect rather than calling a
            // reader of its own: one request path, one plan, one set of reset
            // rules. `Date.now()` would also be a new value every press, and a
            // counter cannot collide with itself twice in the same millisecond.
            onClick={() => {
              setRetrying(true);
              setRetryNonce((nonce) => nonce + 1);
            }}
            // DW-184. Without these a slow retry is indistinguishable from a
            // broken button: the strip does not move, the body does not move,
            // and the only evidence the press did anything is a request nobody
            // can see. `disabled` also stops a second press from bumping the
            // nonce again and aborting the read the first one started.
            disabled={retrying}
            aria-busy={retrying}
          >
            {retrying ? PREVIEW_RETRYING_COPY : PREVIEW_RETRY_COPY}
          </button>
        </div>
      )}

      {/* The column's OWN polite region. Inside the column, not the shell's:
          the shell reports which SURFACE is showing, and a body replaced
          underneath a reader is a change to what they are reading. Empty
          whenever there is nothing to report, so a restore, a pick and an
          unchanged refresh are all silent.

          The node STAYS MOUNTED and only its text changes — a region has to
          exist before its content moves for the move to be observed at all, so
          keying this and remounting it is the one mechanism assistive tech
          handles least reliably. Repeats are handled inside the text instead,
          by `nextAnnouncement` (DW-182). */}
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
                setDraftSeed(null);
                // Dropped here for the same reason the other two closing paths
                // drop it (`:281` on a selection change, `:451` after a landed
                // save): a version outlives the editor it was captured for
                // otherwise. `startEditing` re-seeds it, so this changes no
                // behaviour today — it keeps the ref's own invariant true on
                // every path rather than on the two that happened to be
                // written first.
                editingVersionRef.current = undefined;
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

      {/* The recovery half of Story 1.8 (DW-214), and the FIRST client
          `GET/POST /api/workbench/artifact/revisions` has ever had.

          WHETHER it shows at all is `previewHistoryTarget` and nothing typed
          here: never for a page or a 404, and never while the editor is open —
          a revert under an open draft would replace the bytes that draft is
          measured against and turn the owner's own save into a conflict they
          caused by pressing a button in this panel.

          BELOW the body, like `RevisionHistory`'s section on an article: it is
          chrome about the file, not part of reading it. */}
      {historyTarget && (
        <section className="wb-preview-history">
          <button
            type="button"
            ref={historyToggleRef}
            className="wb-preview-history-toggle"
            aria-expanded={historyOpen}
            aria-controls={historyId}
            onClick={toggleHistory}
          >
            {PREVIEW_HISTORY_COPY}
          </button>

          {historyOpen && (
            // FOCUSABLE and NAMED, because it scrolls (`max-height` +
            // `overflow-y`). A scrollable container that no element inside can
            // take focus into is unreachable by keyboard alone — WCAG 2.1.1 —
            // and a long history is exactly the case where that bites. `group`
            // rather than `region` so a labelled container does not add a
            // landmark inside the Preview's own `complementary`.
            <div
              id={historyId}
              className="wb-preview-history-panel"
              role="group"
              aria-label={PREVIEW_HISTORY_COPY}
              tabIndex={0}
            >
              {historyLoading && (
                <p className="wb-preview-history-note">{PREVIEW_HISTORY_LOADING_COPY}</p>
              )}

              {/* ONE slot for whichever of the three requests failed. Token-only
                  and muted like `.wb-preview-error`, because UX-DR15 reserves
                  colour for destructive labels; `role="alert"` is what announces
                  it. A server-supplied sentence reaches the owner verbatim —
                  the helpers in `workbench-preview.ts` decide which. */}
              {historyError && (
                <p role="alert" className="wb-preview-history-error">
                  {historyError}
                </p>
              )}

              {/* The list is a READ, and the route answers it on a read-only
                  deployment too — hiding it would tell the owner nothing except
                  that they cannot look. What is withheld is the revert, and this
                  is the one sentence every Revert control points at. */}
              {readOnly && revisions !== null && revisions.length > 0 && (
                <p id={readOnlyNoteId} className="wb-preview-history-note">
                  {PREVIEW_HISTORY_READ_ONLY_COPY}
                </p>
              )}

              {!historyLoading && revisions !== null && revisions.length === 0 && (
                <p className="wb-preview-history-note">{PREVIEW_HISTORY_EMPTY_COPY}</p>
              )}

              {!historyLoading && revisions !== null && revisions.length > 0 && (
                <ul className="wb-preview-history-list">
                  {revisions.map((revision) => {
                    const viewing = viewingTimestamp === revision.timestamp;
                    // THIS row's writes, not any row's. A busy flag shared
                    // across the list told a reader that every revision was
                    // being written and put `Reverting…` on controls that were
                    // doing nothing.
                    const revertingThis = revertingTimestamp === revision.timestamp;
                    const viewingThis = viewLoading && viewing;
                    const contentId = `${historyId}-${revision.timestamp}`;
                    return (
                      <li key={revision.timestamp} className="wb-preview-history-item">
                        {/* Date, size, author and reason. The visible instant is
                            derived from `timestamp` — the id the controls send
                            back — while `date` is the server's ISO string, which
                            belongs in `dateTime` where a machine can read it.
                            Everything after the date, INCLUDING which optional
                            fields survive and in what order, is
                            `artifactRevisionMeta`'s answer; this only joins it. */}
                        <p className="wb-preview-history-meta">
                          <time dateTime={revision.date}>
                            {artifactRevisionDate(revision)}
                          </time>
                          {artifactRevisionMeta(revision).map((part) => ` · ${part}`).join("")}
                        </p>
                        <div className="wb-preview-history-actions">
                          <button
                            type="button"
                            className="wb-preview-history-action"
                            onClick={() => void viewRevision(revision.timestamp)}
                            // Scoped to the entry actually being read: a shared
                            // `disabled` froze every View button while one was
                            // in flight. A newer view supersedes an older one
                            // through `viewRequestRef`, so the others stay live.
                            disabled={viewingThis}
                            aria-busy={viewingThis || undefined}
                            aria-expanded={viewing}
                            // The `<pre>` this control opens, so the expanded
                            // state points at something rather than at nothing.
                            aria-controls={viewing ? contentId : undefined}
                          >
                            {viewing ? PREVIEW_HISTORY_HIDE_COPY : PREVIEW_HISTORY_VIEW_COPY}
                          </button>
                          <button
                            type="button"
                            className="wb-preview-history-action"
                            onClick={() => requestRevert(revision.timestamp)}
                            // `disabled` is list-wide because a SECOND
                            // concurrent write is the thing being prevented;
                            // `aria-busy` and the label are per row, because
                            // only one of them is the write that is running.
                            // Read-only is `aria-disabled` instead, so the
                            // control stays in the tab order and a reader can
                            // reach the sentence explaining it (the
                            // `RevisionItem` idiom, DW-187/DW-149).
                            disabled={revertingTimestamp !== null}
                            aria-busy={revertingThis || undefined}
                            aria-disabled={readOnly || undefined}
                            aria-describedby={readOnly ? readOnlyNoteId : undefined}
                            data-readonly={readOnly || undefined}
                          >
                            {revertingThis
                              ? PREVIEW_HISTORY_REVERTING_COPY
                              : PREVIEW_HISTORY_REVERT_COPY}
                          </button>
                        </div>
                        {viewing && viewContent !== null && (
                          // Verbatim, in a `<pre>`: this is the SOURCE of an
                          // executable Schema, not the reading surface, and
                          // rendering it as markdown would show a version that
                          // looks like the one on screen above it.
                          //
                          // Focusable and named for the same WCAG 2.1.1 reason
                          // the panel is: it scrolls, and a Schema is long.
                          <pre
                            id={contentId}
                            className="wb-preview-history-content"
                            role="group"
                            aria-label={artifactRevisionDate(revision)}
                            tabIndex={0}
                          >
                            {viewContent}
                          </pre>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      {/* The one overlay level (UX-DR17). Esc and Cancel both leave view-first
          with nothing written; only Confirm opens the editor.

          Two ELEMENTS, never two overlays: each opener closes the other's state
          before setting its own, so at most one of these is ever `open`. */}
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

      {/* …and the revert's own gate. The Revert control that opened it stays
          mounted through the whole flow, so `useDialogA11y`'s own restore has
          somewhere to return focus to; the disclosure is the fallback for the
          case where a landed revert re-lists into a shorter list. */}
      <ConfirmDialog
        open={pendingRevert !== null}
        title={PREVIEW_HISTORY_REVERT_CONFIRM_TITLE}
        // NAMES the entry it is about. Every row's control opens the same
        // dialog, so a static sentence would be a destructive confirm that
        // never says which of them the owner pressed.
        body={previewHistoryRevertConfirmBody(
          revisions?.find((revision) => revision.timestamp === pendingRevert) ?? null,
        )}
        confirmLabel={PREVIEW_HISTORY_REVERT_CONFIRM_LABEL}
        cancelLabel={PREVIEW_CANCEL_COPY}
        onConfirm={() => void confirmRevert()}
        onCancel={() => setPendingRevert(null)}
        fallbackFocusRef={historyToggleRef}
      />
    </aside>
  );
}
