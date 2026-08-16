import {
  loadConfig,
  saveConfig,
  getEffectiveSettings,
  getWorkbenchSettings,
  applyWorkbenchSettings,
  workbenchSettingsStored,
  isValidProvider,
  isReadOnly,
  _resetConfigCache,
  type AppConfig,
} from "@/lib/config";
import { getEffectiveProvider } from "@/lib/config";
import { validateWorkbenchSettingsPatch } from "@/lib/workbench-settings";
import {
  PROVIDER_INFO,
  EMBEDDING_PROVIDERS,
  isEmbeddingProvider,
} from "@/lib/providers";
import { getErrorMessage } from "@/lib/errors";
import { getPrincipal } from "@/lib/auth";
import { isOwnerHandle } from "@/lib/owner";

async function requireOwner() {
  const principal = await getPrincipal();
  return principal && isOwnerHandle(principal.handle) ? principal : null;
}

// ---------------------------------------------------------------------------
// GET /api/settings — return effective settings with source annotations
// ---------------------------------------------------------------------------

export async function GET() {
  if (!(await requireOwner())) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  await loadConfig();
  const settings = getEffectiveSettings();
  // ONE settings API. Story 1.9's fields ride under ONE nested `workbench` key
  // beside the frozen legacy object — widening `EffectiveSettings` would force
  // edits to `settings-route.test.ts`'s whole-object fixture and to
  // `useSettings.ts`'s hand-duplicated type for fields neither of them uses.
  //
  // `getWorkbenchSettings()` builds that object, and it is the only thing that
  // may: no field it returns carries a stored API key — the three secrets become
  // `has*ApiKey` booleans (AD-23).
  return Response.json({ ...settings, workbench: getWorkbenchSettings() });
}

// ---------------------------------------------------------------------------
// PUT /api/settings — update the config file
// ---------------------------------------------------------------------------

