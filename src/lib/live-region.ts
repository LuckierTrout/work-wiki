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
 *
 * ---------------------------------------------------------------------------
 * VERIFYING THE OTHER HALF — a manual procedure, knowingly (DW-287)
 * ---------------------------------------------------------------------------
 *
 * Everything above is about a STRING. `preview-announcements.test.tsx` proves
 * the region's value changed and that the sentence a reader hears is unchanged;
 * `live-region.test.ts` proves the alternation. None of that is the claim the
 * mechanism exists for, which is that assistive technology UTTERS the sentence
 * a second time. Nothing in this repo can observe an utterance: Playwright
 * drives a browser, not a screen reader, and no automated lane here speaks. The
 * 2026-08-28 decision on DW-287 therefore closes the gap as KNOWINGLY MANUAL —
 * run this by hand whenever this module, `nextAnnouncement`'s callers, or the
 * mark itself changes.
 *
 * WHICH AT: VoiceOver on macOS (Cmd+F5) is the reference. Repeat on NVDA
 * (Windows) before changing the mark, because implementations diff region text
 * differently and a character that satisfies one has satisfied only that one.
 * JAWS is named in DW-287 alongside those two and is IN SCOPE, not excluded —
 * it is simply not on the machines this is normally run on. Anyone with a JAWS
 * licence should run the same two gestures there; it is the third data point
 * the mark's choice would most benefit from.
 *
 * WHICH SURFACE, and WHAT TO HEAR — two regions, two gestures:
 *
 *   1. The Preview column's polite region (`p.wb-sr-only[aria-live="polite"]`
 *      inside `.wb-preview`, rendered by `PreviewColumn.tsx`). Dock the Preview
 *      on a page, then change that page's bytes on disk THREE times in a row
 *      without touching the selection, letting the refresh land each time.
 *      Expect to hear "Preview updated" THREE times — once per change. Hearing
 *      it once is the DW-182 bug: the second write of an identical string was
 *      not a change.
 *
 *      Three, not two, because the mark ALTERNATES. The second write adds it and
 *      the third takes it off again, so the third utterance is the one that
 *      proves a region can be re-announced by a string getting SHORTER — the
 *      half a two-step check never reaches, and the half that would break if the
 *      mark were ever changed to always-append or to a growing tail.
 *
 *   2. The shell's polite region (`p.wb-sr-only[aria-live="polite"]` at the end
 *      of `Workbench.tsx`). Press an already-current rail item — Chat while
 *      Chat is showing. Expect to hear "Chat" again on every press.
 *
 * In both cases listen for the sentence ALONE: `LIVE_REGION_REPEAT_MARK` is
 * U+200B and must not be spoken, spelled, or announced as "blank". If any of it
 * is audible, the mark is the wrong character and this module — not the caller
 * — is where that is fixed.
 *
 * `AGENTS.md` → "Test environments" points here, so a reader who starts from
 * the test strategy lands on this procedure.
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
