import { retiredRoute } from "@/lib/retired";

/** Retired: talk thread comments. See `src/lib/retired.ts`. */
export function POST(): Response {
  return retiredRoute();
}
