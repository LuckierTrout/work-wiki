"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/Alert";
import { SrcChip } from "@/components/folio/primitives";
import type { EvidenceAnchor, EvidenceLocation } from "@/lib/evidence";
import type {
  MemoryChangeProposal,
  MemoryChangeProposalSummary,
  MemoryProposalReview,
  MemoryProposalStatus,
} from "@/lib/memory-proposals";

const TABS: Array<{ value: MemoryProposalStatus | "all"; label: string }> = [
  { value: "pending", label: "Awaiting review" },
  { value: "accepted", label: "Accepted" },
  { value: "rejected", label: "Rejected" },
  { value: "all", label: "All" },
];

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function visibleMarkdown(content: string | null): string {
  if (!content) return "This page does not exist yet.";
  return content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

function formatLocation(location: EvidenceLocation): string {
  switch (location.kind) {
    case "text-range":
      return location.heading
        ? `${location.heading} · characters ${location.start}–${location.end}`
        : `characters ${location.start}–${location.end}`;
    case "document-section":
      return `section · ${location.heading}`;
    case "pdf-page":
      return `PDF · page ${location.page}`;
    case "slide":
      return `slide ${location.slide}${location.section === "speaker-notes" ? " · speaker notes" : ""}`;
    case "spreadsheet":
      return `${location.sheet}${location.range ? ` · ${location.range}` : ""}`;
    case "email":
      return location.section === "attachment"
        ? `email attachment${location.attachmentName ? ` · ${location.attachmentName}` : ""}`
        : `email ${location.section}`;
    case "url-fragment":
      return location.fragment ? `web passage · ${location.fragment}` : "web passage";
  }
}

function safeWebUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function StatusLabel({ proposal }: { proposal: MemoryChangeProposalSummary | MemoryChangeProposal }) {
  const color = proposal.status === "pending"
    ? "var(--accent)"
    : proposal.status === "rejected"
      ? "var(--rust)"
      : "var(--muted)";
  return (
    <span className="receipt" style={{ fontSize: 10, color, textTransform: "uppercase", letterSpacing: ".1em" }}>
      {proposal.status}
    </span>
  );
}

function EvidenceCard({ anchor }: { anchor: EvidenceAnchor }) {
  const href = safeWebUrl(anchor.source.url);
  return (
    <article
      style={{
        padding: "16px 0",
        borderBottom: "1px solid var(--rule)",
      }}
    >
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <SrcChip type={anchor.source.type} />
        <span className="receipt" style={{ fontSize: 10.5, color: "var(--muted)" }}>
          {formatLocation(anchor.location)}
        </span>
      </div>
      <blockquote
        style={{
          margin: "11px 0 0",
          paddingLeft: 14,
          borderLeft: "2px solid var(--accent)",
          color: "var(--ink-2)",
          fontSize: 14,
          lineHeight: 1.6,
        }}
      >
        {anchor.excerpt}
      </blockquote>
      <div style={{ marginTop: 9, fontSize: 12 }}>
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
            Open source ↗
          </a>
        ) : (
          <span className="receipt" style={{ color: "var(--faint)" }}>
            stored source · {anchor.source.filename ?? anchor.source.url}
          </span>
        )}
      </div>
    </article>
  );
}

