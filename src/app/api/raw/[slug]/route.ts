import { NextResponse } from "next/server";
import { decodeSlug } from "@/lib/slugify";
import {
  listReadableWikiPages,
  readRawSource,
  readRawSourceById,
} from "@/lib/wiki";
import { getPrincipal, type Principal } from "@/lib/auth";
import { canReadSlug } from "@/lib/authz";
import { canonicalSlugHintForMissing } from "@/lib/page-redirect";
import { getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { buildKnowledgeTree, workbenchSlugGate } from "@/lib/workbench-tree";
import { rawPathAllowed } from "@/lib/workbench-files";

/**
 * GET /api/raw/[slug][?source=<rawId>]
 *
 * Returns a raw source as `text/plain`, suitable for download or programmatic
 * inspection. Without `?source`, returns the latest single blob; with a
 * `?source=<rawId>`, returns that per-source snapshot. Thin read-only wrapper —
 * the library functions own the path-traversal guard and not-found semantics.
 *
 * Read-only, NO-AUTH, and gated TWICE — the same pair `/api/assets/[...path]`
 * keeps (DW-536, extended here by DW-742), because the two gates cover disjoint
 * holes: {@link canReadSlug} is frontmatter-only and refuses an existing
 * PRIVATE page to a non-owner, while the Workbench slug gate refuses a page the
 * knowledge tree DROPS (an agent-scoped page is hidden without ever being
 * `visibility: private`). This door serves the raw SOURCE bytes the Workbench
 * Files tab lists under `raw/sources/<slug>`, so a narrower gate here was a
 * hole in that door's: the Files tab withheld the filename while a plain
 * unauthenticated GET still served the text. An anonymous request for a slug
 * both gates admit still gets the bytes.
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
    // Gate 2 — the WORKBENCH slug gate, derived the ONE way every other file
    // door derives it (`/api/assets/[...path]` is the reference:
    // `listReadableWikiPages` → `buildKnowledgeTree` → `workbenchSlugGate` →
    // `rawPathAllowed`). `canReadSlug` above is frontmatter-only, so it is not
    // the whole gate: an AGENT-SCOPED page needs no `visibility: private` to be
    // hidden — the knowledge tree drops it — and the Files tab withheld
    // `raw/sources/<slug>` while this door still served the raw SOURCE TEXT of
    // the very same page to an anonymous caller (DW-742). The two gates cover
    // disjoint holes exactly as they do on the assets door: `hiddenSlugs` is
    // derived from entries the principal can READ, so a private page an
    // anonymous caller cannot read is absent from that set entirely.
    //
    // ONE DISPLAY PATH DECIDES BOTH RAW SHAPES. `rawPathSlug` answers the same
    // slug for `raw/sources/<slug>.md` and `raw/sources/<slug>/<rawId>.<ext>`
    // (and the `queries/<leaf>` join behaves identically for both), so gating
    // on the flat path decides the `?source=` shape too — without ever
    // interpolating an unvalidated query value into a gate path.
    //
    // FAIL CLOSED, and in its OWN try/catch: the outer catch below collapses
    // everything to 404, which for a derivation failure would be a refusal that
    // looks like an ordinary miss. The page-index read behind the gate can fail
    // (storage outage, binding failure), and neither falling through to the
    // bytes nor silently 404-ing is right — log it and answer 500, the shape
    // the assets door already keeps for the same failure.
    let hiddenSlugs: ReadonlySet<string>;
    try {
      const entries = await listReadableWikiPages(principal);
      ({ hiddenSlugs } = workbenchSlugGate(entries, buildKnowledgeTree(entries)));
    } catch (err) {
      logger.error("raw", "slug gate derivation failed", err);
      return NextResponse.json({ error: "internal error" }, { status: 500 });
    }
    if (!rawPathAllowed(`raw/sources/${slug}.md`, hiddenSlugs)) {
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
