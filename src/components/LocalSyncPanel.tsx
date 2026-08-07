"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { LocalSyncClient } from "@/lib/local-sync-clients";

interface VaultOption { id: string; name: string }

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function LocalSyncPanel({ vaults }: { vaults: VaultOption[] }) {
  const [clients, setClients] = useState<LocalSyncClient[]>([]);
  const [mode, setMode] = useState<"sources" | "archive">("sources");
  const [folder, setFolder] = useState("/path/to/your/documents");
  const [label, setLabel] = useState("My computer");
  const [vaultId, setVaultId] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await requestJson<{ clients: LocalSyncClient[] }>("/api/sync/status");
      setClients(data.clients);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not load local sync clients.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const command = useMemo(() => {
    const env = [
      "export WORKWIKI_API_TOKEN='paste-your-owner-automation-token'",
      `export WORKWIKI_SYNC_CLIENT=${shellQuote(label.toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "my-computer")}`,
      `export WORKWIKI_SYNC_LABEL=${shellQuote(label || "My computer")}`,
    ];
    if (mode === "archive") {
      env.push(`pnpm sync watch ${shellQuote(folder)}`);
    } else {
      const flags = ["--confirm"];
      if (vaultId) flags.push(`--vault=${shellQuote(vaultId)}`);
      if (tags.trim()) flags.push(`--tags=${shellQuote(tags.trim())}`);
      env.push(`pnpm sync source-watch ${shellQuote(folder)} ${flags.join(" ")}`);
    }
    return env.join("\n");
  }, [folder, label, mode, tags, vaultId]);

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setNotice("Setup command copied. Replace the token placeholder only in your local terminal.");
    } catch {
      setNotice("Copy was blocked. Select the command text and copy it manually.");
    }
  }

  async function remove(client: LocalSyncClient) {
    if (!window.confirm(`Remove “${client.label}” from this status list? This does not stop a companion still running on that computer.`)) return;
    setBusy(client.id);
    try {
      await requestJson(`/api/sync/status?id=${encodeURIComponent(client.id)}`, { method: "DELETE" });
      setClients((current) => current.filter((item) => item.id !== client.id));
      setNotice("Client record removed. Stop its local process separately if it is still running.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not remove the sync client.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="local-sync-panel" aria-labelledby="local-sync-heading">
      <div className="local-sync-heading">
        <div>
          <p className="receipt">Local companion</p>
          <h3 id="local-sync-heading">Configure a watched folder and see when it last checked in.</h3>
          <p>The browser creates the setup recipe; the companion on your computer performs filesystem reads and sends heartbeats here.</p>
        </div>
        <button type="button" className="btn ghost" onClick={() => void load()}>Refresh status</button>
      </div>

      <div className="local-sync-layout">
        <div className="local-sync-builder">
          <div className="local-sync-mode" role="group" aria-label="Sync mode">
            <button type="button" className={mode === "sources" ? "is-active" : ""} aria-pressed={mode === "sources"} onClick={() => setMode("sources")}>
              <strong>Source folder</strong><small>Ingest changed documents</small>
            </button>
            <button type="button" className={mode === "archive" ? "is-active" : ""} aria-pressed={mode === "archive"} onClick={() => setMode("archive")}>
              <strong>Off-account backup</strong><small>Download owner archives</small>
            </button>
          </div>
          <div className="local-sync-fields">
            <label><span>Computer label</span><input className="studio-input" value={label} onChange={(event) => setLabel(event.target.value)} /></label>
            <label><span>{mode === "archive" ? "Backup destination" : "Folder to watch"}</span><input className="studio-input" value={folder} onChange={(event) => setFolder(event.target.value)} /></label>
            {mode === "sources" ? (
              <>
                <label><span>Destination vault</span><select className="studio-input" value={vaultId} onChange={(event) => setVaultId(event.target.value)}><option value="">No default vault</option>{vaults.map((vault) => <option key={vault.id} value={vault.id}>{vault.name}</option>)}</select></label>
                <label><span>Default tags</span><input className="studio-input" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="reference, local-sync" /></label>
              </>
            ) : null}
          </div>
          <div className="local-sync-command">
            <div><span className="receipt">Terminal recipe</span><small>The API token is never stored in this page.</small></div>
            <pre><code>{command}</code></pre>
            <button type="button" className="btn primary" onClick={() => void copyCommand()}>Copy setup command</button>
          </div>
        </div>

        <div className="local-sync-register">
          <div className="local-sync-register-head"><span className="receipt">Connected clients</span><strong>{clients.length}</strong></div>
          {clients.length === 0 ? (
            <div className="studio-empty"><p className="studio-empty-title">No companion has checked in yet</p><p>Run the generated command from the WorkWiki repository. Its first successful operation will appear here.</p></div>
          ) : clients.map((client) => (
            <article key={client.id} className={`local-sync-client is-${client.state}`}>
              <div><span className="local-sync-state" aria-hidden="true" /><div><h4>{client.label}</h4><p>{client.mode === "sources" ? "Source folder" : "Archive backup"} · {client.operation}</p></div></div>
              <dl><div><dt>Last check-in</dt><dd>{new Date(client.lastSeenAt).toLocaleString()}</dd></div>{client.itemCount !== undefined ? <div><dt>Items</dt><dd>{client.itemCount}</dd></div> : null}<div><dt>State</dt><dd>{client.state}</dd></div></dl>
              {client.message ? <p className="local-sync-message">{client.message}</p> : null}
              <button type="button" disabled={busy === client.id} onClick={() => void remove(client)}>{busy === client.id ? "Removing…" : "Remove record"}</button>
            </article>
          ))}
        </div>
      </div>
      {notice ? <div className="studio-note" role="status"><strong>Local sync</strong><span>{notice}</span></div> : null}
    </section>
  );
}
