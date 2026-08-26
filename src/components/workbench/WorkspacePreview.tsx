"use client";

import { useEffect, useState } from "react";
import { send } from "@/lib/workbench-request";
import { workspaceFileUrl } from "@/lib/chat-agent";
import { previewFileKind } from "@/lib/workbench-preview";
import type { WorkspaceSelection } from "@/lib/workbench-tree";
import { PreviewBody } from "./PreviewBody";

/**
 * The Preview column for a file the Agent wrote (Story 8.8).
 *
 * A SECOND, SMALLER COLUMN rather than a third branch inside `PreviewColumn`,
 * and the reason is what this file does NOT have: no version, no `If-Match`, no
 * revisions, no Edit, no Revert, no media door, no wikilink slug set. Every one
 * of those is about a kernel artifact with a write path behind it, and an
 * `agent-workspace/` file has none — it is bytes on the owner's local disk,
 * reached through the sidecar. Threading a nullable version and a disabled Edit
 * button through the kernel column would have made every one of those
 * guarantees conditional for the sake of reusing a header.
 *
 * READ-ONLY BY CONSTRUCTION. There is no writer here at all: the way to change
 * one of these files is to ask the Agent, and the way to keep one is to have the
 * Agent write it into the wiki through the kernel — which is the same rule that
 * keeps `dataVersion` honest.
 *
 * FETCHED FROM THE SIDECAR, so it fails exactly as Chat does: the sidecar being
 * down is a refused connection and the column says so rather than showing an
 * empty body that reads as an empty file.
 */

export interface WorkspacePreviewProps {
  id: string;
  selection: WorkspaceSelection;
  hidden?: boolean;
}

const LOADING_COPY = "Loading…";
const FAILED_COPY =
  "Could not read this file. The sidecar may not be running, or the Agent may have removed it.";

export function WorkspacePreview({ id, selection, hidden }: WorkspacePreviewProps) {
  const [content, setContent] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    setContent(null);
    void (async () => {
      try {
        let token: string | null = null;
        try {
          const settings = await send<{ token?: string | null }>(
            "/api/v1/loopback-settings",
            { method: "GET" },
          );
          token = typeof settings.token === "string" ? settings.token : null;
        } catch {
          token = null;
        }
        const read = await fetch(workspaceFileUrl(selection.path), {
          cache: "no-store",
          signal: controller.signal,
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        if (!read.ok) throw new Error(String(read.status));
        const body = (await read.json()) as { content?: unknown };
        if (typeof body.content !== "string") throw new Error("shape");
        setContent(body.content);
      } catch (error) {
        // An aborted fetch is an unmount or a new pick, not a failure — showing
        // the refusal sentence for it would flash an error on every click.
        if ((error as Error).name === "AbortError") return;
        setFailed(true);
      } finally {
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [selection.path]);

  const name = selection.path.split("/").filter(Boolean).at(-1) || selection.path;
  const format = previewFileKind(selection.path);

  return (
    <aside
      id={id}
      className="wb-preview"
      aria-label={`Preview, ${name}`}
      {...(hidden ? { hidden: true } : {})}
    >
      <header className="wb-preview-header">
        <h2 className="wb-preview-title">{name}</h2>
        {/* The path is SAID, because `report.md` alone does not tell the owner
            this file is the Agent's rather than the wiki's — and the two are
            stored in different places with different rules. */}
        <p className="wb-preview-path">agent-workspace/{selection.path}</p>
      </header>
      <div className="wb-preview-body">
        {loading ? (
          <p className="wb-preview-note">{LOADING_COPY}</p>
        ) : failed ? (
          <p className="wb-preview-note" role="alert">
            {FAILED_COPY}
          </p>
        ) : (
          <PreviewBody
            // `unsupported` cannot reach here — the sidecar answers 415 for a
            // non-text extension, which lands on the refusal above — so anything
            // that is not markdown renders verbatim rather than being parsed.
            format={format === "markdown" ? "markdown" : "text"}
            content={content ?? ""}
            // NO WIKILINK TARGETS. An Agent output is not part of the wiki's link
            // graph, so `[[alpha]]` in a draft has nothing to resolve against and
            // renders as the missing-link text — which is the truth.
            readableSlugs={new Set()}
            onOpenPage={() => {}}
          />
        )}
      </div>
    </aside>
  );
}
