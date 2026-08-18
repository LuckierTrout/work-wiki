import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useSettings } from "@/hooks/useSettings";
import {
  WRITE_CONFLICT_COPY,
  WRITE_PRECONDITION_REQUIRED_COPY,
} from "@/lib/write-precondition";

/**
 * `/settings` — the OTHER surface that writes `AppConfig` (DW-63), MOUNTED.
 *
 * This hook had no test of any kind, which is exactly why it is the risky half
 * of the story: `SettingsCanvas` and this form write the same file through the
 * same `PUT`, and the whole of what keeps one from silently putting back every
 * field the other just changed is a header built from a field of the GET body.
 * `workbench-settings.test.ts` executes the canvas's client with a stubbed
 * fetch; nothing anywhere ran this one.
 *
 * The harness renders only what a person can act on — the save button, the
 * result sentence, the load error and one form field — so every assertion is
 * made on the rendered DOM and on the requests that were actually issued.
 */

const SEEDED = "w1:1a-1111111122222222";
const LANDED = "w1:1a-3333333344444444";

/**
 * `EffectiveSettings` as the route serves it, plus the top-level `version`.
 * Only the fields this hook reads are filled in; the rest of the legacy object
 * is the route's contract and is pinned in `settings-route.test.ts`.
 */
function body(version: string | undefined, overrides: Record<string, unknown> = {}) {
  return {
    provider: "openai",
    providerSource: "config",
    model: "gpt-4o",
    modelSource: "config",
    configured: true,
    embeddingSupport: true,
    embeddingModel: null,
    embeddingModelSource: "none",
    hasApiKey: true,
    ollamaBaseUrl: null,
    ollamaBaseUrlSource: "none",
    structuredKnowledgeProvider: null,
    structuredKnowledgeProviderSource: "none",
    structuredKnowledgeModel: null,
    structuredKnowledgeModelSource: "none",
    structuredKnowledgeConfigured: false,
    readOnly: false,
    ...(version === undefined ? {} : { version }),
    ...overrides,
  };
}

function Harness() {
  const { handleSave, saveResult, loadError, model, setModel } = useSettings();
  return (
    <form onSubmit={handleSave}>
      <label htmlFor="model">Model</label>
      <input id="model" value={model} onChange={(e) => setModel(e.target.value)} />
      <button type="submit">Save</button>
      <output data-testid="save-result">{saveResult?.message ?? ""}</output>
      <output data-testid="load-error">{loadError ?? ""}</output>
    </form>
  );
}

let fetchMock: ReturnType<typeof vi.fn>;
/** Every `/api/settings` call, in order, with the header the hook attached. */
let settingsCalls: Array<{ method: string; ifMatch: string | undefined }>;

/**
 * Drive the hook with one answer per `/api/settings` call. `/api/status` is
 * answered blandly throughout: it shares the global with the settings read, and
 * an unhandled probe would settle outside `act`.
 */
function stub(answers: Array<() => unknown>) {
  let index = 0;
  fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
    const href = String(url);
    if (href !== "/api/settings") {
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }
    settingsCalls.push({
      method: init?.method ?? "GET",
      ifMatch: ((init?.headers ?? {}) as Record<string, string>)["If-Match"],
    });
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    const result = answer();
    if (result instanceof Error) throw result;
    return result as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
}

function ok(payload: unknown) {
  return () => ({ ok: true, status: 200, json: async () => payload });
}

function refused(status: number, error: string) {
  return () => ({ ok: false, status, json: async () => ({ error }) });
}

/** Mount and let the two on-mount reads settle. */
async function mount() {
  render(<Harness />);
  await waitFor(() => expect(settingsCalls.length).toBeGreaterThan(0));
  await waitFor(() =>
    expect((screen.getByLabelText("Model") as HTMLInputElement).value).not.toBe(""),
  );
}

