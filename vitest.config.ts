import { defineConfig } from "vitest/config";
import { readdirSync } from "fs";
import path from "path";

const DOM_INCLUDE = "src/**/__tests__/**/*.test.tsx";

/**
 * Refuse to run when the "dom" project would collect nothing, or would leave a
 * mounted suite behind.
 *
 * A project whose `include` matches NOTHING does not fail a combined
 * `vitest run`: the run is satisfied by the other project's files and exits 0
 * with the empty project simply absent from the report. So a typo in
 * `DOM_INCLUDE`, or a `.test.tsx` moved out of a `__tests__` directory, would
 * delete every mounted assertion from CI while the report still reads "all
 * passed" — the one failure mode this split introduces, and the one nothing
 * else in the repo can observe. (Run alone, `--project dom` does exit 1 on an
 * empty collection; CI runs `pnpm test`, which does not.)
 *
 * The include is checked by APPLYING it to what is actually on disk, not by
 * restating where the suites are expected to be — either half can drift on its
 * own. Config load is the only place this survives, since a guard living in
 * either project's files vanishes together with them.
 */
function includeMatcher(glob: string): RegExp {
  // Segment by segment, so the two tokens this pattern uses cannot interfere:
  // `**` (any number of directories, including none) and `*` (any run of
  // characters within one segment). A `**` segment carries its own separator,
  // which is what lets it match nothing at all.
  const segments = glob.split("/");
  const source = segments
    .map((segment, index) => {
      if (segment === "**") return "(?:[^/]+/)*";
      const literal = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
      return index === segments.length - 1 ? literal : `${literal}/`;
    })
    .join("");
  return new RegExp(`^${source}$`);
}

const onDisk = readdirSync(path.resolve(__dirname, "./src"), {
  recursive: true,
  encoding: "utf8",
})
  .map((entry) => `src/${entry.split(path.sep).join("/")}`)
  .filter((entry) => entry.endsWith(".test.tsx"));
const domInclude = includeMatcher(DOM_INCLUDE);
const collected = onDisk.filter((file) => domInclude.test(file));

if (collected.length === 0) {
  throw new Error(
    `vitest: "${DOM_INCLUDE}" matches no files, so the "dom" project would ` +
      `collect nothing and a full run would still exit 0 with every mounted ` +
      `assertion silently gone. ` +
      (onDisk.length > 0
        ? `The suites are still on disk (${onDisk.join(", ")}) — the include no ` +
          `longer describes where they live.`
        : `No *.test.tsx file exists under src/ either.`),
  );
}
const missed = onDisk.filter((file) => !collected.includes(file));
if (missed.length > 0) {
  throw new Error(
    `vitest: ${missed.join(", ")} would never run — "${DOM_INCLUDE}" does not ` +
      `match them, and an uncollected suite is indistinguishable from a passing ` +
      `one in the report. Move each file under a __tests__ directory, or widen ` +
      `the include.`,
  );
}

/**
 * Two projects, one `vitest run`.
 *
 * `.github/workflows/ci.yml` runs `pnpm test` and nothing else, so a second
 * config file plus a second script would be a suite nobody runs. Splitting the
 * single config into `test.projects` keeps one invocation and gives the mounted
 * `.test.tsx` suites the jsdom environment they need without moving the 4000+
 * existing `.test.ts` assertions off `environment: "node"`.
 *
 * The alias is restated per project on purpose: a root-level `resolve.alias`
 * does NOT cascade into inline projects.
 */
const alias = { "@": path.resolve(__dirname, "./src") };

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/__tests__/**/*.test.ts"],
          setupFiles: ["./vitest.setup.ts"],
        },
        resolve: { alias },
      },
      {
        test: {
          name: "dom",
          environment: "jsdom",
          // `*.test.ts` deliberately does not match `*.test.tsx`, so the two
          // projects partition the suite rather than overlapping it.
          include: [DOM_INCLUDE],
          setupFiles: ["./vitest.setup.ts", "./vitest.setup.dom.ts"],
        },
        // `src/app/layout.tsx` imports `./globals.css` and
        // `katex/dist/katex.min.css`, so mounting the shell makes vite process
        // CSS — and processing CSS makes it load the repo's ROOT
        // `postcss.config.mjs`, which is Tailwind v4's
        // `{ plugins: ["@tailwindcss/postcss"] }` STRING form. Vite's own
        // postcss loader does not resolve string plugin ids, so the suite dies
        // at collection with `Invalid PostCSS Plugin found at: plugins[0]`
        // rather than failing an assertion. An explicit empty plugin list stops
        // the config file from being looked up at all; the stylesheets still
        // resolve and evaluate to nothing, which is all a jsdom mount can use
        // (there is no layout engine to apply them to — see the fidelity notes
        // in `vitest.setup.dom.ts`). Scoped to the `dom` project so the `node`
        // project, which imports no CSS, is untouched.
        css: { postcss: { plugins: [] } },
        // The repo's tsconfig is `"jsx": "preserve"` (Next transforms it), so
        // JSX inside a test file would otherwise reach esbuild untransformed.
        // This is the whole plugin requirement — no `@vitejs/plugin-react`.
        esbuild: { jsx: "automatic" },
        resolve: { alias },
      },
    ],
  },
});
