import type { Metadata } from "next";
import { permanentRedirect } from "next/navigation";
import { decodeSlug } from "@/lib/slugify";
import {
  readWikiPageWithFrontmatter,
  tenantForOwner,
} from "@/lib/wiki";
import { pagePath } from "@/lib/links";
import { getPrincipal } from "@/lib/auth";
import { canReadFrontmatter } from "@/lib/authz";
import { aliasRedirectForMissing } from "@/lib/page-redirect";
import { ArticleView } from "@/components/ArticleView";
import { getPageEvidence } from "@/lib/evidence";

interface WikiPageProps {
  params: Promise<{ handle: string; slug: string }>;
}

/**
 * Per-page Open Graph / Twitter metadata for the owner-scoped page URL — the
 * only page URL there is now that the commons is retired. Pages the viewer
 * can't read get a neutral title so existence isn't leaked.
 */
export async function generateMetadata({
  params,
}: WikiPageProps): Promise<Metadata> {
  const { slug: encodedSlug } = await params;
  const slug = decodeSlug(encodedSlug);
  const page = await readWikiPageWithFrontmatter(slug);
  if (!page || !canReadFrontmatter(page.frontmatter, await getPrincipal())) {
    // The layout's title template appends " · work-wiki".
    return { title: "Page not found" };
  }
  const tenant = tenantForOwner(
    typeof page.frontmatter.owner === "string"
      ? page.frontmatter.owner
      : undefined,
  );
  const description =
    typeof page.frontmatter.summary === "string"
      ? page.frontmatter.summary
      : undefined;
  const url = pagePath(tenant, slug);
  return {
    title: page.title, // layout template appends " · work-wiki"
    ...(description ? { description } : {}),
    alternates: { canonical: url },
    openGraph: {
      title: page.title,
      ...(description ? { description } : {}),
      url,
      type: "article",
    },
    twitter: {
      card: "summary",
      title: page.title,
      ...(description ? { description } : {}),
    },
  };
}

/**
 * The owner-scoped page route — the ONLY page-view surface. The public commons
 * URL `/wiki/<slug>` is retired, so every readable page (public or private)
 * renders here, behind a read-authorization check.
 */
export default async function WikiPageView({ params }: WikiPageProps) {
  const { handle: encodedHandle, slug: encodedSlug } = await params;
  const slug = decodeSlug(encodedSlug);
  const page = await readWikiPageWithFrontmatter(slug);
  const principal = await getPrincipal();

  // A private page the viewer can't read is indistinguishable from a missing
  // one (same 404 UI) — never reveal that a private page exists.
  if (!page || !canReadFrontmatter(page.frontmatter, principal)) {
    // A merged-away/renamed slug forwards (one 308) to its survivor's
    // canonical URL — but only when THIS viewer may read the survivor, so
    // forwarding never becomes a private-page existence oracle.
    const target = await aliasRedirectForMissing(slug, principal);
    if (target) permanentRedirect(target);
    return (
      <div className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-3xl font-bold">Page not found</h1>
        <p className="mt-4 text-foreground/60">
          No wiki page exists for &ldquo;{slug}&rdquo;.
        </p>
      </div>
    );
  }

  // The page is addressed by slug (globally unique pre-P5); the handle segment
  // is the canonical owner. If the URL handle doesn't match the page's real
  // tenant (wrong owner, or stale/mixed-case), 308 to the canonical URL so
  // every page has one indexable address.
  const pageTenant = tenantForOwner(
    typeof page.frontmatter.owner === "string"
      ? page.frontmatter.owner
      : undefined,
  );
  if (decodeSlug(encodedHandle).toLowerCase() !== pageTenant) {
    permanentRedirect(pagePath(pageTenant, slug));
  }

  // Readable page → render with the real principal (so its backlinks include
  // the viewer's own private pages).
  // The `disputed` banner no longer reports whether a reconciliation is open:
  // talk is retired with the commons (AD-21), so no surface can open, show, or
  // close a thread, and a reader told one exists has nowhere to act on it.
  const evidenceBundle = principal && tenantForOwner(principal.handle) === pageTenant
    ? await getPageEvidence(principal.handle, slug)
    : null;
  return (
    <ArticleView
      page={page}
      slug={slug}
      pageTenant={pageTenant}
      principal={principal}
      evidenceBundle={evidenceBundle}
    />
  );
}
