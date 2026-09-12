/** Browser-safe pairing protocol. This does not replace token authentication. */
export const SIDECAR_PAIRING_PROTOCOL = 1;
export const SIDECAR_INSTANCE_HEADER = "x-work-wiki-instance";
export const SIDECAR_PAIRING_COPY =
  "This sidecar is not paired with this app. Stop the sidecar, start the app and sidecar from the same checkout with the same data directory, check WORKWIKI_URL, then reload this page.";

export interface SidecarPairing {
  protocol: number;
  instance: string;
  localIdentity: string;
}

export function appSidecarPairing(): SidecarPairing {
  return {
    protocol: SIDECAR_PAIRING_PROTOCOL,
    instance: process.env.NEXT_PUBLIC_SIDECAR_INSTANCE || "",
    localIdentity: process.env.SIDECAR_LOCAL_IDENTITY || "",
  };
}

export function isSidecarPairing(value: unknown): value is SidecarPairing {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SidecarPairing>;
  return item.protocol === SIDECAR_PAIRING_PROTOCOL &&
    typeof item.instance === "string" && item.instance.length > 0 &&
    typeof item.localIdentity === "string" && item.localIdentity.length > 0;
}

export function matchesSidecarPairing(payload: unknown, expected: string): boolean {
  if (!payload || typeof payload !== "object" || !expected) return false;
  const health = payload as { pairing?: unknown; pairingReady?: boolean };
  return health.pairingReady === true && isSidecarPairing(health.pairing) &&
    health.pairing.instance === expected;
}
