import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { canReadFrontmatter } from "@/lib/authz";
import { rawPath } from "@/lib/links";
import { decodeSlug } from "@/lib/slugify";
import { listVaults } from "@/lib/vault";
import { readWikiPageWithFrontmatter, tenantForOwner } from "@/lib/wiki";

interface Params {
  params: Promise<{ id: string; slug: string }>;
}

/** GET a page preview, but only through one of the signed-in owner's vaults. */
export async function GET(_request: Request, { params }: Params) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  const { id, slug: encodedSlug } = await params;
  const vault = (await listVaults(principal.handle)).find(
    (candidate) => candidate.id === id,
  );
  if (!vault) {
    return NextResponse.json({ error: "Vault not found." }, { status: 404 });
  }

  const slug = decodeSlug(encodedSlug);
  if (!vault.slugs.includes(slug)) {
    return NextResponse.json({ error: "Page not found." }, { status: 404 });
  }

  const page = await readWikiPageWithFrontmatter(slug);
  if (!page || !canReadFrontmatter(page.frontmatter, principal)) {
    return NextResponse.json({ error: "Page not found." }, { status: 404 });
  }

  const owner =
    typeof page.frontmatter.owner === "string"
      ? page.frontmatter.owner
      : undefined;
  return NextResponse.json({
    page: {
      slug,
      title: page.title,
      body: page.body,
      rawHref: rawPath(tenantForOwner(owner), slug),
    },
  });
}
