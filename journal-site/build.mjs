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

const agentMeta = {
  pm: { label: "PM", className: "agent-pm", status: "merged" },
  build: { label: "Build", className: "agent-build", status: "built" },
  review: { label: "Review", className: "agent-review", status: "checked" },
  "office-hour": { label: "Office Hour", className: "agent-office-hour", status: "recorded" },
  research: { label: "Research", className: "agent-research", status: "noted" },
  architect: { label: "Architect", className: "agent-architect", status: "proposal" },
  yoyo: { label: "yoyo", className: "agent-yoyo", status: "logged" },
  unknown: { label: "Unknown", className: "agent-unknown", status: "stored" },
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
  if (normalizedTitle.includes("office hour")) return "office-hour";
  if (normalizedTitle.includes("research")) return "research";
  if (normalizedTitle.includes("architect")) return "architect";
  if (normalizedTitle.includes("pm")) return "pm";
  if (normalizedTitle.includes("build")) return "build";
  if (normalizedTitle.includes("review")) return "review";
  return "yoyo";
}

function parseHeading(heading) {
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
          </header>
          <aside class="entry-status" aria-label="Entry status">
            <span>commit ${pseudoCommit(entry)}</span>
            <span>✓ ${meta.status}</span>
          </aside>
          <section class="entry-details" aria-label="Journal entry content">
            <div class="entry-body">
              ${entry.bodyHtml}
            </div>
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
    <main class="terminal-shell">
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
            <h1>Terminal Magazine</h1>
          </div>
          <aside class="hero-panel" aria-label="Journal statistics">
            <dl class="stat-grid">
              <div>
                <dt>Entries</dt>
                <dd>: ${stats.total}</dd>
              </div>
              <div>
                <dt>Range</dt>
                <dd>: ${escapeHtml(range)}</dd>
              </div>
              <div>
                <dt>Top voice</dt>
                <dd>: ${escapeHtml(stats.topAgent.label)} (${stats.topAgent.count})</dd>
              </div>
              <div>
                <dt>Latest</dt>
                <dd>: ${stats.latest ? escapeHtml(formatDate(stats.latest.date)) : "None"}</dd>
              </div>
            </dl>
            <div class="agent-ledger" aria-label="Entries by agent">
              <span>Agents</span>
              ${renderAgentStats(stats)}
            </div>
          </aside>
        </div>
      </header>

      <section class="command-bar" aria-label="Timeline command">
        <span>$ journal --timeline --follow</span>
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

      <section class="archive-shell" aria-label="Journal archive">
        <div class="archive-label">
          <span>Timeline</span>
          <strong>Generated from .yoyo/journal.md</strong>
        </div>
        <div id="entry-list" class="entry-list">
          ${renderEntries(entries)}
        </div>
      </section>
    </main>

    <footer class="site-footer">
      <p>$ generated from <code>.yoyo/journal.md</code></p>
      <a href="${repoUrl}">Back to yopedia</a>
    </footer>

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
