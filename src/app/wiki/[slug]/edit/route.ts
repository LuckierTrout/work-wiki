import { retiredRoute } from "@/lib/retired";

/**
 * Retired: the legacy flat edit URL. It lived inside the `/wiki/[slug]`
 * namespace, which is retired wholesale, so it no longer 308s to the canonical
 * `/u/<tenant>/<slug>/edit` — it 404s like the rest of the namespace.
 * See `src/lib/retired.ts`.
 */
export function GET(): Response {
  return retiredRoute();
}
