/**
 * The ACTIVE Wiki's Workspace Purpose, rendered for a prompt.
 *
 * This is the composed reader that sits above both stores: it asks `wikis.ts`
 * which Wiki is current and `workspace-profile.ts` for that Wiki's profile.
 * It lives in its own module because `wikis.ts` already imports
 * `workspace-profile.ts` (the seeder writes the profile), so putting this
 * lookup in the profile store would close an import cycle. See `wiki-paths.ts`
 * for the layering.
 *
 * Every prompt site that used to import `buildWorkspaceGuidance` from
 * `workspace-profile` imports it from here instead; the call signature is
 * unchanged, so switching the active Wiki now swaps which profile reaches
 * ingest, chat, query, monitoring, extraction and the agent runtime.
 */

import { logger } from "./logger";
import { getCurrentWiki } from "./wikis";
import {
  getWorkspaceProfile,
  renderWorkspaceGuidance,
} from "./workspace-profile";

export async function buildWorkspaceGuidance(owner: string): Promise<string> {
  try {
    const wiki = await getCurrentWiki(owner);
    // No Wiki, no profile to key a read on, no guidance (DW-137). This branch
    // used to read the retired `tenants/<t>` singleton so an owner who had not
    // created a Wiki yet still saw their pre-split purpose in every prompt —
    // the same read-through `getWorkspaceProfile` carried, kept a second time
    // because this path has no `wikiId`. Both are gone: the legacy address is
    // now relocated once by `workspace-profile-backfill.ts` and lives nowhere
    // on a live read path. An owner with no Wiki has nothing the prompt can
    // name, and inventing one from a retired file is exactly the behaviour that
    // had no end date.
    if (!wiki) return "";
    return renderWorkspaceGuidance(await getWorkspaceProfile(owner, wiki.id));
  } catch (error) {
    // Fail soft. Guidance is an ADDITION to a prompt — losing it degrades the
    // answer, while throwing would fail the whole ingest or chat turn over a
    // damaged registry or an unreadable profile. Warn so it is diagnosable.
    logger.warn(
      "workspace-guidance",
      `resolving the active wiki's Workspace Purpose for "${owner}" failed — continuing without it`,
      error,
    );
    return "";
  }
}
