import { retiredRoute } from "@/lib/retired";

/** Retired: page discussion (talk) threads. See `src/lib/retired.ts`. */
export function GET(): Response {
  return retiredRoute();
}

export function POST(): Response {
  return retiredRoute();
}
