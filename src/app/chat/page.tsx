import Link from "next/link";
import { SignInButton } from "@clerk/nextjs";
import { getPrincipal } from "@/lib/auth";
import { ChatWorkspace } from "@/components/ChatWorkspace";

export default async function ChatPage() {
  const principal = await getPrincipal();
  if (!principal) {
    return (
      <main className="shell fade" style={{ paddingTop: 120, paddingBottom: 120, textAlign: "center" }}>
        <p className="fmark" style={{ justifyContent: "center" }}>your knowledge</p>
        <h1 className="display" style={{ fontSize: "clamp(36px,5vw,60px)", margin: "16px 0 12px" }}>
          Chat with your wiki.
        </h1>
        <p style={{ color: "var(--ink-2)", fontSize: 18, maxWidth: "46ch", margin: "0 auto 28px" }}>
          Conversations can include private pages, so sign in to continue.
        </p>
        <SignInButton mode="modal"><button className="btn primary">Sign in to chat</button></SignInButton>
        <p style={{ marginTop: 14, fontSize: 13, color: "var(--faint)" }}>
          No account yet? <Link href="/waitlist" className="underline">Join the waitlist</Link>.
        </p>
      </main>
    );
  }

  return <ChatWorkspace />;
}
