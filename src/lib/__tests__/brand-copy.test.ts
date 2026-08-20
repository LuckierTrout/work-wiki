/**
 * AD-7 / Story 1.1: the rebrand is DISPLAY-ONLY.
 *
 * User-visible copy says `work-wiki`. Every runtime identifier — tenants, owner
 * constants, MCP server name, localStorage keys, `YOPEDIA_*` env/secret names,
 * `X-Yopedia-*` headers, Cloudflare resource names — stays `yopedia`, because
 * renaming those orphans production R2/KV/Queue data.
 *
 * The source scan below is deliberately crude: it reads the repo as text and
 * fails on any stray brand string. That is the only way to stop a future edit
 * from reintroducing "Yopedia" into rendered copy.
 *
 * Four things make the scan hard to hollow out:
 *
 * 1. ONE file filter. `SOURCE_TEXT` is the only source-type filter in this
 *    file and is `walk()`'s default, so a newly added file type cannot be read
 *    by one scan and invisible to another. Two listing selectors survive
 *    alongside it and neither is a source-type filter: `MARKDOWN` selects the
 *    repo root's NON-recursive markdown listing, and `ANY_FILE` reads `tools/`
 *    and `scripts/` whole, whatever the extension. Every other root uses
 *    `SOURCE_TEXT`.
 * 2. ONE union. `scannedSources()` and `maintainerSources()` still exist to
 *    describe how each root is reached, but every predicate — stale
 *    "WorkWiki", stray `workwiki`, stray `yopedia` — runs over
 *    `allBrandSources()`, the de-duplicated union, through the single
 *    `scanBrandSources()` helper. A predicate that reads half the tree was the
 *    defect this suite used to have, so each content test asserts the corpus
 *    it actually iterated reaches BOTH lists.
 * 3. Pins with a floor. Named files prove each root and each load-bearing
 *    filter alternative is reachable; a corpus-size floor proves the walk did
 *    not collapse to just the named files.
 * 4. ONE visible exemption inventory, counted. The union means the workers'
 *    READMEs and the `wrangler.jsonc` files — which carry this deployment's
 *    own grandfathered "Yopedia" prose that AGENTS.md says never to "fix" —
 *    are in the strict scan. `YOPEDIA_PROSE_EXEMPT` maps each of them to
 *    TODAY'S occurrence count, so the waiver is per-occurrence rather than
 *    per-file: one new line of Yopedia display prose in an exempt file fails
 *    the suite, and so does an exemption that has stopped being needed.
 */
import { describe, expect, it } from "vitest";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { APP_NAME, APP_TITLE } from "../brand";
import manifest from "../../app/manifest";

const SRC = path.resolve(__dirname, "../..");
const ROOT = path.resolve(SRC, "..");

/** Every `yopedia` spelling that is a runtime identifier, not display copy. */
const IDENTIFIER_ALLOWLIST = [
  // All-caps is always an identifier: env vars, secrets, and Worker bindings.
  // Display copy is never shouted, so this can't mask a real offender.
  /\bYOPEDIA[A-Z0-9_]*\b/g,
  /X-Yopedia-(?:[A-Za-z-]+|\*)/g, // wire-protocol headers
  /`yopedia`/g, // the identifier named in a doc comment
  /\/u\/yopedia\b/g, // DEFAULT_TENANT in a URL path (inlined in the workers)
  /yopedia (?:email-ingest|task-consumer) ok/g, // Worker health-check bodies
  /"yopedia"/g, // DEFAULT_TENANT, BASE_AGENT_OWNER, MCP serverInfo.name
  /yopedia--[a-z0-9-]+/g, // agent ids derived from BASE_AGENT_OWNER
  /yopedia_[a-z_]+/g, // localStorage keys
  /yopedia-[a-z-]+/g, // Cloudflare resource names, sandbox host, monitor UA
  /yopedia\.yolog\.dev/g, // upstream origin referenced in comments
  // The deployment origin derived from the frozen Cloudflare project name —
  // same class as the upstream origin above, and what `skills/` documents as
  // the MCP endpoint. Renaming the project is what AGENTS.md forbids, so the
  // hostname it generates is an identifier, not copy. Spelled out in full on
  // purpose: a generalised `yopedia\.[a-z0-9.-]+` would wave through any
  // "Yopedia.<something>" a future doc invents.
  /yopedia\.yuanhao-li\.workers\.dev/g,
  /yologdev\/yopedia/g, // upstream repo link (AGENTS.md says leave it)
];

