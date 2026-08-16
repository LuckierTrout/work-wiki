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
  /** The Wiki's files as a nested tree, for the Files tab. */
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
