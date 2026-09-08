/**
 * The SERVER half of the E2E identity seam (DW-534).
 *
 * Resolves the `yopedia_e2e` cookie with the SAME `principalFromCookieValue`
 * that `src/middleware.ts` and `getPrincipal` use — one verifier, so the client
 * gates can never admit a viewer the server would refuse — and hands the result
 * to the client provider. That is the whole discovery mechanism: no new HTTP
 * route, no client fetch, and no `NEXT_PUBLIC_*` variable carrying the identity
 * into the bundle.
 *
 * FAILS CLOSED, ALWAYS. `principalFromCookieValue` already answers `null` when
 * the harness is not armed, when the cookie is absent, when the HMAC does not
 * verify, or when the cookie names anyone but `YOPEDIA_OWNER_USER_ID`. The
 * `catch` here covers what it cannot see: no request cookie store at all (a
 * non-request scope). Every one of those publishes a signed-out viewer — never
 * the owner — which mirrors `getE2ePrincipal` in `src/lib/auth.ts` exactly, and
 * keeps the client gate narrower-or-equal to the server's.
 *
 * AND IT IS NARROW, the same two ways `getPrincipal` is. Next's own control-flow
 * errors — chiefly the dynamic-rendering bailout `cookies()` throws when a
 * statically-probed route reads it — are re-thrown with `unstable_rethrow`
 * rather than absorbed, because swallowing one would both mislabel a normal
 * build event as "no cookie" and muddy Next's dynamic-render detection. What is
 * left is logged before the downgrade: a signed-out answer here is
 * INDISTINGUISHABLE from the DW-534 symptom this component exists to fix, so a
 * genuine defect must not reach the harness as silence.
 *
 * `next/headers` is imported LAZILY, inside the function. This module is
 * statically imported by `src/app/layout.tsx` (a conditional import there would
 * make `AppProviders` async, which `src/app/__tests__/app-shell.test.tsx` pins
 * against), so a top-level `import { cookies } from "next/headers"` would put a
 * request-scoped API into the module graph of every non-armed render too. The
 * dynamic import keeps the harness out of production render paths: nothing loads
 * `next/headers` unless this component actually runs.
 */

import { unstable_rethrow } from "next/navigation";
import { E2E_COOKIE_NAME, principalFromCookieValue } from "@/lib/e2e-identity";
import { logger } from "@/lib/logger";
import { E2eViewerIdentityProvider } from "./E2eViewerIdentityProvider";

async function e2eViewerHandle(): Promise<string | null> {
  try {
    const { cookies } = await import("next/headers");
    const jar = await cookies();
    const principal = await principalFromCookieValue(jar.get(E2E_COOKIE_NAME)?.value);
    return principal?.handle ?? null;
  } catch (err) {
    // Next's control-flow errors are not failures — let the dynamic-rendering
    // bailout propagate so a statically-probed route still becomes dynamic.
    unstable_rethrow(err);
    // Anything else is either no request cookie store (a non-request scope) or a
    // real defect, and the two are told apart by the log, not by the answer:
    // both fail closed to a signed-out viewer, never the owner. `warn` matches
    // `getPrincipal`'s ambiguous branch — suppressed at the test default
    // (level=error), visible while the harness runs.
    logger.warn(
      "e2e-identity",
      "resolving the E2E viewer cookie threw — no request scope, or a genuine failure; treating the viewer as signed out",
      err,
    );
    return null;
  }
}

export async function E2eViewerIdentity({
  children,
}: {
  children: React.ReactNode;
}) {
  const handle = await e2eViewerHandle();
  return (
    <E2eViewerIdentityProvider handle={handle}>{children}</E2eViewerIdentityProvider>
  );
}
