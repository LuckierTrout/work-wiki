"use client";

import Link from "next/link";
import { useId } from "react";
import { providerLabel } from "@/lib/providers";
import { ProviderForm } from "@/components/ProviderForm";
import { EmbeddingSettings } from "@/components/EmbeddingSettings";
import { EmailIngestSettings } from "@/components/EmailIngestSettings";
import { StructuredKnowledgeSettings } from "@/components/StructuredKnowledgeSettings";
import { NamesTermsSettings } from "@/components/NamesTermsSettings";
import { WorkspacePurposeSettings } from "@/components/WorkspacePurposeSettings";
import { VaultExportButton } from "@/components/VaultExportButton";
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
    structuredKnowledgeProvider,
    structuredKnowledgeModel,
    setProvider,
    setModel,
    setOllamaBaseUrl,
    setEmbeddingModel,
    setStructuredKnowledgeProvider,
    setStructuredKnowledgeModel,
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
    vectorNotice,
  } = useSettings();

  /**
   * The read-only banner's id, so every control refused for that reason can
   * resolve it through `aria-describedby`.
   *
   * ONE sentence for the whole form rather than one per panel: the three panels
   * refuse for the identical reason, and three copies would be three things to
   * keep in step. Only handed down while `readOnly`, so the attribute is only
   * ever set when there is a node with this id to point at.
   */
  const readOnlyNoteId = useId();
  const describedBy = readOnly ? readOnlyNoteId : undefined;

  /**
   * The submit, refused BEFORE `handleSave` runs.
   *
   * Here rather than inside `useSettings`, because the hook is shared and its
   * contract is unchanged: this page decides what its own Save button does. The
   * `preventDefault` still fires, or the browser would navigate away on a form
   * submission this handler declined to make a request for.
   */
  function onSubmit(event: React.FormEvent) {
    if (readOnly) {
      event.preventDefault();
      return;
    }
    void handleSave(event);
  }

  // ------------------------------------------
  // Render
  // ------------------------------------------

  if (loadError) {
    return (
      <div className="shell paper-route fade" style={{ paddingTop: 48, paddingBottom: 92 }}>
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
      </div>
    );
  }

  return (
    <div className="shell paper-route fade" style={{ paddingTop: 48, paddingBottom: 92 }}>
      <p className="fmark" style={{ marginBottom: 16 }}>owner configuration</p>
      <h1 className="display" style={{ fontSize: "clamp(36px,4.5vw,58px)", margin: 0 }}>Settings</h1>
      <p style={{ color: "var(--ink-2)", fontSize: 17, margin: "11px 0 0", maxWidth: "64ch" }}>
        Manage the intelligence and delivery routes behind work-wiki.
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

      {/* ---- Read-only banner ----

          Identified, because it is the sentence every refused control below
          points at through `aria-describedby` (DW-299). `aria-disabled`
          announces "dimmed" and a `readOnly` input announces "read only";
          neither says which deployment state caused it, and this is the only
          place that is stated at all. Not `role="alert"` — nothing failed; it
          is the deployment's standing state. */}
      {readOnly && (
        <div
          id={readOnlyNoteId}
          className="mt-4 rounded-lg border border-amber-500/20 bg-amber-50 p-4 text-sm text-amber-700 dark:bg-amber-900/20 dark:text-amber-400"
        >
          <strong>Read-only mode</strong> — This deployment has explicitly
          disabled settings changes.
        </div>
      )}

      {/* ---- Form ----

          NO `<fieldset disabled>` any more (DW-299 — the DW-191 defect, second
          instance). `disabled` on a fieldset takes every descendant out of the
          tab order, so the stored provider, model, base URL and embedding model
          — the values a read-only deployment leaves an owner to READ — became
          unreachable by keyboard and by screen reader, and **Test Connection**,
          which writes nothing at all, was refused along with them. Each control
          states its own refusal instead, following `WorkspacePurposeSettings`:
          `disabled` stays only for transient state, the standing refusal is
          `aria-disabled`, and the handler is what actually refuses. */}
      <div className="max-w-4xl">
      <form onSubmit={onSubmit} className="mt-8 space-y-6">
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
          readOnly={readOnly}
          describedBy={describedBy}
        />

        <StructuredKnowledgeSettings
          provider={structuredKnowledgeProvider}
          setProvider={setStructuredKnowledgeProvider}
          model={structuredKnowledgeModel}
          setModel={setStructuredKnowledgeModel}
          settings={settings}
          onFieldChange={() => {
            setSaveResult(null);
            setTestResult(null);
          }}
          readOnly={readOnly}
          describedBy={describedBy}
        />

        {/*
          Embedding Model — and, beside it, the route's answer about the STORED
          vector switch (DW-327). `vectorNotice` is passed straight through: the
          hook derives the sentence from the served `workbench` object and this
          page decides nothing about it.
        */}
        <EmbeddingSettings
          embeddingModel={embeddingModel}
          setEmbeddingModel={setEmbeddingModel}
          effectiveModel={settings?.embeddingModel ?? null}
          modelSource={settings?.embeddingModelSource ?? "none"}
          modelInEffect={settings?.embeddingModelInEffect ?? null}
          overridden={settings?.embeddingModelOverridden ?? false}
          vectorNotice={vectorNotice}
          rebuilding={rebuilding}
          onRebuild={handleRebuildEmbeddings}
          rebuildResult={rebuildResult}
          readOnly={readOnly}
          describedBy={describedBy}
        />

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-3 pt-2">
          <button
            type="submit"
            // `saving` is TRANSIENT and keeps `disabled`; the standing refusal
            // is `aria-disabled`, so the button keeps its place in the tab
            // order and the banner above can be announced with it. `onSubmit`
            // early-returns, which is what actually refuses.
            disabled={saving}
            aria-disabled={readOnly || undefined}
            aria-describedby={describedBy}
            className={`rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity disabled:opacity-50${
              readOnly ? " opacity-50 cursor-default" : " hover:opacity-90"
            }`}
          >
            {saving ? "Saving…" : "Save Settings"}
          </button>
          {/* NOT refused. `POST /api/settings/test` probes the configured
              provider and stores nothing, so a read-only deployment has no
              reason to withhold it — and it is the one control that tells the
              owner whether what they can still read actually works. The old
              fieldset disabled it purely by being its ancestor. */}
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
      </div>

      <div className="max-w-4xl">
        <WorkspacePurposeSettings />
        <NamesTermsSettings />
        <EmailIngestSettings />

        {/* ---- Your data ---- */}
        <section className="mt-10">
          <h2 className="text-lg font-semibold text-foreground">Your data</h2>
          <p style={{ color: "var(--ink-2)", fontSize: 14, margin: "6px 0 12px", maxWidth: "60ch" }}>
            Download every page you can read as an Obsidian-compatible vault —
            markdown with wikilinks, frontmatter, and bundled images.
          </p>
          <VaultExportButton />
        </section>
      </div>
    </div>
  );
}
