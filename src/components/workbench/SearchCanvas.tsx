"use client";

import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { send } from "@/lib/workbench-request";
import {
  CHAT_VECTOR_FALLBACK_COPY,
  workbenchMode,
} from "@/lib/workbench-modes";
import { selectionFromContentPath, type TreeSelection } from "@/lib/workbench-tree";
import {
  SEARCH_IMAGES_HEADING,
  partitionSearchImages,
} from "@/lib/search-images";
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
  const searchSeq = useRef(0);
  // The two halves of one list. Recomputed per render rather than stored, so
  // there is no second copy of the results to fall out of step with `hits`.
  const { images, rest } = partitionSearchImages(hits ?? []);

  async function runSearch(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    const seq = ++searchSeq.current;
    setBusy(true);
    setError(null);
    setVectorNote(null);
    try {
      const body = await send<SearchResponse>(
        `/api/v1/projects/${encodeURIComponent(wikiId)}/search`,
        { method: "POST", body: JSON.stringify({ query: trimmed, topK: 10 }) },
      );
      if (seq !== searchSeq.current) return;
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
      if (seq !== searchSeq.current) return;
      setError(cause instanceof Error ? cause.message : "Search failed.");
      setHits(null);
    } finally {
      if (seq === searchSeq.current) setBusy(false);
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
      {/* The image section (Story 7.7). WHICH hits are in it — and therefore
          which leave the list below — is one executed partition, so a hit
          cannot appear twice or vanish from both. Rank order is the search
          route's, preserved in each half. */}
      {images.length > 0 ? (
        <section className="wb-search-images" aria-label={SEARCH_IMAGES_HEADING}>
          <h3 className="wb-search-images-heading">{SEARCH_IMAGES_HEADING}</h3>
          <ul className="wb-search-image-grid">
            {images.map(({ hit, src }) => (
              <li key={`img:${hit.path}:${hit.score}`}>
                <button
                  type="button"
                  className="wb-search-image"
                  onClick={() => onDockPreview(selectionFromContentPath(hit.path))}
                >
                  {/* Owner-gated bytes from our own routes, so a plain <img>. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt={hit.title} loading="lazy" />
                  <span className="wb-search-hit-title">{hit.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {rest.length > 0 ? (
        <ul className="wb-search-hits">
          {rest.map((hit) => (
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
