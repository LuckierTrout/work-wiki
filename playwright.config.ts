import { defineConfig } from "@playwright/test";
import {
  E2E_ORIGIN,
  E2E_OWNER_HANDLE,
  E2E_OWNER_ID,
  E2E_PORT,
  E2E_SECRET,
} from "./e2e/env";

/**
 * Authenticated browser E2E against a dedicated `next dev` on :4173.
 *
 * The owner identity is the HMAC cookie from `src/lib/e2e-identity.ts`, not a
 * Clerk account. `next dev` is required so `YOPEDIA_E2E` is read at request
 * time — Next inlines middleware env at `next build`, which would bake the
 * harness into a production artifact.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: E2E_ORIGIN,
    trace: "on-first-retry",
  },
  webServer: {
    command: `rm -rf e2e/.data && pnpm exec next dev --turbopack --hostname 127.0.0.1 -p ${E2E_PORT}`,
    url: E2E_ORIGIN,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      YOPEDIA_E2E: "1",
      YOPEDIA_E2E_SECRET: E2E_SECRET,
      YOPEDIA_OWNER_USER_ID: E2E_OWNER_ID,
      NEXT_PUBLIC_OWNER_HANDLE: E2E_OWNER_HANDLE,
      YOPEDIA_SITE_URL: "",
      DATA_DIR: "e2e/.data",
      WIKI_DIR: "e2e/.data/wiki",
      RAW_DIR: "e2e/.data/raw",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
        process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??
        "pk_test_ZWUyZS1sb2NhbC1ub3QtZm9yLXByb2Q",
      CLERK_SECRET_KEY:
        process.env.CLERK_SECRET_KEY ?? "sk_test_e2e_local_not_for_prod",
    },
  },
});
