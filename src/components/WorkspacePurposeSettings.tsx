"use client";

import { useEffect, useId, useState } from "react";
import type { WorkspaceProfile } from "@/lib/workspace-profile";
import { SCENARIO_LABELS } from "@/lib/wiki-scenarios";
import {
  EMPTY_WORKSPACE_PROFILE,
  WORKSPACE_SCENARIO_TEMPLATES,
  type WorkspaceProfileInput,
  type WorkspaceScenario,
} from "@/lib/workspace-profile-schema";

type Feedback = { ok: boolean; message: string } | null;

/**
 * Why every control on this form refuses on a read-only deployment (DW-191).
 *
 * Exported because it is the sentence the refused controls POINT AT through
 * `aria-describedby`, and because `read-only-copy-parity.test.ts` pins it
 * against what `PUT /api/workspace-profile` answers. It NARROWS that sentence
 * on purpose: the route says "Settings are read-only in this deployment.",
 * which is true of every field the Settings surface owns and useless beside a
 * form that edits one thing. The parity suite records the divergence rather
 * than letting it look like the drift it is otherwise indistinguishable from.
 *
 * Copy says work-wiki; the runtime identifier stays `YOPEDIA_READONLY`.
 */
export const WORKSPACE_PURPOSE_READ_ONLY_COPY =
  "Workspace Purpose cannot be changed while this deployment is read-only.";

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
  /**
   * The read-only sentence's id, so every control refused for that reason can
   * resolve it through `aria-describedby`.
   *
   * `aria-disabled` on its own announces "dimmed" and nothing about why, and a
   * `readOnly` textarea announces "read only" and nothing about why either —
   * the sentence below the form is the only place the reason is stated at all.
   * Rendered only while `readOnly`, so the attribute is only ever set when
   * there is a node with this id to point at.
   */
  const readOnlyNoteId = useId();
  /**
   * `aria-describedby` for a control this deployment may refuse.
   *
   * Every control here already has its meaning in its own `<label>`, so unlike
   * `SettingsCanvas.describedBy` there is no hint id to append to — but the
   * shape is the same, and a control that grows a hint should append rather
   * than replace.
   */
  const describedBy = readOnly ? readOnlyNoteId : undefined;

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
    // THE EARLY RETURN IS THE WHOLE REFUSAL — `WikiSwitcherProps.readOnly` owns
    // the rationale for this convention. Here it also protects what the owner
    // came to read: this handler overwrites every field with template bytes, so
    // without the guard an `aria-disabled` button they can still activate would
    // paint a draft over the stored purpose they can no longer save back.
    if (readOnly) return;
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
    // Before the `setSaving`, so a refused deployment never flashes "Saving…"
    // over a request it will not make. The route answers 403 either way; this is
    // what keeps the submit button from being a control that says it refuses and
    // then behaves as though it did not.
    if (readOnly) return;
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
            shut rather than collecting edits the server will throw away.

            `readOnly` is deliberately NOT one of these legs any more (DW-191).
            `disabled` on a fieldset takes every descendant out of the tab order,
            so on a read-only deployment the whole stored Workspace Purpose —
            text the owner is entitled to READ — became unreachable by keyboard
            and by screen reader. Read-only means read-only, not hidden; each
            control below states its own refusal instead, following the
            convention `WikiSwitcherProps.readOnly` documents. The other three
            legs keep the fieldset: `loading` and `saving` are transient, and
            `!wiki` is a separate defect with the same shape, not this one.

            And NOT dimmed as a whole either. A read-only `opacity-60` here would
            fade the stored purpose, key questions and scope lists — the exact
            text this change exists to keep readable — so it would be the sighted
            half of the same defect, trading one group of owners for another. The
            visible affordance is the refusal stated where it applies: the amber
            sentence below the form, and `opacity-60` on the three CONTROLS that
            refuse, which carry no content of their own. (A field-chrome cue
            without a contrast loss is available if one is ever wanted — see
            `.wb-set-input[readonly]` in `globals.css`, which recolours the box
            rather than the value.) */}
        <fieldset disabled={loading || saving || !wiki} className="disabled:opacity-60">
          <div className="grid gap-5 border-b border-foreground/10 p-5 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <div>
              <label className="text-sm font-medium text-foreground/75">
                Starting scenario
                <select
                  value={profile.scenario}
                  // `aria-disabled`, never `disabled`: a <select> has no
                  // `readonly`, and `disabled` would take the picker out of the
                  // tab order along with the scenario this wiki is running on —
                  // see `SettingsCanvas.providerRow`, which refuses the same way
                  // for the same reason.
                  aria-disabled={readOnly || undefined}
                  onChange={(event) => {
                    if (readOnly) return;
                    setProfile({ ...profile, scenario: event.target.value as WorkspaceScenario });
                    setFeedback(null);
                  }}
                  aria-describedby={describedBy}
                  className="mt-1.5 block w-full rounded-lg border border-foreground/15 bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-foreground/35"
                >
                  {Object.entries(SCENARIO_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className={`btn ghost mt-3 w-full justify-center${
                  readOnly ? " opacity-60" : ""
                }`}
                // `!selectedTemplate` is VALUE state (the custom scenario has
                // no template to load), so it keeps `disabled` — but it YIELDS
                // to the deployment state. Both at once is reachable (read-only
                // with `custom` selected), and `disabled` would win: the button
                // would leave the tab order carrying the only `aria-describedby`
                // pointer some owners have to the refusal, which is the exact
                // harm this change exists to remove. `applyTemplate()` guards
                // both conditions, so a writable deployment is unaffected.
                disabled={!readOnly && !selectedTemplate}
                aria-disabled={readOnly || undefined}
                aria-describedby={describedBy}
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
                readOnly={readOnly}
                aria-describedby={describedBy}
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
                readOnly={readOnly}
                aria-describedby={describedBy}
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
                readOnly={readOnly}
                aria-describedby={describedBy}
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
                readOnly={readOnly}
                aria-describedby={describedBy}
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
                readOnly={readOnly}
                aria-describedby={describedBy}
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
                readOnly={readOnly}
                aria-describedby={describedBy}
                className="mt-1.5 block w-full resize-y rounded-lg border border-foreground/15 bg-background px-3 py-2.5 text-sm leading-6 text-foreground outline-none placeholder:text-foreground/30 focus:border-foreground/35"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-foreground/10 px-5 py-4">
            <button
              type="submit"
              className={`btn primary${readOnly ? " opacity-60" : ""}`}
              // `saving` and `!wiki` keep `disabled` — one transient, one the
              // separate unnamed defect this change deliberately does not widen
              // into. Read-only takes `aria-disabled` so the owner can still
              // reach the button and hear why it refuses.
              disabled={saving || !wiki}
              aria-disabled={readOnly || undefined}
              aria-describedby={describedBy}
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

      {/* Identified so every refused control above can point at it: this is the
          only place the reason for their refusal is stated at all. Not
          `role="alert"` — nothing failed; it is the deployment's standing
          state. */}
      {readOnly && (
        <p
          id={readOnlyNoteId}
          className="mt-3 text-sm text-amber-700 dark:text-amber-400"
        >
          {WORKSPACE_PURPOSE_READ_ONLY_COPY}
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
