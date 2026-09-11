import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/owner";
import { createOwnWiki, resetOwnerTenant, seedWikiPages } from "./fixtures/wiki";

// These cases share the harness store, so establish and return an empty tenant.
// Actual browser history and rendered withdrawal are essential here: jsdom does
// not blur focus when a containing region becomes hidden.
test.beforeAll(async () => resetOwnerTenant());
test.afterAll(async () => resetOwnerTenant());
const runtimeErrors: string[] = [];
test.beforeEach(async ({ page }) => {
  runtimeErrors.length = 0;
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
});
test.afterEach(() => expect(runtimeErrors).toEqual([]));

const settingsButton = (page: Page) => page.getByRole("button", { name: "Settings", exact: true });
const settingsNav = (page: Page) => page.getByRole("navigation", { name: "Settings categories" });

async function shell(page: Page, mode = "wiki") {
  await createOwnWiki(page, `History focus ${Date.now()}`);
  await page.goto(`/?mode=${mode}`);
  await expect(page.locator(".wb-shell")).toHaveAttribute("data-mounted", "true");
}

async function settings(page: Page, open: boolean) {
  await settingsButton(page).click();
  if (open) await expect(settingsNav(page)).toBeVisible();
  else await expect(settingsNav(page)).toHaveCount(0);
}

async function traverse(page: Page, direction: "back" | "forward", open: boolean) {
  if (direction === "back") await page.goBack();
  else await page.goForward();
  await expect(page).toHaveURL(open ? /[?&]settings=1(?:&|$)/ : /^(?!.*[?&]settings=1).*$/);
  if (open) await expect(settingsNav(page)).toBeVisible();
  else await expect(settingsNav(page)).toHaveCount(0);
}

test("category Back preserves its row, then closing Back rescues the canvas", async ({ page }) => {
  await shell(page);
  await settings(page, true);
  const category = settingsNav(page).getByRole("button", { name: "Embeddings", exact: true });
  await category.click();
  await expect(category).toBeFocused();
  await page.goBack();
  await expect(page).not.toHaveURL(/category=/);
  await expect(settingsNav(page)).toBeVisible();
  await expect(category).toBeFocused();
  await traverse(page, "back", false);
  await expect(page.locator("#wb-canvas")).toBeFocused();
});

const departures = [
  ["tree", "wiki", ".wb-tree-panel button"],
  ["Sources", "sources", ".wb-left-surface button"],
  ["Activity", "wiki", ".wb-activity button"],
  ["Preview", "wiki", "#wb-preview-column button"],
  ["Preview separator", "wiki", ".wb-split-handle--preview"],
  ["canvas", "wiki", "#wb-canvas"],
] as const;

for (const direction of ["back", "forward"] as const) {
  for (const [name, mode, selector] of departures) {
    test(`${direction} opening Settings rescues ${name}`, async ({ page }) => {
      await shell(page, mode);
      if (selector.includes("preview")) {
        await seedWikiPages(page, [{ slug: "history-focus-alpha", content: "# History focus alpha\n\nPreview focus target." }]);
        await page.reload();
      }
      await settings(page, true);
      if (direction === "back") await settings(page, false);
      else await traverse(page, "back", false);
      if (selector.includes("preview")) {
        await page.locator("button.wb-tree-row:not(.wb-tree-row--group)").filter({ hasText: "History focus alpha" }).first().click();
        await expect(page.locator("#wb-preview-column")).toBeVisible();
      }
      const control = page.locator(selector).first();
      await expect(control).toBeVisible();
      await control.focus();
      await expect(control).toBeFocused();
      const departed = await control.elementHandle();
      await traverse(page, direction, true);
      await expect(page.locator("#wb-canvas")).toBeFocused();
      expect(await departed!.evaluate((node) =>
        !node.isConnected || node.closest("[hidden]") !== null,
      )).toBe(true);
    });
  }
}

for (const direction of ["back", "forward"] as const) {
  test(`${direction} opening Settings rescues WorkspacePreview`, async ({ page }) => {
    // Sidecar availability and stored Chat/output bytes are fixtures; the actual
    // shell, output chip, second Preview, and browser traversal run together.
    const conversation = {
      id: "output-chat", title: "Output chat",
      messages: [{ id: "answer", role: "assistant", content: "Report ready.",
        outputs: [{ path: "report.md", name: "report.md", bytes: 64 }] }],
    };
    await page.route("http://127.0.0.1:19828/api/v1/health", async (route) => {
      await route.fulfill({ json: { ok: true } });
    });
    await page.route("**/api/chat/conversations**", async (route) => {
      await route.fulfill({ json: route.request().url().endsWith("/output-chat")
        ? { conversation } : { conversations: [conversation] } });
    });
    await page.route("http://127.0.0.1:19828/api/v1/workspace/file?**", async (route) => {
      await route.fulfill({ json: { content: "[Report link](https://example.com/report)" } });
    });
    await shell(page, "chat");
    await settings(page, true);
    if (direction === "back") await settings(page, false);
    else await traverse(page, "back", false);
    await page.getByRole("button", { name: "report.md · 64 B" }).click();
    const link = page.locator("#wb-preview-column").getByRole("link", { name: "Report link" });
    await link.focus();
    await expect(link).toBeFocused();
    await traverse(page, direction, true);
    await expect(page.locator("#wb-canvas")).toBeFocused();
    await expect(link).toBeHidden();
  });
}

for (const [name, selector] of [
  ["rail", "nav.wb-rail button"],
  ["WikiSwitcher", ".wb-wiki-switch-new"],
  ["tree separator", ".wb-split-handle--tree"],
]) {
  test(`closing Back and opening Forward preserve ${name}`, async ({ page }) => {
    await shell(page);
    await settings(page, true);
    const control = page.locator(selector).first();
    await control.focus();
    await expect(control).toBeFocused();
    await traverse(page, "back", false);
    await expect(control).toBeFocused();
    await traverse(page, "forward", true);
    await expect(control).toBeFocused();
  });
}

test("mode-only traversal preserves keyboard position", async ({ page }) => {
  await shell(page);
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  const control = page.getByRole("button", { name: "Graph", exact: true });
  await control.focus();
  await page.goBack();
  await expect(page).toHaveURL(/mode=wiki/);
  await expect(control).toBeFocused();
});

test("Back from SettingsNav gives a restored Create Wiki dialog priority", async ({ page }) => {
  await resetOwnerTenant();
  await page.goto("/?mode=wiki");
  await expect(page.locator(".wb-shell")).toHaveAttribute("data-mounted", "true");
  // Seed history before opening the modal: its backdrop correctly blocks rail clicks.
  await settings(page, true);
  await settings(page, false);
  await page.getByRole("button", { name: "Create Wiki", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create Wiki" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toBeFocused();
  await traverse(page, "back", true);
  await expect(dialog).toBeHidden();
  await expect(page.locator("#wb-canvas")).toBeFocused();
  const category = settingsNav(page).getByRole("button").first();
  await category.focus();
  await expect(category).toBeFocused();
  await traverse(page, "back", false);
  await expect(dialog).toBeVisible();
  await expect(dialog).toBeFocused();
  await expect(page.locator("#wb-canvas")).not.toBeFocused();
});
