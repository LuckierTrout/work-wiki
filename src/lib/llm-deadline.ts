import { getLlmTimeoutMs } from "./config";
import { SETTINGS_LABEL, settingsPointer } from "./workbench-settings";

/**
 * The owner-facing half of the LLM deadline (DW-64).
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
