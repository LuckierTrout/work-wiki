import Link from "next/link";
import { readLog, listWikiPages } from "@/lib/wiki";
import { canReadEntry } from "@/lib/authz";
import { getPrincipal } from "@/lib/auth";
import { ownerToTenant, type SlugTenantMap } from "@/lib/links";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";

// The production log can contain private-page references, so authorization is
// resolved for every request before those lines are rendered. Keep this route
// dynamic even when a build-time filesystem has no log yet; otherwise Next can
// classify it as static and fail when Clerk reads request cookies at runtime.
export const dynamic = "force-dynamic";

export default async function LogPage() {
  const raw = await readLog();

  // Redact log lines that mention a private page the viewer can't read — the
  // log records titles/slugs, which would otherwise leak. Skipped entirely in
  // the common case where there are no hidden pages.
  let logContent = raw;
  // slug→tenant for the log's in-content `](slug.md)` links, so they resolve to
  // the canonical `/u/<owner>/<slug>` rather than taking a DEFAULT_TENANT 308.
  //
  // Built from the READABLE half of the same listing the redaction partitions —
  // never from `buildSlugTenantMap()`, which is ungated and one call shorter.
  // Two reasons the gate is load-bearing rather than belt-and-braces:
  //
  //   - The map is derived from the SAME listing the redaction partitions, so
  //     an ungated one would contradict the redaction entry by entry: this page
  //     would hold a slug→owner pairing for exactly the pages it just stripped
  //     from the prose.
  //   - `MarkdownRenderer` carries no `"use client"` directive today, so on
  //     this server-rendered path the map stays server-side. That is a property
  //     of the renderer, not of this page — the moment it or any child of it
  //     becomes a client component, this value is serialized into the payload.
  //     The gate is what makes that change safe instead of a leak.
  const slugTenants: SlugTenantMap = {};
  if (raw) {
    const principal = await getPrincipal();
    // ONE listing, ONE `canReadEntry` pass, partitioned — the two halves are
    // complements, so re-listing or re-checking could only let them disagree.
    const hidden: Awaited<ReturnType<typeof listWikiPages>> = [];
    for (const p of await listWikiPages()) {
      if (canReadEntry(p, principal)) slugTenants[p.slug] = ownerToTenant(p.owner);
      else hidden.push(p);
    }
    if (hidden.length > 0) {
      // Match the slug in the forms the log actually uses — `](slug.md)`
      // links, `slug: <slug>` ingest details, and `"<slug>"` dedup details —
      // plus the title. Anchored forms avoid the over-redaction a bare-slug
      // substring would cause, while still covering the bare-slug detail line.
      const needles = hidden
        .flatMap((p) => [
          `${p.slug}.md`,
          `slug: ${p.slug}`,
          `"${p.slug}"`,
          p.title,
        ])
        .filter((n): n is string => Boolean(n))
        .map((n) => n.toLowerCase());
      logContent = raw
        .split("\n")
        .filter((line) => {
          const l = line.toLowerCase();
          return !needles.some((n) => l.includes(n));
        })
        .join("\n");
    }
  }

  return (
    <div className="shell paper-route fade" style={{ paddingTop: 48, paddingBottom: 92 }}>
      <div className="spread" style={{ gap: 24, alignItems: "end", marginBottom: 32 }}>
        <div>
          <p className="fmark" style={{ marginBottom: 16 }}>the trail</p>
          <h1 className="display" style={{ fontSize: "clamp(36px,4.5vw,58px)", margin: 0 }}>Activity log</h1>
          <p style={{ color: "var(--ink-2)", fontSize: 17, margin: "11px 0 0", maxWidth: "64ch" }}>
            A chronological receipt of new pages, reconciliations, revisions, and automation.
          </p>
        </div>
        <Link href="/query" className="btn ghost">
          Ask the wiki
        </Link>
      </div>

      {logContent ? (
        <article style={{ maxWidth: 900, borderTop: "1px solid var(--rule)", paddingTop: 28 }}>
          <MarkdownRenderer content={logContent} slugTenants={slugTenants} />
        </article>
      ) : (
        <p className="text-foreground/60">
          No activity logged yet. Ingest some content to see the timeline.
        </p>
      )}
    </div>
  );
}
