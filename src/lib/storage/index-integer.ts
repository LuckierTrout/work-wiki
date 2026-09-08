/**
 * What a stored counter is worth.
 *
 * Anything that is not a non-negative, finite INTEGER reads as `0` rather than
 * propagating: a hand-edited `"x"`, a `1.5`, a `-1` or a `NaN` would otherwise
 * flow straight into `previous + 1` and produce a counter that never compares
 * usefully again. Shared by the reader and by {@link StorageProvider.incrementIndex}
 * so a corrupt value heals the same way on every provider.
 */
export function narrowIndexInteger(value: unknown): number {
  if (typeof value !== "number") return 0;
  if (!Number.isInteger(value)) return 0;
  return value >= 0 ? value : 0;
}
