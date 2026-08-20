import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import SettingsPage from "@/app/settings/page";

/**
 * `/settings` end to end through the browser half of DW-274, MOUNTED.
 *
 * The component suite supplies `modelInEffect` as a hand-written literal and
 * the hook suite only widened a fixture, so between them NOTHING executed the
 * one line that connects the route's answer to the rendered sentence. That gap
 * is not theoretical: swapping
 *
 *     modelInEffect={settings?.embeddingModelInEffect ?? null}
 *
 * for `settings?.embeddingModel ?? null` leaves the whole suite green while the
 * page renders "This deployment embeds with `text-embedding-3-small`" — the
 * ORIGINAL wrong answer, now wearing the new note. This file is the assertion
 * that fails under that mutation.
 *
 * So the page, the hook and `EmbeddingSettings` are all real here; only the
 * unrelated panels below the form are stubbed, because each fetches its own
 * endpoint on mount and none of them is on the wire under test.
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

/** The DW-274 deployment, as `GET /api/settings` serves it. */
const SUBSTITUTED = {
  provider: "anthropic",
  providerSource: "env",
  model: "claude-sonnet-4-20250514",
  modelSource: "default",
  configured: true,
  embeddingSupport: true,
  // What is SET — the env variable, reported truthfully…
  embeddingModel: "text-embedding-3-small",
  embeddingModelSource: "env",
  // …and what actually embeds, which is a different model.
  embeddingModelInEffect: "@cf/baai/bge-m3",
  embeddingModelOverridden: true,
  hasApiKey: true,
  ollamaBaseUrl: null,
  ollamaBaseUrlSource: "none",
  structuredKnowledgeProvider: null,
  structuredKnowledgeProviderSource: "none",
  structuredKnowledgeModel: null,
  structuredKnowledgeModelSource: "none",
  structuredKnowledgeConfigured: false,
  readOnly: false,
  version: "w1:1a-1111111122222222",
};

/**
 * Answer `/api/settings` with `payload`; answer everything else blandly.
 *
 * `/api/status` shares the global with the settings read and is fetched on the
 * same mount, so an unhandled probe would settle outside `act` — the technique
 * `useSettings.test.tsx` documents.
 */
function stubFetch(payload: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const href = String(url);
      const body = href === "/api/settings" ? payload : {};
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }),
  );
}

/** The override note, or null when the page rendered none. */
function overrideNote(): HTMLElement | null {
  return document.getElementById("embeddingModelOverride");
}

beforeEach(() => {
  stubFetch(SUBSTITUTED);
});

afterEach(() => {
  // FIRST, for the reason `useSettings.test.tsx` documents: vitest runs
  // afterEach hooks in reverse registration order, so the setup file's
  // `cleanup()` lands after this one and would unmount with `fetch` unstubbed.
  cleanup();
  vi.unstubAllGlobals();
});

describe("/settings names the model that actually embeds (DW-274)", () => {
  it("passes the IN-EFFECT model to the note, not the one that is merely set", async () => {
    render(<SettingsPage />);

    await waitFor(() => expect(overrideNote()).not.toBeNull());
    const note = overrideNote()!;

    // THE assertion. The note names what embeds…
    expect(note.textContent).toContain("@cf/baai/bge-m3");
    // …and NOT the env value, which is what the page said before this story and
    // what a `modelInEffect={settings?.embeddingModel}` mis-wiring would put
    // back here.
    expect(note.textContent).not.toContain("text-embedding-3-small");

    // The locked env box goes on showing what is SET, unchanged — both facts
    // are on screen, which is the whole point of the pair.
    expect(screen.getByText("text-embedding-3-small")).toBeTruthy();
  });

  it("renders no note when the served payload reports no substitution", async () => {
    // The same page, the same wire, the common case: the note is a function of
    // what the route said, not something the page decides for itself.
    stubFetch({
      ...SUBSTITUTED,
      embeddingModelInEffect: "text-embedding-3-small",
      embeddingModelOverridden: false,
    });
    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByText("text-embedding-3-small")).toBeTruthy());
    expect(overrideNote()).toBeNull();
    expect(document.body.textContent).not.toContain("Not in effect");
  });
});
