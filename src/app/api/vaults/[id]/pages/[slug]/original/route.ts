import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { listDocumentSources } from "@/lib/document-sources";
import { getStorage } from "@/lib/storage";
import { decodeSlug } from "@/lib/slugify";
import { listVaults } from "@/lib/vault";

interface Params {
  params: Promise<{ id: string; slug: string }>;
}

function asciiFilename(filename: string): string {
  return (
    filename
      .replace(/[\r\n"]/g, "_")
      .replace(/[^\x20-\x7e]/g, "_")
      .slice(0, 180) || "document"
  );
}

function safeContentType(contentType: string): string {
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(contentType)
    ? contentType
    : "application/octet-stream";
}

/** Owner-only access to an original file represented inside a vault. */
export async function GET(request: Request, { params }: Params) {
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
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }

  const digest = new URL(request.url).searchParams.get("source");
  let sources;
  try {
    sources = await listDocumentSources(slug, principal.handle);
  } catch {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }
  const source = sources.find((candidate) => candidate.sha256 === digest);
  if (!source) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }

  try {
    const bytes = await getStorage().readAsset(source.originalKey);
    const fallbackName = asciiFilename(source.filename);
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "Content-Type": safeContentType(source.contentType),
        "Content-Disposition": `inline; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(source.filename)}`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }
}
