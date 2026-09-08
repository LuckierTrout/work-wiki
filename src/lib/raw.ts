import {
  getRawDir,
  rawRelPath,
  tenantForOwner,
  tenantRawRelPath,
  validateSlug,
  ensureDirectories,
} from "./wiki";
import { getStorage } from "./storage";
import { bumpDataVersion } from "./data-version";
import { isEnoent } from "./errors";
import { logger } from "./logger";
// The door's OWN inventory of what each extension is served as. Imported
// rather than restated so a stored artefact's `mediaType` cannot disagree with
// what the Preview and asset doors actually send. Cycle-free: `workbench-intake`
// pulls only `document-formats`, `slugify` and `workbench-tree`, none of which
// reach back here.
import { intakeContentType } from "./workbench-intake";

// ---------------------------------------------------------------------------
// Raw source storage
// ---------------------------------------------------------------------------

/**
 * The ONE directory under `raw/` that Source bytes are written to.
 *
 * Arrival stores under `raw/sources/` (FR-41) — the address the Workbench's
 * Sources and Files surfaces are built around — while `raw/assets/` (binary
 * assets) and `raw/uploads/` (queue staging) keep their own siblings. Before
 * this, `saveRawSource` wrote a flat `raw/<slug>.md` that the Workbench's
 * silo-only raw resolve (DW-40) would never show.
 *
 * Reads still look at the legacy flat location afterwards, so a workspace
 * written before the move keeps answering; nothing WRITES there any more.
 */
export const RAW_SOURCES_DIR = "sources";

/**
 * The OPTIONAL keep of extractor output (Story 7.2's Intake checkbox).
 *
 * Not a second vault and not a Source: the system of record for a binary
 * arrival is still the immutable bytes under `raw/sources/`, and the Markdown
 * the sidecar produced is written beside them as `raw/sources/<slug>/<id>.md`
 * whether or not this keep is on. This directory is a debugging convenience —
 * "show me exactly what the parser saw" — which is why nothing reads it back.
 */
export const RAW_PARSED_DIR = "parsed";

/**
 * The structural root of the binary-asset tree under `raw/`.
 *
 * Its PER-PAGE subtree is `assets/<slug>/<file>` — images pulled out of a
 * document arrival (`preserveDocumentSources`) and images fetched for a page
 * (`fetch.ts`) land there, and `syncSiloForPage` mirrors the whole
 * `assets/<slug>` directory into the owner's tenant silo. That subtree is the
 * reason the Workbench read gate has to know this root by name: its second
 * segment is a page slug exactly as it is under {@link RAW_SOURCES_DIR}, so a
 * gate reading the FIRST segment derives `assets` and discloses every hidden
 * page's asset directory (DW-491).
 *
 * NOT everything under this root is per-page: `illustration.ts` writes
 * `assets/illustrations/<key>.jpg`, a shared cache with no slug in it. Such a
 * subtree has its first segment read as a slug anyway — the fail-closed
 * direction {@link RAW_PARSED_DIR} also takes, since the path alone cannot
 * prove a segment is not somebody's slug.
 *
 * The constant is the STORAGE-root spelling, shared by the silo mirror and that
 * read gate so the two cannot drift apart. It is deliberately NOT every
 * `assets/…` literal in the tree: `fetch.ts`, `illustration.ts`, the
 * `/api/assets` route and the vault export spell it too, but there the string
 * doubles as the MARKDOWN-FACING ref namespace (`![](assets/<slug>/<file>)`)
 * and the exported vault's layout — a separate contract that `rawRelPath` maps
 * onto this root, and that must not start moving whenever this one does.
 */
export const RAW_ASSETS_DIR = "assets";

/**
 * The first segments under `raw/` that are STRUCTURE, not a page slug.
 *
 * A page slug occupies the same position as these roots do — `raw/<slug>.md`
 * and the legacy hashed `raw/<slug>/<rawId>.md` put it right there — so a
 * caller walking `raw/<name>/` cannot tell a real page slugged `assets` from
 * the asset root itself by the path alone.
 *
 * The principle when the path cannot resolve that ambiguity is to WITHHOLD, and
 * `rawPathSlug` already applies it under `raw/` — though in the opposite
 * DIRECTION, which is worth naming so the two are not read as one rule. There,
 * withholding means reading `parsed` AS a slug, so a hidden page by that name
 * keeps its subtree out of the Files listing. Here, withholding means reading
 * the name as a ROOT, so the mirror skips the legacy hashed tree for these
 * names rather than pulling another owner's content into one page's silo
 * (DW-611); a page delete likewise leaves them alone. Each direction costs the
 * real page named `parsed`/`assets` something, and each buys the answer that
 * cannot leak or destroy somebody else's data.
 *
 * {@link listRawSourceSnapshots} takes the SAME withholding under the legacy
 * root, for the same reason in a third shape: reading `sources` as a slug there
 * turned every flat `raw/sources/<hex>.md` into a snapshot of a page called
 * `sources` (DW-568). This set must therefore be EVERY structural root, not
 * merely the ones the silo happened to care about — one missing name is one
 * root that still mints unreadable rows.
 *
 * `uploads` is `ingest-staging.ts`'s root (`raw/uploads/<jobId>/<file>`) and
 * the literal lives there; it is restated here because this set is about what
 * a *slug-shaped* segment may not be, and staging blobs are as foreign to a
 * page's silo as anything else under `raw/`.
 *
 * `originals` is `document-sources.ts`'s root
 * (`raw/originals/<tenant>/<slug>/<file>`, written through `rawRelPath`) and
 * the literal lives there, restated here for the same reason — and it is the
 * one whose second segment is not even a slug but a TENANT, so reading it as a
 * page would name a page after somebody's tenant id.
 */