/**
 * The ONE source-type filter. Every walk in this file uses it, so coverage is
 * a property of the root list alone — adding a `.toml` or `.webmanifest` file
 * under any scanned root cannot quietly land outside the scan, and no second
 * filter can drift away from this one.
 *
 * It stays an allowlist of text types on purpose: several scanned roots carry
 * fonts and images (`public/fonts` TrueType, `public/yoyo.png`,
 * `docs/assets` screenshots), which `readFile(..., "utf8")` would happily
 * decode into mojibake. The extensionless `Dockerfile` is named because the
 * workers ship one.
 *
 * Deleting an alternative here silently deletes a tree from all three scans,
 * so the pin test below names one file per load-bearing alternative and puts a
 * floor under the corpus size.
 */
const SOURCE_TEXT =
  /(?:^Dockerfile$|\.(?:tsx?|jsx?|mjs|cjs|md|mdx|json|jsonc|css|html|svg|txt|ya?ml|sh|toml|webmanifest)$)/;

/**
 * `skipDirs` is per-call on purpose. A globally-skipped directory name would
 * silently shrink `scannedSources()` too — a future `dist/` under `src/`,
 * `integrations/` or `workers/` would drop out of the brand scan without any
 * test noticing, which is the quiet vacuity the pin tests exist to prevent.
 */
