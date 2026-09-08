import { retiredRoute } from "@/lib/retired";

/** Retired: ask-yoyo on a talk thread. See `src/lib/retired.ts`. */
export function POST(): Response {
  return retiredRoute();
}
