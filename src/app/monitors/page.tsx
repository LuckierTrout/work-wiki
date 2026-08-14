import { PrivateWorkspaceNotice } from "@/components/PrivateWorkspaceNotice";
import { getPrincipal } from "@/lib/auth";
import { SourceMonitorDesk } from "@/components/SourceMonitorDesk";

export default async function MonitorsPage() {
  const principal = await getPrincipal();
  if (!principal) {
    return (
      <PrivateWorkspaceNotice heading="Source monitors" action="Sign in to manage sources" />
    );
  }
  return <SourceMonitorDesk />;
}
