import { PrivateWorkspaceNotice } from "@/components/PrivateWorkspaceNotice";
import { getPrincipal } from "@/lib/auth";
import { KnowledgeAtlas } from "@/components/KnowledgeAtlas";

export default async function KnowledgePage() {
  const principal = await getPrincipal();
  if (!principal) {
    return (
      <PrivateWorkspaceNotice heading="Knowledge atlas" action="Sign in to open the atlas" />
    );
  }
  return <KnowledgeAtlas />;
}
