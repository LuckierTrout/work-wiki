import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { ClientInputError, getErrorMessage } from "@/lib/errors";
import { deleteWiki, parseRenameWikiInput, renameWiki } from "@/lib/wikis";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * PATCH /api/wikis/<id> — rename a Wiki.
 *
 * Body: `{ name }`. Moves the registry entry's name and the `# <name>` heading
 * of that Wiki's `purpose.md`, and nothing else — the Scenario Template, the
 * Schema, the workspace profile, Pages and Sources are untouched. 404 when the
 * id names no Wiki.
 */
export async function PATCH(request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  if (isReadOnly()) {
    return NextResponse.json(
      { error: "Wikis cannot be renamed while this deployment is read-only." },
      { status: 403 },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  try {
    const { name } = parseRenameWikiInput(body);
    const { id } = await params;
    const wiki = await renameWiki(principal.handle, id, name);
    return wiki
      ? NextResponse.json({ wiki })
      : NextResponse.json({ error: "Wiki not found." }, { status: 404 });
  } catch (error) {
    const status = error instanceof ClientInputError ? 400 : 500;
    return NextResponse.json({ error: getErrorMessage(error) }, { status });
  }
}

/**
 * DELETE /api/wikis/<id> — remove a Wiki and its `wikis/<id>/` directory.
 *
 * No body, so there is no JSON parse guard to fail: the id is the whole
 * request. Deleting the ACTIVE Wiki is a 400 — the pointer decides which
 * `schema.md` every prompt executes, and this route will not move it as a side
 * effect. 404 when the id names no Wiki. Pages and Sources are tenant-wide and
 * are never removed.
 */
export async function DELETE(_request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  if (isReadOnly()) {
    return NextResponse.json(
      { error: "Wikis cannot be deleted while this deployment is read-only." },
      { status: 403 },
    );
  }
  try {
    const { id } = await params;
    const wiki = await deleteWiki(principal.handle, id);
    return wiki
      ? NextResponse.json({ wiki })
      : NextResponse.json({ error: "Wiki not found." }, { status: 404 });
  } catch (error) {
    const status = error instanceof ClientInputError ? 400 : 500;
    return NextResponse.json({ error: getErrorMessage(error) }, { status });
  }
}
