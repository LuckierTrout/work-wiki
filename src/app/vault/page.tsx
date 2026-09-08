import Link from "next/link";
import { PrivateWorkspaceNotice } from "@/components/PrivateWorkspaceNotice";
import { getPrincipal } from "@/lib/auth";
import { listVaults } from "@/lib/vault";
import { VaultManager } from "@/components/VaultManager";

/**
 * `/vault` — the signed-in user's vault management surface: a list of their
 * named vaults (each a curated reference lens over the commons) with create /
 * rename / delete / explore. Agents live on the top-level `/agents`. Signed-out
 * visitors see only a sign-in prompt — no data is fetched or leaked.
 */
export default async function VaultPage() {
  const principal = await getPrincipal();

  if (!principal) {
    return (
      <PrivateWorkspaceNotice heading="Vaults" action="Sign in to view your vaults" />
    );
  }

  const vaults = await listVaults(principal.handle);

  return (
    <div className="fade">
      {/* Header */}
      <section className="shell paper-route" style={{ paddingTop: 56 }}>
        <p className="fmark" style={{ marginBottom: 18 }}>
          your vaults
        </p>
        <div
          className="spread"
          style={{ gap: 20, alignItems: "flex-end", flexWrap: "wrap" }}
        >
          <h1
            className="display"
            style={{ fontSize: "clamp(34px,4.6vw,58px)", margin: 0 }}
          >
            Vaults
          </h1>
          <Link
            href="/agents"
            className="receipt"
            style={{
              fontSize: 13,
              color: "var(--agent)",
              textDecoration: "none",
              paddingBottom: 8,
              whiteSpace: "nowrap",
            }}
          >
            Agents →
          </Link>
        </div>
        <p
          style={{
            color: "var(--ink-2)",
            fontSize: 18,
            lineHeight: 1.55,
            margin: "14px 0 0",
            maxWidth: "56ch",
          }}
        >
          Each vault is a curated set of live references into your wiki. Open
          one to search folders, filter file types, and read documents in place.
        </p>
      </section>

      {/* Vaults */}
      <section
        className="shell paper-route"
        style={{
          marginTop: 44,
          paddingTop: 26,
          borderTop: "1px solid var(--rule)",
        }}
      >
        <VaultManager vaults={vaults} />
      </section>
    </div>
  );
}
