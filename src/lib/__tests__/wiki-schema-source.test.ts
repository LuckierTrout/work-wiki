/**
 * Story 1.2 — the Schema a Scenario Template seeds is the Schema that executes.
 *
 * AD-10 says there is ONE loader and no forked copy of the page conventions in
 * code. So `loadPageConventions()` (no argument — how ingest, query, and lint
 * call it) must read the ACTIVE Wiki's `schema.md`, and must degrade to the
 * repo-root `SCHEMA.md` when there is no owner, no Wiki, or an unreadable file.
 *
 * `loadPageTemplates()` stays on the root file: page templates are the engine's
 * own output shapes, not a Scenario Template, and a seeded `schema.md` has no
 * `## Page templates` section to find.
 *
 * This file also owns a second, separately-scoped concern: DW-19's single-owner
 * Schema resolution invariant (see the "single-owner Schema resolution
 * invariant" block below). That is about WHOSE Schema the no-argument loader
 * resolves, not about Wiki-vs-root precedence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { buildIngestSystemPrompt } from "../ingest";
import { _resetLocks } from "../lock";
import { buildQuerySystemPrompt } from "../query";
import { loadPageConventions, loadPageTemplates } from "../schema";
import { PAGE_CONVENTIONS_HEADING, extractSection } from "../schema-source";
import { _resetStorage, getStorage } from "../storage";
import { logger } from "../logger";
import {
  createWiki,
  readActiveWikiSchema,
  wikiArtifactPath,
  wikiRegistryPath,
} from "../wikis";

const OWNER = "alice";
/** A second tenant holding Wikis in the same deployment. Never the site owner. */
const OTHER_TENANT = "bob";

let tmpDir: string;
let originalDataDir: string | undefined;
let originalOwner: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-schema-"));
  originalDataDir = process.env.DATA_DIR;
  originalOwner = process.env.NEXT_PUBLIC_OWNER_HANDLE;
  process.env.DATA_DIR = tmpDir;
  process.env.NEXT_PUBLIC_OWNER_HANDLE = OWNER;
  _resetLocks();
  _resetStorage();
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalOwner === undefined) delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
  else process.env.NEXT_PUBLIC_OWNER_HANDLE = originalOwner;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("loadPageConventions resolves the active wiki's Schema", () => {
  it("returns the repo-root conventions when the registry is empty", async () => {
    const root = await loadPageConventions();
    expect(root).toContain("## Page conventions");
    // The root file documents the engine's kebab-case slug rule; a seeded
    // Scenario Template Schema does not.
    expect(root).toBe(await loadPageConventions(`${process.cwd()}/SCHEMA.md`));
  });

  it("returns the current wiki's conventions once one exists", async () => {
    const root = await loadPageConventions();
    await createWiki(OWNER, { name: "Shelf", scenario: "reading" });

    const active = await loadPageConventions();
    expect(active).toContain("## Page conventions");
    expect(active).not.toBe(root);
    // The reading template's own prose, projected into the executable Schema.
    expect(active).toContain("Preserve sequence when it matters");
  });

  it("adds the scenario's guidance without dropping the engine's rules", async () => {
    const root = await loadPageConventions();
    await createWiki(OWNER, { name: "Shelf", scenario: "reading" });
    const active = await loadPageConventions();

    // Everything the ingest/graph/index machinery relies on is still in the
    // prompt after a wiki is activated — this is the regression that would
    // silently degrade every generated page.
    for (const rule of [
      "/^[a-z0-9][a-z0-9-]*$/",
      "[Title](other-slug.md)",
      "Every page starts with an H1 title",
      "one-paragraph summary",
      "log.md",
    ]) {
      expect(root).toContain(rule);
      expect(active).toContain(rule);
    }
    expect(active).toContain("Preserve sequence when it matters");
    expect(active.length).toBeGreaterThan(root.length);
  });

  it("falls back to the root Schema when the wiki's conventions section is empty", async () => {
    const wiki = await createWiki(OWNER, { name: "Shelf", scenario: "reading" });
    // A hand-emptied schema.md must not silently strip the prompt to "".
    await fs.writeFile(
      path.join(tmpDir, wikiArtifactPath(OWNER, wiki.id, "schema.md")),
      "# Schema\n\n## Page conventions\n\n## Key questions\n\n- nothing\n",
    );
    expect(await loadPageConventions()).toBe(
      await loadPageConventions(`${process.cwd()}/SCHEMA.md`),
    );
  });

  it("follows the active pointer when a second wiki is created", async () => {
    await createWiki(OWNER, { name: "Shelf", scenario: "reading" });
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const active = await loadPageConventions();
    expect(active).toContain("Prefer explicit owners");
    expect(active).not.toContain("Preserve sequence when it matters");
  });

  it("falls back to the root Schema when the wiki's file cannot be read", async () => {
    const wiki = await createWiki(OWNER, { name: "Shelf", scenario: "reading" });
    await fs.rm(path.join(tmpDir, wikiArtifactPath(OWNER, wiki.id, "schema.md")));
    const conventions = await loadPageConventions();
    expect(conventions).toBe(await loadPageConventions(`${process.cwd()}/SCHEMA.md`));
  });

  it("falls back to the root Schema when no owner handle is configured", async () => {
    await createWiki(OWNER, { name: "Shelf", scenario: "reading" });
    delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
    expect(await loadPageConventions()).toBe(
      await loadPageConventions(`${process.cwd()}/SCHEMA.md`),
    );
  });

  it("respects an explicit path override, wiki or no wiki", async () => {
    await createWiki(OWNER, { name: "Shelf", scenario: "reading" });
    const explicit = path.join(tmpDir, "OTHER.md");
    await fs.writeFile(explicit, "# Other\n\n## Page conventions\n\nOnly this.\n");
    expect(await loadPageConventions(explicit)).toContain("Only this.");
  });
});

