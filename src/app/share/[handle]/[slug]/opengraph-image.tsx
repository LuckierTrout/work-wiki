import { retiredRoute } from "@/lib/retired";

// Retired alongside the share page itself: this metadata route is compiled to a
// route handler, so it answers a bodiless 404 rather than rendering a card for
// a surface that no longer exists. See `src/lib/retired.ts`.
export const dynamic = "force-dynamic";

export default function ShareOgImage() {
  return retiredRoute();
}
