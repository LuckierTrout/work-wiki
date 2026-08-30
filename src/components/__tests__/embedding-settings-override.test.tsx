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

    // The locked box carries no `aria-describedby`. DW-562 gave it a NAME —
    // it is an `<output>` the `<label htmlFor="embeddingModel">` associates
    // with — and left the DESCRIPTION alone, which is a separate question
    // nothing has asked. The note lands immediately after it in reading order,
    // which is what actually carries it here.
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
  /**
   * The `EMBEDDING_MODEL` pin the LOCKED branch says instead (DW-559).
   *
   * It NAMES the variable, unlike `ProviderForm`'s twin: `modelSource === "env"`
   * here comes from `embeddingModelAnswer`, whose only env leg is
   * `getEmbeddingModelOverride()`, which reads `EMBEDDING_MODEL` and nothing
   * else. There is no second candidate to guess between.
   */
  const ENV_PIN_COPY =
    "The environment sets EMBEDDING_MODEL, and that wins at runtime. " +
    "This box is fixed until that variable is unset.";
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

  it("COMPOSES with the page's read-only sentence, which leads the list", () => {
    // The page's read-only id is FIRST (DW-560). It used to trail the three ids
    // this component owns while `ProviderForm`'s model box led with it, so one
    // banner sentence occupied two positions on one page. The banner renders
    // above this whole section, so leading is its DOM reading-order position.
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
      "readOnlyNote embeddingModelHint",
    );
    // The id this component owns resolves; `readOnlyNote` is the PAGE's node.
    expect(hint()).not.toBeNull();
    expect(input.readOnly).toBe(true);
  });

  it("names all FOUR ids when every condition holds at once", () => {
    // The full composition, which no other case reaches: a read-only
    // deployment that is ALSO substituting a model and reporting an inactive
    // switch. Each id answers a different question, so none may displace
    // another — and the order is the page's node FIRST (DW-560: the banner
    // renders above this whole section, and every control on `/settings` now
    // names it at index 0), then the three this component owns in DOM reading
    // order.
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
      "readOnlyNote",
      "embeddingModelOverride",
      "embeddingVectorNotice",
      "embeddingModelHint",
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
    // by construction rather than by a gate. The locked box still carries no
    // `aria-describedby`: DW-562 gave it a NAME, not a description, and reading
    // order is what carries the hint there.
    render(
      <EmbeddingSettings
        {...props({ modelSource: "env", effectiveModel: "@cf/baai/bge-m3" })}
      />,
    );

    // No EDITABLE box — the locked branch is what rendered. Said as the tag
    // rather than as `queryByLabelText(…) === null`, which used to mean "no
    // editable box" only because the locked one had no name at all (DW-562).
    const box = screen.getByText("@cf/baai/bge-m3");
    expect(box.tagName).toBe("OUTPUT");
    expect(document.querySelector("input#embeddingModel")).toBeNull();
    expect(box.getAttribute("aria-describedby")).toBeNull();
    // The dimensions sentence COMPOSES with the pin rather than replacing it
    // (DW-559): the pin says why the box is locked, the dimensions sentence says
    // what an index built here has to match. Both are true and neither alone is
    // the answer.
    expect(hint()!.textContent).toBe(`${ENV_PIN_COPY} ${WORKERS_AI_COPY}`);
    expect(hint()!.textContent).not.toContain("Leave empty");
  });

  it("states the EMBEDDING_MODEL pin on an env model that is not Workers AI's", () => {
    // The state DW-559 names, and the one no case reached before: the box is
    // locked for a model with no dimensions note of its own, so the branch used
    // to fall through to "Leave empty to use the embedding provider default." —
    // advice for a control with no box to empty and no save that could move it.
    render(
      <EmbeddingSettings
        {...props({ modelSource: "env", effectiveModel: "text-embedding-3-small" })}
      />,
    );

    // The locked branch rendered, not the editable one — asserted on the tag,
    // for the reason the case above states.
    const lockedBox = document.getElementById("embeddingModel");
    expect(lockedBox).not.toBeNull();
    expect(lockedBox!.tagName).toBe("OUTPUT");
    expect(document.querySelector("input#embeddingModel")).toBeNull();
    expect(hint()!.textContent).toBe(ENV_PIN_COPY);
    expect(hint()!.textContent).not.toContain("Leave empty");
    expect(hint()!.textContent).not.toContain("Vectorize");
  });

  it("keeps the editable branch's advice unchanged on every non-env source", () => {
    // The other half of the branch: `config`, `default` and `none` all render a
    // real input, so the original sentence is still the true one and this case
    // is the net that DW-559 did not widen the env branch over them. The
    // effective model is deliberately `@cf/baai/bge-m3` — the value that DOES
    // change the sentence under the pin — so a branch that dropped the
    // `modelSource` half of its condition would fail here rather than pass on a
    // model that never reaches the special case anyway.
    for (const source of ["config", "default", "none"] as const) {
      cleanup();
      render(
        <EmbeddingSettings
          {...props({ modelSource: source, effectiveModel: "@cf/baai/bge-m3" })}
        />,
      );
      const input = screen.getByLabelText(/Embedding Model/) as HTMLInputElement;
      expect(input.getAttribute("aria-describedby")).toBe("embeddingModelHint");
      expect(hint()!.textContent, source).toBe(DEFAULT_COPY);
    }
  });
});

