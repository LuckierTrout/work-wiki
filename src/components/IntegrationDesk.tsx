"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/Alert";
import type {
  IntegrationOutboxEvent,
  IntegrationSettings,
} from "@/lib/integration-outbox";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

export function IntegrationDesk() {
  const [events, setEvents] = useState<IntegrationOutboxEvent[]>([]);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookEnabled, setWebhookEnabled] = useState(false);
  const [calendarEnabled, setCalendarEnabled] = useState(false);
  const [signingConfigured, setSigningConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await request<{
        settings: IntegrationSettings;
        events: IntegrationOutboxEvent[];
        webhookSigningConfigured: boolean;
      }>("/api/integrations");
      setEvents(data.events);
      setWebhookUrl(data.settings.webhookUrl ?? "");
      setWebhookEnabled(data.settings.webhookEnabled);
      setCalendarEnabled(data.settings.calendarEnabled);
      setSigningConfigured(data.webhookSigningConfigured);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load integrations.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await request<{ settings: IntegrationSettings }>("/api/integrations", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webhookEnabled, webhookUrl, calendarEnabled }),
      });
      setNotice("Integration settings saved. Newly accepted actions will enter the enabled outboxes.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save integration settings.");
    } finally {
      setSaving(false);
    }
  }

  async function retry(id: string) {
    setError(null);
    try {
      const data = await request<{ event: IntegrationOutboxEvent }>(`/api/integrations/${id}/retry`, { method: "POST" });
      setEvents((current) => current.map((event) => event.id === id ? data.event : event));
      setNotice("Delivery queued for retry.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not retry this delivery.");
    }
  }

  const pending = events.filter((event) => event.status === "pending" || event.status === "delivering").length;
  const failed = events.filter((event) => event.status === "failed").length;

  return (
    <div className="shell paper-route fade" style={{ paddingTop: 46, paddingBottom: 92 }}>
      <div className="spread" style={{ gap: 24, alignItems: "end" }}>
        <div>
          <p className="fmark" style={{ marginBottom: 16 }}>dispatch desk</p>
          <h1 className="display" style={{ fontSize: "clamp(36px,4.5vw,58px)", margin: 0 }}>
            Approved actions, safely delivered.
          </h1>
          <p style={{ color: "var(--ink-2)", fontSize: 17, margin: "11px 0 0", maxWidth: "64ch" }}>
            The outbox gives every delivery a stable identity, durable receipt, and retry history.
          </p>
        </div>
        <div className="row" style={{ gap: 20 }}>
          <div style={{ textAlign: "right" }}><span className="display" style={{ display: "block", fontSize: 32 }}>{pending}</span><span className="receipt" style={small}>in flight</span></div>
          <div style={{ textAlign: "right" }}><span className="display" style={{ display: "block", fontSize: 32, color: failed ? "var(--rust)" : "var(--muted)" }}>{failed}</span><span className="receipt" style={small}>failed</span></div>
        </div>
      </div>

      {error && <div style={{ marginTop: 20 }}><Alert variant="error">{error}</Alert></div>}
      {notice && <div style={{ marginTop: 20 }}><Alert variant="success">{notice}</Alert></div>}

      <form onSubmit={save} className="grid md:grid-cols-2" style={{ gap: 18, marginTop: 32 }}>
        <section style={panel}>
          <div className="spread" style={{ gap: 12 }}>
            <div><p className="fmark">webhook</p><h2 className="display" style={{ fontSize: 24, margin: "8px 0 0" }}>Send accepted actions</h2></div>
            <input type="checkbox" aria-label="Enable webhook" checked={webhookEnabled} onChange={(event) => setWebhookEnabled(event.target.checked)} />
          </div>
          <p style={{ color: "var(--muted)", fontSize: 13.5, lineHeight: 1.55 }}>POST a provider-neutral event to your automation endpoint with an idempotency key.</p>
          <label style={{ display: "grid", gap: 6, color: "var(--muted)", fontSize: 12 }}>
            HTTPS endpoint
            <input type="url" value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} placeholder="https://hooks.example.com/workwiki" style={inputStyle} />
          </label>
          <p className="receipt" style={{ color: signingConfigured ? "var(--accent)" : "var(--rust)", fontSize: 9.5, margin: "11px 0 0" }}>
            {signingConfigured ? "HMAC SIGNING CONFIGURED" : "UNSIGNED UNTIL YOPEDIA_WEBHOOK_SIGNING_SECRET IS SET"}
          </p>
        </section>
        <section style={panel}>
          <div className="spread" style={{ gap: 12 }}>
            <div><p className="fmark">iCalendar</p><h2 className="display" style={{ fontSize: 24, margin: "8px 0 0" }}>Portable task calendar</h2></div>
            <input type="checkbox" aria-label="Enable calendar export" checked={calendarEnabled} onChange={(event) => setCalendarEnabled(event.target.checked)} />
          </div>
          <p style={{ color: "var(--muted)", fontSize: 13.5, lineHeight: 1.55 }}>Create one VTODO per accepted action. Import the private file into Apple Calendar, Outlook, or another compatible app.</p>
          <a className="btn ghost" href="/api/integrations/calendar" style={{ marginTop: 9 }}>Download .ics</a>
        </section>
        <div className="row md:col-span-2" style={{ justifyContent: "end" }}>
          <button className="btn primary" type="submit" disabled={saving || loading}>{saving ? "Saving…" : "Save integrations"}</button>
        </div>
      </form>

      <section style={{ marginTop: 38 }}>
        <div className="spread" style={{ gap: 14, paddingBottom: 13, borderBottom: "1px solid var(--rule)" }}>
          <div><p className="fmark">delivery ledger</p><h2 className="display" style={{ fontSize: 27, margin: "8px 0 0" }}>Receipts and retries</h2></div>
          <span className="receipt" style={small}>{events.length} events</span>
        </div>
        {loading ? <p style={{ color: "var(--muted)", marginTop: 24 }}>Loading delivery history…</p> : events.length === 0 ? (
          <div style={{ textAlign: "center", padding: "58px 20px", borderBottom: "1px solid var(--rule)" }}><p className="display" style={{ fontSize: 24, margin: 0 }}>No deliveries yet.</p><p style={{ color: "var(--muted)", margin: "7px 0 0" }}>Accept a proposed task after enabling an integration.</p></div>
        ) : events.map((event) => (
          <article key={event.id} className="grid sm:grid-cols-[minmax(0,1fr)_auto]" style={{ gap: 16, padding: "18px 0", borderBottom: "1px solid var(--rule)" }}>
            <div>
              <div className="row" style={{ gap: 9, flexWrap: "wrap" }}>
                <span className="receipt" style={{ color: event.status === "failed" ? "var(--rust)" : event.status === "delivered" ? "var(--accent)" : "var(--muted)", fontSize: 9.5, textTransform: "uppercase" }}>{event.status}</span>
                <strong style={{ fontSize: 14.5 }}>{event.destination}</strong>
                <span className="receipt" style={small}>attempt {event.attempts}</span>
              </div>
              <p style={{ margin: "7px 0 0", color: "var(--ink-2)", fontSize: 13.5 }}>{String(((event.payload.action ?? {}) as Record<string, unknown>).title ?? event.sourceId)}</p>
              <span className="receipt" style={{ ...small, display: "block", marginTop: 7 }}>idempotency · {event.idempotencyKey.slice(0, 16)}…</span>
              {event.lastError && <p style={{ color: "var(--rust)", fontSize: 12.5, margin: "8px 0 0" }}>{event.lastError}</p>}
            </div>
            {(event.status === "failed" || event.status === "pending") && <button className="btn ghost" type="button" onClick={() => void retry(event.id)} style={{ alignSelf: "start" }}>Retry</button>}
          </article>
        ))}
      </section>
    </div>
  );
}

const panel: React.CSSProperties = { padding: 21, background: "var(--paper-2)", border: "1px solid var(--rule)", borderRadius: 14 };
const inputStyle: React.CSSProperties = { width: "100%", border: "1px solid var(--rule-strong)", borderRadius: 9, background: "var(--paper)", color: "var(--ink)", padding: "10px 12px", font: "inherit", fontSize: 14 };
const small: React.CSSProperties = { color: "var(--faint)", fontSize: 9.5 };
