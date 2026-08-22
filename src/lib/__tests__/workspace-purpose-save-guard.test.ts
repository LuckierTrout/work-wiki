import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * `save()`'s post-await writes sit behind the cancelled/superseded guard
 * (DW-320).
 *
 * WHY A SCAN. `workspace-purpose-settings.test.tsx` drives the observable half
 * of this — two overlapping PUTs, the older settling last, only the newest
 * answer adopted — and stops exactly where the component does. React discards a
 * state update aimed at an unmounted tree in silence, so a PUT that resolves
 * after the form is gone writes into nothing whether the guard is there or not:
 * deleting `cancelledRef.current` from this function leaves every mounted
 * assertion in the repo green. An unreachable-by-test line is invisible to a
 * mounted suite and obvious to a scan, so this is where it is pinned — the same
 * division `workbench-left-column.test.ts` states for the in-flight guards.
 *
 * WHAT IS PINNED is the ORDER, not the presence of a string: both tokens are
 * captured before the first await, and no state write anywhere below that await
 * — in the success path, in the catch, or in the `finally` — is reached without
 * a guard being consulted first. `finally` is the one that looks safe and is
 * not: `return` inside a `try` runs it on the way out, so a superseded run
 * reaches `setSaving(false)` and lifts the gate over a PUT still in flight.
 *
 * And WHICH guard, because there are two and they are not interchangeable.
 * `answerSeqRef` gates adoption and is moved by every `load`; `saveSeqRef` gates
 * the in-flight flag and is moved only by a save. A `finally` on the first
 * strands `saving` the moment a recheck starts behind a save — the fieldset
 * disabled and the button on "Saving…" with nothing left to clear it.
 */

const COMPONENT = path.resolve(
  __dirname,
  "../../components/WorkspacePurposeSettings.tsx",
);

/** Every call that writes this component's state. */
const STATE_WRITE = /\b(set[A-Z]\w*|placeProfile)\s*\(/g;

/** Either guard: the answer token's, or the save token's. */
const ANY_GUARD = /\b(adopted|ownsSaving)\(\)/;

/**
 * The body of `save()`, by brace matching from its declaration.
 *
 * Walked rather than sliced at the next `}`: the function contains object
 * literals, a template string and three blocks, and `indexOf("}")` would cut it
 * off inside the first of them and hand every assertion below a fragment.
 */
async function saveBody(): Promise<string> {
  const source = await readFile(COMPONENT, "utf8");
  const start = source.indexOf("async function save(event: React.FormEvent) {");
  if (start === -1) {
    throw new Error("WorkspacePurposeSettings no longer declares `save(event)`");
  }
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("`save()` is unterminated");
}

/** Where each state write sits inside `text`. */
function writeOffsets(text: string): number[] {
  return Array.from(text.matchAll(STATE_WRITE), (match) => match.index ?? 0);
}

describe("save() cannot speak for a form that is gone or superseded (DW-320)", () => {
  it("captures the answer token BEFORE the first await", async () => {
    const body = await saveBody();
    const capture = body.indexOf("const seq = (answerSeqRef.current += 1);");
    const firstAwait = body.indexOf("await request");
    expect(capture).toBeGreaterThan(-1);
    expect(firstAwait).toBeGreaterThan(-1);
    // Read after the round trip, the token would be whatever the LAST run set —
    // so a superseded run would compare its own bump against itself and always
    // match, which is the guard deleted while still spelled.
    expect(capture).toBeLessThan(firstAwait);
  });

  it("consults both halves of the guard — unmounted AND superseded", async () => {
    const body = await saveBody();
    // The same pair `load()` carries: `cancelledRef` answers "this component is
    // gone", the token answers "something newer already owns this form". They
    // are different failures and neither implies the other — a newer save on a
    // still-mounted form is not cancelled, and an unmounted form was never
    // superseded.
    expect(body).toContain("!cancelledRef.current");
    expect(body).toContain("seq === answerSeqRef.current");
  });

  it("captures a SAVE-scoped token too, and owns `saving` with that one", async () => {
    const body = await saveBody();
    // TWO tokens, because they answer two different questions. `answerSeqRef` is
    // bumped by every `load` — a recheck included — and gates whether this run's
    // ANSWER may be adopted. `saveSeqRef` is bumped only here and gates the
    // in-flight FLAG.
    //
    // Collapsing them strands the form: a recheck can still start in the window
    // between `setSaving(true)` and the effect that records the stand-down, so a
    // `finally` gated on the answer token skips its `setSaving(false)` — and
    // nothing else clears it, leaving the fieldset disabled and the button on
    // "Saving…" for the rest of the session.
    expect(body).toContain("const writeSeq = (saveSeqRef.current += 1);");
    expect(body).toContain("writeSeq === saveSeqRef.current");
    // The save token must be captured before the await for the same reason the
    // answer token is: read afterwards it would always match itself.
    expect(body.indexOf("saveSeqRef.current += 1")).toBeLessThan(
      body.indexOf("await request"),
    );
  });

  it("puts the guard in front of every write below the await", async () => {
    const body = await saveBody();
    const afterAwait = body.slice(body.indexOf("await request"));

    // The three regions the writes live in. `finally` is the one that looks
    // safe and is not: a `return` from the `try` still runs it.
    const catchAt = afterAwait.indexOf("} catch (error) {");
    const finallyAt = afterAwait.indexOf("} finally {");
    expect(catchAt).toBeGreaterThan(-1);
    expect(finallyAt).toBeGreaterThan(catchAt);

    const regions: ReadonlyArray<readonly [string, string]> = [
      ["success path", afterAwait.slice(0, catchAt)],
      ["catch", afterAwait.slice(catchAt, finallyAt)],
      ["finally", afterAwait.slice(finallyAt)],
    ];

    for (const [name, region] of regions) {
      const guardAt = region.search(ANY_GUARD);
      expect(guardAt, `${name} has no guard at all`).toBeGreaterThan(-1);
      for (const offset of writeOffsets(region)) {
        // Every write in the region is reached only after the guard has been
        // consulted. A guard added BELOW the first write is a guard that does
        // not run.
        expect(offset, `${name} writes state before consulting the guard`).toBeGreaterThan(
          guardAt,
        );
      }
    }

    // …and WHICH guard, because the two are not interchangeable. The answer
    // token decides what may be adopted; the save token decides who owns the
    // in-flight flag. A `finally` on the answer token strands `saving` the
    // first time a recheck slips in behind a save.
    const [, successPath] = regions[0];
    const [, catchBlock] = regions[1];
    const [, finallyBlock] = regions[2];
    expect(successPath).toContain("adopted()");
    expect(catchBlock).toContain("adopted()");
    expect(finallyBlock).toContain("ownsSaving()");
    expect(finallyBlock).not.toContain("adopted()");
  });

  it("guards writes rather than only counting them, so the check cannot go vacuous", async () => {
    // The positive control for the case above: with no state writes found, its
    // inner loop is empty and it passes against a function that guards nothing.
    // Both halves of that loop are asserted to have something to say.
    const body = await saveBody();
    const afterAwait = body.slice(body.indexOf("await request"));
    expect(writeOffsets(afterAwait).length).toBeGreaterThanOrEqual(3);
    expect(
      afterAwait.match(/\b(adopted|ownsSaving)\(\)/g)?.length,
    ).toBeGreaterThanOrEqual(3);
  });
});
