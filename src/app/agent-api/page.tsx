import type { Metadata } from "next";
import { AgentApiContent } from "@/components/AgentApiContent";

// Guide for using work-wiki as an agent. The markdown lives as a static
// asset (public/agent-api.md) and is rendered client-side — NOT read from the
// filesystem on the server, which would 500 on the Cloudflare Workers runtime.
export const metadata: Metadata = {
  title: "Agent API — work-wiki",
  description:
    "How an external agent runtime uses its work-wiki credential to ingest and consume content.",
};

export default function AgentApiPage() {
  return (
    <div className="shell paper-route fade" style={{ paddingTop: 48, paddingBottom: 92 }}>
      <p className="fmark" style={{ marginBottom: 16 }}>external agent guide</p>
      <h1 className="display" style={{ fontSize: "clamp(36px,4.5vw,58px)", margin: 0 }}>Agent API</h1>
      <p style={{ color: "var(--ink-2)", fontSize: 17, margin: "11px 0 32px", maxWidth: "64ch" }}>
        Scoped credentials let external runtimes ingest, retrieve context, and run configured specialists.
      </p>
      <section style={{ maxWidth: 900, paddingTop: 26, borderTop: "1px solid var(--rule)" }}>
        <AgentApiContent />
      </section>
    </div>
  );
}