// ---------------------------------------------------------------------------
// The ENV-LOCKED box has an accessible name at all (DW-562)
// ---------------------------------------------------------------------------

describe("EmbeddingSettings — the locked box's accessible name", () => {
  /** The label the two branches share, or null when none was rendered. */
  function modelLabel(): HTMLElement | null {
    return document.querySelector("label[for='embeddingModel']");
  }

  it("names the locked box from the label the editable branch also uses", () => {
    // The defect: this branch rendered a bare `<div>` while the
    // `<label htmlFor="embeddingModel">` above went on naming an id no element
    // in the document carried, so the locked box was announced with NO
    // accessible name. It is an `<output>` now — one of HTML's labelable
    // elements — so the association is one a BROWSER makes.
    //
    // The ELEMENT is what had to change. `for` associates only with a labelable
    // element, and moving the id onto the `<div>` would have bought nothing in
    // either place: Testing Library refuses the association exactly as a browser
    // does, throwing "the element associated with this label (<div />) is
    // non-labellable" rather than resolving it. The two agree, so these queries
    // are evidence about what is announced and not merely about a heuristic.
    render(
      <EmbeddingSettings
        {...props({ modelSource: "env", effectiveModel: "text-embedding-3-small" })}
      />,
    );

    const box = document.getElementById("embeddingModel");
    expect(box).not.toBeNull();
    expect(box!.tagName).toBe("OUTPUT");
    expect(document.querySelector("input#embeddingModel")).toBeNull();
    expect(box!.textContent).toBe("text-embedding-3-small");

    // Pinned against the label's OWN text rather than a loose pattern a partial
    // name would also satisfy — the label carries "(optional)" too, and a name
    // missing it is a different name. `getByRole(…, { name })` is the query
    // that goes through the accessible-name computation; `status` is
    // `<output>`'s implicit role.
    const label = modelLabel();
    expect(label).not.toBeNull();
    const name = label!.textContent!;
    expect(name).toBe("Embedding Model (optional)");
    expect(screen.getByRole("status", { name })).toBe(box);
    expect(screen.getByLabelText(name)).toBe(box);

    // NOT bought with focusability: no `tabIndex`, so `/settings`' keyboard
    // order is exactly what it was.
    expect(box!.hasAttribute("tabindex")).toBe(false);
    expect((box as HTMLElement).tabIndex).toBe(-1);
    // No EXPLICIT role. The implicit `status` the query above resolves through
    // is the one this box should have; what is absent is an authored widget
    // role, which on an unfocusable element would be a control assistive tech
    // offers and then cannot operate.
    expect(box!.hasAttribute("role")).toBe(false);
    // …and the LIVE REGION that implicit role brings is silenced. The role
    // stays; only the announcing does not, which matters because this box
    // re-renders whenever `/api/settings` answers.
    expect(box!.getAttribute("aria-live")).toBe("off");
    // Still no DESCRIPTION. DW-562 is about the missing NAME.
    expect(box!.getAttribute("aria-describedby")).toBeNull();
  });

  it("leaves the EDITABLE branch untouched by the locked branch's shape", () => {
    // Nothing the locked branch gained may leak onto the branch that renders a
    // real control: same id, same label association, same composition, and no
    // `aria-live`.
    for (const source of ["config", "default", "none"] as const) {
      cleanup();
      render(
        <EmbeddingSettings
          {...props({
            modelSource: source,
            embeddingModel: "nomic-embed-text",
            readOnly: true,
            describedBy: "readOnlyNote",
          })}
        />,
      );

      const box = document.getElementById("embeddingModel");
      // Guarded before every `!` below, and labelled with `source`, so a
      // regression fails as this claim on the named iteration rather than as a
      // bare `TypeError`.
      expect(box, source).not.toBeNull();
      const label = modelLabel();
      expect(label, source).not.toBeNull();
      expect(box!.tagName, source).toBe("INPUT");
      expect((box as HTMLInputElement).value, source).toBe("nomic-embed-text");
      expect(screen.getByLabelText(label!.textContent!), source).toBe(box);
      expect(box!.hasAttribute("aria-live"), source).toBe(false);
      expect(box!.getAttribute("aria-describedby"), source).toBe(
        "readOnlyNote embeddingModelHint",
      );
    }
  });
});
