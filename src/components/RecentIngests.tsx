"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { forgetRecentJobs, getRecentJobIds } from "@/lib/recent-ingests";
import { useSlugTenants } from "@/hooks/useSlugTenants";
import { hostOf } from "@/lib/share-target";

/** A still-running (or failed) job submitted from THIS browser (live status). */
interface InFlight {
  jobId: string;
  status: "queued" | "processing" | "failed";
  url?: string;
  title?: string;
  error?: string;
}

/** A completed ingest from the server ledger (durable, all sources). */
interface LedgerEntry {
  ingest_id: string;
  source_url: string;
  primary_slug: string;
  finished_at: string;
  status: string;
  source_type: string;
  deduped?: boolean;
}

interface EmailJob {
  jobId: string;
  status: "queued" | "processing" | "done" | "failed";
  slug?: string;
  error?: string;
  title?: string;
  createdAt: string;
  email?: {
    from: string;
    subject: string;
    attachmentNames: string[];
  };
}

/**
 * Why the bulk delete refuses, said out loud.
 *
 * CHARACTER-IDENTICAL to `READ_ONLY_REFUSAL.bulkPageDelete`, the sentence
 * `DELETE /api/ingest/history` answers with its 403 — so the owner reads the
 * same words whether the surface stated the refusal or the server did. It is
 * duplicated rather than imported because `read-only.ts` pulls `./config` (the
 * settings/storage graph, and `process.env`), which does not belong in a browser
 * bundle. `read-only-copy-parity.test.ts` compares the two so the duplication
 * cannot drift.
 */
export const BULK_DELETE_READ_ONLY_COPY =
  "Ingested pages cannot be deleted while this deployment is read-only.";

