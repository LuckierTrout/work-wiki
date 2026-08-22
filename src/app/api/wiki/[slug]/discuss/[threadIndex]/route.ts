import { retiredRoute } from "@/lib/retired";

/** Retired: a single talk thread. See `src/lib/retired.ts`. */
export function GET(): Response {
  return retiredRoute();
}

export function PATCH(): Response {
  return retiredRoute();
}
