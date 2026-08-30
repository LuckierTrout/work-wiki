import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { ClientInputError, getErrorMessage } from "@/lib/errors";
import { isOwnerPrincipal } from "@/lib/owner";
import { isReadOnlyError } from "@/lib/read-only";
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
 * Owner-only (DW-159): signing in is not enough — the creation door is gated on
 * `isOwnerPrincipal`, in the same 401 → owner → read-only order the other
 * owner-gated write door (`PUT /api/workbench/artifact`) uses.
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
  // THE OWNER, not merely someone signed in. A non-owner's Wiki would be inert:
  // `readActiveWikiSchema()` resolves the Schema that executes from
  // `getOwnerHandle()`, so nothing a non-owner's Wiki holds is ever read by a
  // prompt, and `src/app/api/workbench/artifact/route.ts` 403s its Schema
  // edits. work-wiki is a single-owner deployment (`owner.ts`), so this is a
  // refusal, not a permission model — and it sits BEFORE the read-only check
  // and before body parsing, matching the artifact route, so both write doors
  // answer a non-owner identically whatever else is true of the request.
  //
  // FAILS CLOSED, deliberately: `isOwnerPrincipal` answers false for EVERYONE
  // when NEITHER `YOPEDIA_OWNER_USER_ID` NOR `NEXT_PUBLIC_OWNER_HANDLE` is set
  // or non-blank, so an unconfigured deployment refuses creation to every caller
  // including the deployer. A deployment with no owner has nobody to create for,
  // and opening the door to "any signed-in user" on a missing env var is the
  // failure this ordering exists to avoid — so an operator meeting this 403 on a
  // fresh deploy should set those vars.
  //
  // DECIDED ON THE STABLE CLERK ID (DW-486), not the handle, whenever
  // `YOPEDIA_OWNER_USER_ID` is configured: that is the same fact the middleware
  // admitted this request on, so the owner the deployment gate let through can
  // never be the caller this 403 turns away.
  if (!isOwnerPrincipal(principal)) {
    return NextResponse.json(
      { error: "Only the workspace owner can create Wikis." },
      { status: 403 },
    );
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
    // Backstop for a flag that flipped mid-request: the gate above already
    // answered for a deployment that was read-only when the request arrived, so
    // reaching here means the kernel writer refused. A refusal is neither a
    // server fault nor the caller's bad input.
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
    }
    const status = error instanceof ClientInputError ? 400 : 500;
    return NextResponse.json({ error: getErrorMessage(error) }, { status });
  }
}
