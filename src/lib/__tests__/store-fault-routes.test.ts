/**
 * DW-481. Three sibling POST doors — monitors, retrieval evals and memory
 * change proposals — classified a create failure by MESSAGE alone. Each had
 * its own regex with `invalid` in it, so the filesystem's own sentence
 * `EINVAL: invalid argument, open '…'` came back to the caller as THEIR 400:
 * a broken disk reported as bad input, and a client that retries a 400
 * forever without ever reaching a 5xx anyone alerts on.
 *
 * What is pinned here is the classification alone, across all three doors: a
 * store fault is 500 by TYPE, a `ClientInputError` is 400 by type, and the
 * residual message ladder still 400s the untyped validation throws those
 * modules make today. The handlers are imported directly with `@/lib/auth`
 * and the store module mocked — the `research-route.test.ts` recipe.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));
vi.mock("@/lib/source-monitors", () => ({
  createSourceMonitor: vi.fn(),
  listSourceMonitors: vi.fn(async () => []),
}));
vi.mock("@/lib/retrieval-evals", () => ({
  saveRetrievalEvalCase: vi.fn(),
  listRetrievalEvalCases: vi.fn(async () => []),
  listRetrievalEvalRuns: vi.fn(async () => []),
  runRetrievalEvaluation: vi.fn(),
}));
vi.mock("@/lib/memory-proposals", () => ({
  createMemoryChangeProposal: vi.fn(),
  listMemoryChangeProposals: vi.fn(async () => []),
}));

import { POST as postMonitor } from "@/app/api/monitors/route";
import { POST as postEvaluation } from "@/app/api/system/evaluations/route";
import { POST as postProposal } from "@/app/api/review/proposals/route";
import { getPrincipal } from "@/lib/auth";
import { ClientInputError, StoreFaultError } from "@/lib/errors";
import { createSourceMonitor } from "@/lib/source-monitors";
import { saveRetrievalEvalCase } from "@/lib/retrieval-evals";
import { createMemoryChangeProposal } from "@/lib/memory-proposals";

const mockedPrincipal = vi.mocked(getPrincipal);

/**
 * The errno failure DW-481 names. It never passes through our code as a typed
 * throw — Node attaches `code` on the way out of the filesystem — which is
 * why `isStoreFault` probes the code and no amount of retyping inside the
 * store modules would have caught it.
 */
function errnoFault(code = "EINVAL"): Error {
  return Object.assign(
    new Error(`${code}: invalid argument, open '/data/alice/monitors.json'`),
    { code },
  );
}

/**
 * The SAME error a route would classify correctly, arriving from a SECOND copy
 * of `errors.ts` (DW-578): identical shape, identical `name`, different
 * constructor — what vitest's two projects, a bundler splitting server and edge
 * chunks, or the stdio MCP entry compiled on its own actually produce.
 *
 * `instanceof` answers false for it, so while these ladders classified by
 * identity the caller's 400 became a 500 in production only, where no test could
 * see it. The message is deliberately one NO door's residual regex matches
 * (`required|invalid|blocked|threshold|at most`, `…|add at least`,
 * `…|owner|does not change|too large`): if the residual ladder could answer 400
 * on its own, these rows would stay green against an identity check and pin
 * nothing.
 */
function foreignClientInputError(message: string): Error {
  return Object.assign(new Error(message), { name: "ClientInputError" });
}

type Door = {
  name: string;
  /** POST the door with a body its own shape checks accept, so the store is reached. */
  call: () => Promise<Response>;
  store: ReturnType<typeof vi.fn>;
  /**
   * The module's REAL untyped validation throw, copied verbatim from source
   * (`source-monitors.ts:231`, `retrieval-evals.ts:98`, `memory-proposals.ts:176`).
   * An invented message would pin an input the ladder never actually sees.
   */
  untypedValidationMessage: string;
};