async function walk(
  dir: string,
  include: RegExp = SOURCE_TEXT,
  skipDirs: string[] = [],
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      if (skipDirs.includes(entry.name)) continue;
      out.push(...(await walk(full, include, skipDirs)));
    } else if (include.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const INTEGRATIONS = path.resolve(SRC, "../integrations");

describe("display name", () => {
  it("is work-wiki", () => {
    expect(APP_NAME).toBe("work-wiki");
    expect(APP_TITLE.startsWith("work-wiki")).toBe(true);
  });

  it("drives the PWA manifest rather than a second hardcoded string", () => {
    const m = manifest();
    expect(m.short_name).toBe(APP_NAME);
    expect(m.name).toBe(APP_TITLE);
    expect(m.description).toContain(APP_NAME);
  });

  it("drives the root layout metadata", async () => {
    const layout = await readFile(path.join(SRC, "app/layout.tsx"), "utf8");
    // The title template and openGraph siteName must interpolate APP_NAME.
    expect(layout).toMatch(/template:\s*`%s · \$\{APP_NAME\}`/);
    expect(layout).toMatch(/siteName:\s*APP_NAME/);
  });
});

/** Everything that ships rendered copy or wire strings, not just the app tree. */
async function scannedSources(): Promise<string[]> {
  const trees = ["app", "components", "lib", "hooks"].map((d) => path.join(SRC, d));
  const files = [
    ...(await Promise.all(trees.map((d) => walk(d)))).flat(),
    path.join(SRC, "mcp.ts"),
    path.join(SRC, "middleware.ts"),
    // The Cloudflare workers send real email to real people — this is exactly
    // where the queue-attempt header rename slipped past an app-only scan.
    // With the shared filter this now also reads their READMEs, `wrangler.jsonc`
    // and `Dockerfile`, which is where AGENTS.md's frozen resource names live.
    ...(await walk(path.resolve(SRC, "../workers"))),
    // The browser clipper ships its own UI (popup, extension name, context
    // menu) outside the Next tree, so an `src/`-only scan never saw it. It has
    // no TypeScript at all — its copy is HTML, JS, JSON and a README.
    ...(await walk(INTEGRATIONS)),
    // Served to users and agents (`public/agent-api.md` is the published API
    // guide), so its copy is as brand-visible as anything in the app tree.
    ...(await walk(path.join(ROOT, "public"))),
    // The journal static site's generator (`build.mjs`) emits the site's
    // headings; its CSS and JS carry no brand string today, and are read so a
    // future one can't land unseen. `dist/` is gitignored build output —
    // present on a developer's machine, absent in CI — so scanning it would
    // make the result depend on whether someone happened to run a build.
    ...(await walk(path.join(ROOT, "journal-site"), SOURCE_TEXT, ["dist"])),
    // Slash-command docs: agent-facing copy nothing used to read.
    ...(await walk(path.join(ROOT, ".opencode", "commands"))),
    // The published MCP skill — the one place an outside agent reads our name
    // and our endpoint from.
    ...(await walk(path.join(ROOT, "skills"))),
  ];
  return files;
}

/** Listing selectors, NOT source-type filters — see the header comment. */
const MARKDOWN = /\.md$/;
const ANY_FILE = /(?:)/;

/**
 * Every `workwiki` spelling that is a frozen operator identifier, not display
 * copy. Renaming any of them breaks an existing operator setup: the env names
 * are read by `tools/work-wiki-sync.mjs`, the origin is production, the
 * lowercase-hyphen family names on-disk backup state, and the clipper's
 * storage key and context-menu id are persisted in installed extensions.
 *
 * Each entry is anchored to the exact artifact it protects. A pattern wider
 * than its identifier is a hole, not a convenience: the case table below pairs
 * every entry with the nearest prose that must still trip.
 */
const WORKWIKI_IDENTIFIER_ALLOWLIST = [
  // Env/secret names, which all carry the underscore. Requiring it matters now
  // that markdown roots are scanned: bare all-caps is ordinary heading style
  // there ("## WORKWIKI SETUP"), so `WORKWIKI[A-Z0-9_]*` would wave prose through.
  /\bWORKWIKI_[A-Z0-9_]*\b/g,
  /workwiki\.app/g, // the production origin
  // The lowercase-hyphen family: on-disk state, archive names, and the calendar
  // export filename. Anchored to the documented artifacts — including the
  // `.ics` extension, so "the workwiki-actions list" is still a slip — which is
  // what keeps display prose ("workwiki-first") out of the waiver.
  /\.?workwiki-(?:source-sync|backups|portable-archive|archive|actions\.ics|[*.$0-9])/g,
  // The clipper's `chrome.storage.local` key — the ONE camelCase spelling in
  // the repo, so it is listed literally rather than as a camelCase shape.
  /\bworkwikiDefaultTags\b/g,
  /\bsave-to-workwiki\b/g, // the clipper's context-menu id, persisted per install
  /hooks\.example\.com\/workwiki/g, // the webhook placeholder rendered by IntegrationDesk
];

/**
 * The two scan rules as pure predicates over text, so what "clean" means is
 * itself pinned by a test. Without this, the only evidence that either scan
 * catches a regression is a plant-and-revert done once by hand.
 */
function saysStaleDisplayName(text: string): boolean {
  return text.includes("WorkWiki");
}

/**
 * The surviving `workwiki` tokens after every frozen-identifier spelling is
 * stripped. Returning the tokens rather than a bare boolean is what makes a
 * failure actionable: the offender list names the word that tripped the scan,
 * instead of handing the reader a filename to re-grep by hand.
 *
 * Tokenised by splitting on whitespace rather than by matching a greedy
 * non-space run around the word. The two select exactly the same substrings,
 * but the regex form backtracks quadratically over a single long non-space
 * run — and the union scan reads generated vendor bundles (the
 * `.generated.ts` files under `src/lib/vendor`) that are one ~370 KB
 * non-space run each. That form took over a minute here and tripped vitest's
 * 5 s per-test timeout.
 */
function strayWorkwiki(text: string): string[] {
  let rest = text;
  for (const pattern of WORKWIKI_IDENTIFIER_ALLOWLIST) rest = rest.replace(pattern, "");
  return rest.split(/\s+/).filter((token) => token.toLowerCase().includes("workwiki"));
}

function hasStrayWorkwiki(text: string): boolean {
  return strayWorkwiki(text).length > 0;
}

/**
 * A "token" from a minified or generated bundle can be the whole file (the
 * vendor bundles above are one 369 KB run), which would bury the failure in
 * an unreadable wall of text. The path plus the head of the token is enough to
 * find it.
 */
const MAX_REPORTED_TOKEN = 80;
function readableToken(token: string): string {
  return token.length > MAX_REPORTED_TOKEN
    ? `${token.slice(0, MAX_REPORTED_TOKEN)}… (${token.length} chars)`
    : token;
}

/**
 * The `yopedia` occurrences left once every frozen spelling is stripped. Count
 * rather than boolean: the exemption inventory pins how many a grandfathered
 * file may carry, which is what stops an exempt file from accumulating new
 * display prose.
 */
function strayYopedia(text: string): string[] {
  let rest = text;
  for (const pattern of IDENTIFIER_ALLOWLIST) rest = rest.replace(pattern, "");
  return rest.match(/yopedia/gi) ?? [];
}

function hasStrayYopedia(text: string): boolean {
  return strayYopedia(text).length > 0;
}

/**
 * Maintainer-facing surfaces: operator tooling, the repo's markdown
 * documentation, and the frozen root config files.
 *
 * This list is not a weaker scan — every predicate runs over the union of it
 * and `scannedSources()`. It exists because these roots are reached
 * differently: `tools/` and `scripts/` are read whole, whatever the extension,
 * and the repo root is not walked at all.
 *
 * The root markdown listing is deliberately NON-recursive: process artifacts
 * under `_bmad-output/` (historical specs, the deferred-work ledger)
 * legitimately carry the old "WorkWiki" string, so a recursive walk would fail
 * the suite for a non-obvious reason. That non-recursive listing is also
 * markdown-only, which is why the root config files below have to be named one
 * by one — `wrangler.jsonc` carries the frozen Cloudflare resource names
 * AGENTS.md protects, and `Dockerfile` has no extension for a filter to match.
 */
async function maintainerSources(): Promise<string[]> {
  const rootMarkdown = (await readdir(ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && MARKDOWN.test(entry.name))
    .map((entry) => path.join(ROOT, entry.name));
  return [
    ...(await walk(path.join(ROOT, "tools"), ANY_FILE)),
    ...rootMarkdown,
    // Walked with the shared filter like every other tree: a `.mdx` or `.json`
    // dropped in here is documentation too, and a markdown-only walk would not
    // read it. The only non-text files under `docs/` are the two screenshots in
    // `docs/assets`, which `SOURCE_TEXT` already excludes.
    ...(await walk(path.join(ROOT, "docs"))),
    // Operator scripts, read like `tools/` — every file, whatever the extension.
    ...(await walk(path.join(ROOT, "scripts"), ANY_FILE)),
    // Root config the non-recursive markdown listing cannot see.
    ...["wrangler.jsonc", "package.json", "mcp.json", "Dockerfile"].map((file) =>
      path.join(ROOT, file),
    ),
  ];
}

/**
 * The de-duplicated union of both lists — what every brand predicate reads.
 * The union is the point: a file only has to appear in ONE list to be held to
 * ALL three rules, so adding a root can never weaken a rule elsewhere.
 */
async function allBrandSources(): Promise<string[]> {
  return [...new Set([...(await scannedSources()), ...(await maintainerSources())])];
}

/**
 * One file only `maintainerSources()` reaches and one only `scannedSources()`
 * reaches. Every content test asserts the corpus it iterated contains both, so
 * narrowing a single predicate back to one list — the exact defect this suite
 * was built to remove — fails instead of passing quietly.
 */
const MAINTAINER_ONLY_WITNESS = path.join("tools", "work-wiki-sync.mjs");
const SCANNED_ONLY_WITNESS = path.join("src", "app", "layout.tsx");

/**
 * The single iteration every content test runs. `offense` returns the offender
 * line for a file, or null when it is clean; the helper hands back both the
 * offenders and the ROOT-relative list of files it actually read, so a test
 * can assert the corpus rather than trusting it.
 */
async function scanBrandSources(
  offense: (text: string, relative: string) => string | null,
): Promise<{ offenders: string[]; read: string[] }> {
  const files = await allBrandSources();
  const offenders: string[] = [];
  for (const file of files) {
    const relative = path.relative(ROOT, file);
    const hit = offense(await readFile(file, "utf8"), relative);
    if (hit !== null) offenders.push(hit);
  }
  return { offenders, read: files.map((file) => path.relative(ROOT, file)) };
}

function expectUnionCorpus(read: string[]): void {
  for (const witness of [MAINTAINER_ONLY_WITNESS, SCANNED_ONLY_WITNESS]) {
    expect(
      read,
      `this predicate read ${read.length} files but not ${witness} — it was narrowed to one source list; every brand rule must run over allBrandSources()`,
    ).toContain(witness);
  }
}

/**
 * ROOT-relative path → the number of non-allowlisted `yopedia` occurrences it
 * is grandfathered to carry TODAY. These are this deployment's own history —
 * release notes, the Cloudflare setup script, the workers' READMEs and the
 * `wrangler.jsonc` resource names — and AGENTS.md tells maintainers not to
 * "fix" them, so they are exempt from the yopedia check ONLY. Both `workwiki`
 * rules still apply to every file here.
 *
 * The count, not the path, is the waiver: a file-level exemption would let an
 * exempt file accumulate new Yopedia display prose forever, which is the very
 * failure this suite exists to catch. The pin test fails in both directions —
 * fewer occurrences means the entry should shrink or go, more means fresh
 * brand prose landed.
 */
const YOPEDIA_PROSE_EXEMPT = new Map([
  ["BACKLOG.md", 2],
  ["README.md", 5],
  ["wrangler.jsonc", 2],
  [path.join("docs", "trusted-memory-roadmap.md"), 2],
  [path.join("scripts", "setup-cloudflare.sh"), 7],
  [path.join("workers", "email-ingest", "README.md"), 3],
  [path.join("workers", "task-consumer", "README.md"), 2],
  [path.join("workers", "task-consumer", "wrangler.jsonc"), 5],
]);

describe("no stale brand strings in rendered copy", () => {
  it("actually reads the browser clipper's shipped copy", async () => {
    // A scan that matches no files passes every assertion below while proving
    // nothing. Pin the clipper's rendered surfaces by name so a filter that
    // stops matching them fails here instead of going quietly vacuous.
    const scanned = (await scannedSources()).map((f) => path.relative(INTEGRATIONS, f));
    for (const file of ["popup.html", "manifest.json", "service-worker.js"]) {
      expect(scanned).toContain(path.join("browser-clipper", file));
    }
  });

  it("actually reads every root and every load-bearing file type", async () => {
    // Two failure modes, two guards. A root that moves or a filter alternative
    // that is deleted while tuning the list both shrink the scan silently:
    // dropping `tsx?|` from SOURCE_TEXT takes the ENTIRE app tree out of all
    // three predicates. So pin one file per root AND one per load-bearing
    // extension — `.tsx`, `.ts` and the extensionless `Dockerfile` are named
    // here for that reason, not because those three files are special.
    const scanned = (await scannedSources()).map((f) => path.relative(ROOT, f));
    for (const file of [
      path.join("src", "app", "layout.tsx"), // .tsx — the app tree
      path.join("src", "lib", "brand.ts"), // .ts — the library tree
      path.join("workers", "sandbox-runner", "Dockerfile"), // the extensionless case
      path.join("workers", "sandbox-runner", "README.md"),
      path.join("workers", "task-consumer", "wrangler.jsonc"),
      path.join("public", "agent-api.md"),
      path.join("journal-site", "build.mjs"),
      path.join("skills", "work-wiki-mcp", "SKILL.md"),
    ]) {
      expect(scanned).toContain(file);
    }
    // `.opencode/commands/` holds only BMAD-installer-generated docs, so
    // pinning one by name would fail this suite on an upstream rename for a
    // reason with nothing to do with branding. Assert the root contributes.
    const opencode = scanned.filter((f) =>
      f.startsWith(path.join(".opencode", "commands") + path.sep),
    );
    expect(
      opencode.length,
      "scannedSources() must read .opencode/commands — the root went vacuous",
    ).toBeGreaterThan(0);
    // Named files prove the reach; the floor proves the walk did not collapse
    // to just them. ~540 files today, so 300 leaves room to delete a tree
    // legitimately without becoming a second thing to update on every commit.
    expect(
      scanned.length,
      "scannedSources() collapsed — a filter alternative or a whole root is gone",
    ).toBeGreaterThan(300);
  });

  it("actually reads every surface the maintainer sweep covered", async () => {
    const scanned = (await maintainerSources()).map((f) => path.relative(ROOT, f));
    for (const file of [
      MAINTAINER_ONLY_WITNESS,
      path.join("tools", "work-wiki-sync.md"),
      "BACKLOG.md",
      path.join("docs", "llm-wiki-functional-parity-roadmap.md"),
      path.join("scripts", "setup-cloudflare.sh"),
      "wrangler.jsonc",
      "package.json",
      "mcp.json",
      "Dockerfile",
    ]) {
      expect(scanned).toContain(file);
    }
  });

  it("scans strictly more than either source list alone", async () => {
    // The union has to be a real widening of both lists, not a relabelling of
    // one: if a future edit folds one list into the other (or empties it), the
    // per-test corpus assertions would still find both witnesses while half
    // the reach quietly disappeared.
    const scanned = await scannedSources();
    const maintainer = await maintainerSources();
    const all = await allBrandSources();
    expect(all.length).toBeGreaterThan(scanned.length);
    expect(all.length).toBeGreaterThan(maintainer.length);
    // De-duplicated: a file named by both lists is read and reported once.
    expect(new Set(all).size).toBe(all.length);
    expectUnionCorpus(all.map((file) => path.relative(ROOT, file)));
  });

  it('no brand source says "WorkWiki"', async () => {
    const { offenders, read } = await scanBrandSources((text, relative) =>
      saysStaleDisplayName(text) ? relative : null,
    );
    expectUnionCorpus(read);
    expect(offenders).toEqual([]);
  });

  it('every "workwiki" in the repo is a frozen operator identifier', async () => {
    // Strictly stronger than the literal "WorkWiki" check above: it also
    // catches case variants ("Workwiki", "workwiki" as prose). The literal
    // check stays because it gives the common regression a crisper message.
    const { offenders, read } = await scanBrandSources((text, relative) => {
      const stray = strayWorkwiki(text);
      if (stray.length === 0) return null;
      return `${relative}: ${[...new Set(stray)].map(readableToken).join(", ")}`;
    });
    expectUnionCorpus(read);
    expect(offenders).toEqual([]);
  });

  it("tells a frozen operator identifier apart from a display-brand slip", () => {
    // The scans above only prove the tree is clean today. These cases fix what
    // "clean" means, so a widened allowlist that stops catching regressions
    // fails here rather than passing quietly.
    for (const frozen of [
      "> Base URL in these examples: `https://workwiki.app`",
      "WORKWIKI_SYNC_INTERVAL_MINUTES=360 WORKWIKI_SYNC_KEEP=30",
      'const SOURCE_STATE_FILE = ".workwiki-source-sync.json";',
      'join(process.cwd(), "workwiki-backups")',
      "/^workwiki-.*\\.zip$/",
      "const name = `workwiki-${new Date().toISOString()}.zip`;",
      "workwiki-2026-08-19T12-00-00-000Z.zip",
      "workwiki-archive.zip",
      "workwiki-*.zip",
      'format: "workwiki-portable-archive",',
      // The four spellings the widened app-tree scan reads.
      'chrome.storage.local.get(["workwikiDefaultTags"], (stored) => {',
      'id: "save-to-workwiki",',
      'placeholder="https://hooks.example.com/workwiki"',
      '"Content-Disposition": \'attachment; filename="workwiki-actions.ics"\'',
    ]) {
      expect(hasStrayWorkwiki(frozen), frozen).toBe(false);
      expect(saysStaleDisplayName(frozen), frozen).toBe(false);
    }
    for (const slip of [
      "keeping WorkWiki cloud-first",
      "the Workwiki worker",
      // The regression guard for the anchored lowercase-hyphen pattern: a
      // wildcard `workwiki-[a-z-]*` would swallow this prose silently.
      "the workwiki-first approach",
      // One near-miss per pattern added for the app tree, each differing from
      // the frozen spelling ONLY in the part that anchors it: the camelCase
      // hump, the hyphenated id, the host path, the `.ics` extension.
      "the workwiki dashboard",
      "the workwiki-actions list",
      // The camelCase entry is one literal spelling, not a shape: a NEW camelCase
      // identifier has to be reviewed and allowlisted, not waved through on form.
      "rename workwikiSidebar before shipping",
      "save to workwiki from any page",
      "post the webhook to workwiki",
    ]) {
      expect(hasStrayWorkwiki(slip), slip).toBe(true);
    }
    // The literal check is a STRICT SUBSET of the stray check: it catches the
    // exact "WorkWiki" casing only, and must stay blind to the variants above.
    expect(saysStaleDisplayName("keeping WorkWiki cloud-first")).toBe(true);
    expect(saysStaleDisplayName("the Workwiki worker")).toBe(false);
    expect(saysStaleDisplayName("the workwiki-first approach")).toBe(false);
  });

  it("tells a frozen yopedia identifier apart from a display-brand slip", () => {
    // The yopedia allowlist is twelve patterns wide and guards the identifiers
    // that would orphan production data if renamed, so it is the one most
    // likely to be "tidied" into something more general. These cases are what
    // makes that a failing edit: generalising the deployment origin to
    // `yopedia\.[a-z0-9.-]+` waves through the last slip below.
    for (const frozen of [
      "YOPEDIA_API_TOKEN=... # secret name read by the worker",
      'headers.set("X-Yopedia-Queue-Attempt", String(attempt));',
      "the `yopedia` tenant is the identifier, not the brand",
      "GET /u/yopedia/pages returns the tenant index",
      'return new Response("yopedia email-ingest ok");',
      'const DEFAULT_TENANT = "yopedia";',
      'owner: "yopedia--research-agent",',
      'localStorage.getItem("yopedia_recent_pages")',
      'name = "yopedia-task-queue"',
      "https://yopedia.yolog.dev/api/mcp",
      "https://yopedia.yuanhao-li.workers.dev/api/mcp",
      "forked from https://github.com/yologdev/yopedia",
    ]) {
      expect(hasStrayYopedia(frozen), frozen).toBe(false);
    }
    for (const slip of [
      "Visit Yopedia today",
      "The Yopedia wiki keeps your notes",
      "# Yopedia inbound email",
      // The near-miss for the deployment origin: same shape, different host.
      "Yopedia.example.com is where the docs live",
    ]) {
      expect(hasStrayYopedia(slip), slip).toBe(true);
    }
  });

  it('every remaining "yopedia" is a runtime identifier', async () => {
    const { offenders, read } = await scanBrandSources((text, relative) => {
      if (YOPEDIA_PROSE_EXEMPT.has(relative)) return null;
      return hasStrayYopedia(text) ? relative : null;
    });
    expectUnionCorpus(read);
    expect(offenders).toEqual([]);
  });

  it("keeps every Yopedia prose exemption earning its place, occurrence by occurrence", async () => {
    // A file-level waiver only fails at zero, which would let an exempt file
    // grow new "Yopedia" display copy forever — DW-236's exact failure mode.
    // Pinning the count makes BOTH directions a failure, and a path no scan
    // reads (typo, moved file) is just as dead as one with nothing to exempt.
    const byRelative = new Map(
      (await allBrandSources()).map((file) => [path.relative(ROOT, file), file]),
    );
    for (const [relative, expected] of YOPEDIA_PROSE_EXEMPT) {
      const full = byRelative.get(relative);
      expect(
        full,
        `${relative} is exempt from the yopedia scan but no source list reads it — fix the path or drop the exemption`,
      ).toBeDefined();
      const found = strayYopedia(await readFile(full as string, "utf8")).length;
      expect(
        found,
        `${relative} carries ${found} non-allowlisted "yopedia" occurrences, not the ${expected} pinned here. ` +
          `Fewer: lower the count, or delete the entry if it reached 0 so the file rejoins the scan. ` +
          `More: new Yopedia display prose landed — remove it rather than raising the count, unless it is genuinely this deployment's own history.`,
      ).toBe(expected);
    }
  });
});

describe("wire-protocol identifiers survive the display rename", () => {
  it("the queue-attempt header name matches on both sides", async () => {
    // The producer and the consumer are in different build units, so a rename
    // on one side type-checks fine and silently breaks retry accounting.
    const HEADER = "X-Yopedia-Queue-Attempt";
    const producer = await readFile(
      path.resolve(SRC, "../workers/task-consumer/index.ts"),
      "utf8",
    );
    const consumer = await readFile(
      path.join(SRC, "app/api/tasks/run/route.ts"),
      "utf8",
    );
    expect(producer).toContain(HEADER);
    expect(consumer).toContain(HEADER);
  });

  it("the sync script named by package.json exists on disk", async () => {
    // `scripts.sync` and the renamed companion script are a two-sided contract
    // like the header above: rename either side alone and every other test
    // stays green while `pnpm sync` — the owner's documented backup entry
    // point, also emitted by LocalSyncPanel — dies at startup with
    // ERR_MODULE_NOT_FOUND.
    const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
    const sync = pkg.scripts?.sync;
    expect(sync, "package.json must keep a scripts.sync entry").toBeTypeOf("string");
    // Tolerate runner flags (e.g. `node --enable-source-maps <path>`): the
    // contract is only that the command names an .mjs file that exists.
    const scriptPath = sync.split(/\s+/).find((token: string) => token.endsWith(".mjs"));
    expect(
      scriptPath,
      `scripts.sync ("${sync}") must invoke an .mjs script by path`,
    ).toBeDefined();
    expect((await stat(path.join(ROOT, scriptPath as string))).isFile()).toBe(true);
  });
});
