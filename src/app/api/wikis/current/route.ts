import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { ClientInputError, getErrorMessage } from "@/lib/errors";
import { setCurrentWiki } from "@/lib/wikis";

/**
 * PUT /api/wikis/current — set the active Wiki.
 *
 * Body: `{ id }`. The selection is durable server-side (AD-23) rather than a
 * browser-local preference, so it survives a reload on any device. 404 when
 * the id names no Wiki in the owner's registry.
 */
export async function PUT(request: Request) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  if (isReadOnly()) {
    return NextResponse.json(
      { error: "The active wiki cannot be changed while this deployment is read-only." },
      { status: 403 },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const id =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { id?: unknown }).id
      : undefined;
  if (typeof id !== "string" || !id.trim()) {
    return NextResponse.json({ error: "A wiki id is required." }, { status: 400 });
  }
  try {
    const wiki = await setCurrentWiki(principal.handle, id);
    return wiki
      ? NextResponse.json({ wiki })
      : NextResponse.json({ error: "Wiki not found." }, { status: 404 });
  } catch (error) {
    const status = error instanceof ClientInputError ? 400 : 500;
    return NextResponse.json({ error: getErrorMessage(error) }, { status });
  }
}
