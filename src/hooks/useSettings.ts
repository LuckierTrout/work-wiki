"use client";

import { useState, useCallback, useEffect } from "react";
import { providerLabel } from "@/lib/providers";
import {
  storedVectorInputs,
  vectorSearchInactiveCopy,
  workbenchSettingsFrom,
  type WorkbenchSettingsPayload,
} from "@/lib/workbench-settings";
import { IF_MATCH_HEADER, formatIfMatch } from "@/lib/write-precondition";

// ---------------------------------------------------------------------------
// Types matching the API responses
// ---------------------------------------------------------------------------

export type SettingSource = "env" | "config" | "default" | "none";

export interface EffectiveSettings {
  provider: string | null;
  providerSource: SettingSource;
  model: string | null;
  modelSource: SettingSource;
  configured: boolean;
  embeddingSupport: boolean;
  embeddingModel: string | null;
  embeddingModelSource: SettingSource;
  /**
   * What actually embeds, and whether it differs from what is set (DW-274).
   * The pair above stays "what is set and where" — the draft-seeding below
   * reads `embeddingModel`, so a resolved provider default landing in it would
   * be written into the store by the next save.
   */
  embeddingModelInEffect: string | null;
  embeddingModelOverridden: boolean;
  hasApiKey: boolean;
  ollamaBaseUrl: string | null;
  ollamaBaseUrlSource: SettingSource;
  /**
   * Why the endpoint above is empty when the owner did set one (DW-402).
   *
   * The full env→store ladder's refusal, as `GET /api/settings` serves it.
   * `ProviderForm` renders it inside the Ollama Base URL block — the sentence
   * belongs beside the box it explains, not on the page's error channel, and
   * the draft-seeding below deliberately ignores it: it is copy, never a value
   * a save could write back.
   */
  ollamaBaseUrlIssue: string | null;
  structuredKnowledgeProvider: string | null;
  structuredKnowledgeProviderSource: SettingSource;
  structuredKnowledgeModel: string | null;
  structuredKnowledgeModelSource: SettingSource;
  structuredKnowledgeConfigured: boolean;
  readOnly: boolean;
  /**
   * The WRITE PRECONDITION for the stored config these values came out of
   * (DW-63). `GET /api/settings` serves it beside the legacy fields, and
   * {@link useSettings} sends it back as `If-Match` on the save.
   *
   * Optional on the TYPE only because this interface is a hand-duplicated view
   * of the route's body; the route always serves one, and a save without it is
   * refused rather than applied blindly.
   */
  version?: string;
  /**
   * Story 1.9's nested object, which `GET /api/settings` already serves beside
   * these flat fields (DW-327).
   *
   * `unknown` on purpose, and it is the ONE field here that is. The rest of
   * this interface is a claimed shape — `await res.json()` is asserted into it
   * and every field is read as though the claim held — which is tolerable for
   * values that are only ever RENDERED. This object is different: it feeds a
   * RULE (`canEnableVectorSearch`, through {@link storedVectorInputs}), whose
   * inputs have no safe defaults, so it is narrowed by
   * {@link workbenchSettingsFrom} rather than asserted. A payload that is not
   * one produces `null` and the flat page renders exactly as it did before this
   * field existed.
   */
  workbench?: unknown;
}

export interface ProviderStatus {
  configured: boolean;
  provider: string | null;
  model: string | null;
  embeddingSupport: boolean;
  /**
   * The ENV leg's refusal, as `/api/status` serves it (DW-402).
   *
   * REQUIRED, like every other field here: both doors that answer this shape
   * serve a whole `ProviderInfo`. `/api/status` returns `getProviderInfo()`
   * outright and `POST /api/settings/test` spreads it beside its own `ok`
   * flag, so there is no response carrying the other four fields and not this
   * one. Marking it optional would let a reader treat "absent" as a state the
   * wire can produce, which it cannot.
   */
  ollamaBaseUrlIssue: string | null;
}

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

