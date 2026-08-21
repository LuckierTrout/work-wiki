import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsPage from "@/app/settings/page";

/**
 * `/settings` on a read-only deployment, MOUNTED (DW-299).
 *
 * The page wrapped its whole form in `<fieldset disabled={readOnly}>`, which is
 * the DW-191 defect verbatim: `disabled` on a fieldset takes EVERY descendant
 * out of the tab order, so the stored provider, model, base URL and embedding
 * model — the values a read-only deployment leaves an owner to READ — became
 * unreachable by keyboard and by screen reader, and **Test Connection**, which
 * writes nothing at all, was refused along with them purely by being inside.
 *
 * Nothing unit-testable connects the served `readOnly` flag to a rendered
 * control: `useSettings` merely re-exports the field, and the three panels take
 * a prop. So the page, the hook and all three panels are real here; only the
 * unrelated sibling panels below the form are stubbed, each of which fetches
 * its own endpoint on mount — the `settings-page-legacy-surface-parity.tsx`
 * technique.
 */

vi.mock("@/components/WorkspacePurposeSettings", () => ({
  WorkspacePurposeSettings: () => null,
}));
vi.mock("@/components/NamesTermsSettings", () => ({
  NamesTermsSettings: () => null,
}));
vi.mock("@/components/EmailIngestSettings", () => ({
  EmailIngestSettings: () => null,
}));
vi.mock("@/components/VaultExportButton", () => ({
  VaultExportButton: () => null,
}));

const VERSION = "w1:1a-1111111122222222";

/**
 * `GET /api/settings` with stored values in every field this page renders.
 *
 * `ollama` so the base-URL input renders at all, and every `*Source` is
 * `config` so each field takes its EDITABLE branch — the locked `env` branch is
 * a plain `<div>` and would make the "still readable" assertions vacuous.
 */
