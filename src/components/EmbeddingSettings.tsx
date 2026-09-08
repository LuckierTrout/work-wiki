"use client";

import { useId } from "react";

// ---------------------------------------------------------------------------
// EmbeddingSettings — embedding model field + rebuild vector index section
// ---------------------------------------------------------------------------

/**
 * Why **Rebuild Vector Index** refuses on a read-only deployment (DW-387).
 *
 * The CLIENT mirror of `READ_ONLY_REFUSAL.embeddingRebuild` — what
 * `POST /api/settings/rebuild-embeddings` answers — and character-identical to
 * it, pinned by `read-only-copy-parity.test.ts`. Exported because it is the
 * sentence the button POINTS AT through `aria-describedby`.
 *
 * ITS OWN sentence rather than the page's banner. The banner states what
 * `PUT /api/settings` answers ("Settings cannot be changed…"), which is true of
 * every field above and false of this button: a rebuild edits no setting at
 * all. Reading the form's sentence before pressing and the rebuild door's
 * afterwards is exactly the drift DW-387 is about.
 *
 * Copy says work-wiki; the runtime identifier stays `YOPEDIA_READONLY`.
 */
export const EMBEDDING_REBUILD_READ_ONLY_COPY =
  "Embeddings cannot be rebuilt while this deployment is read-only.";

/**
 * The Workers AI hint, in the three states the deployment can actually be in
 * (DW-715).
 *
 * THREE WHOLE SENTENCES rather than a stem plus fragments, because each is a
 * different claim and each has to be readable as the whole of what is being
 * asserted. The provider half is resolved by `GET /api/settings`'s
 * `embeddingProviderInEffect`; the INDEX half is a separate, optional
 * `YOPEDIA_VECTORIZE` binding that the same response answers separately. The
 * hint used to state both off the provider alone, so a Workers AI deployment
 * with no index bound was told it had a 1,024-dimensional one.
 *
 * Only {@link EMBEDDING_WORKERS_AI_INDEX_COPY} carries a dimension: 1,024 is `bge-m3`'s
 * output width and the width an index has to be created at, which is advice
 * about an index that EXISTS. With none bound there is nothing for it to be a
 * property of, and with the binding unknown nothing resolved it either way — so
 * the shortest sentence, which claims only the provider, is what stands.
 */
export const EMBEDDING_WORKERS_AI_INDEX_COPY =
  "This deployment uses Cloudflare Workers AI with a 1,024-dimensional Vectorize index.";
export const EMBEDDING_WORKERS_AI_NO_INDEX_COPY =
  "This deployment uses Cloudflare Workers AI. No Vectorize index is bound.";
export const EMBEDDING_WORKERS_AI_COPY = "This deployment uses Cloudflare Workers AI.";

/**
 * Which of the three the hint has earned, or `""` when it has earned none.
 *
 * Pure, and gated on BOTH the resolved provider and the pinned model id exactly
 * as the composed sentence was (DW-616) — the id alone is what is SET, and
 * `EMBEDDING_MODEL=@cf/baai/bge-m3` can be pinned on a deployment that embeds
 * through OpenAI. A non-Workers deployment says nothing at all here, whatever
 * the binding answered.
 */
function workersAiHint(
  providerInEffect: string | null | undefined,
  effectiveModel: string | null,
  hasVectorizeBinding: boolean | null | undefined,
): string {
  if (providerInEffect !== "workers-ai" || effectiveModel !== "@cf/baai/bge-m3") return "";
  if (hasVectorizeBinding === true) return EMBEDDING_WORKERS_AI_INDEX_COPY;
  if (hasVectorizeBinding === false) return EMBEDDING_WORKERS_AI_NO_INDEX_COPY;
  return EMBEDDING_WORKERS_AI_COPY;
}

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
   * Which embedding provider this deployment ACTUALLY embeds through, as
   * `GET /api/settings` resolved it (DW-616).
   *
   * Read for ONE purpose: gating the Cloudflare Workers AI dimensions sentence
   * below, which is a claim about the deployment's INFRASTRUCTURE. The model id
   * alone does not carry it — an `EMBEDDING_MODEL=@cf/baai/bge-m3` pin on an
   * OpenAI deployment is reported truthfully in the locked box while the
   * resolver substitutes, and the sentence used to fire there and describe an
   * index that does not exist.
   *
   * SERVED, never derived here. `resolveEmbeddingProvider` auto-detects Workers
   * AI from the runtime binding with neither `EMBEDDING_PROVIDER` nor the stored
   * provider set — the normal shape of the deployment the sentence IS true of —
   * so an env→store ladder walked in the browser would silence the sentence
   * exactly where it belongs.
   *
   * Optional, and absent means "nobody answered the question", which makes NO
   * Workers AI claim rather than assuming one: a statement about infrastructure
   * is only worth rendering when something actually resolved it. Every caller
   * that does not pass it renders byte-identically to before this prop existed.
   */
  providerInEffect?: string | null;
  /**
   * Whether `YOPEDIA_VECTORIZE` is bound, as `GET /api/settings` read it
   * (DW-715).
   *
   * The SECOND fact the Workers AI sentence above needs, and independent of the
   * provider. The binding is optional — the R2 provider holds it as
   * `VectorizeIndex | undefined` and guards every vector call on it — so a
   * deployment can resolve Workers AI and have no index at all, which is the
   * state the old single sentence described as having a 1,024-dimensional one.
   *
   * SERVED, never derived here: a binding is readable only inside a Workers
   * request scope, and nothing in the browser can ask.
   *
   * THREE-STATE, like {@link EmbeddingSettingsProps.providerInEffect}. `null`
   * (the default, and what every caller that does not pass it gets) is "nobody
   * answered", which drops the index clause and leaves the provider clause —
   * independently resolved — standing. It never guesses a binding.
   */
  hasVectorizeBinding?: boolean | null;
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

