import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getChatConversation } from "@/lib/chat";
import { isReadOnly } from "@/lib/config";
import { getErrorMessage } from "@/lib/errors";
import { enqueueOrInline } from "@/lib/ingest-async";
import { ingest } from "@/lib/ingest";
import { createIngestJob } from "@/lib/ingest-jobs";
import { saveAnswerToWiki } from "@/lib/query";
import { saveRawSourceFor } from "@/lib/raw";
import { READ_ONLY_REFUSAL, isReadOnlyError } from "@/lib/read-only";
import { sourceSha256 } from "@/lib/source-sha256";

interface RouteContext {
  params: Promise<{ id: string }>;
}

function queryAnswerSourceSlug(pageSlug: string): string {
  const leaf = pageSlug.startsWith("queries/")
    ? pageSlug.slice("queries/".length)
    : pageSlug;
  return `query-${leaf}`;
}

export async function POST(request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  if (isReadOnly()) {
    return NextResponse.json(
      { error: READ_ONLY_REFUSAL.savedAnswer },
      { status: 403 },
    );
  }
  try {
    const { id } = await params;
    const conversation = await getChatConversation(principal.handle, id);
    if (!conversation) {
      return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    }
    const body = (await request.json().catch(() => ({}))) as {
      title?: unknown;
      content?: unknown;
    };
    const lastAssistant = [...conversation.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    const content =
      typeof body.content === "string" && body.content.trim()
        ? body.content.trim()
        : lastAssistant?.content.trim() ?? "";
    if (!content) {
      return NextResponse.json(
        { error: "No assistant answer to save." },
        { status: 400 },
      );
    }
    const title =
      typeof body.title === "string" && body.title.trim()
        ? body.title.trim()
        : conversation.title || "Chat answer";
    const sources = (lastAssistant?.citations ?? [])
      .map((citation) => citation.path.replace(/^wiki\//, "").replace(/\.md$/, ""))
      .filter((slug) => slug && !slug.includes("/"));
    const result = await saveAnswerToWiki(
      title,
      content,
      undefined,
      sources.length > 0 ? sources : undefined,
      "markdown",
      principal.handle,
      principal.handle,
      {
        conversationId: conversation.id,
        conversationName: conversation.title,
        underQueries: true,
      },
    );
    const sourceSlug = queryAnswerSourceSlug(result.slug);
    const contentSha256 = await sourceSha256(content);
    await saveRawSourceFor(sourceSlug, contentSha256, content, {
      owner: principal.handle,
    });
    const sourcePath = `raw/sources/${sourceSlug}/${contentSha256}.md`;
    const jobId = crypto.randomUUID();
    await createIngestJob({
      jobId,
      owner: principal.handle,
      title,
    });
    const ingestResponse = await enqueueOrInline(
      jobId,
      {
        kind: "ingest",
        title,
        content,
        owner: principal.handle,
        author: principal.handle,
        tags: ["query-answer"],
        jobId,
        sourceType: "text",
        sourcePath,
        contentSha256,
      },
      () =>
        ingest(title, content, {
          owner: principal.handle,
          author: principal.handle,
          triggeredBy: principal.handle,
          tags: ["query-answer"],
          sourceType: "text",
          sourcePath,
          contentSha256,
        }),
    );
    const ingestBody = (await ingestResponse.json().catch(() => ({}))) as {
      queued?: boolean;
      jobId?: string;
    };
    return NextResponse.json({
      slug: result.slug,
      path: `wiki/${result.slug}.md`,
      jobId: ingestBody.jobId ?? jobId,
      queued: ingestBody.queued ?? true,
      sourcePath,
    });
  } catch (error) {
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
    }
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
