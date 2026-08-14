import { notFound, redirect } from "next/navigation";
import { VaultExplorer } from "@/components/VaultExplorer";
import { getPrincipal } from "@/lib/auth";
import { getVaultExplorerEntries } from "@/lib/vault-explorer";
import { listVaults } from "@/lib/vault";

interface VaultExplorerPageProps {
  params: Promise<{ id: string }>;
}

/** Owner-only document explorer for one named vault. */
export default async function VaultExplorerPage({
  params,
}: VaultExplorerPageProps) {
  const principal = await getPrincipal();
  if (!principal) redirect("/vault");

  const { id } = await params;
  const vaults = await listVaults(principal.handle);
  const vault = vaults.find((candidate) => candidate.id === id);
  if (!vault) notFound();

  const entries = await getVaultExplorerEntries(vault, principal);

  return (
    <VaultExplorer
      vault={vault}
      vaults={vaults.map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        count: candidate.slugs.length,
      }))}
      initialEntries={entries}
    />
  );
}
