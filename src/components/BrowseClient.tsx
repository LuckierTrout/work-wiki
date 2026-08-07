"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { IndexEntry } from "@/lib/types";
import type { BrowsePayload, DiscussionStats, TagFacet } from "@/lib/browse";
import type { DocumentLineage } from "@/lib/document-lineage";
import { formatRelativeTime } from "@/lib/format";
import {
  browsePageExcerpt,
  browsePageHref,
  browsePageKind,
  humanizeBrowseTag,
} from "@/lib/browse-explorer-view";
import { Icon } from "@/components/folio/icons";
import { Confidence, Mark } from "@/components/folio/primitives";
import { RemoveFromVaultButton } from "@/components/RemoveFromVaultButton";

type Sort = "recent" | "confidence" | "sources";

interface VaultLite {
  id: string;
  name: string;
  visibility: "public" | "private";
}

interface BrowseClientProps {
  myHandle: string | null;
  /** The active lens scope: `"all"` (all workspace knowledge) or `"vault:<id>"`. */
  activeScope: string;
  /** The signed-in user's own vaults — one location each. */
  myVaults: VaultLite[];
  /** First page (server-rendered, no query) — the client re-fetches from here. */
  initialResults: IndexEntry[];
  /** Total matches for the initial (unsearched) scope — drives pagination. */
  initialTotal: number;
  /** Tag facets across the whole scope pool, by count desc (stable folder tree). */
  initialTags: TagFacet[];
  initialDiscussionStats: DiscussionStats;
  pageSize: number;
  /** Initial tag filter (from `?tag=` — e.g. a tag chip on an article). */
  initialTag?: string | null;
  /** How many agents (besides yoyo) tend this workspace. */
  tenderAgents: number;
  /** ISO timestamp of the most recent update in the initial result pool. */
  lastTended: string | null;
}

const SORT_LABELS: Record<Sort, string> = {
  recent: "Recently updated",
  confidence: "Highest confidence",
  sources: "Most sourced",
};

function LocationLink({
  href,
  label,
  count,
  active,
  privateVault,
}: {
  href: string;
  label: string;
  count?: number;
  active: boolean;
  privateVault?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`browse-explorer-location${active ? " is-active" : ""}`}
      aria-current={active ? "page" : undefined}
    >
      <span className="browse-explorer-nav-copy">
        <Icon.folder width="15" height="15" aria-hidden="true" />
        <span>{label}</span>
        {privateVault ? <span className="sr-only">private</span> : null}
      </span>
      {typeof count === "number" ? (
        <span className="receipt browse-explorer-count">{count}</span>
      ) : null}
    </Link>
  );
}

function ExplorerButton({
  label,
  count,
  active,
  icon,
  onClick,
  disabled,
}: {
  label: string;
  count?: number;
  active: boolean;
  icon: "doc" | "folder" | "spark";
  onClick: () => void;
  disabled?: boolean;
}) {
  const Glyph = Icon[icon];
  return (
    <button
      type="button"
      className={`browse-explorer-nav-button${active ? " is-active" : ""}`}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="browse-explorer-nav-copy">
        <Glyph width="15" height="15" aria-hidden="true" />
        <span>{label}</span>
      </span>
      {typeof count === "number" ? (
        <span className="receipt browse-explorer-count">{count}</span>
      ) : null}
    </button>
  );
}

