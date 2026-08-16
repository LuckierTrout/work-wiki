/**
 * DW-6 retirement pin — the collapsed delete gate, pinned by source scan.
 *
 * Vitest runs `environment: "node"` and only `src/**\/__tests__/**\/*.test.ts`:
 * no jsdom, no testing-library (the create-wiki-ui.test.ts convention). So the
 * gate is pinned as text: with the commons realm branch retired, the client
 * delete gate must stay exactly `isOwner || isSiteOwner` — the effective server
 * outcome in this single-owner deployment — and no commons realm computation
 * may return to ArticleActions or ArticleView.
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

const COMPONENTS = path.resolve(__dirname, "../../components");

function read(component: string): Promise<string> {
  return readFile(path.join(COMPONENTS, component), "utf8");
}

describe("ArticleActions delete gate (commons realm branch retired)", () => {
  it("gates Delete on exactly isOwner || isSiteOwner", async () => {
    const source = await read("ArticleActions.tsx");
    expect(source).toContain("const canDelete = isOwner || isSiteOwner;");
    expect(source).not.toContain("isCommonsPage");
  });

  it("threads no commons realm flag from ArticleView", async () => {
    const view = await read("ArticleView.tsx");
    expect(view).not.toContain("isCommonsPage");
    expect(view).not.toContain("belongsInCommons");
    // Save-to-vault gating survives the retirement untouched.
    expect(view).toContain("isCuratable={isCuratable}");
  });
});
