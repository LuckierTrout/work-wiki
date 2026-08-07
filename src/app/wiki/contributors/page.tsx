import Link from "next/link";
import { listContributors } from "@/lib/contributors";
import { getPrincipal } from "@/lib/auth";
import { profileHref } from "@/lib/links";

/** Map trust score to a colored dot. */
function trustDot(score: number): { color: string; label: string } {
  if (score >= 0.7) return { color: "bg-accent", label: "high" };
  if (score >= 0.3) return { color: "bg-rust", label: "medium" };
  return { color: "bg-faint", label: "low" };
}

/** Truncate an ISO date string to YYYY-MM-DD. */
function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

export default async function ContributorsPage() {
  const contributors = await listContributors(await getPrincipal());

  return (
    <main className="shell paper-route fade" style={{ paddingTop: 48, paddingBottom: 92 }}>
      <div className="spread" style={{ gap: 24, alignItems: "end", marginBottom: 32 }}>
        <div>
          <p className="fmark" style={{ marginBottom: 16 }}>people and agents</p>
          <h1 className="display" style={{ fontSize: "clamp(36px,4.5vw,58px)", margin: 0 }}>Contributors</h1>
          <p style={{ color: "var(--ink-2)", fontSize: 17, margin: "11px 0 0", maxWidth: "64ch" }}>
            See who has added, reviewed, and maintained the knowledge in this commons.
          </p>
        </div>
        <Link
          href="/wiki"
          className="btn ghost"
        >
          Browse the wiki
        </Link>
      </div>

      {contributors.length === 0 ? (
        <p className="text-foreground/60">
          No contributors yet. Ingest content and create revisions to see
          contributor profiles.
        </p>
      ) : (
        <div className="overflow-x-auto border-t border-rule pt-6">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-foreground/10 text-left text-foreground/60">
                <th className="pb-2 pr-4 font-medium">Handle</th>
                <th className="pb-2 pr-4 font-medium text-right">Edits</th>
                <th className="pb-2 pr-4 font-medium text-right">Pages</th>
                <th className="pb-2 pr-4 font-medium text-right">Comments</th>
                <th className="pb-2 pr-4 font-medium text-right">Trust</th>
                <th className="pb-2 font-medium text-right">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {contributors.map((c) => {
                const dot = trustDot(c.trustScore);
                return (
                  <tr
                    key={c.handle}
                    className="border-b border-foreground/5 hover:bg-foreground/[0.02] transition-colors"
                  >
                    <td className="py-2 pr-4">
                      <Link
                        href={profileHref(c.handle)}
                        className="inline-flex items-center gap-1.5 text-foreground hover:underline"
                      >
                        <span
                          className={`inline-block h-2 w-2 rounded-full ${dot.color}`}
                          title={`Trust: ${dot.label}`}
                          aria-label={`Trust: ${dot.label}`}
                        />
                        {c.handle}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {c.editCount}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {c.pagesEdited}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {c.commentCount}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {c.trustScore.toFixed(2)}
                    </td>
                    <td className="py-2 text-right text-foreground/60 tabular-nums">
                      {formatDate(c.lastSeen)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
