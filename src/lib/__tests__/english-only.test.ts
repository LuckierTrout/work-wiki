/**
 * DW-4: the zh-CN localisation is retired. The recorded preference (AGENTS.md)
 * is English-only, and the catalog it replaced keyed on exact English source
 * strings — so every chrome rename silently un-translated a row, while the
 * catalog itself shipped the pre-rename brand as rendered copy.
 *
 * The scan is source-level because there is no browser in this suite: what it
 * pins is that nobody reintroduces the machinery — a catalog module, a locale
 * cookie the layout reads, a picker, or the `data-no-localize` opt-out that only
 * a DOM-rewriting provider would need.
 */
import { describe, expect, it } from "vitest";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const SRC = path.resolve(__dirname, "../..");
const ROOT = path.resolve(SRC, "..");

/**
 * Anything that can carry locale machinery, not just TypeScript: a catalog can
 * come back as plain `.js`, a picker as markup, and the picker's styling as a
 * stylesheet rule the identifier scans never read.
 */
const SCANNED = /\.(?:[cm]?[jt]sx?|css|html)$/;

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...(await walk(full)));
    } else if (SCANNED.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every source that could carry locale machinery, tests excluded.
 *
 * The `src/` walk starts at `SRC` rather than at a list of trees: `middleware.ts`
 * is the conventional home for cookie-based locale negotiation, so an
 * app/components/lib/hooks listing would leave the blind spot exactly where the
 * machinery would come back — and `mcp.ts` / `cli.ts` sit beside it.
 *
 * It also reaches past `src/` for the same reason `brand-copy.test.ts` does: the
 * browser clipper ships its own document and UI, and the workers ship their own
 * copy, so an app-only scan never sees a picker that returns out there.
 */
async function sources(): Promise<string[]> {
  const trees = [SRC, path.join(ROOT, "workers"), path.join(ROOT, "integrations")];
  return (await Promise.all(trees.map((t) => walk(t)))).flat();
}

/**
 * A scan that matches no files passes every assertion below while proving
 * nothing. Every scanning test funnels through here so a relocated tree fails
 * loudly instead of going quietly vacuous — a canary that lived inside a single
 * `it` would leave the other scans unguarded.
 */
async function scannedSources(): Promise<string[]> {
  const scanned = await sources();
  const relative = scanned.map((f) => path.relative(ROOT, f));
  for (const file of [
    "src/app/layout.tsx",
    "src/app/globals.css",
    "src/components/NavHeader.tsx",
    "src/components/workbench/IconRail.tsx",
    "src/middleware.ts",
    "workers/email-ingest/index.ts",
    "integrations/browser-clipper/popup.js",
    "integrations/browser-clipper/popup.html",
  ]) {
    expect(relative).toContain(path.normalize(file));
  }
  // Named files prove the reach; a floor proves the walk did not collapse to
  // just them after a directory filter goes wrong.
  expect(scanned.length).toBeGreaterThan(100);
  return scanned;
}

async function offenders(pattern: RegExp): Promise<string[]> {
  const found: string[] = [];
  for (const file of await scannedSources()) {
    if (pattern.test(await readFile(file, "utf8"))) found.push(path.relative(ROOT, file));
  }
  return found;
}

async function exists(relative: string): Promise<boolean> {
  try {
    await access(path.join(SRC, relative));
    return true;
  } catch {
    return false;
  }
}

describe("the interface is English only", () => {
  it("declares the document language without consulting request state", async () => {
    const layout = await readFile(path.join(SRC, "app/layout.tsx"), "utf8");
    expect(layout).toContain('lang="en"');
    // A fresh visit has no locale to negotiate, so the document language must
    // not vary per request. A constant is fine; a request-derived value is not,
    // which is the property here — not the `lang="..."` spelling.
    const lang = layout.match(/<html[\s\S]*?\slang=(\{[^}]*\}|"[^"]*")/)?.[1];
    expect(lang, "the root layout must set <html lang>").toBeDefined();
    expect(lang).not.toMatch(/cookies|headers|params|navigator|accept-?language|locale/i);
  });

  it("never rewrites the document language at runtime", async () => {
    // The other way the document language could start varying again: a client
    // component assigning it after hydration. The repo's prevailing style
    // aliases the element first (`const root = document.documentElement`), so
    // this bans the assignment itself — in either spelling — not one receiver.
    expect(await offenders(/\.lang\s*=(?!=)|setAttribute\(\s*["'`]lang["'`]/)).toEqual([]);
  });

  it("never reads a locale cookie, so a stale one from the retired picker is inert", async () => {
    // Reading cookies at all is legitimate (auth, theme, flags) — reading one to
    // choose a language is not. So this pins the retired cookie by name, plus
    // any cookie access that shops for a locale nearby, rather than banning
    // `cookies(`. It is anchored to a cookie accessor on purpose: the live
    // workspace output-language preference reads `language` from forms and
    // query strings, and that is not a UI locale.
    expect(
      await offenders(
        /workwiki_locale|INTERFACE_LOCALE_COOKIE|(?:cookies\(\)|cookieStore|\.cookies\b|document\.cookie)[\s\S]{0,80}?(?:locale|lang)/i,
      ),
    ).toEqual([]);
    // The root layout imported `cookies` from next/headers for exactly one
    // reason, and that reason is gone.
    const layout = await readFile(path.join(SRC, "app/layout.tsx"), "utf8");
    expect(layout).not.toMatch(/from\s+["']next\/headers["']/);
  });

  it("ships no translation catalog, provider, picker, or opt-out marker", async () => {
    // `localeCompare` and other unrelated `locale` identifiers are fine; only
    // the retired module's own names are offenders. The module is matched by
    // import path in any style — `@/lib/i18n`, `./i18n`, `../i18n`, and the
    // directory form `@/lib/i18n/catalog` a rebuild would naturally take. The
    // off-the-shelf catalogs are named outright: swapping the hand-rolled module
    // for `next-intl` is the same reintroduction.
    expect(
      await offenders(
        /LocaleProvider|LocaleSwitcher|LocalizedSurface|InterfaceLocale|translateInterface|data-no-localize|["'`][^"'`]*\bi18n(?:[/.][^"'`]*)?["'`]|\b(?:next-intl|i18next|react-intl|@formatjs)\b/,
      ),
    ).toEqual([]);
  });

  it("keeps the retired modules deleted, not merely unreferenced", async () => {
    // An identifier-only scan passes against a recreated file whose internals
    // were renamed, so pin the paths themselves.
    for (const file of ["lib/i18n.ts", "components/LocaleProvider.tsx", "components/LocaleSwitcher.tsx"]) {
      expect(await exists(file), `${file} must stay deleted`).toBe(false);
    }
  });

  it("has no locale picker stylesheet hooks left behind", async () => {
    // Rules for a deleted component are how the picker gets re-styled back into
    // existence with the identifier scan above still green. Scanned everywhere,
    // not just in `globals.css`: a second stylesheet is the obvious home for a
    // rule the app tree no longer carries.
    expect(await offenders(/locale-switcher/)).toEqual([]);
    const css = await readFile(path.join(SRC, "app/globals.css"), "utf8");
    expect(css).not.toContain("locale-switcher");
  });
});
