import Link from "next/link";
import { permanentRedirect } from "next/navigation";
import { decodeSlug } from "@/lib/slugify";
import { readWikiPageWithFrontmatter, tenantForOwner } from "@/lib/wiki";
import { pagePath, editPath } from "@/lib/links";
import { canReadFrontmatter, canWriteFrontmatter } from "@/lib/authz";
import { getPrincipal } from "@/lib/auth";
import { WikiEditor } from "@/components/WikiEditor";

interface EditPageProps {
  params: Promise<{ handle: string; slug: string }>;
}

export default async function EditWikiPage({ params }: EditPageProps) {
  const { handle: encodedHandle, slug: encodedSlug } = await params;
  const slug = decodeSlug(encodedSlug);
  const page = await readWikiPageWithFrontmatter(slug);
  const principal = await getPrincipal();

  // A private page the viewer can't read is indistinguishable from missing.
  if (!page || !canReadFrontmatter(page.frontmatter, principal)) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-3xl font-bold">Page not found</h1>
        <p className="mt-4 text-foreground/60">
          No wiki page exists for &ldquo;{slug}&rdquo; — nothing to edit.
        </p>
      </div>
    );
  }

  // Readable but not writable — show a clear message instead of the editor.
  // This is a body editor, so pass "body" to enforce the commons realm gate.
  //
  // The copy below may state the page's realm outright because this branch is
  // reachable for exactly one kind of page: the read cloak above already
  // returned "Page not found" for an unreadable private page, and a READABLE
  // private page is writable by the same principals that could read it. So a
  // denial here means a public, non-agent-scoped, non-artifact page — the class
  // `belongsInCommons` names. Keep that ordering, or the sentence stops
  // being true (and would leak a private page's realm).
  if (!canWriteFrontmatter(page.frontmatter, principal, "body")) {
    const backHref = pagePath(tenantForOwner(
      typeof page.frontmatter.owner === "string"
        ? page.frontmatter.owner
        : undefined,
    ), slug);
    return (
      <div className="mx-auto max-w-3xl px-6 py-12">
        <Link
          href={backHref}
          className="text-sm text-foreground/60 hover:text-foreground transition-colors"
        >
          ← Back to page
        </Link>
        <h1 className="mt-6 text-3xl font-bold">Cannot edit</h1>
        <p className="mt-4 text-foreground/60">
          This page is public knowledge, and public knowledge pages are agent-maintained
          — their prose is written and curated by agents, so it can&rsquo;t be
          rewritten or deleted here. Only an agent or a site admin can revise
          this page&rsquo;s text.
        </p>
      </div>
    );
  }

  // Canonical owner segment; 308 to the canonical edit URL on mismatch.
  const pageTenant = tenantForOwner(
    typeof page.frontmatter.owner === "string"
      ? page.frontmatter.owner
      : undefined,
  );
  if (decodeSlug(encodedHandle).toLowerCase() !== pageTenant) {
    permanentRedirect(editPath(pageTenant, slug));
  }

  // Extract the 7 patchable metadata fields from frontmatter for the editor.
  const fm = page.frontmatter;
  const initialMetadata = {
    confidence: typeof fm.confidence === "number" ? fm.confidence : null,
    disputed: fm.disputed === true,
    tags: Array.isArray(fm.tags) ? (fm.tags as string[]) : [],
    aliases: Array.isArray(fm.aliases) ? (fm.aliases as string[]) : [],
    expiry: typeof fm.expiry === "string" ? fm.expiry : "",
    valid_from: typeof fm.valid_from === "string" ? fm.valid_from : "",
    supersedes: typeof fm.supersedes === "string" ? fm.supersedes : "",
  };

  return (
    <div className="shell paper-route fade" style={{ paddingTop: 48, paddingBottom: 92 }}>
      <Link
        href={pagePath(pageTenant, slug)}
        className="text-sm text-foreground/60 hover:text-foreground transition-colors"
      >
        ← Back to page
      </Link>
      <p className="fmark" style={{ marginTop: 28, marginBottom: 16 }}>edit with attribution</p>
      <h1 className="display" style={{ fontSize: "clamp(36px,4.5vw,58px)", margin: 0 }}>
        Edit {page.title}
      </h1>
      <p style={{ color: "var(--ink-2)", fontSize: 17, margin: "11px 0 30px", maxWidth: "64ch" }}>
        Revise the page while preserving citations, ownership, and an attributable revision receipt.
      </p>
      <section style={{ maxWidth: 1000, borderTop: "1px solid var(--rule)", paddingTop: 28 }}>
        <WikiEditor
          slug={slug}
          tenant={pageTenant}
          initialContent={page.body}
          initialMetadata={initialMetadata}
        />
      </section>
    </div>
  );
}
