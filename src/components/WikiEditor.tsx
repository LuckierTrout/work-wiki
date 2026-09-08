"use client";

import Link from "next/link";
import { useId, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  RequestFailedError,
  unconfirmedCause,
  writeFailure,
} from "@/lib/workbench-request";
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

/**
 * The ONE phrase every failed save on this form is described with (DW-624).
 *
 * A phrase and not a sentence, like `SETTINGS_SAVE_ACTION`: `writeFailure`
 * composes both renderings from it — the unknown-outcome sentence for a write
 * nothing came back to confirm, and the `Couldn’t …` fallback for a throw that
 * carried no message. Two sentences typed out beside each other is how they
 * drift.
 */
export const EDIT_PAGE_SAVE_ACTION = "save this page";

/**
 * THE partial-save sentence, for the save that half landed (DW-428).
 *
 * States two facts and relays a third: the body leg was answered `ok`, the
 * metadata leg was REFUSED, and here — verbatim, after the dash — is what the
 * server said about that refusal.
 *
 * It cannot be a server sentence. Each route handled ONE request and can only
 * speak about that one; a metadata refusal is written as "nothing was changed",
 * which is true of the metadata and false of the page whose body this form
 * already stored a moment earlier. Only this form knows a save was two writes,
 * so only this form can say which half survived — and without it the owner
 * reads a bare refusal, assumes the save did nothing, and retypes or reloads
 * over a body that is already on disk.
 *
 * NOT for a metadata leg whose outcome is UNKNOWN. A `fetch` that rejected —
 * dropped connection, aborted request — leaves nobody able to say the metadata
 * change "was not" applied; that branch says the provable half only, and its
 * sentence is {@link EDIT_PAGE_METADATA_UNCONFIRMED_COPY} below.
 */
export function partialSaveMessage(served: string): string {
  return `Your text was saved; the metadata change was not — ${served}`;
}

/**
 * The save whose body landed and whose METADATA REQUEST NOBODY ANSWERED
 * (DW-703).
 *
 * Its sibling above relays a served reason because there was one. Here the
 * `PATCH` left and nothing at all came back — a dropped connection, an aborted
 * request — so the only honest statement is the asymmetry: the text is on disk
 * (the `PUT` was answered `ok`, which is the fact only this form knows) and the
 * metadata half is genuinely unknown. Until now this branch reported
 * `unconfirmedWriteMessage`, which describes the WHOLE save as unknown and so
 * sent an owner to retype or reload over a body already stored — the very harm
 * the partial-save sentence exists to prevent, one cause over.
 *
 * THREE NEIGHBOURING BRANCHES ARE DELIBERATELY NOT THIS SENTENCE:
 *
 *   - a metadata leg a GATEWAY answered (502/504). Same information state, but
 *     DW-624 froze the one unconfirmed sentence there and pinned it; this
 *     sentence does not reopen a decision it is not fixing.
 *   - a metadata leg the ROUTE refused (`!res.ok` otherwise). The outcome is
 *     known and served — {@link partialSaveMessage} carries it.
 *   - the `PUT`'s own dying 2xx body read. The metadata request was NEVER SENT
 *     there, so "nothing came back to confirm the metadata change" would be a
 *     false claim about our own knowledge; nothing was ever asked.
 *
 * Says nothing about a retry of either half and carries no transport
 * vocabulary. The reconciliation it offers is the same MOVE
 * `unconfirmedWriteMessage` offers — go and look rather than press again — but
 * not the same words: that sentence says "the screen", because it speaks for
 * every surface in the app, and this one says "the page", because it speaks for
 * exactly one and can name it.
 */
