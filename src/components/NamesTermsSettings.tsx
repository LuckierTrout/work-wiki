"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  NamesTermEntry,
  NamesTermInput,
  NamesTermKind,
} from "@/lib/names-terms";

const KIND_LABELS: Record<NamesTermKind, string> = {
  person: "Person",
  organization: "Organization",
  project: "Project or product",
  acronym: "Acronym",
  term: "Term",
};

const EMPTY_DRAFT: NamesTermInput = {
  kind: "person",
  canonical: "",
  aliases: [],
  description: "",
  email: "",
  role: "",
  organization: "",
  guidance: "",
};

type Feedback = { ok: boolean; message: string } | null;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function aliasesText(aliases: readonly string[]): string {
  return aliases.join(", ");
}

function parseAliases(value: string): string[] {
  return value.split(/[\n,;]/).map((alias) => alias.trim()).filter(Boolean);
}

export function NamesTermsSettings() {
  const [entries, setEntries] = useState<NamesTermEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<NamesTermInput>(EMPTY_DRAFT);
  const [aliasDraft, setAliasDraft] = useState("");
  const [filter, setFilter] = useState<NamesTermKind | "all">("all");
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function load() {
    setLoading(true);
    try {
      const data = await request<{ entries: NamesTermEntry[] }>("/api/names-terms");
      setEntries(data.entries);
    } catch (error) {
      setFeedback({
        ok: false,
        message: error instanceof Error ? error.message : "Couldn’t load Names & Terms.",
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const shown = useMemo(
    () => filter === "all" ? entries : entries.filter((entry) => entry.kind === filter),
    [entries, filter],
  );

  function resetForm() {
    setDraft(EMPTY_DRAFT);
    setAliasDraft("");
    setEditingId(null);
  }

  function beginEdit(entry: NamesTermEntry) {
    setEditingId(entry.id);
    setDraft({
      kind: entry.kind,
      canonical: entry.canonical,
      aliases: entry.aliases,
      description: entry.description ?? "",
      email: entry.email ?? "",
      role: entry.role ?? "",
      organization: entry.organization ?? "",
      guidance: entry.guidance ?? "",
    });
    setAliasDraft(aliasesText(entry.aliases));
    setFeedback(null);
    document.getElementById("names-terms-editor")?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!draft.canonical.trim()) return;
    setSaving(true);
    setFeedback(null);
    const input: NamesTermInput = {
      ...draft,
      aliases: parseAliases(aliasDraft),
    };
    try {
      const data = await request<{ entry: NamesTermEntry }>(
        editingId ? `/api/names-terms/${editingId}` : "/api/names-terms",
        {
          method: editingId ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      setEntries((current) => {
        const next = editingId
          ? current.map((entry) => entry.id === editingId ? data.entry : entry)
          : [...current, data.entry];
        return next.sort(
          (a, b) => a.kind.localeCompare(b.kind) || a.canonical.localeCompare(b.canonical),
        );
      });
      setFeedback({
        ok: true,
        message: editingId ? "Entry updated." : "Entry added to your workspace dictionary.",
      });
      resetForm();
    } catch (error) {
      setFeedback({
        ok: false,
        message: error instanceof Error ? error.message : "Couldn’t save this entry.",
      });
    } finally {
      setSaving(false);
    }
  }

  async function remove(entry: NamesTermEntry) {
    if (!window.confirm(`Remove “${entry.canonical}” from Names & Terms?`)) return;
    setFeedback(null);
    try {
      await request(`/api/names-terms/${entry.id}`, { method: "DELETE" });
      setEntries((current) => current.filter((candidate) => candidate.id !== entry.id));
      if (editingId === entry.id) resetForm();
      setFeedback({ ok: true, message: `Removed “${entry.canonical}”.` });
    } catch (error) {
      setFeedback({
        ok: false,
        message: error instanceof Error ? error.message : "Couldn’t remove this entry.",
      });
    }
  }

  const isPerson = draft.kind === "person";

  return (
    <section
      className="mt-12 border-t border-foreground/10 pt-10"
      aria-labelledby="names-terms-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <p className="fmark mb-2">Shared language</p>
          <h2 id="names-terms-heading" className="text-xl font-semibold tracking-tight text-foreground">
            Names &amp; Terms
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-foreground/60">
            Teach WorkWiki the preferred names, aliases, acronyms, and terms it should use
            across new pages, chat, search, tasks, the Atlas, and digests.
          </p>
        </div>
        <div className="rounded-full border border-foreground/15 bg-foreground/[0.025] px-3 py-1.5">
          <span className="receipt text-[10px] text-foreground/55">
            {loading ? "loading…" : `${entries.length} remembered`}
          </span>
        </div>
      </div>

      <div className="mt-6 grid overflow-hidden rounded-2xl border border-foreground/15 bg-foreground/[0.018] lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
        <form
          id="names-terms-editor"
          onSubmit={save}
          className="border-b border-foreground/10 p-5 lg:border-b-0 lg:border-r"
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="receipt text-[10px] text-foreground/45">
                {editingId ? "EDITING ENTRY" : "NEW ENTRY"}
              </p>
              <h3 className="mt-1 text-base font-semibold text-foreground">
                {editingId ? draft.canonical || "Update entry" : "Add a name or term"}
              </h3>
            </div>
            {editingId && (
              <button type="button" className="btn ghost" onClick={resetForm}>
                Cancel
              </button>
            )}
          </div>

          <div className="mt-5 grid gap-4 sm:grid-cols-[160px_minmax(0,1fr)]">
            <label className="text-sm font-medium text-foreground/75">
              Type
              <select
                value={draft.kind}
                onChange={(event) => {
                  const kind = event.target.value as NamesTermKind;
                  setDraft({
                    ...draft,
                    kind,
                    ...(kind === "person"
                      ? {}
                      : { email: "", role: "", organization: "" }),
                  });
                }}
                className="mt-1.5 block w-full rounded-lg border border-foreground/15 bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-foreground/35"
              >
                {Object.entries(KIND_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label className="text-sm font-medium text-foreground/75">
              Preferred name or term
              <input
                value={draft.canonical}
                maxLength={160}
                onChange={(event) => setDraft({ ...draft, canonical: event.target.value })}
                placeholder={isPerson ? "Christian Lee" : "Canonical label"}
                className="mt-1.5 block w-full rounded-lg border border-foreground/15 bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-foreground/30 focus:border-foreground/35"
              />
            </label>
          </div>

          <label className="mt-4 block text-sm font-medium text-foreground/75">
            Aliases and common variations
            <textarea
              value={aliasDraft}
              rows={2}
              onChange={(event) => setAliasDraft(event.target.value)}
              placeholder="Separate aliases with commas — Chris, C. Lee"
              className="mt-1.5 block w-full resize-y rounded-lg border border-foreground/15 bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-foreground/30 focus:border-foreground/35"
            />
          </label>

          {isPerson && (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium text-foreground/75">
                Role
                <input
                  value={draft.role ?? ""}
                  onChange={(event) => setDraft({ ...draft, role: event.target.value })}
                  placeholder="Product owner"
                  className="mt-1.5 block w-full rounded-lg border border-foreground/15 bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-foreground/30 focus:border-foreground/35"
                />
              </label>
              <label className="text-sm font-medium text-foreground/75">
                Organization
                <input
                  value={draft.organization ?? ""}
                  onChange={(event) => setDraft({ ...draft, organization: event.target.value })}
                  placeholder="Company or team"
                  className="mt-1.5 block w-full rounded-lg border border-foreground/15 bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-foreground/30 focus:border-foreground/35"
                />
              </label>
              <label className="text-sm font-medium text-foreground/75 sm:col-span-2">
                Email <span className="font-normal text-foreground/35">(optional)</span>
                <input
                  type="email"
                  value={draft.email ?? ""}
                  onChange={(event) => setDraft({ ...draft, email: event.target.value })}
                  placeholder="name@example.com"
                  className="mt-1.5 block w-full rounded-lg border border-foreground/15 bg-background px-3 py-2.5 font-mono text-sm text-foreground outline-none placeholder:text-foreground/30 focus:border-foreground/35"
                />
              </label>
            </div>
          )}

          <label className="mt-4 block text-sm font-medium text-foreground/75">
            Context
            <textarea
              value={draft.description ?? ""}
              rows={2}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              placeholder="What this refers to, so similar names aren’t confused"
              className="mt-1.5 block w-full resize-y rounded-lg border border-foreground/15 bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-foreground/30 focus:border-foreground/35"
            />
          </label>

          <label className="mt-4 block text-sm font-medium text-foreground/75">
            Usage guidance <span className="font-normal text-foreground/35">(optional)</span>
            <textarea
              value={draft.guidance ?? ""}
              rows={2}
              onChange={(event) => setDraft({ ...draft, guidance: event.target.value })}
              placeholder="For example: use the full name in formal summaries"
              className="mt-1.5 block w-full resize-y rounded-lg border border-foreground/15 bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-foreground/30 focus:border-foreground/35"
            />
          </label>

          <button
            className="btn primary mt-5 w-full justify-center"
            type="submit"
            disabled={saving || !draft.canonical.trim()}
          >
            {saving ? "Saving…" : editingId ? "Update entry" : "Remember this"}
          </button>
          <p className="mt-3 text-xs leading-5 text-foreground/40">
            Original source wording and quotations stay unchanged. The dictionary guides
            generated language and identity matching only.
          </p>
        </form>

        <div className="min-w-0 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="receipt text-[10px] text-foreground/45">WORKSPACE DICTIONARY</p>
              <h3 className="mt-1 text-base font-semibold text-foreground">Remembered language</h3>
            </div>
            <select
              aria-label="Filter Names & Terms"
              value={filter}
              onChange={(event) => setFilter(event.target.value as NamesTermKind | "all")}
              className="rounded-lg border border-foreground/15 bg-background px-3 py-2 text-xs text-foreground/70 outline-none"
            >
              <option value="all">All types</option>
              {Object.entries(KIND_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          {loading ? (
            <p className="mt-8 text-sm text-foreground/45">Loading your dictionary…</p>
          ) : shown.length === 0 ? (
            <div className="mt-6 rounded-xl border border-dashed border-foreground/15 px-5 py-10 text-center">
              <p className="display text-xl text-foreground">No entries yet.</p>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-foreground/50">
                Start with people whose names appear in meeting notes, then add project
                shorthand and company acronyms.
              </p>
            </div>
          ) : (
            <div className="mt-4 divide-y divide-foreground/10">
              {shown.map((entry) => (
                <article key={entry.id} className="py-4 first:pt-2">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-sm font-semibold text-foreground">{entry.canonical}</h4>
                        <span className="receipt rounded-full bg-foreground/[0.045] px-2 py-1 text-[9px] text-foreground/45">
                          {KIND_LABELS[entry.kind]}
                        </span>
                      </div>
                      {entry.aliases.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {entry.aliases.map((alias) => (
                            <span key={alias} className="rounded-md border border-foreground/10 px-2 py-1 text-[11px] text-foreground/55">
                              {alias}
                            </span>
                          ))}
                        </div>
                      )}
                      {(entry.role || entry.organization || entry.email) && (
                        <p className="mt-2 text-xs text-foreground/45">
                          {[entry.role, entry.organization, entry.email].filter(Boolean).join(" · ")}
                        </p>
                      )}
                      {entry.description && (
                        <p className="mt-2 text-sm leading-5 text-foreground/60">{entry.description}</p>
                      )}
                      {entry.guidance && (
                        <p className="mt-2 border-l-2 border-[var(--accent)] pl-2 text-xs leading-5 text-foreground/50">
                          {entry.guidance}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button type="button" className="btn ghost" onClick={() => beginEdit(entry)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={() => void remove(entry)}
                        style={{ color: "var(--rust)" }}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>

      {feedback && (
        <div
          role="status"
          className={`mt-4 rounded-lg border p-3 text-sm ${
            feedback.ok
              ? "border-green-500/20 bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400"
              : "border-red-500/20 bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400"
          }`}
        >
          {feedback.message}
        </div>
      )}
    </section>
  );
}