function body(overrides: Record<string, unknown> = {}) {
  return {
    provider: "ollama",
    providerSource: "config",
    model: "llama3.1",
    modelSource: "config",
    configured: true,
    embeddingSupport: true,
    embeddingModel: "nomic-embed-text",
    embeddingModelSource: "config",
    embeddingModelInEffect: null,
    embeddingModelOverridden: false,
    hasApiKey: true,
    ollamaBaseUrl: "http://localhost:11434/api",
    ollamaBaseUrlSource: "config",
    structuredKnowledgeProvider: "openai",
    structuredKnowledgeProviderSource: "config",
    structuredKnowledgeModel: "gpt-4o-mini",
    structuredKnowledgeModelSource: "config",
    structuredKnowledgeConfigured: true,
    readOnly: true,
    version: VERSION,
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function stubFetch(payload: unknown) {
  fetchMock = vi.fn(async (url: unknown) => {
    const href = String(url);
    const answer = href === "/api/settings" ? payload : {};
    return { ok: true, status: 200, json: async () => answer } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
}

/** Requests this page issued that were not the two mount GETs. */
function writeCalls(): unknown[][] {
  return fetchMock.mock.calls.filter((call) => {
    const method = (call[1] as RequestInit | undefined)?.method;
    return method !== undefined && method !== "GET";
  });
}

/**
 * One of the form's controls, by its DOM id.
 *
 * By id rather than by label text: three of these labels carry a `SourceBadge`
 * inside them, so their accessible name is "Providerconfig" and the like — an
 * artefact of the badge that has nothing to do with what this suite is about.
 * The ids are the stable handles the `<label htmlFor>` already points at.
 */
function field(id: string): HTMLInputElement | HTMLSelectElement {
  const control = document.getElementById(id);
  if (!control) throw new Error(`no control with id "${id}" is rendered`);
  return control as HTMLInputElement | HTMLSelectElement;
}

afterEach(() => {
  // FIRST, for the reason `useSettings.test.tsx` documents: vitest runs
  // afterEach hooks in reverse registration order, so the setup file's
  // `cleanup()` lands after this one and would unmount with `fetch` unstubbed.
  cleanup();
  vi.unstubAllGlobals();
});

describe("/settings refuses per control, not by disabling the form (DW-299)", () => {
  beforeEach(() => {
    stubFetch(body());
  });

  it("keeps every stored value readable and in the tab order", async () => {
    render(<SettingsPage />);

    await waitFor(() =>
      expect((field("provider") as HTMLSelectElement).value).toBe("ollama"),
    );

    // THE assertion this change exists for. Each control still carries its
    // stored value AND is still reachable — `readOnly` on the text inputs,
    // `aria-disabled` on the selects, `disabled` on none of them.
    for (const [id, value] of [
      ["provider", "ollama"],
      ["model", "llama3.1"],
      ["ollamaBaseUrl", "http://localhost:11434/api"],
      ["structuredKnowledgeProvider", "openai"],
      ["structuredKnowledgeModel", "gpt-4o-mini"],
      ["embeddingModel", "nomic-embed-text"],
    ] as const) {
      const control = field(id);
      expect(control.value, id).toBe(value);
      expect(control.hasAttribute("disabled"), id).toBe(false);
    }
  });

  it("points every refused control at the one refusal sentence", async () => {
    render(<SettingsPage />);
    await waitFor(() =>
      expect((field("provider") as HTMLSelectElement).value).toBe("ollama"),
    );

    const refused: HTMLElement[] = [
      field("provider"),
      field("model"),
      field("ollamaBaseUrl"),
      field("structuredKnowledgeProvider"),
      field("structuredKnowledgeModel"),
      field("embeddingModel"),
      screen.getByRole("button", { name: "Save Settings" }),
      screen.getByRole("button", { name: "Rebuild Vector Index" }),
    ];

    for (const control of refused) {
      const described = control.getAttribute("aria-describedby");
      expect(described, control.id || control.textContent || "").toBeTruthy();
      // Every id in the list resolves to a node actually in the document — the
      // property that makes the description real rather than decorative. The
      // embedding box legitimately names more than one (its own notes compose
      // with this one), so the whole list is walked.
      const ids = described!.split(" ").filter(Boolean);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(document.getElementById(id)).not.toBeNull();
      // …and one of them is the read-only banner.
      expect(
        ids.some((id) =>
          (document.getElementById(id)?.textContent ?? "").includes("Read-only mode"),
        ),
      ).toBe(true);
    }
  });

  it("marks the write controls aria-disabled and leaves them focusable", async () => {
    render(<SettingsPage />);
    await waitFor(() =>
      expect((field("provider") as HTMLSelectElement).value).toBe("ollama"),
    );

    for (const control of [
      field("provider"),
      field("structuredKnowledgeProvider"),
      screen.getByRole("button", { name: "Save Settings" }),
      screen.getByRole("button", { name: "Rebuild Vector Index" }),
    ]) {
      expect(control.getAttribute("aria-disabled")).toBe("true");
      expect(control.hasAttribute("disabled")).toBe(false);
    }

    // The text boxes take `readOnly` instead — a <select> has none, which is
    // why the two halves refuse differently.
    for (const control of [
      field("model"),
      field("ollamaBaseUrl"),
      field("structuredKnowledgeModel"),
      field("embeddingModel"),
    ] as HTMLInputElement[]) {
      expect(control.readOnly).toBe(true);
    }
  });

  it("leaves Test Connection enabled — it writes nothing", async () => {
    render(<SettingsPage />);
    await waitFor(() =>
      expect((field("provider") as HTMLSelectElement).value).toBe("ollama"),
    );

    const test = screen.getByRole("button", { name: "Test Connection" });
    expect(test.hasAttribute("disabled")).toBe(false);
    expect(test.hasAttribute("aria-disabled")).toBe(false);

    fireEvent.click(test);

    // …and it actually runs: the old fieldset refused it purely by being its
    // ancestor, which is the sighted half of the same defect.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/settings/test")),
      ).toBe(true),
    );
  });

  it("makes no request when Save or Rebuild is pressed", async () => {
    render(<SettingsPage />);
    await waitFor(() =>
      expect((field("provider") as HTMLSelectElement).value).toBe("ollama"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Rebuild Vector Index" }));
    await Promise.resolve();

    // `aria-disabled` alone is advisory — the handlers are what refuse.
    expect(writeCalls()).toEqual([]);
  });

  it("refuses the select edits themselves", async () => {
    render(<SettingsPage />);
    await waitFor(() =>
      expect((field("provider") as HTMLSelectElement).value).toBe("ollama"),
    );

    fireEvent.change(field("provider"), { target: { value: "openai" } });

    // The returning `onChange` is what makes `aria-disabled` honest: a picker
    // that announced "dimmed" and then changed anyway would be worse than one
    // that was simply `disabled`.
    expect((field("provider") as HTMLSelectElement).value).toBe("ollama");
  });
});

describe("/settings is unchanged on a writable deployment — the control case", () => {
  beforeEach(() => {
    stubFetch(body({ readOnly: false }));
  });

  it("refuses nothing, describes nothing, and still saves", async () => {
    render(<SettingsPage />);
    await waitFor(() =>
      expect((field("provider") as HTMLSelectElement).value).toBe("ollama"),
    );

    expect(document.body.textContent).not.toContain("Read-only mode");
    for (const control of [
      field("provider"),
      field("model"),
      field("structuredKnowledgeProvider"),
      field("embeddingModel"),
      screen.getByRole("button", { name: "Save Settings" }),
      screen.getByRole("button", { name: "Rebuild Vector Index" }),
    ]) {
      expect(control.hasAttribute("aria-disabled")).toBe(false);
      expect(control.getAttribute("aria-describedby")).toBeNull();
    }

    // The select still moves, and the save still goes out — without this every
    // assertion in the suite above would also pass against a page that had
    // simply stopped working.
    fireEvent.change(field("provider"), { target: { value: "openai" } });
    expect((field("provider") as HTMLSelectElement).value).toBe("openai");

    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));
    await waitFor(() => expect(writeCalls().length).toBeGreaterThan(0));
    expect(String(writeCalls()[0][0])).toContain("/api/settings");
  });
});
