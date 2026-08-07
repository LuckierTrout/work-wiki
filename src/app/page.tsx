import { redirect } from "next/navigation";
import { HomeDashboard } from "@/components/HomeDashboard";
import { getPrincipal } from "@/lib/auth";
import { listActionItems } from "@/lib/action-items";
import { listChatConversations } from "@/lib/chat";
import { buildHomeDashboardSnapshot } from "@/lib/home-dashboard";
import { logger } from "@/lib/logger";
import { listReadableWikiPages } from "@/lib/wiki";

// The dashboard is private and changes whenever the owner's working set does.
export const dynamic = "force-dynamic";

export default async function Home() {
  const principal = await getPrincipal();
  if (!principal) redirect("/sign-in");

  // A failed secondary widget should not take down the owner's whole homepage.
  // Each source degrades to an honest empty state and leaves an operational log.
  const [pages, tasks, conversations] = await Promise.all([
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
  ]);

  return (
    <HomeDashboard
      snapshot={buildHomeDashboardSnapshot(pages, tasks, conversations)}
    />
  );
}
