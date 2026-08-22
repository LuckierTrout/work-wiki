/**
 * The one `<option>` spelling both Wiki pickers share (DW-148).
 *
 * The switcher and the delete dialog rendered `wiki.name` alone. Nothing
 * enforces unique names, and Delete is irreversible, so two rows spelled `Acme`
 * made an unrecoverable choice a coin flip. `wikiOptionLabel` adds the three
 * facts that are not the name.
 *
 * Unit-tested here rather than only through the two mounted suites, whose
 * fixture ids are hand-written strings like `wiki 1/2` chosen to exercise
 * percent-encoding. Those never put `id.slice(0, 8)` in front of the shape it
 * actually gets — `crypto.randomUUID()`, whose first eight characters stop at a
 * hex block rather than mid-word.
 */
import { describe, expect, it } from "vitest";
import { SCENARIO_LABELS, wikiOptionLabel } from "../wiki-scenarios";
import { WIKI_ID_RE } from "../wiki-paths";

/** A real `crypto.randomUUID()` value — the shape `wikis.ts` actually writes. */
const UUID = "3f2a9c41-7b6d-4e88-9a10-5c2d8e7f0b34";

describe("wikiOptionLabel", () => {
  it("carries the name, the template, the created day and the head of the id", () => {
    expect(WIKI_ID_RE.test(UUID)).toBe(true);

    const label = wikiOptionLabel({
      id: UUID,
      name: "Acme",
      scenario: "business",
      createdAt: "2026-01-02T03:04:05.678Z",
    });

    expect(label).toBe("Acme — Business · 2026-01-02 · 3f2a9c41");
    // The label map is the shared one, so a relabelled scenario reaches the
    // picker without this function knowing.
    expect(label).toContain(SCENARIO_LABELS.business);
    // The id fragment is the first UUID block exactly — long enough to be a
    // discriminator, short enough to read beside a name.
    expect(label).toContain(UUID.split("-")[0]);
    expect(label).not.toContain(UUID);
  });

  it("separates two wikis that differ only by id", () => {
    // The DW-148 case itself: same name, same template, same day. The id is the
    // only thing left, which is why it is in the label at all.
    const twin = {
      name: "Acme",
      scenario: "business",
      createdAt: "2026-01-02T03:04:05.678Z",
    } as const;
    const a = wikiOptionLabel({ ...twin, id: UUID });
    const b = wikiOptionLabel({
      ...twin,
      id: "9d4e1b07-2c53-4a6f-8e21-0b7a3f5c9d18",
    });

    expect(a).not.toBe(b);
  });

  it("takes the day off the ISO string rather than through a time zone", () => {
    // Formatted through `Intl`, an instant late in a UTC day renders as the
    // PREVIOUS day west of Greenwich — so the label would name a different date
    // for the same wiki depending on who was looking, and the tests would drift
    // with the machine that ran them.
    expect(
      wikiOptionLabel({
        id: UUID,
        name: "Acme",
        scenario: "general",
        createdAt: "2026-01-02T23:59:59.999Z",
      }),
    ).toContain("· 2026-01-02 ·");
  });

  it("leaves a name that contains the separators alone", () => {
    // The separators are decoration, not structure: nothing parses this string
    // back apart, so a name carrying an em dash or a middot is rendered as the
    // owner typed it rather than escaped or trimmed.
    const label = wikiOptionLabel({
      id: UUID,
      name: "Acme — R&D · notes",
      scenario: "research",
      createdAt: "2026-01-02T00:00:00.000Z",
    });

    expect(label).toBe("Acme — R&D · notes — Research · 2026-01-02 · 3f2a9c41");
    expect(label.startsWith("Acme — R&D · notes")).toBe(true);
  });
});
