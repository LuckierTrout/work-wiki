import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsPage from "@/app/settings/page";
import { EMBEDDING_REBUILD_READ_ONLY_COPY } from "@/components/EmbeddingSettings";
import { SETTINGS_READ_ONLY_COPY } from "@/lib/workbench-settings";

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

/**
 * The sibling panels, stubbed — but RECORDING what the page handed them.
 *
 * Each of these fetches its own endpoint on mount, which is why they are
 * stubbed at all. Rendering nothing was enough while the page passed them
 * nothing; now it passes `readOnly` (DW-386), and a stub that discarded its
 * props would let `<NamesTermsSettings readOnly={readOnly} />` be reverted to
 * `<NamesTermsSettings />` with this whole file still green — the two surfaces
 * would go back to looking live in front of their 403s and nothing would say
 * so. So the props are captured and asserted below.
 */
const namesTermsProps: Array<Record<string, unknown>> = [];
const emailIngestProps: Array<Record<string, unknown>> = [];

vi.mock("@/components/WorkspacePurposeSettings", () => ({
  WorkspacePurposeSettings: () => null,
}));
vi.mock("@/components/NamesTermsSettings", () => ({
  NamesTermsSettings: (props: Record<string, unknown>) => {
    namesTermsProps.push(props);
    return null;
  },
}));
vi.mock("@/components/EmailIngestSettings", () => ({
  EmailIngestSettings: (props: Record<string, unknown>) => {
    emailIngestProps.push(props);
    return null;
  },
}));
vi.mock("@/components/VaultExportButton", () => ({
  VaultExportButton: () => null,
}));

const VERSION = "w1:1a-1111111122222222";

