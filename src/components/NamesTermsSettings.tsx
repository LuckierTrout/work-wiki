"use client";

import { useEffect, useId, useMemo, useState } from "react";
import type {
  NamesTermEntry,
  NamesTermInput,
  NamesTermKind,
} from "@/lib/names-terms";
import {
  RequestFailedError,
  readJsonBody,
  writeFailure,
} from "@/lib/workbench-request";

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

/**
 * Why every writing control on this surface refuses on a read-only deployment
 * (DW-386).
 *
 * The CLIENT mirror of `READ_ONLY_REFUSAL.namesTerms` — what
 * `POST /api/names-terms` and `PUT`/`DELETE /api/names-terms/[id]` all answer —
 * and character-identical to it, pinned by `read-only-copy-parity.test.ts`.
 * Exported because it is the sentence the refused controls POINT AT through
 * `aria-describedby`.
 *
 * NOT narrowed. The server sentence already names this store and covers the
 * three verbs this surface offers (add, update, remove), so there is nothing a
 * narrower wording could tell the owner that this one does not.
 *
 * Copy says work-wiki; the runtime identifier stays `YOPEDIA_READONLY`.
 */
export const NAMES_TERMS_READ_ONLY_COPY =
  "Names & Terms entries cannot be changed while this deployment is read-only.";

export interface NamesTermsSettingsProps {
  /**
   * `YOPEDIA_READONLY=1`, as `/settings` already read it from
   * `GET /api/settings`.
   *
   * A PROP rather than a fetch of this component's own: the mounting surface
   * knows the flag, and a second read would be a second answer to one question
   * — free to disagree with the banner rendered a few nodes above it.
   *
   * Optional and off by default, so every existing caller renders unchanged.
   */
  readOnly?: boolean;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await readJsonBody<T & { error?: string }>(response);
  // `RequestFailedError`, never a bare `Error` (DW-717): the MESSAGE is
  // byte-identical, but the status rides the error. `writeFailure` cannot tell
  // a gateway that gave up (502/504 — the write may have landed) from a route
  // that refused by reading `Request failed (504)`, so a bare throw here made
  // every catch below report a hand-off as a KNOWN failure.
  if (!response.ok) {
    throw new RequestFailedError(
      body.error || `Request failed (${response.status})`,
      response.status,
    );
  }
  return body;
}

function aliasesText(aliases: readonly string[]): string {
  return aliases.join(", ");
}

function parseAliases(value: string): string[] {
  return value.split(/[\n,;]/).map((alias) => alias.trim()).filter(Boolean);
}

