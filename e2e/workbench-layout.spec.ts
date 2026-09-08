import type { Page } from "@playwright/test";
import {
  SPLIT_HIT_WIDTH,
  SPLIT_PREVIEW_LABEL,
  SPLIT_TREE_LABEL,
} from "../src/lib/workbench-split";
import { expect, test } from "./fixtures/owner";
import { createOwnWiki, resetOwnerTenant, seedWikiPages } from "./fixtures/wiki";

/**
 * The layout claims a stylesheet scan can state but cannot settle (DW-185).
 *
 * `workbench-split.test.ts` and `workbench-left-column.test.ts` pin the
 * declaration text and the source order of the rules below — which is a real
 * check, and stays. What text in `globals.css` cannot show is the RESOLVED
 * result: that the cascade actually landed on the rule the source order
 * predicts, that a 24px strip really measures 24px on the boundary it names,
 * that a point two pixels inside it really answers to the pointer, or that a
 * stacked column is really reachable by scrolling.
 *
 * So every assertion here reads a resolved value — `getComputedStyle` through
 * `toHaveCSS`, `getBoundingClientRect` through `boundingBox`,
 * `document.elementFromPoint`, and a real document scroll. None of them reads
 * the stylesheet, and none may: a spec that re-parsed `globals.css` here would
 * be the third copy of the scan the other two suites already own.
 *
 * The layout is deliberately NOT repaired from here. If a case below disagrees
 * with the stylesheet scans, a real browser and the source text have said
 * different things about the same rule, and that is a product bug to file
 * rather than a number to adjust.
 */

/**
 * Every case here mints a wiki, and one worker shares one store across every
 * spec file — so this file hands the store back rather than leaving whatever it
 * created for whoever runs next.
 *
 * Not an argument about ORDER: `workbench-owner.spec.ts` re-establishes its own
 * empty tenant in `beforeAll` and does not depend on this hook, which is what
 * keeps either file correct run alone, renamed, or sharded. This is the other
 * half of the same discipline — leave the store as you found it.
 */
test.afterAll(async () => {
  await resetOwnerTenant();
});

/** A page in the seeded wiki; clicking its tree row is what docks the Preview. */
const PAGE_TITLE = "Layout alpha";

/**
 * Enough content that the narrow shell OVERFLOWS the viewport.
 *
 * Not decoration. Below 900px the release swaps `overflow: hidden` for
 * `visible` so the DOCUMENT scrolls, and "the document did not scroll" is the
 * pass a clamped shell and a document shorter than the viewport produce
 * identically — which is why the sheet case proves the scroll BEFORE it asserts
 * the clamp.
 *
 * A margin rather than a threshold: the stacked rows clear 600px on their own
 * even with one page seeded (`.wb-tree-body` caps at 40vh and
 * `.wb-preview-body` at 50vh, so the two of them plus their heads already
 * approach the viewport), and this content puts the result somewhere it cannot
 * drift back under. Measured at 800×600: a 986px document, scrolling 386px.
 */
const DOCKED_BODY = Array.from(
  { length: 40 },
  (_, i) => `Paragraph ${i + 1} of the docked page, past the Preview body's 50vh cap.`,
).join("\n\n");

const SEEDED = [
  { slug: "layout-alpha", content: `# ${PAGE_TITLE}\n\n${DOCKED_BODY}` },
  ...Array.from({ length: 9 }, (_, i) => ({
    slug: `layout-filler-${i + 1}`,
    content: `# Layout filler ${i + 1}\n\nA tree row, past the tree body's 40vh cap.`,
  })),
];

/**
 * A signed-in shell at `width`×`height` with the Preview docked on a real tree
 * row — the state every case below starts from.
 *
 * The dock comes from a CLICK rather than from stored state: the reveal effect
 * and the docked grid variants both key on the same selection, and a restore
 * would skip the moment this spec exists to observe.
 */
