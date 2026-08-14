import Link from "next/link";
import { HomeAsk } from "@/components/HomeAsk";
import { Icon } from "@/components/folio/icons";
import { formatRelativeTime } from "@/lib/format";
import type { HomeDashboardSnapshot } from "@/lib/home-dashboard";
import { ownerToTenant, pagePath } from "@/lib/links";
import type { ActionItem } from "@/lib/action-items";
import type { IndexEntry } from "@/lib/types";

function documentHref(page: IndexEntry): string {
  return pagePath(ownerToTenant(page.owner), page.slug);
}

function documentKind(page: IndexEntry): string {
  if (page.type === "slides") return "slides";
  if (page.type === "html") return "artifact";
  return "document";
}

function titleizeSlug(value: string): string {
  return value
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toLocaleUpperCase() + word.slice(1))
    .join(" ");
}

function documentTitle(page: IndexEntry): string {
  const title = page.title.trim();
  if (title === page.slug || (title.includes("-") && !title.includes(" "))) {
    return titleizeSlug(page.slug);
  }
  return title;
}

function documentSummary(page: IndexEntry): string | null {
  const cleaned = page.summary
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^summary\s*:?\s*$/i, "")
    .trim();
  if (!cleaned) return null;
  const comparable = (value: string) =>
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[\p{P}\p{S}\s]+/gu, "");
  if (
    comparable(cleaned) === comparable(page.slug) ||
    comparable(cleaned) === comparable(page.title)
  ) {
    return null;
  }
  return cleaned;
}

function dueLabel(item: ActionItem): string | null {
  if (!item.dueDate) return null;
  const parsed = Date.parse(item.dueDate);
  if (!Number.isFinite(parsed)) return item.dueDate;
  const date = new Date(parsed);
  const overdue = parsed < Date.now() && item.status !== "done";
  const label = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
  return `${overdue ? "overdue · " : "due · "}${label}`;
}

function WidgetHeading({
  label,
  title,
  href,
  linkLabel,
}: {
  label: string;
  title: string;
  href: string;
  linkLabel: string;
}) {
  return (
    <header className="dashboard-widget-heading">
      <div>
        <p className="fmark">{label}</p>
        <h2 className="display">{title}</h2>
      </div>
      <Link href={href} className="dashboard-text-link">
        {linkLabel} <Icon.arrow width="14" height="14" aria-hidden />
      </Link>
    </header>
  );
}

