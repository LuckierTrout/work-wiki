import { notFound } from "next/navigation";

/**
 * The commons product surface retired with the move to a private, single-owner
 * Workbench (Story 1.1 / AD-21).
 *
 * Every entry here is a route that used to serve public browse, public
 * profiles, share, waitlist, the no-auth query demo, publish-to-commons, or
 * talk. Each one now answers 404 through {@link retiredPage} (App Router pages)
 * or {@link retiredRoute} (route handlers), so "what got cut" is one enumerable
 * list rather than twenty independent edits.
 *
 * The underlying `src/lib/` modules are deliberately left on disk with no
 * reachable callers — deleting them would cascade into `trail.ts`,
 * `graph-build.ts`, `search.ts`, `merge.ts`, `vault.ts`, and `maintenance.ts`,
 * which later epics still need.
 *
 * Paths use the App Router's dynamic-segment notation (`[slug]`) so a surface
 * is named the same way its file is.
 */
export const RETIRED_SURFACES = [
  // Pages
  "/wiki",
  "/wiki/[slug]",
  "/wiki/[slug]/edit",
  "/wiki/contributors",
  "/waitlist",
  "/share/[handle]/[slug]",
  "/share/[handle]/[slug]/opengraph-image",
  "/u/[handle]",
  "/u/[handle]/a/[agent]",
  // Route handlers
  "/api/wiki/browse",
  "/api/contributors",
  "/api/contributors/[handle]",
  "/api/query/demo",
  "/api/agents/[id]/publish",
  "/api/wiki/[slug]/discuss",
  "/api/wiki/[slug]/discuss/[threadIndex]",
  "/api/wiki/[slug]/discuss/[threadIndex]/comments",
  "/api/wiki/[slug]/discuss/[threadIndex]/ask-yoyo",
] as const;

export type RetiredSurface = (typeof RETIRED_SURFACES)[number];

/**
 * The body of a retired App Router **page**. Throws Next's not-found signal, so
 * the route renders the app's 404 instead of the retired commons UI.
 */
export function retiredPage(): never {
  notFound();
}

/**
 * The body of a retired **route handler**. A bodiless 404 — no error envelope,
 * no side effects, identical for every method and every caller.
 */
export function retiredRoute(): Response {
  return new Response(null, { status: 404 });
}
