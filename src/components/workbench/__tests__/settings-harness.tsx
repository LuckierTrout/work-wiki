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
