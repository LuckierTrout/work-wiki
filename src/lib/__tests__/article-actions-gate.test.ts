/**
 * DW-120/DW-269 — the SEAMS that carry the realm fact into the write gates.
 *
 * What the gate DECIDES is pinned by mounting it:
 * `src/components/__tests__/article-actions-delete-gate.test.tsx` renders
 * `ArticleActions` across the page/viewer matrix and compares the rendered
 * affordance against `canWritePage(meta, principal, "delete")` itself. This
 * file pins what a mounted test cannot see — the hop that gets the fact there.
 *
 * DW-269 adds two more of the same shape: `realmDeniesBodyWrite` into
 * `ArticleActions` for Re-ingest, and `realmDeniesRevert` into
 * `RevisionHistory` (and on to each `RevisionItem`) for Revert. Every one is
 * the same one-attribute hop with the same failure mode.
 *
 * `realmDeniesDelete` is computed on the SERVER (`ArticleView`) because
 * `belongsInCommons` reaches storage, locks and `wiki.ts`, and `ArticleActions`
 * is a `"use client"` island. That makes the seam exactly one JSX attribute
 * across one hop: delete it and the mounted suite still passes (it hands the
 * prop in itself) while every page owner is offered Delete on a public
 * knowledge page the server always refuses — the DW-120 bug, restored.
 *
 * The island's side of the boundary is pinned as a source scan on purpose: a
 * server-only module entering this file's import graph is a BUILD-time fact
 * (`@/lib/commons` → storage/lock/wiki in a browser bundle), which no mounted
 * render can observe — vitest resolves those modules happily under jsdom.
 *
 * Vitest runs this project as `environment: "node"` over
 * `src/**\/__tests__/**\/*.test.ts` only — no jsdom, no testing-library (the
 * create-wiki-ui.test.ts convention), which is why the mounted half lives in a
 * `.test.tsx` sibling under `src/components/__tests__`.
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

const COMPONENTS = path.resolve(__dirname, "../../components");
const LIB = path.resolve(__dirname, "..");

function read(component: string): Promise<string> {
  return readFile(path.join(COMPONENTS, component), "utf8");
}

/** A module under `src/lib` — for the client-safe helpers the islands import. */
function readLib(module: string): Promise<string> {
  return readFile(path.join(LIB, module), "utf8");
}

/**
 * The source text of one JSX element, from `<Name` to the `/>` that closes it.
 *
 * Used instead of a `<Name\b[^>]*attr` regex because such a scan stops at the
 * first `>` — including one INSIDE a prop value — and would then fail for a
 * reason unrelated to what it pins. Throws rather than returning `""` so a
 * renamed or deleted element fails as a missing element, not as a missing
 * attribute.
 */
function elementText(source: string, name: string): string {
  const start = source.indexOf(`<${name}`);
  if (start === -1) throw new Error(`<${name}> is not rendered in this file`);
  const end = source.indexOf("/>", start);
  if (end === -1) throw new Error(`<${name}> has no self-closing tag`);
  return source.slice(start, end + 2);
}

/** Every module specifier `source` imports, static or dynamic. */
function importSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(/\bfrom\s+["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g),
  ].map((m) => m[1]);
}

/**
 * The client island's own file plus every component it renders.
 *
 * The boundary is a property of the whole client SUBTREE, not of one file: a
 * server-only module pulled into `DeletePageButton` reaches the browser bundle
 * just as surely as one imported by `ArticleActions`, and a scan of the parent
 * alone would never see it.
 */
const ISLAND_SUBTREE = [
  "ArticleActions.tsx",
  "ReingestButton.tsx",
  "DeletePageButton.tsx",
  "SaveToVaultButton.tsx",
];

/**
 * The OTHER client island `ArticleView` threads a realm fact into. Listed
 * separately because it is a sibling of `ArticleActions`, not a child of it —
 * `ISLAND_SUBTREE`'s "parent renders each child" check does not apply — but it
 * carries exactly the same server-only-module prohibition.
 */
