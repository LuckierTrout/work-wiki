import { describe, it, expect } from "vitest";
import { POST } from "@/app/api/agents/[id]/publish/route";

/**
 * Publish-to-commons is retired (AD-21): the route answers a bodiless 404 for
 * every caller and credential, and performs no side effects.
 */
describe("POST /api/agents/[id]/publish — retired", () => {
  it("404s with no body", async () => {
    const res = POST();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });

  it("takes no arguments — no token, agent, or body is inspected", () => {
    expect(POST.length).toBe(0);
  });
});
