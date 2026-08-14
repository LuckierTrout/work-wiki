import {
  loadConfig,
  saveConfig,
  getEffectiveSettings,
  isValidProvider,
  isReadOnly,
  _resetConfigCache,
  type AppConfig,
} from "@/lib/config";
import { getEffectiveProvider } from "@/lib/config";
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
  return Response.json(settings);
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
    const body = (await request.json()) as Partial<AppConfig>;

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

    await saveConfig(updated);

    // Re-prime the sync cache so the response and any immediate LLM request use
    // the newly selected provider rather than falling back to env detection.
    _resetConfigCache();
    await loadConfig();

    // Return updated effective settings
    const effective = getEffectiveProvider();
    return Response.json({
      saved: true,
      effective,
    });
  } catch (err) {
    const message = getErrorMessage(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
