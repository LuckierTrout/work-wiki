/**
 * Story 1.4 — the left column's structural invariants, pinned by source scan.
 *
 * Vitest runs `environment: "node"` and only `src/**\/__tests__/**\/*.test.ts`:
 * there is no jsdom and no testing-library, and adding them is out of scope
 * here (DW-24). So this follows the `single-ia.test.ts` / `workbench-chrome.
 * test.ts` convention and reads the sources as text. What it really pins is
 * that nobody turns the tree into routing, drops the tablist semantics, inlines
 * a sentence next to the shared module, turns the Preview into a navigating or
 * always-editable surface (or lets its reading face leak into chrome),
 * reintroduces "Open project folder", or lands the docked grid variants ahead
 * of the rules they have to outrank.
 */
import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  FILES_EMPTY_COPY,
  FILES_TRUNCATED_COPY,
  FILES_UNAVAILABLE_COPY,
  KNOWLEDGE_EMPTY_COPY,
  KNOWLEDGE_UNAVAILABLE_COPY,
  TREE_NO_WIKI_COPY,
  TREE_TABS,
  TREE_UNAVAILABLE_COPY,
  WIKI_SCOPE_COPY,
} from "../workbench-tree";
import {
  PREVIEW_EMPTY_COPY,
  PREVIEW_FAILED_COPY,
  PREVIEW_UNSUPPORTED_COPY,
  WIKILINK_MISSING_COPY,
} from "../workbench-preview";

const SRC = path.resolve(__dirname, "../..");
const WORKBENCH = path.join(SRC, "components/workbench");

function read(file: string): Promise<string> {
  return readFile(path.join(WORKBENCH, file), "utf8");
}

function globals(): Promise<string> {
  return readFile(path.join(SRC, "app/globals.css"), "utf8");
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const dirent of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, dirent.name);
    // `__tests__` is skipped for the same reason `single-ia.test.ts` skips it:
    // a scan that reads its own assertion text can only ever fail.
    if (dirent.isDirectory()) {
      if (dirent.name === "__tests__") continue;
      out.push(...(await walk(full)));
    }
    else if (/\.(tsx?|css)$/.test(dirent.name)) out.push(full);
  }
  return out;
}

