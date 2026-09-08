import { NextResponse } from "next/server";
import { canWriteFrontmatter } from "@/lib/authz";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { parseFrontmatter, type Frontmatter } from "@/lib/frontmatter";
import { stripFrontmatterBlock } from "@/lib/markdown";
import { isOwnerPrincipal } from "@/lib/owner";
import { listReadableWikiPages, readWikiPage } from "@/lib/wiki";
import {
  isEditableArtifactFile,
  type EditableArtifactFile,
} from "@/lib/wiki-scenarios";
import { getWikiRegistry, readEffectiveWikiArtifact } from "@/lib/wikis";
import { contentVersion, scopedContentVersion } from "@/lib/write-precondition";
import {
  readWorkbenchFile,
  wikiLeafName,
  wikiLeafSlug,
  workbenchFileExists,
} from "@/lib/workbench-files";
import {
  capPreviewBody,
  isPreviewMediaFormat,
  previewFileKind,
  type PreviewFormat,
  type PreviewPayload,
} from "@/lib/workbench-preview";
import {
  buildKnowledgeTree,
  findKnowledgePage,
  workbenchSlugGate,
} from "@/lib/workbench-tree";

/**
 * GET /api/workbench/preview — the bytes behind a Workbench tree selection.
 *
 * `?kind=page&slug=<slug>` or `?kind=file&path=<display path>`, i.e. exactly the
 * two shapes of `TreeSelection`. The response is `PreviewPayload`.
 *
 * THE GATE IS RE-DERIVED HERE, NEVER TRUSTED FROM THE CLIENT. The column already
 * holds `knowledge` and `files`, so it could send a slug it believes is
 * readable — which would make the browser the authority on what the server will
 * read. Deriving `workbenchSlugGate(entries, buildKnowledgeTree(entries))` over
 * `await listReadableWikiPages(principal)` costs one index read and makes the
 * Preview's reach identical to the tree's BY CONSTRUCTION: both surfaces run the
 * same two functions over the same principal.
 *
 * NO EXISTENCE ORACLE. Gated out, traversal-shaped, absent, and unreadable all
 * answer one 404 with one body — never 403, never a distinguishable message. A
 * caller must not be able to learn that `wiki/hidden.md` exists by comparing
 * this route's answers, which is the rule `api/raw/[slug]/route.ts` already
 * follows.
 */

/**
 * Every answer is per-principal and gated, so none of it may be cached — not by
 * a shared cache and not by the browser's back/forward store. Same directive as
 * `api/system/health` and `api/archive/export`.
 */
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** One body for every refusal. Deliberately says nothing about which it was. */
const NOT_FOUND = { error: "Not found." } as const;

function notFound() {
  return json(NOT_FOUND, 404);
}

function badRequest(message: string) {
  return json({ error: message }, 400);
}

/**
 * The body as the owner reads it AND as the editor edits it: one string.
 *
 * For a PAGE the YAML block is already gone. `PUT /api/wiki/[slug]` documents
 * `content` as the body without frontmatter and owns the block end-to-end, so
 * stripping here is what makes read, edit and save agree on one string.
 *
 * `whole` is the ARTIFACT's exception, and it is not cosmetic.
 * `PUT /api/workbench/artifact` stores `content` as the ENTIRE file and owns no
 * frontmatter for it at all — which is what `PreviewPayload.artifact` already
 * claims. Stripping a leading `---` block here would hand the editor a body the
 * next save writes back without it: a silent deletion, answered with a 200 and a
 * `dataVersion` bump. Read and write have to agree on which bytes they mean, and
 * for an artifact those bytes are all of them.
 */
function bodyFor(format: PreviewFormat, content: string, whole = false): string {
  // The two formats that never carry one: nothing was read for either.
  if (format === "unsupported" || isPreviewMediaFormat(format)) return "";
  if (whole) return content;
  return format === "markdown" ? stripFrontmatterBlock(content) : content;
}