const HISTORY_SUBTREE = ["RevisionHistory.tsx", "RevisionItem.tsx"];

/**
 * The client-safe helper both islands pull identity from.
 *
 * It is not a component, so it is scanned separately — but it is squarely
 * INSIDE the browser bundle, so the same server-only-module prohibition binds
 * it. A `@/lib/commons` import added here would reach the browser through two
 * islands at once, and neither component scan would see it.
 */
const CLIENT_LIB = "viewer-handle.ts";

describe("the commons-realm fact reaches the Delete gate (DW-120)", () => {
  it("is computed on the server from the predicate canWritePage decides on", async () => {
    const view = await read("ArticleView.tsx");
    // The exported predicate, not a re-spelling of its body: a local
    // `visibility !== "private" && …` here would pass a naive "computes the
    // realm" check and drift the moment the realm gate changes.
    expect(view).toContain(
      'import { isRealmRestrictedWrite } from "@/lib/authz";',
    );
    expect(view).toMatch(
      /const realmDeniesDelete = isRealmRestrictedWrite\(realmMeta, "delete"\)/,
    );
    // Anchored to the ELEMENT, not to the attribute: a bare
    // `toContain("realmDeniesDelete={realmDeniesDelete}")` would keep passing
    // the moment any other element in this file grew the same attribute, and
    // the one hop this pins could then be deleted with the suite still green.
    //
    // Sliced rather than regex-matched: a `[^>]*` scan cannot cross a `>`, so
    // it would break the day any prop on this element contained one (a
    // comparison, an arrow function, a generic) — failing for a reason that has
    // nothing to do with the seam. `elementText` takes the element's real span.
    expect(elementText(view, "ArticleActions")).toContain(
      "realmDeniesDelete={realmDeniesDelete}",
    );
    // Save-to-vault gating shares the coerced frontmatter and is untouched.
    expect(view).toContain("isCuratable={isCuratable}");
  });

  it("computes the BODY-write realm fact the same way, for Re-ingest and Revert", async () => {
    // DW-269. The same predicate, asked the kind the routes behind those two
    // doors actually pass (`"body"` for `POST /api/ingest/reingest` and for
    // `POST /api/wiki/[slug]/revisions {action:"revert"}`) — not a reuse of the
    // delete answer, so a future rule that splits the realm by kind again finds
    // each seam already asking its own question.
    const view = await read("ArticleView.tsx");
    expect(view).toMatch(
      /const realmDeniesBodyWrite = isRealmRestrictedWrite\(realmMeta, "body"\)/,
    );
    // Anchored to each ELEMENT, for the same reason as the Delete hop above.
    expect(elementText(view, "ArticleActions")).toContain(
      "realmDeniesBodyWrite={realmDeniesBodyWrite}",
    );
    expect(elementText(view, "RevisionHistory")).toContain(
      "realmDeniesRevert={realmDeniesBodyWrite}",
    );
  });

  it("gates Re-ingest and Revert on the props, never on a re-derived realm", async () => {
    const actions = await read("ArticleActions.tsx");
    // Received, not defaulted — a `= false` would widen the gate the instant
    // the seam above is dropped.
    expect(actions).toContain("realmDeniesBodyWrite: boolean;");
    expect(actions).not.toMatch(/realmDeniesBodyWrite\s*=\s*false/);
    // `isSiteOwner` stays an OR at both doors: the site owner is an admin and
    // passes the server's check on a realm page.
    expect(actions).toContain(
      "hasSourceUrl && (isSiteOwner || (ownsOrContributes && !realmDeniesBodyWrite))",
    );

    const history = await read("RevisionHistory.tsx");
    expect(history).toContain("realmDeniesRevert: boolean;");
    expect(history).not.toMatch(/realmDeniesRevert\s*=\s*false/);
    expect(history).toContain(
      "const canRevert = isLoaded && isSignedIn && (isSiteOwner || !realmDeniesRevert);",
    );
    // …and the panel hands its answer to every row, which is what actually
    // removes the button.
    expect(elementText(history, "RevisionItem")).toContain("canRevert={canRevert}");

    const item = await read("RevisionItem.tsx");
    expect(item).toContain("canRevert: boolean;");
    expect(item).not.toMatch(/canRevert\s*=\s*true/);
    // View is NOT gated: reading an old revision is not a write, so hiding it
    // would be a refusal the server never answers.
    expect(item).toMatch(/\{canRevert && \(/);
    expect(item).toContain("View revision from");
  });

  it("keeps the revision-history island free of the server-only realm modules", async () => {
    // Same bundling fact as the action bar: `RevisionHistory` now reads the
    // Clerk session and `@/lib/owner`, and must learn the realm ONLY as a prop.
    for (const component of HISTORY_SUBTREE) {
      const specifiers = importSpecifiers(await read(component));
      expect(specifiers.length).toBeGreaterThan(0);
      for (const serverOnly of ["@/lib/commons", "@/lib/authz", "@/lib/wiki"]) {
        expect(specifiers).not.toContain(serverOnly);
      }
    }
    // …and the shared identity helper, which rides in the same bundle through
    // both islands and is scanned with them for that reason.
    const libSpecifiers = importSpecifiers(await readLib(CLIENT_LIB));
    expect(libSpecifiers.length).toBeGreaterThan(0);
    for (const serverOnly of ["@/lib/commons", "@/lib/authz", "@/lib/wiki"]) {
      expect(libSpecifiers).not.toContain(serverOnly);
    }

    const history = await read("RevisionHistory.tsx");
    expect(history).toContain('"use client"');
    const historySpecifiers = importSpecifiers(history);
    expect(historySpecifiers).toContain("@/lib/owner");
    expect(historySpecifiers).toContain("@/lib/viewer-handle");
  });

  it("is consumed by the island as a prop, and gates Delete with it", async () => {
    const actions = await read("ArticleActions.tsx");
    // Received, not defaulted: an optional prop with a `false` default would
    // widen the gate silently the moment the seam above is dropped.
    expect(actions).toContain("realmDeniesDelete: boolean;");
    expect(actions).not.toMatch(/realmDeniesDelete\s*=\s*false/);
    // The gate itself. `isSiteOwner` stays an OR — the site owner is an admin
    // and passes the server's check on a realm page — while the page owner is
    // now gated on the realm, which is the divergence DW-120 names.
    expect(actions).toContain(
      "const canDelete = isSiteOwner || (isOwner && !realmDeniesDelete);",
    );
  });

  it("keeps the island SUBTREE free of the server-only realm modules", async () => {
    // `belongsInCommons` lives in `@/lib/commons`, whose import graph reaches
    // storage, locks and `wiki.ts`. Pulling any of those into a `"use client"`
    // file is the failure this seam exists to avoid — and it is a BUNDLING
    // fact, invisible to a mounted render, which resolves them happily.
    //
    // Asserted over the parsed import specifiers rather than over the files'
    // text: the module names appear in this suite's own prose (explaining why
    // they are absent), so a substring scan would fail on a comment while still
    // passing an `await import("@/lib/commons")` written on one line.
    const actions = await read("ArticleActions.tsx");
    expect(actions).toContain('"use client"');
    // The list is the parent plus what it renders — checked against the file,
    // so a NEW child added to the action bar and left off the list fails here
    // instead of quietly escaping the scan.
    for (const child of ISLAND_SUBTREE.slice(1)) {
      expect(actions).toContain(`<${child.replace(".tsx", "")} `);
    }

    for (const component of ISLAND_SUBTREE) {
      const specifiers = importSpecifiers(await read(component));
      // Sanity, per file: the scan finds real imports, so an empty match set
      // can never make the exclusions below vacuously true.
      expect(specifiers.length).toBeGreaterThan(0);
      for (const serverOnly of ["@/lib/commons", "@/lib/authz", "@/lib/wiki"]) {
        expect(specifiers).not.toContain(serverOnly);
      }
    }
    // The island's identity imports, named explicitly: these are what make the
    // client half of the Delete gate decidable in the browser at all. The Clerk
    // session is no longer read here directly — `@/lib/viewer-handle` owns the
    // one copy of the handle-resolution rule, so the assertion follows it there
    // rather than being dropped. `@/lib/owner` stays local: it is a plain env
    // read, not a session read.
    const actionSpecifiers = importSpecifiers(actions);
    expect(actionSpecifiers).toContain("@/lib/owner");
    expect(actionSpecifiers).toContain("@/lib/viewer-handle");
    // …and the session read really does happen, one hop away.
    expect(importSpecifiers(await readLib(CLIENT_LIB))).toContain("@clerk/nextjs");
    // Not in the island itself — a second `useUser` here would be the drift the
    // extraction exists to prevent.
    expect(actionSpecifiers).not.toContain("@clerk/nextjs");
  });

  it("resolves the viewer's handle ONCE, for both gates", async () => {
    // The rule mirrors the server's `resolveHandle`: prefer the Clerk username,
    // fall back to the X/Twitter external account. Only the first branch is
    // exercised by the mounted suites, so two copies could drift for exactly
    // the Twitter-SSO viewers the fallback exists for — moving the Delete and
    // Revert gates apart with every test still green. Pinned as "one
    // definition, two importers".
    const lib = await readLib(CLIENT_LIB);
    expect(lib).toContain('"use client"');
    expect(lib).toMatch(/\(\^\|_\)\(x\|twitter\)\$/);
    expect(lib).toContain("export function useViewerHandle()");

    // Neither island restates it.
    for (const component of ["ArticleActions.tsx", "RevisionHistory.tsx"]) {
      const source = await read(component);
      expect(source).toContain("useViewerHandle()");
      expect(source).not.toMatch(/externalAccounts/);
      expect(source).not.toContain("useUser");
    }
  });
});

/**
 * DW-392 — the SESSION term on the Revert gate.
 *
 * Its own `describe` rather than an addition to the DW-120 block above: that
 * block is about the REALM fact and the Delete gate, and a regression in who
 * may revert is not a realm/Delete failure. Reported under this heading, the
 * failing test names the gate that actually broke.
 *
 * The mounted half is
 * `src/components/__tests__/revision-revert-session-gate.test.tsx`; this is the
 * text pin that stops an ownership term from being added back.
 */
describe("the viewer's SESSION reaches the Revert gate (DW-392)", () => {
  it("gates Revert on the session, and still on no ownership term", async () => {
    const history = await read("RevisionHistory.tsx");

    // The session term, taken from the SHARED hook rather than from a second
    // `useUser()` read — `@/lib/viewer-handle` owns the one copy of who the
    // viewer is, and `ArticleActions`' `canCurate` reads `isSignedIn` off the
    // same destructure. `POST /api/wiki/[slug]/revisions` is a write, so the
    // write-gate middleware 401s an anonymous caller before the route's authz
    // runs; without this term every viewer of a non-realm page was offered
    // Restore and its confirm in front of that 401.
    expect(history).toMatch(
      /const \{[^}]*\bisSignedIn\b[^}]*\} = useViewerHandle\(\);/,
    );
    // `isLoaded` guards the WHOLE gate now, not just `isSiteOwner`: the
    // pre-session answer is "we do not know yet", and for a convenience gate
    // that must resolve to "no". The mounted rows are in
    // `src/components/__tests__/revision-revert-session-gate.test.tsx`.
    expect(history).toContain(
      "const canRevert = isLoaded && isSignedIn && (isSiteOwner || !realmDeniesRevert);",
    );

    // AND NO OWNERSHIP TERM, which is the half a "more gating is safer" edit
    // would get wrong. The revert route gates on the realm and on the private-
    // page ACL, never on page ownership, so an `isOwner`/`ownsOrContributes`
    // term here would hide Restore from signed-in viewers the server admits —
    // wider is the forbidden direction, but narrower-than-the-server is only
    // tolerable where the browser genuinely cannot know better (ADMIN_HANDLES),
    // and here it can.
    //
    // Matched on CODE SHAPES, not on the bare identifier: the file explains in
    // prose why `isOwner` is absent, and a `not.toContain("isOwner")` would
    // fail on that explanation while a one-line `isOwner && …` slipped past a
    // reviewer. `isOwnerHandle`/`isSiteOwner` are the SITE-owner check and stay.
    expect(history).not.toMatch(/\bconst\s+isOwner\b/);
    expect(history).not.toMatch(/\bconst\s+ownsOrContributes\b/);
    // The page's owner and contributors never reach this island at all — no
    // prop declared for either, so there is nothing to compare against.
    expect(history).not.toMatch(/^\s*owner\??:/m);
    expect(history).not.toMatch(/^\s*contributors\??:/m);
    expect(history).not.toMatch(/owner\.toLowerCase\(\)/);
    // …and `canRevert` itself names only the three terms above.
    const canRevertLine = history
      .split("\n")
      .find((line) => line.includes("const canRevert ="))!;
    expect(canRevertLine).not.toMatch(/\bisOwner\b|\bownsOrContributes\b/);
  });
});

