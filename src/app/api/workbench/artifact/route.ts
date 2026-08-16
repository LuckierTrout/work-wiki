import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { ClientInputError, getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { isOwnerHandle } from "@/lib/owner";
import { PAGE_CONVENTIONS_REQUIRED_COPY, hasPageConventions } from "@/lib/schema-source";
import { isEditableArtifactFile } from "@/lib/wiki-scenarios";
import { getWikiRegistry, writeWikiArtifact } from "@/lib/wikis";
import { PREVIEW_MAX_CHARS } from "@/lib/workbench-preview";

/**
 * PUT /api/workbench/artifact?path=schema.md — the Schema edit (Story 1.8).
 *
 * The write half of the Preview's confirm-gated editor for the one Wiki artifact
 * an owner may change. Body is `{ content }`: the whole file, because an
 * artifact has no frontmatter for the server to own.
 *
 * THE TARGET IS AN ALLOWLIST, NOT A PATH. `?path=` is matched against
 * `EDITABLE_ARTIFACT_FILES` and everything else — `purpose.md`, `wiki/alpha.md`,
 * `../secrets`, absent — gets ONE identical 400. The route deliberately does not
 * re-use `resolveWorkbenchFile`, which also resolves `wiki/` and `raw/` keys: a
 * write route that accepted every path the READ route resolves would be a wider
 * door onto the same bytes than the read side has.
 *
 * THE WIKI IS RE-DERIVED, NEVER NAMED BY THE CALLER. The id comes from
 * `getWikiRegistry(principal.handle).currentId`, exactly as
 * `api/workbench/preview/route.ts` resolves it for the read. The browser can
 * address neither a tenant, nor a Wiki, nor a storage key.
 *
 * NO EXISTENCE ORACLE EITHER. The refusals above are about the caller's own
 * request, so they carry a sentence the owner can act on — but nothing here
 * discloses what any other path resolves to.
 */

/**
 * Per-principal and gated, like every answer in this tree — no shared cache and
 * no browser back/forward store may hold one.
 */
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/**
 * ONE body for every path that is not the editable artifact. Deliberately says
 * nothing about which of the four it was, and names no file.
 */
const NOT_EDITABLE = {
  error: "That file can’t be edited here.",
} as const;

export async function PUT(request: Request) {
  try {
    return await handle(request);
  } catch (error) {
    // A `ClientInputError` is the caller's input — `wikis.ts` throws it for an
    // unparseable owner or Wiki id — and everything else is ours. Without this
    // wrap a throw escapes as a framework 500 whose body is not `{ error }`,
    // which is the shape `savePreviewBody` parses.
    const status = error instanceof ClientInputError ? 400 : 500;
    if (status === 500) {
      logger.error("workbench-artifact", "artifact write failed", error);
    }
    return json({ error: getErrorMessage(error) }, status);
  }
}

async function handle(request: Request) {
  const principal = await getPrincipal();
  if (!principal) {
    return json({ error: "Sign in required." }, 401);
  }
  // THE OWNER, not merely someone signed in. `writeWikiArtifact` addresses the
  // CALLER's tenant, while `readActiveWikiSchema()` resolves the Schema that
  // executes from `getOwnerHandle()` — so a non-owner's save would land bytes
  // nowhere a prompt ever reads, answer 200, write a log line and move the
  // refresh counter. That is exactly the silently-inert save `hasPageConventions`
  // exists to prevent, arriving by another door. work-wiki is a single-owner
  // deployment (`owner.ts`), so this is a refusal, not a permission model.
  if (!isOwnerHandle(principal.handle)) {
    return json({ error: "Only the workspace owner can edit the Schema." }, 403);
  }
  if (isReadOnly()) {
    return json(
      { error: "The Schema cannot be edited while this deployment is read-only." },
      403,
    );
  }

  const target = new URL(request.url).searchParams.get("path");
  if (!isEditableArtifactFile(target)) {
    return json(NOT_EDITABLE, 400);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  const content = (body as { content?: unknown } | null)?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    return json({ error: "The Schema must be text, and cannot be empty." }, 400);
  }
  // The same cap the Preview reads under. Above it the route would serve back a
  // PREFIX marked `truncated`, and `previewWriteTarget` refuses to edit a
  // truncated body — so an oversized Schema saved here would be one the owner
  // could never edit again through the surface that wrote it.
  if (content.length > PREVIEW_MAX_CHARS) {
    return json(
      {
        error: `A Schema must be ${new Intl.NumberFormat("en-US").format(
          PREVIEW_MAX_CHARS,
        )} characters or fewer.`,
      },
      400,
    );
  }
  // Composed from the loader's own primitives — see `hasPageConventions`. A
  // Schema saved without that section is INERT: `loadPageConventions()` falls
  // back to the repo-root `SCHEMA.md`, so the owner would be told the save
  // succeeded while their Schema stopped steering anything.
  if (!hasPageConventions(content)) {
    return json({ error: PAGE_CONVENTIONS_REQUIRED_COPY }, 400);
  }

  const { currentId } = await getWikiRegistry(principal.handle);
  if (!currentId) {
    return json({ error: "Wiki not found." }, 404);
  }

  // One writer, and it owns the tail: the bytes, then the activity log and the
  // `dataVersion` bump, both fail-soft. A log or counter hiccup after the bytes
  // landed must never be reported to the owner as a failed save.
  await writeWikiArtifact(principal.handle, currentId, target, content);
  return json({ ok: true });
}
