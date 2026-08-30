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
import { NAMES_TERMS_READ_ONLY_COPY } from "@/components/NamesTermsSettings";
import { EMAIL_INGEST_READ_ONLY_COPY } from "@/components/EmailIngestSettings";
import { EMBEDDING_REBUILD_READ_ONLY_COPY } from "@/components/EmbeddingSettings";
import {
  RESEARCH_COLLECT_READ_ONLY_COPY,
  RESEARCH_CREATE_READ_ONLY_COPY,
  RESEARCH_MUTATE_READ_ONLY_COPY,
} from "@/components/KnowledgeStudio";
import { SETTINGS_READ_ONLY_COPY } from "../workbench-settings";

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
    //
    // OF THE AT-ARRIVAL GATE, precisely (DW-319). A flag that flips MID-request
    // is answered by the route's backstop with the kernel's own
    // `wikiFileWrite`, so this is not the only sentence the door can serve —
    // see "the Settings route and the kernel behind it answer DIFFERENT
    // sentences" below. What is asserted here is unaffected: the gate's literal
    // is still narrower than the client constant beside the form.
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
    // narrower, and the one an HTTP caller reads on a deployment that was
    // already read-only when the request arrived — while a direct library caller
    // reaching `saveWorkspaceProfile` gets the kernel's. Two sentences for one
    // door, recorded as a difference so it does not look like the re-ingest bug
    // above.
    //
    // NOT "the only one an HTTP caller ever reads" any more (DW-319). The route
    // now carries the `isReadOnlyError` backstop on its write, so a flag that
    // flips MID-REQUEST — writable at the gate, refused by the kernel — answers
    // 403 with `wikiFileWrite` verbatim. Which sentence a caller meets tells
    // them WHEN the deployment turned read-only; that is the point of carrying
    // the kernel's own rather than re-serving the route's literal.
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
      ["todos/route.ts", "todos"],
      ["todos/[id]/route.ts", "todos"],
      ["sources/meeting/route.ts", "sourceMeeting"],
      // DW-387 — the two `/settings` doors. Unlike the rest of this list they
      // DID have a body to preserve; the literals were moved under
      // `READ_ONLY_REFUSAL` rather than duplicated, because unlike the
      // wiki-lifecycle routes nothing else in the repo depended on their exact
      // wording. `PUT /api/workspace-profile` is NOT here: it is a different
      // door, keeps its own literal, and is pinned by value above.
      ["settings/route.ts", "settingsSave"],
      ["settings/rebuild-embeddings/route.ts", "embeddingRebuild"],
    ] as const) {
      const source = await routeSource(route);
      expect(source, route).toContain(`error: READ_ONLY_REFUSAL.${key}`);
      // …and never as a re-typed string beside it.
      expect(source, route).not.toContain(servedAs(READ_ONLY_REFUSAL[key]));
    }
  });

  it("Names & Terms says exactly what its three doors answer", () => {
    // DW-386. The surface composed a write in front of a door that had answered
    // 403 since DW-294 and carried no `readOnly` term at all: submit and Remove
    // looked live, and Remove opened an irreversible-sounding `window.confirm`
    // onto the refusal. One sentence for `POST /api/names-terms` and
    // `PUT`/`DELETE /api/names-terms/[id]` alike, because the server owns one.
    expect(NAMES_TERMS_READ_ONLY_COPY).toBe(READ_ONLY_REFUSAL.namesTerms);
  });

  it("Email ingestion says exactly what PUT /api/email/settings answers", () => {
    // DW-386's sibling. Not narrowed: the server sentence already names exactly
    // what this form edits, so there is nothing a narrower one could add.
    expect(EMAIL_INGEST_READ_ONLY_COPY).toBe(READ_ONLY_REFUSAL.emailSettings);
  });

  it("the Research desk says exactly what its THREE doors answer", () => {
    // DW-386. Create, Run/Cancel/Delete and Collect meet three different doors,
    // so the desk states three sentences rather than one — and Collect's is not
    // a research sentence at all: it pushes the brief's URLs into the ordinary
    // ingest pipeline, and `POST /api/ingest/batch` is what answers.
    expect(RESEARCH_CREATE_READ_ONLY_COPY).toBe(READ_ONLY_REFUSAL.researchCreate);
    expect(RESEARCH_MUTATE_READ_ONLY_COPY).toBe(READ_ONLY_REFUSAL.researchMutate);
    expect(RESEARCH_COLLECT_READ_ONLY_COPY).toBe(READ_ONLY_REFUSAL.ingest);
    // …and the three are distinct, which is the property that makes rendering
    // three notes worth anything: one string reused across two doors is how a
    // re-point goes unnoticed.
    expect(
      new Set([
        RESEARCH_CREATE_READ_ONLY_COPY,
        RESEARCH_MUTATE_READ_ONLY_COPY,
        RESEARCH_COLLECT_READ_ONLY_COPY,
      ]).size,
    ).toBe(3);
  });

  it("the /settings banner and the save bar say exactly what PUT /api/settings answers", () => {
    // DW-387. `/settings` stated THREE different sentences for one deployment
    // state — the banner ("This deployment has explicitly disabled settings
    // changes."), this route's inline literal, and the rebuild door's — none of
    // them owned here. `SETTINGS_READ_ONLY_COPY` is now the single client mirror,
    // rendered by both the Workbench save bar and the page banner.
    expect(SETTINGS_READ_ONLY_COPY).toBe(READ_ONLY_REFUSAL.settingsSave);
    // And NOT the sentence the settings PUT used to serve, which
    // `PUT /api/workspace-profile` still owns: two doors, two sentences, and
    // this is what stops a reword of one from being read as a reword of both.
    expect(SETTINGS_READ_ONLY_COPY).not.toBe(
      "Settings are read-only in this deployment.",
    );
  });

  it("Rebuild Vector Index says what ITS door answers, not the form's", async () => {
    // DW-387. The button pointed at the page's read-only banner — the SETTINGS
    // save sentence — over a door that answers about embeddings. A rebuild
    // changes no setting at all, so the owner read one sentence before pressing
    // and would have met another in the 403.
    expect(EMBEDDING_REBUILD_READ_ONLY_COPY).toBe(
      READ_ONLY_REFUSAL.embeddingRebuild,
    );
    expect(EMBEDDING_REBUILD_READ_ONLY_COPY).not.toBe(SETTINGS_READ_ONLY_COPY);
    // …and the route no longer spells the old literal anywhere.
    const route = await routeSource("settings/rebuild-embeddings/route.ts");
    expect(route).not.toContain("Rebuilding embeddings is disabled in read-only mode.");
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