export const RAW_STRUCTURAL_DIRS: ReadonlySet<string> = new Set([
  RAW_SOURCES_DIR,
  RAW_ASSETS_DIR,
  RAW_PARSED_DIR,
  "uploads",
  "originals",
]);

/** Storage-relative path for something under `raw/sources/`. */
export function rawSourceRelPath(rest: string): string {
  return rawRelPath(`${RAW_SOURCES_DIR}/${rest}`);
}

/** Storage-relative path for something under `raw/parsed/`. */
export function rawParsedRelPath(rest: string): string {
  return rawRelPath(`${RAW_PARSED_DIR}/${rest}`);
}

/** Storage-relative path for something under `tenants/<tenant>/raw/sources/`. */
export function tenantRawSourceRelPath(tenant: string, rest: string): string {
  return tenantRawRelPath(tenant, `${RAW_SOURCES_DIR}/${rest}`);
}

export interface SaveRawSourceOptions {
  /**
   * The handle whose silo the bytes are mirrored into.
   *
   * Without it only the flat `raw/sources/…` key is written, which the
   * Workbench cannot see: `listWorkbenchFilePaths` resolves `raw/` strictly
   * inside `tenants/<tenant>/raw/` and never falls back to the shared flat tree
   * (DW-40). Intake doors pass the signed-in principal so the arrival is
   * visible in Files on the next `dataVersion` refresh. Ingest's own callers
   * leave it unset — `syncSiloForPage` mirrors a page's artifacts after the
   * page write, which is the path they already go through.
   */
  owner?: string | null;
}

/**
 * Publish `rel` create-only, naming the key if the provider refuses.
 *
 * A store that cannot complete must not fall back to an overwrite. The old
 * `fileExists`-then-write pair treated a failed check as "absent" and wrote
 * anyway; under FR-2 that is the worse failure, because a flaky answer on an
 * OCCUPIED key would mutate immutable bytes. The create-only door removes the
 * window entirely, and a rejection still fails visibly — the arrival fails, the
 * key is named in the log, and the owner can retry.
 *
 * THE COST THIS ACCEPTS: a create-only door ships the whole body before the
 * precondition can reject it. The filesystem provider writes and fsyncs a
 * complete tmp file before `fs.link` (or, on a link-less mount, the fallback
 * probe) answers "the name is taken", and R2 PUTs the object
 * before `etagDoesNotMatch: "*"` rejects it, so a re-drop of the same large PDF
 * now pays a full write where the old `fileExists` short-circuited. Accepted:
 * the race it closes mutates bytes the product promises never change.
 *
 * NOT A BATCH MEMBER, on purpose (DW-293). `StorageProvider.withBatchedWrites`
 * amortises one directory barrier over many writes, but an ingest arrival makes
 * exactly two — this flat key, then {@link mirrorSourceToSilo}'s copy — and
 * they live in two DIFFERENT directories, so a per-directory barrier is two
 * barriers for two writes. Nothing saved, in exchange for widening a create-only
 * door (which publishes by `fs.link`, falling back to a probe-then-`rename`
 * under the publication lock where the mount has no hard links, and stays fully
 * synced) into a scope whose members are only recoverable by re-driving the
 * whole set.
 */
async function publishSourceFirstWrite(
  rel: string,
  content: string,
): Promise<boolean> {
  try {
    return await getStorage().writeFileIfAbsent(rel, content);
  } catch (err) {
    logger.warn("raw", `create-only write failed for "${rel}"; refusing to overwrite`, err);
    throw err;
  }
}

/** The binary twin of {@link publishSourceFirstWrite}; same contract and cost. */
async function publishSourceBytesFirstWrite(
  rel: string,
  bytes: ArrayBuffer,
): Promise<boolean> {
  try {
    return await getStorage().writeAssetIfAbsent(rel, bytes);
  } catch (err) {
    logger.warn("raw", `create-only write failed for "${rel}"; refusing to overwrite`, err);
    throw err;
  }
}

