import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StatusBadge } from "@/components/StatusBadge";
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

/** The `/api/status` body, with the two fields these cases move. */
function status(overrides: Record<string, unknown> = {}) {
  return {
    configured: false,
    provider: null,
    model: null,
    embeddingSupport: false,
    ollamaBaseUrlIssue: null,
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
