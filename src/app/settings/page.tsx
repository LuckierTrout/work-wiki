"use client";

import Link from "next/link";
import { providerLabel } from "@/lib/providers";
import { ProviderForm } from "@/components/ProviderForm";
import { EmbeddingSettings } from "@/components/EmbeddingSettings";
import { useSettings } from "@/hooks/useSettings";

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  const {
    settings,
    status,
    loadError,
    readOnly,
    provider,
    model,
    ollamaBaseUrl,
    embeddingModel,
    setProvider,
    setModel,
    setOllamaBaseUrl,
    setEmbeddingModel,
    handleSave,
    handleTest,
    handleRebuildEmbeddings,
    saving,
    saveResult,
    setSaveResult,
    testing,
    testResult,
    setTestResult,
    rebuilding,
    rebuildResult,
  } = useSettings();

  // ------------------------------------------
  // Render
  // ------------------------------------------

  if (loadError) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-12">
        <Link
          href="/"
          className="text-sm text-foreground/50 hover:text-foreground/80 transition-colors"
        >
          ← Home
        </Link>
        <h1 className="mt-4 text-3xl font-bold tracking-tight text-foreground">
          Settings
        </h1>
        <div className="mt-6 rounded-lg border border-red-500/20 bg-red-50 p-4 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400">
          Failed to load settings: {loadError}
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <Link
        href="/"
        className="text-sm text-foreground/50 hover:text-foreground/80 transition-colors"
      >
        ← Home
      </Link>
      <h1 className="mt-4 text-2xl sm:text-3xl font-bold tracking-tight text-foreground">
        Settings
      </h1>
      <p className="mt-2 text-foreground/60">
        View your LLM provider status and model preferences.
      </p>

      {/* ---- Status indicator ---- */}
      <div className="mt-6 rounded-lg border border-foreground/10 bg-foreground/[0.02] p-4">
        {!status && !settings ? (
          <div className="flex items-center gap-2 text-sm text-foreground/40">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-gray-300 dark:bg-gray-600 animate-pulse" />
            Checking provider…
          </div>
        ) : status?.configured ? (
          <div className="flex items-center gap-2 text-sm">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-green-500" />
            <span className="text-foreground/80">
              Connected:{" "}
              <span className="font-medium">
                {providerLabel(status.provider!)}
              </span>{" "}
              ({status.model})
            </span>
            {status.embeddingSupport && (
              <span className="text-foreground/40">• embeddings ✓</span>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-500" />
            No LLM provider configured
          </div>
        )}
      </div>

      {/* ---- Read-only banner ---- */}
      {readOnly && (
        <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-50 p-4 text-sm text-amber-700 dark:bg-amber-900/20 dark:text-amber-400">
          <strong>Read-only mode</strong> — Settings cannot be changed in this
          cloud deployment. Configure via environment variables instead.
        </div>
      )}

      {/* ---- Form ---- */}
      <fieldset disabled={readOnly} className="disabled:opacity-60">
      <form onSubmit={handleSave} className="mt-8 space-y-6">
        <ProviderForm
          provider={provider}
          setProvider={setProvider}
          model={model}
          setModel={setModel}
          ollamaBaseUrl={ollamaBaseUrl}
          setOllamaBaseUrl={setOllamaBaseUrl}
          settings={settings}
          onFieldChange={() => {
            setSaveResult(null);
            setTestResult(null);
          }}
        />

        {/* Embedding Model */}
        <EmbeddingSettings
          embeddingModel={embeddingModel}
          setEmbeddingModel={setEmbeddingModel}
          rebuilding={rebuilding}
          onRebuild={handleRebuildEmbeddings}
          rebuildResult={rebuildResult}
        />

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-3 pt-2">
          <button
            type="submit"
            disabled={saving || readOnly}
            className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save Settings"}
          </button>
          <button
            type="button"
            onClick={handleTest}
            disabled={testing}
            className="rounded-md border border-foreground/20 px-4 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-foreground/5 disabled:opacity-50"
          >
            {testing ? "Testing…" : "Test Connection"}
          </button>
        </div>

        {/* Save feedback */}
        {saveResult && (
          <div
            className={`rounded-lg border p-3 text-sm ${
              saveResult.ok
                ? "border-green-500/20 bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400"
                : "border-red-500/20 bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400"
            }`}
          >
            {saveResult.message}
          </div>
        )}

        {/* Test feedback */}
        {testResult && (
          <div
            className={`rounded-lg border p-3 text-sm ${
              testResult.ok
                ? "border-green-500/20 bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400"
                : "border-red-500/20 bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400"
            }`}
          >
            {testResult.message}
          </div>
        )}
      </form>
      </fieldset>
    </main>
  );
}
