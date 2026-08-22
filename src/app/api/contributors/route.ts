import { retiredRoute } from "@/lib/retired";

/** Retired: public contributor profiles. See `src/lib/retired.ts`. */
export function GET(): Response {
  return retiredRoute();
}