function ago(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Recent ingest activity. The durable list comes from the SERVER ledger
 * (`/api/ingest/history`, scoped to pages the caller can read) so it survives
 * across domains/devices and includes EVERY ingest path — the form, the queue,
 * MCP, and the "Save to work-wiki" bookmarklet/share (which don't touch this
 * browser's localStorage). On top of that, jobs this browser just submitted are
 * polled by id for live status (incl. failures) until they land in the ledger.
 * Refreshes on tab focus so a bookmarklet save made in a popup appears on return.
 */
export function RecentIngests() {
  const { hrefForSlug } = useSlugTenants();
  const [inflight, setInflight] = useState<InFlight[]>([]);
  const [history, setHistory] = useState<LedgerEntry[]>([]);
  const [emailJobs, setEmailJobs] = useState<EmailJob[]>([]);
  const [errored, setErrored] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [deleteNotice, setDeleteNotice] = useState("");
  /**
   * `YOPEDIA_READONLY=1`, as the history GET reported it (DW-265).
   *
   * `/ingest` is `"use client"` from the page down, so this cannot arrive as a
   * prop from a server component — it rides on the answer this list already
   * fetches. Defaults to `false` so a signed-out viewer, a 401, or a failed
   * load renders exactly what it rendered before this existed; the server
   * refuses regardless, and claiming read-only over a fetch that never answered
   * would be a refusal invented on the client.
   */
  const [readOnly, setReadOnly] = useState(false);
  /**
   * The refusal sentence's id, so both refused controls can point at it.
   *
   * `useId()` rather than a literal, matching every other surface in this
   * change: nothing outside this component names the id, and a hand-picked
   * string is one collision away from describing somebody else's node.
   */
  const readOnlyNoteId = useId();

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let polls = 0;

    async function tick() {
      let fetchedEmailJobs: EmailJob[] = [];
      // 1. Durable server history (the source of truth).
      try {
        const res = await fetch("/api/ingest/history?limit=20");
        if (res.ok) {
          const data = (await res.json()) as {
            entries?: LedgerEntry[];
            readOnly?: boolean;
          };
          if (!cancelled) {
            setHistory(Array.isArray(data.entries) ? data.entries : []);
            // Only ever adopted from an OK answer, and only as a boolean: a
            // route that stopped serving the field leaves the list live rather
            // than refusing everything on an `undefined`.
            setReadOnly(data.readOnly === true);
            setErrored(false);
          }
        } else if (res.status !== 401) {
          // 401 = signed out (expected → stay quiet). Anything else is a real
          // fault: don't let a 500ing ledger look like "no recent ingests".
          console.warn("[recent-ingests] history fetch failed:", res.status);
          if (!cancelled) setErrored(true);
        }
      } catch (err) {
        // Keep the last-known history, but record the fault so a persistent
        // outage isn't invisible (esp. an empty first load).
        console.warn("[recent-ingests] history fetch error:", err);
        if (!cancelled) setErrored(true);
      }

      // 2. Email-created jobs are not tied to this browser's localStorage. They
      //    are owner-scoped on the server and carry sender/attachment metadata
      //    that must never be exposed through the global ingest ledger.
      try {
        const res = await fetch("/api/ingest/jobs?source=email&limit=20");
        if (res.ok) {
          const data = (await res.json()) as { jobs?: EmailJob[] };
          fetchedEmailJobs = Array.isArray(data.jobs) ? data.jobs : [];
          if (!cancelled) {
            setEmailJobs(fetchedEmailJobs);
          }
        } else if (res.status !== 401) {
          console.warn("[recent-ingests] email jobs fetch failed:", res.status);
          if (!cancelled) setErrored(true);
        }
      } catch (err) {
        console.warn("[recent-ingests] email jobs fetch error:", err);
        if (!cancelled) setErrored(true);
      }

      // 3. This browser's in-flight (and just-failed) jobs (live status until
      //    success lands in the ledger above).
      const ids = getRecentJobIds();
      const results = ids.length
        ? await Promise.all(
            ids.map(async (id) => {
              try {
                const r = await fetch(`/api/ingest/status/${id}`);
                if (!r.ok) return null;
                return { jobId: id, ...(await r.json()) } as InFlight & {
                  status: string;
                };
              } catch {
                return null;
              }
            }),
          )
        : [];
      if (cancelled) return;
      // Keep queued/processing (live) AND failed (so a failure isn't silent);
      // drop "done" — those surface via the ledger, avoiding a duplicate row.
      const live = results.filter(
        (j): j is InFlight =>
          j !== null &&
          (j.status === "queued" || j.status === "processing" || j.status === "failed"),
      );
      setInflight(live);

      // Keep refreshing while a job is still running (so its completion shows in
      // the ledger), bounded so a stuck job can't drive an endless background loop.
      polls += 1;
      const stillRunning = live.some(
        (j) => j.status === "queued" || j.status === "processing",
      ) || fetchedEmailJobs.some(
        (j) => j.status === "queued" || j.status === "processing",
      );
      if (polls < 90 && stillRunning) timer = setTimeout(tick, 4000);
    }

    tick();
    // A bookmarklet/share save happens in another tab/popup — refresh on return.
    const onFocus = () => {
      polls = 0;
      tick();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const historyEntries = history.filter((entry) => entry.source_type !== "email");
  const terminalEmailJobs = emailJobs.filter(
    (job) => job.status === "done" || job.status === "failed",
  );
  const failedBrowserJobs = inflight.filter((job) => job.status === "failed");
  const selectableKeys = [
    ...new Set([
      ...terminalEmailJobs.map((job) => `job:${job.jobId}`),
      ...failedBrowserJobs.map((job) => `job:${job.jobId}`),
      ...historyEntries.map((entry) => `ingest:${entry.ingest_id}`),
    ]),
  ];
  const selectedCount = selectableKeys.filter((key) => selected.has(key)).length;
  const allSelected = selectableKeys.length > 0 && selectedCount === selectableKeys.length;

  function toggleSelected(key: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setDeleteError("");
    setDeleteNotice("");
  }

  function leaveSelectionMode() {
    setSelectionMode(false);
    setSelected(new Set());
    setDeleteError("");
  }

  async function deleteSelected() {
    // BEFORE the confirm, not after (DW-149's rule): the server answers 403
    // either way, and asking the owner to accept "permanently removed" for a
    // delete that cannot happen is the exact harm this gate exists to remove.
    // The entry control below refuses first, so this is the second lock on the
    // same door — reachable if a selection was already open when the answer
    // arrived.
    if (readOnly) return;

    const ingestIds = historyEntries
      .filter((entry) => selected.has(`ingest:${entry.ingest_id}`))
      .map((entry) => entry.ingest_id);
    const jobIds = [
      ...terminalEmailJobs,
      ...failedBrowserJobs,
    ]
      .filter((job, index, jobs) =>
        selected.has(`job:${job.jobId}`) &&
        jobs.findIndex((candidate) => candidate.jobId === job.jobId) === index,
      )
      .map((job) => job.jobId);
    const count = ingestIds.length + jobIds.length;
    if (count === 0 || deleting) return;

    const hasMergedPage = historyEntries.some(
      (entry) => selected.has(`ingest:${entry.ingest_id}`) && entry.deduped,
    );
    const confirmed = window.confirm(
      `Delete ${count} selected ingest${count === 1 ? "" : "s"}?\n\n` +
        "Generated wiki pages and their derived indexes will be permanently removed. " +
        "Raw source snapshots and immutable audit records will be retained." +
        (hasMergedPage
          ? "\n\nAt least one selected ingest was merged; deleting it also deletes its shared canonical page."
          : ""),
    );
    if (!confirmed) return;

    setDeleting(true);
    setDeleteError("");
    setDeleteNotice("");
    try {
      const response = await fetch("/api/ingest/history", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ingestIds, jobIds }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        deletedIngestIds?: string[];
        deletedJobIds?: string[];
        deletedPageSlugs?: string[];
        failed?: { id: string; error: string }[];
      };
      if (!response.ok) {
        throw new Error(data.error || `Delete failed (${response.status})`);
      }

      const deletedIngestIds = new Set(data.deletedIngestIds ?? []);
      const deletedJobIds = new Set(data.deletedJobIds ?? []);
      setHistory((current) =>
        current.filter((entry) => !deletedIngestIds.has(entry.ingest_id)),
      );
      setEmailJobs((current) =>
        current.filter((job) => !deletedJobIds.has(job.jobId)),
      );
      setInflight((current) =>
        current.filter((job) => !deletedJobIds.has(job.jobId)),
      );
      forgetRecentJobs([...deletedJobIds]);

      const failedIds = new Set((data.failed ?? []).map((failure) => failure.id));
      setSelected(
        new Set(
          [...failedIds].map((id) =>
            ingestIds.includes(id) ? `ingest:${id}` : `job:${id}`,
          ),
        ),
      );

      const removedCount = deletedIngestIds.size + deletedJobIds.size;
      const pageCount = data.deletedPageSlugs?.length ?? 0;
      if ((data.failed?.length ?? 0) > 0) {
        setDeleteError(
          `${data.failed!.length} selected item${data.failed!.length === 1 ? "" : "s"} could not be deleted. ${data.failed![0].error}`,
        );
      } else {
        setSelectionMode(false);
        setSelected(new Set());
      }
      setDeleteNotice(
        `${removedCount} ingest record${removedCount === 1 ? "" : "s"} cleared${pageCount > 0 ? ` · ${pageCount} wiki page${pageCount === 1 ? "" : "s"} deleted` : ""}. Raw sources were retained.`,
      );
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Couldn’t delete the selected ingests.");
    } finally {
      setDeleting(false);
    }
  }

  if (
    inflight.length === 0 &&
    history.length === 0 &&
    emailJobs.length === 0 &&
    !deleteNotice &&
    !deleteError
  ) {
    if (!errored) return null;
    // A load error with nothing to show — say so rather than looking empty.
    return (
      <section style={{ marginTop: 36, paddingTop: 24, borderTop: "1px solid var(--rule)" }}>
        <p className="fmark" style={{ marginBottom: 12 }}>
          Recent ingests
        </p>
        <p style={{ fontSize: 13, color: "var(--muted)" }}>
          Couldn’t load recent activity — try again in a moment.
        </p>
      </section>
    );
  }

  return (
    <section style={{ marginTop: 36, paddingTop: 24, borderTop: "1px solid var(--rule)" }}>
      <div
        className="row"
        style={{ justifyContent: "space-between", gap: 12, marginBottom: 12, flexWrap: "wrap" }}
      >
        <p className="fmark" style={{ margin: 0 }}>
          Recent ingests
        </p>
        {selectableKeys.length > 0 && (
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {selectionMode ? (
              <>
                <button
                  type="button"
                  onClick={() => setSelected(allSelected ? new Set() : new Set(selectableKeys))}
                  disabled={deleting}
                  style={{
                    border: 0,
                    background: "transparent",
                    color: "var(--accent)",
                    cursor: deleting ? "not-allowed" : "pointer",
                    fontSize: 12,
                    fontWeight: 600,
                    padding: "4px 6px",
                  }}
                >
                  {allSelected ? "Clear selection" : "Select all"}
                </button>
                <button
                  type="button"
                  onClick={leaveSelectionMode}
                  disabled={deleting}
                  style={{
                    border: 0,
                    background: "transparent",
                    color: "var(--muted)",
                    cursor: deleting ? "not-allowed" : "pointer",
                    fontSize: 12,
                    padding: "4px 6px",
                  }}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                // `aria-disabled`, never `disabled`: the control keeps its place
                // in the tab order so the sentence below can be announced with
                // it — the `ReingestButton` convention. The handler is what
                // actually refuses, and it refuses BEFORE selection mode opens,
                // so the owner never reaches the confirm at all.
                aria-disabled={readOnly || undefined}
                aria-describedby={readOnly ? readOnlyNoteId : undefined}
                onClick={() => {
                  if (readOnly) return;
                  setSelectionMode(true);
                  setDeleteNotice("");
                }}
                style={{
                  border: "1px solid var(--rule)",
                  borderRadius: 999,
                  background: "var(--paper-2)",
                  color: "var(--ink-2)",
                  cursor: readOnly ? "default" : "pointer",
                  fontSize: 12,
                  fontWeight: 600,
                  opacity: readOnly ? 0.55 : 1,
                  padding: "6px 11px",
                }}
              >
                Bulk delete
              </button>
            )}
          </div>
        )}
      </div>
      {/* Identified so every refused control above can point at it: this is the
          only place the reason for their refusal is stated at all. Not
          `role="alert"` — nothing failed; it is the deployment's standing
          state. Rendered before the selection panel, so the refusal is on
          screen ahead of anything that looks like a way into the delete.

          GUARDED ON THERE BEING A CONTROL. The Bulk delete button only renders
          when something is selectable, so on a read-only deployment whose list
          holds nothing deletable this sentence would otherwise stand alone —
          announcing a refusal of an operation the owner was never offered, with
          no control anywhere pointing at it. The `selectionMode` leg is for the
          case where a selection was already open when the answer arrived. */}
      {readOnly && (selectableKeys.length > 0 || selectionMode) && (
        <p
          id={readOnlyNoteId}
          style={{
            color: "var(--muted)",
            fontSize: 12,
            lineHeight: 1.45,
            margin: "0 0 12px",
          }}
        >
          {BULK_DELETE_READ_ONLY_COPY}
        </p>
      )}
      {selectionMode && (
        <div
          style={{
            border: "1px solid color-mix(in srgb, var(--rust) 35%, var(--rule))",
            borderRadius: 12,
            background: "color-mix(in srgb, var(--rust) 5%, var(--paper-2))",
            padding: "12px 14px",
            marginBottom: 12,
          }}
        >
          <div
            className="row"
            style={{ justifyContent: "space-between", alignItems: "center", gap: 14, flexWrap: "wrap" }}
          >
            <div>
              <p style={{ margin: 0, color: "var(--ink)", fontSize: 13.5, fontWeight: 650 }}>
                {selectedCount} selected
              </p>
              <p style={{ margin: "4px 0 0", color: "var(--muted)", fontSize: 11.5, lineHeight: 1.45 }}>
                Deletes generated pages and derived indexes. Raw sources and audit records stay retained.
              </p>
            </div>
            <button
              type="button"
              onClick={deleteSelected}
              // `disabled` stays for the two TRANSIENT/value states it always
              // carried; the standing refusal is `aria-disabled`, and
              // `deleteSelected` early-returns on it.
              disabled={selectedCount === 0 || deleting}
              aria-disabled={readOnly || undefined}
              aria-describedby={readOnly ? readOnlyNoteId : undefined}
              style={{
                border: 0,
                borderRadius: 999,
                background: "var(--rust)",
                color: "white",
                cursor: selectedCount === 0 || deleting ? "not-allowed" : "pointer",
                fontSize: 12,
                fontWeight: 700,
                opacity: selectedCount === 0 || deleting ? 0.45 : 1,
                padding: "8px 13px",
              }}
            >
              {deleting ? "Deleting…" : `Delete selected${selectedCount > 0 ? ` (${selectedCount})` : ""}`}
            </button>
          </div>
        </div>
      )}
      {(deleteNotice || deleteError) && (
        <p
          aria-live="polite"
          style={{
            color: deleteError ? "var(--rust)" : "var(--muted)",
            fontSize: 12,
            lineHeight: 1.45,
            margin: "0 0 12px",
          }}
        >
          {deleteError || deleteNotice}
        </p>
      )}
      <ul className="stack" style={{ gap: 9, listStyle: "none", margin: 0, padding: 0 }}>
        {emailJobs.map((job) => {
          const failed = job.status === "failed";
          const done = job.status === "done";
          const selectable = failed || done;
          const selectionKey = `job:${job.jobId}`;
          const names = job.email?.attachmentNames ?? [];
          return (
            <li
              key={job.jobId}
              style={{
                border: "1px solid var(--rule)",
                borderRadius: 12,
                padding: "10px 12px",
                background: "color-mix(in srgb, var(--accent) 3%, transparent)",
              }}
            >
              <div className="row" style={{ gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                {selectionMode && selectable && (
                  <input
                    type="checkbox"
                    checked={selected.has(selectionKey)}
                    onChange={() => toggleSelected(selectionKey)}
                    aria-label={`Select ingest ${job.email?.subject || job.title || job.jobId}`}
                    style={{ accentColor: "var(--rust)", cursor: "pointer" }}
                  />
                )}
                <span
                  className="receipt"
                  style={{ fontSize: 10.5, color: "var(--accent)", minWidth: 44 }}
                >
                  email
                </span>
                <span
                  className="receipt"
                  style={{ fontSize: 10.5, color: failed ? "var(--rust)" : "var(--muted)" }}
                >
                  {failed ? "failed" : done ? ago(job.createdAt) : job.status === "processing" ? "working…" : "queued"}
                </span>
                {done && job.slug ? (
                  <Link href={hrefForSlug(job.slug)} style={{ color: "var(--accent)", fontSize: 13.5 }}>
                    {job.email?.subject || job.title || job.slug}
                  </Link>
                ) : (
                  <span style={{ fontSize: 13.5, color: "var(--ink-2)" }}>
                    {job.email?.subject || job.title || "Emailed note"}
                  </span>
                )}
                {job.email?.from && (
                  <span className="receipt" style={{ fontSize: 10.5, color: "var(--faint)" }}>
                    from {job.email.from}
                  </span>
                )}
              </div>
              {failed && job.error && (
                <p className="receipt" style={{ margin: "6px 0 0 54px", fontSize: 11.5, color: "var(--rust)" }}>
                  {job.error}
                </p>
              )}
              {names.length > 0 && (
                <p className="receipt" style={{ margin: "6px 0 0 54px", fontSize: 10.5, color: "var(--faint)" }}>
                  {names.join(", ")} · recorded, not processed
                </p>
              )}
            </li>
          );
        })}
        {inflight.map((j) => {
          const failed = j.status === "failed";
          const selectionKey = `job:${j.jobId}`;
          return (
            <li
              key={j.jobId}
              className="row"
              style={{ gap: 10, alignItems: "baseline", flexWrap: "wrap" }}
            >
              {selectionMode && failed && (
                <input
                  type="checkbox"
                  checked={selected.has(selectionKey)}
                  onChange={() => toggleSelected(selectionKey)}
                  aria-label={`Select ingest ${j.title || j.url || j.jobId}`}
                  style={{ accentColor: "var(--rust)", cursor: "pointer" }}
                />
              )}
              <span
                className="receipt"
                style={{ fontSize: 11, color: failed ? "var(--rust)" : "var(--accent)", minWidth: 64 }}
              >
                {failed ? "failed" : j.status === "processing" ? "working…" : "queued"}
              </span>
              <span style={{ fontSize: 13.5, color: "var(--ink-2)", wordBreak: "break-all" }}>
                {j.title || j.url || j.jobId}
              </span>
              {failed && j.error && (
                <span className="receipt" style={{ fontSize: 11.5, color: "var(--rust)" }}>
                  {j.error}
                </span>
              )}
            </li>
          );
        })}
        {historyEntries.map((e) => (
          <li
            key={e.ingest_id}
            className="row"
            style={{ gap: 10, alignItems: "baseline", flexWrap: "wrap" }}
          >
            {selectionMode && (
              <input
                type="checkbox"
                checked={selected.has(`ingest:${e.ingest_id}`)}
                onChange={() => toggleSelected(`ingest:${e.ingest_id}`)}
                aria-label={`Select ingest ${e.primary_slug || e.source_url}`}
                style={{ accentColor: "var(--rust)", cursor: "pointer" }}
              />
            )}
            <span className="receipt" style={{ fontSize: 11, color: "var(--muted)", minWidth: 64 }}>
              {ago(e.finished_at)}
            </span>
            {e.primary_slug ? (
              <Link href={hrefForSlug(e.primary_slug)} style={{ color: "var(--accent)", fontSize: 13.5 }}>
                {e.primary_slug}
              </Link>
            ) : (
              <span style={{ fontSize: 13.5, color: "var(--ink-2)", wordBreak: "break-all" }}>
                {e.source_url}
              </span>
            )}
            {e.source_url && e.source_url !== "text-paste" && e.source_url !== "upload" && (
              <span className="receipt" style={{ fontSize: 11, color: "var(--faint)" }}>
                {hostOf(e.source_url)}
              </span>
            )}
            {e.deduped && (
              <span className="receipt" style={{ fontSize: 11, color: "var(--faint)" }}>
                merged
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
