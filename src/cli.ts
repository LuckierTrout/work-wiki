#!/usr/bin/env node
/**
 * CLI entry point for work-wiki.
 *
 * Usage:
 *   pnpm cli ingest <url>         Ingest a URL into the wiki
 *   pnpm cli ingest --text        Ingest text from stdin
 *   pnpm cli query <question>     Query the wiki
 *   pnpm cli search <query>       Search wiki pages by content
 *   pnpm cli read <slug>          Read a wiki page by slug
 *   pnpm cli create <slug>        Create a new wiki page (body from stdin)
 *   pnpm cli update <slug>        Update an existing wiki page (body from stdin)
 *   pnpm cli lint                 Run wiki lint checks
 *   pnpm cli lint --fix           Run lint and auto-fix issues
 *   pnpm cli list                 List all wiki pages
 *   pnpm cli list --raw           List raw sources
 *   pnpm cli delete <slug>        Delete a wiki page and clean up side effects
 *   pnpm cli history              Show recent ingest history
 *   pnpm cli status               Show wiki health summary
 *   pnpm cli help                 Show this help
 */

// ---------------------------------------------------------------------------
// Argument parsing (exported for testing)
// ---------------------------------------------------------------------------

export type ParsedCommand =
  | { command: "ingest-url"; url: string }
  | { command: "ingest-text" }
  | { command: "reingest"; slug: string }
  | { command: "query"; question: string }
  | { command: "search"; query: string; fuzzy: boolean; scope?: string; limit: number }
  | { command: "read"; slug: string }
  | { command: "create"; slug: string; title: string; tags?: string[] }
  | { command: "update"; slug: string; title?: string; tags?: string[] }
  | { command: "lint"; fix: boolean }
  | { command: "list"; raw: boolean }
  | { command: "delete"; slug: string }
  | { command: "history"; limit: number }
  | { command: "status" }
  | { command: "help" }
  | { command: "error"; message: string };

