/**
 * Shared Review-count gate for the API and the Workbench badge.
 *
 * A stored or mocked `pendingCount` can be NaN, fractional, or negative.
 * Those values must not reach the rail: keep only a finite non-negative
 * integer, and let the caller fall back (usually `items.length`).
 */
export function normalizeReviewCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
