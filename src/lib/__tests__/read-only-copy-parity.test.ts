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
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { READ_ONLY_REFUSAL } from "../read-only";
import {
  WIKI_CREATE_READ_ONLY_COPY,
  WIKI_READ_ONLY_COPY,
  WIKI_TEMPLATE_READ_ONLY_COPY,
} from "../workbench-tree";
import { DELETE_PAGE_READ_ONLY_COPY } from "@/components/DeletePageButton";
import { REINGEST_READ_ONLY_COPY } from "@/components/ReingestButton";
import { REVERT_READ_ONLY_COPY } from "@/components/RevisionHistory";
import { BULK_DELETE_READ_ONLY_COPY } from "@/components/RecentIngests";
import { CREATE_PAGE_READ_ONLY_COPY } from "@/app/wiki/new/NewWikiForm";
import { previewArtifactHistoryCopy } from "../workbench-preview";
import { NAMES_TERMS_READ_ONLY_COPY } from "@/components/NamesTermsSettings";
import { EMAIL_INGEST_READ_ONLY_COPY } from "@/components/EmailIngestSettings";
import { EMBEDDING_REBUILD_READ_ONLY_COPY } from "@/components/EmbeddingSettings";
import {
  RESEARCH_COLLECT_READ_ONLY_COPY,
  RESEARCH_CREATE_READ_ONLY_COPY,
  RESEARCH_MUTATE_READ_ONLY_COPY,
} from "../research-panel";
import { GRAPH_INSIGHT_DISMISS_READ_ONLY_COPY } from "@/components/workbench/GraphCanvas";
import { REVIEW_QUEUE_READ_ONLY_COPY } from "@/components/workbench/ReviewCanvas";
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
 * A kernel writer's source, read the same way {@link routeSource} reads a
 * handler's.
 *
 * Used only by the ungated-door tripwire below, which asserts the ABSENCE of a
 * gate — and absence is the one thing an import cannot express. There is no
 * constant to compare, so the file itself is the evidence.
 */
async function libSource(file: string): Promise<string> {
  return readFile(path.resolve(__dirname, "..", file), "utf8");
}

/**
 * Every `.ts` module under `src/lib/storage/`, as paths {@link libSource} takes.
 *
 * Enumerated from disk rather than listed, so a provider added tomorrow is
 * covered by the import-cycle tripwire without anyone remembering to add it.
 */
async function storageModuleFiles(prefix = "storage"): Promise<string[]> {
  const dir = path.resolve(__dirname, "..", prefix);
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await storageModuleFiles(rel)));
    else if (entry.name.endsWith(".ts")) out.push(rel);
  }
  return out;
}

/**
 * A client component's source, read the same way {@link routeSource} reads a
 * handler's.
 *
 * For the surfaces that render a sentence they do not OWN. A constant can be
 * imported and compared; "this file renders it by name and retypes nothing"
 * cannot, and that is the state `ResearchCanvas` is in.
 */
