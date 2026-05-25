import { mkdir, readFile, rm, writeFile, cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const journalPath = path.join(repoRoot, ".yoyo", "journal.md");
const distDir = path.join(__dirname, "dist");
const assetsDir = path.join(__dirname, "assets");

const issueBaseUrl = "https://github.com/yologdev/yopedia/issues/";
const repoUrl = "https://github.com/yologdev/yopedia";
const journalMinDate = "2026-04-01";

const agentMeta = {
  pm: {
    label: "PM",
    className: "agent-pm",
    status: "prioritized",
    description: "Finds product gaps and turns them into work.",
  },
  build: {
    label: "Build",
    className: "agent-build",
    status: "shipped",
    description: "Implements ready issues and opens pull requests.",
  },
  review: {
    label: "Review",
    className: "agent-review",
    status: "reviewed",
    description: "Checks diffs against acceptance criteria.",
  },
  "office-hour": {
    label: "Office Hour",
    className: "agent-office-hour",
    status: "triaged",
    description: "Sorts issues and routes complex work.",
  },
  research: {
    label: "Research",
    className: "agent-research",
    status: "scanned",
    description: "Reads the field and files strategic signals.",
  },
  architect: {
    label: "Architect",
    className: "agent-architect",
    status: "planned",
    description: "Breaks hard changes into buildable plans.",
  },
  yoyo: {
    label: "yoyo",
    className: "agent-yoyo",
    status: "logged",
    description: "Maintains the journal and connects the trail.",
  },
  unknown: {
    label: "Unknown",
    className: "agent-unknown",
    status: "stored",
    description: "Stored without a known agent role.",
  },
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("\n", " ");
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizeAgent(value = "") {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "-");
  if (normalized === "research-scan") return "research";
  if (normalized === "office-hour" || normalized === "officehour") return "office-hour";
  if (agentMeta[normalized]) return normalized;
  return "unknown";
}

function inferAgent(title, agentRaw) {
  if (agentRaw.trim()) return normalizeAgent(agentRaw);

  const normalizedTitle = title.toLowerCase();
  if (normalizedTitle.includes("office hour") || normalizedTitle.includes("office-hour")) {
    return "office-hour";
  }
  if (normalizedTitle.includes("research")) return "research";
  if (normalizedTitle.includes("architect")) return "architect";
  if (normalizedTitle.includes("pm")) return "pm";
  if (normalizedTitle.includes("build")) return "build";
  if (normalizedTitle.includes("review")) return "review";
  return "yoyo";
}

function parseHeading(heading) {
  const agentOnlyMatch = heading.match(/^\(([^)]+)\)$/);
  if (agentOnlyMatch) {
    const agent = normalizeAgent(agentOnlyMatch[1]);
    return {
      date: "unknown",
      time: "",
      agent,
      title: agent === "unknown" ? "Session notes" : `${agentMeta[agent].label} session`,
    };
  }

  const reverseMatch = heading.match(
    /^(.+?)\s+[—-]\s+(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?(?:\s+\(([^)]+)\))?$/,
  );

  if (reverseMatch) {
    const [, titleRaw, date, time = "", agentRaw = ""] = reverseMatch;
    const title = titleRaw.trim() || "Session notes";
    return {
      date,
      time,
      agent: inferAgent(title, agentRaw),
      title,
    };
  }

  const match = heading.match(
    /^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?(?:\s+\(([^)]+)\))?(?:\s+[—-]\s+(.+))?$/,
  );

  if (!match) {
    return {
      date: "unknown",
      time: "",
      agent: "unknown",
      title: heading.trim() || "Session notes",
    };
  }

  const [, date, time = "", agentRaw = "", titleRaw = ""] = match;
  const title =
    titleRaw.trim() ||
    (agentRaw.trim() ? `${agentMeta[normalizeAgent(agentRaw)].label} session` : "Session notes");
  const agent = inferAgent(title, agentRaw);

  return { date, time, agent, title };
}

function isValidDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date;
}

function assertPlausibleJournalDate(parsed, heading) {
  if (!isValidDate(parsed.date)) return;
  if (parsed.date >= journalMinDate) return;

  throw new Error(
    `Journal heading has implausible date before ${journalMinDate}: "${heading}". ` +
      "Fix the source heading in .yoyo/journal.md before publishing.",
  );
}

function stripMarkdown(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function renderInline(markdown) {
  const codeSpans = [];
  let html = escapeHtml(markdown).replace(/`([^`]+)`/g, (_match, code) => {
    const token = `%%CODE${codeSpans.length}%%`;
    codeSpans.push(`<code>${code}</code>`);
    return token;
  });

  html = html
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" rel="noopener noreferrer">$1</a>',
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/(^|[\s(])#(\d+)\b/g, `$1<a href="${issueBaseUrl}$2">#$2</a>`);

  for (const [index, code] of codeSpans.entries()) {
    html = html.replaceAll(`%%CODE${index}%%`, code);
  }

  return html;
}

function isTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(line);
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableSeparator(line) {
  if (!isTableRow(line)) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function renderTable(headerCells, rows) {
  const header = headerCells
    .map((cell) => `<th scope="col">${renderInline(cell)}</th>`)
    .join("");
  const body = rows
    .map((row) => {
      const cells = headerCells.map((_header, index) => row[index] ?? "");
      return `<tr>${cells.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`;
    })
    .join("");

  return `<div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderMarkdown(markdown) {
  const lines = markdown.trim().split(/\r?\n/);
  const chunks = [];
  let paragraph = [];
  let list = [];
  let code = [];
  let inCode = false;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    chunks.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (list.length === 0) return;
    chunks.push(`<ul>${list.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul>`);
    list = [];
  };

  const flushCode = () => {
    if (code.length === 0) return;
    chunks.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
    code = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().startsWith("```")) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        flushParagraph();
        flushList();
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      code.push(line);
      continue;
    }

    const nextLine = lines[index + 1] ?? "";
    if (isTableRow(line) && isTableSeparator(nextLine)) {
      flushParagraph();
      flushList();
      const header = splitTableRow(line);
      const rows = [];
      index += 2;
      while (index < lines.length && isTableRow(lines[index])) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      index -= 1;
      chunks.push(renderTable(header, rows));
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^(#{3,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      chunks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      list.push(bullet[1]);
      continue;
    }

    const quote = line.match(/^\s*>\s+(.+)$/);
    if (quote) {
      flushParagraph();
      flushList();
      chunks.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  flushCode();

  return chunks.join("\n");
}

function parseJournal(markdown) {
  const headingRegex = /^##\s+(.+)$/gm;
  const matches = [...markdown.matchAll(headingRegex)];

  return matches.map((match, index) => {
    const heading = match[1].trim();
    const bodyStart = match.index + match[0].length;
    const bodyEnd = matches[index + 1]?.index ?? markdown.length;
    const body = markdown.slice(bodyStart, bodyEnd).trim();
    const parsed = parseHeading(heading);
    assertPlausibleJournalDate(parsed, heading);
    const timestamp = isValidDate(parsed.date)
      ? `${parsed.date}${parsed.time ? `T${parsed.time}:00Z` : "T00:00:00Z"}`
      : "";
    const plain = stripMarkdown(body);
    const id = `${parsed.date}-${index + 1}-${slugify(parsed.title || heading)}`;

    return {
      ...parsed,
      id,
      body,
      bodyHtml: renderMarkdown(body),
      plain,
      summary: plain.slice(0, 180),
      timestamp,
      month: parsed.date.slice(0, 7),
      monthLabel: formatMonth(parsed.date),
      heading,
    };
  });
}

function formatMonth(date) {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf())) return "Undated";
  return new Intl.DateTimeFormat("en", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

function formatDate(date) {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf())) return date;
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

function formatShortDate(date) {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf())) return date;
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })
    .format(parsed)
    .toUpperCase();
}

function pseudoCommit(entry) {
  let hash = 0;
  const seed = `${entry.id}-${entry.title}-${entry.timestamp}`;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(7, "0").slice(0, 7);
}

function firstIssue(entry) {
  const issue = `${entry.title} ${entry.body}`.match(/#(\d+)\b/);
  return issue ? `#${issue[1]}` : "";
}

function wordCount(value) {
  return stripMarkdown(value).split(/\s+/).filter(Boolean).length;
}

function getStats(entries) {
  const counts = new Map();
  for (const entry of entries) {
    counts.set(entry.agent, (counts.get(entry.agent) ?? 0) + 1);
  }
  const topAgent = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["unknown", 0];
  const sortedDates = entries
    .map((entry) => entry.date)
    .filter((date) => isValidDate(date))
    .sort();

  return {
    total: entries.length,
    firstDate: sortedDates[0] ?? "",
    lastDate: sortedDates.at(-1) ?? "",
    latest: entries.find((entry) => isValidDate(entry.date)),
    topAgent: {
      key: topAgent[0],
      count: topAgent[1],
      label: agentMeta[topAgent[0]]?.label ?? "Unknown",
    },
    counts: Object.fromEntries(counts),
  };
}

function getMonthGroups(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = entry.month || "unknown";
    const current = groups.get(key) ?? {
      month: key,
      label: entry.monthLabel || "Undated",
      count: 0,
    };
    current.count += 1;
    groups.set(key, current);
  }

  return [...groups.values()].sort((a, b) => b.month.localeCompare(a.month));
}

