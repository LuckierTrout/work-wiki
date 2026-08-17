/**
 * Story 1.8 — the Schema an owner edits is the Schema that executes.
 *
 * FR-34's second half: `schema.md` is the executable artifact
 * `loadPageConventions()` hands to every ingest, chat and lint prompt, and until
 * this story nothing in the app could change it. What that story ships is
 * invisible when it works, so the two things most likely to rot silently are
 * pinned here directly: the WRITE TAIL (the activity log and the `dataVersion`
 * bump an artifact write owes, both fail-soft) and the TARGET SELECTION (which
 * URL `Save` posts to, and whether the row on screen is still the row the draft
 * came from).
 *
 * Everything a node suite can execute is executed: the route for each status
 * against a real temp `DATA_DIR`, the writer for the bytes, and the pure
 * decisions directly. `vitest.config.ts` is `environment: "node"` with no DOM
 * (DW-15), so the wiring inside `PreviewColumn` and the two routes is the one
 * thing left to a source scan — and it is scoped to the specific lines a
 * rewrite would keep the wording of while changing the behaviour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

/**
 * The route's gate is `getPrincipal()`. Hoisted so it governs the whole file:
 * there is no Clerk session in a node suite, and what is under test is what the
 * route does WITH a principal, not how it gets one.
 */
const principal = vi.hoisted(() => ({ current: null as { id: string; handle: string } | null }));
vi.mock("@/lib/auth", () => ({
  getPrincipal: vi.fn(async () => principal.current),
}));

import { readDataVersion } from "../data-version";
import { _resetLocks } from "../lock";
import { loadPageConventions } from "../schema";
import {
  PAGE_CONVENTIONS_HEADING,
  PAGE_CONVENTIONS_REQUIRED_COPY,
  hasPageConventions,
  readEnginePageConventions,
} from "../schema-source";
import { _resetStorage, getStorage } from "../storage";
import { listWikiPages, wikiRelPath } from "../wiki";
import { readLog } from "../wiki-log";
import {
  CREATABLE_SCENARIOS,
  EDITABLE_ARTIFACT_FILES,
  WIKI_ARTIFACT_FILES,
  isEditableArtifactFile,
  renderSchemaMarkdown,
  scenarioTemplate,
  type WikiArtifactFile,
} from "../wiki-scenarios";
import {
  createWiki,
  readWikiArtifact,
  wikiArtifactPath,
  writeWikiArtifact,
  type WikiRecord,
} from "../wikis";
import {
  PREVIEW_EDIT_CONFIRM_BODY,
  PREVIEW_EDIT_CONFIRM_TITLE,
  PREVIEW_EDIT_SCHEMA_CONFIRM_BODY,
  PREVIEW_EDIT_SCHEMA_CONFIRM_TITLE,
  PREVIEW_MAX_CHARS,
  PREVIEW_SAVE_FAILED_COPY,
  PREVIEW_SCHEMA_SAVE_FAILED_COPY,
  canEditPreview,
  previewEditCopy,
  previewWriteTarget,
  type PreviewPayload,
} from "../workbench-preview";

const OWNER = "yuanhao";
const COMPONENTS = path.resolve(__dirname, "../../components/workbench");
const ROUTES = path.resolve(__dirname, "../../app/api");

