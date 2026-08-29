import { NextRequest, NextResponse } from "next/server";
import { createTextStreamResponse } from "ai";
import { hasLLMKey, callLLMStream } from "@/lib/llm";
import {
  LLM_DEADLINE_COPY,
  isLlmDeadlineAbort,
  llmDeadlineConfigured,
} from "@/lib/llm-deadline";
import { QUERY_MAX_OUTPUT_TOKENS } from "@/lib/constants";
import { listReadableWikiPages, isAgentScopedType, isArtifactType } from "@/lib/wiki";
import { getPrincipal } from "@/lib/auth";
import {
  selectPagesForQuery,
  buildContext,
  buildQuerySystemPrompt,
  type QueryFormat,
} from "@/lib/query";
import { resolveScopeSlugs } from "@/lib/search";
import { getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { expandQueryWithNamesTerms } from "@/lib/names-terms";

/**
 * ONE rule for every abort shape this route maps: an abort is the OWNER'S
 * DEADLINE only if the owner set a deadline (DW-64).
 *
 * `llmTimeoutOption()` installs no signal at all when the field is blank —
 * the default, and the state of every owner who never filled it in — so an
 * abort arriving with none configured came from somewhere this route did not
 * set up, and `LLM_DEADLINE_COPY` would name a limit to raise and a field to
 * clear that do not exist. Where this is false, every branch below falls back
 * to exactly its pre-DW-64 behaviour: rethrow, or the error's own words.
 *
 * Module scope, not inside `POST`, so the `catch` and the stream reader are
 * demonstrably asking the same question. Not exported — Next 15 type-checks
 * route exports, and this file's export surface stays the `POST` handler alone.
 */
function ownDeadline(cause: unknown): boolean {
  return llmDeadlineConfigured() && isLlmDeadlineAbort(cause);
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

    // Validate `format` if present; default to "prose" when missing.
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
    const queryFormat: QueryFormat =
      format === "table"
        ? "table"
        : format === "slides"
          ? "slides"
          : format === "html"
            ? "html"
            : "prose";

    // Validate `scope` if present — must be a string.
    if (scope !== undefined && typeof scope !== "string") {
      return NextResponse.json(
        { error: "scope must be a string (e.g. 'agent:yoyo')" },
        { status: 400 },
      );
    }

    const trimmedQuestion = question.trim();

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

    // Resolve scope to a set of slugs (handles the "mine" lens; empty "mine"
    // falls back to the full commons).
    const { scopeSlugs, error: scopeError } = await resolveScopeSlugs(
      scope,
      principal,
    );
    if (scopeError) {
      return NextResponse.json({ error: scopeError }, { status: 400 });
    }

    let entries = await listReadableWikiPages(principal);

    // Unscoped queries answer from the public commons only — exclude agent-scoped
    // pages (identity / knowledge / social), which surface solely via an explicit
    // `agent:` scope. Mirrors the non-streaming query() path (query.ts).
    if (!scopeSlugs) {
      entries = entries.filter(
        (e) => !isAgentScopedType(e.type) && !isArtifactType(e.type),
      );
    }

    // Empty wiki — nothing to query
    if (entries.length === 0) {
      return NextResponse.json(
        {
          error:
            "The wiki is empty. Please ingest some content first so I have something to answer from.",
        },
        { status: 400 },
      );
    }

    if (!hasLLMKey()) {
      return NextResponse.json(
        {
          error:
            "No API key configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or another provider key.",
        },
        { status: 500 },
      );
    }

    // Select relevant pages and build context (same logic as query())
    const retrievalQuestion = await expandQueryWithNamesTerms(
      principal.handle,
      trimmedQuestion,
    );
    const selectedSlugs = await selectPagesForQuery(
      retrievalQuestion,
      entries,
      scopeSlugs,
    );
    const { context, slugs: loadedSlugs } =
      await buildContext(selectedSlugs);

    // Build the system prompt (same as non-streaming query)
    const systemPrompt = await buildQuerySystemPrompt(
      context,
      entries,
      selectedSlugs,
      queryFormat,
      principal.handle,
    );

    // Stream the LLM response
    const result = await callLLMStream(systemPrompt, trimmedQuestion, {
      maxOutputTokens: QUERY_MAX_OUTPUT_TOKENS,
    });

    // DW-64. Served from `fullStream`, not `toTextStreamResponse()`.
    //
    // `callLLMStream` puts ONE deadline over the whole stream (the frozen
    // 2026-08-21 decision — see its docblock). When that deadline fires, the
    // AI SDK does NOT propagate the `TimeoutError`: it enqueues an
    // `{ type: "abort" }` part and CLOSES the stream. `textStream` — which
    // `toTextStreamResponse()` serves — keeps `text-delta` parts and drops
    // everything else, so the abort vanished and a truncated half-answer
    // arrived looking finished. `fullStream` is the only place the abort is
    // visible, so the route reads that and swaps the silence for one sentence
    // naming the control the owner set.
    //
    // Only the SENTENCE changes. Text deltas are still enqueued one at a time
    // as they arrive, so the answer streams exactly as before, and
    // `createTextStreamResponse` is literally what `toTextStreamResponse()`
    // calls — same `text/plain; charset=utf-8` default, same header merge.
    const parts = result.fullStream[Symbol.asyncIterator]();
    let emitted = false;

    // A blank line separates the notice from the answer it interrupts — but
    // only when there IS an answer. A deadline that fires before the first
    // token would otherwise open the body with two empty lines.
    const closeWithNotice = (controller: ReadableStreamDefaultController<string>) => {
      logger.warn(
        "query",
        "LLM deadline reached; the answer was cut short and the owner told",
      );
      controller.enqueue(emitted ? `\n\n${LLM_DEADLINE_COPY}` : LLM_DEADLINE_COPY);
      controller.close();
    };

    const textStream = new ReadableStream<string>({
      async pull(controller) {
        // LOOPS rather than returning on a part it has nothing to say about.
        // The streams spec re-invokes `pull` when the previous one settles only
        // if something asked for more data WHILE it was pending, so a `pull`
        // that returns having neither enqueued nor closed parks the response
        // forever — and `fullStream` opens with a bookkeeping `start` part on
        // every single answer, so that would be every answer, not an edge case.
        for (;;) {
          let next;
          try {
            next = await parts.next();
          } catch (streamError) {
            // The SDK's abort guard is `isAbortError(error) && signal.aborted`,
            // so an abort that lands before the signal flips reaches
            // `controller.error` instead of the `abort` part below. Same fact,
            // same sentence. Anything else is NOT ours — it errors the stream
            // exactly as it does today.
            if (ownDeadline(streamError)) {
              closeWithNotice(controller);
              return;
            }
            throw streamError;
          }

          if (next.done) {
            controller.close();
            return;
          }

          const part = next.value;
          if (part.type === "text-delta") {
            // An EMPTY delta is not an answer. Enqueueing it would be a no-op
            // byte-wise but would flip `emitted`, and a deadline arriving next
            // would then open the body with the blank line that rule exists to
            // prevent. (`research-runtime.ts` guards the same case the same
            // way.) One non-empty delta per `pull`, so the answer still reaches
            // the owner token by token rather than in a buffered lump.
            if (part.text.length === 0) continue;
            emitted = true;
            controller.enqueue(part.text);
            return;
          }
          if (
            (part.type === "abort" && llmDeadlineConfigured()) ||
            (part.type === "error" && ownDeadline(part.error))
          ) {
            closeWithNotice(controller);
            return;
          }
          // Everything else is bookkeeping (`start`, `finish`, step markers,
          // and the non-deadline `error` part, which goes on being dropped
          // exactly as it is today — that is DW-64's neighbour, not DW-64).
        }
      },
      async cancel() {
        // Release THIS reader when the owner cancels the fetch. Not the
        // provider connection: `fullStream` is one branch of a `tee()`, and a
        // tee cancels its source only once BOTH branches are cancelled — the
        // other branch is the SDK's own, which this route cannot reach.
        //
        // AWAITED, not `void`-ed: `void` on a promise attaches no handler, so a
        // rejecting `return()` would surface as an unhandled rejection. And no
        // argument — the iterator protocol's `return(value)` takes a RETURN
        // VALUE, not a cancellation reason, and the SDK ignores it either way.
        await parts.return?.();
      },
    });

    return createTextStreamResponse({
      textStream,
      headers: {
        // Percent-encode so non-ASCII slugs (e.g. CJK titles) survive the
        // header transport, which is Latin-1 on the wire. The client decodes
        // with decodeURIComponent before JSON.parse.
        "X-Wiki-Sources": encodeURIComponent(JSON.stringify(loadedSlugs)),
      },
    });
  } catch (error) {
    logger.error("query", "Query stream error", error);
    return NextResponse.json(
      {
        // The deadline can also fire BEFORE the stream, from one of the LLM
        // calls this handler makes on the way there: `expandQueryWithNamesTerms`,
        // `selectPagesForQuery` and `buildQuerySystemPrompt` all reach `callLLM`,
        // which spreads the same `llmTimeoutOption()`. (Not from `callLLMStream`
        // itself — it constructs its signal inside the `streamText(...)`
        // arguments and `streamText` returns synchronously, so that signal has
        // no window in which to fire before the reader above exists.) Those
        // rejections land here, and the owner's sentence is the same one.
        //
        // 500 and not 504: this is the route's own verdict about a limit the
        // OWNER set, not a gateway's verdict about us.
        error: ownDeadline(error)
          ? LLM_DEADLINE_COPY
          : getErrorMessage(error),
      },
      { status: 500 },
    );
  }
}
