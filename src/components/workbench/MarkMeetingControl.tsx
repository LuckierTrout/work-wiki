"use client";

import { useEffect, useState } from "react";
import { workbenchSourcePath } from "@/lib/source-delete";
import { send, writeFailure } from "@/lib/workbench-request";
import { TODOS_NON_MEETING_COPY } from "@/lib/workbench-modes";

export interface MarkMeetingControlProps {
  path: string;
  readOnly?: boolean;
}

interface MeetingResponse {
  path: string;
  meeting: boolean;
}

export function MarkMeetingControl({ path, readOnly = false }: MarkMeetingControlProps) {
  const canonical = workbenchSourcePath(path);
  const [meeting, setMeeting] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!canonical) return;
    let cancelled = false;
    setError(null);
    send<MeetingResponse>(
      `/api/sources/meeting?path=${encodeURIComponent(canonical)}`,
      { method: "GET" },
    )
      .then((body) => {
        if (!cancelled) setMeeting(body.meeting);
      })
      .catch(() => {
        if (!cancelled) {
          setMeeting(null);
          setError("Couldn’t load whether this Source is a meeting.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [canonical]);

  if (!canonical) return null;

  async function mark() {
    if (readOnly || busy || !canonical) return;
    setBusy(true);
    setError(null);
    try {
      const body = await send<MeetingResponse>("/api/sources/meeting", {
        method: "POST",
        body: JSON.stringify({ path: canonical, meeting: true }),
      });
      setMeeting(body.meeting);
    } catch (cause) {
      setError(writeFailure(cause, "mark this Source as a meeting").message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wb-mark-meeting">
      {meeting === false && <p className="wb-mark-meeting-copy">{TODOS_NON_MEETING_COPY}</p>}
      {meeting === false && (
        <button
          type="button"
          className="wb-mark-meeting-btn"
          disabled={readOnly || busy}
          onClick={() => void mark()}
        >
          Mark as meeting
        </button>
      )}
      {error && <p className="wb-mark-meeting-error">{error}</p>}
    </div>
  );
}
