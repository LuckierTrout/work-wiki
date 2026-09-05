import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mock the agents library — we only test the route's validation and wiring.
// AgentOwnershipError is a real class so the route's `instanceof` check works.
// ---------------------------------------------------------------------------
vi.mock("@/lib/agents", () => {
  class AgentOwnershipError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "AgentOwnershipError";
    }
  }
  return {
    seedAgent: vi.fn(),
    assertCanMutateAgent: vi.fn(async () => null),
    AgentOwnershipError,
    // Mirrors the real composite-id helper (separate parts joined with "--").
    agentIdFor: (owner: string, name = "yoyo") => `${owner}--${name}`,
  };
});

// The route resolves the owner from the session principal, falling back to a
// service-token principal for automated (CI) seeding.
vi.mock("@/lib/auth", () => ({
  getPrincipal: vi.fn(async () => ({ id: "test-user", handle: "test-user" })),
  getServicePrincipal: vi.fn(() => null),
}));

import { seedAgent, assertCanMutateAgent, AgentOwnershipError } from "@/lib/agents";
import { getPrincipal, getServicePrincipal } from "@/lib/auth";
import { POST } from "@/app/api/agents/seed/route";
import type { AgentProfile } from "@/lib/types";

const mockedSeedAgent = vi.mocked(seedAgent);
const mockedAssertCanMutate = vi.mocked(assertCanMutateAgent);
const mockedGetPrincipal = vi.mocked(getPrincipal);
const mockedGetServicePrincipal = vi.mocked(getServicePrincipal);

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/agents/seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function validBody() {
  return {
    id: "yoyo",
    name: "yoyo",
    description: "A self-evolving coding agent growing up in public",
    sections: [
      {
        slug: "yoyo-identity",
        title: "yoyo — Identity",
        type: "identity",
        content: "I am yoyo, an AI coding agent...",
      },
      {
        slug: "yoyo-learnings",
        title: "yoyo — Learnings",
        type: "learnings",
        content: "## Recent Lessons...",
      },
      {
        slug: "yoyo-social-wisdom",
        title: "yoyo — Social Wisdom",
        type: "social",
        content: "## Recent Insights...",
      },
    ],
  };
}

const fakeProfile: AgentProfile = {
  id: "yoyo",
  name: "yoyo",
  description: "A self-evolving coding agent growing up in public",
  identityPages: ["yoyo-identity"],
  learningPages: ["yoyo-learnings"],
  socialPages: ["yoyo-social-wisdom"],
  registered: "2026-05-03T00:00:00.000Z",
  lastUpdated: "2026-05-03T00:00:00.000Z",
};

