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
  readLegacyTenantProfile,
  renderWorkspaceGuidance,
} from "./workspace-profile";

export async function buildWorkspaceGuidance(owner: string): Promise<string> {
  try {
    const wiki = await getCurrentWiki(owner);
    if (!wiki) {
      // No Wiki, so no per-Wiki profile to key a read on — but an owner who
      // upgrades with a hand-authored `tenants/<t>/workspace-profile.json` and
      // has not created a Wiki yet would otherwise have their purpose vanish
      // from every prompt on the very deploy the fallback exists to survive.
      // Read-only, and bounded to the migration window: the first Wiki they
      // create seeds its own profile and this branch stops being reached.
      const legacy = await readLegacyTenantProfile(owner);
      return legacy ? renderWorkspaceGuidance(legacy) : "";
    }
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