async function dockedShell(
  page: Page,
  width: number,
  height: number,
): Promise<void> {
  await page.setViewportSize({ width, height });
  await createOwnWiki(page, `E2E layout ${Date.now()}`);
  await seedWikiPages(page, SEEDED);
  await page.goto("/");
  const row = page
    .locator("button.wb-tree-row:not(.wb-tree-row--group)")
    .filter({ hasText: PAGE_TITLE })
    .first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(page.locator(".wb-shell")).toHaveAttribute("data-preview", "true");
  await expect(page.locator(".wb-preview")).toBeVisible();
}

/** A live box, or a failure that names which element had none. */
async function boxOf(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  expect(box, `${selector} must have a layout box`).not.toBeNull();
  return box!;
}

/**
 * What the pointer would land on at a viewport point.
 *
 * TWO fields, because "no separator here" and "nothing here at all" are
 * different answers and only one of them is the miss this spec means. A point
 * off the viewport, or over a gap, returns no element — and collapsing that to
 * the same `null` a real miss produces would let a mistyped coordinate read as
 * proof that the strip stops at its boundary. `tag` is null only when the
 * browser found nothing; `handle` is null when it found something that is not
 * the separator.
 *
 * `closest` rather than an identity check on the returned node: the strip has a
 * `::before` hairline and could gain a child, and the claim under test is that
 * the pointer reaches the SEPARATOR, not that it reaches one particular node.
 */
interface Hit {
  tag: string | null;
  handle: string | null;
}

async function handleAt(page: Page, x: number, y: number): Promise<Hit> {
  return page.evaluate(
    ([px, py]) => {
      const el = document.elementFromPoint(px, py);
      if (!el) return { tag: null, handle: null };
      const handle = el.closest(".wb-split-handle");
      return {
        tag: el.tagName.toLowerCase(),
        handle: handle ? handle.className : null,
      };
    },
    [x, y] as const,
  );
}

test.describe("the docked shell measured in a real browser (DW-185)", () => {
  test("puts each separator's grab strip on its own column boundary", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    // Wide enough that the handles are not hidden: the 1199px block drops them,
    // because both side columns are pinned to their minimums from there down
    // and there is no width left to drag.
    await dockedShell(page, 1280, 800);

    const treeStrip = page.getByRole("separator", { name: SPLIT_TREE_LABEL });
    const previewStrip = page.getByRole("separator", { name: SPLIT_PREVIEW_LABEL });
    await expect(treeStrip).toBeVisible();
    await expect(previewStrip).toBeVisible();

    const left = await boxOf(page, ".wb-left");
    const preview = await boxOf(page, ".wb-preview");
    const tree = await boxOf(page, ".wb-split-handle--tree");
    const previewHandle = await boxOf(page, ".wb-split-handle--preview");

    // The ONE retyped number in this file, and it is imported rather than
    // typed: `SPLIT_HIT_WIDTH` is the same constant the shell's clamp reads.
    // WCAG 2.2 AA SC 2.5.8 wants 24 CSS px, and this is where that is true of
    // a rendered box rather than of a declaration.
    expect(Math.round(tree.width)).toBe(SPLIT_HIT_WIDTH);
    expect(Math.round(previewHandle.width)).toBe(SPLIT_HIT_WIDTH);

    // Both strips start AT their boundary and extend RIGHT of it (DW-44), so
    // the scrollbar on the left of each boundary stays clickable. Compared
    // between two LIVE boxes: `left: calc(var(--wb-rail) + var(--wb-tree))` is
    // only correct if it resolves to the column edge, and only the browser
    // knows what it resolved to.
    expect(Math.abs(tree.x - (left.x + left.width))).toBeLessThanOrEqual(1);
    expect(Math.abs(previewHandle.x - preview.x)).toBeLessThanOrEqual(1);

    // …and it is full height, which is what makes the whole boundary grabbable.
    const shell = await boxOf(page, ".wb-shell");
    expect(Math.abs(tree.height - shell.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(previewHandle.height - shell.height)).toBeLessThanOrEqual(1);
  });

  test("answers the pointer inside each boundary and not outside it", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await dockedShell(page, 1280, 800);

    for (const selector of [".wb-split-handle--tree", ".wb-split-handle--preview"]) {
      const strip = await boxOf(page, selector);
      const midY = strip.y + strip.height / 2;
      // Two pixels IN from the boundary: `z-index: 2` and a transparent
      // background make this the kind of claim only hit-testing can settle —
      // the strip is invisible, so nothing else here would notice it being
      // covered by a later rule or sitting under the column borders.
      const inside = await handleAt(page, strip.x + 2, midY);
      expect(
        inside.handle,
        `${selector} must answer just inside its boundary`,
      ).toContain("wb-split-handle");
      // …and two pixels OUT, which is the scrollbar side. A strip centred on
      // the boundary would answer here too, and that is exactly the regression
      // DW-44 traded a centred strip away to avoid.
      const outside = await handleAt(page, strip.x - 2, midY);
      // Something IS there — the column the strip sits against. Asserted first,
      // because a point that hit nothing would satisfy the line below while
      // proving nothing about where the strip ends.
      expect(
        outside.tag,
        `${selector}: the point outside its boundary must land on the column, ` +
          `not off the document`,
      ).not.toBeNull();
      expect(
        outside.handle,
        `${selector} must not answer outside its boundary`,
      ).toBeNull();
    }
  });
});

