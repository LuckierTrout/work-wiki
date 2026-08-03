"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { slugify } from "@/lib/slugify";
import type { AgentProfile } from "@/lib/types";

/**
 * Client-safe mirror of `agentShortName` from `@/lib/agents` (a pure fn, but
 * that module pulls in server-only deps, so it can't be imported here). The id
 * is `slugify(owner)--slugify(name)`; strip the unambiguous owner prefix to get
 * the name slug for the `/u/<owner>/a/<name>` URL.
 */
function agentShortName(agent: AgentProfile): string {
  if (!agent.owner) return agent.id;
  const prefix = `${slugify(agent.owner)}--`;
  return agent.id.startsWith(prefix) ? agent.id.slice(prefix.length) : agent.id;
}
import { Avatar, Mark } from "@/components/folio/primitives";
import { AgentTokenPanel } from "@/components/AgentTokenPanel";

interface AgentManagerProps {
  handle: string;
  agents: AgentProfile[];
}

/** Folio text input — mirrors the Ask/Browse console input field. */
function FInput({
  value,
  onChange,
  placeholder,
  multiline,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  multiline?: boolean;
}) {
  const shared = {
    value,
    onChange: (
      e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => onChange(e.target.value),
    placeholder,
    style: {
      width: "100%",
      border: "1px solid var(--rule-strong)",
      borderRadius: 12,
      background: "var(--paper-2)",
      padding: "12px 16px",
      fontSize: 15,
      color: "var(--ink)",
      outline: "none",
      fontFamily: "var(--font-read)",
      resize: "vertical" as const,
    },
  };
  return multiline ? (
    <textarea {...shared} rows={2} />
  ) : (
    <input {...shared} />
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <span className="receipt" style={{ fontSize: 12, color: "var(--rust)" }}>
      {message}
    </span>
  );
}

/** A single agent management card. */
function AgentCard({
  handle,
  agent,
}: {
  handle: string;
  agent: AgentProfile;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<null | "edit" | "token" | "activity">(null);
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const [instructions, setInstructions] = useState(agent.instructions ?? "");
  const [knowledgeScope, setKnowledgeScope] = useState(agent.knowledgeScope ?? "");
  const [trigger, setTrigger] = useState(agent.trigger ?? "manual");
  const [enabled, setEnabled] = useState(agent.enabled ?? false);
  const [searchWiki, setSearchWiki] = useState(
    (agent.allowedTools ?? ["search-wiki"]).includes("search-wiki"),
  );
  const [proposeTasks, setProposeTasks] = useState(
    (agent.allowedTools ?? []).includes("propose-tasks"),
  );
  const [provider, setProvider] = useState(agent.provider ?? "");
  const [model, setModel] = useState(agent.model ?? "");
  const [runPrompt, setRunPrompt] = useState("");
  const [runOutput, setRunOutput] = useState<string | null>(null);
  const [activity, setActivity] = useState<Array<{
    id: string;
    trigger: string;
    output: string;
    toolsUsed: string[];
    createdAt: string;
  }>>([]);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function saveEdit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${agent.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description,
          instructions,
          knowledgeScope,
          trigger,
          enabled,
          allowedTools: [
            ...(searchWiki ? ["search-wiki"] : []),
            ...(proposeTasks ? ["propose-tasks"] : []),
          ],
          provider: provider || null,
          model,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `request failed (${res.status})`);
      }
      setMode(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function runAgent() {
    setRunning(true);
    setError(null);
    setRunOutput(null);
    try {
      const res = await fetch(`/api/agents/${agent.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: runPrompt }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        activity?: { output?: string };
      };
      if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
      setRunOutput(body.activity?.output ?? "Run complete.");
      setRunPrompt("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Agent run failed");
    } finally {
      setRunning(false);
    }
  }

  async function toggleActivity() {
    if (mode === "activity") {
      setMode(null);
      return;
    }
    setMode("activity");
    setError(null);
    try {
      const res = await fetch(`/api/agents/${agent.id}/activity`);
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        activity?: typeof activity;
      };
      if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
      setActivity(body.activity ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Activity could not be loaded");
    }
  }

  async function remove() {
    if (
      !window.confirm(
        `Delete agent "${agent.name}"? This cannot be undone.`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${agent.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `request failed (${res.status})`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        background: "var(--paper-2)",
        border: "1px solid var(--rule)",
        borderRadius: 16,
        padding: 20,
      }}
    >
      <div className="row" style={{ gap: 13, alignItems: "flex-start" }}>
        <Avatar id={agent.id} agent size={30} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
            <Link
              href={`/u/${handle}/a/${agentShortName(agent)}`}
              style={{
                margin: 0,
                fontSize: 19,
                fontWeight: 600,
                letterSpacing: "-.02em",
                color: "var(--ink)",
                textDecoration: "none",
              }}
            >
              {agent.name}
            </Link>
            <Mark id={agent.id} agent />
          </div>
          <p
            style={{
              margin: "6px 0 0",
              fontSize: 14,
              color: "var(--muted)",
              lineHeight: 1.55,
              maxWidth: "60ch",
            }}
          >
            {agent.description}
          </p>
          <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 8 }}>
            <span className="receipt" style={{ fontSize: 9.5, color: "var(--muted)" }}>
              {agent.trigger ?? "manual"}
            </span>
            {(agent.trigger ?? "manual") !== "manual" && (
              <span className="receipt" style={{ fontSize: 9.5, color: agent.enabled ? "var(--accent)" : "var(--faint)" }}>
                {agent.enabled ? "enabled" : "paused"}
              </span>
            )}
            {agent.lastRunAt && (
              <span className="receipt" style={{ fontSize: 9.5, color: "var(--faint)" }}>
                last run {new Date(agent.lastRunAt).toLocaleString()}
              </span>
            )}
          </div>
        </div>
      </div>

      <div
        className="row"
        style={{ gap: 6, flexWrap: "wrap", marginTop: 16 }}
      >
        <button
          type="button"
          className="btn ghost"
          onClick={() => setMode(mode === "edit" ? null : "edit")}
        >
          {mode === "edit" ? "Cancel" : "Edit"}
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={() => setMode(mode === "token" ? null : "token")}
        >
          Token
        </button>
        <button type="button" className="btn ghost" onClick={() => void toggleActivity()}>
          {mode === "activity" ? "Close history" : "History"}
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={remove}
          disabled={busy}
          style={{ color: "var(--rust)" }}
        >
          Delete
        </button>
        {error && <ErrorLine message={error} />}
      </div>

      {mode === "edit" && (
        <div className="stack" style={{ gap: 12, marginTop: 16 }}>
          <FInput value={name} onChange={setName} placeholder="Agent name" />
          <FInput
            value={description}
            onChange={setDescription}
            placeholder="What this agent is"
            multiline
          />
          <FInput
            value={instructions}
            onChange={setInstructions}
            placeholder="Operating instructions: what to look for and what a useful result contains"
            multiline
          />
          <FInput
            value={knowledgeScope}
            onChange={setKnowledgeScope}
            placeholder="Knowledge scope (blank, mine, vault:…, or agent:…)"
          />
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <label style={{ flex: "1 1 190px", fontSize: 13, color: "var(--muted)" }}>
              Provider
              <select value={provider} onChange={(event) => setProvider(event.target.value as typeof provider)} style={{ width: "100%", marginTop: 5, border: "1px solid var(--rule-strong)", borderRadius: 9, background: "var(--paper)", color: "var(--ink)", padding: "9px 10px" }}>
                <option value="">App default</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="google">Google</option>
                <option value="ollama-cloud">Ollama Cloud</option>
                <option value="deepseek">DeepSeek</option>
                <option value="ollama">Ollama</option>
              </select>
            </label>
            <label style={{ flex: "2 1 260px", fontSize: 13, color: "var(--muted)" }}>
              Model override
              <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="Leave blank for provider default" style={{ width: "100%", marginTop: 5, border: "1px solid var(--rule-strong)", borderRadius: 9, background: "var(--paper)", color: "var(--ink)", padding: "9px 10px" }} />
            </label>
          </div>
          <div className="row" style={{ gap: 14, flexWrap: "wrap" }}>
            <label style={{ fontSize: 13, color: "var(--muted)" }}>
              Trigger{" "}
              <select value={trigger} onChange={(event) => setTrigger(event.target.value as typeof trigger)} style={{ marginLeft: 6, border: "1px solid var(--rule-strong)", borderRadius: 8, background: "var(--paper)", color: "var(--ink)", padding: "7px 9px" }}>
                <option value="manual">Manual</option>
                <option value="after-ingest">After ingest</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </label>
            <label className="row" style={{ gap: 6, fontSize: 13, color: "var(--muted)" }}>
              <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
              Enable automatic runs
            </label>
          </div>
          <fieldset style={{ border: "1px solid var(--rule)", borderRadius: 10, padding: "10px 12px" }}>
            <legend className="receipt" style={{ padding: "0 5px", fontSize: 10, color: "var(--faint)" }}>Allowed tools</legend>
            <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
              <label className="row" style={{ gap: 6, fontSize: 13 }}><input type="checkbox" checked={searchWiki} onChange={(event) => setSearchWiki(event.target.checked)} />Search wiki</label>
              <label className="row" style={{ gap: 6, fontSize: 13 }}><input type="checkbox" checked={proposeTasks} onChange={(event) => setProposeTasks(event.target.checked)} />Propose tasks</label>
            </div>
          </fieldset>
          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn primary"
              onClick={saveEdit}
              disabled={busy || !name.trim() || !description.trim()}
            >
              {busy ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      )}

      {mode === "token" && (
        <div style={{ marginTop: 16 }}>
          <AgentTokenPanel agentId={agent.id} />
        </div>
      )}

      {mode === "activity" && (
        <div className="stack" style={{ gap: 10, marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--rule)" }}>
          {activity.length === 0 ? (
            <p style={{ margin: 0, color: "var(--muted)", fontSize: 13 }}>No runs recorded yet.</p>
          ) : activity.slice(0, 10).map((entry) => (
            <div key={entry.id} style={{ padding: "10px 0", borderBottom: "1px solid var(--rule)" }}>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <span className="receipt" style={{ fontSize: 9.5 }}>{entry.trigger}</span>
                <span className="receipt" style={{ fontSize: 9.5, color: "var(--faint)" }}>{new Date(entry.createdAt).toLocaleString()}</span>
                {entry.toolsUsed.map((tool) => <span key={tool} className="receipt" style={{ fontSize: 9.5, color: "var(--accent)" }}>{tool}</span>)}
              </div>
              <p style={{ margin: "7px 0 0", fontSize: 13.5, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{entry.output}</p>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--rule)" }}>
        <p className="fmark" style={{ marginBottom: 8 }}>Run now</p>
        <div className="row" style={{ gap: 8, alignItems: "end" }}>
          <input value={runPrompt} onChange={(event) => setRunPrompt(event.target.value)} placeholder="Optional focus for this run" style={{ flex: 1, border: "1px solid var(--rule-strong)", borderRadius: 10, background: "var(--paper)", color: "var(--ink)", padding: "9px 11px", fontSize: 13.5 }} />
          <button type="button" className="btn primary" onClick={() => void runAgent()} disabled={running}>{running ? "Running…" : "Run agent"}</button>
        </div>
        {runOutput && <p style={{ margin: "10px 0 0", padding: 11, borderRadius: 10, background: "var(--paper)", fontSize: 13.5, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{runOutput}</p>}
      </div>
    </div>
  );
}

function CreateAgent({ handle }: { handle: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const previewId = name.trim()
    ? `${slugify(handle)}--${slugify(name)}`
    : null;

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `request failed (${res.status})`);
      }
      setName("");
      setDescription("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        background: "var(--paper-2)",
        border: "1px solid var(--rule)",
        borderRadius: 16,
        padding: 20,
      }}
    >
      <div className="stack" style={{ gap: 12 }}>
        <FInput value={name} onChange={setName} placeholder="New agent name (e.g. Scout)" />
        <FInput
          value={description}
          onChange={setDescription}
          placeholder="What this agent does"
          multiline
        />
        <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "baseline" }}>
          <button
            type="button"
            className="btn primary"
            onClick={create}
            disabled={busy || !name.trim() || !description.trim()}
          >
            {busy ? "Creating…" : "Create agent"}
          </button>
          {previewId && (
            <span className="receipt" style={{ fontSize: 11.5, color: "var(--faint)" }}>
              id: {previewId}
            </span>
          )}
          {error && <ErrorLine message={error} />}
        </div>
      </div>
    </div>
  );
}

/**
 * The owner's agent management surface (rendered on the `/agents` page): lists
 * their agents with inline edit / token / delete, plus a create form. All
 * actions hit the existing `/api/agents` endpoints and refresh the server tree
 * on success.
 */
export function AgentManager({ handle, agents }: AgentManagerProps) {
  return (
    <div className="stack" style={{ gap: 16 }}>
      {agents.length === 0 ? (
        <p style={{ margin: 0, color: "var(--muted)", fontSize: 14.5 }}>
          No agents yet. Create one below to ingest and maintain pages on your
          behalf.
        </p>
      ) : (
        agents.map((agent) => (
          <AgentCard key={agent.id} handle={handle} agent={agent} />
        ))
      )}
      <CreateAgent handle={handle} />
    </div>
  );
}
