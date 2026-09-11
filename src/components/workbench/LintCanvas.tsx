"use client";

import { SurfacePresentation } from "@/hooks/useSurfaceVisibility";

import { useCallback, useEffect, useRef, useState } from "react";
import { send, writeFailure } from "@/lib/workbench-request";
import { workbenchMode } from "@/lib/workbench-modes";
import { selectionFromContentPath, type TreeSelection } from "@/lib/workbench-tree";
import {
  WORKBENCH_LINT_IDLE,
  workbenchCanAutoFix,
  type WorkbenchLintIssue,
} from "@/lib/workbench-lint-types";

export interface LintCanvasProps {
  wikiId: string;
  readOnly?: boolean;
  active?: boolean;
  onDockPreview: (selection: TreeSelection) => void;
}

interface LintResponse {
  issues?: WorkbenchLintIssue[];
}

export function LintCanvas({
  wikiId: _wikiId,
  readOnly = false,
  active: _active = true,
  onDockPreview,
}: LintCanvasProps) {
  const idle = workbenchMode("lint").emptyState ?? WORKBENCH_LINT_IDLE;
  const [ran, setRan] = useState(false);
  const [semantic, setSemantic] = useState(false);
  const [issues, setIssues] = useState<WorkbenchLintIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const wikiScope = useRef(_wikiId);
  wikiScope.current = _wikiId;
  useEffect(() => {
    setIssues([]);
    setError(null);
    setRan(false);
    setBusy(false);
  }, [_wikiId]);

  const run = useCallback(async () => {
    if (wikiScope.current !== _wikiId) return;
    setBusy(true);
    setError(null);
    try {
      const body = await send<LintResponse>("/api/lint/workbench", {
        method: "POST",
        body: JSON.stringify({ semantic }),
      });
      if (wikiScope.current !== _wikiId) return;
      setIssues(body.issues ?? []);
      setRan(true);
    } catch (cause) {
      if (wikiScope.current !== _wikiId) return;
      setError(cause instanceof Error ? cause.message : "Couldn’t run lint.");
    } finally {
      if (wikiScope.current === _wikiId) setBusy(false);
    }
  }, [semantic, _wikiId]);

  async function fix(issue: WorkbenchLintIssue) {
    if (readOnly || !workbenchCanAutoFix(issue, readOnly)) return;
    setBusy(true);
    setError(null);
    try {
      await send("/api/lint/workbench-fix", {
        method: "POST",
        body: JSON.stringify({
          type: issue.type,
          slug: issue.slug,
          target: issue.target,
        }),
      });
      await run();
    } catch (cause) {
      if (wikiScope.current === _wikiId) setError(writeFailure(cause, "auto-fix the issue").message);
    } finally {
      if (wikiScope.current === _wikiId) setBusy(false);
    }
  }

  return (
    <SurfacePresentation active={_active}>
    <div className="wb-lint">
      <div className="wb-todos-bar">
        <label className="wb-lint-semantic">
          <input
            type="checkbox"
            checked={semantic}
            onChange={(event) => setSemantic(event.target.checked)}
          />
          Semantic
        </label>
        <button
          type="button"
          className="wb-todos-btn wb-todos-btn--primary"
          disabled={busy}
          onClick={() => void run()}
        >
          Run lint
        </button>
      </div>
      {error && <p className="wb-todos-error">{error}</p>}
      {!ran ? (
        <p className="wb-empty">{idle}</p>
      ) : issues.length === 0 ? (
        <p className="wb-empty">No lint issues.</p>
      ) : (
        <ul className="wb-todos-cards">
          {issues.map((issue, index) => (
            <li key={`${issue.type}:${issue.slug}:${issue.target ?? ""}:${index}`} className="wb-todos-card">
              <p className="wb-lint-type">{issue.type}</p>
              {issue.slug ? (
                <button
                  type="button"
                  className="wb-todos-link"
                  onClick={() => onDockPreview(selectionFromContentPath(`wiki/${issue.slug}.md`))}
                >
                  wiki/{issue.slug}.md
                </button>
              ) : (
                <p className="wb-todos-link">{issue.type === "insight-pointer" ? "Graph Insights" : issue.type}</p>
              )}
              <p className="wb-todos-rationale">{issue.message}</p>
              {workbenchCanAutoFix(issue, readOnly) && (
                <button
                  type="button"
                  className="wb-todos-btn"
                  disabled={busy}
                  onClick={() => void fix(issue)}
                >
                  Auto-fix
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
    </SurfacePresentation>
  );
}
