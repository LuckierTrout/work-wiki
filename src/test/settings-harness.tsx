import { afterEach, beforeEach, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { SettingsCanvas } from "@/components/workbench/SettingsCanvas";
import {
  SETTINGS_LOADING_COPY,
  type SettingsCategoryId,
  type WorkbenchSettingsPayload,
} from "@/lib/workbench-settings";

/**
 * The mount harness the Settings suites share (DW-228).
 *
 * Four mounted suites carried a verbatim copy of the same ~50-field fixture,
 * the same `fetch` stub, the same `aria-describedby` resolver and the same
 * mount-and-settle helper. A field added to `WorkbenchSettingsPayload` had to
 * land in four places, and a fixture that drifted in one copy changed what that
 * file asserted without anything saying so. Everything genuinely shared lives
 * here; every per-file DELTA stays in the file it belongs to, stated as an
 * override so it reads as the one thing that suite is about.
 *
 * Named `settings-harness.tsx`, not `*.test.tsx`: the `dom` project collects
 * `src/**\/__tests__/**\/*.test.tsx`, and `vitest.config.ts` throws at config
 * load when a `*.test.tsx` on disk falls outside that include — so a helper
 * wearing the suffix would be collected as a suite containing no assertions.
 * The `.tsx` extension is still required, because `mountSettings` renders JSX.
 *
 * Living in `src/test/` rather than beside the suites, for `dom-helpers.ts`'s
 * reason (DW-471): a fifth mounted suite,
 * `src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx`,
 * sits in a different directory entirely, so a `./settings-harness` sibling
 * import could not reach this file and it kept its own verbatim copy of the
 * ~50-field fixture. `@/test/settings-harness` resolves from any directory
 * through the `@` → `src` alias both vitest projects restate. Nothing the app
 * ships may import from `@/test/` — this module pulls `vitest` and
 * `@testing-library/react`, both devDependencies — and
 * `src/lib/__tests__/test-infra-conventions.test.ts` is what enforces that.
 */

/**
 * The stored settings, as `GET /api/settings` serves them on a fresh, writable,
 * OpenAI-configured deployment.
 *
 * This is the MAJORITY base — the fixture `settings-research-provider.test.tsx`
 * used verbatim, and the one the other three reached by changing two or three
 * fields. Change a value here only when the fresh-deployment answer itself
 * changes; a value one suite needs different belongs in that suite's overrides.
 */
export function settingsPayload(
  overrides: Partial<WorkbenchSettingsPayload> = {},
): WorkbenchSettingsPayload {
  return {
    // The write precondition `GET /api/settings` serves beside the values — the
    // opaque stamp the store holds, not a hash of the config (DW-197).
    //
    // `s1:` IS THE SETTINGS SCHEME, and the only one (DW-472). `newConfigVersion`
    // in `src/lib/config.ts` mints `s1:${32 hex}`, and `isStoredConfigVersion`
    // accepts exactly that or the `s1:unstamped` sentinel — there is no third
    // shape. `w1:` and `w1s:` belong to `src/lib/write-precondition.ts` and
    // version the CONTENT of wiki file bytes, a different store answering a
    // different question. Three fixtures here once overrode `version` to a
    // `w1:`-shaped value; nothing read it, so the wrong scheme sat green. A
    // fixture reaching for `w1:` in a settings payload is reaching for the
    // wrong scheme, not choosing a second legitimate one.
    version: "s1:00000000000000000000000000000000",
    chatProvider: "openai",
    chatModel: "gpt-4o",
    ingestProvider: "anthropic",
    ingestModel: "claude-sonnet-4-20250514",
    customBaseUrl: null,
    hasCustomApiKey: false,
    // No env-supplied credential either: `LLM_CUSTOM_API_KEY` and
    // `FIRECRAWL_API_KEY` are both unset on a fresh deployment, so both key
    // rows read as stored-only and keep their `Remove` (DW-66).
    envCustomApiKey: false,
    llmTimeoutSeconds: null,
    vectorSearchEnabled: false,
    embeddingProvider: "openai",
    embeddingModel: "text-embedding-3-small",
    embeddingBaseUrl: null,
    hasEmbeddingApiKey: false,
    // No substitution by default (DW-312), so every case written before the
    // pair existed announces exactly what it announced then — the cases that
    // are ABOUT the substitution opt in by overriding both fields.
    embeddingModelInEffect: null,
    embeddingModelOverridden: false,
    envEmbeddingProvider: null,
    envEmbeddingModel: null,
    envCustomBaseUrl: null,
    // No env-supplied credential for any vendor, so a STORED key is the only
    // one in play — which is what every key-row case asserts against.
    envEmbeddingApiKeyProviders: [],
    // Not on Workers. The binding leg of the vector gate fires for `workers-ai`
    // only (DW-225), so with the `openai` selection above it is inert — a suite
    // that selects `workers-ai` has to turn this on or the gate refuses for a
    // SECOND reason and every sentence under test changes.
    hasWorkersAiBinding: false,
    firecrawlBaseUrl: null,
    hasFirecrawlApiKey: false,
    envFirecrawlApiKey: false,
    // Deep Research, fresh.
    researchProvider: null,
    envResearchProvider: null,
    hasTavilyApiKey: false,
    hasSerpApiKey: false,
    serpApiEngine: null,
    searxngBaseUrl: null,
    envSearxngBaseUrl: null,
    searxngCategories: null,
    envResearchProviders: [],
    // Epic 7's panes: the Intake door has no inbound address configured and
    // MinerU is off, which is the fresh-deployment answer for both.
    inboundEmailAddress: null,
    inboundEmailEnabled: false,
    intakeKeepParsed: false,
    mineruMode: "off",
    mineruLocalBaseUrl: null,
    hasMinerUApiKey: false,
    // The loopback door, shut — the fail-closed answer every one of these
    // fixtures wants, since none of them is about Epic 8's pane.
    apiEnabled: false,
    allowUnauthenticated: false,
    hasLoopbackApiToken: false,
    loopbackTokenSource: "none",
    language: "English",
    readOnly: false,
    ...overrides,
  };
}

/**
 * ONE mock for the whole file, reset between tests rather than replaced.
 *
 * A fresh `vi.fn()` per `beforeEach` would leave every `fetchMock.…` reference a
 * suite captured pointing at last test's object. Keeping the identity stable and
 * resetting the state is what lets a call site hold the value this returns for
 * the length of the file — which is how all four suites were already written.
 */
const fetchMock = vi.fn();

/**
 * Whether this file called `installSettingsFetchMock()`.
 *
 * Module state, and therefore PER TEST FILE: vitest gives each file its own
 * module registry, so this is never shared between suites.
 */
let installed = false;

/**
 * Stub `fetch` for the file and tear the tree down in the right order.
 *
 * Call ONCE at module top level, before the `describe`s: that registers the
 * hooks after `vitest.setup.dom.ts` has registered its own, and vitest runs
 * `afterEach` hooks in REVERSE registration order — so the `cleanup()` below
 * lands FIRST, unmounting while `fetch` is still stubbed. The setup file's
 * `cleanup()` stays a backstop behind it.
 */
export function installSettingsFetchMock(): typeof fetchMock {
  // Installing twice registers BOTH hooks twice. The second `afterEach` would
  // call `vi.unstubAllGlobals()` again (harmless) and `cleanup()` again on an
  // already-empty tree (also harmless) — so the damage is silent rather than
  // loud, and the file would look installed once while behaving otherwise.
  if (installed) {
    throw new Error(
      "installSettingsFetchMock() was called twice in one file. It registers " +
        "a beforeEach/afterEach pair, so a second call double-registers both. " +
        "Call it once at module top level and hold the mock it returns.",
    );
  }
  installed = true;

  beforeEach(() => {
    // Drops recorded calls AND any `mockResolvedValue` a previous test left, so
    // this behaves exactly as the per-test `vi.fn()` it replaces.
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    // FIRST: vitest runs afterEach hooks in reverse registration order, so the
    // setup file's `cleanup()` lands after this one. Unmounting here tears the
    // tree down while `fetch` is still stubbed.
    cleanup();
    vi.unstubAllGlobals();
  });

  return fetchMock;
}

/**
 * What a screen reader would actually read out for a control: every id in its
 * `aria-describedby` list, resolved and joined. A single `getElementById` over
 * the whole attribute silently returns null the moment a second id is appended,
 * which would make an assertion on the description pass vacuously.
 */
export function announcedFor(control: HTMLElement): string {
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

/**
 * Mount one Settings category over `stored` and let the single on-mount read
 * settle.
 *
 * `headingId` is the id `SettingsCanvas` labels its region with; every mounted
 * suite passes the same one the shell does. The wait is on
 * `SETTINGS_LOADING_COPY` rather than on the mock's promise because the surface
 * swaps the loading text out in an effect, and asserting before that swap reads
 * the placeholder instead of the values.
 */
export async function mountSettings(
  category: SettingsCategoryId,
  stored: WorkbenchSettingsPayload,
) {
  // Without the install, `fetch` is the real one: the surface's on-mount read
  // goes to the network, never resolves against `stored`, and the failure
  // surfaces as an opaque `waitFor` timeout pointing at the loading text rather
  // than at the missing setup line.
  if (!installed) {
    throw new Error(
      "mountSettings() needs installSettingsFetchMock(): without it `fetch` is " +
        "not stubbed, the on-mount read never resolves against the payload, " +
        "and this fails as a waitFor timeout. Add " +
        "`installSettingsFetchMock();` at this file's top level.",
    );
  }
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ workbench: stored }),
  } as unknown as Response);
  const view = render(<SettingsCanvas category={category} headingId="wb-set-heading" />);
  // The loading state is replaced once the read lands.
  await waitFor(() => expect(screen.queryByText(SETTINGS_LOADING_COPY)).toBeNull());
  return view;
}

