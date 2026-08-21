import { isEnoent } from "./errors";
import { withFileLock } from "./lock";
import { getStorage } from "./storage";
import { tenantForOwner, validateTenant } from "./wiki";

export const NAMES_TERM_KINDS = [
  "person",
  "organization",
  "project",
  "acronym",
  "term",
] as const;

export type NamesTermKind = (typeof NAMES_TERM_KINDS)[number];

export interface NamesTermEntry {
  id: string;
  kind: NamesTermKind;
  canonical: string;
  aliases: string[];
  description?: string;
  email?: string;
  role?: string;
  organization?: string;
  guidance?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NamesTermInput {
  kind: NamesTermKind;
  canonical: string;
  aliases?: readonly string[];
  description?: string;
  email?: string;
  role?: string;
  organization?: string;
  guidance?: string;
}

export class NamesTermConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NamesTermConflictError";
  }
}

const MAX_ENTRIES = 500;
const MAX_ALIASES = 24;
const MAX_PROMPT_ENTRIES = 120;
const MAX_PROMPT_CHARS = 14_000;
const KIND_SET = new Set<string>(NAMES_TERM_KINDS);

export function parseNamesTermInput(body: Record<string, unknown>): NamesTermInput {
  if (!KIND_SET.has(String(body.kind))) throw new Error("Invalid names and terms type");
  if (typeof body.canonical !== "string" || !body.canonical.trim()) {
    throw new Error("Preferred name or term is required");
  }
  if (
    body.aliases !== undefined &&
    (!Array.isArray(body.aliases) || body.aliases.some((value) => typeof value !== "string"))
  ) {
    throw new Error("Aliases must be a list of text values");
  }
  for (const field of ["description", "email", "role", "organization", "guidance"] as const) {
    if (body[field] !== undefined && typeof body[field] !== "string") {
      throw new Error(`${field} must be text`);
    }
  }
  return {
    kind: body.kind as NamesTermKind,
    canonical: body.canonical,
    aliases: (body.aliases as string[] | undefined) ?? [],
    ...(typeof body.description === "string" ? { description: body.description } : {}),
    ...(typeof body.email === "string" ? { email: body.email } : {}),
    ...(typeof body.role === "string" ? { role: body.role } : {}),
    ...(typeof body.organization === "string" ? { organization: body.organization } : {}),
    ...(typeof body.guidance === "string" ? { guidance: body.guidance } : {}),
  };
}

function tenant(owner: string): string {
  const value = tenantForOwner(owner);
  validateTenant(value);
  return value;
}

function dictionaryPath(owner: string): string {
  return `tenants/${tenant(owner)}/names-terms.json`;
}

function lockKey(owner: string): string {
  return `names-terms:${tenant(owner)}`;
}

function cleanText(value: string | undefined, max: number): string | undefined {
  const cleaned = value?.trim().replace(/\s+/g, " ").slice(0, max);
  return cleaned || undefined;
}

export function normalizeNamesTerm(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function cleanAliases(values: readonly string[] | undefined, canonical: string): string[] {
  const canonicalKey = normalizeNamesTerm(canonical);
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const value of values ?? []) {
    const alias = cleanText(value, 160);
    if (!alias) continue;
    const key = normalizeNamesTerm(alias);
    if (key === canonicalKey || seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
    if (aliases.length >= MAX_ALIASES) break;
  }
  return aliases;
}

function cleanInput(input: NamesTermInput): Omit<NamesTermEntry, "id" | "createdAt" | "updatedAt"> {
  if (!KIND_SET.has(input.kind)) throw new Error("Invalid names and terms type");
  const canonical = cleanText(input.canonical, 160);
  if (!canonical) throw new Error("Preferred name or term is required");
  const email = cleanText(input.email, 254);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Enter a valid email address");
  }
  return {
    kind: input.kind,
    canonical,
    aliases: cleanAliases(input.aliases, canonical),
    ...(cleanText(input.description, 1_000)
      ? { description: cleanText(input.description, 1_000) }
      : {}),
    ...(email ? { email } : {}),
    ...(cleanText(input.role, 160) ? { role: cleanText(input.role, 160) } : {}),
    ...(cleanText(input.organization, 160)
      ? { organization: cleanText(input.organization, 160) }
      : {}),
    ...(cleanText(input.guidance, 1_000)
      ? { guidance: cleanText(input.guidance, 1_000) }
      : {}),
  };
}