function save() {
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

function result(): string {
  return screen.getByTestId("save-result").textContent ?? "";
}

beforeEach(() => {
  settingsCalls = [];
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's `cleanup()` lands after this one. Unmounting here tears the
  // hook down while `fetch` is still stubbed.
  cleanup();
  vi.unstubAllGlobals();
});

describe("useSettings — the write precondition (DW-63)", () => {
  it("sends the version the GET served, as `If-Match` on the PUT", async () => {
    stub([ok(body(SEEDED)), ok({ saved: true, version: LANDED }), ok(body(LANDED))]);
    await mount();

    save();

    await waitFor(() => expect(result()).toBe("Settings saved."));
    const put = settingsCalls.find((call) => call.method === "PUT");
    expect(put).toBeTruthy();
    expect(put!.ifMatch).toBe(`"${SEEDED}"`);
    // …and the read that seeded it carried no precondition at all: a GET is not
    // a conditional write.
    expect(settingsCalls[0]).toEqual({ method: "GET", ifMatch: undefined });
  });

  it("picks up the NEW version, so a second save without a reload lands", async () => {
    stub([
      ok(body(SEEDED)),
      ok({ saved: true, version: LANDED }),
      // The refresh a landed save already runs, now serving the new version.
      ok(body(LANDED)),
      ok({ saved: true, version: LANDED }),
      ok(body(LANDED)),
    ]);
    await mount();

    save();
    await waitFor(() => expect(result()).toBe("Settings saved."));
    save();

    await waitFor(
      () => expect(settingsCalls.filter((call) => call.method === "PUT")).toHaveLength(2),
    );
    const puts = settingsCalls.filter((call) => call.method === "PUT");
    expect(puts[0].ifMatch).toBe(`"${SEEDED}"`);
    expect(puts[1].ifMatch).toBe(`"${LANDED}"`);
  });

  it("adopts the LANDED version even when the follow-up refresh fails", async () => {
    // THE bug: the version used to be adopted only from the refresh, so a save
    // whose refresh blipped left the superseded string in state and the very
    // next save was refused 412 — for a change the owner had made themselves,
    // with no way out but a reload.
    stub([
      ok(body(SEEDED)),
      ok({ saved: true, version: LANDED }),
      () => new TypeError("Failed to fetch"),
      ok({ saved: true, version: LANDED }),
      ok(body(LANDED)),
    ]);
    await mount();

    save();
    await waitFor(() => expect(screen.getByTestId("load-error").textContent).not.toBe(""));
    save();

    await waitFor(
      () => expect(settingsCalls.filter((call) => call.method === "PUT")).toHaveLength(2),
    );
    const puts = settingsCalls.filter((call) => call.method === "PUT");
    expect(puts[1].ifMatch).toBe(`"${LANDED}"`);
    expect(puts[1].ifMatch).not.toBe(`"${SEEDED}"`);
  });

  it("sends NO precondition once a read has failed, rather than a stale one", async () => {
    // A read that did not land says nothing about what is stored, so the version
    // it last saw is no longer evidence. The honest outcome is the route's 428
    // ("could not be checked"), never a 412 blaming somebody else for a change
    // nobody made.
    stub([
      ok(body(SEEDED)),
      // A save that lands but answers no version of its own…
      ok({ saved: true }),
      // …followed by the refresh it always runs, which does not land.
      () => new TypeError("Failed to fetch"),
      ok({ saved: true }),
      ok(body(SEEDED)),
    ]);
    await mount();

    save();
    await waitFor(() => expect(result()).toBe("Settings saved."));
    await waitFor(() => expect(screen.getByTestId("load-error").textContent).not.toBe(""));
    save();

    await waitFor(
      () => expect(settingsCalls.filter((call) => call.method === "PUT")).toHaveLength(2),
    );
    expect(settingsCalls.filter((call) => call.method === "PUT")[1].ifMatch).toBeUndefined();
  });

  it("relays the SERVER's conflict sentence and keeps the form's values", async () => {
    stub([ok(body(SEEDED)), refused(412, WRITE_CONFLICT_COPY)]);
    await mount();
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gpt-4.1" } });

    save();

    await waitFor(() => expect(result()).toBe(WRITE_CONFLICT_COPY));
    // A refused save must never be the thing that loses the edit.
    expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("gpt-4.1");
    // …and it did not refresh over the top of it either.
    expect(settingsCalls.filter((call) => call.method === "GET")).toHaveLength(1);
  });

  it("relays the 428 sentence the same way", async () => {
    stub([ok(body(undefined)), refused(428, WRITE_PRECONDITION_REQUIRED_COPY)]);
    await mount();

    save();

    await waitFor(() => expect(result()).toBe(WRITE_PRECONDITION_REQUIRED_COPY));
    // A GET that served no version means the hook had none to send — which is
    // exactly what the route answered 428 to.
    expect(settingsCalls[1].ifMatch).toBeUndefined();
  });
});
