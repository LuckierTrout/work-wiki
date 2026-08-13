# Reconcile: nashsu/llm_wiki_skill

**Input:** [nashsu/llm_wiki_skill](https://github.com/nashsu/llm_wiki_skill) (`SKILL.md`, `api-reference.md`, `examples.md`, `README.md`)
**Intent:** Documentation-only Agent Skill so Claude Code / Codex / any skills runtime can query the locally running wiki over HTTP+JSON (`curl`/`fetch`) — no SDK.

**Against:** FR-36, FR-76, FR-77, FR-78, FR-79; addendum *External Agent Skill*.

## What the PRD / addendum captured

- **Auth / bind:** loopback `127.0.0.1:19828`; Settings generate token; `LLM_WIKI_API_TOKEN` overrides UI (`tokenSource: env|store|none`); `allowUnauthenticated`; Bearer / `X-LLM-Wiki-Token` / `?token=` last resort (never echo); `/health` unauthenticated with `ok/status/version/enabled/authRequired/authConfigured/allowUnauthenticated/tokenSource`; stop if `authConfigured: false && allowUnauthenticated: false`; 401 / 503 `"disabled"` / 503 `"busy"` (64 in-flight); CORS `*`; timing-safe compare.
- **Routes:** health, projects `{id,name,path,current}`, files tree, files/content (whitelist `purpose.md`/`schema.md`/`wiki/**`/`raw/sources/**`, text-only, 2 MiB), hybrid search (`query/topK/includeContent/queryEmbedding`, `mode` + `tokenHits`/`vectorHits`/`vectorScore`/`images`), wikilinks graph, `sources/rescan` → `{queue, changedTasks}`. `{id}` = `current` | UUID | URL-encoded path; names resolved client-side (0 matches: ask, no silent `current`; 2+: disambiguate).
- **Limits:** body 1 MiB → 400; tree 10000 → 413; `topK` ≤ 50; graph `limit` ≤ 1000; 120 req/s → 429; 403 traversal; 415 binary.
- **Triggers / etiquette:** fire on LLM Wiki / work-wiki / “my wiki” / “my knowledge base” / id-path-`current` / ground / rescan; not generic notes / Obsidian / Notion / Logseq / files; when in doubt, ask. Cite paths; don’t dump full pages; don’t fabricate; read-only except rescan; connection-refused and `port_conflict` called out. Install: `npx skills add … --skill llm-wiki`.
- **Documented divergence (not a miss):** stock skill treats `POST /api/v1/projects/{id}/chat` as **501** (desktop WebView chat — don’t call). work-wiki **implements** it (FR-77 JSON + SSE). Addendum + FR-76/FR-79 already record this; a branded skill may document `/chat`. Review PATCH/GET/resolve are work-wiki extras, not skill-contract misses.

## Gaps vs the skill contract

1. **`files` `root` aliases** — Skill allows `root=sources` **aliases** `raw` and `raw/sources`. FR-76 lists only `wiki|sources|all`. Stock skill callers using `root=raw` would 400 unless aliased.
2. **`truncated` + no-cursor tree** — Skill `files` response includes `truncated`; examples forbid paging with `maxFiles=1,2,…` (no offset). FR-76 omits `truncated` and that anti-pattern, so agents can assume a capped tree is complete or hammer the API.
3. **Health-first probe** — Skill workflow is always `GET /health` *before* data calls, then branch on `enabled` / `authConfigured` / `tokenSource` / `port_conflict`. FR-36 has the payload; FR-79 only mentions connection-refused and `port_conflict` after failure — not the mandatory pre-flight.
4. **Project-boundary etiquette** — Skill: default to `current` and **say so once**; **confirm** a mid-conversation Wiki switch in the reply; a non-`current` `{id}` does **not** change the UI’s active Wiki. FR-76 has name-resolution rules; this conversational lock is dropped.
5. **Graph API invariants vs Workbench graph** — Skill graph is `[[wikilink]]` only: unordered-pair dedup, self-edges dropped, `weight` always `1.0`. FR-76 says “wikilinks graph” but does not lock those invariants, so implementers could wire the Workbench 4-signal graph (FR-45) onto the skill route.
