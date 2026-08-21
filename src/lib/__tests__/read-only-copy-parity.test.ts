/**
 * The read-only sentences, server side against client side (DW-187, DW-188).
 *
 * `READ_ONLY_REFUSAL` in `read-only.ts` owns every sentence a SERVER answers.
 * It cannot own the ones client components render beside a dimmed control:
 * importing it into a `"use client"` module would drag `./config` — the
 * settings/storage/embeddings graph, and `process.env` — into the browser
 * bundle. So each surface carries its own exported constant, and the price of
 * that boundary is that the two halves can drift apart silently: the owner reads
 * one sentence before pressing and a different one in the 403 body afterwards,
 * and nothing fails.
 *
 * This file is the seam. Every client constant is compared against the server
 * sentence it mirrors — CHARACTER-IDENTICAL where the door answers its own
 * refusal, and explicitly recorded where it deliberately does not.
 *
 * Node project (no mount): these are two string constants, and importing the
 * component modules for their exported copy needs no DOM.
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { READ_ONLY_REFUSAL } from "../read-only";
import {
  WIKI_CREATE_READ_ONLY_COPY,
  WIKI_TEMPLATE_READ_ONLY_COPY,
} from "../workbench-tree";
import { DELETE_PAGE_READ_ONLY_COPY } from "@/components/DeletePageButton";
import { REINGEST_READ_ONLY_COPY } from "@/components/ReingestButton";
import { REVERT_READ_ONLY_COPY } from "@/components/RevisionHistory";
import { WORKSPACE_PURPOSE_READ_ONLY_COPY } from "@/components/WorkspacePurposeSettings";
import { BULK_DELETE_READ_ONLY_COPY } from "@/components/RecentIngests";
import { CREATE_PAGE_READ_ONLY_COPY } from "@/app/wiki/new/NewWikiForm";
import { PREVIEW_HISTORY_READ_ONLY_COPY } from "../workbench-preview";

/**
 * A route's own 403 sentence, read out of its source.
 *
 * FIVE route files below spell their refusal INLINE rather than through
 * `READ_ONLY_REFUSAL` — `wikis/route.ts`, `wikis/[id]/template/route.ts`,
 * `wikis/[id]/route.ts` (rename AND delete), `wikis/current/route.ts` and
 * `workspace-profile/route.ts`. They gate at the HTTP layer on `isReadOnly()`
 * instead of reaching a kernel writer, so there is no constant to compare
 * against and a literal restated here would only pin this file to itself.
 * Reading the handler means a reworded route body fails on the next run, which
 * is the whole point.
 *
 * The doors gated LATER (DW-294/DW-300/DW-314) import the constant instead —
 * they had no body to preserve — and are pinned by NAME further down rather
 * than through this helper.
 */
async function routeSource(route: string): Promise<string> {
  return readFile(path.resolve(__dirname, "../../app/api", route), "utf8");
}

/**
 * The sentence as the handler SERVES it, not as the file merely mentions it.
 *
 * A bare `toContain(sentence)` matches anywhere — a comment quoting the old
 * wording, or a dead branch left behind by the rewrite — so a route that
 * reworded its actual response body would still pass while the owner read one
 * sentence before pressing and another in the 403 afterwards. Every handler
 * read through {@link routeSource} answers through
 * `NextResponse.json({ error: "…" }, …)`, so the `error:` key is what gets
 * pinned.
 */
function servedAs(sentence: string): string {
  return `error: ${JSON.stringify(sentence)}`;
}

