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
 * disk, works out which of them can reach one of the four kernel writers, and
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
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const API = path.resolve(__dirname, "../../app/api");
const LIB = path.resolve(__dirname, "..");

/** The four functions that carry the refusal. Named, not inferred. */
const KERNEL_WRITERS = [
  "writeWikiPageWithSideEffects",
  "deleteWikiPage",
  "patchMetadata",
  "writeWikiArtifact",
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
  "@/lib/lifecycle": ["writeWikiPageWithSideEffects", "deleteWikiPage"],
  "@/lib/wiki": ["writeWikiPageWithSideEffects", "deleteWikiPage"],
  "@/lib/patch-metadata": ["patchMetadata"],
  "@/lib/wikis": ["writeWikiArtifact"],
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
    "fixMissingCrossRef",
    "fixContradiction",
    "fixMissingConceptPage",
    "fixBrokenLink",
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
};

/** Every `src/lib/*.ts` module whose own code calls a kernel writer. */
const WRITER_MODULES = [
  "agents",
  "document-sources",
  "ingest",
  "lint-fix",
  "memory-proposals",
  "merge",
  "query",
  "search",
  "tenant-admin",
] as const;

async function routeFiles(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await routeFiles(full, out);
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

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
    const files = await routeFiles(API);
    expect(files.length).toBeGreaterThan(20); // the scan actually found routes

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
    expect(reached.length).toBeGreaterThanOrEqual(20);
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

  it("the four kernel writers still call assertWritable", async () => {
    // The floor the whole scheme rests on. Every "the catch classifies it"
    // treatment above is worthless if the writer stopped throwing, and that
    // deletion would otherwise show up only as a handful of behavioural tests
    // going red with no explanation of what they shared.
    for (const [module, writers] of [
      ["lifecycle", ["writeWikiPageWithSideEffects", "deleteWikiPage"]],
      ["patch-metadata", ["patchMetadata"]],
      ["wikis", ["writeWikiArtifact"]],
    ] as const) {
      const source = await readFile(path.join(LIB, `${module}.ts`), "utf8");
      for (const writer of writers) {
        const start = source.indexOf(`export async function ${writer}(`);
        expect(start, `${module}.ts: ${writer}`).toBeGreaterThan(-1);
        // The gate must be in the writer's OWN opening lines, not merely
        // somewhere in the file — a call moved below the storage work would
        // still match a file-wide search.
        const head = source.slice(start, start + 1200);
        expect(head, `${module}.ts: ${writer} opens with assertWritable`).toMatch(
          /assertWritable\(READ_ONLY_REFUSAL\.\w+\)/,
        );
      }
    }
  });
});
