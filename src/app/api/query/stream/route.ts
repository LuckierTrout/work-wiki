import { ownerTenantHandle } from "@/lib/owner";
import { NextRequest, NextResponse } from "next/server";
import { createTextStreamResponse } from "ai";
import { hasLLMKey, callLLMStream } from "@/lib/llm";
import {
  LLM_DEADLINE_COPY,
  LLM_LENGTH_CAP_COPY,
  LLM_STOPPED_EARLY_COPY,
  isOwnLlmDeadline,
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
 * The three reasons this route can close an answer early, each as ONE object
 * pairing the owner's sentence with the operator's log line.
 *
 * A DESCRIPTOR rather than two `string` parameters on `closeWithNotice`,
 * because two adjacent bare strings are the same type: transposing them
 * type-checks cleanly and would enqueue the operator's log line into the
 * owner's answer body while logging the notice. Binding the pair here means a
 * call site names WHICH ending happened and cannot pick a mismatched half —
 * a cap truncation can no longer log "LLM deadline reached" and send an
 * operator to raise a timeout that never fired. The third one arrives under
 * exactly that rule (DW-666): a descriptor beside these two, never a bare
 * `(copy, log)` pair added alongside them.
 *
 * Not exported — Next 15 type-checks route exports, and this file's export
 * surface stays the `POST` handler alone.
 */
const DEADLINE_NOTICE = {
  copy: LLM_DEADLINE_COPY,
  log: "LLM deadline reached; the answer was cut short and the owner told",
} as const;
const LENGTH_CAP_NOTICE = {
  copy: LLM_LENGTH_CAP_COPY,
  log: "Output token cap reached; the answer was cut short and the owner told",
} as const;
const STOPPED_EARLY_NOTICE = {
  copy: LLM_STOPPED_EARLY_COPY,
  log: "Model stopped before finishing; the answer was cut short and the owner told",
} as const;

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

    // Artifacts (saved html/slides) are NEVER query knowledge — their markup
    // must never enter the LLM context — so exclude them REGARDLESS of scope
    // (incl. a vault that curated one, or the owner/"Mine" scope). This term
    // used to sit inside the `if (!scopeSlugs)` block below, so an owner- or
    // `mine`-scoped stream could answer from saved artifact markup while the
    // non-streaming `query()` refused it (DW-726). One invariant, stated the
    // same way in both paths — see query.ts.
    entries = entries.filter((e) => !isArtifactType(e.type));

    // Unscoped queries answer from the public commons only — exclude agent-scoped
    // pages (identity / knowledge / social), which surface solely via an explicit
    // `agent:` scope. Mirrors the non-streaming query() path (query.ts).
    if (!scopeSlugs) {
      entries = entries.filter((e) => !isAgentScopedType(e.type));
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

    if (!(await hasLLMKey())) {
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
      ownerTenantHandle(principal),
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
      ownerTenantHandle(principal),
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
    //
    // The notice is a PARAMETER, not this function's own constant (DW-547).
    // Two different things can now end an answer early — the owner's deadline
    // and this repo's output cap — and they are two different sentences with
    // two different logs, but exactly one closing shape: same blank-line rule,
    // same graceful `close()` so the body stays a 200 the client can read.
    //
    // ONE descriptor argument, never a `(copy, log)` pair — see the notice
    // constants above for why two bare strings here would be a transposition
    // waiting to happen.
    const closeWithNotice = (
      controller: ReadableStreamDefaultController<string>,
      notice: { readonly copy: string; readonly log: string },
    ) => {
      logger.warn("query", notice.log);
      controller.enqueue(emitted ? `\n\n${notice.copy}` : notice.copy);
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
            if (isOwnLlmDeadline(streamError)) {
              closeWithNotice(controller, DEADLINE_NOTICE);
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
            (part.type === "error" && isOwnLlmDeadline(part.error))
          ) {
            closeWithNotice(controller, DEADLINE_NOTICE);
            return;
          }
          // DW-547, widened by DW-666. The other way an answer ends early, and
          // until now the silent one: the model reports WHY it stopped on the
          // `finish` part, and this branch used to read only `"length"` — the
          // cap CUTTING the answer at `maxOutputTokens`, which is
          // `QUERY_MAX_OUTPUT_TOKENS` on every call this route makes. Every
          // other reason fell into the bookkeeping tail below and the body
          // simply ended — the same half answer looking like a whole one that
          // DW-64 fixed for the deadline, and `content-filter` is the concrete
          // case: the model was stopped and the owner was told nothing.
          //
          // `stop` IS THE ONLY CLEAN ENDING, so it is the only silent one.
          // `length` keeps its own sentence, which promises the rest of the
          // answer is reachable by narrowing. The rest — `content-filter`,
          // `error`, `tool-calls`, `other` — share one sentence: this repo
          // passes no tools on these calls, so any of them means the model
          // stopped somewhere that is not the end of the answer, and a rule
          // keyed on "did the model finish" needs no per-reason table.
          //
          // UNGATED, unlike the abort branch above. The abort branch asks
          // `llmDeadlineConfigured()` because an abort with no deadline set is
          // someone else's; the cap is passed on every single call and the
          // model's own report of how it stopped is its own either way, so
          // there is no state in which either belongs to somebody else.
          //
          // AFTER the abort/deadline branch, deliberately: a deadline that
          // fires mid-answer can be followed by a `finish` carrying `length`,
          // and the deadline is what actually stopped the run. Reaching the
          // abort branch first means the deadline sentence wins, unchanged.
          if (part.type === "finish" && part.finishReason !== "stop") {
            closeWithNotice(
              controller,
              part.finishReason === "length"
                ? LENGTH_CAP_NOTICE
                : STOPPED_EARLY_NOTICE,
            );
            return;
          }
          // Everything else is bookkeeping (`start`, a clean `finish`, step
          // markers, and the non-deadline `error` part, which goes on being
          // dropped exactly as it is today — that is DW-64's neighbour, not
          // DW-64).
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
        error: isOwnLlmDeadline(error)
          ? LLM_DEADLINE_COPY
          : getErrorMessage(error),
      },
      { status: 500 },
    );
  }
}
