import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CONFIG_UNREADABLE_BADGE_COPY, StatusBadge } from "@/components/StatusBadge";
import { ollamaBaseUrlRefusedCopy } from "@/lib/workbench-settings";

/**
 * The setup help panel, MOUNTED (DW-402).
 *
 * The panel lists `OLLAMA_BASE_URL` as one of the variables to set. On a
 * deployment that SET it and had it refused, that list was advice the owner had
 * already followed: `/api/status` answered `configured: false` for both "no
 * variable" and "a variable we threw away", and only the second has a fix. The
 * route now carries the sentence, and whether the panel SAYS it is not
 * something a source scan can check.
 *
 * The component had no test before this file.
 */

const REFUSAL = ollamaBaseUrlRefusedCopy("env", "localhost:11434");

/** The `/api/status` body, with the three fields these cases move. */
function status(overrides: Record<string, unknown> = {}) {
  return {
    configured: false,
    provider: null,
    model: null,
    embeddingSupport: false,
    ollamaBaseUrlIssue: null,
    configUnreadable: false,
    ...overrides,
  };
}

/** Answer `/api/status` with `body`; answer everything else blandly. */
function stubFetch(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const answer = String(url) === "/api/status" ? body : {};
      return { ok: true, status: 200, json: async () => answer } as unknown as Response;
    }),
  );
}

/**
 * Open the panel, which is behind a disclosure button.
 *
 * `fireEvent`, not a raw `button.click()`: RTL wraps its events in `act`, so
 * the state update and the re-render it causes are flushed before the next
 * assertion. A bare DOM click leaves React to settle outside `act`, which is
 * the "not wrapped in act(...)" warning — and, on a slower update, a query
 * against the tree as it was BEFORE the panel opened.
 */
async function openHelp(): Promise<HTMLElement> {
  const button = await screen.findByRole("button", { name: "How to configure" });
  fireEvent.click(button);
  return await screen.findByText("Set one of these environment variables:");
}

beforeEach(() => {
  stubFetch(status());
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's `cleanup()` lands after this one and would unmount a tree with
  // `fetch` already unstubbed.
  cleanup();
  vi.unstubAllGlobals();
});

describe("StatusBadge stops recommending a variable the deployment refused", () => {
  it("shows the served reason beneath the variable list", async () => {
    stubFetch(status({ ollamaBaseUrlIssue: REFUSAL }));
    render(<StatusBadge />);

    const panel = await openHelp();
    const body = panel.parentElement!;

    // THE assertion: the panel still lists the variable AND now says this
    // deployment's value for it was seen and rejected.
    expect(body.textContent).toContain("OLLAMA_BASE_URL / OLLAMA_MODEL");
    expect(body.textContent).toContain(REFUSAL);
    // The whole sentence, remedy included — the list alone is the advice the
    // owner already took.
    expect(screen.getByText(REFUSAL)).toBeTruthy();
  });

  it("leaves the variable list exactly as it was when nothing was refused", async () => {
    render(<StatusBadge />);

    const panel = await openHelp();
    const body = panel.parentElement!;

    for (const variable of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "DEEPSEEK_API_KEY",
      "OLLAMA_API_KEY",
      "OLLAMA_BASE_URL / OLLAMA_MODEL",
    ]) {
      expect(body.textContent).toContain(variable);
    }
    // …and no stray sentence: the reason is a function of the payload, not
    // something the panel decides for itself.
    expect(body.textContent).not.toContain("is not an absolute");
  });

  it("never shows the panel — or the reason — on a configured deployment", async () => {
    // The panel is the unconfigured branch's own copy. A configured deployment
    // has nothing to be told about setup, and an endpoint complaint beside
    // "Connected" would contradict the line above it.
    stubFetch(
      status({
        configured: true,
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        ollamaBaseUrlIssue: REFUSAL,
      }),
    );
    render(<StatusBadge />);

    await waitFor(() => expect(document.body.textContent).toContain("Connected"));
    expect(screen.queryByRole("button", { name: "How to configure" })).toBeNull();
    expect(document.body.textContent).not.toContain(REFUSAL);
  });
});

