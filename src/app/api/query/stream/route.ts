import { NextRequest, NextResponse } from "next/server";
import { hasLLMKey, callLLMStream } from "@/lib/llm";
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
 * THE deadline sentence. One phrasing, both surfaces.
 *
 * A fired LLM deadline reaches the owner two ways on this route: thrown out of
 * retrieval before a single token exists, or as an `abort` part part-way through
 * an answer that is already on screen. The wording has to be true of
 * both — hence "stopped before it was finished" rather than any claim about how
 * much arrived — and it names the Settings control ("LLM timeout") so the owner
 * has somewhere to go. No transport vocabulary: `abort`, `aborted` and `signal`
 * are the SDK's words, not the owner's.
 *
 * Module-private on purpose: route files export handlers only. Its text is
 * pinned literally in `src/lib/__tests__/query-stream-route.test.ts`.
 */
const QUERY_DEADLINE_COPY =
  "This answer ran past the LLM timeout set in Settings and stopped " +
  "before it was finished. Ask again, or raise that limit in Settings.";

/** The two names an abandoned request carries, whatever threw it. */
function isAbortNamed(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

/**
 * Is this the configured LLM deadline (or an explicit abort) rather than a real
 * failure?
 *
 * Same rule as `unconfirmedCause` in `workbench-request.ts`: `AbortSignal.timeout`
 * rejects with a `TimeoutError` (a `DOMException`, which is an `Error`), an
 * explicit `controller.abort()` with an `AbortError`. Everything else is a
 * genuine failure and keeps the 500 path.
 *
 * One level of `.cause` counts too: providers and the SDK routinely re-throw
 * the abort they saw wrapped in an error of their own, and the owner-facing
 * fact — the deadline fired — is identical either way. Only one level, so a
 * long cause chain from an unrelated failure can't be mistaken for a deadline.
 */
function isDeadlineError(error: unknown): boolean {
  if (isAbortNamed(error)) return true;
  return (
    error instanceof Error && isAbortNamed((error as { cause?: unknown }).cause)
  );
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

    // Hand-rolled equivalent of `result.toTextStreamResponse()`. That helper
    // forwards `text-delta` parts and nothing else, so when the deadline fires
    // mid-answer the SDK's `abort` part is dropped and the answer simply stops
    // mid-sentence. And because the SDK CLOSES an aborted stream rather than
    // erroring it, the sentence cannot be added from a `catch` either — it has
    // to be appended here, where the `abort` part is visible.
    //
    // Pull-driven, like the SDK's own pipe: one part per `pull` keeps the
    // reader's backpressure, and `cancel` returns the iterator so a client that
    // walks away stops the model call instead of leaving it running.
    const encoder = new TextEncoder();
    const parts = result.fullStream[Symbol.asyncIterator]();

    // Has any answer text reached the owner yet? Decides whether the sentence
    // needs a blank line in front of it — see `deadlineTail`.
    let sentAnyText = false;

    /**
     * The sentence, as bytes, with the separator the moment calls for: a blank
     * line only when a partial answer stands in front of it. Fired before the
     * first token there is nothing to separate from, and two leading newlines
     * would read as an empty answer.
     */
    const deadlineTail = () =>
      encoder.encode(
        sentAnyText ? `\n\n${QUERY_DEADLINE_COPY}` : QUERY_DEADLINE_COPY,
      );

    /**
     * Finalize the iterator, swallowing a rejection.
     *
     * By the time this runs the outcome is already decided — the sentence is
     * enqueued and the body is about to close cleanly, or the client has walked
     * away. An iterator that rejects from `return()` must not turn either into
     * an errored body (the contract says this body is never errored) or, from
     * `cancel`, into an unhandled rejection.
     */
    const endParts = async (reason?: unknown) => {
      try {
        await parts.return?.(reason);
      } catch {
        // Deliberately ignored; see above.
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          // Loops only past parts that produce no bytes (`start`, `finish`,
          // reasoning, tool traffic); every exit either enqueues or closes.
          for (;;) {
            const { done, value: part } = await parts.next();
            if (done) {
              controller.close();
              return;
            }
            if (part.type === "text-delta") {
              sentAnyText = true;
              controller.enqueue(encoder.encode(part.text));
              return;
            }
            // The deadline, either shape: the SDK's own abort part, or an
            // `error` part carrying the abort. A non-deadline `error` part is
            // ignored exactly as `toTextStreamResponse` ignores it.
            if (
              part.type === "abort" ||
              (part.type === "error" && isDeadlineError(part.error))
            ) {
              // The pre-stream path logs through the route's outer catch; this
              // one would otherwise be invisible to operations.
              logger.warn(
                "query",
                "Query stream hit the LLM deadline mid-answer",
                { sentAnyText },
              );
              controller.enqueue(deadlineTail());
              await endParts();
              controller.close();
              return;
            }
          }
        } catch (error) {
          // A deadline that surfaces as a throw gets the same sentence and a
          // clean close; anything else errors the body, as it does today.
          if (!isDeadlineError(error)) {
            controller.error(error);
            return;
          }
          logger.warn(
            "query",
            "Query stream hit the LLM deadline mid-answer",
            { sentAnyText },
          );
          controller.enqueue(deadlineTail());
          controller.close();
        }
      },
      async cancel(reason) {
        await endParts(reason);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        // Percent-encode so non-ASCII slugs (e.g. CJK titles) survive the
        // header transport, which is Latin-1 on the wire. The client decodes
        // with decodeURIComponent before JSON.parse.
        "X-Wiki-Sources": encodeURIComponent(JSON.stringify(loadedSlugs)),
      },
    });
  } catch (error) {
    logger.error("query", "Query stream error", error);
    // A fired deadline is not a server fault and its raw message ("The
    // operation was aborted due to timeout") is transport vocabulary. 504,
    // and the one sentence.
    if (isDeadlineError(error)) {
      return NextResponse.json({ error: QUERY_DEADLINE_COPY }, { status: 504 });
    }
    return NextResponse.json(
      {
        error: getErrorMessage(error),
      },
      { status: 500 },
    );
  }
}
