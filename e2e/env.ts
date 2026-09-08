/** Shared by Playwright config and the owner fixture so the cookie and the server agree. */
export const E2E_SECRET = "e2e-local-secret-do-not-use-in-prod-32";
export const E2E_OWNER_ID = "user_e2e_owner";
export const E2E_OWNER_HANDLE = "e2e-owner";
export const E2E_PORT = 4173;
export const E2E_ORIGIN = `http://127.0.0.1:${E2E_PORT}`;