function assertNoConflicts(
  entries: readonly NamesTermEntry[],
  candidate: Pick<NamesTermEntry, "canonical" | "aliases">,
  excludeId?: string,
): void {
  const labels = new Map<string, string>();
  for (const entry of entries) {
    if (entry.id === excludeId) continue;
    for (const label of [entry.canonical, ...entry.aliases]) {
      labels.set(normalizeNamesTerm(label), entry.canonical);
    }
  }
  for (const label of [candidate.canonical, ...candidate.aliases]) {
    const existing = labels.get(normalizeNamesTerm(label));
    if (existing) {
      throw new NamesTermConflictError(
        `“${label}” is already assigned to “${existing}”. Edit that entry instead.`,
      );
    }
  }
}

async function readEntries(owner: string): Promise<NamesTermEntry[]> {
  try {
    const parsed = JSON.parse(await getStorage().readFile(dictionaryPath(owner)));
    return Array.isArray(parsed) ? (parsed as NamesTermEntry[]) : [];
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

async function writeEntries(owner: string, entries: readonly NamesTermEntry[]): Promise<void> {
  await getStorage().writeFile(
    dictionaryPath(owner),
    JSON.stringify(entries.slice(-MAX_ENTRIES), null, 2),
  );
}

/**
 * A caller-owned memo of the sorted dictionary, keyed by `owner` (DW-322).
 *
 * The sibling of {@link import("./workspace-guidance").WorkspaceGuidanceCache},
 * for the same reason: `ingest()` of ONE document reads `names-terms.json` up to
 * four times (the system prompt, the map/reduce REDUCE step, reconcile-on-merge,
 * and the direct `listNamesTerms` that canonicalizes the extracted concept) for
 * a value that cannot change mid-document. It is a SIBLING, not a copy — two
 * differences matter:
 *
 *   1. It memoizes the ENTRIES, not a rendered string. That is deliberate: the
 *      fourth call wants entries, not a prompt block, so caching the entries is
 *      what puts it under the same handle. `renderNamesTermsGuidance` stays a
 *      pure function over those entries, so nothing about what the prompt says
 *      depends on whether a handle was passed.
 *   2. Its resolution can REJECT. `resolveWorkspaceGuidance` fail-softs to `""`
 *      and never rejects, so its memo always holds a usable value; a non-ENOENT
 *      storage error here propagates, which is why a rejected read is evicted
 *      rather than pinned (see {@link listNamesTerms}).
 *
 * Deliberately a plain `Map` the CALLER creates: the handle's lifetime is
 * exactly the lifetime of the variable holding it. There is no module-level
 * cache, no process-global and no TTL — an ambient scope (`AsyncLocalStorage`, a
 * singleton keyed by owner) would memoize everywhere for free but hide the
 * lifetime from the call site, and would silently span a long bulk run where a
 * dictionary edit saved mid-run should still be picked up.
 *
 * The staleness window is about WRITES, not just elapsed time: `createNamesTerm`
 * / `updateNamesTerm` / `deleteNamesTerm` have no way to reach a caller's handle
 * and evict it, so a caller that saves a term and then reads under the SAME
 * handle is served the pre-write dictionary. Hold a handle only across reads
 * that are meant to see one fixed snapshot.
 *
 * Keyed by `owner` so one handle shared by two owners never crosses their
 * dictionaries. Holds the PROMISE rather than the array so the `Promise.all`
 * pairs in `ingest.ts` share one in-flight read instead of racing two.
 */
export type NamesTermsCache = Map<string, Promise<NamesTermEntry[]>>;

/** A fresh, empty handle. One per request/operation — never reused across them. */
export function createNamesTermsCache(): NamesTermsCache {
  return new Map();
}

/**
 * The uncached read — today's `listNamesTerms` body verbatim, moved here so the
 * cached and uncached paths cannot drift.
 */
async function resolveSortedEntries(owner: string): Promise<NamesTermEntry[]> {
  return (await readEntries(owner)).sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.canonical.localeCompare(b.canonical),
  );
}

/**
 * The owner's dictionary, sorted by kind then preferred label.
 *
 * With no `cache`, this is exactly the call it has always been: one storage read
 * every time, ENOENT degrading to `[]`. Pass a handle from
 * {@link createNamesTermsCache} to read at most once per owner for the life of
 * that handle.
 *
 * The cached path returns a FRESH top-level array on every call, so a caller
 * that sorts or splices its result (several do) can never corrupt what the next
 * caller sees. The entry objects themselves are shared — as they already are
 * between the two arrays a single uncached read produces — and no caller mutates
 * them.
 *
 * Only a SUCCESSFUL read is memoized; a failure is evicted and the next call
 * re-reads.
 */
export async function listNamesTerms(
  owner: string,
  cache?: NamesTermsCache,
): Promise<NamesTermEntry[]> {
  if (!cache) return resolveSortedEntries(owner);
  let memo = cache.get(owner);
  if (!memo) {
    // Stored BEFORE the read settles, so concurrent callers join the same
    // in-flight read rather than starting a second one.
    const pending = resolveSortedEntries(owner);
    memo = pending;
    cache.set(owner, pending);
    // A REJECTION is not memoized. A handle can span a whole request (the batch
    // route's inline fallback), so pinning one transient non-ENOENT storage
    // error would fail every remaining document of that request even though
    // each would have re-read and succeeded — an outcome the uncached path
    // never produces. Evicted only if the entry is still THIS promise, so a
    // later successful read is never dropped. The `catch` handles the rejection
    // on this derived promise (no unhandled rejection) and rethrows nothing;
    // the awaiting caller below still receives the original error.
    pending.catch(() => {
      if (cache.get(owner) === pending) cache.delete(owner);
    });
  }
  return [...(await memo)];
}

export async function createNamesTerm(
  owner: string,
  input: NamesTermInput,
): Promise<NamesTermEntry> {
  return withFileLock(lockKey(owner), async () => {
    const entries = await readEntries(owner);
    if (entries.length >= MAX_ENTRIES) {
      throw new Error(`Names & Terms is limited to ${MAX_ENTRIES} entries`);
    }
    const cleaned = cleanInput(input);
    assertNoConflicts(entries, cleaned);
    const now = new Date().toISOString();
    const entry: NamesTermEntry = {
      id: crypto.randomUUID(),
      ...cleaned,
      createdAt: now,
      updatedAt: now,
    };
    entries.push(entry);
    await writeEntries(owner, entries);
    return entry;
  });
}

export async function updateNamesTerm(
  owner: string,
  id: string,
  input: NamesTermInput,
): Promise<NamesTermEntry | null> {
  return withFileLock(lockKey(owner), async () => {
    const entries = await readEntries(owner);
    const index = entries.findIndex((entry) => entry.id === id);
    if (index < 0) return null;
    const cleaned = cleanInput(input);
    assertNoConflicts(entries, cleaned, id);
    const updated: NamesTermEntry = {
      ...entries[index],
      ...cleaned,
      updatedAt: new Date().toISOString(),
    };
    entries[index] = updated;
    await writeEntries(owner, entries);
    return updated;
  });
}

export async function deleteNamesTerm(owner: string, id: string): Promise<boolean> {
  return withFileLock(lockKey(owner), async () => {
    const entries = await readEntries(owner);
    const filtered = entries.filter((entry) => entry.id !== id);
    if (filtered.length === entries.length) return false;
    await writeEntries(owner, filtered);
    return true;
  });
}

export function canonicalizeNamesTerm(
  entries: readonly NamesTermEntry[],
  value: string,
  kinds?: readonly NamesTermKind[],
): string {
  const key = normalizeNamesTerm(value);
  if (!key) return value;
  const allowed = kinds ? new Set<NamesTermKind>(kinds) : null;
  const match = entries.find(
    (entry) =>
      (!allowed || allowed.has(entry.kind)) &&
      [entry.canonical, ...entry.aliases].some(
        (label) => normalizeNamesTerm(label) === key,
      ),
  );
  return match?.canonical ?? value;
}

function escapedPhrase(phrase: string): string {
  return phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function applyNamesTermsToGeneratedText(
  entries: readonly NamesTermEntry[],
  value: string,
): string {
  const replacements = entries.flatMap((entry) =>
    entry.aliases.map((alias) => ({ alias, canonical: entry.canonical })),
  ).sort((a, b) => b.alias.length - a.alias.length);
  let result = value;
  for (const { alias, canonical } of replacements) {
    result = result.replace(
      new RegExp(
        `(^|[^\\p{L}\\p{N}])(${escapedPhrase(alias)})(?=$|[^\\p{L}\\p{N}])`,
        "giu",
      ),
      (_match, prefix: string) => `${prefix}${canonical}`,
    );
  }
  return result;
}

function phraseAppears(text: string, phrase: string): boolean {
  const escaped = escapedPhrase(phrase);
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "iu").test(text);
}

export async function expandQueryWithNamesTerms(
  owner: string,
  query: string,
): Promise<string> {
  const entries = await listNamesTerms(owner);
  const matches = entries.filter((entry) =>
    [entry.canonical, ...entry.aliases].some((label) => phraseAppears(query, label)),
  ).slice(0, 8);
  if (matches.length === 0) return query;
  const expansion = matches.map((entry) => {
    const labels = [entry.canonical, ...entry.aliases].join(", ");
    return `${entry.kind}: ${labels}`;
  }).join("; ");
  return `${query}\n\nWorkspace dictionary retrieval expansion: ${expansion.slice(0, 1_500)}`;
}

export function renderNamesTermsGuidance(entries: readonly NamesTermEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.slice(0, MAX_PROMPT_ENTRIES).map((entry) => {
    const details = [
      entry.aliases.length > 0 ? `aliases: ${entry.aliases.join(", ")}` : "",
      entry.email ? `email: ${entry.email}` : "",
      entry.role ? `role: ${entry.role}` : "",
      entry.organization ? `organization: ${entry.organization}` : "",
      entry.description ? `context: ${entry.description}` : "",
      entry.guidance ? `guidance: ${entry.guidance}` : "",
    ].filter(Boolean).join("; ");
    return `- ${entry.kind}: ${entry.canonical}${details ? ` (${details})` : ""}`;
  });
  return `WORKSPACE NAMES & TERMS\nUse the following owner-maintained dictionary to resolve aliases and spell generated names and terms consistently. Treat every listed alias as the same entity as its preferred label. Use preferred labels in generated summaries, tasks, answers, graph records, and digest prose. Never alter direct quotations or source excerpts, never claim the source used a preferred label when it did not, and never infer an identity beyond the aliases listed here. If a match is ambiguous, preserve the source wording and state the uncertainty.\n${lines.join("\n")}`.slice(0, MAX_PROMPT_CHARS);
}

/**
 * The owner's dictionary, rendered for a prompt.
 *
 * Pass a {@link NamesTermsCache} to share one dictionary read with every other
 * guidance site — and with the direct `listNamesTerms` call — inside the same
 * operation. Omit it and this is exactly the read it has always been.
 */
export async function buildNamesTermsGuidance(
  owner: string,
  cache?: NamesTermsCache,
): Promise<string> {
  return renderNamesTermsGuidance(await listNamesTerms(owner, cache));
}