/**
 * Mirror stored Source bytes into the owner's silo. FAIL-SOFT: the flat
 * `raw/sources/…` key is the system of record, and a mirror that rejects must
 * not turn a Source that already landed into a failed arrival — the cost is a
 * Files tree that lags until the next reconcile, which is recoverable.
 */
async function mirrorSourceToSilo(
  rest: string,
  content: string,
  owner: string | null | undefined,
): Promise<boolean> {
  if (!owner) return false;
  try {
    const rel = tenantRawSourceRelPath(tenantForOwner(owner), rest);
    // Immutable in the silo too: a re-arrival must not rewrite what is there,
    // and the create-only door decides that in ONE operation — a separate
    // existence check would leave a window where two mirrors of the same key
    // both saw "absent" and the loser's write replaced the winner's bytes.
    return await getStorage().writeFileIfAbsent(rel, content);
  } catch (err) {
    logger.warn("raw", `silo mirror failed for raw source "${rest}"`, err);
    return false;
  }
}

/**
 * Write `raw/sources/<rest>` unless it already exists, and report whether the
 * bytes are new.
 *
 * Sources are IMMUTABLE once saved (FR-2), so an existing key is left exactly
 * as it is — never rewritten, and never thrown over: `saveRawSource` is called
 * on every ingest of a slug, so refusing loudly would turn a second ingest of
 * the same page into an error. Distinct arrivals get distinct keys through
 * {@link saveRawSourceFor}'s content-hashed id, which is why "the key exists"
 * and "the same bytes are already stored" mean the same thing there.
 *
 * A NEW write bumps `dataVersion` so the Workbench's trees catch up without a
 * reload. A skipped write that only repairs a missing silo copy also bumps —
 * the Files tree just gained a key the watcher would otherwise never see. A
 * skipped write that changed nothing bumps nothing.
 *
 * "Does it exist?" and "write it" are ONE provider call (`writeFileIfAbsent`),
 * never a check followed by a write. The pair left a window in which two
 * concurrent arrivals on the same absent key both read "absent" and the later
 * write replaced the earlier one's bytes — precisely the mutation FR-2
 * forbids. A provider that cannot complete the create-only call THROWS and the
 * arrival fails visibly, which is deliberate: degrading to an overwrite on a
 * flaky provider is the worse failure, and the owner can retry.
 */
async function storeRawSource(
  rest: string,
  content: string,
  options?: SaveRawSourceOptions,
): Promise<boolean> {
  await ensureDirectories();
  const rel = rawSourceRelPath(rest);
  const created = await publishSourceFirstWrite(rel, content);
  if (!created) {
    // Occupied (FR-2): leave the bytes. Still repair the mirror — the flat
    // bytes exist, and a silo that never received them would leave the Source
    // invisible forever. The first write already bumped; without a second bump
    // here the watcher is forward-only and Files stays empty after a
    // fail-then-repair.
    //
    // Mirror the STORED bytes, not the request body. A tree key can be
    // re-offered with different text (FR-40 path identity); copying the new
    // body into the silo would show Files a Source the flat key does not hold.
    //
    // So a failed re-read ABANDONS the repair rather than falling back to
    // `content` (DW-570). Falling back would mirror exactly the bytes the
    // paragraph above forbids, and — because the silo door is create-only —
    // that wrong text would be the permanent answer Files gives for this
    // Source, with nothing to correct it later. A silo that is still missing
    // the Source is the strictly better failure: it is visibly empty rather
    // than confidently wrong, the flat bytes are intact, and the next arrival
    // on this key repairs it for real. No mirror means no `dataVersion` bump
    // either — nothing changed for a watcher to see.
    let stored: string;
    try {
      stored = await getStorage().readFile(rel);
    } catch (err) {
      logger.warn("raw", `could not re-read "${rel}" for silo repair`, err);
      return false;
    }
    const repaired = await mirrorSourceToSilo(rest, stored, options?.owner);
    if (repaired) await bumpDataVersion();
    return false;
  }
  await mirrorSourceToSilo(rest, content, options?.owner);
  await bumpDataVersion();
  return true;
}

/**
 * The binary twin of {@link storeRawSource}.
 *
 * A PDF, a DOCX or a JPEG is not text and must not be round-tripped through a
 * UTF-8 string on the way to storage — `writeFile` would mangle every byte that
 * is not valid UTF-8, and the sidecar would then be handed a corrupt document
 * to parse. `writeAssetIfAbsent` is the provider's create-only binary door, and
 * this keeps the rest of the arrival contract identical: first-write-only, silo
 * mirror, one `dataVersion` bump — with the existence decision and the
 * publication fused into one operation for the reason {@link storeRawSource}
 * documents.
 *
 * THE SILO MIRROR IS NOT OPTIONAL HERE, despite an earlier comment on this
 * function claiming "Files resolves binaries through the flat key". It does
 * not: {@link resolveWorkbenchFile} resolves `raw/` strictly inside
 * `tenants/<tenant>/raw/` and never falls back to the shared flat tree (DW-40),
 * the same rule the string writer above mirrors for. Without this a stored
 * image was invisible in Files and its bytes unreachable through the media
 * door — the two things Story 7.7 exists to provide.
 */
