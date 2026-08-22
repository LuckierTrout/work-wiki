import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { stripFrontmatterBlock } from "@/lib/markdown";
import { isOwnerHandle } from "@/lib/owner";
import { listReadableWikiPages, readWikiPage } from "@/lib/wiki";
import {
  isEditableArtifactFile,
  type EditableArtifactFile,
} from "@/lib/wiki-scenarios";
import { getWikiRegistry } from "@/lib/wikis";
import { contentVersion, scopedContentVersion } from "@/lib/write-precondition";
import { readWorkbenchFile, wikiLeafSlug, workbenchFileExists } from "@/lib/workbench-files";
import {
  capPreviewBody,
  previewFileKind,
  type PreviewFormat,
  type PreviewPayload,
} from "@/lib/workbench-preview";
import {
  buildKnowledgeTree,
  findKnowledgePage,
  readableSlugsFromKnowledge,
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
 * read. Deriving `readableSlugsFromKnowledge(buildKnowledgeTree(await
 * listReadableWikiPages(principal)))` costs one index read and makes the
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
  if (format === "unsupported") return "";
  if (whole) return content;
  return format === "markdown" ? stripFrontmatterBlock(content) : content;
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
  const knowledge = buildKnowledgeTree(await listReadableWikiPages(principal));
  const readableSlugs = readableSlugsFromKnowledge(knowledge);

  if (kind === "page") {
    const slug = params.get("slug");
    if (!slug) return badRequest("A slug is required.");
    // Gate BEFORE the read: a slug outside the set must not reach storage at
    // all, so a timing difference cannot answer what the status code will not.
    if (!readableSlugs.has(slug)) return notFound();

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
    const payload: PreviewPayload = {
      name: findKnowledgePage(knowledge, slug)?.title ?? slug,
      path: `wiki/${slug}.md`,
      slug,
      format: "markdown",
      body,
      truncated,
      // The write precondition (DW-38/51), derived from the WHOLE stored file
      // rather than from `body`: `PUT /api/wiki/[slug]` checks it against
      // `existing.content`, which still carries the YAML block this payload
      // stripped. Two versions over two different strings would never match.
      version: contentVersion(page.content),
      // A compiled Page is the one thing this story makes editable: it is what
      // `PUT /api/wiki/[slug]` writes. Artifacts are Story 1.8, sources Epic 2.
      //
      // `isReadOnly()` is the SAME refusal that write route now answers 403 to
      // (DW-37). Offering `Edit` where the save cannot land walks the owner
      // through a full retype only to fail at `Save`. The bytes still render:
      // read-only means read-only, not hidden.
      editable: !isReadOnly(),
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
  const gate = { readableSlugs };
  let content = "";
  if (format === "unsupported") {
    if (!(await workbenchFileExists(principal.handle, currentId, displayPath, gate))) {
      return notFound();
    }
  } else {
    const file = await readWorkbenchFile(principal.handle, currentId, displayPath, gate);
    if (!file) return notFound();
    content = file.content;
  }

  // `wiki/<slug>.md` is the same bytes a Page selection reads, reached from the
  // other tab — so it carries the slug and is editable through the same route.
  const segments = displayPath.split("/");
  // THE SAME name→slug rule the read gate applies, not a second expression of
  // it: a case-sensitive test here once served `wiki/alpha.MD` (which the gate
  // admits, because a filesystem need not be case-sensitive) with no slug, so a
  // page the Knowledge tab edits was read-only from the Files tab. One function
  // is what stops the two from drifting again.
  const slug =
    segments.length === 2 && segments[0] === "wiki"
      ? (wikiLeafSlug(segments[1]) ?? undefined)
      : undefined;

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

  const payload: PreviewPayload = {
    name: segments[segments.length - 1],
    path: displayPath,
    ...(slug ? { slug } : {}),
    ...(artifact ? { artifact } : {}),
    format,
    body,
    truncated,
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
    // `isOwnerHandle()` — because offering `Edit` where the write will refuse
    // walks the owner through the confirm dialog and a full retype of an
    // executable Schema only to fail at `Save`. The owner half matters even on a
    // single-owner deployment: `isOwnerHandle` is false for EVERYONE when
    // `NEXT_PUBLIC_OWNER_HANDLE` is unset (`owner.ts`), while the Workbench
    // itself is only signed-in-gated (`page.tsx`), so without this the affordance
    // is offered on a deployment where no save can ever land.
    //
    // The page half consults `isReadOnly()` and nothing else, because that is
    // exactly the set of refusals `PUT /api/wiki/[slug]` answers beyond its
    // realm-aware ACL: it is signed-in-gated, never owner-gated, so a page save
    // still lands for any principal the ACL admits. DW-37 added the read-only
    // gate to that route; this half now says what it says.
    editable:
      format === "markdown" &&
      ((slug !== undefined && !isReadOnly()) ||
        (artifact !== undefined && !isReadOnly() && isOwnerHandle(principal.handle))),
  };
  return json(payload);
}