/**
 * The parameter list a function DECLARES, as source text.
 *
 * `Function.prototype.length` is not usable as a signature pin here: it stops
 * counting at the first default-valued parameter, so the most likely shape of
 * the multi-tenant migration — `readActiveWikiSchema(tenant = getOwnerHandle())`
 * — would leave `.length === 0` and the pin silently green. Reading the declared
 * parameter list catches required, optional AND defaulted parameters alike.
 *
 * A signature pin that can return "no parameters" for a function it failed to
 * parse is worse than no pin, so this throws rather than guessing. Two forms
 * would otherwise read as empty: a bound or native function (`[native code]`,
 * no parameter text at all), and an arrow with one unparenthesized parameter
 * (`async tenant => { … getOwnerHandle() … }`), where the first `(...)` in the
 * source is a call inside the BODY. Both are reachable refactors of the very
 * function under pin. Anchoring on a `function` declaration rejects them loudly.
 */
function declaredParams(fn: (...args: never[]) => unknown): string[] {
  const src = String(fn);
  const declaration = src.includes("[native code]")
    ? null
    : /^(?:async\s+)?function\s*\*?\s*[\w$]*\s*\(([^)]*)\)/.exec(src);
  if (!declaration) {
    throw new Error(
      `declaredParams: ${fn.name || "<anonymous>"} is no longer a plain function ` +
        `declaration, so its parameter list cannot be read (source starts: ` +
        `${src.slice(0, 60)}…). Re-express this pin for the new form — do not ` +
        `let it report an empty parameter list for a function it cannot parse.`,
    );
  }
  return declaration[1]
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
}

/**
 * DW-19 — the single-owner Schema resolution invariant.
 *
 * `readActiveWikiSchema()` resolves the tenant DEPLOYMENT-GLOBALLY from
 * `NEXT_PUBLIC_OWNER_HANDLE`, unlike every other tenant-scoped read/write in
 * the repo, which takes a passed-in owner. That is correct for a single-owner
 * deployment and load-bearing at the four no-argument `loadPageConventions()`
 * call sites. Two of them (`query.ts`, `ingest.ts`) sit beside a per-caller
 * `owner` that may be a different handle — those are pinned at their consumer
 * surface below. The other two (both `lint-checks.ts` detectors) have no owner
 * in scope at all and are covered only by the loader-level pins. These tests
 * exist so the resolution cannot drift into tenant-awareness — or into another
 * tenant's Wiki winning — silently.
 */
