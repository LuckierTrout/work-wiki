"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/Alert";
import { MonitorDigestPanel } from "@/components/MonitorDigestPanel";
import type {
  SourceMonitor,
  SourceMonitorCadence,
  SourceMonitorRunResult,
} from "@/lib/source-monitors";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function when(value: string | null | undefined): string {
  if (!value) return "not scheduled";
  return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function SourceMonitorDesk() {
  const [monitors, setMonitors] = useState<SourceMonitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [targetSlug, setTargetSlug] = useState("");
  const [cadence, setCadence] = useState<SourceMonitorCadence>("daily");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await request<{ monitors: SourceMonitor[] }>("/api/monitors");
      setMonitors(data.monitors);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load monitored sources.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function addMonitor(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || !url.trim() || !targetSlug.trim()) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const data = await request<{ monitor: SourceMonitor }>("/api/monitors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, url, targetSlug, cadence }),
      });
      setMonitors((current) => [data.monitor, ...current]);
      setName("");
      setUrl("");
      setTargetSlug("");
      setNotice("Source added. Its first check establishes a baseline; later meaningful changes enter Review.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not add this source.");
    } finally {
      setSaving(false);
    }
  }

  async function patchMonitor(id: string, patch: Partial<SourceMonitor>) {
    setError(null);
    try {
      const data = await request<{ monitor: SourceMonitor }>(`/api/monitors/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      setMonitors((current) => current.map((monitor) => monitor.id === id ? data.monitor : monitor));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update this source.");
    }
  }

  async function runMonitor(id: string) {
    setRunningId(id);
    setError(null);
    setNotice(null);
    try {
      const data = await request<{ result: SourceMonitorRunResult }>(`/api/monitors/${id}/run`, { method: "POST" });
      setMonitors((current) => current.map((monitor) => monitor.id === id ? data.result.monitor : monitor));
      setNotice(
        data.result.outcome === "proposal-created"
          ? "A meaningful change was found. The proposed revision is waiting in Review."
          : data.result.outcome === "initialized"
            ? "Baseline captured. Future meaningful changes will create review proposals."
            : data.result.outcome === "minor-change"
              ? "A small change was recorded below your review threshold."
              : "No source change was found.",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not check this source.");
      await load();
    } finally {
      setRunningId(null);
    }
  }

  async function removeMonitor(id: string) {
    if (!window.confirm("Stop monitoring this source? Existing review history will remain.")) return;
    try {
      await request(`/api/monitors/${id}`, { method: "DELETE" });
      setMonitors((current) => current.filter((monitor) => monitor.id !== id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not remove this source.");
    }
  }

  const active = monitors.filter((monitor) => monitor.state === "active").length;
  const errors = monitors.filter((monitor) => monitor.state === "error").length;

  return (
    <div className="shell paper-route fade" style={{ paddingTop: 46, paddingBottom: 92 }}>
      <div className="spread" style={{ gap: 24, alignItems: "end" }}>
        <div>
          <p className="fmark" style={{ marginBottom: 16 }}>source watch</p>
          <h1 className="display" style={{ fontSize: "clamp(36px,4.5vw,58px)", margin: 0 }}>
            Let sources come back to you.
          </h1>
          <p style={{ color: "var(--ink-2)", fontSize: 17, margin: "11px 0 0", maxWidth: "64ch" }}>
            Monitor durable URLs. work-wiki filters minor noise and drafts a cited update only when the meaning changes.
          </p>
        </div>
        <div className="row" style={{ gap: 22 }}>
          <div style={{ textAlign: "right" }}>
            <span className="display" style={{ display: "block", fontSize: 30 }}>{active}</span>
            <span className="receipt" style={{ color: "var(--faint)", fontSize: 9.5 }}>active</span>
          </div>
          <div style={{ textAlign: "right" }}>
            <span className="display" style={{ display: "block", fontSize: 30, color: errors ? "var(--rust)" : "var(--muted)" }}>{errors}</span>
            <span className="receipt" style={{ color: "var(--faint)", fontSize: 9.5 }}>need attention</span>
          </div>
        </div>
      </div>

      <form onSubmit={addMonitor} style={{ marginTop: 32, padding: "22px", background: "var(--paper-2)", border: "1px solid var(--rule)", borderRadius: 14 }}>
        <div className="spread" style={{ gap: 16, alignItems: "baseline" }}>
          <h2 className="display" style={{ fontSize: 22, margin: 0 }}>Watch a source</h2>
          <span className="receipt" style={{ color: "var(--faint)", fontSize: 9.5 }}>owner-private configuration</span>
        </div>
        <div className="grid md:grid-cols-2" style={{ gap: 12, marginTop: 17 }}>
          <label style={{ display: "grid", gap: 6, fontSize: 12, color: "var(--muted)" }}>
            Source name
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Quarterly product brief" style={inputStyle} />
          </label>
          <label style={{ display: "grid", gap: 6, fontSize: 12, color: "var(--muted)" }}>
            Existing wiki page slug
            <input value={targetSlug} onChange={(event) => setTargetSlug(event.target.value)} placeholder="product-roadmap" style={inputStyle} />
          </label>
          <label style={{ display: "grid", gap: 6, fontSize: 12, color: "var(--muted)" }}>
            Public source URL
            <input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/brief" style={inputStyle} />
          </label>
          <label style={{ display: "grid", gap: 6, fontSize: 12, color: "var(--muted)" }}>
            Check cadence
            <select value={cadence} onChange={(event) => setCadence(event.target.value as SourceMonitorCadence)} style={inputStyle}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="manual">Manual only</option>
            </select>
          </label>
        </div>
        <div className="row" style={{ justifyContent: "end", marginTop: 14 }}>
          <button className="btn primary" type="submit" disabled={saving || !name.trim() || !url.trim() || !targetSlug.trim()}>
            {saving ? "Adding…" : "Add source"}
          </button>
        </div>
      </form>

      {error && <div style={{ marginTop: 18 }}><Alert variant="error">{error}</Alert></div>}
      {notice && <div style={{ marginTop: 18 }}><Alert variant="success">{notice} <Link href="/review" className="underline">Open Review</Link></Alert></div>}

      <MonitorDigestPanel />

      <div style={{ marginTop: 34, borderTop: "1px solid var(--rule)" }}>
        {loading ? (
          <p style={{ color: "var(--muted)", marginTop: 28 }}>Loading source watches…</p>
        ) : monitors.length === 0 ? (
          <div style={{ textAlign: "center", padding: "68px 20px", borderBottom: "1px solid var(--rule)" }}>
            <p className="display" style={{ fontSize: 26, margin: 0 }}>No sources are on watch yet.</p>
            <p style={{ color: "var(--muted)", margin: "8px 0 0" }}>Add a source above to establish its first baseline.</p>
          </div>
        ) : monitors.map((monitor) => (
          <article key={monitor.id} className="grid md:grid-cols-[minmax(0,1fr)_auto]" style={{ gap: 22, padding: "22px 0", borderBottom: "1px solid var(--rule)" }}>
            <div style={{ minWidth: 0 }}>
              <div className="row" style={{ gap: 9, flexWrap: "wrap" }}>
                <span className="fresh" style={{ background: monitor.state === "error" ? "var(--rust)" : monitor.state === "paused" ? "var(--faint)" : "var(--accent)" }} />
                <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>{monitor.name}</h2>
                <span className="receipt" style={{ color: monitor.state === "error" ? "var(--rust)" : "var(--faint)", fontSize: 9.5, textTransform: "uppercase" }}>{monitor.state}</span>
              </div>
              <a href={monitor.url} target="_blank" rel="noreferrer" className="receipt" style={{ display: "block", color: "var(--accent)", fontSize: 11, marginTop: 7, overflow: "hidden", textOverflow: "ellipsis" }}>
                {monitor.url} ↗
              </a>
              <div className="row" style={{ gap: 14, flexWrap: "wrap", marginTop: 9 }}>
                <span className="receipt" style={metaStyle}>page · {monitor.targetSlug}</span>
                <span className="receipt" style={metaStyle}>{monitor.cadence}</span>
                <span className="receipt" style={metaStyle}>next · {when(monitor.nextCheckAt)}</span>
                {monitor.lastCheckedAt && <span className="receipt" style={metaStyle}>checked · {when(monitor.lastCheckedAt)}</span>}
              </div>
              {monitor.lastError && <p style={{ color: "var(--rust)", fontSize: 12.5, margin: "10px 0 0" }}>{monitor.lastError}</p>}
              {monitor.lastProposalId && <Link href="/review" style={{ display: "inline-block", color: "var(--accent)", fontSize: 12.5, marginTop: 9 }}>Latest proposed revision →</Link>}
            </div>
            <div className="row" style={{ gap: 7, alignSelf: "start", flexWrap: "wrap", justifyContent: "end" }}>
              <button className="btn primary" type="button" disabled={runningId !== null || monitor.state === "paused"} onClick={() => void runMonitor(monitor.id)}>
                {runningId === monitor.id ? "Checking…" : "Check now"}
              </button>
              <button className="btn ghost" type="button" onClick={() => void patchMonitor(monitor.id, { state: monitor.state === "paused" ? "active" : "paused" })}>
                {monitor.state === "paused" ? "Resume" : "Pause"}
              </button>
              <button className="btn ghost" type="button" onClick={() => void removeMonitor(monitor.id)} style={{ color: "var(--rust)" }}>Remove</button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  border: "1px solid var(--rule-strong)",
  borderRadius: 9,
  background: "var(--paper)",
  color: "var(--ink)",
  padding: "10px 12px",
  font: "inherit",
  fontSize: 14,
};

const metaStyle: React.CSSProperties = {
  color: "var(--faint)",
  fontSize: 9.5,
};
