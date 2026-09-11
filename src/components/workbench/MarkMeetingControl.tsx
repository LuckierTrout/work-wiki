"use client";

import { useEffect, useId, useRef, useState } from "react";
import { SurfacePresentation, useSurfaceVisible } from "@/hooks/useSurfaceVisibility";
import { workbenchSourcePath } from "@/lib/source-delete";
import { send, writeFailure } from "@/lib/workbench-request";
import { TODOS_NON_MEETING_COPY } from "@/lib/workbench-modes";

/**
 * Why Mark as meeting refuses on a read-only deployment (DW-733).
 *
 * The CLIENT mirror of `READ_ONLY_REFUSAL.sourceMeeting`, character-identical
 * to it and pinned by `read-only-copy-parity.test.ts`. Exported because it is
 * the sentence the refused button POINTS AT through `aria-describedby`.
 *
 * It cannot be imported from `@/lib/read-only`: that module is server-only —
 * it reads `YOPEDIA_READONLY` off `process.env` — and this is a `"use client"`
 * component, so the constant is mirrored here the way every other client half
 * of a refusal already is (Graph, Review, Todos).
 *
 * ONE control, ONE door. This surface's only write control meets
 * `POST /api/sources/meeting`, which answers exactly this sentence, and it is
 * NOT the Todos sentence — marking a Source as a meeting changes a SOURCE, not
 * a todo. The two are worth telling apart because both are reachable from the
 * same workbench shell, not because they share a canvas: this control is
 * rendered by `SourcesTree` and `PreviewColumn` alone, never by `TodosCanvas`.
 *
 * Until now the control folded `readOnly` into bare `disabled`, so the refusal
 * left the tab order with no sentence to announce and no client half held to
 * the 403.
 *
 * Copy says work-wiki; the runtime identifier stays `YOPEDIA_READONLY`.
 */
export const SOURCE_MEETING_READ_ONLY_COPY =
  "Sources cannot be marked as meetings while this deployment is read-only.";

export interface MarkMeetingControlProps {
  path: string;
  readOnly?: boolean;
}

interface MeetingResponse {
  path: string;
  meeting: boolean;
}

export function MarkMeetingControl({ path, readOnly = false }: MarkMeetingControlProps) {
  const visible = useSurfaceVisible();
  const canonical = workbenchSourcePath(path);
  const canonicalRef = useRef(canonical);
  canonicalRef.current = canonical;
  const mutationSeq = useRef(0);
  const [meeting, setMeeting] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Above the `!canonical` early return: a hook cannot be conditional.
  const noteId = useId();

  useEffect(() => {
    setMeeting(null);
    setError(null);
    setReadError(null);
  }, [canonical]);

  useEffect(() => {
    if (!canonical || !visible) return;
    let cancelled = false;
    const seq = mutationSeq.current;
    setReadError(null);
    send<MeetingResponse>(
      `/api/sources/meeting?path=${encodeURIComponent(canonical)}`,
      { method: "GET" },
    )
      .then((body) => {
        if (!cancelled && seq === mutationSeq.current) setMeeting(body.meeting);
      })
      .catch(() => {
        if (!cancelled && seq === mutationSeq.current) {
          setMeeting(null);
          setReadError("Couldn’t load whether this Source is a meeting.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [canonical, visible]);

  if (!canonical) return null;

  async function mark() {
    if (readOnly || busy || !canonical) return;
    mutationSeq.current += 1;
    setBusy(true);
    setError(null);
    setReadError(null);
    try {
      const body = await send<MeetingResponse>("/api/sources/meeting", {
        method: "POST",
        body: JSON.stringify({ path: canonical, meeting: true }),
      });
      if (canonicalRef.current === canonical) setMeeting(body.meeting);
    } catch (cause) {
      if (canonicalRef.current === canonical) setError(writeFailure(cause, "mark this Source as a meeting").message);
    } finally {
      mutationSeq.current += 1;
      setBusy(false);
    }
  }

  return (
    <SurfacePresentation>
    <div className="wb-mark-meeting">
      {meeting === false && <p className="wb-mark-meeting-copy">{TODOS_NON_MEETING_COPY}</p>}
      {meeting === false && (
        // `disabled` is the TRANSIENT state only (DW-531's shape). `busy` lasts
        // one in-flight request and describes nothing; `readOnly` is a standing
        // refusal, so it stays focusable and announces its reason instead of
        // vanishing from the tab order. `mark()` keeps its own early return —
        // `aria-disabled` is an announcement, not a gate, and Enter still
        // reaches the handler.
        <button
          type="button"
          className="wb-mark-meeting-btn"
          disabled={!readOnly && busy}
          aria-disabled={readOnly || undefined}
          aria-describedby={readOnly ? noteId : undefined}
          onClick={() => void mark()}
        >
          Mark as meeting
        </button>
      )}
      {/* Rendered on the same `meeting === false` condition as the button it
          describes: this control has exactly one refusable thing on it, and with
          the button absent (a Source already marked, or still loading) there is
          nothing for the sentence to be about. */}
      {readOnly && meeting === false && (
        <p id={noteId} className="wb-mark-meeting-note">
          {SOURCE_MEETING_READ_ONLY_COPY}
        </p>
      )}
      {(error || readError) && <p className="wb-mark-meeting-error">{error || readError}</p>}
    </div>
    </SurfacePresentation>
  );
}
