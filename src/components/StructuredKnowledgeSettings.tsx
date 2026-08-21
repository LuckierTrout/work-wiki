"use client";

import { DEFAULT_MODELS, PROVIDER_INFO, providerLabel } from "@/lib/providers";
import { SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY } from "@/lib/workbench-settings";
import type { EffectiveSettings } from "@/hooks/useSettings";

export interface StructuredKnowledgeSettingsProps {
  provider: string;
  setProvider: (value: string) => void;
  model: string;
  setModel: (value: string) => void;
  settings: EffectiveSettings | null;
  onFieldChange?: () => void;
  /**
   * `YOPEDIA_READONLY=1`, as `GET /api/settings` reported it (DW-299).
   *
   * Refuses PER CONTROL rather than through the page's old
   * `<fieldset disabled>` — see `ProviderFormProps.readOnly`, which documents
   * why (DW-191): a disabled fieldset takes the stored extraction provider and
   * model out of the tab order, and reading them is exactly what a read-only
   * deployment leaves an owner. Optional and off by default, so every existing
   * caller renders unchanged.
   */
  readOnly?: boolean;
  /** The id of the sentence that says WHY — see `ProviderFormProps.describedBy`. */
  describedBy?: string;
}

export function StructuredKnowledgeSettings({
  provider,
  setProvider,
  model,
  setModel,
  settings,
  onFieldChange,
  readOnly = false,
  describedBy,
}: StructuredKnowledgeSettingsProps) {
  const effectiveProvider =
    provider || settings?.structuredKnowledgeProvider || null;
  const effectiveModel =
    model.trim() ||
    (provider ? DEFAULT_MODELS[provider] : settings?.structuredKnowledgeModel) ||
    null;
  const usesPrimary =
    !provider && settings?.structuredKnowledgeProviderSource !== "config";
  /**
   * `Custom` is selectable here but not CONFIGURABLE here (DW-368).
   *
   * Exactly `ProviderForm`'s `showCustom` (DW-61): this section renders no
   * base-URL and no API-key input, and it deliberately gains none — a second
   * editor for `customBaseUrl`/`customApiKey` would give two surfaces a
   * lost-update race over the same two stored fields, which the 2026-08-18
   * decision on DW-61 rules out in as many words. The option stays (removing it
   * would make an already-stored `custom` unrepresentable in its own picker)
   * and the page says where the other two halves live — otherwise a save here
   * stores a provider `getConfiguredModel` refuses to construct, and the first
   * anyone hears of it is a failed extraction call.
   *
   * Read off `effectiveProvider`, not off `provider`: a deployment already
   * STORING `custom` for extraction needs the pointer on first paint, before
   * the owner has touched the select.
   *
   * But `effectiveProvider` ALONE is too wide, because
   * `workloadModelSettings` (`src/lib/config.ts`) resolves an unset extraction
   * provider to `provider ?? primaryProvider` with source `"default"` — so a
   * deployment whose PRIMARY is `custom` and whose extraction is unset is
   * served `structuredKnowledgeProvider: "custom"` and would light this up
   * while the flow badge beside it still reads "Primary provider". That case is
   * the primary picker's to speak for: `ProviderForm` is already rendering this
   * exact sentence for it, and a second copy on the same page would say the
   * same thing twice about one setting the owner cannot change from here.
   *
   * So the gate is INHERIT-AWARE, and it keys off `usesPrimary` rather than
   * re-deriving the same question: the badge and the pointer must be reading
   * the same rung of that ladder, or the section can claim to be routing
   * through the primary provider and to own a `custom` routing choice at once.
   */
  const showCustom = !usesPrimary && effectiveProvider === "custom";

  return (
    <section className="rounded-lg border border-foreground/15 bg-foreground/[0.025] p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground/90">
            Knowledge extraction
          </h2>
          <p className="mt-1 max-w-xl text-sm text-foreground/55">
            Route schema-constrained Atlas extraction separately from chat and
            general generation.
          </p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${
            settings?.structuredKnowledgeConfigured
              ? "bg-green-500/15 text-green-700 dark:text-green-400"
              : "bg-amber-500/15 text-amber-700 dark:text-amber-400"
          }`}
        >
          {settings?.structuredKnowledgeConfigured
            ? "Credential ready"
            : "Credential required"}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-md border border-foreground/10 bg-background px-3 py-2 text-xs text-foreground/55">
        <span>Wiki page</span>
        <span aria-hidden="true" className="text-foreground/25">
          →
        </span>
        <span className="font-medium text-foreground/80">
          {usesPrimary
            ? "Primary provider"
            : effectiveProvider
              ? providerLabel(effectiveProvider)
              : "Choose provider"}
          {effectiveModel ? ` · ${effectiveModel}` : ""}
        </span>
        <span aria-hidden="true" className="text-foreground/25">
          →
        </span>
        <span>Knowledge Atlas</span>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label
            htmlFor="structuredKnowledgeProvider"
            className="block text-sm font-medium text-foreground/80"
          >
            Extraction provider
          </label>
          <select
            id="structuredKnowledgeProvider"
            value={provider}
            // `aria-disabled` + a returning handler, never `disabled`: a
            // <select> has no `readonly`, and the stored routing choice is
            // state the owner is entitled to read.
            aria-disabled={readOnly || undefined}
            aria-describedby={readOnly ? describedBy : undefined}
            onChange={(event) => {
              if (readOnly) return;
              setProvider(event.target.value);
              onFieldChange?.();
            }}
            className="mt-1.5 block w-full rounded-md border border-foreground/20 bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:border-foreground/40 focus:outline-none focus:ring-1 focus:ring-foreground/20"
          >
            <option value="">Use primary provider</option>
            {PROVIDER_INFO.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor="structuredKnowledgeModel"
            className="block text-sm font-medium text-foreground/80"
          >
            Extraction model
          </label>
          <input
            id="structuredKnowledgeModel"
            type="text"
            value={model}
            onChange={(event) => {
              setModel(event.target.value);
              onFieldChange?.();
            }}
            readOnly={readOnly}
            aria-describedby={readOnly ? describedBy : undefined}
            placeholder={
              provider
                ? DEFAULT_MODELS[provider] ?? "Enter model name"
                : "Use the primary model"
            }
            className="mt-1.5 block w-full rounded-md border border-foreground/20 bg-background px-3 py-2 font-mono text-sm text-foreground shadow-sm focus:border-foreground/40 focus:outline-none focus:ring-1 focus:ring-foreground/20"
          />
        </div>
      </div>

      {/*
        DESCRIBES, does not mark: no `aria-invalid` on the picker and the save
        is not blocked — the same convention `ProviderForm`'s note follows.
        Selecting `custom` is not an error, it is half a configuration, and the
        other half is finished somewhere else. The sentence is the SHARED one,
        so both pickers send an owner to the same place.
      */}
      {showCustom && (
        <div
          id="structuredKnowledgeCustomEndpoint"
          className="mt-4 rounded-md border border-foreground/10 bg-foreground/[0.03] px-3 py-3 text-sm text-foreground/60"
        >
          <p className="font-medium text-foreground/80">Custom provider</p>
          <p className="mt-1">{SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY}</p>
        </div>
      )}

      <p className="mt-3 text-xs text-foreground/40">
        Provider credentials remain encrypted server secrets. This setting only
        chooses which configured credential and model handle extraction.
      </p>
    </section>
  );
}
