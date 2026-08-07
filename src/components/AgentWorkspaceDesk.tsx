"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  AgentInteractionRequest,
  AgentRunWorkspace,
  AgentSandboxApproval,
} from "@/lib/agent-workspaces";

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

export function AgentWorkspaceDesk() {
  const [workspaces, setWorkspaces] = useState<AgentRunWorkspace[]>([]);
  const [interactions, setInteractions] = useState<AgentInteractionRequest[]>([]);
  const [approvals, setApprovals] = useState<AgentSandboxApproval[]>([]);
  const [values, setValues] = useState<Record<string, Record<string, string | number | boolean>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pendingInteractions = interactions.filter((item) => item.status === "pending");
  const visibleApprovals = [
    ...approvals.filter((item) => item.status === "pending" || item.status === "executing"),
    ...approvals.filter((item) => item.status !== "pending" && item.status !== "executing"),
  ].slice(0, 8);

  const load = useCallback(async () => {
    try {
      const [workspaceData, interactionData, approvalData] = await Promise.all([
        json<{ workspaces: AgentRunWorkspace[] }>("/api/agent-workspaces"),
        json<{ interactions: AgentInteractionRequest[] }>("/api/agent-interactions"),
        json<{ approvals: AgentSandboxApproval[] }>("/api/agent-sandbox-approvals"),
      ]);
      setWorkspaces(workspaceData.workspaces);
      setInteractions(interactionData.interactions);
      setApprovals(approvalData.approvals);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load agent workspaces.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function submit(interaction: AgentInteractionRequest) {
    setBusy(interaction.id);
    setError(null);
    try {
      await json(`/api/agent-interactions/${interaction.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: values[interaction.id] ?? {} }),
      });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not submit input.");
    } finally {
      setBusy(null);
    }
  }

  async function remove(workspace: AgentRunWorkspace) {
    if (!window.confirm(`Delete the private run workspace for ${workspace.agentId}?`)) return;
    setBusy(workspace.id);
    setError(null);
    try {
      await json(`/api/agent-workspaces?id=${encodeURIComponent(workspace.id)}`, { method: "DELETE" });
      setWorkspaces((current) => current.filter((item) => item.id !== workspace.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete the workspace.");
    } finally {
      setBusy(null);
    }
  }

  async function decide(approval: AgentSandboxApproval, decision: "approve" | "reject") {
    if (decision === "approve" && !window.confirm(`Run this exact command in the isolated sandbox?\n\n${approval.command}`)) return;
    setBusy(approval.id);
    setError(null);
    try {
      await json(`/api/agent-sandbox-approvals/${approval.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not process the command approval.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section id="agent-workspace" style={{ marginTop: 54, paddingTop: 28, borderTop: "1px solid var(--rule)" }}>
      <p className="fmark">agent workspace</p>
      <h2 className="display" style={{ fontSize: 30, margin: "10px 0 6px" }}>Runs, files, and requested input</h2>
      <p style={{ margin: 0, color: "var(--muted)", maxWidth: "65ch" }}>
        Every run keeps a private response and receipt. When an agent needs a decision, its form pauses here and resumes only after you submit it.
      </p>
      {error ? <p style={{ color: "var(--rust)" }}>{error}</p> : null}

      <div className="stack" style={{ gap: 12, marginTop: 22 }}>
        <div className="row" style={{ justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
          <span className="receipt" style={{ fontSize: 10 }}>COMMAND APPROVAL DOCKET</span>
          <span className="receipt" style={{ fontSize: 9.5, color: "var(--faint)" }}>
            {approvals.filter((item) => item.status === "pending").length} waiting
          </span>
        </div>
        {approvals.length === 0 ? (
          <p style={{ color: "var(--faint)", fontSize: 13 }}>No sandbox commands have been requested.</p>
        ) : visibleApprovals.map((approval) => (
          <article className={`agent-command-docket is-${approval.status}`} key={approval.id}>
            <div className="agent-command-docket-head">
              <div>
                <span className="receipt">{approval.status.replace("-", " ")}</span>
                <h3>{approval.purpose}</h3>
              </div>
              <span className="receipt">{approval.agentId}</span>
            </div>
            <pre><code>{approval.command}</code></pre>
            <dl className="agent-command-facts">
              <div><dt>Input files</dt><dd>{approval.files.length || "None"}</dd></div>
              <div><dt>Expected outputs</dt><dd>{approval.outputFiles.length || "None"}</dd></div>
              <div><dt>Time limit</dt><dd>{Math.round(approval.timeoutMs / 1_000)} seconds</dd></div>
              <div><dt>Requested</dt><dd>{new Date(approval.createdAt).toLocaleString()}</dd></div>
            </dl>
            {approval.files.length > 0 ? (
              <p className="receipt agent-command-manifest">
                Inputs: {approval.files.map((file) => `${file.filename} (${Math.max(1, Math.round(file.size / 1_024))} KB)`).join(" · ")}
              </p>
            ) : null}
            {approval.outputFiles.length > 0 ? (
              <p className="receipt agent-command-manifest">Outputs: {approval.outputFiles.join(" · ")}</p>
            ) : null}
            {approval.result ? (
              <details className="agent-command-result">
                <summary>Execution receipt · {approval.result.exitCode === undefined ? "did not start" : `exit ${approval.result.exitCode}`} · {(approval.result.durationMs / 1_000).toFixed(1)}s</summary>
                {approval.result.stdout ? <pre><code>{approval.result.stdout}</code></pre> : null}
                {approval.result.stderr ? <pre className="is-error"><code>{approval.result.stderr}</code></pre> : null}
                {approval.result.artifacts.length > 0 ? <p>Saved files: {approval.result.artifacts.join(", ")}</p> : null}
              </details>
            ) : null}
            {approval.status === "pending" ? (
              <div className="agent-command-actions">
                <button className="btn primary" type="button" disabled={busy === approval.id} onClick={() => void decide(approval, "approve")}>
                  {busy === approval.id ? "Processing…" : "Approve exact command"}
                </button>
                <button className="btn ghost" type="button" disabled={busy === approval.id} onClick={() => void decide(approval, "reject")}>Reject</button>
              </div>
            ) : null}
          </article>
        ))}
      </div>

      <div className="grid lg:grid-cols-2" style={{ gap: 24, marginTop: 22 }}>
        <div className="stack" style={{ gap: 12 }}>
          <span className="receipt" style={{ fontSize: 10 }}>INPUT REQUESTS</span>
          {pendingInteractions.length === 0 ? (
            <p style={{ color: "var(--faint)", fontSize: 13 }}>No agent is waiting for input.</p>
          ) : pendingInteractions.map((interaction) => (
            <form key={interaction.id} onSubmit={(event) => { event.preventDefault(); void submit(interaction); }} style={{ border: "1px solid var(--rule)", borderRadius: 14, padding: 16, background: "var(--paper-2)" }}>
              <strong>{interaction.title}</strong>
              {interaction.description ? <p style={{ color: "var(--muted)", fontSize: 13 }}>{interaction.description}</p> : null}
              <div className="stack" style={{ gap: 10 }}>
                {interaction.fields.map((field) => (
                  <label key={field.id} style={{ fontSize: 12.5, color: "var(--muted)" }}>
                    {field.label}{field.required ? " *" : ""}
                    {field.type === "select" ? (
                      <select required={field.required} value={String(values[interaction.id]?.[field.id] ?? "")} onChange={(event) => setValues((current) => ({ ...current, [interaction.id]: { ...current[interaction.id], [field.id]: event.target.value } }))} style={{ display: "block", width: "100%", marginTop: 5, padding: 9, border: "1px solid var(--rule-strong)", borderRadius: 8, background: "var(--paper)" }}>
                        <option value="">Choose…</option>
                        {field.options?.map((option) => <option key={option}>{option}</option>)}
                      </select>
                    ) : field.type === "checkbox" ? (
                      <input type="checkbox" checked={values[interaction.id]?.[field.id] === true} onChange={(event) => setValues((current) => ({ ...current, [interaction.id]: { ...current[interaction.id], [field.id]: event.target.checked } }))} style={{ marginLeft: 8 }} />
                    ) : field.type === "textarea" ? (
                      <textarea required={field.required} value={String(values[interaction.id]?.[field.id] ?? "")} onChange={(event) => setValues((current) => ({ ...current, [interaction.id]: { ...current[interaction.id], [field.id]: event.target.value } }))} rows={3} style={{ display: "block", width: "100%", marginTop: 5, padding: 9, border: "1px solid var(--rule-strong)", borderRadius: 8, background: "var(--paper)" }} />
                    ) : (
                      <input type={field.type} required={field.required} value={String(values[interaction.id]?.[field.id] ?? "")} onChange={(event) => setValues((current) => ({ ...current, [interaction.id]: { ...current[interaction.id], [field.id]: field.type === "number" && event.target.value !== "" ? event.target.valueAsNumber : event.target.value } }))} style={{ display: "block", width: "100%", marginTop: 5, padding: 9, border: "1px solid var(--rule-strong)", borderRadius: 8, background: "var(--paper)" }} />
                    )}
                    {field.help ? <small style={{ display: "block", marginTop: 3 }}>{field.help}</small> : null}
                  </label>
                ))}
              </div>
              <button className="btn primary" type="submit" disabled={busy === interaction.id} style={{ marginTop: 12 }}>{busy === interaction.id ? "Resuming…" : "Submit and resume"}</button>
            </form>
          ))}
        </div>

        <div className="stack" style={{ gap: 12 }}>
          <span className="receipt" style={{ fontSize: 10 }}>RECENT RUN FILES</span>
          {workspaces.length === 0 ? <p style={{ color: "var(--faint)", fontSize: 13 }}>Run an agent to create its first workspace.</p> : workspaces.slice(0, 12).map((workspace) => (
            <div key={workspace.id} style={{ borderBottom: "1px solid var(--rule)", paddingBottom: 12 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>{workspace.agentId}</div>
              <div className="receipt" style={{ marginTop: 4, fontSize: 9.5, color: workspace.status === "failed" ? "var(--rust)" : "var(--faint)" }}>{workspace.status} · {new Date(workspace.createdAt).toLocaleString()}</div>
              <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                {workspace.artifacts.map((artifact) => (
                  <a key={artifact.id} className="receipt" href={`/api/agent-workspaces/${workspace.id}/artifacts/${artifact.id}`} style={{ color: "var(--accent)", fontSize: 9.5 }}>{artifact.filename}</a>
                ))}
                <button type="button" className="receipt" disabled={busy === workspace.id} onClick={() => void remove(workspace)} style={{ color: "var(--rust)", fontSize: 9.5 }}>{busy === workspace.id ? "Deleting…" : "Delete workspace"}</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
