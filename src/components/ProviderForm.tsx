"use client";

// ---------------------------------------------------------------------------
// ProviderForm — provider / model / Ollama URL fields
// ---------------------------------------------------------------------------

import { PROVIDER_INFO, DEFAULT_MODELS } from "@/lib/providers";
import { SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY } from "@/lib/workbench-settings";
import { SourceBadge } from "@/components/SourceBadge";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SettingSource = "env" | "config" | "default" | "none";

interface EffectiveSettings {
  provider: string | null;
  providerSource: SettingSource;
  model: string | null;
  modelSource: SettingSource;
  configured: boolean;
  embeddingSupport: boolean;
  embeddingModel: string | null;
  embeddingModelSource: SettingSource;
  hasApiKey: boolean;
  ollamaBaseUrl: string | null;
  ollamaBaseUrlSource: SettingSource;
  /** Why the endpoint was thrown away, or `null` when it was not (DW-402). */
  ollamaBaseUrlIssue: string | null;
}

export interface ProviderFormProps {
  provider: string;
  setProvider: (v: string) => void;
  model: string;
  setModel: (v: string) => void;
  ollamaBaseUrl: string;
  setOllamaBaseUrl: (v: string) => void;
  settings: EffectiveSettings | null;
  onFieldChange?: () => void;
  /**
   * `YOPEDIA_READONLY=1`, as `GET /api/settings` reported it (DW-299).
   *
   * REFUSES PER CONTROL. `/settings` used to wrap this whole form in
   * `<fieldset disabled>`, which is the DW-191 defect: `disabled` on a fieldset
   * takes every descendant out of the tab order, so the STORED provider, model
   * and base URL — values the owner is entitled to READ — became unreachable by
   * keyboard and by screen reader on the one deployment where reading is all
   * that is left. So the select takes `aria-disabled` and a handler that
   * returns, the text inputs take `readOnly`, and the values stay where they
   * are.
   *
   * Optional and off by default, so every existing caller renders unchanged.
   */
  readOnly?: boolean;
  /**
   * The id of the sentence that says WHY a refused control refuses.
   *
   * Passed in rather than composed here: the page owns the sentence (one of
   * them, for the whole form), and a note minted per component would be the
   * same sentence three times over. `aria-disabled` alone announces "dimmed"
   * and a `readOnly` input announces "read only" — neither says read-only
   * DEPLOYMENT, which is the only part the owner can act on.
   */
  describedBy?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_OPTIONS = [
  { value: "", label: "— Select provider —" },
  ...PROVIDER_INFO,
] as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProviderForm({
  provider,
  setProvider,
  model,
  setModel,
  ollamaBaseUrl,
  setOllamaBaseUrl,
  settings,
  onFieldChange,
  readOnly = false,
  describedBy,
}: ProviderFormProps) {
  // The provider to use for conditional field display:
  // if form has a selection, use that; otherwise fall back to effective settings
  const effectiveProvider = provider || settings?.provider || null;
  const showOllamaUrl = effectiveProvider === "ollama";
  const showOllamaCloud = effectiveProvider === "ollama-cloud";
  /**
   * `Custom` is selectable here but not CONFIGURABLE here (DW-61).
   *
   * This form renders no base-URL and no API-key input, and it deliberately
   * gains none: a second editor for `customBaseUrl`/`customApiKey` would give
   * two surfaces a lost-update race over the same two stored fields (DW-63's
   * gap), which the 2026-08-18 decision on DW-61 rules out in as many words. So
   * the option stays and the page says where the other two halves live —
   * otherwise a save here stores a provider `src/lib/llm.ts` cannot construct,
   * and the first anyone hears of it is a failed LLM call.
   *
   * Read off `effectiveProvider` rather than off `provider`, exactly like the
   * two Ollama blocks: a deployment already STORING `custom` needs the pointer
   * on first paint, before the owner has touched the select.
   */
  const showCustom = effectiveProvider === "custom";
  /**
   * The PICKER's own value, and the deliberate exception to `:110-113` (DW-505).
   *
   * Every other reader above reads `effectiveProvider`, and the `showCustom`
   * argument three lines up is why: a deployment already STORING a provider
   * needs the notes on first paint, before the owner has touched the select.
   * That argument is about a control the owner has NOT moved — the notes point
   * at configuration that exists whether or not the select has been touched.
   *
   * The credential line is the one thing on this form that is a statement
   * ABOUT THE SELECTION, so the fallback inverts there: `useSettings.ts:232-235`
   * seeds `provider` from the payload only when `providerSource === "config"`,
   * so an `env`- or `default`-sourced deployment paints `— Select provider —`
   * with a stored provider behind it — and `effectiveProvider` then made the
   * line announce THAT provider's key state (and, since DW-420 pointed the
   * picker's `aria-describedby` at it, made the picker announce it too) while
   * the control visibly showed no selection at all. Nothing is withheld by not
   * naming the stored provider here: `page.tsx:137-160` already states the
   * effective provider and its readiness above this form.
   *
   * `null` for the blank option, so the four branches below are chosen off a
   * value that means what the owner can see.
   */
  const selectedProvider = provider || null;
  const selectedProviderHasKey =
    selectedProvider !== null &&
    settings?.provider === selectedProvider &&
    settings.hasApiKey;
  /**
   * ONE condition, read by both the credential-status line and the
   * `aria-describedby` that points at it (DW-420).
   *
   * `EmbeddingSettings.tsx:142` states the rule in as many words: two
   * expressions would be two rules that agree today, and the way they would
   * disagree is a description pointing at an element that is not in the
   * document. So this const serves both roles, exactly as `showCustom` and
   * `showOllamaCloud` already do for their notes.
   */
  const showCredentialStatus = settings !== null;

  /**
   * The endpoint input's descriptions, COMPOSED rather than chosen (DW-402).
   *
   * A hint sitting beside a control is invisible to a screen reader — the
   * convention `SettingsCanvas.tsx`'s rows already state — so the refusal
   * sentence has to be pointed at, not merely placed nearby. It is also not the
   * only thing that can describe this box: a read-only deployment already
   * points every control at the page's one read-only sentence, and BOTH can
   * apply at once. Picking one would silence the other, so the ids are joined.
   *
   * `undefined` when neither applies, never `""`: an empty `aria-describedby`
   * is an attribute pointing at nothing.
   */
  const ollamaIssueId = settings?.ollamaBaseUrlIssue ? "ollamaBaseUrlIssue" : undefined;
  const ollamaDescribedBy =
    [readOnly ? describedBy : undefined, ollamaIssueId]
      .filter((id): id is string => Boolean(id))
      .join(" ") || undefined;

  /**
   * The PICKER's descriptions, composed the same way (DW-400).
   *
   * The `showCustom` note below says where the base URL and the API key are
   * actually configured, and it sat BESIDE this select with nothing tying the
   * two together — the exact gap `SettingsCanvas.tsx`'s rows state the
   * convention against: a hint merely adjacent to a control is invisible to a
   * screen reader, so an owner who selects `custom` heard the option name and
   * never the sentence saying the configuration is only half done.
   *
   * COMPOSED rather than chosen, for the same reason the endpoint input above
   * composes: on a read-only deployment BOTH sentences apply, and each answers
   * a different question — why the control refuses, and what is still
   * unconfigured. Picking one would silence the other. `describedBy` stays
   * FIRST so the two controls on this page announce their shared read-only
   * sentence in the same position.
   *
   * The id is contributed only while the note is actually rendered, so the
   * attribute never points at an absent element; `undefined` when neither
   * applies, never `""`.
   *
   * TWO MORE NODES JOIN THE LIST. The credential-status line below the select
   * is the selected provider's credential state (DW-420); the Ollama Cloud
   * note is the same shape of picker-conditional pointer the `showCustom` note
   * is (DW-419). Both sat beside this control with nothing tying them to it,
   * so the owner heard the option name and neither.
   *
   * ORDERED BY DOM READING ORDER, which is the whole ordering rule: a screen
   * reader reads the ids in the order they are listed, so listing them in the
   * order the nodes appear on screen makes the announced description match the
   * visual one. That is also why `describedBy` stays FIRST — the read-only
   * sentence renders above the form.
   *
   * `credentialStatusId` is derived from `showCredentialStatus` — the `<p>`'s
   * OWN gate, the one condition both read — and NOT from the provider.
   * Deriving it from anything else, the provider or `selectedProviderHasKey`,
   * would let the two drift and leave the attribute pointing at an element
   * that is not in the document. `customEndpointId` and `ollamaCloudId` are
   * mutually exclusive by construction (`effectiveProvider` cannot be both
   * `custom` and `ollama-cloud`), so their relative order is never observed;
   * it is written in DOM order anyway so the rule reads as one rule, and at
   * most three ids are ever emitted.
   */
  const credentialStatusId = showCredentialStatus
    ? "providerCredentialStatus"
    : undefined;
  const customEndpointId = showCustom ? "providerCustomEndpoint" : undefined;
  const ollamaCloudId = showOllamaCloud ? "providerOllamaCloud" : undefined;
  const providerDescribedBy =
    [
      readOnly ? describedBy : undefined,
      credentialStatusId,
      customEndpointId,
      ollamaCloudId,
    ]
      .filter((id): id is string => Boolean(id))
      .join(" ") || undefined;

  /**
   * The MODEL box's descriptions, composed the same way (DW-506).
   *
   * "Leave empty to use the default model for the selected provider." sat
   * beside this input with nothing tying the two together, and the input's
   * attribute was `readOnly ? describedBy : undefined` — a CHOICE, so the hint
   * never composed and, on a writable deployment, was never announced at all.
   * The same harm class as DW-400/DW-419/DW-420, and the same fix:
   * `SettingsCanvas.tsx:561,614` states the convention that a hint merely
   * adjacent to a control is invisible to a screen reader.
   *
   * The hint `<p>` renders on BOTH branches of the env/editable ternary below —
   * it is outside it — so its id is unconditional, unlike the picker's
   * conditional notes. `describedBy` stays FIRST, matching the picker
   * (DW-400/DW-419) and the endpoint input (DW-402): every control THIS FORM
   * renders announces the page's read-only sentence in the same position.
   *
   * Scoped to this form deliberately. `EmbeddingSettings`' `notes` puts the
   * page's read-only id LAST, so on a read-only `/settings` the two model boxes
   * announce that one banner sentence in opposite positions. That is a
   * pre-existing inconsistency and this change does not move it: reordering
   * either composition would be a change to a control's announced description
   * that neither DW-505 nor DW-506 asks for.
   *
   * `|| undefined` is kept even though `modelHintId` is unconditional today: it
   * is the invariant all four compositions in this file and `EmbeddingSettings`
   * state, and one of them differing for a reason that is true only now is the
   * drift these comments argue against.
   */
  const modelHintId = "providerModelHint";
  const modelDescribedBy =
    [readOnly ? describedBy : undefined, modelHintId]
      .filter((id): id is string => Boolean(id))
      .join(" ") || undefined;

  return (
    <>
      {/* Provider */}
      <div>
        <label
          htmlFor="provider"
          className="block text-sm font-medium text-foreground/80"
        >
          Provider
          {settings && <SourceBadge source={settings.providerSource} />}
        </label>
        <select
          id="provider"
          value={provider}
          // `aria-disabled`, never `disabled`: a <select> has no `readonly`, and
          // `disabled` would take the picker out of the tab order along with
          // the provider this deployment is running on — the
          // `WorkspacePurposeSettings` scenario picker refuses the same way for
          // the same reason. The handler is what actually refuses.
          aria-disabled={readOnly || undefined}
          aria-describedby={providerDescribedBy}
          onChange={(e) => {
            if (readOnly) return;
            setProvider(e.target.value);
            onFieldChange?.();
          }}
          className="mt-1.5 block w-full rounded-md border border-foreground/20 bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:border-foreground/40 focus:outline-none focus:ring-1 focus:ring-foreground/20"
        >
          {PROVIDER_OPTIONS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        {/*
          The id lives in the const above and the JSX merely reads it, matching
          the `showCustom` note below: one literal, so the emitted
          `aria-describedby` and the rendered node can never name different
          strings.
        */}
        {showCredentialStatus && (
          <p id={credentialStatusId} className="mt-2 text-xs text-foreground/40">
            {/*
              THE BLANK BRANCH IS FIRST (DW-505). It is a state of the control,
              not of the store, so it is decided before any of the three
              provider branches gets to speak — and `settings.provider === null`
              would otherwise fall straight through to "⚠ No API key" on a
              deployment that has simply never stored one.

              A SENTENCE rather than a hidden line: hiding it would change WHEN
              this node renders, which is the one thing `showCredentialStatus`
              above exists to keep as a single condition shared with
              `credentialStatusId`, and the id would drop out of a composition
              the page-level suites assert.
            */}
            {selectedProvider === null
              ? "Select a provider to check its server credential"
              : selectedProviderHasKey
                ? "✓ API key configured on server"
                : settings.provider === selectedProvider
                  ? "⚠ No API key — set via server environment variables"
                  : "Save this selection to check its server credential"}
          </p>
        )}
      </div>

      {/* Model */}
      <div>
        <label
          htmlFor="model"
          className="block text-sm font-medium text-foreground/80"
        >
          Model
          {settings && <SourceBadge source={settings.modelSource} />}
        </label>
        {settings?.modelSource === "env" ? (
          // NO `aria-describedby` here, deliberately — the same reasoning
          // `EmbeddingSettings.tsx`'s locked branch spells out: this is a plain
          // non-focusable `<div>` with no role, and assistive tech does not
          // expose a description on one, so the attribute would be decoration.
          // Reading order is what carries the hint on this branch; the editable
          // branch below takes the attribute because an `<input>` IS exposed.
          <div className="mt-1.5 rounded-md border border-foreground/10 bg-foreground/5 px-3 py-2 text-sm text-foreground/60 font-mono">
            {settings.model}
          </div>
        ) : (
          <input
            id="model"
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            // `readOnly`, not `disabled`: the stored model stays selectable,
            // copyable and in the tab order, which is the whole point.
            readOnly={readOnly}
            aria-describedby={modelDescribedBy}
            placeholder={
              effectiveProvider
                ? DEFAULT_MODELS[effectiveProvider] ?? "Enter model name"
                : "Select a provider first"
            }
            className="mt-1.5 block w-full rounded-md border border-foreground/20 bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:border-foreground/40 focus:outline-none focus:ring-1 focus:ring-foreground/20 font-mono"
          />
        )}
        {/*
          OUTSIDE the ternary above, so the id is unconditional — the hint is
          true of both spellings of this control, and the id lives in the const
          the composition reads so the attribute and the node can never name
          different strings.
        */}
        <p id={modelHintId} className="mt-1 text-xs text-foreground/40">
          Leave empty to use the default model for the selected provider.
        </p>
      </div>

      {/* Ollama Base URL */}
      {showOllamaUrl && (
        <div>
          <label
            htmlFor="ollamaBaseUrl"
            className="block text-sm font-medium text-foreground/80"
          >
            Ollama Base URL
            {settings && (
              <SourceBadge source={settings.ollamaBaseUrlSource} />
            )}
          </label>
          {settings?.ollamaBaseUrlSource === "env" ? (
            <div className="mt-1.5 rounded-md border border-foreground/10 bg-foreground/5 px-3 py-2 text-sm text-foreground/60 font-mono">
              {settings.ollamaBaseUrl}
            </div>
          ) : (
            <input
              id="ollamaBaseUrl"
              type="text"
              value={ollamaBaseUrl}
              onChange={(e) => setOllamaBaseUrl(e.target.value)}
              readOnly={readOnly}
              aria-describedby={ollamaDescribedBy}
              placeholder="http://localhost:11434/api"
              className="mt-1.5 block w-full rounded-md border border-foreground/20 bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:border-foreground/40 focus:outline-none focus:ring-1 focus:ring-foreground/20 font-mono"
            />
          )}
          {/*
            WHY THE BOX IS EMPTY (DW-402). A refused endpoint resolves to
            nothing, so without this the owner reads a blank field beside a
            `none` badge — the same picture as never having set one — while the
            server has already logged that it saw the value and threw it away.

            INSIDE THIS BLOCK, never outside it: the sentence is about the
            Ollama endpoint, and the only place that reads as an answer is
            beside the control that asks. It carries an `id` because beside is
            not enough — `ollamaDescribedBy` above points the input at it, so a
            screen reader announces the refusal with the field rather than
            leaving it to be discovered by browsing. DESCRIBES, does not mark:
            no `aria-invalid` and the save is not blocked, matching the custom
            endpoint note below.
          */}
          {settings?.ollamaBaseUrlIssue && (
            <p id="ollamaBaseUrlIssue" className="mt-1.5 text-xs text-foreground/55">
              {settings.ollamaBaseUrlIssue}
            </p>
          )}
        </div>
      )}

      {/*
        DESCRIBES, does not mark: no `aria-invalid` anywhere and the save is not
        blocked — the same convention `EmbeddingSettings.tsx`'s override note
        follows. Selecting `custom` is not an error, it is simply half a
        configuration, and the other half is finished somewhere else.
      */}
      {showCustom && (
        <div
          id={customEndpointId}
          className="rounded-md border border-foreground/10 bg-foreground/[0.03] px-3 py-3 text-sm text-foreground/60"
        >
          <p className="font-medium text-foreground/80">Custom provider</p>
          <p className="mt-1">{SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY}</p>
        </div>
      )}

      {showOllamaCloud && (
        <div
          id={ollamaCloudId}
          className="rounded-md border border-foreground/10 bg-foreground/[0.03] px-3 py-3 text-sm text-foreground/60"
        >
          <p className="font-medium text-foreground/80">Ollama Cloud</p>
          <p className="mt-1">
            Models run at <span className="font-mono">ollama.com</span>. The
            API key stays encrypted as a Cloudflare Worker secret and is never
            returned to this page.
          </p>
        </div>
      )}
    </>
  );
}
