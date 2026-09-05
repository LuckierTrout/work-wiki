/**
 * Story 1.3 — the shell's structural invariants, pinned by source scan.
 *
 * This file is collected by vitest's `node` project — `environment: "node"`,
 * `src/**\/__tests__/**\/*.test.ts` — which mounts nothing and loads no
 * testing-library. Mounted coverage is the sibling `*.test.tsx` half, collected
 * by the `dom` project. So this follows the `single-ia.test.ts` /
 * `create-wiki-ui.test.ts` convention and reads the components as text. What it
 * really pins is that
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

/**
 * A component with its prose removed, for the scans that BAN a token.
 *
 * A docblock that names the mistake it is arguing against — `localStorage`, the
 * inverted overflow test — would fail a bare `not.toContain` on its own, which
 * would ban the explanation rather than the code.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
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
 * One top-level rule's block, for the pins that read ordinary declarations
 * rather than the `--wb-*` tokens {@link declarations} collects.
 *
 * The FIRST occurrence, which is the unnested one: the responsive blocks
 * further down re-open several of these selectors indented inside a media
 * query, and a pin that read one of those would assert about the wrong layout.
 */
function ruleBlock(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThan(-1);
  const rest = css.slice(start);
  const end = rest.indexOf("\n}");
  expect(end).toBeGreaterThan(-1);
  return rest.slice(0, end);
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
    // …and the traversal's focus bump is NARROWED by a sample taken BEFORE the
    // surface is applied (DW-513): it fires only when the keyboard was really in
    // the canvas about to be swapped, so Back pressed on a rail button leaves
    // that button focused.
    //
    // The ORDER is the pin, not merely the presence of the call. Moved below
    // `applySurface` — or into the `canvasFocusNonce` effect, whose own comment
    // bans it reading `activeElement` — the sample would answer about the canvas
    // that has ALREADY been swapped, and every mounted case in this repo still
    // passes: jsdom does not blur through an ancestor `hidden`, so the withdrawn
    // section still `contains` the stale `activeElement` and the wrong reading
    // agrees with the right one on exactly the cases the suites cover. Only a
    // positional scan can tell the two apart.
    const shellCode = stripComments(source);
    const sampledAt = shellCode.indexOf(
      "document.getElementById(CANVAS_ID)?.contains(document.activeElement)",
    );
    const appliedAt = shellCode.indexOf("applySurface(next, settings, category);");
    expect(sampledAt).toBeGreaterThan(-1);
    expect(appliedAt).toBeGreaterThan(-1);
    expect(sampledAt).toBeLessThan(appliedAt);
    // And the bump really is gated on the sample rather than on the flag alone.
    expect(shellCode).not.toContain("if (movedSettings) bumpCanvasFocus();");
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
    // The fail-closed Chat sentence is now CHOSEN by the page's own origin
    // (DW-607), so the component imports the selector rather than a constant.
    // The claim the pin was always making — no sentence is typed here — is
    // still what is checked, one line down.
    expect(source).toContain("chatSidecarDownCopy");
    // NEITHER sentence may be spelled here. Banning only the old one would let
    // the new one be inlined with every pin still green, which is the same
    // second definition the rule exists to stop — the env name is the
    // distinctive substring, and it carries no curly apostrophe to mistype.
    expect(source).not.toContain("Start the local sidecar");
    expect(source).not.toContain("WORKWIKI_SIDECAR_ALLOWED_ORIGINS");
    expect(source).toContain("surface.emptyState");
    const graph = await read("GraphCanvas.tsx");
    expect(graph).toContain("GRAPH_NARROW_COPY");
    // A sentence typed here is a second definition of copy the handoff fixes.
    expect(source).not.toContain("Press Enter to search.");
    expect(source).not.toContain("No pending cards.");
  });

  it("fails Chat closed rather than degrading it", async () => {
    const source = await read("ModeCanvas.tsx");
    expect(source).toContain("chatSidecarDownCopy");
    expect(source).not.toContain("Start the local sidecar");
    expect(source).not.toContain("WORKWIKI_SIDECAR_ALLOWED_ORIGINS");
    // The selector is only honest if it is fed the REAL page origin (DW-607).
    // A hardcoded string or an omitted argument still renders the unreachable
    // sentence under `sidecar-down-copy.test.tsx`'s deployed-origin mount — that
    // suite fixes the document URL, so it cannot tell a wired component from a
    // constant — while handing every LOOPBACK page the wrong sentence, which no
    // other test in the repo mounts. This line is where that regression lands.
    expect(source).toContain("window.location.origin");
    expect(source).toContain("<ChatCanvas");
    expect(source).toContain('sidecar === "up"');
    expect(source).toContain("<ChatCanvas");
    expect(source).not.toContain("ChatWorkspace");
  });

  it("mounts TodosCanvas instead of the generic stub", async () => {
    const source = await read("ModeCanvas.tsx");
    expect(source).toContain("<TodosCanvas");
    expect(source).toContain('mode !== "todos"');
  });

  it("mounts Graph, Lint, and Review canvases instead of the generic stub", async () => {
    const source = await read("ModeCanvas.tsx");
    expect(source).toContain("<GraphCanvas");
    expect(source).toContain("<LintCanvas");
    expect(source).toContain("<ReviewCanvas");
    expect(source).toContain("<ResearchCanvas");
    expect(source).toContain('mode !== "graph"');
    expect(source).toContain('mode !== "lint"');
    expect(source).toContain('mode !== "review"');
  });

  it("restores the offset on the element that is really scrolling (DW-523)", async () => {
    // Below the stacking breakpoint with a Preview docked, `globals.css`
    // releases `.wb-shell`'s clamp and the DOCUMENT scrolls — so a restore that
    // only ever reads `.wb-canvas` reads 0, writes 0, and hands the owner the
    // top of the page at that width with every other assertion here green.
    const source = await read("ModeCanvas.tsx");
    // The branch has a NAME, so the mounted case can be about the behaviour and
    // this can be about the wiring.
    expect(source).toContain("function canvasScroller(canvas: HTMLElement): HTMLElement {");
    expect(source).toContain("const scroller = canvasScroller(canvas);");
    // The DOCUMENT is asked whether it overflows, and the canvas is the default:
    // asking the canvas inverts the failure, because a not-yet-laid-out canvas
    // (and every canvas in jsdom) reports `scrollHeight === clientHeight === 0`
    // and would hand the document every restore it should not have.
    expect(source).toContain("root.scrollHeight > root.clientHeight ? root : canvas");
    expect(stripComments(source)).not.toContain(
      "canvas.scrollHeight > canvas.clientHeight",
    );
    expect(source).toContain(
      "document.scrollingElement as HTMLElement | null) ?? document.documentElement",
    );
    // Read, written and listened to through the ONE chosen element…
    expect(source).toContain("scroller.scrollTop = stored;");
    expect(source).toContain("const landed = scroller.scrollTop;");
    expect(source).not.toContain("canvas.scrollTop = canvasScrollRef.current;");
    // …with the listener on the DOCUMENT when that element is not the canvas: a
    // viewport scroll is dispatched at `Document` and does not bubble up from
    // `documentElement`, so a listener on the root element never fires.
    expect(source).toContain(
      "const target: EventTarget = scroller === canvas ? canvas : document;",
    );
    expect(source).toContain('target.addEventListener("scroll", onScroll, { passive: true })');
    expect(source).toContain('target.removeEventListener("scroll", onScroll)');
    // Not window as well, and not both surfaces at once. Every BAN below runs
    // against the STRIPPED copy: a docblock that names the mistake it argues
    // against would otherwise fail these, which bans the explanation rather
    // than the code.
    const code = stripComments(source);
    expect(code).not.toContain('window.addEventListener("scroll"');
    // The width itself stays in the stylesheet, which owns the condition. A
    // word boundary rather than a bare substring, which would also reject
    // `9000`, `1900` and `900ms`.
    expect(code).not.toMatch(/\b900\b/);
    expect(code).not.toContain("max-width");
    expect(code).not.toContain("matchMedia");
    // And the docblock no longer states the wrong premise unconditionally.
    expect(source).not.toContain(
      "`.wb-canvas` is the mode canvas's SCROLL CONTAINER",
    );
    // The keyboard must not undo the restore either. Closing Settings bumps
    // `canvasFocusNonce`, and that PASSIVE effect focuses `#wb-canvas` — after
    // every layout effect, so after the restore has already run. On the
    // document branch a plain `focus()` scrolls the section into view and puts
    // the page back at the top one frame later. jsdom's `focus()` does not
    // scroll, so no mounted case in this repo can see it.
    const shell = await read("Workbench.tsx");
    expect(shell).toContain(
      "document.getElementById(CANVAS_ID)?.focus({ preventScroll: true });",
    );
    expect(stripComments(shell)).not.toMatch(
      /getElementById\(CANVAS_ID\)\?\.focus\(\)/,
    );
  });

  it("keeps the canvas offset in a ref and puts it back before paint (DW-521, DW-524)", async () => {
    const source = await read("ModeCanvas.tsx");
    const code = stripComments(source);
    // Before the paint, so an un-withdrawn canvas never shows its top first and
    // then jumps. Neither kind of effect runs during a server render, so this
    // costs the SSR output nothing.
    expect(code).toContain("useLayoutEffect(() => {");
    expect(code.match(/useLayoutEffect\(/g) ?? []).toHaveLength(1);
    // NEVER RECORDED is not the same as ZERO. On the document branch the
    // scroller is the PAGE, so a first mount that wrote a 0 into it would
    // destroy the browser's own scroll restoration or a `#hash` landing — for a
    // surface that has not gone off screen even once and has nothing to restore.
    expect(code).toContain("const canvasScrollRef = useRef<number | null>(null);");
    expect(code).not.toContain("const canvasScrollRef = useRef(0);");
    expect(code).toMatch(
      /const stored = canvasScrollRef\.current;\s*if \(stored !== null\) \{\s*scroller\.scrollTop = stored;/,
    );
    // The restore's own echo, armed with what the browser LANDED on and spent
    // by the first scroll event whatever it says — a boolean latch could never
    // be spent by a restore that changed nothing, and would swallow the owner's
    // next genuine scroll.
    expect(code).toContain("const restoreEchoRef = useRef<number | null>(null);");
    expect(code).toContain("restoreEchoRef.current = scroller.scrollTop;");
    expect(code).toContain("if (echo !== null && landed === echo) return;");
    // …and it is cleared at the TOP of the effect, before the `hidden` guard
    // can return past it: an arm that outlived its effect instance would be
    // spent by the owner's next genuine scroll instead of by a restore.
    const body = code.slice(code.indexOf("useLayoutEffect(() => {"));
    expect(body).toContain("restoreEchoRef.current = null;");
    expect(body.indexOf("restoreEchoRef.current = null;")).toBeLessThan(
      body.indexOf("if (!canvas || hidden) return;"),
    );
    // Still a REF, and still not keyed per mode: no storage key is invented for
    // a value that never crosses a reload.
    expect(code).not.toContain("localStorage");
    // Keyed on the withdrawal AND on the two conditions under which the
    // stylesheet moves the scroll off `.wb-canvas` with `hidden` unmoved
    // (DW-719). Both are handed down by the shell — this file's `matchMedia`,
    // `900` and `max-width` bans above still hold inside the component.
    expect(source).toContain("}, [hidden, previewOpen, narrow]);");
  });

  it("re-probes the scroller on every run and drops an offset from another surface (DW-719)", async () => {
    const source = await read("ModeCanvas.tsx");
    const code = stripComments(source);
    // The probe runs INSIDE the effect, so a re-run under the new keys asks the
    // layout again rather than reusing the element the first run happened to
    // find.
    expect(code).toContain("const scroller = canvasScroller(canvas);");
    // …and the offset is DROPPED when the answer changed. Re-applying a canvas
    // offset to the page — or a page offset to the canvas — is not a restore.
    expect(code).toContain("const scrollerRef = useRef<HTMLElement | null>(null);");
    expect(code).toMatch(
      /if \(scrollerRef\.current !== scroller\) \{\s*scrollerRef\.current = scroller;\s*canvasScrollRef\.current = null;\s*\}/,
    );
    // The drop happens BEFORE the restore reads the ref, or it would spend the
    // wrong offset on the new surface and only then notice.
    expect(code.indexOf("canvasScrollRef.current = null;")).toBeLessThan(
      code.indexOf("const stored = canvasScrollRef.current;"),
    );
    // The two new props are re-run triggers and nothing else: neither is read
    // anywhere but the dependency array.
    for (const prop of ["previewOpen", "narrow"]) {
      expect(code.match(new RegExp(`\\b${prop}\\b`, "g")) ?? []).toHaveLength(3);
    }
    // The third clamp-flipping condition stays out of here. `data-sheet-open`
    // brings the clamp BACK, and threading it would make this component a
    // second reader of a layout rule the stylesheet owns.
    expect(code).not.toContain("data-sheet-open");
    // And the shell is where the query is subscribed to, using
    // `workbench-split`'s single copy of the breakpoint.
    const shell = stripComments(await read("Workbench.tsx"));
    expect(shell).toContain("window.matchMedia(SPLIT_NARROW_QUERY)");
    expect(shell).toContain("previewOpen={previewOpen}");
    expect(shell).toContain("narrow={narrow}");
  });
});

