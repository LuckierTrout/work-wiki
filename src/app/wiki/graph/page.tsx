"use client";

import { useRef, useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useGraphSimulation } from "@/hooks/useGraphSimulation";
import { KNOWLEDGE_TREE_HREF, readScopeFromSearch } from "@/lib/workbench-url";

export default function GraphPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const router = useRouter();

  // Owner knowledge + vault lenses. The deployment is private, so the default
  // is always the signed-in owner's full readable graph.
  const { isLoaded, isSignedIn } = useUser();
  const [scope, setScope] = useState<string | undefined>("mine");

  // The signed-in user's vaults, for the lens selector (fetched on mount).
  const [myVaults, setMyVaults] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;
    fetch("/api/vaults")
      .then((r) => (r.ok ? r.json() : { vaults: [] }))
      .then((d: { vaults?: { id: string; name: string }[] }) => {
        if (!cancelled) setMyVaults(d.vaults ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isSignedIn]);

  // Initial scope once, on first Clerk load: a `?scope=` deep-link wins, else
  // default = mine. Reads `window.location` directly rather than through
  // `useSearchParams`, which would opt this whole page into a client-side
  // rendering bailout — the SAME rationale `@/lib/workbench-url` was written
  // under, which is why the read is that module's and not a second
  // `URLSearchParams` hand-rolled here (DW-166). One reader per param, in one
  // place; the `?? "mine"` below is the page's own fallback, and the reader
  // deliberately validates nothing because the lens vocabulary is
  // `/api/wiki/graph`'s and that route already gates it.
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current || !isLoaded) return;
    didInit.current = true;
    setScope(readScopeFromSearch(window.location.search) ?? "mine");
  }, [isLoaded]);

  const scopedHandle = scope?.startsWith("owner:")
    ? scope.slice("owner:".length)
    : null;
  const activeVaultId = scope?.startsWith("vault:")
    ? scope.slice("vault:".length)
    : null;

  const {
    loading,
    empty,
    fetchError,
    canvasBg,
    handleMouseMove,
    handleMouseLeave,
    handleClick,
    handleKeyDown,
    handleFocus,
    handleBlur,
    cursorAnnouncement,
  } = useGraphSimulation(canvasRef, router, scope);

  const lens = scopedHandle ? (
    <div
      className="row"
      style={{
        display: "inline-flex",
        gap: 8,
        alignItems: "center",
        border: "1px solid var(--rule)",
        background: "var(--paper-2)",
        borderRadius: 999,
        padding: "5px 12px",
        fontSize: 13,
      }}
    >
      <span style={{ color: "var(--muted)" }}>
        Graphing{" "}
        <span style={{ color: "var(--ink)", fontWeight: 600 }}>
          @{scopedHandle}
        </span>
        ’s pages
      </span>
      <button
        type="button"
        onClick={() => setScope("mine")}
        style={{ color: "var(--muted)", background: "transparent", border: 0, cursor: "pointer" }}
        aria-label="Clear scope and show the full wiki graph"
      >
        ✕
      </button>
    </div>
  ) : (
    <div
      role="group"
      aria-label="Graph scope"
      className="row"
      style={{ gap: 6, flexWrap: "wrap" }}
    >
      {[
        { scope: "mine" as string | undefined, label: "All knowledge", active: !activeVaultId },
        ...myVaults.map((v) => ({
          scope: `vault:${v.id}` as string | undefined,
          label: v.name,
          active: activeVaultId === v.id,
        })),
      ].map((o) => (
        <button
          key={o.scope ?? "all"}
          type="button"
          onClick={() => setScope(o.scope)}
          style={{
            fontSize: 13,
            padding: "5px 12px",
            borderRadius: 999,
            whiteSpace: "nowrap",
            cursor: "pointer",
            border: `1px solid ${o.active ? "var(--ink)" : "var(--rule)"}`,
            background: o.active ? "var(--ink)" : "transparent",
            color: o.active ? "var(--paper)" : "var(--ink-2)",
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold tracking-tight">Wiki Graph</h1>
        {lens}
      </div>

      {loading ? (
        <p className="text-foreground/60">Loading graph…</p>
      ) : fetchError ? (
        <p className="text-red-500">Failed to load graph data: {fetchError}</p>
      ) : empty ? (
        <p className="text-foreground/60">
          {scopedHandle
            ? `No pages in @${scopedHandle}’s silo yet.`
            : activeVaultId
              ? "This vault has no pages yet."
              : "No wiki pages yet. Ingest some content to see the graph!"}
        </p>
      ) : (
        <>
          {/*
            The canvas below names the Knowledge tree as its accessible
            alternative, so that tree has to be reachable while the canvas is
            rendering too: a `<canvas>` fallback child is exposed only to a
            client that cannot render the canvas at all, and `role="img"` prunes
            it from the a11y tree besides. This visible link is the reachable
            one, and `retired-surfaces.test.ts` pins it as such.

            Both links point at `KNOWLEDGE_TREE_HREF` — this page spells no
            route of its own. The visible one is a `next/link`, the house
            convention for in-app navigation; the fallback stays a plain `<a>`,
            since a client with no canvas has no use for client-side routing.

            The copy names the WIKI's pages, not "all pages": this graph is
            lens-scoped (`?scope=` — mine, a vault, or another owner), so the
            two sets are not the same one and promising the graph's contents
            would be a promise the tree does not keep.

            The canvas below IS a tab stop, because there is now something to
            do from it (DW-594/595). `useGraphSimulation` owns a keyboard cursor
            — an index into the node set that the arrow keys move and Enter or
            Space activates — and both input paths end in the hook's single
            `openNode`, so the page Enter opens is by construction the page a
            click on that node opens. This replaces the DW-463 state, where the
            canvas carried `tabIndex={0}` beside pointer handlers only and a
            keyboard reader landed on a focus stop where every key did nothing;
            the answer then was to remove the stop, and the answer now is to
            make it lead somewhere.

            It stays `role="img"`, because it is still a picture with a text
            alternative and DW-131/DW-461 pin that semantics. An operable
            `role="img"` is unusual, so the cursor is announced by the sibling
            live region below rather than by the canvas's own name, and the
            `aria-label` names the keys so a screen-reader user knows they
            exist. `role="application"` was rejected: it suppresses browse mode
            for a surface whose text alternative is one link away.

            The fallback `<a>` inside the canvas carries `tabIndex={-1}`
            (DW-594). Canvas fallback content is displayed only by a client that
            cannot render the canvas at all — but every browser that CAN render
            it still puts focusable fallback content in the sequential focus
            order, so without this a keyboard reader hits a focus stop that
            renders nothing on screen. The link itself stays (a client with no
            canvas needs it), and the visible `next/link` above stays the
            reachable escape hatch either way.
          */}
          <p className="text-sm text-foreground/60 mb-4">
            Click a node to open the page, or focus the graph and use the arrow
            keys to move between nodes and Enter to open one. Or open the{" "}
            <Link href={KNOWLEDGE_TREE_HREF} className="underline">
              Workbench Knowledge tree
            </Link>{" "}
            for a text list of this wiki&rsquo;s pages.
          </p>
          <div className="w-full overflow-hidden rounded-lg border border-foreground/10">
            <canvas
              ref={canvasRef}
              tabIndex={0}
              onClick={handleClick}
              onMouseMove={handleMouseMove}
              onMouseLeave={handleMouseLeave}
              onKeyDown={handleKeyDown}
              onFocus={handleFocus}
              onBlur={handleBlur}
              className="block w-full"
              style={{ height: 560, backgroundColor: canvasBg }}
              role="img"
              aria-label="Wiki page relationship graph. Use the arrow keys to move between pages and Enter to open one. Or open the Workbench Knowledge tree for a text list of this wiki's pages."
            >
              Wiki relationship graph — open the{" "}
              <a href={KNOWLEDGE_TREE_HREF} tabIndex={-1}>
                Workbench Knowledge tree
              </a>{" "}
              for a text list of this wiki&rsquo;s pages.
            </canvas>
          </div>
          {/*
            The canvas's announcement channel. `role="img"` gives the canvas a
            static name, so the node under the keyboard cursor is announced
            here instead — polite, so it does not interrupt, and visually
            hidden, because the canvas already shows the cursor as a ring.

            One element carries both `role="status"` and `aria-live="polite"`,
            and it stays mounted with an empty string rather than being
            conditionally rendered: a live region announces what CHANGES inside
            it, so a region that appears already holding its text has, for some
            assistive technology, nothing to report. (`ToastContainer` splits
            the pair across two elements and mounts on demand, which suits a
            list of transient notices; this is one slot rewritten in place.)
          */}
          <p className="sr-only" role="status" aria-live="polite">
            {cursorAnnouncement}
          </p>
          <p className="text-xs text-foreground/40 mt-2">
            Node size reflects connection count. Colors indicate detected
            communities.
          </p>
        </>
      )}
    </div>
  );
}
