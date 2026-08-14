import Link from "next/link";
import { SignInButton } from "@clerk/nextjs";
import { getPrincipal } from "@/lib/auth";
import { SystemHealthDesk } from "@/components/SystemHealthDesk";

export default async function SystemPage() {
  const principal = await getPrincipal();
  if (!principal) {
    return (
      <main className="shell fade" style={{ paddingTop: 120, paddingBottom: 120, textAlign: "center" }}>
        <p className="fmark" style={{ justifyContent: "center" }}>private operator&apos;s desk</p>
        <h1 className="display" style={{ fontSize: "clamp(36px,5vw,60px)", margin: "16px 0 12px" }}>
          Know what your memory is doing.
        </h1>
        <p style={{ color: "var(--ink-2)", fontSize: 18, maxWidth: "46ch", margin: "0 auto 28px" }}>
          Inspect retrieval quality, verified backups, delivery failures, and AI receipts from one owner-only workspace.
        </p>
        <SignInButton mode="modal"><button className="btn primary">Sign in to inspect system health</button></SignInButton>
        <p style={{ marginTop: 14, fontSize: 13, color: "var(--faint)" }}>
          No account yet? <Link href="/waitlist" className="underline">Join the waitlist</Link>.
        </p>
      </main>
    );
  }
  return <SystemHealthDesk />;
}
