import { ownerTenantHandle } from "@/lib/owner";
import { NextResponse } from "next/server";
import { citationPathAllowed } from "@/lib/chat-citations";
import { getChatConversation } from "@/lib/chat";
import { isReadOnly } from "@/lib/config";
import { getErrorMessage } from "@/lib/errors";
import { enqueueOrInline } from "@/lib/ingest-async";
import { ingest } from "@/lib/ingest";
import { createIngestJob } from "@/lib/ingest-jobs";
import { requireOwnerPrincipal } from "@/lib/owner-route";
import { saveAnswerToWiki } from "@/lib/query";
import { saveRawSourceFor } from "@/lib/raw";
import { READ_ONLY_REFUSAL, isReadOnlyError } from "@/lib/read-only";
import { sourceSha256 } from "@/lib/source-sha256";
import { validateSlug } from "@/lib/wiki";

interface RouteContext {
  params: Promise<{ id: string }>;
}

function queryAnswerSourceSlug(pageSlug: string): string {
  const leaf = pageSlug.startsWith("queries/")
    ? pageSlug.slice("queries/".length)
    : pageSlug;
  return `query-${leaf}`;
}

function wikiSlugFromCitationPath(path: string): string | null {
  if (!path.startsWith("wiki/") || !path.endsWith(".md")) return null;
  const slug = path.slice("wiki/".length, -".md".length);
  try {
    validateSlug(slug);
    return slug;
  } catch {
    return null;
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const principal = await requireOwnerPrincipal();
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
    const conversation = await getChatConversation(ownerTenantHandle(principal), id);
    if (!conversation) {
      return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    }
    const body = (await request.json().catch(() => ({}))) as {
      title?: unknown;
      messageId?: unknown;
    };
    const messageId =
      typeof body.messageId === "string" ? body.messageId.trim() : "";
    const assistant = messageId
      ? conversation.messages.find(
          (message) => message.id === messageId && message.role === "assistant",
        )
      : [...conversation.messages]
          .reverse()
          .find((message) => message.role === "assistant");
    const content = assistant?.content.trim() ?? "";
    if (!assistant || !content) {
      return NextResponse.json(
        { error: "No assistant answer to save." },
        { status: 400 },
      );
    }
    const title =
      typeof body.title === "string" && body.title.trim()
        ? body.title.trim()
        : conversation.title || "Chat answer";
    const citations = (assistant.citations ?? []).filter((citation) =>
      citationPathAllowed(citation.path),
    );
    const wikiSlugs = citations
      .map((citation) => wikiSlugFromCitationPath(citation.path))
      .filter((slug): slug is string => Boolean(slug));
    const sourcePaths = citations
      .map((citation) => citation.path)
      .filter((path) => path.startsWith("raw/sources/"));
    const contentWithProvenance =
      sourcePaths.length > 0
        ? `${content}\n\n## Sources\n${sourcePaths.map((path) => `- \`${path}\``).join("\n")}`
        : content;
    const result = await saveAnswerToWiki(
      title,
      contentWithProvenance,
      undefined,
      wikiSlugs.length > 0 ? wikiSlugs : undefined,
      "markdown",
      ownerTenantHandle(principal),
      principal.handle,
      {
        conversationId: conversation.id,
        conversationName: conversation.title,
        underQueries: true,
      },
    );
    const sourceSlug = queryAnswerSourceSlug(result.slug);
    const contentSha256 = await sourceSha256(contentWithProvenance);
    await saveRawSourceFor(sourceSlug, contentSha256, contentWithProvenance, {
      owner: ownerTenantHandle(principal),
    });
    const sourcePath = `raw/sources/${sourceSlug}/${contentSha256}.md`;
    const jobId = crypto.randomUUID();
    await createIngestJob({
      jobId,
      owner: ownerTenantHandle(principal),
      title,
    });
    const pagePayload = {
      slug: result.slug,
      path: `wiki/${result.slug}.md`,
      jobId,
      sourcePath,
    };
    try {
      const ingestResponse = await enqueueOrInline(
        jobId,
        {
          kind: "ingest",
          title,
          content: contentWithProvenance,
          owner: ownerTenantHandle(principal),
          author: principal.handle,
          tags: ["query-answer"],
          jobId,
          sourceType: "text",
          sourcePath,
          contentSha256,
        },
        () =>
          ingest(title, contentWithProvenance, {
            owner: ownerTenantHandle(principal),
            author: principal.handle,
            triggeredBy: principal.handle,
            tags: ["query-answer"],
            sourceType: "text",
            sourcePath,
            contentSha256,
            jobId,
          }),
      );
      if (!ingestResponse.ok) {
        return NextResponse.json(
          { ...pagePayload, queued: false },
          { status: 202 },
        );
      }
      const ingestBody = (await ingestResponse.json().catch(() => ({}))) as {
        queued?: boolean;
        jobId?: string;
      };
      return NextResponse.json({
        ...pagePayload,
        jobId: ingestBody.jobId ?? jobId,
        queued: ingestBody.queued ?? true,
      });
    } catch (error) {
      return NextResponse.json(
        {
          ...pagePayload,
          queued: false,
          error: getErrorMessage(error),
        },
        { status: 202 },
      );
    }
  } catch (error) {
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
    }
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
