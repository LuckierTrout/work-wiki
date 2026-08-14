import { PrivateWorkspaceNotice } from "@/components/PrivateWorkspaceNotice";
import { getPrincipal } from "@/lib/auth";
import { ActionInbox } from "@/components/ActionInbox";

export default async function TasksPage() {
  const principal = await getPrincipal();
  if (!principal) {
    return (
      <PrivateWorkspaceNotice heading="Tasks" action="Sign in to view tasks" />
    );
  }
  return <ActionInbox />;
}
