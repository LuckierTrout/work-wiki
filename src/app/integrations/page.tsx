import Link from "next/link";
import { SignInButton } from "@clerk/nextjs";
import { getPrincipal } from "@/lib/auth";
import { IntegrationDesk } from "@/components/IntegrationDesk";

export default async function IntegrationsPage() {
  const principal = await getPrincipal();
  if (!principal) {
    return (
      <main className="shell fade" style={{ paddingTop: 120, paddingBottom: 120, textAlign: "center" }}>
        <p className="fmark" style={{ justifyContent: "center" }}>private dispatch desk</p>
        <h1 className="display" style={{ fontSize: "clamp(36px,5vw,60px)", margin: "16px 0 12px" }}>
          Send approved work, once.
        </h1>
        <p style={{ color: "var(--ink-2)", fontSize: 18, maxWidth: "46ch", margin: "0 auto 28px" }}>
          Accepted actions can leave WorkWiki through a durable, retry-safe outbox. Nothing is sent before approval.
        </p>
        <SignInButton mode="modal"><button className="btn primary">Sign in to manage integrations</button></SignInButton>
        <p style={{ marginTop: 14, fontSize: 13, color: "var(--faint)" }}>
          No account yet? <Link href="/waitlist" className="underline">Join the waitlist</Link>.
        </p>
      </main>
    );
  }
  return <IntegrationDesk />;
}