/**
 * Every `wb-*` class the components RENDER, against the rules `globals.css`
 * actually declares.
 *
 * The defect this exists for is invisible everywhere else: `WorkspacePreview`
 * shipped a longer spelling of `wb-preview-head` that matched no rule anywhere,
 * so the column's title strip had no padding, no border and a UA heading inside
 * it — and every suite in the repo stayed green. A class name is not
 * type-checked, not linted, and not asserted by a mounted test that queries by
 * role.
 *
 * STATIC LITERALS ONLY. A class assembled around a `${…}` is a family of names
 * this scan cannot enumerate, so the fragments flush against an interpolation
 * are skipped rather than guessed at — `wb-tree-row--` is not a class and
 * failing on it would teach the next person to delete the scan.
 */

/** Class tokens from one template literal, minus anything flush against a hole. */
function templateClasses(raw: string): string[] {
  const statics: string[] = [];
  let buffer = "";
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === "$" && raw[i + 1] === "{") {
      statics.push(buffer);
      buffer = "";
      let depth = 1;
      i += 2;
      while (i < raw.length && depth > 0) {
        if (raw[i] === "{") depth += 1;
        else if (raw[i] === "}") depth -= 1;
        if (depth > 0) i += 1;
      }
      continue;
    }
    buffer += raw[i];
  }
  statics.push(buffer);
  const out: string[] = [];
  for (let index = 0; index < statics.length; index += 1) {
    const part = statics[index];
    let tokens = part.split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    // `a${x}` — the last token of this fragment is a PREFIX, not a class.
    if (index > 0 && !/^\s/.test(part)) tokens = tokens.slice(1);
    if (index < statics.length - 1 && !/\s$/.test(part)) tokens = tokens.slice(0, -1);
    out.push(...tokens);
  }
  return out;
}

