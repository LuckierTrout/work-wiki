/**
 * EVERY door that can reach a kernel writer answers the refusal (DW-187, DW-190).
 *
 * The behavioural suites pin the doors that exist TODAY. What none of them can
 * see is the door added TOMORROW: a new `route.ts` that calls `ingest()` or
 * `deleteWikiPage()` and forgets both treatments ships a 500 whose body reads
 * "Pages cannot be written while this deployment is read-only." — a refusal
 * reported as a server fault, and on the ingest-shaped doors a pile of orphaned
 * raw files and `failed` job records behind it. Every existing test stays green,
 * because none of them knows the new file is there.
 *
 * So this scans instead of asserting a list. It reads the route modules off
 * disk, works out which of them can reach one of the gated kernel writers, and
 * requires each to carry ONE of the two sanctioned treatments:
 *
 *   - an early `isReadOnly()` gate — for doors where the kernel refusal arrives
 *     too late to shape the response (irreversible side effects already
 *     committed, or expensive/failable work whose own error would mask it), or
 *   - an `isReadOnlyError(...)` branch in the catch — for doors that reach the
 *     writer directly, where the kernel's own refusal is both timely and enough.
 *
 * Source-scan, in the convention of `article-actions-gate.test.ts`: the `node`
 * project has no DOM and cannot execute a route module, and executing them would
 * not answer the question anyway — "is a treatment PRESENT" is a property of the
 * file, and a route only reachable through a queue consumer has no request to
 * make of it here.
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { walkFiles } from "./source-scan";

const API = path.resolve(__dirname, "../../app/api");
const LIB = path.resolve(__dirname, "..");

/**
 * The writers this file scans for. Named, not inferred — and NOT every gated
 * function in `src/lib`.
 *
 * What the roll holds: the DW-187 kernel writers (page bytes, page metadata,
 * Wiki artifact bytes), the wiki-lifecycle and workspace-profile writers gated
 * later (DW-266, DW-314, DW-315), `lifecycle.ts`'s two internal-step writers,
 * and the DW-385 store writers for names terms, research projects (including
 * `research-runtime.ts`'s `retireResearchProject`, which gates at its own entry
 * rather than leaning on the delete it ends with) and the email-ingest config
 * (DW-640/DW-642). Everything past the first group is not a
 * kernel writer in the DW-188 sense — each carries sentences of its own rather
 * than the four page/artifact ones — but they have the same
 * exposure: exported functions that write bytes, so a route reaching one
 * untreated ships the same 500-shaped refusal this file exists to prevent.
 *
 * OUT OF SCOPE, deliberately, and stated so the list is not read as a census of
 * `assertWritable`:
 *
 *   - The REMAINING DW-385 store writers — `todos.ts`, `review-queue.ts`,
 *     `graph-insight-dismissals.ts`, `source-meeting.ts`, `maintenance.ts` and
 *     `workspace-profile-backfill.ts`. They carry the refusal too, and their
 *     doors are pinned BY NAME in `read-only-copy-parity.test.ts` rather than
 *     derived here. Reaching them is a further widening with its own question
 *     behind it, not a gap this pass left open by accident.
 *   - The research `*OrRefusal` wrappers and `applyResearchProjectMutation`,
 *     which return the `RESEARCH_WRITE_REFUSED` sentinel instead of calling
 *     `assertWritable` — they are not writers by this file's definition, and the
 *     third case below would fail on them for the right reason.
 *   - `lifecycle.ts`'s THIRD `*WhileLocked` export,
 *     `writeWikiPageWithSideEffectsWhileLocked`. It is registered in
 *     {@link WRITER_EXPORTS} so a route importing it is scanned, but it is not
 *     on this roll: its gate lives one frame down, in the private
 *     `writeWikiPageWithSideEffectsInternal`, so the third case's head probe
 *     would fail on it for the wrong reason. Two of the family are writers by
 *     this file's definition; this one is reaching-only.
 *   - `sweepOrphanWikiDirectories`, whose only caller outside `deleteWiki` is
 *     `maintenance.ts`'s fail-soft dynamic import, so naming it would mean
 *     adding `@/lib/maintenance` to {@link WRITER_EXPORTS} — a different
 *     widening, with a different question behind it.
 *   - `wikis.ts`'s `canonicalizeWikiPurpose`, gated in its own right but reached
 *     only through `workspace-profile-backfill.ts` and from there the same
 *     fail-soft dynamic import in `maintenance.ts` — the identical situation to
 *     `sweepOrphanWikiDirectories`, and out for the identical reason.
 *
 * This list is the file's ONE hand-written roll of writers, and both cases
 * below read FROM it: the staleness case re-derives which of these writers each
 * {@link WRITER_MODULES} entry reaches (never the whole of
 * {@link WRITER_EXPORTS}, which also carries writer-REACHING symbols such as
 * `ingest` and `fixLintIssue` that are not writers themselves), and the
 * `assertWritable` case iterates it and works out each writer's defining module
 * rather than restating a second partial copy.
 */