function KnowledgeRow({
  page,
  discussion,
  selected,
  onSelect,
}: {
  page: IndexEntry;
  discussion?: { total: number; open: number };
  selected: boolean;
  onSelect: (slug: string) => void;
}) {
  const kind = browsePageKind(page);
  const openCount = discussion?.open ?? 0;
  const decaying =
    Boolean(page.expiry) &&
    page.expiry! <= new Date().toISOString().slice(0, 10);

  return (
    <button
      type="button"
      className={`browse-explorer-file${selected ? " is-selected" : ""}`}
      aria-pressed={selected}
      onClick={() => onSelect(page.slug)}
    >
      <span className="browse-explorer-file-copy">
        <span className="browse-explorer-file-title">{page.title}</span>
        <span className="browse-explorer-file-summary">
          {browsePageExcerpt(page)}
        </span>
        <span className="browse-explorer-file-meta receipt">
          {kind.label}
          {page.sourceCount !== undefined
            ? ` · ${page.sourceCount} ${page.sourceCount === 1 ? "source" : "sources"}`
            : ""}
          {page.updated ? ` · ${formatRelativeTime(page.updated)}` : ""}
          {openCount > 0 ? ` · ${openCount} open` : ""}
          {decaying ? " · review due" : ""}
        </span>
      </span>
      <span className="browse-explorer-file-confidence">
        {page.confidence !== undefined ? (
          <Confidence value={page.confidence} withLabel />
        ) : (
          <span aria-hidden="true">›</span>
        )}
      </span>
    </button>
  );
}

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function LineageOutput({
  label,
  status,
  detail,
  href,
}: {
  label: string;
  status: string;
  detail: string;
  href?: string | null;
}) {
  const content = (
    <>
      <span className="browse-lineage-output-head">
        <span>{label}</span>
        <span className="receipt">{status}</span>
      </span>
      <span className="browse-lineage-output-detail">{detail}</span>
      {href ? <span className="browse-lineage-output-link">Open →</span> : null}
    </>
  );

  return href ? (
    <Link className="browse-lineage-output" href={href}>
      {content}
    </Link>
  ) : (
    <div className="browse-lineage-output">{content}</div>
  );
}

function ProcessingLineage({
  lineage,
  loading,
  error,
  pageHref,
  onRetry,
}: {
  lineage: DocumentLineage | null;
  loading: boolean;
  error: boolean;
  pageHref: string;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <section className="browse-lineage" aria-busy="true">
        <div className="browse-lineage-title-row">
          <div>
            <p className="browse-explorer-section-label receipt">Processing &amp; outputs</p>
            <h3>Tracing this document…</h3>
          </div>
          <span className="browse-lineage-pulse" aria-hidden="true" />
        </div>
        <div className="browse-lineage-skeleton" aria-hidden="true">
          <span /><span /><span />
        </div>
      </section>
    );
  }

  if (error || !lineage) {
    return (
      <section className="browse-lineage">
        <div className="browse-lineage-title-row">
          <div>
            <p className="browse-explorer-section-label receipt">Processing &amp; outputs</p>
            <h3>Lineage is temporarily unavailable.</h3>
          </div>
          <button type="button" onClick={onRetry}>Retry</button>
        </div>
      </section>
    );
  }

  const sourceDetail = lineage.isArtifact
    ? `${countLabel(lineage.sources.count, "cited page")} used to generate this output`
    : lineage.sources.originalFiles.length > 0
      ? `${countLabel(lineage.sources.count, "source")} · ${lineage.sources.originalFiles.slice(0, 2).join(", ")}`
      : `${countLabel(lineage.sources.count, "source")} retained as evidence`;
  const knowledgeDetail = lineage.knowledge.records > 0 || lineage.knowledge.relations > 0
    ? `${countLabel(lineage.knowledge.records, "record")} · ${countLabel(lineage.knowledge.relations, "relationship")}`
    : lineage.knowledge.compilationStatus === "processing"
      ? "Structured extraction is still running"
      : lineage.knowledge.compilationStatus === "failed"
        ? "Structured extraction needs attention"
        : "No people, projects, decisions, or relationships found";
  const knowledgeStatus = lineage.knowledge.records > 0
    ? "Connected"
    : lineage.knowledge.compilationStatus === "processing"
      ? "Processing"
      : lineage.knowledge.compilationStatus === "failed"
        ? "Needs attention"
        : "No records";
  const proposalDetail = lineage.proposals.total === 0
    ? "No canonical wiki changes were proposed"
    : `${lineage.proposals.pending} waiting · ${lineage.proposals.accepted} accepted`;
  const taskDetail = lineage.tasks.total === 0
    ? "No concrete commitments were found"
    : `${lineage.tasks.proposed} proposed · ${lineage.tasks.accepted} active · ${lineage.tasks.done} done`;
  const artifactDetail = lineage.artifacts.length === 0
    ? "No saved HTML or slide outputs cite this page"
    : lineage.artifacts.map((artifact) => artifact.title).slice(0, 2).join(" · ");

  return (
    <section className="browse-lineage">
      <div className="browse-lineage-title-row">
        <div>
          <p className="browse-explorer-section-label receipt">Processing &amp; outputs</p>
          <h3>What this material became</h3>
        </div>
        <span className="receipt browse-lineage-live">Live lineage</span>
      </div>

      <div className="browse-lineage-trunk">
        <div className="browse-lineage-node">
          <span className="browse-lineage-node-mark" aria-hidden="true">1</span>
          <span>
            <strong>{lineage.isArtifact ? "Cited knowledge" : "Original evidence"}</strong>
            <small>{sourceDetail}</small>
          </span>
          {lineage.sources.href ? <Link href={lineage.sources.href}>View</Link> : null}
        </div>
        <div className="browse-lineage-connector receipt" aria-hidden="true">creates</div>
        <div className="browse-lineage-node">
          <span className="browse-lineage-node-mark" aria-hidden="true">2</span>
          <span>
            <strong>{lineage.isArtifact ? "Rendered artifact" : "Knowledge page"}</strong>
            <small>{lineage.isArtifact ? "Saved output; excluded from the knowledge corpus" : "Readable synthesis available in Browse and search"}</small>
          </span>
          <Link href={pageHref}>Open</Link>
        </div>
      </div>

      <div className="browse-lineage-branch-label receipt">
        <span>Derived separately from the page</span>
      </div>
      <div className="browse-lineage-outputs">
        <LineageOutput
          label="Knowledge map"
          status={knowledgeStatus}
          detail={knowledgeDetail}
          href="/knowledge"
        />
        <LineageOutput
          label="Review changes"
          status={lineage.proposals.pending > 0 ? `${lineage.proposals.pending} waiting` : "Clear"}
          detail={proposalDetail}
          href={lineage.proposals.items[0]
            ? `/review?proposal=${encodeURIComponent(lineage.proposals.items[0].id)}`
            : "/review"}
        />
        <LineageOutput
          label="To-do items"
          status={lineage.tasks.proposed > 0 ? `${lineage.tasks.proposed} proposed` : "Clear"}
          detail={taskDetail}
          href={`/tasks?source=${encodeURIComponent(lineage.slug)}`}
        />
        <LineageOutput
          label="Generated artifacts"
          status={lineage.artifacts.length > 0 ? `${lineage.artifacts.length} saved` : "None"}
          detail={artifactDetail}
          href={lineage.artifacts[0]?.href ?? null}
        />
      </div>
      <p className="browse-lineage-note">
        Knowledge changes and to-dos are separate. Neither becomes approved work until you accept it.
      </p>
    </section>
  );
}