describe("client refusal copy mirrors the server's", () => {
  it("Delete says exactly what DELETE /api/wiki/[slug] answers", () => {
    expect(DELETE_PAGE_READ_ONLY_COPY).toBe(READ_ONLY_REFUSAL.pageDelete);
  });

  it("Re-ingest says exactly what POST /api/ingest/reingest answers", () => {
    // The drift this file exists for: these two were one word apart ("This page
    // cannot be re-ingested…" vs "Pages cannot be re-ingested…") with every
    // other assertion in the suite green.
    expect(REINGEST_READ_ONLY_COPY).toBe(READ_ONLY_REFUSAL.reingest);
  });

  it("Revert is narrower than the kernel sentence behind it, on purpose", () => {
    // `POST /api/wiki/[slug]/revisions` spells no refusal of its own — it maps
    // the kernel writer's, which covers create, edit, revert and re-ingest
    // alike. "Pages cannot be written…" is true there and useless beside a
    // button labelled Revert, so the surface narrows it. Pinned as a DIFFERENCE
    // rather than left to look like the bug above.
    expect(REVERT_READ_ONLY_COPY).not.toBe(READ_ONLY_REFUSAL.pageWrite);
    expect(REVERT_READ_ONLY_COPY).toContain("reverted");
    // Both still name the deployment state, which is the property that makes
    // either sentence actionable.
    expect(READ_ONLY_REFUSAL.pageWrite).toContain("read-only");
    expect(REVERT_READ_ONLY_COPY).toContain("read-only");
  });

  it("the Preview's Revert is narrower than the artifact sentence behind it, on purpose", () => {
    // DW-214 gave `GET/POST /api/workbench/artifact/revisions` its first client.
    // The POST refuses with `READ_ONLY_REFUSAL.artifactEdit` — "The Schema
    // cannot be edited…" — which is the honest sentence for a door that also
    // carries the editor's save, and a confusing one beside a control labelled
    // Revert over a version the owner did not type. So the panel narrows it, and
    // the difference is recorded here rather than left to look like the
    // re-ingest bug above.
    expect(PREVIEW_HISTORY_READ_ONLY_COPY).not.toBe(READ_ONLY_REFUSAL.artifactEdit);
    expect(PREVIEW_HISTORY_READ_ONLY_COPY).toContain("reverted");
    // Both name the SCHEMA — the narrowing is about the verb, not the subject:
    // a sentence that stopped saying which file it was about would leave the
    // owner guessing which of the column's two surfaces refused.
    expect(READ_ONLY_REFUSAL.artifactEdit).toContain("Schema");
    expect(PREVIEW_HISTORY_READ_ONLY_COPY).toContain("Schema");
    // …and both still name the deployment state, which is the property that
    // makes either sentence actionable.
    expect(READ_ONLY_REFUSAL.artifactEdit).toContain("read-only");
    expect(PREVIEW_HISTORY_READ_ONLY_COPY).toContain("read-only");
    // Narrower than the PAGE revert's sentence too, and distinct from it: the
    // two live on different surfaces refusing different writers, and one string
    // reused for both is how a re-point goes unnoticed.
    expect(PREVIEW_HISTORY_READ_ONLY_COPY).not.toBe(REVERT_READ_ONLY_COPY);
  });

  it("Change template says exactly what POST /api/wikis/[id]/template answers", async () => {
    // The canvas card opened a DESTRUCTIVE confirm onto this 403 (DW-189), so
    // the sentence the owner now reads instead of confirming has to be the one
    // the door would have answered afterwards.
    const route = await routeSource("wikis/[id]/template/route.ts");
    expect(route).toContain(servedAs(WIKI_TEMPLATE_READ_ONLY_COPY));
    // …and not by accident of a substring: the switcher's four-verb sentence
    // does not cover templates, which is why this constant exists at all.
    expect(WIKI_TEMPLATE_READ_ONLY_COPY).not.toBe(WIKI_CREATE_READ_ONLY_COPY);
  });

  it("the canvas's Create Wiki says exactly what POST /api/wikis answers", async () => {
    const route = await routeSource("wikis/route.ts");
    expect(route).toContain(servedAs(WIKI_CREATE_READ_ONLY_COPY));
  });

  it("Workspace Purpose is narrower than the Settings sentence behind it, on purpose", async () => {
    // `PUT /api/workspace-profile` refuses with a sentence about SETTINGS —
    // true of every field that surface owns, and unhelpful beside a form that
    // edits one thing. Recorded as a difference rather than left to look like
    // the re-ingest bug above.
    const route = await routeSource("workspace-profile/route.ts");
    const served = "Settings are read-only in this deployment.";
    expect(route).toContain(servedAs(served));
    expect(WORKSPACE_PURPOSE_READ_ONLY_COPY).not.toBe(served);
    expect(WORKSPACE_PURPOSE_READ_ONLY_COPY).toContain("Workspace Purpose");
    // Both still name the deployment state, which is what makes either
    // sentence actionable.
    expect(served).toContain("read-only");
    expect(WORKSPACE_PURPOSE_READ_ONLY_COPY).toContain("read-only");
  });

  it("the wiki-lifecycle kernel sentences equal the literals their routes serve", async () => {
    // DW-266 gated `createWiki`, `applyScenarioTemplate` and `renameWiki`
    // themselves, so CLI, MCP and library callers inherit the refusal the three
    // routes already answer inline. The routes keep their literals — rewriting
    // those bodies was out of scope — so the constant and the literal are two
    // copies of one sentence, and this is what stops them drifting: reword
    // either side and the next run is red.
    expect(await routeSource("wikis/route.ts")).toContain(
      servedAs(READ_ONLY_REFUSAL.wikiCreate),
    );
    expect(await routeSource("wikis/[id]/template/route.ts")).toContain(
      servedAs(READ_ONLY_REFUSAL.wikiTemplate),
    );
    expect(await routeSource("wikis/[id]/route.ts")).toContain(
      servedAs(READ_ONLY_REFUSAL.wikiRename),
    );
    // And through the SAME sentences, the client constants beside the dimmed
    // canvas controls: three copies, one wording, one test.
    expect(READ_ONLY_REFUSAL.wikiCreate).toBe(WIKI_CREATE_READ_ONLY_COPY);
    expect(READ_ONLY_REFUSAL.wikiTemplate).toBe(WIKI_TEMPLATE_READ_ONLY_COPY);
  });

  it("the Settings route and the kernel behind it answer DIFFERENT sentences", async () => {
    // `wikiFileWrite` covers the two unlocked byte putters under
    // `tenants/<t>/wikis/<id>/` and `saveWorkspaceProfile`. Unlike the three
    // wiki-lifecycle keys above it deliberately does NOT mirror its route:
    // `PUT /api/workspace-profile` gates first with a sentence about SETTINGS —
    // narrower, and the only one an HTTP caller ever reads — while a direct
    // library caller reaching `saveWorkspaceProfile` gets the kernel's. Two
    // sentences for one door, recorded as a difference so it does not look like
    // the re-ingest bug above.
    const route = await routeSource("workspace-profile/route.ts");
    const served = "Settings are read-only in this deployment.";
    expect(route).toContain(servedAs(served));
    expect(READ_ONLY_REFUSAL.wikiFileWrite).not.toBe(served);
    // And the kernel's is the WIDER of the two: it names the file, because the
    // putters behind it are reached by create, re-template and rename alike.
    expect(READ_ONLY_REFUSAL.wikiFileWrite).toContain("Wiki files");
    // Both still name the deployment state, which is what makes either
    // sentence actionable.
    expect(served).toContain("read-only");
    expect(READ_ONLY_REFUSAL.wikiFileWrite).toContain("read-only");
  });

  it("the bulk delete says exactly what DELETE /api/ingest/history answers", () => {
    // DW-265. The control opened a `window.confirm` promising an irreversible
    // delete in front of that 403, so the sentence the owner now reads INSTEAD
    // of confirming has to be the one the door would have answered afterwards.
    expect(BULK_DELETE_READ_ONLY_COPY).toBe(READ_ONLY_REFUSAL.bulkPageDelete);
  });

  it("Create page is narrower than the kernel sentence behind it, on purpose", () => {
    // DW-264's sibling case to Revert: `POST /api/wiki` spells no
    // refusal of its own — it maps the kernel writer's, which covers create,
    // edit, revert and re-ingest alike. "Pages cannot be written…" beside a
    // button labelled Create page is true and useless, so the form narrows it.
    // Pinned as a DIFFERENCE rather than left to look like the re-ingest bug
    // above.
    expect(CREATE_PAGE_READ_ONLY_COPY).not.toBe(READ_ONLY_REFUSAL.pageWrite);
    expect(CREATE_PAGE_READ_ONLY_COPY).toContain("created");
    // Distinct from the OTHER narrowing of the same kernel sentence: two
    // surfaces refusing two verbs, and one string reused for both is how a
    // re-point goes unnoticed.
    expect(CREATE_PAGE_READ_ONLY_COPY).not.toBe(REVERT_READ_ONLY_COPY);
    // Both still name the deployment state, which is what makes either
    // sentence actionable.
    expect(READ_ONLY_REFUSAL.pageWrite).toContain("read-only");
    expect(CREATE_PAGE_READ_ONLY_COPY).toContain("read-only");
  });

  it("the wiki delete/switch kernel sentences equal the literals their routes serve", async () => {
    // DW-314 gated `deleteWiki` and `setCurrentWiki` themselves, so CLI, MCP
    // and library callers inherit the refusal the two routes already answer
    // inline. The routes keep their literals — rewriting those bodies was out
    // of scope — so the constant and the literal are two copies of one
    // sentence, and this is what stops them drifting.
    expect(await routeSource("wikis/[id]/route.ts")).toContain(
      servedAs(READ_ONLY_REFUSAL.wikiDelete),
    );
    expect(await routeSource("wikis/current/route.ts")).toContain(
      servedAs(READ_ONLY_REFUSAL.wikiSwitch),
    );
  });

  it("the orphan sweep's sentence mirrors no route, and says so", async () => {
    // The one wiki-lifecycle key with nothing to mirror.
    // `sweepOrphanWikiDirectories` is reached from `deleteWiki` and from
    // `POST /api/tasks/scan`, and neither spells a sentence about it — the scan
    // answers its OWN refusal before the sweep is ever called. Asserted rather
    // than merely stated in a comment, so a future route that starts serving
    // this sentence inline has to come back and decide which side owns it.
    const scan = await routeSource("tasks/scan/route.ts");
    // The scan is one of the new doors, so it serves the CONSTANT rather than a
    // literal — pinned by name for that reason.
    expect(scan).toContain("error: READ_ONLY_REFUSAL.maintenanceScan");
    expect(scan).not.toContain("READ_ONLY_REFUSAL.wikiDirectorySweep");
    expect(scan).not.toContain(servedAs(READ_ONLY_REFUSAL.wikiDirectorySweep));
    // And it is about DIRECTORIES, not about deleting a Wiki — an owner reading
    // "Wikis cannot be deleted…" beside a scheduled GC pass would go looking
    // for a delete nobody asked for.
    expect(READ_ONLY_REFUSAL.wikiDirectorySweep).not.toBe(
      READ_ONLY_REFUSAL.wikiDelete,
    );
    expect(READ_ONLY_REFUSAL.wikiDirectorySweep).toContain("wiki directories");
  });

  it("the newly gated doors serve their own constant, not a literal", async () => {
    // DW-294/DW-300/DW-314 — five route files, four sentences (the two
    // Names & Terms handlers share one). These had NO refusal at all, so unlike
    // the wiki-lifecycle routes there was no body to preserve — each imports
    // the constant directly, which is the shape every new door should take. Pinned
    // by NAME (`READ_ONLY_REFUSAL.x`) rather than by value, because a literal
    // reappearing in one of these handlers is exactly the regression the
    // one-owner rule exists to prevent.
    for (const [route, key] of [
      ["research/route.ts", "researchCreate"],
      ["names-terms/route.ts", "namesTerms"],
      ["names-terms/[id]/route.ts", "namesTerms"],
      ["email/settings/route.ts", "emailSettings"],
      ["tasks/scan/route.ts", "maintenanceScan"],
    ] as const) {
      const source = await routeSource(route);
      expect(source, route).toContain(`error: READ_ONLY_REFUSAL.${key}`);
      // …and never as a re-typed string beside it.
      expect(source, route).not.toContain(servedAs(READ_ONLY_REFUSAL[key]));
    }
  });

  it("every server sentence names read-only and reads as a sentence", () => {
    // "Forbidden" alone would leave the owner hunting a permission they do not
    // lack, which is the whole reason these are owned in one place.
    for (const [key, sentence] of Object.entries(READ_ONLY_REFUSAL)) {
      expect(sentence, key).toContain("read-only");
      expect(sentence, key).toMatch(/^[A-Z].*\.$/);
      expect(sentence, key).toContain("while this deployment is read-only.");
    }
  });

  it("no two server sentences are the same string", () => {
    // One owner per sentence is only meaningful if the sentences are distinct —
    // two identical values would mean a door is borrowing another's wording and
    // could be re-pointed without any test noticing.
    const values = Object.values(READ_ONLY_REFUSAL);
    expect(new Set(values).size).toBe(values.length);
  });
});