/** Every static `wb-*` class one component renders. */
function renderedClasses(source: string): Set<string> {
  const code = stripComments(source);
  const found = new Set<string>();
  const marker = "className=";
  for (let at = code.indexOf(marker); at !== -1; at = code.indexOf(marker, at + 1)) {
    const i = at + marker.length;
    let expression: string;
    if (code[i] === '"' || code[i] === "'") {
      const quote = code[i];
      expression = code.slice(i, code.indexOf(quote, i + 1) + 1);
    } else if (code[i] === "{") {
      let depth = 0;
      let end = i;
      for (; end < code.length; end += 1) {
        if (code[end] === "{") depth += 1;
        else if (code[end] === "}" && --depth === 0) break;
      }
      expression = code.slice(i, end + 1);
    } else continue;
    for (const literal of expression.matchAll(/"([^"\\]*)"|'([^'\\]*)'/g)) {
      for (const token of (literal[1] ?? literal[2] ?? "").split(/\s+/)) {
        if (token) found.add(token);
      }
    }
    for (const literal of expression.matchAll(/`([^`]*)`/g)) {
      for (const token of templateClasses(literal[1])) found.add(token);
    }
  }
  return new Set([...found].filter((name) => name.startsWith("wb-")));
}

/**
 * The classes that are RENDERED with no rule, each with the reason it is not a
 * defect this bundle is allowed to absorb silently.
 *
 * NOT A PLACE TO PUT A NEW MISS. A sixth entry is either a defect nobody priced
 * or one an edit just introduced, and the scan is worth nothing if widening this
 * list is the way past it.
 */
const RULELESS_ALLOWED = new Map<string, string>([
  [
    "wb-chat-msg",
    "Chat's message wrapper has never had chrome — giving it any is a UX decision, not a rename.",
  ],
  [
    "wb-chat-msg--assistant",
    "The assistant modifier on the same unstyled wrapper; it exists as a hook, not as a look.",
  ],
  [
    "wb-chat-msg-role",
    "The role label inside that wrapper, likewise unstyled since Story 8.1.",
  ],
  [
    "wb-chat-thinking",
    "The thinking line Chat and Research both render; same argument, two surfaces.",
  ],
  [
    "wb-search-hit-title",
    "The Search hit's title, which inherits the hit's own type; a rule for it would be new design.",
  ],
]);

/**
 * Every file the scan reads, in one place.
 *
 * ONE list for both cases below: an allowlist entry rendered only from
 * `WikiWorkbench.tsx` would otherwise be reported as un-rendered by the honesty
 * case while the miss scan was perfectly happy with it — a red test for a
 * correct allowlist, which teaches the next person to delete the entry.
 */
async function classScanFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(WORKBENCH, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".tsx")) files.push(entry.name);
  }
  files.sort();
  // The Wiki surface renders inside the shell and uses the same vocabulary, so
  // it is scanned with the columns even though it lives one directory up.
  return [...files, "../WikiWorkbench.tsx"];
}

/**
 * The stylesheet with its PROSE removed, which is the only form a selector may
 * be matched against.
 *
 * `globals.css` is comment-dense and its comments name selectors constantly —
 * this file's own `.wb-preview-title` block explains itself by naming
 * `.wb-preview-name`, and the responsive blocks name `.wb-canvas` and
 * `.wb-preview-body` in prose. Matched against the raw text, a rename that left
 * its explanatory comment behind would reproduce DW-718 exactly: a class with no
 * rule, and a green scan pointing at the sentence that used to describe it.
 */
async function styledCss(): Promise<string> {
  return (await globals()).replace(/\/\*[\s\S]*?\*\//g, "");
}

/** A selector for EXACTLY this class — `.wb-preview` is not `.wb-preview-body`. */
function classSelector(name: string): RegExp {
  return new RegExp(`\\.${name.replace(/[-]/g, "\\-")}(?![\\w-])`);
}

describe("every rendered wb-* class has a rule", () => {
  it("names the class and the file when one does not", async () => {
    const css = await styledCss();
    const misses: string[] = [];
    const rendered = new Set<string>();
    let checked = 0;
    for (const file of await classScanFiles()) {
      const source = await read(file);
      for (const name of renderedClasses(source)) {
        checked += 1;
        rendered.add(name);
        if (classSelector(name).test(css)) continue;
        if (RULELESS_ALLOWED.has(name)) continue;
        misses.push(`${file} renders ".${name}", which no rule in globals.css matches`);
      }
    }
    expect(misses).toEqual([]);
    // The scan is actually looking at something: a `className` parser that
    // silently found nothing would pass this suite forever.
    expect(checked).toBeGreaterThan(200);
    // The workspace column's strip carries the class the stylesheet declares —
    // the same one the kernel column uses (DW-718). The miss list above is what
    // catches a rename to anything else; this is what catches the class being
    // dropped altogether, which the miss list could not.
    expect(rendered.has("wb-preview-head")).toBe(true);
    expect(renderedClasses(await read("WorkspacePreview.tsx")).has("wb-preview-head")).toBe(
      true,
    );
  });

  it("keeps the allowlist honest — every entry is still rule-less and still rendered", async () => {
    // An allowlist nobody prunes becomes a list of classes that DO have rules,
    // and then a genuine miss can hide behind a stale entry. Both halves are
    // checked: the class must still be rendered somewhere, and must still have
    // no rule.
    const css = await styledCss();
    const rendered = new Set<string>();
    for (const file of await classScanFiles()) {
      for (const name of renderedClasses(await read(file))) rendered.add(name);
    }
    for (const [name, reason] of RULELESS_ALLOWED) {
      expect(reason.length).toBeGreaterThan(20);
      expect(rendered.has(name)).toBe(true);
      expect(classSelector(name).test(css)).toBe(false);
    }
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

  it("makes the Preview strip survive an <h2> and an unbreakable path (DW-718)", async () => {
    // The class-coverage scan below proves a SELECTOR exists; it says nothing
    // about what is in it. Every declaration here is load-bearing for the
    // Agent-workspace column specifically — that column renders
    // `.wb-preview-title` on an `<h2>` and `.wb-preview-path` on a `<p>`, where
    // the kernel column renders a `<strong>` and a `<span>` — so all of them
    // could be deleted with the scan, the mounted suites and the type checker
    // green, and the strip would go back to a UA `1.5em` heading with UA block
    // margins in a row that is one padded line tall.
    const { rules } = shellBlocks(await globals());
    const title = ruleBlock(rules, ".wb-preview-title");
    // A heading's own size and margins, overridden.
    expect(title).toContain("margin: 0;");
    expect(title).toContain("font-size: var(--wb-font-size);");
    // …and the shrink treatment `.wb-preview-name` carries, because in that
    // column this holds a FILENAME rather than the constant "Preview": a flex
    // item defaults to `min-width: auto`, so one long unbroken name would push
    // the path out of a column whose minimum is 200px.
    expect(title).toContain("min-width: 0;");
    expect(title).toContain("overflow: hidden;");
    expect(title).toContain("text-overflow: ellipsis;");
    expect(title).toContain("white-space: nowrap;");

    const pathRule = ruleBlock(rules, ".wb-preview-path");
    expect(pathRule).toContain("margin: 0;");
    expect(pathRule).toContain("min-width: 0;");
    // The path has no space to break at, so the browser is given one INSIDE it
    // — the strip stays the width of its column and the path wraps in place.
    expect(pathRule).toContain("overflow-wrap: anywhere;");

    // The three blocks this bundle was not allowed to touch are still the ones
    // that make both boxes scroll and both columns withdraw.
    expect(ruleBlock(rules, ".wb-preview")).toContain("overflow: auto;");
    expect(ruleBlock(rules, ".wb-preview-body")).toContain("overflow: auto;");
    expect(ruleBlock(rules, ".wb-preview-head")).toContain(
      "border-bottom: 1px solid var(--wb-border);",
    );
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

/**
 * The retired repo-wide claim, as a set of patterns rather than a set of
 * sentences.
 *
 * Twelve files named a repo-wide absence of any DOM test environment as the
 * REASON their code was shaped a certain way; the `dom` project shipping made
 * every one of those premises false while the arguments they carried stayed
 * true. Matching the
 * CLAIM rather than one wording is what keeps the guard alive through a reword:
 * a future agent repeating the mistake will not repeat the phrasing.
 *
 * The patterns are deliberately narrow enough to leave the ACCURATE,
 * project-scoped comments alone — "the `node` project has no DOM", "this suite
 * runs `environment: \"node\"` with no DOM", "an environment that has no DOM",
 * "Vitest runs this project as `environment: \"node\"`" all pass, and must, or
 * the guard would force a rewrite of prose that is already right.
 *
 * Two patterns carry a `[x]` character class over a letter that changes
 * nothing about what they match. It keeps THIS file's own source clear of the
 * literal claim, so the scan can read itself like every other file instead of
 * carving out an exception — the one hole a scan like this can have.
 */
const RETIRED_DOM_CLAIMS = [
  /th(is|e) repo(sitory)? (has|had) no dom/i,
  /there is (still )?no (dom test environment|jsdom|testing-library)/i,
  /vitest (runs|is) `?environment: "node"/i,
  /`vitest\.config\.ts` is `environment: "node"/i,
  /no jsdom and no testing[-]library/i,
  /forbidden from adding (jsdom|one)/i,
  /with no dom [e]nvironment/i,
];

const ROOT = path.resolve(SRC, "..");

/**
 * Comment wrapping, undone.
 *
 * This repo wraps comments at ~78 columns, so the claim under scan is USUALLY
 * split across two lines with a `*` or `//` between the halves. A line-based
 * match would see `has no DOM test` and `environment` as unrelated strings and
 * report a clean tree — which is the failure mode a source scan is least able
 * to notice about itself.
 */
function unwrapComments(source: string): string {
  return source.replace(/[ \t]*\r?\n[ \t]*(?:\*|\/\/)?[ \t]*/g, " ");
}

/**
 * Every file the claim could live in — not just `src/`.
 *
 * The config files and `AGENTS.md` are in scope on purpose: `AGENTS.md` is what
 * the failure message below points a reader at, and a guard that cannot see the
 * document stating its own rule can watch that document go stale. `e2e/` is the
 * third environment, and the likeliest place for a fresh half-truth about the
 * other two.
 */
async function scannedFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const dir of ["src", "e2e"]) {
    const entries = await readdir(path.join(ROOT, dir), {
      recursive: true,
      encoding: "utf8",
    });
    for (const entry of entries) {
      const file = `${dir}/${entry.split(path.sep).join("/")}`;
      if (/\.(ts|tsx|css|md)$/.test(file)) files.push(file);
    }
  }
  files.push("AGENTS.md", "vitest.config.ts", "vitest.setup.ts", "vitest.setup.dom.ts");
  return files;
}

