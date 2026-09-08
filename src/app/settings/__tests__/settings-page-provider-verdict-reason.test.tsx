import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import SettingsPage from "@/app/settings/page";
import { ollamaBaseUrlRefusedCopy } from "@/lib/workbench-settings";

/**
 * The `/settings` provider verdict saying WHY, MOUNTED (DW-417).
 *
 * The sentence has existed on the wire since DW-402 — `getProviderInfo()` mints
 * it, `/api/status` serves it as `ProviderInfo.ollamaBaseUrlIssue`, and
 * `useSettings` types it as REQUIRED on `ProviderStatus`. The only component
 * that ever rendered it is `StatusBadge`, which is mounted nowhere. So on the
 * page an owner actually opens, "No LLM provider configured" arrived bare: the
 * same six words for "nothing was ever set" and for "what you set was thrown
 * away", and only the second one has an action attached.
 *
 * Nothing unit-testable connects the served field to a rendered node — the
 * sentence is pinned in `workbench-settings.test.ts` and the hook would happily
 * carry it forever with no reader — so this file mounts the real page over the
 * real hook and stubs only `fetch`. The panels below the form are stubbed for
 * the reason `settings-page-legacy-surface-parity.test.tsx` documents: each
 * fetches its own endpoint on mount, and an unhandled probe settles outside
 * `act`.
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

/** A stamp in the settings store's own `s1:` scheme (`newConfigVersion`). */
const VERSION = "s1:1a1a1a1a2b2b2b2b3c3c3c3c4d4d4d4d";

/** The resolver's own sentence, never a second wording composed for this file. */
const ISSUE = ollamaBaseUrlRefusedCopy("env", "localhost:11434");

/**
 * The OTHER leg's sentence. `resolveOllamaBaseUrl`'s config branch refuses a
 * STORED endpoint, and that refusal reaches the page only on
 * `EffectiveSettings` — `/api/status` answers the env question and by DW-370's
 * design never consults the store, so it reports `null` here.
 */
const STORED_ISSUE = ollamaBaseUrlRefusedCopy("config", "ollama.internal:11434");

/** The amber verdict this page renders when nothing resolved. */
const VERDICT = "No LLM provider configured";

/**
 * `/api/settings` for a deployment with nothing configured — the state that
 * accompanies a refused endpoint, since a refused `OLLAMA_BASE_URL` set alone
 * selects no provider at all.
 *
 * It carries `ollamaBaseUrlIssue` because the real body does: the route spreads
 * a whole `EffectiveSettings`, and that object reports the FULL env→store
 * ladder's refusal — a different question from `/api/status`'s, which is the env
 * leg alone. Omitting it here would have let the store-leg cases below pass
 * against `undefined` rather than against what the server actually sends.
 */
function settingsBody(overrides: Record<string, unknown> = {}) {
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
    ollamaBaseUrlIssue: null,
    structuredKnowledgeProvider: null,
    structuredKnowledgeProviderSource: "none",
    structuredKnowledgeModel: null,
    structuredKnowledgeModelSource: "none",
    structuredKnowledgeConfigured: false,
    readOnly: false,
    version: VERSION,
    ...overrides,
  };
}

/** `/api/status` as `getProviderInfo()` serves it — every field, always. */
function providerStatus(overrides: Record<string, unknown> = {}) {
  return {
    configured: false,
    provider: null,
    model: null,
    embeddingSupport: false,
    ollamaBaseUrlIssue: null,
    ...overrides,
  };
}

/**
 * Answer `/api/status` with `status` and `/api/settings` with `settings`.
 *
 * `status: "fail"` makes the status door answer `500`, which is how
 * `useSettings.fetchStatus` is driven to `setStatus(null)` — the state where the
 * page has a loaded `settings` object and no `status` object at all.
 */
function stubFetch(status: unknown, settings: unknown = settingsBody()) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const href = String(url);
      if (href === "/api/status" && status === "fail") {
        return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
      }
      const answer =
        href === "/api/status"
          ? status
          : href === "/api/settings"
            ? settings
            : {};
      return { ok: true, status: 200, json: async () => answer } as unknown as Response;
    }),
  );
}

/** The status block: the bordered box the verdict and its reason share. */
function statusBlock(): HTMLElement {
  return screen.getByText(VERDICT).closest("div.rounded-lg") as HTMLElement;
}

afterEach(() => {
  // FIRST, for the reason the sibling suites document: vitest runs afterEach
  // hooks in reverse registration order, so the setup file's `cleanup()` lands
  // after this one and would unmount with `fetch` unstubbed.
  cleanup();
  vi.unstubAllGlobals();
});