const KERNEL_WRITERS = [
  "writeWikiPageWithSideEffects",
  "deleteWikiPage",
  "patchMetadata",
  "writeWikiArtifact",
  "createWiki",
  "applyScenarioTemplate",
  "renameWiki",
  "deleteWiki",
  "setCurrentWiki",
  "saveWorkspaceProfile",
  // The two putters BELOW `saveWorkspaceProfile`, each gated in its own right.
  // No route imports either today — both are reached under a held
  // `WikiLockHeld` token, from `wikis.ts`'s seeder and the DW-137 backfill — so
  // the scan's value here is PROSPECTIVE: a future route that takes the lock
  // itself and calls one directly is exactly the door that would otherwise walk
  // past this file untreated.
  "putWorkspaceProfile",
  "copyWorkspaceProfileIfAbsent",
  // DW-640: `lifecycle.ts`'s two internal-step writers, each gated in its own
  // right. Like the workspace putters above, no route imports either today —
  // the only callers are `lint-fix.ts`'s `fixStaleIndex` and, under
  // `mergePages`, `merge.ts`'s private `mergePagesWhileSourceLocked` — so the
  // value here is PROSPECTIVE and the same: a future route that takes the
  // lifecycle lock itself and calls one directly is exactly the door that would
  // otherwise walk past this file untreated.
  "pruneStaleIndexEntry",
  "deleteWikiPageWhileLocked",
  // DW-642: the DW-385 store writers whose doors are real routes TODAY. Each is
  // an `export async function` carrying its own `assertWritable` sentence, so a
  // route reaching one untreated ships the same 500-shaped refusal.
  "createNamesTerm",
  "updateNamesTerm",
  "deleteNamesTerm",
  "repairResearchRegistry",
  "createResearchProject",
  "editResearchProject",
  "deleteResearchProject",
  "saveEmailIngestConfig",
  // Declared in `research-runtime.ts`, not `research-projects.ts`, and a writer
  // in its own right rather than merely writer-reaching: it TOMBSTONES through
  // the CAS mutator before it ever reaches `deleteResearchProject`, so it gates
  // at its own entry. Registering it as reaching-only would leave that gate
  // deletable with all three cases green — the one thing the third case exists
  // to stop.
  "retireResearchProject",
] as const;

/**
 * Library exports that reach a kernel writer, keyed by the module a route
 * imports them from.
 *
 * Per-SYMBOL rather than per-module, because the coarse form would be useless in
 * both directions: `@/lib/ingest` also exports `extractSummary` and `readLedger`
 * (pure reads, imported by routes that write nothing), and `@/lib/wiki`
 * re-exports the writers alongside every read helper in the codebase. A
 * module-level rule would demand a gate on read-only routes and let a writing
 * one through.
 *
 * `it("names every writer-reaching export")` below re-derives this map from
 * `src/lib` and fails if a new one appears, so the list cannot quietly go stale.
 */
