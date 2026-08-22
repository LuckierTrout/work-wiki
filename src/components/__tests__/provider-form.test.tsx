import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ProviderForm, type ProviderFormProps } from "@/components/ProviderForm";
import { ollamaBaseUrlRefusedCopy } from "@/lib/workbench-settings";

/**
 * The Ollama Base URL block, MOUNTED (DW-402).
 *
 * The resolver refuses an endpoint that is not an absolute `http(s)` URL and
 * falls through to nothing, which used to leave this form showing an EMPTY box
 * beside a `none` source badge — the same picture a deployment that never set
 * one shows, and only one of the two has a fix. `GET /api/settings` now carries
 * the sentence; whether the form SAYS it is not something a source scan can
 * check, so these cases are made against the rendered DOM.
 *
 * The component had no test before this file.
 */

/** The refusal exactly as the server mints it — never a second wording here. */
const ENV_REFUSAL = ollamaBaseUrlRefusedCopy("env", "localhost:11434");
const STORE_REFUSAL = ollamaBaseUrlRefusedCopy("config", "not-a-url");

type Settings = NonNullable<ProviderFormProps["settings"]>;

/** Only the fields these cases move; the rest is a shape the component reads. */
function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    provider: "ollama",
    providerSource: "config",
    model: null,
    modelSource: "none",
    configured: true,
    embeddingSupport: false,
    embeddingModel: null,
    embeddingModelSource: "none",
    hasApiKey: false,
    ollamaBaseUrl: null,
    ollamaBaseUrlSource: "none",
    ollamaBaseUrlIssue: null,
    ...overrides,
  };
}

function props(overrides: Partial<ProviderFormProps> = {}): ProviderFormProps {
  return {
    provider: "ollama",
    setProvider: vi.fn(),
    model: "",
    setModel: vi.fn(),
    ollamaBaseUrl: "",
    setOllamaBaseUrl: vi.fn(),
    settings: settings(),
    ...overrides,
  };
}

/**
 * The Ollama endpoint control's own container, so "inside the block" is
 * testable.
 *
 * `closest("div")` from the label IS that container — the `showOllamaUrl`
 * block's own `<div>`. This used to walk one further to `.parentElement`, which
 * is the fragment's render container, i.e. the WHOLE form: every
 * `textContent` assertion below then passed for a sentence rendered anywhere on
 * the page, and the "inside this block, never outside it" rule was unpinned.
 */
function ollamaBlock(): HTMLElement {
  const label = screen.getByText("Ollama Base URL");
  return label.closest("div")!;
}

afterEach(() => {
  cleanup();
});

