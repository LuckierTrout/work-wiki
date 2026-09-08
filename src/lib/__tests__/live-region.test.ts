import { describe, expect, it } from "vitest";
import {
  LIVE_REGION_REPEAT_MARK,
  announcementSentence,
  nextAnnouncement,
} from "@/lib/live-region";

/**
 * DW-182 — the whole decision behind "say it again".
 *
 * A live region announces on CHANGE, so the bug is invisible from inside a
 * component: writing `Preview updated` over `Preview updated` looks like a
 * successful announcement in every source scan and in every assertion that
 * reads the region's text against the copy constant. What can be executed is
 * this: given what the region holds and the sentence that has to be heard, the
 * value written back is DIFFERENT from what was there.
 */

describe("LIVE_REGION_REPEAT_MARK", () => {
  it("is a zero-width space — invisible, unspoken, and one code point", () => {
    // Both sides are ESCAPES, and the code point is asserted outright. A second
    // invisible literal here would be stripped by exactly whatever stripped the
    // one in the module, so the two would go on matching after the mark was
    // gone and every repeat had silently become a no-op write.
    expect(LIVE_REGION_REPEAT_MARK).toBe("\u200B");
    expect(LIVE_REGION_REPEAT_MARK.codePointAt(0)).toBe(0x200b);
    expect(LIVE_REGION_REPEAT_MARK).toHaveLength(1);
    // Not a plain space: HTML whitespace handling collapses a trailing one, so
    // some engines would have nothing to diff.
    expect(LIVE_REGION_REPEAT_MARK).not.toBe(" ");
    expect(LIVE_REGION_REPEAT_MARK.trim()).toBe(LIVE_REGION_REPEAT_MARK);
  });
});

describe("nextAnnouncement", () => {
  it("marks a sentence the region is already holding", () => {
    expect(nextAnnouncement("Preview updated", "Preview updated")).toBe(
      "Preview updated" + LIVE_REGION_REPEAT_MARK,
    );
  });

  it("alternates rather than accumulating, over three identical sentences", () => {
    // THE property. Always-appending would grow the value without bound, and a
    // region holding the sentence plus four marks is a string no consumer can
    // compare to the copy constant any more.
    const sentence = "Preview updated";
    const first = nextAnnouncement("", sentence);
    const second = nextAnnouncement(first, sentence);
    const third = nextAnnouncement(second, sentence);
    const fourth = nextAnnouncement(third, sentence);

    expect(first).toBe(sentence);
    expect(second).toBe(sentence + LIVE_REGION_REPEAT_MARK);
    expect(third).toBe(sentence);
    expect(fourth).toBe(sentence + LIVE_REGION_REPEAT_MARK);
    // Every step is a change — which is the only thing assistive tech observes.
    for (const [before, after] of [
      ["", first],
      [first, second],
      [second, third],
      [third, fourth],
    ] as const) {
      expect(after).not.toBe(before);
    }
    // …and every step still SAYS the same sentence.
    for (const value of [first, second, third, fourth]) {
      expect(announcementSentence(value)).toBe(sentence);
    }
  });

  it("leaves a genuinely new sentence unmarked", () => {
    expect(nextAnnouncement("Preview updated", "Preview, Beta")).toBe("Preview, Beta");
    // …including when what is on the region is the MARKED spelling of some
    // other sentence: the value already differs, so nothing has to be added.
    expect(
      nextAnnouncement("Preview updated" + LIVE_REGION_REPEAT_MARK, "Preview, Beta"),
    ).toBe("Preview, Beta");
  });

  it("never marks a cleared region", () => {
    // Clearing is a request for SILENCE. A lone mark is still a content change,
    // and some implementations announce that as an empty utterance.
    expect(nextAnnouncement("Preview updated", "")).toBe("");
    expect(nextAnnouncement("", "")).toBe("");
    expect(nextAnnouncement("Preview updated" + LIVE_REGION_REPEAT_MARK, "")).toBe("");
  });

  it("says a sentence into an empty region unchanged", () => {
    expect(nextAnnouncement("", "Preview, Alpha")).toBe("Preview, Alpha");
  });
});

describe("announcementSentence", () => {
  it("strips the mark, so a region can be read back as copy", () => {
    expect(announcementSentence("Preview updated" + LIVE_REGION_REPEAT_MARK)).toBe(
      "Preview updated",
    );
    expect(announcementSentence("Preview updated")).toBe("Preview updated");
    expect(announcementSentence("")).toBe("");
  });

  it("is total against a value carrying more than one mark", () => {
    const noisy = `${LIVE_REGION_REPEAT_MARK}Preview${LIVE_REGION_REPEAT_MARK} updated${LIVE_REGION_REPEAT_MARK}`;
    expect(announcementSentence(noisy)).toBe("Preview updated");
  });

  it("round-trips whatever nextAnnouncement produced", () => {
    for (const sentence of ["Preview updated", "Preview, Alpha", "Wiki", ""]) {
      expect(announcementSentence(nextAnnouncement("", sentence))).toBe(sentence);
      expect(announcementSentence(nextAnnouncement(sentence, sentence))).toBe(sentence);
    }
  });
});
