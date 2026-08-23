"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { send } from "@/lib/workbench-request";
import { workbenchMode } from "@/lib/workbench-modes";
import { readStoredResearchFill } from "@/lib/workbench-state";
import type { ResearchProject } from "@/lib/research-projects";

export interface ResearchCanvasProps {
  wikiId: string;
  active?: boolean;
  filledId?: string | null;
}

interface ResearchResponse {
  projects?: ResearchProject[];
}

export function ResearchCanvas({
  wikiId: _wikiId,
  active = true,
  filledId = null,
}: ResearchCanvasProps) {
  const empty = workbenchMode("research").emptyState ?? "";
  const [projects, setProjects] = useState<ResearchProject[]>([]);
  const [error, setError] = useState<string | null>(null);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const body = await send<ResearchResponse>("/api/research", { method: "GET" });
      if (seq !== loadSeq.current) return;
      setProjects(body.projects ?? []);
      setError(null);
    } catch (cause) {
      if (seq !== loadSeq.current) return;
      setProjects([]);
      setError(cause instanceof Error ? cause.message : "Couldn’t load Deep Research.");
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load, filledId]);

  const highlight = filledId ?? readStoredResearchFill();
  const matched = highlight ? projects.filter((project) => project.id === highlight) : [];
  const shown =
    matched.length > 0
      ? matched
      : projects.filter((project) => project.status === "draft").slice(0, 1);

  return (
    <div className="wb-research">
      {error && <p className="wb-todos-error">{error}</p>}
      {shown.length === 0 ? (
        <p className="wb-empty">{empty}</p>
      ) : (
        shown.map((project) => (
          <article key={project.id} className="wb-todos-card">
            <h3 className="wb-todos-title">{project.title}</h3>
            <p className="wb-todos-rationale">{project.question}</p>
            <ul className="wb-research-queries">
              {(Array.isArray(project.queries) ? project.queries : []).map((query) => (
                <li key={query}>{query}</li>
              ))}
            </ul>
            <p className="wb-todos-meta">Draft — web search has not started.</p>
          </article>
        ))
      )}
    </div>
  );
}