/**
 * The unreadable STORE, as `/api/status` now serves it (DW-622).
 *
 * The route used to read through `loadConfig()`, which flattens an unreadable
 * store to `{}` — so this badge could not tell "nothing was ever saved" from
 * "what was saved could not be read", and rendered the same reassuring line for
 * both. The route now carries `configUnreadable`; whether the badge SAYS it, in
 * BOTH of its states, is not something a source scan can check.
 */
describe("StatusBadge says when the stored settings could not be read", () => {
  it("shows the caveat beside a provider the ENVIRONMENT resolved", async () => {
    // The state most likely to mislead: everything reads as a success, and the
    // stored half of the settings — a saved model, endpoint or key the owner
    // expects to be in force — is silently not applied.
    stubFetch(
      status({
        configured: true,
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        configUnreadable: true,
      }),
    );
    render(<StatusBadge />);

    await waitFor(() => expect(document.body.textContent).toContain("Connected"));
    expect(screen.getByText(CONFIG_UNREADABLE_BADGE_COPY)).toBeTruthy();
  });

  it("shows the caveat in the not-configured state, without opening the panel", async () => {
    // An owner who reads "no provider configured" goes off to set a variable.
    // Burying this behind the disclosure would let them do exactly that while
    // the provider they already saved sits in a file nothing could parse.
    stubFetch(status({ configUnreadable: true }));
    render(<StatusBadge />);

    await waitFor(() =>
      expect(document.body.textContent).toContain("No LLM provider configured"),
    );
    expect(screen.getByText(CONFIG_UNREADABLE_BADGE_COPY)).toBeTruthy();
    // …and it is not something the panel decides for itself: it was already on
    // screen before the disclosure was touched.
    await openHelp();
    expect(screen.getAllByText(CONFIG_UNREADABLE_BADGE_COPY)).toHaveLength(1);
  });

  it("names no file, error or value — the flag it renders is a boolean", async () => {
    // AD-23: the config file holds API keys and a `JSON.parse` message quotes
    // the offending bytes back, so the route serves a boolean and this line is
    // all there is to render. Pinned here because the copy is the only place a
    // future edit could reintroduce detail the payload does not even carry.
    stubFetch(status({ configUnreadable: true }));
    render(<StatusBadge />);

    await waitFor(() =>
      expect(screen.getByText(CONFIG_UNREADABLE_BADGE_COPY)).toBeTruthy(),
    );
    // ASSERTED AGAINST WHAT WAS RENDERED, not only against the constant: detail
    // added BESIDE the sentence in the JSX — a filename in a sibling span, a
    // parser message appended after it — passes a constant-level check and still
    // puts it on screen. The whole tree is in scope here precisely so that
    // cannot happen.
    const rendered = document.body.textContent ?? "";
    expect(rendered).toContain(CONFIG_UNREADABLE_BADGE_COPY);
    for (const leak of ["config.json", "JSON", "parse", "sk-", "/"]) {
      expect(rendered).not.toContain(leak);
      expect(CONFIG_UNREADABLE_BADGE_COPY).not.toContain(leak);
    }
  });

  it("stays silent when the store read fine", async () => {
    // Both states, because the caveat now lives on both branches: a flag that
    // was rendered unconditionally would be a standing complaint on every
    // healthy deployment.
    render(<StatusBadge />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("No LLM provider configured"),
    );
    expect(screen.queryByText(CONFIG_UNREADABLE_BADGE_COPY)).toBeNull();
    await openHelp();
    expect(screen.queryByText(CONFIG_UNREADABLE_BADGE_COPY)).toBeNull();

    cleanup();
    stubFetch(status({ configured: true, provider: "anthropic", model: "claude-x" }));
    render(<StatusBadge />);
    await waitFor(() => expect(document.body.textContent).toContain("Connected"));
    expect(screen.queryByText(CONFIG_UNREADABLE_BADGE_COPY)).toBeNull();
  });
});
