/**
 * The one mechanism that makes a REPEATED sentence announce twice (DW-182).
 *
 * An `aria-live` region is announced when its content CHANGES. Writing the same
 * string into it a second time is, to every implementation that diffs the
 * region's text, indistinguishable from not writing at all — so two consecutive
 * silent refreshes of the Preview report as one, and re-picking a surface whose
 * label matches the one already spoken reports as nothing at all. Both regions
 * in the Workbench have that shape, which is why this lives here rather than
 * beside either of them: it is a property of live regions, not of the Preview.
 *
 * The fix is an INVISIBLE mark alternated onto the end of a repeated sentence.
 * A zero-width space rather than a keyed node, deliberately: remounting a live
 * region is the mechanism assistive tech observes LEAST reliably — the region
 * has to exist before its content changes for the change to be noticed at all —
 * while a text-node edit inside a region that stayed mounted is the case every
 * implementation handles. The mark is not rendered and not spoken, so the
 * sentence a reader hears is exactly the sentence without it.
 *
 * It ALTERNATES rather than always-appending, so a region that repeats the same
 * sentence ten times never accumulates ten marks — the value flips between
 * `sentence` and `sentence + mark`, and every flip is a change.
 *
 * Pure and framework-free: both callers pass the region's CURRENT value and get
 * the next one back, which is what lets the node suite execute every row of the
 * matrix rather than a component being grepped for it.
 */

/**
 * U+200B ZERO WIDTH SPACE — no glyph, no advance width, and no utterance.
 *
 * Not a normal space: a trailing space is collapsed by HTML whitespace handling
 * in a rendered region and would give some engines nothing to diff. Not a
 * combining or control character either — those can be spoken, or can change
 * how the character before them is rendered.
 *
 * Written as an ESCAPE, never as the character itself: an invisible byte in
 * source survives no editor, formatter or paste reliably, and losing it here
 * silently turns every repeat into a no-op write. The test asserts against the
 * escape and the code point for the same reason — a second invisible literal
 * over there would be stripped by whatever stripped this one, and the two would
 * go on agreeing about nothing.
 */
export const LIVE_REGION_REPEAT_MARK = "\u200B";

/**
 * What to write into a live region so `sentence` is announced, given whatever
 * the region currently holds.
 *
 * `current` is the raw region value, mark included — the caller passes the
 * state it is about to replace, which is why every call site is a state
 * UPDATER rather than a plain `set`. Reading the region's value from a variable
 * captured in an older closure would compare against a sentence that has since
 * been overwritten and drop the mark exactly when it is needed.
 *
 * An empty sentence is never marked: clearing a region is a request for
 * SILENCE, and `mark` alone is still a content change that some implementations
 * announce as an empty utterance.
 */
export function nextAnnouncement(current: string, sentence: string): string {
  if (sentence === "") return "";
  if (current === sentence) return sentence + LIVE_REGION_REPEAT_MARK;
  return sentence;
}

/**
 * The sentence inside a region value — the mark removed.
 *
 * For anything that has to read a region back and compare it to copy: a test,
 * or any future consumer that reports what was last announced. Every occurrence
 * is stripped rather than one trailing one, so this stays total against a value
 * some other writer marked differently.
 */
export function announcementSentence(value: string): string {
  return value.split(LIVE_REGION_REPEAT_MARK).join("");
}
