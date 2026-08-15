import { redirect } from "next/navigation";
import { WikiWorkbench } from "@/components/WikiWorkbench";
import { Workbench } from "@/components/workbench/Workbench";
import { getPrincipal } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { emptyRegistry, getWikiRegistry } from "@/lib/wikis";

// The Workbench is private and reflects the owner's working set on every load.
export const dynamic = "force-dynamic";

export default async function Home() {
  const principal = await getPrincipal();
  if (!principal) redirect("/sign-in");

  // Unlike a read-only widget, an empty wiki registry is an ACTIONABLE state
  // ("No wiki yet." + Create Wiki), and creating rewrites the tenant workspace
  // profile. So a failed read is flagged rather than flattened — the workbench
  // says the read failed instead of claiming the owner has no wikis.
  const wikiRegistry = await getWikiRegistry(principal.handle)
    .then((registry) => ({ registry, unavailable: false }))
    .catch((error) => {
      logger.error("home", "wiki registry read failed", error);
      return { registry: emptyRegistry(), unavailable: true };
    });

  return (
    <Workbench>
      <WikiWorkbench
        initialWikis={wikiRegistry.registry.wikis}
        initialCurrentId={wikiRegistry.registry.currentId}
        unavailable={wikiRegistry.unavailable}
      />
    </Workbench>
  );
}
