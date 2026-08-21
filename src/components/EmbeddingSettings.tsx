"use client";

// ---------------------------------------------------------------------------
// EmbeddingSettings — embedding model field + rebuild vector index section
// ---------------------------------------------------------------------------

export interface EmbeddingSettingsProps {
  embeddingModel: string;
  setEmbeddingModel: (v: string) => void;
  effectiveModel: string | null;
  modelSource: "env" | "config" | "default" | "none";
  /**
   * The model this deployment ACTUALLY embeds with (DW-274). Only read when
   * {@link EmbeddingSettingsProps.overridden} is true.
   */
  modelInEffect: string | null;
  /**
   * True when the model above is SET but something else is embedding — the
   * embedding provider cannot serve it, so the resolver substitutes its own
   * default. False renders exactly what this component rendered before the
   * flag existed.
   */
  overridden: boolean;
  /**
   * What the STORED vector switch has to say, or nothing (DW-327).
   *
   * One READY sentence, produced by `vectorSearchInactiveCopy` in
   * `workbench-settings.ts` and passed through — never composed here. This
   * component knows nothing about legs, providers or endpoints, and the state
   * it describes is one the flat page cannot edit at all; re-deriving any part
   * of it here would be a second answer to a question the module already
   * answers for the Workbench and for the route's refusals.
   *
   * Optional and absent by default, so every caller that does not pass it — and
   * every existing test — renders byte-identically to before.
   */
  vectorNotice?: string | null;
  rebuilding: boolean;
  onRebuild: () => void;
  rebuildResult: { ok: boolean; message: string } | null;
  /**
   * `YOPEDIA_READONLY=1`, as `GET /api/settings` reported it (DW-299).
   *
   * Refuses PER CONTROL rather than through the page's old
   * `<fieldset disabled>` — see `ProviderFormProps.readOnly` for the DW-191
   * reasoning. Here that covers TWO controls: the model box, whose stored value
   * must stay readable and reachable, and Rebuild Vector Index, whose route
   * (`POST /api/settings/rebuild-embeddings`) already answers 403 — so the
   * button was live-looking over a refusal it would only meet after a round
   * trip.
   *
   * Optional and off by default, so every existing caller renders unchanged.
   */
  readOnly?: boolean;
  /**
   * The id of the sentence that says WHY — see `ProviderFormProps.describedBy`.
   *
   * COMPOSED with this component's own two notes rather than replacing them: a
   * read-only deployment can be substituting an embedding model and reporting
   * an inactive vector switch at the same time, and a control that stated only
   * one of the three reasons would describe part of why it will not run.
   */
  describedBy?: string;
}

/**
 * The id the override note is announced under.
 *
 * The note DESCRIBES the field, it does not invalidate it: a substitution owned
 * by `EMBEDDING_MODEL` cannot be fixed from this box at all, and marking a
 * control the owner cannot fix from where they are standing is a dead end
 * (DEPLOY.md's "describe, do not mark" rule). So no `aria-invalid`, and the
 * save is not blocked.
 */
const OVERRIDE_NOTE_ID = "embeddingModelOverride";

/**
 * The id the vector notice is announced under (DW-327).
 *
 * Its own id rather than a second sentence inside the override note: the two
 * are independent — a deployment can be substituting a model, reporting an
 * inactive switch, both, or neither — and an `aria-describedby` naming one id
 * for two conditions would describe the wrong one half the time.
 *
 * DESCRIBES, does not mark, for the same reason the override note does: the
 * vector switch and every leg it names live on the Workbench surface, so
 * marking the model box `aria-invalid` here would blame the one control the
 * owner CAN reach for a state that is mostly not its doing — and the save is
 * not blocked, because the flat page is allowed to land edits over an
 * already-inactive switch (DW-303).
 */