describe("single-owner Schema resolution invariant", () => {
  it("a second tenant's active Wiki never wins over the site owner's", async () => {
    // Both tenants hold an active Wiki in the same deployment; only the site
    // owner's may reach the loader. The site owner's Wiki is created FIRST so
    // the other tenant's is the newest in the deployment: a drift to a global,
    // non-owner-keyed "current Wiki" registry fails here rather than passing
    // because the owner happened to be last.
    await createWiki(OWNER, { name: "Shelf", scenario: "reading" });
    await createWiki(OTHER_TENANT, { name: "Ops", scenario: "business" });

    const active = await loadPageConventions();
    expect(active).toContain("Preserve sequence when it matters");
    expect(active).not.toContain("Prefer explicit owners");
  });

  it("follows NEXT_PUBLIC_OWNER_HANDLE rather than any fixed handle", async () => {
    // Every other test in this block leaves the env at `alice`, so on their
    // evidence alone the resolution could be hardcoded to `alice` — or picking
    // whichever tenant it happens to find first — and still look correct.
    // Repointing the site owner is what proves the env var IS the resolution.
    await createWiki(OWNER, { name: "Shelf", scenario: "reading" });
    await createWiki(OTHER_TENANT, { name: "Ops", scenario: "business" });

    process.env.NEXT_PUBLIC_OWNER_HANDLE = OTHER_TENANT; // restored in afterEach

    const active = await loadPageConventions();
    expect(active).toContain("Prefer explicit owners");
    expect(active).not.toContain("Preserve sequence when it matters");
  });

  it("a non-owner tenant's Wiki alone still falls back to the repo-root Schema", async () => {
    await createWiki(OTHER_TENANT, { name: "Ops", scenario: "business" });

    const conventions = await loadPageConventions();
    // Non-vacuity guard: `toBe` alone would pass with both sides `""` (root
    // SCHEMA.md missing, or its heading renamed), which proves nothing.
    expect(conventions).toContain("## Page conventions");
    expect(conventions).toBe(
      await loadPageConventions(`${process.cwd()}/SCHEMA.md`),
    );
    // Never the other tenant's Scenario Template prose.
    expect(conventions).not.toContain("Prefer explicit owners");
  });

  /**
   * Give both tenants an active Wiki seeded from different Scenario Templates,
   * and return each one's full `## Page conventions` section.
   *
   * The assertions below compare whole SECTIONS, not marker phrases. A scenario
   * template's one-line `pageConventions` string is reused verbatim in the
   * owner's WORKSPACE PROFILE block, which IS legitimately per-caller — so
   * `expect(prompt).not.toContain("Prefer explicit owners")` would fail against
   * a correct prompt. The full section (engine rules + scenario prose) appears
   * only where the Schema was resolved, which is the thing under test.
   */
  async function seedBothTenants() {
    // Owner first, other tenant second — same ordering rationale as the
    // behavioral pin above: the newest Wiki in the deployment must not be the
    // owner's, or "newest wins" drift would pass for the wrong reason.
    await createWiki(OWNER, { name: "Shelf", scenario: "reading" });
    const otherWiki = await createWiki(OTHER_TENANT, {
      name: "Ops",
      scenario: "business",
    });

    const ownerConventions = await loadPageConventions();
    const otherSchema = await fs.readFile(
      path.join(tmpDir, wikiArtifactPath(OTHER_TENANT, otherWiki.id, "schema.md")),
      "utf8",
    );
    const otherConventions = extractSection(otherSchema, PAGE_CONVENTIONS_HEADING);

    // Non-vacuity: the two sections must exist and actually differ, or the
    // `toContain`/`not.toContain` pair below proves nothing.
    expect(ownerConventions).toContain("Preserve sequence when it matters");
    expect(otherConventions).toContain("Prefer explicit owners");
    expect(otherConventions).not.toBe(ownerConventions);

    return { ownerConventions, otherConventions };
  }

  it("gives a non-owner ingest caller the SITE OWNER's conventions", async () => {
    const { ownerConventions, otherConventions } = await seedBothTenants();

    // `owner` here is the per-caller principal — it can be `"system"`, an agent
    // handle, or another tenant. It must NOT steer the Schema resolution.
    const prompt = await buildIngestSystemPrompt(OTHER_TENANT);
    expect(prompt).toContain(ownerConventions);
    expect(prompt).not.toContain(otherConventions);
  });

  it("gives a non-owner query caller the SITE OWNER's conventions", async () => {
    const { ownerConventions, otherConventions } = await seedBothTenants();

    const prompt = await buildQuerySystemPrompt("", [], [], "prose", OTHER_TENANT);
    expect(prompt).toContain(ownerConventions);
    expect(prompt).not.toContain(otherConventions);
  });

  it("warns and falls back to the root Schema when the registry is unparseable", async () => {
    // DW-155 — the catch branch inside `readActiveWikiSchema()`.
    //
    // The mechanism this fixture depends on: `readRegistry` catches ENOENT and
    // ONLY ENOENT, so `JSON.parse` on a corrupt `tenants/<t>/wikis.json` throws
    // a SyntaxError that propagates out of `getCurrentWiki` into the catch.
    // Writing an EMPTY or `{}` registry would not reach that branch — it parses
    // fine and degrades through the null-Wiki path, which the tests above
    // already cover. The bytes must be genuinely unparseable.
    await createWiki(OWNER, { name: "Shelf", scenario: "reading" });
    await fs.writeFile(
      path.join(tmpDir, wikiRegistryPath(OWNER)),
      "{ this is not JSON",
    );

    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const conventions = await loadPageConventions();

      // Non-vacuity guard: `toBe` alone would pass with both sides `""`.
      expect(conventions).toContain("## Page conventions");
      expect(conventions).toBe(
        await loadPageConventions(`${process.cwd()}/SCHEMA.md`),
      );
      // Never the Wiki whose registry we just corrupted.
      expect(conventions).not.toContain("Preserve sequence when it matters");
      // Silent fallback is the failure mode this branch exists to prevent: a
      // misconfigured owner or an unreadable registry would otherwise serve the
      // wrong Schema forever with nothing to diagnose from. So assert the warn
      // is DIAGNOSABLE, not merely present — a warn whose message and payload
      // were emptied is the same undiagnosable outcome wearing a tag.
      //
      // Filtered to the `"wikis"` tag rather than counting every warn: an
      // unrelated warn from another module would otherwise fail this spuriously.
      const wikiWarns = warn.mock.calls.filter((call) => call[0] === "wikis");
      expect(wikiWarns).toHaveLength(1);
      const [, message, ...rest] = wikiWarns[0];
      // Names WHO failed to resolve and WHAT the caller got instead.
      expect(message).toContain(OWNER);
      expect(message).toContain("SCHEMA.md");
      // And carries the underlying error, or the log says a fallback happened
      // without saying why.
      expect(rest.some((arg) => arg instanceof Error)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("resolves the owner's Wiki when the env handle differs in CASE", async () => {
    // DW-156 — case normalization at the Schema path, not just in isolation.
    // `ownerToTenant` lowercases the handle into the tenant path segment, so a
    // deployment configured as `Alice` must reach the same silo as `alice`.
    const wiki = await createWiki(OWNER, { name: "Shelf", scenario: "reading" });

    // Both address functions must collapse the case, not just the registry one.
    expect(wikiRegistryPath("Alice")).toBe(wikiRegistryPath(OWNER));
    expect(wikiArtifactPath("Alice", wiki.id, "schema.md")).toBe(
      wikiArtifactPath(OWNER, wiki.id, "schema.md"),
    );

    process.env.NEXT_PUBLIC_OWNER_HANDLE = "Alice"; // restored in afterEach

    // The behavioral assertion alone is NOT enough on this platform: macOS's
    // default APFS is case-INSENSITIVE, so `tenants/Alice/wikis.json` and
    // `tenants/alice/wikis.json` are the same file and the read would succeed
    // with the normalization removed. Watch the storage provider instead and
    // assert on the KEY the Schema path asked for — that is filesystem-
    // independent, and it pins the normalization where DW-156 lives (the Schema
    // resolution) rather than on the isolated path helper.
    //
    // Literal strings on purpose: routing the expectation back through
    // `wikiRegistryPath(...)` would compare the normalizer against itself.
    const storage = getStorage();
    const readFile = vi.spyOn(storage, "readFile");
    try {
      const active = await loadPageConventions();
      expect(active).toContain("Preserve sequence when it matters");

      const requested = readFile.mock.calls.map((call) => call[0]);
      expect(requested).toContain("tenants/alice/wikis.json");
      expect(requested.some((key) => key.includes("tenants/Alice/"))).toBe(false);
    } finally {
      readFile.mockRestore();
    }
  });

  it("trims AND lowercases the env handle at the Schema path", async () => {
    // Composition of the two normalizations `ownerToTenant` applies. A handle
    // configured with stray whitespace is a real deployment mistake, and it
    // must land in the same silo as the clean lowercase form rather than
    // creating `tenants/-alice-/`.
    await createWiki(OWNER, { name: "Shelf", scenario: "reading" });
    process.env.NEXT_PUBLIC_OWNER_HANDLE = "  Alice  "; // restored in afterEach

    const storage = getStorage();
    const readFile = vi.spyOn(storage, "readFile");
    try {
      const active = await loadPageConventions();
      expect(active).toContain("Preserve sequence when it matters");

      const requested = readFile.mock.calls.map((call) => call[0]);
      expect(requested).toContain("tenants/alice/wikis.json");
    } finally {
      readFile.mockRestore();
    }
  });

  it("resolves a Wiki CREATED under a differently-cased handle", async () => {
    // The other side of the same normalization: the Wiki is created for
    // `"Alice"` while the env names `"alice"`. Case must never split one owner
    // into two silos, in either direction.
    expect(wikiRegistryPath(OWNER)).toBe(wikiRegistryPath("Alice"));

    await createWiki("Alice", { name: "Shelf", scenario: "reading" });
    expect(process.env.NEXT_PUBLIC_OWNER_HANDLE).toBe(OWNER);

    const active = await loadPageConventions();
    expect(active).toContain("Preserve sequence when it matters");
  });

  it("declares no tenant parameter on either resolution entry point", () => {
    // Signature pin, read from the DECLARED parameter list rather than
    // `.length` — see `declaredParams` above for why `.length` is not enough.
    //
    // `readActiveWikiSchema()` must keep an empty parameter list: it gets its
    // tenant from the environment, by design. `loadPageConventions()` must keep
    // exactly one, the test-only `schemaPath` override.
    //
    // Adding a tenant parameter to either — required, optional, or defaulted —
    // trips this, which is the point: making the Schema resolution tenant-aware
    // must be a deliberate, test-updating change, not a silent slide into
    // multi-tenancy. If this fails, do not just widen the assertion: confirm the
    // behavioral and consumer-surface pins above still hold, and that every
    // no-argument call site now passes its own tenant.
    expect(declaredParams(readActiveWikiSchema)).toEqual([]);
    const conventionsParams = declaredParams(loadPageConventions);
    expect(conventionsParams).toHaveLength(1);
    expect(conventionsParams[0]).toMatch(/^schemaPath\b/);
  });
});

describe("loadPageTemplates stays on the repo-root SCHEMA.md", () => {
  it("is unaffected by an active wiki", async () => {
    const before = await loadPageTemplates();
    await createWiki(OWNER, { name: "Shelf", scenario: "reading" });
    const after = await loadPageTemplates();
    expect(before).toContain("## Page templates");
    expect(after).toBe(before);
  });
});
