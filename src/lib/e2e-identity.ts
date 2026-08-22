/**
 * Deterministic authenticated identity for local Playwright E2E.
 *
 * Armed only when `YOPEDIA_E2E=1` and `YOPEDIA_E2E_SECRET` is at least 32
 * characters, and never on the production origin (`YOPEDIA_SITE_URL`).
 * Production wrangler files must not set `YOPEDIA_E2E` — a test pins that.
 *
 * The cookie is HMAC-SHA256 over the configured owner user id. Middleware and
 * `getPrincipal` share this module so the fixture cannot mint a principal the
 * gate would refuse, or pass the gate as someone `getPrincipal` would treat
 * as anonymous.
 *
 * This is a local test harness, not an operator setting. It must stay out of
 * wrangler vars and Cloudflare secrets.
 */

export const E2E_COOKIE_NAME = "yopedia_e2e";
export const E2E_SECRET_MIN_LENGTH = 32;
export const E2E_FLAG_ENV = "YOPEDIA_E2E";
export const E2E_SECRET_ENV = "YOPEDIA_E2E_SECRET";
export const E2E_DEFAULT_HANDLE = "e2e-owner";

const PRODUCTION_SITE_URL = "https://workwiki.app";
const OWNER_ID_RE = /^[A-Za-z0-9_-]+$/;

export interface Principal {
  id: string;
  handle: string;
}

export function isE2eIdentityArmed(): boolean {
  if (process.env.YOPEDIA_SITE_URL === PRODUCTION_SITE_URL) return false;
  if (process.env[E2E_FLAG_ENV] !== "1") return false;
  const secret = process.env[E2E_SECRET_ENV];
  return typeof secret === "string" && secret.length >= E2E_SECRET_MIN_LENGTH;
}

export function e2eOwnerUserId(): string | null {
  const id = process.env.YOPEDIA_OWNER_USER_ID?.trim();
  return id && OWNER_ID_RE.test(id) ? id : null;
}

export function e2eOwnerHandle(): string {
  const handle = process.env.NEXT_PUBLIC_OWNER_HANDLE?.trim();
  return handle && handle.length > 0 ? handle : E2E_DEFAULT_HANDLE;
}

function e2eSecret(): string | null {
  const secret = process.env[E2E_SECRET_ENV];
  return typeof secret === "string" && secret.length >= E2E_SECRET_MIN_LENGTH
    ? secret
    : null;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return [...new Uint8Array(sig)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Mint the httpOnly cookie value the Playwright owner fixture installs.
 *
 * `userId` must be the same `YOPEDIA_OWNER_USER_ID` the server is configured
 * with — a cookie for anyone else verifies, then the owner gate refuses it.
 */
export async function mintE2eCookie(
  userId: string,
  secret: string,
): Promise<string> {
  if (!OWNER_ID_RE.test(userId)) {
    throw new Error("e2e identity user id is not a Clerk-shaped id");
  }
  if (secret.length < E2E_SECRET_MIN_LENGTH) {
    throw new Error("e2e identity secret is too short");
  }
  const hex = await hmacHex(secret, `v1.${userId}`);
  return `v1.${userId}.${hex}`;
}

export async function principalFromCookieValue(
  value: string | undefined | null,
): Promise<Principal | null> {
  if (!isE2eIdentityArmed()) return null;
  const secret = e2eSecret();
  const ownerId = e2eOwnerUserId();
  if (!secret || !ownerId || !value) return null;

  const match = /^v1\.([A-Za-z0-9_-]+)\.([0-9a-f]+)$/.exec(value);
  if (!match) return null;
  const [, userId, hex] = match;
  const expected = await hmacHex(secret, `v1.${userId}`);
  if (!timingSafeEqualHex(hex, expected)) return null;
  if (userId !== ownerId) return null;
  return { id: ownerId, handle: e2eOwnerHandle() };
}