/**
 * Mount one Settings category over a QUEUE of responses — one per `fetch` call.
 *
 * The sibling of {@link mountSettings}, for the suites that drive a save and so
 * need the read, the PUT and whatever follows to answer differently. Once the
 * queue is exhausted the LAST response answers every further call, which is
 * what lets a case that only cares about the first two entries make a third
 * request without arranging for it.
 *
 * The two stay two functions rather than one with an overloaded argument: a
 * suite that mounts a FIXED store reads as a statement about that store, and
 * collapsing them would put a single-element array at every one of those call
 * sites saying nothing.
 */
export async function mountSettingsQueue(
  category: SettingsCategoryId,
  responses: Array<() => unknown>,
) {
  // Same reason as `mountSettings`: without the install `fetch` is the real
  // one, so the queue answers nothing and the failure surfaces as an opaque
  // `waitFor` timeout on the loading text rather than at the missing line.
  if (!installed) {
    throw new Error(
      "mountSettingsQueue() needs installSettingsFetchMock(): without it " +
        "`fetch` is not stubbed, the on-mount read never resolves against the " +
        "queue, and this fails as a waitFor timeout. Add " +
        "`installSettingsFetchMock();` at this file's top level.",
    );
  }
  // An empty queue has no last entry to fall back on, so
  // `responses[Math.min(0, -1)]` is `responses[-1]` — `undefined`, called as a
  // function INSIDE the stub. That surfaces as the same opaque `waitFor`
  // timeout on the loading text the guard above exists to eliminate, with
  // `next is not a function` buried in a rejected fetch nobody awaits.
  if (responses.length === 0) {
    throw new Error(
      "mountSettingsQueue() was given an empty queue, so there is nothing to " +
        "answer the surface's on-mount read with. Pass at least the read; a " +
        "mount over a FIXED store is `mountSettings(category, payload)`.",
    );
  }
  let call = 0;
  fetchMock.mockImplementation(async () => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return next() as Response;
  });
  const view = render(<SettingsCanvas category={category} headingId="wb-set-heading" />);
  // The loading state is replaced once the read lands.
  await waitFor(() => expect(screen.queryByText(SETTINGS_LOADING_COPY)).toBeNull());
  return view;
}

