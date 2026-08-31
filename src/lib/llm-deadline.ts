import { getLlmTimeoutMs } from "./config";
import { SETTINGS_LABEL, settingsPointer } from "./workbench-settings";

/**
 * Why a streamed answer stopped early — every sentence, and every predicate
 * that licenses one (DW-64, DW-544, DW-545, DW-547, DW-663, DW-664).
 *
 * The deadline was the first reason and named the file; it is no longer the
 * only one. A streamed answer can also end because the model ran into an output
 * cap — `QUERY_MAX_OUTPUT_TOKENS` on the query route, the synthesis budget on a
 * research run — because the stream was cut with no deadline configured at all,
 * or because a provider `error` part ended a research brief. All five sentences
 * share one failure — a half answer, or half a brief, that reads as a whole one
 * — so they share one home, and callers import the sentence rather than each
 * keeping a copy of it. The FILENAME stays: `./llm` and DW-64's spec both name
 * it, and renaming it would buy nothing this docblock does not say.
 *
 * A SEPARATE, dependency-light module rather than another export on `llm.ts`,
 * for two reasons that both have to hold at once:
 *
 *   - `src/app/api/query/stream/route.ts` is where the mapping belongs, and a
 *     `route.ts` cannot own the sentence itself: Next 15 type-checks route
 *     exports, and no `route.ts` in this repo exports anything but its HTTP
 *     handlers.
 *   - the suite that pins the sentence has to MOCK `@/lib/llm` (to drive
 *     `callLLMStream` with a fake stream) while importing the REAL constant.
 *     Living on `llm.ts` would put the sentence behind that mock, and the test
 *     would then be asserting a restated literal against itself.
 *
 * Every sentence below states the answer is INCOMPLETE, because the failure
 * this module closes is a half answer that reads as a whole one — and none of
 * them carries transport vocabulary. The SDK's own words for a fired deadline
 * ("The operation was aborted due to timeout") name a signal, not anything the
 * owner set or can act on.
 *
 * The Settings pointer is the dividing line. A sentence gets one only when it
 * names a control the owner actually has: the LLM timeout, which they filled in
 * and can raise or clear. {@link LLM_LENGTH_CAP_COPY},
 * {@link LLM_RESEARCH_LENGTH_CAP_COPY} and
 * {@link LLM_RESEARCH_STREAM_CUT_SHORT_COPY} get none, because there is no field behind
 * any of them. Neither output cap is settable: the query route's is the named
 * constant `QUERY_MAX_OUTPUT_TOKENS` in `./constants`, and the research budget
 * is a bare literal passed at the synthesis call sites in
 * `research-runtime.ts` — different shapes, but both in source, and neither
 * written by anything on the Settings surface. A stream cut with no deadline
 * configured, or ended by a provider error, was cut by something this repo did
 * not install at all.
 *
 * The deadline's MECHANISM is deliberately not here and is not changing — see
 * the frozen-decision note on `callLLMStream` in `./llm`.
 */

/**
 * What the owner reads when their own LLM deadline cuts an answer short.
 *
 * ONE constant, DERIVED. The Settings destination is composed through
 * {@link settingsPointer} exactly as `llm.ts`'s runtime refusals are (DW-369),
 * so renaming the `llm-models` category cannot leave this sentence pointing at
 * a nav row the Settings surface no longer shows — and the composed string is
 * deliberately absent as a literal from this file, the route and the suite, so
 * a search for it turns up only the one place that owns it.
 *
 * The SHORT surface label ({@link SETTINGS_LABEL}, not the "Workbench Settings"
 * form) matches `llm.ts` for the same reason it does there: this is a runtime
 * sentence streamed into an answer body, not copy rendered ON a Settings page,
 * so the extra word that disambiguates the two Settings surfaces would only be
 * noise here.
 *
 * No transport vocabulary — the SDK's own words for this ("The operation was
 * aborted due to timeout") name a signal, not anything the owner set, and no
 * Copy table in this repo contains that vocabulary. This names the control they
 * did set and what to do with it. It states the answer is INCOMPLETE, because
 * the failure this closes is a half answer that reads as a whole one.
 *
 * It may only be shown when {@link llmDeadlineConfigured} is true. Every clause
 * in it — the limit to raise, the blank that means no deadline — describes a
 * field the owner filled in, so shown without one it would send them to a
 * control they never set and an action that changes nothing.
 */
