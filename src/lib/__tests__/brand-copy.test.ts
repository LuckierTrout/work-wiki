/**
 * AD-7 / Story 1.1: the rebrand is DISPLAY-ONLY.
 *
 * User-visible copy says `work-wiki`. Every runtime identifier — tenants, owner
 * constants, MCP server name, localStorage keys, `YOPEDIA_*` env/secret names,
 * `X-Yopedia-*` headers, Cloudflare resource names — stays `yopedia`, because
 * renaming those orphans production R2/KV/Queue data.
 *
 * The source scan below is deliberately crude: it reads the app and component
 * trees as text and fails on any stray brand string. That is the only way to
 * stop a future edit from reintroducing "Yopedia" into rendered copy.
 */
import { describe, expect, it } from "vitest";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { APP_NAME, APP_TITLE } from "../brand";
import manifest from "../../app/manifest";

const SRC = path.resolve(__dirname, "../..");

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
  /yologdev\/yopedia/g, // upstream repo link (AGENTS.md says leave it)
];

/** TypeScript sources — the default for the Next tree and the Workers. */
const TS_SOURCES = /\.tsx?$/;
/**
 * The browser clipper ships no TypeScript at all: its rendered copy lives in
 * HTML, JS, JSON (the extension name/description) and its README. A `.tsx?`
 * filter over that tree matches nothing, which is how a scan can look like it
 * covers the clipper while reading zero files.
 */
const CLIPPER_SOURCES = /\.(html|js|json|css|md)$/;

/**
 * `skipDirs` is per-call on purpose. A globally-skipped directory name would
 * silently shrink `scannedSources()` too — a future `dist/` under `src/`,
 * `integrations/` or `workers/` would drop out of the brand scan without any
 * test noticing, which is the quiet vacuity the pin tests exist to prevent.
 */
async function walk(
  dir: string,
  include: RegExp = TS_SOURCES,
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
    ...(await walk(path.resolve(SRC, "../workers"))),
    // The browser clipper ships its own UI (popup, extension name, context
    // menu) outside the Next tree, so an `src/`-only scan never saw it. It has
    // no TypeScript, hence its own extension filter.
    ...(await walk(INTEGRATIONS, CLIPPER_SOURCES)),
  ];
  return files;
}

const ROOT = path.resolve(SRC, "..");
const MARKDOWN = /\.md$/;
const ANY_FILE = /(?:)/;
/**
 * Human-authored text under `public/` and `journal-site/`. Those trees also
 * carry fonts and images, which `readFile(..., "utf8")` would happily decode
 * into mojibake — so gate them by extension rather than reading everything.
 */
const TEXT_SOURCES = /\.(?:md|mjs|cjs|js|ts|json|jsonc|css|html|svg|txt|ya?ml|sh)$/;

/**
 * Every `workwiki` spelling that is a frozen operator identifier, not display
 * copy. Renaming any of them breaks an existing operator setup: the env names
 * are read by `tools/work-wiki-sync.mjs`, the origin is production, and the
 * lowercase-hyphen family names on-disk backup state.
 */
