/** Server-only guidance identity. Storage and attribution keep the caller's handle. */
import { getStorage } from "./storage";
import { isEnoent } from "./errors";
import { slugify } from "./slugify";
import { assertDistinctAgentHandle } from "./owner";

function validOwner(value: unknown): value is string {
  if (typeof value !== "string" || /[\u0000-\u001f/\\]/.test(value)) return false;
  // Match the existing tenant normalization without accepting its empty/default
  // fallback. Dots within a real human handle (alice.smith) remain valid.
  const hasIdentity = (part: string) => part.replace(/[\s.\-]/g, "").length > 0;
  const boundary = value.indexOf("--");
  return hasIdentity(value) && (boundary < 0 || hasIdentity(value.slice(0, boundary)));
}

/**
 * A delimiter alone is not evidence that a principal is an agent. Consult the
 * full registry identity; its owner was recorded from the authenticated session.
 * Unknown identities retain their own guidance silo. Invalid or contradictory
 * records stop the operation before any fallback can borrow default guidance.
 * No process cache: registry changes must be visible on the next operation.
 */
export async function resolveGuidanceOwner(handle: string): Promise<string> {
  if (!validOwner(handle)) throw new Error("Invalid guidance principal");
  // Only this grammar can name a stored agent. Human handles need not follow it.
  if (!handle.includes("--") || !/^[a-z0-9][a-z0-9-]*$/.test(handle)) return handle;
  let profile: unknown;
  try {
    profile = JSON.parse(await getStorage().readFile(`agents/${handle}.json`));
  } catch (error) {
    if (isEnoent(error)) return handle;
    throw error;
  }
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("Invalid guidance agent identity");
  }
  assertDistinctAgentHandle(handle);
  const record = profile as Record<string, unknown>;
  const owner = record.owner;
  if (record.id !== handle || !validOwner(owner) || !slugify(owner)) {
    throw new Error("Invalid guidance agent ownership");
  }
  const prefix = `${slugify(owner)}--`;
  const name = handle.slice(prefix.length);
  if (!handle.startsWith(prefix) || !name || slugify(name) !== name) {
    throw new Error("Inconsistent guidance agent ownership");
  }
  return owner;
}
