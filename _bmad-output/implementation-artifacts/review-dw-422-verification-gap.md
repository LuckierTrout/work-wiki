Read `/Users/christianlee/App-Development/work-wiki/_bmad/render/bmad-build/work-wiki-c0d963009af6/8a8fffa6a84e9e192b04/review-prompts/verification-gap.md` completely and follow it as your review instructions.

Review content:

diff --git a/src/components/workbench/ChatCanvas.tsx b/src/components/workbench/ChatCanvas.tsx
index 226c0105..daba2c0c 100644
--- a/src/components/workbench/ChatCanvas.tsx
+++ b/src/components/workbench/ChatCanvas.tsx
@@ -1,5 +1,7 @@
 "use client";
 
+import { SurfacePresentation, useSurfaceVisible } from "@/hooks/useSurfaceVisibility";
+
 import {
   useEffect,
   useMemo,
@@ -85,6 +87,7 @@ function thinkingLines(text: string): string[] {
 }
 
 export function ChatCanvas({ wikiId, readOnly, onDockPreview }: ChatCanvasProps) {
+  const visible = useSurfaceVisible();
   const [error, setError] = useState<string | null>(null);
   // The conversation half — the list, the open one, its messages and its
   // settings — lives in `useChatConversations`, over the doors in
@@ -160,7 +163,7 @@ export function ChatCanvas({ wikiId, readOnly, onDockPreview }: ChatCanvasProps)
    * command underneath it.
    */
   useEffect(() => {
-    if (!pending && skillPicker === null) return;
+    if (!visible || (!pending && skillPicker === null)) return;
     const onKey = (event: globalThis.KeyboardEvent) => {
       if (event.key !== "Escape") return;
       event.preventDefault();
@@ -174,7 +177,7 @@ export function ChatCanvas({ wikiId, readOnly, onDockPreview }: ChatCanvasProps)
     return () => document.removeEventListener("keydown", onKey);
     // `answerPending` closes over `pending` and `formValues`, both in the deps.
     // eslint-disable-next-line react-hooks/exhaustive-deps
-  }, [pending, skillPicker, formValues]);
+  }, [visible, pending, skillPicker, formValues]);
 
   /**
    * Skills on disk, read once on mount through `scanSkills`.
@@ -187,13 +190,14 @@ export function ChatCanvas({ wikiId, readOnly, onDockPreview }: ChatCanvasProps)
    * `@/lib/chat-composer`.
    */
   useEffect(() => {
+    if (!visible) return;
     const controller = new AbortController();
     void (async () => {
       const scanned = await scanSkills(controller.signal);
-      if (scanned) setSkills(scanned);
+      if (!controller.signal.aborted && scanned) setSkills(scanned);
     })();
     return () => controller.abort();
-  }, []);
+  }, [visible]);
 
   function stopTurn() {
     abortRef.current?.abort();
@@ -555,6 +559,7 @@ export function ChatCanvas({ wikiId, readOnly, onDockPreview }: ChatCanvasProps)
   );
 
   return (
+    <SurfacePresentation>
     <div className={`wb-chat${retrievalMode === "sources" ? " wb-chat--sources" : ""}`}>
       <aside className="wb-chat-sidebar" aria-label="Conversations">
         <button
@@ -1037,5 +1042,6 @@ export function ChatCanvas({ wikiId, readOnly, onDockPreview }: ChatCanvasProps)
         </div>
       </div>
     </div>
+    </SurfacePresentation>
   );
 }
diff --git a/src/components/workbench/GraphCanvas.tsx b/src/components/workbench/GraphCanvas.tsx
index 21124b2d..eb51958a 100644
--- a/src/components/workbench/GraphCanvas.tsx
+++ b/src/components/workbench/GraphCanvas.tsx
@@ -1,6 +1,7 @@
 "use client";
 
 import { useCallback, useEffect, useId, useRef, useState } from "react";
+import { SurfacePresentation, useSurfaceVisible } from "@/hooks/useSurfaceVisibility";
 import { send, writeFailure } from "@/lib/workbench-request";
 import { GRAPH_NARROW_COPY, workbenchMode } from "@/lib/workbench-modes";
 import { STRONG_EDGE_WEIGHT } from "@/lib/graph-relevance";
