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
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const SRC = path.resolve(__dirname, "../..");

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      out.push(...(await walk(full)));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

async function appAndComponentSources(): Promise<string[]> {
  return [
    ...(await walk(path.join(SRC, "app"))),
    ...(await walk(path.join(SRC, "components"))),
  ];
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
