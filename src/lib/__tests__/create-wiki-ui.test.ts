/**
 * Story 1.2 — the UI invariants the AC states, pinned by source scan.
 *
 * This is the `node` project, so it reads the components as text following the
 * `single-ia.test.ts` convention. What it pins is what a scan is genuinely good
 * at: that nobody reintroduces a blank Wiki option, drops `aria-modal` from the
 * one confirm overlay, edits the empty-state copy the AC quotes verbatim, or
 * puts a second Wiki switcher back on the canvas.
 *
 * `vitest.config.ts` now ships a second `dom` project, so the behaviour a scan
 * cannot see is asserted on rendered DOM instead — `create-wiki-flow.test.tsx`
 * for this card's dialogs, and `workbench/__tests__/wiki-canvas-duplication.test.tsx`
 * for the one-of-each counts in the assembled shell. Prefer those for anything
 * observable; keep the scans here for source-shape invariants only.
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  CREATABLE_SCENARIOS,
  SCENARIO_LABELS,
  WIKI_ARTIFACT_FILES,
} from "../wiki-scenarios";

const COMPONENTS = path.resolve(__dirname, "../../components");

function read(component: string): Promise<string> {
  return readFile(path.join(COMPONENTS, component), "utf8");
}

/**
 * Source with its comments removed, matching `workbench-split.test.ts`: a ban on
 * a label or a symbol is about what the component DOES, and the file's own prose
 * explaining where that control moved to must not read as a violation.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("CreateWikiDialog offers exactly the five Scenario Templates", () => {
  it("renders the five labels from the shared map and nothing else", async () => {
    const source = await read("CreateWikiDialog.tsx");
    expect(source).toContain("CREATABLE_SCENARIOS");
    expect(source).toContain("SCENARIO_LABELS");
    expect(CREATABLE_SCENARIOS.map((value) => SCENARIO_LABELS[value])).toEqual([
      "Research",
      "Reading",
      "Personal Growth",
      "Business",
      "General",
    ]);
  });

  it("has no blank or custom option anywhere in the picker", async () => {
    const source = await read("CreateWikiDialog.tsx");
    expect(source).not.toMatch(/custom/i);
    expect(source).not.toMatch(/\bBlank\b/);
  });

  it("preselects Business and states the no-blank-wiki rule", async () => {
    const source = await read("CreateWikiDialog.tsx");
    expect(source).toContain('DEFAULT_SCENARIO: CreatableScenario = "business"');
    expect(source.replace(/\s+/g, " ")).toContain(
      "Pick one Scenario Template. This writes purpose.md, Schema, and this wiki’s own Workspace Purpose. There is no blank wiki.",
    );
  });

  it("labels the name input with a real label, not a placeholder", async () => {
    const source = await read("CreateWikiDialog.tsx");
    expect(source).toContain("Wiki name");
    expect(source).toMatch(/htmlFor=\{nameId\}/);
    expect(source).not.toContain("placeholder=");
    // The cap is the server parser's, imported — not a restated literal.
    expect(source).toContain("maxLength={MAX_WIKI_NAME_CHARS}");
  });

  it("is one accessible overlay level with a single primary action", async () => {
    const source = await read("CreateWikiDialog.tsx");
    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
    expect(source).toContain("aria-labelledby");
    // Toggle-button semantics, not `aria-current` (which means "current item
    // in a set of navigation links" and announces no selection here).
    expect(source).toContain("aria-pressed={selected}");
    expect(source).not.toMatch(/aria-current=/);
    expect(source.match(/btn primary/g) ?? []).toHaveLength(1);
    expect(source).toContain("btn ghost");
  });
});

describe("both dialogs share one accessibility implementation", () => {
  it("neither dialog forks the focus trap", async () => {
    for (const component of ["ConfirmDialog.tsx", "CreateWikiDialog.tsx"]) {
      const source = await read(component);
      expect(source).toContain("useDialogA11y");
      expect(source).toContain('role="dialog"');
      expect(source).toContain('aria-modal="true"');
      expect(source).toContain("aria-labelledby");
      // The trap itself lives in the hook — a copy here is the regression.
      expect(source).not.toContain("focusables");
      expect(source).not.toContain('event.key !== "Tab"');
    }
  });

  it("the shared hook traps Tab, restores focus, locks scroll, and spares select-Esc", async () => {
    const hook = await readFile(
      path.resolve(__dirname, "../../hooks/useDialogA11y.ts"),
      "utf8",
    );
    expect(hook).toContain("dialogRef.current?.focus()");
    expect(hook).toContain("opener.focus()");
    expect(hook).toContain('document.body.style.overflow = "hidden"');
    expect(hook).toContain("stopPropagation");
    expect(hook).toContain('event.key !== "Tab"');
    // Focus that has drifted outside is pulled back in, not left to walk the
    // background; and an open <select> dropdown eats its own Esc.
    expect(hook).toContain("root.contains(active)");
    expect(hook).toContain("HTMLSelectElement");
  });

  it("does not restore focus to an opener the action unmounted", async () => {
    const hook = await readFile(
      path.resolve(__dirname, "../../hooks/useDialogA11y.ts"),
      "utf8",
    );
    // Creating the first wiki replaces the empty state that held the opening
    // button, so `opener.focus()` on the detached node drops the keyboard user
    // on <body>. The caller's fallback landmark takes over.
    expect(hook).toContain("opener?.isConnected");
    expect(hook).toContain("fallbackRef.current?.current?.focus()");

    const workbench = await read("WikiWorkbench.tsx");
    expect(workbench.match(/fallbackFocusRef=\{headingRef\}/g) ?? []).toHaveLength(2);
    expect(workbench).toContain("tabIndex={-1}");
  });
});

describe("WikiWorkbench empty state and preview copy", () => {
  it("uses the AC's exact sentences", async () => {
    const source = await read("WikiWorkbench.tsx");
    expect(source).toContain("No wiki yet.");
    expect(source).toContain("Select a file to preview.");
  });

  it("offers a single primary Create Wiki action on the empty state", async () => {
    const source = await read("WikiWorkbench.tsx");
    expect(source).toContain("Create Wiki");
    expect(source.match(/btn primary/g) ?? []).toHaveLength(1);
  });

  it("lists the two seeded files and warns that both are overwritten", async () => {
    const source = await read("WikiWorkbench.tsx");
    // One list of artifact names, shared with the server module.
    expect(source).toContain("WIKI_ARTIFACT_FILES");
    expect(WIKI_ARTIFACT_FILES).toEqual(["purpose.md", "schema.md"]);
    expect(source).toContain("Change template");
    const warning = source.replace(/\s+/g, " ");
    // The Workspace Purpose is per-wiki and a re-template rewrites it too, so
    // the confirm has to name it, say what is LOST (a purpose hand-authored in
    // Settings, not just a file), and say the blast radius stops at this wiki.
    expect(warning).toContain(
      "This overwrites purpose.md, Schema, and the Workspace Purpose for this wiki — a purpose you wrote in Settings will be replaced by the new template’s. Other wikis, Pages and Sources are not changed.",
    );
  });

  it("blocks the destructive confirm when the template would not change", async () => {
    const source = await read("WikiWorkbench.tsx");
    expect(source).toContain("confirmDisabled={pendingScenario === current?.scenario}");
  });

  it("reports a failed overwrite inside the overlay, not behind it", async () => {
    // The confirm dialog stays open on failure and its backdrop covers the
    // section, so an error rendered by the host is invisible: the owner would
    // see the spinner stop and nothing else.
    const dialog = await read("ConfirmDialog.tsx");
    expect(dialog).toContain('role="alert"');
    expect(dialog).toContain("{error}");

    const workbench = await read("WikiWorkbench.tsx");
    expect(workbench).toContain("setTemplateError(");
    expect(workbench).toContain("error={templateError}");
  });

  it("locks the controls that a request in flight would otherwise contradict", async () => {
    const workbench = await read("WikiWorkbench.tsx");
    // The scenario <select> lives inside the confirm dialog: changing it
    // mid-request would display a template that was not the one applied.
    expect(workbench).toContain("disabled={busy}");
    // Overlapping switches settle out of order and roll back to a stale id.
    // The guard follows the switcher: DW-33 retired this card's copy, so the
    // left column header is where the invariant now lives — retargeted, not
    // dropped.
    const switcher = await read("workbench/WikiSwitcher.tsx");
    expect(switcher).toContain("disabled={switching}");
    expect(switcher).toContain("if (switching) return;");
  });

  it("leaves switching and the persistent create control to the header (DW-33)", async () => {
    // The canvas card and the left column header both shipped a switcher and a
    // create button, so Wiki mode put two of each in one viewport. The header
    // is the single owner; these negatives are what stops the card's copies
    // coming back.
    // The MECHANICS, not one label spelling: a returning duplicate need not
    // reuse the old copy. So the bans are on the machinery a wiki switcher
    // cannot do without — enumerating `wikis` as options, the write route, the
    // handler and its in-flight flag — plus the labels, matched
    // case-insensitively over comment-stripped source so the file's own prose
    // about the header is not a finding. The rendered COUNT is asserted in
    // `workbench/__tests__/wiki-canvas-duplication.test.tsx`, which is where a
    // relabelled control is caught.
    const workbench = stripComments(await read("WikiWorkbench.tsx"));
    expect(workbench).not.toContain("wikis.map");
    expect(workbench).not.toContain("switchWiki");
    expect(workbench).not.toContain("setSwitching");
    expect(workbench).not.toContain("wiki-workbench-switcher");
    expect(workbench).not.toContain("/api/wikis/current");
    expect(workbench).not.toMatch(/new wiki/i);
    expect(workbench).not.toMatch(/active wiki/i);

    const switcher = await read("workbench/WikiSwitcher.tsx");
    expect(switcher).toContain("Active wiki");
    expect(switcher).toContain("/api/wikis/current");
    expect(switcher).toContain("New Wiki");
  });

  it("hands the preview sentence's visibility to the shell's own state (DW-39)", async () => {
    // A docked Preview column and "Select a file to preview." describe the same
    // slot, so both on screen at once is a contradiction. The canvas reaches the
    // shell as `children` and cannot read `previewOpen`, so the class is the
    // seam and the stylesheet decides. (The rule is EXERCISED — not just
    // spelled — in `workbench/__tests__/wiki-canvas-duplication.test.tsx`.)
    const workbench = await read("WikiWorkbench.tsx");
    expect(workbench).toContain("wb-canvas-preview-note");

    const css = await readFile(
      path.resolve(__dirname, "../../app/globals.css"),
      "utf8",
    );
    expect(css).toContain(
      '.wb-shell[data-preview="true"] .wb-canvas-preview-note {',
    );
  });

  it("does not offer Create Wiki when the registry could not be read", async () => {
    // "No wiki yet." is a claim about the registry. On a read failure the
    // workbench cannot make it, and its primary action would seed a duplicate
    // wiki and move every prompt onto its template on a transient error.
    const workbench = await read("WikiWorkbench.tsx");
    expect(workbench).toContain("unavailable");
    expect(workbench).toContain("Your wikis couldn’t be loaded.");

    const page = await readFile(
      path.resolve(__dirname, "../../app/page.tsx"),
      "utf8",
    );
    expect(page).toContain("unavailable: true");
    expect(page).toContain("unavailable={wikiRegistry.unavailable}");
  });

  it("resets the create dialog on close, so reopening never paints a stale attempt", async () => {
    const source = await read("CreateWikiDialog.tsx");
    expect(source).toContain("if (open) return;");
    expect(source).not.toContain("if (!open) return;\n    setScenario");
  });

  it("leaves the landing page h1 to the Workbench shell", async () => {
    // The Workbench shell owns the landing page <h1> (the wb-title masthead —
    // pinned as one token so the class can't drift off the h1); WikiWorkbench
    // must not add another.
    const workbench = await read("WikiWorkbench.tsx");
    const shell = await read("workbench/Workbench.tsx");
    expect(workbench).not.toMatch(/<h1[\s>]/);
    expect(shell).toMatch(/<h1 className="wb-title">/);
  });

  it("refetches the server tree after each of its own kernel writes", async () => {
    const source = await read("WikiWorkbench.tsx");
    // Two writes left on this card, and both make the server render stale:
    // `create` (seeds a wiki and makes it active) and `applyTemplate`
    // (rewrites purpose.md, Schema and the Workspace Purpose — the live wiki
    // does not change, the bytes behind it do). The third was `switchWiki`,
    // which went with the retired switcher (DW-33); the header's own switch
    // refreshes in `WikiSwitcher.tsx`.
    expect(source.match(/router\.refresh\(\)/g) ?? []).toHaveLength(2);
  });
});

describe("one label map", () => {
  it("is the only scenario-label source the Settings form uses", async () => {
    const source = await read("WorkspacePurposeSettings.tsx");
    expect(source).toContain('import { SCENARIO_LABELS } from "@/lib/wiki-scenarios"');
    expect(source).not.toMatch(/const SCENARIO_LABELS/);
    // The draft-loaded feedback names the same label as the <select>, rather
    // than the template's own `name` ("General knowledge" vs "General").
    expect(source).toContain("SCENARIO_LABELS[selectedTemplate.scenario]");
    expect(source).not.toContain("${selectedTemplate.name}");
  });
});