async function storeRawSourceBytes(
  rest: string,
  bytes: ArrayBuffer,
  options?: SaveRawSourceOptions,
): Promise<boolean> {
  await ensureDirectories();
  const rel = rawSourceRelPath(rest);
  const created = await publishSourceBytesFirstWrite(rel, bytes);
  if (!created) {
    // Occupied (FR-2): leave the bytes. Repair a missing mirror even when the
    // flat bytes are already there, for the reason {@link storeRawSource}
    // documents: the watcher is forward-only, so a mirror that failed once
    // would otherwise never land.
    const repaired = await mirrorSourceBytesToSilo(rest, bytes, options?.owner);
    if (repaired) await bumpDataVersion();
    return false;
  }
  await mirrorSourceBytesToSilo(rest, bytes, options?.owner);
  await bumpDataVersion();
  return true;
}

/**
 * The binary twin of {@link mirrorSourceToSilo} — same fail-soft contract, and
 * `writeAssetIfAbsent` rather than `writeFileIfAbsent` because a PNG is not a
 * UTF-8 string.
 *
 * The bytes are mirrored from the CALLER's buffer rather than re-read from the
 * flat key: this writer is first-write-only over a content-addressed name, so
 * the buffer in hand and the stored object are the same bytes by construction.
 */
async function mirrorSourceBytesToSilo(
  rest: string,
  bytes: ArrayBuffer,
  owner: string | null | undefined,
): Promise<boolean> {
  if (!owner) return false;
  try {
    const rel = tenantRawSourceRelPath(tenantForOwner(owner), rest);
    // Create-only, for the same reason {@link mirrorSourceToSilo} is.
    return await getStorage().writeAssetIfAbsent(rel, bytes);
  } catch (err) {
    logger.warn("raw", `silo mirror failed for raw source bytes "${rest}"`, err);
    return false;
  }
}

/**
 * Save the immutable BYTES of one binary arrival at
 * `raw/sources/<slug>/<rawId>.<ext>`.
 *
 * `rawId` is the SHA-256 of those bytes, which is what makes a re-drop of the
 * same PDF land on the key it already occupies instead of minting a second
 * snapshot — and what lets the extracted Markdown sit beside it at
 * `<slug>/<rawId>.md` without a separate identity to keep in sync.
 */
export async function saveRawSourceBytes(
  slug: string,
  rawId: string,
  ext: string,
  bytes: ArrayBuffer,
  options?: SaveRawSourceOptions,
): Promise<{ path: string; rel: string; created: boolean }> {
  validateSlug(slug);
  if (!RAW_ID_RE.test(rawId)) {
    throw new Error("Invalid raw id: must be a hex hash");
  }
  if (!RAW_EXT_RE.test(ext)) {
    throw new Error("Invalid raw source extension");
  }
  const rest = `${slug}/${rawId}.${ext}`;
  const created = await storeRawSourceBytes(rest, bytes, options);
  return {
    path: `${getRawDir()}/${RAW_SOURCES_DIR}/${rest}`,
    rel: rawSourceRelPath(rest),
    created,
  };
}

/** Read stored binary Source bytes back for the extract-bytes door. */
export async function readRawSourceBytes(rel: string): Promise<ArrayBuffer> {
  return getStorage().readAsset(rel);
}

/**
 * Keep a copy of what the extractor produced under `raw/parsed/`.
 *
 * FAIL-SOFT by contract: the caller has already written the extracted text to
 * the Source location that Ingest reads, so a rejected keep must not turn a
 * successful extract into a failed one.
 */
export async function saveParsedMarkdown(
  slug: string,
  rawId: string,
  content: string,
): Promise<string | null> {
  try {
    validateSlug(slug);
    if (!RAW_ID_RE.test(rawId)) return null;
    await ensureDirectories();
    const rel = rawParsedRelPath(`${slug}/${rawId}.md`);
    await getStorage().writeFile(rel, content);
    return rel;
  } catch (error) {
    logger.warn("raw", `parsed keep failed for "${slug}/${rawId}"`, error);
    return null;
  }
}

/**
 * Save a raw source document at `raw/sources/<id>.md` and return its path.
 * Throws on an invalid id. Existing bytes are never rewritten — see
 * {@link storeRawSource}.
 */
export async function saveRawSource(
  id: string,
  content: string,
  options?: SaveRawSourceOptions,
): Promise<string> {
  validateSlug(id);
  await storeRawSource(`${id}.md`, content, options);
  return `${getRawDir()}/${RAW_SOURCES_DIR}/${id}.md`;
}

