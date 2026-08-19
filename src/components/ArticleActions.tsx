"use client";

import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { useState } from "react";
import { rawPath } from "@/lib/links";
import { isOwnerHandle } from "@/lib/owner";
import { ReingestButton } from "@/components/ReingestButton";
import { DeletePageButton } from "@/components/DeletePageButton";
import { SaveToVaultButton } from "@/components/SaveToVaultButton";

interface ArticleActionsProps {
  slug: string;
  /** The page's canonical tenant — for the Edit / View-source links. */
  tenant: string;
  /** The page owner handle (lowercased compare against the viewer's username). */
  owner: string;
  /** Contributor handles. */
  contributors: string[];
  /** Whether the page may be curated into a vault: public + non-agent, INCLUDING
   *  artifacts (gates the "Save to vault" button). */
  isCuratable: boolean;
  /**
   * The REALM half of the Delete gate: whether `canWritePage`'s commons-realm
   * branch refuses a delete of this page — i.e. it is public, not agent-scoped
   * and not an artifact, so its prose is agent- and admin-maintained.
   *
   * Computed on the server by {@link import("./ArticleView").ArticleView} with
   * the very predicate that branch decides on (`isRealmRestrictedWrite`), and
   * threaded rather than re-derived here: the predicate reaches
   * `@/lib/commons`, whose import graph pulls storage, locks and `wiki.ts`, and
   * this file is a client island. Required, not optional — a defaulted `false`
   * would silently widen the gate the moment the seam is dropped.
   */
  realmDeniesDelete: boolean;
  /** Whether a raw source exists (gates the View-source link). */
  hasRawSource: boolean;
  /** Whether a source URL exists (gates the Reingest button). */
  hasSourceUrl: boolean;
  /**
   * `YOPEDIA_READONLY=1`. Passed through to the two actions here that sit in
   * front of a gated write: {@link DeletePageButton} (`DELETE /api/wiki/[slug]`,
   * DW-37) and {@link ReingestButton} (`POST /api/ingest/reingest`, DW-187 —
   * and the kernel page writer behind it, DW-188).
   *
   * Graphify and Save to vault are deliberately NOT dimmed and must not be:
   * Graphify posts to `/api/knowledge`, which rebuilds derived structured
   * knowledge and writes no wiki page, and Save to vault curates a reference.
   * Neither reaches a kernel writer, so dimming them would be a refusal the
   * server never answers — the mirror of the bug this fixes.
   */
  readOnly?: boolean;
}

/**
 * The article action bar — self-gating per-viewer. ArticleView renders the same
 * context-free article for everyone (cacheable); this client island reads the
 * Clerk session and shows only the actions the signed-in viewer is allowed:
 *
 *   - View raw        — when a raw source exists.
 *   - Reingest        — owner/contributor, when a source URL exists.
 *   - Graphify page   — page owner only; refreshes derived private knowledge.
 *   - Delete          — the site owner, or the page owner on a page the
 *                       commons realm does not reserve for agents.
 *   - Save to vault    — any signed-in viewer on a curatable page (owners and
 *                       contributors included; gated by `isCuratable`).
 *
 * There is intentionally NO human "Edit page" button: in this deployment
 * pages are maintained by agents (via API/MCP), not hand-edited here.
 *
 * These are CONVENIENCE gates only; every underlying route re-authorizes the
 * request server-side, so a stale/forged client never bypasses the real check.
 */
