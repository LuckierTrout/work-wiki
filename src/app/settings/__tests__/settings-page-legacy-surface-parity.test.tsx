import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsPage from "@/app/settings/page";
import {
  SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY,
  storedVectorInputs,
  vectorSearchInactiveCopy,
  type WorkbenchSettingsPayload,
} from "@/lib/workbench-settings";

/**
 * The legacy flat `/settings` page saying what it can and cannot do, MOUNTED.
 *
 * Two claims this page used to get wrong, and both of them live in the WIRING
 * rather than in any one function:
 *
 *   - DW-327. `GET /api/settings` has served the whole `workbench` object since
 *     Story 1.9, and this page rendered nothing about vector search at all — so
 *     a flat save the DW-303 scoping now ALLOWS lands on a store whose switch is
 *     on and inactive, with no signal anywhere on the page that it is. Nothing
 *     unit-testable connects the served payload to a rendered sentence: the copy
 *     function is pinned in `workbench-settings.test.ts` and the component takes
 *     the sentence as a prop, so between them the hook could pass `null` forever
 *     and stay green.
 *   - DW-61. The provider picker offers `Custom` and renders neither a base URL
 *     nor an API key, so a save there stored a provider `llm.ts` refuses to
 *     construct — three runtime errors pointing at fields the owner had just
 *     failed to find.
 *
 * So the page, the hook, `ProviderForm` and `EmbeddingSettings` are all real
 * here; only the unrelated panels below the form are stubbed, each of which
 * fetches its own endpoint on mount — the technique
 * `settings-page-embedding-wiring.test.tsx` documents.
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

/** The `workbench` object as `getWorkbenchSettings()` builds it, fresh. */
function workbench(
  overrides: Partial<WorkbenchSettingsPayload> = {},
): WorkbenchSettingsPayload {
  return {
    version: VERSION,
    chatProvider: null,
    chatModel: null,
    ingestProvider: null,
    ingestModel: null,
    customBaseUrl: null,
    hasCustomApiKey: false,
    llmTimeoutSeconds: null,
    vectorSearchEnabled: false,
    embeddingProvider: null,
    embeddingModel: null,
    embeddingBaseUrl: null,
    hasEmbeddingApiKey: false,
    embeddingModelInEffect: null,
    embeddingModelOverridden: false,
    envEmbeddingProvider: null,
    envEmbeddingModel: null,
    envCustomBaseUrl: null,
    envEmbeddingApiKeyProviders: [],
    hasWorkersAiBinding: false,
    firecrawlBaseUrl: null,
    hasFirecrawlApiKey: false,
    language: "English",
    readOnly: false,
    ...overrides,
  };
}

/** The flat legacy half of the body, which this page has always read. */
function body(overrides: Record<string, unknown> = {}) {
  return {
    provider: "openai",
    providerSource: "config",
    model: "gpt-4o",
    modelSource: "config",
    configured: true,
    embeddingSupport: true,
    embeddingModel: null,
    // `config` rather than `env`, so the EDITABLE input renders and the
    // `aria-describedby` assertions have a control to make them about.
    embeddingModelSource: "config",
    embeddingModelInEffect: null,
    embeddingModelOverridden: false,
    hasApiKey: true,
    ollamaBaseUrl: null,
    ollamaBaseUrlSource: "none",
    structuredKnowledgeProvider: null,
    structuredKnowledgeProviderSource: "none",
    structuredKnowledgeModel: null,
    structuredKnowledgeModelSource: "none",
    structuredKnowledgeConfigured: false,
    readOnly: false,
    version: VERSION,
    workbench: workbench(),
    ...overrides,
  };
}

/**
 * Answer `/api/settings` with `payload`; answer everything else blandly —
 * `/api/status` shares the global and is fetched on the same mount, so an
 * unhandled probe would settle outside `act`.
 */
function stubFetch(payload: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const href = String(url);
      const answer = href === "/api/settings" ? payload : {};
      return { ok: true, status: 200, json: async () => answer } as unknown as Response;
    }),
  );
}

/** The vector notice, or null when the page rendered none. */
function vectorNotice(): HTMLElement | null {
  return document.getElementById("embeddingVectorNotice");
}