describe("ProviderForm says why the Ollama endpoint box is empty", () => {
  it("renders the served sentence inside the endpoint block", () => {
    render(
      <ProviderForm
        {...props({
          settings: settings({ ollamaBaseUrlIssue: ENV_REFUSAL }),
        })}
      />,
    );

    // THE assertion: the owner reads the variable, the refused value and what
    // to set instead, in the place the empty box is.
    expect(screen.getByText(ENV_REFUSAL)).toBeTruthy();
    expect(ollamaBlock().textContent).toContain(ENV_REFUSAL);

    // …and the input POINTS AT it. Beside is not enough: a hint that is merely
    // adjacent is invisible to a screen reader, which is the convention the
    // Workbench settings rows already state.
    const input = screen.getByLabelText(/Ollama Base URL/) as HTMLInputElement;
    expect(input.getAttribute("aria-describedby")).toBe("ollamaBaseUrlIssue");
    expect(document.getElementById("ollamaBaseUrlIssue")!.textContent).toBe(ENV_REFUSAL);

    // DESCRIBES, does not mark: no control is flagged invalid and nothing is
    // disabled — this is half a configuration, not a rejected input.
    expect(document.querySelector("[aria-invalid]")).toBeNull();
    expect(input.readOnly).toBe(false);
  });

  it("COMPOSES the reason with the read-only sentence rather than replacing it", () => {
    // Both can apply at once — a read-only deployment whose endpoint was also
    // refused — and each answers a different question: why the box refuses
    // edits, and why it is empty. Picking one would silence the other.
    render(
      <ProviderForm
        {...props({
          readOnly: true,
          describedBy: "readOnlyNote",
          settings: settings({ ollamaBaseUrlIssue: ENV_REFUSAL }),
        })}
      />,
    );

    const input = screen.getByLabelText(/Ollama Base URL/) as HTMLInputElement;
    const ids = input.getAttribute("aria-describedby")!.split(" ");
    expect(ids).toContain("readOnlyNote");
    expect(ids).toContain("ollamaBaseUrlIssue");
  });

  it("points at nothing when there is nothing to point at", () => {
    // `undefined`, never `""`: an empty `aria-describedby` is an attribute
    // referencing no element, which is worse than the absent attribute.
    render(<ProviderForm {...props()} />);

    const input = screen.getByLabelText(/Ollama Base URL/);
    expect(input.hasAttribute("aria-describedby")).toBe(false);
  });

  it("renders the STORED refusal the same way — the form does not compose the wording", () => {
    // The sentence naming the store is a different string from the one naming
    // the variable, and both arrive as data. A form that reworded either could
    // drift from the log line the server emitted.
    render(
      <ProviderForm
        {...props({
          settings: settings({
            ollamaBaseUrlSource: "none",
            ollamaBaseUrlIssue: STORE_REFUSAL,
          }),
        })}
      />,
    );

    expect(ollamaBlock().textContent).toContain(STORE_REFUSAL);
    expect(document.body.textContent).not.toContain("OLLAMA_BASE_URL");
  });

  it("renders it beside a POPULATED box, where the endpoint in use is not the one that was set", () => {
    // The real shape of "a reason beside a value": `OLLAMA_BASE_URL` was
    // refused and the STORED endpoint took over, so the box shows an address,
    // the badge says `config`, and the sentence explains that the variable the
    // owner set is not the one being used. Without it the page looks simply
    // correct.
    //
    // NOT the `env` source: that spelling of the control — the read-only div —
    // can never carry a reason at all. `ollamaBaseUrlSource === "env"` means
    // the env leg RETURNED a URL, and `resolveOllamaBaseUrl` hands that answer
    // back outright with `issue: null`, so the pairing is a payload the server
    // cannot emit and a test asserting it would pin fiction.
    render(
      <ProviderForm
        {...props({
          settings: settings({
            ollamaBaseUrl: "http://ollama.internal:11434",
            ollamaBaseUrlSource: "config",
            ollamaBaseUrlIssue: ENV_REFUSAL,
          }),
        })}
      />,
    );

    expect(
      (screen.getByLabelText(/Ollama Base URL/) as HTMLInputElement).readOnly,
    ).toBe(false);
    expect(ollamaBlock().textContent).toContain(ENV_REFUSAL);
  });

  it("renders nothing when the payload carries no reason", () => {
    // The common case, and the one a mis-wiring would fill with a stray note:
    // the sentence is a function of what the route said, not something the form
    // decides for itself.
    render(<ProviderForm {...props()} />);

    expect(screen.getByLabelText(/Ollama Base URL/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("is not an absolute");
  });

  it("renders nothing when the picker is not on Ollama, reason or no reason", () => {
    // The whole block is gone for another provider, and the sentence must not
    // outlive it: an endpoint complaint beside an Anthropic selection would
    // describe a control that is not on screen.
    render(
      <ProviderForm
        {...props({
          provider: "anthropic",
          settings: settings({
            provider: "anthropic",
            ollamaBaseUrlIssue: ENV_REFUSAL,
          }),
        })}
      />,
    );

    expect(screen.queryByLabelText(/Ollama Base URL/)).toBeNull();
    expect(document.body.textContent).not.toContain(ENV_REFUSAL);
  });
});
