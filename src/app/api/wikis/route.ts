import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { ClientInputError, getErrorMessage } from "@/lib/errors";
import { createWiki, getWikiRegistry, parseCreateWikiInput } from "@/lib/wikis";

/**
 * GET /api/wikis — the owner's Wiki registry: `{ wikis, currentId }`.
 *
 * Clerk-session-only, so the middleware gate covers it and there is no
 * `IN_ROUTE_AUTH_PATHS` entry to add.
 */
export async function GET() {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const registry = await getWikiRegistry(principal.handle);
    return NextResponse.json({
      wikis: registry.wikis,
      currentId: registry.currentId,
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

/**
 * POST /api/wikis — create a Wiki from one of the five Scenario Templates.
 *
 * Body: `{ name, scenario }`. `custom`, an unknown scenario, and a blank name
 * are all 400s: there is no blank Wiki (FR-38). Seeds `purpose.md`,
 * `schema.md`, and the workspace profile, and makes the new Wiki current.
 */
export async function POST(request: Request) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  if (isReadOnly()) {
    return NextResponse.json(
      { error: "Wikis cannot be created while this deployment is read-only." },
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
    const wiki = await createWiki(principal.handle, parseCreateWikiInput(body));
    return NextResponse.json({ wiki }, { status: 201 });
  } catch (error) {
    const status = error instanceof ClientInputError ? 400 : 500;
    return NextResponse.json({ error: getErrorMessage(error) }, { status });
  }
}