export function parseArgs(argv: string[]): ParsedCommand {
  const [sub, ...rest] = argv;

  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    return { command: "help" };
  }

  switch (sub) {
    case "ingest": {
      if (rest.includes("--text")) {
        return { command: "ingest-text" };
      }
      const url = rest.find((a) => !a.startsWith("-"));
      if (!url) {
        return { command: "error", message: "Usage: pnpm cli ingest <url>  or  pnpm cli ingest --text" };
      }
      return { command: "ingest-url", url };
    }
    case "reingest": {
      const slug = rest.find((a) => !a.startsWith("-"));
      if (!slug) {
        return { command: "error", message: "Usage: pnpm cli reingest <slug>" };
      }
      return { command: "reingest", slug };
    }
    case "query": {
      const question = rest.filter((a) => !a.startsWith("-")).join(" ");
      if (!question) {
        return { command: "error", message: "Usage: pnpm cli query <question>" };
      }
      return { command: "query", question };
    }
    case "search": {
      const fuzzy = rest.includes("--fuzzy");
      const scopeIdx = rest.indexOf("--scope");
      const scope = scopeIdx !== -1 ? rest[scopeIdx + 1] : undefined;
      const limitIdx = rest.indexOf("--limit");
      const limitRaw = limitIdx !== -1 ? rest[limitIdx + 1] : undefined;
      const limit = limitRaw ? parseInt(limitRaw, 10) : 10;
      // Collect non-flag tokens as the query, skipping values of --scope and --limit
      const skipIndices = new Set<number>();
      if (scopeIdx !== -1) { skipIndices.add(scopeIdx); skipIndices.add(scopeIdx + 1); }
      if (limitIdx !== -1) { skipIndices.add(limitIdx); skipIndices.add(limitIdx + 1); }
      const queryWords = rest.filter((a, i) => !a.startsWith("-") && !skipIndices.has(i));
      const searchQuery = queryWords.join(" ");
      if (!searchQuery) {
        return { command: "error", message: "Usage: pnpm cli search <query> [--fuzzy] [--scope agent:<id>] [--limit N]" };
      }
      return { command: "search", query: searchQuery, fuzzy, scope, limit: isNaN(limit) ? 10 : limit };
    }
    case "read": {
      const slug = rest.find((a) => !a.startsWith("-"));
      if (!slug) {
        return { command: "error", message: "Usage: pnpm cli read <slug>" };
      }
      return { command: "read", slug };
    }
    case "create": {
      const slug = rest.find((a) => !a.startsWith("-"));
      if (!slug) {
        return { command: "error", message: 'Usage: pnpm cli create <slug> --title "Page Title"' };
      }
      const titleIdx = rest.indexOf("--title");
      if (titleIdx === -1 || !rest[titleIdx + 1]) {
        return { command: "error", message: 'Usage: pnpm cli create <slug> --title "Page Title"' };
      }
      const title = rest[titleIdx + 1];
      const tagsIdx = rest.indexOf("--tags");
      const tags = tagsIdx !== -1 && rest[tagsIdx + 1]
        ? rest[tagsIdx + 1].split(",").map((t) => t.trim()).filter(Boolean)
        : undefined;
      return { command: "create", slug, title, tags };
    }
    case "update": {
      const slug = rest.find((a) => !a.startsWith("-"));
      if (!slug) {
        return { command: "error", message: "Usage: pnpm cli update <slug> [--title \"New Title\"] [--tags tag1,tag2]" };
      }
      const titleIdx = rest.indexOf("--title");
      const title = titleIdx !== -1 && rest[titleIdx + 1] ? rest[titleIdx + 1] : undefined;
      const tagsIdx = rest.indexOf("--tags");
      const tags = tagsIdx !== -1 && rest[tagsIdx + 1]
        ? rest[tagsIdx + 1].split(",").map((t) => t.trim()).filter(Boolean)
        : undefined;
      return { command: "update", slug, title, tags };
    }
    case "delete": {
      const slug = rest.find((a) => !a.startsWith("-"));
      if (!slug) {
        return { command: "error", message: "Usage: pnpm cli delete <slug>" };
      }
      return { command: "delete", slug };
    }
    case "lint": {
      const fix = rest.includes("--fix");
      return { command: "lint", fix };
    }
    case "list": {
      const raw = rest.includes("--raw");
      return { command: "list", raw };
    }
    case "history": {
      const limitIdx = rest.indexOf("--limit");
      const limitRaw = limitIdx !== -1 ? rest[limitIdx + 1] : undefined;
      const limit = limitRaw ? parseInt(limitRaw, 10) : 20;
      return { command: "history", limit: isNaN(limit) ? 20 : limit };
    }
    case "status":
      return { command: "status" };
    default:
      return { command: "error", message: `Unknown command: ${sub}\nRun "pnpm cli help" for usage.` };
  }
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP = `
work-wiki CLI

Usage: pnpm cli <command> [args]

Commands:
  ingest <url>         Ingest a URL into the wiki
  ingest --text        Ingest text from stdin (pipe or type, then Ctrl-D)
  reingest <slug>      Re-fetch and update a page from its original source URL
  query <question>     Query the wiki
  search <query>       Search wiki pages by content
  read <slug>          Read a wiki page by slug
  create <slug>        Create a new wiki page (reads body from stdin)
  update <slug>        Update an existing wiki page (reads body from stdin)
  delete <slug>        Delete a wiki page and clean up side effects
  lint                 Run wiki lint checks
  lint --fix           Run lint and auto-fix issues
  list                 List all wiki pages (slug + title)
  list --raw           List raw sources instead of wiki pages
  history              Show recent ingest history
  status               Show wiki health summary
  help                 Show this help

Search flags:
  --fuzzy              Enable typo-tolerant fuzzy matching
  --scope agent:<id>   Restrict results to an agent's pages
  --limit N            Max results (default: 10)

Create flags:
  --title <title>      Page title (required)
  --tags tag1,tag2     Comma-separated tags (optional)

Update flags:
  --title <title>      New page title (optional — preserves existing if omitted)
  --tags tag1,tag2     Comma-separated tags (optional — preserves existing if omitted)

History flags:
  --limit N            Max entries to show (default: 20)

Examples:
  pnpm cli ingest https://example.com/article
  echo "Some text" | pnpm cli ingest --text
  pnpm cli reingest attention-mechanisms
  pnpm cli query "What is attention in transformers?"
  pnpm cli search "attention mechanism"
  pnpm cli search "atention" --fuzzy
  pnpm cli search "identity" --scope agent:yoyo --limit 5
  pnpm cli read attention-mechanisms
  pnpm cli delete attention-mechanisms
  echo "Page body content" | pnpm cli create my-page --title "My Page"
  echo "Tagged page" | pnpm cli create my-page --title "My Page" --tags ai,ml
  echo "new content" | pnpm cli update my-page
  echo "new content" | pnpm cli update my-page --title "New Title"
  echo "new content" | pnpm cli update my-page --title "New Title" --tags ai,ml
  pnpm cli lint
  pnpm cli lint --fix
  pnpm cli list
  pnpm cli list --raw
  pnpm cli history
  pnpm cli history --limit 10
  pnpm cli status
`.trim();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Command runners
// ---------------------------------------------------------------------------