/**
 * A per-source raw id is a hex digest at one of the two lengths the writers
 * actually mint — path-safe by construction, and bounded so that "hex stem"
 * alone is not enough.
 *
 * 16 is `contentHash` (FNV-1a forward+reverse, `embeddings.ts`), which
 * `ingest.ts` and Workbench Intake pass to {@link saveRawSourceFor}. 64 is
 * SHA-256 (`sourceSha256`/`bytesSha256` in `source-sha256.ts`), which
 * {@link saveRawSourceBytes}, the extract dispatcher, the chat-save door and
 * the research pipeline pass. There is no third length: an ALTERNATION of the
 * two, not a floor, is the exact statement of what a snapshot id IS, so
 * narrowing costs no real snapshot (DW-744). A floor like `{16,}` would accept
 * stems no writer produces and leave the collision half-open.
 *
 * Hoisted for the same reason as {@link RAW_EXT_RE}: every writer
 * ({@link saveRawSourceBytes}, {@link saveParsedMarkdown},
 * {@link saveRawSourceFor}), every reader ({@link readRawSourceById}) and
 * {@link isRawSnapshotName} test the SAME rule, so a bound cannot land in the
 * predicate alone and leave the listing and the silo mirror denying a snapshot
 * a writer happily minted.
 */
const RAW_ID_RE = /^(?:[a-f0-9]{16}|[a-f0-9]{64})$/;

/**
 * The extension half of a snapshot filename, as {@link saveRawSourceBytes}
 * writes it. Hoisted out of that writer so the WRITER and
 * {@link isRawSnapshotName} cannot disagree about what it accepts.
 */
const RAW_EXT_RE = /^[a-z0-9]{1,8}$/;

/**
 * Is `name` a per-page snapshot filename — `<hex>.<ext>` — as opposed to a
 * folder-import file that happens to share the directory?
 *
 * `raw/sources/<name>/` is written by TWO writers: {@link saveRawSourceFor} /
 * {@link saveRawSourceBytes} address it by page slug, and
 * {@link saveRawSourceTree} addresses it by folder-import root, so `<name>`
 * can belong to a page, to an import, or (by collision) to both. The
 * content-addressed filename is the only thing in the path that tells them
 * apart.
 *
 * This is the ONE rule, shared: the silo mirror (`silo.ts`), the delete arm
 * that unmirrors, and {@link listRawSourceSnapshots} all classify with this
 * function, and it accepts every extension {@link saveRawSourceBytes} accepts.
 * They used to be two hand-synced tests, and the divergence was not
 * theoretical — the listing's own `<hex>.md` copy is why a stored PDF appeared
 * in no listing at all and a PDF-only workspace reported zero Sources
 * (DW-569). Keeping one predicate means the mirror cannot carry an artefact
 * the listing denies exists, and a change to what a snapshot filename IS
 * lands in every consumer at once.
 *
 * The id half is BOUNDED, and that closes the collision this comment used to
 * record as accepted. `beef.md` and `2024.pdf` at the top of a folder-import
 * root are short hex stems, and by "any hex stem" they were snapshots
 * (DW-744): {@link listRawSourceSnapshots} emitted an unreadable
 * `{slug: "papers", rawId: "2024"}` row that {@link readRawSourceById} cannot
 * open; `silo.ts` mirrored somebody else's import file into the colliding
 * page's silo and deleted it with that page; and for a `.md` one, `cli.ts`'s
 * `slugsWithSnapshots` read the bogus row as proof the slug had a snapshot and
 * dropped the slug's real flat `raw/sources/papers.md` from `list --raw`.
 * {@link RAW_ID_RE} now accepts only the 16- and 64-hex lengths the writers
 * mint, so those names are ordinary import files again.
 *
 * Narrowing is safe HERE, where a length floor would not have been, because
 * the bound is not a guess about hashes in general: it is the enumeration of
 * what {@link saveRawSourceFor} and {@link saveRawSourceBytes} accept. Writer
 * and predicate read the one constant, so there is no id a writer takes and
 * this predicate denies — `raw.test.ts` pins that round trip at both lengths,
 * and pins `beef.md` / `2024.pdf` as NOT snapshots.
 *
 * A collision is still POSSIBLE — an import file genuinely named
 * `<16 hex>.md` — but it now takes a filename no one writes by hand, and it is
 * still bounded to a single FILE at depth 1, never a directory or a tree.
 */
export function isRawSnapshotName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return (
    RAW_ID_RE.test(name.slice(0, dot)) && RAW_EXT_RE.test(name.slice(dot + 1))
  );
}

export interface RawSourceSnapshot {
  slug: string;
  rawId: string;
  /** Lowercase, no dot: `md` for a Markdown snapshot, `pdf`/`png`/… for bytes. */
  ext: string;
  /** What the repo's own doors serve these bytes as; octet-stream when unknown. */
  mediaType: string;
  /** Workbench path, e.g. `raw/sources/<slug>/<rawId>.<ext>`. */
  path: string;
}

