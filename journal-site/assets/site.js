const searchInput = document.querySelector("#search");
const agentFilter = document.querySelector("#agent-filter");
const sortOrder = document.querySelector("#sort-order");
const resultCount = document.querySelector("#result-count");
const entryList = document.querySelector("#entry-list");

const entries = Array.from(document.querySelectorAll(".journal-entry"));

function visibleEntries() {
  return entries.filter((entry) => !entry.hidden);
}

function updateMonthMarkers() {
  let previousMonth = "";

  for (const entry of entries) {
    const marker = entry.querySelector(".month-marker");
    marker.classList.remove("is-visible");
    marker.textContent = "";

    if (entry.hidden) continue;

    const month = entry.dataset.month;
    if (month !== previousMonth) {
      marker.textContent = entry.dataset.monthLabel || month;
      marker.classList.add("is-visible");
      previousMonth = month;
    }
  }
}

function applyFilters() {
  const query = (searchInput.value || "").trim().toLowerCase();
  const agent = agentFilter.value;
  const order = sortOrder.value;

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
  updateMonthMarkers();
}

searchInput.addEventListener("input", applyFilters);
agentFilter.addEventListener("change", applyFilters);
sortOrder.addEventListener("change", applyFilters);

applyFilters();
