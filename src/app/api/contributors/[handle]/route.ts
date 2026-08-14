import { retiredRoute } from "@/lib/retired";

/** Retired: a single public contributor profile. See `src/lib/retired.ts`. */
export function GET(): Response {
  return retiredRoute();
}