@@ -78,6 +79,9 @@ export function GraphCanvas({
   onDockPreview,
   onOpenResearch,
 }: GraphCanvasProps) {
+  const visible = useSurfaceVisible(active);
+  const visibleRef = useRef(visible);
+  visibleRef.current = visible;
   const empty = workbenchMode("graph").emptyState ?? "No graph yet. Ingest sources to build one.";
   const containerRef = useRef<HTMLDivElement | null>(null);
   const sigmaRef = useRef<{
@@ -137,10 +141,11 @@ export function GraphCanvas({
   }, [wikiId]);
 
   const load = useCallback(async () => {
+    if (!visibleRef.current) return;
     const seq = ++loadSeq.current;
     try {
       const body = await send<GraphResponse>("/api/graph/workbench", { method: "GET" });
-      if (seq !== loadSeq.current) return;
+      if (!visibleRef.current || seq !== loadSeq.current) return;
       setNodes(body.nodes ?? []);
       setEdges(body.edges ?? []);
       setCommunities(body.communities ?? []);
@@ -150,7 +155,7 @@ export function GraphCanvas({
       setPrefill(body.prefill);
       setError(null);
     } catch (cause) {
-      if (seq !== loadSeq.current) return;
+      if (!visibleRef.current || seq !== loadSeq.current) return;
       setNodes([]);
       setEdges([]);
       setCommunities([]);
@@ -163,9 +168,10 @@ export function GraphCanvas({
   }, []);
 
   useEffect(() => {
-    if (!active) return;
+    if (!visible) return;
     void load();
-  }, [active, load, dataVersion]);
+    return () => { loadSeq.current += 1; };
+  }, [visible, load, dataVersion, wikiId]);
 
   const selected = insights.find((insight) => insight.id === selectedInsight) ?? null;
   selectedRef.current = selected;
@@ -476,6 +482,7 @@ export function GraphCanvas({
   }
 
   return (
+    <SurfacePresentation active={active}>
     <div className="wb-graph">
       <p className="wb-empty wb-empty--narrow">{GRAPH_NARROW_COPY}</p>
       <div className="wb-graph-job wb-empty--wide">
@@ -659,5 +666,6 @@ export function GraphCanvas({
         onConfirm={(values) => void confirmResearch(values)}
       />
     </div>
+    </SurfacePresentation>
   );
 }
diff --git a/src/components/workbench/LintCanvas.tsx b/src/components/workbench/LintCanvas.tsx
index 1de044c4..f3a6948f 100644
--- a/src/components/workbench/LintCanvas.tsx
+++ b/src/components/workbench/LintCanvas.tsx
@@ -1,6 +1,8 @@
 "use client";
 
-import { useCallback, useState } from "react";
+import { SurfacePresentation } from "@/hooks/useSurfaceVisibility";
+
+import { useCallback, useEffect, useRef, useState } from "react";
 import { send, writeFailure } from "@/lib/workbench-request";
 import { workbenchMode } from "@/lib/workbench-modes";
 import { selectionFromContentPath, type TreeSelection } from "@/lib/workbench-tree";
@@ -34,7 +36,17 @@ export function LintCanvas({
   const [error, setError] = useState<string | null>(null);
   const [busy, setBusy] = useState(false);
 
+  const wikiScope = useRef(_wikiId);
+  wikiScope.current = _wikiId;
+  useEffect(() => {
+    setIssues([]);
+    setError(null);
+    setRan(false);
+    setBusy(false);
+  }, [_wikiId]);
+
   const run = useCallback(async () => {
+    if (wikiScope.current !== _wikiId) return;
     setBusy(true);
     setError(null);
     try {
@@ -42,14 +54,16 @@ export function LintCanvas({
         method: "POST",
         body: JSON.stringify({ semantic }),
       });
+      if (wikiScope.current !== _wikiId) return;
       setIssues(body.issues ?? []);
       setRan(true);
     } catch (cause) {
+      if (wikiScope.current !== _wikiId) return;
       setError(cause instanceof Error ? cause.message : "Couldn’t run lint.");
     } finally {
-      setBusy(false);
+      if (wikiScope.current === _wikiId) setBusy(false);
     }
-  }, [semantic]);
+  }, [semantic, _wikiId]);
 
   async function fix(issue: WorkbenchLintIssue) {
     if (readOnly || !workbenchCanAutoFix(issue, readOnly)) return;
@@ -66,13 +80,14 @@ export function LintCanvas({
       });
       await run();
     } catch (cause) {
-      setError(writeFailure(cause, "auto-fix the issue").message);
+      if (wikiScope.current === _wikiId) setError(writeFailure(cause, "auto-fix the issue").message);
     } finally {
-      setBusy(false);
+      if (wikiScope.current === _wikiId) setBusy(false);
     }
   }
 
   return (
+    <SurfacePresentation active={_active}>
     <div className="wb-lint">
       <div className="wb-todos-bar">
         <label className="wb-lint-semantic">
@@ -129,5 +144,6 @@ export function LintCanvas({
         </ul>
       )}
     </div>
+    </SurfacePresentation>
   );
 }
diff --git a/src/components/workbench/ModeCanvas.tsx b/src/components/workbench/ModeCanvas.tsx
index a49d245f..1df5536c 100644
--- a/src/components/workbench/ModeCanvas.tsx
+++ b/src/components/workbench/ModeCanvas.tsx
@@ -307,6 +307,7 @@ export function ModeCanvas({
       </SurfaceVisibilityProvider>
 
       {sidecar === "up" ? (
+        <SurfaceVisibilityProvider visible={mode === "chat" && !hidden}>
         <div className="wb-canvas-pad" hidden={mode !== "chat" || hidden}>
           {mode === "chat" && !hidden ? (
             <h2 id={headingId} className="wb-surface-title">
@@ -319,6 +320,7 @@ export function ModeCanvas({
             onDockPreview={onDockPreview ?? (() => {})}
           />
         </div>
+      </SurfaceVisibilityProvider>
       ) : mode === "chat" && !hidden ? (
         <div className="wb-canvas-pad">
           <h2 id={headingId} className="wb-surface-title">
@@ -328,7 +330,8 @@ export function ModeCanvas({
         </div>
       ) : null}
 
-      <div className="wb-canvas-pad" hidden={mode !== "search" || hidden}>
+      <SurfaceVisibilityProvider visible={mode === "search" && !hidden}>
+        <div className="wb-canvas-pad" hidden={mode !== "search" || hidden}>
         {mode === "search" && !hidden ? (
           <h2 id={headingId} className="wb-surface-title">
             {workbenchMode("search").label}
@@ -339,8 +342,10 @@ export function ModeCanvas({
           onDockPreview={onDockPreview ?? (() => {})}
         />
       </div>
+      </SurfaceVisibilityProvider>
 
-      <div className="wb-canvas-pad" hidden={mode !== "todos" || hidden}>
+      <SurfaceVisibilityProvider visible={mode === "todos" && !hidden}>
+        <div className="wb-canvas-pad" hidden={mode !== "todos" || hidden}>
         {mode === "todos" && !hidden ? (
           <h2 id={headingId} className="wb-surface-title">
             {workbenchMode("todos").label}
@@ -354,8 +359,10 @@ export function ModeCanvas({
           onPendingCountChange={onTodoCountChange}
         />
       </div>
+      </SurfaceVisibilityProvider>
 
-      <div className="wb-canvas-pad" hidden={mode !== "graph" || hidden}>
+      <SurfaceVisibilityProvider visible={mode === "graph" && !hidden}>
+        <div className="wb-canvas-pad" hidden={mode !== "graph" || hidden}>
         {mode === "graph" && !hidden ? (
           <h2 id={headingId} className="wb-surface-title">
             {workbenchMode("graph").label}
@@ -370,8 +377,10 @@ export function ModeCanvas({
           onOpenResearch={onOpenResearch}
         />
       </div>
+      </SurfaceVisibilityProvider>
 
-      <div className="wb-canvas-pad" hidden={mode !== "lint" || hidden}>
+      <SurfaceVisibilityProvider visible={mode === "lint" && !hidden}>
+        <div className="wb-canvas-pad" hidden={mode !== "lint" || hidden}>
         {mode === "lint" && !hidden ? (
           <h2 id={headingId} className="wb-surface-title">
             {workbenchMode("lint").label}
@@ -384,8 +393,10 @@ export function ModeCanvas({
           onDockPreview={onDockPreview ?? (() => {})}
         />
       </div>
+      </SurfaceVisibilityProvider>
 
-      <div className="wb-canvas-pad" hidden={mode !== "review" || hidden}>
+      <SurfaceVisibilityProvider visible={mode === "review" && !hidden}>
+        <div className="wb-canvas-pad" hidden={mode !== "review" || hidden}>
         {mode === "review" && !hidden ? (
           <h2 id={headingId} className="wb-surface-title">
             {workbenchMode("review").label}
@@ -401,8 +412,10 @@ export function ModeCanvas({
           onOpenResearch={onOpenResearch}
         />
       </div>
+      </SurfaceVisibilityProvider>
 
-      <div className="wb-canvas-pad" hidden={mode !== "research" || hidden}>
+      <SurfaceVisibilityProvider visible={mode === "research" && !hidden}>
+        <div className="wb-canvas-pad" hidden={mode !== "research" || hidden}>
         {mode === "research" && !hidden ? (
           <h2 id={headingId} className="wb-surface-title">
             {workbenchMode("research").label}
@@ -418,10 +431,12 @@ export function ModeCanvas({
           readOnly={readOnly}
         />
       </div>
+      </SurfaceVisibilityProvider>
 
       {/* The Skills rail lists what the sidecar scanned, and owns the switch
           that hides a pack from `/skill` and from the Agent (Story 8.6). */}
-      <div className="wb-canvas-pad" hidden={mode !== "skills" || hidden}>
+      <SurfaceVisibilityProvider visible={mode === "skills" && !hidden}>
+        <div className="wb-canvas-pad" hidden={mode !== "skills" || hidden}>
         {mode === "skills" && !hidden ? (
           <h2 id={headingId} className="wb-surface-title">
             {workbenchMode("skills").label}
@@ -429,6 +444,7 @@ export function ModeCanvas({
         ) : null}
         <SkillsCanvas active={mode === "skills" && !hidden} readOnly={readOnly} />
       </div>
+      </SurfaceVisibilityProvider>
 
       {!wikiActive &&
         !hidden &&
diff --git a/src/components/workbench/PreviewColumn.tsx b/src/components/workbench/PreviewColumn.tsx
index cb937e7f..b425efe6 100644
--- a/src/components/workbench/PreviewColumn.tsx
+++ b/src/components/workbench/PreviewColumn.tsx
@@ -11,7 +11,7 @@ import {
   type Ref,
 } from "react";
 import { ConfirmDialog } from "@/components/ConfirmDialog";
-import { SurfaceVisibilityProvider } from "@/hooks/useSurfaceVisibility";
+import { SurfacePresentation, SurfaceVisibilityProvider, useSurfaceVisible } from "@/hooks/useSurfaceVisibility";
 import {
   previewFetchPlan,
   requestDataVersionCheck,
@@ -276,6 +276,35 @@ function PreviewPane({
   hidden = false,
   ref,
 }: PreviewColumnProps & { selection: KernelSelection }) {
+  const visible = useSurfaceVisible();
+  const visibleRef = useRef(visible);
+  visibleRef.current = visible;
+  const selectionKey =
+    selection.kind === "page" ? `page:${selection.slug}` : `file:${selection.path}`;
+  const selectionKeyRef = useRef(selectionKey);
+  selectionKeyRef.current = selectionKey;
+  const dataVersionRef = useRef(dataVersion);
+  dataVersionRef.current = dataVersion;
+  const deferredNudge = useRef<{ key: string; version: number } | null>(null);
+  const deferredAnnouncement = useRef<{ key: string; sentence: string } | null>(null);
+  const deferredHistory = useRef(false);
+  const deferredHistoryError = useRef<{ key: string; message: string } | null>(null);
+  const resumeBarrier = useRef<{ key: string; version: number } | null>(null);
+  const historyVersion = useRef<number | null>(null);
+  const deferredView = useRef<{ file: EditableArtifactFile; timestamp: number } | null>(null);
+  const listInFlight = useRef(false);
+  const viewInFlight = useRef<{ file: EditableArtifactFile; timestamp: number } | null>(null);
+
+  function nudgeVersion(version: number) {
+    if (visibleRef.current) requestDataVersionCheck();
+    else deferredNudge.current = { key: selectionKeyRef.current, version };
+  }
+
+  function announce(sentence: string) {
+    if (visibleRef.current) setRefreshAnnouncement((current) => nextAnnouncement(current, sentence));
+    else deferredAnnouncement.current = { key: selectionKeyRef.current, sentence };
+  }
+
   const [payload, setPayload] = useState<PreviewPayload | null>(null);
   // What is on screen RIGHT NOW, readable from an async callback that closed
   // over an older render. Assigned during render, the `useDialogA11y` idiom.
@@ -525,8 +554,6 @@ function PreviewPane({
   // Keyed on a PRIMITIVE derived from the pick, never on the object: the shell
   // rebuilds that object freely across renders, and an identity key would clear
   // the offsets the owner is still looking at.
-  const selectionKey =
-    selection.kind === "page" ? `page:${selection.slug}` : `file:${selection.path}`;
   // Declared BEFORE the restore, so on the rare commit that changes both the row
   // and `hidden` React runs them in that order: cleared, then restored from
   // nothing.
@@ -592,7 +619,44 @@ function PreviewPane({
     };
   }, [hidden]);
 
+  // A hidden mutation owes one version check. Wait for its served version
+  // before re-reading, otherwise the check's own refresh repeats the return read.
+  // The deadline also works for a standalone pane without a watcher, or a failed
+  // version check: last-good data is retained until bounded revalidation resumes.
+  useLayoutEffect(() => {
+    if (!visible) return;
+    const pending = deferredNudge.current;
+    deferredNudge.current = null;
+    if (pending?.key === selectionKey && pending.version === dataVersion) {
+      resumeBarrier.current = pending;
+      requestDataVersionCheck();
+    }
+    const barrier = resumeBarrier.current;
+    if (!barrier) return;
+    if (barrier.key !== selectionKey || barrier.version !== dataVersion) {
+      resumeBarrier.current = null;
+      return;
+    }
+    const timer = setTimeout(() => {
+      resumeBarrier.current = null;
+      setRetryNonce((current) => current + 1);
+    }, REQUEST_TIMEOUT_MS);
+    return () => clearTimeout(timer);
+  }, [visible, selectionKey, dataVersion]);
+
+  useLayoutEffect(() => {
+    if (!visible) {
+      if (listInFlight.current) deferredHistory.current = true;
+      if (viewInFlight.current) deferredView.current = viewInFlight.current;
+    }
+    return () => {
+      listRequestRef.current += 1;
+      viewRequestRef.current += 1;
+    };
+  }, [visible, selectionKey]);
+
   useEffect(() => {
+    if (resumeBarrier.current) return;
     // WHY this effect is running, and therefore what it may touch — decided by
     // an executed function, never by conditions typed here. A bump that lands
     // while the owner is mid-edit must not take their draft, and a bump that
@@ -602,6 +666,7 @@ function PreviewPane({
       shown: shownSelectionRef.current,
       next: selection,
       editing,
+      visible,
     });
     // The row this run leaves recorded is the PLAN's answer, not an assignment
     // sequenced against the comparison above: `shownSelectionRef.current =
@@ -612,6 +677,7 @@ function PreviewPane({
     // The open editor is never disturbed. `editing` is in the deps below, so
     // closing it lets the deferred read happen instead of losing it.
     if (!plan.fetch) return;
+    let current = true;
     const controller = new AbortController();
     // The deadline is armed here rather than through `AbortSignal.timeout` so
     // one controller carries both reasons to stop: the owner picking another
@@ -624,6 +690,12 @@ function PreviewPane({
       REQUEST_TIMEOUT_MS,
     );
     if (plan.reset) {
+      deferredHistoryError.current = null;
+      deferredHistory.current = false;
+      deferredView.current = null;
+      historyVersion.current = null;
+      listInFlight.current = false;
+      viewInFlight.current = null;
       setLoading(true);
       setGone(false);
       setUnreachable(false);
@@ -684,7 +756,11 @@ function PreviewPane({
     // unreachable is decided by `fetchPreview`, which the node suite executes
     // with a stubbed fetch. Left inline here it could only ever be grepped for.
     void fetchPreview(previewRequestUrl(selection), controller.signal).then((result) => {
+      if (!current || !visibleRef.current || selectionKeyRef.current !== selectionKey) return;
       if (result.status === "stale") return;
+      const pending = deferredAnnouncement.current;
+      deferredAnnouncement.current = null;
+      const mutationSentence = pending?.key === selectionKey ? pending.sentence : null;
       // Both flags are cleared EXPLICITLY, not only via the reset block above: a
       // silent refresh starts from whatever the last read left behind, so a row
       // that failed once would keep saying so after it began answering again —
@@ -710,7 +786,8 @@ function PreviewPane({
             shown: payloadRef.current,
             next: result.payload,
           }) ?? "";
-        setRefreshAnnouncement((current) => nextAnnouncement(current, sentence));
+        const announcement = mutationSentence ?? sentence;
+        setRefreshAnnouncement((current) => nextAnnouncement(current, announcement));
         setPayload(result.payload);
         setGone(false);
         setUnreachable(false);
@@ -722,6 +799,7 @@ function PreviewPane({
         // replacement that is not stale.
         setGone(true);
         setUnreachable(false);
+        if (mutationSentence) setRefreshAnnouncement((current) => nextAnnouncement(current, mutationSentence));
         // A 404 takes the WHOLE edit path with it, dialog included (DW-181).
         // `Edit` unmounts on this render because `previewEditTarget` now
         // answers `null`, but a confirm the owner opened a moment ago would
@@ -763,8 +841,9 @@ function PreviewPane({
         // `null` LEAVES the region as it is rather than clearing it: silence is
         // what is being asked for, and this branch has no opinion about the
         // sentence some other branch put there.
-        if (staleSentence !== null) {
-          setRefreshAnnouncement((current) => nextAnnouncement(current, staleSentence));
+        const announcement = mutationSentence ?? staleSentence;
+        if (announcement !== null) {
+          setRefreshAnnouncement((current) => nextAnnouncement(current, announcement));
         }
       }
       setLoading(false);
@@ -776,16 +855,18 @@ function PreviewPane({
     });
 
     return () => {
+      current = false;
       clearTimeout(deadline);
       controller.abort();
     };
-  }, [selection, dataVersion, editing, retryNonce]);
+  }, [selection, selectionKey, dataVersion, editing, retryNonce, visible]);
 
   // Confirming the dialog unmounts the `Edit` button that opened it, so
   // `useDialogA11y`'s restore has nothing to return focus to. The caret belongs
   // in the editor anyway; leaving is the mirror image. Parent effects run after
   // the dialog's own cleanup, so this is the last word on focus either way.
   useEffect(() => {
+    if (!visible) return;
     if (editing) {
       editorRef.current?.focus();
       return;
@@ -794,7 +875,7 @@ function PreviewPane({
       restoreEditFocus.current = false;
       editRef.current?.focus();
     }
-  }, [editing]);
+  }, [editing, visible]);
 
   // Where focus goes when the revert confirm closes into a running write
   // (DW-214). `useDialogA11y` restores to the OPENER when it is still
@@ -808,8 +889,8 @@ function PreviewPane({
   // Only on the LEADING edge — a revert starting — so the effect cannot pull
   // focus back when the write settles and the owner has moved on.
   useEffect(() => {
-    if (revertingTimestamp !== null) historyToggleRef.current?.focus();
-  }, [revertingTimestamp]);
+    if (visible && revertingTimestamp !== null) historyToggleRef.current?.focus();
+  }, [revertingTimestamp, visible]);
 
   // WHETHER there is unsaved text is one executed function (`previewDraftDirty`),
   // never a comparison typed here: this is the whole of what stands between a
@@ -876,6 +957,8 @@ function PreviewPane({
   }, [gone, payload]);
 
   const save = useCallback(async () => {
+    const originKey = selectionKeyRef.current;
+    const originVersion = dataVersionRef.current;
     const target = editingTargetRef.current;
     if (!target || saving) return;
     // The column must still be showing the thing this draft came from, compared
@@ -914,6 +997,7 @@ function PreviewPane({
     });
     // Busy flag first, on every exit path including the superseded one below.
     setSaving(false);
+    if (selectionKeyRef.current !== originKey) return;
     // The owner may have picked another row while this was in flight. The
     // column is showing that row now, so stamping this draft onto its payload
     // would put file A's text under file B's header — and the focus restore
@@ -952,7 +1036,7 @@ function PreviewPane({
       // write in the system, so the owner's own save is not a special case: it
       // just asks the watcher to look NOW instead of on the next tick, and the
       // answer still comes from the server's integer.
-      requestDataVersionCheck();
+      nudgeVersion(originVersion);
       // A landed save CREATED a revision: `writeWikiArtifact` snapshots the
       // bytes it replaces before it writes (DW-59). The panel's cached list is
       // therefore missing the entry the owner is most likely to want back — and
@@ -982,7 +1066,7 @@ function PreviewPane({
         // find out. The same signal a landed save fires, for the same reason:
         // the answer still comes from the server's integer, not from this
         // column's guess about what happened.
-        requestDataVersionCheck();
+        nudgeVersion(originVersion);
         // THE CACHED REVISION LIST IS NOW WRONG IN THE SAME WAY IT IS AFTER A
         // LANDED SAVE, and this is the one statement of why — the unconfirmed
         // revert below points here rather than restating it.
@@ -1033,15 +1117,22 @@ function PreviewPane({
    * then keep the new row from ever fetching its own.
    */
   async function loadRevisions(file: EditableArtifactFile) {
+    if (!visibleRef.current) { deferredHistory.current = true; return; }
+    deferredHistory.current = false;
+    historyVersion.current = dataVersionRef.current;
+    listInFlight.current = true;
+    const originKey = selectionKeyRef.current;
     const token = ++listRequestRef.current;
     setHistoryLoading(true);
-    setHistoryError(null);
+    const heldError = deferredHistoryError.current;
+    if (heldError?.key !== originKey) setHistoryError(null);
     const result = await fetchArtifactRevisions(file, {
       signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
     });
     // Superseded: another listing started, or the owner left this row. Not an
     // error and not an empty history — simply not this panel's answer any more.
-    if (listRequestRef.current !== token) return;
+    if (!visibleRef.current || selectionKeyRef.current !== originKey || listRequestRef.current !== token) return;
+    listInFlight.current = false;
     setHistoryLoading(false);
     if (result.status === "ok") {
       // The whole landed listing — rows AND the bound that shaped them — in one
@@ -1051,7 +1142,11 @@ function PreviewPane({
         truncated: result.truncated,
         limit: result.limit,
       });
-    } else setHistoryError(result.message);
+    } else if (heldError?.key !== originKey) setHistoryError(result.message);
+    if (heldError?.key === originKey) {
+      setHistoryError(heldError.message);
+      deferredHistoryError.current = null;
+    }
   }
 
   /**
@@ -1070,6 +1165,7 @@ function PreviewPane({
   function refreshHistory() {
     const file = payloadRef.current?.artifact;
     if (!file) return;
+    if (!visibleRef.current) { deferredHistory.current = true; return; }
     if (historyOpenRef.current) void loadRevisions(file);
     else setListing(null);
   }
@@ -1093,17 +1189,26 @@ function PreviewPane({
       setViewContent(null);
       return;
     }
+    await readRevision(historyTarget, timestamp);
+  }
+
+  async function readRevision(file: EditableArtifactFile, timestamp: number) {
+    if (!visibleRef.current) { deferredView.current = { file, timestamp }; return; }
+    deferredView.current = null;
+    viewInFlight.current = { file, timestamp };
+    const originKey = selectionKeyRef.current;
     const token = ++viewRequestRef.current;
     setViewLoading(true);
     setViewingTimestamp(timestamp);
     setViewContent(null);
     setHistoryError(null);
-    const result = await fetchArtifactRevision(historyTarget, timestamp, {
+    const result = await fetchArtifactRevision(file, timestamp, {
       signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
     });
     // Superseded by a newer view, or by a pick. Dropping it here is what keeps
     // one entry's bytes from appearing under another entry's control.
-    if (viewRequestRef.current !== token) return;
+    if (!visibleRef.current || selectionKeyRef.current !== originKey || viewRequestRef.current !== token) return;
+    viewInFlight.current = null;
     setViewLoading(false);
     if (result.status === "ok") {
       setViewContent(result.content);
@@ -1140,6 +1245,8 @@ function PreviewPane({
       setPendingRevert(null);
       return;
     }
+    const originKey = selectionKeyRef.current;
+    const originVersion = dataVersionRef.current;
     const token = ++revertRequestRef.current;
     setPendingRevert(null);
     setRevertingTimestamp(timestamp);
@@ -1156,7 +1263,7 @@ function PreviewPane({
     // done either way and the shell will notice it through `dataVersion`; what
     // must not happen is this result reaching a panel that is now about another
     // file — the same rule `save()` keeps for its own superseded case.
-    if (revertRequestRef.current !== token) return;
+    if (selectionKeyRef.current !== originKey || revertRequestRef.current !== token) return;
     setRevertingTimestamp(null);
     if (result.status === "error") {
       if (result.unconfirmed) {
@@ -1182,7 +1289,8 @@ function PreviewPane({
         //
         // No announcement: `PREVIEW_HISTORY_REVERTED_COPY` says a revert
         // HAPPENED, which is exactly what nobody knows.
-        requestDataVersionCheck();
+        nudgeVersion(originVersion);
+        deferredHistoryError.current = { key: originKey, message: result.message };
         await loadRevisions(file);
         // The re-list is an AWAIT, so the token has to be read again on the far
         // side of it: the owner can pick another row while it is in flight, and
@@ -1190,7 +1298,7 @@ function PreviewPane({
         // straggler cannot write into a panel that has been re-pointed. Without
         // this, the previous row's revert message would be waiting inside the
         // new row's History the next time it was expanded.
-        if (revertRequestRef.current !== token) return;
+        if (selectionKeyRef.current !== originKey || revertRequestRef.current !== token) return;
         setHistoryError(result.message);
         return;
       }
@@ -1207,19 +1315,28 @@ function PreviewPane({
     // the one destructive success announced nothing. Polite, in the column's own
     // region beside `Preview updated`, and through `nextAnnouncement` so a
     // second revert is heard as a second revert (DW-182).
-    setRefreshAnnouncement((current) =>
-      nextAnnouncement(current, historyCopy.reverted),
-    );
+    announce(historyCopy.reverted);
     // The SAME signal a landed save fires. The revert bumped `dataVersion` at
     // the kernel's one tail, so this asks the watcher to look NOW and the new
     // bytes arrive through the column's single fetch effect — never through a
     // second read path belonging to this panel.
-    requestDataVersionCheck();
+    nudgeVersion(originVersion);
     // …and the list has one more entry than it did: the bytes this revert
     // replaced were snapshotted by `writeWikiArtifact` behind the route.
     await loadRevisions(file);
   }
 
+  useEffect(() => {
+    if (!visible) return;
+    if (deferredAnnouncement.current?.key !== selectionKey) deferredAnnouncement.current = null;
+    if (resumeBarrier.current || !historyTarget || !historyOpen) return;
+    if (deferredHistory.current || (historyVersion.current !== null && historyVersion.current !== dataVersion)) {
+      void loadRevisions(historyTarget);
+    }
+    const view = deferredView.current;
+    if (view && view.file === historyTarget) void readRevision(view.file, view.timestamp);
+  }, [visible, selectionKey, historyTarget, historyOpen, dataVersion, retryNonce]);
+
   const page = selection.kind === "page" ? findKnowledgePage(knowledge, selection.slug) : null;
   // WHAT to call this pick is `selectionName`, in `workbench-tree` where the
   // node suite runs it — not a ternary here. The shell speaks the same name in
@@ -1392,6 +1509,7 @@ function PreviewPane({
 
   return (
     <aside id={id} className="wb-preview" hidden={hidden} aria-label="Preview" ref={mergeAsideRef}>
+      <SurfacePresentation>
       <header className="wb-preview-head">
         <strong className="wb-preview-title">Preview</strong>
         <span className="wb-preview-name">{name}</span>
@@ -1797,6 +1915,7 @@ function PreviewPane({
           onJumpToSource={canJumpToSource ? jumpToSource : undefined}
         />
       )}
+      </SurfacePresentation>
     </aside>
   );
 }
diff --git a/src/components/workbench/ResearchCanvas.tsx b/src/components/workbench/ResearchCanvas.tsx
index 9f7c217e..7bd78d28 100644
--- a/src/components/workbench/ResearchCanvas.tsx
+++ b/src/components/workbench/ResearchCanvas.tsx
@@ -1,6 +1,7 @@
 "use client";
 
 import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
+import { SurfacePresentation, useSurfaceVisible } from "@/hooks/useSurfaceVisibility";
 import { send, writeFailure } from "@/lib/workbench-request";
 import { workbenchMode } from "@/lib/workbench-modes";
 import { readStoredResearchFill } from "@/lib/workbench-state";
@@ -76,6 +77,9 @@ export function ResearchCanvas({
   filledId = null,
   readOnly = false,
 }: ResearchCanvasProps) {
+  const visible = useSurfaceVisible(active);
+  const visibleRef = useRef(visible);
+  visibleRef.current = visible;
   const empty = workbenchMode("research").emptyState ?? "";
   const [projects, setProjects] = useState<ResearchProject[]>([]);
   const [error, setError] = useState<string | null>(null);
@@ -122,6 +126,7 @@ export function ResearchCanvas({
   }, [wikiId]);
 
   const load = useCallback(async () => {
+    if (!visibleRef.current) return;
     const seq = ++loadSeq.current;
     try {
       const wiki = researchWikiId(wikiId);
@@ -129,7 +134,7 @@ export function ResearchCanvas({
         ? `/api/research?wikiId=${encodeURIComponent(wiki)}`
         : "/api/research";
       const body = await send<ResearchResponse>(path, { method: "GET" });
-      if (seq !== loadSeq.current) return;
+      if (!visibleRef.current || seq !== loadSeq.current) return;
       setProjects(body.projects ?? []);
       setError(null);
       // The repair notice is about THIS read's predecessor. Any later read —
@@ -139,16 +144,17 @@ export function ResearchCanvas({
       // before the notice goes up rather than after.
       setRepaired(false);
     } catch (cause) {
-      if (seq !== loadSeq.current) return;
+      if (!visibleRef.current || seq !== loadSeq.current) return;
       setError(cause instanceof Error ? cause.message : "Couldn’t load Deep Research.");
       setRepaired(false);
     }
   }, [wikiId]);
 
   useEffect(() => {
-    if (!active) return;
+    if (!visible) return;
     void load();
-  }, [active, load, filledId]);
+    return () => { loadSeq.current += 1; };
+  }, [visible, load, filledId]);
 
   // Poll only while something is moving. A finished board is static, and an
   // interval against it would be a request every few seconds for the life of
@@ -156,12 +162,12 @@ export function ResearchCanvas({
   // is precisely a transition this panel cannot otherwise learn about.
   const streaming = error !== null || projects.some(researchIsPolling);
   useEffect(() => {
-    if (!active || !streaming) return;
+    if (!visible || !streaming) return;
     const timer = setInterval(() => {
       void load();
     }, RESEARCH_POLL_MS);
     return () => clearInterval(timer);
-  }, [active, streaming, load]);
+  }, [visible, streaming, load]);
 
   const queries = parseResearchQueries(queryText);
   const canStart = !readOnly && topic.trim().length > 0 && queries.length > 0 && !starting;
@@ -328,6 +334,7 @@ export function ResearchCanvas({
   const repairable = error !== null && researchRegistryRepairable(error);
 
   return (
+    <SurfacePresentation active={active}>
     <div className="wb-research">
       {error && <p className="wb-todos-error">{error}</p>}
       {/* THE STATEMENT A DESTRUCTIVE OPERATION OWES. This canvas has no
@@ -467,6 +474,7 @@ export function ResearchCanvas({
         </p>
       ) : null}
     </div>
+    </SurfacePresentation>
   );
 }
 
diff --git a/src/components/workbench/ReviewCanvas.tsx b/src/components/workbench/ReviewCanvas.tsx
index 6c268dd4..1af8cf82 100644
--- a/src/components/workbench/ReviewCanvas.tsx
+++ b/src/components/workbench/ReviewCanvas.tsx
@@ -3,6 +3,7 @@
 import { useCallback, useEffect, useId, useRef, useState } from "react";
 import { RESEARCH_CREATE_READ_ONLY_COPY, researchWikiId } from "@/lib/research-panel";
 import { normalizeReviewCount } from "@/lib/review-count";
+import { SurfacePresentation, useSurfaceVisible } from "@/hooks/useSurfaceVisibility";
 import { send, writeFailure } from "@/lib/workbench-request";
 import { workbenchMode } from "@/lib/workbench-modes";
 import { selectionFromContentPath, type TreeSelection } from "@/lib/workbench-tree";
@@ -52,6 +53,9 @@ export function ReviewCanvas({
   onOpenResearch,
 }: ReviewCanvasProps) {
   const empty = workbenchMode("review").emptyState ?? "No pending cards.";
+  const visible = useSurfaceVisible(active);
+  const visibleRef = useRef(visible);
+  visibleRef.current = visible;
   const [items, setItems] = useState<ReviewItem[]>([]);
   const [itemsWikiId, setItemsWikiId] = useState<string | null>(null);
   const [error, setError] = useState<string | null>(null);
@@ -89,6 +93,7 @@ export function ReviewCanvas({
   }, [wikiId]);
 
   const load = useCallback(async () => {
+    if (!visibleRef.current) return;
     const seq = ++loadSeq.current;
     if (!wikiId) {
       setItems([]);
@@ -100,14 +105,14 @@ export function ReviewCanvas({
     try {
       const query = `?wikiId=${encodeURIComponent(wikiId)}`;
       const body = await send<ReviewResponse>(`/api/review-queue${query}`, { method: "GET" });
-      if (seq !== loadSeq.current) return;
+      if (!visibleRef.current || seq !== loadSeq.current) return;
       setItems(body.items ?? []);
       setItemsWikiId(wikiId);
       const next = normalizeReviewCount(body.pendingCount);
       if (next !== null) onPendingCountChange?.(next);
       setError(null);
     } catch (cause) {
-      if (seq !== loadSeq.current) return;
+      if (!visibleRef.current || seq !== loadSeq.current) return;
       setItems([]);
       setItemsWikiId(wikiId);
       setError(cause instanceof Error ? cause.message : "Couldn’t load Review.");
@@ -115,9 +120,10 @@ export function ReviewCanvas({
   }, [onPendingCountChange, wikiId]);
 
   useEffect(() => {
-    if (!active) return;
+    if (!visible) return;
     void load();
-  }, [active, load, dataVersion]);
+    return () => { loadSeq.current += 1; };
+  }, [visible, load, dataVersion]);
 
   async function act(id: string, action: "skip" | "create-page") {
     if (readOnly || !wikiId) return;
@@ -228,6 +234,7 @@ export function ReviewCanvas({
   const shown = itemsWikiId === wikiId ? items : [];
 
   return (
+    <SurfacePresentation active={active}>
     <div className="wb-review">
       {error && <p className="wb-todos-error">{error}</p>}
       {shown.length === 0 ? (
@@ -348,5 +355,6 @@ export function ReviewCanvas({
         onConfirm={(values) => void confirmResearch(values)}
       />
     </div>
+    </SurfacePresentation>
   );
 }
diff --git a/src/components/workbench/SearchCanvas.tsx b/src/components/workbench/SearchCanvas.tsx
index 65e425c4..d7e516fe 100644
--- a/src/components/workbench/SearchCanvas.tsx
+++ b/src/components/workbench/SearchCanvas.tsx
@@ -1,6 +1,8 @@
 "use client";
 
-import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
+import { SurfacePresentation } from "@/hooks/useSurfaceVisibility";
+
+import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
 import { send } from "@/lib/workbench-request";
 import {
   CHAT_VECTOR_FALLBACK_COPY,
@@ -32,6 +34,15 @@ export function SearchCanvas({ wikiId, onDockPreview }: SearchCanvasProps) {
   const [vectorNote, setVectorNote] = useState<string | null>(null);
   const [busy, setBusy] = useState(false);
   const searchSeq = useRef(0);
+  const wikiScope = useRef(wikiId);
+  wikiScope.current = wikiId;
+  useEffect(() => {
+    searchSeq.current += 1;
+    setHits(null);
+    setError(null);
+    setVectorNote(null);
+    setBusy(false);
+  }, [wikiId]);
   // The two halves of one list. Recomputed per render rather than stored, so
   // there is no second copy of the results to fall out of step with `hits`.
   const { images, rest } = partitionSearchImages(hits ?? []);
@@ -48,7 +59,7 @@ export function SearchCanvas({ wikiId, onDockPreview }: SearchCanvasProps) {
         `/api/v1/projects/${encodeURIComponent(wikiId)}/search`,
         { method: "POST", body: JSON.stringify({ query: trimmed, topK: 10 }) },
       );
-      if (seq !== searchSeq.current) return;
+      if (wikiScope.current !== wikiId || seq !== searchSeq.current) return;
       if (body.error) {
         setError(body.error);
         setHits(null);
@@ -59,11 +70,11 @@ export function SearchCanvas({ wikiId, onDockPreview }: SearchCanvasProps) {
         setVectorNote(body.vectorPhase.message || CHAT_VECTOR_FALLBACK_COPY);
       }
     } catch (cause) {
-      if (seq !== searchSeq.current) return;
+      if (wikiScope.current !== wikiId || seq !== searchSeq.current) return;
       setError(cause instanceof Error ? cause.message : "Search failed.");
       setHits(null);
     } finally {
-      if (seq === searchSeq.current) setBusy(false);
+      if (wikiScope.current === wikiId && seq === searchSeq.current) setBusy(false);
     }
   }
 
@@ -80,6 +91,7 @@ export function SearchCanvas({ wikiId, onDockPreview }: SearchCanvasProps) {
   }
 
   return (
+    <SurfacePresentation>
     <div className="wb-search">
       <form className="wb-search-form" onSubmit={onSubmit}>
         <label className="wb-sr-only" htmlFor="wb-search-q">
@@ -146,5 +158,6 @@ export function SearchCanvas({ wikiId, onDockPreview }: SearchCanvasProps) {
         </ul>
       ) : null}
     </div>
+    </SurfacePresentation>
   );
 }
diff --git a/src/components/workbench/SkillsCanvas.tsx b/src/components/workbench/SkillsCanvas.tsx
index d5278571..9ebf5c93 100644
--- a/src/components/workbench/SkillsCanvas.tsx
+++ b/src/components/workbench/SkillsCanvas.tsx
@@ -1,6 +1,7 @@
 "use client";
 
-import { useCallback, useEffect, useState } from "react";
+import { useCallback, useEffect, useRef, useState } from "react";
+import { SurfacePresentation, useSurfaceVisible } from "@/hooks/useSurfaceVisibility";
 import { loopbackFetch } from "@/lib/loopback-client";
 import { workbenchMode } from "@/lib/workbench-modes";
 import {
@@ -46,6 +47,10 @@ export interface SkillsCanvasProps {
 }
 
 export function SkillsCanvas({ active, readOnly = false }: SkillsCanvasProps) {
+  const visible = useSurfaceVisible(active);
+  const visibleRef = useRef(visible);
+  visibleRef.current = visible;
+  const scanSeq = useRef(0);
   const [skills, setSkills] = useState<SkillSummary[] | null>(null);
   const [error, setError] = useState<string | null>(null);
   const [busy, setBusy] = useState<string | null>(null);
@@ -73,12 +78,15 @@ export function SkillsCanvas({ active, readOnly = false }: SkillsCanvasProps) {
    */
   const scan = useCallback(
     async (options: { signal?: AbortSignal; quiet?: boolean } = {}) => {
+      if (!visibleRef.current) return;
+      const seq = ++scanSeq.current;
       const { signal, quiet = false } = options;
       try {
         const read = await loopbackFetch(SKILL_SCAN_URL, {
           cache: "no-store",
           ...(signal ? { signal } : {}),
         });
+        if (!visibleRef.current || signal?.aborted || seq !== scanSeq.current) return;
         if (!read.ok) {
           if (quiet) return;
           setError(SKILLS_SCAN_FAILED_COPY);
@@ -86,6 +94,7 @@ export function SkillsCanvas({ active, readOnly = false }: SkillsCanvasProps) {
           return;
         }
         const body = (await read.json()) as { skills?: SkillSummary[] };
+        if (!visibleRef.current || signal?.aborted || seq !== scanSeq.current) return;
         const listed = Array.isArray(body.skills) ? body.skills : null;
         if (quiet) {
           // Replaced only when a list was actually READ — reading it is the
@@ -96,7 +105,7 @@ export function SkillsCanvas({ active, readOnly = false }: SkillsCanvasProps) {
         setError(null);
         setSkills(listed ?? []);
       } catch {
-        if (signal?.aborted) return;
+        if (!visibleRef.current || signal?.aborted || seq !== scanSeq.current) return;
         if (quiet) return;
         // Sidecar down or API off. Named, unlike in Chat: this surface exists to
         // answer "which Skills do I have", and a silent empty list would read as
@@ -109,11 +118,11 @@ export function SkillsCanvas({ active, readOnly = false }: SkillsCanvasProps) {
   );
 
   useEffect(() => {
-    if (!active) return;
+    if (!visible) return;
     const controller = new AbortController();
     void scan({ signal: controller.signal });
-    return () => controller.abort();
-  }, [active, scan]);
+    return () => { scanSeq.current += 1; controller.abort(); };
+  }, [visible, scan]);
 
   /**
    * Flip one Skill.
@@ -178,6 +187,7 @@ export function SkillsCanvas({ active, readOnly = false }: SkillsCanvasProps) {
   }
 
   return (
+    <SurfacePresentation active={active}>
     <div className="wb-skills">
       <p className="wb-skills-hint">{SKILLS_SCAN_HINT_COPY}</p>
       {error ? (
@@ -219,5 +229,6 @@ export function SkillsCanvas({ active, readOnly = false }: SkillsCanvasProps) {
         </ul>
       ) : null}
     </div>
+    </SurfacePresentation>
   );
 }
diff --git a/src/components/workbench/TodosCanvas.tsx b/src/components/workbench/TodosCanvas.tsx
index 4bb496bd..cda8c945 100644
--- a/src/components/workbench/TodosCanvas.tsx
+++ b/src/components/workbench/TodosCanvas.tsx
@@ -1,6 +1,7 @@
 "use client";
 
 import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
+import { SurfacePresentation, useSurfaceVisible } from "@/hooks/useSurfaceVisibility";
 import { send, writeFailure } from "@/lib/workbench-request";
 import { workbenchMode } from "@/lib/workbench-modes";
 import { selectionFromContentPath, type TreeSelection } from "@/lib/workbench-tree";
@@ -64,6 +65,9 @@ export function TodosCanvas({
   onDockPreview,
   onPendingCountChange,
 }: TodosCanvasProps) {
+  const surfaceVisible = useSurfaceVisible(active);
+  const visibleRef = useRef(surfaceVisible);
+  visibleRef.current = surfaceVisible;
   const empty = workbenchMode("todos").emptyState ?? "No candidates. Meeting ingest will propose them.";
   const [tab, setTab] = useState<TodoTab>("candidates");
   const [items, setItems] = useState<TodoItem[]>([]);
@@ -96,16 +100,17 @@ export function TodosCanvas({
   const todosNoteId = useId();
 
   const load = useCallback(async () => {
+    if (!visibleRef.current) return;
     const seq = ++loadSeq.current;
     try {
       const body = await send<TodosResponse>(`/api/todos?tab=${tab}`, { method: "GET" });
-      if (seq !== loadSeq.current) return;
+      if (!visibleRef.current || seq !== loadSeq.current) return;
       setItems(body.items ?? []);
       setExtractError(body.extractError ?? null);
       if (typeof body.pendingCount === "number") onPendingCountChange?.(body.pendingCount);
       setError(null);
     } catch (cause) {
-      if (seq !== loadSeq.current) return;
+      if (!visibleRef.current || seq !== loadSeq.current) return;
       setItems([]);
       setExtractError(null);
       setError(cause instanceof Error ? cause.message : "Couldn’t load Todos.");
@@ -113,9 +118,10 @@ export function TodosCanvas({
   }, [tab, onPendingCountChange]);
 
   useEffect(() => {
-    if (!active) return;
+    if (!surfaceVisible) return;
     void load();
-  }, [active, load]);
+    return () => { loadSeq.current += 1; };
+  }, [surfaceVisible, load]);
 
   const visible = useMemo(() => {
     const today = new Date().toISOString().slice(0, 10);
@@ -226,6 +232,7 @@ export function TodosCanvas({
   const bulkIds = [...selected];
 
   return (
+    <SurfacePresentation active={active}>
     <div className="wb-todos">
       <div className="wb-todos-bar">
         <div className="wb-todos-seg" role="tablist" aria-label="Todo lists">
@@ -547,5 +554,6 @@ export function TodosCanvas({
         </p>
       ) : null}
     </div>
+    </SurfacePresentation>
   );
 }
diff --git a/src/components/workbench/__tests__/chat-conversation-crud.test.tsx b/src/components/workbench/__tests__/chat-conversation-crud.test.tsx
index d7363dae..a77dcb2a 100644
--- a/src/components/workbench/__tests__/chat-conversation-crud.test.tsx
+++ b/src/components/workbench/__tests__/chat-conversation-crud.test.tsx
@@ -47,6 +47,7 @@ vi.mock("@/lib/workbench-data-version", async () => {
   return { ...actual, requestDataVersionCheck };
 });
 
+import { SurfaceVisibilityProvider } from "@/hooks/useSurfaceVisibility";
 import { ChatCanvas } from "@/components/workbench/ChatCanvas";
 import {
   useChatConversations,
@@ -385,3 +386,45 @@ describe("New Chat writes on both sides of the hook boundary", () => {
     expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("");
   });
 });
+
+
+describe("returning Chat snapshots cannot undo explicit list mutations (DW-422)", () => {
+  it.each(["create", "rename", "delete"])("preserves %s while a return refresh is pending", async (operation) => {
+    baseSend((url) => {
+      if (url === "/api/chat/conversations") return { conversations: [ALPHA, BETA] };
+      if (url === "/api/chat/conversations/c1") return { conversation: ALPHA };
+      return {};
+    });
+    const tree = (visible: boolean) => <SurfaceVisibilityProvider visible={visible}><HookProbe /></SurfaceVisibilityProvider>;
+    const view = render(tree(true));
+    await act(async () => {});
+    expect(hook!.conversations.map((row) => row.id)).toEqual(["c1", "c2"]);
+    expect(hook!.activeId).toBe("c1");
+    view.rerender(tree(false));
+    let release!: (body: unknown) => void;
+    const staleList = new Promise((resolve) => { release = resolve; });
+    send.mockImplementation(async (url: string, init?: RequestInit) => {
+      if (url === "/api/chat/conversations" && init?.method === "GET") return staleList;
+      if (url === "/api/chat/conversations" && init?.method === "POST") return { conversation: GAMMA };
+      if (url === "/api/chat/conversations/c1" && init?.method === "PATCH") return { conversation: { ...ALPHA, name: "Renamed Alpha" } };
+      return {};
+    });
+    view.rerender(tree(true));
+    await act(async () => {});
+    expect(send.mock.calls.filter(([url, init]) => url === "/api/chat/conversations" && init?.method === "GET")).toHaveLength(2);
+    await act(async () => {
+      if (operation === "create") await hook!.startConversation();
+      else if (operation === "rename") await hook!.renameActive("c1", "Renamed Alpha");
+      else await hook!.removeConversation("c2");
+    });
+    const expected = hook!.conversations.map((row) => ({ id: row.id, name: row.name }));
+    await act(async () => release({ conversations: [ALPHA, BETA] }));
+    expect(hook!.conversations.map((row) => ({ id: row.id, name: row.name }))).toEqual(expected);
+    if (operation === "create") {
+      expect(hook!.activeId).toBe("c3");
+      expect(hook!.conversations.map((row) => row.id)).toEqual(["c3", "c1", "c2"]);
+    } else if (operation === "rename") {
+      expect(hook!.conversations.find((row) => row.id === "c1")?.name).toBe("Renamed Alpha");
+    } else expect(hook!.conversations.map((row) => row.id)).toEqual(["c1"]);
+  });
+});
diff --git a/src/components/workbench/__tests__/chat-live-stream.test.tsx b/src/components/workbench/__tests__/chat-live-stream.test.tsx
index 3cbe846a..28ecb319 100644
--- a/src/components/workbench/__tests__/chat-live-stream.test.tsx
+++ b/src/components/workbench/__tests__/chat-live-stream.test.tsx
@@ -19,6 +19,7 @@
  */
 import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
 import {
+  act,
   cleanup,
   fireEvent,
   render,
@@ -31,6 +32,7 @@ import { toolRowLabel } from "@/lib/chat-agent";
 const { send } = vi.hoisted(() => ({ send: vi.fn() }));
 vi.mock("@/lib/workbench-request", () => ({ send }));
 
+import { ModeCanvas } from "@/components/workbench/ModeCanvas";
 import { ChatCanvas } from "@/components/workbench/ChatCanvas";
 import { clearLoopbackDoorToken } from "@/lib/loopback-client";
 
@@ -335,3 +337,27 @@ describe("the owner can end a turn that is still in flight", () => {
     expect(signal.aborted).toBe(true);
   });
 });
+
+
+it("keeps an active Chat stream alive while its mode is withdrawn (DW-422)", async () => {
+  const tree = (hidden: boolean) => <ModeCanvas mode="chat" sidecar="up" headingId="chat-mode" hidden={hidden} wikiId="current"><p>Wiki</p></ModeCanvas>;
+  const view = render(tree(false));
+  await screen.findByLabelText("Message");
+  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "How is revenue?" } });
+  fireEvent.click(screen.getByRole("button", { name: "Send" }));
+  await screen.findByText("Rolling revenue is up.");
+  const signal = chatSignal;
+  const region = document.querySelector(".wb-chat-log");
+  const before = region?.textContent;
+  view.rerender(tree(true));
+  expect(signal?.aborted).toBe(false);
+  await act(async () => releaseDone());
+  expect(region?.textContent).toBe(before);
+  expect(send.mock.calls.filter(([url]) => url.includes("/conversations/c1/messages"))).toHaveLength(1);
+  view.rerender(tree(false));
+  await screen.findByText("Settled answer.");
+  expect(document.querySelector(".wb-chat-log")).toBe(region);
+  expect(signal?.aborted).toBe(false);
+  expect(send.mock.calls.filter(([url]) => url.endsWith("/retrieve"))).toHaveLength(1);
+  expect(send.mock.calls.filter(([url]) => url === "/api/chat/conversations/c1")).toHaveLength(1);
+});
diff --git a/src/components/workbench/__tests__/preview-announcements.test.tsx b/src/components/workbench/__tests__/preview-announcements.test.tsx
index 4bc538a6..87477f21 100644
--- a/src/components/workbench/__tests__/preview-announcements.test.tsx
+++ b/src/components/workbench/__tests__/preview-announcements.test.tsx
@@ -1326,3 +1326,33 @@ describe("Retry reports that it is working (DW-184)", () => {
     expect(back.disabled).toBe(false);
   });
 });
+
+
+describe("hidden Preview lifecycle (DW-422)", () => {
+  it("coalesces hidden version bumps and ignores a cancellation-ignoring late response", async () => {
+    const view = await renderShell();
+    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
+    await act(async () => {});
+    let settle!: (value: unknown) => void;
+    answer = () => new Promise((resolve) => { settle = resolve; });
+    await refresh(view, { ...DATA, dataVersion: 1 });
+    expect(reads).toHaveLength(2);
+    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
+    await act(async () => {});
+    const before = columnAnnouncedRaw();
+    await refresh(view, { ...DATA, dataVersion: 2 });
+    await refresh(view, { ...DATA, dataVersion: 3 });
+    await act(async () => { settle({ ok: true, status: 200, json: async () => payload("Alpha", "obsolete hidden bytes") }); });
+    expect(reads).toHaveLength(2);
+    expect(columnAnnouncedRaw()).toBe(before);
+    expect(document.querySelector(".wb-preview")?.textContent).not.toContain("obsolete hidden bytes");
+    answer = () => ({ ok: true, status: 200, json: async () => payload("Alpha", "latest returned bytes") });
+    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
+    await act(async () => {});
+    expect(reads).toHaveLength(3);
+    expect(screen.getByText("latest returned bytes")).toBeTruthy();
+    expect(announcementSentence(columnAnnouncedRaw())).toBe(PREVIEW_UPDATED_COPY);
+    await refresh(view, { ...DATA, dataVersion: 4 });
+    expect(reads).toHaveLength(4);
+  });
+});
diff --git a/src/components/workbench/__tests__/preview-dirty-guard.test.tsx b/src/components/workbench/__tests__/preview-dirty-guard.test.tsx
index 860db8f6..50c6215a 100644
--- a/src/components/workbench/__tests__/preview-dirty-guard.test.tsx
+++ b/src/components/workbench/__tests__/preview-dirty-guard.test.tsx
@@ -9,6 +9,7 @@ import {
 } from "@/components/workbench/WorkbenchData";
 import {
   PREVIEW_CLOSED_COPY,
+  PREVIEW_CANCEL_COPY,
   PREVIEW_DISCARD_CONFIRM_LABEL,
   PREVIEW_DISCARD_CONFIRM_TITLE,
   PREVIEW_EDIT_CONFIRM_LABEL,
@@ -930,3 +931,32 @@ describe("a save the write precondition refuses (DW-38, DW-51)", () => {
     expect(writes[0].headers["If-Match"]).toBe(`"${SEEDED_VERSION}"`);
   });
 });
+
+
+it("defers hidden bumps through a dirty editor until the owner leaves it (DW-422)", async () => {
+  window.history.replaceState(null, "", "/");
+  let reads = 0;
+  answer = () => { reads += 1; return { ok: true, status: 200, json: async () => payload("Alpha", reads === 1 ? "# Alpha" : "Current server bytes") }; };
+  const view = await renderShell();
+  fireEvent.click(row("Alpha"));
+  await act(async () => {});
+  await typeIntoEditor("Owner draft survives");
+  const original = editor();
+  fireEvent.click(row("Settings"));
+  for (const dataVersion of [1, 2, 3]) {
+    view.rerender(<WorkbenchDataProvider value={{ ...DATA, dataVersion }}><Workbench><p>canvas</p></Workbench></WorkbenchDataProvider>);
+    await act(async () => {});
+  }
+  fireEvent.click(row("Settings"));
+  await act(async () => {});
+  expect(editor()).toBe(original);
+  expect(editor()?.value).toBe("Owner draft survives");
+  expect(reads).toBe(1);
+  fireEvent.click(row(PREVIEW_CANCEL_COPY));
+  await act(async () => {});
+  const discard = screen.queryByRole("button", { name: PREVIEW_DISCARD_CONFIRM_LABEL });
+  if (discard) fireEvent.click(discard);
+  await act(async () => {});
+  expect(reads).toBe(2);
+  expect(screen.getByText("Current server bytes")).toBeTruthy();
+});
diff --git a/src/components/workbench/__tests__/preview-revision-history.test.tsx b/src/components/workbench/__tests__/preview-revision-history.test.tsx
index 36948881..28735f82 100644
--- a/src/components/workbench/__tests__/preview-revision-history.test.tsx
+++ b/src/components/workbench/__tests__/preview-revision-history.test.tsx
@@ -1,5 +1,6 @@
 import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
 import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
+import { PreviewColumn } from "../PreviewColumn";
 import { Workbench } from "@/components/workbench/Workbench";
 import {
   WorkbenchDataProvider,
@@ -1244,3 +1245,213 @@ describe("the gate names the version, and the panel is reachable by keyboard", (
     expect(pre.getAttribute("aria-label")).toBe(artifactRevisionDate(NEWER));
   });
 });
+
+describe("hidden mutation reconciliation (DW-422)", () => {
+  async function settings() {
+    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
+    await act(async () => {});
+  }
+  async function serve(view: ReturnType<typeof render>, dataVersion: number) {
+    view.rerender(<WorkbenchDataProvider value={{ ...DATA, dataVersion }}><Workbench><p>canvas</p></Workbench></WorkbenchDataProvider>);
+    await act(async () => {});
+  }
+  it.each(["ok", "unreachable"])("holds a hidden revert's reads for its version answer, then refreshes each resource once (%s)", async (readOutcome) => {
+    let previews = 0;
+    previewAnswer = () => { previews += 1; return ok(schemaPayload()); };
+    const pending = deferred<unknown>();
+    revertAnswer = () => pending.promise;
+    const view = await renderShell();
+    await dock();
+    await expandHistory();
+    const nudge = vi.fn();
+    const unsubscribe = subscribeDataVersionCheck(nudge);
+    try {
+      fireEvent.click(revertButtons()[0]);
+      fireEvent.click(screen.getByRole("button", { name: PREVIEW_HISTORY_REVERT_CONFIRM_LABEL }));
+      await settings();
+      const before = columnAnnounced();
+      await act(async () => pending.resolve(ok({ ok: true, version: "w1s:2-new" })));
+      expect(nudge).not.toHaveBeenCalled();
+      expect(listings()).toBe(1);
+      expect(previews).toBe(1);
+      expect(columnAnnounced()).toBe(before);
+      await settings();
+      expect(nudge).toHaveBeenCalledTimes(1);
+      expect(previews).toBe(1);
+      expect(listings()).toBe(1);
+      if (readOutcome === "unreachable") previewAnswer = () => { previews += 1; return refusal(503, "Temporarily unavailable"); };
+      await serve(view, 1);
+      expect(previews).toBe(2);
+      expect(listings()).toBe(2);
+      expect(columnAnnounced()).toBe(PREVIEW_HISTORY_REVERTED_COPY);
+      await serve(view, 2);
+      expect(previews).toBe(3);
+      expect(listings()).toBe(3);
+    } finally { unsubscribe(); }
+  });
+
+
+  it("uses a version already served while the hidden write was in flight", async () => {
+    const pending = deferred<unknown>();
+    revertAnswer = () => pending.promise;
+    const view = await renderShell();
+    await dock();
+    await expandHistory();
+    fireEvent.click(revertButtons()[0]);
+    fireEvent.click(screen.getByRole("button", { name: PREVIEW_HISTORY_REVERT_CONFIRM_LABEL }));
+    await settings();
+    await serve(view, 1);
+    await act(async () => pending.resolve(ok({ ok: true, version: "next" })));
+    const nudge = vi.fn();
+    const unsubscribe = subscribeDataVersionCheck(nudge);
+    try {
+      await settings();
+      expect(nudge).not.toHaveBeenCalled();
+      expect(listings()).toBe(2);
+      expect(columnAnnounced()).toBe(PREVIEW_HISTORY_REVERTED_COPY);
+    } finally { unsubscribe(); }
+  });
+
+  it("keeps an unconfirmed hidden revert's failure through the resumed history read", async () => {
+    const pending = deferred<unknown>();
+    revertAnswer = () => pending.promise;
+    const view = await renderShell();
+    await dock();
+    await expandHistory();
+    fireEvent.click(revertButtons()[0]);
+    fireEvent.click(screen.getByRole("button", { name: PREVIEW_HISTORY_REVERT_CONFIRM_LABEL }));
+    await settings();
+    await act(async () => pending.resolve(Promise.reject(new TypeError("Network lost"))));
+    expect(listings()).toBe(1);
+    await settings();
+    await serve(view, 1);
+    expect(listings()).toBe(2);
+    expect(screen.getByRole("alert").textContent).toContain("the outcome is unknown");
+  });
+
+
+  it.each(["ok", "refused"])("settles a hidden save (%s) without losing the owner's result", async (outcome) => {
+    let previews = 0;
+    previewAnswer = () => { previews += 1; return ok(schemaPayload()); };
+    const pending = deferred<unknown>();
+    writeAnswer = () => pending.promise;
+    const view = await renderShell();
+    await dock();
+    await expandHistory();
+    fireEvent.click(screen.getByRole("button", { name: PREVIEW_EDIT_COPY }));
+    fireEvent.click(screen.getByRole("button", { name: PREVIEW_EDIT_CONFIRM_LABEL }));
+    await act(async () => {});
+    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Saved owner's bytes" } });
+    fireEvent.click(screen.getByRole("button", { name: PREVIEW_SAVE_COPY }));
+    await settings();
+    const nudge = vi.fn();
+    const unsubscribe = subscribeDataVersionCheck(nudge);
+    try {
+      await act(async () => pending.resolve(outcome === "ok" ? ok({ ok: true, version: "next" }) : refusal(412, "This version changed. Keep your draft.")));
+      expect(nudge).not.toHaveBeenCalled();
+      expect(listings()).toBe(1);
+      expect(previews).toBe(1);
+      await settings();
+      if (outcome === "ok") {
+        expect(nudge).toHaveBeenCalledTimes(1);
+        await serve(view, 1);
+        expect(previews).toBe(2);
+        expect(listings()).toBe(2);
+        expect(screen.queryByRole("textbox")).toBeNull();
+      } else {
+        expect(nudge).not.toHaveBeenCalled();
+        expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Saved owner's bytes");
+        expect(screen.getByRole("alert").textContent).toBe("This version changed. Keep your draft.");
+        expect(screen.getByRole("button", { name: PREVIEW_SAVE_COPY }).hasAttribute("disabled")).toBe(false);
+      }
+    } finally { unsubscribe(); }
+  });
+
+
+  it("releases one return reconciliation when the local version barrier times out", async () => {
+    // Preview retains its existing 15-second request deadline.
+    const previewTimeout = 15_000;
+    const pending = deferred<unknown>();
+    revertAnswer = () => pending.promise;
+    let previews = 0;
+    previewAnswer = () => { previews += 1; return ok(schemaPayload()); };
+    const view = await renderShell();
+    await dock();
+    await expandHistory();
+    fireEvent.click(revertButtons()[0]);
+    fireEvent.click(screen.getByRole("button", { name: PREVIEW_HISTORY_REVERT_CONFIRM_LABEL }));
+    await settings();
+    await act(async () => pending.resolve(ok({ ok: true, version: "next" })));
+    vi.useFakeTimers();
+    try {
+      await settings();
+      expect(previews).toBe(1);
+      expect(listings()).toBe(1);
+      await act(async () => vi.advanceTimersByTimeAsync(previewTimeout - 1));
+      expect(previews).toBe(1);
+      expect(listings()).toBe(1);
+      await act(async () => vi.advanceTimersByTimeAsync(1));
+      expect(previews).toBe(2);
+      expect(listings()).toBe(2);
+      expect(columnAnnounced()).toBe(PREVIEW_HISTORY_REVERTED_COPY);
+      await act(async () => vi.advanceTimersByTimeAsync(previewTimeout));
+      expect(previews).toBe(2);
+      expect(listings()).toBe(2);
+      await serve(view, 1);
+      expect(previews).toBe(3);
+      expect(listings()).toBe(3);
+    } finally { vi.useRealTimers(); }
+  });
+
+  it("rejects a late history listing and resumes it once", async () => {
+    const pending = deferred<unknown>();
+    listAnswer = () => pending.promise;
+    await renderShell();
+    await dock();
+    fireEvent.click(screen.getByRole("button", { name: PREVIEW_HISTORY_COPY }));
+    await settings();
+    await act(async () => pending.resolve(ok({ revisions: [{ ...NEWER, reason: "obsolete hidden revision" }] })));
+    expect(document.body.textContent).not.toContain("obsolete hidden revision");
+    listAnswer = () => ok({ revisions: [OLDER] });
+    await settings();
+    expect(listings()).toBe(2);
+    expect(document.body.textContent).not.toContain("obsolete hidden revision");
+    expect(rowLabels()).toHaveLength(1);
+  });
+});
+
+
+describe("Preview target scope while withdrawn (DW-422)", () => {
+  const dirty = () => {};
+  const select = () => {};
+  const pane = (slug: string, hidden: boolean) => <PreviewColumn id="scoped-preview" selection={{ kind: "page", slug }} knowledge={KNOWLEDGE_TWO} files={FILES} onOpenPage={select} onOpenFile={select} dataVersion={0} onDirtyChange={dirty} hidden={hidden} />;
+  it("delays a first hidden mount and drops an old row's deferred mutation outcome", async () => {
+    let previews = 0;
+    previewAnswer = () => { previews += 1; return ok(schemaPayload()); };
+    const view = render(pane("alpha", true));
+    await act(async () => {});
+    expect(previews).toBe(0);
+    view.rerender(pane("alpha", false));
+    await act(async () => {});
+    await expandHistory();
+    const pending = deferred<unknown>();
+    revertAnswer = () => pending.promise;
+    fireEvent.click(revertButtons()[0]);
+    fireEvent.click(screen.getByRole("button", { name: PREVIEW_HISTORY_REVERT_CONFIRM_LABEL }));
+    view.rerender(pane("alpha", true));
+    view.rerender(pane("beta", true));
+    const nudge = vi.fn();
+    const unsubscribe = subscribeDataVersionCheck(nudge);
+    try {
+      await act(async () => pending.resolve(ok({ ok: true, version: "new" })));
+      expect(previews).toBe(1);
+      view.rerender(pane("beta", false));
+      await act(async () => {});
+      expect(previews).toBe(2);
+      expect(listings()).toBe(1);
+      expect(nudge).not.toHaveBeenCalled();
+      expect(columnAnnounced()).toBe("");
+      expect(historyToggle()?.getAttribute("aria-expanded")).toBe("false");
+    } finally { unsubscribe(); }
+  });
+});
diff --git a/src/components/workbench/__tests__/settings-canvas-persistence.test.tsx b/src/components/workbench/__tests__/settings-canvas-persistence.test.tsx
index 57a1b65a..56406f2d 100644
--- a/src/components/workbench/__tests__/settings-canvas-persistence.test.tsx
+++ b/src/components/workbench/__tests__/settings-canvas-persistence.test.tsx
@@ -631,11 +631,13 @@ describe.each(OPENERS)(
       // !settingsOpen` and gated the MOUNT, so a Settings visit unmounted the
       // column and took the draft with it — no confirm, no announcement, no way
       // back. The dock rule alone decides the mount now.
-      await renderShell(TREE_DATA);
+      const view = await renderShell(TREE_DATA);
       const editor = await openPreviewEditorWith("# Alpha, half rewritten");
 
       await open();
       expect(settingsShowing()).toBe(true);
+      await refreshShell(view, { ...TREE_DATA, dataVersion: 1 });
+      await refreshShell(view, { ...TREE_DATA, dataVersion: 2 });
       // Withdrawn, not unmounted: out of the accessibility tree while the node
       // and its text are still in the document.
       expect(previewColumn()?.hasAttribute("hidden")).toBe(true);
diff --git a/src/components/workbench/__tests__/workbench-mode-url.test.tsx b/src/components/workbench/__tests__/workbench-mode-url.test.tsx
index 69b962fd..c494ec55 100644
--- a/src/components/workbench/__tests__/workbench-mode-url.test.tsx
+++ b/src/components/workbench/__tests__/workbench-mode-url.test.tsx
@@ -324,7 +324,8 @@ describe("Workbench mode ↔ URL", () => {
     expect(current()).toBe("Wiki");
     const rail = screen.getByRole("navigation", { name: "Modes" });
     const before = window.history.length;
-    const probes = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
+    const probeCalls = () => (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => String(url).endsWith("/health"));
+    const probes = probeCalls().length;
 
     fireEvent.click(railItem("Chat"));
 
@@ -335,7 +336,8 @@ describe("Workbench mode ↔ URL", () => {
     // segment is never re-rendered, so nothing above the mode panel unmounts.
     // Same rail node, and the sidecar probe did not run a second time.
     expect(screen.getByRole("navigation", { name: "Modes" })).toBe(rail);
-    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(probes);
+    // Chat initializes on first presentation, so its reads are expected here.
+    expect(probeCalls()).toHaveLength(probes);
     expect(announced()).toBe("Chat");
     // The URL is layered ON the storage restore, never a replacement for it: a
     // reload with no param at all must still land on Chat.
diff --git a/src/components/workbench/useChatConversations.ts b/src/components/workbench/useChatConversations.ts
index 7c9d597e..2c373acd 100644
--- a/src/components/workbench/useChatConversations.ts
+++ b/src/components/workbench/useChatConversations.ts
@@ -8,6 +8,7 @@ import {
   type Dispatch,
   type SetStateAction,
 } from "react";
+import { useSurfaceVisible } from "@/hooks/useSurfaceVisibility";
 import {
   CHAT_HISTORY_DEPTH_DEFAULT,
   CHAT_TOKEN_BUDGET_DEFAULT,
@@ -91,6 +92,8 @@ export function useChatConversations({
   readOnly,
   onError,
 }: UseChatConversationsOptions): ChatConversations {
+  const visible = useSurfaceVisible();
+  const initialized = useRef(false);
   const [conversations, setConversations] = useState<ConversationRow[]>([]);
   const [activeId, setActiveId] = useState<string | null>(null);
   const [messages, setMessages] = useState<CanvasMessage[]>([]);
@@ -103,6 +106,17 @@ export function useChatConversations({
   // switching conversations quickly leaves the surface showing the slower one.
   const loadSeq = useRef(0);
   const persistSeq = useRef(0);
+  // Passive snapshots must not undo an explicit list change. Invalidate at
+  // both edges so a refresh started during a write cannot outlive its result.
+  const listMutationSeq = useRef(0);
+  const mutateList = useCallback(async <T,>(write: () => Promise<T>): Promise<T> => {
+    listMutationSeq.current += 1;
+    try {
+      return await write();
+    } finally {
+      listMutationSeq.current += 1;
+    }
+  }, []);
   // SERIALIZED, not concurrent: two setting patches racing would let the loser's
   // answer be merged last and put the toolbar back to the value the owner just
   // left. The rejection is swallowed so one failed patch cannot break the next.
@@ -112,13 +126,8 @@ export function useChatConversations({
   const errorRef = useRef(onError);
   errorRef.current = onError;
 
-  const loadList = useCallback(async () => {
-    const rows = await listConversations();
-    setConversations(rows);
-    return rows;
-  }, []);
-
   const loadConversation = useCallback(async (id: string) => {
+    initialized.current = true;
     const seq = ++loadSeq.current;
     const conversation = await readConversation(id);
     if (seq !== loadSeq.current) return;
@@ -137,22 +146,37 @@ export function useChatConversations({
   }, []);
 
   useEffect(() => {
-    void loadList()
-      .then((rows) => {
-        const wanted =
-          typeof window !== "undefined"
-            ? new URLSearchParams(window.location.search).get("conversation")
-            : null;
-        const next = rows.find((row) => row.id === wanted) ?? rows[0];
-        if (next) {
-          setActiveId(next.id);
-          return loadConversation(next.id);
-        }
-      })
-      .catch((cause) => {
-        errorRef.current(cause instanceof Error ? cause.message : "Chat failed.");
-      });
-  }, [loadList, loadConversation]);
+    if (!visible) return;
+    let current = true;
+    const selectionSeq = loadSeq.current;
+    const mutationSeq = listMutationSeq.current;
+    void (async () => {
+      const rows = await listConversations();
+      if (!current || mutationSeq !== listMutationSeq.current) return;
+      setConversations(rows);
+      // A return reconciles the list only. Reloading the active conversation
+      // would overwrite a draft or a turn still streaming in the mounted pane.
+      if (initialized.current || selectionSeq !== loadSeq.current) return;
+      const wanted = new URLSearchParams(window.location.search).get("conversation");
+      const next = rows.find((row) => row.id === wanted) ?? rows[0];
+      if (!next) { initialized.current = true; return; }
+      const conversation = await readConversation(next.id);
+      if (!current || mutationSeq !== listMutationSeq.current || selectionSeq !== loadSeq.current) return;
+      initialized.current = true;
+      setActiveId(next.id);
+      if (!conversation) { errorRef.current("Conversation not found."); return; }
+      const settings = conversationSettings(conversation);
+      setMessages(conversation.messages ?? []);
+      setRetrievalMode(settings.retrievalMode);
+      setTokenBudget(settings.tokenBudget);
+      setHistoryDepth(settings.historyDepth);
+      setSelectedSkill(settings.selectedSkill);
+      setConversations((items) => mergeConversationRow(items, next.id, conversation));
+    })().catch((cause) => {
+      if (current && mutationSeq === listMutationSeq.current) errorRef.current(cause instanceof Error ? cause.message : "Chat failed.");
+    });
+    return () => { current = false; };
+  }, [visible]);
 
   /**
    * Open a new conversation and make it the active one.
@@ -163,23 +187,25 @@ export function useChatConversations({
    */
   const startConversation = useCallback(async (): Promise<ConversationRow | null> => {
     if (readOnly) return null;
+    initialized.current = true;
+    loadSeq.current += 1;
     // The three fields the door accepts, and no fourth: `selectedSkill` is not
     // among them, so it is not read here and not in the deps either.
-    const conversation = await createConversation({
+    const conversation = await mutateList(() => createConversation({
       retrievalMode,
       tokenBudget,
       historyDepth,
-    });
+    }));
     if (!conversation) return null;
-    setConversations((current) => [conversation, ...current]);
+    setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)]);
     setActiveId(conversation.id);
     return conversation;
-  }, [readOnly, retrievalMode, tokenBudget, historyDepth]);
+  }, [readOnly, retrievalMode, tokenBudget, historyDepth, mutateList]);
 
   const removeConversation = useCallback(
     async (id: string): Promise<RemoveConversationOutcome> => {
       if (readOnly) return { switched: false, fallbackId: null };
-      await deleteConversation(id);
+      await mutateList(() => deleteConversation(id));
       const next = conversations.filter((item) => item.id !== id);
       setConversations(next);
       if (activeId !== id) return { switched: false, fallbackId: null };
@@ -193,17 +219,17 @@ export function useChatConversations({
       }
       return { switched: true, fallbackId: fallback?.id ?? null };
     },
-    [readOnly, conversations, activeId, loadConversation],
+    [readOnly, conversations, activeId, loadConversation, mutateList],
   );
 
   const renameActive = useCallback(
     async (id: string, name: string) => {
       if (readOnly) return;
-      const conversation = await renameConversation(id, name);
+      const conversation = await mutateList(() => renameConversation(id, name));
       if (!conversation) return;
       setConversations((current) => mergeConversationRow(current, id, conversation));
     },
-    [readOnly],
+    [readOnly, mutateList],
   );
 
   const patchActive = useCallback(
@@ -212,7 +238,7 @@ export function useChatConversations({
       const id = activeId;
       patchChain.current = patchChain.current
         .then(async () => {
-          const conversation = await patchConversation(id, patch);
+          const conversation = await mutateList(() => patchConversation(id, patch));
           if (conversation) {
             setConversations((current) =>
               mergeConversationRow(current, id, conversation),
@@ -221,7 +247,7 @@ export function useChatConversations({
         })
         .catch(() => undefined);
     },
-    [activeId, readOnly],
+    [activeId, readOnly, mutateList],
   );
 
   const persistFrames = useCallback(
@@ -231,12 +257,12 @@ export function useChatConversations({
       options?: PersistOptions,
     ) => {
       const seq = ++persistSeq.current;
-      const conversation = await persistConversationMessages(id, frames, options);
+      const conversation = await mutateList(() => persistConversationMessages(id, frames, options));
       if (seq !== persistSeq.current) return;
       setMessages(conversation.messages ?? []);
       setConversations((current) => mergeConversationRow(current, id, conversation));
     },
-    [],
+    [mutateList],
   );
 
   const clearOptimistic = useCallback(() => {
diff --git a/src/hooks/useSurfaceVisibility.ts b/src/hooks/useSurfaceVisibility.ts
index 340e7af5..5b7293f1 100644
--- a/src/hooks/useSurfaceVisibility.ts
+++ b/src/hooks/useSurfaceVisibility.ts
@@ -1,6 +1,6 @@
 "use client";
 
-import { createContext, createElement, useContext, type ReactNode } from "react";
+import { createContext, createElement, useContext, useLayoutEffect, useRef, type ReactNode } from "react";
 
 /**
  * Whether the surface a subtree renders into is ON SCREEN.
@@ -42,10 +42,23 @@ export function SurfaceVisibilityProvider({
   visible: boolean;
   children: ReactNode;
 }) {
-  return createElement(SurfaceVisibilityContext.Provider, { value: visible }, children);
+  const ancestorVisible = useContext(SurfaceVisibilityContext);
+  return createElement(SurfaceVisibilityContext.Provider, { value: ancestorVisible && visible }, children);
 }
 
 /** `true` unless an enclosing surface says it is currently off screen. */
-export function useSurfaceVisible(): boolean {
-  return useContext(SurfaceVisibilityContext);
+export function useSurfaceVisible(active = true): boolean {
+  return useContext(SurfaceVisibilityContext) && active;
+}
+
+/** Keep the last visible presentation while owner operations settle off screen.
+ * This retains the mounted subtree; it neither cancels nor replays its work.
+ */
+export function SurfacePresentation({ children, active = true }: { children: ReactNode; active?: boolean }) {
+  const visible = useSurfaceVisible(active);
+  const presented = useRef(children);
+  useLayoutEffect(() => {
+    if (visible) presented.current = children;
+  }, [visible, children]);
+  return visible ? children : presented.current;
 }
diff --git a/src/lib/__tests__/workbench-data-version.test.ts b/src/lib/__tests__/workbench-data-version.test.ts
index aa7d8905..d74d1c20 100644
--- a/src/lib/__tests__/workbench-data-version.test.ts
+++ b/src/lib/__tests__/workbench-data-version.test.ts
@@ -951,6 +951,15 @@ describe("dataVersionRefreshPlan", () => {
 });
 
 describe("previewFetchPlan", () => {
+  it("defers even a new target before recording or resetting it when hidden", () => {
+    const shown = { kind: "page" as const, slug: "alpha" };
+    const next = { kind: "page" as const, slug: "beta" };
+    for (const editing of [false, true]) {
+      expect(previewFetchPlan({ shown, next, editing, visible: false })).toEqual({ fetch: false, reset: false, shown });
+      expect(previewFetchPlan({ shown: null, next, editing, visible: false })).toEqual({ fetch: false, reset: false, shown: null });
+    }
+  });
+
   const ALPHA: TreeSelection = { kind: "page", slug: "alpha" };
   const BETA: TreeSelection = { kind: "page", slug: "beta" };
   const FILE: TreeSelection = { kind: "file", path: "wiki/alpha.md" };
@@ -1475,7 +1484,7 @@ describe("the Preview column re-reads its bytes without disturbing an editor", (
     // component used to hold by hand — compare, then record — is now inside
     // `previewFetchPlan`, where the suite executes it.
     expect(source).toMatch(
-      /previewFetchPlan\(\{\s*shown:\s*shownSelectionRef\.current,\s*next:\s*selection,\s*editing,\s*\}\)/,
+      /previewFetchPlan\(\{\s*shown:\s*shownSelectionRef\.current,\s*next:\s*selection,\s*editing,\s*visible,\s*\}\)/,
     );
     expect(source).toContain("shownSelectionRef.current = plan.shown;");
     // …and the component records nothing of its own, so there is no assignment
@@ -1487,7 +1496,7 @@ describe("the Preview column re-reads its bytes without disturbing an editor", (
     // imperative re-read for the reason the plan exists at all: a second
     // request path would carry its own reset semantics, and a retry pressed
     // while the editor is open would then take the owner's draft.
-    expect(source).toMatch(/\}, \[selection, dataVersion, editing, retryNonce\]\)/);
+    expect(source).toMatch(/\}, \[selection, selectionKey, dataVersion, editing, retryNonce, visible\]\)/);
     // The reset block — the one that abandons an open editor — is now BEHIND the
     // plan, and still inside the effect.
     const effect = source.slice(
diff --git a/src/lib/__tests__/workbench-left-column.test.ts b/src/lib/__tests__/workbench-left-column.test.ts
index 1d788320..48ee5393 100644
--- a/src/lib/__tests__/workbench-left-column.test.ts
+++ b/src/lib/__tests__/workbench-left-column.test.ts
@@ -863,7 +863,7 @@ describe("PreviewColumn is view-first over a rendered body", () => {
     // DW-54 adds a fourth dependency: the `Retry` control bumps a nonce rather
     // than calling a reader of its own, so a retry goes through the SAME plan
     // as every other read — including the rule that an open editor defers it.
-    expect(source).toMatch(/\}, \[selection, dataVersion, editing, retryNonce\]\)/);
+    expect(source).toMatch(/\}, \[selection, selectionKey, dataVersion, editing, retryNonce, visible\]\)/);
     // No second copy of the decision: the component must not re-derive it.
     expect(source).not.toContain("response.ok");
   });
@@ -1116,7 +1116,10 @@ describe("the two scroll restores beat the paint", () => {
     // TWO layout effects, and the ORDER is load-bearing: the row reset is
     // declared first so a commit that changes both the pick and `hidden` clears
     // the offsets before the restore could assign the previous row's.
-    expect(code.match(/useLayoutEffect\(/g) ?? []).toHaveLength(2);
+    // Lifecycle invalidation also uses layout effects; count only the scroll
+    // reset/restore region, whose ordering this assertion protects.
+    const scrollEffects = code.slice(code.indexOf("useLayoutEffect(() => {"), code.indexOf("}, [hidden]);") + "}, [hidden]);".length);
+    expect(scrollEffects.match(/useLayoutEffect\(/g) ?? []).toHaveLength(2);
     expect(code.indexOf("}, [selectionKey]);")).toBeLessThan(
       code.indexOf("}, [hidden]);"),
     );
diff --git a/src/lib/workbench-data-version.ts b/src/lib/workbench-data-version.ts
index dfbcfe4b..1805bbdd 100644
--- a/src/lib/workbench-data-version.ts
+++ b/src/lib/workbench-data-version.ts
@@ -363,7 +363,9 @@ export function previewFetchPlan(input: {
   shown: TreeSelection | null;
   next: TreeSelection;
   editing: boolean;
+  visible?: boolean;
 }): PreviewFetchPlan {
+  if (input.visible === false) return { fetch: false, reset: false, shown: input.shown };
   if (!isSameSelection(input.shown, input.next)) {
     return { fetch: true, reset: true, shown: input.next };
   }
diff --git a/_bmad-output/implementation-artifacts/spec-dw-422-hidden-pane-lifecycle.md b/_bmad-output/implementation-artifacts/spec-dw-422-hidden-pane-lifecycle.md
new file mode 100644
index 00000000..d06b46fa
--- /dev/null
+++ b/_bmad-output/implementation-artifacts/spec-dw-422-hidden-pane-lifecycle.md
@@ -0,0 +1,130 @@
+---
+title: 'DW-422: Pause hidden pane activity and reconcile on return'
+type: 'bugfix'
+created: '2026-09-10'
+status: 'in-review'
+baseline_commit: '239f43dda395f5ba318812b177b413fcd330558a'
+review_loop_iteration: 0
+baseline_revision: '239f43dda395f5ba318812b177b413fcd330558a'
+context: []
+---
+
+<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">
+
+## Intent
+
+**Problem:** Hidden Preview keeps fetching and announcing. Mode panes admit late passive responses, and Chat initialization reads start off screen.
+
+**Approach:** Apply the approved visibility gate to passive reads, version checks and announcements; reconcile on return while preserving owner work.
+
+## Boundaries & Constraints
+
+**Always:** Honor ancestor visibility. Preserve drafts, selection, scroll, dialogs and save/revert/Chat operations. Scope outcomes to their original target. Retain permissions, errors, repeat announcements and editor deferral. Coalesce hidden changes into one read per passive resource on return; later independent commits may refresh normally.
+
+**Ask First:** Changes to server contracts, persistence, mutation semantics or which user operations continue during withdrawal.
+
+**Never:** Unmount to pause; replay Search, semantic Lint, generation or mutations on return; change the global dataVersion bus; restyle panes; include DW-538/760; modify frozen identifiers, protected configuration, existing intent contracts or the orchestrator-owned ledger. Publishing, merging and deployment are outside this packet.
+
+## I/O & Edge-Case Matrix
+
+| Scenario | Input / State | Expected Output / Behavior | Error Handling |
+|---|---|---|---|
+| Hidden changes | Several version bumps during Settings | No passive reads, nudges or live-region writes; one current refresh on return | Preserve last-good data |
+| Late read | Read started before withdrawal settles while hidden | Ignore obsolete settlement, including cancellation-ignoring transports | No hidden error or stale overwrite |
+| Editing | Dirty draft across hide/show and bumps | Same draft/editor; refresh after edit ends | Preserve conflict handling |
+| Mutation settles | Save/revert finishes while hidden | Settle bookkeeping; defer history read, nudge and announcement | Preserve failure/retry outcome |
+| Target changes | Pending outcome belongs to previous row/wiki | Do not announce/apply it to new target | Current target loads normally |
+| First hidden mount | Preview or mode has never shown | Delay passive initialization until visible | Normal first-load error handling |
+| Explicit work | Chat stream, Search or Lint underway | Preserve operation; do not restart on return | Retain result for visible presentation |
+
+</frozen-after-approval>
+
+## Code Map
+
+- `src/hooks/useSurfaceVisibility.ts`: provider and default-visible consumer; compose ancestor visibility.
+- `src/components/workbench/PreviewColumn.tsx`: `PreviewPane` fetch effect (~595), save/revert nudges, history reads and announcements.
+- `src/lib/workbench-data-version.ts`: `previewFetchPlan` preserves shown selection and edit deferral; shared watcher bus stays unchanged.
+- `src/components/workbench/ModeCanvas.tsx`: mounted panes and `active` inputs. `Workbench.tsx` supplies hidden props.
+- Mode readers: `TodosCanvas.tsx`, `GraphCanvas.tsx`, `ReviewCanvas.tsx`, `ResearchCanvas.tsx`, `SkillsCanvas.tsx` in the same directory. Existing active gates need late-result protection.
+- `ChatCanvas.tsx` and `useChatConversations.ts` there: separate passive resumption from conversation selection. `SearchCanvas.tsx`/`LintCanvas.tsx` own explicit operations.
+
+## Tasks & Acceptance
+
+**Execution:**
+- [x] `src/hooks/useSurfaceVisibility.ts`, `src/components/workbench/ModeCanvas.tsx` — publish consistent effective visibility for each pane, preserving standalone default-visible behavior.
+- [x] `src/lib/workbench-data-version.ts`, `src/components/workbench/PreviewColumn.tsx` — gate reads before reset, invalidate late reads, coalesce deferred history reads/nudges/announcements without duplicate resumption.
+- [x] `src/components/workbench/{TodosCanvas,GraphCanvas,ReviewCanvas,ResearchCanvas,SkillsCanvas}.tsx` — retain active/polling gates and reject obsolete passive settlements.
+- [x] `src/components/workbench/{ChatCanvas,SearchCanvas,LintCanvas}.tsx`, `src/components/workbench/useChatConversations.ts` — separate passive initialization/resumption from explicit operation lifetime; defer hidden presentation without resetting sessions or replaying work.
+- [x] `src/components/workbench/__tests__/{preview-announcements,settings-canvas-persistence,preview-revision-history,preview-dirty-guard}.test.tsx` — execute Preview matrix through real Workbench and controlled responses.
+- [x] `src/components/workbench/__tests__/mode-canvas-withdrawn.test.tsx` — test mode withdrawal, polling, late reads and Chat preservation. Add provider cases to `src/hooks/__tests__/useSurfaceVisibility.test.tsx` and plan cases to `src/lib/__tests__/workbench-data-version.test.ts`.
+
+**Acceptance Criteria:**
+- Given Workbench navigation, when Settings hides a pane across version changes, then reads/announcements pause and current data reconciles once on return.
+- Given pending work, when visibility changes repeatedly, then stale reads cannot replace current data and explicit operations survive without replay.
+- Given standalone components, when no provider exists, then default-visible behavior remains intact.
+
+## Spec Change Log
+
+## Design Notes
+
+Older DW-422 specs bundle other work and remain historical context. Passive read cancellation is allowed; mutation/stream cancellation is not. Mounted tests prove live-region text; VoiceOver/NVDA speech remains manual.
+
+## Verification
+
+- Run focused node plan/provider and mounted Preview/mode suites, including a real Workbench composition case and cancellation-ignoring responses.
+- Run `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm test`, `pnpm build` and `git diff --check`; record actual results and existing skips.
+- Perform the documented live-region VoiceOver/NVDA check where available; explicitly retain any unexecuted platform limitation.
+
+
+## Implementation Evidence — 2026-09-10
+
+Implemented in the isolated checkout based on `239f43dda395f5ba318812b177b413fcd330558a`; not committed, published, merged or deployed. Frozen intent, protected configuration, frozen identifiers and deferred-work ledger were not edited.
+
+- Visibility providers compose ancestor visibility. Every mounted mode publishes effective visibility. `SurfacePresentation` retains the last visible subtree while owner operations settle, preserving mounted nodes and deferring hidden live-region DOM updates.
+- Preview gates before selection resets, rejects obsolete body/history responses, preserves dirty editing, and scopes mutation outcomes to their originating selection. Deferred mutation version checks use the mutation-start version. A local return barrier releases one Preview/history reconciliation when that served version advances; an already-served hidden advance needs no extra check. Preview's existing local `REQUEST_TIMEOUT_MS` (15 seconds) bounds waiting if no watcher answer arrives. The global bus is unchanged.
+- Mode passive readers preserve their active/polling gates and reject obsolete settlements. Chat initializes when visible and reconciles only its conversation list on return; active conversation, composer, stream and explicit operations remain alive. Search and Lint present retained results on return without replay and reject outcomes from a superseded wiki.
+
+### Executed matrix
+
+| Matrix row | Mounted or pure evidence |
+| --- | --- |
+| Hidden version changes and cancellation-ignoring body response | `preview-announcements.test.tsx`: real Workbench Settings visit, multiple hidden bumps, ignored late body, one return read, later independent commit |
+| Dirty editor | `settings-canvas-persistence.test.tsx`: same editor node/draft across hidden bumps; `preview-dirty-guard.test.tsx`: zero additional reads through return until the owner leaves the editor, then one current read |
+| Hidden save/revert outcomes | `preview-revision-history.test.tsx` hidden mutation group: save success/refusal and retryable draft; revert success/unknown outcome; no hidden nudge/history/live-region changes; version-answer coalescing; already-served hidden version; later independent commit; preserved restore announcement even when the return read is unreachable |
+| Late history / target switch / first hidden mount | `preview-revision-history.test.tsx`: ignored cancellation-ignoring listing, one return listing; same mounted Preview delays first initialization and drops a previous row's revert after a hidden target change |
+| Passive mode readers and polling | `mode-canvas-withdrawn.test.tsx`: Todos/Graph/Review/Research late reads, Skills abort-ignoring JSON response, Research polling withdrawal and return |
+| Explicit work | `mode-canvas-withdrawn.test.tsx`: retained Search and semantic Lint results with one request; Chat composer/session preservation. `chat-live-stream.test.tsx`: real ModeCanvas withdraws an active stream, leaves its signal live, persists its result while hidden, presents it on return without retrieval replay or active-conversation reload |
+| Provider and pure plan contracts | `useSurfaceVisibility.test.tsx`: default visible, ancestor composition, same live-region DOM. `workbench-data-version.test.ts`: hidden plan preserves shown selection before reset |
+
+### Verification results and limits
+
+- Latest changed Preview suites: **119/119 passed** (`/private/tmp/dw422-preview-final.log`). Other focused mode/provider/plan and compatibility suites passed, including **95/95** for updated source wiring and mode URL/remount assertions (`/private/tmp/dw422-contract-final.log`).
+- Full `pnpm test` with approved runtime permissions: **416 files passed; 10,194 passed, 1 skipped**, 128.29 seconds (`/private/tmp/dw422-full-test-network.log`). The skip is the existing live Tavily check without `TAVILY_API_KEY` in `research-runtime.test.ts`. The final unreachable-return announcement correction and one added case landed while this broad run was underway; the 119-test Preview rerun above verifies that correction. A final exact-code broad rerun belongs to workflow review/finalization.
+- `pnpm exec tsc --noEmit`: passed on the final implementation (`/private/tmp/dw422-tsc-terminal.log`). Run sequentially after build because Next regenerates `.next/types` during its build.
+- `pnpm lint`: passed with no new warnings or errors (`/private/tmp/dw422-lint-terminal.log`); existing `jsx-ast-utils` TSNonNullExpression diagnostics remain.
+- `pnpm build`: passed with approved network access (`/private/tmp/dw422-build-final.log`), before the final small unreachable-return announcement correction. Sandbox-only build failed DNS lookup of configured Google fonts; the sandbox-only full test run was stopped after real subprocess/loopback/workerd failures, then rerun with required permissions. No tests were weakened to accommodate those restrictions.
+- `git diff --check`: passed.
+- VoiceOver/NVDA speech procedure remains **unexecuted**; mounted tests verify live-region DOM strings, not assistive-technology speech. No browser layout or production/deployment claim is made.
+- Dependencies are temporarily linked to the existing root `node_modules` for verification; the untracked link is not source and must not be staged. The local version-barrier timeout expiry is covered by the focused review regression recorded below.
+
+
+### Focused review corrections — 2026-09-10
+
+- Fixed the substantiated Chat list race: passive list initialization/resumption captures a mutation generation and rejects obsolete success/error/detail settlements before writing state. Explicit create, rename, delete, settings and frame writes invalidate the generation at both start and settlement, so a snapshot cannot undo their newer row state. A created row is deduplicated against any snapshot that already included it.
+- Added mounted `chat-conversation-crud.test.tsx` cases for a return list refresh racing create, rename and delete; all preserve the explicit outcome after the stale snapshot settles.
+- Added real Workbench `preview-revision-history.test.tsx` coverage for the existing **15-second** local version barrier: no early reads, one Preview/history reconciliation on expiry, no timer replay, and normal refresh on a later version change.
+- Did not apply the proposed pending-revision-collapse patch. The requested owner sequence is not reachable in the current UI: `viewingThis = viewLoading && viewing`, and the current View/Hide control has `disabled={viewingThis}`. A real mounted click while pending is suppressed. No control was enabled or changed to manufacture reachability; the speculative cleanup-only patch and its invalid regression were removed.
+- Focused affected suites passed **73/73** across Chat CRUD, live Chat streaming, withdrawn modes and Preview revision history (`/private/tmp/dw422-review-fixes-focused.log`). TypeScript and lint also passed (`/private/tmp/dw422-review-fixes-tsc.log`, `/private/tmp/dw422-review-fixes-lint.log`); lint retains only the existing tool diagnostics. `git diff --check` passed.
+- Workflow remains `in-review`. Required edge/verification review launchers hit the agent thread limit; those review packets and final exact-code broad verification remain outstanding. No commit or push was performed.
+
+
+### Terminal local verification and review handoff — 2026-09-10
+
+All checks below ran sequentially after the Chat review fix and timer regression, with no concurrent source edits:
+
+- `pnpm test`: **416 files passed; 10,199 tests passed, 1 existing credential-dependent skip**, 125.52 seconds (`/private/tmp/dw422-terminal-test.log`).
+- `pnpm build`, `pnpm exec tsc --noEmit`, `pnpm lint`, `git diff --check`: all exited zero (`/private/tmp/dw422-terminal-{build,tsc,lint,diff}.log`). Existing lint-tool diagnostics remain; no new warnings/errors.
+- Approved intent checksum matches the approved draft; orchestrator-owned ledger is unchanged. Temporary dependency symlink removed after verification.
+- Blind review completed: the Chat snapshot race was classified medium/patch and fixed with executed regressions; the pending-revision-collapse claim was rejected as unreachable through the existing disabled control.
+- Edge-case and verification-gap reviewers could not launch: both returned `agent thread limit reached`. Per rendered bmad-build step 04, complete standalone prompts containing the final diff are saved beside this spec as `review-dw-422-edge-case-hunter.md` and `review-dw-422-verification-gap.md`. Run each in a separate fresh session and return the findings before workflow finalization.
+- Status intentionally remains `in-review`; nothing is committed, published, merged or deployed. VoiceOver/NVDA speech remains unexecuted. Earlier statements that exact-code broad verification was outstanding are superseded by this terminal record; the two independent reviews remain outstanding.
diff --git a/src/components/workbench/__tests__/mode-canvas-withdrawn.test.tsx b/src/components/workbench/__tests__/mode-canvas-withdrawn.test.tsx
new file mode 100644
index 00000000..6e75493e
--- /dev/null
+++ b/src/components/workbench/__tests__/mode-canvas-withdrawn.test.tsx
@@ -0,0 +1,148 @@
+import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
+import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
+import { ModeCanvas } from "../ModeCanvas";
+import { SurfaceVisibilityProvider } from "@/hooks/useSurfaceVisibility";
+import { RESEARCH_POLL_MS } from "@/lib/research-panel";
+import { clearLoopbackDoorToken } from "@/lib/loopback-client";
+import type { WorkbenchModeId } from "@/lib/workbench-modes";
+
+const { send } = vi.hoisted(() => ({ send: vi.fn() }));
+vi.mock("@/lib/workbench-request", async (original) => ({ ...await original<object>(), send }));
+const CONVERSATION = { id: "c1", name: "First conversation", messages: [], retrievalMode: "wiki", tokenBudget: 32000, historyDepth: 10 };
+function tree(mode: WorkbenchModeId, hidden = false, version = 0, ancestor = true) {
+  return <SurfaceVisibilityProvider visible={ancestor}><ModeCanvas mode={mode} sidecar="up" headingId="mode-heading" hidden={hidden} wikiId="wiki-1" dataVersion={version}><p>Wiki remains mounted</p></ModeCanvas></SurfaceVisibilityProvider>;
+}
+const flush = () => act(async () => {});
+function deferred<T>() {
+  let resolve!: (value: T) => void;
+  let reject!: (error: Error) => void;
+  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
+  return { promise, resolve, reject };
+}
+function defaults(url: string) {
+  if (url === "/api/chat/conversations") return { conversations: [CONVERSATION] };
+  if (url === "/api/chat/conversations/c1") return { conversation: CONVERSATION };
+  if (url === "/api/v1/loopback-settings") return { token: "door" };
+  return { items: [], projects: [], nodes: [], edges: [] };
+}
+beforeEach(() => {
+  window.localStorage.clear();
+  window.history.replaceState(null, "", "/");
+  clearLoopbackDoorToken();
+  send.mockReset().mockImplementation(async (url: string) => defaults(url));
+  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ skills: [] }), { status: 200 })));
+});
+afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
+
+describe("mounted mode withdrawal (DW-422)", () => {
+  it("does no passive initialization behind a hidden ancestor", async () => {
+    const view = render(tree("chat", false, 0, false));
+    await flush();
+    expect(send).not.toHaveBeenCalled();
+    expect(fetch).not.toHaveBeenCalled();
+    view.rerender(tree("chat"));
+    await flush();
+    expect(send.mock.calls.filter(([url]) => url === "/api/chat/conversations")).toHaveLength(1);
+    expect(send.mock.calls.filter(([url]) => url === "/api/chat/conversations/c1")).toHaveLength(1);
+  });
+
+  it.each([
+    ["todos", "/api/todos?tab=candidates"],
+    ["graph", "/api/graph/workbench"],
+    ["review", "/api/review-queue?wikiId=wiki-1"],
+    ["research", "/api/research?wikiId=wiki-1"],
+  ] as const)("rejects a late %s read and reads once on return", async (mode, path) => {
+    const old = deferred<unknown>();
+    send.mockImplementation((url: string) => url === path ? old.promise : Promise.resolve(defaults(url)));
+    const view = render(tree(mode));
+    await flush();
+    expect(send.mock.calls.filter(([url]) => url === path)).toHaveLength(1);
+    view.rerender(tree(mode, true, 1));
+    view.rerender(tree(mode, true, 2));
+    await act(async () => old.reject(new Error("obsolete passive failure")));
+    expect(document.body.textContent).not.toContain("obsolete passive failure");
+    send.mockImplementation(async (url: string) => defaults(url));
+    view.rerender(tree(mode, false, 2));
+    await flush();
+    expect(send.mock.calls.filter(([url]) => url === path)).toHaveLength(2);
+    expect(document.body.textContent).not.toContain("obsolete passive failure");
+  });
+
+  it("rejects a Skills response whose body ignores abort", async () => {
+    const old = deferred<unknown>();
+    vi.mocked(fetch).mockImplementationOnce(async () => ({ ok: true, json: () => old.promise }) as Response);
+    const view = render(tree("skills"));
+    await flush();
+    view.rerender(tree("skills", true));
+    await act(async () => old.resolve({ skills: [{ id: "stale", name: "Stale Skill", enabled: true }] }));
+    expect(document.body.textContent).not.toContain("Stale Skill");
+    view.rerender(tree("skills"));
+    await flush();
+    expect(fetch).toHaveBeenCalledTimes(2);
+  });
+
+  it("stops Research polling while hidden and resumes one current read", async () => {
+    vi.useFakeTimers();
+    const path = "/api/research?wikiId=wiki-1";
+    send.mockImplementation(async (url: string) => {
+      if (url === path) throw new Error("Temporarily unavailable");
+      return defaults(url);
+    });
+    const view = render(tree("research"));
+    await flush();
+    await act(async () => vi.advanceTimersByTimeAsync(RESEARCH_POLL_MS));
+    expect(send.mock.calls.filter(([url]) => url === path)).toHaveLength(2);
+    view.rerender(tree("research", true));
+    await act(async () => vi.advanceTimersByTimeAsync(RESEARCH_POLL_MS * 3));
+    expect(send.mock.calls.filter(([url]) => url === path)).toHaveLength(2);
+    view.rerender(tree("research"));
+    await flush();
+    expect(send.mock.calls.filter(([url]) => url === path)).toHaveLength(3);
+  });
+
+  it("refreshes Chat's list without reloading its active conversation or composer", async () => {
+    const view = render(tree("chat"));
+    await flush();
+    const composer = document.querySelector(".wb-chat-composer textarea") ?? document.querySelector("textarea");
+    expect(composer).toBeTruthy();
+    fireEvent.change(composer!, { target: { value: "Keep this draft" } });
+    view.rerender(tree("chat", true));
+    await flush();
+    view.rerender(tree("chat"));
+    await flush();
+    expect(document.querySelector("textarea")).toBe(composer);
+    expect((composer as HTMLTextAreaElement).value).toBe("Keep this draft");
+    expect(send.mock.calls.filter(([url]) => url === "/api/chat/conversations/c1")).toHaveLength(1);
+    expect(send.mock.calls.filter(([url]) => url === "/api/chat/conversations")).toHaveLength(2);
+  });
+
+  it("retains an explicit Search result for return without replaying the request", async () => {
+    const result = deferred<unknown>();
+    send.mockImplementation((url: string) => url.endsWith("/search") ? result.promise : Promise.resolve(defaults(url)));
+    const view = render(tree("search"));
+    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "alpha" } });
+    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" });
+    view.rerender(tree("search", true));
+    await act(async () => result.resolve({ hits: [{ title: "Retained answer", path: "wiki/alpha.md", snippet: "Search result", score: 1 }] }));
+    expect(document.body.textContent).not.toContain("Retained answer");
+    view.rerender(tree("search"));
+    expect(screen.getByText("Retained answer")).toBeTruthy();
+    expect(send.mock.calls.filter(([url]) => url.endsWith("/search"))).toHaveLength(1);
+  });
+
+  it("retains an explicit semantic Lint result without running it on return", async () => {
+    const result = deferred<unknown>();
+    send.mockImplementation((url: string) => url === "/api/lint/workbench" ? result.promise : Promise.resolve(defaults(url)));
+    const view = render(tree("lint"));
+    fireEvent.click(screen.getByRole("checkbox", { name: "Semantic" }));
+    fireEvent.click(screen.getByRole("button", { name: "Run lint" }));
+    view.rerender(tree("lint", true));
+    await act(async () => result.resolve({ issues: [{ type: "test", slug: "alpha", message: "Retained lint result" }] }));
+    expect(document.body.textContent).not.toContain("Retained lint result");
+    view.rerender(tree("lint"));
+    expect(screen.getByText("Retained lint result")).toBeTruthy();
+    const calls = send.mock.calls.filter(([url]) => url === "/api/lint/workbench");
+    expect(calls).toHaveLength(1);
+    expect(JSON.parse(calls[0][1].body).semantic).toBe(true);
+  });
+});
diff --git a/src/hooks/__tests__/useSurfaceVisibility.test.tsx b/src/hooks/__tests__/useSurfaceVisibility.test.tsx
new file mode 100644
index 00000000..59f5d4c9
--- /dev/null
+++ b/src/hooks/__tests__/useSurfaceVisibility.test.tsx
@@ -0,0 +1,30 @@
+import { afterEach, describe, expect, it } from "vitest";
+import { cleanup, render, screen } from "@testing-library/react";
+import { SurfacePresentation, SurfaceVisibilityProvider, useSurfaceVisible } from "../useSurfaceVisibility";
+
+afterEach(cleanup);
+function Probe() { return <output>{String(useSurfaceVisible())}</output>; }
+describe("effective surface visibility", () => {
+  it("defaults to visible without a provider", () => {
+    render(<Probe />);
+    expect(screen.getByRole("status").textContent).toBe("true");
+  });
+  it("does not let a visible descendant override a hidden ancestor", () => {
+    const tree = (visible: boolean) => <SurfaceVisibilityProvider visible={visible}><SurfaceVisibilityProvider visible><Probe /></SurfaceVisibilityProvider></SurfaceVisibilityProvider>;
+    const view = render(tree(false));
+    expect(screen.getByRole("status").textContent).toBe("false");
+    view.rerender(tree(true));
+    expect(screen.getByRole("status").textContent).toBe("true");
+  });
+  it("keeps the same live-region DOM while hidden and presents the latest result on return", () => {
+    const tree = (visible: boolean, text: string) => <SurfaceVisibilityProvider visible={visible}><SurfacePresentation><p role="status">{text}</p></SurfacePresentation></SurfaceVisibilityProvider>;
+    const view = render(tree(true, "before"));
+    const region = screen.getByRole("status");
+    view.rerender(tree(false, "intermediate"));
+    view.rerender(tree(false, "latest"));
+    expect(region.textContent).toBe("before");
+    view.rerender(tree(true, "latest"));
+    expect(screen.getByRole("status")).toBe(region);
+    expect(region.textContent).toBe("latest");
+  });
+});


Do not invoke any skill. If the instruction file is unreadable, report that exact failure and stop. Return only the review result.

Applicable repository policy overrides minimum-finding instructions: never pad findings to a quota; zero findings is a valid review.
