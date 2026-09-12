/** Fresh kernel attestation; no disk fallback or last-good pairing on failure. */
import { fileURLToPath } from "node:url";
import { localSidecarIdentity } from "../tools/sidecar-identity.mjs";

export const SIDECAR_PAIRING_PROTOCOL = 1;
export const SIDECAR_INSTANCE_HEADER = "x-work-wiki-instance";
const root = fileURLToPath(new URL("..", import.meta.url));

export function isSidecarPairing(value) {
  return value && typeof value === "object" &&
    value.protocol === SIDECAR_PAIRING_PROTOCOL &&
    typeof value.instance === "string" && value.instance.length > 0 &&
    typeof value.localIdentity === "string" && value.localIdentity.length > 0;
}

export function pairingOrigin(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    // Loopback aliases reach the same listener; different ports never do.
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) url.hostname = "localhost";
    return url.origin;
  } catch { return null; }
}

export function createPairingSource({ kernel, localIdentity = localSidecarIdentity(root), fetchImpl = fetch }) {
  // Only simultaneous reads coalesce. Every subsequent operation asks again.
  let pending;
  return {
    read() {
      if (pending) return pending;
      pending = (async () => {
        try {
          if (!kernel.base || !kernel.token) return null;
          const url = new URL(kernel.base);
          const response = await fetchImpl(`${kernel.base}/api/v1/loopback-settings`, {
            headers: { authorization: `Bearer ${kernel.token}` },
            cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5000),
          });
          if (!response.ok) return null;
          const { pairing } = await response.json();
          if (!isSidecarPairing(pairing)) return null;
          const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
          if (local && pairing.localIdentity !== localIdentity) return null;
          return pairing;
        } catch { return null; }
      })().finally(() => { pending = undefined; });
      return pending;
    },
  };
}
