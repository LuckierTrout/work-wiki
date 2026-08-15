import { redirect } from "next/navigation";
import { HomeDashboard } from "@/components/HomeDashboard";
import { WikiWorkbench } from "@/components/WikiWorkbench";
import { getPrincipal } from "@/lib/auth";
import { listActionItems } from "@/lib/action-items";
import { listChatConversations } from "@/lib/chat";
import { buildHomeDashboardSnapshot } from "@/lib/home-dashboard";
import { logger } from "@/lib/logger";
import { listReadableWikiPages } from "@/lib/wiki";
import { emptyRegistry, getWikiRegistry } from "@/lib/wikis";

// The dashboard is private and changes whenever the owner's working set does.
export const dynamic = "force-dynamic";

export default async function Home() {
  const principal = await getPrincipal();
  if (!principal) redirect("/sign-in");

  // A failed secondary widget should not take down the owner's whole homepage.
  // Each source degrades to an honest empty state and leaves an operational log.
  const [pages, tasks, conversations, wikiRegistry] = await Promise.all([
    listReadableWikiPages(principal).catch((error) => {
      logger.error("home", "dashboard document list failed", error);
      return [];
    }),
    listActionItems(principal.handle).catch((error) => {
      logger.error("home", "dashboard action list failed", error);
      return [];
    }),
    listChatConversations(principal.handle).catch((error) => {
      logger.error("home", "dashboard conversation list failed", error);
      return [];
    }),
    // Unlike the three read-only lists above, an empty wiki registry is an
    // ACTIONABLE state ("No wiki yet." + Create Wiki), and creating rewrites
    // the tenant workspace profile. So a failed read is flagged rather than
    // flattened — the workbench says the read failed instead of claiming the
    // owner has no wikis.
    getWikiRegistry(principal.handle)
      .then((registry) => ({ registry, unavailable: false }))
      .catch((error) => {
        logger.error("home", "wiki registry read failed", error);
        return { registry: emptyRegistry(), unavailable: true };
      }),
  ]);

  return (
    <>
      <WikiWorkbench
        initialWikis={wikiRegistry.registry.wikis}
        initialCurrentId={wikiRegistry.registry.currentId}
        unavailable={wikiRegistry.unavailable}
      />
      <HomeDashboard
        snapshot={buildHomeDashboardSnapshot(pages, tasks, conversations)}
      />
    </>
  );
}