afterEach(() => {
  // FIRST, for the reason `useSettings.test.tsx` documents: vitest runs
  // afterEach hooks in reverse registration order, so the setup file's
  // `cleanup()` lands after this one and would unmount with `fetch` unstubbed.
  cleanup();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The stored vector switch, on the page that renders no switch (DW-327)
// ---------------------------------------------------------------------------

describe("/settings surfaces the STORED vector state (DW-327)", () => {
  /** Switched ON over an `openai` selection missing its endpoint and its key. */
  const INACTIVE = workbench({
    vectorSearchEnabled: true,
    embeddingProvider: "openai",
    embeddingModel: "text-embedding-3-small",
  });

  beforeEach(() => {
    stubFetch(body({ workbench: INACTIVE }));
  });

  it("renders the flat-frame sentence for a switch that is on but inactive", async () => {
    render(<SettingsPage />);

    await waitFor(() => expect(vectorNotice()).not.toBeNull());

    // THE assertion. Byte-identical to what the copy function produces over the
    // stored inputs — the page composes nothing of its own, so a hook that
    // re-derived the legs or re-typed the frame fails here.
    expect(vectorNotice()!.textContent).toBe(
      vectorSearchInactiveCopy(storedVectorInputs(INACTIVE), "flat"),
    );
    expect(vectorNotice()!.textContent).toBe(
      "Vector search is switched on, but it needs an endpoint and an API key before it can run. Supply what is missing, or turn the switch off in Workbench Settings → Embeddings.",
    );
  });

  it("names the same unmet legs the Workbench would, and points at the switch instead of naming it", async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(vectorNotice()).not.toBeNull());
    const text = vectorNotice()!.textContent ?? "";

    // The DIAGNOSIS is the Workbench's, unchanged: same legs, same order.
    expect(text).toContain("it needs an endpoint and an API key before it can run");
    // …and the ACTION is the one an owner standing here can take. This page
    // renders no vector control at all, so "Turn it off" would be advice about
    // something that is not on the screen.
    expect(text).not.toContain("Turn it off");
    // Named IN FULL: this page's own nav row and its <h1> both read "Settings",
    // so a bare "Settings → Embeddings" would read as a path inside the page
    // the owner is already standing on.
    expect(text).toContain("Workbench Settings → Embeddings");
    expect(document.body.textContent).not.toContain("Turn it off");
  });

  it("DESCRIBES the model box without marking it invalid or blocking the save", async () => {
    // The DW-274 override note's convention. Every leg the sentence names lives
    // on the other surface, so marking the one control this page DOES render
    // would blame it for a state that is not its doing — and DW-303 exists
    // precisely so an edit here can still land over an inactive switch.
    render(<SettingsPage />);
    await waitFor(() => expect(vectorNotice()).not.toBeNull());

    const input = screen.getByLabelText(/Embedding Model/) as HTMLInputElement;
    expect(input.getAttribute("aria-describedby")).toBe("embeddingVectorNotice");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Save Settings" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("renders the notice on the LOCKED env branch too, where this state is commonest", async () => {
    // THE MUTATION THIS CATCHES. Every other vector case here seeds
    // `embeddingModelSource: "config"`, so gating the notice on the editable
    // branch (`modelSource !== "env" && …`) left the whole suite green — while
    // deleting the sentence from exactly the deployments it most targets. An
    // `EMBEDDING_MODEL`/`EMBEDDING_PROVIDER` deployment renders the model as a
    // locked, non-focusable div, and its switch is just as able to be on and
    // inactive.
    const envInactive = workbench({
      vectorSearchEnabled: true,
      // The environment owns both, so neither is editable from anywhere.
      envEmbeddingProvider: "openai",
      envEmbeddingModel: "text-embedding-3-small",
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
    });
    stubFetch(
      body({
        embeddingModel: "text-embedding-3-small",
        embeddingModelSource: "env",
        workbench: envInactive,
      }),
    );
    render(<SettingsPage />);

    await waitFor(() => expect(vectorNotice()).not.toBeNull());
    expect(vectorNotice()!.textContent).toBe(
      vectorSearchInactiveCopy(storedVectorInputs(envInactive), "flat"),
    );
    // The locked branch really is what rendered — there is no editable box.
    expect(screen.queryByLabelText(/Embedding Model/)).toBeNull();
    expect(document.getElementById("embeddingModel")).toBeNull();
    // The env-owned legs are still the endpoint and the key, named as ever.
    expect(vectorNotice()!.textContent).toContain(
      "it needs an endpoint and an API key before it can run",
    );
  });

  it("renders NOTHING when every leg is met", async () => {
    // `ollama` is self-transporting, so an endpoint and a key are not legs at
    // all — the switch is on AND working, and a working feature has nothing to
    // report.
    stubFetch(
      body({
        workbench: workbench({
          vectorSearchEnabled: true,
          embeddingProvider: "ollama",
          embeddingModel: "nomic-embed-text",
        }),
      }),
    );
    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByLabelText(/Embedding Model/)).toBeTruthy());
    expect(vectorNotice()).toBeNull();
    expect(document.body.textContent).not.toContain("Vector search");
    expect(document.querySelector("[aria-describedby]")).toBeNull();
  });

  it("renders NOTHING when the switch is off, whatever its legs look like", async () => {
    // The sentence opens "Vector search is switched on", so a switch that is off
    // must not produce it — and a switch that is off has nothing to report.
    stubFetch(
      body({
        workbench: workbench({
          vectorSearchEnabled: false,
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
        }),
      }),
    );
    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByLabelText(/Embedding Model/)).toBeTruthy());
    expect(vectorNotice()).toBeNull();
    expect(document.body.textContent).not.toContain("Vector search");
  });

  it("renders NOTHING when the served body carries no usable `workbench` object", async () => {
    // An older route, a proxy that dropped the key, a shape that does not check
    // out: `workbenchSettingsFrom` answers `null` for all three and the page
    // renders exactly as it did before this field was read at all.
    for (const broken of [
      undefined,
      null,
      {},
      // A payload missing the ONE boolean the vector rule cannot default —
      // `hasWorkersAiBinding` — which is what makes the guard a check rather
      // than a cast.
      (() => {
        const { hasWorkersAiBinding: _drop, ...rest } = INACTIVE;
        return rest;
      })(),
    ]) {
      stubFetch(body({ workbench: broken }));
      render(<SettingsPage />);
      await waitFor(() => expect(screen.getByLabelText(/Embedding Model/)).toBeTruthy());
      expect(vectorNotice()).toBeNull();
      expect(document.body.textContent).not.toContain("Vector search");
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// The Custom provider says where its other two halves live (DW-61)
// ---------------------------------------------------------------------------

describe("/settings tells a Custom selection where the endpoint and key live (DW-61)", () => {
  it("renders the advisory for a STORED custom provider, on first paint", async () => {
    // Read off the EFFECTIVE provider, so a deployment already storing `custom`
    // gets the pointer before the owner has touched the select.
    stubFetch(body({ provider: "custom", providerSource: "config" }));
    render(<SettingsPage />);

    await waitFor(() =>
      expect(screen.getByText(SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY)).toBeTruthy(),
    );
    // The OTHER surface, named in full — "Settings" alone is this page.
    expect(document.body.textContent).toContain("Workbench Settings → LLM Models");
  });

  it("still renders NO base-URL and NO API-key input beside it", async () => {
    // The advisory exists BECAUSE this page must not grow those two boxes: a
    // second editor for `customBaseUrl`/`customApiKey` extends DW-63's
    // lost-update gap, which the DW-61 decision rules out in as many words.
    stubFetch(body({ provider: "custom", providerSource: "config" }));
    render(<SettingsPage />);

    await waitFor(() =>
      expect(screen.getByText(SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY)).toBeTruthy(),
    );
    expect(document.getElementById("customBaseUrl")).toBeNull();
    expect(document.getElementById("customApiKey")).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    // …and it DESCRIBES: nothing is marked invalid and Save is live.
    expect(document.querySelector("[aria-invalid]")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Save Settings" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("appears when the owner SELECTS custom, and disappears when they select away", async () => {
    // The other half of the I/O matrix row: "typed selection OR effective".
    // Every case above seeds `custom` from the payload, so `showCustom` reading
    // `provider || settings?.provider` was only ever exercised through its
    // second operand — a `showCustom = settings?.provider === "custom"` would
    // have passed all of them while the picker said nothing as it was used.
    stubFetch(body({ provider: "openai", providerSource: "config" }));
    render(<SettingsPage />);

    const select = (await screen.findByLabelText(/Provider/)) as HTMLSelectElement;
    expect(
      screen.queryByText(SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY),
    ).toBeNull();

    fireEvent.change(select, { target: { value: "custom" } });
    expect(screen.getByText(SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY)).toBeTruthy();
    // …and still no boxes for the two fields it names.
    expect(document.getElementById("customBaseUrl")).toBeNull();
    expect(document.getElementById("customApiKey")).toBeNull();

    // Selecting away takes it back off screen: it describes the CURRENT
    // selection, not something the page latched onto.
    fireEvent.change(select, { target: { value: "anthropic" } });
    expect(
      screen.queryByText(SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY),
    ).toBeNull();
  });

  it("renders no advisory for any other provider", async () => {
    for (const provider of ["openai", "anthropic", "ollama", "ollama-cloud"]) {
      stubFetch(body({ provider, providerSource: "config" }));
      render(<SettingsPage />);
      await waitFor(() => expect(screen.getByLabelText(/Provider/)).toBeTruthy());
      expect(document.body.textContent).not.toContain(
        SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY,
      );
      cleanup();
    }
  });

  it("renders no advisory when no provider is selected or effective", async () => {
    stubFetch(body({ provider: null, providerSource: "none" }));
    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByLabelText(/Provider/)).toBeTruthy());
    expect(document.body.textContent).not.toContain(
      SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY,
    );
  });
});

// ---------------------------------------------------------------------------
// The two Custom notes, ASSOCIATED with their pickers, on one page (DW-400)
// ---------------------------------------------------------------------------

/**
 * The claim that only exists once both components are mounted together.
 *
 * `ProviderForm` and `StructuredKnowledgeSettings` each compose their picker's
 * `aria-describedby` from the page's read-only note id plus their own
 * custom-endpoint note id, and both source comments justify the ORDER by "the
 * two pickers on `/settings`". Neither component can pin that: mounted alone
 * each is handed a synthetic `describedBy` string no page ever passes — the
 * real one is minted by `useId()` at `page.tsx:60-61` and handed to both
 * panels — and neither can see the other's note id to know the two are
 * distinct. `/settings` is the only place where the ids are minted for real,
 * where both notes are on screen at once, and where "each picker references
 * only its own note" is a statement about anything.
 */
describe("/settings associates each Custom note with its own picker (DW-400)", () => {
  /**
   * Both halves stored `custom`, which is what puts BOTH notes on screen.
   * `structuredKnowledgeProviderSource: "config"` is load-bearing: with
   * `"default"` the extraction section is INHERITING and deliberately renders
   * no note of its own, so the page would carry only one.
   */
  const BOTH_CUSTOM = {
    provider: "custom",
    providerSource: "config",
    structuredKnowledgeProvider: "custom",
    structuredKnowledgeProviderSource: "config",
  };

  function primaryPicker(): HTMLSelectElement {
    return document.getElementById("provider") as HTMLSelectElement;
  }

  function extractionPicker(): HTMLSelectElement {
    return document.getElementById("structuredKnowledgeProvider") as HTMLSelectElement;
  }

  it("points each picker at its own note, and the two ids differ", async () => {
    stubFetch(body(BOTH_CUSTOM));
    render(<SettingsPage />);

    await waitFor(() => expect(primaryPicker()).not.toBeNull());
    await waitFor(() => expect(extractionPicker()).not.toBeNull());

    expect(primaryPicker().getAttribute("aria-describedby")).toBe(
      "providerCustomEndpoint",
    );
    expect(extractionPicker().getAttribute("aria-describedby")).toBe(
      "structuredKnowledgeCustomEndpoint",
    );
    // Each id RESOLVES, and to a node carrying the shared sentence. Resolved by
    // id rather than by text: both notes render the same copy here, so
    // `getByText` would throw on multiple matches — and matching by text would
    // not prove WHICH node the attribute reaches anyway.
    const primaryNote = document.getElementById("providerCustomEndpoint");
    const extractionNote = document.getElementById("structuredKnowledgeCustomEndpoint");
    expect(primaryNote).not.toBeNull();
    expect(extractionNote).not.toBeNull();
    // DISTINCT nodes — one shared id on a page mounting both panels would give
    // two pickers one description and `getElementById` a coin flip over which
    // note it resolves to.
    expect(primaryNote).not.toBe(extractionNote);
    expect(primaryNote!.textContent).toContain(SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY);
    expect(extractionNote!.textContent).toContain(SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY);
    // The page really is showing two copies of it — the premise of resolving
    // by id above, and the shape a one-note page would fail.
    expect(screen.getAllByText(SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY)).toHaveLength(2);
  });

  it("appends the page's real read-only note to BOTH, in the same position", async () => {
    // The ordering-parity claim the source comments make: the read-only
    // sentence is FIRST on both pickers, so one page does not announce its one
    // shared refusal in two different positions.
    stubFetch(body({ ...BOTH_CUSTOM, readOnly: true }));
    render(<SettingsPage />);

    await waitFor(() => expect(primaryPicker()).not.toBeNull());
    await waitFor(() => expect(extractionPicker()).not.toBeNull());

    const primaryIds = primaryPicker().getAttribute("aria-describedby")!.split(" ");
    const extractionIds = extractionPicker()
      .getAttribute("aria-describedby")!
      .split(" ");

    // COMPOSED, not chosen: two ids each, so neither sentence displaced the
    // other.
    expect(primaryIds).toHaveLength(2);
    expect(extractionIds).toHaveLength(2);

    // The shared refusal, FIRST on both. Read off the DOM rather than
    // hardcoded — the page mints it with `useId()`, so its value is React's to
    // choose and only its SAMENESS across the two pickers is the page's claim.
    expect(primaryIds[0]).toBe(extractionIds[0]);
    const readOnlyNote = document.getElementById(primaryIds[0]);
    expect(readOnlyNote).not.toBeNull();
    expect(readOnlyNote!.textContent).toContain("Read-only mode");

    // …and each picker's own note SECOND, still its own.
    expect(primaryIds[1]).toBe("providerCustomEndpoint");
    expect(extractionIds[1]).toBe("structuredKnowledgeCustomEndpoint");
  });
});
