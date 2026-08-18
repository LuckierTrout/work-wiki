"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { FileNode, KnowledgeGroup } from "@/lib/workbench-tree";
import type { WikiRecord } from "@/lib/wikis";

/**
 * The server-loaded working set the shell's left column and Preview dock read.
 *
 * It arrives as context rather than as `<Workbench>` props because `page.tsx`
 * is a server component and the shell is a client one: a provider is the one
 * seam where a growing set of server reads can be handed across that boundary
 * without every intermediate component restating them. Story 1.7's
 * `dataVersion` is here for exactly that reason rather than as another prop —
 * both the watcher and, through the shell, the Preview column read it.
 *
 * Every field has an empty default so a consumer rendered outside the provider
 * degrades to "nothing loaded" instead of throwing.
 */
export interface WorkbenchData {
  /** The owner's Wikis, newest registry order, for the header switcher. */
  wikis: readonly WikiRecord[];
  currentWikiId: string | null;
  /** The registry read failed — the column says so instead of showing zero. */
  registryUnavailable: boolean;
  /** Readable pages grouped by type, for the Knowledge tab. */
  knowledge: readonly KnowledgeGroup[];
  /**
   * The page index could not be read, so `knowledge` is a degraded placeholder
   * rather than an observation. Without this the tab would show "No pages yet.
   * Ingest a source to compile one." — an instruction premised on a fact the
   * server does not have, exactly the mistake the registry's own flag exists to
   * prevent.
   */
  knowledgeUnavailable: boolean;
  /**
   * The owner's files as a nested tree, for the Files tab — the one tenant
   * silo plus the CURRENT Wiki's `purpose.md` and `schema.md`. Not "the Wiki's
   * files": Pages and Sources are shared across an owner's Wikis
   * (`src/lib/wikis.ts:16-17`, DW-30), which is what `WIKI_SCOPE_COPY` says at
   * the switcher and what Story 1.4's Wiki-switch AC now observes.
   */
  files: readonly FileNode[];
  /** Same discrimination as `knowledgeUnavailable`, for the file walk. */
  filesUnavailable: boolean;
  /** The file walk hit a cap; the Files tab says so under the tree. */
  filesTruncated: boolean;
  /**
   * The refresh signal this server render was built from — the monotonic
   * integer every kernel page write and delete raises by one. `DataVersionWatcher`
   * compares it to what `GET /api/workbench/version` answers and re-runs the
   * server render when it has moved forward; `PreviewColumn` takes it as a
   * dependency so the docked row re-reads its bytes at the same moment. A read
   * that failed degrades to `0`, which the forward-only comparison makes at
   * worst one wasted render rather than a loop.
   */
  dataVersion: number;
  /**
   * `YOPEDIA_READONLY=1` — the deployment refuses every write. An env fact the
   * server already holds, so it travels this seam rather than through a new
   * route and a client fetch. The shell hands it to `WikiSwitcher`, whose four
   * controls all sit in front of routes that answer 403 on such a deployment;
   * `SettingsCanvas` gets the same fact from its own payload's `readOnly`.
   *
   * Defaults to `false`: "not read-only" is the ordinary deployment, and a
   * consumer outside the provider must not lock its controls on the strength of
   * a missing provider.
   */
  readOnly: boolean;
}

const EMPTY_DATA: WorkbenchData = {
  wikis: [],
  currentWikiId: null,
  registryUnavailable: false,
  knowledge: [],
  knowledgeUnavailable: false,
  files: [],
  filesUnavailable: false,
  filesTruncated: false,
  dataVersion: 0,
  readOnly: false,
};

const WorkbenchDataContext = createContext<WorkbenchData>(EMPTY_DATA);

export function WorkbenchDataProvider({
  value,
  children,
}: {
  value: WorkbenchData;
  children: ReactNode;
}) {
  return (
    <WorkbenchDataContext.Provider value={value}>{children}</WorkbenchDataContext.Provider>
  );
}

export function useWorkbenchData(): WorkbenchData {
  return useContext(WorkbenchDataContext);
}