export const LLM_DEADLINE_COPY =
  `This answer is incomplete: it hit the LLM timeout set in ` +
  `${settingsPointer("llm-models", SETTINGS_LABEL)}. Raise that limit, or ` +
  `clear it for no deadline, then ask again.`;

/**
 * The same deadline, read by the owner of a Deep Research run (DW-544).
 *
 * A SECOND sentence rather than {@link LLM_DEADLINE_COPY} reused, because the
 * two describe different outcomes. A query's half answer is still on screen —
 * "ask again" is a second question. A research run that hits the deadline
 * during synthesis writes NOTHING: the run fails closed rather than committing
 * a truncated brief as a finished wiki page, so the sentence has to say the
 * wiki is untouched, or the owner goes looking for a page that is not there.
 *
 * Same composed pointer and same gate as {@link LLM_DEADLINE_COPY}: shown only
 * where {@link llmDeadlineConfigured} is true, since every clause names a field
 * the owner filled in.
 */
export const LLM_DEADLINE_RESEARCH_COPY =
  `This research run is incomplete: it hit the LLM timeout set in ` +
  `${settingsPointer("llm-models", SETTINGS_LABEL)}. Nothing was written to ` +
  `the wiki. Raise that limit, or clear it for no deadline, then run the ` +
  `research again.`;

/**
 * A RESEARCH synthesis stream that ended early with NO deadline configured
 * (DW-544), or on an `error` part that was not a deadline at all (DW-664).
 *
 * TWO USES, and only the first is gated. DW-544's use is the far side of
 * {@link llmDeadlineConfigured} for an abort. DW-664's is UNGATED: when an
 * `error` part that {@link isLlmDeadlineAbort} does not recognise ends the
 * synthesis brief — nothing after it but `ai@6`'s own teardown, which carries
 * `finishReason: "error"` — the `for await` ends normally and half a brief used
 * to flow on into the page write. The words
 * below fit that ending as they stand — they name no field, no limit and no
 * cause, only that the response stopped and the wiki is untouched — so they
 * stay true whether or not a deadline is configured. {@link
 * LLM_DEADLINE_RESEARCH_COPY} could NOT be shown there even with a deadline
 * set: blaming the owner's timeout for an unrelated provider error would send
 * them to raise a limit that had nothing to do with it. The SDK's own error
 * goes to `logger.warn` instead, where diagnostics belong.
 *
 * RESEARCH-SCOPED, and named for it. The text says "this research run" and
 * "nothing was written to the wiki", both of which would be false on either
 * query route: a query writes nothing ever, so telling its owner the wiki is
 * untouched names a reassurance about a risk that was never on the table. A
 * general "a stream ended early" sentence for the query surfaces does not exist
 * yet, and if one is ever needed it is a new constant beside this one, not this
 * one reused.
 *
 * The counterpart to {@link LLM_DEADLINE_RESEARCH_COPY} on the far side of
 * {@link llmDeadlineConfigured}. Research fails closed on a cut stream either
 * way — committing half a brief is the bug being fixed, and the field being
 * blank does not make a truncated page truthful — so only the WORDS change
 * here, not the outcome.
 *
 * NO Settings pointer, deliberately. With the field blank, `llmTimeoutOption()`
 * installed no signal at all, so whatever cut this stream is not a limit the
 * owner set; sending them to raise it, or to clear a field that is already
 * blank, is the dead end {@link llmDeadlineConfigured} exists to close.
 */
