import Link from "next/link";
import { SignInButton } from "@clerk/nextjs";
import { getPrincipal } from "@/lib/auth";
import { KnowledgeStudio } from "@/components/KnowledgeStudio";

export const metadata = {
  title: "Knowledge Studio — work-wiki",
  description: "Private owner workspace for compiling, understanding, and operating your knowledge.",
};

export default async function StudioPage() {
  const principal = await getPrincipal();
  if (!principal) {
    return (
      <section className="shell" style={{ paddingBlock: 120, textAlign: "center" }}>
        <p className="fmark" style={{ justifyContent: "center" }}>owner workspace</p>
        <h1 className="display" style={{ fontSize: "clamp(36px,5vw,64px)", margin: "16px 0" }}>Knowledge Studio</h1>
        <p style={{ maxWidth: 560, margin: "0 auto 28px", color: "var(--ink-2)", lineHeight: 1.6 }}>Sign in to compile, inspect, research, and operate your private knowledge.</p>
        <SignInButton mode="modal"><button className="btn primary">Sign in</button></SignInButton>
        <p style={{ marginTop: 16, fontSize: 13, color: "var(--faint)" }}><Link href="/">Return home</Link></p>
      </section>
    );
  }
  return <KnowledgeStudio />;
}
