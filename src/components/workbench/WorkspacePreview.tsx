"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { loopbackFetch } from "@/lib/loopback-client";
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
        const read = await loopbackFetch(workspaceFileUrl(selection.path), {
          cache: "no-store",
          signal: controller.signal,
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

  // ---------------------------------------------------------------------------
  // The column comes back where the owner left it (DW-720)
  // ---------------------------------------------------------------------------
  //
  // `PreviewColumn`'s DW-520 restore, on the column beside it — and for the same
  // reason, TWICE: `.wb-preview` (the `<aside>` itself) and `.wb-preview-body`
  // are both `overflow: auto` in `globals.css`, and `.wb-preview[hidden] {
  // display: none }` DISCARDS a scroll box. An Agent report is exactly the kind
  // of long document a Settings visit should not cost the owner their place in.
  //
  // REFS, not storage. This column survives the visit MOUNTED behind `hidden`,
  // so neither offset ever has to cross a reload: no localStorage key is
  // invented here and no FR-8 cross-session claim is made for them. `null` until
  // something has actually been recorded, which is NOT the same as 0 — a first
  // restore that assigned a 0 nobody stored would move a box that has not gone
  // off screen even once.
  const asideRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const asideScrollRef = useRef<number | null>(null);
  const bodyScrollRef = useRef<number | null>(null);
  // One echo per box, each armed with the value the browser ACTUALLY landed on
  // and spent by the first `scroll` event whatever that event says (DW-521). A
  // boolean would be a latch with no way to spend it: a restore that assigns the
  // offset a box already holds fires no `scroll` at all.
  const asideEchoRef = useRef<number | null>(null);
  const bodyEchoRef = useRef<number | null>(null);

  // WHICH FILE the two offsets belong to. They are a memory of what was on
  // SCREEN, not a property of the column: the shell renders this component with
  // no key, so picking another Agent output keeps the same instance and the same
  // two numbers — and because the restore below runs on `hidden` alone, picking
  // a file without scrolling it and then making a Settings round trip would
  // assign the PREVIOUS file's offsets to a document that never had them.
  //
  // Keyed on a PRIMITIVE derived from the pick, never on the object: the shell
  // rebuilds that object freely across renders, and an identity key would clear
  // the offsets the owner is still looking at. The `file:` prefix is
  // `PreviewColumn`'s, so the two columns' keys read the same way.
  const selectionKey = `file:${selection.path}`;
  // Declared BEFORE the restore, so on the rare commit that changes both the
  // pick and `hidden` React runs them in that order: cleared, then restored from
  // nothing.
  useLayoutEffect(() => {
    asideScrollRef.current = null;
    bodyScrollRef.current = null;
    asideEchoRef.current = null;
    bodyEchoRef.current = null;
  }, [selectionKey]);

  // A LAYOUT effect (DW-524): a passive one runs after the browser has painted,
  // so a column the owner is being handed back paints at the top and then
  // visibly jumps. Keyed on `hidden` ALONE — that prop IS the withdrawal, and
  // coming back is the moment the browser has just reset both `scrollTop`s to 0.
  useLayoutEffect(() => {
    const aside = asideRef.current;
    // Whatever the previous run armed is spent HERE, before the guard: a stale
    // echo is the owner's own scroll, dropped for matching a number no restore
    // actually wrote.
    asideEchoRef.current = null;
    bodyEchoRef.current = null;
    if (!aside || hidden) return;
    // The nodes are read through functions rather than captured, so the listener
    // below keeps working against whatever node is in the tree at the moment an
    // event arrives rather than the one this run happened to see.
    const boxes = [
      { node: () => asideRef.current as HTMLElement | null, stored: asideScrollRef, echo: asideEchoRef },
      { node: () => bodyRef.current as HTMLElement | null, stored: bodyScrollRef, echo: bodyEchoRef },
    ];
    for (const box of boxes) {
      const node = box.node();
      const stored = box.stored.current;
      // Nothing recorded means nothing assigned: the box starts where the
      // browser left it rather than being dragged to a 0 nobody chose.
      if (!node || stored === null) continue;
      node.scrollTop = stored;
      // What the browser actually landed on — where the box is shorter than the
      // stored offset the assignment is CLAMPED, and recording that clamp would
      // replace the owner's offset with the maximum of a box still filling in.
      box.echo.current = node.scrollTop;
    }
    // ONE listener, in the CAPTURE phase, on the stable `<aside>`. `scroll` does
    // not bubble, so a bubble-phase listener here could never hear
    // `.wb-preview-body` — but a non-bubbling event still runs the capture path
    // from the root to the target, and a capture listener on an ancestor
    // therefore sees it, while one registered on the `<aside>` itself also fires
    // at `AT_TARGET`.
    const onScroll = (event: Event) => {
      const box = boxes.find((candidate) => candidate.node() === event.target);
      if (!box) return;
      const landed = (event.target as HTMLElement).scrollTop;
      const echo = box.echo.current;
      // Spent unconditionally — a VALUE, not a latch.
      box.echo.current = null;
      if (echo !== null && landed === echo) return;
      box.stored.current = landed;
    };
    aside.addEventListener("scroll", onScroll, { passive: true, capture: true });
    return () => {
      aside.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [hidden]);

  const name = selection.path.split("/").filter(Boolean).at(-1) || selection.path;
  const format = previewFileKind(selection.path);

  return (
    <aside
      id={id}
      className="wb-preview"
      aria-label={`Preview, ${name}`}
      ref={asideRef}
      {...(hidden ? { hidden: true } : {})}
    >
      {/* `wb-preview-head`, the class `globals.css` actually declares, and the
          same one the kernel column's strip carries (DW-718). This used to
          carry a longer spelling of it that no rule anywhere matched, so the
          strip had no padding, no bottom border and a UA heading standing at
          `1.5em` inside it — a miss nothing in the repo could see until
          `workbench-chrome.test.ts` began scanning rendered classes against the
          stylesheet. */}
      <header className="wb-preview-head">
        <h2 className="wb-preview-title">{name}</h2>
        {/* The path is SAID, because `report.md` alone does not tell the owner
            this file is the Agent's rather than the wiki's — and the two are
            stored in different places with different rules. */}
        <p className="wb-preview-path">agent-workspace/{selection.path}</p>
      </header>
      <div className="wb-preview-body" ref={bodyRef}>
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