export const LLM_RESEARCH_STREAM_CUT_SHORT_COPY =
  `This research run is incomplete: the model's response stopped before it ` +
  `was finished. Nothing was written to the wiki. Run the research again.`;

/**
 * The answer ran into this repo's own output cap (DW-547).
 *
 * `finishReason: "length"` on the `finish` part means the model stopped because
 * it reached `maxOutputTokens`, which `/api/query/stream` passes as
 * `QUERY_MAX_OUTPUT_TOKENS` on every call. Before DW-547 that part fell into
 * the route's bookkeeping tail and the body simply ended — the same silent half
 * answer the deadline used to produce, from a different cause.
 *
 * UNGATED, unlike the deadline sentences: the cap is passed on every call, so a
 * `length` finish is always this repo's own and there is no state in which it
 * could belong to someone else.
 *
 * NO Settings pointer, and none may be added. `QUERY_MAX_OUTPUT_TOKENS` is a
 * source constant (`./constants`); nothing on the Settings surface writes it,
 * so pointing the owner at Settings would send them looking for a control that
 * is not there. What they CAN do is ask something narrower, which is what this
 * says instead.
 */
export const LLM_LENGTH_CAP_COPY =
  `This answer is incomplete: it reached the maximum length a single answer ` +
  `can be. Ask again for a narrower part of the question to see the rest.`;

/**
 * The same cap, read by the owner of a Deep Research run (DW-663).
 *
 * `finishReason: "length"` on the synthesis stream's `finish` part means the
 * brief was CUT at the output budget `synthesizeResearchBrief` passes on every
 * call — not that it fit under it. Before DW-663 that part fell through the
 * loop's bookkeeping tail and the half brief was committed as a finished wiki
 * page, which is the same silent truncation DW-544 closed for the deadline,
 * from a different cause.
 *
 * A SECOND sentence rather than {@link LLM_LENGTH_CAP_COPY} reused, for the
 * reason {@link LLM_DEADLINE_RESEARCH_COPY} is a second sentence too: that one
 * is query-scoped and says "Ask again for a narrower part of the question to
 * see the rest", which promises the REST of an answer that is already on
 * screen. A research run that hits the cap writes NOTHING — the run fails
 * closed — so there is no rest to see, and the sentence has to say the wiki is
 * untouched or the owner goes looking for a page that is not there.
 *
 * UNGATED, exactly as {@link LLM_LENGTH_CAP_COPY} is: the cap is passed on
 * every synthesis call, so a `length` finish is always this repo's own and
 * there is no state in which it could belong to someone else.
 * {@link llmDeadlineConfigured} has no bearing on it — a configured deadline
 * did not cut this stream, the cap did.
 *
 * NO Settings pointer, and none may be added. The synthesis budget is a source
 * literal in `research-runtime.ts`; nothing on the Settings surface writes it,
 * so pointing the owner at Settings would send them looking for a control that
 * is not there. What they CAN do is ask a narrower research question, which is
 * what this says instead.
 */
export const LLM_RESEARCH_LENGTH_CAP_COPY =
  `This research run is incomplete: the brief reached the maximum length a ` +
  `single run can produce. Nothing was written to the wiki. Ask a narrower ` +
  `research question and run it again.`;

/**
 * Is there a deadline for an abort to BE?
 *
 * `llmTimeoutOption()` returns `{}` — no `abortSignal` at all — whenever
 * `getLlmTimeoutMs()` is `null` (`src/lib/config.ts`), which is the default and
 * the state of every owner who has not filled the field in. So with no timeout
 * configured, nothing this repo installed can have fired, and an abort that
 * arrives anyway came from somewhere else entirely.
 *
 * This is the gate on {@link LLM_DEADLINE_COPY}, not a second flavour of it:
 * where it is false the caller must behave exactly as it did before DW-64 —
 * rethrow, or report the error in its own words. Naming a limit the owner never
 * set, and telling them to clear a field that is already blank, is the dead end
 * this repo's Settings-pointer rules exist to close.
 */
