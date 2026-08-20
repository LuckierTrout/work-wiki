/**
 * `POST /api/research` — how a create failure is classified.
 *
 * DW-164 gave `createResearchProject` a `MAX_PROJECTS` refusal, which is the
 * caller's state and not a server fault. The handler is imported directly and
 * its store is mocked (the `wikis-routes.test.ts` recipe), so what is pinned
 * here is the mapping alone: a `ClientInputError` is a 400 by TYPE, anything
 * else stays a 500, and the message regex that predates the class still stands.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));
vi.mock("@/lib/research-projects", () => ({
  createResearchProject: vi.fn(),
  listResearchProjects: vi.fn(),
}));

import { POST } from "@/app/api/research/route";
import { getPrincipal } from "@/lib/auth";
import { ClientInputError } from "@/lib/errors";
import { createResearchProject } from "@/lib/research-projects";

const mockedPrincipal = vi.mocked(getPrincipal);
const mockedCreate = vi.mocked(createResearchProject);

const request = (body: unknown) =>
  new Request("http://localhost/api/research", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const BODY = { title: "Launch research", question: "What supports the date?" };

describe("POST /api/research failure classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrincipal.mockResolvedValue({ handle: "alice" } as Awaited<
      ReturnType<typeof getPrincipal>
    >);
  });

  it("400s the MAX_PROJECTS refusal", async () => {
    // The refusal message carries no "required"/"invalid", so the pre-existing
    // regex alone would have called this a server fault.
    mockedCreate.mockRejectedValue(
      new ClientInputError("This workspace already has the maximum of 100 research projects."),
    );

    const response = await POST(request(BODY));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "This workspace already has the maximum of 100 research projects.",
    });
  });

  it("still 500s a storage failure", async () => {
    // The discriminator for the row above: classification is by type, not by
    // "any error from the store is the caller's fault".
    mockedCreate.mockRejectedValue(new Error("disk full"));

    expect((await POST(request(BODY))).status).toBe(500);
  });

  it("keeps 400ing the validation throws that predate ClientInputError", async () => {
    mockedCreate.mockRejectedValue(new Error("Research title is required"));

    expect((await POST(request(BODY))).status).toBe(400);
  });

  it("201s a create that lands", async () => {
    mockedCreate.mockResolvedValue({ id: "p1" } as Awaited<
      ReturnType<typeof createResearchProject>
    >);

    const response = await POST(request(BODY));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ project: { id: "p1" } });
  });
});
