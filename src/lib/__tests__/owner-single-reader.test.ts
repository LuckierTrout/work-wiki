/**
 * DW-157 — `getOwnerHandle()` is the ONE production reader of
 * `NEXT_PUBLIC_OWNER_HANDLE`.
 *
 * The value of that invariant is entirely a grep property: a reviewer asking
 * "who resolves the site owner?" greps for `getOwnerHandle` and expects the
 * answer to be complete. Two inline `process.env.NEXT_PUBLIC_OWNER_HANDLE`
 * reads (the scan route's backup scheduler and `e2eOwnerHandle()`) used to make
 * it incomplete, and nothing in the suite noticed — the acceptance criterion was
 * a manual grep run outside the tests, so the next inline read added anywhere in
 * `src/` would regress this silently.
 *
 * This is that grep, mechanized. It scans SOURCE rather than behavior on
 * purpose: the property under pin is about where the string appears, which no
 * runtime assertion can observe.
 *
 * Scope note: test files are deliberately excluded. They configure the env var
 * directly — that is how a suite arms an owner — and holding them to the
 * production rule would forbid the fixtures every owner-gated test needs.
 */
import { describe, expect, it } from "vitest";
import fs from "fs/promises";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SRC_ROOT = path.join(REPO_ROOT, "src");

/** The single file allowed to read the env var directly. */
const ALLOWED = ["src/lib/owner.ts"];

/**
 * Strip line comments and block comments.
 *
 * Deliberately naive — it does not model strings, template literals or regex
 * literals, so a `//` inside a string (a URL, say) truncates the rest of that
 * line. That biases toward removing text, which can only ever make this pin
 * MISS a read, never invent one: a false pass is possible in a contrived case,
 * a false failure is not. Worth it to keep a commented-out example or a doc
 * comment naming the variable — of which this repo has several — from tripping
 * an invariant about actual reads.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

/** Every `.ts`/`.tsx` file under `src/`, excluding tests. */
async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      found.push(...(await sourceFiles(full)));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    found.push(full);
  }
  return found;
}

describe("NEXT_PUBLIC_OWNER_HANDLE has exactly one production reader", () => {
  it("is read only by src/lib/owner.ts", async () => {
    const files = await sourceFiles(SRC_ROOT);
    // Non-vacuity: a walk that found nothing would pass the emptiness check
    // below against an empty allowlist mismatch, or worse, silently shrink.
    expect(files.length).toBeGreaterThan(100);

    const readers: string[] = [];
    for (const file of files) {
      const code = stripComments(await fs.readFile(file, "utf8"));
      // Both addressing forms. A computed `process.env[someVariable]` cannot be
      // caught by any source scan; that is the known hole, and routing such a
      // read through `getOwnerHandle()` is the rule this pin is asking for.
      if (
        /process\.env\.NEXT_PUBLIC_OWNER_HANDLE\b/.test(code) ||
        /process\.env\[\s*["'`]NEXT_PUBLIC_OWNER_HANDLE["'`]\s*\]/.test(code)
      ) {
        readers.push(path.relative(REPO_ROOT, file).split(path.sep).join("/"));
      }
    }

    expect(
      readers.sort(),
      `DW-157: \`getOwnerHandle()\` in src/lib/owner.ts must be the only ` +
        `production reader of NEXT_PUBLIC_OWNER_HANDLE, so that grepping for ` +
        `\`getOwnerHandle\` finds every site-owner resolution. Route the new ` +
        `read(s) in ${readers.filter((f) => !ALLOWED.includes(f)).join(", ")} ` +
        `through \`getOwnerHandle()\` instead — it already trims and treats ` +
        `blank as "no owner configured".`,
    ).toEqual(ALLOWED);
  });
});
