import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { GRAPH_NARROW_COPY } from "../src/lib/workbench-modes";
import { E2E_OWNER_HANDLE } from "./env";
import { expect, test, unsignedTest } from "./fixtures/owner";

const E2E_TENANT_DIR = path.join(
  process.cwd(),
  "e2e/.data/tenants",
  E2E_OWNER_HANDLE,
);

async function readE2ePage(slug: string): Promise<string> {
  return fs.readFile(path.join(E2E_TENANT_DIR, "wiki", `${slug}.md`), "utf8");
}

async function readE2ePageOrEmpty(slug: string): Promise<string> {
  try {
    return await readE2ePage(slug);
  } catch {
    return "";
  }
}

async function createOwnWiki(page: Page, name: string): Promise<string> {
  await page.goto("/");
  const response = await page.request.post("/api/wikis", {
    data: { name, scenario: "general" },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { wiki?: { id?: string } };
  const wikiId = body.wiki?.id;
  expect(wikiId, "createOwnWiki must return a wiki id").toBeTruthy();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Wiki", exact: true })).toBeVisible();
  await expect(page.locator("#wb-canvas").getByText("No wiki yet.")).toHaveCount(0);
  return wikiId as string;
}

async function currentWikiId(page: Page): Promise<string> {
  const response = await page.request.get("/api/wikis");
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { currentId?: string | null };
  expect(body.currentId, "a current Wiki is required").toBeTruthy();
  return body.currentId as string;
}

async function replaceWikiPage(
  page: Page,
  slug: string,
  content: string,
) {
  const preview = await page.request.get(
    `/api/workbench/preview?kind=page&slug=${encodeURIComponent(slug)}`,
  );
  expect(preview.ok()).toBeTruthy();
  const payload = (await preview.json()) as { body?: string; version?: string };
  if (typeof payload.body === "string" && payload.body.includes(content)) {
    return;
  }
  expect(payload.version, `preview version for ${slug}`).toBeTruthy();
  const put = await page.request.put(`/api/wiki/${encodeURIComponent(slug)}`, {
    headers: { "If-Match": `"${payload.version}"` },
    data: { content },
  });
  expect(put.ok(), `PUT /api/wiki/${slug} ${put.status()}`).toBeTruthy();
}

async function seedWikiPages(
  page: Page,
  pages: Array<{ slug: string; content: string }>,
) {
  for (const entry of pages) {
    const response = await page.request.post("/api/wiki", {
      data: { slug: entry.slug, content: entry.content },
    });
    expect([201, 409]).toContain(response.status());
    if (response.status() === 409) {
      await replaceWikiPage(page, entry.slug, entry.content);
    }
    await expect
      .poll(() => readE2ePageOrEmpty(entry.slug))
      .toContain(entry.content);
  }
}

async function seedReviewQueue(
  page: Page,
  items: Array<Record<string, unknown>>,
) {
  const wikiId = await currentWikiId(page);
  const now = new Date().toISOString();
  await fs.mkdir(E2E_TENANT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(E2E_TENANT_DIR, "review-queue.json"),
    JSON.stringify({
      items: items.map((item) => ({
        createdAt: now,
        updatedAt: now,
        wikiId,
        ...item,
      })),
    }),
  );
}

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

  test("Chat and Search rails expose their canvases", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Chat", exact: true })).toBeVisible();
    await expect(
      page
        .getByText("Start the local sidecar on 127.0.0.1:19828 to use Chat.")
        .or(page.getByRole("button", { name: "New Chat" })),
    ).toBeVisible();

    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Search", exact: true })).toBeVisible();
    await expect(page.getByPlaceholder("Press Enter to search.")).toBeVisible();
    await page.getByPlaceholder("Press Enter to search.").fill("alpha");
    await page.getByPlaceholder("Press Enter to search.").press("Enter");
    await expect(
      page.getByText("No matching Pages or Sources.").or(page.getByText("Searching…")),
    ).toBeVisible();
  });

  test("signed-in Graph, Lint, Review, and Research journeys open after a wiki exists", async ({
    page,
  }) => {
    await createOwnWiki(page, `E2E rails ${Date.now()}`);
    await expect(page.getByRole("heading", { name: "Wiki", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Graph", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Graph", exact: true })).toBeVisible();
    await expect(page.locator(".wb-graph")).toContainText("No graph yet. Ingest sources to build one.");

    await page.getByRole("button", { name: "Lint", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Lint", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Run lint" })).toBeVisible();
    await page.getByRole("button", { name: "Run lint" }).click();
    await expect(page.getByText("Run lint to check wiki health.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Run lint" })).toBeEnabled();

    await page.getByRole("button", { name: "Review", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
    await expect(page.getByText("No pending cards.")).toBeVisible();

    await page.getByRole("button", { name: "Deep Research", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Deep Research", exact: true })).toBeVisible();
    await expect(page.getByText("No research tasks yet.")).toBeVisible();
  });

  test("the Files tab is reachable after sign-in", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("tab", { name: "Files" }).click();
    await expect(page.getByRole("tab", { name: "Files" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  test("non-empty Graph chrome, reduced-motion Fit, narrow layout, and Research handoff", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await createOwnWiki(page, `E2E graph ${Date.now()}`);
    await seedWikiPages(page, [
      { slug: "hub", content: "# Hub\n\nSee [[spoke]]." },
      { slug: "spoke", content: "# Spoke\n\nLinked from hub." },
      { slug: "alone", content: "# Alone\n\nNo inbound links." },
    ]);
    await page.goto("/");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Graph", exact: true }).click();
    await expect(page.getByRole("button", { name: "Fit" })).toBeVisible({ timeout: 20_000 });
    await page.setViewportSize({ width: 800, height: 900 });
    await expect(page.getByText(GRAPH_NARROW_COPY)).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(page.getByText(GRAPH_NARROW_COPY)).toBeHidden();
    await expect(page.locator(".wb-graph-canvas")).toBeVisible();
    await expect(page.getByRole("button", { name: "Graph", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Zoom in" }).click();
    await page.getByRole("button", { name: "Zoom out" }).click();
    await page.getByRole("button", { name: "Fit" }).click();
    await page.locator(".wb-graph-canvas").hover();
    await page.locator(".wb-graph-canvas").click();
    const insights = page.locator(".wb-graph-insights");
    if (!(await insights.isVisible())) {
      await page.getByRole("button", { name: "Insights" }).click();
    }
    await expect(insights).toBeVisible();
    const insight = insights.locator(".wb-graph-insight-hit").first();
    await expect(insight).toBeVisible();
    await insight.click();
    await expect(insight).toHaveAttribute("aria-pressed", "true");
    await insights.getByRole("button", { name: "Deep Research" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Deep Research" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByRole("heading", { name: "Deep Research", exact: true })).toBeVisible({
      timeout: 15_000,
    });
    const research = page.locator(".wb-research");
    await expect(research.locator(".wb-todos-card")).toBeVisible();
    await expect(
      research.getByText("Draft — web search has not started."),
    ).toBeVisible();
  });

  test("Lint auto-fix and Review Create Page / Skip in the signed-in browser", async ({
    page,
  }) => {
    await createOwnWiki(page, `E2E lint ${Date.now()}`);
    await seedWikiPages(page, [
      { slug: "linker", content: "# Linker\n\nSee [[gone]] and keep [[stay]]." },
      { slug: "stay", content: "# Stay\n\nA valid link target." },
    ]);
    await page.goto("/");
    await page.getByRole("button", { name: "Lint", exact: true }).click();
    await page.getByRole("button", { name: "Run lint" }).click();
    const autoFix = page.getByRole("button", { name: "Auto-fix" }).first();
    await expect(autoFix).toBeVisible({ timeout: 15_000 });
    await autoFix.click();
    await expect(autoFix).toBeHidden({ timeout: 15_000 });
    await expect.poll(() => readE2ePage("linker")).not.toContain("[[gone]]");
    await expect.poll(() => readE2ePage("linker")).toContain("[[stay]]");

    await seedReviewQueue(page, [
      {
        id: "e2e-review-1",
        kind: "warning",
        title: "E2E judgment",
        summary: "Seeded for browser coverage.",
        path: "wiki/topic.md",
        queries: ["What should we keep?"],
        status: "pending",
        sourcePath: "wiki/topic.md",
      },
    ]);
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await expect(page.getByText("E2E judgment")).toBeVisible();
    await page.getByRole("button", { name: "Skip" }).click();
    await expect(page.getByText("E2E judgment")).toHaveCount(0);
    await page.getByRole("button", { name: "Wiki", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await expect(page.getByText("E2E judgment")).toHaveCount(0);

    await seedReviewQueue(page, [
      {
        id: "e2e-review-2",
        kind: "warning",
        title: "E2E create page",
        summary: "Create this page.",
        path: "wiki/topic.md",
        queries: [],
        status: "pending",
        sourcePath: "wiki/topic.md",
      },
    ]);
    await page.getByRole("button", { name: "Wiki", exact: true }).click();
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await expect(page.getByText("E2E create page")).toBeVisible();
    await page.getByRole("button", { name: "Create Page" }).click();
    await expect(page.getByText("E2E create page")).toHaveCount(0, { timeout: 20_000 });
    await expect
      .poll(() => readE2ePageOrEmpty("e2e-create-page"))
      .toContain("# E2E create page");
  });
});

unsignedTest.describe("signed-out boundary", () => {
  unsignedTest.use({ storageState: { cookies: [], origins: [] } });

  unsignedTest("sends a browser with no session to sign-in", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/sign-in/);
  });
});
