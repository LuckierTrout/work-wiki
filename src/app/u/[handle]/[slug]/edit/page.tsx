import Link from "next/link";
import { permanentRedirect } from "next/navigation";
import { decodeSlug } from "@/lib/slugify";
import { readWikiPageWithFrontmatter, tenantForOwner } from "@/lib/wiki";
import { pagePath, editPath } from "@/lib/links";
import { canReadFrontmatter, canWriteFrontmatter } from "@/lib/authz";
import { resolveWriteDenial } from "@/lib/write-denial";
import { aliasTargetForMissing } from "@/lib/page-redirect";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { WikiEditor } from "@/components/WikiEditor";
import { contentVersion } from "@/lib/write-precondition";

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
    // A merged-away/renamed slug's EDIT bookmark forwards (one 308) to the
    // survivor's edit URL — the page route already did this for the read view,
    // and forwarding to `pagePath` here would drop an editor onto the article.
    // Same principal-aware, fail-closed gate, so it never becomes a
    // private-page existence oracle; `null` keeps the copy below unchanged.
    // This runs BEFORE the handle-canonicalization 308 further down (which is
    // unreachable on this branch anyway), so a miss lands on the survivor in
    // one hop rather than bouncing through DEFAULT_TENANT first.
    const target = await aliasTargetForMissing(slug, principal);
    if (target) permanentRedirect(editPath(target.tenant, target.canonical));
    return (
      <div className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-3xl font-bold">Page not found</h1>
        <p className="mt-4 text-foreground/60">
          No wiki page exists for &ldquo;{slug}&rdquo; — nothing to edit.
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

  // Readable but not writable — show a clear message instead of the editor.
  // This is a body editor, so pass "body" to enforce the commons realm gate.
  //
  // ORDERING, AND WHAT EACH POSITION BUYS (read cloak → canonical 308 → this):
  //
  //   - The read cloak MUST stay first. Moving the 308 above it would turn the
  //     redirect into a private-page existence oracle: a viewer who may not
  //     read the page would learn its canonical owner from the Location header.
  //   - This denial MUST stay after the 308. Rendered before it, a
  //     non-canonical URL like `/u/bob/transformers/edit` answered a refusal
  //     whose "← Back to page" link pointed at `/u/alice/transformers` — a
  //     screen that belongs to a different handle than the one in the address
  //     bar. After the 308 the refusal always describes the URL the viewer is
  //     actually on, and `pageTenant` above is the one it was canonicalized to
  //     (computed once, not re-derived for the back-link).
  //
  // The copy may state the page's realm outright because this branch is
  // reachable for exactly one kind of page: the read cloak already returned
  // "Page not found" for an unreadable private page, and a READABLE private
  // page is writable by the same principals that could read it. So a denial
  // here means a public, non-agent-scoped, non-artifact page — the class
  // `belongsInCommons` names. Keep that ordering, or the sentence stops being
  // true (and would leak a private page's realm). The sentence itself comes
  // from `resolveWriteDenial`, the same call the nine server denies make, so
  // this screen and the 403 behind Save cannot word the refusal differently —
  // and the realm claim is re-derived from THIS page rather than asserted by
  // the reachability argument above. (Given that argument the resolver always
  // answers the realm sentence here; routing through it is what keeps that a
  // fact about the page instead of a comment about the ordering.)
  if (!canWriteFrontmatter(page.frontmatter, principal, "body")) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-12">
        <Link
          href={pagePath(pageTenant, slug)}
          className="text-sm text-foreground/60 hover:text-foreground transition-colors"
        >
          ← Back to page
        </Link>
        <h1 className="mt-6 text-3xl font-bold">Cannot edit</h1>
        <p className="mt-4 text-foreground/60">
          {resolveWriteDenial("edit", page.frontmatter, "body")}
        </p>
      </div>
    );
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
          // The WHOLE stored file, not `page.body`: `PUT /api/wiki/[slug]`
          // checks the precondition against `existing.content`, which still
          // carries the YAML block the editor never sees. Two versions over two
          // different strings would never match.
          initialVersion={contentVersion(page.content)}
          initialMetadata={initialMetadata}
          // A server component, so the env fact is read here. `PUT`/`PATCH
          // /api/wiki/[slug]` refuse on a read-only deployment (DW-37); the
          // editor says so before the owner rewrites the page.
          readOnly={isReadOnly()}
        />
      </section>
    </div>
  );
}
