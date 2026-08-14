import { retiredRoute } from "@/lib/retired";

/** Retired: public commons browse search. See `src/lib/retired.ts`. */
export function GET(): Response {
  return retiredRoute();
}
