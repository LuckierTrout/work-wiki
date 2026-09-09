import { ownerTenantHandle } from "@/lib/owner";
import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { getErrorMessage, isClientInputError } from "@/lib/errors";
import { isReadOnlyError } from "@/lib/read-only";
import { applyScenarioTemplate, parseScenarioInput } from "@/lib/wikis";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/wikis/<id>/template — apply a different Scenario Template.
 *
 * The server half of the confirm-gated overwrite: rewrites `purpose.md`,
 * `schema.md`, and the workspace profile for that Wiki, and nothing else —
 * Pages, Sources, the page index, and the log are untouched. 404 when the id
 * names no Wiki.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  if (isReadOnly()) {
    return NextResponse.json(
      { error: "Templates cannot be applied while this deployment is read-only." },
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
    const { id } = await params;
    const wiki = await applyScenarioTemplate(
      ownerTenantHandle(principal),
      id,
      parseScenarioInput(body),
      principal.handle,
    );
    return wiki
      ? NextResponse.json({ wiki })
      : NextResponse.json({ error: "Wiki not found." }, { status: 404 });
  } catch (error) {
    // Backstop for a flag that flipped mid-request: the gate above already
    // answered for a deployment that was read-only when the request arrived, so
    // reaching here means the kernel writer refused. A refusal is neither a
    // server fault nor the caller's bad input.
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
    }
    const status = isClientInputError(error) ? 400 : 500;
    return NextResponse.json({ error: getErrorMessage(error) }, { status });
  }
}
