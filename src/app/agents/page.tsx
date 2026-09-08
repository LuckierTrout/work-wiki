import { PrivateWorkspaceNotice } from "@/components/PrivateWorkspaceNotice";
import { getPrincipal } from "@/lib/auth";
import { listAgentsForOwner } from "@/lib/agents";
import { AgentManager } from "@/components/AgentManager";
import { AgentWorkspaceDesk } from "@/components/AgentWorkspaceDesk";

/**
 * `/agents` — the signed-in user's agent management surface: list their agents
 * with inline edit / token / delete, plus a create form. A top-level page (moved
 * off `/vault`). Signed-out visitors see only a sign-in prompt — no data
 * fetched.
 */
export default async function AgentsPage() {
  const principal = await getPrincipal();

  if (!principal) {
    return (
      <PrivateWorkspaceNotice heading="Agents" action="Sign in to view your agents" />
    );
  }

  const handle = principal.handle;
  const agents = await listAgentsForOwner(handle);

  return (
    <div className="fade">
      {/* Header */}
      <section className="shell paper-route" style={{ paddingTop: 56 }}>
        <p className="fmark" style={{ marginBottom: 18 }}>
          your agents
        </p>
        <h1
          className="display"
          style={{ fontSize: "clamp(34px,4.6vw,58px)", margin: 0 }}
        >
          Agents
        </h1>
        <p
          style={{
            color: "var(--ink-2)",
            fontSize: 18,
            lineHeight: 1.55,
            margin: "14px 0 0",
            maxWidth: "56ch",
          }}
        >
          Agents that ingest and maintain pages on your behalf.
        </p>
      </section>

      {/* Agents */}
      <section
        className="shell paper-route"
        style={{
          marginTop: 44,
          paddingTop: 26,
          borderTop: "1px solid var(--rule)",
        }}
      >
        <AgentManager handle={handle} agents={agents} />
        <AgentWorkspaceDesk />
      </section>
    </div>
  );
}
