/**
 * DW-271. `belongsInCommons` decides whether a page is public knowledge, and
 * every permission path that consults it runs inside a route — which is exactly
 * where `@/lib/wiki` gets mocked.
 *
 * `wiki.ts` merely RE-EXPORTS `isAgentScopedType`/`isArtifactType` from
 * `page-types.ts`. While `commons.ts` reached them through that re-export, any
 * route suite that mocked `@/lib/wiki` without restating the two predicates
 * turned them into `undefined` inside `commons.ts`, and `belongsInCommons` threw
 * a `TypeError` calling `undefined` — a 403 answered as a 500. Nothing failed at
 * import time and nothing failed in `commons.test.ts` (which mocks nothing), so
 * the trap was invisible until a future suite happened to step in it.
 *
 * THIS SUITE IS THE TRAP, SPRUNG ON PURPOSE. The factory below supplies ONLY the
 * two functions `commons.ts` genuinely needs from `wiki.ts` and deliberately
 * omits the predicates — the shape a route author writes without ever thinking
 * about the commons. It passes only while `commons.ts` imports the predicates
 * from `./page-types` directly. Move that import back onto `./wiki` and these
 * assertions fail here, in a two-line suite, instead of in production.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/wiki", () => ({
  listWikiPages: vi.fn(async () => []),
  tenantForOwner: vi.fn((owner: string) => owner.toLowerCase()),
}));

import { belongsInCommons } from "../commons";

describe("belongsInCommons under a wiki mock that omits the page-type predicates", () => {
  it("returns true for a public note — no TypeError from calling `undefined`", () => {
    expect(belongsInCommons({ visibility: "public", type: "note" })).toBe(true);
  });

  it("still excludes agent-scoped pages", () => {
    expect(belongsInCommons({ visibility: "public", type: "agent-identity" })).toBe(false);
    expect(belongsInCommons({ visibility: "public", type: "agent-knowledge" })).toBe(false);
  });

  it("still excludes rendered artifacts", () => {
    expect(belongsInCommons({ visibility: "public", type: "html" })).toBe(false);
    expect(belongsInCommons({ visibility: "public", type: "slides" })).toBe(false);
  });

  it("still excludes private pages", () => {
    expect(belongsInCommons({ visibility: "private", type: "note" })).toBe(false);
  });

  it("returns a boolean for every one of those, never throws", () => {
    // The DW-271 fault was a THROW, not a wrong answer: `isAgentScopedType is
    // not a function` propagates out of the permission path as a 500. Pinning
    // the type as well as the value keeps a future regression legible.
    for (const type of [undefined, "note", "agent-identity", "html", "slides"]) {
      expect(typeof belongsInCommons({ visibility: "public", type })).toBe("boolean");
    }
  });
});
