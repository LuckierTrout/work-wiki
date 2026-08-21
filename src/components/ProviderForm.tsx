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
  const selectedProviderHasKey =
    settings?.provider === effectiveProvider && settings.hasApiKey;

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
          aria-describedby={readOnly ? describedBy : undefined}
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
        {settings && (
          <p className="mt-2 text-xs text-foreground/40">
            {selectedProviderHasKey
              ? "✓ API key configured on server"
              : settings.provider === effectiveProvider
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
            aria-describedby={readOnly ? describedBy : undefined}
            placeholder={
              effectiveProvider
                ? DEFAULT_MODELS[effectiveProvider] ?? "Enter model name"
                : "Select a provider first"
            }
            className="mt-1.5 block w-full rounded-md border border-foreground/20 bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:border-foreground/40 focus:outline-none focus:ring-1 focus:ring-foreground/20 font-mono"
          />
        )}
        <p className="mt-1 text-xs text-foreground/40">
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
              aria-describedby={readOnly ? describedBy : undefined}
              placeholder="http://localhost:11434/api"
              className="mt-1.5 block w-full rounded-md border border-foreground/20 bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:border-foreground/40 focus:outline-none focus:ring-1 focus:ring-foreground/20 font-mono"
            />
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
        <div className="rounded-md border border-foreground/10 bg-foreground/[0.03] px-3 py-3 text-sm text-foreground/60">
          <p className="font-medium text-foreground/80">Custom provider</p>
          <p className="mt-1">{SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY}</p>
        </div>
      )}

      {showOllamaCloud && (
        <div className="rounded-md border border-foreground/10 bg-foreground/[0.03] px-3 py-3 text-sm text-foreground/60">
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