export function HomeDashboard({
  snapshot,
}: {
  snapshot: HomeDashboardSnapshot;
}) {
  const { recentDocuments, openTasks, recentConversations, topics, totals } =
    snapshot;

  return (
    <main className="home-dashboard fade">
      <div className="shell dashboard-shell">
        <header className="dashboard-masthead rise">
          <div>
            <p className="fmark">your private workspace</p>
            <h1 className="display">Welcome back.</h1>
            <p className="dashboard-deck">
              Pick up the documents, decisions, and conversations that are
              moving now.
            </p>
          </div>
          <div className="dashboard-actions" aria-label="Quick actions">
            <Link href="/save" className="btn">
              <Icon.plus width="16" height="16" aria-hidden /> Save something
            </Link>
            <Link href="/ingest" className="btn primary">
              <Icon.doc width="16" height="16" aria-hidden /> Add source
            </Link>
          </div>
        </header>

        <dl className="dashboard-today-strip rise" aria-label="Workspace totals">
          <div>
            <dt>documents</dt>
            <dd>{totals.documents}</dd>
          </div>
          <div>
            <dt>sources</dt>
            <dd>{totals.sources}</dd>
          </div>
          <div>
            <dt>open to-dos</dt>
            <dd>{totals.openTasks}</dd>
          </div>
          <div>
            <dt>chat threads</dt>
            <dd>{totals.conversations}</dd>
          </div>
          <p className="receipt">live working set</p>
        </dl>

        <section className="dashboard-ask rise" aria-labelledby="dashboard-ask-title">
          <div className="dashboard-ask-intro">
            <p className="fmark">ask across everything</p>
            <h2 id="dashboard-ask-title" className="display">
              Start with a question.
            </h2>
          </div>
          <HomeAsk
            examples={[]}
            placeholder="Ask what changed, what is connected, or what needs your attention…"
            helperText="Answers search your readable knowledge and cite every page they use. ⌘↵ to ask."
          />
        </section>

        <div className="dashboard-grid">
          <section className="dashboard-widget dashboard-documents rise">
            <WidgetHeading
              label="continue reading"
              title="Recent documents"
              href="/query"
              linkLabel="Ask the wiki"
            />
            {recentDocuments.length === 0 ? (
              <div className="dashboard-empty">
                <p>No documents yet.</p>
                <Link href="/ingest">Add your first source →</Link>
              </div>
            ) : (
              <ol className="dashboard-document-list">
                {recentDocuments.map((page) => {
                  const summary = documentSummary(page);
                  return (
                    <li key={page.slug}>
                      <Link href={documentHref(page)}>
                        <span className="dashboard-document-icon" aria-hidden>
                          <Icon.doc width="18" height="18" />
                        </span>
                        <span className="dashboard-document-copy">
                          <span className="dashboard-document-title">
                            {documentTitle(page)}
                          </span>
                          {summary && (
                            <span className="dashboard-document-summary">
                              {summary}
                            </span>
                          )}
                          <span className="dashboard-document-meta receipt">
                            {documentKind(page)}
                            {page.updated
                              ? ` · ${formatRelativeTime(page.updated)}`
                              : ""}
                            {page.sourceCount
                              ? ` · ${page.sourceCount} ${page.sourceCount === 1 ? "source" : "sources"}`
                              : ""}
                          </span>
                        </span>
                        <Icon.arrow
                          className="dashboard-row-arrow"
                          width="16"
                          height="16"
                          aria-hidden
                        />
                      </Link>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          <section className="dashboard-widget dashboard-tasks rise">
            <WidgetHeading
              label="needs attention"
              title="To-do"
              href="/tasks"
              linkLabel="Open list"
            />
            {openTasks.length === 0 ? (
              <div className="dashboard-empty dashboard-empty-compact">
                <span className="dashboard-empty-check" aria-hidden>
                  <Icon.check width="18" height="18" />
                </span>
                <p>You’re caught up. New actions extracted by AI will appear here.</p>
              </div>
            ) : (
              <ol className="dashboard-task-list">
                {openTasks.map((item) => {
                  const due = dueLabel(item);
                  return (
                    <li key={item.id}>
                      <Link href="/tasks">
                        <span
                          className={`dashboard-priority dashboard-priority-${item.priority}`}
                          aria-label={`${item.priority} priority`}
                        />
                        <span>
                          <span className="dashboard-task-title">{item.title}</span>
                          <span className="dashboard-task-meta receipt">
                            {item.status === "inbox" ? "awaiting review" : "active"}
                            {due ? ` · ${due}` : ""}
                            {item.assignee ? ` · ${item.assignee}` : ""}
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          <section className="dashboard-widget dashboard-chat rise">
            <WidgetHeading
              label="keep the thread"
              title="Chat"
              href="/chat"
              linkLabel="New chat"
            />
            {recentConversations.length === 0 ? (
              <div className="dashboard-empty dashboard-empty-compact">
                <span className="dashboard-empty-check" aria-hidden>
                  <Icon.chat width="18" height="18" />
                </span>
                <p>Ask your wiki a question to begin your first grounded thread.</p>
              </div>
            ) : (
              <ol className="dashboard-chat-list">
                {recentConversations.map((conversation) => (
                  <li key={conversation.id}>
                    <Link href="/chat">
                      <span className="dashboard-chat-icon" aria-hidden>
                        <Icon.chat width="16" height="16" />
                      </span>
                      <span>
                        <span className="dashboard-chat-title">
                          {conversation.title}
                        </span>
                        <span className="dashboard-chat-meta receipt">
                          {conversation.scope || "all knowledge"} ·{" "}
                          {formatRelativeTime(conversation.updatedAt)}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="dashboard-widget dashboard-explore rise">
            <WidgetHeading
              label="follow a connection"
              title="Explore"
              href="/wiki/graph"
              linkLabel="Open graph"
            />
            <p className="dashboard-widget-deck">
              Move through the ideas your documents share, or enter through a
              topic you use often.
            </p>
            {topics.length > 0 && (
              <div className="dashboard-topics" aria-label="Top topics">
                {topics.map((topic) => (
                  <span key={topic.label.toLocaleLowerCase()}>
                    <span>{topic.label}</span>
                    <span className="receipt">{topic.count}</span>
                  </span>
                ))}
              </div>
            )}
            <nav className="dashboard-explore-links" aria-label="Explore your wiki">
              <Link href="/query">
                <Icon.search width="18" height="18" aria-hidden />
                <span>
                  <strong>Ask your wiki</strong>
                  <small>Get a cited answer from every readable page</small>
                </span>
              </Link>
              <Link href="/wiki/graph">
                <Icon.spark width="18" height="18" aria-hidden />
                <span>
                  <strong>Knowledge graph</strong>
                  <small>See pages, topics, and their links</small>
                </span>
              </Link>
              <Link href="/vault">
                <Icon.folder width="18" height="18" aria-hidden />
                <span>
                  <strong>Vault explorer</strong>
                  <small>Move through your organized collections</small>
                </span>
              </Link>
              <Link href="/review">
                <Icon.check width="18" height="18" aria-hidden />
                <span>
                  <strong>Review knowledge</strong>
                  <small>Check changes before they settle in</small>
                </span>
              </Link>
            </nav>
          </section>
        </div>
      </div>
    </main>
  );
}