/**
 * One row per STORED artefact in the hashed trees:
 * `raw/sources/<slug>/<hex>.<ext>`, plus the legacy `raw/<slug>/<hex>.<ext>`
 * that predates the move under `raw/sources/`.
 *
 * ONE ROW IS ONE FILE, not one arrival. A binary Source and the Markdown the
 * sidecar extracted from it share a `rawId` — {@link saveRawSourceBytes} says
 * so deliberately, "without a separate identity to keep in sync" — so `ext` is
 * part of a row's identity and part of the dedup key. Keying on
 * `<slug>/<rawId>` alone reported whichever of the two the walk reached first
 * and silently dropped the other.
 *
 * DEPTH 1 ONLY, and the filename must be `<hex>.<ext>`
 * ({@link isRawSnapshotName}), because `rawId` is what a caller reads a row
 * back BY: {@link readRawSourceById} builds `<slug>/<rawId>.md` and cannot
 * address anything else. That is what keeps folder-import Sources
 * ({@link saveRawSourceTree}) out in the shape they actually take: identified
 * by relative path (FR-40), nested (`raw/sources/papers/energy/note.md`), and
 * named the way people name files rather than as a hash. A deeper walk would
 * mint rows pointing at paths no reader can open, which is DW-568 in a new
 * place.
 *
 * The filename test carries the id LENGTH bound too, and that is what keeps the
 * ordinary folder-import file out: `raw/sources/papers/2024.pdf` sits at depth
 * 1 with an all-hex stem, and while any hex stem was an id it was emitted as
 * `{slug: "papers", rawId: "2024", ext: "pdf"}` — precisely the unopenable row
 * this walk exists to avoid, since `readRawSourceById("papers", "2024")`
 * addresses nothing (DW-744). `2024` is not a length any writer mints, so it is
 * not an id, and the row is gone. Every row here now names ONE real file at the
 * path it reports AND is readable by the `<slug>/<rawId>` its own fields spell.
 *
 * `silo.ts`'s `mirrorHashedTree` walks this same tree the same way.
 *
 * Under the LEGACY root the {@link RAW_STRUCTURAL_DIRS} names are skipped:
 * `sources`, `assets`, `parsed`, `uploads` and `originals` are roots there, not
 * page slugs, and reading `sources` as a slug is exactly what turned every flat
 * `raw/sources/<hex>.md` into a bogus snapshot of a page called `sources`
 * (DW-568). The skip is legacy-root-only — one level down, inside
 * `raw/sources/`, a directory named `assets` really IS a page slug and its
 * `raw/sources/assets/<hex>.md` really is that page's snapshot tree.
 *
 * {@link listRawSources} stays non-recursive — that is the browse contract,
 * and the Workbench Sources surface built on it is unchanged: snapshots never
 * appear as extra rows THERE. Every caller that needs the hashed arrivals too
 * unions this listing in itself: Chat/Search retrieval (`wiki-retrieve.ts`),
 * the CLI's `list --raw` / `status`, and the `incomplete-coverage` lint check
 * (DW-437). A caller that unions must also decide what to do about the slug
 * `ingest()` writes BOTH ways — see `listRawSourceRows` in `src/cli.ts` — and,
 * since this listing carries binaries, whether it can READ a row at all: each
 * call site says which it does and why.
 */
export async function listRawSourceSnapshots(): Promise<RawSourceSnapshot[]> {
  const roots: Array<{
    prefix: string;
    pathPrefix: string;
    /** Are this root's children ambiguous between page slug and structure? */
    skipStructural: boolean;
  }> = [
    {
      prefix: rawSourceRelPath(""),
      pathPrefix: `raw/${RAW_SOURCES_DIR}`,
      skipStructural: false,
    },
    { prefix: rawRelPath(""), pathPrefix: "raw", skipStructural: true },
  ];
  const snapshots: RawSourceSnapshot[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const entries = await listPrefix(root.prefix);
    for (const entry of entries) {
      if (!entry.isDirectory || entry.name.startsWith(".")) continue;
      if (root.skipStructural && RAW_STRUCTURAL_DIRS.has(entry.name)) continue;
      try {
        validateSlug(entry.name);
      } catch {
        continue;
      }
      const children = await listPrefix(`${root.prefix}/${entry.name}`);
      for (const child of children) {
        if (child.isDirectory || !isRawSnapshotName(child.name)) continue;
        const dot = child.name.lastIndexOf(".");
        const rawId = child.name.slice(0, dot);
        const ext = child.name.slice(dot + 1);
        // The extension is part of the key: a PDF and its extracted Markdown
        // are two stored artefacts sharing one `rawId`.
        const key = `${entry.name}/${rawId}.${ext}`;
        if (seen.has(key)) continue;
        seen.add(key);
        snapshots.push({
          slug: entry.name,
          rawId,
          ext,
          mediaType: intakeContentType(child.name),
          path: `${root.pathPrefix}/${entry.name}/${child.name}`,
        });
      }
    }
  }
  return snapshots;
}