export const EDIT_PAGE_METADATA_UNCONFIRMED_COPY =
  "Your text was saved; nothing came back to confirm whether the metadata " +
  "change went through, so that half is unknown. Check what the page shows " +
  "before trying again.";

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

    // Whether the body leg of THIS attempt was answered `ok` — the same
    // predicate that already lets execution reach the `PATCH` and that already
    // re-stamps `version` below. A plain local, so it starts false on every
    // attempt and cannot leak into a later one.
    let bodyLanded = false;
    // Whether the metadata `PATCH` is OUTSTANDING — sent, and not yet answered
    // (DW-703). True for exactly the window between the `fetch` call and the
    // `Response` coming back, so it is a claim about our own knowledge and
    // nothing else.
    //
    // "Sent" alone would be too broad in BOTH directions. `bodyLanded` cannot
    // tell an unanswered metadata leg from the `PUT`'s own dying 2xx body read:
    // that read rethrows AFTER `bodyLanded` is set and BEFORE this leg fires,
    // so both reach the outer `catch` with the same body-landed fact and the
    // same unconfirmed cause — which is why a second local is needed at all.
    // But a flag left true once the response ARRIVED would still be true at
    // `router.push` / `router.refresh()`, which run inside this same `try`: a
    // navigation that throws a `TypeError` is an unconfirmed cause too, and the
    // owner would be told the metadata outcome is unknown about a `PATCH` the
    // route answered `ok` a line earlier.
    let metadataOutstanding = false;

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
          // The STATUS rides the error (DW-624). The message is unchanged, so
          // every refusal this route composes — the 403 read-only sentence, the
          // 412 conflict, the 428 — reads exactly as before. What the status
          // buys is the gateway leg: a 502 or 504 came from something OTHER than
          // the route, so whether the page was written is unknown, and
          // `body save failed (504)` asserts an outcome nobody observed.
          throw new RequestFailedError(
            body.error ?? `body save failed (${res.status})`,
            res.status,
          );
        }
        bodyLanded = true;
        // The version of what LANDED, adopted before the PATCH leg can fail —
        // otherwise a retry after a failed PATCH re-sends a version this very
        // request superseded.
        //
        // The guard splits the two failures that were hiding behind one
        // `.catch(() => null)` (DW-624). A body that will not PARSE is the
        // route's arrived answer: it stays `null`, the OLD version is left in
        // place so the next save is refused rather than blind, and the PATCH
        // still fires — today's behaviour, unchanged. A read that DIES
        // mid-stream is the missing confirmation itself and is rethrown, so
        // the flow stops here rather than navigating away on a pre-save
        // version. The held version is deliberately NOT cleared on that path
        // either: a dying read is the same arrived 200 as an unparseable one.
        const landed = (await res.json().catch((cause: unknown) => {
          if (unconfirmedCause(cause)) throw cause;
          return null;
        })) as {
          version?: unknown;
        } | null;
        if (typeof landed?.version === "string" && landed.version.length > 0) {
          setVersion(landed.version);
        }
      }

      // 2. Save metadata if changed (PATCH)
      if (metadataDirty) {
        // Raised BEFORE the call and lowered the moment it returns. Before,
        // because the whole point of the local is the case where `fetch` itself
        // rejects; lowered on return, because a `Response` of ANY status is an
        // answer — the `!res.ok` path below is already excluded by the
        // `RequestFailedError` condition in the `catch`, so all this has to
        // record is that something came back at all.
        metadataOutstanding = true;
        const res = await fetch(`/api/wiki/${slug}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ metadata: buildPatchPayload(metadata) }),
        });
        metadataOutstanding = false;
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          // Every refusal that can reach here — the 403 read-only sentence, the
          // 400 field shapes, a 403 NOT_OWNER, a 404 — reads as "nothing was
          // changed". That is true of the METADATA and false of the page: the
          // `PUT` above already landed the body, which is the fact the version
          // docblock records and the fact the owner has no other way to learn.
          //
          // `served` is a non-empty STRING or nothing: the cast above is
          // unchecked and `??` only catches null/undefined, so a refusal
          // answering `{"error": ""}` would end the sentence on a dangling dash
          // and a non-string `error` would splice `[object Object]` into it.
          // The status fallback carries all three cases — it still proves the
          // metadata was not applied — and is prefixed for the same reason.
          const served =
            typeof body.error === "string" && body.error.length > 0
              ? body.error
              : `metadata save failed (${res.status})`;
          // The composition is unchanged, and so is the status-carrying rule
          // above. On a gateway status `writeFailure` never reaches this
          // message anyway — it answers the unconfirmed sentence instead, which
          // is the file's existing rule that an UNKNOWN metadata outcome takes
          // no partial-save prefix: "the metadata change was not" is precisely
          // the claim a 504 leaves nobody able to make.
          throw new RequestFailedError(
            bodyLanded ? partialSaveMessage(served) : served,
            res.status,
          );
        }
      }

      router.push(`/u/${tenant}/${slug}`);
      router.refresh();
    } catch (err) {
      // ONE owner for the verdict (DW-624). Both legs above throw the SERVER's
      // own sentence on a refusal, so `writeFailure` relays it exactly as
      // before — the DW-428 partial-save sentence included. What changes is the
      // throw nobody answered: a fired deadline, a dropped socket, a gateway
      // that gave up, or the dying 2xx body read above is now described as an
      // UNKNOWN outcome rather than in transport vocabulary.
      //
      // The reconciliation is that the flow STOPS: `router.push` is inside the
      // try, so the form stays open on the draft the owner typed, which is the
      // only screen that can still tell them what happened.
      //
      // ONE branch of that verdict is narrowed here (DW-703). `writeFailure`
      // stays the owner of WHETHER the outcome is known — this never re-derives
      // `unconfirmedCause` — and the four conditions below only select which of
      // two unknown-outcome sentences fits the facts this form holds: the body
      // leg was answered `ok`, the metadata request is still outstanding, and
      // the cause is not a `RequestFailedError`, i.e. nothing answered it at all
      // rather than a gateway answering instead of the route. Every other path
      // — the gateway one, the never-sent one, and a throw from the navigation
      // after both legs landed — keeps `writeFailure`'s own sentence verbatim.
      const failure = writeFailure(err, EDIT_PAGE_SAVE_ACTION);
      const metadataUnanswered =
        failure.unconfirmed &&
        bodyLanded &&
        metadataOutstanding &&
        !(err instanceof RequestFailedError);
      setError(
        metadataUnanswered
          ? EDIT_PAGE_METADATA_UNCONFIRMED_COPY
          : failure.message,
      );
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