export function BrowseClient({
  myHandle,
  activeScope,
  myVaults,
  initialResults,
  initialTotal,
  initialTags,
  initialDiscussionStats,
  pageSize,
  initialTag,
  tenderAgents,
  lastTended,
}: BrowseClientProps) {
  const activeVaultId = activeScope.startsWith("vault:")
    ? activeScope.slice("vault:".length)
    : null;
  const activeVault = activeVaultId
    ? myVaults.find((vault) => vault.id === activeVaultId) ?? null
    : null;
  const ownVaultLens = activeVault;

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  const [tag, setTag] = useState<string | null>(initialTag ?? null);
  const [page, setPage] = useState(1);
  const [results, setResults] = useState(initialResults);
  const [total, setTotal] = useState(initialTotal);
  const [discussionStats, setDiscussionStats] = useState(initialDiscussionStats);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(
    () => initialResults[0]?.slug ?? null,
  );
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const [showAllTopics, setShowAllTopics] = useState(false);
  const [lineage, setLineage] = useState<DocumentLineage | null>(null);
  const [lineageLoading, setLineageLoading] = useState(false);
  const [lineageError, setLineageError] = useState(false);
  const [lineageRetryTick, setLineageRetryTick] = useState(0);

  const searching = debouncedQuery.trim().length > 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const selectedPage = useMemo(
    () => results.find((result) => result.slug === selectedSlug) ?? null,
    [results, selectedSlug],
  );
  const visibleTopics = showAllTopics ? initialTags : initialTags.slice(0, 12);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(id);
  }, [query]);

  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }

    let active = true;
    setLoading(true);
    const params = new URLSearchParams();
    if (debouncedQuery.trim()) params.set("q", debouncedQuery.trim());
    params.set("scope", activeScope);
    if (tag) params.set("tag", tag);
    params.set("sort", sort);
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));

    fetch(`/api/wiki/browse?${params.toString()}`)
      .then((response) =>
        response.ok
          ? (response.json() as Promise<BrowsePayload>)
          : Promise.reject(new Error(`HTTP ${response.status}`)),
      )
      .then((data) => {
        if (!active) return;
        setResults(data.results ?? []);
        setTotal(data.total ?? 0);
        setDiscussionStats(data.discussionStats ?? {});
        setFetchError(false);
      })
      .catch(() => {
        if (active) setFetchError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [activeScope, debouncedQuery, page, pageSize, retryTick, sort, tag]);

  useEffect(() => {
    if (results.length === 0) {
      setSelectedSlug(null);
      return;
    }
    if (!results.some((result) => result.slug === selectedSlug)) {
      setSelectedSlug(results[0].slug);
    }
  }, [results, selectedSlug]);

  useEffect(() => {
    if (!selectedSlug) {
      setLineage(null);
      setLineageError(false);
      return;
    }

    const controller = new AbortController();
    setLineage(null);
    setLineageLoading(true);
    setLineageError(false);
    fetch(`/api/wiki/${encodeURIComponent(selectedSlug)}/lineage`, {
      signal: controller.signal,
    })
      .then((response) =>
        response.ok
          ? (response.json() as Promise<{ lineage: DocumentLineage }>)
          : Promise.reject(new Error(`HTTP ${response.status}`)),
      )
      .then((data) => setLineage(data.lineage))
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setLineageError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLineageLoading(false);
      });

    return () => controller.abort();
  }, [lineageRetryTick, selectedSlug]);

  function onSearchChange(value: string) {
    setQuery(value);
    setPage(1);
  }

  function onSortChange(value: Sort) {
    setSort(value);
    setPage(1);
  }

  function onTagChange(value: string | null) {
    setTag(value);
    setPage(1);
  }

  const lensHref = (scope: string) =>
    `/wiki?scope=${encodeURIComponent(scope)}`;
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const selectedKind = selectedPage ? browsePageKind(selectedPage) : null;
  const selectedOwner =
    selectedPage?.owner && selectedPage.owner !== "system"
      ? selectedPage.owner
      : null;
  const selectedDiscussion = selectedPage
    ? discussionStats[selectedPage.slug]
    : undefined;
  const selectedDecaying =
    Boolean(selectedPage?.expiry) &&
    selectedPage!.expiry! <= new Date().toISOString().slice(0, 10);

  return (
    <div className="fade browse-explorer-page">
      <header className="browse-explorer-shell browse-explorer-header">
        <div>
          <p className="fmark" style={{ margin: 0 }}>
            private knowledge library
          </p>
          <h1 className="display browse-explorer-title">
            {activeVault ? activeVault.name : "Browse"}
          </h1>
          <p className="browse-explorer-deck">
            Find a document, inspect what the wiki knows, and open it without
            losing your place.
          </p>
        </div>
        <div className="browse-explorer-header-actions">
          <Link className="btn primary" href="/ingest">
            <Icon.plus width="15" height="15" aria-hidden="true" />
            Import
          </Link>
          <Link className="btn ghost" href="/vault">
            Manage vaults
          </Link>
        </div>
      </header>

      <nav
        className="browse-explorer-shell browse-explorer-path receipt"
        aria-label="Current browse location"
      >
        <span>Workspace</span>
        <span aria-hidden="true">/</span>
        <span>{activeVault?.name ?? "All knowledge"}</span>
        {tag ? (
          <>
            <span aria-hidden="true">/</span>
            <button type="button" onClick={() => onTagChange(null)}>
              {humanizeBrowseTag(tag)} ×
            </button>
          </>
        ) : null}
        <span className="browse-explorer-path-count">{total} files</span>
      </nav>

      <main className="browse-explorer-shell browse-explorer-grid">
        <aside className="browse-explorer-sidebar" aria-label="Knowledge folders">
          <div className="browse-explorer-sidebar-section">
            <p className="browse-explorer-section-label receipt">Locations</p>
            <LocationLink
              href={lensHref("all")}
              label="All knowledge"
              count={activeVaultId ? undefined : initialTotal}
              active={!activeVaultId}
            />
            {myHandle
              ? myVaults.map((vault) => (
                  <LocationLink
                    key={vault.id}
                    href={lensHref(`vault:${vault.id}`)}
                    label={vault.name}
                    active={activeVaultId === vault.id}
                    privateVault={vault.visibility === "private"}
                  />
                ))
              : null}
          </div>

          <div className="browse-explorer-sidebar-section">
            <p className="browse-explorer-section-label receipt">Smart folders</p>
            <ExplorerButton
              label="Recently updated"
              active={!searching && sort === "recent"}
              icon="doc"
              onClick={() => onSortChange("recent")}
              disabled={searching}
            />
            <ExplorerButton
              label="Most sourced"
              active={!searching && sort === "sources"}
              icon="spark"
              onClick={() => onSortChange("sources")}
              disabled={searching}
            />
            <ExplorerButton
              label="Highest confidence"
              active={!searching && sort === "confidence"}
              icon="spark"
              onClick={() => onSortChange("confidence")}
              disabled={searching}
            />
          </div>

          {initialTags.length > 0 ? (
            <div className="browse-explorer-sidebar-section">
              <p className="browse-explorer-section-label receipt">Topic folders</p>
              <ExplorerButton
                label="All topics"
                count={initialTotal}
                active={tag === null}
                icon="folder"
                onClick={() => onTagChange(null)}
              />
              {visibleTopics.map(([topic, count]) => (
                <ExplorerButton
                  key={topic}
                  label={humanizeBrowseTag(topic)}
                  count={count}
                  active={tag === topic}
                  icon="folder"
                  onClick={() => onTagChange(tag === topic ? null : topic)}
                />
              ))}
              {initialTags.length > 12 ? (
                <button
                  type="button"
                  className="browse-explorer-more receipt"
                  onClick={() => setShowAllTopics((value) => !value)}
                  aria-expanded={showAllTopics}
                >
                  {showAllTopics
                    ? "Show fewer"
                    : `Show ${initialTags.length - 12} more`}
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="browse-explorer-steward">
            <Image
              src="/yoyo.png"
              alt="yoyo, the steward octopus"
              width={28}
              height={25}
            />
            <span>
              <span className="receipt">
                tended by yoyo
                {tenderAgents > 0 ? ` + ${tenderAgents} agents` : ""}
              </span>
              {lastTended ? (
                <span className="receipt">
                  <i aria-hidden="true" /> last sweep {formatRelativeTime(lastTended)}
                </span>
              ) : null}
            </span>
          </div>
        </aside>

        <section
          className="browse-explorer-register"
          aria-labelledby="browse-register-heading"
        >
          <div className="browse-explorer-register-head">
            <div>
              <p className="browse-explorer-section-label receipt">Document register</p>
              <h2 id="browse-register-heading">
                {searching ? "Search results" : tag ? humanizeBrowseTag(tag) : "All files"}
              </h2>
            </div>
            <label className="browse-explorer-sort receipt">
              <span className="sr-only">Sort documents</span>
              <select
                value={sort}
                disabled={searching}
                onChange={(event) => onSortChange(event.target.value as Sort)}
              >
                {Object.entries(SORT_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {searching ? "Ranked by relevance" : label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="browse-explorer-search">
            <Icon.search width="16" height="16" aria-hidden="true" />
            <span className="sr-only">Search your knowledge library</span>
            <input
              type="search"
              value={query}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search by meaning, title, tag, or keyword"
            />
            {loading ? <span className="receipt">searching…</span> : null}
            {query ? (
              <button
                type="button"
                onClick={() => onSearchChange("")}
                aria-label="Clear search"
              >
                ×
              </button>
            ) : null}
          </label>

          {fetchError ? (
            <div className="browse-explorer-error" role="alert">
              <span>Couldn&apos;t refresh. The last complete result set is still shown.</span>
              <button
                type="button"
                onClick={() => setRetryTick((value) => value + 1)}
                disabled={loading}
              >
                Retry
              </button>
            </div>
          ) : null}

          <div
            className="browse-explorer-files"
            aria-live="polite"
            aria-busy={loading}
            style={{ opacity: loading ? 0.58 : 1 }}
          >
            {results.length > 0 ? (
              results.map((result) => (
                <KnowledgeRow
                  key={result.slug}
                  page={result}
                  discussion={discussionStats[result.slug]}
                  selected={selectedSlug === result.slug}
                  onSelect={setSelectedSlug}
                />
              ))
            ) : (
              <div className="browse-explorer-empty">
                <Icon.search width="25" height="25" aria-hidden="true" />
                <h3>No matching files</h3>
                <p>Clear the search or choose another topic folder.</p>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => {
                    onSearchChange("");
                    onTagChange(null);
                  }}
                >
                  Show all files
                </button>
              </div>
            )}
          </div>

          <div className="browse-explorer-pagination receipt">
            <button
              type="button"
              disabled={page <= 1 || loading}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
              aria-label="Previous page"
            >
              ←
            </button>
            <span>
              {from}–{to} of {total}
            </span>
            <span className="browse-explorer-page-number">
              Page {page} of {totalPages}
            </span>
            <button
              type="button"
              disabled={page >= totalPages || loading}
              onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
              aria-label="Next page"
            >
              →
            </button>
          </div>
        </section>

        <aside className="browse-explorer-details" aria-label="Selected document details">
          {!selectedPage || !selectedKind ? (
            <div className="browse-explorer-details-empty">
              <span className="browse-explorer-paper-mark" aria-hidden="true" />
              <p className="fmark">reading desk</p>
              <h2>Select a file</h2>
              <p>Its summary, provenance, and next actions will stay visible here.</p>
            </div>
          ) : (
            <>
              <div className="browse-explorer-details-heading">
                <div className="browse-explorer-details-kicker receipt">
                  <span>{selectedKind.label}</span>
                  <span>
                    {selectedPage.updated
                      ? formatRelativeTime(selectedPage.updated)
                      : "date unknown"}
                  </span>
                </div>
                <h2>{selectedPage.title}</h2>
                <p>{browsePageExcerpt(selectedPage)}</p>
                <div className="browse-explorer-details-actions">
                  <Link className="btn primary" href={browsePageHref(selectedPage)}>
                    Open document
                    <Icon.arrow width="14" height="14" aria-hidden="true" />
                  </Link>
                  <Link
                    className="btn ghost"
                    href={`/query?q=${encodeURIComponent(selectedPage.title)}`}
                  >
                    Ask about it
                  </Link>
                </div>
              </div>

              <dl className="browse-explorer-facts receipt">
                <div>
                  <dt>Sources</dt>
                  <dd>{selectedPage.sourceCount ?? 0}</dd>
                </div>
                <div>
                  <dt>Confidence</dt>
                  <dd>
                    {selectedPage.confidence !== undefined
                      ? `${Math.round(selectedPage.confidence * 100)}%`
                      : "Not scored"}
                  </dd>
                </div>
                <div>
                  <dt>Owner</dt>
                  <dd>{selectedOwner ?? "Workspace"}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>
                    {selectedDecaying
                      ? "Review due"
                      : selectedDiscussion?.open
                        ? `${selectedDiscussion.open} open thread${selectedDiscussion.open === 1 ? "" : "s"}`
                        : "Current"}
                  </dd>
                </div>
              </dl>

              {selectedPage.confidence !== undefined ? (
                <div className="browse-explorer-confidence-block">
                  <span className="browse-explorer-section-label receipt">
                    Evidence confidence
                  </span>
                  <Confidence value={selectedPage.confidence} withLabel />
                </div>
              ) : null}

              <ProcessingLineage
                lineage={lineage}
                loading={lineageLoading}
                error={lineageError}
                pageHref={browsePageHref(selectedPage)}
                onRetry={() => setLineageRetryTick((value) => value + 1)}
              />

              {(selectedPage.tags ?? []).length > 0 ? (
                <div className="browse-explorer-tags">
                  <p className="browse-explorer-section-label receipt">Filed under</p>
                  <div>
                    {(selectedPage.tags ?? []).map((pageTag) => (
                      <button
                        type="button"
                        key={pageTag}
                        onClick={() => onTagChange(pageTag)}
                      >
                        {humanizeBrowseTag(pageTag)}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {selectedOwner ? (
                <div className="browse-explorer-owner">
                  <Mark
                    id={selectedOwner}
                    agent={selectedOwner.includes("--")}
                  />
                  <span className="receipt">maintains this file</span>
                </div>
              ) : null}

              <div className="browse-explorer-details-footer">
                <span className="receipt">{selectedPage.slug}</span>
                {ownVaultLens ? (
                  <RemoveFromVaultButton
                    slug={selectedPage.slug}
                    vaultId={ownVaultLens.id}
                  />
                ) : null}
              </div>
            </>
          )}
        </aside>
      </main>
    </div>
  );
}
