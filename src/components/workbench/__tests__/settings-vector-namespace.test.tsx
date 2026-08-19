import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { SettingsCanvas } from "@/components/workbench/SettingsCanvas";
import {
  SETTINGS_VECTOR_HINT_COPY,
  type WorkbenchSettingsPayload,
} from "@/lib/workbench-settings";

/**
 * The DW-73 namespace refusal, MOUNTED.
 *
 * `workbench-settings.test.ts` pins the sentence at the library seam, which is
 * the right tool for "what does the predicate say" and the wrong one for the
 * claim the spec's acceptance criterion actually makes: that an owner LOOKING
 * at the vector switch is told about the namespace. Between the two sits the
 * component's own wiring — which of `vectorAllowed`/`vectorBlocked` reaches the
 * hint span, and whether that span is the checkbox's `aria-describedby` — and a
 * node suite reading source cannot observe either. So the assertions below are
 * made against the rendered DOM, on the text a screen reader would announce.
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
    embeddingProvider: "workers-ai",
    embeddingModel: "text-embedding-3-small",
    embeddingBaseUrl: null,
    hasEmbeddingApiKey: false,
    envEmbeddingProvider: null,
    envEmbeddingModel: null,
    envEmbeddingApiKeyProviders: [],
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

/** Mount the embeddings category and let the single on-mount read settle. */
async function mount(stored: WorkbenchSettingsPayload) {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ workbench: stored }),
  } as unknown as Response);
  const view = render(<SettingsCanvas category="embeddings" headingId="wb-set-heading" />);
  await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
  return view;
}

const IN_NAMESPACE =
  "Vector search needs a model id in the Workers AI @cf/ namespace before it can be turned on.";
const OUT_OF_NAMESPACE =
  "Vector search needs a model id outside the Workers AI @cf/ namespace before it can be turned on.";

describe("the vector switch announces the NAMESPACE refusal (DW-73)", () => {
  it("describes a Workers AI selection holding an OpenAI model id", async () => {
    await mount(payload());
    const checkbox = screen.getByLabelText("Enable vector search") as HTMLInputElement;
    // Refused: the owner cannot turn it on, and the reason travels WITH the
    // control rather than sitting unassociated beside it.
    expect(checkbox.getAttribute("aria-disabled")).toBe("true");
    expect(announcedFor(checkbox)).toBe(IN_NAMESPACE);
    // The old sentence is the regression this guards: "needs a model" beside a
    // model box that visibly holds one sent the owner nowhere.
    expect(announcedFor(checkbox)).not.toContain("needs a model before");
  });

  it("describes the MIRROR case — an OpenAI selection holding a Workers AI id", async () => {
    await mount(
      payload({
        embeddingProvider: "openai",
        embeddingModel: "@cf/baai/bge-m3",
        embeddingBaseUrl: "https://embed.example",
        hasEmbeddingApiKey: true,
      }),
    );
    const checkbox = screen.getByLabelText("Enable vector search") as HTMLInputElement;
    expect(checkbox.getAttribute("aria-disabled")).toBe("true");
    expect(announcedFor(checkbox)).toBe(OUT_OF_NAMESPACE);
  });

  it("shows the ordinary hint once the id matches the provider", async () => {
    await mount(payload({ embeddingModel: "@cf/baai/bge-m3" }));
    const checkbox = screen.getByLabelText("Enable vector search") as HTMLInputElement;
    // Workers AI carries its own transport, so a matching id is the WHOLE gate:
    // no endpoint, no key, and no refusal.
    expect(checkbox.getAttribute("aria-disabled")).toBeNull();
    expect(announcedFor(checkbox)).toBe(SETTINGS_VECTOR_HINT_COPY);
  });
});
