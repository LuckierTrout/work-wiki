"use client";

import { useState, type FormEvent, type KeyboardEvent } from "react";
import { send } from "@/lib/workbench-request";
import {
  CHAT_VECTOR_FALLBACK_COPY,
  workbenchMode,
} from "@/lib/workbench-modes";
import { selectionFromContentPath, type TreeSelection } from "@/lib/workbench-tree";
import type { SearchHit } from "@/lib/chat-contract";

export interface SearchCanvasProps {
  wikiId: string;
  onDockPreview: (selection: TreeSelection) => void;
}

interface SearchResponse {
  hits?: SearchHit[];
  vectorPhase?: { status: string; message?: string };
  error?: string;
}

export function SearchCanvas({ wikiId, onDockPreview }: SearchCanvasProps) {
  const empty = workbenchMode("search").emptyState ?? "Press Enter to search.";
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vectorNote, setVectorNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function runSearch(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    setVectorNote(null);
    try {
      const body = await send<SearchResponse>(
        `/api/v1/projects/${encodeURIComponent(wikiId)}/search`,
        { method: "POST", body: JSON.stringify({ query: trimmed, topK: 10 }) },
      );
      if (body.error) {
        setError(body.error);
        setHits(null);
        return;
      }
      setHits(body.hits ?? []);
      if (body.vectorPhase?.status === "failed") {
        setVectorNote(body.vectorPhase.message || CHAT_VECTOR_FALLBACK_COPY);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Search failed.");
      setHits(null);
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void runSearch(query);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void runSearch(query);
    }
  }

  return (
    <div className="wb-search">
      <form className="wb-search-form" onSubmit={onSubmit}>
        <label className="wb-sr-only" htmlFor="wb-search-q">
          Search query
        </label>
        <input
          id="wb-search-q"
          className="wb-search-input"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={empty}
          autoComplete="off"
        />
      </form>
      {busy ? <p className="wb-empty">Searching…</p> : null}
      {vectorNote ? <p className="wb-chat-vector">{vectorNote}</p> : null}
      {error ? <p className="wb-chat-error">{error}</p> : null}
      {hits === null && !busy ? <p className="wb-empty">{empty}</p> : null}
      {hits && hits.length === 0 && !busy ? (
        <p className="wb-empty">No matching Pages or Sources.</p>
      ) : null}
      {hits && hits.length > 0 ? (
        <ul className="wb-search-hits">
          {hits.map((hit) => (
            <li key={`${hit.path}:${hit.score}`}>
              <button
                type="button"
                className="wb-search-hit"
                onClick={() => onDockPreview(selectionFromContentPath(hit.path))}
              >
                <span className="wb-search-hit-title">{hit.title}</span>
                <span className="wb-search-hit-path">{hit.path}</span>
                <span className="wb-search-hit-snippet">{hit.snippet}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
