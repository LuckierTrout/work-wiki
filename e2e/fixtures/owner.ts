import { test as base, expect } from "@playwright/test";
import { E2E_COOKIE_NAME, mintE2eCookie } from "../../src/lib/e2e-identity";
import { E2E_OWNER_ID, E2E_SECRET } from "../env";

/**
 * Authenticated Workbench owner. Installs the HMAC cookie `getPrincipal` and
 * middleware accept when `YOPEDIA_E2E=1`. No Clerk account, no saved session
 * file — the identity is minted from the same secret the webServer is started
 * with.
 */
export const test = base.extend({
  storageState: async ({}, use) => {
    const value = await mintE2eCookie(E2E_OWNER_ID, E2E_SECRET);
    await use({
      cookies: [
        {
          name: E2E_COOKIE_NAME,
          value,
          domain: "127.0.0.1",
          path: "/",
          expires: Math.floor(Date.now() / 1000) + 60 * 60,
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    });
  },
});

export const unsignedTest = base;

export { expect };