interface ActionResult {
  ok: boolean;
  message: string;
}

export interface UseSettingsReturn {
  // Fetched data
  settings: EffectiveSettings | null;
  status: ProviderStatus | null;
  loadError: string | null;
  readOnly: boolean;
  // Form values
  provider: string;
  model: string;
  ollamaBaseUrl: string;
  embeddingModel: string;
  structuredKnowledgeProvider: string;
  structuredKnowledgeModel: string;
  // Form setters
  setProvider: (v: string) => void;
  setModel: (v: string) => void;
  setOllamaBaseUrl: (v: string) => void;
  setEmbeddingModel: (v: string) => void;
  setStructuredKnowledgeProvider: (v: string) => void;
  setStructuredKnowledgeModel: (v: string) => void;
  // Actions
  handleSave: (e: React.FormEvent) => Promise<void>;
  handleTest: () => Promise<void>;
  handleRebuildEmbeddings: () => Promise<void>;
  // Action state
  saving: boolean;
  saveResult: ActionResult | null;
  setSaveResult: (v: ActionResult | null) => void;
  testing: boolean;
  testResult: ActionResult | null;
  setTestResult: (v: ActionResult | null) => void;
  rebuilding: boolean;
  rebuildResult: ActionResult | null;
  /**
   * What the STORED vector switch has to say on this page, or `null` for
   * nothing at all (DW-327).
   *
   * Non-null only when the store holds the switch ON over legs that are unmet.
   * A switch that is off, a configuration that is satisfied, and a body whose
   * `workbench` object is absent or unusable all produce `null` — and `null`
   * renders nothing, which is byte-identically what this page did before.
   *
   * It is the SAME sentence, from the same function, that a flat save's refusal
   * carries: DW-303 now lets a flat save land on a store whose switch is on but
   * inactive, so without this the owner had no signal anywhere on the page that
   * the switch they cannot see is not doing anything.
   */
  vectorNotice: string | null;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSettings(): UseSettingsReturn {
  // Fetched state
  const [settings, setSettings] = useState<EffectiveSettings | null>(null);
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /**
   * The precondition the form's draft was SEEDED with, kept beside `settings`
   * rather than derived at Save (DW-63). `/settings` and the Workbench's
   * `SettingsCanvas` write the same `AppConfig`, so a form left open across the
   * other surface's save would otherwise put every field it changed back.
   *
   * The `await fetchSettings()` a landed save already runs is what carries the
   * new one forward, so a second save without a reload still lands.
   */
  const [version, setVersion] = useState<string | null>(null);
  /**
   * The `workbench` object of the last read that LANDED, already narrowed
   * (DW-327).
   *
   * Kept apart from `settings` rather than read back off it, for the reason
   * {@link EffectiveSettings.workbench} gives: `settings` is an asserted shape
   * and this is a checked one, and storing the checked value is what keeps the
   * check from having to be repeated (or skipped) at every read site.
   */
  const [workbench, setWorkbench] = useState<WorkbenchSettingsPayload | null>(null);

  // Form state
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState("");
  const [structuredKnowledgeProvider, setStructuredKnowledgeProvider] =
    useState("");
  const [structuredKnowledgeModel, setStructuredKnowledgeModel] = useState("");

  // UI state
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<ActionResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ActionResult | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildResult, setRebuildResult] = useState<ActionResult | null>(null);

  // ------------------------------------------
  // Fetch settings & status
  // ------------------------------------------

  /**
   * Returns whether the read LANDED, which the save path needs: a refresh that
   * lands is the freshest thing anyone knows about the stored config, and one
   * that does not must not be allowed to throw away what the save itself was
   * told (see {@link handleSave}).
   */
  const fetchSettings = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/settings");
      if (!res.ok) throw new Error("Failed to load settings");
      const data: EffectiveSettings = await res.json();
      setSettings(data);
      setVersion(typeof data.version === "string" ? data.version : null);
      // NARROWED, not asserted — see `EffectiveSettings.workbench`. The whole
      // BODY is handed over rather than `data.workbench`, because
      // `workbenchSettingsFrom` is the route's own guard for exactly this seam
      // and reaches for the key itself. `null` is the ordinary answer for an
      // older route, a proxy that dropped the object, or a shape that does not
      // check out, and it renders nothing.
      setWorkbench(workbenchSettingsFrom(data));