/**
 * The `workbench` patch the nth `fetch` call sent.
 *
 * Indexes the mock's calls DIRECTLY, so `n` counts every call the surface made
 * — the on-mount read is call 0, and a recovery GET occupies an index of its
 * own. NOT the same reader as the one `settings-save-in-flight.test.tsx`
 * defines under this name: that file routes its stub by URL and indexes a
 * FILTERED list of `/api/settings` calls only, which answers the different
 * question "what did the nth SETTINGS call carry" while other endpoints are in
 * play. Leave that one where it is.
 */
export function patchOf(call: number): Record<string, unknown> {
  // An index past the end — or any index at all before the surface has fetched
  // anything — would destructure `undefined` and die as
  // `undefined is not iterable`, a message about the destructuring rather than
  // about the index. The body-less case below gets a named error; so does this.
  const made = fetchMock.mock.calls.length;
  if (call < 0 || call >= made) {
    throw new Error(
      `patchOf(${call}): there is no such fetch call — ${made} ` +
        `${made === 1 ? "call was" : "calls were"} made. Wait for the call to ` +
        `have happened — the waitFor on the mock's call count every case here ` +
        `already makes — before reading its body.`,
    );
  }
  const [, init] = fetchMock.mock.calls[call] as [string, RequestInit];
  // A GET carries none, and `JSON.parse(String(undefined))` would throw
  // `Unexpected token u` — a message about nothing, at a stack frame in the
  // parser rather than at the call index that is actually wrong.
  if (init?.body == null) {
    throw new Error(
      `patchOf(${call}): that fetch call carried no body, so there is no ` +
        `workbench patch to read. Call 0 is the surface's on-mount read, and a ` +
        `recovery read takes an index of its own — count every call, not just ` +
        `the saves.`,
    );
  }
  return (JSON.parse(String(init.body)) as { workbench: Record<string, unknown> })
    .workbench;
}
