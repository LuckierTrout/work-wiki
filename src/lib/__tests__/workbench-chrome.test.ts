/**
 * Story 1.3 — the shell's structural invariants, pinned by source scan.
 *
 * Vitest runs `environment: "node"` and only `src/**\/__tests__/**\/*.test.ts`:
 * there is no jsdom and no testing-library, and adding them is out of scope
 * here. So this follows the `single-ia.test.ts` / `create-wiki-ui.test.ts`
 * convention and reads the components as text. What it really pins is that
 * nobody turns mode switching into routing, drops the rail's accessible names,
 * inlines empty-state copy next to the shared module, leaks the Preview serif
 * into chrome, or reintroduces a device branch under the responsive rules.
 */
import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { APP_NAME } from "../brand";

const SRC = path.resolve(__dirname, "../..");
const WORKBENCH = path.join(SRC, "components/workbench");

function read(file: string): Promise<string> {
  return readFile(path.join(WORKBENCH, file), "utf8");
}

function globals(): Promise<string> {
  return readFile(path.join(SRC, "app/globals.css"), "utf8");
}

/**
 * The declarations of a top-level rule, keyed by property. Only single-line
 * `prop: value;` declarations are collected, which is every declaration in the
 * blocks this file compares.
 */
function declarations(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThan(-1);
  const block = css.slice(start, start + css.slice(start).indexOf("\n}"));
  const found = new Map<string, string>();
  for (const line of block.split("\n")) {
    const match = /^\s{2}(--[\w-]+):\s*(.+);\s*$/.exec(line);
    if (match) found.set(match[1], match[2]);
  }
  return found;
}

/**
 * Splits the appended Workbench CSS into the `.wb-shell { … }` declaration
 * block (where the tokens live) and everything after it (the chrome rules), so
 * "the shell redeclares `--ink`" and "no chrome rule uses `var(--ink)`" can be
 * asserted separately rather than contradicting each other.
 */
function shellBlocks(css: string): { tokens: string; rules: string } {
  const start = css.indexOf(".wb-shell {");
  expect(start).toBeGreaterThan(-1);
  const shell = css.slice(start);
  const end = shell.indexOf("\n}");
  expect(end).toBeGreaterThan(-1);
  return { tokens: shell.slice(0, end), rules: shell.slice(end) };
}

describe("IconRail", () => {
  it("is one labelled nav whose active mode is marked, not merely coloured", async () => {
    const source = await read("IconRail.tsx");
    expect(source).toContain('aria-label="Modes"');
    expect(source).toContain("<nav");
    expect(source).toContain("aria-current");
    // The rail renders the shared order, rather than restating a list here.
    expect(source).toContain("WORKBENCH_MODES.map");
  });

  it("hides count badges at zero and names them with count + noun", async () => {
    const source = await read("IconRail.tsx");
    expect(source).toContain("count > 0");
    expect(source).toContain("badgeAccessibleName");
    expect(source).toContain("BADGE_MODE_NOUNS");
  });

  it("gives the sidecar dot all three states, and only goes live on an answer", async () => {
    const source = await read("IconRail.tsx");
    expect(source).toContain('"Sidecar running"');
    expect(source).toContain('"Sidecar not running"');
    // "unknown" is neither: before the first probe answers — and in a tab that
    // starts hidden, indefinitely — the dot must not accuse a live sidecar of
    // being dead.
    expect(source).toContain('"Checking sidecar"');
    expect(source).toContain('sidecar === "up"');
    expect(source).toContain('sidecar === "down"');
    expect(source).toContain("wb-status--live");
  });

  it("puts the status label in the live region as content, not as an attribute", async () => {
    // `role="status"` announces content mutations. An empty span whose only
    // text is `aria-label` announces nothing when the sidecar comes up.
    const source = await read("IconRail.tsx");
    expect(source).toMatch(/<span className="wb-sr-only">\{sidecarLabel\}<\/span>/);
    expect(source).not.toMatch(/role="status"[\s\S]{0,200}aria-label=\{sidecarLabel\}/);
  });

  it("opens Settings as a surface on this shell, not as a route", async () => {
    // Story 1.9 brought Settings inside the shell. A link here would be the
    // route change `epics.md:367` forbids for a surface switch — it unmounts
    // everything above the canvas, typed Chat input included — so the control is
    // a button with its own active state, and the accessible name is unchanged.
    const source = await read("IconRail.tsx");
    expect(source).not.toContain('href="/settings"');
    // It TOGGLES: the control marks itself current while Settings is showing,
    // so a press that only ever opened would read as a switch that cannot be
    // switched off.
    expect(source).toContain("onClick={onToggleSettings}");
    expect(source).toContain('aria-label="Settings"');
    expect(source).toContain('aria-current={settingsActive ? "page" : undefined}');
    // Exactly one rail control is ever current: a mode's own active state is
    // suppressed while Settings is showing.
    expect(source).toContain("const active = !settingsActive && item.id === mode;");
  });

  it("labels the collapse control for both directions", async () => {
    const source = await read("IconRail.tsx");
    expect(source).toContain("Collapse left column");
    expect(source).toContain("Expand left column");
    expect(source).toContain("aria-expanded");
    // `aria-expanded` without `aria-controls` is a state with no subject.
    expect(source).toContain("aria-controls={leftColumnId}");
  });

  it("keys the badge map by mode id, not by string", async () => {
    // `Record<string, …>` would let a mistyped mode key compile and resolve to
    // a count of 0 — indistinguishable at runtime from "this mode has no badge".
    const source = await read("IconRail.tsx");
    expect(source).toContain("Partial<Record<WorkbenchModeId,");
    expect(source).not.toMatch(/COUNTS: Record<string,/);
  });
});