/**
 * The frontmatter of bytes this route ALREADY READ, or `{}` when there is none
 * and when there is one that will not parse.
 *
 * Both branches call this, and each calls it ONCE: `disputed` and `editable`
 * are two questions about one file, and two parses (or a parse plus a re-read)
 * is how they would come to disagree.
 *
 * A block with no closing `---` throws in `parseFrontmatter`. Empty metadata is
 * the fail-CLOSED answer for `editable`, not a permissive one: `belongsInCommons`
 * treats a record with no `visibility` and no `type` as a commons page, so
 * `canWriteFrontmatter(..., "body")` refuses every principal but the service
 * principal and an admin. For EMPTY metadata that is exactly the answer
 * `PUT /api/wiki/[slug]` gives — a file with no YAML block at all parses to
 * `{}` there too, and the same ACL refuses the same principals with a 403.
 *
 * For an UNPARSEABLE block the two routes DIVERGE, deliberately (DW-494): on an
 * ORDINARY deployment that route's `readWikiPageWithFrontmatter` throws before
 * its ACL check ever runs, and the outer catch classifies the throw as 500 (400
 * only for `invalid slug`). Under `YOPEDIA_READONLY` its `isReadOnly()` guard
 * refuses every slug with a 403 before any of that, so the 500 is the
 * ordinary-path answer. This route does not propagate the throw, because a
 * Preview that cannot render is not a server fault — it reports the bytes it
 * read and marks the affordance closed. So the catch is a real decision, not a
 * swallow.
 */
function frontmatterOf(content: string): Frontmatter {
  try {
    return parseFrontmatter(content).data;
  } catch {
    return {};
  }
}

export async function GET(request: Request) {
  try {
    return await handle(request);
  } catch (error) {
    // Without this a throw from `getPrincipal`, the index read or a storage read
    // escapes as a framework 500 whose body is not `{ error }` — breaking the
    // shape every other route in this tree answers with, and the one the column
    // parses. `api/wikis/current` wraps for the same reason.
    logger.error("workbench-preview", "preview read failed", error);
    return json({ error: getErrorMessage(error) }, 500);
  }
}