const WRITER_EXPORTS: Record<string, readonly string[]> = {
  "@/lib/lifecycle": [
    "writeWikiPageWithSideEffects",
    "deleteWikiPage",
    // DW-640's two internal-step writers, listed here because this is the
    // module that DECLARES them — which is also how the third case finds their
    // gate.
    "pruneStaleIndexEntry",
    "deleteWikiPageWhileLocked",
    // Registry-only, and deliberately NOT on {@link KERNEL_WRITERS}: the third
    // `*WhileLocked` export gates one frame down, in the private
    // `writeWikiPageWithSideEffectsInternal`, so the third case's head probe
    // would fail on it for the wrong reason. It is here because
    // `writerImports` matches symbols on a `\b` boundary — the
    // `writeWikiPageWithSideEffects` entry above does NOT match an import of
    // this longer name, so without its own row a future route importing it is
    // skipped entirely.
    "writeWikiPageWithSideEffectsWhileLocked",
  ],
  // `src/lib/wiki.ts` re-exports only these two of `lifecycle.ts`'s writers, so
  // the putters above deliberately have no entry here.
  "@/lib/wiki": ["writeWikiPageWithSideEffects", "deleteWikiPage"],
  "@/lib/patch-metadata": ["patchMetadata"],
  "@/lib/wikis": [
    "writeWikiArtifact",
    // DW-266/DW-314's lifecycle writers (DW-315). Every route importing one of
    // these today already satisfies the rule above — as it happens each carries
    // both treatments, though ONE is all the scan asks for. What the widening
    // buys is the NEXT route: one reaching `createWiki` or `deleteWiki` with
    // neither. The DW-642 store-writer keys at the bottom of this map were added
    // for exactly the same reason, and found every door they reach already
    // treated too.
    "createWiki",
    "applyScenarioTemplate",
    "renameWiki",
    "deleteWiki",
    "setCurrentWiki",
  ],
  // `saveWorkspaceProfile` is the only one a route imports today; the two
  // putters are here for the prospective reason {@link KERNEL_WRITERS} gives.
  "@/lib/workspace-profile": [
    "saveWorkspaceProfile",
    "putWorkspaceProfile",
    "copyWorkspaceProfileIfAbsent",
  ],
  "@/lib/ingest": [
    "ingest",
    "ingestUrl",
    "ingestImage",
    "ingestPdf",
    "ingestDocument",
    "ingestXMention",
    "ingestYouTube",
    "reingest",
    "reconcilePage",
  ],
  "@/lib/ingest-async": ["enqueueOrInline"],
  "@/lib/agents": ["updateAgent", "seedAgent", "addAgentLearningPage"],
  "@/lib/lint-fix": [
    "fixLintIssue",
    "fixOrphanPage",
    "fixEmptyPage",
    // Writer-reaching since DW-640 put `pruneStaleIndexEntry` on the roll: this
    // is its one production caller.
    "fixStaleIndex",
    "fixMissingCrossRef",
    "fixContradiction",
    "fixMissingConceptPage",
    "fixBrokenLink",
    "fixDanglingWikilink",
    "fixRenamedSlug",
    "fixStalePage",
    "fixUnmigratedPage",
    "fixSupersededDangling",
  ],
  "@/lib/merge": ["mergePages"],
  "@/lib/memory-proposals": ["applyMemoryChangeProposal"],
  "@/lib/query": ["saveAnswerToWiki"],
  "@/lib/tenant-admin": ["deleteTenant"],
  "@/lib/search": ["updateRelatedPages"],
  "@/lib/document-sources": ["preserveDocumentSources"],
  "@/lib/review-queue": ["createPageFromReview"],
  "@/lib/workbench-lint-fix": ["fixWorkbenchLintIssue"],
  // Writer-REACHING: the Source cascade calls `deleteWikiPage` for each page it
  // retires and `writeWikiPageWithSideEffects` for the survivor it rewrites.
  // `/api/workbench/source` imports it, so this key is what puts a LIVE door in
  // front of the scan — until it was added, both of that route's treatments
  // could have been deleted with all three cases green.
  "@/lib/source-cascade": ["cascadeDeleteSource"],
  // DW-642's store-writer definers. Per-SYMBOL matters most here: each of these
  // modules also exports the READ side that unrelated routes import —
  // `listNamesTerms`/`expandQueryWithNamesTerms` (`/api/query/stream`,
  // `/api/sources/search`), `getResearchProject`/`listResearchProjects`, and
  // `loadEmailIngestConfig` (`/api/settings`). A module-level rule would start
  // demanding a read-only treatment on routes that write nothing. The ONE
  // deliberate module-level exception is `writerImports`' dynamic-`import()`
  // branch, which cannot see what a call site destructures: it is why
  // `/api/research/[id]/run` counts as reached even though its only match is the
  // dynamic `import("@/lib/research-projects")` that pulls the READ
  // `getResearchProject`. Over-reaching there is the safe direction — the cost
  // is a treatment on a route that may not need one, not a door left unasked.
  "@/lib/names-terms": ["createNamesTerm", "updateNamesTerm", "deleteNamesTerm"],
  "@/lib/research-projects": [
    "repairResearchRegistry",
    "createResearchProject",
    "editResearchProject",
    "deleteResearchProject",
  ],
  "@/lib/email-ingest": ["saveEmailIngestConfig"],
  // Mixed: `retireResearchProject` is on {@link KERNEL_WRITERS} and this is the
  // module that DECLARES it, so the third case reads its gate from here.
  // `reconcileResearchProjects` is writer-REACHING only — the shape of
  // `@/lib/ingest` and `@/lib/lint-fix` above — calling `deleteResearchProject`
  // without gating itself, so the third case never looks for an
  // `assertWritable` under its name.
  "@/lib/research-runtime": ["retireResearchProject", "reconcileResearchProjects"],
};

