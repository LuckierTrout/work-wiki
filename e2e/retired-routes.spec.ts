import { RETIRED_SURFACES } from "../src/lib/retired";
import { expect, test } from "./fixtures/owner";

const RETIRED_PAGES = [
  "/wiki",
  "/wiki/alpha",
  "/wiki/contributors",
  "/waitlist",
  "/u/anyone",
] as const;

const RETIRED_APIS = ["/api/wiki/browse", "/api/query/demo", "/api/contributors"] as const;

test.describe("signed-in retired-route 404s", () => {
  test("the sampled URLs are the retired surfaces, not a restated list", () => {
    expect(RETIRED_SURFACES).toEqual(
      expect.arrayContaining([
        "/wiki",
        "/wiki/[slug]",
        "/wiki/contributors",
        "/waitlist",
        "/u/[handle]",
        "/api/wiki/browse",
        "/api/query/demo",
        "/api/contributors",
      ]),
    );
  });

  for (const path of RETIRED_PAGES) {
    test(`${path} is 404 for the signed-in owner`, async ({ page }) => {
      await page.goto(path);
      // App Router document navigations can report 200 for `notFound()`; the
      // retired page still paints Next's 404 chrome, which is what the owner
      // sees. API samples below assert the HTTP status.
      await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
      await expect(page.getByText("This page could not be found.")).toBeVisible();
    });
  }

  for (const path of RETIRED_APIS) {
    test(`${path} is a bodiless 404 for the signed-in owner`, async ({
      request,
    }) => {
      const response = await request.get(path);
      expect(response.status()).toBe(404);
      expect(await response.text()).toBe("");
    });
  }
});