/**
 * Save the raw snapshot of ONE source of a page at
 * `raw/sources/<slug>/<rawId>.md`.
 *
 * Unlike {@link saveRawSource} (one blob per slug), this keeps every source's
 * raw separately so a page built from multiple sources can show them all — and
 * because `rawId` is a hash of the arriving bytes, it is also the writer
 * Workbench Intake uses: two different arrivals cannot collide onto one key, so
 * immutability costs nothing. `rawId` must be a hex hash; `slug` is validated
 * as a path segment.
 */
export async function saveRawSourceFor(
  slug: string,
  rawId: string,
  content: string,
  options?: SaveRawSourceOptions,
): Promise<string> {
  validateSlug(slug);
  if (!RAW_ID_RE.test(rawId)) {
    throw new Error("Invalid raw id: must be a hex hash");
  }
  await storeRawSource(`${slug}/${rawId}.md`, content, options);
  return `${getRawDir()}/${RAW_SOURCES_DIR}/${slug}/${rawId}.md`;
}

/**
 * Save a folder-import Source at `raw/sources/<relative>`, where `relative`
 * is already a sanitized tree path with an extension (`papers/energy/note.md`).
 *
 * Same helper as {@link saveRawSourceFor}: no overwrite, optional `{ owner }`
 * silo mirror, `dataVersion` bump. Folder identity is the relative path
 * (FR-40); a re-import of the same tree lands on an occupied key and must
 * not rewrite.
 */
export async function saveRawSourceTree(
  relativePath: string,
  content: string,
  options?: SaveRawSourceOptions,
): Promise<{ path: string; created: boolean }> {
  const segments = relativePath.split("/");
  if (
    relativePath.length === 0 ||
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    relativePath.startsWith("/") ||
    segments.length < 2 ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Invalid raw tree path");
  }
  const leaf = segments[segments.length - 1];
  const dot = leaf.lastIndexOf(".");
  if (dot <= 0) {
    throw new Error("Invalid raw tree path");
  }
  for (const dir of segments.slice(0, -1)) {
    validateSlug(dir);
  }
  validateSlug(leaf.slice(0, dot));
  const created = await storeRawSource(relativePath, content, options);
  return {
    path: `${getRawDir()}/${RAW_SOURCES_DIR}/${relativePath}`,
    created,
  };
}

