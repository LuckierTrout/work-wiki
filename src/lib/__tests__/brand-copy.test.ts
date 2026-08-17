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

async function walk(dir: string, include: RegExp = TS_SOURCES): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...(await walk(full, include)));
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
      if ((await readFile(file, "utf8")).includes("WorkWiki")) {
        offenders.push(path.relative(SRC, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("actually reads every surface the maintainer sweep covered", async () => {
    // Same vacuousness guard as the clipper canary above: pin the five swept
    // files by name so a relocated file or a filter that stops matching fails
    // here instead of silently shrinking the scan.
    const scanned = (await maintainerSources()).map((f) => path.relative(ROOT, f));
    for (const file of [
      path.join("tools", "work-wiki-sync.mjs"),
      path.join("tools", "WORKWIKI_SYNC.md"),
      "BACKLOG.md",
      path.join("docs", "llm-wiki-functional-parity-roadmap.md"),
      path.join("workers", "sandbox-runner", "README.md"),
    ]) {
      expect(scanned).toContain(file);
    }
  });

  it('no maintainer-facing file says "WorkWiki"', async () => {
    const offenders: string[] = [];
    for (const file of await maintainerSources()) {
      if ((await readFile(file, "utf8")).includes("WorkWiki")) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
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