/**
 * The id the default-model hint is announced under (DW-506).
 *
 * The sentence below the field — "Leave empty to use the embedding provider
 * default.", or the `EMBEDDING_MODEL` pin (plus the Workers AI dimensions note)
 * on the locked branch — sat beside the input with nothing tying the two
 * together, which is the gap
 * `SettingsCanvas.tsx:561,614` states the convention against: a hint merely
 * adjacent to a control is invisible to a screen reader, so the owner heard the
 * label and never what an empty box would do.
 *
 * UNCONDITIONAL, unlike the two notes above: that `<p>` renders on both
 * branches of the env/editable ternary, so the id is always in the document and
 * the "never name an absent element" rule is satisfied by construction rather
 * than by a gate. It joins `notes` LAST of the three ids this component owns —
 * after {@link OVERRIDE_NOTE_ID} and {@link VECTOR_NOTICE_ID}, which is DOM
 * reading order for those three nodes — with the page's read-only id ahead of
 * all of them (DW-560), because the banner renders above this whole section.
 *
 * DESCRIBES, does not mark, like the other two: an empty box is the documented
 * way to ask for the provider default, not an error.
 */
const MODEL_HINT_ID = "embeddingModelHint";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EmbeddingSettings({
  embeddingModel,
  setEmbeddingModel,
  effectiveModel,
  modelSource,
  modelInEffect,
  providerInEffect = null,
  hasVectorizeBinding = null,
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
  // The Workers AI clause the env-locked hint has earned, or `""` (DW-715).
  // Resolved ONCE here rather than inside the branch below, so the condition and
  // the string it appends can never be two different calls.
  const workersAiClause = workersAiHint(
    providerInEffect,
    effectiveModel,
    hasVectorizeBinding,
  );
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
  /**
   * The id {@link EMBEDDING_REBUILD_READ_ONLY_COPY} is announced under (DW-387).
   *
   * Its own node rather than a share of the page's banner: the two sentences
   * describe two different doors, and one id naming both would announce the
   * form's refusal beside a button the form's door has nothing to do with.
   *
   * `useId()` rather than a module constant like the two notes above, because
   * unlike them it is minted per MOUNT: `OVERRIDE_NOTE_ID` and
   * `VECTOR_NOTICE_ID` predate this change and are the page's to keep, but a
   * second `EmbeddingSettings` in one document would make a hardcoded id a
   * duplicate, and `aria-describedby` would resolve to whichever copy the
   * document happened to reach first. Rendered only while `readOnly`, so the
   * attribute is only ever set when there is a node with this id to point at.
   */
  const rebuildReadOnlyNoteId = useId();
  const notes =
    [
      // FIRST, and it is the PAGE's node (DW-560). The read-only banner renders
      // above this whole section, so leading the list IS its DOM reading-order
      // position — the same rule the three ids below are ordered by. It used to
      // trail them, while `ProviderForm`'s model box led with it, so one
      // sentence on one page was announced in two different positions depending
      // on which model box the owner reached. `ProviderFormProps.describedBy`'s
      // composition is the order this was moved onto, not the other way round.
      readOnlyNoteId,
      showOverrideNote ? OVERRIDE_NOTE_ID : null,
      showVectorNotice ? VECTOR_NOTICE_ID : null,
      // Unconditional, and LAST of the three ids this component owns — the hint
      // `<p>` renders below both notes and above nothing this component points
      // at.
      MODEL_HINT_ID,
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
        // AN `<output>`, not a `<div>` — one shape for the page's two locked
        // model boxes (DW-562); `ProviderForm.tsx`'s twin branch spells the
        // reasoning out in full. The short version: `<output>` is one of HTML's
        // labelable elements, so the `<label htmlFor="embeddingModel">` above
        // names this box natively, exactly as it names the editable branch's
        // `<input>`. A bare `<div>` could not be named by that label at all —
        // `for` associates only with a labelable element, and a browser and
        // Testing Library both REFUSE the association rather than one of them
        // going along with it — so this box was announced with no accessible
        // name, and the ELEMENT is what had to change.
        //
        // `aria-live="off"` because `<output>`'s implicit role is `status`,
        // which is a LIVE REGION, and this box re-renders whenever
        // `/api/settings` answers. The role STAYS — it is what the box is
        // exposed as, and what its accessible name is computed for — and only
        // the live-region behaviour is silenced. No EXPLICIT `role` and no
        // `tabIndex`: a widget role on an unfocusable element is a control
        // assistive tech cannot operate, and making the box focusable would
        // change `/settings`' keyboard order.
        //
        // Still NO `aria-describedby`, which is the DESCRIPTION rather than the
        // name: the note lands immediately after this box in reading order,
        // which is what carries it here, and the editable branch below keeps the
        // attribute because a description on a form control is announced with
        // the control rather than only when the reader reaches it.
        //
        // `block w-full` restores what the `<div>` had for free — `<output>` is
        // inline by default.
        <output
          id="embeddingModel"
          aria-live="off"
          className="mt-1.5 block w-full rounded-md border border-foreground/10 bg-foreground/5 px-3 py-2 text-sm text-foreground/60 font-mono"
        >
          {effectiveModel}
        </output>
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

        This sentence has a TWIN: `settingsModelSubstitutedCopy` in
        `workbench-settings.ts` says the same fact on the Workbench canvas, and
        `DEPLOY.md` block-quotes that variant for operators. Exactly ONE clause
        differs, on purpose — the note BELOW says "the model above", because it
        sits under a box that always shows the value it means; the CANVAS
        sentence says "the model that is set", because its box is empty whenever
        `EMBEDDING_MODEL` owns the value. Reword any clause here and
        `src/components/__tests__/embedding-substitution-copy-parity.test.tsx`
        fails until every copy is considered.
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
      {/*
        OUTSIDE the env/editable ternary above, so its id is unconditional —
        whichever sentence the branch selects, the node named by
        {@link MODEL_HINT_ID} is in the document.
      */}
      <p id={MODEL_HINT_ID} className="mt-1 text-xs text-foreground/40">
        {modelSource === "env"
          ? // The locked branch has no box to empty (DW-559): it is an
            // `<output>`, it takes no keystroke, and a save would not move what
            // pinned the value — so "Leave empty to use the embedding provider
            // default." was advice the control refuses. The pin is what is
            // true, said in the shape every other env row on this surface uses
            // (`settingsEnvOverrideCopy` / `settingsEnvProviderPinCopy`).
            //
            // It NAMES the variable, unlike `ProviderForm`'s twin: `source ===
            // "env"` here comes from `embeddingModelAnswer`, whose only env leg
            // is `getEmbeddingModelOverride()`, which reads `EMBEDDING_MODEL`
            // and nothing else. There is no second candidate to guess between.
            //
            // The Workers AI dimensions sentence COMPOSES rather than being
            // replaced: it answers a different question — what an index built
            // here has to match — and it was the only sentence this branch had,
            // so dropping it would trade one gap for another.
            //
            // It is gated on the PROVIDER as well as on the model id (DW-616).
            // The id alone is what is SET, and `EMBEDDING_MODEL=@cf/baai/bge-m3`
            // can be pinned on a deployment that embeds through OpenAI — the
            // resolver substitutes, the override note above already says so, and
            // this sentence was still claiming a Vectorize index that is not
            // there. `providerInEffect` is what the resolver ANSWERED, so both
            // halves of the condition have to hold. Absent (`null`) makes no
            // claim: the model term is deliberately unchanged, so the inverse
            // gap — Workers AI in effect under a non-Workers pin — stays as it
            // was.
            //
            // The sentence itself is now SPLIT on a second served fact (DW-715).
            // It used to state the provider and the index together off the
            // provider alone, but `YOPEDIA_VECTORIZE` is an independent optional
            // binding — see `workersAiHint`, which owns all three forms so no
            // caller can inline a fourth.
            "The environment sets EMBEDDING_MODEL, and that wins at runtime. " +
            "This box is fixed until that variable is unset." +
            (workersAiClause ? ` ${workersAiClause}` : "")
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
          // ITS OWN door's sentence, not the page banner's — see
          // `EMBEDDING_REBUILD_READ_ONLY_COPY`.
          aria-describedby={readOnly ? rebuildReadOnlyNoteId : undefined}
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
      {/* Identified so the button above can point at it: this is the only place
          the reason for ITS refusal is stated. Not `role="alert"` — nothing
          failed; it is the deployment's standing state. */}
      {readOnly && (
        <p
          id={rebuildReadOnlyNoteId}
          className="mt-2 text-xs text-amber-700 dark:text-amber-500"
        >
          {EMBEDDING_REBUILD_READ_ONLY_COPY}
        </p>
      )}
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
