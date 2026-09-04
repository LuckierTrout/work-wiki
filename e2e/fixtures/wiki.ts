import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { E2E_OWNER_HANDLE } from "../env";
import { expect } from "./owner";

/**
 * Seeding every authenticated spec shares.
 *
 * These helpers were private to `workbench-owner.spec.ts` until a second spec
 * needed the same wiki on disk. One definition serves both, instead of the
 * copy-and-drift this repo keeps filing against duplicated harnesses.
 *
 * THE FILENAME is what keeps this a module rather than a suite.
 * `playwright.config.ts` sets no `testMatch`, so the default applies and it
 * collects `*.test.ts` as well as `*.spec.ts` — a fixture named
 * `wiki.test.ts` would be picked up and run as a suite with no test in it.
 * Directory placement does not save it; the name does.
 */

/** The whole harness store — `DATA_DIR`, and the tree `webServer` wipes at boot. */
export const E2E_DATA_DIR = path.join(process.cwd(), "e2e/.data");

/** Where the harness owner's tenant lands under `DATA_DIR=e2e/.data`. */
export const E2E_TENANT_DIR = path.join(
  E2E_DATA_DIR,
  "tenants",
  E2E_OWNER_HANDLE,
);

/**
 * Put the harness store back the way `webServer` starts it — an empty tree.
 *
 * THE WHOLE `e2e/.data`, not just the tenant, because the tenant directory is
 * not where all of it lives: `playwright.config.ts` also pins
 * `WIKI_DIR=e2e/.data/wiki` and `RAW_DIR=e2e/.data/raw` beside it, and the store
 * writes `.indexes/`, `derived-indexes/`, `.storage-locks/` and a `.revisions/`
 * subtree of its own. Deleting the tenant alone leaves `.indexes/` naming slugs
 * whose files are gone — a half-reset that reads as corruption rather than as a
 * fresh start. This is exactly the `rm -rf e2e/.data` the webServer command
 * runs, and it is the one definition of "clean" the harness has.
 *
 * WHY A SPEC CALLS IT: one worker shares one store across every file, and the
 * config wipes it once, before the server boots. So a file whose cases require
 * an empty tenant establishes that itself in `beforeAll`, and a file that mints
 * wikis hands the store back in `afterAll`. Neither rests on which file
 * Playwright happens to run first.
 *
 * `maxRetries` because the server under test is live and holds locks under
 * `.storage-locks/`: a directory being written while this runs answers
 * ENOTEMPTY/EBUSY, and a hook that throws would fail a suite over harness
 * bookkeeping rather than over anything the spec claims.
 */
export async function resetOwnerTenant(): Promise<void> {
  await fs.rm(E2E_DATA_DIR, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

export async function readE2ePage(slug: string): Promise<string> {
  return fs.readFile(path.join(E2E_TENANT_DIR, "wiki", `${slug}.md`), "utf8");
}

export async function readE2ePageOrEmpty(slug: string): Promise<string> {
  try {
    return await readE2ePage(slug);
  } catch {
    return "";
  }
}

export async function createOwnWiki(page: Page, name: string): Promise<string> {
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

export async function currentWikiId(page: Page): Promise<string> {
  const response = await page.request.get("/api/wikis");
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { currentId?: string | null };
  expect(body.currentId, "a current Wiki is required").toBeTruthy();
  return body.currentId as string;
}

/**
 * Module-private on purpose: it is the 409 branch of `seedWikiPages` and means
 * nothing on its own — a caller reaching for it directly would be writing a
 * page without first asking whether the page is already there.
 */
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

export async function seedWikiPages(
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
