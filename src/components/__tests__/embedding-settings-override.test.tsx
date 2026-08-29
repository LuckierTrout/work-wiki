import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  EmbeddingSettings,
  type EmbeddingSettingsProps,
} from "@/components/EmbeddingSettings";

/**
 * The embedding model field, MOUNTED (DW-274).
 *
 * `config.ts` now reports what is SET and what is IN EFFECT as two separate
 * fields, but the flag is worth nothing if the surface does not say it — and
 * "the surface says it" is not something a source scan can check. So these
 * cases are made against the rendered DOM: the note is present with the model
 * that actually embeds, the field beside it still shows what the owner set,
 * and the not-overridden case renders no note at all.
 *
 * The component had no test before this file.
 */

function props(
  overrides: Partial<EmbeddingSettingsProps> = {},
): EmbeddingSettingsProps {
  return {
    embeddingModel: "",
    setEmbeddingModel: vi.fn(),
    effectiveModel: null,
    modelSource: "none",
    modelInEffect: null,
    overridden: false,
    rebuilding: false,
    onRebuild: vi.fn(),
    rebuildResult: null,
    ...overrides,
  };
}

/** The vector notice, or null when the component rendered none (DW-327). */
function vectorNotice(): HTMLElement | null {
  return document.getElementById("embeddingVectorNotice");
}

/** The override note, or null when the component rendered none. */
function overrideNote(): HTMLElement | null {
  return document.getElementById("embeddingModelOverride");
}

/**
 * No node in this component carries a DANGLING `aria-describedby` (DW-506).
 *
 * The component-level twin of the parity suite's
 * `expectEveryDescribedIdResolves()`, kept as its own helper because the cases
 * below no longer cover it by accident. They used to assert
 * `document.querySelector("[aria-describedby]")` is null — a net that happened
 * to prove "nothing dangles" only because nothing described anything at all.
 * The model box now carries a standing description, so each of those nets is
 * narrowed to the one id its case is actually about, and this walks what the
 * net used to: every id every control names resolves to a node in the document,
 * and a control carrying the attribute names at least one — `""` is an
 * attribute pointing at nothing, which is worse than no attribute.
 */
