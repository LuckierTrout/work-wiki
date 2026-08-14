"use client";

import { DEFAULT_MODELS, PROVIDER_INFO, providerLabel } from "@/lib/providers";
import type { EffectiveSettings } from "@/hooks/useSettings";

export interface StructuredKnowledgeSettingsProps {
  provider: string;
  setProvider: (value: string) => void;
  model: string;
  setModel: (value: string) => void;
  settings: EffectiveSettings | null;
  onFieldChange?: () => void;
}

export function StructuredKnowledgeSettings({
  provider,
  setProvider,
  model,
  setModel,
  settings,
  onFieldChange,
}: StructuredKnowledgeSettingsProps) {
  const effectiveProvider =
    provider || settings?.structuredKnowledgeProvider || null;
  const effectiveModel =
    model.trim() ||
    (provider ? DEFAULT_MODELS[provider] : settings?.structuredKnowledgeModel) ||
    null;
  const usesPrimary =
    !provider && settings?.structuredKnowledgeProviderSource !== "config";

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
            onChange={(event) => {
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
            placeholder={
              provider
                ? DEFAULT_MODELS[provider] ?? "Enter model name"
                : "Use the primary model"
            }
            className="mt-1.5 block w-full rounded-md border border-foreground/20 bg-background px-3 py-2 font-mono text-sm text-foreground shadow-sm focus:border-foreground/40 focus:outline-none focus:ring-1 focus:ring-foreground/20"
          />
        </div>
      </div>

      <p className="mt-3 text-xs text-foreground/40">
        Provider credentials remain encrypted server secrets. This setting only
        chooses which configured credential and model handle extraction.
      </p>
    </section>
  );
}