/**
 * `GET /api/settings` with stored values in every field this page renders.
 *
 * `ollama` so the base-URL input renders at all, and every `*Source` is
 * `config` so each field takes its EDITABLE branch — the locked `env` branch
 * renders a read-only `<output>` with no value to edit, which would make the
 * "still readable and still in the tab order" assertions vacuous. Nothing in
 * this file renders a locked box at all, so no case here may claim anything
 * about one.
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
  namesTermsProps.length = 0;
  emailIngestProps.length = 0;
});

/** What the page last handed a recorded panel. */
function lastProps(recorded: Array<Record<string, unknown>>): Record<string, unknown> {
  expect(recorded.length).toBeGreaterThan(0);
  return recorded[recorded.length - 1];
}

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

  it("points every control the FORM refuses at the form's refusal sentence", async () => {
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
    ];
    // **Rebuild Vector Index** is deliberately NOT here. It stands in front of
    // a different door — `POST /api/settings/rebuild-embeddings` — and reads
    // that door's sentence instead (DW-387); the case below is where it is
    // pinned.

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

  it("names that one sentence at index 0 on every one of them (DW-560)", async () => {
    // MEMBERSHIP is the case above; this is POSITION, over the same list.
    // `EmbeddingSettings` used to put the page's read-only id LAST while every
    // other control on this page put it FIRST — one sentence, one page, two
    // positions in the announced description depending on which box the owner
    // reached. The banner renders above the whole form, so index 0 is its DOM
    // reading-order position and the divergence had no defence.
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
    ];
    // The same list, and the same deliberate exclusion: **Rebuild Vector
    // Index** stands in front of a different door and names that door's own
    // sentence (DW-387), never the banner.

    const leading = new Set<string>();
    for (const control of refused) {
      const label = control.id || control.textContent || "";
      const described = control.getAttribute("aria-describedby");
      // Asserted PRESENT before it is split, so a control that stopped
      // describing anything at all fails as this claim rather than as a bare
      // `TypeError` from dereferencing null.
      expect(described, label).toBeTruthy();
      const ids = described!.split(" ").filter(Boolean);
      expect(ids.length, label).toBeGreaterThan(0);
      const first = document.getElementById(ids[0]);
      expect(first, `${label} -> ${ids[0]}`).not.toBeNull();
      expect(first!.textContent, label).toContain("Read-only mode");
      leading.add(ids[0]);
    }
    // …and it is ONE id, not seven that each happen to lead with some
    // banner-looking node: the page mints a single `useId()` and hands the same
    // string to every one of these.
    expect(leading.size).toBe(1);
  });

  it("states the sentence PUT /api/settings actually answers (DW-387)", async () => {
    // The banner used to be a FOURTH wording of one deployment state — "This
    // deployment has explicitly disabled settings changes." — while the route
    // answered something else and the Workbench save bar a third thing. Pinned
    // against the exported constant rather than a retyped string:
    // `read-only-copy-parity.test.ts` is what ties that constant to the route,
    // and this is what ties the banner to the constant.
    render(<SettingsPage />);
    await waitFor(() =>
      expect((field("provider") as HTMLSelectElement).value).toBe("ollama"),
    );

    const describedIds = field("model").getAttribute("aria-describedby")!.split(" ");
    const banner = document.getElementById(describedIds[0]);
    expect(banner).not.toBeNull();
    // The label three suites identify this banner by, and the pinned sentence
    // after it.
    expect(banner!.textContent).toContain("Read-only mode");
    expect(banner!.textContent).toContain(SETTINGS_READ_ONLY_COPY);
  });

  it("hands the served readOnly down to Names & Terms and Email ingestion (DW-386)", async () => {
    // The page is the only thing that knows the flag for these two — they take
    // it as a prop rather than making a second read-only fetch — so this is the
    // only place the wiring exists to be broken.
    render(<SettingsPage />);
    await waitFor(() =>
      expect((field("provider") as HTMLSelectElement).value).toBe("ollama"),
    );

    await waitFor(() => expect(lastProps(namesTermsProps).readOnly).toBe(true));
    expect(lastProps(emailIngestProps).readOnly).toBe(true);
    // And NOT the banner's id: each of those sections states what ITS OWN door
    // answers, and the banner is `PUT /api/settings`'s (DW-387).
    expect(lastProps(namesTermsProps).describedBy).toBeUndefined();
    expect(lastProps(emailIngestProps).describedBy).toBeUndefined();
  });

  it("points Rebuild at the EMBEDDINGS sentence, not the form's (DW-387)", async () => {
    // `/settings` used to state three different sentences for one deployment
    // state — the banner, `PUT /api/settings` and this button's door — and this
    // button read the FORM's. A rebuild changes no setting at all, so the owner
    // read one sentence before pressing and would have met another in the 403.
    render(<SettingsPage />);
    await waitFor(() =>
      expect((field("provider") as HTMLSelectElement).value).toBe("ollama"),
    );

    const rebuild = screen.getByRole("button", { name: "Rebuild Vector Index" });
    const ids = (rebuild.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .filter(Boolean);
    expect(ids).toHaveLength(1);
    const note = document.getElementById(ids[0]);
    expect(note).not.toBeNull();
    // Read off the DOM against the exported constant rather than a retyped
    // string: `read-only-copy-parity.test.ts` is what pins that constant to
    // what the route answers, and this is what pins the button to the constant.
    expect(note!.textContent).toBe(EMBEDDING_REBUILD_READ_ONLY_COPY);
    // …and NOT the banner, which is the whole defect.
    expect(note!.textContent).not.toContain("Read-only mode");
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
    expect(document.body.textContent).not.toContain(SETTINGS_READ_ONLY_COPY);
    // The flag reaches the two prop-fed sections as FALSE — without this half a
    // page hardcoding `readOnly` would pass the read-only case above while
    // refusing both surfaces on a deployment that writes fine.
    expect(lastProps(namesTermsProps).readOnly).toBe(false);
    expect(lastProps(emailIngestProps).readOnly).toBe(false);
    const controls = [
      field("provider"),
      field("model"),
      field("structuredKnowledgeProvider"),
      field("embeddingModel"),
      screen.getByRole("button", { name: "Save Settings" }),
      screen.getByRole("button", { name: "Rebuild Vector Index" }),
    ];
    const label = (c: HTMLElement) => c.id || c.textContent || "";
    for (const control of controls) {
      expect(control.hasAttribute("aria-disabled"), label(control)).toBe(false);
    }

    // Nothing REFUSES, so nothing describes a refusal. Three controls are split
    // out rather than dropped: the picker describes its credential state
    // (DW-420) and the two model boxes describe their default-model hints
    // (DW-506). None of those is a refusal, and a suite that pins refusal must
    // not mistake them for one — so they assert what they DO say instead.
    const DESCRIBES_SOMETHING = new Set(["provider", "model", "embeddingModel"]);
    for (const control of controls.filter((c) => !DESCRIBES_SOMETHING.has(c.id))) {
      expect(control.getAttribute("aria-describedby"), label(control)).toBeNull();
    }
    // Every id those three name resolves, and none of the nodes is the
    // read-only banner — which this deployment does not render at all. That is
    // the suite's actual claim about them: no refusal is being announced.
    for (const control of controls.filter((c) => DESCRIBES_SOMETHING.has(c.id))) {
      const ids = (control.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .filter(Boolean);
      expect(ids.length, label(control)).toBeGreaterThan(0);
      for (const id of ids) {
        const node = document.getElementById(id);
        expect(node, `${label(control)} -> ${id}`).not.toBeNull();
        expect(node!.textContent, `${label(control)} -> ${id}`).not.toContain(
          "Read-only mode",
        );
      }
    }
    // The model boxes name EXACTLY their hints on a writable deployment: the
    // read-only sentence is the only other thing that composes into either.
    expect(field("model").getAttribute("aria-describedby")).toBe("providerModelHint");
    expect(field("embeddingModel").getAttribute("aria-describedby")).toBe(
      "embeddingModelHint",
    );

    // The picker names EXACTLY its credential line — not the read-only
    // sentence, which this deployment does not render at all.
    const describedIds = (field("provider").getAttribute("aria-describedby") ?? "")
      .split(" ")
      .filter(Boolean);
    expect(describedIds).toEqual(["providerCredentialStatus"]);
    const credentialNode = document.getElementById("providerCredentialStatus");
    expect(credentialNode).not.toBeNull();
    // What the owner actually HEARS, read off the fixture: the payload stores
    // `ollama` with a key, and the form has not been touched yet, so the line
    // is the confirming one. This is the only suite where the real served
    // payload reaches the sentence, so it is the only place the wiring from
    // `hasApiKey` through to the announced words can be pinned.
    expect(credentialNode!.textContent).toBe("✓ API key configured on server");
    expect(credentialNode!.textContent).not.toContain("Read-only mode");

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