/** A Schema whose conventions section actually carries something. */
const EDITED = [
  "# Schema — edited by hand",
  "",
  PAGE_CONVENTIONS_HEADING,
  "",
  "Every page names the meeting it came from.",
  "",
  "## Key questions",
  "",
  "- what changed",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// The conventions predicate — the loader's own primitives, not a second parser
// ---------------------------------------------------------------------------

describe("hasPageConventions", () => {
  it("accepts a section with a body", () => {
    expect(hasPageConventions(EDITED)).toBe(true);
    // `###` does not terminate a `##` section, so a sub-heading is still inside.
    expect(
      hasPageConventions(`${PAGE_CONVENTIONS_HEADING}\n\n### Scenario\n\nrules\n`),
    ).toBe(true);
  });

  it("refuses a Schema the prompt would find nothing in", () => {
    // Missing entirely.
    expect(hasPageConventions("# Schema\n\n## Key questions\n\n- one\n")).toBe(false);
    // Present, but empty — the case that makes `loadPageConventions()` fall back
    // to the repo-root file, i.e. the case where a "successful" save leaves the
    // owner's Schema steering nothing at all.
    expect(
      hasPageConventions(`# Schema\n\n${PAGE_CONVENTIONS_HEADING}\n\n## Key questions\n\n- one\n`),
    ).toBe(false);
    expect(hasPageConventions(`${PAGE_CONVENTIONS_HEADING}\n`)).toBe(false);
    expect(hasPageConventions(`${PAGE_CONVENTIONS_HEADING}\n\n   \n`)).toBe(false);
    expect(hasPageConventions("")).toBe(false);
  });

  it("refuses a non-string without the caller having to narrow first", () => {
    // Its first caller validates a field off a parsed JSON body, so `unknown` is
    // the honest signature — a `string` parameter would make the guard
    // unreachable on paper and force this test through a cast.
    for (const value of [undefined, null, 3, {}, ["## Page conventions\n\nx"]]) {
      expect(hasPageConventions(value)).toBe(false);
    }
  });

  it("agrees with the loader about what counts, because it runs the same primitives", async () => {
    // Not two rules that happen to match today. If this predicate ever gained a
    // regex of its own, this is where the two would part company.
    const source = await fs.readFile(path.resolve(__dirname, "../schema-source.ts"), "utf8");
    const fn = source.slice(
      source.indexOf("export function hasPageConventions"),
      source.indexOf("export const PAGE_CONVENTIONS_REQUIRED_COPY"),
    );
    expect(fn).toContain("sectionBody(extractSection(content, PAGE_CONVENTIONS_HEADING))");
    expect(fn).not.toMatch(/\/.*Page conventions.*\//);
  });

  it("names the section in the sentence it is refused with", () => {
    expect(PAGE_CONVENTIONS_REQUIRED_COPY).toContain(PAGE_CONVENTIONS_HEADING);
  });

  it("is written in the same register as every sibling sentence", () => {
    // Typographic marks, not straight quotes — `couldn’t` / `Wiki’s` are the
    // house style, and one straight `"` in a dialog beside them reads as a bug.
    expect(PAGE_CONVENTIONS_REQUIRED_COPY).toContain("“");
    expect(PAGE_CONVENTIONS_REQUIRED_COPY).toContain("”");
    expect(PAGE_CONVENTIONS_REQUIRED_COPY).not.toContain('"');
    // `Wiki` is the domain noun everywhere else in this epic.
    for (const sentence of [
      PAGE_CONVENTIONS_REQUIRED_COPY,
      PREVIEW_EDIT_SCHEMA_CONFIRM_TITLE,
    ]) {
      expect(sentence).not.toMatch(/\bwiki\b/);
    }
  });
});

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

describe("EDITABLE_ARTIFACT_FILES", () => {
  it("is the Schema alone, and a strict subset of the seeded artifacts", () => {
    expect(EDITABLE_ARTIFACT_FILES).toEqual(["schema.md"]);
    for (const file of EDITABLE_ARTIFACT_FILES) {
      expect(WIKI_ARTIFACT_FILES).toContain(file);
    }
    // `purpose.md` is deliberately out of scope: it has no runtime reader and
    // its content overlaps the tenant-global workspace profile, whose
    // reconciliation this story does not own.
    expect(EDITABLE_ARTIFACT_FILES).not.toContain("purpose.md");
  });

  it("refuses everything that is not exactly that name", () => {
    expect(isEditableArtifactFile("schema.md")).toBe(true);
    for (const value of [
      "purpose.md",
      "wiki/schema.md",
      "schema.MD",
      "../schema.md",
      "",
      null,
      undefined,
      3,
      ["schema.md"],
    ]) {
      expect(isEditableArtifactFile(value)).toBe(false);
    }
  });

  it("is carried by the writer's own TYPE, not by the route alone", async () => {
    // The route is not the only thing that can reach `writeWikiArtifact`. If its
    // parameter were the seeded set, a future caller could write `purpose.md`
    // through the one writer without ever passing `isEditableArtifactFile` — and
    // the log line, which names the Schema, would then be a lie.
    const seededOnly = "purpose.md" as WikiArtifactFile;
    const refused = () =>
      // @ts-expect-error — `writeWikiArtifact` takes `EditableArtifactFile`, so
      // the compiler refuses the wider seeded type. Widening the parameter back
      // makes this directive unused and `npx tsc --noEmit` fails.
      writeWikiArtifact(OWNER, "11111111-2222-4333-8444-555555555555", seededOnly, "x");
    expect(typeof refused).toBe("function");

    // …and the same guarantee pinned where `vitest` can see it, since a suite
    // that never type-checks would stay green on the widened signature.
    const wikis = await fs.readFile(path.resolve(__dirname, "../wikis.ts"), "utf8");
    expect(wikis).toMatch(
      /export async function writeWikiArtifact\(\s*owner: string,\s*wikiId: string,\s*file: EditableArtifactFile,/,
    );
  });
});

// ---------------------------------------------------------------------------
// The two decisions the column cannot make in a DOM
// ---------------------------------------------------------------------------

describe("previewEditCopy", () => {
  const page: PreviewPayload = {
    name: "Alpha",
    path: "wiki/alpha.md",
    slug: "alpha",
    format: "markdown",
    body: "# Alpha\n",
    truncated: false,
    editable: true,
  };
  const schema: PreviewPayload = {
    name: "schema.md",
    path: "schema.md",
    artifact: "schema.md",
    format: "markdown",
    body: EDITED,
    truncated: false,
    editable: true,
  };

  it("names the Schema rather than a page when the Schema is what is open", () => {
    const copy = previewEditCopy(previewWriteTarget(schema));
    expect(copy.confirmTitle).toBe(PREVIEW_EDIT_SCHEMA_CONFIRM_TITLE);
    expect(copy.confirmBody).toBe(PREVIEW_EDIT_SCHEMA_CONFIRM_BODY);
    expect(copy.saveFallback).toBe(PREVIEW_SCHEMA_SAVE_FAILED_COPY);
    // The consequence is the reason this copy exists at all: a page edit changes
    // one page, a Schema edit changes every prompt that runs afterwards.
    expect(copy.confirmBody).toContain("ingest, chat and lint");
    expect(copy.confirmTitle.toLowerCase()).not.toContain("page");
  });

  it("keeps Story 1.5's page copy for a page, unchanged", () => {
    const copy = previewEditCopy(previewWriteTarget(page));
    expect(copy.confirmTitle).toBe(PREVIEW_EDIT_CONFIRM_TITLE);
    expect(copy.confirmBody).toBe(PREVIEW_EDIT_CONFIRM_BODY);
    expect(copy.saveFallback).toBe(PREVIEW_SAVE_FAILED_COPY);
  });

  it("is total, so a payload with no target still renders a dialog", () => {
    // Unreachable — `canEditPreview` is the same predicate — but a `null` here
    // must not throw during a render.
    expect(previewEditCopy(null).confirmTitle).toBe(PREVIEW_EDIT_CONFIRM_TITLE);
  });

  it("says work-wiki, never the runtime identifier", () => {
    for (const sentence of [
      PREVIEW_EDIT_SCHEMA_CONFIRM_TITLE,
      PREVIEW_EDIT_SCHEMA_CONFIRM_BODY,
      PREVIEW_SCHEMA_SAVE_FAILED_COPY,
      PAGE_CONVENTIONS_REQUIRED_COPY,
    ]) {
      expect(sentence).not.toMatch(/yopedia/i);
      // English-only build.
      expect(sentence).not.toMatch(/[一-鿿]/);
    }
  });

  it("routes the Schema somewhere other than the page write path", () => {
    expect(previewWriteTarget(schema)?.url).not.toContain("/api/wiki/");
    expect(canEditPreview(schema)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The writer and the route, against a real temp DATA_DIR
// ---------------------------------------------------------------------------

describe("editing the Schema", () => {
  let tmpDir: string;
  let originalDataDir: string | undefined;
  let originalOwner: string | undefined;
  let originalWikiDir: string | undefined;
  let originalRawDir: string | undefined;
  let originalReadOnly: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-schema-edit-"));
    originalDataDir = process.env.DATA_DIR;
    originalOwner = process.env.NEXT_PUBLIC_OWNER_HANDLE;
    originalWikiDir = process.env.WIKI_DIR;
    originalRawDir = process.env.RAW_DIR;
    originalReadOnly = process.env.YOPEDIA_READONLY;
    process.env.DATA_DIR = tmpDir;
    process.env.NEXT_PUBLIC_OWNER_HANDLE = OWNER;
    process.env.WIKI_DIR = path.join(tmpDir, "wiki");
    process.env.RAW_DIR = path.join(tmpDir, "raw");
    delete process.env.YOPEDIA_READONLY;
    await fs.mkdir(process.env.WIKI_DIR, { recursive: true });
    await fs.mkdir(process.env.RAW_DIR, { recursive: true });
    _resetLocks();
    _resetStorage();
    principal.current = { id: "u1", handle: OWNER };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    principal.current = null;
    for (const [key, value] of [
      ["DATA_DIR", originalDataDir],
      ["NEXT_PUBLIC_OWNER_HANDLE", originalOwner],
      ["WIKI_DIR", originalWikiDir],
      ["RAW_DIR", originalRawDir],
      ["YOPEDIA_READONLY", originalReadOnly],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetStorage();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** The READ handler, for the round trip a lossy strip would break. */
  async function get(query: string): Promise<Response> {
    const { GET } = await import("@/app/api/workbench/preview/route");
    return GET(new Request(`http://localhost/api/workbench/preview?${query}`));
  }

  /** The handler, imported lazily so the env above is in place first. */
  async function put(query: string, body: unknown): Promise<Response> {
    const { PUT } = await import("@/app/api/workbench/artifact/route");
    return PUT(
      new Request(`http://localhost/api/workbench/artifact${query}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  }

  async function seed(): Promise<WikiRecord> {
    return createWiki(OWNER, { name: "Field notes", scenario: "research" });
  }

  async function readSchema(wiki: WikiRecord): Promise<string> {
    return (await readWikiArtifact(OWNER, wiki.id, "schema.md")) ?? "";
  }

  // -------------------------------------------------------------------------
  // The writer
  // -------------------------------------------------------------------------

  it("lands the bytes at the artifact path, logs the edit and bumps the signal", async () => {
    const wiki = await seed();
    const before = await readDataVersion();

    await writeWikiArtifact(OWNER, wiki.id, "schema.md", EDITED);

    // Exactly where `readActiveWikiSchema()` looks — deliberately outside
    // `tenants/<t>/wiki/`, where `reconcileSilos()` would sweep it away.
    const abs = path.join(tmpDir, wikiArtifactPath(OWNER, wiki.id, "schema.md"));
    await expect(fs.readFile(abs, "utf-8")).resolves.toBe(EDITED);
    expect(await readSchema(wiki)).toBe(EDITED);

    // The tail an artifact actually has: the activity log…
    const log = (await readLog()) ?? "";
    expect(log.match(/^## \[\d{4}-\d{2}-\d{2}\] edit \| /gm) ?? []).toHaveLength(1);
    expect(log).toContain("schema.md");
    // `wiki/log.md` is tenant-global and `schema.md` is per Wiki, so the entry
    // has to carry the id or the log cannot say WHOSE Schema moved once the
    // owner has a second Wiki. Still ONE entry — the id is its details line.
    expect(log).toContain(`Wiki: ${wiki.id}`);
    // …and the refresh counter, exactly one higher.
    expect(await readDataVersion()).toBe(before + 1);
  });

  it("changes nothing else — no page, no index entry, no page count", async () => {
    const wiki = await seed();
    const pagesBefore = await listWikiPages();
    const purposeBefore = await readWikiArtifact(OWNER, wiki.id, "purpose.md");

    await writeWikiArtifact(OWNER, wiki.id, "schema.md", EDITED);

    expect(await listWikiPages()).toEqual(pagesBefore);
    expect(await readWikiArtifact(OWNER, wiki.id, "purpose.md")).toBe(purposeBefore);
    // Nothing acquired a slug: `wiki/index.md` is written by the page pipeline
    // and this write must never touch it.
    await expect(
      getStorage().fileExists(wikiRelPath("index.md")),
    ).resolves.toBe(false);
    await expect(getStorage().fileExists(wikiRelPath("schema.md"))).resolves.toBe(false);
  });

  it("is callable from inside the tenant lock's own holder without deadlocking", async () => {
    // `withFileLock` is NOT reentrant — it chains onto the key's existing
    // promise — so the seeder shares the UNLOCKED byte-write while this function
    // takes `wikis:<tenant>` itself. Two writes back to back prove the lock is
    // released rather than held.
    const wiki = await seed();
    await writeWikiArtifact(OWNER, wiki.id, "schema.md", EDITED);
    await writeWikiArtifact(OWNER, wiki.id, "schema.md", `${EDITED}\nagain\n`);
    expect(await readSchema(wiki)).toContain("again");
  });

  it("still resolves when the log or the counter fails, because the bytes landed", async () => {
    const wiki = await seed();
    const storage = getStorage();
    // `appendToLog` writes through `appendFile`; `bumpDataVersion` through
    // `putIndex`. Both fail; neither may turn a landed write into a failure.
    vi.spyOn(storage, "appendFile").mockRejectedValue(new Error("log is gone"));
    vi.spyOn(storage, "putIndex").mockRejectedValue(new Error("kv is gone"));

    await expect(
      writeWikiArtifact(OWNER, wiki.id, "schema.md", EDITED),
    ).resolves.toBeUndefined();
    expect(await readSchema(wiki)).toBe(EDITED);
  });

  // -------------------------------------------------------------------------
  // The round trip — the whole point of the story
  // -------------------------------------------------------------------------

  it("reaches the prompts: loadPageConventions() returns the EDITED section", async () => {
    const wiki = await seed();
    const seeded = await loadPageConventions();
    expect(seeded).not.toContain("Every page names the meeting it came from.");

    await writeWikiArtifact(OWNER, wiki.id, "schema.md", EDITED);

    const active = await loadPageConventions();
    expect(active).toContain("Every page names the meeting it came from.");
    expect(active).not.toBe(seeded);
    // Through the ONE loader — no reader was added and no fallback changed.
    expect(active).not.toBe(await loadPageConventions(`${process.cwd()}/SCHEMA.md`));
  });

  it("reaches the prompts through the route as well, end to end", async () => {
    const wiki = await seed();
    const before = await readDataVersion();

    const response = await put("?path=schema.md", { content: EDITED });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");

    expect(await readSchema(wiki)).toBe(EDITED);
    expect(await readDataVersion()).toBe(before + 1);
    expect(await loadPageConventions()).toContain(
      "Every page names the meeting it came from.",
    );
  });

  // -------------------------------------------------------------------------
  // The route's refusals
  // -------------------------------------------------------------------------

  it("round-trips a Schema with a leading YAML block without eating it", async () => {
    // The read route strips a leading `---` block for a PAGE, because
    // `PUT /api/wiki/[slug]` owns frontmatter end-to-end. An artifact is
    // whole-file in both directions: stripping it here would hand the editor a
    // body whose very next save deletes the block — silently, with a 200 and a
    // `dataVersion` bump.
    const wiki = await seed();
    const withYaml = `---\nowner: ${OWNER}\nnote: keep me\n---\n\n${EDITED}`;

    expect((await put("?path=schema.md", { content: withYaml })).status).toBe(200);

    const read = await get("kind=file&path=schema.md");
    expect(read.status).toBe(200);
    const payload = await read.json();
    expect(payload.body).toBe(withYaml);
    expect(payload.body.startsWith("---")).toBe(true);
    expect(payload.body).toContain("note: keep me");

    // The exact bytes the editor was seeded with, saved back untouched — the
    // idempotence a lossy read would break on the FIRST save, not the second.
    expect((await put("?path=schema.md", { content: payload.body })).status).toBe(200);
    expect(await readSchema(wiki)).toBe(withYaml);
    expect((await readSchema(wiki)).startsWith("---")).toBe(true);
  });

  it("still strips the YAML block for a page, which is not whole-file", async () => {
    // The artifact exception must not become a general one: a page's `content`
    // field IS the body without frontmatter, so a page that stopped stripping
    // would double the block on the next save.
    await seed();
    await fs.writeFile(
      path.join(tmpDir, "wiki", "alpha.md"),
      "---\ntitle: alpha\ntype: concept\n---\n\n# Alpha\n\nbody\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(tmpDir, "wiki", "index.md"),
      "# Wiki Index\n\n- [alpha](alpha.md) — alpha\n",
      "utf-8",
    );
    const payload = await (await get("kind=page&slug=alpha")).json();
    expect(payload.body).toBe("# Alpha\n\nbody\n");
    expect(payload.body).not.toContain("---");
  });

  it("refuses a signed-in principal who is not the owner", async () => {
    // `writeWikiArtifact` addresses the CALLER's tenant while
    // `readActiveWikiSchema()` resolves the executing Schema from
    // `getOwnerHandle()`. A non-owner's save would therefore land bytes no
    // prompt ever reads and still answer 200, log, and move the counter — the
    // silently-inert save `hasPageConventions` exists to prevent, by another
    // door.
    const wiki = await seed();
    const seeded = await readSchema(wiki);
    principal.current = { id: "u2", handle: "somebody-else" };

    const response = await put("?path=schema.md", { content: EDITED });
    expect(response.status).toBe(403);
    expect(typeof (await response.json()).error).toBe("string");

    expect(await readSchema(wiki)).toBe(seeded);
    expect(await readDataVersion()).toBe(0);
    expect(await readLog()).toBeNull();
  });

  it("refuses a signed-out save and writes nothing", async () => {
    const wiki = await seed();
    const seeded = await readSchema(wiki);
    principal.current = null;

    const response = await put("?path=schema.md", { content: EDITED });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Sign in required." });
    expect(await readSchema(wiki)).toBe(seeded);
    expect(await readDataVersion()).toBe(0);
  });

  it("refuses every save on a read-only deployment", async () => {
    const wiki = await seed();
    const seeded = await readSchema(wiki);
    process.env.YOPEDIA_READONLY = "1";

    const response = await put("?path=schema.md", { content: EDITED });
    expect(response.status).toBe(403);
    expect(typeof (await response.json()).error).toBe("string");
    expect(await readSchema(wiki)).toBe(seeded);
    expect(await readDataVersion()).toBe(0);
  });

  it("does not offer the Schema for editing on a read-only deployment", async () => {
    // The read decides whether `Edit` is on screen and the write decides whether
    // a save lands. When they disagree the owner walks the confirm dialog and
    // retypes an executable Schema only to be refused at `Save` — so the read
    // route consults the SAME `isReadOnly()` the write route refuses on. The
    // bytes still render: read-only means read-only, not hidden.
    await seed();
    process.env.YOPEDIA_READONLY = "1";

    const payload = await (await get("kind=file&path=schema.md")).json();
    expect(payload.editable).toBe(false);
    expect(payload.artifact).toBe("schema.md");
    expect(payload.body.length).toBeGreaterThan(0);
  });

  it("does not offer the Schema for editing to anyone the write route will refuse", async () => {
    // The mirror of the read-only case above, for the OTHER 403 the write route
    // answers. Both halves matter, and the second is not hypothetical: the
    // Workbench is signed-in-gated rather than owner-gated (`page.tsx`), and
    // `isOwnerHandle` is false for EVERYONE when `NEXT_PUBLIC_OWNER_HANDLE` is
    // unset — so without this the affordance is offered on a deployment where no
    // save can ever land, and the owner discovers it only after retyping an
    // executable Schema. The bytes still render in both cases: not-editable
    // means not-editable, not hidden.
    await seed();

    // A signed-in NON-owner never reaches the question: the read resolves the
    // Wiki from `getWikiRegistry(principal.handle)`, so someone else's tenant
    // has no current Wiki and `schema.md` resolves to nothing. It answers the
    // same 404 every other unresolvable path does — no oracle, and nothing to
    // offer.
    principal.current = { id: "u2", handle: "somebody-else" };
    expect((await get("kind=file&path=schema.md")).status).toBe(404);

    // The case that IS reachable, and the reason the owner half is here at all:
    // with `NEXT_PUBLIC_OWNER_HANDLE` unset nobody is the owner, so the write
    // route refuses every save — while this principal still has a registry, a
    // current Wiki and a `schema.md` that resolves. Without the owner half of
    // `editable` the affordance is offered on a deployment where no save can
    // ever land. The bytes still render: not-editable means not-editable, not
    // hidden.
    principal.current = { id: "u1", handle: OWNER };
    delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
    const ownerless = await (await get("kind=file&path=schema.md")).json();
    expect(ownerless.editable).toBe(false);
    expect(ownerless.artifact).toBe("schema.md");
    expect(ownerless.body.length).toBeGreaterThan(0);
    // …and the write route agrees, which is the whole point of the pair.
    expect((await put("?path=schema.md", { content: EDITED })).status).toBe(403);
  });

  it("keeps a seeded Schema saveable back through the route it is offered in", async () => {
    // The story's own round trip has a precondition nothing else states: the
    // bytes `seedWikiArtifacts` writes must PASS `hasPageConventions`, or the
    // owner opens the seeded Schema, changes one word and is told their Schema
    // is invalid. Every creatable scenario, because each renders its own
    // template — and then the read → save round trip for the current one, so
    // the guarantee is end-to-end and not just a predicate over a string.
    const engine = await readEnginePageConventions();
    for (const scenario of CREATABLE_SCENARIOS) {
      expect(
        hasPageConventions(renderSchemaMarkdown(scenarioTemplate(scenario), engine)),
      ).toBe(true);
    }

    const wiki = await seed();
    const seeded = await (await get("kind=file&path=schema.md")).json();
    expect(seeded.editable).toBe(true);
    const edited = `${seeded.body}\nOne more line.\n`;
    expect((await put("?path=schema.md", { content: edited })).status).toBe(200);
    expect(await readSchema(wiki)).toBe(edited);
  });

  it("answers ONE identical 400 for every path that is not the editable artifact", async () => {
    const wiki = await seed();
    const seeded = await readSchema(wiki);

    const answers = await Promise.all(
      [
        "?path=purpose.md",
        "?path=wiki%2Falpha.md",
        "?path=..%2Fsecrets",
        "",
      ].map(async (query) => {
        const response = await put(query, { content: EDITED });
        return { status: response.status, body: await response.json() };
      }),
    );
    // The write route grants no existence oracle either: a caller must not learn
    // from these which of the four it was.
    for (const answer of answers) {
      expect(answer.status).toBe(400);
      expect(answer).toEqual(answers[0]);
    }
    expect(await readSchema(wiki)).toBe(seeded);
    expect(await readDataVersion()).toBe(0);
  });

  it("answers 404 when the registry names no current Wiki", async () => {
    // No `createWiki` at all in this case.
    const response = await put("?path=schema.md", { content: EDITED });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Wiki not found." });
    expect(await readDataVersion()).toBe(0);
  });

  it("refuses a Schema that would silently stop steering anything", async () => {
    const wiki = await seed();
    const seeded = await readSchema(wiki);

    for (const content of [
      "# Schema\n\n## Key questions\n\n- one\n",
      `# Schema\n\n${PAGE_CONVENTIONS_HEADING}\n\n## Key questions\n\n- one\n`,
    ]) {
      const response = await put("?path=schema.md", { content });
      expect(response.status).toBe(400);
      // The sentence names the section, so the fix is the next thing the owner
      // can type — and the editor stays open holding their text.
      expect((await response.json()).error).toContain(PAGE_CONVENTIONS_HEADING);
    }
    expect(await readSchema(wiki)).toBe(seeded);
    expect(await readDataVersion()).toBe(0);
  });

  it("refuses a Schema the Preview would then truncate and refuse to edit", async () => {
    const wiki = await seed();
    const seeded = await readSchema(wiki);
    const oversized = `${EDITED}${"x".repeat(PREVIEW_MAX_CHARS)}`;

    const response = await put("?path=schema.md", { content: oversized });
    expect(response.status).toBe(400);
    expect(typeof (await response.json()).error).toBe("string");
    expect(await readSchema(wiki)).toBe(seeded);
  });

  it("refuses an empty, non-string or unparseable body", async () => {
    const wiki = await seed();
    const seeded = await readSchema(wiki);

    for (const body of [{ content: "" }, { content: "   " }, { content: 3 }, {}, "{"]) {
      const response = await put("?path=schema.md", body);
      expect(response.status).toBe(400);
      expect(typeof (await response.json()).error).toBe("string");
    }
    expect(await readSchema(wiki)).toBe(seeded);
    expect(await readDataVersion()).toBe(0);
  });

  it("answers a failed storage write with 500, and moves nothing", async () => {
    const wiki = await seed();
    const seeded = await readSchema(wiki);
    vi.spyOn(getStorage(), "writeFile").mockRejectedValue(new Error("disk is gone"));

    const response = await put("?path=schema.md", { content: EDITED });
    expect(response.status).toBe(500);
    expect(typeof (await response.json()).error).toBe("string");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");

    vi.restoreAllMocks();
    expect(await readSchema(wiki)).toBe(seeded);
    expect(await readDataVersion()).toBe(0);
    expect(await readLog()).toBeNull();
  });

  it("still answers 200 when only the tail failed", async () => {
    const wiki = await seed();
    const storage = getStorage();
    vi.spyOn(storage, "appendFile").mockRejectedValue(new Error("log is gone"));
    vi.spyOn(storage, "putIndex").mockRejectedValue(new Error("kv is gone"));

    const response = await put("?path=schema.md", { content: EDITED });
    expect(response.status).toBe(200);

    vi.restoreAllMocks();
    // The save DID land — reporting it as failed would be the one lie that
    // costs the owner their text.
    expect(await readSchema(wiki)).toBe(EDITED);
  });

  it("never lets the caller name the Wiki, the tenant or a storage key", async () => {
    const wiki = await seed();
    const other = await createWiki(OWNER, { name: "Other", scenario: "business" });
    // `other` is now current. A caller passing the FIRST Wiki's id must not be
    // able to write into it: the route reads `currentId` and ignores everything
    // else on the URL.
    const response = await put(
      `?path=schema.md&wikiId=${wiki.id}&owner=someone-else&key=tenants%2Fx%2Fy.md`,
      { content: EDITED },
    );
    expect(response.status).toBe(200);
    expect(await readSchema(other)).toBe(EDITED);
    expect(await readSchema(wiki)).not.toBe(EDITED);
  });
});

// ---------------------------------------------------------------------------
// The wiring a node suite cannot execute
// ---------------------------------------------------------------------------

describe("the shared editor gained a second target without forking", () => {
  async function read(file: string): Promise<string> {
    return fs.readFile(path.join(COMPONENTS, file), "utf8");
  }

  it("keeps ONE editor, ONE save client and no URL of its own", async () => {
    const source = await read("PreviewColumn.tsx");
    // One confirm gate, one textarea, one save call — a second of any of them
    // would be an edit path that skips something.
    expect(source.match(/setEditing\(true\)/g) ?? []).toHaveLength(1);
    expect(source.match(/savePreviewBody\(/g) ?? []).toHaveLength(1);
    expect(source).toContain("savePreviewBody(target.url, draft");
    // The column spells no route at all: which URL is `previewWriteTarget`'s
    // answer, executed above, never a branch typed in here.
    expect(source).not.toContain('"/api/');
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toContain('method: "PUT"');
    // …and no second refresh mechanism: the landed save still nudges the
    // watcher, and this column still owns no router.
    expect(source).toContain("requestDataVersionCheck()");
    expect(source).not.toMatch(/\buseRouter\(/);
  });

  it("compares the SAME key it is about to post to", async () => {
    const source = await read("PreviewColumn.tsx");
    const save = source.slice(
      source.indexOf("const save = useCallback"),
      source.indexOf("}, [draft, saving]);"),
    );
    // Both guards — before the request and after it — are the target key, not
    // the payload's slug: a page and the Schema now differ in URL as well as in
    // identity, so a slug comparison would pass while the URL pointed elsewhere.
    expect(
      save.match(/if \(previewWriteTarget\(payloadRef\.current\)\?\.key !== target\.key\) return;/g) ??
        [],
    ).toHaveLength(2);
    expect(save).not.toContain("payloadRef.current?.slug");
    expect(save).toContain("const target = editingTargetRef.current;");
    // The fallback sentence comes from the executed copy function, so a Schema
    // save cannot fail with "This page couldn’t be saved."
    expect(save).toContain("previewEditCopy(target).saveFallback");
    expect(save).not.toContain("PREVIEW_SAVE_FAILED_COPY");
  });

  it("takes the confirm dialog's sentences from the executed copy function", async () => {
    const source = await read("PreviewColumn.tsx");
    expect(source).toContain("previewEditCopy(previewWriteTarget(payload))");
    expect(source).toContain("title={editCopy.confirmTitle}");
    expect(source).toContain("body={editCopy.confirmBody}");
    // No ternary in the JSX, and no second copy of either sentence.
    expect(source).not.toContain("PREVIEW_EDIT_CONFIRM_TITLE");
    expect(source).not.toContain("PREVIEW_EDIT_SCHEMA_CONFIRM_TITLE");
    // The editor is seeded from the payload it rendered, once.
    expect(source).toContain("editingTargetRef.current = target;");
  });

  it("refuses to open an editor with nowhere to save to", async () => {
    const source = await read("PreviewColumn.tsx");
    const start = source.slice(
      source.indexOf("const startEditing = useCallback"),
      source.indexOf("}, [payload]);"),
    );
    // A silent same-row refresh (Story 1.7) can replace the payload while this
    // dialog is open, and the new one may be truncated or no longer editable.
    // Without this guard the editor opens with a null target and `Save` neither
    // writes nor says why — and `startEditing` runs behind a confirm click, so
    // no test that never mounts the component would ever see it.
    expect(start).toContain("const target = previewWriteTarget(payload);");
    expect(start).toMatch(/if \(!target\) \{\s*\n\s*setConfirmOpen\(false\);\s*\n\s*return;\s*\n\s*\}/);
    // …and the guard is BEFORE the editor opens, not after it.
    expect(start.indexOf("if (!target)")).toBeLessThan(start.indexOf("setEditing(true)"));
    expect(start.indexOf("if (!target)")).toBeLessThan(start.indexOf("setDraft("));
  });

  it("still writes a page exactly as Story 1.5 shipped it", async () => {
    // The shared editor gains a target; it does not change the first one.
    const source = await read("PreviewColumn.tsx");
    expect(source).toContain("<ConfirmDialog");
    expect(source).toContain("onConfirm={startEditing}");
    expect(source).toContain("readOnly={saving}");
    expect(source).toContain("draft.trim().length === 0");
    expect(source).toContain("canEditPreview(payload)");
  });
});

describe("the two routes", () => {
  /**
   * Source with its comments removed. Prose is not code: both routes DOCUMENT
   * the allowlist and the storage layout in their docblocks, and a bare
   * substring scan would fail on the explanation rather than on a second
   * expression of the thing explained.
   */
  function code(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  async function readRoute(file: string): Promise<string> {
    return code(await fs.readFile(path.join(ROUTES, file), "utf8"));
  }

  it("re-derives the gate and the Wiki server-side on the write", async () => {
    const source = await readRoute("workbench/artifact/route.ts");
    expect(source).toContain("await getPrincipal()");
    expect(source).toContain("isReadOnly()");
    // The Wiki id comes from the registry, never from the request.
    expect(source).toContain("await getWikiRegistry(principal.handle)");
    expect(source).not.toMatch(/searchParams\.get\("(wikiId|owner|tenant|key)"\)/);
    // The allowlist is the shared constant, not a second list.
    expect(source).toContain("isEditableArtifactFile(target)");
    expect(source).not.toContain("EDITABLE_ARTIFACT_FILES");
    // ONE writer, called once.
    expect(source.match(/writeWikiArtifact\(/g) ?? []).toHaveLength(1);
    // …and never a page writer.
    expect(source).not.toMatch(/writeWikiPage|runPageLifecycleOp|deleteWikiPage/);
    // The conventions rule is imported, never re-expressed.
    expect(source).toContain("hasPageConventions(content)");
    expect(source).not.toMatch(/\/.*Page conventions.*\//);
  });

  it("lets the READ route decide what may be edited", async () => {
    const source = await readRoute("workbench/preview/route.ts");
    // The same allowlist the write route gates on, so what the column is offered
    // and what the server will accept cannot drift.
    expect(source).toContain("isEditableArtifactFile(displayPath)");
    expect(source).toContain("...(artifact ? { artifact } : {})");
    // The artifact half also carries `isReadOnly()`, so the affordance and the
    // route that answers it refuse together rather than one offering what the
    // other rejects. The executed test above pins the behaviour; this pins that
    // the two conditions stay in ONE expression.
    expect(source).toMatch(
      /editable:\s*\n?\s*format === "markdown" &&\s*\n?\s*\(slug !== undefined \|\|\s*\n?\s*\(artifact !== undefined && !isReadOnly\(\) && isOwnerHandle\(principal\.handle\)\)\)/,
    );
    // The page branch is untouched: a Page is still `editable: true`.
    expect(source).toContain("editable: true,");
  });

  it("expresses the artifact layout in exactly one module", async () => {
    // `tenants/<t>/wikis/<id>/…` is `wiki-paths.ts`'s alone — every other
    // caller goes through `wikiDirPath`/`wikiArtifactPath`, or the write path
    // and the read path could address different bytes. The helpers live in a
    // leaf module (not `wikis.ts`) so the per-Wiki profile store can address
    // the directory without importing `wikis.ts` back into a cycle.
    // Comment-stripped, like the routes below: EVERY module here documents the
    // layout in prose, so a raw scan would pass on the docblock that explains
    // the rule rather than on the code that keeps it.
    const paths = code(
      await fs.readFile(path.resolve(__dirname, "../wiki-paths.ts"), "utf8"),
    );
    expect(paths).toContain("`tenants/${tenantFor(owner)}/wikis/");
    // The sweep addresses the PARENT of a Wiki's directory, so `wiki-paths.ts`
    // owns that expression too rather than a second module re-deriving the
    // listing prefix a delete then has to agree with.
    expect(paths).toContain("`tenants/${tenantFor(owner)}/wikis`");
    // No other module interpolates the layout — prose in a docblock is fine,
    // a second `${…}/wikis` expression is the regression, WITH or without the
    // trailing slash: `…/wikis` alone is the directory the sweep enumerates,
    // and a `not.toContain("}/wikis/")` guard sails straight past it. The
    // negative lookahead spares `wikiRegistryPath`'s `…}/wikis.json`, which
    // addresses the registry file rather than the artifact tree.
    // The profile is a sibling of the artifacts: same directory, ONE helper —
    // and now a NAMED one, because two modules need the full address rather
    // than just the directory. `workspace-profile.ts` reads and writes the
    // file; `wikis.ts` snapshots and restores it when a re-template fails
    // (DW-143). A second literal is how a restore silently starts putting back
    // a file nothing ever wrote.
    expect(paths).toContain("/workspace-profile.json`");
    for (const name of ["wikis.ts", "workspace-profile.ts"]) {
      const source = code(
        await fs.readFile(path.resolve(__dirname, `../${name}`), "utf8"),
      );
      expect(source).not.toMatch(/\}\/wikis(?!\.)/);
      // …and BOTH modules reach the file through the promoted helper. `wikis.ts`
      // is the module the promotion exists FOR: its snapshot and its restore
      // have to address the same bytes `putWorkspaceProfile` writes, or a
      // failed re-template puts a file back that nothing ever read. Matched as
      // a SHAPE, so renaming the parameters is not a failure.
      expect(source).toMatch(/wikiProfilePath\(\s*\w+\s*,\s*\w+\s*\)/);
      // The per-Wiki profile address is not re-derived either — and the guard
      // is on the FILENAME rather than on one spelling of the interpolation,
      // because the realistic drift is a two-step derivation or a differently
      // named local helper, neither of which a `wikiDirPath(…)}/…` pattern
      // would catch. `wikis.ts` may not name the file at all; the ONE literal
      // left in `workspace-profile.ts` is the retired tenant-global singleton
      // (`tenants/${tenant(owner)}/workspace-profile.json`), a DIFFERENT file
      // kept at its one read-only site.
      const literals = source.match(/workspace-profile\.json/g) ?? [];
      expect(literals).toHaveLength(name === "workspace-profile.ts" ? 1 : 0);
    }
    for (const file of [
      "workbench/artifact/route.ts",
      "workbench/preview/route.ts",
    ]) {
      expect(await readRoute(file)).not.toContain("/wikis/");
    }
  });
});
