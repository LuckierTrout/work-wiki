import Link from "next/link";
import { SignInButton } from "@clerk/nextjs";
import { getPrincipal } from "@/lib/auth";
import { ActionInbox } from "@/components/ActionInbox";

export default async function TasksPage() {
  const principal = await getPrincipal();
  if (!principal) {
    return (
      <main className="shell fade" style={{ paddingTop: 120, paddingBottom: 120, textAlign: "center" }}>
        <p className="fmark" style={{ justifyContent: "center" }}>private action ledger</p>
        <h1 className="display" style={{ fontSize: "clamp(36px,5vw,60px)", margin: "16px 0 12px" }}>Your task inbox.</h1>
        <p style={{ color: "var(--ink-2)", fontSize: 18, maxWidth: "44ch", margin: "0 auto 28px" }}>
          Proposed actions are private and require your approval.
        </p>
        <SignInButton mode="modal"><button className="btn primary">Sign in to view tasks</button></SignInButton>
        <p style={{ marginTop: 14, fontSize: 13, color: "var(--faint)" }}>
          No account yet? <Link href="/waitlist" className="underline">Join the waitlist</Link>.
        </p>
      </main>
    );
  }
  return <ActionInbox />;
}