export function ArticleActions({
  slug,
  tenant,
  owner,
  contributors,
  isCuratable,
  realmDeniesDelete,
  hasRawSource,
  hasSourceUrl,
  readOnly = false,
}: ArticleActionsProps) {
  const { isLoaded, isSignedIn, user } = useUser();
  const [graphifyState, setGraphifyState] = useState<
    "idle" | "working" | "done" | "failed"
  >("idle");
  const [graphifyError, setGraphifyError] = useState<string | null>(null);
  // Resolve the viewer's handle the SAME way the server does (auth.ts
  // resolveHandle): prefer the Clerk username, else the username on the X/Twitter
  // external account (Twitter-SSO users often have no Clerk username set).
  const handle =
    user?.username ??
    user?.externalAccounts?.find(
      (a) => typeof a.provider === "string" && /(^|_)(x|twitter)$/i.test(a.provider),
    )?.username ??
    null;
  // Owner/contributor gating is case-insensitive (owner/contributors are stored
  // lowercased server-side).
  const handleLc = handle?.toLowerCase() ?? null;

  const isOwner = !!handleLc && handleLc === owner.toLowerCase();
  const isSiteOwner = isOwnerHandle(handleLc);
  const ownsOrContributes =
    !!handleLc &&
    (isOwner || contributors.some((c) => c.toLowerCase() === handleLc));
  // The Delete gate, split the way the knowledge is split.
  //
  // WHAT THE CLIENT KNOWS: who the viewer is. Only the browser holds the Clerk
  // session, so `isOwner`/`isSiteOwner` can only be decided here.
  // WHAT THE SERVER KNOWS: the page's realm. `belongsInCommons` reaches
  // storage/lock/wiki, so `realmDeniesDelete` arrives as a prop from
  // `ArticleView` — the same predicate `canWritePage`'s realm branch decides
  // on, never a second guess at it.
  // WHAT NEITHER SIDE CAN KNOW HERE: `ADMIN_HANDLES`. It is a server-only var,
  // so an admin who is NOT the site owner passes the server's delete check and
  // is still not offered the button.
  //
  // That asymmetry is deliberate and one-directional: this gate may be
  // NARROWER than the server's answer (an under-offered button is a missing
  // convenience) but must never be WIDER (an offered button the server refuses
  // is the bug this replaced — a page owner was shown Delete on a public
  // knowledge page the realm gate always refused). The server re-authorizes
  // every request regardless; `article-actions-delete-gate.test.tsx` pins the
  // inequality against `canWritePage` itself.
  const canDelete = isSiteOwner || (isOwner && !realmDeniesDelete);
  // Any signed-in user can curate a curatable page (public + non-agent, incl.
  // artifacts) into their vault — including owners and contributors (owned/
  // contributed pages are NOT automatically in vaults, so excluding them created
  // a curation gap for the most engaged users).
  const canCurate = isLoaded && !!isSignedIn && isCuratable;

  async function graphifyPage() {
    setGraphifyState("working");
    setGraphifyError(null);
    try {
      const response = await fetch("/api/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(body.error || `Graphify failed (${response.status}).`);
      }
      setGraphifyState("done");
    } catch (error) {
      setGraphifyState("failed");
      setGraphifyError(error instanceof Error ? error.message : "Graphify failed.");
    }
  }

  return (
    <div className="mt-12 border-t border-rule pt-6 flex flex-wrap items-center gap-3">
      {hasRawSource && (
        <Link href={rawPath(tenant, slug)} className="btn">
          View raw
        </Link>
      )}
      {hasSourceUrl && ownsOrContributes && (
        <ReingestButton slug={slug} readOnly={readOnly} />
      )}
      {isOwner && (
        <button
          type="button"
          className="btn"
          disabled={graphifyState === "working"}
          onClick={() => void graphifyPage()}
        >
          {graphifyState === "working"
            ? "Graphifying…"
            : graphifyState === "done"
              ? "Graphified"
              : "Graphify page"}
        </button>
      )}
      {graphifyState === "done" && (
        <Link href="/knowledge" className="btn ghost">
          Open atlas
        </Link>
      )}
      {canCurate && <SaveToVaultButton slug={slug} />}
      {canDelete && <DeletePageButton slug={slug} readOnly={readOnly} />}
      {graphifyError && (
        <p role="alert" style={{ width: "100%", margin: 0, color: "var(--rust)", fontSize: 12.5 }}>
          {graphifyError}
        </p>
      )}
    </div>
  );
}
