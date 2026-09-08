import { getLoopbackApiSettings, loadConfigSync } from "@/lib/config";
import { getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { requireOwnerOrServicePrincipal } from "@/lib/owner-route";

/**
 * `GET /api/v1/loopback-settings` — the one door the loopback token leaves by
 * (Story 8.1).
 *
 * THE SIDECAR CANNOT READ THE STORE. `AppConfig` lives in kernel storage (AD-23,
 * and on a deployed kernel that is R2), the sidecar must not import `src/lib`,
 * and the Worker cannot dial `127.0.0.1` to push. So the sidecar asks, over the
 * same owner-automation bearer token the extract claim loop already presents —
 * `WORKWIKI_API_TOKEN` / `YOPEDIA_SERVICE_TOKEN`, no third token family.
 *
 * THE OWNER'S OWN SESSION IS ALSO ADMITTED, and that is deliberate rather than a
 * loosening. Two callers legitimately need the plaintext token in a browser:
 *
 *  - Settings → API + MCP, whose locked controls are Generate / **show** / hide /
 *    **copy**. "Show a token you already stored" is not possible from a payload
 *    that only reports `hasLoopbackApiToken`.
 *  - The Workbench's own Chat, which reaches the sidecar from the browser and
 *    therefore has to present the same bearer token every other client does. The
 *    alternative was exempting the product's own origin from the token gate,
 *    which would have made the gate weaker than it looks for one caller class.
 *
 * `getWorkbenchSettings` is still the redacted read and still never carries the
 * value: this route is the ONE door the plaintext leaves by, both callers are the
 * owner, and it is `no-store` on every path.
 *
 * "Settings apply only after Save" falls out of the sidecar reading them HERE
 * rather than caching them forever: it re-polls, so a Save lands within one
 * interval and an unsaved draft never lands at all.
 *
 * NOTHING HERE IS LOGGED. Not on success, not on failure, not truncated. The
 * error path logs the thrown message only, and every branch below is reached
 * before the token is read.
 */
export async function GET(request: Request) {
  try {
    if (!(await requireOwnerOrServicePrincipal(request))) {
      // 401 for "nothing authorized this", never 403: a 403 would confirm to an
      // unauthenticated caller that the route exists and is worth guessing at.
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const settings = getLoopbackApiSettings();
    return Response.json(
      {
        enabled: settings.enabled,
        allowUnauthenticated: settings.allowUnauthenticated,
        token: settings.token,
        tokenSource: settings.tokenSource,
        // SKILL ENABLEMENT RIDES ALONG, on this route rather than on a second
        // one, because the sidecar needs it on exactly the same schedule and for
        // exactly the same reason: it is an owner decision stored in the kernel
        // that a process on the owner's laptop has to honour. A separate poll
        // would double the requests to say the same thing one interval later.
        //
        // The map records DECISIONS — absent means enabled — so an empty object
        // is the correct answer for a workspace that has never disabled a Skill,
        // and `scanSkills` reads it that way.
        skillEnablement: loadConfigSync().skillEnablement ?? {},
      },
      // Never cached, anywhere. A revoked token that a CDN or a `fetch` cache
      // kept answering with would be a credential the owner believes they
      // rotated.
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    logger.error("api", "loopback settings door failed", error);
    return Response.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
