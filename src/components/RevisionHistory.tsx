"use client";

import { useState, useCallback, useId } from "react";
import { useRouter } from "next/navigation";
import { isOwnerHandle } from "@/lib/owner";
import { useViewerHandle } from "@/lib/viewer-handle";
import { RevisionItem } from "./RevisionItem";
import type { Revision } from "./RevisionItem";

/**
 * Why Revert refuses, said out loud.
 *
 * DELIBERATELY NARROWER THAN THE SERVER'S SENTENCE, and this is the one place
 * that is true. `POST /api/wiki/[slug]/revisions` spells no refusal of its own —
 * it maps the KERNEL's, which is `READ_ONLY_REFUSAL.pageWrite`, "Pages cannot be
 * written while this deployment is read-only." That is the honest sentence for a
 * writer that carries create, edit, revert and re-ingest alike, and a useless one
 * beside a button labelled Revert. So the surface says what the owner was about
 * to do; the server keeps the sentence that is true of every caller.
 * `read-only-copy-parity.test.ts` records the divergence explicitly rather than
 * leaving it to be discovered as a bug.
 *
 * Duplicated rather than imported for the same reason as every other client
 * constant: `read-only.ts` pulls `./config` and `process.env` with it.
 */
export const REVERT_READ_ONLY_COPY =
  "Pages cannot be reverted to an earlier revision while this deployment is read-only.";

interface RevisionHistoryProps {
  slug: string;
  /**
   * The REALM half of the Revert gate: whether `canWritePage`'s commons-realm
   * branch refuses a BODY write of this page.
   * `POST /api/wiki/[slug]/revisions {action:"revert"}` re-authorizes with
   * `writeKind: "body"`, so on a public, non-agent-scoped, non-artifact page it
   * always answers 403 — and every viewer was still shown a Revert button per
   * row, with an irreversible-sounding confirm in front of it (DW-269, the
   * DW-120 shape one door over).
   *
   * Computed on the SERVER by {@link import("./ArticleView").ArticleView} from
   * `isRealmRestrictedWrite`, because that predicate reaches `@/lib/commons`,
   * whose import graph pulls storage, locks and `wiki.ts` — none of which may
   * enter this `"use client"` file. Required, not optional: a defaulted `false`
   * would silently restore the button the moment the seam is dropped.
   *
   * REVERT TAKES NO OWNERSHIP TERM, deliberately. The route gates on the realm
   * and on the private-page ACL, not on page ownership, so adding an `isOwner`
   * term here would hide the control from viewers the server would have
   * allowed. This prop is the realm half alone; the site owner (an admin
   * server-side) keeps the door on realm pages, and the identity half of the
   * gate — signed-in, plus site owner — is decided beside `canRevert` below.
   *
   * IT DOES TAKE A SIGNED-IN TERM (DW-392, 2026-08-28). That is not the same
   * thing: being signed in is a precondition the server really does enforce,
   * where ownership is not. The enforcing layer is `middleware.ts`, not the
   * per-page ACL — `canWritePage` only restricts PRIVATE pages ("authentication
   * for public edits is the write-gate middleware's job", per its own docblock),
   * so on a public artifact it would answer `true` for an anonymous principal.
   * The private-deployment gate is what answers a session-less browser POST 401
   * "Authentication required." before the route is entered at all: the
   * revisions path is exempt from that gate ONLY under `isBearerMachineWrite`,
   * which requires a `Bearer` credential a browser does not send.
   *
   * So an anonymous viewer of a public artifact or an agent-scoped page — a
   * page the realm leaves alone, where `!realmDeniesRevert` was the whole gate —
   * was being offered a Revert button per row, with an irreversible-sounding
   * `window.confirm` in front of it, for a write that was never going to run.
   * The added term narrows this gate TOWARD the server's answer; an `isOwner`
   * term would narrow it PAST that answer, which is why the renegotiation
   * recorded in `spec-dw-121-…-authz-realm-parity-and-read-gates` covers the
   * signed-in half alone.
   *
   * HARDENING, NOT A LIVE BUG TODAY. `handlePrivateRequest` makes this whole
   * deployment single-owner: a session-less browser navigation is redirected to
   * `/sign-in` and any other signed-in user gets a 404, so no anonymous viewer
   * reaches the article at all right now. The gate is written for the state the
   * component claims to hold — an offered control the server refuses — not for
   * the one deployment configuration that hides the component first.
   */
  realmDeniesRevert: boolean;
  /**
   * `YOPEDIA_READONLY=1`, read on the server by the page that renders the
   * article and threaded down through {@link import("./ArticleView").ArticleView}
   * — no route and no client fetch is added for a fact the process already
   * holds.
   *
   * `POST /api/wiki/[slug]/revisions {action:"revert"}` now answers 403 on such
   * a deployment (DW-187), and the kernel page writer refuses the rewrite behind
   * it (DW-188). Left ungated, {@link handleRevert}'s first act is a
   * `window.confirm` the owner has to answer before learning the deployment was
   * never going to run it — the exact harm DW-149 names.
   */
  readOnly?: boolean;
}

