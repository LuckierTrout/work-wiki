import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { SettingsCanvas } from "@/components/workbench/SettingsCanvas";
import {
  SETTINGS_MODEL_INHERIT_COPY,
  SETTINGS_READ_ONLY_COPY,
  SETTINGS_SAVED_COPY,
  SETTINGS_SAVE_COPY,
  type WorkbenchSettingsPayload,
} from "@/lib/workbench-settings";
import {
  WRITE_CONFLICT_COPY,
  WRITE_PRECONDITION_REQUIRED_COPY,
} from "@/lib/write-precondition";

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
    // The write precondition `GET /api/settings` serves beside the values — the
    // opaque stamp the store holds, not a hash of the config (DW-197).
    version: "s1:00000000000000000000000000000000",
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

// ---------------------------------------------------------------------------
// The write precondition on the Settings canvas (DW-63)
// ---------------------------------------------------------------------------
//
// DW-63 is specifically about TWO surfaces writing one `AppConfig`, and the
// only thing standing between them is one header built from a field of the
// payload the draft was seeded from. `workbench-settings.test.ts` executes
// `saveWorkbenchSettings` with a stubbed fetch and scans this component's
// source; neither can see the seam between the two — that the version the
// canvas SENDS is the one the read it is showing came with, and that a landed
// save re-seeds it so the next one is not refused as a conflict with itself.

describe("the Settings canvas sends the version it was seeded with (DW-63)", () => {
  const SEEDED = "s1:11111111111111112222222222222222";
  const LANDED = "s1:33333333333333334444444444444444";

  /** Mount writable, with one response per call rather than one for all. */
  async function mountWritable(responses: Array<() => unknown>) {
    let call = 0;
    fetchMock.mockImplementation(async () => {
      const next = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return next() as Response;
    });
    render(<SettingsCanvas category="llm-models" headingId="wb-set-heading" />);
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
  }

  function read(version: string) {
    return () => ({
      ok: true,
      status: 200,
      json: async () => ({ workbench: payload({ readOnly: false, version }) }),
    });
  }

  function saved(version: string) {
    return () => ({
      ok: true,
      status: 200,
      json: async () => ({
        saved: true,
        version,
        workbench: payload({ readOnly: false, version, chatModel: "gpt-4.1" }),
      }),
    });
  }

  function typeChatModel(value: string) {
    fireEvent.change(screen.getByLabelText("Chat model"), { target: { value } });
  }

  function ifMatchOf(call: number): string | undefined {
    const [, init] = fetchMock.mock.calls[call] as [string, RequestInit];
    return ((init.headers ?? {}) as Record<string, string>)["If-Match"];
  }

  it("puts the seeded payload's version on the save, and adopts the answered one", async () => {
    await mountWritable([read(SEEDED), saved(LANDED), saved(LANDED)]);

    typeChatModel("gpt-4.1");
    fireEvent.click(screen.getByRole("button", { name: SETTINGS_SAVE_COPY }));
    await waitFor(() => expect(screen.getByText(SETTINGS_SAVED_COPY)).toBeTruthy());

    // Call 0 is the read; call 1 is the save.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, put] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(put.method).toBe("PUT");
    expect(ifMatchOf(1)).toBe(`"${SEEDED}"`);

    // A second edit and save WITHOUT a reload rides the version the first save
    // answered — the existing `setPayload(result.payload)` re-seed is what
    // carries it, and this is the only place that can observe it.
    typeChatModel("gpt-4.1-mini");
    fireEvent.click(screen.getByRole("button", { name: SETTINGS_SAVE_COPY }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(ifMatchOf(2)).toBe(`"${LANDED}"`);
  });

  it("CLEARS the version when a landed save answers without one (DW-199)", async () => {
    // The convention `PreviewColumn` already spells for this seam: what the
    // surface knows after a versionless 200 is "the current version is
    // unknown". Sending nothing gets 428 — "this save could not be checked" —
    // which is true. Re-sending the version this very save superseded gets 412
    // — "somebody else changed this while you were editing" — about an actor
    // that does not exist, and it can only ever be refused. Neither can
    // clobber, so the tie goes to the honest refusal.
    const versionless = () => ({
      ok: true,
      status: 200,
      json: async () => ({
        saved: true,
        workbench: (() => {
          const { version: _dropped, ...rest } = payload({
            readOnly: false,
            chatModel: "gpt-4.1",
          });
          return rest;
        })(),
      }),
    });
    await mountWritable([
      read(SEEDED),
      versionless,
      () => ({
        ok: false,
        status: 428,
        json: async () => ({ error: WRITE_PRECONDITION_REQUIRED_COPY }),
      }),
    ]);

    typeChatModel("gpt-4.1");
    fireEvent.click(screen.getByRole("button", { name: SETTINGS_SAVE_COPY }));
    await waitFor(() => expect(screen.getByText(SETTINGS_SAVED_COPY)).toBeTruthy());
    expect(ifMatchOf(1)).toBe(`"${SEEDED}"`);

    // The NEXT save carries no `If-Match` at all…
    typeChatModel("gpt-4.1-mini");
    fireEvent.click(screen.getByRole("button", { name: SETTINGS_SAVE_COPY }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(ifMatchOf(2)).toBeUndefined();

    // …and is refused with the 428 sentence, with every edit still on screen.
    await waitFor(() =>
      expect(screen.getByText(WRITE_PRECONDITION_REQUIRED_COPY)).toBeTruthy(),
    );
    expect((screen.getByLabelText("Chat model") as HTMLInputElement).value).toBe(
      "gpt-4.1-mini",
    );
  });

  it("still RENDERS a load that carries no version at all", async () => {
    // A payload without one is accepted rather than turned into an
    // indistinguishable load failure that takes the whole canvas off screen.
    const { version: _dropped, ...withoutVersion } = payload({ readOnly: false });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ workbench: withoutVersion }),
    } as unknown as Response);
    render(<SettingsCanvas category="llm-models" headingId="wb-set-heading" />);
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());

    expect((screen.getByLabelText("Chat model") as HTMLInputElement).value).toBe("gpt-4o");
    // …and a save from it carries NO `If-Match`, which the route answers 428
    // with the draft still on screen — never an unconditional write.
    typeChatModel("gpt-4.1");
    fireEvent.click(screen.getByRole("button", { name: SETTINGS_SAVE_COPY }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(ifMatchOf(1)).toBeUndefined();
  });

  it("keeps every edit on screen and shows the SERVER's conflict sentence", async () => {
    await mountWritable([
      read(SEEDED),
      () => ({
        ok: false,
        status: 412,
        json: async () => ({ error: WRITE_CONFLICT_COPY }),
      }),
    ]);

    typeChatModel("gpt-4.1");
    fireEvent.click(screen.getByRole("button", { name: SETTINGS_SAVE_COPY }));

    await waitFor(() => expect(screen.getByText(WRITE_CONFLICT_COPY)).toBeTruthy());
    // A refused save must never be the thing that loses the edit.
    expect((screen.getByLabelText("Chat model") as HTMLInputElement).value).toBe("gpt-4.1");
    expect(screen.queryByText(SETTINGS_SAVED_COPY)).toBeNull();
  });
});