const WORKWIKI_IDENTIFIER_ALLOWLIST = [
  // Env/secret names, which all carry the underscore. Requiring it matters now
  // that markdown roots are scanned: bare all-caps is ordinary heading style
  // there ("## WORKWIKI SETUP"), so `WORKWIKI[A-Z0-9_]*` would wave prose through.
  /\bWORKWIKI_[A-Z0-9_]*\b/g,
  /workwiki\.app/g, // the production origin
  // The lowercase-hyphen family: on-disk state and archive names. Anchored to the
  // documented artifacts, so display prose ("workwiki-first") is NOT swallowed.
  /\.?workwiki-(?:source-sync|backups|portable-archive|archive|[*.$0-9])/g,
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
 */
function strayWorkwiki(text: string): string[] {
  let rest = text;
  for (const pattern of WORKWIKI_IDENTIFIER_ALLOWLIST) rest = rest.replace(pattern, "");
  return rest.match(/\S*workwiki\S*/gi) ?? [];
}

function hasStrayWorkwiki(text: string): boolean {
  return strayWorkwiki(text).length > 0;
}

/**
 * Maintainer-facing surfaces the DW-10 sweep covered: operator tooling and the
 * repo's markdown documentation. These are scanned ONLY for the stale
 * "WorkWiki" display name — deliberately NOT folded into `scannedSources()`,
 * because root markdown legitimately carries capital-Y "Yopedia" prose and
 * `yologdev/yopedia` upstream links (AGENTS.md says never "fix" them), which
 * would fail the yopedia-identifier test below.
 *
 * The root markdown listing is deliberately NON-recursive: process artifacts
 * under `_bmad-output/` (historical specs, the deferred-work ledger)
 * legitimately carry the old "WorkWiki" string, so a recursive walk would fail
 * the suite for a non-obvious reason.
 *
 * `public/`, `scripts/`, `journal-site/` and `.opencode/commands/` are operator
 * and owner-facing too — the served API guide, the Cloudflare setup script, the
 * journal static site, and the slash-command docs — and none of them were read
 * by the DW-10 sweep, so brand drift there was invisible.
 */
async function maintainerSources(): Promise<string[]> {
  const rootMarkdown = (await readdir(ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && MARKDOWN.test(entry.name))
    .map((entry) => path.join(ROOT, entry.name));
  return [
    ...(await walk(path.join(ROOT, "tools"), ANY_FILE)),
    ...rootMarkdown,
    ...(await walk(path.join(ROOT, "docs"), MARKDOWN)),
    ...(await walk(path.join(ROOT, "workers"), MARKDOWN)),
    // Served to users and agents (`public/agent-api.md` is the published API
    // guide), so its copy is as brand-visible as anything in the app tree.
    ...(await walk(path.join(ROOT, "public"), TEXT_SOURCES)),
    // Operator scripts, read like `tools/` — every file, whatever the extension.
    ...(await walk(path.join(ROOT, "scripts"), ANY_FILE)),
    // The journal static site's generator (`build.mjs`) emits the site's
    // headings; its CSS and JS carry no brand string today, and are read so a
    // future one can't land unseen. `dist/` is gitignored build output —
    // present on a developer's machine, absent in CI — so scanning it would
    // make the result depend on whether someone happened to run a build.
    ...(await walk(path.join(ROOT, "journal-site"), TEXT_SOURCES, ["dist"])),
    ...(await walk(path.join(ROOT, ".opencode", "commands"), MARKDOWN)),
  ];
}

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

  it('no scanned source says "WorkWiki"', async () => {
    const offenders: string[] = [];
    for (const file of await scannedSources()) {
      if (saysStaleDisplayName(await readFile(file, "utf8"))) {
        offenders.push(path.relative(SRC, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("actually reads every surface the maintainer sweep covered", async () => {
    // Same vacuousness guard as the clipper canary above: pin one file per
    // scanned root by name so a relocated file or a filter that stops matching
    // fails here instead of silently shrinking the scan.
    const scanned = (await maintainerSources()).map((f) => path.relative(ROOT, f));
    for (const file of [
      path.join("tools", "work-wiki-sync.mjs"),
      path.join("tools", "work-wiki-sync.md"),
      "BACKLOG.md",
      path.join("docs", "llm-wiki-functional-parity-roadmap.md"),
      path.join("workers", "sandbox-runner", "README.md"),
      path.join("public", "agent-api.md"),
      path.join("scripts", "setup-cloudflare.sh"),
      path.join("journal-site", "build.mjs"),
    ]) {
      expect(scanned).toContain(file);
    }
    // `.opencode/commands/` holds only BMAD-installer-generated docs, so
    // pinning one by name would fail this suite on an upstream rename for a
    // reason with nothing to do with branding. Assert the root contributes.
    const opencode = scanned.filter((f) => f.startsWith(path.join(".opencode", "commands") + path.sep));
    expect(
      opencode.length,
      "maintainerSources() must read .opencode/commands — the root went vacuous",
    ).toBeGreaterThan(0);
  });

  it('no maintainer-facing file says "WorkWiki"', async () => {
    const offenders: string[] = [];
    for (const file of await maintainerSources()) {
      if (saysStaleDisplayName(await readFile(file, "utf8"))) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every maintainer-facing "workwiki" is a frozen operator identifier', async () => {
    // Strictly stronger than the literal "WorkWiki" check above: it also
    // catches case variants ("Workwiki", "workwiki" as prose). The literal
    // check stays because it gives the common regression a crisper message.
    const offenders: string[] = [];
    for (const file of await maintainerSources()) {
      const stray = strayWorkwiki(await readFile(file, "utf8"));
      if (stray.length > 0) {
        offenders.push(`${path.relative(ROOT, file)}: ${[...new Set(stray)].join(", ")}`);
      }
    }
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
    ]) {
      expect(hasStrayWorkwiki(slip), slip).toBe(true);
    }
    // The literal check is a STRICT SUBSET of the stray check: it catches the
    // exact "WorkWiki" casing only, and must stay blind to the variants above.
    expect(saysStaleDisplayName("keeping WorkWiki cloud-first")).toBe(true);
    expect(saysStaleDisplayName("the Workwiki worker")).toBe(false);
    expect(saysStaleDisplayName("the workwiki-first approach")).toBe(false);
  });

  it('every remaining "yopedia" is a runtime identifier', async () => {
    const offenders: string[] = [];
    for (const file of await scannedSources()) {
      let text = await readFile(file, "utf8");
      for (const pattern of IDENTIFIER_ALLOWLIST) text = text.replace(pattern, "");
      if (/yopedia/i.test(text)) offenders.push(path.relative(SRC, file));
    }
    expect(offenders).toEqual([]);
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
