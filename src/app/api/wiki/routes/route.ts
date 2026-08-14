import { NextResponse } from "next/server";
import { listReadableWikiPages, ownerToTenant } from "@/lib/wiki";
import { getPrincipal } from "@/lib/auth";

/**
 * slug → canonical tenant, over the caller's READABLE pages. Lets client
 * components (search, query sources, lint, batch, ingest) build canonical
 * `/u/<tenant>/<slug>` links without threading `owner` through every payload.
 * Readability-gated: a private page only appears in its owner's map, so this
 * never leaks another user's private slugs. An unknown slug falls back on the
 * client to the default tenant's `/u/` URL (see `slugPath`), which 308s to the
 * page's real tenant — the retired `/wiki/<slug>` form is never emitted.
 */
export async function GET() {
  const pages = await listReadableWikiPages(await getPrincipal());
  const map: Record<string, string> = {};
  for (const p of pages) map[p.slug] = ownerToTenant(p.owner);
  return NextResponse.json(map);
}
