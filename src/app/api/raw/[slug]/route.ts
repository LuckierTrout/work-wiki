import { NextResponse } from "next/server";
import { decodeSlug } from "@/lib/slugify";
import {
  readRawSource,
  readRawSourceById,
} from "@/lib/wiki";
import { getPrincipal, type Principal } from "@/lib/auth";
import { canReadSlug } from "@/lib/authz";
import { canonicalSlugHintForMissing } from "@/lib/page-redirect";
import { getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { rawSourceAccessAllowed } from "@/lib/raw-source-access";

/**
 * GET /api/raw/[slug][?source=<rawId>]
 *
 * Returns a raw source as `text/plain`, suitable for download or programmatic
 * inspection. Without `?source`, returns the latest single blob; with a
 * `?source=<rawId>`, returns that per-source snapshot. Thin read-only wrapper —
 * the library functions own the path-traversal guard and not-found semantics.
 *
 * Both raw surfaces check strict frontmatter access first, then the shared
 * additional raw-source gate. The deployment owner may view and download
 * agent-scoped sources (DW-771); other callers retain the Workbench visibility
 * boundary. Ordinary public sources remain available without a session.
 *
 * MISS-404s CARRY `canonicalSlug` (DW-233). The `/u/<handle>/raw/<slug>` page
 * component 308s a merged-away slug to the survivor's raw view; this door used
 * to hard-404 it, so an HTTP caller holding the old slug had no way to follow.
 * The recorded 2026-08-28 decision keeps the 404 STATUS here — an API caller is
 * not a browser — and adds the survivor's slug to the body instead,
 * projected from the very same gate through
 * {@link canonicalSlugHintForMissing}. The field is ADDITIVE and present only
 * when that principal-aware, fail-closed gate resolves a survivor, so the
 * existence-oracle properties are the page routes' properties, unchanged.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  // Hoisted out of the `try` so the catch below can ask for the hint too. That
  // catch is the exit a merged-away slug actually takes: `canReadSlug` answers
  // TRUE for an absent page (the caller's own not-found handling speaks), so
  // the request falls through to `readRawSource`, which throws when no blob is
  // archived at the old slug. `principal` is assigned immediately after `slug`,
  // and a failure to resolve either leaves it `null` — the gate's own
  // fail-closed input.
  let slug: string | null = null;
  let principal: Principal | null = null;
  try {
    const { slug: encodedSlug } = await params;
    slug = decodeSlug(encodedSlug);
    principal = await getPrincipal();
    // A private page's raw source is owner-only — 404 otherwise (same as missing).
    if (!(await canReadSlug(slug, principal))) {
      // No hint here in practice: this arm fires only for a page that EXISTS
      // but is unreadable, and the alias index maps every live slug to itself,
      // so the gate's `canonical !== slug` guard declines. Spread anyway rather
      // than reasoned about at the call site — one gate decides, not two.
      return NextResponse.json(
        { error: "not found", ...(await canonicalSlugHintForMissing(slug, principal)) },
        { status: 404 },
      );
    }
    // Keep derivation failures distinct from ordinary source misses. The
    // shared gate throws on uncertainty; this API logs and sanitizes it.
    let allowed: boolean;
    try {
      allowed = await rawSourceAccessAllowed(slug, principal);
    } catch (err) {
      logger.error("raw", "slug gate derivation failed", err);
      return NextResponse.json({ error: "internal error" }, { status: 500 });
    }
    if (!allowed) {
      // The route's existing 404 shape, so this door stays a non-oracle and the
      // DW-233 merged-away-slug hint keeps behaving as it does on every other
      // refusal here.
      return NextResponse.json(
        { error: "not found", ...(await canonicalSlugHintForMissing(slug, principal)) },
        { status: 404 },
      );
    }

    const sourceId = new URL(req.url).searchParams.get("source");
    const source = sourceId
      ? await readRawSourceById(slug, sourceId)
      : await readRawSource(slug);
    return new NextResponse(source.content, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        // Advise (but don't force) a sensible filename when users hit
        // "save as" — browsers still render inline by default.
        "Content-Disposition": `inline; filename="${source.filename}"`,
      },
    });
  } catch (err) {
    const message = getErrorMessage(err);
    // Both "invalid slug" and "not found" collapse to 404 from the
    // caller's perspective — neither reveals whether a file exists.
    const hint = slug ? await canonicalSlugHintForMissing(slug, principal) : {};
    return NextResponse.json({ error: message, ...hint }, { status: 404 });
  }
}
