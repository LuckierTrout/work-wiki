/**
 * Story 1.2 — the UI invariants the AC states, pinned by source scan.
 *
 * Vitest runs `environment: "node"` and only `src/**\/__tests__/**\/*.test.ts`:
 * there is no jsdom and no testing-library, and adding them is out of scope for
 * this story. So this follows the `single-ia.test.ts` convention and reads the
 * components as text. What it really pins is that nobody reintroduces a blank
 * Wiki option, drops `aria-modal` from the one confirm overlay, or edits the
 * empty-state copy the AC quotes verbatim.
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
      "Pick one Scenario Template. This writes purpose.md and Schema. There is no blank wiki.",
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
    expect(warning).toContain(
      "This overwrites purpose.md and Schema for this wiki. Pages and Sources are not changed.",
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
    expect(workbench).toContain("disabled={switching}");
    expect(workbench).toContain("if (switching) return;");
  });

  it("does not offer Create Wiki when the registry could not be read", async () => {
    // "No wiki yet." is a claim about the registry. On a read failure the
    // workbench cannot make it, and its primary action would rewrite the
    // tenant workspace profile on the strength of a transient error.
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

  it("refetches the server tree after a mutation that rewrites the profile", async () => {
    const source = await read("WikiWorkbench.tsx");
    expect(source.match(/router\.refresh\(\)/g) ?? []).toHaveLength(3);
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