export function NamesTermsSettings({
  readOnly = false,
}: NamesTermsSettingsProps = {}) {
  const [entries, setEntries] = useState<NamesTermEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<NamesTermInput>(EMPTY_DRAFT);
  const [aliasDraft, setAliasDraft] = useState("");
  const [filter, setFilter] = useState<NamesTermKind | "all">("all");
  const [feedback, setFeedback] = useState<Feedback>(null);
  /**
   * The read-only sentence's id, so every control refused for that reason can
   * resolve it through `aria-describedby`.
   *
   * `aria-disabled` on its own announces "dimmed" and nothing about why, and a
   * `readOnly` input announces "read only" and nothing about why either — the
   * sentence below the grid is the only place the reason is stated at all.
   * Rendered only while `readOnly`, so the attribute is only ever set when
   * there is a node with this id to point at.
   */
  const readOnlyNoteId = useId();
  /**
   * `aria-describedby` for a control this section refuses: ITS OWN note, and
   * nothing else.
   *
   * NOT composed with the page's read-only banner, even though `/settings`
   * renders one a few nodes above. That banner states what
   * `PUT /api/settings` answers — the refusal of the provider form — and these
   * controls stand in front of `/api/names-terms`. One control, one door, one
   * sentence: the same rule **Rebuild Vector Index** follows, and the whole
   * point of DW-387. `undefined` while writable, so nothing describes a refusal
   * that is not happening.
   */
  const refusalIds = readOnly ? readOnlyNoteId : undefined;

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
    // `preventDefault` FIRST, refusal second: the browser would navigate away
    // on a submission this handler declined to make a request for.
    event.preventDefault();
    // THE EARLY RETURN IS THE WHOLE REFUSAL — `aria-disabled` dims the button
    // but leaves it activatable, which is the point: the control keeps its
    // place in the tab order so the sentence can be announced with it.
    if (readOnly) return;
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
      // A 2xx whose body is not the documented shape must not reach state
      // (DW-747). `readJsonBody` resolves `{}` for a 200 that merely fails to
      // PARSE — the answer arrived and was shapeless, and it is the caller's
      // job to say so — which makes `data.entry` `undefined`. Unguarded, that
      // `undefined` goes into `entries`, the row map below reads
      // `entry.canonical` off it, and the whole Names & Terms section blanks
      // out over a write that most likely landed.
      //
      // The guard covers EVERY field this component dereferences off an entry
      // with no guard of its own, not just the one that crashed first: `id`
      // (the row key and the edit-target match), `canonical` and `kind` (the
      // `setEntries` comparator runs `localeCompare` on both, and `KIND_LABELS`
      // is indexed by `kind`), and `aliases` (the row reads `.length` and maps
      // it, and `beginEdit` hands it to `aliasesText`). A PARTIAL entry — a
      // body that parses and carries only some of them — reaches exactly the
      // same crash, so a guard naming two fields would only move which line
      // dies. Nothing beyond these four is checked: the optional fields are
      // read behind truthiness tests already.
      //
      // Thrown INSIDE the `try`, so the existing `writeFailure` catch composes
      // the sentence and no new error-reporting path appears; `unconfirmed` is
      // false, so the list the owner is looking at stays on screen and is not
      // refetched.
      if (
        !data.entry?.id ||
        !data.entry.canonical ||
        typeof data.entry.kind !== "string" ||
        !Array.isArray(data.entry.aliases)
      ) {
        throw new Error("The server did not confirm this entry.");
      }
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
      // NOTHING CAME BACK (DW-717), so the entry may be stored and the list on
      // screen is the stale one. The refetch runs FIRST and the sentence LAST:
      // `load` does not clear `feedback` on its way in, but its CATCH writes to
      // that same slot — and the likeliest reason a write went unconfirmed is a
      // connection that is still down, so the refetch usually rejects too. Set
      // the other way round, the owner reads `Failed to fetch` in place of the
      // one sentence that tells them the truth about their entry.
      const { message, unconfirmed } = writeFailure(error, "save this entry");
      if (unconfirmed) await load();
      setFeedback({ ok: false, message });
    } finally {
      setSaving(false);
    }
  }

  async function remove(entry: NamesTermEntry) {
    // BEFORE the confirm, never in front of the 403: a dialog asking the owner
    // to approve a removal the deployment will refuse is a decision they were
    // never actually offered (the DW-265 shape).
    if (readOnly) return;
    if (!window.confirm(`Remove “${entry.canonical}” from Names & Terms?`)) return;
    setFeedback(null);
    try {
      await request(`/api/names-terms/${entry.id}`, { method: "DELETE" });
      setEntries((current) => current.filter((candidate) => candidate.id !== entry.id));
      if (editingId === entry.id) resetForm();
      setFeedback({ ok: true, message: `Removed “${entry.canonical}”.` });
    } catch (error) {
      // Refetch first, sentence last — see `save` for why the order is what
      // keeps the honest sentence on screen.
      const { message, unconfirmed } = writeFailure(error, "remove this entry");
      if (unconfirmed) await load();
      setFeedback({ ok: false, message });
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
            Teach work-wiki the preferred names, aliases, acronyms, and terms it should use
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
                  // `aria-disabled` dims a <select> but does NOT stop it
                  // moving, and this handler is destructive beyond the field
                  // itself: leaving "person" wipes role, organization and
                  // email. The handler is what actually refuses — the
                  // `WorkspacePurposeSettings` scenario-picker shape.
                  if (readOnly) return;
                  const kind = event.target.value as NamesTermKind;
                  setDraft({
                    ...draft,
                    kind,
                    ...(kind === "person"
                      ? {}
                      : { email: "", role: "", organization: "" }),
                  });
                }}
                // A `<select>` has no `readOnly`, which is why this half of
                // the form refuses differently from the text boxes below.
                aria-disabled={readOnly || undefined}
                aria-describedby={refusalIds}
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
                readOnly={readOnly}
                aria-describedby={refusalIds}
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
              readOnly={readOnly}
              aria-describedby={refusalIds}
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
                  readOnly={readOnly}
                  aria-describedby={refusalIds}
                  className="mt-1.5 block w-full rounded-lg border border-foreground/15 bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-foreground/30 focus:border-foreground/35"
                />
              </label>
              <label className="text-sm font-medium text-foreground/75">
                Organization
                <input
                  value={draft.organization ?? ""}
                  onChange={(event) => setDraft({ ...draft, organization: event.target.value })}
                  placeholder="Company or team"
                  readOnly={readOnly}
                  aria-describedby={refusalIds}
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
                  readOnly={readOnly}
                  aria-describedby={refusalIds}
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
              readOnly={readOnly}
              aria-describedby={refusalIds}
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
              readOnly={readOnly}
              aria-describedby={refusalIds}
              className="mt-1.5 block w-full resize-y rounded-lg border border-foreground/15 bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-foreground/30 focus:border-foreground/35"
            />
          </label>

          <button
            className={`btn primary mt-5 w-full justify-center${
              readOnly ? " opacity-60" : ""
            }`}
            type="submit"
            // `saving` is TRANSIENT and keeps `disabled`. The empty-draft guard
            // YIELDS to the refusal: on a read-only deployment the boxes above
            // are `readOnly`, so the draft can never be filled in and a
            // `disabled` button would take the one control carrying the
            // sentence out of the tab order — the DW-191/DW-299 defect.
            disabled={saving || (!readOnly && !draft.canonical.trim())}
            aria-disabled={readOnly || undefined}
            aria-describedby={refusalIds}
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
                        // The standing refusal is `aria-disabled`, never
                        // `disabled`: the button keeps its place in the tab
                        // order, and `remove` returns before its `window.confirm`.
                        aria-disabled={readOnly || undefined}
                        aria-describedby={refusalIds}
                        style={{
                          color: "var(--rust)",
                          ...(readOnly ? { opacity: 0.6 } : {}),
                        }}
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

      {/* Identified so every refused control above can point at it: this is the
          only place THIS store's reason is stated. Not `role="alert"` — nothing
          failed; it is the deployment's standing state. */}
      {readOnly && (
        <p
          id={readOnlyNoteId}
          className="mt-3 text-sm text-amber-700 dark:text-amber-400"
        >
          {NAMES_TERMS_READ_ONLY_COPY}
        </p>
      )}
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
