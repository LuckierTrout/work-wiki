import { expect, test, unsignedTest } from "./fixtures/owner";

test.describe("private Workbench owner journey", () => {
  test("lands on the Wiki canvas as the signed-in owner", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Wiki", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Modes" })).toBeVisible();
    await expect(page.locator("#wb-canvas").getByText("No wiki yet.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Create Wiki" })).toBeEnabled();
  });

  test("creates a wiki from a scenario template and opens Settings", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Create Wiki" }).click();
    const dialog = page.getByRole("dialog", { name: "Create Wiki" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Create" }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(page.locator("#wb-canvas").getByText("No wiki yet.")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Wiki", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(
      page.getByRole("navigation", { name: "Settings categories" }),
    ).toBeVisible();
  });

  test("the Files tab is reachable after sign-in", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("tab", { name: "Files" }).click();
    await expect(page.getByRole("tab", { name: "Files" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

unsignedTest.describe("signed-out boundary", () => {
  unsignedTest.use({ storageState: { cookies: [], origins: [] } });

  unsignedTest("sends a browser with no session to sign-in", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/sign-in/);
  });
});
