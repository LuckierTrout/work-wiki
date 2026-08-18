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

/**
 * DW-37/DW-149 — the read-only seam down to Delete.
 *
 * `DELETE /api/wiki/[slug]` now answers 403 on a read-only deployment, and this
 * button's first act is `window.confirm("Delete this page? This cannot be
 * undone.")`. The mounted behaviour lives in
 * `src/components/__tests__/page-write-read-only.test.tsx`; what a mounted test
 * CANNOT see is the seam that carries the fact, because it hands the prop in
 * itself. Three JSX attributes across two server hops, any one of which could be
 * deleted with every mounted assertion still green and the owner back to
 * confirming a delete the deployment will refuse.
 */
describe("the read-only fact reaches the Delete button (DW-37, DW-149)", () => {
  it("is read on the server and threaded down, never fetched", async () => {
    const page = await readFile(
      path.resolve(__dirname, "../../app/u/[handle]/[slug]/page.tsx"),
      "utf8",
    );
    // A server component, so the env fact is read where it already lives.
    expect(page).toContain('import { isReadOnly } from "@/lib/config";');
    expect(page).toContain("readOnly={isReadOnly()}");

    // Anchored to the ELEMENT, not to the attribute: a bare
    // `toContain("readOnly={readOnly}")` would keep passing the moment any
    // other element in this file grows the same attribute, and the hop this
    // pins could then be deleted with the suite still green.
    const view = await read("ArticleView.tsx");
    expect(view).toMatch(/<ArticleActions\b[^>]*\breadOnly=\{readOnly\}/s);

    const actions = await read("ArticleActions.tsx");
    expect(actions).toContain("<DeletePageButton slug={slug} readOnly={readOnly} />");
    // The action bar is a client island and must not learn this any other way:
    // one seam, not a second source of truth that could disagree with it.
    expect(actions).not.toContain("isReadOnly");
  });

  it("dims nothing this change did not gate", async () => {
    // Reingest, Graphify and Save to vault write through routes DW-37 left
    // ungated, so they must keep working on a read-only deployment. Dimming
    // them on a guess would be a refusal the server never answers — the mirror
    // of the bug being fixed.
    const actions = await read("ArticleActions.tsx");
    expect(actions).toContain("<ReingestButton");
    expect(actions).toContain("<SaveToVaultButton slug={slug} />");
    expect(actions.match(/readOnly=\{readOnly\}/g) ?? []).toHaveLength(1);
    expect(actions).not.toMatch(/aria-disabled/);
  });
});