      // Pre-fill form only with config-sourced values (not env)
      if (data.providerSource === "config" && data.provider) {
        setProvider(data.provider);
      } else if (data.providerSource !== "env") {
        setProvider("");
      }
      if (data.modelSource === "config" && data.model) {
        setModel(data.model);
      } else {
        setModel("");
      }
      if (data.ollamaBaseUrlSource === "config" && data.ollamaBaseUrl) {
        setOllamaBaseUrl(data.ollamaBaseUrl);
      } else {
        setOllamaBaseUrl("");
      }
      if (data.embeddingModelSource === "config" && data.embeddingModel) {
        setEmbeddingModel(data.embeddingModel);
      } else {
        setEmbeddingModel("");
      }
      if (
        data.structuredKnowledgeProviderSource === "config" &&
        data.structuredKnowledgeProvider
      ) {
        setStructuredKnowledgeProvider(data.structuredKnowledgeProvider);
      } else {
        setStructuredKnowledgeProvider("");
      }
      if (
        data.structuredKnowledgeModelSource === "config" &&
        data.structuredKnowledgeModel
      ) {
        setStructuredKnowledgeModel(data.structuredKnowledgeModel);
      } else {
        setStructuredKnowledgeModel("");
      }
      return true;
    } catch (err) {
      // The version goes with the read that failed. Keeping the last one would
      // let a save minutes later be conditional on a config nothing has
      // confirmed is still there — and be refused 412 ("changed somewhere
      // else") for a change nobody made. An UNKNOWN version must produce the
      // truthful 428 instead, which is the same reasoning `PreviewColumn`
      // applies when a landed save answers none.
      setVersion(null);
      // …and the narrowed `workbench` object goes with it, for the same reason
      // and with the stronger claim: a checked value must not outlive the read
      // that confirmed it, and this one feeds a RULE rather than a render.
      setWorkbench(null);
      setLoadError(err instanceof Error ? err.message : "Unknown error");
      return false;
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status");
      if (!res.ok) throw new Error("Status check failed");
      const data: ProviderStatus = await res.json();
      setStatus(data);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
    fetchStatus();
  }, [fetchSettings, fetchStatus]);

  // ------------------------------------------
  // Save
  // ------------------------------------------

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveResult(null);
    setTestResult(null);

    try {
      const body: Record<string, string | null> = {};

      // Only send provider if user selected one
      if (provider) {
        body.provider = provider;
      }

      // Model: send if filled, null to clear
      if (model.trim()) {
        body.model = model.trim();
      }

      // Ollama base URL
      if (provider === "ollama" && ollamaBaseUrl.trim()) {
        body.ollamaBaseUrl = ollamaBaseUrl.trim();
      }

      // Embedding model
      if (embeddingModel.trim()) {
        body.embeddingModel = embeddingModel.trim();
      }

      // Workload-specific routing is explicit: empty values clear the override
      // and return Structured Knowledge to the primary provider/model.
      body.structuredKnowledgeProvider = structuredKnowledgeProvider || null;
      body.structuredKnowledgeModel = structuredKnowledgeModel.trim() || null;

      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(version ? { [IF_MATCH_HEADER]: formatIfMatch(version) } : {}),
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `Save failed (${res.status})`);
      }

      // What the store now holds, straight from the save that landed. Parsed
      // with the same guard the error branch above uses.
      const landed = (await res.json().catch(() => null)) as {
        version?: unknown;
      } | null;

      setSaveResult({ ok: true, message: "Settings saved." });

      // Refresh to pick up new effective values
      const refreshed = await fetchSettings();
      await fetchStatus();

      // The refresh is the FRESHER source whenever it lands — another actor may
      // have saved between this PUT and that GET — so it wins. When it does not
      // land it clears the version, and THAT is the case this restores: without
      // it a landed save followed by a failed refresh left no precondition at
      // all, or worse, the superseded one, and the owner's very next save was
      // refused for a change they had made themselves.
      if (!refreshed && typeof landed?.version === "string" && landed.version.length > 0) {
        setVersion(landed.version);
      }
    } catch (err) {
      setSaveResult({
        ok: false,
        message: err instanceof Error ? err.message : "Save failed",
      });
    } finally {
      setSaving(false);
    }
  }

  // ------------------------------------------
  // Test connection
  // ------------------------------------------

  async function handleTest() {
    setTesting(true);
    setTestResult(null);

    try {
      const res = await fetch("/api/settings/test", { method: "POST" });
      const data = (await res.json()) as ProviderStatus & { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "Provider connection failed");
      }
      setStatus(data);

      setTestResult({
        ok: true,
        message: `Live connection succeeded: ${providerLabel(data.provider ?? "anthropic")} (${data.model})${data.embeddingSupport ? " — embeddings supported" : ""}`,
      });
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : "Connection test failed",
      });
    } finally {
      setTesting(false);
    }
  }

  // ------------------------------------------
  // Rebuild vector index
  // ------------------------------------------

  async function handleRebuildEmbeddings() {
    setRebuilding(true);
    setRebuildResult(null);

    try {
      const res = await fetch("/api/settings/rebuild-embeddings", {
        method: "POST",
      });
      const data = await res.json();

      if (!res.ok) {
        setRebuildResult({
          ok: false,
          message: data.error ?? "Rebuild failed",
        });
      } else {
        setRebuildResult({
          ok: true,
          message: `Rebuilt: ${data.embedded} page${data.embedded !== 1 ? "s" : ""} embedded using ${data.model}${data.skipped > 0 ? ` (${data.skipped} skipped)` : ""}`,
        });
      }
    } catch (err) {
      setRebuildResult({
        ok: false,
        message:
          err instanceof Error ? err.message : "Failed to rebuild vector index",
      });
    } finally {
      setRebuilding(false);
    }
  }

  // ------------------------------------------
  // Derived
  // ------------------------------------------

  /**
   * The stored vector state, as ONE sentence or as nothing (DW-327).
   *
   * Derived rather than stored, because it is a pure function of the payload
   * this page has already got — a second piece of state would be a second thing
   * that can be stale. `vectorSearchInactiveCopy` returns `""` for a satisfied
   * configuration, which is the "nothing to say" answer and is normalised to
   * `null` here so the prop has one absence rather than two.
   *
   * Guarded on the STORED flag as well: the sentence opens "Vector search is
   * switched on", so it must not be shown for a switch that is off — and a
   * switch that is off has nothing to report, whatever its legs look like.
   */
  const vectorNotice =
    workbench && workbench.vectorSearchEnabled
      ? // The FLAT frame, which is the same one this page's saves are refused
        // with: one state, one wording, whichever way the owner meets it.
        vectorSearchInactiveCopy(storedVectorInputs(workbench), "flat") || null
      : null;

  return {
    // Fetched data
    settings,
    status,
    loadError,
    readOnly: settings?.readOnly ?? false,
    // Form values
    provider,
    model,
    ollamaBaseUrl,
    embeddingModel,
    structuredKnowledgeProvider,
    structuredKnowledgeModel,
    // Form setters
    setProvider,
    setModel,
    setOllamaBaseUrl,
    setEmbeddingModel,
    setStructuredKnowledgeProvider,
    setStructuredKnowledgeModel,
    // Actions
    handleSave,
    handleTest,
    handleRebuildEmbeddings,
    // Action state
    saving,
    saveResult,
    setSaveResult,
    testing,
    testResult,
    setTestResult,
    rebuilding,
    rebuildResult,
    // Derived
    vectorNotice,
  };
}
