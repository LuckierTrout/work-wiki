import path from "node:path";
import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import { requireOwnerOrServicePrincipal } from "@/lib/owner-route";
import { getDataDir } from "@/lib/paths";
import { isFilesystemStorage } from "@/lib/storage";
import { wikiDirPath } from "@/lib/wiki-paths";
import { getWikiRegistry } from "@/lib/wikis";

/**
 * `GET /api/v1/projects` — which Wikis exist, and which one `current` means
 * (Story 8.2).
 *
 * THE FIRST CALL any agent makes. Every other route takes `{id}`, and without
 * this one a client's only options are to guess a UUID or hard-code `current` —
 * which is how an agent ends up writing into whichever Wiki happened to be
 * active. So `current` is reported as an explicit `currentId` field rather than
 * left implicit, and each record repeats `isCurrent`: a caller that lists
 * projects should not have to correlate two fields to render a checkmark.
 *
 * OWNER-SCOPED, from the registry, in one read. There is no cross-tenant listing
 * here even for an owner-automation token: the registry is per-handle, and this
 * route asks for exactly the principal's own.
 */
export async function GET(request: Request) {
  const principal = await requireOwnerOrServicePrincipal(request);
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const registry = await getWikiRegistry(principal.handle);
    return NextResponse.json({
      currentId: registry.currentId,
      projects: registry.wikis.map((wiki) => ({
        id: wiki.id,
        name: wiki.name,
        // The scenario is included because it is what decides which artifacts a
        // Wiki has at all — an agent listing files under a Wiki wants to know
        // whether asking for `outline.md` is even meaningful.
        scenario: wiki.scenario,
        createdAt: wiki.createdAt,
        updatedAt: wiki.updatedAt,
        // WHERE THE WIKI'S ARTIFACTS LIVE, kernel-relative and display-only. It
        // is deliberately NOT a host filesystem project root: Pages and Sources
        // are still one flat tree per workspace (DW-17), and minting a host path
        // here would advertise a partitioning that does not exist. A client that
        // wants bytes uses `files` and `files/content`, never this string.
        path: wikiDirPath(principal.handle, wiki.id),
        // Present ONLY on a filesystem-backed kernel. The sidecar maps this
        // absolute dir to the Wiki UUID; R2 omits it because there is no host
        // path. Owner project folders still come from WORKWIKI_WIKI_ROOTS.
        ...(isFilesystemStorage()
          ? {
              hostPath: path.resolve(
                getDataDir(),
                wikiDirPath(principal.handle, wiki.id),
              ),
            }
          : {}),
        isCurrent: wiki.id === registry.currentId,
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
