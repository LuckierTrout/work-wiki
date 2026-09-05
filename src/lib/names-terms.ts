import { ClientInputError, isEnoent } from "./errors";
import { withFileLock } from "./lock";
import { READ_ONLY_REFUSAL, assertWritable } from "./read-only";
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

/**
 * The READ type — what {@link listNamesTerms} (and every helper that consumes
 * its result) hands back. The compile-time half of what
 * {@link resolveSortedEntries}'s `Object.freeze` already enforces at runtime
 * (DW-498).
 *
 * The read and the write surfaces are genuinely different types here, and until
 * this existed only the runtime knew it: `listNamesTerms` advertised a mutable
 * `NamesTermEntry[]` while handing back frozen objects, so a consumer could be
 * written straight through `tsc` against a contract the runtime then refuses at
 * the mutating line. Under a {@link NamesTermsCache} that line is worse than a
 * local failure — the entry objects are SHARED between every array the handle
 * hands out, which is exactly why they are frozen.
 *
 * {@link NamesTermEntry} stays mutable and stays the type of
 * `createNamesTerm` / `updateNamesTerm` and of {@link cleanInput}: the write
 * path builds entries, pushes onto their aliases and index-assigns
 * replacements, and none of that is what a read result is for. Mutable widens
 * to frozen (TypeScript ignores `readonly` property modifiers for assignability
 * and treats `string[]` as a `readonly string[]`), so a write-path value still
 * satisfies every helper below; the direction that must NOT work — a frozen
 * entry where a mutable one is expected — is the one this split closes.
 */
export type FrozenNamesTermEntry = Readonly<Omit<NamesTermEntry, "aliases">> & {
  readonly aliases: readonly string[];
};

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

/**
 * Validate a request body into a {@link NamesTermInput}.
 *
 * Refusals are `ClientInputError` (DW-641), not a bare `Error`: the two writing
 * doors used to end their catch at `NamesTermConflictError ? 409 : 400`, so an
 * EACCES, a full disk or a lock timeout inside `createNamesTerm` /
 * `updateNamesTerm` was reported as the owner's bad input while the sibling
 * `DELETE` answered 500 for the same class. A door can only default to 500 —
 * one verdict from the one store — once the store TYPES what is actually the
 * caller's fault. The same idiom as `research-projects.ts`; the messages are
 * unchanged. See {@link cleanInput} and `createNamesTerm`'s entry cap for the
 * other sites that carry it.
 */
