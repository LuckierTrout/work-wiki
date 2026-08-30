import { NextRequest, NextResponse } from "next/server";
import { query, type QueryFormat } from "@/lib/query";
import { getPrincipal } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import { LLM_DEADLINE_COPY, isOwnLlmDeadline } from "@/lib/llm-deadline";
import { logger } from "@/lib/logger";

function parseFormat(value: unknown): QueryFormat {
  if (value === "table") return "table";
  if (value === "slides") return "slides";
  if (value === "html") return "html";
  return "prose";
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const { question, format, scope } = body;

    if (
      !question ||
      typeof question !== "string" ||
      question.trim().length === 0
    ) {
      return NextResponse.json(
        { error: "question is required and must be a non-empty string" },
        { status: 400 },
      );
    }

    // Validate `format` if present; default to "prose" when missing/invalid.
    if (
      format !== undefined &&
      format !== "prose" &&
      format !== "table" &&
      format !== "slides" &&
      format !== "html"
    ) {
      return NextResponse.json(
        { error: "format must be 'prose', 'table', 'slides', or 'html'" },
        { status: 400 },
      );
    }

    // Validate `scope` if present — must be a string.
    if (scope !== undefined && typeof scope !== "string") {
      return NextResponse.json(
        { error: "scope must be a string (e.g. 'agent:yoyo')" },
        { status: 400 },
      );
    }

    // Querying invokes the LLM (a real cost), so it's signed-in-only. The
    // middleware write-gate already 401s anonymous POSTs to /api/**; this is
    // defense-in-depth at the cost-critical endpoint so a future middleware/
    // matcher change can't silently open free anonymous querying. (Agents query
    // via MCP — query() directly — not this route, so this doesn't gate them.)
    const principal = await getPrincipal();
    if (!principal) {
      return NextResponse.json(
        { error: "Sign in required to query work-wiki." },
        { status: 401 },
      );
    }

    const result = await query(
      question.trim(),
      parseFormat(format),
      scope || undefined,
      principal,
    );

    return NextResponse.json(result);
  } catch (error) {
    logger.error("query", "Query error", error);
    return NextResponse.json(
      {
        // DW-545. `query()` reaches `callLLM` several times over, each spreading
        // the same `llmTimeoutOption()`, so the owner's own deadline lands here
        // as a `TimeoutError` and used to reach them as `getErrorMessage`'s
        // passthrough of the SDK's words: "The operation was aborted due to
        // timeout". That names a signal, not the limit they set.
        //
        // This route, not just its streaming neighbour, because
        // `useStreamingQuery` re-queries THIS one whenever the stream route
        // answers non-2xx and PREFERS the message it gets back
        // (`src/hooks/useStreamingQuery.ts`). Left unmapped, the transport
        // words here overwrite the sentence `/api/query/stream` already emits —
        // so both routes ask `isOwnLlmDeadline` and answer identically.
        //
        // 500 and not 504, for the same reason the stream route gives: this is
        // a verdict about a limit the OWNER set, not a gateway's verdict about
        // us. Anything else keeps the error's own words, exactly as today.
        error: isOwnLlmDeadline(error)
          ? LLM_DEADLINE_COPY
          : getErrorMessage(error),
      },
      { status: 500 },
    );
  }
}
