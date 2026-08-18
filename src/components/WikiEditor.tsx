"use client";

import Link from "next/link";
import { useId, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { getErrorMessage } from "@/lib/errors";
import { Alert } from "@/components/Alert";
import { IF_MATCH_HEADER, formatIfMatch } from "@/lib/write-precondition";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MetadataValues {
  confidence: number | null;
  disputed: boolean;
  tags: string[];
  aliases: string[];
  expiry: string;
  valid_from: string;
  supersedes: string;
}

/**
 * Why Save refuses. One owner for the wording, phrased like every other
 * read-only sentence in the app, and stated ABOVE the fields rather than only
 * beside the button: the harm DW-149 names is retyping a whole page before
 * finding out, so the owner has to meet this before they start typing.
 */
export const EDIT_PAGE_READ_ONLY_COPY =
  "This page cannot be saved while this deployment is read-only. Your edits here will not be stored.";

interface WikiEditorProps {
  slug: string;
  /** The page's tenant — where to navigate after a successful save. */
  tenant: string;
  initialContent: string;
  /**
   * The WRITE PRECONDITION for the page this form was seeded from (DW-38,
   * DW-51) — `contentVersion` of the WHOLE stored file, computed on the server
   * by the edit page and sent back as `If-Match` on the body `PUT`.
   *
   * Captured WITH the seed and never re-derived: this form can sit open for as
   * long as it takes to rewrite a page, and an unconditional save would replace
   * whatever another actor stored in the meantime.
   *
   * REQUIRED, so a call site that forgets it is a compile error rather than a
   * form whose Save can only ever be answered 428. It is the SEED of the
   * version state below, not the value that is sent: a landed `PUT` answers a
   * new one, and the form adopts it.
   */
  initialVersion: string;
  initialMetadata?: MetadataValues;
  /**
   * `YOPEDIA_READONLY=1`, read on the server by the edit page and threaded down.
   *
   * `PUT` and `PATCH /api/wiki/[slug]` both answer 403 on such a deployment
   * (DW-37), and this form's Save fires both. Left ungated the owner rewrites an
   * entire page and meets the refusal only at Save. The convention is the one
   * the rest of DW-37 uses: `aria-disabled` rather than `disabled` (the button
   * stays focusable, so the sentence explaining it can be announced), a handler
   * that returns before either request, and the sentence on screen from the
   * moment the form renders.
   *
   * The fields stay editable on purpose — read-only means the SERVER refuses a
   * write, and a reader who wants to draft, copy out, or diff text in the box
   * loses nothing the deployment was protecting.
   */
  readOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Small sub-components
// ---------------------------------------------------------------------------

/** Inline chip list with add / remove for tags and aliases. */
function ChipInput({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");

  function add() {
    const trimmed = draft.trim();
    if (trimmed && !values.includes(trimmed)) {
      onChange([...values, trimmed]);
    }
    setDraft("");
  }

  return (
    <div>
      <span className="block text-xs font-medium text-foreground/60 mb-1">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5 mb-1.5">
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 rounded-full bg-foreground/10 px-2.5 py-0.5 text-xs"
          >
            {v}
            <button
              type="button"
              onClick={() => onChange(values.filter((x) => x !== v))}
              className="hover:text-red-500 transition-colors"
              aria-label={`Remove ${v}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder={placeholder}
          className="flex-1 rounded border border-foreground/20 bg-transparent px-2 py-1 text-sm placeholder:text-foreground/40 focus:border-foreground/50 focus:outline-none transition-colors"
        />
        <button
          type="button"
          onClick={add}
          disabled={!draft.trim()}
          className="rounded border border-foreground/20 px-2 py-1 text-xs hover:bg-foreground/10 transition-colors disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dirty detection helper
// ---------------------------------------------------------------------------

function isMetadataDirty(
  current: MetadataValues,
  initial: MetadataValues,
): boolean {
  if (current.confidence !== initial.confidence) return true;
  if (current.disputed !== initial.disputed) return true;
  if (current.expiry !== initial.expiry) return true;
  if (current.valid_from !== initial.valid_from) return true;
  if (current.supersedes !== initial.supersedes) return true;
  if (current.tags.length !== initial.tags.length) return true;
  if (current.tags.some((t, i) => t !== initial.tags[i])) return true;
  if (current.aliases.length !== initial.aliases.length) return true;
  if (current.aliases.some((a, i) => a !== initial.aliases[i])) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Build PATCH payload — always send all 7 keys so users can clear fields
// ---------------------------------------------------------------------------

function buildPatchPayload(values: MetadataValues): Record<string, unknown> {
  return {
    confidence: values.confidence,
    disputed: values.disputed,
    tags: values.tags,
    aliases: values.aliases,
    expiry: values.expiry || null,
    valid_from: values.valid_from || null,
    supersedes: values.supersedes || null,
  };
}

// ---------------------------------------------------------------------------
// Main editor
// ---------------------------------------------------------------------------

const DEFAULT_METADATA: MetadataValues = {
  confidence: null,
  disputed: false,
  tags: [],
  aliases: [],
  expiry: "",
  valid_from: "",
  supersedes: "",
};

export function WikiEditor({
  slug,
  tenant,
  initialContent,
  initialVersion,
  initialMetadata,
  readOnly = false,
}: WikiEditorProps) {
  const router = useRouter();

  // Body state
  const [content, setContent] = useState(initialContent);
  const bodyDirty = content !== initialContent;

  // Metadata state — real useState so React re-renders on change
  const initial = initialMetadata ?? DEFAULT_METADATA;
  const [metadata, setMetadata] = useState<MetadataValues>(initial);
  const metadataDirty = isMetadataDirty(metadata, initial);

  const dirty = bodyDirty || metadataDirty;

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * The precondition the NEXT `PUT` is conditional on. Seeded from the prop and
   * re-stamped from every landed save — the same move `PreviewColumn` makes
   * with `result.version`.
   *
   * State rather than the prop directly, because this form does TWO writes and
   * the second can fail on its own: a `PUT` that lands followed by a `PATCH`
   * that does not leaves the form open with `bodyDirty` still true, and a retry
   * holding the ORIGINAL version would be refused 412 — "changed somewhere
   * else while you were editing", about a change the owner made themselves a
   * second earlier, with no way out but a reload.
   */
  const [version, setVersion] = useState(initialVersion);
  const readOnlyNoteId = useId();

  const updateField = useCallback(
    <K extends keyof MetadataValues>(key: K, value: MetadataValues[K]) => {
      setMetadata((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  // ------ save handler ------

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    // The guard lives HERE, not only on the button: a form with a text field
    // submits on Enter, which would reach past an `aria-disabled` Save.
    if (readOnly) return;
    if (!content.trim()) {
      setError("Content cannot be empty");
      return;
    }

    setBusy(true);
    setError(null);

    try {
      // 1. Save body if changed (PUT)
      if (bodyDirty) {
        const res = await fetch(`/api/wiki/${slug}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            // The PUT leg only. `PATCH` is metadata, which this story
            // deliberately does not gate — see `route.ts`.
            ...(version ? { [IF_MATCH_HEADER]: formatIfMatch(version) } : {}),
          },
          body: JSON.stringify({ content }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `body save failed (${res.status})`);
        }
        // The version of what LANDED, adopted before the PATCH leg can fail —
        // otherwise a retry after a failed PATCH re-sends a version this very
        // request superseded. Parsed with the same guard the error branch
        // above uses: a body that will not parse leaves the old version in
        // place, and the next save is refused rather than blind.
        const landed = (await res.json().catch(() => null)) as {
          version?: unknown;
        } | null;
        if (typeof landed?.version === "string" && landed.version.length > 0) {
          setVersion(landed.version);
        }
      }

      // 2. Save metadata if changed (PATCH)
      if (metadataDirty) {
        const res = await fetch(`/api/wiki/${slug}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ metadata: buildPatchPayload(metadata) }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(
            body.error ?? `metadata save failed (${res.status})`,
          );
        }
      }

      router.push(`/u/${tenant}/${slug}`);
      router.refresh();
    } catch (err) {
      setError(getErrorMessage(err, "unknown error"));
      setBusy(false);
    }
  }

  // ------ confidence display helper ------
  const confidenceDisplay =
    metadata.confidence !== null
      ? `${Math.round(metadata.confidence * 100)}%`
      : "—";

  return (
    <form onSubmit={handleSave} className="mt-6 space-y-6">
      {/* FIRST, above every field: the harm this prevents is a whole page
          retyped before the refusal arrives, so the sentence has to be met
          before the typing starts — not discovered beside a dimmed Save. Not
          `role="alert"`: nothing failed, this is the deployment's standing
          state, and announcing it on every mount would interrupt. */}
      {readOnly && (
        <p
          id={readOnlyNoteId}
          className="rounded-lg border border-foreground/20 bg-foreground/5 p-3 text-sm text-foreground/70"
        >
          {EDIT_PAGE_READ_ONLY_COPY}
        </p>
      )}

      {/* ── Metadata section ── */}
      {initialMetadata && (
        <details className="rounded-lg border border-foreground/20 p-4" open>
          <summary className="cursor-pointer text-sm font-semibold select-none">
            Page Metadata
            {metadataDirty && (
              <span className="ml-2 text-xs text-yellow-500 font-normal">
                (modified)
              </span>
            )}
          </summary>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {/* Confidence */}
            <div>
              <label
                htmlFor="confidence"
                className="block text-xs font-medium text-foreground/60 mb-1"
              >
                Confidence{" "}
                <span className="text-foreground/40">{confidenceDisplay}</span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="confidence"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={metadata.confidence ?? 0.5}
                  onChange={(e) =>
                    updateField("confidence", parseFloat(e.target.value))
                  }
                  className="flex-1"
                />
                <button
                  type="button"
                  onClick={() => updateField("confidence", null)}
                  className="text-xs text-foreground/40 hover:text-foreground transition-colors"
                  title="Clear confidence"
                >
                  Clear
                </button>
              </div>
            </div>

            {/* Disputed toggle */}
            <div className="flex items-center gap-2">
              <label
                htmlFor="disputed"
                className="text-xs font-medium text-foreground/60"
              >
                Disputed
              </label>
              <button
                id="disputed"
                type="button"
                role="switch"
                aria-checked={metadata.disputed}
                onClick={() => updateField("disputed", !metadata.disputed)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                  metadata.disputed ? "bg-red-500" : "bg-foreground/20"
                }`}
              >
                <span
                  className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                    metadata.disputed ? "translate-x-4.5" : "translate-x-0.5"
                  }`}
                />
              </button>
              {metadata.disputed && (
                <span className="text-xs text-red-500">⚠ Disputed</span>
              )}
            </div>

            {/* Expiry */}
            <div>
              <label
                htmlFor="expiry"
                className="block text-xs font-medium text-foreground/60 mb-1"
              >
                Expiry
              </label>
              <input
                id="expiry"
                type="date"
                value={metadata.expiry}
                onChange={(e) => updateField("expiry", e.target.value)}
                className="w-full rounded border border-foreground/20 bg-transparent px-2 py-1 text-sm focus:border-foreground/50 focus:outline-none transition-colors"
              />
            </div>

            {/* Valid from */}
            <div>
              <label
                htmlFor="valid_from"
                className="block text-xs font-medium text-foreground/60 mb-1"
              >
                Valid from
              </label>
              <input
                id="valid_from"
                type="date"
                value={metadata.valid_from}
                onChange={(e) => updateField("valid_from", e.target.value)}
                className="w-full rounded border border-foreground/20 bg-transparent px-2 py-1 text-sm focus:border-foreground/50 focus:outline-none transition-colors"
              />
            </div>

            {/* Supersedes */}
            <div className="sm:col-span-2">
              <label
                htmlFor="supersedes"
                className="block text-xs font-medium text-foreground/60 mb-1"
              >
                Supersedes (slug)
              </label>
              <input
                id="supersedes"
                type="text"
                value={metadata.supersedes}
                onChange={(e) => updateField("supersedes", e.target.value)}
                placeholder="e.g. old-page-slug"
                className="w-full rounded border border-foreground/20 bg-transparent px-2 py-1 text-sm placeholder:text-foreground/40 focus:border-foreground/50 focus:outline-none transition-colors"
              />
            </div>

            {/* Tags */}
            <div className="sm:col-span-2">
              <ChipInput
                label="Tags"
                values={metadata.tags}
                onChange={(v) => updateField("tags", v)}
                placeholder="Add tag…"
              />
            </div>

            {/* Aliases */}
            <div className="sm:col-span-2">
              <ChipInput
                label="Aliases"
                values={metadata.aliases}
                onChange={(v) => updateField("aliases", v)}
                placeholder="Add alias…"
              />
            </div>
          </div>
        </details>
      )}

      {/* ── Body textarea ── */}
      <div>
        <label
          htmlFor="content"
          className="block text-sm font-medium mb-2"
        >
          Markdown
          {bodyDirty && (
            <span className="ml-2 text-xs text-yellow-500 font-normal">
              (modified)
            </span>
          )}
        </label>
        <textarea
          id="content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          required
          spellCheck={false}
          className="w-full min-h-[500px] rounded-lg border border-foreground/20 bg-transparent px-4 py-3 font-mono text-sm placeholder:text-foreground/40 focus:border-foreground/50 focus:outline-none transition-colors resize-y"
        />
        <p className="mt-2 text-xs text-foreground/40">
          The first <code>#</code> heading will become the page title.
        </p>
      </div>

      {error && (
        <Alert variant="error">
          {error}
        </Alert>
      )}

      <div className="flex items-center gap-4">
        <button
          type="submit"
          // `disabled` stays for the transient states it already covered, but
          // NOT on a read-only deployment: `!dirty` is the state an owner who
          // never types stays in, so leaving it on would take the button out
          // of the tab order in exactly the case the refusal exists for, and
          // the `aria-disabled` and `aria-describedby` below would never be
          // reached. The standing refusal is `aria-disabled`, which keeps the
          // button focusable so the sentence above is announced with it; the
          // submit it lets through is caught by the guard in `handleSave`.
          disabled={!readOnly && (busy || !dirty)}
          aria-disabled={readOnly || undefined}
          aria-describedby={readOnly ? readOnlyNoteId : undefined}
          className={`inline-block rounded-lg bg-foreground px-6 py-3 text-sm font-medium text-background transition-opacity disabled:opacity-50 disabled:cursor-not-allowed ${
            readOnly ? "opacity-50 cursor-default" : "hover:opacity-90"
          }`}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <Link
          href={`/u/${tenant}/${slug}`}
          className="text-sm text-foreground/60 hover:text-foreground transition-colors"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