/**
 * Collapsible revision history panel rendered at the bottom of a wiki page.
 *
 * Fetches revisions on-demand when the user expands the section — keeps the
 * server component thin and avoids unnecessary API calls for pages the user
 * is just reading.
 */
export function RevisionHistory({
  slug,
  realmDeniesRevert,
  readOnly = false,
}: RevisionHistoryProps) {
  const router = useRouter();
  // The identity half of the Revert gate, mirroring `ArticleActions`: only the
  // browser holds the Clerk session, so whether the viewer is signed in and
  // whether they are the site owner can both only be decided here, while the
  // realm arrives as a prop from the server. `ADMIN_HANDLES` is
  // server-only, so an admin who is not the site owner is under-offered Revert —
  // narrower than the server's answer, which is the one safe direction. Both
  // facts come from the shared `@/lib/viewer-handle` hook (whose handle is
  // already lowercased, which is why `isOwnerHandle` is called on it directly)
  // so this gate and the Delete/Re-ingest gates read one copy of the resolution
  // rule — the Clerk hook is never called a second time in this island, and
  // `article-actions-gate.test.ts` pins that as a source scan.
  const { isLoaded, isSignedIn, handle } = useViewerHandle();
  // `isLoaded` guards this term because before the session resolves `handle` is
  // null for a viewer who will turn out to be the site owner, so an unguarded
  // `isOwnerHandle` would answer `false` by accident of a missing handle rather
  // than by a decision — and on a realm page that is the difference between
  // "we do not know yet" and "no". Guarded, the fail-closed hydration answer is
  // deliberate and matches `ArticleActions`'s `canCurate`, the one affordance
  // over there that is `isLoaded`-guarded for the same reason (`canDelete` and
  // `canReingest` lean on `handleLc` being null instead). It guards the
  // signed-in term below for the same reason, which
  // is now what decides a NON-realm page too: `!realmDeniesRevert` alone no
  // longer makes `canRevert` true there.
  const isSiteOwner = isLoaded && isOwnerHandle(handle);
  // The signed-in term (DW-392), and the reason `isLoaded` now guards two
  // things. A signed-out viewer of a page the realm does not restrict — a
  // public artifact, an agent-scoped page — passed `!realmDeniesRevert` and was
  // shown Revert on every row, in front of a POST the deployment gate in
  // `middleware.ts` answers 401 before the route runs (see the prop docblock:
  // the per-page ACL is NOT what refuses here). Same shape as
  // `ArticleActions`'s `canCurate` (`isLoaded && !!isSignedIn && …`), and read
  // from the SAME hook, so the islands cannot disagree about who is looking.
  // Unresolved sessions fail closed: absent beats briefly offered.
  const isSignedInViewer = isLoaded && isSignedIn;
  // The site owner is necessarily signed in, so the new conjunct closes no door
  // the previous expression opened for them.
  const canRevert = isSignedInViewer && (isSiteOwner || !realmDeniesRevert);
  // One sentence for the whole list; every Revert button points at it.
  const readOnlyNoteId = useId();
  const [open, setOpen] = useState(false);
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Viewing a specific revision
  const [viewingTimestamp, setViewingTimestamp] = useState<number | null>(null);
  const [viewContent, setViewContent] = useState<string | null>(null);
  const [viewLoading, setViewLoading] = useState(false);

  // Revert state
  const [reverting, setReverting] = useState(false);

  const fetchRevisions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/wiki/${slug}/revisions`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Failed to load revisions (${res.status})`);
      }
      const data = (await res.json()) as { revisions: Revision[] };
      setRevisions(data.revisions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [slug]);

  function handleToggle() {
    const willOpen = !open;
    setOpen(willOpen);
    if (willOpen && revisions === null && !loading) {
      fetchRevisions();
    }
  }

  async function handleView(timestamp: number) {
    if (viewingTimestamp === timestamp) {
      // Toggle off
      setViewingTimestamp(null);
      setViewContent(null);
      return;
    }

    setViewLoading(true);
    setViewingTimestamp(timestamp);
    setViewContent(null);
    try {
      const res = await fetch(`/api/wiki/${slug}/revisions?timestamp=${timestamp}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Failed to load revision (${res.status})`);
      }
      const data = (await res.json()) as { content: string };
      setViewContent(data.content);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setViewingTimestamp(null);
    } finally {
      setViewLoading(false);
    }
  }

  async function handleRevert(timestamp: number) {
    // BEFORE the confirm, not after: a dialog the owner has to answer is the
    // harm, and the answer changes nothing.
    if (readOnly) return;

    const dateStr = new Date(timestamp).toLocaleString();
    if (!window.confirm(`Revert this page to the version from ${dateStr}? The current content will be saved as a revision first.`)) {
      return;
    }

    setReverting(true);
    setError(null);
    try {
      const res = await fetch(`/api/wiki/${slug}/revisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revert", timestamp }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Revert failed (${res.status})`);
      }
      // Refresh the page to show the reverted content.
      router.refresh();
      // Re-fetch revisions to show the new state.
      setViewingTimestamp(null);
      setViewContent(null);
      await fetchRevisions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setReverting(false);
    }
  }

  return (
    <section className="mt-10 border-t border-foreground/10 pt-6">
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={open}
        aria-controls="revision-history-panel"
        className="flex items-center gap-2 text-sm font-medium text-foreground/50 uppercase tracking-wide hover:text-foreground/70 transition-colors"
      >
        {/* Clock icon */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
        History
        <span className="text-xs font-normal">
          {open ? "▲" : "▼"}
        </span>
      </button>

      {open && (
        <div id="revision-history-panel" className="mt-4">
          {loading && (
            <p className="text-sm text-foreground/50">Loading revisions…</p>
          )}

          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">
              Error: {error}
            </p>
          )}

          {!loading && revisions !== null && revisions.length === 0 && (
            <p className="text-sm text-foreground/50">
              No previous revisions for this page.
            </p>
          )}

          {/* Gated on `canRevert` as well as `readOnly`: the sentence explains a
              control, and `aria-describedby` on that control is the only thing
              that points at it. With Revert hidden — by the realm, or since
              DW-392 by the viewer being signed out or unresolved — it would be
              an orphaned paragraph: a refusal shown to a reader who was never
              offered the action, with zero referrers for its id. */}
          {readOnly &&
            canRevert &&
            !loading &&
            revisions !== null &&
            revisions.length > 0 && (
              <p id={readOnlyNoteId} className="mb-3 text-sm text-foreground/60">
                {REVERT_READ_ONLY_COPY}
              </p>
            )}

          {!loading && revisions !== null && revisions.length > 0 && (
            <ul className="space-y-3">
              {revisions.map((rev) => (
                <RevisionItem
                  key={rev.timestamp}
                  revision={rev}
                  isViewing={viewingTimestamp === rev.timestamp}
                  viewContent={viewingTimestamp === rev.timestamp ? viewContent : null}
                  viewLoading={viewLoading && viewingTimestamp === rev.timestamp}
                  reverting={reverting}
                  canRevert={canRevert}
                  readOnly={readOnly}
                  readOnlyNoteId={readOnlyNoteId}
                  onView={handleView}
                  onRevert={handleRevert}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
