"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/Alert";
import type {
  MonitorDigest,
  MonitorDigestCadence,
  MonitorDigestSettings,
} from "@/lib/monitor-digests";

interface DigestResponse {
  settings: MonitorDigestSettings;
  digests: MonitorDigest[];
  unread: number;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function when(value: string): string {
  return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function deliveryLabel(digest: MonitorDigest): string {
  switch (digest.email.status) {
    case "disabled": return "in-app only";
    case "pending": return "email pending";
    case "queued": return "email queued";
    case "sending": return "email sending";
    case "sent": return "email sent";
    case "failed": return "email needs retry";
  }
}

export function MonitorDigestPanel() {
  const [settings, setSettings] = useState<MonitorDigestSettings | null>(null);
  const [digests, setDigests] = useState<MonitorDigest[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await request<DigestResponse>("/api/monitor-digests");
      setSettings(data.settings);
      setDigests(data.digests);
      setUnread(data.unread);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load source digests.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (!settings) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const data = await request<{ settings: MonitorDigestSettings }>("/api/monitor-digests", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: settings.enabled,
          cadence: settings.cadence,
          emailEnabled: settings.enabled && settings.emailEnabled,
          emailAddress: settings.emailAddress,
        }),
      });
      setSettings(data.settings);
      setNotice("Digest preferences saved.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save digest preferences.");
    } finally {
      setSaving(false);
    }
  }

  async function generateNow() {
    setGenerating(true);
    setError(null);
    setNotice(null);
    try {
      const data = await request<{ digest: MonitorDigest | null; queued: boolean; message?: string }>(
        "/api/monitor-digests",
        { method: "POST" },
      );
      if (data.digest) {
        setDigests((current) => [data.digest!, ...current.filter((item) => item.id !== data.digest!.id)]);
        setUnread((current) => current + (data.digest?.readAt ? 0 : 1));
        setNotice(data.queued ? "Digest created and its email was queued." : "Digest created in your in-app history.");
      } else {
        setNotice(data.message ?? "There is no new monitor activity to summarize.");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not generate a digest.");
    } finally {
      setGenerating(false);
    }
  }

  async function markRead(id: string) {
    try {
      const data = await request<{ digest: MonitorDigest }>(`/api/monitor-digests/${id}/read`, {
        method: "POST",
      });
      setDigests((current) => current.map((digest) => digest.id === id ? data.digest : digest));
      setUnread((current) => Math.max(0, current - 1));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not mark this digest as read.");
    }
  }

  if (loading || !settings) {
    return <p style={{ color: "var(--muted)", marginTop: 32 }}>Loading digest history…</p>;
  }

  return (
    <section style={{ marginTop: 34, padding: "24px", border: "1px solid var(--rule)", borderRadius: 14, background: "var(--paper)" }}>
      <div className="spread" style={{ gap: 18, alignItems: "start" }}>
        <div>
          <div className="row" style={{ gap: 9 }}>
            <p className="fmark" style={{ margin: 0 }}>source digest</p>
            {unread > 0 && <span className="receipt" style={unreadStyle}>{unread} new</span>}
          </div>
          <h2 className="display" style={{ fontSize: 26, margin: "10px 0 5px" }}>The meaningful changes, in one place.</h2>
          <p style={{ color: "var(--ink-2)", margin: 0, maxWidth: "62ch", fontSize: 14 }}>
            work-wiki groups source checks, proposed revisions, failures, and recoveries. The in-app history is private to your account.
          </p>
        </div>
        <button className="btn ghost" type="button" onClick={() => void generateNow()} disabled={generating}>
          {generating ? "Building…" : "Build digest now"}
        </button>
      </div>

      <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)_auto]" style={{ gap: 14, marginTop: 20, alignItems: "end" }}>
        <label style={fieldStyle}>
          <span>Digest schedule</span>
          <select
            value={settings.cadence}
            disabled={!settings.enabled}
            onChange={(event) => setSettings({ ...settings, cadence: event.target.value as MonitorDigestCadence })}
            style={inputStyle}
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </label>
        <label style={fieldStyle}>
          <span>Delivery email</span>
          <input
            type="email"
            value={settings.emailAddress}
            disabled={!settings.enabled || !settings.emailEnabled}
            onChange={(event) => setSettings({ ...settings, emailAddress: event.target.value })}
            placeholder="you@example.com"
            style={inputStyle}
          />
        </label>
        <button className="btn primary" type="button" onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      <div className="row" style={{ gap: 18, flexWrap: "wrap", marginTop: 13 }}>
        <label style={checkStyle}>
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(event) => setSettings({
              ...settings,
              enabled: event.target.checked,
              emailEnabled: event.target.checked ? settings.emailEnabled : false,
            })}
          />
          Keep an in-app digest history
        </label>
        <label style={{ ...checkStyle, opacity: settings.enabled ? 1 : 0.55 }}>
          <input
            type="checkbox"
            checked={settings.emailEnabled}
            disabled={!settings.enabled}
            onChange={(event) => setSettings({ ...settings, emailEnabled: event.target.checked })}
          />
          Also deliver by email
        </label>
      </div>
      {settings.emailEnabled && (
        <p className="receipt" style={{ color: "var(--faint)", fontSize: 9.5, margin: "10px 0 0" }}>
          Cloudflare must list this destination as a verified Email Routing address before delivery can succeed.
        </p>
      )}

      {error && <div style={{ marginTop: 16 }}><Alert variant="error">{error}</Alert></div>}
      {notice && <div style={{ marginTop: 16 }}><Alert variant="success">{notice}</Alert></div>}

      <div style={{ marginTop: 24, borderTop: "1px solid var(--rule)" }}>
        {digests.length === 0 ? (
          <p style={{ color: "var(--muted)", margin: "22px 0 0" }}>
            No digests yet. Run a source check, then build one now, or let the schedule create it automatically.
          </p>
        ) : digests.map((digest) => (
          <article key={digest.id} style={{ padding: "20px 0", borderBottom: "1px solid var(--rule)" }}>
            <div className="spread" style={{ gap: 18, alignItems: "start" }}>
              <div>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  {!digest.readAt && <span className="fresh" />}
                  <strong style={{ fontSize: 15 }}>{when(digest.createdAt)}</strong>
                  <span className="receipt" style={statusStyle}>{deliveryLabel(digest)}</span>
                </div>
                <p style={{ color: "var(--muted)", fontSize: 12.5, margin: "7px 0 0" }}>
                  {digest.counts.checks} checks · {digest.counts.proposals} proposed updates · {digest.counts.failures} failures · {digest.counts.recoveries} recoveries
                </p>
              </div>
              {!digest.readAt && (
                <button className="btn ghost" type="button" onClick={() => void markRead(digest.id)}>
                  Mark read
                </button>
              )}
            </div>
            {digest.email.error && <p style={{ color: "var(--rust)", fontSize: 12.5, margin: "10px 0 0" }}>{digest.email.error}</p>}
            {digest.entries.length === 0 ? (
              <p style={{ color: "var(--muted)", margin: "13px 0 0", fontSize: 13.5 }}>No sources needed attention.</p>
            ) : (
              <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
                {digest.entries.map((entry, index) => (
                  <div key={`${entry.monitorId}-${entry.kind}-${entry.occurredAt}-${index}`} className="spread" style={{ gap: 14, padding: "10px 12px", background: "var(--paper-2)", borderRadius: 9 }}>
                    <div style={{ minWidth: 0 }}>
                      <span className="receipt" style={{ color: entry.kind === "failure" ? "var(--rust)" : "var(--accent)", fontSize: 9.5 }}>{entry.kind}</span>
                      <p style={{ margin: "3px 0 0", fontSize: 13.5 }}><strong>{entry.monitorName}</strong> · {entry.detail}</p>
                    </div>
                    {entry.kind === "proposal" ? (
                      <Link href="/review" style={entryLinkStyle}>Review →</Link>
                    ) : entry.targetSlug ? (
                      <Link href={`/u/${encodeURIComponent(digest.owner)}/${encodeURIComponent(entry.targetSlug)}`} style={entryLinkStyle}>Open →</Link>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

const fieldStyle: React.CSSProperties = {
  display: "grid",
  gap: 6,
  color: "var(--muted)",
  fontSize: 12,
};

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

const checkStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  color: "var(--ink-2)",
  fontSize: 13,
};

const unreadStyle: React.CSSProperties = {
  color: "var(--accent)",
  border: "1px solid var(--accent)",
  borderRadius: 999,
  padding: "2px 7px",
  fontSize: 9,
};

const statusStyle: React.CSSProperties = {
  color: "var(--faint)",
  border: "1px solid var(--rule)",
  borderRadius: 999,
  padding: "2px 7px",
  fontSize: 9,
};

const entryLinkStyle: React.CSSProperties = {
  color: "var(--accent)",
  fontSize: 12,
  whiteSpace: "nowrap",
};
