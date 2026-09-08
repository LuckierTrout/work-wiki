import { PrivateWorkspaceNotice } from "@/components/PrivateWorkspaceNotice";
import { getPrincipal } from "@/lib/auth";
import { IntegrationDesk } from "@/components/IntegrationDesk";

export default async function IntegrationsPage() {
  const principal = await getPrincipal();
  if (!principal) {
    return (
      <PrivateWorkspaceNotice heading="Integrations" action="Sign in to manage integrations" />
    );
  }
  return <IntegrationDesk />;
}
