import { decodeSlug } from "@/lib/slugify";
import { notFound, permanentRedirect } from "next/navigation";
import {
  readRawSource,
  readRawSourceById,
  readWikiPageWithFrontmatter,
  tenantForOwner,
} from "@/lib/wiki";
import type { RawSourceWithContent } from "@/lib/raw";
import { parseSources } from "@/lib/sources";
import { pagePath, rawPath } from "@/lib/links";
import { canReadSlug } from "@/lib/authz";
import { getPrincipal } from "@/lib/auth";
import { aliasTargetForMissing } from "@/lib/page-redirect";
import { RawSourceBrowser, type RawItem } from "@/components/RawSourceBrowser";

interface RawSourcePageProps {
  params: Promise<{ handle: string; slug: string }>;
}

export default async function RawSourcePage({ params }: RawSourcePageProps) {
  const { handle: encodedHandle, slug: encodedSlug } = await params;
  const slug = decodeSlug(encodedSlug);
  // Read once and reuse: the alias gate below needs the same principal the
  // read check used, and two `getPrincipal()` calls would be two auth reads.
  const principal = await getPrincipal();

  // A private page's raw source is owner-only — 404 (same as missing) otherwise.
  if (!(await canReadSlug(slug, principal))) {
    notFound();
  }

  // The owner segment is canonical: resolve it from the page's frontmatter so
  // the "Back to page" link is correct regardless of the URL's handle.
  const ownerPage = await readWikiPageWithFrontmatter(slug);

  // The single latest blob, read AT MOST ONCE and shared with the legacy branch
  // below. `undefined` = not read yet; `null` = read and genuinely absent.
  let legacyBlob: RawSourceWithContent | null | undefined;

  if (!ownerPage) {
    // No page at this slug — but that does NOT mean nothing is here. A merge
    // hard-deletes the absorbed page while `deleteWikiPage` deliberately leaves
    // its `raw/` archive alone ("the raw layer is immutable"), so the archive
    // this route served before the merge is still on disk. Forwarding on
    // `!ownerPage` alone would hide it behind a 308 forever, so the forward is
    // gated on there being genuinely nothing left to serve at the old slug.
    try {
      legacyBlob = await readRawSource(slug);
    } catch {
      legacyBlob = null;
    }
    if (legacyBlob === null) {
      // A merged-away/renamed slug's RAW bookmark forwards (one 308) to the
      // survivor's raw URL, under the same principal-aware, fail-closed gate
      // the page and edit routes use. BEFORE the handle-canonicalization 308
      // on purpose — with no page, `pageTenant` below resolves to
      // DEFAULT_TENANT, so a non-default handle would otherwise burn a hop
      // redirecting to a URL that also misses. No target → fall through
      // unchanged (everything below already reads `ownerPage` with `?.`).
      const target = await aliasTargetForMissing(slug, principal);
      if (target) permanentRedirect(rawPath(target.tenant, target.canonical));
    }
  }

  const pageTenant = tenantForOwner(
    typeof ownerPage?.frontmatter.owner === "string"
      ? ownerPage.frontmatter.owner
      : undefined,
  );
  if (decodeSlug(encodedHandle).toLowerCase() !== pageTenant) {
    permanentRedirect(rawPath(pageTenant, slug));
  }

  // Build the source list from the page's provenance. Newest first.
  const sources = parseSources(
    ownerPage?.frontmatter.sources as string | string[] | undefined,
  )
    .slice()
    .reverse();
  const anyRaw = sources.some((s) => s.raw_id);

  let items: RawItem[];
  let initialKey: string;
  let initialContent: string | null = null;

  if (anyRaw) {
    // Per-source pages: one entry per source. Snapshots are viewable; sources
    // ingested before per-source raw existed are shown as "uncaptured".
    items = sources.map((s, i) => ({
      key: s.raw_id ?? `uncaptured-${i}`,
      kind: s.raw_id ? "snapshot" : "uncaptured",
      sourceId: s.raw_id ?? null,
      type: s.type,
      url: s.url,
      fetched: s.fetched,
      triggeredBy: s.triggered_by,
    }));
    const firstSnapshot = items.find((it) => it.kind === "snapshot")!;
    initialKey = firstSnapshot.key;
    try {
      initialContent = (await readRawSourceById(slug, firstSnapshot.sourceId!))
        .content;
    } catch {
      initialContent = null;
    }
  } else {
    // Legacy page: a single latest blob, regardless of how many sources exist.
    // Already read above when there was no page — reuse it rather than hitting
    // storage twice for the same file.
    if (legacyBlob === undefined) {
      try {
        legacyBlob = await readRawSource(slug);
      } catch {
        legacyBlob = null;
      }
    }
    if (!legacyBlob) notFound();
    const blob = legacyBlob;
    const latest = sources[0];
    items = [
      {
        key: "__legacy__",
        kind: "legacy",
        sourceId: null,
        type: latest?.type ?? "url",
        url: latest?.url ?? "text-paste",
        fetched: latest?.fetched ?? blob.modified.slice(0, 10),
        triggeredBy: latest?.triggered_by ?? "system",
      },
    ];
    initialKey = "__legacy__";
    initialContent = blob.content;
  }

  return (
    <RawSourceBrowser
      slug={slug}
      items={items}
      initialKey={initialKey}
      initialContent={initialContent}
      backHref={pagePath(pageTenant, slug)}
    />
  );
}