export function llmDeadlineConfigured(): boolean {
  return getLlmTimeoutMs() !== null;
}

/**
 * Is this thrown cause an abort of the flavour a deadline produces?
 *
 * `AbortSignal.timeout()` rejects with a `TimeoutError`; an explicit abort
 * rejects with an `AbortError`. Pair it with {@link llmDeadlineConfigured} —
 * this half answers "what shape", that half answers "could it have been ours",
 * and only both together license the sentence.
 *
 * NARROWER THAN THE SDK'S OWN `isAbortError` ON PURPOSE. That predicate
 * (`@ai-sdk/provider-utils`) matches `AbortError`, `TimeoutError` AND
 * `ResponseAborted` — and `ResponseAborted` is the name Next.js gives a CLIENT
 * DISCONNECT. A reader who closed the tab is not a deadline, and telling them
 * about a timeout they did not hit would be a sentence about the wrong event
 * written into a response nobody is reading. That third name is left out here,
 * deliberately.
 *
 * `instanceof Error` does not miss the real thing: an `AbortSignal.timeout`
 * rejection is a `DOMException`, and in Node `DOMException` extends `Error`
 * (verified: `new DOMException("x", "TimeoutError") instanceof Error === true`).
 *
 * Deliberately NOT `unconfirmedCause` from `./workbench-request`, which is the
 * nearest-looking predicate: it also matches `TypeError` and 502/504, and it
 * means "the write's outcome is unknown". That is false here. A query is a
 * read, nothing was written, and what happened is known exactly — the answer
 * stopped where the deadline landed.
 */
export function isLlmDeadlineAbort(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    (cause.name === "TimeoutError" || cause.name === "AbortError")
  );
}

/**
 * MAY THIS CALLER SAY "deadline"? — the gate for callers whose fallback is
 * silence or the error's own words (DW-64).
 *
 * Both halves at once: {@link isLlmDeadlineAbort} answers "what shape", and
 * {@link llmDeadlineConfigured} answers "could it have been ours".
 * `llmTimeoutOption()` installs no signal at all when the field is blank — the
 * default, and the state of every owner who never filled it in — so an abort
 * arriving with none configured came from somewhere this repo did not set up,
 * and {@link LLM_DEADLINE_COPY} would name a limit to raise and a field to
 * clear that do not exist. Where this is false, the caller falls back to
 * exactly its pre-DW-64 behaviour: rethrow, or the error's own words.
 *
 * NOT the universal rule for every abort in this repo, and `research-runtime.ts`
 * is the exception on purpose. Its fallback on an abort is neither silence nor
 * an error message: it is COMMITTING the truncated brief as a finished wiki
 * page, which is the failure DW-544 closed. So research asks the ungated
 * {@link isLlmDeadlineAbort} to decide whether to FAIL, and asks
 * {@link llmDeadlineConfigured} separately to pick between
 * {@link LLM_DEADLINE_RESEARCH_COPY} and
 * {@link LLM_RESEARCH_STREAM_CUT_SHORT_COPY} — the gate chooses its WORDS, never
 * its outcome. Use this composed predicate only where a false answer can safely
 * mean "carry on as before".
 *
 * HERE, not in a route (DW-545). `/api/query/stream` owned this predicate at
 * module scope so its `catch` and its stream reader were demonstrably asking
 * the same question; `/api/query` now has to ask it too — and it is the route
 * `useStreamingQuery` PREFERS the message from, so the two answering
 * differently would mean the stream route's sentence being overwritten by
 * transport words from its neighbour. A `route.ts` cannot export the shared
 * copy either: Next 15 type-checks route exports, and no `route.ts` in this
 * repo exports anything but its HTTP handlers.
 */
export function isOwnLlmDeadline(cause: unknown): boolean {
  return llmDeadlineConfigured() && isLlmDeadlineAbort(cause);
}