describe("Workbench shell", () => {
  it("switches modes with state and the History API, never with a route change", async () => {
    // `epics.md:367`: a mode switch must not destroy typed Chat input. Routing
    // per mode unmounts everything above the mode panel and makes that
    // impossible, so it is forbidden rather than merely unnecessary.
    const source = await read("Workbench.tsx");
    // Call sites, not the prose that explains the ban.
    expect(source).not.toContain("router.push(");
    expect(source).not.toMatch(/from "next\/link"/);
    expect(source).not.toMatch(/\buseRouter\(/);
    expect(source).toContain("setModeState");
    // DW-27 NARROWS the ban rather than lifting it: the mode is mirrored into
    // `?mode=` with the native History API, which Next 15 patches into its
    // router — the URL moves with no server round trip and no unmount. So the
    // rule is "no routing", not "no URL".
    expect(source).toContain("window.history.pushState(");
    expect(source).toContain("window.history.replaceState(");
    expect(source).toContain('window.addEventListener("popstate", onPopState)');
    // The other half of the ban. `useSearchParams()` would read the same value
    // at the cost of a Suspense boundary and dynamic rendering on `page.tsx`,
    // and it is a `next/navigation` hook in a shell that must own no routing.
    expect(source).not.toMatch(/\buseSearchParams\(/);
    expect(source).not.toMatch(/from "next\/navigation"/);
  });

  it("announces the surface name politely on change, but not on restore", async () => {
    // Restoring a stored mode on load is not a change the owner made; putting
    // `mode` straight into the live region reports a switch that never
    // happened, on every page load.
    const source = await read("Workbench.tsx");
    expect(source).toContain('aria-live="polite"');
    expect(source).toMatch(/aria-live="polite"[\s\S]{0,120}\{announcement\}/);
    expect(source).toContain('useState("")');
    // Through the shell's one `announce` (DW-182), never `setAnnouncement`
    // directly: a region announces on CHANGE, so writing the label already in
    // there is indistinguishable from not writing at all, and re-picking a
    // surface whose label matches reported nothing.
    expect(source).toContain("announce(workbenchMode(next).label)");
    expect(source).toContain("nextAnnouncement(current, sentence)");
    expect(source.match(/setAnnouncement\(/g) ?? []).toHaveLength(1);
  });

  it("does not chase focus onto a hidden trigger", async () => {
    // Widening past 900px hides the trigger (`display: none`); focusing it
    // there is a no-op that drops the keyboard user on <body>.
    const source = await read("Workbench.tsx");
    expect(source).toContain("setSheetClosed(false)");
    expect(source).toContain("trigger?.offsetParent");
  });

  it("tells assistive tech what the sheet trigger expands", async () => {
    const source = await read("Workbench.tsx");
    expect(source).toContain("aria-controls={RAIL_ID}");
    expect(source).toContain("id={RAIL_ID}");
    const rail = await read("IconRail.tsx");
    expect(rail).toMatch(/<nav className="wb-rail" id=\{id\}/);
  });

  it("puts the product title in the page's single h1", async () => {
    const source = await read("Workbench.tsx");
    expect(source).toMatch(/<h1 className="wb-title">\{APP_NAME\}<\/h1>/);
    // Rendered copy says work-wiki; the literal lives in one place (AD-7).
    expect(APP_NAME).toBe("work-wiki");
    // Nothing below the shell may add a second one: the surface title is the
    // canvas's own heading, and Story 1.2's surface is pinned at <h2> by
    // create-wiki-ui.test.ts.
    const canvas = await read("ModeCanvas.tsx");
    expect(canvas).not.toContain("<h1");
    expect(canvas).toContain("<h2 id={headingId}");
  });

  it("keeps an h1 in the tree while the column is collapsed", async () => {
    // Collapsing is `display: none` on the column that holds the h1, which
    // removes it from the accessibility tree along with the pixels. The clipped
    // restatement covers exactly that state, and the CSS keeps the two mutually
    // exclusive — including below 900px, where the column is force-shown.
    const source = await read("Workbench.tsx");
    expect(source).toContain('<h1 className="wb-sr-only wb-title-fallback">');
    const css = await globals();
    expect(css).toMatch(
      /\.wb-shell\[data-collapsed="true"\] \.wb-title-fallback \{\s*display: block;/,
    );
    const narrow = css.slice(css.indexOf("@media (max-width: 899px)"));
    expect(narrow).toMatch(
      /\.wb-shell\[data-collapsed="true"\] \.wb-title-fallback \{\s*display: none;/,
    );
  });

  it("persists mode and collapse through the guarded accessor", async () => {
    // Call sites, not identifiers: bare names are satisfied by the import line
    // alone, so the restore could be unwired — or inverted — below it without
    // moving an assertion.
    const source = await read("Workbench.tsx");
    expect(source).toContain("@/lib/workbench-state");
    // The mode restore is URL-FIRST since DW-27, and the precedence itself is a
    // pure function the node suite executes (`workbench-url.test.ts`) rather
    // than a `??` typed here — this pins that the shell actually calls it, with
    // the stored mode as the fallback and not the other way round.
    expect(source).toContain("initialMode(window.location.search, readStoredMode())");
    expect(source).toContain("setCollapsed(readStoredCollapsed())");
    expect(source).toContain("writeStoredMode(next)");
    expect(source).toContain("writeStoredCollapsed(next)");
  });

  it("holds keyboard focus inside the open sheet", async () => {
    // The sheet's backdrop makes the canvas unclickable, so Tab walking out of
    // the rail strands a keyboard user on controls they cannot see or operate.
    const source = await read("Workbench.tsx");
    expect(source).toContain('event.key !== "Tab"');
    expect(source).toContain("event.preventDefault()");
    expect(source).toContain("rail.contains(active)");
  });

  it("wraps focus on the visible controls, not on the hidden chevron", async () => {
    // The chevron is the rail's last child and `display: none` below 900px —
    // the only width where the sheet exists. Unfiltered, it becomes the wrap
    // point: Shift+Tab focuses a hidden element (a no-op) and dead-ends, while
    // forward Tab off the Settings link never matches `last`, is not prevented,
    // and walks out of the rail onto the backdropped canvas. All three
    // assertions in the test above stay true throughout, which is why this one
    // pins the filter itself.
    const source = await read("Workbench.tsx");
    expect(source).toMatch(/\.filter\(\(item\) => item\.getClientRects\(\)\.length > 0\)/);
    const css = await globals();
    const narrow = css.slice(css.indexOf("@media (max-width: 899px)"));
    expect(narrow).toMatch(/\.wb-rail-chevron \{\s*display: none;/);
  });

  it("keeps state updaters free of side effects", async () => {
    // Writing the focus-restore flag inside `setSheetOpen`'s updater makes the
    // updater impure; "was it open?" is read from a ref instead.
    const source = await read("Workbench.tsx");
    expect(source).toContain("sheetOpenRef.current && restoreFocus");
    expect(source).not.toMatch(/setSheetOpen\(\(open\) => \{[\s\S]{0,200}restoreFocusRef/);
    // Same rule for the collapse toggle: React runs updaters twice under
    // StrictMode, so the localStorage write belongs outside it.
    expect(source).not.toMatch(/setCollapsed\(\([\w]+\) => \{[\s\S]{0,200}writeStoredCollapsed/);
    expect(source).toMatch(/setCollapsed\(next\);\s*\n\s*writeStoredCollapsed\(next\);/);
  });

  it("closes the sheet on Esc from the bubble phase, not capture", async () => {
    // `useDialogA11y` takes Esc on capture and stops propagation so exactly one
    // overlay closes. The sheet is navigation, not a modal: a capture-phase
    // listener here would close it out from under an open ConfirmDialog.
    const source = await read("Workbench.tsx");
    expect(source).toContain('document.addEventListener("keydown", onKey)');
    expect(source).not.toMatch(/addEventListener\("keydown", onKey, true\)/);
    expect(source).not.toContain("hooks/useDialogA11y");
    expect(source).not.toMatch(/\buseDialogA11y\(/);
    // The sheet must not own body overflow — the dialog hook already does.
    expect(source).not.toContain("document.body.style.overflow");
  });

  it("dismisses the sheet by backdrop, by mode choice, and on widening", async () => {
    const source = await read("Workbench.tsx");
    expect(source).toContain("wb-backdrop");
    expect(source).toContain("closeSheet");
    expect(source).toContain("matchMedia(");
    // The subject is that the shell OBSERVES the breakpoint, not where the
    // string is typed. DW-47 moved the query into `workbench-split` so the
    // stylesheet's blocks and every JavaScript reader of them share one number.
    expect(source).toContain("matchMedia(SPLIT_WIDE_QUERY)");
  });
});

describe("ModeCanvas", () => {
  it("sources every sentence from the shared module", async () => {
    const source = await read("ModeCanvas.tsx");
    expect(source).toContain("@/lib/workbench-modes");
    expect(source).toContain("CHAT_SIDECAR_DOWN_COPY");
    expect(source).toContain("CHAT_SIDECAR_UP_COPY");
    expect(source).toContain("GRAPH_NARROW_COPY");
    expect(source).toContain("surface.emptyState");
    // A sentence typed here is a second definition of copy the handoff fixes.
    expect(source).not.toContain("Press Enter to search.");
    expect(source).not.toContain("No pending cards.");
  });

  it("fails Chat closed rather than degrading it", async () => {
    const source = await read("ModeCanvas.tsx");
    expect(source).toContain('sidecar === "up" ? CHAT_SIDECAR_UP_COPY : CHAT_SIDECAR_DOWN_COPY');
  });
});

describe("shell chrome carries no serif", () => {
  it("never names Georgia or a serif stack under components/workbench", async () => {
    // Georgia is Story 1.5's Preview body face. In chrome it is the exact
    // "serif leak" the type lock forbids.
    //
    // `withFileTypes` because Stories 1.4-1.7 add subdirectories here and
    // `readFile` on one throws EISDIR. And `sans-serif` is stripped first: it
    // is the shell's own generic fallback, so a bare substring check would ban
    // the correct stack for the opposite of the reason this test exists.
    for (const entry of await readdir(WORKBENCH, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const source = (await read(entry.name)).replaceAll("sans-serif", "");
      expect(source).not.toContain("Georgia");
      expect(source).not.toContain("serif");
    }
  });
});

describe("globals.css", () => {
  it("locks the chrome to system sans at the handoff's density", async () => {
    // The serif scan above is only the negative half of the type lock. The
    // positive half — the exact stack, 13px/1.45, 600 for strong, 18px/1.3 for
    // surface titles — is the intent's most explicit visual constraint and was
    // asserted nowhere: every number could drift with the suite green.
    const { tokens } = shellBlocks(await globals());
    expect(tokens).toContain(
      '--wb-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;',
    );
    expect(tokens).toContain("--wb-font-size: 13px;");
    expect(tokens).toContain("--wb-line-height: 1.45;");
    expect(tokens).toContain("--wb-weight-strong: 600;");
    expect(tokens).toContain("--wb-title-size: 18px;");
    expect(tokens).toContain("--wb-title-line-height: 1.3;");
    // Declared is not applied: the shell has to paint through them.
    expect(tokens).toContain("font-family: var(--wb-font);");
    expect(tokens).toContain("font-size: var(--wb-font-size);");
    expect(tokens).toContain("line-height: var(--wb-line-height);");
  });

  it("marks the active mode with the wash, in both colour modes", async () => {
    // "Filled rounded square wash, never a hue change" (UX-DR3). The token
    // existing in the block is not the same as the active item painting with
    // it, and nothing linked the two.
    const { rules } = shellBlocks(await globals());
    expect(rules).toMatch(
      /\.wb-rail-item--active \{\s*background: var\(--wb-active-wash\);/,
    );
    // Forced-colours modes discard author backgrounds, which is the whole
    // indicator. Without a second channel every rail item looks identical and
    // the sighted user loses the active state entirely.
    const forced = rules.slice(rules.indexOf("@media (forced-colors: active)"));
    expect(forced).toContain("@media (forced-colors: active)");
    expect(forced).toMatch(/\.wb-rail-item--active \{\s*outline: 2px solid CanvasText;/);
  });

  it("defines a 48px rail and width-driven responsive rules", async () => {
    const css = await readFile(path.join(SRC, "app/globals.css"), "utf8");
    expect(css).toContain(".wb-rail");
    expect(css).toContain("--wb-rail: 48px");
    expect(css).toContain("@media (max-width: 1199px)");
    expect(css).toContain("@media (max-width: 899px)");
    // Story 1.1's ban: no device-specific stylesheet hook.
    expect(css).not.toContain("mobile-navigation");
  });

  it("hard-codes the chrome tokens so .dark cannot reach them", async () => {
    const { tokens, rules } = shellBlocks(await readFile(path.join(SRC, "app/globals.css"), "utf8"));
    for (const literal of ["#ffffff", "#fafafa", "#171717", "#737373", "#e5e5e5", "#16a34a"]) {
      expect(tokens).toContain(literal);
    }
    // The `.wb-*` chrome itself paints only through `--wb-*`, so no chrome rule
    // may resolve through a token `.dark` redefines.
    expect(rules).not.toContain("var(--ink)");
    expect(rules).not.toContain("var(--paper)");
    expect(rules).not.toContain("var(--accent)");
  });

  it("pins the Folio palette to light inside the shell", async () => {
    // The shell's SUBTREE is ordinary app markup: WikiWorkbench paints with
    // `text-foreground`, `border-foreground/15`, `.receipt` and `.btn`, which
    // all resolve through the Folio tokens. `.dark` on <html> flips `--ink` to
    // near-white — and ThemeToggle only mounts in NavHeader, which this route
    // no longer renders, so there would be no way back from white-on-white.
    const { tokens } = shellBlocks(await readFile(path.join(SRC, "app/globals.css"), "utf8"));
    expect(tokens).toContain("--ink: #18181b;");
    expect(tokens).toContain("--paper: #ffffff;");
    expect(tokens).toContain("--rule: #e4e4e7;");
    expect(tokens).toContain("--accent: #1e3a5f;");
    expect(tokens).toContain("--foreground: var(--ink);");
    expect(tokens).toContain("--background: var(--paper);");
    // Tailwind v4 belt-and-braces: if a utility references `--color-*` rather
    // than the inlined value, those resolve at `:root` — in dark scope.
    expect(tokens).toContain("--color-foreground: var(--ink);");
    // Without this the native <select> in the Wiki canvas renders dark.
    expect(tokens).toContain("color-scheme: light;");
  });

  it("keeps the pinned palette in step with :root rather than with itself", async () => {
    // The assertions above compare the shell to literals retyped here, which
    // cannot notice drift: change `:root --accent` and every route repaints
    // except this one, with the whole suite still green. So compare the blocks.
    // Every token `.dark` overrides is a token that can repaint the shell's
    // subtree, and each must be restated at its exact `:root` value.
    const css = await globals();
    const root = declarations(css, ":root");
    const dark = declarations(css, ".dark");
    const shell = declarations(css, ".wb-shell");
    expect(dark.size).toBeGreaterThan(0);
    for (const token of dark.keys()) {
      expect(root.has(token)).toBe(true);
      expect({ token, value: shell.get(token) }).toEqual({
        token,
        value: root.get(token),
      });
    }
  });

  it("styles only the outline on focus, and includes the canvas selects", async () => {
    // Restating `border-radius` reshapes the control on focus: rail items are
    // 6px, the count badge is a pill. And `select` is what the Wiki canvas
    // renders — omitting it leaves those two on the global 3px offset.
    const { rules } = shellBlocks(await globals());
    const focus = rules.slice(rules.indexOf(":focus-visible {"));
    expect(rules).toContain("input, select, textarea");
    expect(focus.slice(0, focus.indexOf("}"))).not.toContain("border-radius");
  });

  it("keeps a monospace face for paths and code inside the shell", async () => {
    // The `.wb-shell *` blanket is what keeps the Preview serif out of chrome,
    // but it also flattens `.receipt` (the seeded file list) to system sans.
    const { rules } = shellBlocks(await readFile(path.join(SRC, "app/globals.css"), "utf8"));
    expect(rules).toContain(".receipt");
    expect(rules).toContain("var(--wb-font-mono)");
    // The serif lock still holds: sans and mono only.
    expect(rules).not.toContain("Georgia");
  });

  it("keeps the shell off the 1180px centred container", async () => {
    const css = await readFile(path.join(SRC, "app/globals.css"), "utf8");
    const shell = css.slice(css.indexOf(".wb-shell {"));
    expect(shell).toContain("100dvh");
    expect(shell).not.toContain("var(--maxw)");
  });

  it("keeps the left column present at the narrow breakpoint", async () => {
    // Collapse is persisted, so collapsing on desktop then loading narrow would
    // otherwise arrive with no left column — and no <h1> — at all.
    const css = await readFile(path.join(SRC, "app/globals.css"), "utf8");
    const narrow = css.slice(css.indexOf("@media (max-width: 899px)"));
    expect(narrow).toMatch(
      /\.wb-shell\[data-collapsed="true"\] \.wb-left \{\s*display: flex;/,
    );
  });

  it("takes the closed sheet out of the tab order, not just off screen", async () => {
    // `transform` alone leaves all twelve rail controls focusable, so a
    // keyboard user tabs an invisible rail before reaching the canvas.
    const css = await readFile(path.join(SRC, "app/globals.css"), "utf8");
    const narrow = css.slice(css.indexOf("@media (max-width: 899px)"));
    expect(narrow).toContain("visibility: hidden;");
    expect(narrow).toContain("visibility: visible;");
    expect(narrow).toContain("visibility 0.18s ease");
  });

  it("withdraws the collapse chevron where there is no split to collapse", async () => {
    // Below 900px the column is force-shown, so the chevron would report a
    // state the layout contradicts — and persist it back to the desktop.
    const narrow = (await globals()).slice(
      (await globals()).indexOf("@media (max-width: 899px)"),
    );
    expect(narrow).toMatch(/\.wb-rail-chevron \{\s*display: none;/);
  });

  it("does not let the body outgrow the shell it contains", async () => {
    // layout.tsx's body is `min-h-screen` (100vh, the LARGE viewport height)
    // while the shell is 100dvh. On mobile 100vh is the taller of the two, so
    // the page gains an outer scrollbar on a surface built not to scroll.
    const css = await globals();
    expect(css).toMatch(/body:has\(\.wb-shell\) \{\s*min-height: 100dvh;/);
  });
});

describe("the shell owns the viewport at /", () => {
  it("SiteChrome treats / as bare", async () => {
    const source = await readFile(path.join(SRC, "components/SiteChrome.tsx"), "utf8");
    expect(source).toContain('pathname === "/"');
    expect(source).toContain('pathname?.startsWith("/sign-in")');
  });

  it("keeps a skip link on the bare branch too", async () => {
    // `/` now puts twelve rail controls ahead of the canvas, so the bypass
    // matters more here than on a route with the site nav (WCAG 2.4.1).
    const source = await readFile(path.join(SRC, "components/SiteChrome.tsx"), "utf8");
    expect(source.match(/className="skip-nav"/g) ?? []).toHaveLength(2);
    expect(source.match(/Skip to main content/g) ?? []).toHaveLength(2);
  });

  it("points the bypass past the rail, not at the <main> that holds it", async () => {
    // On `/` the shell is INSIDE <main>, rail first: `#main-content` lands
    // ahead of every rail control and skips nothing at all. The target has to
    // be the canvas, and the canvas has to be focusable to receive it.
    const source = await readFile(path.join(SRC, "components/SiteChrome.tsx"), "utf8");
    expect(source).toContain('workbench ? "#wb-canvas" : "#main-content"');
    expect(source).toContain("href={skipTarget}");
    const canvas = await read("ModeCanvas.tsx");
    expect(canvas).toContain('export const CANVAS_ID = "wb-canvas"');
    // EXACTLY ONE of each. The canvas used to return one `<section>` per branch
    // — two spellings of the same id, only ever one of them mounted. Keeping
    // the Wiki subtree mounted in every mode (DW-26) puts both branches inside
    // one section, and one is what an id has to be: a second `#wb-canvas` would
    // give the skip link two targets and leave the browser to pick.
    //
    // The patterns allow the attribute VALUE to be conditional, because it now
    // is: Settings mounts its own canvas beside this one (DW-373) and this
    // section goes behind `hidden` carrying neither the id nor the tab index,
    // so the two are never in the document at once. What still has to be one is
    // the number of PLACES either is spelled — a second `id={…CANVAS_ID}` here
    // is the duplicate this counts against.
    expect(canvas.match(/id=\{[^{}]*CANVAS_ID\}/g) ?? []).toHaveLength(1);
    expect(canvas.match(/tabIndex=\{[^{}]*-1\}/g) ?? []).toHaveLength(1);
    // …and the withdrawal is conditioned on the prop the shell passes, not on
    // anything this file decides for itself.
    //
    // Matched with the whitespace open, not as exact literals: the counts above
    // are the invariant, and these three say WHAT the one occurrence of each
    // spells. A formatter wrapping the ternary across lines changes neither,
    // and the sibling scan in `workbench-settings.test.ts` gave up exact
    // literals for the same reason in the same change.
    expect(canvas).toMatch(/hidden=\{\s*hidden\s*\}/);
    expect(canvas).toMatch(/id=\{\s*hidden\s*\?\s*undefined\s*:\s*CANVAS_ID\s*\}/);
    expect(canvas).toMatch(/tabIndex=\{\s*hidden\s*\?\s*undefined\s*:\s*-1\s*\}/);
  });

  it("the landing page mounts the Workbench and no metrics dashboard", async () => {
    const source = await readFile(path.join(SRC, "app/page.tsx"), "utf8");
    expect(source).toContain("<Workbench>");
    expect(source).toContain("<WikiWorkbench");
    // DESIGN.md: no metric dashboard as home. A metrics block below a
    // full-height shell also contradicts "one shell".
    expect(source).not.toContain("HomeDashboard");
    expect(source).not.toContain("buildHomeDashboardSnapshot");
    // The auth gate and the registry's `unavailable` discrimination survive.
    expect(source).toContain('redirect("/sign-in")');
    expect(source).toContain("unavailable: true");
  });

  it("puts the Wiki surface inside the canvas rather than a centred container", async () => {
    const source = await readFile(path.join(SRC, "components/WikiWorkbench.tsx"), "utf8");
    expect(source).toContain('className="wb-canvas-pad"');
    expect(source).not.toContain('className="shell py-8"');
  });
});