export function parseNamesTermInput(body: Record<string, unknown>): NamesTermInput {
  if (!KIND_SET.has(String(body.kind))) throw new ClientInputError("Invalid names and terms type");
  if (typeof body.canonical !== "string" || !body.canonical.trim()) {
    throw new ClientInputError("Preferred name or term is required");
  }
  if (
    body.aliases !== undefined &&
    (!Array.isArray(body.aliases) || body.aliases.some((value) => typeof value !== "string"))
  ) {
    throw new ClientInputError("Aliases must be a list of text values");
  }
  for (const field of ["description", "email", "role", "organization", "guidance"] as const) {
    if (body[field] !== undefined && typeof body[field] !== "string") {
      throw new ClientInputError(`${field} must be text`);
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

// Refusals here are `ClientInputError` for the reason {@link parseNamesTermInput}
// documents: they are the caller's fault by construction, and they reach a door
// through `createNamesTerm`/`updateNamesTerm`, whose other failures are the
// storage layer's and must stay 500.
function cleanInput(input: NamesTermInput): Omit<NamesTermEntry, "id" | "createdAt" | "updatedAt"> {
  if (!KIND_SET.has(input.kind)) throw new ClientInputError("Invalid names and terms type");
  const canonical = cleanText(input.canonical, 160);
  if (!canonical) throw new ClientInputError("Preferred name or term is required");
  const email = cleanText(input.email, 254);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ClientInputError("Enter a valid email address");
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

/**
 * Can the read pipeline dereference this element without a guard of its own
 * (DW-499)?
 *
 * "Readable" is defined by what the pipeline actually touches, and nothing
 * wider: the sort comparator reads `kind` and `canonical`, and
 * `[entry.canonical, ...entry.aliases]` appears in
 * {@link canonicalizeNamesTerm}, {@link expandQueryWithNamesTerms},
 * {@link renderNamesTermsGuidance} — and, on the WRITE path,
 * {@link assertNoConflicts}, which every create and update runs over what
 * {@link readEntries} just handed it. So: an object, a string `kind`, a string
 * `canonical`, and an `aliases` array of strings.
 *
 * Deliberately NOT validated here: `kind` against {@link NAMES_TERM_KINDS},
 * `id`, and every optional field. None of them can throw on the read path, and
 * dropping an element the pipeline would have handled is data loss — see
 * {@link readEntries} for why a dropped element is worse than it looks.
 *
 * A pure predicate. It never coerces, repairs or rewrites an element; the only
 * outcomes are "kept as it is" and "not in this read".
 */
function isReadableEntry(value: unknown): value is NamesTermEntry {
  if (!value || typeof value !== "object") return false;
  const { kind, canonical, aliases } = value as Record<string, unknown>;
  return (
    typeof kind === "string" &&
    typeof canonical === "string" &&
    Array.isArray(aliases) &&
    aliases.every((alias) => typeof alias === "string")
  );
}

/**
 * The read boundary — and the one place a corrupt element is dropped (DW-499).
 *
 * The filter is what lets every later layer (sort, freeze, canonicalize,
 * render) dereference an entry with no guard of its own. Before it, one bad
 * element in a hand-edited `names-terms.json` failed the WHOLE read: a `null`
 * beside a real entry threw a `TypeError` out of the sort comparator, and a
 * field-less object survived as far as `renderNamesTermsGuidance`'s
 * `entry.aliases`. Filtering at the boundary degrades the read to the valid
 * SUBSET instead, which is the behaviour every consumer here already wants —
 * dictionary guidance is an addition to a prompt, never the operation.
 *
 * The WRITE path reads through here too, and that cuts both ways. A
 * create/update/delete over a dictionary holding an unreadable element now
 * SUCCEEDS, where {@link assertNoConflicts}' `[entry.canonical, ...aliases]`
 * used to throw a `TypeError` and the route answered 500 — the owner could not
 * add a term until they hand-repaired the file. But the element is then NOT
 * written back: these three persist what they read, so the next write drops it
 * from `names-terms.json` for good. That is the price of the degrade, it is the
 * reason the predicate is as narrow as it is (it must never drop something the
 * pipeline could have handled), and both halves are pinned in
 * `names-terms.test.ts` — moving this filter down into
 * {@link resolveSortedEntries} to stop deleting the owner's bytes would restore
 * the 500 at the write door.
 *
 * Unchanged: ENOENT degrades to `[]` and everything else RETHROWS, so the
 * `JSON.parse` `SyntaxError` from an unparseable file still propagates to the
 * caller's own catch (`merge.ts`'s pre-fold probe is the one that matters).
 */
async function readEntries(owner: string): Promise<NamesTermEntry[]> {
  try {
    const parsed: unknown = JSON.parse(await getStorage().readFile(dictionaryPath(owner)));
    return Array.isArray(parsed) ? parsed.filter(isReadableEntry) : [];
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
 * A caller-owned memo of the sorted dictionary, keyed by TENANT (DW-322).
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
 * Keyed by the TENANT the dictionary is addressed by — `tenant(owner)`, the
 * same derivation {@link dictionaryPath} uses — so one handle shared by two
 * owners never crosses their dictionaries, and two spellings of ONE handle
 * (`"Alice"` / `"alice"`, which `ownerToTenant` collapses to one path) share
 * the single slot over that one file instead of taking two reads and two
 * snapshots that can diverge (DW-394). Holds the PROMISE rather than the array
 * so the `Promise.all` pairs in `ingest.ts` share one in-flight read instead of
 * racing two.
 */
export type NamesTermsCache = Map<string, Promise<FrozenNamesTermEntry[]>>;

/** A fresh, empty handle. One per request/operation — never reused across them. */
export function createNamesTermsCache(): NamesTermsCache {
  return new Map();
}

/**
 * The uncached read, and the SINGLE place a read snapshot is produced — cached
 * and uncached callers both land here, so the two paths cannot drift.
 *
 * Each entry (and its `aliases`, the only nested mutable field on
 * {@link NamesTermEntry}) is frozen before it leaves: under a handle every
 * caller of the operation is handed the SAME entry objects, so an
 * `entry.aliases.push(...)` in one consumer would otherwise leak into every
 * later caller (DW-397). Freezing turns that into an immediate `TypeError` at
 * the mutating line instead of a silent cross-caller edit. Only the entries are
 * frozen — {@link listNamesTerms} still hands out a fresh top-level ARRAY that
 * callers may sort or splice.
 *
 * {@link readEntries} deliberately stays unfrozen: `createNamesTerm` pushes onto
 * the array it reads, `updateNamesTerm` index-assigns a spread-built
 * replacement into it, and `deleteNamesTerm` filters it into a new one — all
 * ARRAY-level writes over entries they never mutate in place, which is exactly
 * why the freeze belongs here and not there.
 *
 * The sort and the freeze both dereference every element unguarded, and they
 * may: {@link readEntries} filters through {@link isReadableEntry}, so a
 * `null`, a non-object or a field-less element never reaches this function
 * (DW-499). It used to skip freezing such an element — which did nothing for
 * the comparator one line above, where a corrupt element in an array of two or
 * more already threw.
 *
 * The return type is {@link FrozenNamesTermEntry}, so what callers are handed
 * is typed as what it is (DW-498).
 */
async function resolveSortedEntries(owner: string): Promise<FrozenNamesTermEntry[]> {
  const entries = (await readEntries(owner)).sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.canonical.localeCompare(b.canonical),
  );
  for (const entry of entries) {
    Object.freeze(entry.aliases);
    Object.freeze(entry);
  }
  return entries;
}

/**
 * The owner's dictionary, sorted by kind then preferred label.
 *
 * With no `cache`, this is exactly the call it has always been: one storage read
 * every time, ENOENT degrading to `[]`. Pass a handle from
 * {@link createNamesTermsCache} to read at most once per TENANT for the life of
 * that handle — the memo is keyed by the same `tenant(owner)` that addresses the
 * file, so two casings of one handle share one read (DW-394).
 *
 * The cached path returns a FRESH top-level array on every call, so a caller
 * that sorts or splices its result (several do) can never corrupt what the next
 * caller sees. The entry OBJECTS are shared between those arrays, so
 * {@link resolveSortedEntries} freezes each one and its `aliases`: mutating a
 * returned entry throws a `TypeError` rather than silently rewriting what every
 * later caller under the handle sees (DW-397). The RESULT TYPE says so —
 * {@link FrozenNamesTermEntry}, not the mutable {@link NamesTermEntry} the
 * write path uses — so a consumer written to mutate an entry is rejected by
 * `tsc` rather than by the runtime at the mutating line (DW-498).
 *
 * A corrupt element cannot reach here at all: {@link readEntries} filters the
 * parsed file down to the entries the pipeline can dereference, so a
 * hand-edited dictionary degrades to its valid subset instead of failing the
 * read (DW-499). What still rejects is exactly what {@link readEntries}
 * propagates: an unparseable file, and any storage failure that is not ENOENT
 * (EACCES, EIO, a remote-storage error). The RENDER layer no longer throws.
 *
 * Only a SUCCESSFUL read is memoized; a failure is evicted and the next call
 * re-reads.
 */
export async function listNamesTerms(
  owner: string,
  cache?: NamesTermsCache,
): Promise<FrozenNamesTermEntry[]> {
  if (!cache) return resolveSortedEntries(owner);
  // Keyed by what ADDRESSES the file, not by the raw handle: `dictionaryPath`
  // routes through the same `tenant()`, so `"Alice"` and `"alice"` are one file
  // and must be one memo slot (DW-394).
  const key = tenant(owner);
  let memo = cache.get(key);
  if (!memo) {
    // Stored BEFORE the read settles, so concurrent callers join the same
    // in-flight read rather than starting a second one.
    const pending = resolveSortedEntries(owner);
    memo = pending;
    cache.set(key, pending);
    // A REJECTION is not memoized. A handle can span a whole request (the batch
    // route's inline fallback), so pinning one transient non-ENOENT storage
    // error would fail every remaining document of that request even though
    // each would have re-read and succeeded — an outcome the uncached path
    // never produces. Evicted only if the entry is still THIS promise, so a
    // later successful read is never dropped. The `catch` handles the rejection
    // on this derived promise (no unhandled rejection) and rethrows nothing;
    // the awaiting caller below still receives the original error.
    pending.catch(() => {
      if (cache.get(key) === pending) cache.delete(key);
    });
  }
  return [...(await memo)];
}

export async function createNamesTerm(
  owner: string,
  input: NamesTermInput,
): Promise<NamesTermEntry> {
  // Deployment read-only (DW-385). AHEAD of `withFileLock`, so a refused call
  // does not first queue behind the tenant's in-flight dictionary work.
  //
  // Today the `/api/names-terms` handlers are the only callers of these three
  // and they gate already, so this changes no behaviour the app has; it is here
  // for the DIRECT LIBRARY caller added next, which no HTTP gate can reach.
  // Same reasoning as the wiki-lifecycle gates in `read-only.ts`.
  assertWritable(READ_ONLY_REFUSAL.namesTerms);
  return withFileLock(lockKey(owner), async () => {
    const entries = await readEntries(owner);
    if (entries.length >= MAX_ENTRIES) {
      throw new ClientInputError(`Names & Terms is limited to ${MAX_ENTRIES} entries`);
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
  // Deployment read-only (DW-385) — see {@link createNamesTerm}.
  assertWritable(READ_ONLY_REFUSAL.namesTerms);
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
  // Deployment read-only (DW-385) — see {@link createNamesTerm}.
  assertWritable(READ_ONLY_REFUSAL.namesTerms);
  return withFileLock(lockKey(owner), async () => {
    const entries = await readEntries(owner);
    const filtered = entries.filter((entry) => entry.id !== id);
    if (filtered.length === entries.length) return false;
    await writeEntries(owner, filtered);
    return true;
  });
}

/**
 * The three helpers below take the READ type (DW-498): they are the only
 * functions a {@link listNamesTerms} result is passed into, and none of them
 * writes to an entry. A mutable {@link NamesTermEntry} still satisfies
 * {@link FrozenNamesTermEntry}, so every write-path caller compiles untouched.
 */
export function canonicalizeNamesTerm(
  entries: readonly FrozenNamesTermEntry[],
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
  entries: readonly FrozenNamesTermEntry[],
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

export function renderNamesTermsGuidance(entries: readonly FrozenNamesTermEntry[]): string {
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
