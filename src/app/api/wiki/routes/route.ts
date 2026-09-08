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
  // Null prototype, the same construction-site idiom as the other slug→tenant
  // maps (DW-232): the keys are content-derived slugs, so the literal that
  // builds them is where the guard belongs. Nothing indexes this map here — it
  // is written once and serialized — and the client rebuilds a fresh object
  // from `r.json()` (`useSlugTenants`), where `resolveSlugPath`'s own-property
  // guard is what actually protects the lookup. `NextResponse.json` walks own
  // enumerable properties, so the response body is byte-identical.
  const map: Record<string, string> = Object.create(null);
  for (const p of pages) map[p.slug] = ownerToTenant(p.owner);
  return NextResponse.json(map);
}
