import { redirect } from "next/navigation";
import { WikiWorkbench } from "@/components/WikiWorkbench";
import { Workbench } from "@/components/workbench/Workbench";
import { WorkbenchDataProvider } from "@/components/workbench/WorkbenchData";
import { getPrincipal } from "@/lib/auth";
import { logger } from "@/lib/logger";
import type { IndexEntry } from "@/lib/types";
import { listReadableWikiPages } from "@/lib/wiki";
import { listWorkbenchFilePaths } from "@/lib/workbench-files";
import {
  buildFileTree,
  buildKnowledgeTree,
  readableSlugsFromKnowledge,
} from "@/lib/workbench-tree";
import { emptyRegistry, getWikiRegistry } from "@/lib/wikis";

// The Workbench is private and reflects the owner's working set on every load.
export const dynamic = "force-dynamic";

/**
 * The left column's tree data is loaded here and handed across the
 * server/client boundary by `WorkbenchDataProvider`. Two reasons it is not
 * fetched in the browser: this story adds no API route and no client fetch, and
 * `listReadableWikiPages` is the only visibility gate there is — reading it from
 * the authenticated `Principal` on the server is what makes "no request can
 * return another owner's pages" structurally true rather than a rule a future
 * caller has to remember.
 *
 * Every load degrades and logs the way the registry read already does — with a
 * FLAG, never by flattening to empty. A tree that silently reports zero turns a
 * read failure into "you have nothing yet", and the empty state's instruction
 * ("Ingest a source to compile one.") is then advice premised on a fact the
 * server does not have.
 */
export default async function Home() {
  const principal = await getPrincipal();
  if (!principal) redirect("/sign-in");

  // The registry and the page index do not depend on each other, so they are
  // awaited together. The file walk needs BOTH — the current Wiki id for the
  // seeded artifacts, and the readable slug set for its read gate — so it
  // follows them rather than joining the same round.
  const [wikiRegistry, pageIndex] = await Promise.all([
    // Unlike a read-only widget, an empty wiki registry is an ACTIONABLE state
    // ("No wiki yet." + Create Wiki), and creating rewrites the tenant workspace
    // profile. So a failed read is flagged rather than flattened — the workbench
    // says the read failed instead of claiming the owner has no wikis.
    getWikiRegistry(principal.handle)
      .then((registry) => ({ registry, unavailable: false }))
      .catch((error) => {
        logger.error("home", "wiki registry read failed", error);
        return { registry: emptyRegistry(), unavailable: true };
      }),
    listReadableWikiPages(principal)
      .then((entries) => ({ entries, unavailable: false }))
      .catch((error) => {
        logger.error("home", "readable page index read failed", error);
        return { entries: [] as IndexEntry[], unavailable: true };
      }),
  ]);

  // The gate is the KNOWLEDGE TREE ITSELF, not the raw index it was built from.
  // `buildKnowledgeTree` also drops agent-scoped pages, so deriving the slug set
  // from `pageIndex.entries` would leave the Files tab naming a page the
  // Knowledge tab hides — a filename is the same disclosure as a title. Reading
  // the set off the rendered tree is what makes "one gate, two tabs" a fact
  // rather than a comment. The derivation lives in `workbench-tree` so a test
  // EXECUTES it — inlined here it could only be grepped for, and a rewrite that
  // kept this comment and read `pageIndex.entries` instead would stay green.
  const knowledge = buildKnowledgeTree(pageIndex.entries);
  const readableSlugs = readableSlugsFromKnowledge(knowledge);

  const fileListing = await listWorkbenchFilePaths(
    principal.handle,
    wikiRegistry.registry.currentId,
    { readableSlugs },
  )
    .then((listing) => ({ ...listing, unavailable: false }))
    .catch((error) => {
      logger.error("home", "workbench file listing failed", error);
      return { paths: [] as string[], truncated: false, unavailable: true };
    });

  return (
    <WorkbenchDataProvider
      value={{
        wikis: wikiRegistry.registry.wikis,
        currentWikiId: wikiRegistry.registry.currentId,
        registryUnavailable: wikiRegistry.unavailable,
        knowledge,
        knowledgeUnavailable: pageIndex.unavailable,
        files: buildFileTree(fileListing.paths),
        // A failed page-index read is ALSO a failed file read: the walk's gate
        // is that index, so an empty slug set filters every page out of `wiki/`
        // and the tab would show an empty silo where the truth is "we could not
        // find out". The flag travels with the gate it depends on.
        filesUnavailable: fileListing.unavailable || pageIndex.unavailable,
        filesTruncated: fileListing.truncated,
      }}
    >
      <Workbench>
        {/* Keyed on the current Wiki: Story 1.2's card seeds `useState` from its
            props, so a `router.refresh()` triggered by the HEADER switcher would
            otherwise leave the canvas naming the previous Wiki. */}
        <WikiWorkbench
          key={wikiRegistry.registry.currentId ?? "none"}
          initialWikis={wikiRegistry.registry.wikis}
          initialCurrentId={wikiRegistry.registry.currentId}
          unavailable={wikiRegistry.unavailable}
        />
      </Workbench>
    </WorkbenchDataProvider>
  );
}
