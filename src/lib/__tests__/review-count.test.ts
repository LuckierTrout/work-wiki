import { describe, expect, it } from "vitest";
import { normalizeReviewCount } from "../review-count";

describe("normalizeReviewCount", () => {
  it("keeps finite non-negative integers", () => {
    expect(normalizeReviewCount(0)).toBe(0);
    expect(normalizeReviewCount(3)).toBe(3);
  });

  it("drops every other value", () => {
    expect(normalizeReviewCount(-1)).toBeNull();
    expect(normalizeReviewCount(2.5)).toBeNull();
    expect(normalizeReviewCount(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeReviewCount("2")).toBeNull();
    expect(normalizeReviewCount(undefined)).toBeNull();
  });
});
