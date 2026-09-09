import { expect, test } from "@playwright/test";

// Temporary publication check: removed after GitHub failure-artifact receipt.
test("controlled first-attempt failure uploads synthetic browser evidence", async ({ page }, testInfo) => {
  expect(testInfo.retry).toBe(0);
  await page.setContent("<main><h1>Synthetic CI artifact verification</h1></main>");
  await expect(page.getByRole("heading")).toHaveText("Intentional failure for artifact verification");
});