test.describe("a stacked Preview below 900px is reachable (DW-34)", () => {
  test("releases the shell's clamp so the document scrolls to the column", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    // Docked wide first, then narrowed: the same order an owner produces, and
    // the order that makes the responsive block the only thing that changed.
    await dockedShell(page, 1280, 800);
    await page.setViewportSize({ width: 800, height: 600 });

    const shell = page.locator(".wb-shell");
    // The clamp released — resolved, not declared. `height: 100dvh;
    // max-height: 100dvh; overflow: hidden` is right for three desktop columns
    // and fatal for a fourth ROW: it would place the Preview past the bottom of
    // a box that clips, unreachable by scroll or by `scrollIntoView`.
    await expect(shell).toHaveCSS("overflow", "visible");

    const preview = page.locator(".wb-preview");
    await preview.scrollIntoViewIfNeeded();
    await expect(preview).toBeInViewport();
  });

  test("clamps it back while the mode sheet is open, and lets go on close", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await dockedShell(page, 1280, 800);
    await page.setViewportSize({ width: 800, height: 600 });

    const shell = page.locator(".wb-shell");
    await expect(shell).toHaveCSS("overflow", "visible");

    // POSITIVE CONTROL, and the case is worthless without it. `scrollY === 0`
    // after a scroll attempt is exactly what a document SHORTER than the
    // viewport produces, so the clamped assertion below would pass on an empty
    // page with the counter-rule deleted. Prove the document scrolls while the
    // sheet is CLOSED first; only then does refusing to scroll mean anything.
    const openScroll = await page.evaluate(() => {
      window.scrollTo(0, 0);
      window.scrollBy(0, 400);
      return { y: window.scrollY, height: document.documentElement.scrollHeight };
    });
    expect(
      openScroll.height,
      "the narrow shell must overflow the viewport, or the clamp below proves nothing",
    ).toBeGreaterThan(600);
    expect(
      openScroll.y,
      "with the sheet closed the document must actually scroll",
    ).toBeGreaterThan(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

    await page.getByRole("button", { name: "Modes" }).click();
    await expect(shell).toHaveAttribute("data-sheet-open", "true");
    // The rail is a fixed off-canvas sheet over a fixed backdrop at this width,
    // so a document that scrolls scrolls the page BEHIND an open modal.
    await expect(shell).toHaveCSS("overflow", "hidden");
    const scrolled = await page.evaluate(() => {
      window.scrollBy(0, 800);
      return window.scrollY;
    });
    // …and the SAME document that just moved 400px does not move at all.
    expect(scrolled).toBe(0);

    await page.keyboard.press("Escape");
    await expect(shell).toHaveAttribute("data-sheet-open", "false");
    await expect(shell).toHaveCSS("overflow", "visible");
  });

  test("releases and re-clamps a COLLAPSED docked shell, which takes three attributes", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    // Both halves for the widest docked selector.
    // `.wb-shell[data-collapsed][data-preview]` is named explicitly in the
    // release, so the release must still reach a collapsed shell; and it is two
    // attributes wide, so the sheet's counter-rule has to be THREE to outrank
    // it. Source order cannot decide this one — it is a specificity claim, and
    // only a browser resolves specificity.
    await dockedShell(page, 1280, 800);
    // The chevron is `display: none` below 900px, so the collapse has to happen
    // wide and the viewport has to move afterwards.
    //
    // Enter rather than a pointer click, and not for a lack of the affordance:
    // `next dev` paints its own overlay portal over the bottom-left corner of
    // the viewport, which is exactly where the rail's chevron sits, so a
    // pointer click here waits on a harness artifact rather than on the app.
    // The keyboard reaches the same handler, and the collapse is a PRECONDITION
    // for this case — the claim under test is the cascade after the resize.
    await page.getByRole("button", { name: "Collapse left column" }).press("Enter");
    const shell = page.locator(".wb-shell");
    await expect(shell).toHaveAttribute("data-collapsed", "true");
    await page.setViewportSize({ width: 800, height: 600 });
    // BOTH attributes re-read after the resize, and this is the whole guard on
    // the case: below 900px the column is force-shown, and a shell that dropped
    // `data-collapsed` on the way down would go on passing every line below
    // while exercising the two-attribute rule this case exists to get past.
    await expect(shell).toHaveAttribute("data-collapsed", "true");
    await expect(shell).toHaveAttribute("data-preview", "true");
    await expect(shell).toHaveCSS("overflow", "visible");

    await page.getByRole("button", { name: "Modes" }).click();
    await expect(shell).toHaveAttribute("data-sheet-open", "true");
    await expect(shell).toHaveAttribute("data-collapsed", "true");
    await expect(shell).toHaveCSS("overflow", "hidden");
  });

  test("keeps the clamp at the same width when NOTHING is docked", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    // THE NEGATIVE CONTROL. Every case above asserts that a docked shell stops
    // clamping below 900px; none of them would notice the release being handed
    // to shells that are not docked. Broaden the selector past `[data-preview]`
    // — drop the attribute, or add a comma — and the three-column surface
    // becomes a page that scrolls at every narrow width, with the rail sheet
    // sliding over content it no longer covers, and every case above stays
    // green. This is the case that goes red.
    await page.setViewportSize({ width: 1280, height: 800 });
    await createOwnWiki(page, `E2E layout undocked ${Date.now()}`);
    await page.goto("/");
    const shell = page.locator(".wb-shell");
    await expect(shell).toHaveAttribute("data-preview", "false");

    await page.setViewportSize({ width: 800, height: 600 });
    await expect(shell).toHaveAttribute("data-preview", "false");
    await expect(shell).toHaveCSS("overflow", "hidden");
    // …and it really is the shell holding the page still, not a short document:
    // the clamp is what makes `100dvh` the whole of it.
    const scrolled = await page.evaluate(() => {
      window.scrollBy(0, 800);
      return window.scrollY;
    });
    expect(scrolled).toBe(0);
  });
});

test.describe("the 900–1199px band has no draggable divider (DW-185)", () => {
  test("hides both grab strips, which is why the geometry cases run at 1280px", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    // The reason the two geometry cases above choose 1280px, asserted rather
    // than assumed. From 1199px down both side columns are pinned to their
    // minimums, so there is no width left to drag and the handles are dropped —
    // and `showSplitHandle` deliberately does NOT know that breakpoint, because
    // a width comparison in JavaScript would be a second copy of the media
    // query. Which means the elements are still in the DOM here and only the
    // stylesheet withdraws them: `display: none`, resolved, on a node that
    // exists.
    await dockedShell(page, 1280, 800);
    await expect(page.locator(".wb-split-handle--tree")).toBeVisible();

    await page.setViewportSize({ width: 1000, height: 800 });
    await expect(page.locator(".wb-shell")).toHaveAttribute("data-preview", "true");
    for (const selector of [".wb-split-handle--tree", ".wb-split-handle--preview"]) {
      await expect(page.locator(selector)).toHaveCount(1);
      await expect(page.locator(selector)).toHaveCSS("display", "none");
    }
  });
});
