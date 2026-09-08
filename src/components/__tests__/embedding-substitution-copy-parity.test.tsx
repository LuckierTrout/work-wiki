import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  EmbeddingSettings,
  type EmbeddingSettingsProps,
} from "@/components/EmbeddingSettings";
import { settingsModelSubstitutedCopy } from "@/lib/workbench-settings";

/**
 * The embedding-substitution sentence, flat page against canvas (DW-336).
 *
 * ONE fact — this deployment is embedding with a model other than the one that
 * is set — said on TWO surfaces, in two sentences that are not shared. The flat
 * `/settings` page spells it as JSX in `EmbeddingSettings.tsx` (a `<p>` under
 * the model box, the model name in a `<span className="font-mono">`); the
 * Workbench canvas gets it from `settingsModelSubstitutedCopy` in
 * `workbench-settings.ts` as a plain string joined into the model row's
 * `aria-describedby`. They cannot be merged: the canvas box is EMPTY whenever
 * `EMBEDDING_MODEL` owns the value, so that sentence cannot point at a control
 * and says "the model that is set" where the flat one says "the model above".
 *
 * That single deliberate difference is argued in both files. Every OTHER clause
 * was duplicated by hand with nothing holding the two together, so a reword to
 * either side left the other stale with every existing suite green. This file
 * is the seam, following `src/lib/__tests__/read-only-copy-parity.test.ts`:
 * shared clauses asserted against BOTH sentences from one list, the two
 * sentences compared CHARACTER-IDENTICAL once the divergent clause is
 * normalized, and that divergence pinned in both directions so real drift never
 * reads as the intended one. A THIRD copy — `DEPLOY.md`'s block quote of the
 * canvas variant — is pinned at the bottom of this file.
 *
 * The flat side is read from a MOUNT, never from the `.tsx` source: the JSX
 * splits the sentence across a `<span>` and four source lines, so a source scan
 * would pin the file's formatting rather than the sentence — and would keep
 * passing if the `<p>` stopped rendering at all.
 *
 * The canvas side is read by CALLING the copy function, which is deliberately
 * the weaker half of that pair: nothing here would fail if
 * `SettingsCanvas.tsx` stopped joining the string into the model row's hint.
 * That hop is not this file's to hold — it is pinned by
 * `src/components/workbench/__tests__/settings-vector-namespace.test.tsx`,
 * whose `substituted()` helper restates the sentence by hand ON PURPOSE so the
 * assertion is about what a screen reader announces. This file holds the
 * WORDING across surfaces; that one holds the canvas render.
 *
 * `*.test.tsx` ⇒ dom project; `workbench-settings.ts` is client-safe, so the
 * same suite can import both.
 */

/** The one clause the two surfaces say differently, on purpose. */
const FLAT_CLAUSE = "the model above";
const CANVAS_CLAUSE = "the model that is set";

/**
 * The wording BOTH surfaces must carry.
 *
 * The list lives here rather than being exported from shipped code: neither
 * surface has a use for it, and an export would make the sentence look shared
 * when the whole point is that it is not. Each entry is asserted against both
 * sentences, so a reword on either side fails until both are considered.
 */
const SHARED_CLAUSES = [
  "Not in effect.",
  "This deployment embeds with",
  "the embedding provider cannot serve",
  "so it uses its own default instead.",
  "Vectors are tagged with the model that produced them",
  "an index built with a different model needs rebuilding.",
] as const;

const MODEL_IN_EFFECT = "@cf/baai/bge-m3";
const MODEL_THAT_IS_SET = "text-embedding-3-small";

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

/**
 * The flat sentence as the OWNER reads it: rendered, then whitespace-normalized.
 *
 * Mounted in the state that actually SHIPS — the literal DW-274 deployment,
 * `EMBEDDING_MODEL=text-embedding-3-small` on Workers AI. `overridden: true`
 * means a model IS set, so `modelSource: "env"` with a real `effectiveModel` is
 * the pairing `getEffectiveSettings` can hand down; a null-and-"none" default
 * would make every claim below about a state the app cannot produce. The set
 * model is a parameter only because one case varies it to prove the sentence
 * names the model IN EFFECT and not that one.
 *
 * JSX indentation is not part of the sentence — the source wraps it across four
 * lines and a `<span>`, which arrives in `textContent` as newlines and runs of
 * spaces. Collapsing them is what makes a character-identical comparison against
 * a single-line string meaningful rather than a formatting test.
 *
 * The note is read out of the container THIS render returned, not through the
 * global `document.getElementById`: two calls inside one `it` leave two mounts
 * in the body, and a document-wide lookup for a duplicated id returns the FIRST
 * — which would compare a stale sentence as if it were fresh.
 */