function renderAgentOptions(entries) {
  const present = [...new Set(entries.map((entry) => entry.agent))].sort((a, b) =>
    agentMeta[a].label.localeCompare(agentMeta[b].label),
  );
  return [
    '<option value="all">All agents</option>',
    ...present.map((agent) => `<option value="${agent}">${agentMeta[agent].label}</option>`),
  ].join("");
}

function renderAgentStats(stats) {
  return Object.entries(agentMeta)
    .filter(([agent]) => stats.counts[agent])
    .map(
      ([agent, meta]) => `
        <span class="agent-stat ${meta.className}"><b>${meta.label}</b>:${stats.counts[agent]}</span>
      `,
    )
    .join("");
}

function renderAgentLegend(stats) {
  return Object.entries(agentMeta)
    .filter(([agent]) => stats.counts[agent])
    .map(
      ([agent, meta]) => `
        <li class="agent-key ${meta.className}">
          <span class="agent-dot" aria-hidden="true"></span>
          <span>
            <strong>${meta.label}</strong>
            <small>${stats.counts[agent]} entries. ${meta.description}</small>
          </span>
        </li>
      `,
    )
    .join("");
}

function renderMonthNav(entries) {
  return getMonthGroups(entries)
    .map(
      (month) => `
        <a href="#month-${escapeAttr(month.month)}" data-month-link="${escapeAttr(month.month)}">
          <span>${escapeHtml(month.label)}</span>
          <strong>${month.count}</strong>
        </a>
      `,
    )
    .join("");
}

function renderRecentEntries(entries) {
  return entries
    .slice(0, 3)
    .map((entry) => {
      const meta = agentMeta[entry.agent] ?? agentMeta.unknown;
      return `
        <a class="recent-item ${meta.className}" href="#${escapeAttr(entry.id)}">
          <span>${escapeHtml(meta.label)}</span>
          <strong>${escapeHtml(entry.title)}</strong>
          <time datetime="${escapeAttr(entry.timestamp)}">${formatDate(entry.date)}</time>
        </a>
      `;
    })
    .join("");
}

function renderEntries(entries) {
  return entries
    .map((entry) => {
      const meta = agentMeta[entry.agent] ?? agentMeta.unknown;
      const searchable = `${entry.title} ${entry.agent} ${entry.plain}`;
      const issue = firstIssue(entry);
      return `
        <article
          id="${escapeAttr(entry.id)}"
          class="journal-entry ${meta.className}"
          data-agent="${escapeAttr(entry.agent)}"
          data-date="${escapeAttr(entry.date)}"
          data-month="${escapeAttr(entry.month)}"
          data-month-label="${escapeAttr(entry.monthLabel)}"
          data-search="${escapeAttr(searchable.toLowerCase())}"
          data-expanded="false"
        >
          <div class="month-marker" aria-hidden="true"></div>
          <div class="entry-rail" aria-hidden="true"><span></span></div>
          <header class="entry-header">
            <div class="entry-kicker">
              <time datetime="${escapeAttr(entry.timestamp)}">${formatShortDate(entry.date)}</time>
              <span>${entry.time ? `${escapeHtml(entry.time)} UTC` : "00:00 UTC"}</span>
              <span class="agent-badge">${meta.label}</span>
              <span>yoyo</span>
              ${issue ? `<a href="${issueBaseUrl}${issue.slice(1)}">${issue}</a>` : ""}
            </div>
            <h2><a href="#${escapeAttr(entry.id)}">${escapeHtml(entry.title)}</a></h2>
            <p class="entry-summary">${escapeHtml(entry.summary)}${entry.plain.length > 180 ? "..." : ""}</p>
          </header>
          <aside class="entry-status" aria-label="Entry status">
            <span>commit ${pseudoCommit(entry)}</span>
            <span>${meta.status}</span>
            <span>${wordCount(entry.body)} words</span>
          </aside>
          <section class="entry-details" aria-label="Journal entry content">
            <div class="entry-body">
              ${entry.bodyHtml}
            </div>
            <button class="entry-toggle" type="button" aria-expanded="false">
              Read full entry
            </button>
          </section>
        </article>
      `;
    })
    .join("");
}

