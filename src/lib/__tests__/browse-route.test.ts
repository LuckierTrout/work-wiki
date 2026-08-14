import { describe, it, expect, vi } from "vitest";
import { GET } from "@/app/api/wiki/browse/route";
import * as browse from "../browse";

/**
 * Public commons browse is retired (AD-21): the handler 404s without touching
 * the search library, so no query, param parsing, or index read happens.
 */
describe("GET /api/wiki/browse — retired", () => {
  it("404s with no body", async () => {
    const res = GET();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });

  it("never calls searchCommons", () => {
    const spy = vi.spyOn(browse, "searchCommons");
    GET();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
