import { NextResponse } from "next/server";
import { isFilesystemWikiId } from "@/lib/chat-contract";

interface RouteContext {
  params: Promise<{ wikiId: string }>;
}

/**
 * Cloud Chat is not hosted on the Worker. The browser posts to the loopback
 * sidecar; this route exists only to refuse the cloud origin.
 */
export async function POST(_request: Request, { params }: RouteContext) {
  const { wikiId } = await params;
  if (isFilesystemWikiId(wikiId)) {
    return NextResponse.json({ error: "invalid_wiki_id" }, { status: 400 });
  }
  return NextResponse.json({ error: "sidecar_required" }, { status: 503 });
}