export async function PUT(request: Request) {
  if (!(await requireOwner())) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // Optional deployment-wide kill switch. Cloud storage itself is writable;
  // credentials still remain server secrets and never pass through this API.
  if (isReadOnly()) {
    return Response.json(
      { error: "Settings are read-only in this deployment." },
      { status: 403 },
    );
  }

  try {
    const body = (await request.json()) as Partial<AppConfig> & {
      workbench?: unknown;
    };

    // Validate provider if provided
    if (body.provider !== undefined && body.provider !== null) {
      if (typeof body.provider !== "string" || !isValidProvider(body.provider)) {
        const valid = PROVIDER_INFO.map((p) => p.value).join(", ");
        return Response.json(
          { error: `Invalid provider: "${body.provider}". Must be one of: ${valid}` },
          { status: 400 },
        );
      }
    }

    // Validate the optional provider dedicated to schema-constrained Knowledge
    // Atlas extraction. This selects a server-side credential; keys never pass
    // through the settings API.
    if (
      body.structuredKnowledgeProvider !== undefined &&
      body.structuredKnowledgeProvider !== null
    ) {
      if (
        typeof body.structuredKnowledgeProvider !== "string" ||
        !isValidProvider(body.structuredKnowledgeProvider)
      ) {
        const valid = PROVIDER_INFO.map((p) => p.value).join(", ");
        return Response.json(
          {
            error: `Invalid structuredKnowledgeProvider: "${body.structuredKnowledgeProvider}". Must be one of: ${valid}`,
          },
          { status: 400 },
        );
      }
    }

    // Validate embeddingProvider if provided
    if (body.embeddingProvider !== undefined && body.embeddingProvider !== null) {
      if (
        typeof body.embeddingProvider !== "string" ||
        !isEmbeddingProvider(body.embeddingProvider)
      ) {
        return Response.json(
          {
            error: `Invalid embeddingProvider: "${body.embeddingProvider}". Must be one of: ${EMBEDDING_PROVIDERS.join(", ")}`,
          },
          { status: 400 },
        );
      }
    }

    // Validate model if provided
    if (body.model !== undefined && body.model !== null) {
      if (typeof body.model !== "string" || body.model.trim().length === 0) {
        return Response.json(
          { error: "Model must be a non-empty string" },
          { status: 400 },
        );
      }
    }

    if (
      body.structuredKnowledgeModel !== undefined &&
      body.structuredKnowledgeModel !== null
    ) {
      if (
        typeof body.structuredKnowledgeModel !== "string" ||
        body.structuredKnowledgeModel.trim().length === 0
      ) {
        return Response.json(
          { error: "Structured Knowledge model must be a non-empty string" },
          { status: 400 },
        );
      }
    }

    // Validate ollamaBaseUrl if provided
    if (body.ollamaBaseUrl !== undefined && body.ollamaBaseUrl !== null) {
      if (typeof body.ollamaBaseUrl !== "string") {
        return Response.json(
          { error: "ollamaBaseUrl must be a string" },
          { status: 400 },
        );
      }
    }

    // Load existing config and merge with provided fields
    const existing = await loadConfig();
    const updated: AppConfig = { ...existing };

    if (body.provider !== undefined) {
      if (body.provider === null) {
        delete updated.provider;
      } else {
        updated.provider = body.provider as AppConfig["provider"];
      }
    }

    if (body.model !== undefined) {
      if (body.model === null || body.model === "") {
        delete updated.model;
      } else {
        updated.model = body.model;
      }
    }

    if (body.structuredKnowledgeProvider !== undefined) {
      if (body.structuredKnowledgeProvider === null) {
        delete updated.structuredKnowledgeProvider;
      } else {
        updated.structuredKnowledgeProvider = body.structuredKnowledgeProvider;
      }
    }

    if (body.structuredKnowledgeModel !== undefined) {
      if (
        body.structuredKnowledgeModel === null ||
        body.structuredKnowledgeModel === ""
      ) {
        delete updated.structuredKnowledgeModel;
      } else {
        updated.structuredKnowledgeModel =
          body.structuredKnowledgeModel.trim();
      }
    }

    if (body.ollamaBaseUrl !== undefined) {
      if (body.ollamaBaseUrl === null || body.ollamaBaseUrl === "") {
        delete updated.ollamaBaseUrl;
      } else {
        updated.ollamaBaseUrl = body.ollamaBaseUrl;
      }
    }

    if (body.embeddingModel !== undefined) {
      if (body.embeddingModel === null || body.embeddingModel === "") {
        delete updated.embeddingModel;
      } else {
        updated.embeddingModel = body.embeddingModel;
      }
    }

    if (body.embeddingProvider !== undefined) {
      if (body.embeddingProvider === null) {
        delete updated.embeddingProvider;
      } else {
        updated.embeddingProvider = body.embeddingProvider;
      }
    }

    // Story 1.9's fields, applied AFTER every legacy branch and only when the
    // key is present — a body with no `workbench` produces byte-identically the
    // same saved object it did before this story.
    //
    // The client already disabled the vector control with
    // `canEnableVectorSearch`; re-running the same predicate here, over the
    // config this request is about to write, is what makes FR-56 a RULE rather
    // than a disabled button. `workbenchSettingsStored(updated)` is deliberately
    // the post-legacy-merge object: an `embeddingModel` set by the flat field in
    // this same request counts toward the gate.
    let merged = updated;
    if (body.workbench !== undefined) {
      const validation = validateWorkbenchSettingsPatch(
        body.workbench,
        workbenchSettingsStored(updated),
      );
      if (!validation.ok) {
        // Nothing is written: the refusal happens before `saveConfig`, so a
        // rejected vector switch leaves the store exactly as it was.
        return Response.json({ error: validation.error }, { status: 400 });
      }
      merged = applyWorkbenchSettings(updated, validation.patch);
    }

    await saveConfig(merged);

    // Re-prime the sync cache so the response and any immediate LLM request use
    // the newly selected provider rather than falling back to env detection.
    _resetConfigCache();
    await loadConfig();

    // Return updated effective settings
    const effective = getEffectiveProvider();
    return Response.json({
      saved: true,
      effective,
      // The fresh stored values, so a landed save re-seeds the surface's draft
      // from what the kernel actually holds rather than from what was sent.
      workbench: getWorkbenchSettings(),
    });
  } catch (err) {
    const message = getErrorMessage(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
