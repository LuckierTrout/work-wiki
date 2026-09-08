import { describe, it, expect, vi } from "vitest";
import { GET } from "../../app/api/query/demo/route";
import * as queryModule from "../query";

/**
 * The signed-out, no-auth query demo is retired (AD-21). It was the only
 * unauthenticated route in the app; it now 404s and never reaches the LLM.
 */
describe("GET /api/query/demo — retired", () => {
  it("404s with no body", async () => {
    const res = GET();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });

  it("never runs a query", () => {
    const spy = vi.spyOn(queryModule, "query");
    GET();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
