import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { SettingsCanvas } from "@/components/workbench/SettingsCanvas";
import {
  SETTINGS_MODEL_INHERIT_COPY,
  SETTINGS_READ_ONLY_COPY,
  type WorkbenchSettingsPayload,
} from "@/lib/workbench-settings";

/**
 * The Settings controls a read-only deployment refuses, MOUNTED (DW-37, DW-65).
 *
 * `workbench-settings.test.ts` reads this component's source, which is the right
 * tool for "is `disabled` gone" and the wrong one for the claim that actually
 * matters: that a keyboard user on a read-only deployment can still REACH the
 * provider pickers and READ what this deployment is running on. `disabled` takes
 * a control out of the tab order, and no source scan can observe a tab order —
 * so the two assertions below are made against the rendered DOM: focus lands,
 * and an activation changes nothing while the control still shows the stored
 * value.
 */

/** The stored settings, as `GET /api/settings` serves them. */
function payload(overrides: Partial<WorkbenchSettingsPayload> = {}): WorkbenchSettingsPayload {
  return {
    chatProvider: "openai",
    chatModel: "gpt-4o",
    ingestProvider: "anthropic",
    ingestModel: "claude-sonnet-4-20250514",
    customBaseUrl: null,
    hasCustomApiKey: false,
    llmTimeoutSeconds: null,
    vectorSearchEnabled: false,
    embeddingProvider: "openai",
    embeddingModel: "text-embedding-3-small",
    embeddingBaseUrl: null,
    hasEmbeddingApiKey: true,
    envEmbeddingProvider: null,
    envEmbeddingModel: null,
    envEmbeddingApiKeyProviders: [],
    firecrawlBaseUrl: null,
    hasFirecrawlApiKey: false,
    language: "English",
    readOnly: true,
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

/** Mount one category and let the single on-mount read settle. */
async function mount(
  category: "llm-models" | "embeddings",
  stored: WorkbenchSettingsPayload,
) {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ workbench: stored }),
  } as unknown as Response);
  const view = render(<SettingsCanvas category={category} headingId="wb-set-heading" />);
  // The loading state is replaced once the read lands.
  await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
  return view;
}

describe("a read-only deployment (DW-37, DW-65)", () => {
  it("keeps the provider pickers focusable and reporting what is stored", async () => {
    await mount("llm-models", payload());
    for (const [label, value] of [
      ["Chat provider", "openai"],
      ["Ingest provider", "anthropic"],
    ] as const) {
      const select = screen.getByLabelText(label) as HTMLSelectElement;
      // `disabled` is the bug: it takes the control out of the tab order, so the
      // owner cannot reach it and cannot read which provider is configured.
      expect(select.disabled).toBe(false);
      expect(select.hasAttribute("disabled")).toBe(false);
      expect(select.getAttribute("aria-disabled")).toBe("true");
      select.focus();
      expect(document.activeElement).toBe(select);
      expect(select.value).toBe(value);
    }
  });

  it("announces WHY each refused control refuses, without losing its own hint", async () => {
    // `aria-disabled` on its own announces "dimmed" and nothing more, and
    // `SETTINGS_READ_ONLY_COPY` used to sit unassociated in the save bar — so a
    // keyboard user reached a picker that would not move and was told nothing
    // about the deployment. The sentence is APPENDED to each control's own hint
    // rather than replacing it: the hint still explains what the field means.
    await mount("llm-models", payload());
    for (const label of ["Chat provider", "Ingest provider"] as const) {
      const select = screen.getByLabelText(label);
      const announced = announcedFor(select);
      expect(announced).toContain(SETTINGS_READ_ONLY_COPY);
      expect(announced).toContain(SETTINGS_MODEL_INHERIT_COPY);
    }
  });

  it("keeps the description to the control's own hint on a writable deployment", async () => {
    await mount("llm-models", payload({ readOnly: false }));
    const announced = announcedFor(screen.getByLabelText("Chat provider"));
    expect(announced).toContain(SETTINGS_MODEL_INHERIT_COPY);
    // The save bar is showing the ordinary standing sentence here, and pointing
    // a control at it would announce "unsaved edits do not apply" as though it
    // were a constraint on the picker.
    expect(announced).not.toContain(SETTINGS_READ_ONLY_COPY);
  });

  it("refuses a provider change and puts the picker back", async () => {
    await mount("llm-models", payload());
    const select = screen.getByLabelText("Chat provider") as HTMLSelectElement;

    fireEvent.change(select, { target: { value: "google" } });

    // The claim worth pinning: the picker still reports what is STORED. The
    // handler commits nothing and React re-applies the controlled value, so it
    // never sits on a provider the draft never took — which would make the next
    // save of some other field read as though the owner had chosen it.
    await waitFor(() => expect(select.value).toBe("openai"));
    // The read is the only request this surface has made.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the vector switch focusable, described, and unchanged by a click", async () => {
    await mount("embeddings", payload());
    const checkbox = screen.getByLabelText("Enable vector search") as HTMLInputElement;
    expect(checkbox.disabled).toBe(false);
    expect(checkbox.hasAttribute("disabled")).toBe(false);
    expect(checkbox.getAttribute("aria-disabled")).toBe("true");
    checkbox.focus();
    expect(document.activeElement).toBe(checkbox);
    // The reason is wired as the control's own description, which only a
    // focusable control can ever have announced — and the announced text has to
    // NAME the refusal, not merely be non-empty. `aria-describedby` is a
    // space-separated list, so every id is resolved and joined the way a screen
    // reader would read them.
    expect(announcedFor(checkbox)).toContain(SETTINGS_READ_ONLY_COPY);

    fireEvent.click(checkbox);

    await waitFor(() => expect(checkbox.checked).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses the vector switch on the OTHER half of its predicate too", async () => {
    // Not read-only — the provider simply cannot support vector search yet. Same
    // convention, because the same argument applies: the hint that names the
    // missing legs is this control's `aria-describedby`, and a `disabled`
    // control is never focused, so that description was never announced.
    await mount(
      "embeddings",
      payload({ readOnly: false, embeddingProvider: null, embeddingModel: null }),
    );
    const checkbox = screen.getByLabelText("Enable vector search") as HTMLInputElement;
    expect(checkbox.hasAttribute("disabled")).toBe(false);
    expect(checkbox.getAttribute("aria-disabled")).toBe("true");
    checkbox.focus();
    expect(document.activeElement).toBe(checkbox);

    fireEvent.click(checkbox);

    await waitFor(() => expect(checkbox.checked).toBe(false));
  });

  it("leaves every control interactive on a writable deployment", async () => {
    await mount("embeddings", payload({ readOnly: false, vectorSearchEnabled: true }));
    const select = screen.getByLabelText("Embedding provider") as HTMLSelectElement;
    const checkbox = screen.getByLabelText("Enable vector search") as HTMLInputElement;
    // No stray `aria-disabled="false"`: the stylesheet's refused face keys off
    // the attribute's presence, so a writable deployment must not carry it.
    expect(select.hasAttribute("aria-disabled")).toBe(false);
    expect(checkbox.hasAttribute("aria-disabled")).toBe(false);

    fireEvent.change(select, { target: { value: "ollama" } });
    await waitFor(() => expect(select.value).toBe("ollama"));

    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(false));
  });
});
