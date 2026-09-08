import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useSettings } from "@/hooks/useSettings";
import {
  WRITE_CONFLICT_COPY,
  WRITE_PRECONDITION_REQUIRED_COPY,
} from "@/lib/write-precondition";
import { unconfirmedWriteMessage } from "@/lib/workbench-request";
import { SETTINGS_SAVE_ACTION } from "@/lib/workbench-settings";

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
      <output data-testid="save-ok">{saveResult ? String(saveResult.ok) : ""}</output>
      <output data-testid="load-error">{loadError ?? ""}</output>
    </form>
  );
}

let fetchMock: ReturnType<typeof vi.fn>;
/** Every `/api/settings` call, in order, with the header the hook attached. */
let settingsCalls: Array<{ method: string; ifMatch: string | undefined }>;
/**
 * Every `/api/status` call.
 *
 * Counted rather than ignored because it is HALF the reconcile: `/settings`
 * renders a provider/model banner straight off that object, at the top of the
 * very screen the unconfirmed sentence tells the owner to check. Without this,
 * deleting `fetchStatus()` from the unconfirmed branch left every suite green.
 */
let statusCalls: number;

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
      if (href === "/api/status") statusCalls += 1;
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

/** `"true"`, `"false"`, or `""` for a save that has not reported yet. */
function verdict(): string {
  return screen.getByTestId("save-ok").textContent ?? "";
}

/** A 200 whose BODY READ rejects — the two halves DW-624 tells apart. */
function landedBodyThrows(cause: Error) {
  return () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw cause;
    },
  });
}

