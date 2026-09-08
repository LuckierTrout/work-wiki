import { PrivateWorkspaceNotice } from "@/components/PrivateWorkspaceNotice";
import { getPrincipal } from "@/lib/auth";
import { SystemHealthDesk } from "@/components/SystemHealthDesk";

export default async function SystemPage() {
  const principal = await getPrincipal();
  if (!principal) {
    return (
      <PrivateWorkspaceNotice heading="System health" action="Sign in to inspect system health" />
    );
  }
  return <SystemHealthDesk />;
}
