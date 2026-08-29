import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ProviderForm, type ProviderFormProps } from "@/components/ProviderForm";
import {
  SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY,
  ollamaBaseUrlRefusedCopy,
} from "@/lib/workbench-settings";

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

describe("ProviderForm points the picker at the notes beside it", () => {
  /**
   * The notes are POINTERS, not warnings (DW-400, DW-419, DW-420).
   *
   * The custom-endpoint note says where the base URL and the API key are
   * actually configured (DW-400); the credential-status line says whether the
   * SELECTED provider has a key on the server (DW-420); the Ollama Cloud note
   * says the key is a Worker secret never returned to the page (DW-419). All
   * three used to sit beside the picker with nothing associating them — so an owner who moved to the select
   * heard the option name and none of them. Whether the select POINTS at each
   * node is not something a source scan can check, so these cases are made
   * against the rendered DOM, and every emitted id is resolved.
   */
  function picker(): HTMLElement {
    return document.getElementById("provider")!;
  }

  /** The ids the picker actually announces, in the order it announces them. */
  function describedIds(): string[] {
    return (picker().getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
  }

  it("describes the picker with the note when `custom` is picked on a writable deployment", () => {
    render(
      <ProviderForm
        {...props({
          provider: "custom",
          settings: settings({ provider: "custom" }),
        })}
      />,
    );

    // DOM reading order: the credential line sits under the select (DW-420),
    // the note below both.
    expect(picker().getAttribute("aria-describedby")).toBe(
      "providerCredentialStatus providerCustomEndpoint",
    );
    // Each id resolves to a node, and the note carries the SHARED sentence —
    // an attribute pointing at nothing announces nothing.
    for (const id of describedIds()) expect(document.getElementById(id)).not.toBeNull();
    expect(
      document.getElementById("providerCustomEndpoint")!.textContent,
    ).toContain(SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY);
  });

  it("COMPOSES all three notes rather than letting one replace another", () => {
    // A read-only deployment already storing `custom`: all three apply, and
    // each answers a different question — why the picker refuses, whether the
    // provider has a key, and what is still unconfigured. The read-only
    // sentence stays FIRST, matching the Ollama input's order so one page does
    // not announce it in two positions; the rest follow in DOM reading order,
    // so the announced description matches the visual one.
    render(
      <ProviderForm
        {...props({
          provider: "custom",
          readOnly: true,
          describedBy: "readOnlyNote",
          settings: settings({ provider: "custom" }),
        })}
      />,
    );

    expect(picker().getAttribute("aria-describedby")).toBe(
      "readOnlyNote providerCredentialStatus providerCustomEndpoint",
    );
    // Both ids this component owns resolve. `readOnlyNote` is the PAGE's node
    // and is not rendered here, which is why it is not walked.
    expect(document.getElementById("providerCredentialStatus")).not.toBeNull();
    expect(document.getElementById("providerCustomEndpoint")).not.toBeNull();
  });

  it("drops the conditional notes' ids while their nodes are not showing", () => {
    // A note's id is contributed only while the note renders; appending either
    // unconditionally would point the picker at an absent element. The
    // credential line has no such gate on a loaded page — it renders whenever
    // `settings` does (DW-420), so its id is here.
    render(
      <ProviderForm
        {...props({
          provider: "anthropic",
          readOnly: true,
          describedBy: "readOnlyNote",
          settings: settings({ provider: "anthropic" }),
        })}
      />,
    );

    expect(picker().getAttribute("aria-describedby")).toBe(
      "readOnlyNote providerCredentialStatus",
    );
    expect(document.getElementById("providerCustomEndpoint")).toBeNull();
    expect(document.getElementById("providerOllamaCloud")).toBeNull();
  });

  it("names the credential line alone on a writable, plain-provider deployment", () => {
    // The commonest shape of all: nothing refuses and no picker-conditional
    // note is showing, but the selected provider's credential state still
    // belongs WITH the control rather than left to be found by browsing.
    render(
      <ProviderForm
        {...props({
          provider: "openai",
          settings: settings({ provider: "openai", hasApiKey: true }),
        })}
      />,
    );

    expect(picker().getAttribute("aria-describedby")).toBe("providerCredentialStatus");
    // The id resolves, and to the node carrying the EXACT served sentence —
    // "the picker points at the sentence" is the whole claim.
    expect(document.getElementById("providerCredentialStatus")!.textContent).toBe(
      "✓ API key configured on server",
    );
  });

  it("names the same line when the server has NO key for the stored provider", () => {
    // The one branch that reports a problem rather than a state (DW-420). It is
    // still a description, not a validation error: the picker is not marked
    // invalid and the save is not blocked, so an owner who cannot reach the
    // server environment can still see and store the selection.
    render(
      <ProviderForm
        {...props({
          provider: "openai",
          settings: settings({ provider: "openai", hasApiKey: false }),
        })}
      />,
    );

    expect(picker().getAttribute("aria-describedby")).toBe("providerCredentialStatus");
    expect(document.getElementById("providerCredentialStatus")!.textContent).toBe(
      "⚠ No API key — set via server environment variables",
    );
    expect(picker().getAttribute("aria-invalid")).toBeNull();
  });

  it("names the same line when the credential is not yet knowable", () => {
    // A selection the server has not stored yet: the line says so, and the
    // picker points at the same node — the id is gated on `settings`, which is
    // the line's OWN gate, not on which provider is picked.
    render(
      <ProviderForm
        {...props({
          provider: "openai",
          settings: settings({ provider: "anthropic", hasApiKey: true }),
        })}
      />,
    );

    expect(picker().getAttribute("aria-describedby")).toBe("providerCredentialStatus");
    expect(document.getElementById("providerCredentialStatus")!.textContent).toBe(
      "Save this selection to check its server credential",
    );
  });

  it("adds the Ollama Cloud note AFTER the credential line, both resolving", () => {
    // DW-419: the same shape of picker-conditional pointer `custom` already
    // had. Two ids, in the order the two nodes appear on screen.
    render(
      <ProviderForm
        {...props({
          provider: "ollama-cloud",
          settings: settings({ provider: "ollama-cloud", hasApiKey: true }),
        })}
      />,
    );

    expect(describedIds()).toEqual([
      "providerCredentialStatus",
      "providerOllamaCloud",
    ]);
    for (const id of describedIds()) expect(document.getElementById(id)).not.toBeNull();
    expect(document.getElementById("providerOllamaCloud")!.textContent).toContain(
      "never returned to this page",
    );
  });

  it("puts the Ollama Cloud note LAST behind the read-only sentence and the credential line", () => {
    // `ollamaCloudId` is the final slot in the composition array, and its
    // position relative to the other two is only observable here — the
    // `custom` rows exercise the slot before it.
    render(
      <ProviderForm
        {...props({
          provider: "ollama-cloud",
          readOnly: true,
          describedBy: "readOnlyNote",
          settings: settings({ provider: "ollama-cloud", hasApiKey: true }),
        })}
      />,
    );

    expect(describedIds()).toEqual([
      "readOnlyNote",
      "providerCredentialStatus",
      "providerOllamaCloud",
    ]);
    // Both ids this component owns resolve; `readOnlyNote` is the PAGE's node.
    expect(document.getElementById("providerCredentialStatus")).not.toBeNull();
    expect(document.getElementById("providerOllamaCloud")).not.toBeNull();
  });

  it("names the Ollama Cloud note ALONE before settings have loaded", () => {
    // First paint, no `settings` yet: no credential line rendered, so no
    // credential id — the attribute never names an absent element.
    render(
      <ProviderForm {...props({ provider: "ollama-cloud", settings: null })} />,
    );

    expect(picker().getAttribute("aria-describedby")).toBe("providerOllamaCloud");
    expect(document.getElementById("providerOllamaCloud")).not.toBeNull();
    expect(document.getElementById("providerCredentialStatus")).toBeNull();
  });

  it("emits no attribute at all when nothing applies", () => {
    // `undefined`, never `""`: an empty `aria-describedby` is an attribute
    // referencing no element, which is worse than the absent attribute. A
    // settings-less writable paint of a plain provider is the only state with
    // genuinely nothing to say — once `settings` loads, the credential line
    // renders and is named.
    render(
      <ProviderForm {...props({ provider: "anthropic", settings: null })} />,
    );

    expect(picker().hasAttribute("aria-describedby")).toBe(false);
  });

  it("DESCRIBES rather than marks: the picker is not flagged invalid", () => {
    // Selecting `custom` is half a configuration, not a rejected input.
    render(<ProviderForm {...props({ provider: "custom" })} />);

    expect(picker().getAttribute("aria-invalid")).toBeNull();
  });
});

describe("ProviderForm tells the truth about a BLANK selection (DW-505)", () => {
  /**
   * `— Select provider —` is a REAL state, not a first-paint artefact.
   *
   * `useSettings.ts:232-235` seeds `provider` from the payload only when
   * `providerSource === "config"`, so an `env`- or `default`-sourced deployment
   * paints the blank option with a stored provider behind it. The credential
   * line used to read that STORED provider's key state — and, since DW-420
   * pointed the picker at the line, the picker announced it too — while the
   * control visibly showed no selection. Whether the sentence matches the
   * control is not something a source scan can check, so these cases are made
   * against the rendered DOM.
   */
  const BLANK_COPY = "Select a provider to check its server credential";

  function credentialLine(): HTMLElement | null {
    return document.getElementById("providerCredentialStatus");
  }

  function picker(): HTMLElement {
    return document.getElementById("provider")!;
  }

  it("says the selection is absent rather than naming a credentialed store", () => {
    // THE DW-505 defect, exactly: a stored `openai` WITH a key behind a blank
    // pick used to announce "✓ API key configured on server" — a claim about a
    // provider the control is not showing.
    render(
      <ProviderForm
        {...props({
          provider: "",
          settings: settings({ provider: "openai", hasApiKey: true }),
        })}
      />,
    );

    expect((picker() as HTMLSelectElement).value).toBe("");
    expect(credentialLine()!.textContent).toBe(BLANK_COPY);
    expect(document.body.textContent).not.toContain("✓ API key configured on server");
    // The line still renders and the picker still points at it: the gate is
    // `settings !== null`, and DW-505 changes the SENTENCE, never when the node
    // or its id exist.
    expect(picker().getAttribute("aria-describedby")).toBe("providerCredentialStatus");
  });

  it("says the same thing over an UNCREDENTIALED store, rather than warning", () => {
    // The "⚠ No API key" branch is a complaint about a selection. With no
    // selection there is nothing to complain about, and the warning would send
    // the owner to the server environment over a provider they have not picked.
    render(
      <ProviderForm
        {...props({
          provider: "",
          settings: settings({ provider: "openai", hasApiKey: false }),
        })}
      />,
    );

    expect(credentialLine()!.textContent).toBe(BLANK_COPY);
    expect(document.body.textContent).not.toContain("⚠ No API key");
  });

  it("says the same thing when NOTHING is stored — `null === null` must not warn", () => {
    // THE MUTATION THIS CATCHES. Deriving the branches from a value that is
    // `null` for the blank pick makes the second branch's `settings.provider
    // === selectedProvider` true for an empty store, so without the blank
    // branch standing FIRST a never-configured deployment reads "⚠ No API key
    // — set via server environment variables" beside a picker showing nothing.
    render(
      <ProviderForm
        {...props({
          provider: "",
          settings: settings({ provider: null, hasApiKey: false }),
        })}
      />,
    );

    expect(credentialLine()!.textContent).toBe(BLANK_COPY);
    expect(document.body.textContent).not.toContain("⚠ No API key");
    // DESCRIBES, does not mark: an untouched picker is not a rejected input.
    expect(picker().getAttribute("aria-invalid")).toBeNull();
  });

  it("leaves the NOTES on the stored-provider fallback while the line drops it", () => {
    // The boundary DW-505 draws. `effectiveProvider` keeps the fallback for the
    // Custom/Ollama blocks — a deployment already storing `custom` needs the
    // pointer on first paint (`ProviderForm.tsx:110-113`) — and only the
    // credential line, which is a statement about the SELECTION, reads the
    // picker's own value.
    render(
      <ProviderForm
        {...props({
          provider: "",
          settings: settings({ provider: "custom", hasApiKey: true }),
        })}
      />,
    );

    // The note is on screen and still announced with the control.
    const note = document.getElementById("providerCustomEndpoint");
    expect(note).not.toBeNull();
    expect(note!.textContent).toContain(SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY);
    expect(picker().getAttribute("aria-describedby")).toBe(
      "providerCredentialStatus providerCustomEndpoint",
    );
    // …and the line beside it still says the selection is absent.
    expect(credentialLine()!.textContent).toBe(BLANK_COPY);
  });

  it("keeps the Ollama block on the fallback too, blank pick or not", () => {
    // The same exception, said for the other reader of `effectiveProvider`: a
    // stored `ollama` still renders its endpoint field before the owner has
    // touched the select.
    render(
      <ProviderForm
        {...props({ provider: "", settings: settings({ provider: "ollama" }) })}
      />,
    );

    expect(screen.getByLabelText(/Ollama Base URL/)).toBeTruthy();
    expect(credentialLine()!.textContent).toBe(BLANK_COPY);
  });

  it("reads the three existing branches off the picker once a provider IS selected", () => {
    // The other half of the boundary: a real selection must announce exactly
    // what it announced before this change.
    render(
      <ProviderForm
        {...props({
          provider: "openai",
          settings: settings({ provider: "openai", hasApiKey: true }),
        })}
      />,
    );
    expect(credentialLine()!.textContent).toBe("✓ API key configured on server");
    cleanup();

    render(
      <ProviderForm
        {...props({
          provider: "openai",
          settings: settings({ provider: "openai", hasApiKey: false }),
        })}
      />,
    );
    expect(credentialLine()!.textContent).toBe(
      "⚠ No API key — set via server environment variables",
    );
    cleanup();

    render(
      <ProviderForm
        {...props({
          provider: "openai",
          settings: settings({ provider: "anthropic", hasApiKey: true }),
        })}
      />,
    );
    expect(credentialLine()!.textContent).toBe(
      "Save this selection to check its server credential",
    );
  });
});

describe("ProviderForm announces the model box's default-model hint (DW-506)", () => {
  /**
   * The hint COMPOSES with the read-only sentence rather than being replaced by
   * it (DW-506).
   *
   * The input's attribute used to be `readOnly ? describedBy : undefined` — a
   * choice, so the hint never composed and on a writable deployment was never
   * announced at all, the same harm class as DW-400/DW-419/DW-420. The hint
   * `<p>` renders on both branches of the env/editable ternary, so its id is
   * unconditional.
   */
  const HINT_COPY = "Leave empty to use the default model for the selected provider.";

  function hint(): HTMLElement | null {
    return document.getElementById("providerModelHint");
  }

  it("names the hint alone on a writable deployment", () => {
    render(
      <ProviderForm
        {...props({ settings: settings({ modelSource: "config", model: "llama3.1" }) })}
      />,
    );

    const input = screen.getByLabelText(/^Model/) as HTMLInputElement;
    expect(input.getAttribute("aria-describedby")).toBe("providerModelHint");
    // The id RESOLVES, and to the node carrying the sentence — an attribute
    // pointing at nothing announces nothing.
    expect(hint()!.textContent).toBe(HINT_COPY);
    expect(input.readOnly).toBe(false);
  });

  it("COMPOSES with the read-only sentence, which stays FIRST", () => {
    // Both apply at once on a read-only deployment, and each answers a
    // different question — why the box refuses edits, and what an empty box
    // would do. `describedBy` leads, matching the picker and the Ollama input
    // so one page announces its refusal in one position.
    render(
      <ProviderForm
        {...props({
          readOnly: true,
          describedBy: "readOnlyNote",
          settings: settings({ modelSource: "config", model: "llama3.1" }),
        })}
      />,
    );

    const input = screen.getByLabelText(/^Model/) as HTMLInputElement;
    expect(input.getAttribute("aria-describedby")).toBe("readOnlyNote providerModelHint");
    // The id this component owns resolves; `readOnlyNote` is the PAGE's node.
    expect(hint()).not.toBeNull();
    expect(input.readOnly).toBe(true);
  });

  it("leaves the ENV-LOCKED box unattributed, with the hint still in the document", () => {
    // The locked branch is a plain non-focusable `<div>` with no role, and
    // assistive tech does not expose a description on one — so it carries no
    // `aria-describedby` to pretend otherwise, exactly as
    // `EmbeddingSettings`'s locked branch does not. Reading order carries the
    // hint here, and the `<p>` and its id are outside the ternary, so both are
    // still there.
    render(
      <ProviderForm
        {...props({
          model: "",
          settings: settings({ modelSource: "env", model: "gpt-4o" }),
        })}
      />,
    );

    expect(document.getElementById("model")).toBeNull();
    const box = screen.getByText("gpt-4o");
    expect(box.getAttribute("aria-describedby")).toBeNull();
    expect(hint()!.textContent).toBe(HINT_COPY);
  });

  it("resolves every id the model box announces, on both deployments", () => {
    // The page-level invariant, said where the composition is built — and said
    // over the two deployments that produce DIFFERENT lists. The read-only
    // iteration hands `describedBy` down as the page does, without which both
    // iterations would emit the same single id and the second would prove
    // nothing its name claims.
    for (const [readOnly, expected] of [
      [false, ["providerModelHint"]],
      [true, ["readOnlyNote", "providerModelHint"]],
    ] as const) {
      render(
        <ProviderForm
          {...props({
            readOnly,
            describedBy: readOnly ? "readOnlyNote" : undefined,
            settings: settings({ modelSource: "config", model: "llama3.1" }),
          })}
        />,
      );
      const ids = (
        (screen.getByLabelText(/^Model/) as HTMLInputElement).getAttribute(
          "aria-describedby",
        ) ?? ""
      )
        .split(" ")
        .filter(Boolean);
      expect(ids, String(readOnly)).toEqual(expected);
      // Only the ids this component MINTS are walked: `readOnlyNote` is the
      // PAGE's node and is not rendered here.
      for (const id of ids.filter((i) => i !== "readOnlyNote")) {
        expect(document.getElementById(id), id).not.toBeNull();
      }
      cleanup();
    }
  });
});
