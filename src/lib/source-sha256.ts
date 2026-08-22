/**
 * SHA-256 of stored Source bytes — the ingest-skip identity (Stories 2.4–2.12).
 *
 * Distinct from FNV-1a {@link contentHash} in `embeddings.ts`, which stays the
 * embedding stale-check. A skip that used FNV would treat a different digest
 * family as "already ingested".
 */

export async function sourceSha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