async function handle(request: Request) {
  const principal = await getPrincipal();
  if (!principal) {
    return json({ error: "Sign in required." }, 401);
  }

  const params = new URL(request.url).searchParams;
  const kind = params.get("kind");
  if (kind !== "page" && kind !== "file") {
    return badRequest("kind must be \"page\" or \"file\".");
  }

  // The gate, derived exactly as `page.tsx` derives it — the two must not be
  // able to drift, so they run the same pair of functions rather than two
  // expressions that happen to agree today.
  const entries = await listReadableWikiPages(principal);
  const knowledge = buildKnowledgeTree(entries);
  // BOTH halves, from the one derivation `page.tsx` runs: `readableSlugs` for
  // the `wiki/` root, `hiddenSlugs` for the `raw/` one (DW-32).
  const slugGate = workbenchSlugGate(entries, knowledge);

  if (kind === "page") {
    const slug = params.get("slug");
    if (!slug) return badRequest("A slug is required.");
    // Gate BEFORE the read: a slug outside the set must not reach storage at
    // all, so a timing difference cannot answer what the status code will not.
    if (!slugGate.readableSlugs.has(slug)) return notFound();

    // FRESH (DW-195). This read SEEDS a precondition: `version` below is what
    // the editor sends back as `If-Match`. `pageCache` is module-global and
    // ref-counted around bulk scans (lint, search, query, dataview), so a scan
    // running concurrently can hold a superseded entry open — and serving that
    // entry would hand the editor a version of bytes that are no longer stored,
    // producing a 412 against a write nobody made. A fresh read neither
    // consults nor mutates the cache, so the scan holding it is unaffected.
    const page = await readWikiPage(slug, { fresh: true });
    if (!page) return notFound();

    const { body, truncated } = capPreviewBody(bodyFor("markdown", page.content));
    // ONE parse of the bytes this route already read, feeding both `disputed`
    // and `editable` — the two must be talking about the same file, and a
    // second read to answer the second question could see different bytes.
    const fm = frontmatterOf(page.content);
    const disputed = fm.disputed === true;
    const payload: PreviewPayload = {
      name: findKnowledgePage(knowledge, slug)?.title ?? slug,
      path: `wiki/${slug}.md`,
      slug,
      format: "markdown",
      body,
      truncated,
      ...(disputed ? { disputed: true } : {}),
      // The write precondition (DW-38/51), derived from the WHOLE stored file
      // rather than from `body`: `PUT /api/wiki/[slug]` checks it against
      // `existing.content`, which still carries the YAML block this payload
      // stripped. Two versions over two different strings would never match.
      version: contentVersion(page.content),
      // A compiled Page is the one thing this story makes editable: it is what
      // `PUT /api/wiki/[slug]` writes. Artifacts are Story 1.8, sources Epic 2.
      //
      // BOTH refusals `PUT /api/wiki/[slug]` answers 403 to, and no more
      // (DW-42). `isReadOnly()` is the deployment one (DW-37); the ACL one is
      // `canWriteFrontmatter(..., "body")`, whose realm branch refuses ANY
      // write to a public, non-agent-scoped, non-artifact page from a
      // principal that is neither the service principal nor an admin. Without
      // it a readable-but-unwritable page offered `Edit`, seeded the editor,
      // and relayed the write route's 403 only after a full retype. The bytes
      // still render: read-only means read-only, not hidden.
      editable: !isReadOnly() && canWriteFrontmatter(fm, principal, "body"),
    };
    return json(payload);
  }

  const displayPath = params.get("path");
  if (!displayPath) return badRequest("A path is required.");

  // The registry is read for the current Wiki id alone — the two seeded
  // artifacts are the only per-Wiki files, and without an id they resolve to
  // nothing rather than to another Wiki's copy.
  let currentId: string | null = null;
  try {
    currentId = (await getWikiRegistry(principal.handle)).currentId;
  } catch {
    // An unreadable registry costs the artifacts, not the whole Preview: a
    // `wiki/` or `raw/` path does not depend on it.
    currentId = null;
  }

  // The FORMAT is decided by the name, so it is decided before anything is
  // read: for a blob this reader cannot render, the answer is a sentence, and
  // pulling an arbitrarily large object through the Worker to then discard it
  // would be work done to learn nothing. The gate still runs either way.
  const format = previewFileKind(displayPath);
  const gate = slugGate;
  let content = "";
  // MEDIA joins `unsupported` on the existence-only branch (Story 7.7), for the
  // same reason and one more. The same: its bytes are not a body, so reading
  // them here to hand back a string would be work done to learn nothing. The
  // extra: `readFile` DECODES UTF-8, so buffering a PNG would not merely waste
  // the trip, it would corrupt the payload it produced. The column fetches the
  // bytes from `/api/workbench/media`, which streams them undecoded — but the
  // gate still runs here, so a media file outside the caller's reach is a 404
  // in the Preview before the column ever asks for it.
  if (format === "unsupported" || isPreviewMediaFormat(format)) {
    if (!(await workbenchFileExists(principal.handle, currentId, displayPath, gate))) {
      return notFound();
    }
  } else {
    if (displayPath === "purpose.md" && currentId !== null) {
      const effective = await readEffectiveWikiArtifact(
        principal.handle,
        currentId,
        "purpose.md",
      );
      if (effective === null) return notFound();
      content = effective;
    } else {
      const file = await readWorkbenchFile(principal.handle, currentId, displayPath, gate);
      if (!file) return notFound();
      content = file.content;
    }
  }

  const segments = displayPath.split("/");

  // `wiki/<slug>.md` is the same bytes a Page selection reads, reached from the
  // other tab — so it carries the slug and is editable through the same route.
  // THE SAME two rules the read gate applies, not a second expression of
  // either: `wikiLeafName` for "a direct child of the wiki root" (DW-204, which
  // retired this route's own `segments.length === 2 && segments[0] === "wiki"`),
  // and `wikiLeafSlug` for name→slug. A case-sensitive test here once served
  // `wiki/alpha.MD` (which the gate admits, because a filesystem need not be
  // case-sensitive) with no slug, so a page the Knowledge tab edits was
  // read-only from the Files tab. One function each is what stops them drifting
  // again.
  //
  // AND THE SLUG NOW NAMES THE OBJECT THESE BYTES CAME FROM (DW-489). It did
  // not always: several spellings of one `.md` name carry ONE slug on a
  // case-SENSITIVE store, the Files tab lists only the elected one, and the read
  // gate used to serve every one of them — so a deep link or a selection
  // restored from `workbench-state` could preview `wiki/cased.MD` here, with
  // slug `cased` and `editable: true`, while the save landed on a different
  // object. The refusal is upstream, in `resolveWorkbenchFile`: a non-elected
  // spelling never reaches this line, because `readWorkbenchFile` /
  // `workbenchFileExists` above already answered the same 404 they answer for a
  // path that does not exist. NOTHING HERE ENFORCES THAT — do not re-widen the
  // gate on the assumption that this derivation would catch it.
  const wikiLeaf = wikiLeafName(displayPath);
  const slug = wikiLeaf === null ? undefined : (wikiLeafSlug(wikiLeaf) ?? undefined);

  // The Schema (Story 1.8), derived as a SCOPE rather than as a flag.
  //
  // A single-segment display path that is in `EDITABLE_ARTIFACT_FILES` and got
  // this far has already been resolved through `readWorkbenchFile` →
  // `readWikiArtifact`, which needs `currentId` and the file to exist — so
  // reaching here means this Wiki genuinely has one. The allowlist is the SAME
  // constant the write route gates on, so what the column is offered and what
  // the server will accept cannot drift.
  //
  // KEEPING THE ID AND THE FLAG IN ONE VALUE IS THE POINT (DW-200). Deriving
  // `artifact` on its own and then reaching for `currentId` at the version
  // leaves a branch where the two disagree, and the only thing that branch can
  // emit is an unscoped artifact token — precisely what DW-200 exists to
  // eliminate, and a token no writer will ever match. Narrowing once here makes
  // "an artifact without its scope" unrepresentable rather than merely
  // documented as impossible.
  let artifact: EditableArtifactFile | undefined;
  let artifactScope: string | null = null;
  if (isEditableArtifactFile(displayPath) && currentId !== null) {
    artifact = displayPath;
    artifactScope = currentId;
  }

  // Decided AFTER `artifact`, because whether the YAML block is stripped depends
  // on it — see `bodyFor`. An artifact is whole-file in both directions.
  const { body, truncated } = capPreviewBody(
    bodyFor(format, content, artifact !== undefined),
  );

  // The same ONE parse as the `kind=page` branch, over the same bytes that
  // branch would have read — which is what makes the two branches agree about
  // `editable` for `wiki/<slug>.md` rather than merely agreeing today.
  const fm = slug && content ? frontmatterOf(content) : {};
  const disputed = fm.disputed === true;
  const payload: PreviewPayload = {
    name: segments[segments.length - 1],
    path: displayPath,
    ...(slug ? { slug } : {}),
    ...(artifact ? { artifact } : {}),
    format,
    body,
    truncated,
    ...(disputed ? { disputed: true } : {}),
    // The write precondition (DW-38/51/56), over the RAW bytes this route read
    // — before `bodyFor` stripped anything and before the cap sliced anything,
    // because those are the bytes the write routes hold. An `unsupported`
    // format read nothing at all, so it carries no version: there is no editor
    // for it, so no save can start from it, and inventing a version for the
    // empty string would be a claim about a file nobody looked at.
    //
    // SCOPED for the artifact (DW-200): two Wikis seeded from one template hold
    // byte-identical `schema.md` files, so an unscoped token read from one
    // would match the other's and land a draft on the wrong Wiki. The scope is
    // the SAME narrowed value `artifact` came from, so the payload cannot carry
    // an artifact without the binding its version needs. Everything else
    // (`wiki/`, `raw/`) is tenant-global and keeps the unscoped version the page
    // write compares against.
    ...(format === "unsupported"
      ? {}
      : {
          version:
            artifactScope === null
              ? contentVersion(content)
              : scopedContentVersion(artifactScope, content),
        }),
    // Editable where a Page lives, or where the editable artifact does.
    // `purpose.md` and everything under `raw/` stay read-only: the first is
    // deliberately out of Story 1.8's scope (it has no runtime reader and its
    // content overlaps the tenant-global workspace profile), and Sources are
    // Epic 2. Neither has a write path at all.
    //
    // The artifact half also consults BOTH refusals `PUT
    // /api/workbench/artifact` answers 403 to — `isReadOnly()` and
    // `isOwnerPrincipal()` — because offering `Edit` where the write will refuse
    // walks the owner through the confirm dialog and a full retype of an
    // executable Schema only to fail at `Save`. The owner half matters even on a
    // single-owner deployment: `isOwnerPrincipal` is false for EVERYONE when
    // NEITHER `YOPEDIA_OWNER_USER_ID` NOR `NEXT_PUBLIC_OWNER_HANDLE` is
    // configured (`owner.ts`), while the Workbench itself is only
    // signed-in-gated (`page.tsx`), so without this the affordance is offered on
    // a deployment where no save can ever land. It reads the SAME predicate the
    // write door does (DW-486) — the stable Clerk id where one is configured —
    // so an owner whose handle drifted is offered `Edit` exactly where the save
    // will land.
    //
    // The page half consults exactly the refusals `PUT /api/wiki/[slug]`
    // answers 403 to, and no more: `isReadOnly()` (DW-37) AND that route's
    // realm-aware ACL, `canWriteFrontmatter(fm, principal, "body")` (DW-42).
    // It is never owner-gated, unlike the artifact half above — a page save
    // still lands for any principal the ACL admits. The ACL half runs over the
    // frontmatter of the SAME bytes the `kind=page` branch parses, so a page
    // reached from the Files tab and the same page reached from the Knowledge
    // tab cannot disagree about whether `Edit` is offered.
    editable:
      format === "markdown" &&
      ((slug !== undefined &&
        !isReadOnly() &&
        canWriteFrontmatter(fm, principal, "body")) ||
        (artifact !== undefined && !isReadOnly() && isOwnerPrincipal(principal))),
  };
  return json(payload);
}