beforeEach(() => {
  settingsCalls = [];
  statusCalls = 0;
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

// ---------------------------------------------------------------------------
// The 2xx whose body never became readable (DW-624)
// ---------------------------------------------------------------------------

/**
 * Two failures used to hide behind one `.catch(() => null)` on the save's own
 * body read, and BOTH ended in "Settings saved." One of them deserves it and
 * one is the exact case that sentence must never be said about.
 */
describe("useSettings — a 200 whose body read fails", () => {
  it("reports an UNKNOWN outcome when the read dies mid-stream, and reconciles", async () => {
    // The deadline fired while the payload was arriving. A 200 header is no
    // proof the route ran to completion, and it is certainly no proof of what
    // it stored — so the one thing that cannot be claimed here is that the
    // settings were saved.
    stub([
      ok(body(SEEDED)),
      landedBodyThrows(
        Object.assign(new Error("signal timed out"), { name: "TimeoutError" }),
      ),
      ok(body(LANDED)),
    ]);
    await mount();

    save();

    await waitFor(() =>
      expect(result()).toBe(unconfirmedWriteMessage(SETTINGS_SAVE_ACTION)),
    );
    expect(verdict()).toBe("false");
    // No transport vocabulary reaches the owner — the sentence has one owner.
    expect(result()).not.toContain("timed out");
    expect(result()).not.toBe("Settings saved.");
    // …and the screen the sentence sends them to is RE-READ, because the save
    // may well have landed in full: the mount's GET, then this one.
    await waitFor(() =>
      expect(settingsCalls.filter((call) => call.method === "GET")).toHaveLength(2),
    );
    // BOTH halves of that screen. The banner above the form is rendered off
    // `/api/status`, so a reconcile that refreshed only the settings would send
    // the owner to check a provider line still describing the config from
    // before the save that may have landed.
    await waitFor(() => expect(statusCalls).toBe(2));
  });

  it("is unchanged when the body merely fails to PARSE", async () => {
    // An arrived answer that is not JSON — an HTML error page from a proxy, a
    // truncated payload. The route answered; the version is simply left to the
    // refresh, exactly as before.
    stub([
      ok(body(SEEDED)),
      landedBodyThrows(new SyntaxError("Unexpected token <")),
      ok(body(LANDED)),
    ]);
    await mount();

    save();

    await waitFor(() => expect(result()).toBe("Settings saved."));
    expect(verdict()).toBe("true");
    // The refresh that always follows a landed save re-seeds the version, so
    // the next save carries the one the store now holds.
    await waitFor(
      () => expect(settingsCalls.filter((call) => call.method === "GET")).toHaveLength(2),
    );
    save();
    await waitFor(
      () => expect(settingsCalls.filter((call) => call.method === "PUT")).toHaveLength(2),
    );
    expect(settingsCalls.filter((call) => call.method === "PUT")[1].ifMatch).toBe(
      `"${LANDED}"`,
    );
  });

  it("reports a GATEWAY status as an outcome nobody knows, and reconciles", async () => {
    // A 504 did not come from the route: something in front of it gave up
    // waiting. The save may have been applied in full, so "Save failed (504)"
    // is a claim this client cannot make — and the canvas, writing the SAME
    // `AppConfig` through the SAME `PUT`, already answers unknown here.
    stub([
      ok(body(SEEDED)),
      refused(504, "<html>gateway timeout</html>"),
      ok(body(LANDED)),
    ]);
    await mount();

    save();

    await waitFor(() =>
      expect(result()).toBe(unconfirmedWriteMessage(SETTINGS_SAVE_ACTION)),
    );
    expect(verdict()).toBe("false");
    // Whatever a proxy put in the body is not the route's verdict.
    expect(result()).not.toContain("gateway");
    // The same reconcile the dying-body case runs, for the same reason.
    await waitFor(() =>
      expect(settingsCalls.filter((call) => call.method === "GET")).toHaveLength(2),
    );
    await waitFor(() => expect(statusCalls).toBe(2));
  });

  it("leaves a 500 and the route's own refusals reading exactly as before", async () => {
    // The other side of the status now riding the error: only 502 and 504 are
    // unknown. A plain 500 IS the route answering, and a 412 is it answering in
    // words — both keep today's sentence and neither reconciles.
    // A 500 carrying no `error` key at all — the status names itself, exactly
    // as it did before the status began riding the error.
    stub([ok(body(SEEDED)), () => ({ ok: false, status: 500, json: async () => ({}) })]);
    await mount();
    save();
    await waitFor(() => expect(result()).toBe("Save failed (500)"));
    expect(verdict()).toBe("false");
    expect(settingsCalls.filter((call) => call.method === "GET")).toHaveLength(1);
    expect(statusCalls).toBe(1);

    // …and a 500 that DID say something still says it.
    cleanup();
    settingsCalls = [];
    statusCalls = 0;
    stub([ok(body(SEEDED)), refused(500, "The store is unreadable.")]);
    await mount();
    save();
    await waitFor(() => expect(result()).toBe("The store is unreadable."));
    expect(settingsCalls.filter((call) => call.method === "GET")).toHaveLength(1);

    cleanup();
    settingsCalls = [];
    statusCalls = 0;
    stub([ok(body(SEEDED)), refused(412, WRITE_CONFLICT_COPY)]);
    await mount();
    save();
    await waitFor(() => expect(result()).toBe(WRITE_CONFLICT_COPY));
    expect(settingsCalls.filter((call) => call.method === "GET")).toHaveLength(1);
  });

  it("still relays the SERVER's sentence for a refusal whose body dies", async () => {
    // The non-2xx leg is untouched: a status line that arrived IS the verdict,
    // so this reads as a failed save and not as an unknown one.
    stub([
      ok(body(SEEDED)),
      () => ({
        ok: false,
        status: 500,
        json: async () => {
          throw new TypeError("Load failed");
        },
      }),
    ]);
    await mount();

    save();

    await waitFor(() => expect(result()).toBe("Save failed (500)"));
    expect(verdict()).toBe("false");
    // No reconciling read — nothing is unknown.
    expect(settingsCalls.filter((call) => call.method === "GET")).toHaveLength(1);
  });
});
