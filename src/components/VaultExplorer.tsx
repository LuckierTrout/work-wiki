"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon } from "@/components/folio/icons";
import { useSlugTenants } from "@/hooks/useSlugTenants";
import { ownerToTenant, pagePath } from "@/lib/links";
import type { Vault } from "@/lib/vault";
import type { VaultExplorerEntry } from "@/lib/vault-explorer";
import {
  buildExplorerFacets,
  entryFormat,
  filterAndSortEntries,
  formatLabel,
  type ExplorerFacet,
  type ExplorerFilter,
  type ExplorerSort,
} from "@/lib/vault-explorer-view";

const MarkdownRenderer = dynamic(() =>
  import("@/components/MarkdownRenderer").then(
    (module) => module.MarkdownRenderer,
  ),
  { loading: PreviewSkeleton },
);

interface VaultExplorerProps {
  vault: Vault;
  vaults: Array<{ id: string; name: string; count: number }>;
  initialEntries: VaultExplorerEntry[];
}

interface PreviewPage {
  slug: string;
  title: string;
  body: string;
  rawHref: string;
}

interface PreviewFigure {
  id: string;
  src: string;
  alt: string;
  context: string;
  filename: string;
  page?: number;
  originalHref: string;
}

type PreviewState =
  | { status: "loading"; slug: string }
  | { status: "ready"; slug: string; page: PreviewPage }
  | { status: "error"; slug: string; message: string };

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function formatDate(value: string | undefined): string {
  if (!value) return "Date unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : DATE_FORMAT.format(date);
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`;
}

function stripLeadingTitle(body: string): string {
  return body.replace(/^#\s+.+(?:\r?\n)+/, "");
}

function filterKey(filter: ExplorerFilter): string {
  return filter.kind === "all" ? "all" : `${filter.kind}:${filter.value}`;
}

function FacetButton({
  facet,
  kind,
  active,
  onSelect,
  folder = false,
}: {
  facet: ExplorerFacet;
  kind: "folder" | "format" | "tag";
  active: boolean;
  onSelect: (filter: ExplorerFilter) => void;
  folder?: boolean;
}) {
  return (
    <button
      type="button"
      className={`vault-explorer-facet${active ? " is-active" : ""}`}
      aria-pressed={active}
      onClick={() => onSelect({ kind, value: facet.value })}
      title={folder && facet.value !== "__unfiled" ? facet.value : undefined}
      style={{ paddingLeft: folder ? 10 + (facet.depth ?? 0) * 14 : 10 }}
    >
      <span className="vault-explorer-facet-label">
        {folder ? <Icon.folder width="14" height="14" aria-hidden="true" /> : null}
        <span>{facet.label}</span>
      </span>
      <span className="receipt vault-explorer-count">{facet.count}</span>
    </button>
  );
}

function DocumentRow({
  entry,
  selected,
  onSelect,
}: {
  entry: VaultExplorerEntry;
  selected: boolean;
  onSelect: (slug: string) => void;
}) {
  const source = entry.sources[0];
  const format = entryFormat(entry);
  return (
    <button
      type="button"
      className={`vault-document-row${selected ? " is-selected" : ""}`}
      aria-pressed={selected}
      onClick={() => onSelect(entry.slug)}
    >
      <span className="vault-document-mark receipt" aria-hidden="true">
        {format === "page" ? "WIKI" : format.toUpperCase()}
      </span>
      <span className="vault-document-copy">
        <span className="vault-document-title">{entry.title}</span>
        <span className="vault-document-summary">
          {entry.missing
            ? "This reference no longer has a page."
            : entry.summary || source?.filename || entry.slug}
        </span>
        <span className="vault-document-meta receipt">
          {formatLabel(format)}
          {entry.folderPath ? ` · ${entry.folderPath}` : ""}
          {entry.updated ? ` · ${formatDate(entry.updated)}` : ""}
        </span>
      </span>
      <span className="vault-document-arrow" aria-hidden="true">
        ›
      </span>
    </button>
  );
}

function PreviewSkeleton() {
  return (
    <div className="vault-preview-skeleton" aria-label="Loading document preview">
      <span style={{ width: "38%" }} />
      <span style={{ width: "82%" }} />
      <span style={{ width: "94%" }} />
      <span style={{ width: "76%" }} />
      <span style={{ width: "88%" }} />
    </div>
  );
}

function pageFromContext(context: string): number | undefined {
  const page = Number(/\bPDF page\s+(\d+)\b/i.exec(context)?.[1]);
  return Number.isInteger(page) && page > 0 ? page : undefined;
}

function FigureLightbox({ figure, onClose }: { figure: PreviewFigure; onClose: () => void }) {
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const sourceHref = figure.page
    ? `${figure.originalHref}#page=${figure.page}`
    : figure.originalHref;
  return (
    <div className="vault-figure-lightbox" role="dialog" aria-modal="true" aria-label={figure.alt} onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <div className="vault-figure-lightbox-panel">
        <div className="vault-figure-lightbox-head">
          <div>
            <span className="receipt">{figure.context}</span>
            <h3>{figure.alt}</h3>
          </div>
          <button type="button" onClick={onClose} aria-label="Close figure">×</button>
        </div>
        {/* Extracted figures use the owner-gated asset route, so a plain image is required. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={figure.src} alt={figure.alt} />
        <div className="vault-figure-lightbox-foot">
          <span className="receipt">{figure.filename}</span>
          <a className="btn primary" href={sourceHref} target="_blank" rel="noopener noreferrer">
            {figure.page ? `Open original at page ${figure.page}` : "Open original"}
          </a>
        </div>
      </div>
    </div>
  );
}

export function VaultExplorer({
  vault,
  vaults,
  initialEntries,
}: VaultExplorerProps) {
  const router = useRouter();
  const { slugTenants } = useSlugTenants();
  const [entries, setEntries] = useState(initialEntries);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [sort, setSort] = useState<ExplorerSort>("recent");
  const [filter, setFilter] = useState<ExplorerFilter>({ kind: "all" });
  const [selectedSlug, setSelectedSlug] = useState<string | null>(
    () => initialEntries.find((entry) => !entry.missing)?.slug ?? null,
  );
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [activeFigure, setActiveFigure] = useState<PreviewFigure | null>(null);
  const [removing, setRemoving] = useState(false);
  const previewCache = useRef(new Map<string, PreviewPage>());

  const facets = useMemo(() => buildExplorerFacets(entries), [entries]);
  const visibleEntries = useMemo(
    () => filterAndSortEntries(entries, deferredQuery, filter, sort),
    [deferredQuery, entries, filter, sort],
  );
  const selectedEntry = entries.find((entry) => entry.slug === selectedSlug);
  const activeKey = filterKey(filter);

  useEffect(() => {
    if (!selectedSlug) {
      setPreview(null);
      return;
    }
    const cached = previewCache.current.get(selectedSlug);
    if (cached) {
      setPreview({ status: "ready", slug: selectedSlug, page: cached });
      return;
    }

    const controller = new AbortController();
    setPreview({ status: "loading", slug: selectedSlug });
    fetch(
      `/api/vaults/${encodeURIComponent(vault.id)}/pages/${encodeURIComponent(selectedSlug)}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        const payload = (await response.json().catch(() => ({}))) as {
          page?: PreviewPage;
          error?: string;
        };
        if (!response.ok || !payload.page) {
          throw new Error(payload.error ?? `Preview failed (${response.status})`);
        }
        previewCache.current.set(selectedSlug, payload.page);
        setPreview({ status: "ready", slug: selectedSlug, page: payload.page });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setPreview({
          status: "error",
          slug: selectedSlug,
          message: error instanceof Error ? error.message : "Preview unavailable.",
        });
      });

    return () => controller.abort();
  }, [selectedSlug, vault.id]);

  async function removeSelected() {
    if (!selectedEntry || removing) return;
    setRemoving(true);
    try {
      const response = await fetch(`/api/vaults/${encodeURIComponent(vault.id)}/pages`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: selectedEntry.slug }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(payload.error ?? `Remove failed (${response.status})`);
      }
      const remaining = entries.filter((entry) => entry.slug !== selectedEntry.slug);
      setEntries(remaining);
      previewCache.current.delete(selectedEntry.slug);
      setSelectedSlug(remaining.find((entry) => !entry.missing)?.slug ?? null);
      router.refresh();
    } catch (error) {
      setPreview({
        status: "error",
        slug: selectedEntry.slug,
        message: error instanceof Error ? error.message : "Could not remove this page.",
      });
    } finally {
      setRemoving(false);
    }
  }

  const original = selectedEntry?.sources[0];
  const originalHref =
    selectedEntry && original
      ? `/api/vaults/${encodeURIComponent(vault.id)}/pages/${encodeURIComponent(selectedEntry.slug)}/original?source=${encodeURIComponent(original.sha256)}`
      : null;
  const selectedPreview =
    preview && preview.slug === selectedSlug ? preview : null;
  const figures = useMemo<PreviewFigure[]>(() => {
    if (!selectedEntry) return [];
    return selectedEntry.sources.flatMap((source) => {
      const sourceHref = `/api/vaults/${encodeURIComponent(vault.id)}/pages/${encodeURIComponent(selectedEntry.slug)}/original?source=${encodeURIComponent(source.sha256)}`;
      return (source.assets ?? [])
        .filter((asset) => asset.mediaType.startsWith("image/"))
        .map((asset, index) => ({
          id: `${source.sha256}:${asset.publicPath}:${index}`,
          src: asset.publicPath,
          alt: asset.alt || asset.filename,
          context: asset.context,
          filename: source.filename,
          page: pageFromContext(asset.context),
          originalHref: sourceHref,
        }));
    });
  }, [selectedEntry, vault.id]);

  return (
    <div className="fade vault-explorer-page">
      <header className="vault-explorer-shell vault-explorer-header">
        <div>
          <p className="fmark" style={{ margin: 0 }}>
            document vault
          </p>
          <h1 className="display vault-explorer-title">{vault.name}</h1>
          <p className="vault-explorer-deck">
            Find a file, inspect the parsed knowledge, and open its original
            without losing your place.
          </p>
        </div>
        <div className="vault-explorer-header-actions">
          <Link className="btn ghost" href="/ingest">
            <Icon.plus width="15" height="15" aria-hidden="true" />
            Import
          </Link>
          <Link className="btn ghost" href="/vault">
            Manage vaults
          </Link>
        </div>
      </header>

      <div className="vault-explorer-shell vault-explorer-grid">
        <aside className="vault-explorer-shelves" aria-label="Vault explorer">
          <div className="vault-explorer-rail-section">
            <p className="vault-explorer-section-label receipt">Vault shelves</p>
            <nav aria-label="Your vaults" className="vault-explorer-vault-list">
              {vaults.map((candidate) => {
                const current = candidate.id === vault.id;
                return (
                  <Link
                    key={candidate.id}
                    href={`/vault/${encodeURIComponent(candidate.id)}`}
                    className={`vault-explorer-vault-link${current ? " is-active" : ""}`}
                    aria-current={current ? "page" : undefined}
                  >
                    <span>{candidate.name}</span>
                    <span className="receipt vault-explorer-count">{candidate.count}</span>
                  </Link>
                );
              })}
            </nav>
          </div>

          <div className="vault-explorer-rail-section">
            <p className="vault-explorer-section-label receipt">Browse</p>
            <button
              type="button"
              className={`vault-explorer-facet${activeKey === "all" ? " is-active" : ""}`}
              aria-pressed={activeKey === "all"}
              onClick={() => setFilter({ kind: "all" })}
            >
              <span className="vault-explorer-facet-label">
                <Icon.doc width="14" height="14" aria-hidden="true" />
                <span>All documents</span>
              </span>
              <span className="receipt vault-explorer-count">{entries.length}</span>
            </button>
          </div>

          {facets.folders.length > 0 ? (
            <div className="vault-explorer-rail-section">
              <p className="vault-explorer-section-label receipt">Folders</p>
              {facets.folders.map((facet) => (
                <FacetButton
                  key={facet.value}
                  facet={facet}
                  kind="folder"
                  folder
                  active={activeKey === `folder:${facet.value}`}
                  onSelect={setFilter}
                />
              ))}
            </div>
          ) : null}

          {facets.formats.length > 1 ? (
            <div className="vault-explorer-rail-section">
              <p className="vault-explorer-section-label receipt">File types</p>
              {facets.formats.map((facet) => (
                <FacetButton
                  key={facet.value}
                  facet={facet}
                  kind="format"
                  active={activeKey === `format:${facet.value}`}
                  onSelect={setFilter}
                />
              ))}
            </div>
          ) : null}

          {facets.tags.length > 0 ? (
            <div className="vault-explorer-rail-section">
              <p className="vault-explorer-section-label receipt">Top tags</p>
              {facets.tags.map((facet) => (
                <FacetButton
                  key={facet.value}
                  facet={facet}
                  kind="tag"
                  active={activeKey === `tag:${facet.value}`}
                  onSelect={setFilter}
                />
              ))}
            </div>
          ) : null}
        </aside>

        <section className="vault-explorer-register" aria-labelledby="document-register-heading">
          <div className="vault-explorer-register-head">
            <div>
              <p className="vault-explorer-section-label receipt" style={{ marginBottom: 5 }}>
                Document register
              </p>
              <h2 id="document-register-heading" className="vault-explorer-register-title">
                {visibleEntries.length} {visibleEntries.length === 1 ? "item" : "items"}
              </h2>
            </div>
            <label className="vault-explorer-sort">
              <span className="sr-only">Sort documents</span>
              <select value={sort} onChange={(event) => setSort(event.target.value as ExplorerSort)}>
                <option value="recent">Recently updated</option>
                <option value="title">Title A–Z</option>
                <option value="format">File type</option>
              </select>
            </label>
          </div>

          <label className="vault-explorer-search">
            <Icon.search width="16" height="16" aria-hidden="true" />
            <span className="sr-only">Search this vault</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search titles, folders, tags, or filenames"
            />
            {query ? (
              <button type="button" onClick={() => setQuery("")} aria-label="Clear search">
                ×
              </button>
            ) : null}
          </label>

          <div className="vault-document-list" aria-live="polite">
            {visibleEntries.length > 0 ? (
              visibleEntries.map((entry) => (
                <DocumentRow
                  key={entry.slug}
                  entry={entry}
                  selected={entry.slug === selectedSlug}
                  onSelect={setSelectedSlug}
                />
              ))
            ) : entries.length === 0 ? (
              <div className="vault-explorer-empty">
                <Icon.doc width="24" height="24" aria-hidden="true" />
                <h3>This shelf is empty</h3>
                <p>Import documents into this vault or save public wiki pages here.</p>
                <Link className="btn primary" href="/ingest">
                  Import documents
                </Link>
              </div>
            ) : (
              <div className="vault-explorer-empty">
                <Icon.search width="24" height="24" aria-hidden="true" />
                <h3>No matching documents</h3>
                <p>Clear the search or choose another shelf.</p>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => {
                    setQuery("");
                    setFilter({ kind: "all" });
                  }}
                >
                  Show everything
                </button>
              </div>
            )}
          </div>
        </section>

        <aside className="vault-explorer-preview" aria-label="Document preview">
          {!selectedEntry ? (
            <div className="vault-preview-blank">
              <span className="vault-preview-page-mark" aria-hidden="true" />
              <p className="fmark">reading desk</p>
              <h2>Select a document</h2>
              <p>The parsed page will open here while your place in the vault stays put.</p>
            </div>
          ) : (
            <>
              <div className="vault-preview-heading">
                <div className="vault-preview-kicker receipt">
                  <span>{formatLabel(entryFormat(selectedEntry))}</span>
                  <span>{formatDate(selectedEntry.updated ?? original?.storedAt)}</span>
                </div>
                <h2>{selectedEntry.title}</h2>
                {selectedEntry.summary ? <p>{selectedEntry.summary}</p> : null}
                <div className="vault-preview-actions">
                  {/* The entry already holds its owner, so the canonical
                      owner-scoped URL is built directly — no session-map wait,
                      no DEFAULT_TENANT hop. ownerToTenant(undefined) yields the
                      default tenant for genuinely ownerless entries. */}
                  <Link className="btn primary" href={pagePath(ownerToTenant(selectedEntry.owner), selectedEntry.slug)}>
                    Open full page <Icon.arrow width="14" height="14" aria-hidden="true" />
                  </Link>
                  {originalHref ? (
                    <a className="btn ghost" href={originalHref} target="_blank" rel="noopener noreferrer">
                      Open original
                    </a>
                  ) : null}
                  {selectedPreview?.status === "ready" ? (
                    <Link className="btn ghost" href={selectedPreview.page.rawHref}>
                      View raw
                    </Link>
                  ) : null}
                </div>
              </div>

              <dl className="vault-preview-facts receipt">
                {original ? (
                  <>
                    <div>
                      <dt>Original</dt>
                      <dd title={original.filename}>{original.filename}</dd>
                    </div>
                    <div>
                      <dt>Size</dt>
                      <dd>{formatBytes(original.size)}</dd>
                    </div>
                  </>
                ) : null}
                {selectedEntry.folderPath ? (
                  <div>
                    <dt>Folder</dt>
                    <dd>{selectedEntry.folderPath}</dd>
                  </div>
                ) : null}
                {selectedEntry.sources.length > 1 ? (
                  <div>
                    <dt>Originals</dt>
                    <dd>{selectedEntry.sources.length}</dd>
                  </div>
                ) : null}
              </dl>

              {selectedEntry.tags.length > 0 ? (
                <div className="vault-preview-tags" aria-label="Document tags">
                  {selectedEntry.tags.map((tag) => (
                    <button
                      type="button"
                      key={tag}
                      onClick={() => setFilter({ kind: "tag", value: tag })}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              ) : null}

              {figures.length > 0 ? (
                <section className="vault-figure-strip" aria-labelledby="source-figures-heading">
                  <div className="vault-figure-strip-head">
                    <div>
                      <p className="receipt">Visual evidence</p>
                      <h3 id="source-figures-heading">{figures.length} extracted {figures.length === 1 ? "figure" : "figures"}</h3>
                    </div>
                    <span className="receipt">Select to inspect</span>
                  </div>
                  <div className="vault-figure-grid">
                    {figures.map((figure) => (
                      <button type="button" key={figure.id} onClick={() => setActiveFigure(figure)} aria-label={`Inspect ${figure.alt}`}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={figure.src} alt="" loading="lazy" />
                        <span>
                          <strong>{figure.page ? `Page ${figure.page}` : figure.context}</strong>
                          <small>{figure.alt}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}

              <div className="vault-preview-body">
                {!selectedPreview || selectedPreview.status === "loading" ? <PreviewSkeleton /> : null}
                {selectedPreview?.status === "error" ? (
                  <div className="vault-preview-error" role="alert">
                    <p>{selectedPreview.message}</p>
                    <button type="button" className="btn ghost" onClick={() => setSelectedSlug(null)}>
                      Close preview
                    </button>
                  </div>
                ) : null}
                {selectedPreview?.status === "ready" ? (
                  <MarkdownRenderer
                    content={stripLeadingTitle(selectedPreview.page.body)}
                    className="prose-article vault-preview-prose"
                    tenant={ownerToTenant(selectedEntry.owner)}
                    slugTenants={slugTenants}
                  />
                ) : null}
              </div>

              <div className="vault-preview-footer">
                <span className="receipt">Reference stays live with the wiki page.</span>
                <button
                  type="button"
                  onClick={removeSelected}
                  disabled={removing}
                >
                  {removing ? "Removing…" : "Remove from vault"}
                </button>
              </div>
            </>
          )}
        </aside>
      </div>
      {activeFigure ? <FigureLightbox figure={activeFigure} onClose={() => setActiveFigure(null)} /> : null}
    </div>
  );
}