const DOORS: Door[] = [
  {
    name: "POST /api/monitors",
    call: () =>
      postMonitor(
        new Request("http://localhost/api/monitors", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Release notes",
            url: "https://example.com/releases",
            targetSlug: "alice--releases",
          }),
        }),
      ) as Promise<Response>,
    store: vi.mocked(createSourceMonitor) as unknown as ReturnType<typeof vi.fn>,
    untypedValidationMessage: "Monitor name is required",
  },
  {
    name: "POST /api/system/evaluations",
    call: () =>
      postEvaluation(
        new Request("http://localhost/api/system/evaluations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            label: "Launch date",
            question: "When did we launch?",
            expectedSlugs: ["alice--launch"],
          }),
        }),
      ) as Promise<Response>,
    store: vi.mocked(saveRetrievalEvalCase) as unknown as ReturnType<typeof vi.fn>,
    untypedValidationMessage: "Evaluation label and question are required",
  },
  {
    name: "POST /api/review/proposals",
    call: () =>
      postProposal(
        new Request("http://localhost/api/review/proposals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetSlug: "alice--handbook",
            title: "Fix the on-call rota",
            summary: "The rota names a person who left.",
            reason: "Stale after the reorg.",
            proposedContent: "# Handbook\n\nNew rota.",
          }),
        }),
      ) as Promise<Response>,
    store: vi.mocked(createMemoryChangeProposal) as unknown as ReturnType<typeof vi.fn>,
    untypedValidationMessage: "Proposal title is required",
  },
];

/**
 * Every case asserts its store mock was called exactly once. These handlers
 * run real, unmocked pre-store validation (`validateSlug`,
 * `validateUrlSafety`, the body shape checks), so a request body that stops
 * validating would never consume its `mockRejectedValueOnce` and the two 400
 * rows would still go green — off the route's own pre-store 400 rather than
 * the classifier under test. The call count also catches an unconsumed
 * one-time rejection leaking into the next `describe.each` door.
 */
describe("store-fault classification at the three sibling POST doors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrincipal.mockResolvedValue({ handle: "alice" } as Awaited<
      ReturnType<typeof getPrincipal>
    >);
  });

  describe.each(DOORS)("$name", (door) => {
    it("500s a Node EINVAL storage fault and keeps the store's own message", async () => {
      const fault = errnoFault();
      door.store.mockRejectedValueOnce(fault);

      const response = await door.call();

      // Was a 400 before DW-481: the sentence's "invalid" matched the ladder.
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: fault.message });
      expect(door.store).toHaveBeenCalledTimes(1);
    });

    it.each(["EACCES", "ENOSPC"])("500s a %s storage fault too", async (code) => {
      door.store.mockRejectedValueOnce(errnoFault(code));

      expect((await door.call()).status).toBe(500);
      expect(door.store).toHaveBeenCalledTimes(1);
    });

    it("500s a StoreFaultError by type", async () => {
      door.store.mockRejectedValueOnce(
        new StoreFaultError("Research projects file is not a list."),
      );

      const response = await door.call();

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Research projects file is not a list.",
      });
      expect(door.store).toHaveBeenCalledTimes(1);
    });

    it("400s a ClientInputError by type, ahead of the ladder", async () => {
      // "Invalid slug" would have matched the ladder anyway; a message that
      // does NOT match is what proves the TYPE branch is doing the work.
      door.store.mockRejectedValueOnce(new ClientInputError("Slug belongs to someone else."));

      const response = await door.call();

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Slug belongs to someone else.",
      });
      expect(door.store).toHaveBeenCalledTimes(1);
    });

    it("400s a FOREIGN-REALM ClientInputError — the same status, by name not identity", async () => {
      // The row this change exists for. Same message as the case above, so the
      // two are directly comparable: whichever realm the error came from, the
      // door owes the caller the same 400.
      const foreign = foreignClientInputError("Slug belongs to someone else.");
      expect(foreign).not.toBeInstanceOf(ClientInputError);
      door.store.mockRejectedValueOnce(foreign);

      const response = await door.call();

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Slug belongs to someone else.",
      });
      expect(door.store).toHaveBeenCalledTimes(1);
    });

    it("still 400s the module's untyped validation throw via the residual ladder", async () => {
      door.store.mockRejectedValueOnce(new Error(door.untypedValidationMessage));

      const response = await door.call();

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: door.untypedValidationMessage,
      });
      expect(door.store).toHaveBeenCalledTimes(1);
    });

    it("still 500s an untyped failure the ladder does not recognise", async () => {
      door.store.mockRejectedValueOnce(new Error("LLM timeout"));

      expect((await door.call()).status).toBe(500);
      expect(door.store).toHaveBeenCalledTimes(1);
    });
  });
});
