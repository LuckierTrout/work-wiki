import { PrivateWorkspaceNotice } from "@/components/PrivateWorkspaceNotice";
import { getPrincipal } from "@/lib/auth";
import { ChatWorkspace } from "@/components/ChatWorkspace";

export default async function ChatPage() {
  const principal = await getPrincipal();
  if (!principal) {
    return (
      <PrivateWorkspaceNotice heading="Chat" action="Sign in to chat" />
    );
  }

  return <ChatWorkspace />;
}