export async function runIngestUrl(url: string): Promise<void> {
  const { ingestUrl } = await import("./lib/ingest");
  const result = await ingestUrl(url);
  console.log(result.primarySlug);
  if (result.relatedUpdated.length > 0) {
    for (const slug of result.relatedUpdated) {
      console.log(slug);
    }
  }
}

export async function runIngestText(): Promise<void> {
  const text = await readStdin();
  if (!text.trim()) {
    console.error("Error: no text received on stdin");
    process.exit(1);
  }
  // Use the first line (up to 80 chars) as a title, or "Untitled"
  const firstLine = text.split("\n")[0]?.trim().slice(0, 80) || "Untitled";
  const title = firstLine.replace(/^#+\s*/, ""); // strip leading markdown heading
  const { ingest } = await import("./lib/ingest");
  const result = await ingest(title, text);
  console.log(result.primarySlug);
  if (result.relatedUpdated.length > 0) {
    for (const slug of result.relatedUpdated) {
      console.log(slug);
    }
  }
}

export async function runReingest(slug: string): Promise<void> {
  const { reingest } = await import("./lib/ingest");
  const { readWikiPageWithFrontmatter } = await import("./lib/wiki");

  const result = await reingest(slug);

  // Read the updated page to get current title and expiry
  const page = await readWikiPageWithFrontmatter(result.primarySlug);
  const title = page?.title ?? result.primarySlug;
  const expiry = page?.frontmatter.expiry;
  const sourceUrl = result.sourceUrl ?? "(unknown)";

  console.log(`Reingest complete: ${title}`);
  console.log(`  Source: ${sourceUrl}`);
  if (expiry) {
    console.log(`  Expiry: ${expiry}`);
  }
}

export async function runQuery(question: string): Promise<void> {
  const { query } = await import("./lib/query");
  const result = await query(question);
  // Answer to stdout (pipeable)
  console.log(result.answer);
  // Sources to stderr (informational)
  if (result.sources.length > 0) {
    console.error(`\nCited pages: ${result.sources.join(", ")}`);
  }
}

export async function runSearch(
  searchQuery: string,
  fuzzy: boolean,
  limit: number,
  scopeParam?: string,
): Promise<void> {
  const { searchWikiContent, fuzzySearchWikiContent, resolveScope } = await import("./lib/search");
  const scope = scopeParam ? await resolveScope(scopeParam) : undefined;
  const results = fuzzy
    ? await fuzzySearchWikiContent(searchQuery, limit, scope ?? undefined)
    : await searchWikiContent(searchQuery, limit, scope ?? undefined);

  if (results.length === 0) {
    console.error("No results found.");
    return;
  }

  for (const r of results) {
    const snippet = r.snippet.replace(/\t/g, " ");
    console.log(`${r.slug}\t${r.score}\t${snippet}`);
  }
}

export async function runRead(slug: string): Promise<void> {
  const { readWikiPageWithFrontmatter } = await import("./lib/wiki");
  const page = await readWikiPageWithFrontmatter(slug);
  if (!page) {
    console.error(`Error: page "${slug}" not found.\nRun "pnpm cli list" to see available pages.`);
    process.exit(1);
    return; // unreachable but satisfies linting
  }

  // Print metadata header
  const fm = page.frontmatter;
  const lines: string[] = [];
  lines.push(`Title:      ${page.title}`);
  lines.push(`Slug:       ${page.slug}`);
  if (typeof fm.confidence === "number") {
    lines.push(`Confidence: ${fm.confidence}`);
  }
  if (typeof fm.expiry === "string" && fm.expiry.length > 0) {
    lines.push(`Expiry:     ${fm.expiry}`);
  }
  if (Array.isArray(fm.tags) && fm.tags.length > 0) {
    lines.push(`Tags:       ${fm.tags.join(", ")}`);
  }
  if (Array.isArray(fm.authors) && fm.authors.length > 0) {
    lines.push(`Authors:    ${fm.authors.join(", ")}`);
  }
  console.log(lines.join("\n"));
  console.log("---");
  console.log(page.body.trim());
}

export async function runCreate(slug: string, title: string, tags?: string[]): Promise<void> {
  const { validateSlug, readWikiPage } = await import("./lib/wiki");
  const { writeWikiPageWithSideEffects } = await import("./lib/lifecycle");
  const { serializeFrontmatter } = await import("./lib/frontmatter");
  const { extractSummary } = await import("./lib/ingest");

  // Validate slug format
  validateSlug(slug);

  // Check for existing page.
  //
  // FRESH (DW-195). This read's answer decides a mutation: `null` here is what
  // authorizes the create below. `pageCache` is module-global and ref-counted
  // around bulk scans, so a concurrent scan can hold a stale NEGATIVE entry
  // open and the guard would rule a stored slug free.
  //
  // STRICT (DW-378). Without it a non-ENOENT storage failure reads back as
  // `null`, indistinguishable from "no page here", and the guard reads a blip
  // as proof the slug is free — landing a create over a stored Page. Strict
  // rethrows; the catch below keeps that out of the `already exists` sentence.
  let existing: Awaited<ReturnType<typeof readWikiPage>>;
  try {
    existing = await readWikiPage(slug, { fresh: true, strict: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `Error: could not read page "${slug}": ${message}\nNothing was created.`,
    );
    process.exit(1);
    return; // unreachable but satisfies linting
  }
  if (existing) {
    console.error(`Error: page "${slug}" already exists.`);
    process.exit(1);
    return; // unreachable but satisfies linting
  }

  // Read body from stdin
  const body = await readStdin();
  if (!body.trim()) {
    console.error("Error: no content received on stdin");
    process.exit(1);
    return; // unreachable but satisfies linting
  }

  const today = new Date().toISOString().slice(0, 10);
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + 90);
  const expiryDate = expiry.toISOString().slice(0, 10);

  const frontmatter = {
    title,
    created: today,
    updated: today,
    confidence: 0.5,
    expiry: expiryDate,
    authors: ["cli"],
    valid_from: today,
    disputed: false,
    contributors: [],
    aliases: [],
    tags: tags ?? [],
  };

  const fullContent = serializeFrontmatter(frontmatter, body.trim());
  const summary = extractSummary(body.trim());

  const result = await writeWikiPageWithSideEffects({
    slug,
    title,
    content: fullContent,
    summary,
    logOp: "ingest",
    crossRefSource: body.trim(),
    createOnly: true,
    validateNewLinkTargets: true,
  });

  console.log(`Created: ${result.slug}`);
  console.log(`  Title: ${title}`);
  if (result.updatedSlugs.length > 0) {
    console.log(`  Cross-referenced: ${result.updatedSlugs.join(", ")}`);
  }
}

export async function runUpdate(slug: string, title?: string, tags?: string[]): Promise<void> {
  const { validateSlug, readWikiPageWithFrontmatter } = await import("./lib/wiki");
  const { writeWikiPageWithSideEffects } = await import("./lib/lifecycle");
  const { serializeFrontmatter } = await import("./lib/frontmatter");
  const { extractSummary } = await import("./lib/ingest");

  // Validate slug format
  validateSlug(slug);

  // Check that the page exists.
  //
  // FRESH (DW-195). This read's answer decides a mutation, and its bytes ARE
  // the merge base — `existing.content` becomes `expectedContent` below.
  // `pageCache` is module-global and ref-counted around bulk scans, so a
  // concurrent scan can hold a superseded entry open and the update would
  // merge over — and compare against — bytes that are no longer stored.
  //
  // STRICT (DW-378). Without it a non-ENOENT storage failure reads back as
  // `null`, indistinguishable from "no page here", so a blip is reported as a
  // page that does not exist and the update refuses a Page that is merely
  // unreadable. Strict rethrows; the catch below keeps that out of the
  // `not found` sentence.
  let existing: Awaited<ReturnType<typeof readWikiPageWithFrontmatter>>;
  try {
    existing = await readWikiPageWithFrontmatter(slug, { fresh: true, strict: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `Error: could not read page "${slug}": ${message}\nNothing was written.`,
    );
    process.exit(1);
    return; // unreachable but satisfies linting
  }
  if (!existing) {
    console.error(`Error: page "${slug}" not found.\nRun "pnpm cli list" to see available pages.`);
    process.exit(1);
    return; // unreachable but satisfies linting
  }

  // Read new body from stdin
  const body = await readStdin();
  if (!body.trim()) {
    console.error("Error: no content received on stdin");
    process.exit(1);
    return; // unreachable but satisfies linting
  }

  // Merge metadata: use provided values or fall back to existing
  const fm = existing.frontmatter;
  const effectiveTitle = title ?? existing.title;
  const today = new Date().toISOString().slice(0, 10);

  const updatedFrontmatter = {
    ...fm,
    title: effectiveTitle,
    updated: today,
    tags: tags ?? (Array.isArray(fm.tags) ? fm.tags : []),
  };

  const fullContent = serializeFrontmatter(updatedFrontmatter, body.trim());
  const summary = extractSummary(body.trim());

  const result = await writeWikiPageWithSideEffects({
    slug,
    title: effectiveTitle,
    content: fullContent,
    summary,
    logOp: "edit",
    crossRefSource: body.trim(),
    expectedContent: existing.content,
    validateNewLinkTargets: true,
  });

  console.log(`Updated: ${result.slug}`);
  console.log(`  Title: ${effectiveTitle}`);
  if (result.updatedSlugs.length > 0) {
    console.log(`  Cross-referenced: ${result.updatedSlugs.join(", ")}`);
  }
}

export async function runDelete(slug: string): Promise<void> {
  const { deleteWikiPage } = await import("./lib/lifecycle");

  const result = await deleteWikiPage(slug, "cli");

  console.log(`Deleted: ${result.slug}`);
  if (result.removedFromIndex) {
    console.log("  Removed from index");
  }
  if (result.strippedBacklinksFrom.length > 0) {
    console.log(`  Stripped backlinks from: ${result.strippedBacklinksFrom.join(", ")}`);
  }
}

export async function runLint(fix: boolean): Promise<void> {
  const { lint } = await import("./lib/lint");
  const result = await lint();

  if (result.issues.length === 0) {
    console.log("No issues found.");
    return;
  }

  // Print issues
  for (const issue of result.issues) {
    const severity = issue.severity.toUpperCase().padEnd(7);
    console.log(`[${severity}] ${issue.type}: ${issue.message} (${issue.slug})`);
  }
  console.log(`\n${result.summary}`);

  // Auto-fix if requested
  if (fix) {
    const { fixLintIssue } = await import("./lib/lint-fix");
    console.log("\nAttempting auto-fix...\n");
    let fixed = 0;
    let failed = 0;
    for (const issue of result.issues) {
      try {
        const fixResult = await fixLintIssue(
          issue.type,
          issue.slug,
          issue.target,
          issue.message,
        );
        console.log(`  ✓ Fixed ${issue.type} on ${issue.slug}: ${fixResult.message}`);
        fixed++;
      } catch {
        console.error(`  ✗ Could not fix ${issue.type} on ${issue.slug}`);
        failed++;
      }
    }
    console.log(`\nFixed: ${fixed}, Failed: ${failed}`);
    if (failed > 0) {
      process.exit(1);
    }
  } else {
    // No --fix: exit 1 if any issues were found (standard lint convention)
    process.exit(1);
  }
}

/**
 * Every Source row the CLI shows: the flat `raw/sources/<id>.md` listing and
 * the hashed `raw/sources/<slug>/<id>.<ext>` snapshots, with the flat row
 * DROPPED for any slug that has snapshots, and the snapshot rows of ONE
 * arrival collapsed to one.
 *
 * `listRawSources` is non-recursive BY CONTRACT — that is the browse contract
 * its docblock states, and the Workbench Sources surface built on it does not
 * move. The caller unions instead, the same way `wiki-retrieve.ts` already
 * does; without it a workspace whose Sources all arrived through hashed Intake
 * reports an empty `list --raw` and a `Raw sources:\t0` status (DW-437).
 *
 * WHY THE FLAT ROW IS DROPPED when snapshots exist: a plain concatenation
 * double-counts every normally-ingested page. `ingest()` writes BOTH keys for
 * the same slug — the flat blob at `src/lib/ingest.ts:1953`
 * (`saveRawSource(slug, content)`) and the per-source snapshot at
 * `src/lib/ingest.ts:2012` (`saveRawSourceFor(slug, rawId, content)`) — so the
 * two listings describe one page twice. The snapshots are the per-source view
 * of that page and the flat blob is the legacy single-blob view of the same
 * bytes, so the snapshots win: a page with three distinct sources still counts
 * three, and a slug with no snapshot at all keeps its flat row.
 *
 * Only a MARKDOWN snapshot suppresses it, though. That whole argument is about
 * the pair `ingest()` writes from one text; a BINARY snapshot on the same slug
 * is a different Source, and dropping the flat blob for it would hide real
 * prose behind an unrelated image (DW-569).
 *
 * Each listing gets its OWN try/catch: one root failing must not blank the
 * other, which is the whole reason the union is worth more than either half.
 */
async function listRawSourceRows(): Promise<
  Array<{ slug: string; filename: string }>
> {
  const { listRawSources, listRawSourceSnapshots } = await import("./lib/raw");
  const flat: Array<{ slug: string; filename: string }> = [];
  const hashed: Array<{ slug: string; filename: string }> = [];
  const slugsWithSnapshots = new Set<string>();
  try {
    for (const source of await listRawSources()) {
      flat.push({ slug: source.slug, filename: source.filename });
    }
  } catch (error) {
    console.error(`Warning: could not list raw sources: ${String(error)}`);
  }
  // One entry per ARRIVAL, keyed `<slug>/<rawId>`: see the dedupe note below.
  const byArrival = new Map<string, { slug: string; filename: string }>();
  try {
    // THIS CALLER DOES NOT FILTER by `ext` — it is the one that must not.
    // `list --raw` and `Raw sources:` describe what is STORED, so a workspace
    // whose only Source is a PDF has to show it and count it (DW-569); the
    // reading callers (retrieval, `incomplete-coverage`) drop binaries because
    // they need prose, and this one has no such excuse.
    //
    // It DOES collapse the rows of one arrival. A binary Source and the
    // Markdown the sidecar extracted from it are stored under the same
    // `rawId` on purpose, so listing both would print one Source twice and
    // roughly double the count — the same double-count the flat/hashed union
    // above exists to prevent, one level down. The non-Markdown artefact wins
    // the row because it is the immutable original the owner actually handed
    // over; the extract is derived from it.
    for (const snapshot of await listRawSourceSnapshots()) {
      // ONLY a MARKDOWN snapshot suppresses the slug's flat row. The
      // suppression's whole warrant is that the two rows are one page's bytes
      // twice, and that is a claim about `ingest()`: it writes the flat blob
      // and the per-source `.md` snapshot from the SAME text, one call apart.
      // A binary snapshot is a different Source entirely — an image or a PDF
      // dropped onto a slug that also has a flat prose blob — so suppressing on
      // it would delete a real prose Source from the listing and the count to
      // make room for a file it has nothing to do with.
      if (snapshot.ext === "md") slugsWithSnapshots.add(snapshot.slug);
      const key = `${snapshot.slug}/${snapshot.rawId}`;
      if (byArrival.has(key) && snapshot.ext === "md") continue;
      byArrival.set(key, {
        slug: snapshot.slug,
        filename: `${snapshot.rawId}.${snapshot.ext}`,
      });
    }
  } catch (error) {
    console.error(`Warning: could not list raw snapshots: ${String(error)}`);
  }
  hashed.push(...byArrival.values());
  return [
    ...flat.filter((row) => !slugsWithSnapshots.has(row.slug)),
    ...hashed,
  ];
}

export async function runList(raw: boolean): Promise<void> {
  if (raw) {
    const sources = await listRawSourceRows();
    const sorted = sources.sort((a, b) => a.slug.localeCompare(b.slug));
    for (const s of sorted) {
      console.log(`${s.slug}\t${s.filename}`);
    }
  } else {
    const { listWikiPages } = await import("./lib/wiki");
    const pages = await listWikiPages();
    const sorted = pages.sort((a, b) => a.title.localeCompare(b.title));
    for (const p of sorted) {
      console.log(`${p.slug}\t${p.title}`);
    }
  }
}

export async function runStatus(): Promise<void> {
  const { listWikiPages } = await import("./lib/wiki");
  const { getEffectiveSettings, readConfig } = await import("./lib/config");
  const { getErrorMessage } = await import("./lib/errors");

  const pages = await listWikiPages();
  // Same union as `list --raw`: a count that omitted hashed snapshots would
  // report 0 Sources for a workspace built entirely through Intake (DW-437).
  const sources = await listRawSourceRows();

  // WHY the store is loaded before it is read (DW-502).
  //
  // `getEffectiveSettings()` is synchronous: it reads the store through
  // `loadConfigSync()`, which answers `{}` whenever the in-memory cache is not
  // warm — and re-stamps that `{}` for another `CACHE_TTL_MS` (5 s,
  // `src/lib/config.ts`) each time it does. So the hazard is "no async load
  // inside the last 5 seconds", not something peculiar to fresh processes; a CLI
  // process is simply the case that hits it EVERY time, since nothing ran ahead
  // of this command to warm anything. Unwarmed, every ladder's store leg goes
  // blind and `status` reports env-only settings: a provider the owner saved is
  // invisible, and a stored `ollamaBaseUrl` the resolver refused has no refusal
  // to report.
  //
  // WARMING AT THE CALL, which is what the web surface does too — there is no
  // startup hook in this repo to warm anything globally. `src/app/api/status/
  // route.ts` awaits a config read immediately before `getProviderInfo()`, per
  // request, for exactly this reason; this is the same move on the CLI side.
  //
  // THROUGH `readConfig()` RATHER THAN `loadConfig()` (DW-549). Both warm the
  // sync cache identically on the success path, so the DW-502 fix is unchanged;
  // `readConfig()` is simply the only door that tells an ABSENT store from an
  // UNREADABLE one. `loadConfig()` flattens both to `{}`, and the rows below
  // then say "not configured" in the same sentence for "nothing was ever saved"
  // and for "what you saved could not be read" — on the one surface with no
  // Settings screen to go and look at.
  //
  // No error handling belongs here either: `readConfig()` RETURNS its failure
  // rather than throwing, so the rows below print either way.
  const stored = await readConfig();

  const settings = getEffectiveSettings();

  console.log(`Wiki pages:\t${pages.length}`);
  console.log(`Raw sources:\t${sources.length}`);
  // WHY the unreadable store is reported ABOVE the provider verdict (DW-549).
  //
  // A store that could not be read degrades EVERY settings row below it to the
  // environment alone — provider, endpoint and embeddings alike — so it is a
  // caveat on all of them, not a note on one. `Ollama endpoint:` stays
  // immediately after `LLM provider:` because it qualifies exactly that subject.
  //
  // CONDITIONAL, like `Ollama endpoint:`. ENOENT is `status: "ok"` with `{}`, so
  // a deployment that simply never saved anything still prints the four rows it
  // always has — `Label:\tvalue` is a parsed shape, and an unconditional fifth
  // row would be a new field for every reader of this output.
  if (stored.status !== "ok") {
    // WHY THE MESSAGE IS FLATTENED AND CAPPED.
    //
    // `Label:\tvalue` is a parsed shape, and the value here is the only one on
    // this surface that comes from OUTSIDE the program: V8's `JSON.parse` error
    // quotes a snippet of the offending bytes back at you, so a config file
    // holding a newline printed a SECOND, unlabelled physical line and detached
    // the "environment only" caveat from the label it qualifies. Collapsing
    // whitespace is what keeps one `console.log` to one row no matter what is in
    // the file; the cap keeps a large malformed file from turning the row into a
    // paragraph. The row is a POINTER — the operator opens the file next — so
    // losing the tail of a long parser message costs nothing.
    const detail = getErrorMessage(stored.error).replace(/\s+/g, " ").trim();
    const message = detail.length > 200 ? `${detail.slice(0, 197)}...` : detail;
    console.log(
      `Stored config:\tunreadable — ${message}; ` +
      `the settings below reflect the environment only`,
    );
  }
  console.log(`LLM provider:\t${settings.provider ?? "not configured"}`);
  // WHY the endpoint was thrown away (DW-402, DW-418).
  //
  // "not configured" above is the same word for "nothing was ever set" and for
  // "what you set was refused", and only the second has an action attached. The
  // resolver already knows which and carries the sentence on
  // `EffectiveSettings`; the headless operator is the reader least able to go
  // look, since there is no Settings screen on this side of the product.
  //
  // LABELLED FOR ITS OWN SUBJECT, not as a note on the row above. The refusal is
  // about `OLLAMA_BASE_URL` and is reported whether or not a provider resolved —
  // a deployment running `anthropic` can still have a typo'd Ollama endpoint,
  // and suppressing the sentence there would hide it from the only reader who
  // cannot go and look. A row called "Provider note" printed under a successful
  // `LLM provider:` line would read as qualifying a verdict that succeeded;
  // "Ollama endpoint" names what it is actually about.
  //
  // CONDITIONAL, so a clean config prints exactly the four lines it always has —
  // `Label:\tvalue` is a parsed shape, and an empty fifth row would be a new
  // field for every reader of this output.
  if (settings.ollamaBaseUrlIssue) {
    console.log(`Ollama endpoint:\t${settings.ollamaBaseUrlIssue}`);
  }
  console.log(`Embeddings:\t${settings.embeddingSupport ? "available" : "not available"}`);
}

export async function runHistory(limit: number): Promise<void> {
  const { readLedger } = await import("./lib/ingest");
  const entries = await readLedger(limit);

  if (entries.length === 0) {
    console.log("No ingest history found.");
    return;
  }

  // Print header
  console.log(
    "Timestamp".padEnd(25) +
    "Slug".padEnd(30) +
    "Source".padEnd(40) +
    "Status",
  );
  console.log("-".repeat(100));

  for (const entry of entries) {
    const ts = entry.finished_at || entry.started_at || "";
    const shortTs = ts.slice(0, 19).replace("T", " ");
    const slug = entry.primary_slug || "";
    const source = entry.source_url || "";
    const status = entry.status || "";

    console.log(
      shortTs.padEnd(25) +
      slug.slice(0, 28).padEnd(30) +
      source.slice(0, 38).padEnd(40) +
      status,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // argv[0] = node/tsx, argv[1] = script path, argv[2+] = user args
  const args = process.argv.slice(2);
  const parsed = parseArgs(args);

  switch (parsed.command) {
    case "help":
      console.log(HELP);
      return;
    case "error":
      console.error(parsed.message);
      process.exit(1);
      break; // unreachable but satisfies linting
    case "ingest-url":
      await runIngestUrl(parsed.url);
      return;
    case "ingest-text":
      await runIngestText();
      return;
    case "reingest":
      await runReingest(parsed.slug);
      return;
    case "query":
      await runQuery(parsed.question);
      return;
    case "search":
      await runSearch(parsed.query, parsed.fuzzy, parsed.limit, parsed.scope);
      return;
    case "read":
      await runRead(parsed.slug);
      return;
    case "create":
      await runCreate(parsed.slug, parsed.title, parsed.tags);
      return;
    case "update":
      await runUpdate(parsed.slug, parsed.title, parsed.tags);
      return;
    case "delete":
      await runDelete(parsed.slug);
      return;
    case "lint":
      await runLint(parsed.fix);
      return;
    case "list":
      await runList(parsed.raw);
      return;
    case "status":
      await runStatus();
      return;
    case "history":
      await runHistory(parsed.limit);
      return;
  }
}

// Only run main when executed directly (not imported for testing) — DW-551.
//
// This module exports `runStatus`, `runList` and the rest for the suites that
// pin them, and a bare `main()` at module scope runs a COMMAND on every one of
// those imports: with no argv the parser falls through to `help`, so a suite
// gets the HELP block in its output, and any command that throws reaches the
// `process.exit(1)` below and takes the vitest worker down with it.
//
// The shape mirrors `src/mcp.ts` verbatim so the two entry points cannot drift.
const isDirectExecution =
  process.argv[1]?.endsWith("cli.ts") ||
  process.argv[1]?.endsWith("cli.js");

if (isDirectExecution) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);

    // Friendly message for missing API key
    if (message.toLowerCase().includes("api key") || message.toLowerCase().includes("api_key")) {
      console.error(
        `Error: No LLM API key configured.\n\n` +
        `Set one of these environment variables:\n` +
        `  ANTHROPIC_API_KEY=sk-...\n` +
        `  OPENAI_API_KEY=sk-...\n` +
        `  GOOGLE_GENERATIVE_AI_API_KEY=...\n\n` +
        `Or configure a provider in the Settings UI (http://localhost:3000/settings).`,
      );
    } else {
      console.error(`Error: ${message}`);
    }
    process.exit(1);
  });
}
