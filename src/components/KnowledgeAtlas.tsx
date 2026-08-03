"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/Alert";
import type {
  KnowledgeKind,
  KnowledgeRecord,
  StructuredKnowledgeGraph,
} from "@/lib/structured-knowledge";

type View = "all" | "decision" | "project" | "person" | "timeline";

const VIEWS: Array<{ value: View; label: string }> = [
  { value: "all", label: "Atlas" },
  { value: "decision", label: "Decisions" },
  { value: "project", label: "Projects" },
  { value: "person", label: "People" },
  { value: "timeline", label: "Timeline" },
];

const KIND_LABEL: Record<KnowledgeKind, string> = {
  person: "person",
  organization: "organization",
  project: "project",
  decision: "decision",
  commitment: "commitment",
  risk: "risk",
  event: "event",
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function recordDate(record: KnowledgeRecord): string | null {
  return record.validFrom ?? record.validTo ?? null;
}

export function KnowledgeAtlas() {
  const [graph, setGraph] = useState<StructuredKnowledgeGraph | null>(null);
  const [view, setView] = useState<View>("all");
  const [query, setQuery] = useState("");
  const [extractSlug, setExtractSlug] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const data = await request<{ graph: StructuredKnowledgeGraph }>("/api/knowledge");
      setGraph(data.graph);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load structured knowledge.");
    }
  }

  useEffect(() => { void load(); }, []);

  async function extract(event: React.FormEvent) {
    event.preventDefault();
    if (!extractSlug.trim()) return;
    setExtracting(true);
    setError(null);
    try {
      const data = await request<{ graph: StructuredKnowledgeGraph }>("/api/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: extractSlug.trim() }),
      });
      setGraph(data.graph);
      setExtractSlug("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not extract this page.");
    } finally {
      setExtracting(false);
    }
  }

  const shown = useMemo(() => {
    const records = graph?.records ?? [];
    const filtered = records.filter((record) => {
      if (view !== "all" && view !== "timeline" && record.kind !== view) return false;
      const needle = query.trim().toLowerCase();
      return !needle || `${record.name} ${record.summary} ${record.status ?? ""}`.toLowerCase().includes(needle);
    });
    return view === "timeline"
      ? filtered.filter((record) => recordDate(record)).sort((a, b) => (recordDate(b) ?? "").localeCompare(recordDate(a) ?? ""))
      : filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [graph, query, view]);

  const counts = graph?.records.reduce<Record<string, number>>((result, record) => {
    result[record.kind] = (result[record.kind] ?? 0) + 1;
    return result;
  }, {}) ?? {};
  const recordsById = new Map(graph?.records.map((record) => [record.id, record]) ?? []);

  return (
    <main className="shell fade" style={{ paddingTop: 46, paddingBottom: 92 }}>
      <div className="spread" style={{ gap: 24, alignItems: "end" }}>
        <div>
          <p className="fmark" style={{ marginBottom: 16 }}>knowledge atlas</p>
          <h1 className="display" style={{ fontSize: "clamp(36px,4.5vw,58px)", margin: 0 }}>
            The structure behind the story.
          </h1>
          <p style={{ color: "var(--ink-2)", fontSize: 17, margin: "11px 0 0", maxWidth: "64ch" }}>
            Derived records never replace your pages. Each object remains traceable to its source and can be rebuilt.
          </p>
        </div>
        <div style={{ textAlign: "right" }}>
          <span className="display" style={{ display: "block", fontSize: 38 }}>{graph?.records.length ?? 0}</span>
          <span className="receipt" style={{ color: "var(--faint)", fontSize: 9.5 }}>source-linked records</span>
        </div>
      </div>

      {error && <div style={{ marginTop: 20 }}><Alert variant="error">{error}</Alert></div>}

      <div className="grid md:grid-cols-[minmax(0,1fr)_auto]" style={{ gap: 12, marginTop: 30, paddingBottom: 18, borderBottom: "1px solid var(--rule)" }}>
        <div className="row" role="tablist" aria-label="Knowledge view" style={{ gap: 6, flexWrap: "wrap" }}>
          {VIEWS.map((item) => (
            <button key={item.value} type="button" role="tab" aria-selected={view === item.value} className="btn ghost" onClick={() => setView(item.value)} style={{ background: view === item.value ? "var(--paper-3)" : undefined }}>
              {item.label}
              {item.value !== "all" && item.value !== "timeline" && (
                <span className="receipt" style={{ marginLeft: 6, color: "var(--faint)", fontSize: 9.5 }}>{counts[item.value] ?? 0}</span>
              )}
            </button>
          ))}
        </div>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter the atlas…" aria-label="Filter structured knowledge" style={{ border: "1px solid var(--rule-strong)", borderRadius: 9, background: "var(--paper-2)", color: "var(--ink)", padding: "9px 12px", minWidth: 210 }} />
      </div>

      {!graph ? (
        <p style={{ color: "var(--muted)", marginTop: 28 }}>Loading the atlas…</p>
      ) : shown.length === 0 ? (
        <div style={{ textAlign: "center", padding: "72px 20px", borderBottom: "1px solid var(--rule)" }}>
          <p className="display" style={{ fontSize: 27, margin: 0 }}>No records in this view.</p>
          <p style={{ color: "var(--muted)", margin: "8px auto 0", maxWidth: "50ch" }}>
            Accepted revisions and new ingests are extracted automatically. You can also process an existing page below.
          </p>
        </div>
      ) : (
        <div className={view === "timeline" ? "" : "grid md:grid-cols-2"} style={{ gap: view === "timeline" ? 0 : 18, marginTop: 24 }}>
          {shown.map((record) => (
            <article key={record.id} style={{ padding: view === "timeline" ? "20px 0 20px 26px" : 20, border: view === "timeline" ? 0 : "1px solid var(--rule)", borderBottom: view === "timeline" ? "1px solid var(--rule)" : undefined, borderLeft: view === "timeline" ? "2px solid var(--accent)" : undefined, background: view === "timeline" ? "transparent" : "var(--paper-2)", borderRadius: view === "timeline" ? 0 : 12 }}>
              <div className="spread" style={{ gap: 12 }}>
                <span className="receipt" style={{ color: record.kind === "risk" ? "var(--rust)" : "var(--accent)", fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".1em" }}>
                  {KIND_LABEL[record.kind]}
                </span>
                {recordDate(record) && <time className="receipt" style={{ color: "var(--faint)", fontSize: 10 }}>{recordDate(record)}</time>}
              </div>
              <h2 className="display" style={{ fontSize: 22, margin: "9px 0 0" }}>{record.name}</h2>
              <p style={{ color: "var(--ink-2)", fontSize: 14, lineHeight: 1.6, margin: "8px 0 0" }}>{record.summary}</p>
              <div className="row" style={{ gap: 10, flexWrap: "wrap", marginTop: 13 }}>
                {record.status && <span className="receipt" style={{ color: "var(--muted)", fontSize: 10 }}>status · {record.status}</span>}
                {record.sourceSlugs.map((slug) => (
                  <Link key={slug} href={`/u/${encodeURIComponent(record.owner)}/${encodeURIComponent(slug)}`} className="receipt" style={{ color: "var(--accent)", fontSize: 10 }}>source · {slug}</Link>
                ))}
                <span className="receipt" style={{ color: "var(--faint)", fontSize: 10 }}>{record.evidenceIds.length} citation{record.evidenceIds.length === 1 ? "" : "s"}</span>
              </div>
            </article>
          ))}
        </div>
      )}

      {graph && graph.relations.length > 0 && (
        <section style={{ marginTop: 38 }}>
          <div className="spread" style={{ gap: 14, paddingBottom: 13, borderBottom: "1px solid var(--rule)" }}>
            <div><p className="fmark">relationship ledger</p><h2 className="display" style={{ fontSize: 27, margin: "8px 0 0" }}>How the records connect</h2></div>
            <span className="receipt" style={{ color: "var(--faint)", fontSize: 9.5 }}>{graph.relations.length} relationships</span>
          </div>
          {graph.relations.slice(0, 50).map((relation) => {
            const from = recordsById.get(relation.fromId);
            const to = recordsById.get(relation.toId);
            if (!from || !to) return null;
            return (
              <article key={relation.id} className="grid sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]" style={{ gap: 14, padding: "16px 0", borderBottom: "1px solid var(--rule)", alignItems: "center" }}>
                <div><span className="receipt" style={{ color: "var(--faint)", fontSize: 9 }}>{from.kind}</span><strong style={{ display: "block", fontSize: 14, marginTop: 3 }}>{from.name}</strong></div>
                <div style={{ textAlign: "center" }}><span className="receipt" style={{ color: "var(--accent)", fontSize: 9.5 }}>{relation.type} →</span>{(relation.validFrom || relation.validTo) && <span className="receipt" style={{ display: "block", color: "var(--faint)", fontSize: 8.5, marginTop: 4 }}>{relation.validFrom ?? "…"} to {relation.validTo ?? "present"}</span>}</div>
                <div className="sm:text-right"><span className="receipt" style={{ color: "var(--faint)", fontSize: 9 }}>{to.kind}</span><strong style={{ display: "block", fontSize: 14, marginTop: 3 }}>{to.name}</strong></div>
              </article>
            );
          })}
        </section>
      )}

      <form onSubmit={extract} className="grid sm:grid-cols-[minmax(0,1fr)_auto]" style={{ gap: 10, marginTop: 36, paddingTop: 24, borderTop: "1px solid var(--rule)" }}>
        <label style={{ display: "grid", gap: 6, fontSize: 12, color: "var(--muted)" }}>
          Extract an existing private page by slug
          <input value={extractSlug} onChange={(event) => setExtractSlug(event.target.value)} placeholder="meeting-notes" style={{ border: "1px solid var(--rule-strong)", borderRadius: 9, background: "var(--paper-2)", color: "var(--ink)", padding: "10px 12px", font: "inherit" }} />
        </label>
        <button className="btn primary" type="submit" disabled={extracting || !extractSlug.trim()} style={{ alignSelf: "end" }}>
          {extracting ? "Extracting…" : "Extract structure"}
        </button>
      </form>
    </main>
  );
}
