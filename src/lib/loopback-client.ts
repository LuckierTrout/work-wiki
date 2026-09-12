/** All browser calls attest the pair before sending credentials or work. */
import { send } from "./workbench-request";
import { LOOPBACK_HEALTH_URL } from "./v1-contract";
import { matchesSidecarPairing, SIDECAR_INSTANCE_HEADER } from "./sidecar-pairing";

export async function readLoopbackDoorToken(signal?: AbortSignal | null): Promise<string | null> {
  const settings = await send<{ token?: string | null }>(
    "/api/v1/loopback-settings", { method: "GET", cache: "no-store", signal },
  );
  return typeof settings.token === "string" ? settings.token : null;
}

/** Retained for Settings callers; credentials are now read on every operation. */
export function clearLoopbackDoorToken(): void {}

export async function loopbackFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const expected = process.env.NEXT_PUBLIC_SIDECAR_INSTANCE || "";
  // An old sidecar has no pairing proof: never send it the token or POST body.
  const health = await fetch(LOOPBACK_HEALTH_URL, {
    method: "GET", cache: "no-store",
    signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(6000)]) : AbortSignal.timeout(6000),
  });
  const payload = await health.json().catch(() => null);
  if (!health.ok || !matchesSidecarPairing(payload, expected)) {
    return Response.json({ error: "sidecar_pairing_mismatch", status: "pairing_mismatch" }, { status: 409 });
  }
  if (input === LOOPBACK_HEALTH_URL) return Response.json(payload);
  const token = await readLoopbackDoorToken(init.signal);
  const headers = new Headers(init.headers);
  if (token && !headers.has("authorization")) headers.set("Authorization", `Bearer ${token}`);
  headers.set(SIDECAR_INSTANCE_HEADER, expected);
  // The server checks again here, closing the gap after the health probe.
  return fetch(input, { ...init, headers });
}