/**
 * Every `src/lib/*.ts` module whose own code calls a writer on
 * {@link KERNEL_WRITERS} — the corpus the staleness case re-derives
 * {@link WRITER_EXPORTS} from, so that claim has to stay true as the roll grows.
 *
 * NOT here, deliberately, and these are the only absences:
 *
 *   - `lifecycle.ts` and `patch-metadata.ts`. They DEFINE the four original
 *     page/artifact writers, so scanning them would flag most of
 *     `lifecycle.ts`'s exports as writer-reaching and widen the route scan far
 *     past what any of these entries is asking about. The third case reaches
 *     those modules by a different route — through {@link WRITER_EXPORTS} — and
 *     is what guards them.
 *   - `ingest-bookkeeping.ts` (calls `writeWikiPageWithSideEffects`) and
 *     `workspace-profile-backfill.ts` (calls `copyWorkspaceProfileIfAbsent`).
 *     Both are real writer-reaching modules, but NO ROUTE imports either —
 *     `ingest.ts` and `maintenance.ts` respectively are their only importers —
 *     so a {@link WRITER_EXPORTS} key for either could never match an import
 *     and listing them here would demand one that buys nothing. They come in
 *     the day a route imports them.
 */
const WRITER_MODULES = [
  "agents",
  "document-sources",
  "ingest",
  "lint-fix",
  "memory-proposals",
  "merge",
  "query",
  "review-queue",
  "search",
  "source-cascade",
  "tenant-admin",
  // DW-315: the two modules that DEFINE the lifecycle writers. They are scanned
  // for the same reason as the rest — a new export in either that reaches one
  // of them fails the staleness case by name instead of quietly widening the
  // set of routes the first case skips.
  "wikis",
  "workspace-profile",
  // DW-642: the three store-writer definers, plus the two modules that REACH
  // their writers.
  "names-terms",
  "research-projects",
  "email-ingest",
  "research-runtime",
  // Scanned with NO {@link WRITER_EXPORTS} key, and that is the point rather
  // than an omission: today `research-completion.ts` reaches
  // `deleteResearchProject` only through the private
  // `deleteRetiredProjectIfLeaseGone`, which the case's export-body read cannot
  // see (its documented KNOWN LIMIT), and no route imports the module. Listing
  // it says "if an EXPORT here ever calls the writer directly, say so by name".
  "research-completion",
] as const;

/** Which writer-reaching symbols this route module imports, if any. */
function writerImports(source: string): string[] {
  const found: string[] = [];
  for (const [module, symbols] of Object.entries(WRITER_EXPORTS)) {
    const escaped = module.replace(/[/@\-]/g, (c) => `\\${c}`);
    const importRe = new RegExp(
      `import\\s*(?:type\\s*)?\\{([^}]*)\\}\\s*from\\s*"${escaped}"`,
      "gs",
    );
    for (const match of source.matchAll(importRe)) {
      for (const symbol of symbols) {
        if (new RegExp(`\\b${symbol}\\b`).test(match[1])) {
          found.push(`${module}:${symbol}`);
        }
      }
    }
    // A dynamic `await import("@/lib/x")` destructures at the call site, so the
    // named-import scan above cannot see it. Treat the whole module as reached.
    if (new RegExp(`import\\(\\s*"${escaped}"\\s*\\)`).test(source)) {
      found.push(`${module}:(dynamic import)`);
    }
  }
  return [...new Set(found)];
}

