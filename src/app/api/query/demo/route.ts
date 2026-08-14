import { retiredRoute } from "@/lib/retired";

/** Retired: the no-auth signed-out query demo. See `src/lib/retired.ts`. */
export function GET(): Response {
  return retiredRoute();
}