describe("the shell wires the left column without routing", () => {
  it("renders the switcher in the header and the tree only in Wiki mode", async () => {
    const source = await read("Workbench.tsx");
    expect(source).toContain("<WikiSwitcher");
    // The tabs and trees describe the Wiki surface; every other mode keeps
    // Story 1.3's muted label rather than a tree that names nothing on screen.
    //
    // The condition is the MODE and nothing else since DW-412. It used to be
    // `settingsOpen ? <SettingsNav/> : mode === "wiki" ? …`, which unmounted the
    // panel for a Settings visit and re-opened every group and directory the
    // owner had collapsed — `closed` is `TreePanel`'s own state. Settings
    // withdraws it instead, so both halves are pinned: a scan that only saw the
    // mode branch would stay green against a shell that had gone back to
    // rendering the nav in its place.
    expect(source).toMatch(/mode === "wiki" \? \(\s*<TreePanel/);
    expect(source).toMatch(/<TreePanel[\s\S]*?hidden=\{settingsOpen\}[\s\S]*?\/>/);
    expect(source).toMatch(/\{settingsOpen && \(\s*<SettingsNav/);
    expect(source).toContain('className="wb-left-surface"');
    // The product title stays exactly where Story 1.3 put it.
    expect(source).toMatch(/<h1 className="wb-title">\{APP_NAME\}<\/h1>/);
  });

  it("restores and persists the tab through the guarded accessor", async () => {
    // Call sites, not identifiers: a bare name is satisfied by the import line
    // alone, so the restore could be unwired below it without moving this.
    const source = await read("Workbench.tsx");
    expect(source).toContain("setTreeTab(readStoredTreeTab())");
    expect(source).toContain("writeStoredTreeTab(next)");
    // The write stays outside every state updater — React runs updaters twice
    // under StrictMode.
    expect(source).toMatch(/setTreeTab\(next\);\s*\n\s*writeStoredTreeTab\(next\);/);
  });

  it("docks the Preview from shell state, after the canvas, with no route change", async () => {
    const source = await read("Workbench.tsx");
    expect(source).toContain("data-preview=");
    expect(source).toContain("<PreviewColumn");
    // DOM order decides the tab order: rail → left column → canvas → Preview.
    expect(source.indexOf("<ModeCanvas")).toBeLessThan(source.indexOf("<PreviewColumn"));
    // The dock rule itself is a pure function the node suite executes, not a
    // condition typed into JSX where only a grep could reach it.
    expect(source).toContain("shouldDockPreview(mode, selection)");
    // Leaving Wiki mode, switching Wikis, or switching tabs undocks it.
    expect(source).toMatch(
      /setSelection\(null\);\s*\n\s*\}, \[mode, currentWikiId, treeTab\]\)/,
    );
    // Re-picking the selected row deselects it, through the shared equality.
    expect(source).toContain("isSameSelection(current, next) ? null : next");
    // Story 1.3's ban still holds in this file.
    expect(source).not.toContain("router.push(");
    expect(source).not.toMatch(/from "next\/link"/);
    expect(source).not.toMatch(/\buseRouter\(/);
  });

  it("distinguishes a failed read from an empty one on every tab", async () => {
    // A tree that flattens a read failure to zero tells the owner to ingest a
    // source — advice premised on a fact nobody has.
    const source = await read("Workbench.tsx");
    expect(source).toContain("knowledgeUnavailable={knowledgeUnavailable}");
    expect(source).toContain("filesUnavailable={filesUnavailable}");
    const data = await read("WorkbenchData.tsx");
    expect(data).toContain("knowledgeUnavailable: boolean;");
    expect(data).toContain("filesUnavailable: boolean;");
  });
});

describe("TreePanel", () => {
  it("is a real tablist over a real tabpanel", async () => {
    const source = await read("TreePanel.tsx");
    expect(source).toContain('role="tablist"');
    expect(source).toContain('role="tab"');
    expect(source).toContain('role="tabpanel"');
    // Exactly one tab is selected, decided by comparison rather than by a
    // hard-coded index, and the two labels come from the shared module.
    expect(source).toContain("aria-selected={tab === entry.id}");
    expect(source).toContain("TREE_TABS.map");
    expect(TREE_TABS.map((tab) => tab.label)).toEqual(["Knowledge", "Files"]);
    // Only the SELECTED tab controls the one panel — an unselected tab claiming
    // it says it is showing content that belongs to its sibling.
    expect(source).toContain("aria-controls={tab === entry.id ? panelId : undefined}");
  });

  it("renders each tab by name, so a third one cannot inherit the file tree", async () => {
    const source = await read("TreePanel.tsx");
    expect(source).toContain('if (tab === "knowledge")');
    expect(source).toContain('if (tab === "files")');
  });

  it("uses disclosures and a marked selection instead of an unverifiable ARIA tree", async () => {
    const source = await read("TreePanel.tsx");
    expect(source).toContain("aria-expanded={open}");
    expect(source).toMatch(/aria-current=\{[\s\S]{0,160}"true"/);
    // Rows are real buttons in nested lists — no `role="tree"`, no roving
    // tabindex, no arrow-key machinery this suite could not verify.
    expect(source).not.toContain('role="tree"');
    expect(source).not.toContain('role="treeitem"');
    expect(source).toContain('className="wb-tree-list"');
    // Each disclosure names the list it toggles, while that list exists…
    expect(source).toContain("aria-controls={open ? listId : undefined}");
    // …and a directory with nothing in it gets no control at all.
    expect(source).toContain("node.children.length === 0");
    expect(source).toContain("wb-tree-row--static");
  });

  it("sources every sentence from the shared module", async () => {
    const source = await read("TreePanel.tsx");
    expect(source).toContain("@/lib/workbench-tree");
    for (const sentence of [
      TREE_NO_WIKI_COPY,
      TREE_UNAVAILABLE_COPY,
      KNOWLEDGE_UNAVAILABLE_COPY,
      FILES_UNAVAILABLE_COPY,
      KNOWLEDGE_EMPTY_COPY,
      FILES_EMPTY_COPY,
      FILES_TRUNCATED_COPY,
    ]) {
      // A sentence typed here is a second definition of copy the handoff fixes.
      expect(source).not.toContain(sentence);
    }
    expect(source).toContain("KNOWLEDGE_EMPTY_COPY");
    expect(source).toContain("FILES_TRUNCATED_COPY");
  });

  it("distinguishes a failed registry read from an owner with no Wiki", async () => {
    const source = await read("TreePanel.tsx");
    // Both tabs share one branch, so neither tab can claim "No wiki yet." while
    // the truth is that the read failed — the order of the two guards is what
    // makes that impossible, so it is pinned rather than merely present.
    expect(source).toMatch(
      /if \(unavailable\) \{[\s\S]{0,160}TREE_UNAVAILABLE_COPY[\s\S]{0,80}if \(!hasWiki\) \{[\s\S]{0,160}TREE_NO_WIKI_COPY/,
    );
    // Same discrimination per tab: a failed page-index or file read must not
    // reach the owner as "nothing here yet, go ingest something" — and each one
    // names the read that actually failed. The registry sentence would be a
    // false statement here, since the switcher above the tree is at that moment
    // listing the wikis it would claim could not load.
    expect(source).toMatch(
      /if \(knowledgeUnavailable\) \{[\s\S]{0,120}KNOWLEDGE_UNAVAILABLE_COPY/,
    );
    expect(source).toMatch(/if \(filesUnavailable\) \{[\s\S]{0,120}FILES_UNAVAILABLE_COPY/);
    expect(KNOWLEDGE_UNAVAILABLE_COPY).not.toBe(TREE_UNAVAILABLE_COPY);
    expect(FILES_UNAVAILABLE_COPY).not.toBe(TREE_UNAVAILABLE_COPY);
  });

  it("keeps every disclosure reference resolvable and free of stray whitespace", async () => {
    const source = await read("TreePanel.tsx");
    // `aria-controls` is an IDREF LIST: an id built from a free-form page
    // `type` or a filename can carry a space, which splits the value into two
    // references that resolve to nothing. Ids are positional instead.
    expect(source).not.toContain("${baseId}-g-${group.id");
    expect(source).not.toContain("${baseId}-d-${node.path}");
    expect(source).toContain("`${baseId}-g-${index}`");
    expect(source).toContain("`${rowPrefix}-${index}`");
    // A closed disclosure does not render its list, so it must not claim to
    // control one — `aria-expanded` already carries the closed state.
    expect(source).not.toMatch(/aria-controls=\{listId\}/);
    expect(source).toContain("aria-controls={open ? listId : undefined}");
  });
});

describe("WikiSwitcher", () => {
  it("opens the existing dialog rather than forking a second create path", async () => {
    const source = await read("WikiSwitcher.tsx");
    expect(source).toContain('from "@/components/CreateWikiDialog"');
    expect(source).toContain("<CreateWikiDialog");
    expect(source).toContain('"/api/wikis"');
    expect(source).toContain('"/api/wikis/current"');
    // `router.refresh()` is the refresh signal until Story 1.7 replaces it —
    // and it lives here, never in the shell.
    expect(source).toContain("router.refresh()");
  });

  it("does not let an optimistic pick outlive the server's answer", async () => {
    const source = await read("WikiSwitcher.tsx");
    // A stale `pendingId` outranks `currentWikiId` forever, so a switch made
    // from the canvas card would leave this control naming the previous Wiki —
    // and re-picking the option it already shows fires no change event.
    expect(source).toMatch(/setPendingId\(null\);\s*\n\s*\}, \[currentWikiId\]\)/);
    expect(source).toContain("setSwitching(false)");
  });

  it("takes its deadline from the shared helper rather than redefining one", async () => {
    // Every request has a deadline, so `switching` cannot be stranded true by a
    // fetch that never settles — `finally` alone cannot rescue that. The
    // deadline, the JSON content type and the `...init` FIRST spread order now
    // live in ONE module (DW-175): the canvas card had a copy of `send` that
    // armed no signal at all, so a hung create left its `busy` flag up for the
    // session.
    const helper = await readFile(path.join(SRC, "lib/workbench-request.ts"), "utf8");
    expect(helper).toContain("AbortSignal.timeout(REQUEST_TIMEOUT_MS)");
    // Client-safe: this module is imported by two `"use client"` components.
    expect(helper).not.toMatch(/from "node:/);
    // Its behaviour — the content type, the deadline and the `...init` FIRST
    // spread order — is EXERCISED in `workbench-request.test.ts`, and the
    // deadline is observed again at each component's own boundary in the two
    // mounted suites. What is left to a scan is only that the two components
    // consume this module rather than forking it again.

    // Imported, not restated — in BOTH consumers.
    for (const component of ["workbench/WikiSwitcher.tsx", "WikiWorkbench.tsx"]) {
      const consumer = await readFile(path.join(SRC, "components", component), "utf8");
      expect(consumer).toContain('from "@/lib/workbench-request"');
      expect(consumer).not.toContain("const REQUEST_TIMEOUT_MS");
      expect(consumer).not.toContain("async function send<T>");
      // The verdict on a failed write has one owner too (DW-283): whether an
      // aborted request is a failure or an outcome nobody knows is not a
      // judgement a call site may make for itself.
      expect(consumer).not.toContain("function writeFailure(");
      expect(consumer).toContain("writeFailure(");
    }
  });

  it("keeps a handler-level in-flight guard on every write, not only on the button", async () => {
    // The one invariant here that ONLY a scan can hold (DW-255).
    //
    // The mounted suites press each confirm twice and observe one request —
    // which is the behaviour that matters, but it cannot say WHICH guard
    // refused the second press: React dispatches no click on a `disabled`
    // button, so deleting every `if (busy) return` below leaves those tests
    // green. An unreachable line is invisible to a mounted test and obvious to
    // a scan, so this is where it is pinned.
    //
    // The guards are defence in depth, and the depth is the point: `disabled`
    // is a rendering decision that a restyle, a `ConfirmDialog` rewrite, or one
    // more keyboard path into the same handler can undo — `CreateWikiDialog`
    // already carries Enter past its own button, which is why `submit` has the
    // same line.
    const switcher = await read("WikiSwitcher.tsx");
    // `create`, `rename`, `remove` — every write behind a dialog. `switchWiki`
    // is guarded on `switching`, its own flag, asserted separately above.
    //
    // `awaitingWrite` rides ALONGSIDE `busy` in the same line (DW-375): the two
    // shut the same door for different lengths of time — `busy` for the length
    // of the request, the latch until a server render lands after one whose
    // outcome nobody knows. The dialogs stay open on that path, so the handler
    // is reachable with `busy` already back to false.
    expect(switcher.match(/if \(busy \|\| awaitingWrite\) return;/g) ?? []).toHaveLength(3);
    expect(switcher.match(/if \(busy\) return;/g) ?? []).toHaveLength(0);

    // The SECOND keyboard path into `rename`, guarded on exactly what the
    // confirm is guarded on. It is unreachable behind the handler's own early
    // return — deleting either one alone leaves every mounted case green — which
    // is precisely why it is pinned by a scan rather than trusted to a test.
    // `CreateWikiDialog.submit` carries the same pair for the same reason.
    expect(switcher).toContain("if (busy || awaitingWrite || !renameReady) return;");
    const createDialog = await readFile(
      path.join(SRC, "components/CreateWikiDialog.tsx"),
      "utf8",
    );
    expect(createDialog).toContain("if (busy || confirmDisabled) return;");

    const card = await readFile(path.join(SRC, "components/WikiWorkbench.tsx"), "utf8");
    // `create` and `applyTemplate` — the card's two writes, guarded differently
    // on purpose (DW-407). `create`'s dialog stays OPEN when an outcome is
    // unknown, with `busy` already back to false and the confirm plus its Enter
    // path both live over a POST that may have seeded a wiki, so `awaitingCreate`
    // rides alongside `busy` there exactly as `awaitingWrite` does in the
    // switcher. `applyTemplate` is idempotent per scenario — a repeat overwrite
    // writes the same template — so it carries `busy` alone.
    expect(card.match(/if \(busy \|\| awaitingCreate\) return;/g) ?? []).toHaveLength(1);
    expect(card.match(/if \(busy\) return;/g) ?? []).toHaveLength(1);
    // The prop is the reachable half of the pair: the handler's early return is
    // unreachable behind it, which is the whole reason the line above is pinned
    // by a scan rather than trusted to a mounted test.
    expect(card).toContain("confirmDisabled={awaitingCreate}");
  });

  it("labels the switcher for assistive tech and names the create control", async () => {
    const source = await read("WikiSwitcher.tsx");
    expect(source).toContain("Active wiki");
    expect(source).toContain("htmlFor={selectId}");
    expect(source).toContain("New Wiki");
    // A read failure is not "you have no wikis": same state, same sentence as
    // the canvas card already shows.
    expect(source).toContain("TREE_UNAVAILABLE_COPY");
    // An owner with no Wiki gets no switcher — but still gets the one control
    // that ends that state, so `New Wiki` sits outside the gate.
    expect(source).toContain("wikis.length > 0");
    const gate = source.indexOf("{wikis.length > 0 && (");
    expect(gate).toBeGreaterThan(-1);
    const gated = source.slice(gate, source.indexOf("</select>", gate));
    expect(gated).toContain("Active wiki");
    expect(gated).not.toContain("New Wiki");
  });

  it("sources the Wiki-scope sentence rather than inlining it", async () => {
    const source = await read("WikiSwitcher.tsx");
    // A Wiki is a lens, not a partition (`src/lib/wikis.ts:16-17`), and the
    // switcher is where that misreading happens — so the sentence ships, and
    // it ships from the module that owns every left-column sentence.
    expect(source).toContain("WIKI_SCOPE_COPY");
    expect(source).toContain('from "@/lib/workbench-tree"');
    // Typed here it would be a second definition of copy the tests pin
    // elsewhere — the same sourced-not-literal rule TREE_UNAVAILABLE_COPY has.
    // Both the whole sentence and each half of it, because half a sentence
    // pasted in is the same drift. The halves are DERIVED, never typed: typed
    // fragments would stop matching the moment the constant is reworded, and
    // then pass vacuously — exactly the failure this test exists to catch.
    const halves = WIKI_SCOPE_COPY.split(". ").filter(Boolean);
    expect(halves.length).toBeGreaterThan(1);
    for (const half of [WIKI_SCOPE_COPY, ...halves]) {
      expect(source).not.toContain(half);
    }
    // Not `role="alert"`: nothing failed. Announcing a statement of intended
    // design on every mount would interrupt a screen-reader user, and would put
    // a permanent fixture in the channel the switcher's real error uses.
    const note = source.indexOf('className="wb-wiki-switch-note wb-wiki-switch-scope"');
    expect(note).toBeGreaterThan(-1);
    // Anchored at the element's OPENING `<p`, so a `role` written before
    // `className` is inside the scanned window rather than behind it…
    const open = source.lastIndexOf("<p", note);
    expect(open).toBeGreaterThan(-1);
    // …and bounded by a close tag that must actually exist and actually follow:
    // a missing `</p>` would make `indexOf` return -1 and turn the slice into a
    // whole-file scan, which fails on an unrelated `role="alert"` elsewhere.
    const close = source.indexOf("</p>", note);
    expect(close).toBeGreaterThan(note);
    expect(source.slice(open, close)).not.toContain("role=");
    // The sentence is still ANNOUNCED, just not as an alert: the <select> it
    // describes points at it, which is the whole affordance for a user who
    // cannot see that it sits directly below.
    // The scope id is still written from the SAME condition that renders the
    // sentence, so a future edit cannot leave it dangling — it is now one entry
    // in a space-separated list, because a read-only deployment appends the
    // sentence that says a switch will be refused (DW-37).
    expect(source).toContain("aria-describedby={selectDescribedBy}");
    expect(source).toContain("wikis.length > 0 ? scopeNoteId : null");
    expect(source).toContain("readOnly ? readOnlyNoteId : null");
    expect(source.slice(open, close)).toContain("id={scopeNoteId}");
  });

  it("separates the scope sentence from the switcher row it sits under", async () => {
    const css = await globals();
    // Unpinned, deleting this rule leaves the sentence flush against the
    // <select> — reading as part of the control rather than a note about it —
    // with every other assertion in the suite still green.
    //
    // COMPOUND, not `.wb-wiki-switch-scope` alone: the element carries both
    // classes, so a single-class selector ties on specificity with the
    // `margin: 0` below and wins only by sitting later in the file. Pinned as a
    // single class, moving either rule — or sorting the block — would flatten
    // the spacing with this test still green, which is the failure it exists to
    // catch.
    expect(css).toMatch(
      /\.wb-wiki-switch-note\.wb-wiki-switch-scope \{[^}]*margin-top: var\(--wb-space-1\);/,
    );
    // Its OWN rule, not a change to the shared muted face: that face also
    // dresses the `unavailable` note, which is the only child of its branch and
    // must keep `margin: 0`.
    expect(css).toMatch(
      /\.wb-wiki-switch-note,\s*\.wb-wiki-switch-error \{[^}]*margin: 0;/,
    );
  });
});

describe("PreviewColumn is view-first over a rendered body", () => {
  it("keeps the header and the frontmatter strip, and renders the body beneath", async () => {
    const source = await read("PreviewColumn.tsx");
    expect(source).toContain('className="wb-preview-fm"');
    expect(source).toContain("Preview");
    // The whole GFM/wikilink surface is one file, and this is the only place it
    // is mounted — the column itself parses no markdown.
    expect(source).toContain("<PreviewBody");
    expect(source).not.toMatch(/react-markdown|remark|\bmarked\b|renderMarkdown/);
    // The truncation sentence is ABOVE the body. Below it, the only way to
    // learn the page was cut off is to scroll to an end that is not there —
    // and it is also why the `Edit` control is absent, which is visible at once.
    const note = source.indexOf("{state.payload.truncated && (");
    const body = source.indexOf('<div className="wb-preview-body">');
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(body);
    // WHICH of the five states is showing is decided by an executed function,
    // not by four conditions spelled in JSX where only a grep can reach them:
    // inverting the empty test there rendered `This file is empty.` for every
    // readable file with the whole suite green. `workbench-preview.test.ts` runs
    // all five branches; what is left here is that the column asks.
    expect(source).toContain("previewBodyState({ loading, gone, payload })");
    expect(source).not.toContain("payload.body.trim().length === 0");
    expect(source).not.toContain('payload.format === "unsupported"');
    // DW-54 renamed the input with the fact it carries. The column must not
    // hold a flag called `failed` at all any more: it meant five things, and
    // the four that are not a 404 must leave the body where it is. The
    // mounted suite (`preview-announcements.test.tsx`) observes both halves
    // directly; what this pins is that neither can be re-conflated in source.
    expect(source).not.toContain("setFailed(");
    expect(source).toContain("setGone(");
    expect(source).toContain("setUnreachable(");
    // …and the strip is a decision too, not five conditions typed into JSX —
    // `editing` among them, which is what keeps `Retry` off screen in the one
    // state where `previewFetchPlan` would refuse to act on it.
    expect(source).toContain(
      "previewStaleNotice({ loading, gone, unreachable, editing, payload })",
    );
  });

  it("fetches the bytes abortably, keyed on the selection and the data version", async () => {
    const source = await read("PreviewColumn.tsx");
    // The URL is built by the shared module, so the route and its one caller
    // cannot drift on a parameter name — and the stale/failed DECISION is made
    // by `fetchPreview`, which `workbench-preview.test.ts` executes against a
    // stubbed fetch. What is left to pin here is only the wiring.
    expect(source).toContain("fetchPreview(previewRequestUrl(selection), controller.signal)");
    expect(source).toContain("new AbortController()");
    expect(source).toMatch(/controller\.abort\(\)/);
    // The deadline aborts with a REASON, so `fetchPreview` can tell a hung
    // request from a superseded pick. Without it a hang is silently classified
    // as stale and the column shows `Loading…` for the rest of the session.
    expect(source).toContain("controller.abort(PREVIEW_TIMEOUT_REASON)");
    // A pick that lost the race writes nothing: one branch, and it returns.
    expect(source).toContain('if (result.status === "stale") return;');
    // And every OTHER outcome settles the column. Without this line a completed
    // read leaves `Loading…` on screen for the rest of that selection, which is
    // indistinguishable from the hang the deadline exists to end.
    expect(source).toContain("setLoading(false)");
    // DW-54 adds a fourth dependency: the `Retry` control bumps a nonce rather
    // than calling a reader of its own, so a retry goes through the SAME plan
    // as every other read — including the rule that an open editor defers it.
    expect(source).toMatch(/\}, \[selection, dataVersion, editing, retryNonce\]\)/);
    // No second copy of the decision: the component must not re-derive it.
    expect(source).not.toContain("response.ok");
  });

  it("puts the editor behind the confirm dialog and nowhere else", async () => {
    const source = await read("PreviewColumn.tsx");
    expect(source).toContain('from "@/components/ConfirmDialog"');
    expect(source).toContain("<ConfirmDialog");
    // `setEditing(true)` appears exactly once, in the confirm handler — a second
    // call site would be an edit path that skips the gate.
    expect(source.match(/setEditing\(true\)/g) ?? []).toHaveLength(1);
    expect(source).toContain("onConfirm={startEditing}");
    // Raw markdown only: no rich-text affordance, no editor library.
    expect(source).toContain("<textarea");
    expect(source).not.toMatch(/contentEditable|execCommand|toolbar|Wysiwyg|WYSIWYG/i);
    // The write goes through the one existing page route, so
    // `writeWikiPageWithSideEffects` fires — no second markdown writer. The URL
    // and the PUT live in `workbench-preview` (executed there); what this pins
    // is that the column reaches the write path only through that function and
    // never spells a request of its own.
    expect(source).toContain("savePreviewBody(target.url, draft");
    // The write precondition rides with that one call (DW-38/51/56), and it is
    // the version the editor was SEEDED with — never `payload.version` read at
    // Save. A silent same-row refresh (Story 1.7) deliberately leaves an open
    // editor alone, so the payload's version may already describe another
    // actor's bytes: sending THAT would match, and the save would clobber
    // exactly the write this guard exists to notice.
    expect(source).toContain("version: editingVersionRef.current,");
    expect(source).toContain("editingVersionRef.current = payload.version;");
    expect(source).not.toContain("version: payload?.version");
    expect(source).not.toContain("version: payloadRef.current?.version");
    // …and a landed save stamps the version it answered with onto the payload,
    // so a second edit without a reload is not refused as a conflict with
    // itself.
    expect(source).toContain(
      "{ ...current, body: draft, version: result.version }",
    );
    // Call sites, not the docblock that explains the route: the column issues
    // no request of its own at all now — both go through `workbench-preview`,
    // where a stubbed fetch executes them.
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toContain('method: "PUT"');
    // A failed save keeps the owner's text and says so inline.
    expect(source).toContain("setSaveError(result.message)");
    expect(source).toContain('role="alert"');
    expect(source).toContain("setSaving(false)");
    // A save that lands after the owner picked another row must not stamp this
    // draft onto that row's payload, nor pull focus off what they just clicked.
    // …and since DW-181 through `previewEditTarget`, so `gone` is inside the
    // same comparison: the 404 branch KEEPS the payload on purpose, and a guard
    // reading that payload alone passed and posted over a row the server had
    // already deleted.
    expect(source).toMatch(
      /if \(\s*previewEditTarget\(\{ gone: goneRef\.current, payload: payloadRef\.current \}\)\?\.key !==\s*target\.key\s*\)\s*return;/,
    );
    expect(source).not.toContain("previewWriteTarget(payloadRef.current)");
    // The draft is keyed to the TARGET it was SEEDED from, not to whatever the
    // column happens to be showing when Save is pressed. Reading `payload?.slug`
    // there would write page A's text under page B's slug the moment the editor
    // outlived a selection change — and since Story 1.8 the same mistake would
    // post a page's draft to the Schema's route, because the two now differ in
    // URL as well as in key.
    expect(source).toContain("const target = editingTargetRef.current;");
    expect(source).not.toContain("const slug = payload?.slug;");
    // And a pick closes the editor, so the two can only disagree if this is
    // deleted — which is why the check above exists as well as this line.
    const fetchEffect = source.slice(
      source.indexOf("const controller = new AbortController()"),
      source.indexOf("}, [selection, dataVersion, editing])"),
    );
    expect(fetchEffect).toContain("setEditing(false)");
    expect(fetchEffect).toContain("editingTargetRef.current = null");
    // Disabling the focused textarea moves focus to `<body>` for the length of
    // the save, dropping the caret and, on failure, the owner's place in it.
    // `lastIndexOf`: the module docblock names `<textarea>` too, and the
    // element itself is the last occurrence.
    const opens = source.lastIndexOf("<textarea");
    const textarea = source.slice(opens, source.indexOf("/>", opens));
    expect(textarea).toContain("readOnly={saving}");
    expect(textarea).not.toContain("disabled={saving}");
    // An empty body is a 400 whose message is a developer string in no Copy
    // table, one keystroke away. The control refuses instead of the server.
    expect(source).toContain("draft.trim().length === 0");
    // Both edit conditions live in one executed function — dropping the
    // truncation half means saving a prefix over the whole page.
    expect(source).toContain("canEditPreview({ gone, payload })");
    expect(source).not.toContain("payload?.truncated === false");
    // Every request has a deadline; `finally` cannot rescue one that never
    // settles, which would strand the busy flag with no error to explain it.
    expect(source).toContain("AbortSignal.timeout(REQUEST_TIMEOUT_MS)");
  });

  it("carries no book face, no rival renderer, and no navigation", async () => {
    const source = await read("PreviewColumn.tsx");
    expect(source.replaceAll("sans-serif", "")).not.toContain("serif");
    expect(source).not.toContain("Georgia");
    // Epic 7 Story 7.8 owns math and diagrams, and the article renderer wires
    // KaTeX unconditionally — none of it belongs in the Workbench chunk.
    expect(source).not.toMatch(/rehype|remark-math|Mermaid|MarkdownRenderer/);
    expect(source).not.toMatch(/from "next\/link"/);
    expect(source).not.toContain("router.push(");
  });
});

describe("PreviewBody", () => {
  it("renders GFM and wikilinks, and nothing else", async () => {
    const source = await read("PreviewBody.tsx");
    expect(source).toContain("remarkPlugins={[remarkGfm, remarkWikilinks]}");
    // No html-stage plugins at all: that is where KaTeX and raw HTML would come
    // in, and both are out of scope for this epic.
    expect(source).not.toContain("rehypePlugins");
    expect(source).not.toMatch(/rehype|remark-math|Mermaid|MarkdownRenderer/);
    expect(source).not.toMatch(/from "next\/link"/);
    // A wikilink re-points the selection; it never emits a page URL.
    expect(source).toContain('className="wb-wikilink"');
    expect(source).toContain("onOpenPage(slug)");
    // `[text](slug.md)` is the form the kernel writes; as a live anchor it
    // navigates the browser out of the shell to a URL that does not exist.
    expect(source).toContain("markdownLinkTarget(href)");
    expect(source).toContain("<button");
    expect(source).not.toContain("/u/");
    // Tables scroll inside their own box rather than widening the shell.
    expect(source).toContain('className="wb-preview-table"');
  });

  it("sources every sentence from the shared module", async () => {
    const source = await read("PreviewBody.tsx");
    expect(source).toContain("@/lib/workbench-preview");
    for (const sentence of [
      WIKILINK_MISSING_COPY,
      PREVIEW_EMPTY_COPY,
      PREVIEW_FAILED_COPY,
      PREVIEW_UNSUPPORTED_COPY,
    ]) {
      // A sentence typed here is a second definition of copy the handoff fixes.
      expect(source).not.toContain(sentence);
    }
    expect(source).toContain("WIKILINK_MISSING_COPY");
    // A missing link is announced, not merely styled.
    expect(source).toContain('className="wb-sr-only"');
  });

  it("keeps the app's data-URI policy and lets exactly one scheme past it", async () => {
    const source = await read("PreviewBody.tsx");
    expect(source).toContain('from "@/lib/markdown-url"');
    expect(source).toContain("WIKILINK_HREF_PREFIX");
    expect(source).toContain("urlTransform(url)");
  });

  it("carries no book face — the reading face is a token in CSS", async () => {
    const source = await read("PreviewBody.tsx");
    expect(source.replaceAll("sans-serif", "")).not.toContain("serif");
    expect(source).not.toContain("Georgia");
  });
});

describe("the shell follows a wikilink without clearing the selection", () => {
  it("adds a non-toggling open, and does not touch the frozen reset deps", async () => {
    const source = await read("Workbench.tsx");
    // `selectRow` toggles; a link pointing at the row already showing must not
    // undock the column instead of staying on it.
    expect(source).toContain("wikilinkSelection(treeTab, files, slug)");
    expect(source).toContain("onOpenPage={openPage}");
    // Following a link to the row already showing is a no-op: the Preview's
    // fetch effect is keyed on selection IDENTITY, so a fresh-but-equal object
    // tears down the body and refetches bytes the column already has.
    expect(source).toContain("isSameSelection(current, next) ? current : next");
    // The reset effect's deps stay exactly what Story 1.4 froze — a wikilink
    // jump that changed the tab would clear the selection it just made.
    expect(source).toMatch(
      /setSelection\(null\);\s*\n\s*\}, \[mode, currentWikiId, treeTab\]\)/,
    );
    expect(source).not.toMatch(/\buseRouter\(/);
  });
});

describe("Intake's controls sit on the left column's chrome (Story 2.1)", () => {
  it("puts Import / Upload above the tabs, from the one shared constant", async () => {
    const panel = await read("TreePanel.tsx");
    // A slot on this panel — header actions belong with the tree chrome
    // (UX-DR5), not on the rail, which is modes.
    expect(panel).toContain("header?: ReactNode");
    expect(panel).toContain('<div className="wb-tree-head">{header}</div>');
    // ABOVE the tablist, so the column reads head → intake → tabs → tree.
    expect(panel.indexOf('className="wb-tree-head"')).toBeLessThan(
      panel.indexOf('className="wb-tabs"'),
    );

    const controls = await read("IntakeControls.tsx");
    // The label is imported, never retyped: two literals that must stay
    // identical are two definitions however close together they sit.
    expect(controls).toContain("INTAKE_IMPORT_LABEL");
    expect(controls).not.toMatch(/["'`]Import \/ Upload["'`]/);
    expect(controls).toContain("INTAKE_FOLDER_LABEL");
    expect(controls).not.toMatch(/["'`]Folder["'`]/);
    // A real file input, with the accept attribute DERIVED from the allowlist.
    expect(controls).toContain('type="file"');
    expect(controls).toContain("accept={INTAKE_ACCEPT_ATTR}");
    // `webkitdirectory` is allowed only on the Folder input, and only via
    // setAttribute — never as a JSX attribute on Import / Upload. Matched as
    // ATTRIBUTES rather than as bare words, so a docblock is not what fails.
    const importBlock = controls.slice(
      controls.indexOf("{busy ? INTAKE_BUSY_COPY : INTAKE_IMPORT_LABEL}"),
      controls.indexOf("{busy ? INTAKE_BUSY_COPY : INTAKE_FOLDER_LABEL}"),
    );
    expect(importBlock).not.toMatch(/\bwebkitdirectory\b/);
    expect(importBlock).not.toMatch(/\bdirectory\s*[={]/);
    expect(controls).toContain('setAttribute("webkitdirectory"');
    expect(controls).toContain("bindFolderInput");
    expect(controls).toContain("folderInputRef");
    expect(controls).not.toContain('inputRef.current?.setAttribute("webkitdirectory"');
    expect(controls).not.toContain("mozdirectory");
    // `accept` stays on Import / Upload only. Putting it on the directory
    // picker hid office files so they never reached the 2.1 refusal sentence.
    const folderBlock = controls.slice(
      controls.indexOf("{busy ? INTAKE_BUSY_COPY : INTAKE_FOLDER_LABEL}"),
    );
    expect(folderBlock).not.toContain("accept=");
  });

  it("dims the hidden picker with its button, and names the control once", async () => {
    const controls = await read("IntakeControls.tsx");
    const input = controls.slice(controls.indexOf('type="file"'));
    const hidden = input.slice(0, input.indexOf("/>"));
    // The BUTTON's `disabled` stops the click that opens the dialog; it does not
    // stop a `.click()` reaching the input from anywhere else. Both carry it.
    expect(hidden).toContain("disabled={disabled}");
    // One accessible name for one control. The visible button owns it; a label
    // on the hidden input too put a second node with the same name in the tree.
    expect(hidden).toContain('aria-hidden="true"');
    expect(hidden).not.toContain("aria-label");
  });

  it("keeps the URL draft until the shell has reported the outcome", async () => {
    const controls = await read("IntakeControls.tsx");
    // `setDraft("")` inside the submit handler throws away the URL the owner
    // needs most on the failure path: the outcome is not known until the shell
    // reports it, long after this handler returned. The only `setDraft` calls
    // left are the field's own `onChange`.
    const submit = controls.slice(controls.indexOf("onSubmit="));
    expect(submit).toContain("onUrl(draft)");
    expect(submit.slice(0, submit.indexOf("</form>"))).not.toContain('setDraft("")');
  });

  it("offers the same control in Wiki mode and on the Sources column", async () => {
    const source = await read("Workbench.tsx");
    // ONE composed node handed to both surfaces. A second element spelled out
    // for the other column is how the two would start diverging (one passing
    // `busy`, the other forgetting `readOnly`). Counted with comments removed,
    // so an element NAMED in a docblock — including the one this file's own
    // paragraphs would otherwise trip over — is not counted as a second use.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(code.match(/<IntakeControls/g) ?? []).toHaveLength(1);
    expect(source).toContain("header={intakePanel}");
    expect(source).toContain('{mode === "sources" && intakePanel}');
    // The in-app URL field is the one difference between them (UX-DR5).
    expect(source).toContain('url={mode === "sources"}');
    // Read-only is withheld BEFORE the request, not after the route's 403.
    expect(source).toContain("readOnly={readOnly}");
  });

  it("makes the whole shell the drop target, and claims only file drags", async () => {
    const source = await read("Workbench.tsx");
    for (const handler of [
      "onDragOver=",
      "onDragEnter=",
      "onDragLeave=",
      // A drag cancelled with Esc or released outside the window fires neither
      // `drop` nor, reliably, a matching `dragleave` — so without this the
      // overlay stays lit over a shell nobody is dragging anything onto.
      "onDragEnd=",
      "onDrop=",
    ]) {
      expect(source, handler).toContain(handler);
    }
    // The rule itself is a pure function the node suite executes, not a
    // condition typed into a handler where only a grep could reach it.
    expect(source).toContain("intakeDragHasFiles(");
    // `preventDefault` is what makes an element a drop target at all — without
    // it the browser navigates to the dropped file and replaces the shell.
    expect(source).toContain("event.preventDefault();");
    expect(source).toContain('data-drop={dropActive ? "true" : "false"}');
    // OS file drags never fire `dragend` on the drop target (the source is the
    // desktop), so the overlay reset also listens on `window`.
    expect(source).toContain('window.addEventListener("dragend"');
    expect(source).toContain('window.addEventListener("dragleave"');
  });

  it("says what happened wherever the drop landed, in one place", async () => {
    const source = await read("Workbench.tsx");
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    // EXACTLY ONE rendering of the sentence, and it is on the shell rather than
    // inside either left column: the drop target is the whole Workbench, so a
    // drop in Chat or Lint was previously announced into the live region and
    // then had nowhere on screen to appear. Two renderings would paint it twice
    // in Wiki and Sources, which is what moving it out of `intakePanel` fixed.
    expect(code.match(/wb-intake-status/g) ?? []).toHaveLength(1);
    expect(code).toContain('{intakeStatus && <p className="wb-intake-status">');
    // Still ONE live region for the whole shell. The status paragraph is not a
    // second one — two regions holding the same words speak them twice.
    expect(code.match(/aria-live=/g) ?? []).toHaveLength(1);
  });

  it("refuses a second arrival while one is in flight, out loud", async () => {
    const source = await read("Workbench.tsx");
    // Both doors read the same flag. Without it two batches share one
    // `intakeBusy` and race their own `finally`: the first to resolve clears the
    // flag while the second is still posting, and the second's report overwrites
    // a sentence the owner may not have read yet.
    expect(source.match(/if \(readOnly \|\| intakeBusyRef\.current\) return;/g) ?? []).toHaveLength(1);
    expect(source).toContain("if (intakeBusyRef.current) return;");
    // A DROP has no disabled state for the platform to respect, so the refusal
    // is said rather than swallowed — a silent drop is indistinguishable from a
    // lost file, which is the one thing this door must never be.
    expect(source).toContain("INTAKE_IN_FLIGHT_COPY");
    // …and the overlay does not INVITE a drop the deployment will refuse, or
    // one that is already being stored.
    expect(source).toContain("if (!readOnly && !intakeBusyRef.current) setDropActive(true);");
    // A Files-typed drop with an empty list is said, not swallowed.
    expect(source).toContain("INTAKE_FILE_REQUIRED_COPY");
    // An empty Folder pick is said on the Folder action, not swallowed by
    // `submitIntakeFiles([])` — the shell reports it before that helper runs.
    expect(source).toContain("INTAKE_FOLDER_COPY");
    expect(source).toContain("if (picked.length === 0)");
  });

  it("refreshes through the watcher's nudge and nothing else", async () => {
    const source = await read("Workbench.tsx");
    expect(source).toContain("requestDataVersionCheck()");
    // The shell states no opinion about whether the write landed: the server's
    // integer decides. (The router-call ban itself is pinned in
    // `workbench-data-version.test.ts`, which owns that scan.)
    expect(source).not.toMatch(/\buseRouter\(/);
    // Announced as well as rendered: an arrival changes a tree below with no
    // focus move and no route change.
    expect(source).toContain("announce(sentence)");
  });
});

describe("the retired affordance stays retired", () => {
  it("no source under src/ renders `Open project folder`", async () => {
    const offenders: string[] = [];
    for (const file of await walk(SRC)) {
      if ((await readFile(file, "utf8")).includes("Open project folder")) {
        offenders.push(path.relative(SRC, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("page.tsx loads the trees from the authenticated principal", () => {
  it("passes server-loaded data down and never names an owner itself", async () => {
    const source = await readFile(path.join(SRC, "app/page.tsx"), "utf8");
    expect(source).toContain("listReadableWikiPages(principal)");
    expect(source).toContain("listWorkbenchFilePaths(");
    expect(source).toContain("principal.handle");
    expect(source).toContain("buildKnowledgeTree(pageIndex.entries)");
    expect(source).toContain("buildFileTree(fileListing.paths)");
    // The Files tab is gated by the KNOWLEDGE TREE ITSELF, not by the index it
    // was built from: `buildKnowledgeTree` also drops agent-scoped pages, so a
    // set derived from `pageIndex.entries` would let the Files tab name a page
    // the Knowledge tab hides — a filename is the same disclosure as a title.
    // The derivation itself is a shared function the node suite EXECUTES
    // (`workbench-tree.test.ts`), so what is left to pin here is only that this
    // file calls it on the built tree — an inline expression would have made
    // the rule reachable by grep alone, and a rewrite that kept the comment and
    // read `pageIndex.entries` would have stayed green.
    expect(source).toContain("readableSlugsFromKnowledge(knowledge)");
    expect(source).not.toMatch(/readableSlugs\s*=\s*new Set\(/);
    expect(source).toContain("{ readableSlugs }");
    // The gate is the page index, so a failed index read is a failed file read:
    // an empty slug set filters every page out of `wiki/`, and the tab would
    // otherwise show an empty silo where the truth is "we could not find out".
    expect(source).toContain("fileListing.unavailable || pageIndex.unavailable");
    // The registry and the page index are independent, so they share a round.
    expect(source).toContain("await Promise.all([");
    // The card is rendered BARE and unkeyed (DW-174): it reads `wikis`,
    // `currentWikiId` and `registryUnavailable` off the provider above it, so
    // the remount key that used to carry a switch — and could never carry a
    // RENAME, which leaves `currentId` untouched — is gone with the props it
    // stood in for. The consequence is executed in
    // `workbench/__tests__/wiki-canvas-duplication.test.tsx`.
    expect(source).not.toContain("key={wikiRegistry.registry.currentId");
    expect(source).not.toMatch(/initialWikis|initialCurrentId/);
    expect(source).toContain("<WikiWorkbench />");
    expect(source).toContain("registryUnavailable: wikiRegistry.unavailable");
    // No client fetch of tree data, and no second listing path.
    expect(source).not.toContain("fetch(");
  });

  it("hands the working set across the boundary as context, not as shell props", async () => {
    const source = await readFile(path.join(SRC, "app/page.tsx"), "utf8");
    const shell = await read("Workbench.tsx");
    // `workbench-chrome.test.ts` asserts page.tsx contains the literal
    // `<Workbench>`. That assertion is only a real mount check while the
    // element stays bare — props would turn it into `<Workbench\n  …`, and the
    // string would then have to be satisfied by prose somewhere in the file.
    // The provider is what keeps it honest, so both halves are pinned here.
    expect(source).toContain("<WorkbenchDataProvider");
    expect(source).toContain("<Workbench>");
    expect(shell).toContain("useWorkbenchData()");
    expect(shell).not.toContain("knowledge?:");
  });
});

describe("globals.css docks the Preview as a fourth column", () => {
  it("declares the width token and the grid variants", async () => {
    const css = await globals();
    expect(css).toContain("--wb-preview: 360px;");
    // Declared with the rest of the spacing scale, in the ONE `.wb-shell` token
    // block — not in a second block carved out to dodge a test's parser.
    expect(css.match(/^\.wb-shell \{$/gm) ?? []).toHaveLength(1);
    expect(css).toContain('.wb-shell[data-preview="true"] {');
    expect(css).toContain('.wb-shell[data-collapsed="true"][data-preview="true"] {');
    expect(css).toMatch(/\.wb-preview \{\s*grid-column: 4;/);
    expect(css).toContain("var(--wb-split-min-preview)");
  });

  it("orders the docked variants after the rules they must outrank", async () => {
    // `[data-preview]` and `[data-collapsed]` have the same specificity, so
    // source order is the whole mechanism.
    const css = await globals();
    expect(css.indexOf('.wb-shell[data-collapsed="true"] {')).toBeLessThan(
      css.indexOf('.wb-shell[data-preview="true"] {'),
    );
  });

  it("carries the docked variants into both responsive blocks", async () => {
    const css = await globals();
    for (const query of ["@media (max-width: 1199px)", "@media (max-width: 899px)"]) {
      const start = css.lastIndexOf(query);
      expect(start).toBeGreaterThan(-1);
      // Bounded at the NEXT `@media`, not at end of file: slicing to EOF let the
      // 899px block satisfy the 1199px assertion, so deleting the 1199px docked
      // variant would have left this green.
      const next = css.indexOf("@media", start + query.length);
      const block = css.slice(start, next === -1 ? undefined : next);
      expect(block).toContain('[data-preview="true"]');
    }
  });

  it("releases the shell's clamp below 900px so a docked column is reachable", async () => {
    // DW-34. `.wb-shell` is `height: 100dvh; max-height: 100dvh; overflow:
    // hidden` — right for a desktop surface that must not scroll as a page, and
    // fatal here: below 900px the Preview is a fourth ROW, so that rule places
    // it past the bottom of a box that CLIPS. Not below the fold — unreachable,
    // by scroll, by `scrollIntoView`, by anything. A tap on a tree row appeared
    // to do nothing at all, which is why `Workbench`'s reveal effect cannot fix
    // this on its own.
    const css = await globals();
    const start = css.lastIndexOf("@media (max-width: 899px)");
    const next = css.indexOf("@media", start + 1);
    const block = css.slice(start, next === -1 ? undefined : next);
    const docked = block.slice(
      block.indexOf('.wb-shell[data-preview="true"],'),
      block.indexOf("}", block.indexOf('.wb-shell[data-preview="true"],')),
    );
    // All four declarations of the release, not three: `height: auto` is what
    // stops `height: 100dvh` from winning and re-clipping the fourth row, so a
    // scan that omitted it would stay green over exactly the bug this fixes.
    expect(docked).toContain("height: auto;");
    expect(docked).toContain("max-height: none;");
    expect(docked).toContain("overflow: visible;");
    // …and it comes BACK while the mode sheet is open. This is exactly the
    // breakpoint at which the rail is a fixed off-canvas sheet over a fixed
    // backdrop, so a scrolling document scrolls the page BEHIND an open modal:
    // the backdrop stays put while the content slides under it, and a pointer
    // can drag content the backdrop exists to make unreachable.
    const sheet = block.slice(
      block.indexOf('.wb-shell[data-preview="true"][data-sheet-open="true"],'),
      block.indexOf(
        "}",
        block.indexOf('.wb-shell[data-preview="true"][data-sheet-open="true"],'),
      ),
    );
    expect(sheet).toContain("max-height: 100dvh;");
    expect(sheet).toContain("overflow: hidden;");
    // Two attributes wide on the collapsed variant too, or the collapsed
    // three-attribute docked selector above would outrank it.
    expect(block).toContain(
      '.wb-shell[data-collapsed="true"][data-preview="true"][data-sheet-open="true"]',
    );
    // …and a short shell still fills the viewport rather than collapsing to its
    // content, which would leave the canvas floating above a blank page.
    expect(docked).toContain("min-height: 100dvh;");
    // The column takes the single grid column here, with the border moved to
    // the edge it now actually has.
    expect(block).toMatch(/\.wb-preview \{\s*grid-column: 1;/);
    expect(block).toContain("border-top: 1px solid var(--wb-border);");
    // The WIDE layout is untouched: the base rule still clamps, and the base
    // `.wb-preview` is still the fourth column.
    const shellStart = css.indexOf("\n.wb-shell {");
    expect(shellStart).toBeGreaterThan(-1);
    const base = css.slice(shellStart, css.indexOf("\n}", shellStart));
    expect(base).toContain("max-height: 100dvh;");
    expect(base).toContain("overflow: hidden;");
  });

  it("dresses the stale strip as chrome, with no alert colour", async () => {
    // DW-54's strip sits over bytes that are still there. UX-DR15 reserves red
    // for destructive labels, and the shell has no danger colour at all — the
    // same reasoning `.wb-preview-error` already follows.
    const css = await globals();
    const start = css.indexOf(".wb-preview-stale {");
    expect(start).toBeGreaterThan(-1);
    const rule = css.slice(start, css.indexOf("}", start));
    expect(rule).toContain("color: var(--wb-muted);");
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}|\brgb|\bred\b|--wb-danger/i);
    // WCAG 2.2 SC 2.5.8: a 24×24 CSS-pixel floor. `Retry` is the one control
    // this change adds and it exists FOR the narrow breakpoint, where the
    // column is a stacked row and the pointer is a thumb — 2px of padding at a
    // 12px face leaves roughly 20px.
    const retryStart = css.indexOf(".wb-preview-retry {");
    expect(retryStart).toBeGreaterThan(-1);
    expect(css.slice(retryStart, css.indexOf("}", retryStart))).toContain(
      "min-height: 24px;",
    );
  });

  it("declares the reading face once, in the token block, and reads it nowhere else", async () => {
    const css = await globals();
    // `workbench-chrome.test.ts` bans the literal in every rule AFTER the token
    // block and in every file under `src/components/workbench`. The token block
    // is the one remaining place, and declaring it beside `--wb-font` and
    // `--wb-font-mono` is what keeps chrome sans without editing an assertion.
    const start = css.indexOf(".wb-shell {");
    expect(start).toBeGreaterThan(-1);
    const tokens = css.slice(start, start + css.slice(start).indexOf("\n}"));
    expect(tokens).toContain("--wb-font-read:");
    expect(tokens).toContain("Georgia");
    // Exactly once in the whole stylesheet, and that once is the declaration.
    expect(css.match(/Georgia/g) ?? []).toHaveLength(1);

    // …and every READER of the token is a `.wb-preview-body` rule, so the face
    // cannot reach the header, the frontmatter strip, the trees or the canvas.
    const readers = css
      .split("}")
      .filter((rule) => rule.includes("var(--wb-font-read)"));
    expect(readers.length).toBeGreaterThan(0);
    for (const rule of readers) {
      expect(rule.slice(0, rule.indexOf("{"))).toContain(".wb-preview-body");
    }
    // The mono rule still wins inside a code fence: the body's descendant
    // carve-out is an allowlist, and these four are absent from it.
    const carve = readers.find((rule) => rule.includes(":where("));
    expect(carve).toBeTruthy();
    for (const tag of ["code", "pre", "kbd", "samp"]) {
      expect(carve).not.toMatch(new RegExp(`[\\s(]${tag}[,)]`));
    }
  });

  it("paints every link in the body from a token, including the live one", async () => {
    const css = await globals();
    // The two non-navigating states were styled from `--wb-*`; a real `<a>` —
    // the external link the Preview does follow, in a new tab — was left to the
    // user agent, so it alone rendered in browser blue and visited purple. Every
    // colour in the shell comes from a token or from nowhere.
    const rules = css
      .split("}")
      .filter((rule) => /\.wb-preview-body\s+(?::where\(a\)|\.wb-wikilink|\.wb-preview-deadlink)/.test(rule));
    expect(rules.length).toBeGreaterThanOrEqual(3);
    for (const rule of rules) {
      if (!rule.includes("color:")) continue;
      expect(rule).toMatch(/color:\s*var\(--wb-/);
    }
    expect(css).toMatch(/\.wb-preview-body :where\(a\) \{[^}]*color: var\(--wb-/);
  });

  it("indents the tree from a token, not from a number in the component", async () => {
    const css = await globals();
    expect(css).toContain("--wb-tree-indent: 12px;");
    expect(css).toContain("var(--wb-tree-indent)");
    const panel = await read("TreePanel.tsx");
    expect(panel).toContain('"--wb-depth"');
  });
});
