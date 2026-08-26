import { V1_APP_VERSION, type V1Health } from "@/lib/v1-contract";

/**
 * `GET /api/v1/health` — the cloud façade's half of the health contract
 * (Story 8.2).
 *
 * THE SAME FIELDS, A DIFFERENT SUBJECT. Loopback health is about a listener on
 * this machine; this is about the Worker. So `status` is `running` whenever this
 * handler executes at all — a Worker that is not running does not answer — and
 * `port_conflict` is NOT reachable here, because there is no port to contend
 * for. Reporting a value this façade cannot observe would be the same lie Epic
 * 3's flat `"ok"` was.
 *
 * PUBLIC AND UNGATED, exactly as on loopback. This is the route a client probes
 * to find out whether it may call the others, so gating it behind the switch it
 * reports on would make the answer unreachable precisely when it matters. It
 * names no Wiki, no page, no owner and no token — the whole body is booleans and
 * a version string.
 */
export function GET() {
  const body: V1Health = {
    ok: true,
    status: "running",
    version: V1_APP_VERSION,
    enabled: true,
    authRequired: true,
    authConfigured: true,
    allowUnauthenticated: false,
    tokenSource: "none",
  };
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
