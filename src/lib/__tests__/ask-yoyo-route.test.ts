import { describe, it, expect } from "vitest";
import { POST } from "@/app/api/wiki/[slug]/discuss/[threadIndex]/ask-yoyo/route";

/** Talk is retired (AD-21): ask-yoyo 404s and enqueues nothing. */
describe("POST .../discuss/[threadIndex]/ask-yoyo — retired", () => {
  it("404s with no body", async () => {
    const res = POST();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });
});