async function componentSource(file: string): Promise<string> {
  return readFile(path.resolve(__dirname, "../../components", file), "utf8");
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

  it("the Preview's file-specific Revert copy is narrower than the artifact sentence", () => {
    // DW-214 gave `GET/POST /api/workbench/artifact/revisions` its first client.
    // The POST refuses with `READ_ONLY_REFUSAL.artifactEdit` — "The Schema
    // cannot be edited…" — which is the honest sentence for a door that also
    // carries the editor's save, and a confusing one beside a control labelled
    // Revert over a version the owner did not type. So the panel narrows it, and
    // the difference is recorded here rather than left to look like the
    // re-ingest bug above.
    const schema = previewArtifactHistoryCopy("schema.md").readOnly;
    const purpose = previewArtifactHistoryCopy("purpose.md").readOnly;
    expect(schema).not.toBe(READ_ONLY_REFUSAL.artifactEdit);
    expect(purpose).not.toBe(READ_ONLY_REFUSAL.artifactEdit);
    expect(schema).toContain("reverted");
    expect(purpose).toContain("reverted");
    // The server covers the family; the client labels the selected file.
    expect(READ_ONLY_REFUSAL.artifactEdit).toContain("Wiki artifacts");
    expect(schema).toContain("Schema");
    expect(purpose).toContain("Purpose");
    // …and both still name the deployment state, which is the property that
    // makes either sentence actionable.
    expect(READ_ONLY_REFUSAL.artifactEdit).toContain("read-only");
    expect(schema).toContain("read-only");
    expect(purpose).toContain("read-only");
    // Narrower than the PAGE revert's sentence too, and distinct from it: the
    // two live on different surfaces refusing different writers, and one string
    // reused for both is how a re-point goes unnoticed.
    expect(schema).not.toBe(REVERT_READ_ONLY_COPY);
    expect(purpose).not.toBe(REVERT_READ_ONLY_COPY);
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

  it("the retired structured profile route exposes no write-time refusal", async () => {
    const route = await routeSource("workspace-profile/route.ts");
    expect(route).toContain('{ status: 405, headers: { Allow: "GET" } }');
    expect(route).not.toContain("checkWritePrecondition(");
    expect(route).not.toContain("saveWorkspaceProfile(");
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

  it("the switcher's sentence is a deliberate UMBRELLA over four doors", () => {
    // DW-302. `WIKI_READ_ONLY_COPY` is the one client constant on this surface
    // that mirrors no single door: it is rendered once, beside a left column
    // where the switcher, New Wiki, Rename and Delete are ALL dimmed at the
    // same time, and four sentences stacked there would say the same fact four
    // ways. So it names the four verbs in one line instead, and the difference
    // is recorded here rather than left to look like the re-ingest bug above.
    //
    // Wider than each of the four server sentences, not narrower — the
    // opposite direction from Revert and Create page — which is why "differs"
    // is asserted against all four rather than a single kernel sentence.
    // THE FOUR DOORS, not merely four constants. Each key below is pinned
    // against the literal its route actually serves by a sibling case in this
    // file — "the wiki-lifecycle kernel sentences equal the literals their
    // routes serve" (create, template, rename) and "the wiki delete/switch
    // kernel sentences equal the literals their routes serve" (delete, switch)
    // — so a divergence recorded here is a divergence from what the owner
    // would have met in the 403, not from a constant that drifted off its door
    // unnoticed. That is why this case reads no route source of its own.
    for (const sentence of [
      READ_ONLY_REFUSAL.wikiCreate,
      READ_ONLY_REFUSAL.wikiSwitch,
      READ_ONLY_REFUSAL.wikiRename,
      READ_ONLY_REFUSAL.wikiDelete,
    ]) {
      expect(WIKI_READ_ONLY_COPY).not.toBe(sentence);
      // Each door's own sentence names the deployment state…
      expect(sentence).toContain("read-only");
    }
    // …and so does the one sentence standing in for all four, which is the
    // property that makes any of them actionable.
    expect(WIKI_READ_ONLY_COPY).toContain("read-only");

    // The umbrella only earns the divergence if it actually covers all four —
    // a reword that dropped a verb would leave one dimmed control unexplained
    // while every other assertion here stayed green. WORD-BOUNDED: a bare
    // substring check would accept "recreated" for "created", which is how a
    // reword sneaks past a test that looks like it is reading the sentence.
    for (const verb of ["created", "switched", "renamed", "deleted"]) {
      expect(WIKI_READ_ONLY_COPY, verb).toMatch(new RegExp(`\\b${verb}\\b`));
    }

    // And distinct from the two NARROWER constants the same surface exports:
    // `Change template` and the canvas's `Create Wiki` each mirror their own
    // door character for character, and one string reused across the three is
    // how a re-point goes unnoticed.
    expect(WIKI_READ_ONLY_COPY).not.toBe(WIKI_CREATE_READ_ONLY_COPY);
    expect(WIKI_READ_ONLY_COPY).not.toBe(WIKI_TEMPLATE_READ_ONLY_COPY);
    // Templates are NOT one of the four verbs, which is the reason
    // `WIKI_TEMPLATE_READ_ONLY_COPY` has to exist at all. Case-folded, or the
    // check would pass against an umbrella that had quietly grown a
    // "Templates cannot be applied" clause.
    expect(WIKI_READ_ONLY_COPY.toLowerCase()).not.toContain("template");
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

  it("the scratch reaper's sentence mirrors no route either, and its gate stays out of the storage layer", async () => {
    // DW-292's key is the SECOND with nothing to mirror, for the same reason as
    // the sweep's: `reapStrandedScratchFiles` in `maintenance.ts` is reached
    // only from `POST /api/tasks/scan`, which has already answered its OWN
    // refusal before the reaper is called. It exists for the direct library
    // caller — a CLI command, an ops script — that arrives with no route in
    // front of it.
    const scan = await routeSource("tasks/scan/route.ts");
    expect(scan).toContain("error: READ_ONLY_REFUSAL.maintenanceScan");
    expect(scan).not.toContain("READ_ONLY_REFUSAL.scratchFileReap");
    expect(scan).not.toContain(servedAs(READ_ONLY_REFUSAL.scratchFileReap));
    // And it is about SCRATCH files, not about wiki directories — the two GC
    // passes run beside each other in the same block, so one sentence borrowed
    // for both is exactly how a re-point would go unnoticed.
    expect(READ_ONLY_REFUSAL.scratchFileReap).not.toBe(
      READ_ONLY_REFUSAL.wikiDirectorySweep,
    );
    expect(READ_ONLY_REFUSAL.scratchFileReap).toContain("scratch files");

    // WHY THE GATE LIVES IN `maintenance.ts` AND NOT BESIDE THE WALK: this
    // module imports `./config`, which imports `./storage`, which imports the
    // provider — so an `assertWritable` inside `src/lib/storage/` would close
    // an import cycle. Asserted over the WHOLE directory and every spelling
    // that would close it, because a tripwire that watched one file for one
    // spelling would not be watching the invariant it claims.
    const READ_ONLY_SPECIFIER = /["'](?:\.{1,2}\/|@\/lib\/)[^"']*read-only["']/;
    for (const file of await storageModuleFiles()) {
      const source = await libSource(file);
      expect(source, file).not.toMatch(READ_ONLY_SPECIFIER);
    }
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
      // DW-531 — the two Workbench canvas doors. They have answered 403 since
      // they were written, but neither was pinned here, so the client mirrors
      // added beside their now-`aria-disabled` controls had nothing holding
      // them to the sentence the owner would meet in the 403.
      ["graph/insights/route.ts", "graphInsightDismiss"],
      ["review-queue/[id]/route.ts", "reviewQueue"],
      // DW-477 — the registry repair door. It reuses `researchMutate` rather
      // than earning a sentence of its own: repairing IS "change my research"
      // from where the owner stands, and a read-only deployment that rewrote a
      // tenant's registry would be the one exception to the rule its siblings
      // keep.
      ["research/repair/route.ts", "researchMutate"],
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
    // Imported from `research-panel.ts`, not from `KnowledgeStudio.tsx`, since
    // DW-529: the Workbench's `ResearchCanvas` stands in front of the same
    // create door and had a fourth wording of its own inline, owned by nobody
    // and pinned by nothing. One owner, three surfaces.
    //
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

  it("the Graph and Review canvases say exactly what THEIR OWN doors answer", () => {
    // DW-531. Both canvases passed `readOnly` straight into `disabled`: the
    // standing refusal left the tab order and could never be announced with a
    // reason — the exact defect DW-191/DW-299 removed elsewhere. The controls
    // now carry `aria-disabled` and point at these sentences, so the sentences
    // have to be the ones the doors answer.
    expect(GRAPH_INSIGHT_DISMISS_READ_ONLY_COPY).toBe(
      READ_ONLY_REFUSAL.graphInsightDismiss,
    );
    expect(REVIEW_QUEUE_READ_ONLY_COPY).toBe(READ_ONLY_REFUSAL.reviewQueue);
    // ONE CONTROL, ONE DOOR. Both canvases also offer **Deep Research**, which
    // resolves nothing and dismisses nothing — it meets `POST /api/research`,
    // so it points at the CREATE sentence instead. Three distinct strings, or
    // a control would announce a refusal it does not meet.
    expect(
      new Set([
        GRAPH_INSIGHT_DISMISS_READ_ONLY_COPY,
        REVIEW_QUEUE_READ_ONLY_COPY,
        RESEARCH_CREATE_READ_ONLY_COPY,
      ]).size,
    ).toBe(3);
  });

  it("the Studio panels' own write doors refuse nothing, so there is nothing to mirror", async () => {
    // DW-530 asked for a read-only refusal on the Studio's Setup, Skills and
    // Portability panels, on the premise that each "still submits and meets its
    // refusal afterwards". IT DOES NOT. None of the doors those panels' OWN
    // write controls stand in front — create vault, rename/delete vault,
    // create/patch/delete skill, restore archive — calls `isReadOnly()`, and
    // none of the kernel writers behind them calls `assertWritable`. Vaults and
    // agent profiles still mutate under `YOPEDIA_READONLY`, which DW-268
    // records as the flag's deliberate, still-open boundary. A sentence beside
    // those controls would state a deployment property that is false and mirror
    // no server sentence, so they render none.
    //
    // NOT "those panels render no read-only term at all". Purpose & vaults
    // embeds `<WorkspacePurposeSettings />`, a DIFFERENT door
    // (`PUT /api/workspace-profile`) which does refuse and does render
    // `WORKSPACE_PURPOSE_READ_ONLY_COPY` — pinned by its own case above. One
    // panel, two doors, one of them silent.
    //
    // THIS CASE IS THE TRIPWIRE, not documentation. WHEN IT FAILS: one of the
    // doors named below has started refusing, and the Studio panel standing in
    // front of it now needs the client mirror DW-530 asked for — export a
    // constant beside `RESEARCH_CREATE_READ_ONLY_COPY`'s three, pin it against
    // the new `READ_ONLY_REFUSAL` key with a case above, and give the panel's
    // controls the `aria-disabled` + `aria-describedby` shape
    // `EmailIngestSettings` sets. Then delete that door's row here. Do NOT
    // simply relax the assertion.
    //
    // THE GATES ARE MATCHED AS CALLS, not as mentions. A future comment in one
    // of these handlers explaining WHY it does not gate — naming `isReadOnly`,
    // `isReadOnlyError` or `assertWritable` in prose — is welcome and must not
    // turn this case red; only the call form means the door started answering.
    // `READ_ONLY_REFUSAL` is the one still matched bare, because it is an
    // import: it cannot appear in a handler except to be served, and spelling
    // it in a comment here is the one phrasing to avoid.
    for (const [route, panel] of [
      ["vaults/route.ts", "SetupPanel (Purpose & vaults) — create vault"],
      ["vaults/[id]/route.ts", "SetupPanel (Purpose & vaults) — rename/delete vault"],
      ["agent-skills/route.ts", "SkillsPanel (Agent skills)"],
      ["agent-skills/[id]/route.ts", "SkillsPanel (Agent skills)"],
      ["archive/import/route.ts", "PortabilityPanel (Portability)"],
    ] as const) {
      const source = await routeSource(route);
      expect(source, panel).not.toContain("isReadOnly(");
      expect(source, panel).not.toContain("isReadOnlyError(");
      expect(source, panel).not.toContain("READ_ONLY_REFUSAL");
    }
    // …and no gate one layer down either, which is where DW-266/DW-314/DW-385
    // put the wiki, todo and research refusals. A route with no `isReadOnly()`
    // in front of a writer that DOES `assertWritable` still refuses — just with
    // the kernel's sentence — so the writers have to be checked too.
    for (const [file, panel] of [
      ["vault.ts", "SetupPanel (Purpose & vaults)"],
      ["agent-skills.ts", "SkillsPanel (Agent skills)"],
      ["portable-archive.ts", "PortabilityPanel (Portability)"],
    ] as const) {
      const source = await libSource(file);
      expect(source, panel).not.toContain("assertWritable(");
      expect(source, panel).not.toContain("READ_ONLY_REFUSAL");
    }
  });

  it("the Deep Research canvas renders the constant, never a retyped sentence", async () => {
    // DW-529. `ResearchCanvas` owns no constant of its own — it stands in front
    // of the create door three other surfaces already mirror — so there is no
    // value pair to compare. What there WAS is the regression this row exists
    // to prevent: the hint spelled a fourth wording of the create sentence
    // inline, owned by nobody, and nothing in this suite could see it.
    const canvas = await componentSource("workbench/ResearchCanvas.tsx");
    // The sentence arrives by NAME, so a reword of the constant reaches the
    // canvas without anyone editing it.
    expect(canvas).toContain("RESEARCH_CREATE_READ_ONLY_COPY");
    // TWO doors now (DW-644). The form's Start Deep Research meets
    // `POST /api/research`; the rows' Cancel and Start/Retry meet
    // `POST /api/research/[id]/run`, and their note mirrors THAT door's
    // sentence — by name, for the same reason.
    expect(canvas).toContain("RESEARCH_MUTATE_READ_ONLY_COPY");
    // The retired literal is gone — not merely unused, absent.
    expect(canvas).not.toContain(
      "Deep Research cannot start while this deployment is read-only.",
    );
    // …and no OTHER server sentence has been retyped there in its place. The
    // whole table, so a future hint that copies `researchMutate` beside Cancel
    // fails here rather than drifting silently.
    for (const [key, sentence] of Object.entries(READ_ONLY_REFUSAL)) {
      expect(canvas, key).not.toContain(sentence);
    }
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
