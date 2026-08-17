/**
 * WCAG 2.2 AA: a document gets exactly ONE `main` landmark. `SiteChrome` wraps
 * every route's children in `<main id="main-content">`, so any `<main>` rendered
 * by a page or component lands INSIDE it — a duplicate landmark that makes the
 * "skip to main content" bypass ambiguous for screen-reader users.
 *
 * Thirty such inner landmarks were demoted to plain `<div>`s; this guard is what
 * stops the thirty-first. `single-main-landmark-mounted.test.tsx` asserts the
 * same rule against a real rendered tree; this half is source-level, because a
 * mounted test can only cover the surfaces it thinks to compose, while a scan
 * covers every file that exists.
 *
 * The scan is deliberately paranoid in one direction: a FALSE NEGATIVE (a real
 * `<main>` the scan cannot see) silently deletes the whole guard, while a false
 * positive merely annoys someone. Hence `withoutComments()` below, and hence the
 * negative-control cases that prove it is honest rather than trusting it.
 */
import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const SRC = path.resolve(__dirname, "../..");

/**
 * Files allowed to emit a `main` landmark, as `src`-relative paths.
 *
 * `src/app/global-error.tsx` would legitimately belong here if it is ever
 * added: Next.js renders `global-error` OUTSIDE the root layout, replacing
 * `<html>`/`<body>` wholesale, so `SiteChrome` — and therefore the only `main`
 * on every other route — is absent. Such a file must supply its own landmark,
 * and adding it to this set is the correct fix, not demoting its `<main>`.
 */
const LANDMARK_OWNERS = new Set([path.join("components", "SiteChrome.tsx")]);