beforeEach(() => {
  mockedSeedAgent.mockReset();
  mockedSeedAgent.mockResolvedValue(fakeProfile);
  mockedAssertCanMutate.mockReset();
  mockedAssertCanMutate.mockResolvedValue(null);
  mockedGetPrincipal.mockReset();
  mockedGetPrincipal.mockResolvedValue({ id: "test-user", handle: "test-user" });
  mockedGetServicePrincipal.mockReset();
  mockedGetServicePrincipal.mockReturnValue(null);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("POST /api/agents/seed", () => {
  describe("successful seed", () => {
    it("returns 201 with agent profile", async () => {
      const res = await POST(makeRequest(validBody()));
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.agent).toEqual(fakeProfile);
      expect(mockedSeedAgent).toHaveBeenCalledOnce();
      expect(mockedSeedAgent).toHaveBeenCalledWith({
        id: "yoyo",
        name: "yoyo",
        description: "A self-evolving coding agent growing up in public",
        owner: "test-user",
        sections: validBody().sections,
      });
    });

    it("derives owner from the session, ignoring any client-supplied owner", async () => {
      const body = { ...validBody(), owner: "attacker" };
      const res = await POST(makeRequest(body));
      expect(res.status).toBe(201);
      // Owner comes from the principal, never the body.
      expect(mockedSeedAgent).toHaveBeenCalledWith(
        expect.objectContaining({ owner: "test-user" }),
      );
    });
  });

  describe("auth & ownership", () => {
    it("returns 401 when there is neither a session nor a service token", async () => {
      mockedGetPrincipal.mockResolvedValue(null);
      mockedGetServicePrincipal.mockReturnValue(null);
      const res = await POST(makeRequest(validBody()));
      expect(res.status).toBe(401);
      expect(mockedSeedAgent).not.toHaveBeenCalled();
    });

    it("seeds via a service token when there is no session (CI path)", async () => {
      mockedGetPrincipal.mockResolvedValue(null);
      mockedGetServicePrincipal.mockReturnValue({
        id: "service:yoyo-bot",
        handle: "yoyo-bot",
      });
      const res = await POST(makeRequest(validBody()));
      expect(res.status).toBe(201);
      // The service principal's handle becomes the owner.
      expect(mockedSeedAgent).toHaveBeenCalledWith(
        expect.objectContaining({ owner: "yoyo-bot" }),
      );
      // Ownership is checked against the owner-namespaced composite id.
      expect(mockedAssertCanMutate).toHaveBeenCalledWith("yoyo-bot--yoyo", "yoyo-bot");
    });

    it("returns 403 when a non-owner tries to re-seed", async () => {
      mockedAssertCanMutate.mockRejectedValue(
        new AgentOwnershipError(
          'Agent "yoyo" is owned by @alice; @test-user cannot modify it.',
        ),
      );
      const res = await POST(makeRequest(validBody()));
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toMatch(/owned by @alice/);
      expect(mockedSeedAgent).not.toHaveBeenCalled();
    });
  });

  describe("validation — top-level fields", () => {
    it("rejects missing id", async () => {
      const body = validBody();
      delete (body as Record<string, unknown>).id;
      const res = await POST(makeRequest(body));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/id/i);
    });

    it("rejects empty id", async () => {
      const body = { ...validBody(), id: "" };
      const res = await POST(makeRequest(body));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/id/i);
    });

    it("rejects missing name", async () => {
      const body = validBody();
      delete (body as Record<string, unknown>).name;
      const res = await POST(makeRequest(body));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/name/i);
    });

    it("rejects empty name", async () => {
      const body = { ...validBody(), name: "" };
      const res = await POST(makeRequest(body));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/name/i);
    });

    it("rejects missing description", async () => {
      const body = validBody();
      delete (body as Record<string, unknown>).description;
      const res = await POST(makeRequest(body));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/description/i);
    });

    it("rejects missing sections", async () => {
      const body = validBody();
      delete (body as Record<string, unknown>).sections;
      const res = await POST(makeRequest(body));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/sections/i);
    });

    it("rejects empty sections array", async () => {
      const body = { ...validBody(), sections: [] };
      const res = await POST(makeRequest(body));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/sections/i);
    });

    it("rejects non-array sections", async () => {
      const body = { ...validBody(), sections: "not-an-array" };
      const res = await POST(makeRequest(body));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/sections/i);
    });
  });

  describe("validation — section entries", () => {
    it("rejects section missing slug", async () => {
      const body = validBody();
      delete (body.sections[0] as Record<string, unknown>).slug;
      const res = await POST(makeRequest(body));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/slug/i);
    });

    it("rejects section missing title", async () => {
      const body = validBody();
      delete (body.sections[0] as Record<string, unknown>).title;
      const res = await POST(makeRequest(body));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/title/i);
    });

    it("rejects section with invalid type", async () => {
      const body = validBody();
      (body.sections[0] as Record<string, unknown>).type = "invalid";
      const res = await POST(makeRequest(body));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/type/i);
    });

    it("rejects section missing type", async () => {
      const body = validBody();
      delete (body.sections[0] as Record<string, unknown>).type;
      const res = await POST(makeRequest(body));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/type/i);
    });

    it("rejects section missing content", async () => {
      const body = validBody();
      delete (body.sections[0] as Record<string, unknown>).content;
      const res = await POST(makeRequest(body));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/content/i);
    });

    it("rejects section with empty content", async () => {
      const body = validBody();
      (body.sections[0] as Record<string, unknown>).content = "";
      const res = await POST(makeRequest(body));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/content/i);
    });

    /**
     * DW-749 wording parity. The invalid-`type` sentence now lives verbatim in
     * TWO places — this route's `VALID_SECTION_TYPES` check and `seedAgent`'s
     * bucketing `default` arm — with no shared constant between them. The
     * duplication is deliberate (the route refuses before any lib call, and
     * `seedAgent` is the ONLY refusal on the HTTP MCP path, whose argument gate
     * does not judge `enum` members by design), but "the three doors agree on
     * the wording" is a claim that silently rots the next time either file is
     * edited.
     *
     * So this row hardcodes NOTHING. It reads the sentence the route actually
     * answers with out of its 400 body, provokes the one `seedAgent` actually
     * throws (through `importActual` — this suite mocks the module), and
     * asserts the two live strings are equal. It fails when EITHER side drifts,
     * including a drift in the index formatting, which is why the bogus section
     * is at index 1 rather than 0.
     */
    it("answers a bogus section type with the exact sentence seedAgent throws", async () => {
      const body = validBody();
      (body.sections[1] as Record<string, unknown>).type = "bogus";

      const res = await POST(makeRequest(body));
      expect(res.status).toBe(400);
      const routeSentence: string = (await res.json()).error;

      // The REAL seedAgent, not this suite's mock. It refuses in the bucketing
      // pass, before the write loop, so no storage is touched here.
      const { seedAgent: realSeedAgent } =
        await vi.importActual<typeof import("@/lib/agents")>("@/lib/agents");

      let libSentence: string | undefined;
      try {
        await realSeedAgent({
          id: body.id,
          name: body.name,
          description: body.description,
          sections: body.sections as Parameters<typeof realSeedAgent>[0]["sections"],
        });
      } catch (err) {
        libSentence = (err as Error).message;
      }

      expect(libSentence).toBe(routeSentence);
      // Guard against the vacuous pass where both are undefined/empty.
      expect(routeSentence).toContain("index 1");
    });
  });

  describe("error handling", () => {
    it("surfaces lib validation errors as 400", async () => {
      mockedSeedAgent.mockRejectedValue(new Error("Invalid agent ID: !!!"));
      const body = validBody();
      const res = await POST(makeRequest(body));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/Invalid agent ID/);
    });

    it("returns 500 for unexpected errors", async () => {
      mockedSeedAgent.mockRejectedValue(new Error("disk full"));
      const body = validBody();
      const res = await POST(makeRequest(body));
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("disk full");
    });
  });
});
