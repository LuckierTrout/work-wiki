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
    expect(input.getAttribute("aria-describedby")).toBe("embeddingModelOverride");
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
    // …and nothing points at the note that was not rendered.
    expect(document.querySelector("[aria-describedby]")).toBeNull();
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
      expect(document.querySelector("[aria-describedby]")).toBeNull();
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

    expect(ids).toEqual(["embeddingModelOverride", "embeddingVectorNotice"]);
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
    ).toBe("embeddingModelOverride");
    expect(vectorNotice()).toBeNull();
    cleanup();

    render(<EmbeddingSettings {...props({ ...BOTH, overridden: false })} />);
    expect(
      (screen.getByLabelText(/Embedding Model/) as HTMLInputElement).getAttribute(
        "aria-describedby",
      ),
    ).toBe("embeddingVectorNotice");
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
      expect(document.querySelector("[aria-describedby]")).toBeNull();
      cleanup();
    }
  });
});
