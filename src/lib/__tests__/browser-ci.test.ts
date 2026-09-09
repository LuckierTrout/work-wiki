/**
 * DW-753: stop CI silently losing browser coverage, baking the test identity
 * into a production build, or discarding the only evidence of a first failure.
 * These inspect executable configuration; the real browser run and deliberate
 * first-attempt failure prove browser composition and local artifact creation.
 * GitHub upload acceptance requires a separately authorized remote run.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import browserConfig from "../../../playwright.config";

// Use the YAML parser already required by our direct @eslint/eslintrc
// dependency. Resolve through its owner so pnpm's isolated layout works;
// neither an undeclared root import nor a new parsing dependency is needed.
const require = createRequire(import.meta.url);
const eslintRequire = createRequire(require.resolve("@eslint/eslintrc"));
const { load } = eslintRequire("js-yaml") as { load: (text: string) => Workflow };

interface Step {
  id?: string;
  run?: string;
  uses?: string;
  if?: string;
  env?: Record<string, unknown>;
  "continue-on-error"?: boolean;
  with?: Record<string, unknown>;
}

interface Workflow {
  env?: Record<string, unknown>;
  jobs: Record<string, {
    name: string;
    "runs-on": string;
    "timeout-minutes": number;
    needs?: unknown;
    if?: string;
    env?: Record<string, unknown>;
    "continue-on-error"?: boolean;
    steps: Step[];
  }>;
}

const root = path.resolve(__dirname, "../../..");
const workflow = load(readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8"));

describe("Browser CI operational contract", () => {
  it("runs the real browser command in an independent job with Chromium installed", () => {
    const job = workflow.jobs.e2e;
    expect(job).toBeDefined();
    expect(job).toMatchObject({
      name: "Browser E2E",
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 30,
    });
    expect(job.needs).toBeUndefined();
    expect(job.if).toBeUndefined();
    expect(job["continue-on-error"]).toBeUndefined();
    const runs = job.steps.filter((step) => step.run).map((step) => step.run);
    expect(runs).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm exec playwright install --with-deps chromium",
      "pnpm test:e2e",
    ]);
    const browserStep = job.steps.find((step) => step.id === "browser_tests");
    expect(browserStep).toMatchObject({
      id: "browser_tests",
      run: "pnpm test:e2e",
    });
    expect(browserStep?.if).toBeUndefined();
    expect(browserStep?.["continue-on-error"]).toBeUndefined();
    expect(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts["test:e2e"])
      .toBe("playwright test");
  });

  it("keeps E2E identity out of workflow commands and all job environments", () => {
    // Covers inline shell assignments as well as env blocks, including the
    // Application build steps. Identity belongs only to Playwright's dev server.
    expect(JSON.stringify(workflow)).not.toMatch(/YOPEDIA_E2E(?:_SECRET)?\b/);
    expect(workflow.env).toBeUndefined();
    expect(workflow.jobs.e2e.env).toBeUndefined();
    for (const step of workflow.jobs.e2e.steps) expect(step.env).toBeUndefined();
  });

  it("uploads only test results after the browser step fails, preserving its failure", () => {
    const steps = workflow.jobs.e2e.steps;
    const uploads = steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(uploads).toHaveLength(1);
    const upload = uploads[0];
    expect(upload.uses).toBe("actions/upload-artifact@v7.0.1");
    expect(upload.if).toBe("${{ failure() && steps.browser_tests.outcome == 'failure' }}");
    expect(upload.with).toEqual({
      name: "browser-e2e-failure-${{ github.run_attempt }}",
      path: "test-results/",
      "retention-days": 7,
      "if-no-files-found": "warn",
    });
    expect(steps.indexOf(upload)).toBeGreaterThan(steps.findIndex((step) => step.id === "browser_tests"));
  });

  it("records the first failure with no retries or extra browser workers", () => {
    expect(browserConfig).toMatchObject({
      fullyParallel: false,
      retries: 0,
      workers: 1,
      reporter: "list",
      use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
    });
    // No projects/browser override: Playwright's default is Chromium.
    expect(browserConfig.projects).toBeUndefined();
    expect(browserConfig.use?.browserName).toBeUndefined();
    // The uploader must follow any future outputDir override; today it uses
    // Playwright's default test-results directory.
    expect(browserConfig.outputDir).toBeUndefined();
  });
});
