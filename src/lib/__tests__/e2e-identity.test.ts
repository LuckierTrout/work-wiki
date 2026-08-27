import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  E2E_COOKIE_NAME,
  E2E_DEFAULT_HANDLE,
  E2E_SECRET_MIN_LENGTH,
  isE2eIdentityArmed,
  mintE2eCookie,
  principalFromCookieValue,
} from "../e2e-identity";

const SECRET = "e2e-local-secret-do-not-use-in-prod-32";
const OWNER = "user_e2e_owner";

const saved: Record<string, string | undefined> = {};

function arm(extra: Record<string, string | undefined> = {}) {
  const keys = [
    "YOPEDIA_E2E",
    "YOPEDIA_E2E_SECRET",
    "YOPEDIA_OWNER_USER_ID",
    "YOPEDIA_SITE_URL",
    "NEXT_PUBLIC_OWNER_HANDLE",
  ];
  for (const key of keys) saved[key] = process.env[key];
  process.env.YOPEDIA_E2E = "1";
  process.env.YOPEDIA_E2E_SECRET = SECRET;
  process.env.YOPEDIA_OWNER_USER_ID = OWNER;
  delete process.env.YOPEDIA_SITE_URL;
  process.env.NEXT_PUBLIC_OWNER_HANDLE = "e2e-owner";
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("isE2eIdentityArmed", () => {
  it("is off by default", () => {
    arm({ YOPEDIA_E2E: undefined, YOPEDIA_E2E_SECRET: undefined });
    expect(isE2eIdentityArmed()).toBe(false);
  });

  it("requires the flag, a long secret, and not the production origin", () => {
    arm();
    expect(isE2eIdentityArmed()).toBe(true);

    arm({ YOPEDIA_E2E: "0" });
    expect(isE2eIdentityArmed()).toBe(false);

    arm({ YOPEDIA_E2E_SECRET: "too-short" });
    expect(isE2eIdentityArmed()).toBe(false);

    arm({ YOPEDIA_SITE_URL: "https://workwiki.app" });
    expect(isE2eIdentityArmed()).toBe(false);
  });

  it("keeps the cookie name inside the frozen yopedia_ localStorage family", () => {
    expect(E2E_COOKIE_NAME).toBe("yopedia_e2e");
    expect(E2E_SECRET_MIN_LENGTH).toBe(32);
    expect(E2E_DEFAULT_HANDLE).toBe("e2e-owner");
  });
});

describe("mint / verify", () => {
  it("round-trips the configured owner and refuses a tampered cookie", async () => {
    arm();
    const value = await mintE2eCookie(OWNER, SECRET);
    await expect(principalFromCookieValue(value)).resolves.toEqual({
      id: OWNER,
      handle: "e2e-owner",
    });

    const flipped = value.slice(0, -1) + (value.endsWith("a") ? "b" : "a");
    await expect(principalFromCookieValue(flipped)).resolves.toBeNull();
    await expect(principalFromCookieValue(undefined)).resolves.toBeNull();
  });

  it("refuses a well-signed cookie for a different user id", async () => {
    arm();
    const other = await mintE2eCookie("user_other", SECRET);
    await expect(principalFromCookieValue(other)).resolves.toBeNull();
  });

  it("is inert when the harness is not armed", async () => {
    arm({ YOPEDIA_E2E: undefined });
    const value = await mintE2eCookie(OWNER, SECRET);
    await expect(principalFromCookieValue(value)).resolves.toBeNull();
  });
});

/**
 * DW-157 — `e2eOwnerHandle()` reads the site owner through `getOwnerHandle()`
 * rather than its own `process.env.NEXT_PUBLIC_OWNER_HANDLE?.trim()`.
 *
 * Every other fixture in this file arms the harness with the literal
 * `"e2e-owner"`, which IS `E2E_DEFAULT_HANDLE` — so on their evidence alone the
 * function could ignore the environment entirely and hardcode the default, and
 * the whole suite would stay green. These cases are the ones that separate the
 * two: they configure a handle that DIFFERS from the default, and they check
 * the absent-value cases the helper is responsible for collapsing.
 *
 * Asserted through `principalFromCookieValue` rather than on `e2eOwnerHandle()`
 * directly: the handle's only consumer is the principal the middleware and
 * `getPrincipal` mint, so that is the surface where getting it wrong bites.
 */
describe("e2eOwnerHandle at the minted-principal surface", () => {
  it("carries the CONFIGURED handle, trimmed", async () => {
    arm({ NEXT_PUBLIC_OWNER_HANDLE: "  christianlee  " });

    const value = await mintE2eCookie(OWNER, SECRET);

    await expect(principalFromCookieValue(value)).resolves.toEqual({
      id: OWNER,
      handle: "christianlee",
    });
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace-only", "   "],
  ])(
    "falls back to E2E_DEFAULT_HANDLE when the handle is %s",
    async (_label, handle) => {
      // `getOwnerHandle()` returns null for all three, which is exactly what
      // the inline read this replaced treated as absent.
      arm({ NEXT_PUBLIC_OWNER_HANDLE: handle });

      const value = await mintE2eCookie(OWNER, SECRET);

      await expect(principalFromCookieValue(value)).resolves.toEqual({
        id: OWNER,
        handle: E2E_DEFAULT_HANDLE,
      });
    },
  );
});

describe("production lock", () => {
  it("is not named in either wrangler file", async () => {
    const roots = [
      path.resolve(__dirname, "../../../wrangler.jsonc"),
      path.resolve(__dirname, "../../../workers/task-consumer/wrangler.jsonc"),
    ];
    for (const file of roots) {
      const text = await readFile(file, "utf8");
      expect(text).not.toMatch(/YOPEDIA_E2E\b/);
    }
  });
});
