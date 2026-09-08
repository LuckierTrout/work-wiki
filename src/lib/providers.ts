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
 * Fixed output widths for the Workers AI embedding models this repo supports.
 *
 * This is the ONE table: it is both the catalog {@link isWorkersAiEmbeddingModel}
 * tests membership against and the dimension check `embeddings.ts` runs on a
 * returned vector, so an id can never be "acceptable to the gate" and "unknown
 * to the dimension check" at the same time. `embeddings.ts` re-exports this very
 * object rather than keeping a second copy.
 *
 * It lives HERE, not in `embeddings.ts`, because the rule below is read from
 * client-safe code and `embeddings.ts` pulls `ai`, `@opennextjs/cloudflare` and
 * the storage layer. Dimensions are inert data, so the move costs nothing.
 */
export const WORKERS_AI_EMBEDDING_DIMENSIONS: Readonly<Record<string, number>> = {
  "@cf/baai/bge-small-en-v1.5": 384,
  "@cf/baai/bge-base-en-v1.5": 768,
  "@cf/baai/bge-large-en-v1.5": 1024,
  "@cf/baai/bge-m3": 1024,
};

/**
 * The supported Workers AI embedding ids, for copy that has to NAME them.
 * Derived from {@link WORKERS_AI_EMBEDDING_DIMENSIONS} so a new id shows up in
 * the refusal sentence the moment it is added to the table.
 */
export const WORKERS_AI_EMBEDDING_MODEL_IDS: readonly string[] = Object.keys(
  WORKERS_AI_EMBEDDING_DIMENSIONS,
);

/**
 * Is this an embedding model Workers AI can actually serve here?
 *
 * An OWN-PROPERTY test, not `in` and not a truthiness test on the lookup, so
 * `constructor` and `toString` are not model ids — a prototype key reaching a
 * membership test through the settings surface would otherwise be "supported".
 *
 * Spelled `Object.prototype.hasOwnProperty.call` rather than `Object.hasOwn`
 * because this module is client-safe and ships in the browser bundle:
 * `Object.hasOwn` is ES2022, tsconfig targets ES2018, and nothing down-levels
 * it — so on a browser without it the settings page would throw a TypeError
 * where it should be rendering the vector gate.
 */
export function isWorkersAiEmbeddingModel(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(WORKERS_AI_EMBEDDING_DIMENSIONS, model);
}

/**
 * Can this provider actually serve this embedding model id?
 *
 * The ONE statement of the rule, so its two readers cannot drift into two
 * subtly different rules: `embeddings.ts`'s `resolveEmbeddingModelName` DROPS
 * an embedding-model override that fails this (falling back to the provider
 * default, with a warning), and `workbench-settings.ts`'s vector gate REFUSES
 * the same mismatch at the Settings surface rather than accepting it and letting
 * the resolver silently override the owner's choice later (DW-73).
 *
 * The two legs are deliberately asymmetric (DW-220). Under `workers-ai` the test
 * is CATALOG MEMBERSHIP, because a namespace test approves ids nothing can
 * serve: the bare prefix `@cf/` and a vision model such as
 * `@cf/llava-hf/llava-1.5-7b-hf` both sit inside `@cf/`, both used to pass the
 * gate, and both failed only at `ai.run()` — a gate that approves an id no
 * binding will accept is not a gate. Under every other provider the test stays
 * "outside the `@cf/` namespace", because this is not, and must not become, a
 * model-catalog validator for OpenAI versus Google versus Ollama.
 *
 * Both directions are still guarded: a Workers AI id under OpenAI/Google/Ollama
 * is refused by the second leg exactly as before, and the first leg is now
 * strictly narrower than it was — so nothing the resolver would drop can still
 * be approved here.
 *
 * `provider` is an {@link EmbeddingProvider}, not a `string`, because both
 * callers already hold a narrowed value — and an unnarrowed one would make a
 * typo read as "not workers-ai, therefore this id must not be `@cf/`", which is
 * a confident wrong answer rather than a type error.
 *
 * Both legs are CASE-SENSITIVE by design: `@CF/baai/bge-m3` is not a catalog key
 * and not in the namespace, so it is out under every provider. That is not a
 * rough edge to smooth over — `resolveEmbeddingModelName` applies this same
 * predicate, so lower-casing here would let the gate accept an id the resolver
 * then replaces, which is the bug this predicate prevents.
 *
 * The value handed in is already TRIMMED by both callers, and this must not trim
 * on their behalf: a trimming predicate would re-open the gate/resolver split
 * from the other side (DW-221).
 */
export function embeddingModelMatchesProvider(
  provider: EmbeddingProvider,
  model: string,
): boolean {
  if (provider === "workers-ai") return isWorkersAiEmbeddingModel(model);
  return !model.startsWith(WORKERS_AI_MODEL_PREFIX);
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
