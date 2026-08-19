// ---------------------------------------------------------------------------
// Provider / model constants — single source of truth
// ---------------------------------------------------------------------------
// This file is intentionally free of Node.js imports (fs, path, etc.) so it
// can be safely imported from both server code (config.ts, llm.ts) and
// "use client" components (settings page, StatusBadge, etc.).
// ---------------------------------------------------------------------------

/**
 * Canonical list of supported LLM providers with display labels.
 */
export const PROVIDER_INFO = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "google", label: "Google" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "ollama-cloud", label: "Ollama Cloud" },
  { value: "ollama", label: "Ollama (self-hosted)" },
  // Story 1.9: any OpenAI-compatible endpoint the owner points at themselves.
  // It carries no {@link DEFAULT_MODELS} entry ON PURPOSE — a custom endpoint
  // has no model this repo could know the name of, and inventing one would send
  // a request that 404s at a server nobody here has seen.
  { value: "custom", label: "Custom" },
] as const;

/** Union type of valid provider values. */
export type ProviderValue = (typeof PROVIDER_INFO)[number]["value"];

/**
 * Set of valid provider strings, derived from PROVIDER_INFO.
 */
export const VALID_PROVIDERS: ReadonlySet<string> = new Set(
  PROVIDER_INFO.map((p) => p.value),
);

/**
 * Providers capable of producing embeddings. This is a different set from the
 * LLM providers: it adds `workers-ai` (Cloudflare bge-m3) and excludes
 * `anthropic`/`deepseek` (no embedding models). Kept as a single source of
 * truth so the runtime check and the config type can't drift.
 */
export const EMBEDDING_PROVIDERS = [
  "openai",
  "google",
  "ollama",
  "workers-ai",
] as const;

/** Union of valid embedding-provider values. */
export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number];

/** Type guard narrowing an arbitrary string to {@link EmbeddingProvider}. */
export function isEmbeddingProvider(p: string): p is EmbeddingProvider {
  return (EMBEDDING_PROVIDERS as readonly string[]).includes(p);
}

/**
 * The Workers AI model-id namespace (`@cf/baai/bge-m3`,
 * `@cf/baai/bge-large-en-v1.5`). Declared here rather than in `embeddings.ts`
 * because {@link embeddingModelMatchesProvider} is read from client-safe code.
 */
export const WORKERS_AI_MODEL_PREFIX = "@cf/";

/**
 * Does a model id sit on the correct side of the Workers AI namespace boundary?
 *
 * The ONE statement of the rule, so its two readers cannot drift into two
 * subtly different rules: `embeddings.ts`'s `resolveEmbeddingModelName` DROPS
 * an embedding-model override that fails this (falling back to the provider
 * default), and `workbench-settings.ts`'s vector gate REFUSES the same mismatch
 * at the Settings surface rather than accepting it and letting the resolver
 * silently override the owner's choice later (DW-73).
 *
 * It is an equality, not a ban, and that matters in both directions: a Workers
 * AI id under OpenAI/Google/Ollama is exactly as wrong as an OpenAI id under
 * Workers AI, and half the rule would leave the mirror case unguarded. This is
 * deliberately not a model-catalog validator for OpenAI versus Google versus
 * Ollama; the resolver itself distinguishes only Workers AI's `@cf/` namespace.
 */
export function embeddingModelMatchesProvider(provider: string, model: string): boolean {
  return model.startsWith(WORKERS_AI_MODEL_PREFIX) === (provider === "workers-ai");
}

/**
 * Default model for each provider.
 *
 * `custom` is deliberately absent: an owner-supplied OpenAI-compatible endpoint
 * serves whatever model names its operator chose, so there is no default this
 * repo could name. Every reader already falls back (`?? provider`,
 * `?? "Enter model name"`), so the omission surfaces as "you must type one"
 * rather than as a request to a model that does not exist.
 */
export const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
  google: "gemini-2.0-flash",
  deepseek: "deepseek-v4-flash",
  "ollama-cloud": "gpt-oss:120b",
  ollama: "llama3.2",
};

/**
 * Get a human-readable label for a provider value.
 * Falls back to the raw string if the provider is unknown.
 */
export function providerLabel(provider: string): string {
  const entry = PROVIDER_INFO.find((p) => p.value === provider);
  return entry?.label ?? provider;
}

/**
 * Display label for an EMBEDDING provider.
 *
 * `workers-ai` embeds but does not generate, so it is absent from
 * {@link PROVIDER_INFO} — and `providerLabel` would fall back to the raw slug,
 * putting `workers-ai` in a picker beside "OpenAI" and "Google". Adding it to
 * the LLM list to get a label would offer it as a generation provider it cannot
 * be, so the one extra name lives here instead.
 */
export function embeddingProviderLabel(provider: string): string {
  if (provider === "workers-ai") return "Cloudflare Workers AI";
  return providerLabel(provider);
}