function renderHtml(entries) {
  const stats = getStats(entries);
  const range =
    stats.firstDate && stats.lastDate
      ? `${formatDate(stats.firstDate)} - ${formatDate(stats.lastDate)}`
      : "No dated entries";
  const latestLabel = stats.latest ? formatDate(stats.latest.date) : "None";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>yopedia Growth Journal</title>
    <meta name="description" content="A public archive of the agent sessions growing yopedia.">
    <link rel="stylesheet" href="./assets/site.css">
  </head>
  <body>
    <main class="journal-shell" id="top">
      <header class="hero">
        <nav class="topline" aria-label="Project links">
          <strong>yopedia Growth Journal</strong>
          <span></span>
          <a href="${repoUrl}">GitHub</a>
          <a href="${repoUrl}/blob/main/.yoyo/journal.md">Source Journal</a>
          <code>.yoyo/journal.md</code>
        </nav>
        <div class="hero-grid">
          <div class="hero-copy">
            <p class="eyebrow">Public lab log</p>
            <h1>Watch a wiki grow itself.</h1>
            <p class="hero-deck">
              yopedia is a shared second brain for humans and agents. This journal is the visible trail: every scan, triage, build, review, and decision that moves the product forward.
            </p>
            <div class="hero-actions">
              <a href="#archive">Browse the archive</a>
              <a href="${repoUrl}/actions">Inspect agent runs</a>
            </div>
          </div>
          <aside class="hero-panel" aria-label="Journal statistics">
            <dl class="stat-grid">
              <div>
                <dt>Entries</dt>
                <dd>${stats.total}</dd>
              </div>
              <div>
                <dt>Range</dt>
                <dd>${escapeHtml(range)}</dd>
              </div>
              <div>
                <dt>Top voice</dt>
                <dd>${escapeHtml(stats.topAgent.label)} (${stats.topAgent.count})</dd>
              </div>
              <div>
                <dt>Latest</dt>
                <dd>${escapeHtml(latestLabel)}</dd>
              </div>
            </dl>
          </aside>
        </div>
      </header>

      <section class="lab-strip" aria-label="Current journal signal">
        <div>
          <span>Latest signal</span>
          <strong>${stats.latest ? escapeHtml(stats.latest.title) : "No entries yet"}</strong>
        </div>
        <div class="agent-ledger" aria-label="Entries by agent">
          <span>Agent mix</span>
          ${renderAgentStats(stats)}
        </div>
      </section>

      <section class="controls" aria-label="Journal controls">
        <label>
          <span>Search the log</span>
          <input id="search" type="search" placeholder="Try: Cloudflare, X API, blocked, #91">
        </label>
        <label>
          <span>Agent</span>
          <select id="agent-filter">${renderAgentOptions(entries)}</select>
        </label>
        <label>
          <span>Order</span>
          <select id="sort-order">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </label>
        <output id="result-count" aria-live="polite">${entries.length} entries</output>
      </section>

      <section class="lab-overview" aria-label="Journal overview">
        <div class="recent-panel">
          <span class="section-label">Recent activity</span>
          ${renderRecentEntries(entries)}
        </div>
        <div class="agent-panel">
          <span class="section-label">Agent roles</span>
          <ul>
            ${renderAgentLegend(stats)}
          </ul>
        </div>
      </section>

      <section class="archive-shell" id="archive" aria-label="Journal archive">
        <div class="archive-top">
          <div>
            <span class="section-label">Timeline</span>
            <h2>Generated from the source journal</h2>
            <p>Search the public trail, jump by month, and expand entries when the evidence needs a full read.</p>
          </div>
          <nav class="month-nav" aria-label="Jump by month">
            ${renderMonthNav(entries)}
          </nav>
        </div>
        <p id="empty-state" class="empty-state" hidden>No entries match the current filters.</p>
        <div id="entry-list" class="entry-list">
          ${renderEntries(entries)}
        </div>
      </section>
    </main>

    <footer class="site-footer">
      <p>Generated from <code>.yoyo/journal.md</code></p>
      <a href="${repoUrl}">Back to yopedia</a>
    </footer>

    <a class="to-top" href="#top" aria-label="Go to top">Top</a>

    <script src="./assets/site.js" defer></script>
  </body>
</html>
`;
}

async function main() {
  const markdown = await readFile(journalPath, "utf8");
  const entries = parseJournal(markdown).sort((a, b) => {
    if (!a.timestamp && !b.timestamp) return 0;
    if (!a.timestamp) return 1;
    if (!b.timestamp) return -1;
    return b.timestamp.localeCompare(a.timestamp);
  });

  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });
  await cp(assetsDir, path.join(distDir, "assets"), { recursive: true });
  await writeFile(path.join(distDir, "index.html"), renderHtml(entries));
  await writeFile(
    path.join(distDir, "journal.json"),
    JSON.stringify(
      entries.map((entry) => {
        const output = { ...entry };
        delete output.bodyHtml;
        return output;
      }),
      null,
      2,
    ),
  );

  console.log(`Built ${entries.length} journal entries into ${path.relative(repoRoot, distDir)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
