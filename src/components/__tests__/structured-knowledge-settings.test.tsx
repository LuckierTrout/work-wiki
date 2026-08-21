import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  StructuredKnowledgeSettings,
  type StructuredKnowledgeSettingsProps,
} from "@/components/StructuredKnowledgeSettings";
import type { EffectiveSettings } from "@/hooks/useSettings";
import { PROVIDER_INFO } from "@/lib/providers";
import { SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY } from "@/lib/workbench-settings";

/**
 * The extraction provider picker, MOUNTED (DW-368).
 *
 * `custom` is offered here and configured elsewhere, so the section has to SAY
 * where the base URL and the API key live — otherwise a save stores a provider
 * `getConfiguredModel` refuses to construct and the first anyone hears of it is
 * a failed extraction call. "The surface says it" is not something a source
 * scan can check, so these cases are made against the rendered DOM.
 *
 * The component had no test before this file.
 */

/** Only the fields these cases move; the rest is a shape the component reads. */
function settings(
  overrides: Partial<EffectiveSettings> = {},
): EffectiveSettings {
  return {
    provider: null,
    providerSource: "none",
    model: null,
    modelSource: "none",
    configured: false,
    embeddingSupport: false,
    embeddingModel: null,
    embeddingModelSource: "none",
    embeddingModelInEffect: null,
    embeddingModelOverridden: false,
    hasApiKey: false,
    ollamaBaseUrl: null,
    ollamaBaseUrlSource: "none",
    structuredKnowledgeProvider: null,
    structuredKnowledgeProviderSource: "none",
    structuredKnowledgeModel: null,
    structuredKnowledgeModelSource: "none",
    structuredKnowledgeConfigured: false,
    readOnly: false,
    ...overrides,
  };
}

function props(
  overrides: Partial<StructuredKnowledgeSettingsProps> = {},
): StructuredKnowledgeSettingsProps {
  return {
    provider: "",
    setProvider: vi.fn(),
    model: "",
    setModel: vi.fn(),
    settings: settings(),
    ...overrides,
  };
}

/** The custom-endpoint pointer, or null when the component rendered none. */
function customPointer(): HTMLElement | null {
  return document.getElementById("structuredKnowledgeCustomEndpoint");
}

afterEach(() => {
  cleanup();
});

describe("StructuredKnowledgeSettings — the custom-endpoint pointer", () => {
  it("renders when `custom` is picked in the form", () => {
    render(<StructuredKnowledgeSettings {...props({ provider: "custom" })} />);

    const pointer = customPointer();
    expect(pointer).not.toBeNull();
    expect(pointer?.textContent).toContain(SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY);
  });

  it("renders on first paint when `custom` is STORED and untouched", () => {
    // The form value is empty because the owner has touched nothing; the
    // deployment is already routing extraction through `custom`, and that is
    // exactly the owner who needs the pointer.
    render(
      <StructuredKnowledgeSettings
        {...props({
          provider: "",
          settings: settings({
            structuredKnowledgeProvider: "custom",
            structuredKnowledgeProviderSource: "config",
          }),
        })}
      />,
    );

    expect(customPointer()).not.toBeNull();
  });

  it("uses the SAME sentence the primary provider picker uses", () => {
    // One destination, whichever half of the product sent the owner there —
    // `ProviderForm` renders this same constant, and a second hand-typed
    // sentence would be a second place for the destination to go stale.
    render(<StructuredKnowledgeSettings {...props({ provider: "custom" })} />);

    expect(screen.getByText(SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY)).toBeTruthy();
  });

  it("DESCRIBES rather than marks: the picker is not flagged invalid", () => {
    // Selecting `custom` is not an error, it is half a configuration. No
    // `aria-invalid`, and nothing here blocks the save.
    render(<StructuredKnowledgeSettings {...props({ provider: "custom" })} />);

    const picker = document.getElementById("structuredKnowledgeProvider");
    expect(picker?.getAttribute("aria-invalid")).toBeNull();
  });

  it("renders nothing at all on any other provider the picker offers", () => {
    // Derived from `PROVIDER_INFO`, which is what populates the picker — a
    // hardcoded list leaves whichever providers it forgot (and every provider
    // added later) silently uncovered.
    const others = PROVIDER_INFO.filter((option) => option.value !== "custom");
    expect(others.length).toBeGreaterThan(0);

    for (const option of others) {
      render(<StructuredKnowledgeSettings {...props({ provider: option.value })} />);
      // Name the iteration, so a failure says WHICH provider broke.
      expect(customPointer(), `pointer rendered for ${option.value}`).toBeNull();
      cleanup();
    }
  });

  it('renders nothing on "Use primary provider", even when the PRIMARY is custom', () => {
    // The shape `GET /api/settings` actually serves for this deployment.
    // `workloadModelSettings` (`src/lib/config.ts`) resolves an unset extraction
    // provider to `provider ?? primaryProvider` with source `"default"`, so
    // `structuredKnowledgeProvider` is NEVER null while a primary exists — it
    // echoes the primary. A fixture pairing a `custom` primary with a null
    // extraction provider is one the route cannot emit, and asserting against
    // it proves nothing.
    //
    // The section is INHERITING here, which the flow badge already says. The
    // primary picker renders this same sentence for the same setting, and a
    // second copy would say it twice on one page.
    render(
      <StructuredKnowledgeSettings
        {...props({
          provider: "",
          settings: settings({
            provider: "custom",
            providerSource: "config",
            structuredKnowledgeProvider: "custom",
            structuredKnowledgeProviderSource: "default",
          }),
        })}
      />,
    );

    expect(customPointer()).toBeNull();
    // …and the section says so, rather than quietly rendering nothing.
    expect(screen.getByText(/Primary provider/)).toBeTruthy();
  });
});
