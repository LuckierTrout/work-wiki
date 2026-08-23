"use client";

import { useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";

export interface DeepResearchConfirmValues {
  topic: string;
  queries: string[];
}

export interface DeepResearchConfirmProps {
  open: boolean;
  initialTopic: string;
  initialQueries: readonly string[];
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (values: DeepResearchConfirmValues) => void;
}

export function DeepResearchConfirm({
  open,
  initialTopic,
  initialQueries,
  busy = false,
  error = null,
  onCancel,
  onConfirm,
}: DeepResearchConfirmProps) {
  const [topic, setTopic] = useState(initialTopic);
  const [queryText, setQueryText] = useState(initialQueries.join("\n"));

  useEffect(() => {
    if (!open) return;
    setTopic(initialTopic);
    setQueryText(initialQueries.join("\n"));
  }, [open, initialTopic, initialQueries]);

  const queries = queryText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    <ConfirmDialog
      open={open}
      title="Deep Research"
      confirmLabel="Confirm"
      cancelLabel="Cancel"
      busy={busy}
      error={error}
      confirmDisabled={queries.length < 1 || !topic.trim()}
      onCancel={onCancel}
      onConfirm={() => onConfirm({ topic: topic.trim(), queries })}
      body={
        <div className="wb-dr-confirm">
          <label className="wb-todos-field">
            Topic
            <input
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              disabled={busy}
            />
          </label>
          <label className="wb-todos-field">
            Queries (one per line)
            <textarea
              className="wb-dr-queries"
              rows={6}
              value={queryText}
              onChange={(event) => setQueryText(event.target.value)}
              disabled={busy}
            />
          </label>
        </div>
      }
    />
  );
}
