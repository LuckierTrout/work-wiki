import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { listReadableWikiPages } from "@/lib/wiki";
import { listWorkbenchFilePaths } from "@/lib/workbench-files";
import { INTAKE_SIGN_IN_COPY } from "@/lib/workbench-intake";
import {
  buildKnowledgeTree,
  workbenchSlugGate,
  WORKBENCH_FILE_LIMIT,
} from "@/lib/workbench-tree";
import { getWikiRegistry } from "@/lib/wikis";

/**
 * GET /api/workbench/files — remaining file listing after first-paint SSR.
 */

export async function GET() {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: INTAKE_SIGN_IN_COPY }, { status: 401 });
  }
  try {
    const [registry, entries] = await Promise.all([
      getWikiRegistry(principal.handle),
      listReadableWikiPages(principal),
    ]);
    const knowledge = buildKnowledgeTree(entries);
    const slugGate = workbenchSlugGate(entries, knowledge);
    const listing = await listWorkbenchFilePaths(
      principal.handle,
      registry.currentId,
      { ...slugGate, limit: WORKBENCH_FILE_LIMIT },
    );
    return NextResponse.json({
      paths: listing.paths,
      truncated: listing.truncated,
    });
  } catch (error) {
    logger.error("files", "workbench files listing failed", error);
    return NextResponse.json({ paths: [], truncated: false }, { status: 500 });
  }
}