describe("/settings says WHY there is no provider (DW-417)", () => {
  it("renders the refusal beneath the verdict when the resolver refused an endpoint", async () => {
    stubFetch(providerStatus({ ollamaBaseUrlIssue: ISSUE }));
    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByText(VERDICT)).toBeTruthy());

    // THE assertion. Byte-identical to the resolver's sentence — the page
    // composes nothing of its own, so a hook or a component that re-worded the
    // refusal fails here.
    const reason = screen.getByText(ISSUE);
    expect(reason.textContent).toBe(ISSUE);
    // It names the variable and the shape that would have been accepted, which
    // is the whole reason it beats a bare verdict.
    expect(reason.textContent).toContain("OLLAMA_BASE_URL");
    expect(reason.textContent).toContain("http://localhost:11434/api");

    // BENEATH the verdict, which is `StatusBadge`'s placement and for its
    // reason: it reads as a correction to the row above it rather than as a
    // second, competing complaint. Both inside the one status block.
    const block = statusBlock();
    expect(block.contains(reason)).toBe(true);
    expect(
      screen.getByText(VERDICT).compareDocumentPosition(reason) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("DESCRIBES: not an alert, not a control, nothing gated on it", async () => {
    // The convention the read-only banner below already follows. Nothing just
    // failed — this is the deployment's standing state — so an assertive live
    // region would interrupt a screen-reader user over a fact that was true
    // before they arrived.
    stubFetch(providerStatus({ ollamaBaseUrlIssue: ISSUE }));
    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByText(ISSUE)).toBeTruthy());
    const reason = screen.getByText(ISSUE);

    expect(reason.getAttribute("role")).toBeNull();
    expect(reason.getAttribute("aria-live")).toBeNull();
    expect(reason.querySelector("input,button,a,select,textarea")).toBeNull();
    // The save is untouched: the refused value lives in the environment, so
    // blocking a form that cannot write it would be a dead end.
    expect(
      (screen.getByRole("button", { name: "Save Settings" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("emits no extra node when the resolver refused nothing", async () => {
    // The other half of the I/O matrix. `null` is the commonest value this
    // field has — a deployment that never set `OLLAMA_BASE_URL` at all — and
    // the block must render exactly as it did before this change.
    stubFetch(providerStatus());
    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByText(VERDICT)).toBeTruthy());

    // ONE child row in the block: the verdict, and nothing under it.
    const block = statusBlock();
    expect(block.children).toHaveLength(1);
    expect(block.querySelector("p")).toBeNull();
    expect(block.textContent).toBe(VERDICT);
  });

  it("says nothing at all while the status is still loading", async () => {
    // `status` and `settings` both null is the shimmer branch, which is a
    // different state from "no provider" and must not borrow its reason. A
    // `fetch` that never settles is what holds the page there.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByText("Checking provider…")).toBeTruthy());
    expect(screen.queryByText(VERDICT)).toBeNull();
    expect(screen.queryByText(ISSUE)).toBeNull();
  });

  it("leaves the CONFIGURED verdict exactly as it was", async () => {
    // A refused endpoint ALONGSIDE a working provider is a different state from
    // the one DW-417 names — `ProviderForm`'s endpoint block is where that one
    // is said, and this branch must not grow a second copy of it.
    stubFetch(
      providerStatus({
        configured: true,
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        embeddingSupport: true,
        ollamaBaseUrlIssue: ISSUE,
      }),
    );
    render(<SettingsPage />);

    await waitFor(() =>
      expect(document.body.textContent).toContain("Connected:"),
    );
    expect(screen.queryByText(VERDICT)).toBeNull();
    expect(screen.queryByText(ISSUE)).toBeNull();
  });

  it("reads the STORE leg's refusal, which /api/status never reports", async () => {
    // THE FIRST GAP a status-only read left open. `ProviderInfo` is the
    // ENVIRONMENT's answer — `detectEnvProvider` does not consult the store, by
    // DW-370's design — so an endpoint refused out of the saved config arrives
    // on `EffectiveSettings` and nowhere else. Reading only `/api/status` left
    // that whole deployment staring at the bare verdict.
    stubFetch(
      providerStatus(),
      settingsBody({ ollamaBaseUrlIssue: STORED_ISSUE }),
    );
    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByText(VERDICT)).toBeTruthy());
    await waitFor(() => expect(screen.getByText(STORED_ISSUE)).toBeTruthy());

    const reason = screen.getByText(STORED_ISSUE);
    expect(reason.textContent).toBe(STORED_ISSUE);
    // The store leg names what to fix in the store, not a variable nobody set.
    expect(reason.textContent).toContain("The stored Ollama endpoint");
    expect(statusBlock().contains(reason)).toBe(true);
  });

  it("still says why when /api/status itself failed and only /api/settings answered", async () => {
    // THE SECOND GAP. `fetchStatus` swallows a failed probe into
    // `setStatus(null)`, and the route's own catch branch hardcodes
    // `ollamaBaseUrlIssue: null` — so on a 500 the env leg reports nothing
    // whatever the environment holds, while `settings` loaded fine and is
    // carrying the sentence. `settings` alone is enough to leave the shimmer,
    // so the owner lands on the verdict with the reason available and unread.
    stubFetch("fail", settingsBody({ ollamaBaseUrlIssue: ISSUE }));
    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByText(VERDICT)).toBeTruthy());
    expect(screen.getByText(ISSUE).textContent).toBe(ISSUE);
  });

  it("renders the sentence ONCE when both legs report it", async () => {
    // Both fields non-null is the ordinary reading of one refused
    // `OLLAMA_BASE_URL`: the env leg refuses it, and the full ladder reports the
    // same refusal because the env leg is its first rung. They are one sentence
    // about one variable, so two nodes would be the page saying it twice.
    stubFetch(
      providerStatus({ ollamaBaseUrlIssue: ISSUE }),
      settingsBody({ ollamaBaseUrlIssue: ISSUE }),
    );
    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByText(VERDICT)).toBeTruthy());

    // `getAllByText` rather than `getByText`: the singular form throws on a
    // duplicate, which would report "found multiple" instead of the count this
    // case is actually about.
    const block = statusBlock();
    const inBlock = Array.from(block.querySelectorAll("p")).filter(
      (node) => node.textContent === ISSUE,
    );
    expect(inBlock).toHaveLength(1);
    expect(block.children).toHaveLength(2);
  });
});
