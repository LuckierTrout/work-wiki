/**
 * SHA-256 of stored Source bytes — the ingest-skip identity (Stories 2.4–2.12).
 *
 * Distinct from FNV-1a {@link contentHash} in `embeddings.ts`, which stays the
 * embedding stale-check. A skip that used FNV would treat a different digest
 * family as "already ingested".
 */

export async function sourceSha256(text: string): Promise<string> {
  return bytesSha256(new TextEncoder().encode(text));
}

/**
 * The same digest over RAW BYTES (Story 7.1).
 *
 * A PDF has no text form to hash, and encoding one through `TextEncoder` would
 * replace every byte that is not valid UTF-8 — two different PDFs could hash
 * identically. This is the id a binary Source is stored under AND the key the
 * sidecar's parse cache uses, so it has to be over the bytes themselves.
 */
export async function bytesSha256(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
