"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { slugPath } from "@/lib/links";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { WorkspacePurposeSettings } from "@/components/WorkspacePurposeSettings";
import { LocalSyncPanel } from "@/components/LocalSyncPanel";
import type { AgentSkill } from "@/lib/agent-skills";
import type { GraphInsight } from "@/lib/graph-insights";
import type { ResearchProject } from "@/lib/research-projects";
import type { ResearchProvider } from "@/lib/research-providers";
import type { PortableArchiveInspection } from "@/lib/portable-archive";
import type { SourceContribution } from "@/lib/knowledge-compilation";

type StudioSection =
  | "setup"
  | "compile"
  | "sources"
  | "insights"
  | "research"
  | "files"
  | "skills"
  | "portability"
  | "connections";

interface Vault {
  id: string;
  name: string;
  slugs: string[];
}

interface Agent {
  id: string;
  name: string;
  description: string;
}

interface IngestJob {
  id: string;
  url?: string;
  title?: string;
  slug?: string;
  status: string;
  createdAt?: string;
}

interface Proposal {
  id: string;
  title: string;
  summary?: string;
  targetSlug?: string;
  risk?: string;
}

interface SourceResult {
  id: string;
  pageSlug: string;
  pageTitle: string;
  sourceType: string;
  sourceUrl?: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  href: string;
  citation: string;
}

interface Evidence {
  eyebrow: string;
  title: string;
  body: string;
  href?: string;
  hrefLabel?: string;
  signals?: string[];
}

const SECTIONS: Array<{
  id: StudioSection;
  label: string;
  group: "Build" | "Understand" | "Operate";
  description: string;
}> = [
  { id: "setup", label: "Purpose & vaults", group: "Build", description: "Set direction and containers" },
  { id: "compile", label: "Compile", group: "Build", description: "Source-to-knowledge pipeline" },
  { id: "sources", label: "Original sources", group: "Understand", description: "Search unaltered evidence" },
  { id: "insights", label: "Graph insights", group: "Understand", description: "Find gaps and bridges" },
  { id: "research", label: "Research desk", group: "Understand", description: "Plan, collect, synthesize" },
  { id: "files", label: "Files & vaults", group: "Operate", description: "Browse organized material" },
  { id: "skills", label: "Agent skills", group: "Operate", description: "Reusable agent instructions" },
  { id: "portability", label: "Portability", group: "Operate", description: "Export or restore knowledge" },
  { id: "connections", label: "Connections", group: "Operate", description: "Capture and automation entry points" },
];

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function parseLines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function shortDate(value?: string): string {
  if (!value) return "recently";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "recently" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function StatusPill({ children }: { children: React.ReactNode }) {
  return <span className="studio-status">{children}</span>;
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="studio-empty">
      <p className="studio-empty-title">{title}</p>
      <p>{body}</p>
      {action ? <div className="studio-empty-action">{action}</div> : null}
    </div>
  );
}