function expectNoDanglingDescribedIds(): void {
  for (const control of Array.from(document.querySelectorAll("[aria-describedby]"))) {
    const ids = (control.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .filter(Boolean);
    expect(ids.length, control.id || control.tagName).toBeGreaterThan(0);
    for (const id of ids) {
      expect(document.getElementById(id), `${control.id || control.tagName} -> ${id}`)
        .not.toBeNull();
    }
  }
}

afterEach(() => {
  cleanup();
});

describe("EmbeddingSettings — the model that actually embeds", () => {
  it("names the in-effect model beside the locked env box", () => {
    // The literal DW-274 deployment: `EMBEDDING_MODEL=text-embedding-3-small`
    // on Workers AI. The box goes on showing the env value — that IS what the
    // variable says, and the source badge is about the variable — while the
    // note names what `embedText` runs on.
    render(
      <EmbeddingSettings
        {...props({
          modelSource: "env",
          effectiveModel: "text-embedding-3-small",
          modelInEffect: "@cf/baai/bge-m3",
          overridden: true,
        })}
      />,
    );

    const note = overrideNote();
    expect(note).not.toBeNull();
    expect(note?.textContent).toContain("Not in effect");
    expect(note?.textContent).toContain("@cf/baai/bge-m3");

    // What is SET is still on screen, unchanged.
    const box = screen.getByText("text-embedding-3-small");
    expect(box).toBeTruthy();

    // The locked box is a plain non-focusable `<div>` with no role, and
    // assistive tech does not expose a description on one — so it carries no
    // `aria-describedby` to pretend otherwise. The note lands immediately after
    // it in reading order, which is what actually carries it here.
    expect(box.getAttribute("aria-describedby")).toBeNull();
    expect(box.nextElementSibling).toBe(note);
  });

  it("keeps the editable input holding the stored value, and describes it", () => {
    // The `config` source: the owner CAN fix this one from the box, so the box
    // must still hold what they typed rather than the substituted default —
    // otherwise the next save writes a provider default into the store.
    render(
      <EmbeddingSettings
        {...props({
          modelSource: "config",
          embeddingModel: "@cf/baai/bge-m3",
          effectiveModel: "@cf/baai/bge-m3",
          modelInEffect: "nomic-embed-text",
          overridden: true,
        })}
      />,
    );

    const input = screen.getByLabelText(/Embedding Model/) as HTMLInputElement;
    expect(input.value).toBe("@cf/baai/bge-m3");
    // Described, not marked invalid: a mismatch is a sentence, not a rejection.
    // The default-model hint is announced alongside it (DW-506) — it describes
    // the same box and is on screen whichever branch rendered.
    expect(input.getAttribute("aria-describedby")).toBe(
      "embeddingModelOverride embeddingModelHint",
    );
    expect(input.getAttribute("aria-invalid")).toBeNull();

    expect(overrideNote()?.textContent).toContain("nomic-embed-text");
  });

  it("renders no note when the flag is set but no in-effect model came with it", () => {
    // `getEffectiveSettings` cannot produce this pair — the flag's own rule
    // requires a non-null in-effect value — but the prop types permit it and
    // `page.tsx` derives the two props through independent `??` fallbacks. A
    // half-wired caller must get NO sentence rather than one with a hole where
    // the model name belongs ("This deployment embeds with  — …").
    render(
      <EmbeddingSettings
        {...props({
          modelSource: "config",
          embeddingModel: "@cf/baai/bge-m3",
          effectiveModel: "@cf/baai/bge-m3",
          modelInEffect: null,
          overridden: true,
        })}
      />,
    );

    expect(overrideNote()).toBeNull();
    expect(document.body.textContent).not.toContain("Not in effect");
    // …and nothing points at the note that was not rendered. Scoped to that id
    // rather than to "nothing describes anything": the box legitimately names
    // its default-model hint (DW-506), which is not this case's claim.
    expect(
      document.querySelector('[aria-describedby~="embeddingModelOverride"]'),
    ).toBeNull();
    // …and the invariant the page-wide net used to cover, kept as its own
    // claim rather than as a side effect of nothing describing anything.
    expectNoDanglingDescribedIds();
  });

  it("renders no note at all when nothing is being substituted", () => {
    // Not-overridden is the common case and must look exactly as it did before
    // the flag existed — including no dangling `aria-describedby` pointing at
    // an element that is not there.
    for (const modelSource of ["env", "config", "default", "none"] as const) {
      render(
        <EmbeddingSettings
          {...props({
            modelSource,
            embeddingModel: "text-embedding-3-small",
            effectiveModel: "text-embedding-3-small",
            modelInEffect: "text-embedding-3-small",
            overridden: false,
          })}
        />,
      );

      expect(overrideNote()).toBeNull();
      expect(document.body.textContent).not.toContain("Not in effect");
      // Scoped to the override id, for the reason the case above states: the
      // model box still names its own default-model hint (DW-506).
      expect(
        document.querySelector('[aria-describedby~="embeddingModelOverride"]'),
      ).toBeNull();
      expectNoDanglingDescribedIds();
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// The two notes are INDEPENDENT and can be on screen together (DW-327)
// ---------------------------------------------------------------------------

describe("EmbeddingSettings — the override note and the vector notice together", () => {
  /** Both conditions true at once: a substitution AND an inactive switch. */
  const BOTH = {
    modelSource: "config",
    embeddingModel: "@cf/baai/bge-m3",
    effectiveModel: "@cf/baai/bge-m3",
    modelInEffect: "nomic-embed-text",
    overridden: true,
    vectorNotice:
      "Vector search is switched on, but it needs an endpoint and an API key before it can run. Supply what is missing, or turn the switch off in Workbench Settings → Embeddings.",
  } as const;

  it("announces BOTH ids on the input, and both resolve to real elements", () => {
    // THE MUTATION THIS CATCHES. `aria-describedby` is built by joining the ids
    // whose notes are actually rendered, and nothing else in the suite renders
    // both at once — so dropping either id from the join left every other case
    // green while the input silently stopped announcing one of two sentences
    // that are on the screen.
    render(<EmbeddingSettings {...props(BOTH)} />);

    const input = screen.getByLabelText(/Embedding Model/) as HTMLInputElement;
    const ids = (input.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);

    // In DOM reading order, the hint last of the three this component owns.
    expect(ids).toEqual([
      "embeddingModelOverride",
      "embeddingVectorNotice",
      "embeddingModelHint",
    ]);
    // Every announced id RESOLVES — an `aria-describedby` naming an element
    // that is not in the document announces nothing at all.
    for (const id of ids) {
      expect(document.getElementById(id)).not.toBeNull();
    }
    // …and each note carries its own sentence, not the other's.
    expect(overrideNote()?.textContent).toContain("nomic-embed-text");
    expect(vectorNotice()?.textContent).toBe(BOTH.vectorNotice);
    // Described, not marked — neither note is a rejection.
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("announces only the id whose note is rendered, when just one condition holds", () => {
    // The independence, said as the two halves. Each condition alone must
    // produce exactly its own id — which is what makes the pair above a join
    // rather than a coincidence.
    render(<EmbeddingSettings {...props({ ...BOTH, vectorNotice: null })} />);
    expect(
      (screen.getByLabelText(/Embedding Model/) as HTMLInputElement).getAttribute(
        "aria-describedby",
      ),
    ).toBe("embeddingModelOverride embeddingModelHint");
    expect(vectorNotice()).toBeNull();
    cleanup();

    render(<EmbeddingSettings {...props({ ...BOTH, overridden: false })} />);
    expect(
      (screen.getByLabelText(/Embedding Model/) as HTMLInputElement).getAttribute(
        "aria-describedby",
      ),
    ).toBe("embeddingVectorNotice embeddingModelHint");
    expect(overrideNote()).toBeNull();
  });

  it("renders no vector notice, and no dangling id, for an EMPTY sentence", () => {
    // `vectorSearchInactiveCopy` answers `""` for a satisfied configuration, so
    // the empty string is a real value this prop receives — and it must be the
    // same "nothing" that `null` and `undefined` are, rather than an empty
    // paragraph with an id pointing at it.
    for (const vectorNoticeValue of ["", null, undefined]) {
      render(
        <EmbeddingSettings
          {...props({ ...BOTH, overridden: false, vectorNotice: vectorNoticeValue })}
        />,
      );
      expect(vectorNotice()).toBeNull();
      // No DANGLING pointer at the notice that did not render. Scoped to its
      // own id: the box still names its default-model hint (DW-506), and a
      // page-wide net would be a claim about that instead.
      expect(
        document.querySelector('[aria-describedby~="embeddingVectorNotice"]'),
      ).toBeNull();
      expectNoDanglingDescribedIds();
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// The default-model hint is ANNOUNCED, not merely placed beside the box (DW-506)
// ---------------------------------------------------------------------------

describe("EmbeddingSettings — the default-model hint", () => {
  /** The hint, or null when the component rendered none. */
  function hint(): HTMLElement | null {
    return document.getElementById("embeddingModelHint");
  }

  const DEFAULT_COPY = "Leave empty to use the embedding provider default.";
  const WORKERS_AI_COPY =
    "This deployment uses Cloudflare Workers AI with a 1,024-dimensional Vectorize index.";

  it("is announced whenever the editable input renders, and resolves", () => {
    // The commonest shape of all: no substitution, no vector notice, writable.
    // The sentence used to sit beside this box with nothing tying the two
    // together — the gap `SettingsCanvas.tsx`'s rows state the convention
    // against — so the owner heard the label and never what an empty box does.
    render(<EmbeddingSettings {...props({ modelSource: "config" })} />);

    const input = screen.getByLabelText(/Embedding Model/) as HTMLInputElement;
    expect(input.getAttribute("aria-describedby")).toBe("embeddingModelHint");
    expect(hint()!.textContent).toBe(DEFAULT_COPY);
    // DESCRIBES, does not mark: an empty box is how the provider default is
    // asked for, not an error.
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("COMPOSES with the page's read-only sentence rather than being replaced by it", () => {
    // The read-only id keeps the position it already held — last — and the
    // three ids this component owns are what the list orders.
    render(
      <EmbeddingSettings
        {...props({
          modelSource: "config",
          readOnly: true,
          describedBy: "readOnlyNote",
        })}
      />,
    );

    const input = screen.getByLabelText(/Embedding Model/) as HTMLInputElement;
    expect(input.getAttribute("aria-describedby")).toBe(
      "embeddingModelHint readOnlyNote",
    );
    // The id this component owns resolves; `readOnlyNote` is the PAGE's node.
    expect(hint()).not.toBeNull();
    expect(input.readOnly).toBe(true);
  });

  it("names all FOUR ids when every condition holds at once", () => {
    // The full composition, which no other case reaches: a read-only
    // deployment that is ALSO substituting a model and reporting an inactive
    // switch. Each id answers a different question, so none may displace
    // another — and the order is the three this component owns in DOM reading
    // order, with the page's node in the position it already held.
    render(
      <EmbeddingSettings
        {...props({
          modelSource: "config",
          embeddingModel: "@cf/baai/bge-m3",
          effectiveModel: "@cf/baai/bge-m3",
          modelInEffect: "nomic-embed-text",
          overridden: true,
          vectorNotice:
            "Vector search is switched on, but it needs an endpoint and an API key before it can run.",
          readOnly: true,
          describedBy: "readOnlyNote",
        })}
      />,
    );

    const input = screen.getByLabelText(/Embedding Model/) as HTMLInputElement;
    const ids = (input.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
    expect(ids).toEqual([
      "embeddingModelOverride",
      "embeddingVectorNotice",
      "embeddingModelHint",
      "readOnlyNote",
    ]);
    // The three this component MINTS resolve; `readOnlyNote` is the PAGE's node
    // and is not rendered here.
    for (const id of ids.filter((i) => i !== "readOnlyNote")) {
      expect(document.getElementById(id)).not.toBeNull();
    }
  });

  it("carries whichever sentence the branch selects, and keeps its id on the locked one", () => {
    // The `<p>` is OUTSIDE the env/editable ternary, so the id is
    // unconditional — that is what makes "never names an absent element" true
    // by construction rather than by a gate. The locked `<div>` still carries
    // no `aria-describedby`: assistive tech does not expose a description on a
    // plain non-focusable div, so reading order is what carries it there.
    render(
      <EmbeddingSettings
        {...props({ modelSource: "env", effectiveModel: "@cf/baai/bge-m3" })}
      />,
    );

    expect(screen.queryByLabelText(/Embedding Model/)).toBeNull();
    const box = screen.getByText("@cf/baai/bge-m3");
    expect(box.getAttribute("aria-describedby")).toBeNull();
    expect(hint()!.textContent).toBe(WORKERS_AI_COPY);
  });
});
