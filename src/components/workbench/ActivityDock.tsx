"use client";

import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  ACTIVITY_CANCEL_BODY,
  ACTIVITY_CANCEL_CONFIRM,
  ACTIVITY_CANCEL_LABEL,
  ACTIVITY_CANCEL_TITLE,
  ACTIVITY_EMPTY_COPY,
  ACTIVITY_KEEP_RUNNING,
  ACTIVITY_RETRY_LABEL,
  ACTIVITY_ROUTE,
  ACTIVITY_TITLE,
  activityQueueProgress,
  readStoredActivityOpen,
  writeStoredActivityOpen,
  type ActivityRow,
} from "@/lib/workbench-activity";
import { send } from "@/lib/workbench-request";

const POLL_MS = 2_000;

export interface ActivityDockProps {
  readOnly?: boolean;
}

export function ActivityDock({ readOnly = false }: ActivityDockProps) {
  const [open, setOpen] = useState(readStoredActivityOpen);
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const body = await send<{ rows?: ActivityRow[] }>(ACTIVITY_ROUTE, {
        method: "GET",
      });
      setRows(Array.isArray(body.rows) ? body.rows : []);
    } catch {
      // poll fail-soft — the last rows stay on screen
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  function toggle() {
    const next = !open;
    setOpen(next);
    writeStoredActivityOpen(next);
  }

  const progress = activityQueueProgress(rows);
  const cancelling = rows.find((row) => row.jobId === cancelId);

  return (
    <div className="wb-activity">
      <button
        type="button"
        className="wb-activity-toggle"
        aria-expanded={open}
        onClick={toggle}
      >
        {ACTIVITY_TITLE}
        {progress.total > 0 && (
          <span className="wb-activity-count">
            {progress.completed}/{progress.total}
            {progress.activeStep ? ` · ${progress.activeStep}` : ""}
          </span>
        )}
      </button>
      {open && (
        <div className="wb-activity-body">
          {progress.total > 0 && (
            <progress
              className="wb-activity-bar"
              max={progress.total}
              value={progress.completed}
            />
          )}
          {rows.length === 0 ? (
            <p className="wb-activity-empty">{ACTIVITY_EMPTY_COPY}</p>
          ) : (
            <ul className="wb-activity-list">
              {rows.map((row) => (
                <li key={row.jobId} className="wb-activity-row">
                  <div className="wb-activity-main">
                    <span className="wb-activity-title">{row.title}</span>
                    <span className="wb-activity-status">{row.displayStatus}</span>
                  </div>
                  {row.error && <p className="wb-activity-error">{row.error}</p>}
                  {!readOnly && (
                    <div className="wb-activity-actions">
                      {row.canCancel && (
                        <button
                          type="button"
                          className="wb-activity-action"
                          onClick={() => {
                            setError(null);
                            setCancelId(row.jobId);
                          }}
                        >
                          {ACTIVITY_CANCEL_LABEL}
                        </button>
                      )}
                      {row.canRetry && (
                        <button
                          type="button"
                          className="wb-activity-action"
                          onClick={() => {
                            if (retryingId === row.jobId) return;
                            setRetryingId(row.jobId);
                            setError(null);
                            void send(ACTIVITY_ROUTE, {
                              method: "POST",
                              body: JSON.stringify({
                                action: "retry",
                                jobId: row.jobId,
                              }),
                            })
                              .then(() => refresh())
                              .catch((cause: unknown) => {
                                setError(
                                  cause instanceof Error
                                    ? cause.message
                                    : "Retry failed.",
                                );
                              })
                              .finally(() => setRetryingId(null));
                          }}
                        >
                          {ACTIVITY_RETRY_LABEL}
                        </button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <ConfirmDialog
        open={cancelId !== null}
        title={ACTIVITY_CANCEL_TITLE}
        body={ACTIVITY_CANCEL_BODY}
        confirmLabel={ACTIVITY_CANCEL_CONFIRM}
        cancelLabel={ACTIVITY_KEEP_RUNNING}
        busy={busy}
        error={error}
        onCancel={() => {
          if (!busy) setCancelId(null);
        }}
        onConfirm={() => {
          if (!cancelling) return;
          setBusy(true);
          setError(null);
          void send(ACTIVITY_ROUTE, {
            method: "POST",
            body: JSON.stringify({ action: "cancel", jobId: cancelling.jobId }),
          })
            .then(() => {
              setCancelId(null);
              return refresh();
            })
            .catch((cause: unknown) => {
              setError(cause instanceof Error ? cause.message : "Cancel failed.");
            })
            .finally(() => setBusy(false));
        }}
      />
    </div>
  );
}