/** Source extensions that can contain JSX the browser will render. */
const SOURCE_FILE = /\.(?:tsx?|jsx?|mdx)$/;

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      out.push(...(await walk(full)));
    } else if (SOURCE_FILE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every directory under `src` that can put an element in the app's document.
 *
 * `hooks` is here and not only `app`/`components` because `useToast.ts` and
 * `useKeyboardShortcuts.ts` build their trees with `createElement` and are
 * mounted on EVERY route through `ClientProviders`, so a landmark added there
 * is the worst case this guard exists for — one that lands on every page at
 * once. Scanning only `app` and `components` waved it through.
 *
 * `lib` is deliberately excluded: `src/lib/html.ts` handles *ingested*
 * third-party HTML, where a `<main>` string is someone else's document being
 * sanitised, not a landmark in ours.
 */
const SCANNED_DIRS = ["app", "components", "hooks"] as const;

async function appAndComponentSources(): Promise<string[]> {
  const files: string[] = [];
  for (const dir of SCANNED_DIRS) {
    files.push(...(await walk(path.join(SRC, dir))));
  }
  return files;
}

/**
 * Blank out comments — and ONLY comments — so that prose *about* the landmark is
 * never mistaken for one, while everything a browser could actually render
 * survives to be matched.
 *
 * This is a single left-to-right scan rather than a regex, because comments and
 * string literals interact: `src/app/ingest/page.tsx` contains
 * `accept="image/*"`, and a regex that strips `/* … *\/` reads that `/*` as a
 * comment opener and runs to the NEXT `*\/` — the `{/* PDF *\/}` comment thirty
 * lines later — deleting the JSX in between. A `<main>` in that window was
 * invisible to the scan. Regex ordering cannot fix it; only knowing that
 * `image/*` sits inside a string can.
 *
 * So strings are PARSED (to find where comments really begin) but emitted
 * verbatim. That is deliberate: a `<main>` in a string is a genuine landmark
 * once it reaches `dangerouslySetInnerHTML`, so it should be flagged, not
 * excused. Blanking string bodies would also erase `id="main-content"` and make
 * the anti-vacuity check below unable to see the landmark it is guarding.
 *
 * Whitespace of the same shape replaces each comment (newlines kept), so line
 * numbers survive for reporting.
 *
 * One deliberate limit, chosen to fail LOUD rather than silent: an unterminated
 * `'`/`"` is treated as a mis-detection and re-emitted as code once the line
 * ends, since real JS forbids a raw newline inside those quotes. That is what
 * stops an apostrophe in JSX text (`<p>don't</p>`) from swallowing the rest of
 * the file — it trades a possible false positive for never hiding a real tag.
 */
export function withoutComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    // `//` to end of line. Not anchored to line start: a trailing comment is
    // just as capable of holding the word `<main>`.
    //
    // Two shapes are NOT comment openers even though they read as `//`, and
    // both fail in the silent direction (they blank real code):
    //   - `:` before it — a bare URL in JSX text, `<p>see https://x.dev</p>`,
    //     which is page copy rather than a string literal, so the string arm
    //     below never sees it.
    //   - `\` before it — the closing `/` of a regex literal whose body ends in
    //     an escaped slash, e.g. `/https:\/\//`.
    // Both would have hidden a `<main>` written later on the same line, which
    // is exactly the blind-window failure the block-comment arm was fixed for.
    const prev = i > 0 ? source[i - 1] : "";
    if (ch === "/" && next === "/" && prev !== ":" && prev !== "\\") {
      while (i < n && source[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }

    // `/* … */`, which also covers the JSX `{/* … */}` form.
    if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      let literal = ch;
      let closed = false;
      while (j < n) {
        if (source[j] === "\\") {
          literal += source.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (source[j] === "\n") break;
        if (source[j] === quote) {
          literal += quote;
          j++;
          closed = true;
          break;
        }
        literal += source[j];
        j++;
      }
      if (closed) {
        out += literal;
        i = j;
        continue;
      }
      // Not a string after all — an apostrophe in JSX text. Emit it as code so
      // nothing downstream can hide behind a quote that never closes.
      out += ch;
      i++;
      continue;
    }

    if (ch === "`") {
      let j = i + 1;
      out += "`";
      while (j < n) {
        if (source[j] === "\\") {
          out += source.slice(j, j + 2);
          j += 2;
          continue;
        }
        // A `${…}` hole is real code and may itself hold comments, so recurse.
        if (source[j] === "$" && source[j + 1] === "{") {
          let depth = 1;
          let k = j + 2;
          let expression = "";
          while (k < n && depth > 0) {
            if (source[k] === "{") depth++;
            else if (source[k] === "}") {
              depth--;
              if (depth === 0) break;
            }
            expression += source[k];
            k++;
          }
          out += `\${${withoutComments(expression)}}`;
          j = k + 1;
          continue;
        }
        if (source[j] === "`") {
          out += "`";
          j++;
          break;
        }
        out += source[j];
        j++;
      }
      i = j;
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/**
 * Every way the duplicate landmark can come back. A literal `<main>` is only
 * the most obvious one; each of the others renders the same element, and a
 * guard that watched for the tag alone would wave them through.
 */
const LANDMARK_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "<main> element", pattern: /<main\b/ },
  // `\{?\s*` so the JSX expression-container forms — `role={"main"}`,
  // `as={'main'}` — are caught too. Without it the guard watched only the bare
  // attribute spelling, and swapping quotes for braces is a one-character
  // change that reintroduces the same landmark.
  { label: 'role="main"', pattern: /role\s*=\s*\{?\s*["'`]main["'`]/ },
  { label: 'createElement("main")', pattern: /createElement\s*\(\s*["'`]main["'`]/ },
  { label: 'as="main" polymorphic prop', pattern: /\bas\s*=\s*\{?\s*["'`]main["'`]/ },
  { label: "styled.main", pattern: /\bstyled\s*\.\s*main\b/ },
];

const DEMOTE = "Demote it to a plain <div> — SiteChrome already supplies the document's only main landmark.";

describe("exactly one main landmark", () => {
  it("emits no main landmark outside SiteChrome", async () => {
    const offenders: string[] = [];
    for (const file of await appAndComponentSources()) {
      const relative = path.relative(SRC, file);
      if (LANDMARK_OWNERS.has(relative)) continue;
      const code = withoutComments(await readFile(file, "utf8"));
      for (const { label, pattern } of LANDMARK_PATTERNS) {
        if (pattern.test(code)) offenders.push(`${relative} (${label})`);
      }
    }
    expect(
      offenders,
      `These files render a second 'main' landmark inside the one SiteChrome ` +
        `already provides, which is a duplicate-landmark violation (WCAG 2.2 ` +
        `AA) and makes the "skip to main content" bypass ambiguous. ${DEMOTE} ` +
        `If a file legitimately needs its own landmark because it renders ` +
        `outside the root layout (only 'app/global-error.tsx' qualifies), add ` +
        `it to LANDMARK_OWNERS instead.`,
    ).toEqual([]);
  });

  it("keeps both of SiteChrome's branch landmarks in place", async () => {
    // Without this, the sweep above is satisfied by an app with NO main
    // landmark at all — and asserting merely "at least one" would miss one of
    // the two branches being dropped, which would strip the landmark from
    // exactly half the routes. Comments are stripped first so the prose in this
    // file cannot stand in for the real thing.
    const owner = path.join("components", "SiteChrome.tsx");
    const code = withoutComments(await readFile(path.join(SRC, owner), "utf8"));
    const landmarks = code.match(/<main id="main-content"/g) ?? [];
    expect(
      landmarks,
      `SiteChrome must render '<main id="main-content"' in BOTH branches — the ` +
        `'bare' one ('/' and '/sign-in') and the nav+footer one. Finding ` +
        `${landmarks.length} instead of 2 means a route now has no main ` +
        `landmark and no skip-link target, which also makes the scan above ` +
        `pass vacuously.`,
    ).toHaveLength(2);
  });

  it("recognises every spelling of the landmark it claims to watch for", () => {
    // The offender sweep is only as good as this list, and an empty offender
    // list looks identical whether the guard is working or asleep.
    const hit = (source: string) =>
      LANDMARK_PATTERNS.some(({ pattern }) => pattern.test(source));

    for (const source of [
      '<main className="x">',
      '<div role="main">',
      "<div role={'main'}>",
      'createElement("main", null)',
      '<Box as="main">',
      "<Box as={`main`}>",
      "const Shell = styled.main`display:block`",
    ]) {
      expect(hit(source), `should flag: ${source}`).toBe(true);
    }

    for (const source of [
      '<div className="studio-main">',
      '<div id="main-content">',
      '<div role="region" aria-label="main area">',
      "const mainThing = 1;",
    ]) {
      expect(hit(source), `should NOT flag: ${source}`).toBe(false);
    }
  });

  it("still composes SiteChrome in the root layout, where the landmark comes from", async () => {
    // Before the sweep every page carried its own `<main>`, so this
    // composition was not load-bearing. Now it is the ONLY thing between the
    // app and zero landmarks — and the checks above cannot see it: they assert
    // that no file emits a landmark, and that SiteChrome's own source still
    // contains two, both of which stay true if `layout.tsx` stops rendering
    // SiteChrome at all. That end state (no landmark, no skip link, no nav) is
    // worse than the duplicate-landmark bug this story fixed.
    const layout = withoutComments(
      await readFile(path.join(SRC, "app", "layout.tsx"), "utf8"),
    );
    expect(
      /<SiteChrome[\s>]/.test(layout),
      `'app/layout.tsx' must still wrap {children} in <SiteChrome>: it is the ` +
        `only place SiteChrome is composed, and therefore the only source of ` +
        `the document's single main landmark and its skip-link target. If the ` +
        `chrome moves elsewhere, point this check at its new home rather than ` +
        `deleting it.`,
    ).toBe(true);
  });

  it("leaves the demoted content columns carrying their original classes", async () => {
    // The point of the sweep was to change the TAG and nothing else. This pins
    // the class list on the wrapper element itself (`<div className="…"`), and
    // deliberately not the inline `style` text beside it — asserting the
    // padding literals would turn a landmark suite into a change detector that
    // a Prettier rewrap or a spacing tweak breaks.
    const columns: ReadonlyArray<[string, string]> = [
      ["components/ReviewDesk.tsx", "shell paper-route fade"],
      ["components/SystemHealthDesk.tsx", "shell paper-route fade"],
      ["components/IntegrationDesk.tsx", "shell paper-route fade"],
      ["components/KnowledgeAtlas.tsx", "shell paper-route fade"],
      ["components/ChatWorkspace.tsx", "shell fade"],
      ["components/PrivateWorkspaceNotice.tsx", "shell fade"],
      ["components/KnowledgeStudio.tsx", "studio-main"],
      ["components/VaultExplorer.tsx", "vault-explorer-shell vault-explorer-grid"],
    ];
    for (const [relative, className] of columns) {
      // Comment-stripped, so a commented-out copy of the old markup cannot
      // satisfy the check while the live wrapper has drifted.
      const source = withoutComments(await readFile(path.join(SRC, relative), "utf8"));
      // `\s+` because several of these wrappers are formatted multi-line, with
      // `className` on the line below `<div`. Matching the attribute on the
      // same ELEMENT is the claim; how it is line-wrapped is not.
      const wrapper = new RegExp(`<div\\s+className="${className}"`);
      expect(
        wrapper.test(source),
        `${relative}'s content column must still be the same element with the ` +
          `same classes, only demoted from <main> to <div>. '${className}' is ` +
          `what its CSS is keyed on, so losing or renaming it restyles the ` +
          `surface rather than just fixing the landmark.`,
      ).toBe(true);
    }
  });
});

/**
 * Selector-position `main` in the stylesheets.
 *
 * The sweep only holds if nothing styles the ELEMENT: a rule written against
 * `main` would have applied to all thirty demoted wrappers and now applies to
 * one. Every `.css` under `src` is walked rather than one hardcoded path, so a
 * second stylesheet cannot be added outside the check.
 */
function selectorPreludes(css: string): string[] {
  // Comments and strings are resolved in ONE left-to-right pass, for the same
  // reason `withoutComments()` above is not a regex: run separately, whichever
  // goes first is blind to the other. Stripping comments first means
  // `content: "/*"` opens a phantom comment that swallows every rule up to the
  // next `*/` — a `main { … }` element rule could hide in that window, which is
  // the silent direction. Stripping strings first has the mirror flaw, with an
  // apostrophe in a comment ("don't") as the trigger. Scanning once, knowing
  // which state it is in, has neither.
  //
  // A selector (or at-rule prelude) is the text before a `{`, back to the last
  // `}` or `;`. Everything else is a declaration block, so `grid-area: main`
  // and friends are excluded by construction rather than by pattern. Quoted
  // strings become `""` because a font name or a `grid-template-areas` map is
  // never a selector.
  const preludes: string[] = [];
  let current = "";
  for (let i = 0; i < css.length; i++) {
    const c = css[i];

    if (c === "/" && css[i + 1] === "*") {
      i += 2;
      while (i < css.length && !(css[i] === "*" && css[i + 1] === "/")) i++;
      i++; // the loop's own i++ steps past the `/`
      current += " ";
      continue;
    }

    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c && css[j] !== "\n") {
        if (css[j] === "\\") j++;
        j++;
      }
      current += '""';
      // An unterminated quote is a mis-detection (an apostrophe in prose), so
      // only skip ahead when a real closing quote was found on the same line.
      if (j < css.length && css[j] === c) i = j;
      continue;
    }

    if (c === "{") {
      preludes.push(current);
      current = "";
    } else if (c === "}" || c === ";") {
      current = "";
    } else {
      current += c;
    }
  }
  return preludes;
}

/**
 * `main` as an element selector. The leading class includes `(` so the
 * functional pseudo-classes this stylesheet already uses — `:is(main, …)`,
 * `:where(main)`, `:not(main)` — cannot slip past, and the trailing guard keeps
 * `.studio-main` and `#main-content` out.
 */
const MAIN_AT_SELECTOR_POSITION = /(?:^|[\s,>+~(])main(?![-\w])/;

async function stylesheets(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await stylesheets(full)));
    else if (entry.name.endsWith(".css")) out.push(full);
  }
  return out;
}

describe("no stylesheet targets the main element", () => {
  it("styles the demoted columns by class, never by element", async () => {
    const sheets = await stylesheets(SRC);
    // A zero-file walk would pass this vacuously.
    expect(sheets.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const sheet of sheets) {
      for (const prelude of selectorPreludes(await readFile(sheet, "utf8"))) {
        if (MAIN_AT_SELECTOR_POSITION.test(prelude)) {
          offenders.push(`${path.relative(SRC, sheet)}: ${prelude.trim()}`);
        }
      }
    }
    expect(
      offenders,
      `A bare 'main' at selector position used to style all thirty content ` +
        `columns and now reaches only SiteChrome's wrapper, so these rules ` +
        `silently changed meaning with the sweep. Key them to the class the ` +
        `column actually carries ('.shell', '.paper-route', '.studio-main', ` +
        `'.vault-explorer-shell') instead.`,
    ).toEqual([]);
  });

  it("is honest about what counts as selector position", () => {
    // Negative controls for the two ways this check could quietly rot: missing
    // a real element selector, or firing on a declaration value.
    const caught = (css: string) =>
      selectorPreludes(css).some((p) => MAIN_AT_SELECTOR_POSITION.test(p));

    for (const css of [
      "main { color: red }",
      ":is(main, article) { color: red }",
      ":where(main) { color: red }",
      "div:not(main) { color: red }",
      "body > main { color: red }",
      ".x, main { color: red }",
      "header + main { color: red }",
      "@media (min-width: 40rem) { main { color: red } }",
    ]) {
      expect(caught(css), `should flag element selector: ${css}`).toBe(true);
    }

    for (const css of [
      ".studio-main { color: red }",
      "#main-content { color: red }",
      ".main-thing { color: red }",
      ".x { grid-area: main; }",
      ".x { grid-template-areas: 'main side'; }",
      "/* main is the landmark */ .x { color: red }",
      ".x::after { content: 'main'; }",
    ]) {
      expect(caught(css), `should NOT flag: ${css}`).toBe(false);
    }
  });

  it("cannot be blinded by a comment opener inside a CSS string", () => {
    // `content: "/*"` used to open a phantom comment that ran to the next
    // `*/`, hiding every rule in between — including a real element selector.
    const caught = (css: string) =>
      selectorPreludes(css).some((p) => MAIN_AT_SELECTOR_POSITION.test(p));

    expect(
      caught('.a::before { content: "/*"; }\nmain { color: red }\n/* end */'),
      "a real 'main' rule after a string containing /* must still be flagged",
    ).toBe(true);
    // And the mirror case: an apostrophe inside a comment must not make the
    // rest of the sheet read as a string.
    expect(
      caught("/* don't be clever */\nmain { color: red }"),
      "a real 'main' rule after an apostrophe in a comment must still be flagged",
    ).toBe(true);
  });
});

describe("the scan can actually see the code it scans", () => {
  // These guard `withoutComments()` itself. A stripper that over-deletes turns the
  // whole suite green regardless of what the app renders, and that failure is
  // invisible from the outside — the offender list just stays empty.
  const flagged = (source: string) => /<main\b/.test(withoutComments(source));

  it("sees a <main> that follows a string containing /*", () => {
    // The exact shape in `src/app/ingest/page.tsx`: `accept="image/*"` ahead of
    // a later `{/* … */}`. A block-comment-first regex stripper deletes
    // everything between the two and reports no offender.
    const source = [
      '<input accept="image/*" />',
      '<main className="sneaky">reintroduced</main>',
      "{/* PDF */}",
    ].join("\n");
    expect(flagged(source)).toBe(true);
  });

  it("ignores a <main> inside a block comment", () => {
    expect(flagged("/* a <main> in prose */\nconst x = 1;")).toBe(false);
  });

  it("ignores a <main> inside a whole-line // comment", () => {
    expect(flagged("// a <main> in prose\nconst x = 1;")).toBe(false);
  });

  it("ignores a <main> inside a trailing // comment", () => {
    // The previous rule anchored `//` to the start of a line, so this one read
    // as code and would have been a false positive.
    expect(flagged("const x = 1; // see the <main> in SiteChrome")).toBe(false);
  });

  it("ignores a <main> inside a JSX {/* … */} comment", () => {
    expect(flagged("<div>{/* jsx <main> */}</div>")).toBe(false);
  });

  it("still sees a <main> after an apostrophe in JSX text", () => {
    // An unterminated quote must not swallow the rest of the file.
    expect(flagged("<p>don't</p>\n<main>x</main>")).toBe(true);
  });

  it("sees a <main> written inside a string literal", () => {
    // Strings are parsed (so `image/*` cannot open a comment) but NOT blanked:
    // markup in a string is a real landmark the moment it reaches
    // `dangerouslySetInnerHTML`, so excusing it would be a hole, not a nicety.
    expect(flagged('const html = "<main>hi</main>";')).toBe(true);
  });

  it("still sees a <main> after a bare URL in JSX text", () => {
    // `https://…` written as page copy is not a string literal, so the `//`
    // used to read as a line comment and blank everything after it.
    expect(flagged("<p>see https://x.dev</p> <main>x</main>")).toBe(true);
  });

  it("still sees a <main> after a regex literal ending in an escaped slash", () => {
    // In `/https:\/\//` the trailing `\/` + `/` also read as a line comment.
    expect(flagged("const re = /https:\\/\\//; <main>x</main>")).toBe(true);
  });

  it("preserves line count so offender reports stay locatable", () => {
    const source = "/* a\nmulti\nline */\nconst x = 1;";
    expect(withoutComments(source).split("\n")).toHaveLength(source.split("\n").length);
  });
});