function flatSentence(
  model: string,
  setModel: string = MODEL_THAT_IS_SET,
): string {
  const { container } = render(
    <EmbeddingSettings
      {...props({
        modelSource: "env",
        effectiveModel: setModel,
        modelInEffect: model,
        overridden: true,
      })}
    />,
  );
  const note = container.querySelector("#embeddingModelOverride");
  expect(note, "the override note did not render").not.toBeNull();
  return (note?.textContent ?? "").replace(/\s+/g, " ").trim();
}

afterEach(() => {
  cleanup();
});

describe("the substitution sentence says the same thing on both surfaces (DW-336)", () => {
  it.each(SHARED_CLAUSES)("both surfaces say %j", (clause) => {
    expect(flatSentence(MODEL_IN_EFFECT)).toContain(clause);
    expect(settingsModelSubstitutedCopy(MODEL_IN_EFFECT)).toContain(clause);
  });

  it("differs on exactly one clause, held in both directions", () => {
    // The recorded difference, not a bug: the flat note sits directly under a
    // box that always shows the value it means, so it can point at it. The
    // canvas row's box is empty whenever `EMBEDDING_MODEL` owns the value, so
    // it names the setting instead. Asserted BOTH ways — a surface that drifted
    // onto the other's clause would otherwise still pass one half of this.
    const flat = flatSentence(MODEL_IN_EFFECT);
    const canvas = settingsModelSubstitutedCopy(MODEL_IN_EFFECT);

    expect(flat).toContain(FLAT_CLAUSE);
    expect(flat).not.toContain(CANVAS_CLAUSE);
    expect(canvas).toContain(CANVAS_CLAUSE);
    expect(canvas).not.toContain(FLAT_CLAUSE);
  });

  it("is otherwise character-identical", () => {
    // The teeth. The clause list above is the legibility — it says WHICH
    // wording moved — but a re-punctuated or re-ordered sentence passes it, so
    // the two are also compared whole with the one recorded difference
    // normalized away.
    const flat = flatSentence(MODEL_IN_EFFECT);
    // The normalization must have something to normalize. If the flat side ever
    // drifted onto the canvas clause, `.replace()` would be a NO-OP and the two
    // would compare equal — this case would pass while the surface it exists to
    // watch had changed. Asserted HERE rather than leaning on the sibling case
    // above, so the teeth do not depend on a neighbour's continued existence.
    expect(flat).toContain(FLAT_CLAUSE);

    expect(flat.replace(FLAT_CLAUSE, CANVAS_CLAUSE)).toBe(
      settingsModelSubstitutedCopy(MODEL_IN_EFFECT),
    );
  });

  it("names the model IN EFFECT on both surfaces, and never the one that is set", () => {
    // The fact the sentence exists to carry. The flat page renders the model
    // that is SET in the box above the note, so the note naming the wrong one
    // would read as agreement between the two — and the canvas, whose box is
    // empty here, would leave the owner with no way to tell the two apart.
    const model = "nomic-embed-text";
    const flat = flatSentence(model, MODEL_THAT_IS_SET);
    const canvas = settingsModelSubstitutedCopy(model);

    expect(flat).toContain(model);
    expect(flat).not.toContain(MODEL_THAT_IS_SET);
    expect(canvas).toContain(model);
    expect(canvas).not.toContain(MODEL_THAT_IS_SET);
  });

  it("keeps DEPLOY.md's quoted sentence identical to the copy function it quotes", async () => {
    // The THIRD copy. `DEPLOY.md` block-quotes the CANVAS variant verbatim so an
    // operator can compare the doc to the screen before deciding whether a
    // substitution is the thing they are chasing — and a doc that quotes a
    // sentence the surface stopped showing sends them looking for text that is
    // not there, which is worse than no quote. Nothing but memory joined the
    // two until now.
    //
    // Same un-wrapping as `workbench-settings.test.ts`'s DW-222 case: the quote
    // is hard-wrapped, so what must match is the SENTENCE, not the line breaks
    // markdown happens to use. The doc writes the model name as `…` in
    // backticks, which is exactly what the copy function produces when handed
    // that string — so this is a full-sentence comparison, not a substring soup.
    const doc = await readFile(
      path.resolve(__dirname, "../../../DEPLOY.md"),
      "utf8",
    );
    const blocks: string[] = [];
    let current: string[] = [];
    for (const line of doc.split("\n")) {
      if (line.startsWith(">")) {
        current.push(line.replace(/^>\s?/, ""));
      } else if (current.length > 0) {
        blocks.push(current.join(" ").replace(/\s+/g, " ").trim());
        current = [];
      }
    }
    if (current.length > 0) {
      blocks.push(current.join(" ").replace(/\s+/g, " ").trim());
    }

    const quoted = settingsModelSubstitutedCopy("`…`");
    expect(blocks.some((block) => block === quoted)).toBe(true);
  });
});
