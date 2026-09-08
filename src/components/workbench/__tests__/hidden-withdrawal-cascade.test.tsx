import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The four `[hidden]` withdrawals WIN the cascade (DW-415, recorded as DW-433).
 *
 * `.wb-canvas-mode`, `.wb-canvas`, `.wb-preview` and `.wb-tree-panel` stay
 * MOUNTED and go off screen behind the `hidden` attribute, so that an open
 * dialog keeps the name typed into it, a Preview keeps its unsaved markdown and
 * the tree keeps which groups the owner collapsed. Three suites already prove
 * the elements are withdrawn from the accessibility tree, and three source
 * scans already prove the backing rules are present in `globals.css` — but a
 * source scan reads TEXT. It cannot tell a declaration that wins from one that
 * loses.
 *
 * That distinction is the whole of DW-415. Each withdrawal's selector is
 * (0,2,0), and the same stylesheet already writes `display` at (0,3,0), so one
 * future `.wb-shell[data-preview="true"] .wb-canvas { display: flex }` would
 * out-rank a plain `display: none` and put a withdrawn surface back on screen
 * while every existing assertion — and every rule comment — still read as if it
 * could not. `!important` is the floor that closes that: an important author
 * declaration loses to no NORMAL author declaration, at any specificity or
 * source order.
 *
 * So this suite does the one thing the scans cannot: it loads the REAL
 * `globals.css` into jsdom, appends exactly the competing rule the hazard
 * describes, and asks the engine which one won. Restating the rules here would
 * pin nothing — the file under test is the shipped stylesheet.
 *
 * FIDELITY: jsdom evaluates selector matching, specificity and `!important`,
 * which is all these assertions read, and it has no layout engine or media
 * evaluation (fine here — all four withdrawals live outside every width query,
 * pinned by the source scans' brace-depth checks). But it does NOT model the
 * user-agent `hidden` default the way a browser does. MEASURED: with all four
 * withdrawal rules deleted from the injected stylesheet, every hidden element
 * still computes `display: none` — including `.wb-preview`, whose own class
 * block declares `display: flex`, which in a real browser beats the UA default
 * outright. In this engine a (0,1,0) author `display` loses to the `hidden`
 * default and a (0,3,0) one wins. So the baseline case below CANNOT serve as a
 * presence guard for the withdrawal rules, and no assertion here may be read as
 * one. The competitor cases are what carry this suite; the text-presence half
 * is carried by the three source scans, and by `every-withdrawal-has-the-floor`
 * at the end of this file.
 */

/** The shipped stylesheet, minus its build-time `@import`. */
let globalsCss = "";
/** The same file verbatim, for the source scan at the end. */
let rawCss = "";

const GLOBALS = path.resolve(__dirname, "../../../app/globals.css");

/**
 * The Tailwind `@import` on line 1 is a build-time directive: jsdom tries to
 * FETCH it and logs `Could not parse CSS @import URL "tailwindcss"` for every
 * injection. Dropping it keeps the console clean and removes nothing these
 * assertions read.
 *
 * Deliberately tolerant — either quoting style, a `layer(…)`/`source(…)` tail,
 * the `url(…)` form, and a leading BOM or comment. A miss here is COSMETIC (one
 * console line), so nothing asserts the strip succeeded: escalating console
 * noise into a red suite would be a worse failure than the noise.
 */
function stripTailwindImport(css: string): string {
  return css.replace(
    /^﻿?(?:\s|\/\*[\s\S]*?\*\/)*@import\s+(?:url\()?\s*["']?[^"';)]*tailwindcss[^"';)]*["']?\s*\)?[^;]*;/,
    "",
  );
}

beforeAll(async () => {
  rawCss = await readFile(GLOBALS, "utf8");
  globalsCss = stripTailwindImport(rawCss);
});

/** Every `<style>` this suite put in the head, so `afterEach` can take it back. */
const injected: HTMLStyleElement[] = [];

// Nothing here renders through React Testing Library, so there is no tree to
// unmount — `replaceChildren` is the whole teardown, plus the stylesheets.
afterEach(() => {
  for (const style of injected.splice(0)) style.remove();
  document.body.replaceChildren();
});

/**
 * Put the real stylesheet in the document, optionally followed by `extra`.
 *
 * Order matters: `extra` is appended AFTER the withdrawals, so in a same-weight
 * tie it would win on source order too. Anything that still computes to `none`
 * is winning on the floor alone.
 */
function applyStylesheet(extra = ""): void {
  const style = document.createElement("style");
  style.textContent = `${globalsCss}\n${extra}`;
  document.head.appendChild(style);
  injected.push(style);
}

/**
 * The four withdrawals, each with the (0,3,0) competitor DW-415 describes.
 *
 * Every `data-` attribute keyed on here is one `Workbench` actually writes on
 * the shell — a competitor keyed on an attribute the app never sets would be a
 * rule that cannot match in production, and the hazard being pinned is a rule a
 * future author really could add.
 */
const SURFACES = [
  {
    className: "wb-canvas-mode",
    competitor:
      '.wb-shell[data-collapsed="true"] .wb-canvas-mode { display: block; }',
  },
  {
    className: "wb-canvas",
    competitor: '.wb-shell[data-preview="true"] .wb-canvas { display: flex; }',
  },
  {
    className: "wb-preview",
    competitor: '.wb-shell[data-preview="true"] .wb-preview { display: flex; }',
  },
  {
    className: "wb-tree-panel",
    competitor: '.wb-shell[data-settings="true"] .wb-tree-panel { display: flex; }',
  },
] as const;

const COMPETITORS = SURFACES.map((s) => s.competitor).join("\n");

/**
 * The shell markup, cut to what the cascade reads: a `.wb-shell` carrying the
 * data attributes the competitors key on, holding one element per surface.
 *
 * The elements are siblings rather than nested, so a `display: none` inherited
 * from an ancestor can never be what an assertion is reading — each result is
 * that element's own cascade.
 */
function mountShell(hidden: boolean): Map<string, HTMLElement> {
  const shell = document.createElement("div");
  shell.className = "wb-shell";
  shell.dataset.collapsed = "true";
  shell.dataset.preview = "true";
  shell.dataset.settings = "true";
  const elements = new Map<string, HTMLElement>();
  for (const { className } of SURFACES) {
    const el = document.createElement("div");
    el.className = className;
    if (hidden) el.setAttribute("hidden", "");
    shell.appendChild(el);
    elements.set(className, el);
  }
  document.body.appendChild(shell);
  return elements;
}

/** `display` for each surface, keyed by class, so a failure names the column. */
function displays(elements: Map<string, HTMLElement>): Record<string, string> {
  return Object.fromEntries(
    SURFACES.map(({ className }) => [
      className,
      getComputedStyle(elements.get(className)!).display,
    ]),
  );
}

const ALL_NONE = Object.fromEntries(SURFACES.map((s) => [s.className, "none"]));

describe("the [hidden] withdrawals hold against a higher-specificity rule", () => {
  it("hides each withdrawn surface with the stylesheet as shipped", () => {
    // The no-competitor control, and ONLY that: it fixes the starting point the
    // next case moves away from, so a "still none" there is known to be the
    // floor holding rather than a surface that was never showing in the first
    // place. It is NOT a presence guard for the withdrawal rules — see the
    // FIDELITY note above: this case passes with all four rules deleted,
    // because jsdom's `hidden` default survives the low-specificity author
    // `display` that would defeat it in a browser.
    applyStylesheet();

    expect(displays(mountShell(true))).toEqual(ALL_NONE);
  });

  it("keeps them hidden under a (0,3,0) shell-scoped display rule", () => {
    // The defect DW-415 named, made concrete: a later author rule of HIGHER
    // specificity, appended after the withdrawals so it also wins source order.
    // Without the `!important` floor each of these elements computes the
    // competitor's `display` and the withdrawn surface is back on screen. This
    // is the load-bearing case in the file — it is the one that goes red when
    // the floor is removed.
    applyStylesheet(COMPETITORS);

    expect(displays(mountShell(true))).toEqual(ALL_NONE);
  });

  it("yields to a competitor that also declares !important", () => {
    // The real bound, recorded rather than implied. `!important` beats every
    // NORMAL author declaration; it does not beat another important one, which
    // then wins on source order (and Tailwind's `@import` establishes cascade
    // layers, whose order REVERSES for important declarations — so an important
    // declaration emitted inside a layer can take these too).
    //
    // That is the honest scope of the guarantee, and it is the right one: the
    // floor exists to stop an ORDINARY restyle silently undoing a withdrawal,
    // not to make the rule unwritable-over by an author who means it.
    applyStylesheet(
      SURFACES.map((s) => s.competitor.replace(/;/, " !important;")).join("\n"),
    );

    expect(displays(mountShell(true))).toEqual({
      "wb-canvas-mode": "block",
      "wb-canvas": "flex",
      "wb-preview": "flex",
      "wb-tree-panel": "flex",
    });
  });

  it("withdraws nothing that is not carrying the attribute", () => {
    // The bound on the floor in the other direction: `!important` is scoped to
    // the attribute, so it fires only in the state where nothing should show
    // the element. Same stylesheet, same competitors, no `hidden` — every
    // surface stays visible and the competitor is free to set what it likes.
    applyStylesheet(COMPETITORS);
    const shown = displays(mountShell(false));

    for (const { className } of SURFACES) {
      expect({ className, hidden: shown[className] === "none" }).toEqual({
        className,
        hidden: false,
      });
    }
  });
});

describe("every [hidden] withdrawal in the stylesheet carries the floor", () => {
  it("finds no withdrawal rule without display: none !important", () => {
    // The four selectors above are hardcoded here and named one-by-one in the
    // three source scans, so a FIFTH withdrawal — a surface hidden the same way
    // in some later story — could ship with a bare `display: none` and nothing
    // would notice: it would carry the identical defect DW-415 raised, two
    // columns over, with a full suite green. This scan is keyed on the MECHANISM
    // instead of on a list, so a new `[hidden]` rule either arrives with the
    // floor or turns this red.
    //
    // `[^{}]*` for the selector text cannot cross a brace, so each match starts
    // where the previous rule's `}` left off — no delimiter to consume, which is
    // what lets two withdrawals written back-to-back both be seen. At-rule
    // blocks yield their INNER rules, which is the wanted behaviour: a
    // withdrawal smuggled inside a width query would be caught here too.
    const withoutComments = rawCss.replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...withoutComments.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
      .map((match) => ({
        selector: match[1].trim(),
        declarations: match[2].trim(),
      }))
      .filter((rule) => rule.selector.includes("[hidden]"));

    // A zero match would pass the loop below vacuously — the withdrawals having
    // been deleted outright is exactly as bad as one shipping without the floor.
    expect(rules.map((rule) => rule.selector).sort()).toEqual([
      ".wb-canvas-mode[hidden]",
      ".wb-canvas[hidden]",
      ".wb-preview[hidden]",
      ".wb-tree-panel[hidden]",
    ]);

    for (const { selector, declarations } of rules) {
      expect({ selector, floored: /display:\s*none\s*!important;?/.test(declarations) }).toEqual(
        { selector, floored: true },
      );
    }
  });
});