describe("nothing in the repo says this codebase cannot mount a component (DW-108)", () => {
  it("carries none of the retired phrasings, wrapped or not", async () => {
    const files = await scannedFiles();
    // The walk itself. A count threshold would not catch this: `src/` holds
    // hundreds of files, so a move that dropped most of the tree would still
    // clear any number worth writing down. Naming a file that must be in the
    // list is what fails when the walk stops reaching the components.
    expect(files).toContain("src/components/workbench/Workbench.tsx");
    expect(files).toContain("AGENTS.md");

    const offenders: string[] = [];
    for (const file of files) {
      const source = unwrapComments(await readFile(path.join(ROOT, file), "utf8"));
      for (const claim of RETIRED_DOM_CLAIMS) {
        if (claim.test(source)) offenders.push(`${file}: ${claim}`);
      }
    }
    expect(
      offenders,
      `Two vitest projects ship, declared inline in the config: "node" ` +
        `(environment "node", include src/**/__tests__/**/*.test.ts) and "dom" ` +
        `(environment "jsdom", include src/**/__tests__/**/*.test.tsx, ` +
        `setupFiles ./vitest.setup.ts + ./vitest.setup.dom.ts), and ` +
        `browser-level checks run in Playwright via pnpm test:e2e. So do not ` +
        `justify a design by a repo-wide absence of a DOM test environment, ` +
        `and do not describe the whole runner as one environment. Name the ` +
        `PROJECT the file's own suite runs in instead — see the ` +
        `"Test environments" section in AGENTS.md.`,
    ).toEqual([]);
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
    expect(canvas.match(/\bid=\{[^}]*CANVAS_ID\}/g) ?? []).toHaveLength(1);
    expect(canvas.match(/\btabIndex=\{[^}]*-1\}/g) ?? []).toHaveLength(1);
    // …and that one section GIVES BOTH UP while Settings is over it (DW-373).
    // The mode canvas is no longer swapped out for `SettingsCanvas` — it stays
    // mounted behind `hidden` so an open Create Wiki dialog and its draft
    // survive the visit — and `SettingsCanvas` renders the same id and the same
    // landing tab index, so a mode canvas that kept them unconditionally would
    // put the duplicate back that the assertions above exist to forbid.
    expect(canvas).toContain("id={hidden ? undefined : CANVAS_ID}");
    expect(canvas).toContain("tabIndex={hidden ? undefined : -1}");
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

  it("pins post-login to the Workbench, not an old chrome route", async () => {
    // Clerk's fallback defaults to `/` and wrangler already set
    // SIGN_IN_FALLBACK_REDIRECT_URL=/ — that still loses whenever Clerk has a
    // `redirect_url` (dashboard After sign-in URL, or middleware returnBackUrl
    // to /wiki / /knowledge / /settings). Force is what makes login land on `/`.
    const signIn = await readFile(
      path.join(SRC, "app/sign-in/[[...sign-in]]/page.tsx"),
      "utf8",
    );
    expect(signIn).toContain('forceRedirectUrl="/"');
    const layout = await readFile(path.join(SRC, "app/layout.tsx"), "utf8");
    expect(layout).toContain('signInForceRedirectUrl="/"');
  });

  it("puts the Wiki surface inside the canvas rather than a centred container", async () => {
    const source = await readFile(path.join(SRC, "components/WikiWorkbench.tsx"), "utf8");
    expect(source).toContain('className="wb-canvas-pad"');
    expect(source).not.toContain('className="shell py-8"');
  });
});
