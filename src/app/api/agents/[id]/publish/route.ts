import { retiredRoute } from "@/lib/retired";

/** Retired: publish an agent page to the commons. See `src/lib/retired.ts`. */
export function POST(): Response {
  return retiredRoute();
}
