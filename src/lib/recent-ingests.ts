/**
 * Client-side memory of recently-submitted async ingest job ids (localStorage).
 * Lets the /ingest page show a "Recent ingests" strip — with live status fetched
 * per id — so an outcome (done / failed) is visible even after a reload, without
 * a server-side per-user job index.
 */

const KEY = "yopedia_recent_ingests";
const MAX = 8;

export function rememberRecentJob(jobId: string): void {
  if (typeof window === "undefined") return;
  try {
    const ids = [jobId, ...getRecentJobIds().filter((id) => id !== jobId)];
    window.localStorage.setItem(KEY, JSON.stringify(ids.slice(0, MAX)));
  } catch {
    // localStorage unavailable (private mode / quota) — non-critical.
  }
}

export function getRecentJobIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const ids: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Remove terminal job ids after the user clears them from Recent ingests. */
export function forgetRecentJobs(jobIds: string[]): void {
  if (typeof window === "undefined" || jobIds.length === 0) return;
  try {
    const forgotten = new Set(jobIds);
    const remaining = getRecentJobIds().filter((id) => !forgotten.has(id));
    window.localStorage.setItem(KEY, JSON.stringify(remaining));
  } catch {
    // localStorage unavailable — the server-side deletion still succeeded.
  }
}