/**
 * DW-37/DW-149/DW-187 — the read-only seam down to every refusing control.
 *
 * `DELETE /api/wiki/[slug]`, `POST /api/ingest/reingest` and
 * `POST /api/wiki/[slug]/revisions {action:"revert"}` all answer 403 on a
 * read-only deployment, and each control's first act is either an
 * irreversible-sounding `window.confirm` or a request that cannot land. The
 * mounted behaviour lives in
 * `src/components/__tests__/page-write-read-only.test.tsx`; what a mounted test
 * CANNOT see is the seam that carries the fact, because it hands the prop in
 * itself. A handful of JSX attributes across two server hops, any one of which
 * could be deleted with every mounted assertion still green and the owner back
 * to confirming a write the deployment will refuse.
 */
describe("the read-only fact reaches the refusing controls (DW-37, DW-149, DW-187)", () => {
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

  it("reaches Re-ingest and the revision history through the same one seam", async () => {
    // The two hops DW-187 adds. Anchored to the ELEMENT, not to the attribute:
    // a bare `toContain("readOnly={readOnly}")` would keep passing the moment
    // any other element grew the same attribute, and the hop this pins could
    // then be deleted with the suite still green.
    const actions = await read("ArticleActions.tsx");
    expect(actions).toMatch(/<ReingestButton\b[^>]*\breadOnly=\{readOnly\}/s);

    const view = await read("ArticleView.tsx");
    expect(view).toMatch(/<RevisionHistory\b[^>]*\breadOnly=\{readOnly\}/s);

    // RevisionHistory owns the handler that opens the confirm and hands the
    // fact to each row's Revert button; neither client island fetches it.
    const history = await read("RevisionHistory.tsx");
    expect(history).toMatch(/<RevisionItem\b[^>]*\breadOnly=\{readOnly\}/s);
    expect(history).not.toContain("isReadOnly");
    expect(await read("ReingestButton.tsx")).not.toContain("isReadOnly");
    expect(await read("RevisionItem.tsx")).not.toContain("isReadOnly");
  });

  it("dims nothing this change did not gate", async () => {
    // Graphify posts to `/api/knowledge`, which rebuilds derived structured
    // knowledge and reaches no kernel writer; Save to vault curates a
    // reference. Neither is refused on a read-only deployment, so dimming them
    // would be a refusal the server never answers — the mirror of the bug being
    // fixed. Re-ingest and Delete ARE gated now, and exactly those two.
    const actions = await read("ArticleActions.tsx");
    expect(actions).toContain("<SaveToVaultButton slug={slug} />");
    expect(actions.match(/readOnly=\{readOnly\}/g) ?? []).toHaveLength(2);
    // Graphify is spelled inline in this file rather than as a child component,
    // so "not threaded" has to be said as "this file marks nothing disabled on
    // the deployment fact itself".
    expect(actions).not.toMatch(/aria-disabled/);
    expect(actions).toMatch(/<button[^>]*disabled=\{graphifyState === "working"\}/s);
  });
});
