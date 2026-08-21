import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsCanvas } from "@/components/workbench/SettingsCanvas";
import { embeddingProviderLabel } from "@/lib/providers";
import {
  SETTINGS_KEY_ABSENT_COPY,
  SETTINGS_KEY_REMOVE_COPY,
  SETTINGS_KEY_REMOVE_PENDING_COPY,
  SETTINGS_KEY_STORED_COPY,
  SETTINGS_KEY_UNDO_COPY,
  SETTINGS_LOADING_COPY,
  type WorkbenchSettingsPayload,
} from "@/lib/workbench-settings";

/**
 * Clear on switch, MOUNTED (DW-69/DW-72).
 *
 * `workbench-settings.test.ts` pins the pure rules — `embeddingProviderChanged`,
 * `settingsDraftAfterEmbeddingProvider`, `draftEmbeddingKeyStored` — which is
 * the right tool for "what does the rule say" and the wrong one for the claim
 * the spec's acceptance criterion actually makes: that an owner LOOKING at the
 * surface is told the truth about what the save will store. Between the two
 * sits the component's wiring — whether the select applies the rule at all, and
 * which predicate reaches `secretRow`'s hint and its `Remove` button — and a
 * node suite reading source cannot observe either.
 */

/** The stored settings, as `GET /api/settings` serves them. */
function payload(overrides: Partial<WorkbenchSettingsPayload> = {}): WorkbenchSettingsPayload {
  return {
    version: "w1:2-0000000000000000",
    chatProvider: "openai",
    chatModel: "gpt-4o",
    ingestProvider: "anthropic",
    ingestModel: "claude-sonnet-4-20250514",
    customBaseUrl: null,
    hasCustomApiKey: false,
    llmTimeoutSeconds: null,
    vectorSearchEnabled: false,
    // A deployment configured for OpenAI: its endpoint and its credential.
    embeddingProvider: "openai",
    embeddingModel: "text-embedding-3-small",
    embeddingBaseUrl: "https://o/v1",
    hasEmbeddingApiKey: true,
    embeddingModelInEffect: null,
    embeddingModelOverridden: false,
    envEmbeddingProvider: null,
    envEmbeddingModel: null,
    envCustomBaseUrl: null,
    // No env credential for either vendor — the stored key is the only one in
    // play, which is what this file is about.
    envEmbeddingApiKeyProviders: [],
    hasWorkersAiBinding: false,
    firecrawlBaseUrl: null,
    hasFirecrawlApiKey: false,
    language: "English",
    readOnly: false,
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's `cleanup()` lands after this one. Unmounting here tears the
  // tree down while `fetch` is still stubbed.
  cleanup();
  vi.unstubAllGlobals();
});

/** Mount the embeddings category and let the single on-mount read settle. */
async function mount(stored: WorkbenchSettingsPayload) {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ workbench: stored }),
  } as unknown as Response);
  const view = render(<SettingsCanvas category="embeddings" headingId="wb-set-heading" />);
  await waitFor(() => expect(screen.queryByText(SETTINGS_LOADING_COPY)).toBeNull());
  return view;
}

/**
 * What a screen reader would actually read out for a control: every id in its
 * `aria-describedby` list, resolved and joined. A single `getElementById` over
 * the whole attribute silently returns null the moment a second id is appended,
 * which would make an assertion on the description pass vacuously.
 */