const rel = (file: string) => path.relative(path.resolve(__dirname, "../../.."), file);

describe("read-only coverage of every kernel-writer door", () => {
  it("every API route that can reach a kernel writer answers the refusal", async () => {
    const files = await walkFiles(API, { include: /^route\.ts$/ });

    // MEMBER PINS PLUS A COUNT FLOOR — the `english-only.test.ts` idiom
    // `AGENTS.md` prescribes for every caller of `walkFiles`.
    //
    // This case asserts `untreated` is EMPTY, which a SMALLER corpus satisfies
    // by construction. Since DW-470 the scan inherits `SKIPPED_DIRS`, so one
    // name appended there — or one `skipDirs` entry added here — deletes a
    // whole subtree from the walk and the assertion below stays green while
    // covering less. One real `route.ts` per major `src/app/api` subtree makes
    // that cut fail BY NAME instead.
    const scanned = files.map(rel);
    for (const pin of [
      "src/app/api/wiki/route.ts",
      "src/app/api/wikis/route.ts",
      "src/app/api/agents/route.ts",
      "src/app/api/chat/conversations/route.ts",
      "src/app/api/workbench/activity/route.ts",
      "src/app/api/query/route.ts",
      "src/app/api/ingest/route.ts",
      "src/app/api/v1/projects/route.ts",
      // DW-640/DW-642 brought three more subtrees into `reached`. Unpinned,
      // dropping `names-terms` or `email` from the walk would leave the count
      // above the floor below and this case green while covering less — the
      // exact failure the pin idiom exists to catch.
      "src/app/api/names-terms/route.ts",
      "src/app/api/email/settings/route.ts",
      "src/app/api/research/route.ts",
    ]) {
      expect(scanned, `${pin} is a real route the scan must reach`).toContain(pin);
    }
    // A floor, not the exact count (149 at the time of writing): routes are
    // added and removed continuously, and a number that has to be edited on
    // every unrelated PR gets edited without being thought about. The headroom
    // is wide enough to survive normal churn and far too narrow to survive a
    // lost subtree.
    expect(files.length).toBeGreaterThan(100);

    const untreated: string[] = [];
    const reached: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      const imports = writerImports(source);
      if (imports.length === 0) continue;
      reached.push(rel(file));
      const gated = /\bisReadOnly\s*\(\s*\)/.test(source);
      const classified = /\bisReadOnlyError\s*\(/.test(source);
      if (!gated && !classified) {
        untreated.push(`${rel(file)} — reaches ${imports.join(", ")}`);
      }
    }

    // Named in the failure so the fix is obvious: add an early `isReadOnly()`
    // gate if irreversible or expensive work precedes the write, otherwise an
    // `isReadOnlyError(err)` branch in the catch.
    expect(untreated, "routes reaching a kernel writer with neither treatment").toEqual([]);
    // The scan is only evidence if it actually matched something — a broken
    // regex would produce an empty `untreated` and a green, meaningless test.
    //
    // A floor, not the exact count, for the reason above (39 writer-reaching
    // routes since DW-640/DW-642 widened the roll, up from 31). It is set so
    // that losing the LARGEST single `src/app/api` subtree — `ingest`, which
    // still contributes 7 — drops the count below it, while leaving room for a
    // handful of routes to be retired without anyone having to edit this line to
    // make an unrelated PR green. RAISE IT WITH THE ROLL: left at 25 the whole
    // widening could be reverted with this case staying green.
    expect(reached.length).toBeGreaterThanOrEqual(33);
  });

  it("names every writer-reaching export, so the map cannot go stale", async () => {
    // The map above is hand-written; this re-derives it. A new exported function
    // in one of the writer modules that calls a kernel writer — the realistic way
    // a door escapes the scan — fails HERE with its name, rather than silently
    // widening the set of routes the first case skips.
    //
    // KNOWN LIMIT, stated so it is not mistaken for coverage: this reads each
    // export's OWN body. An export that reaches a writer only through a private
    // helper (as `preserveDocumentSources` does, via `appendSourceFigures`) is
    // invisible here and has to be added to the map by hand. The case above is
    // the one that actually guards the outcome — it is keyed on what a ROUTE
    // imports, and a new route is how a door is really added.
    const missing: string[] = [];
    for (const libName of WRITER_MODULES) {
      const source = await readFile(path.join(LIB, `${libName}.ts`), "utf8");
      const lines = source.split("\n");
      // Boundaries are EVERY top-level function, exported or not; spans are only
      // the exported ones. Ending a span at the next EXPORT instead would swallow
      // the private helpers that sit between two exports and credit their bodies
      // to whichever export happened to precede them — which is how
      // `ingest:sameHumanOwner` and `document-sources:listDocumentSources`, both
      // pure, first read as writer-reaching.
      const bounds: number[] = [];
      const spans: { name: string; start: number; end: number }[] = [];
      lines.forEach((line, index) => {
        if (/^(?:export )?(?:async )?function \w+/.test(line)) bounds.push(index);
        const match = line.match(/^export (?:async )?function (\w+)/);
        if (match) spans.push({ name: match[1], start: index, end: lines.length });
      });
      for (const span of spans) {
        const next = bounds.find((line) => line > span.start);
        span.end = next ?? lines.length;
      }
      const declared = new Set(WRITER_EXPORTS[`@/lib/${libName}`] ?? []);
      for (const span of spans) {
        const body = lines.slice(span.start, span.end).join("\n");
        const callsWriter = KERNEL_WRITERS.some((writer) =>
          new RegExp(`\\b${writer}\\s*\\(`).test(body),
        );
        if (callsWriter && !declared.has(span.name)) {
          missing.push(`@/lib/${libName}:${span.name}`);
        }
      }
    }
    expect(missing, "writer-reaching exports absent from WRITER_EXPORTS").toEqual([]);
  });

  it("every kernel writer still calls assertWritable", async () => {
    // The floor the whole scheme rests on. Every "the catch classifies it"
    // treatment above is worthless if the writer stopped throwing, and that
    // deletion would otherwise show up only as a handful of behavioural tests
    // going red with no explanation of what they shared.
    //
    // Iterates KERNEL_WRITERS rather than a second hand-written module→writers
    // list (DW-315): the earlier shape let the two drift, so a writer added to
    // the scan above could go unchecked here with nothing to say so.
    for (const writer of KERNEL_WRITERS) {
      // Which module DEFINES it, derived from the same map the scan uses.
      // `@/lib/wiki` re-exports two of them (`export { … } from "./lifecycle"`)
      // and so declares neither — reading the re-export would find no gate and
      // fail for the wrong reason.
      const defining: string[] = [];
      for (const [module, symbols] of Object.entries(WRITER_EXPORTS)) {
        if (!symbols.includes(writer)) continue;
        const libName = module.slice("@/lib/".length);
        const source = await readFile(path.join(LIB, `${libName}.ts`), "utf8");
        if (source.includes(`export async function ${writer}(`)) defining.push(libName);
      }
      // Exactly one. ZERO has three causes, and the message names all three
      // because the fix differs: the writer was renamed or dropped from
      // WRITER_EXPORTS (and the scan above has been skipping its routes ever
      // since), or it is still there but no longer spelled
      // `export async function <name>(` — respelled as
      // `export const <name> = async (…) =>`, made synchronous, or given a
      // generic parameter list — in which case this probe, not the writer, is
      // what needs updating. TWO means the definition was copied rather than
      // moved.
      expect(
        defining,
        `${writer}: expected exactly one module declaring \`export async function ${writer}(\` — zero means it was renamed, dropped from WRITER_EXPORTS, or respelled (const/generic/non-async)`,
      ).toHaveLength(1);

      const definedIn = defining[0];
      const source = await readFile(path.join(LIB, `${definedIn}.ts`), "utf8");
      const start = source.indexOf(`export async function ${writer}(`);
      // Guarded before the slice: `slice(-1, 1199)` would hand `toMatch` the
      // file's LAST CHARACTER and fail with something unreadable instead of
      // saying the declaration was not found.
      expect(start, `${definedIn}.ts: ${writer} declaration`).toBeGreaterThan(-1);
      // The gate must be in the writer's OWN opening lines, not merely
      // somewhere in the file — a call moved below the storage work would
      // still match a file-wide search.
      const head = source.slice(start, start + 1200);
      expect(head, `${definedIn}.ts: ${writer} opens with assertWritable`).toMatch(
        /assertWritable\(READ_ONLY_REFUSAL\.\w+\)/,
      );
    }
  });
});