const VECTOR_NOTICE_ID = "embeddingVectorNotice";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EmbeddingSettings({
  embeddingModel,
  setEmbeddingModel,
  effectiveModel,
  modelSource,
  modelInEffect,
  overridden,
  vectorNotice,
  rebuilding,
  onRebuild,
  rebuildResult,
  readOnly = false,
  describedBy,
}: EmbeddingSettingsProps) {
  // ONE condition, read by both the note and the `aria-describedby` that points
  // at it — two expressions would be two rules that agree today, and the way
  // they would disagree is a description pointing at an element that is not in
  // the document.
  const showOverrideNote = overridden && modelInEffect !== null;
  // The same discipline for the second note, and then ONE list built from the
  // two conditions — so the attribute can never name an id that is not in the
  // document, and never omit one that is. `undefined` rather than `""` when
  // both are absent, which is what keeps the "no dangling describedby" property
  // literally true rather than merely empty.
  const showVectorNotice = typeof vectorNotice === "string" && vectorNotice.length > 0;
  // The page's read-only sentence joins the same list rather than replacing it:
  // all three conditions are independent, and the attribute must name exactly
  // the ids that are in the document. `readOnlyNoteId` is guarded on `readOnly`
  // as well as on being passed, so a caller that hands down an id without the
  // flag cannot leave a dangling pointer.
  const readOnlyNoteId = readOnly && describedBy ? describedBy : null;
  const notes =
    [
      showOverrideNote ? OVERRIDE_NOTE_ID : null,
      showVectorNotice ? VECTOR_NOTICE_ID : null,
      readOnlyNoteId,
    ]
      .filter((id): id is string => id !== null)
      .join(" ") || undefined;
  return (
    <div>
      <label
        htmlFor="embeddingModel"
        className="block text-sm font-medium text-foreground/80"
      >
        Embedding Model{" "}
        <span className="font-normal text-foreground/40">(optional)</span>
      </label>
      {modelSource === "env" ? (
        // NO `aria-describedby` here, deliberately. This branch is a plain
        // non-focusable `<div>` with no role, and assistive tech does not
        // expose a description on one — the attribute would be decoration. What
        // actually carries the note on this branch is reading order: it follows
        // the box immediately. The editable branch below keeps the attribute
        // because an `<input>` IS exposed, and a description on a form control
        // is announced with the control rather than only when the user reaches
        // it in the reading order.
        <div className="mt-1.5 rounded-md border border-foreground/10 bg-foreground/5 px-3 py-2 text-sm text-foreground/60 font-mono">
          {effectiveModel}
        </div>
      ) : (
        <input
          id="embeddingModel"
          type="text"
          value={embeddingModel}
          onChange={(e) => setEmbeddingModel(e.target.value)}
          placeholder="e.g. text-embedding-3-small (OpenAI) or embedding-001 (Google)"
          className="mt-1.5 block w-full rounded-md border border-foreground/20 bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:border-foreground/40 focus:outline-none focus:ring-1 focus:ring-foreground/20 font-mono"
          readOnly={readOnly}
          aria-describedby={notes}
        />
      )}
      {/*
        The field above goes on showing what is SET — the env value in the
        locked box, the stored value in the editable input — and this names
        what is IN EFFECT beside it. Both are true, and neither alone is the
        answer the owner came to this page for.

        Guarded on BOTH props, not on the flag alone. `getEffectiveSettings`
        cannot currently hand down `overridden: true` with a null
        `modelInEffect` — the flag's own rule requires an in-effect value — but
        the prop types permit the pair and the page's two `??` fallbacks are
        independent of each other, so a half-wired caller would render "This
        deployment embeds with  — the embedding provider cannot serve…". A
        sentence with a hole where the model name goes is worse than no
        sentence.
      */}
      {showOverrideNote && (
        <p
          id={OVERRIDE_NOTE_ID}
          className="mt-1.5 text-xs text-amber-700 dark:text-amber-500"
        >
          Not in effect. This deployment embeds with{" "}
          <span className="font-mono">{modelInEffect}</span> — the embedding
          provider cannot serve the model above, so it uses its own default
          instead. Vectors are tagged with the model that produced them, so an
          index built with a different model needs rebuilding.
        </p>
      )}
      {/*
        The STORED vector switch, said on the page that cannot see it (DW-327).

        It sits in the embedding block because every leg the sentence can name
        is an embedding setting, and the model box above is the one of them this
        page renders. The sentence itself arrives finished from
        `workbench-settings.ts` — this is a render, not a decision.
      */}
      {showVectorNotice && (
        <p
          id={VECTOR_NOTICE_ID}
          className="mt-1.5 text-xs text-amber-700 dark:text-amber-500"
        >
          {vectorNotice}
        </p>
      )}
      <p className="mt-1 text-xs text-foreground/40">
        {modelSource === "env" && effectiveModel === "@cf/baai/bge-m3"
          ? "This deployment uses Cloudflare Workers AI with a 1,024-dimensional Vectorize index."
          : "Leave empty to use the embedding provider default."}
      </p>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          // BEFORE the request, like every other refusing control: the route
          // answers 403 either way, and a rebuild the owner waits out only to
          // be refused is the harm the gate exists to remove.
          onClick={() => {
            if (readOnly) return;
            onRebuild();
          }}
          // `rebuilding` is TRANSIENT and keeps `disabled`; the standing
          // refusal is `aria-disabled`, so the button stays in the tab order
          // and can be announced with the sentence it points at.
          disabled={rebuilding}
          aria-disabled={readOnly || undefined}
          aria-describedby={readOnly ? readOnlyNoteId ?? undefined : undefined}
          className={`rounded-md border border-foreground/20 px-3 py-1.5 text-xs font-medium text-foreground/80 transition-colors disabled:opacity-50 ${
            readOnly ? "opacity-50 cursor-default" : "hover:bg-foreground/5"
          }`}
        >
          {rebuilding ? (
            <span className="inline-flex items-center gap-1.5">
              <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Rebuilding…
            </span>
          ) : (
            "Rebuild Vector Index"
          )}
        </button>
      </div>
      {rebuildResult && (
        <div
          className={`mt-2 rounded-lg border p-3 text-sm ${
            rebuildResult.ok
              ? "border-green-500/20 bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400"
              : "border-red-500/20 bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400"
          }`}
        >
          {rebuildResult.message}
        </div>
      )}
    </div>
  );
}
