"use client";

import { useEffect, useState } from "react";

interface EmailSettingsResponse {
  enabled: boolean;
  inboundAddress: string;
  allowedSenders: string[];
  addressConfigured: boolean;
  routingReady: boolean;
  bodyIngestEnabled: boolean;
  attachmentIngestEnabled: boolean;
  destinationVaultId: string;
  destinationAgentId: string;
  vaults: Array<{ id: string; name: string }>;
  agents: Array<{ id: string; name: string }>;
  updatedAt: string | null;
}

type Feedback = { ok: boolean; message: string } | null;

export function EmailIngestSettings() {
  const [settings, setSettings] = useState<EmailSettingsResponse | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [inboundAddress, setInboundAddress] = useState("");
  const [senders, setSenders] = useState("");
  const [destinationVaultId, setDestinationVaultId] = useState("");
  const [destinationAgentId, setDestinationAgentId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/email/settings")
      .then(async (response) => {
        if (!response.ok) throw new Error("Couldn’t load email settings");
        return (await response.json()) as EmailSettingsResponse;
      })
      .then((data) => {
        if (cancelled) return;
        setSettings(data);
        setEnabled(data.enabled);
        setInboundAddress(data.inboundAddress);
        setSenders(data.allowedSenders.join("\n"));
        setDestinationVaultId(data.destinationVaultId);
        setDestinationAgentId(data.destinationAgentId);
      })
      .catch((error) => {
        if (!cancelled) {
          setFeedback({
            ok: false,
            message: error instanceof Error ? error.message : "Couldn’t load email settings",
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const approvedSenders = senders
    .split(/[\n,]/)
    .map((sender) => sender.trim())
    .filter(Boolean);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/email/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          inboundAddress,
          allowedSenders: approvedSenders,
          destinationVaultId,
          destinationAgentId,
        }),
      });
      const data = (await response.json()) as EmailSettingsResponse & { error?: string };
      if (!response.ok) throw new Error(data.error || "Couldn’t save email settings");
      setSettings(data);
      setEnabled(data.enabled);
      setInboundAddress(data.inboundAddress);
      setSenders(data.allowedSenders.join("\n"));
      setDestinationVaultId(data.destinationVaultId);
      setDestinationAgentId(data.destinationAgentId);
      setFeedback({
        ok: true,
        message: data.routingReady
          ? "Email ingestion settings saved."
          : "Settings saved. Cloudflare routing still needs a managed domain before mail can arrive.",
      });
    } catch (error) {
      setFeedback({
        ok: false,
        message: error instanceof Error ? error.message : "Couldn’t save email settings",
      });
    } finally {
      setSaving(false);
    }
  }

  async function copyAddress() {
    if (!inboundAddress) return;
    await navigator.clipboard.writeText(inboundAddress);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  const routingConnected = Boolean(settings?.routingReady);
  const ready = Boolean(routingConnected && settings?.enabled);

  return (
    <section className="mt-12 border-t border-foreground/10 pt-10" aria-labelledby="email-ingest-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="fmark mb-2">Delivery route</p>
          <h2 id="email-ingest-heading" className="text-xl font-semibold tracking-tight text-foreground">
            Email ingestion
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-foreground/60">
            Forward a note to work-wiki and it enters the same queue as a browser ingest.
            Only approved senders are accepted.
          </p>
        </div>
        <span
          className="receipt rounded-full border px-3 py-1.5 text-[11px]"
          style={{
            color: ready ? "var(--accent)" : "var(--muted)",
            borderColor: ready ? "color-mix(in srgb, var(--accent) 35%, transparent)" : "var(--rule-strong)",
          }}
        >
          {loading
            ? "checking…"
            : ready
              ? "accepting mail"
              : routingConnected
                ? "connected · paused"
                : "not connected"}
        </span>
      </div>

      <form
        onSubmit={save}
        className="mt-6 overflow-hidden rounded-2xl border border-foreground/15 bg-foreground/[0.018]"
      >
        <div
          className="flex flex-wrap items-center gap-3 border-b border-dashed border-foreground/15 px-5 py-4"
          style={{ background: "linear-gradient(90deg, color-mix(in srgb, var(--accent) 7%, transparent), transparent 55%)" }}
        >
          <span className="receipt text-[10px] text-foreground/45">TO</span>
          <input
            type="email"
            value={inboundAddress}
            onChange={(event) => {
              setInboundAddress(event.target.value);
              setFeedback(null);
            }}
            placeholder="ingest@yourdomain.com"
            aria-label="work-wiki inbound email address"
            className="min-w-[240px] flex-1 bg-transparent font-mono text-sm text-foreground outline-none placeholder:text-foreground/30"
          />
          <button
            type="button"
            onClick={copyAddress}
            disabled={!inboundAddress}
            className="rounded-md border border-foreground/15 px-3 py-1.5 text-xs text-foreground/65 transition-colors hover:bg-foreground/5 disabled:opacity-40"
          >
            {copied ? "Copied" : "Copy address"}
          </button>
        </div>

        <div className="grid gap-6 px-5 py-5 sm:grid-cols-[1fr_220px]">
          <div>
            <label htmlFor="approved-email-senders" className="block text-sm font-medium text-foreground">
              Approved senders
            </label>
            <p className="mt-1 text-xs leading-5 text-foreground/45">
              One address per line. Messages from every other sender are rejected before ingestion.
            </p>
            <textarea
              id="approved-email-senders"
              value={senders}
              onChange={(event) => {
                setSenders(event.target.value);
                setFeedback(null);
              }}
              rows={4}
              placeholder="you@example.com"
              className="mt-3 w-full resize-y rounded-lg border border-foreground/15 bg-background/60 px-3 py-2 font-mono text-sm text-foreground outline-none transition-colors placeholder:text-foreground/30 focus:border-foreground/35"
            />
          </div>

          <div className="rounded-xl border border-foreground/10 bg-background/45 p-4">
            <p className="receipt text-[10px] text-foreground/45">WHAT HAPPENS</p>
            <ul className="mt-3 space-y-2 text-xs leading-5 text-foreground/60">
              <li>Email subject becomes the page title.</li>
              <li>Body text and links are synthesized.</li>
              <li>Progress appears under Recent ingests.</li>
              <li>
                Markdown, TXT, HTML, PDF, DOCX, PPTX, XLSX, CSV, ZIP, ODT/ODS/ODP, EPUB,
                MOBI, Org, and RTF attachments are included.
              </li>
              <li>A final receipt reports success or failure.</li>
            </ul>
          </div>
        </div>

        <div className="border-t border-dashed border-foreground/15 px-5 py-5">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
            <div>
              <p className="receipt text-[10px] text-foreground/45">DELIVERY DESK</p>
              <h3 className="mt-1 text-sm font-medium text-foreground">
                File accepted mail where it belongs
              </h3>
            </div>
            <p className="max-w-sm text-xs leading-5 text-foreground/45">
              The owner workspace is the default. Choose an agent for scoped knowledge,
              a vault for filing, or both.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm text-foreground/75">
              Knowledge owner
              <select
                value={destinationAgentId}
                onChange={(event) => {
                  setDestinationAgentId(event.target.value);
                  setFeedback(null);
                }}
                className="mt-2 w-full rounded-lg border border-foreground/15 bg-background px-3 py-2.5 text-sm text-foreground outline-none transition-colors focus:border-foreground/35"
              >
                <option value="">Owner workspace</option>
                {(settings?.agents ?? []).map((agent) => (
                  <option key={agent.id} value={agent.id}>{agent.name}</option>
                ))}
              </select>
            </label>
            <label className="text-sm text-foreground/75">
              File in vault
              <select
                value={destinationVaultId}
                onChange={(event) => {
                  setDestinationVaultId(event.target.value);
                  setFeedback(null);
                }}
                className="mt-2 w-full rounded-lg border border-foreground/15 bg-background px-3 py-2.5 text-sm text-foreground outline-none transition-colors focus:border-foreground/35"
              >
                <option value="">No automatic filing</option>
                {(settings?.vaults ?? []).map((vault) => (
                  <option key={vault.id} value={vault.id}>{vault.name}</option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-foreground/10 px-5 py-4">
          <label className="flex cursor-pointer items-center gap-3 text-sm text-foreground/75">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => {
                setEnabled(event.target.checked);
                setFeedback(null);
              }}
              className="h-4 w-4 accent-current"
            />
            Accept email from approved senders
          </label>
          <button
            type="submit"
            disabled={saving || loading}
            className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save email settings"}
          </button>
        </div>
      </form>

      {!settings?.routingReady && !loading && (
        <p className="mt-3 text-xs leading-5 text-amber-700 dark:text-amber-400">
          Cloudflare routing is waiting for a managed domain. You can save the future address and approved senders now; mail will remain off until the route is connected.
        </p>
      )}

      {feedback && (
        <div
          className={`mt-4 rounded-lg border p-3 text-sm ${
            feedback.ok
              ? "border-green-500/20 bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400"
              : "border-red-500/20 bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400"
          }`}
          role="status"
        >
          {feedback.message}
        </div>
      )}
    </section>
  );
}