export function KnowledgeStudio() {
  const [section, setSection] = useState<StudioSection>("compile");
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [jobs, setJobs] = useState<IngestJob[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [insights, setInsights] = useState<GraphInsight[]>([]);
  const [projects, setProjects] = useState<ResearchProject[]>([]);
  const [researchProviders, setResearchProviders] = useState<ResearchProvider[]>([]);
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [contributions, setContributions] = useState<SourceContribution[]>([]);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [vaultData, agentData, jobData, proposalData, insightData, projectData, skillData, compilationData] = await Promise.all([
        requestJson<{ vaults: Vault[] }>("/api/vaults"),
        requestJson<{ agents: Agent[] }>("/api/agents?mine=1"),
        requestJson<{ jobs: IngestJob[] }>("/api/ingest/jobs?limit=16"),
        requestJson<{ proposals: Proposal[] }>("/api/review/proposals?status=pending"),
        requestJson<{ insights: GraphInsight[] }>("/api/knowledge/insights?scope=mine"),
        requestJson<{ projects: ResearchProject[]; availableProviders?: ResearchProvider[] }>("/api/research"),
        requestJson<{ skills: AgentSkill[] }>("/api/agent-skills"),
        requestJson<{ contributions: SourceContribution[] }>("/api/knowledge/compilation"),
      ]);
      setVaults(vaultData.vaults);
      setAgents(agentData.agents);
      setJobs(jobData.jobs);
      setProposals(proposalData.proposals);
      setInsights(insightData.insights);
      setProjects(projectData.projects);
      setResearchProviders(projectData.availableProviders ?? []);
      setSkills(skillData.skills);
      setContributions(compilationData.contributions);
    } catch (error) {
      setFeedback({ ok: false, message: error instanceof Error ? error.message : "Couldn’t load the studio." });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pipeline = useMemo(() => ({
    sources: jobs.length,
    analysis: jobs.filter((job) => ["queued", "running", "processing"].includes(job.status)).length,
    review: proposals.length,
    accepted: jobs.filter((job) => ["done", "completed", "succeeded"].includes(job.status)).length,
  }), [jobs, proposals]);

  function openSection(next: StudioSection) {
    setSection(next);
    setFeedback(null);
  }

  return (
    <div className="knowledge-studio">
      <aside className="studio-nav" aria-label="Knowledge Studio sections">
        <div className="studio-nav-heading">
          <p className="fmark">Owner workspace</p>
          <h1 className="display">Knowledge Studio</h1>
          <p>Build, inspect, and operate your private memory.</p>
        </div>
        {(["Build", "Understand", "Operate"] as const).map((group) => (
          <div className="studio-nav-group" key={group}>
            <p className="receipt">{group}</p>
            {SECTIONS.filter((item) => item.group === group).map((item) => (
              <button
                type="button"
                key={item.id}
                className="studio-nav-item"
                aria-current={section === item.id ? "page" : undefined}
                onClick={() => openSection(item.id)}
              >
                <span>{item.label}</span>
                <small>{item.description}</small>
              </button>
            ))}
          </div>
        ))}
      </aside>

      <main className="studio-main">
        <header className="studio-main-header">
          <div>
            <p className="receipt">{SECTIONS.find((item) => item.id === section)?.group}</p>
            <h2 className="display">{SECTIONS.find((item) => item.id === section)?.label}</h2>
          </div>
          <button type="button" className="btn ghost" onClick={() => void refresh()} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </header>

        {feedback ? (
          <div className={feedback.ok ? "studio-feedback success" : "studio-feedback error"} role="status">
            {feedback.message}
          </div>
        ) : null}

        {section === "setup" ? (
          <SetupPanel vaults={vaults} setVaults={setVaults} setFeedback={setFeedback} />
        ) : null}
        {section === "compile" ? (
          <CompilePanel jobs={jobs} proposals={proposals} contributions={contributions} onEvidence={setEvidence} />
        ) : null}
        {section === "sources" ? (
          <SourcesPanel vaults={vaults} onEvidence={setEvidence} />
        ) : null}
        {section === "insights" ? (
          <InsightsPanel
            insights={insights}
            onEvidence={setEvidence}
            onProject={(project) => {
              setProjects((current) => [project, ...current]);
              setSection("research");
            }}
            setFeedback={setFeedback}
          />
        ) : null}
        {section === "research" ? (
          <ResearchPanel
            projects={projects}
            providers={researchProviders}
            vaults={vaults}
            setProjects={setProjects}
            onEvidence={setEvidence}
            setFeedback={setFeedback}
          />
        ) : null}
        {section === "files" ? <FilesPanel vaults={vaults} jobs={jobs} /> : null}
        {section === "skills" ? (
          <SkillsPanel
            skills={skills}
            agents={agents}
            setSkills={setSkills}
            onEvidence={setEvidence}
            setFeedback={setFeedback}
          />
        ) : null}
        {section === "portability" ? <PortabilityPanel setFeedback={setFeedback} /> : null}
        {section === "connections" ? <ConnectionsPanel vaults={vaults} /> : null}
      </main>

      <aside className="studio-evidence" aria-label="Evidence and actions">
        <div className="studio-evidence-heading">
          <p className="receipt">Evidence rail</p>
          <h2>Source → decision</h2>
        </div>
        <ol className="studio-pipeline">
          <li><span>1</span><div><strong>Sources</strong><small>{pipeline.sources} recent inputs</small></div></li>
          <li><span>2</span><div><strong>Analysis</strong><small>{pipeline.analysis} active</small></div></li>
          <li><span>3</span><div><strong>Review</strong><small>{pipeline.review} awaiting you</small></div></li>
          <li><span>4</span><div><strong>Knowledge</strong><small>{pipeline.accepted} compiled</small></div></li>
        </ol>
        <div className="studio-evidence-detail">
          {evidence ? (
            <>
              <p className="receipt">{evidence.eyebrow}</p>
              <h3>{evidence.title}</h3>
              <p>{evidence.body}</p>
              {evidence.signals?.length ? (
                <ul>{evidence.signals.map((signal) => <li key={signal}>{signal}</li>)}</ul>
              ) : null}
              {evidence.href ? <Link href={evidence.href}>{evidence.hrefLabel || "Open evidence"} →</Link> : null}
            </>
          ) : (
            <>
              <p className="receipt">Nothing selected</p>
              <h3>Inspect before acting</h3>
              <p>Select a source result, graph insight, research project, or agent skill to keep the underlying evidence visible while you work.</p>
            </>
          )}
        </div>
        <div className="studio-quick-links">
          <p className="receipt">Direct routes</p>
          <Link href="/review">Review proposals <span>→</span></Link>
          <Link href="/wiki/graph">Open graph <span>→</span></Link>
          <Link href="/tasks">Open to-do <span>→</span></Link>
        </div>
      </aside>
    </div>
  );
}

function SetupPanel({
  vaults,
  setVaults,
  setFeedback,
}: {
  vaults: Vault[];
  setVaults: React.Dispatch<React.SetStateAction<Vault[]>>;
  setFeedback: React.Dispatch<React.SetStateAction<{ ok: boolean; message: string } | null>>;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  async function createVault(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const data = await requestJson<{ vault: Vault }>("/api/vaults", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      setVaults((current) => current.some((vault) => vault.id === data.vault.id) ? current : [...current, data.vault]);
      setName("");
      setFeedback({ ok: true, message: `Vault “${data.vault.name}” is ready.` });
    } catch (error) {
      setFeedback({ ok: false, message: error instanceof Error ? error.message : "Couldn’t create the vault." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="studio-panel-stack">
      <section className="studio-intro">
        <p className="studio-kicker">Start with intent</p>
        <h3>Tell the system what deserves to become memory.</h3>
        <p>Purpose, scope, vocabulary, and output language guide every new ingest, answer, digest, extraction, and agent run.</p>
      </section>
      <div className="studio-embedded-settings"><WorkspacePurposeSettings /></div>
      <section className="studio-section-block">
        <div className="studio-section-heading">
          <div><p className="receipt">Containers</p><h3>Vaults</h3></div>
          <Link href="/vault">Open file explorer →</Link>
        </div>
        <form className="studio-inline-form" onSubmit={createVault}>
          <label><span>New vault name</span><input className="studio-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Client research" required /></label>
          <button className="btn primary" disabled={saving}>{saving ? "Creating…" : "Create vault"}</button>
        </form>
        <div className="studio-row-list">
          {vaults.map((vault) => (
            <Link href={`/vault/${encodeURIComponent(vault.id)}`} className="studio-row" key={vault.id}>
              <div><strong>{vault.name}</strong><small>{vault.slugs.length} documents</small></div><span>Open →</span>
            </Link>
          ))}
          {vaults.length === 0 ? <EmptyState title="No vaults yet" body="Create one to keep a research project or body of work together." /> : null}
        </div>
      </section>
    </div>
  );
}

function CompilePanel({ jobs, proposals, contributions, onEvidence }: { jobs: IngestJob[]; proposals: Proposal[]; contributions: SourceContribution[]; onEvidence: (value: Evidence) => void }) {
  return (
    <div className="studio-panel-stack">
      <section className="studio-intro">
        <p className="studio-kicker">Compile queue</p>
        <h3>Turn incoming material into reviewed, connected knowledge.</h3>
        <p>Every item stays traceable from its original source through processing and owner acceptance.</p>
        <div className="studio-action-row"><Link className="btn primary" href="/ingest">Add material</Link><Link className="btn ghost" href="/review">Review changes</Link></div>
      </section>
      <div className="studio-metrics">
        <div><span>{jobs.length}</span><small>Recent sources</small></div>
        <div><span>{jobs.filter((job) => !["done", "completed", "succeeded", "failed"].includes(job.status)).length}</span><small>Processing</small></div>
        <div><span>{proposals.length}</span><small>Need review</small></div>
        <div><span>{contributions.length}</span><small>Source contributions</small></div>
      </div>
      <section className="studio-section-block">
        <div className="studio-section-heading"><div><p className="receipt">Contribution ledger</p><h3>Source-to-page lineage</h3></div></div>
        <div className="studio-row-list">
          {contributions.slice(0, 8).map((contribution) => (
            <button className="studio-row" type="button" key={contribution.id} onClick={() => onEvidence({
              eyebrow: contribution.sourceType,
              title: contribution.pageSlug,
              body: contribution.sourceUrl,
              href: slugPath(contribution.pageSlug),
              hrefLabel: "Open compiled page",
              signals: [`${contribution.structuredRecordIds.length} records`, `${contribution.structuredRelationIds.length} relations`, shortDate(contribution.observedAt)],
            })}>
              <div><strong>{contribution.pageSlug}</strong><small>{contribution.sourceUrl}</small></div><StatusPill>{contribution.sourceType}</StatusPill>
            </button>
          ))}
          {contributions.length === 0 ? <EmptyState title="No compiled contributions yet" body="After ingest, source-to-page and structured-knowledge lineage will appear here." /> : null}
        </div>
      </section>
      <section className="studio-section-block">
        <div className="studio-section-heading"><div><p className="receipt">Latest activity</p><h3>Source queue</h3></div><Link href="/ingest">Full ingest history →</Link></div>
        <div className="studio-row-list">
          {jobs.slice(0, 10).map((job) => (
            <button className="studio-row" type="button" key={job.id} onClick={() => onEvidence({
              eyebrow: "Ingest source",
              title: job.title || job.slug || job.url || "Incoming source",
              body: `This source is ${job.status}. Open ingest history for its complete processing record.`,
              href: "/ingest",
              hrefLabel: "Open ingest history",
              signals: [job.status, shortDate(job.createdAt)],
            })}>
              <div><strong>{job.title || job.slug || job.url || "Incoming source"}</strong><small>{shortDate(job.createdAt)}</small></div><StatusPill>{job.status}</StatusPill>
            </button>
          ))}
          {jobs.length === 0 ? <EmptyState title="The queue is clear" body="Add a document, URL, or email to begin compiling knowledge." action={<Link className="btn primary" href="/ingest">Add material</Link>} /> : null}
        </div>
      </section>
      <section className="studio-section-block">
        <div className="studio-section-heading"><div><p className="receipt">Owner gate</p><h3>Pending knowledge changes</h3></div><Link href="/review">Open review desk →</Link></div>
        <div className="studio-row-list">
          {proposals.slice(0, 6).map((proposal) => (
            <button className="studio-row" type="button" key={proposal.id} onClick={() => onEvidence({
              eyebrow: "Review proposal",
              title: proposal.title,
              body: proposal.summary || "This proposed memory change requires owner acceptance before it can alter the wiki.",
              href: "/review",
              hrefLabel: "Inspect proposal",
              signals: [proposal.risk ? `${proposal.risk} risk` : "owner approval required", proposal.targetSlug || "new knowledge"],
            })}>
              <div><strong>{proposal.title}</strong><small>{proposal.summary || proposal.targetSlug || "Knowledge proposal"}</small></div><StatusPill>{proposal.risk || "review"}</StatusPill>
            </button>
          ))}
          {proposals.length === 0 ? <EmptyState title="Nothing is waiting" body="Agent and extraction proposals will appear here before they change memory." /> : null}
        </div>
      </section>
    </div>
  );
}

function SourcesPanel({ vaults, onEvidence }: { vaults: Vault[]; onEvidence: (value: Evidence) => void }) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("mine");
  const [results, setResults] = useState<SourceResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search(event: React.FormEvent) {
    event.preventDefault();
    setSearching(true);
    setError(null);
    try {
      const params = new URLSearchParams({ q: query, scope });
      const data = await requestJson<{ results: SourceResult[] }>(`/api/sources/search?${params}`);
      setResults(data.results);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Source search failed.");
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="studio-panel-stack">
      <section className="studio-intro">
        <p className="studio-kicker">Source-only search</p>
        <h3>Search what was actually said, before synthesis.</h3>
        <p>Results come from stored originals with line-level citations—not generated pages or agent artifacts.</p>
      </section>
      <form className="studio-search-form" onSubmit={search}>
        <input className="studio-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search original documents…" required />
        <select className="studio-input" value={scope} onChange={(event) => setScope(event.target.value)}>
          <option value="mine">All my knowledge</option>
          {vaults.map((vault) => <option value={`vault:${vault.id}`} key={vault.id}>{vault.name}</option>)}
        </select>
        <button className="btn primary" disabled={searching}>{searching ? "Searching…" : "Search sources"}</button>
      </form>
      {error ? <div className="studio-feedback error">{error}</div> : null}
      <div className="studio-source-results">
        {results.map((result) => (
          <article className="studio-source-result" key={result.id}>
            <button type="button" onClick={() => onEvidence({
              eyebrow: `${result.sourceType} · lines ${result.startLine}–${result.endLine}`,
              title: result.pageTitle,
              body: result.excerpt,
              href: result.href,
              hrefLabel: "Open cited original",
              signals: [result.citation, result.sourceUrl || result.pageSlug],
            })}>
              <div><StatusPill>{result.sourceType}</StatusPill><small>lines {result.startLine}–{result.endLine}</small></div>
              <h3>{result.pageTitle}</h3>
              <p>{result.excerpt}</p>
              <span>{result.citation}</span>
            </button>
          </article>
        ))}
        {results.length === 0 ? <EmptyState title="Search the originals" body="Try a person, phrase, decision, or project. Name and term aliases are applied automatically." /> : null}
      </div>
    </div>
  );
}

function InsightsPanel({
  insights,
  onEvidence,
  onProject,
  setFeedback,
}: {
  insights: GraphInsight[];
  onEvidence: (value: Evidence) => void;
  onProject: (project: ResearchProject) => void;
  setFeedback: React.Dispatch<React.SetStateAction<{ ok: boolean; message: string } | null>>;
}) {
  const [creating, setCreating] = useState<string | null>(null);

  async function research(insight: GraphInsight) {
    setCreating(insight.id);
    try {
      const data = await requestJson<{ project: ResearchProject }>("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: insight.title,
          question: `Investigate this knowledge-graph signal: ${insight.summary} What evidence explains the relationship, gap, or risk, and what should be added to the workspace?`,
          pageSlugs: insight.slugs,
          queries: insight.signals,
        }),
      });
      setFeedback({ ok: true, message: "Research brief created from this graph signal." });
      onProject(data.project);
    } catch (error) {
      setFeedback({ ok: false, message: error instanceof Error ? error.message : "Couldn’t create the research brief." });
    } finally {
      setCreating(null);
    }
  }

  return (
    <div className="studio-panel-stack">
      <section className="studio-intro">
        <p className="studio-kicker">Structural intelligence</p>
        <h3>Find what is disconnected, fragile, or surprisingly related.</h3>
        <p>These signals are derived from the current link graph and tags. They suggest where to investigate; they do not rewrite knowledge.</p>
        <div className="studio-action-row"><Link className="btn primary" href="/wiki/graph">Open interactive graph</Link><Link className="btn ghost" href="/knowledge">Knowledge extraction</Link></div>
      </section>
      <div className="studio-insight-list">
        {insights.map((insight) => (
          <article className="studio-insight" key={insight.id}>
            <button type="button" className="studio-insight-body" onClick={() => onEvidence({
              eyebrow: insight.kind.replace("-", " "),
              title: insight.title,
              body: insight.summary,
              href: "/wiki/graph",
              hrefLabel: "Inspect in graph",
              signals: insight.signals,
            })}>
              <div><StatusPill>{insight.kind.replace("-", " ")}</StatusPill><span>Priority {insight.priority}</span></div>
              <h3>{insight.title}</h3>
              <p>{insight.summary}</p>
              <small>{insight.slugs.slice(0, 4).join(" · ")}</small>
            </button>
            <button type="button" className="studio-text-button" onClick={() => void research(insight)} disabled={creating === insight.id}>
              {creating === insight.id ? "Creating…" : "Research this →"}
            </button>
          </article>
        ))}
        {insights.length === 0 ? <EmptyState title="No structural alerts" body="As your graph grows, disconnected pages, bridge pages, and missing relationships will appear here." action={<Link className="btn ghost" href="/wiki/graph">Open graph</Link>} /> : null}
      </div>
    </div>
  );
}

function ResearchPanel({
  projects,
  providers,
  vaults,
  setProjects,
  onEvidence,
  setFeedback,
}: {
  projects: ResearchProject[];
  providers: ResearchProvider[];
  vaults: Vault[];
  setProjects: React.Dispatch<React.SetStateAction<ResearchProject[]>>;
  onEvidence: (value: Evidence) => void;
  setFeedback: React.Dispatch<React.SetStateAction<{ ok: boolean; message: string } | null>>;
}) {
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [queries, setQueries] = useState("");
  const [sourceUrls, setSourceUrls] = useState("");
  const [vaultId, setVaultId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [provider, setProvider] = useState<ResearchProvider | "">(providers[0] ?? "");

  useEffect(() => {
    if (!provider && providers[0]) setProvider(providers[0]);
  }, [provider, providers]);

  useEffect(() => {
    const active = projects.filter((project) => ["queued", "collecting", "ready"].includes(project.status));
    if (active.length === 0) return;
    const timer = window.setInterval(() => {
      void Promise.all(active.map(async (project) => {
        try {
          const data = await requestJson<{ project: ResearchProject }>(`/api/research/${encodeURIComponent(project.id)}/run`);
          setProjects((current) => current.map((item) => item.id === project.id ? data.project : item));
        } catch { /* The visible status remains stable until the next refresh. */ }
      }));
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [projects, setProjects]);

  async function createProject(event: React.FormEvent) {
    event.preventDefault();
    setBusy("create");
    try {
      const data = await requestJson<{ project: ResearchProject }>("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, question, queries: parseLines(queries), sourceUrls: parseLines(sourceUrls), ...(vaultId ? { vaultId } : {}) }),
      });
      setProjects((current) => [data.project, ...current]);
      setTitle(""); setQuestion(""); setQueries(""); setSourceUrls(""); setVaultId("");
      setFeedback({ ok: true, message: "Research brief saved." });
    } catch (error) {
      setFeedback({ ok: false, message: error instanceof Error ? error.message : "Couldn’t create the research brief." });
    } finally {
      setBusy(null);
    }
  }

  async function patchProject(id: string, patch: Record<string, unknown>) {
    const data = await requestJson<{ project: ResearchProject }>(`/api/research/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    setProjects((current) => current.map((project) => project.id === id ? data.project : project));
    return data.project;
  }

  async function collect(project: ResearchProject) {
    if (project.sourceUrls.length === 0) {
      setFeedback({ ok: false, message: "Add at least one source URL to this brief before collecting." });
      return;
    }
    setBusy(`collect:${project.id}`);
    try {
      await requestJson("/api/ingest/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: project.sourceUrls, ...(project.vaultId ? { vaultId: project.vaultId } : {}) }),
      });
      await patchProject(project.id, { status: "collecting" });
      setFeedback({ ok: true, message: `${project.sourceUrls.length} research source${project.sourceUrls.length === 1 ? " is" : "s are"} entering the ingest pipeline.` });
    } catch (error) {
      setFeedback({ ok: false, message: error instanceof Error ? error.message : "Couldn’t collect the research sources." });
    } finally {
      setBusy(null);
    }
  }

  async function runAutomated(project: ResearchProject) {
    setBusy(`run:${project.id}`);
    try {
      const data = await requestJson<{ project: ResearchProject }>(`/api/research/${encodeURIComponent(project.id)}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(provider ? { provider } : {}) }),
      });
      setProjects((current) => current.map((item) => item.id === project.id ? data.project : item));
      setFeedback({ ok: true, message: data.project.status === "complete" ? "Research draft is ready in Review." : "Automated research started." });
    } catch (error) {
      setFeedback({ ok: false, message: error instanceof Error ? error.message : "Couldn’t start automated research." });
    } finally {
      setBusy(null);
    }
  }

  async function cancel(project: ResearchProject) {
    setBusy(`cancel:${project.id}`);
    try {
      const data = await requestJson<{ project: ResearchProject }>(`/api/research/${encodeURIComponent(project.id)}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
      setProjects((current) => current.map((item) => item.id === project.id ? data.project : item));
      setFeedback({ ok: true, message: "Research cancellation requested." });
    } catch (error) {
      setFeedback({ ok: false, message: error instanceof Error ? error.message : "Couldn’t cancel research." });
    } finally {
      setBusy(null);
    }
  }

  async function synthesize(project: ResearchProject) {
    setBusy(`synthesize:${project.id}`);
    try {
      const result = await requestJson<{ answer: string }>("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: project.question, format: "prose", scope: project.vaultId ? `vault:${project.vaultId}` : "mine" }),
      });
      await patchProject(project.id, { status: "complete", synthesis: result.answer });
      setFeedback({ ok: true, message: "Research synthesis saved to the brief with the query citations." });
    } catch (error) {
      setFeedback({ ok: false, message: error instanceof Error ? error.message : "Couldn’t synthesize the research brief." });
    } finally {
      setBusy(null);
    }
  }

  async function remove(project: ResearchProject) {
    if (!window.confirm(`Delete the research brief “${project.title}”? This does not delete ingested sources.`)) return;
    setBusy(`delete:${project.id}`);
    try {
      await requestJson(`/api/research/${encodeURIComponent(project.id)}`, { method: "DELETE" });
      setProjects((current) => current.filter((item) => item.id !== project.id));
      setFeedback({ ok: true, message: "Research brief deleted. Its source documents were left untouched." });
    } catch (error) {
      setFeedback({ ok: false, message: error instanceof Error ? error.message : "Couldn’t delete the research brief." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="studio-panel-stack">
      <section className="studio-intro">
        <p className="studio-kicker">Directed research</p>
        <h3>Plan the question, collect the corpus, then synthesize with citations.</h3>
        <p>Research briefs persist independently from chat, so the question, source plan, scope, and final synthesis stay together.</p>
        <div className="studio-action-row">
          <label><span className="receipt">Automated provider</span><select className="studio-input" value={provider} onChange={(event) => setProvider(event.target.value as ResearchProvider | "")}><option value="">Use configured default</option>{providers.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          {providers.length === 0 ? <small>No web-research provider is configured. Manual URL collection still works.</small> : null}
        </div>
      </section>
      <form className="studio-form-grid" onSubmit={createProject}>
        <label><span>Brief title</span><input className="studio-input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Vendor landscape" required /></label>
        <label><span>Vault scope</span><select className="studio-input" value={vaultId} onChange={(event) => setVaultId(event.target.value)}><option value="">All my knowledge</option>{vaults.map((vault) => <option key={vault.id} value={vault.id}>{vault.name}</option>)}</select></label>
        <label className="wide"><span>Research question</span><textarea className="studio-input" rows={3} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="What decision should this research inform?" required /></label>
        <label><span>Search prompts · one per line</span><textarea className="studio-input" rows={4} value={queries} onChange={(event) => setQueries(event.target.value)} placeholder="Key competitors\nPricing signals" /></label>
        <label><span>Source URLs · one per line</span><textarea className="studio-input" rows={4} value={sourceUrls} onChange={(event) => setSourceUrls(event.target.value)} placeholder="https://example.com/report" /></label>
        <div className="wide studio-form-submit"><button className="btn primary" disabled={busy === "create"}>{busy === "create" ? "Saving…" : "Create research brief"}</button></div>
      </form>
      <div className="studio-project-list">
        {projects.map((project) => (
          <article className="studio-project" key={project.id}>
            <button type="button" className="studio-project-heading" onClick={() => onEvidence({
              eyebrow: `Research · ${project.status}`,
              title: project.title,
              body: project.question,
              signals: [`${project.sourceUrls.length} planned sources`, `${project.pageSlugs.length} linked pages`, project.vaultId ? "vault scoped" : "all owner knowledge"],
            })}>
              <div><StatusPill>{project.status}</StatusPill><small>Updated {shortDate(project.updatedAt)}</small></div>
              <h3>{project.title}</h3><p>{project.question}</p>
            </button>
            <div className="studio-project-actions">
              <button className="btn primary" type="button" onClick={() => void runAutomated(project)} disabled={busy !== null || providers.length === 0 || ["queued", "collecting", "ready"].includes(project.status)}>{busy === `run:${project.id}` ? "Starting…" : project.status === "failed" || project.status === "cancelled" ? "Retry research" : "Run research"}</button>
              {["queued", "collecting", "ready"].includes(project.status) ? <button className="btn ghost" type="button" onClick={() => void cancel(project)} disabled={busy !== null}>{busy === `cancel:${project.id}` ? "Cancelling…" : "Cancel"}</button> : null}
              <button className="btn ghost" type="button" onClick={() => void collect(project)} disabled={busy !== null}>{busy === `collect:${project.id}` ? "Collecting…" : `Collect ${project.sourceUrls.length} URLs`}</button>
              <button className="btn primary" type="button" onClick={() => void synthesize(project)} disabled={busy !== null}>{busy === `synthesize:${project.id}` ? "Synthesizing…" : "Synthesize"}</button>
              <button className="studio-danger-button" type="button" onClick={() => void remove(project)} disabled={busy !== null}>Delete</button>
            </div>
            {project.progress ? <div className="studio-note"><strong>{project.progress.completedQueries}/{project.progress.totalQueries} searches</strong><span>{project.progress.message}</span></div> : null}
            {project.error ? <div className="studio-feedback error">{project.error}</div> : null}
            {project.results?.length ? <details className="studio-synthesis"><summary>{project.results.length} collected sources</summary><ol>{project.results.map((result) => <li key={result.url}><a href={result.url} target="_blank" rel="noreferrer">{result.title}</a><small>{result.query}</small></li>)}</ol></details> : null}
            {project.proposalId ? <div className="studio-action-row"><Link className="btn primary" href="/review">Review research draft</Link></div> : null}
            {project.synthesis ? <div className="studio-synthesis"><p className="receipt">Saved synthesis</p><MarkdownRenderer content={project.synthesis} /></div> : null}
          </article>
        ))}
        {projects.length === 0 ? <EmptyState title="No research briefs" body="Create one here, or turn a graph insight into a prefilled investigation." /> : null}
      </div>
    </div>
  );
}

function FilesPanel({ vaults, jobs }: { vaults: Vault[]; jobs: IngestJob[] }) {
  return (
    <div className="studio-panel-stack">
      <section className="studio-intro"><p className="studio-kicker">Organized originals</p><h3>Browse by vault, then open the compiled page or stored original.</h3><p>The existing file explorer remains the detailed document browser; this desk shows the shape and recent movement of your collection.</p><div className="studio-action-row"><Link className="btn primary" href="/vault">Open file explorer</Link><Link className="btn ghost" href="/ingest">Bulk import</Link></div></section>
      <div className="studio-file-grid">
        {vaults.map((vault) => <Link href={`/vault/${encodeURIComponent(vault.id)}`} key={vault.id}><span>{vault.slugs.length}</span><h3>{vault.name}</h3><p>{vault.slugs.length === 1 ? "document" : "documents"}</p><small>Browse vault →</small></Link>)}
        {vaults.length === 0 ? <EmptyState title="No folders yet" body="Create a vault in Purpose & vaults, then file material during ingest." /> : null}
      </div>
      <section className="studio-section-block"><div className="studio-section-heading"><div><p className="receipt">Recent movement</p><h3>Incoming files</h3></div><Link href="/ingest">Manage imports →</Link></div><div className="studio-row-list">{jobs.slice(0, 8).map((job) => <Link href="/ingest" className="studio-row" key={job.id}><div><strong>{job.title || job.slug || job.url || "Imported material"}</strong><small>{shortDate(job.createdAt)}</small></div><StatusPill>{job.status}</StatusPill></Link>)}</div></section>
    </div>
  );
}

function SkillsPanel({
  skills,
  agents,
  setSkills,
  onEvidence,
  setFeedback,
}: {
  skills: AgentSkill[];
  agents: Agent[];
  setSkills: React.Dispatch<React.SetStateAction<AgentSkill[]>>;
  onEvidence: (value: Evidence) => void;
  setFeedback: React.Dispatch<React.SetStateAction<{ ok: boolean; message: string } | null>>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy("create");
    try {
      const data = await requestJson<{ skill: AgentSkill }>("/api/agent-skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, instructions, agentIds }),
      });
      setSkills((current) => [data.skill, ...current]);
      setName(""); setDescription(""); setInstructions(""); setAgentIds([]);
      setFeedback({ ok: true, message: "Skill saved and assigned. It will be applied on the selected agents’ next runs." });
    } catch (error) {
      setFeedback({ ok: false, message: error instanceof Error ? error.message : "Couldn’t create the skill." });
    } finally {
      setBusy(null);
    }
  }

  async function patchSkill(skill: AgentSkill, patch: Record<string, unknown>) {
    setBusy(skill.id);
    try {
      const data = await requestJson<{ skill: AgentSkill }>(`/api/agent-skills/${encodeURIComponent(skill.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      setSkills((current) => current.map((item) => item.id === skill.id ? data.skill : item));
      setFeedback({ ok: true, message: `Skill “${data.skill.name}” updated.` });
    } catch (error) {
      setFeedback({ ok: false, message: error instanceof Error ? error.message : "Couldn’t update the skill." });
    } finally {
      setBusy(null);
    }
  }

  async function remove(skill: AgentSkill) {
    if (!window.confirm(`Delete the skill “${skill.name}”? Assigned agents will stop receiving it.`)) return;
    setBusy(skill.id);
    try {
      await requestJson(`/api/agent-skills/${encodeURIComponent(skill.id)}`, { method: "DELETE" });
      setSkills((current) => current.filter((item) => item.id !== skill.id));
      setFeedback({ ok: true, message: "Skill deleted." });
    } catch (error) {
      setFeedback({ ok: false, message: error instanceof Error ? error.message : "Couldn’t delete the skill." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="studio-panel-stack">
      <section className="studio-intro"><p className="studio-kicker">Reusable craft</p><h3>Teach agents repeatable ways of working.</h3><p>Skills are owner-authored instruction blocks. They are injected only into assigned agents and never grant new tools or permissions.</p><div className="studio-action-row"><Link className="btn ghost" href="/agents">Manage agents</Link></div></section>
      <form className="studio-form-grid" onSubmit={create}>
        <label><span>Skill name</span><input className="studio-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Decision extractor" required /></label>
        <label><span>Description</span><input className="studio-input" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="How this skill should be used" /></label>
        <label className="wide"><span>Instructions</span><textarea className="studio-input" rows={6} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Identify explicit decisions, preserve wording, cite the source, and propose uncertain items for review…" required /></label>
        <fieldset className="wide studio-agent-picker"><legend>Assign to agents</legend>{agents.map((agent) => <label key={agent.id}><input type="checkbox" checked={agentIds.includes(agent.id)} onChange={(event) => setAgentIds((current) => event.target.checked ? [...current, agent.id] : current.filter((id) => id !== agent.id))} /><span><strong>{agent.name}</strong><small>{agent.description}</small></span></label>)}{agents.length === 0 ? <p>Create an agent first, then return to assign this skill.</p> : null}</fieldset>
        <div className="wide studio-form-submit"><button className="btn primary" disabled={busy === "create"}>{busy === "create" ? "Saving…" : "Save skill"}</button></div>
      </form>
      <div className="studio-skill-list">
        {skills.map((skill) => (
          <article className="studio-skill" key={skill.id}>
            <button type="button" className="studio-skill-body" onClick={() => onEvidence({ eyebrow: skill.enabled ? "Active agent skill" : "Paused agent skill", title: skill.name, body: skill.instructions, signals: [`${skill.agentIds.length} assigned agents`, skill.description || "No description"] })}>
              <div><StatusPill>{skill.enabled ? "active" : "paused"}</StatusPill><small>{skill.agentIds.length} agents</small></div><h3>{skill.name}</h3><p>{skill.description || skill.instructions}</p>
            </button>
            <div className="studio-skill-actions"><button type="button" className="studio-text-button" disabled={busy === skill.id} onClick={() => void patchSkill(skill, { enabled: !skill.enabled })}>{skill.enabled ? "Pause" : "Enable"}</button><button type="button" className="studio-danger-button" disabled={busy === skill.id} onClick={() => void remove(skill)}>Delete</button></div>
          </article>
        ))}
        {skills.length === 0 ? <EmptyState title="No reusable skills" body="Create one above to give selected agents a consistent method for a recurring job." /> : null}
      </div>
    </div>
  );
}

function PortabilityPanel({ setFeedback }: { setFeedback: React.Dispatch<React.SetStateAction<{ ok: boolean; message: string } | null>> }) {
  const [archive, setArchive] = useState<File | null>(null);
  const [inspection, setInspection] = useState<PortableArchiveInspection | null>(null);
  const [collision, setCollision] = useState<"skip" | "overwrite">("skip");
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);

  async function send(action: "preview" | "import") {
    if (!archive) return;
    setBusy(action);
    try {
      const response = await fetch(`/api/archive/import?action=${action}&collision=${collision}`, {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: archive,
      });
      const data = await response.json() as { inspection?: PortableArchiveInspection; result?: PortableArchiveInspection & { imported: number; skipped: number }; error?: string };
      if (!response.ok) throw new Error(data.error || `Archive ${action} failed`);
      if (data.inspection) setInspection(data.inspection);
      if (data.result) {
        setInspection(data.result);
        setFeedback({ ok: true, message: `Restored ${data.result.imported} files; skipped ${data.result.skipped}. Derived indexes were rebuilt.` });
      }
    } catch (error) {
      setFeedback({ ok: false, message: error instanceof Error ? error.message : `Archive ${action} failed.` });
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="studio-panel-stack">
      <section className="studio-intro"><p className="studio-kicker">Your knowledge, portable</p><h3>Take a full copy out—or bring one back.</h3><p>Exports are generated from your signed-in owner scope. Imports enter the same reviewable ingest pipeline as other material.</p></section>
      <div className="studio-portability">
        <section><p className="receipt">Export</p><h3>Download the complete owner archive</h3><p>Includes wiki pages, source snapshots, vaults, tasks, agents, reviews, and owner indexes with checksums.</p><a className="btn primary" href="/api/archive/export" download>Download full archive</a></section>
        <section><p className="receipt">Restore</p><h3>Preview before writing</h3><p>Checksums and safe paths are verified first. Choose how filename collisions should be handled.</p><input className="studio-input" type="file" accept=".zip,application/zip" onChange={(event) => { setArchive(event.target.files?.[0] ?? null); setInspection(null); }} /><select className="studio-input" value={collision} onChange={(event) => setCollision(event.target.value as "skip" | "overwrite")}><option value="skip">Keep existing files</option><option value="overwrite">Overwrite matching files</option></select><div className="studio-action-row"><button className="btn ghost" type="button" disabled={!archive || busy !== null} onClick={() => void send("preview")}>{busy === "preview" ? "Inspecting…" : "Preview archive"}</button><button className="btn primary" type="button" disabled={!archive || !inspection || busy !== null} onClick={() => void send("import")}>{busy === "import" ? "Restoring…" : "Restore verified archive"}</button></div></section>
      </div>
      {inspection ? <div className="studio-note"><strong>{inspection.fileCount} files · {(inspection.totalBytes / 1024 / 1024).toFixed(1)} MB</strong><span>{inspection.newFiles.length} new and {inspection.collisions.length} existing paths. Archive owner: {inspection.manifest.owner}.</span></div> : null}
      <div className="studio-note"><strong>Safe by default.</strong><span>Export is read-only. Restore validates every checksum, previews collisions, remains owner-scoped, and rebuilds derived indexes after writing.</span></div>
      <div className="studio-action-row"><Link className="btn ghost" href="/ingest">Import ordinary documents</Link><Link className="btn ghost" href="/save">Browser capture guide</Link></div>
    </div>
  );
}

function ConnectionsPanel({ vaults }: { vaults: Array<{ id: string; name: string }> }) {
  const connections = [
    { label: "Browser & URL capture", body: "Save a page by URL and keep its source relationship.", href: "/save", action: "Capture a URL" },
    { label: "Email ingestion", body: "Manage authorized senders and the private inbound address.", href: "/settings", action: "Email settings" },
    { label: "Scheduled web sources", body: "Monitor recurring sources and deliver owner digests.", href: "/monitors", action: "Manage monitors" },
    { label: "Agent runtime", body: "Create scoped agents, credentials, schedules, and reviewable outputs.", href: "/agents", action: "Manage agents" },
    { label: "API & MCP", body: "Connect external automation through scoped machine interfaces.", href: "/agent-api", action: "Open API guide" },
    { label: "Bulk file import", body: "Drop document sets into the processing queue.", href: "/ingest", action: "Import files" },
  ];
  return (
    <div className="studio-panel-stack">
      <section className="studio-intro"><p className="studio-kicker">Capture surfaces</p><h3>Bring knowledge in from wherever the work happens.</h3><p>Each connection lands in an existing authenticated workflow; nothing here creates a second, disconnected copy of your data.</p></section>
      <div className="studio-connection-list">{connections.map((connection) => <Link href={connection.href} key={connection.label}><span className="studio-connection-mark" aria-hidden>↗</span><div><h3>{connection.label}</h3><p>{connection.body}</p><small>{connection.action} →</small></div></Link>)}</div>
      <LocalSyncPanel vaults={vaults} />
    </div>
  );
}
