/**
 * Story 1.1, AC3 (the half that is in scope here): opening the app on a phone
 * or a second Clerk browser must present the SAME information architecture as
 * the desktop — one nav, one route tree, no device-specific surface. The
 * sidecar-dependent half (Chat / extract / MCP / shell announcing themselves as
 * unavailable) is Story 3.1's cloud `503 sidecar_required` contract and is
 * deliberately not asserted here.
 *
 * The scan is source-level because there is no browser in this suite: what it
 * really pins is that nobody reintroduces a parallel mobile IA — a second dock,
 * a `/m/` route tree, or a user-agent branch that swaps the navigation.
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { walkFiles } from "./source-scan";

const SRC = path.resolve(__dirname, "../..");

/**
 * `__tests__` is skipped by `walkFiles` itself, so a scan cannot read its own
 * assertion text and fail on it.
 */
const SOURCE_FILE = /\.tsx?$/;

/**
 * Every app and component source, with the walk's reach asserted on the way
 * past.
 *
 * Both scans below assert only that an offender list is EMPTY, which an
 * emptier corpus satisfies by construction — so a walk that quietly stopped
 * reaching one of these trees would turn the whole file green rather than red.
 * Since DW-117 the traversal is shared, so a single name appended to
 * `SKIPPED_DIRS` could do that to every scanning suite at once. Named files
 * prove each tree is reached; the floor proves the walk did not collapse to
 * just them.
 */
async function appAndComponentSources(): Promise<string[]> {
  const files = [
    ...(await walkFiles(path.join(SRC, "app"), { include: SOURCE_FILE })),
    ...(await walkFiles(path.join(SRC, "components"), { include: SOURCE_FILE })),
  ];
  const relative = files.map((f) => path.relative(SRC, f));
  for (const file of [
    // The root layout is where a UA branch or a second nav would be wired in;
    // `NavHeader` is the nav this file says there is only one of.
    path.join("app", "layout.tsx"),
    path.join("components", "NavHeader.tsx"),
  ]) {
    expect(
      relative,
      `appAndComponentSources() no longer reaches ${file} — the scans below ` +
        `would report no offenders because they read almost nothing.`,
    ).toContain(file);
  }
  // ~320 files today; 150 leaves room to delete a tree legitimately without
  // making this a second thing to update on every commit.
  expect(
    files.length,
    "appAndComponentSources() collapsed — a tree dropped out of the walk",
  ).toBeGreaterThan(150);
  return files;
}

describe("one information architecture on every device", () => {
  it("ships no device-specific navigation surface", async () => {
    // The mobile dock was the one alternate IA; it is retired with the commons
    // routes it linked to. Responsive CSS is fine — a second nav is not.
    const offenders: string[] = [];
    for (const file of await appAndComponentSources()) {
      const text = await readFile(file, "utf8");
      if (/MobileNavigationDock|mobile-navigation-dock/.test(text)) {
        offenders.push(path.relative(SRC, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("has no mobile-only stylesheet hooks left behind", async () => {
    const css = await readFile(path.join(SRC, "app/globals.css"), "utf8");
    expect(css).not.toContain("mobile-navigation");
  });

  it("never branches the layout on a user agent", async () => {
    // A UA sniff is how an alternate IA creeps back in; width-based CSS is not.
    const offenders: string[] = [];
    for (const file of await appAndComponentSources()) {
      const text = await readFile(file, "utf8");
      if (/navigator\.userAgent|user-agent["']\s*\)|isMobileDevice/i.test(text)) {
        offenders.push(path.relative(SRC, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the non-sidecar surfaces on the shared route tree", async () => {
    // Trees, Preview, and search work in any Clerk-authenticated browser, so
    // they must be ordinary routes — not gated behind a desktop-only shell.
    for (const route of ["knowledge", "query", "wiki/new"]) {
      const page = path.join(SRC, "app", route, "page.tsx");
      await expect(readFile(page, "utf8")).resolves.toBeTruthy();
    }
  });
});