export function ReviewDesk() {
  const [proposals, setProposals] = useState<MemoryChangeProposalSummary[]>([]);
  const [tab, setTab] = useState<MemoryProposalStatus | "all">("pending");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [review, setReview] = useState<MemoryProposalReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [acting, setActing] = useState<"accept" | "reject" | "revise" | null>(null);
  const [decisionNote, setDecisionNote] = useState("");
  const [editing, setEditing] = useState(false);
  const [proposedBody, setProposedBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadProposals = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await request<{ proposals: MemoryChangeProposalSummary[] }>(
        "/api/review/proposals",
      );
      setProposals(data.proposals);
      const requestedId = new URLSearchParams(window.location.search).get("proposal");
      setSelectedId((current) =>
        current && data.proposals.some((proposal) => proposal.id === current)
          ? current
          : requestedId && data.proposals.some((proposal) => proposal.id === requestedId)
            ? requestedId
          : data.proposals.find((proposal) => proposal.status === "pending")?.id
            ?? data.proposals[0]?.id
            ?? null,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load review proposals.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadProposals(); }, [loadProposals]);

  useEffect(() => {
    if (!selectedId) {
      setReview(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setError(null);
    void request<{ review: MemoryProposalReview }>(`/api/review/proposals/${selectedId}`)
      .then((data) => {
        if (!cancelled) {
          setReview(data.review);
          setProposedBody(visibleMarkdown(data.review.proposal.proposedContent));
          setEditing(false);
        }
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load proposal.");
      })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selectedId]);

  async function decide(action: "accept" | "reject") {
    if (!selectedId) return;
    setActing(action);
    setError(null);
    setNotice(null);
    try {
      await request<{ proposal: MemoryChangeProposal }>(
        `/api/review/proposals/${selectedId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, decisionNote: decisionNote.trim() || undefined }),
        },
      );
      setDecisionNote("");
      await loadProposals();
      const refreshed = await request<{ review: MemoryProposalReview }>(
        `/api/review/proposals/${selectedId}`,
      );
      setReview(refreshed.review);
      setNotice(
        action === "accept"
          ? "Changes accepted. work-wiki will graphify the updated page in the background."
          : "Proposal rejected. The source page was not changed.",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The decision could not be saved.");
    } finally {
      setActing(null);
    }
  }

  async function saveRevision() {
    if (!selectedId) return;
    setActing("revise");
    setError(null);
    try {
      await request<{ proposal: MemoryChangeProposal }>(
        `/api/review/proposals/${selectedId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "revise", proposedBody }),
        },
      );
      const refreshed = await request<{ review: MemoryProposalReview }>(
        `/api/review/proposals/${selectedId}`,
      );
      setReview(refreshed.review);
      setProposedBody(visibleMarkdown(refreshed.review.proposal.proposedContent));
      setEditing(false);
      await loadProposals();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The revised draft could not be saved.");
    } finally {
      setActing(null);
    }
  }

  const shown = tab === "all"
    ? proposals
    : proposals.filter((proposal) => proposal.status === tab);
  const pendingCount = proposals.filter((proposal) => proposal.status === "pending").length;

  return (
    <main className="shell paper-route fade" style={{ paddingTop: 46, paddingBottom: 92 }}>
      <div className="spread" style={{ gap: 24, alignItems: "end" }}>
        <div>
          <p className="fmark" style={{ marginBottom: 16 }}>private review desk</p>
          <h1 className="display" style={{ fontSize: "clamp(36px,4.5vw,58px)", margin: 0 }}>
            Decide what becomes memory.
          </h1>
          <p style={{ color: "var(--ink-2)", fontSize: 17, margin: "11px 0 0", maxWidth: "62ch" }}>
            Automated research can draft changes. Your accepted revision remains the source of truth.
          </p>
        </div>
        <div style={{ textAlign: "right", minWidth: 92 }}>
          <span className="display" style={{ fontSize: 38, color: pendingCount ? "var(--accent)" : "var(--muted)" }}>
            {pendingCount}
          </span>
          <span className="receipt" style={{ display: "block", color: "var(--faint)", fontSize: 10 }}>
            awaiting review
          </span>
        </div>
      </div>

      {error && <div style={{ marginTop: 20 }}><Alert variant="error">{error}</Alert></div>}
      {notice && <div style={{ marginTop: 20 }}><Alert variant="success">{notice}</Alert></div>}

      <div
        className="row"
        role="tablist"
        aria-label="Proposal status"
        style={{ gap: 6, flexWrap: "wrap", marginTop: 30, paddingBottom: 16, borderBottom: "1px solid var(--rule)" }}
      >
        {TABS.map((item) => {
          const count = item.value === "all"
            ? proposals.length
            : proposals.filter((proposal) => proposal.status === item.value).length;
          return (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={tab === item.value}
              className="btn ghost"
              onClick={() => setTab(item.value)}
              style={{ background: tab === item.value ? "var(--paper-3)" : undefined }}
            >
              {item.label}
              <span className="receipt" style={{ marginLeft: 6, color: "var(--faint)", fontSize: 9.5 }}>{count}</span>
            </button>
          );
        })}
      </div>

      {loading ? (
        <p style={{ color: "var(--muted)", marginTop: 30 }}>Opening the review desk…</p>
      ) : proposals.length === 0 ? (
        <div style={{ textAlign: "center", padding: "84px 20px", borderBottom: "1px solid var(--rule)" }}>
          <p className="display" style={{ fontSize: 28, margin: 0 }}>The desk is clear.</p>
          <p style={{ color: "var(--muted)", margin: "9px auto 0", maxWidth: "48ch" }}>
            Monitoring and agents will place proposed memory changes here. Nothing is applied automatically.
          </p>
        </div>
      ) : (
        <div className="grid lg:grid-cols-[minmax(240px,0.72fr)_minmax(0,2fr)]" style={{ minHeight: 640 }}>
          <aside style={{ borderRight: "1px solid var(--rule)" }}>
            {shown.length === 0 ? (
              <p style={{ color: "var(--muted)", padding: "26px 18px 26px 0" }}>No proposals in this view.</p>
            ) : shown.map((proposal) => (
              <button
                key={proposal.id}
                type="button"
                onClick={() => setSelectedId(proposal.id)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  border: 0,
                  borderBottom: "1px solid var(--rule)",
                  borderLeft: selectedId === proposal.id ? "3px solid var(--accent)" : "3px solid transparent",
                  background: selectedId === proposal.id ? "var(--paper-2)" : "transparent",
                  color: "var(--ink)",
                  padding: "18px 18px 18px 15px",
                  cursor: "pointer",
                }}
              >
                <div className="spread" style={{ gap: 10 }}>
                  <StatusLabel proposal={proposal} />
                  <span className="receipt" style={{ color: proposal.risk === "high" ? "var(--rust)" : "var(--faint)", fontSize: 9.5 }}>
                    {proposal.risk} risk
                  </span>
                </div>
                <strong style={{ display: "block", fontSize: 15, lineHeight: 1.35, marginTop: 8 }}>
                  {proposal.title}
                </strong>
                <span style={{ display: "block", color: "var(--muted)", fontSize: 12.5, lineHeight: 1.45, marginTop: 5 }}>
                  {proposal.summary}
                </span>
                <span className="receipt" style={{ display: "block", color: "var(--faint)", fontSize: 9.5, marginTop: 9 }}>
                  {proposal.kind} · {new Date(proposal.createdAt).toLocaleDateString()}
                </span>
              </button>
            ))}
          </aside>

          <section style={{ padding: "28px 0 28px clamp(22px,4vw,48px)" }}>
            {detailLoading || !review ? (
              <p style={{ color: "var(--muted)" }}>Loading proposal…</p>
            ) : (
              <>
                <div className="spread" style={{ gap: 20, alignItems: "start" }}>
                  <div>
                    <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                      <StatusLabel proposal={review.proposal} />
                      <span className="receipt" style={{ color: "var(--faint)", fontSize: 10 }}>
                        {review.proposal.evidenceIds.length} evidence reference{review.proposal.evidenceIds.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <h2 className="display" style={{ fontSize: "clamp(27px,3vw,38px)", margin: "10px 0 0" }}>
                      {review.proposal.title}
                    </h2>
                    <p style={{ color: "var(--ink-2)", margin: "9px 0 0", lineHeight: 1.6 }}>
                      {review.proposal.reason}
                    </p>
                  </div>
                  <Link className="btn ghost" href={`/u/${encodeURIComponent(review.proposal.owner)}/${review.proposal.targetSlug}`}>
                    Open page
                  </Link>
                </div>

                {review.isStale && (
                  <div style={{ marginTop: 20 }}>
                    <Alert variant="warning">
                      This proposal is stale because the live page changed after it was drafted. It cannot be accepted.
                    </Alert>
                  </div>
                )}

                <div style={{ marginTop: 32 }}>
                  <p className="fmark">proposed revision</p>
                  <div className="grid md:grid-cols-2" style={{ gap: 1, background: "var(--rule)", border: "1px solid var(--rule)", marginTop: 12 }}>
                    <div style={{ background: "var(--paper-2)", minWidth: 0 }}>
                      <p className="receipt" style={{ padding: "10px 14px", margin: 0, color: "var(--faint)", fontSize: 9.5, borderBottom: "1px solid var(--rule)" }}>
                        CURRENT
                      </p>
                      <pre style={{ margin: 0, padding: 16, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "var(--font-read)", fontSize: 13, lineHeight: 1.65, color: "var(--muted)", maxHeight: 430, overflow: "auto" }}>
                        {visibleMarkdown(review.currentContent)}
                      </pre>
                    </div>
                    <div style={{ background: "var(--paper)", minWidth: 0 }}>
                      <div className="spread" style={{ padding: "7px 10px 7px 14px", borderBottom: "1px solid var(--rule)", gap: 10 }}>
                        <p className="receipt" style={{ margin: 0, color: "var(--accent)", fontSize: 9.5 }}>
                          PROPOSED · {review.proposal.revisions?.length ?? 0} OWNER EDITS
                        </p>
                        {review.proposal.status === "pending" && !review.isStale && (
                          <button className="btn ghost" type="button" onClick={() => setEditing((value) => !value)} style={{ padding: "5px 9px", fontSize: 11 }}>
                            {editing ? "Cancel edit" : "Edit draft"}
                          </button>
                        )}
                      </div>
                      {editing ? (
                        <div style={{ padding: 12 }}>
                          <textarea
                            aria-label="Proposed page body"
                            value={proposedBody}
                            onChange={(event) => setProposedBody(event.target.value)}
                            rows={18}
                            style={{ width: "100%", resize: "vertical", border: "1px solid var(--rule-strong)", borderRadius: 8, background: "var(--paper-2)", color: "var(--ink)", padding: 12, fontFamily: "var(--font-read)", fontSize: 13, lineHeight: 1.65 }}
                          />
                          <div className="row" style={{ justifyContent: "end", marginTop: 9 }}>
                            <button className="btn primary" type="button" disabled={acting !== null || !proposedBody.trim()} onClick={() => void saveRevision()}>
                              {acting === "revise" ? "Saving…" : "Save revised draft"}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <pre style={{ margin: 0, padding: 16, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "var(--font-read)", fontSize: 13, lineHeight: 1.65, color: "var(--ink-2)", maxHeight: 430, overflow: "auto" }}>
                          {visibleMarkdown(review.proposal.proposedContent)}
                        </pre>
                      )}
                    </div>
                  </div>
                </div>

                <div style={{ marginTop: 34 }}>
                  <div className="spread" style={{ gap: 14 }}>
                    <p className="fmark">evidence marginalia</p>
                    <span className="receipt" style={{ color: "var(--faint)", fontSize: 10 }}>
                      immutable excerpts
                    </span>
                  </div>
                  {review.evidence.length ? review.evidence.map((anchor) => (
                    <EvidenceCard key={anchor.id} anchor={anchor} />
                  )) : (
                    <div style={{ marginTop: 12, padding: 18, background: "var(--paper-2)", borderLeft: "2px solid var(--rust)" }}>
                      <strong style={{ fontSize: 14 }}>No stored excerpt is attached.</strong>
                      <p style={{ color: "var(--muted)", fontSize: 13, margin: "4px 0 0" }}>
                        Treat this proposal as unsupported until its evidence references can be resolved.
                      </p>
                    </div>
                  )}
                </div>

                {review.proposal.status === "pending" && (
                  <div style={{ marginTop: 34, paddingTop: 24, borderTop: "1px solid var(--rule)" }}>
                    <label htmlFor="decision-note" className="receipt" style={{ display: "block", color: "var(--muted)", fontSize: 10, marginBottom: 8 }}>
                      REVIEW NOTE · OPTIONAL
                    </label>
                    <textarea
                      id="decision-note"
                      value={decisionNote}
                      onChange={(event) => setDecisionNote(event.target.value)}
                      placeholder="Record why you accepted or rejected this change…"
                      rows={3}
                      style={{ width: "100%", resize: "vertical", border: "1px solid var(--rule-strong)", borderRadius: 10, background: "var(--paper-2)", color: "var(--ink)", padding: "11px 13px", font: "inherit", fontSize: 14 }}
                    />
                    <div className="row" style={{ gap: 9, justifyContent: "end", marginTop: 12, flexWrap: "wrap" }}>
                      <button className="btn ghost" type="button" disabled={acting !== null} onClick={() => void decide("reject")} style={{ color: "var(--rust)" }}>
                        {acting === "reject" ? "Rejecting…" : "Reject"}
                      </button>
                      <button className="btn primary" type="button" disabled={acting !== null || review.isStale || editing} onClick={() => void decide("accept")}>
                        {acting === "accept" ? "Applying…" : "Accept & graphify"}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