function announcedFor(control: HTMLElement): string {
  const ids = (control.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
  expect(ids.length).toBeGreaterThan(0);
  return ids
    .map((id) => {
      const target = document.getElementById(id);
      expect(target).not.toBeNull();
      return target!.textContent ?? "";
    })
    .join(" ");
}

const providerSelect = () =>
  screen.getByLabelText("Embedding provider") as HTMLSelectElement;
const endpointBox = () => screen.getByLabelText("Embedding endpoint") as HTMLInputElement;
const keyBox = () => screen.getByLabelText("Embedding API key") as HTMLInputElement;

describe("the embeddings surface clears the vendor pair on a switch (DW-69/DW-72)", () => {
  it("blanks the endpoint and stops claiming a key when Google is picked", async () => {
    await mount(payload());

    // BEFORE: the surface describes the OpenAI configuration it loaded.
    expect(endpointBox().value).toBe("https://o/v1");
    expect(announcedFor(keyBox())).toContain(SETTINGS_KEY_STORED_COPY);
    expect(screen.queryByText(SETTINGS_KEY_REMOVE_COPY)).not.toBeNull();

    fireEvent.change(providerSelect(), { target: { value: "google" } });
    expect(providerSelect().value).toBe("google");

    // AFTER: what the surface shows is what the save will store. The endpoint
    // box is empty, so `settingsSaveBody` sends `null` rather than writing
    // OpenAI's URL back into the store the clear just emptied.
    expect(endpointBox().value).toBe("");
    // The hint is the state, for a field that shows nothing: "A key is stored."
    // beside a key the very next save deletes is the misreport DW-69 names.
    expect(announcedFor(keyBox())).toContain(SETTINGS_KEY_ABSENT_COPY);
    expect(announcedFor(keyBox())).not.toContain(SETTINGS_KEY_STORED_COPY);
    // …and `Remove` goes with it: there is nothing left for it to remove.
    expect(screen.queryByText(SETTINGS_KEY_REMOVE_COPY)).toBeNull();
    // The key field is back to UNTOUCHED rather than pending removal, so a
    // credential typed for Google before saving still rides.
    expect(keyBox().value).toBe("");
    expect(keyBox().readOnly).toBe(false);
  });

  it("leaves both boxes alone when the SAME provider is re-selected", async () => {
    await mount(payload());
    // A marker the rule would DESTROY if it ran: the assertion below cannot pass
    // vacuously, because "the endpoint still reads `https://o/v1`" was already
    // true at mount. `fireEvent` flushes React's state update synchronously, so
    // these are asserted with no `waitFor` — a `waitFor` would happily observe
    // the pre-clear frame and call it a pass.
    fireEvent.change(endpointBox(), { target: { value: "https://o/v1/edited" } });
    expect(endpointBox().value).toBe("https://o/v1/edited");

    // The every-save re-send is the ordinary case, so "same value" must be a
    // no-op on both boxes.
    fireEvent.change(providerSelect(), { target: { value: "openai" } });

    expect(endpointBox().value).toBe("https://o/v1/edited");
    expect(announcedFor(keyBox())).toContain(SETTINGS_KEY_STORED_COPY);
    expect(screen.queryByText(SETTINGS_KEY_REMOVE_COPY)).not.toBeNull();
  });

  it("clears on the way to auto-detect as well", async () => {
    await mount(payload());
    fireEvent.change(providerSelect(), { target: { value: "" } });
    expect(endpointBox().value).toBe("");
    expect(announcedFor(keyBox())).toContain(SETTINGS_KEY_ABSENT_COPY);
  });

  it("RESTORES the stored endpoint across a switch and BACK within one draft", async () => {
    await mount(payload());
    fireEvent.change(providerSelect(), { target: { value: "google" } });
    expect(endpointBox().value).toBe("");

    fireEvent.change(providerSelect(), { target: { value: "openai" } });

    // Back on the STORED vendor, whose endpoint and key the store never moved
    // away from — so the surface shows what a reload would show. Left blank, the
    // next save would send `embeddingBaseUrl: null` and DELETE a stored endpoint
    // for a provider that never net-moved.
    expect(providerSelect().value).toBe("openai");
    expect(endpointBox().value).toBe("https://o/v1");
    // The key half already behaved this way; the endpoint half now matches it.
    expect(announcedFor(keyBox())).toContain(SETTINGS_KEY_STORED_COPY);
    expect(screen.queryByText(SETTINGS_KEY_REMOVE_COPY)).not.toBeNull();
  });

  it("cancels a pending REMOVE when the vendor moves", async () => {
    await mount(payload());
    // The owner presses Remove: the row goes to its removal-pending state and
    // the box turns read-only, with `Undo` as the only way back.
    fireEvent.click(screen.getByText(SETTINGS_KEY_REMOVE_COPY));
    expect(keyBox().readOnly).toBe(true);
    expect(announcedFor(keyBox())).toContain(SETTINGS_KEY_REMOVE_PENDING_COPY);

    fireEvent.change(providerSelect(), { target: { value: "google" } });

    // The pending Remove was about the PREVIOUS vendor's key, and that key is
    // being dropped by the store anyway. Left standing it would ride as
    // `embeddingApiKey: null` — and it would strand the row: `Undo` is gated on
    // the key still counting for the selected vendor, which it no longer does,
    // so the box would stay read-only with no control to release it.
    expect(keyBox().readOnly).toBe(false);
    expect(announcedFor(keyBox())).not.toContain(SETTINGS_KEY_REMOVE_PENDING_COPY);
    expect(announcedFor(keyBox())).toContain(SETTINGS_KEY_ABSENT_COPY);
    expect(screen.queryByText(SETTINGS_KEY_UNDO_COPY)).toBeNull();
  });

  it("discards a key TYPED for the vendor being left behind", async () => {
    await mount(payload());
    fireEvent.change(keyBox(), { target: { value: "sk-typed-for-openai" } });
    expect(keyBox().value).toBe("sk-typed-for-openai");

    fireEvent.change(providerSelect(), { target: { value: "google" } });

    // A credential typed while OpenAI was selected must not be carried into a
    // save that stores it for Google.
    expect(keyBox().value).toBe("");
  });

  it("offers the vendor whose label the switch is about", async () => {
    // Belt-and-braces on the harness rather than on the rule: a renamed option
    // value would make every `fireEvent.change` above a silent no-op.
    await mount(payload());
    const options = [...providerSelect().options].map((option) => option.value);
    expect(options).toContain("google");
    expect(screen.getByText(embeddingProviderLabel("google"))).not.toBeNull();
  });

  it("does not touch the select at all on a READ-ONLY deployment", async () => {
    await mount(payload({ readOnly: true }));
    // The read-only guard returns BEFORE the rule runs. Asserted synchronously
    // and on the SELECT's own value, which is the thing that would differ: the
    // endpoint reading `https://o/v1` is true at mount either way, so it alone
    // would pass whether or not the guard held.
    fireEvent.change(providerSelect(), { target: { value: "google" } });

    expect(providerSelect().value).toBe("openai");
    expect(endpointBox().value).toBe("https://o/v1");
    expect(announcedFor(keyBox())).toContain(SETTINGS_KEY_STORED_COPY);
  });
});