/** Read the stored bytes at a folder-import path, or null if missing. */
export async function readRawSourceTree(
  relativePath: string,
): Promise<string | null> {
  try {
    return await getStorage().readFile(rawSourceRelPath(relativePath));
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

/**
 * Read one per-source raw snapshot written by {@link saveRawSourceFor}.
 * Both `slug` and `rawId` are validated before any filesystem access (the slug
 * can't contain path separators; the id is a hex hash), so traversal is
 * impossible. Throws "not found" when the snapshot doesn't exist.
 *
 * The legacy flat `raw/<slug>/<rawId>.md` is tried second, so snapshots written
 * before Sources moved under `raw/sources/` still read back.
 */
export async function readRawSourceById(
  slug: string,
  rawId: string,
): Promise<RawSourceWithContent> {
  validateSlug(slug);
  if (!RAW_ID_RE.test(rawId)) {
    throw new Error(`raw source not found: ${slug}/${rawId}`);
  }
  const nested = `${slug}/${rawId}.md`;
  const found = await readFirst([rawSourceRelPath(nested), rawRelPath(nested)]);
  if (!found) {
    throw new Error(`raw source not found: ${slug}/${rawId}`);
  }
  let size = found.content.length;
  let modified = new Date().toISOString();
  try {
    const stat = await getStorage().stat(found.rel);
    size = stat.size;
    modified = stat.lastModified.toISOString();
  } catch {
    // stat is best-effort — content already read successfully.
  }
  return { slug, filename: `${rawId}.md`, size, modified, content: found.content };
}

/** First readable key in `candidates`, or null when none of them exist. */
async function readFirst(
  candidates: readonly string[],
): Promise<{ rel: string; content: string } | null> {
  for (const rel of candidates) {
    try {
      return { rel, content: await getStorage().readFile(rel) };
    } catch {
      // Missing or unreadable — try the next location.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Raw source browsing (read-only)
// ---------------------------------------------------------------------------

/**
 * A lightweight descriptor for a file sitting in `raw/`. `slug` is the
 * filename with the final extension stripped, matching the identity that
 * {@link saveRawSource} uses when it writes a file.
 */
export interface RawSource {
  /** Filename without the final extension. Usable as a URL path segment. */
  slug: string;
  /** Original filename including extension, e.g. `llm-wiki-pattern.md`. */
  filename: string;
  /** Size in bytes. */
  size: number;
  /** Last-modified time as an ISO 8601 string. */
  modified: string;
}

/** A raw source plus its full content. Returned by {@link readRawSource}. */
export interface RawSourceWithContent extends RawSource {
  content: string;
}

/**
 * Strip the final extension from a filename. Leading dots (dotfiles) are
 * preserved verbatim — we never treat `.hidden` as having an extension of
 * `hidden`. Returns the input unchanged when there is no extension.
 */
function stripExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  // Guard against dotfiles (`.env`) and extension-less names (`README`).
  if (lastDot <= 0) return filename;
  return filename.slice(0, lastDot);
}

/** List one prefix's files, answering `[]` for a prefix that does not exist. */
async function listPrefix(prefix: string): Promise<import("./storage").FileEntry[]> {
  try {
    return await getStorage().listFiles(prefix);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * List every Source file, newest first.
 *
 * `raw/sources/` is the write location; the legacy flat `raw/` root is listed
 * after it so a workspace written before the move still browses. A filename
 * present in both is reported once, from `raw/sources/` — that is the one the
 * readers below resolve to.
 *
 * - Non-recursive in each root: per-source snapshot subdirectories
 *   (`raw/sources/<slug>/<hash>.md`) are {@link readRawSourceById}'s, not this
 *   listing's.
 * - Skips dotfiles and subdirectories.
 * - Returns `[]` (rather than throwing) when neither root exists, so a fresh
 *   checkout with no ingested sources renders cleanly.
 */
export async function listRawSources(): Promise<RawSource[]> {
  const storage = getStorage();
  const roots: Array<{ prefix: string; entries: import("./storage").FileEntry[] }> = [
    { prefix: rawSourceRelPath(""), entries: await listPrefix(rawSourceRelPath("")) },
    { prefix: rawRelPath(""), entries: await listPrefix(rawRelPath("")) },
  ];

  const sources: RawSource[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const entry of root.entries) {
      if (entry.isDirectory) continue;
      if (entry.name.startsWith(".")) continue;
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);

      const stat = await storage.stat(`${root.prefix}/${entry.name}`);
      sources.push({
        slug: stripExtension(entry.name),
        filename: entry.name,
        size: stat.size,
        modified: stat.lastModified.toISOString(),
      });
    }
  }

  // Newest first — most-recently-ingested at the top of the browser.
  sources.sort((a, b) => (a.modified < b.modified ? 1 : -1));
  return sources;
}

/**
 * Read a single raw source by slug (the filename without its final
 * extension). Returns the file's content along with the same metadata
 * {@link listRawSources} produces.
 *
 * Safety model: we do NOT build a path from the slug directly. Instead we
 * list the Source roots, match the slug against the stripped-extension form of
 * each real entry, and only then `readFile` the matched entry. A path-traversal
 * slug like `../../etc/passwd` can never match a listed file, so it falls
 * through to the "not found" throw. The `validateSlug` guard provides a second
 * layer of defence before we ever touch the filesystem.
 *
 * `raw/sources/` is read first and the legacy flat `raw/` second, matching what
 * {@link listRawSources} reports.
 *
 * @throws {Error} when the slug is invalid or no matching file exists.
 */
export async function readRawSource(
  slug: string,
): Promise<RawSourceWithContent> {
  validateSlug(slug);

  const sources = await listRawSources();
  const match = sources.find((s) => s.slug === slug);
  if (!match) {
    throw new Error(`raw source not found: ${slug}`);
  }

  const found = await readFirst([
    rawSourceRelPath(match.filename),
    rawRelPath(match.filename),
  ]);
  if (!found) {
    throw new Error(`raw source not found: ${slug}`);
  }

  return { ...match, content: found.content };
}

/**
 * Remove stored Source bytes at `raw/sources/<rest>` and the owner's silo copy.
 *
 * Used by cascade delete to drop ONE source's hashed key
 * (`raw/sources/<slug>/<id>.md`) while the page it belongs to lives on.
 * {@link removeSiloForPage} covers the other case: when the whole page goes it
 * walks the per-page hashed silo directory and removes only the snapshot files
 * that belong to that page, leaving foreign files and the directory itself in
 * place when the directory is shared with a folder import (DW-611). It runs on
 * every hard delete, from the lifecycle delete path's fail-soft cleanup batch
 * (DW-609) — a merge-absorb delete passes `preserveRawSources` to skip its
 * raw-Source arms. The two are not redundant — this one is per-source and also
 * deletes the FLAT bytes; that one is per-page and silo-only.
 */
export async function deleteRawSourceBytes(
  rest: string,
  owner?: string,
): Promise<void> {
  const storage = getStorage();
  try {
    await storage.deleteFile(rawSourceRelPath(rest));
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  if (owner) {
    try {
      await storage.deleteFile(tenantRawSourceRelPath(tenantForOwner(owner), rest));
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }
  await bumpDataVersion();
}
