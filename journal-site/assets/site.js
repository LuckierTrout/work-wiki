const searchInput = document.querySelector("#search");
const agentFilter = document.querySelector("#agent-filter");
const sortOrder = document.querySelector("#sort-order");
const resultCount = document.querySelector("#result-count");
const entryList = document.querySelector("#entry-list");
const emptyState = document.querySelector("#empty-state");

const entries = Array.from(document.querySelectorAll(".journal-entry"));
const monthLinks = Array.from(document.querySelectorAll("[data-month-link]"));
const toggles = Array.from(document.querySelectorAll(".entry-toggle"));

function visibleEntries() {
  return entries.filter((entry) => !entry.hidden);
}

function updateMonthMarkers() {
  let previousMonth = "";

  for (const entry of Array.from(entryList.querySelectorAll(".journal-entry"))) {
    const marker = entry.querySelector(".month-marker");
    marker.classList.remove("is-visible");
    marker.textContent = "";
    marker.removeAttribute("id");

    if (entry.hidden) continue;

    const month = entry.dataset.month;
    if (month !== previousMonth) {
      marker.id = `month-${month}`;
      marker.textContent = entry.dataset.monthLabel || month;
      marker.classList.add("is-visible");
      previousMonth = month;
    }
  }
}

function updateMonthLinks() {
  const visibleMonths = new Set(visibleEntries().map((entry) => entry.dataset.month));

  for (const link of monthLinks) {
    const enabled = visibleMonths.has(link.dataset.monthLink);
    link.toggleAttribute("aria-disabled", !enabled);
  }
}

function applyFilters() {
  const query = (searchInput.value || "").trim().toLowerCase();
  const agent = agentFilter.value || "all";
  const order = sortOrder.value || "newest";

  const sorted = [...entries].sort((a, b) => {
    const result = a.dataset.date.localeCompare(b.dataset.date);
    return order === "oldest" ? result : -result;
  });

  for (const entry of sorted) {
    entryList.append(entry);
  }

  for (const entry of entries) {
    const matchesQuery = query.length === 0 || entry.dataset.search.includes(query);
    const matchesAgent = agent === "all" || entry.dataset.agent === agent;
    entry.hidden = !(matchesQuery && matchesAgent);
  }

  const count = visibleEntries().length;
  const label = `${count} ${count === 1 ? "entry" : "entries"}`;
  resultCount.value = label;
  resultCount.textContent = label;
  emptyState.hidden = count !== 0;
  updateMonthMarkers();
  updateMonthLinks();
}

function setEntryExpanded(entry, expanded) {
  const toggle = entry.querySelector(".entry-toggle");
  entry.dataset.expanded = String(expanded);
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.textContent = expanded ? "Collapse entry" : "Read full entry";
}

function expandHashEntry() {
  const id = decodeURIComponent(window.location.hash.slice(1));
  if (!id) return;

  const entry = document.getElementById(id);
  if (!entry || !entry.classList.contains("journal-entry")) return;

  setEntryExpanded(entry, true);
}

searchInput.addEventListener("input", applyFilters);
agentFilter.addEventListener("change", applyFilters);
sortOrder.addEventListener("change", applyFilters);

for (const toggle of toggles) {
  toggle.addEventListener("click", () => {
    const entry = toggle.closest(".journal-entry");
    const expanded = entry.dataset.expanded === "true";
    setEntryExpanded(entry, !expanded);
  });
}

window.addEventListener("hashchange", expandHashEntry);

applyFilters();
expandHashEntry();
