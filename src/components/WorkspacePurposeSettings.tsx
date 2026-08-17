"use client";

import { useEffect, useState } from "react";
import type { WorkspaceProfile } from "@/lib/workspace-profile";
import { SCENARIO_LABELS } from "@/lib/wiki-scenarios";
import {
  EMPTY_WORKSPACE_PROFILE,
  WORKSPACE_SCENARIO_TEMPLATES,
  type WorkspaceProfileInput,
  type WorkspaceScenario,
} from "@/lib/workspace-profile-schema";

type Feedback = { ok: boolean; message: string } | null;

/** The Wiki this purpose belongs to, as the route names it. */
type ActiveWiki = { id: string; name: string };

function listText(values: readonly string[]): string {
  return values.join("\n");
}

function parseList(value: string): string[] {
  return value
    .split("\n")
    .map((item) => item.replace(/^\s*[-*]\s+/, "").trim())
    .filter(Boolean);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

export function WorkspacePurposeSettings() {
  const [profile, setProfile] = useState<WorkspaceProfileInput>({
    ...EMPTY_WORKSPACE_PROFILE,
    keyQuestions: [],
    inScope: [],
    outOfScope: [],
  });
  const [keyQuestions, setKeyQuestions] = useState("");
  const [inScope, setInScope] = useState("");
  const [outOfScope, setOutOfScope] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  // The Workspace Purpose is stored per Wiki, so the form is editing ONE
  // wiki's profile — the active one. Null means the owner has no wiki yet and
  // there is nothing for these bytes to belong to.
  const [wiki, setWiki] = useState<ActiveWiki | null>(null);
  // A failed GET also leaves `wiki` null, and "create a wiki first" would then
  // be a claim about the registry this render never got to make (the same
  // distinction WikiWorkbench draws with `unavailable`). The error banner below
  // says what actually happened; this keeps the intro from contradicting it.
  const [loadFailed, setLoadFailed] = useState(false);

  function placeProfile(value: WorkspaceProfileInput, updatedAt?: string | null) {
    setProfile({
      ...value,
      keyQuestions: [...value.keyQuestions],
      inScope: [...value.inScope],
      outOfScope: [...value.outOfScope],
    });
    setKeyQuestions(listText(value.keyQuestions));
    setInScope(listText(value.inScope));
    setOutOfScope(listText(value.outOfScope));
    setSavedAt(updatedAt ?? null);
  }

  useEffect(() => {
    let cancelled = false;
    void request<{
      profile: WorkspaceProfile;
      readOnly: boolean;
      wiki: ActiveWiki | null;
    }>("/api/workspace-profile")
      .then((data) => {
        if (cancelled) return;
        // No wiki means these bytes belong to no wiki: with a retired
        // tenant-global profile still on disk the route answers its fields so
        // the owner can SEE them, but "Last saved …" would then date a save
        // this form cannot repeat and no wiki owns. Show the values, not the
        // receipt.
        placeProfile(data.profile, data.wiki ? data.profile.updatedAt : null);
        setReadOnly(data.readOnly);
        setWiki(data.wiki ?? null);
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadFailed(true);
          setFeedback({
            ok: false,
            message: error instanceof Error ? error.message : "Couldn’t load Workspace Purpose.",
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

  const selectedTemplate =
    profile.scenario === "custom"
      ? null
      : WORKSPACE_SCENARIO_TEMPLATES[profile.scenario];

  function applyTemplate() {
    if (!selectedTemplate) return;
    placeProfile(selectedTemplate, savedAt);
    setFeedback({
      ok: true,
      // The shared label map, not the template's own `name` — otherwise the
      // <select> and this message show two different names for one scenario.
      message: `${SCENARIO_LABELS[selectedTemplate.scenario]} template loaded as a draft. Review it, then save when it reflects your workspace.`,
    });
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFeedback(null);
    const input: WorkspaceProfileInput = {
      ...profile,
      keyQuestions: parseList(keyQuestions),
      inScope: parseList(inScope),
      outOfScope: parseList(outOfScope),
    };
    try {
      const data = await request<{ profile: WorkspaceProfile; wiki: ActiveWiki | null }>(
        "/api/workspace-profile",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          // The wiki these edits were composed against travels WITH them. The
          // route re-resolves the active wiki per request, so without this a
          // switch in another tab between load and save would write what is on
          // screen over a different wiki's stored purpose.
          body: JSON.stringify({ ...input, wikiId: wiki?.id }),
        },
      );
      placeProfile(data.profile, data.profile.updatedAt);
      // Adopt the wiki the server says it wrote, so the confirmation names the
      // wiki actually written rather than the one this form last believed in.
      const written = data.wiki ?? wiki;
      setWiki(written);
      setFeedback({
        ok: true,
        message: written
          ? `Workspace Purpose saved for “${written.name}”. New ingest, chat, monitoring, extraction, and agent runs on this wiki will use it.`
          : "Workspace Purpose saved. New ingest, chat, monitoring, extraction, and agent runs will use it.",
      });
    } catch (error) {
      setFeedback({
        ok: false,
        message: error instanceof Error ? error.message : "Couldn’t save Workspace Purpose.",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="mt-12 border-t border-foreground/10 pt-10"
      aria-labelledby="workspace-purpose-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <p className="fmark mb-2">Knowledge direction</p>
          <h2
            id="workspace-purpose-heading"
            className="text-xl font-semibold tracking-tight text-foreground"
          >
            Workspace Purpose
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-foreground/60">
            Tell work-wiki what this memory is for, which questions matter, and what
            belongs outside its scope. The profile guides generated work; source
            evidence and citations still win.
          </p>
          {/* Each wiki keeps its own Workspace Purpose beside its own Schema, so
              the form has to say WHOSE purpose it is showing — otherwise editing
              here after switching wikis is editing something unnamed. */}
          <p className="mt-2 max-w-2xl text-sm leading-6 text-foreground/60">
            {loading
              ? "Loading the active wiki’s purpose…"
              : wiki
                ? `This purpose belongs to “${wiki.name}”. Every wiki keeps its own, and switching the active wiki switches which one guides new runs.`
                : loadFailed
                  ? "The active wiki couldn’t be loaded, so there is nothing to edit here yet."
                  : "Create a wiki first — the Workspace Purpose belongs to a wiki, so there is nothing to edit yet."}
          </p>
        </div>
        <div className="rounded-full border border-foreground/15 bg-foreground/[0.025] px-3 py-1.5">
          <span className="receipt text-[10px] text-foreground/55">
            {loading
              ? "loading…"
              : loadFailed
                ? "unavailable"
                : !wiki
                  ? "no wiki"
                  : savedAt
                    ? "active"
                    : "not configured"}
          </span>
        </div>
      </div>

      <form
        onSubmit={save}
        className="mt-6 overflow-hidden rounded-2xl border border-foreground/15 bg-foreground/[0.018]"
      >
        {/* No active wiki means the PUT would be refused, so the controls stay
            shut rather than collecting edits the server will throw away. */}
        <fieldset
          disabled={loading || saving || readOnly || !wiki}
          className="disabled:opacity-60"
        >
          <div className="grid gap-5 border-b border-foreground/10 p-5 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <div>
              <label className="text-sm font-medium text-foreground/75">
                Starting scenario
                <select
                  value={profile.scenario}
                  onChange={(event) => {
                    setProfile({ ...profile, scenario: event.target.value as WorkspaceScenario });
                    setFeedback(null);
                  }}
                  className="mt-1.5 block w-full rounded-lg border border-foreground/15 bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-foreground/35"
                >
                  {Object.entries(SCENARIO_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn ghost mt-3 w-full justify-center"
                disabled={!selectedTemplate}
                onClick={applyTemplate}
              >
                Load scenario draft
              </button>
              <p className="mt-2 text-xs leading-5 text-foreground/40">
                Loading a scenario changes only this unsaved form. It never replaces
                pages or settings until you save.
              </p>
            </div>

            <label className="text-sm font-medium text-foreground/75">
              Purpose
              <textarea
                value={profile.purpose}
                maxLength={8_000}
                rows={6}
                onChange={(event) => setProfile({ ...profile, purpose: event.target.value })}
                placeholder="What should this workspace help you understand, remember, or accomplish?"
                className="mt-1.5 block w-full resize-y rounded-lg border border-foreground/15 bg-background px-3 py-2.5 text-sm leading-6 text-foreground outline-none placeholder:text-foreground/30 focus:border-foreground/35"
              />
            </label>
          </div>

          <div className="grid gap-5 p-5 lg:grid-cols-3">
            <label className="text-sm font-medium text-foreground/75">
              Key questions
              <textarea
                value={keyQuestions}
                rows={6}
                onChange={(event) => setKeyQuestions(event.target.value)}
                placeholder="One question per line"
                className="mt-1.5 block w-full resize-y rounded-lg border border-foreground/15 bg-background px-3 py-2.5 text-sm leading-6 text-foreground outline-none placeholder:text-foreground/30 focus:border-foreground/35"
              />
            </label>
            <label className="text-sm font-medium text-foreground/75">
              In scope
              <textarea
                value={inScope}
                rows={6}
                onChange={(event) => setInScope(event.target.value)}
                placeholder="One boundary per line"
                className="mt-1.5 block w-full resize-y rounded-lg border border-foreground/15 bg-background px-3 py-2.5 text-sm leading-6 text-foreground outline-none placeholder:text-foreground/30 focus:border-foreground/35"
              />
            </label>
            <label className="text-sm font-medium text-foreground/75">
              Out of scope
              <textarea
                value={outOfScope}
                rows={6}
                onChange={(event) => setOutOfScope(event.target.value)}
                placeholder="One exclusion per line"
                className="mt-1.5 block w-full resize-y rounded-lg border border-foreground/15 bg-background px-3 py-2.5 text-sm leading-6 text-foreground outline-none placeholder:text-foreground/30 focus:border-foreground/35"
              />
            </label>
          </div>

          <div className="grid gap-5 border-t border-foreground/10 p-5 md:grid-cols-[220px_minmax(0,1fr)]">
            <label className="text-sm font-medium text-foreground/75">
              Output language
              <input
                value={profile.outputLanguage}
                maxLength={80}
                onChange={(event) => setProfile({ ...profile, outputLanguage: event.target.value })}
                placeholder="English"
                className="mt-1.5 block w-full rounded-lg border border-foreground/15 bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-foreground/30 focus:border-foreground/35"
              />
            </label>
            <label className="text-sm font-medium text-foreground/75">
              Page conventions
              <textarea
                value={profile.pageConventions}
                maxLength={8_000}
                rows={4}
                onChange={(event) => setProfile({ ...profile, pageConventions: event.target.value })}
                placeholder="How should work-wiki organize, qualify, and connect generated knowledge?"
                className="mt-1.5 block w-full resize-y rounded-lg border border-foreground/15 bg-background px-3 py-2.5 text-sm leading-6 text-foreground outline-none placeholder:text-foreground/30 focus:border-foreground/35"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-foreground/10 px-5 py-4">
            <button
              type="submit"
              className="btn primary"
              disabled={saving || readOnly || !wiki}
            >
              {saving ? "Saving…" : "Save Workspace Purpose"}
            </button>
            {savedAt && (
              <span className="text-xs text-foreground/40">
                Last saved {new Date(savedAt).toLocaleString()}
              </span>
            )}
          </div>
        </fieldset>
      </form>

      {readOnly && (
        <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">
          Workspace Purpose cannot be changed while this deployment is read-only.
        </p>
      )}
      {feedback && (
        <div
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
