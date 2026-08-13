---
name: review-reconcile-brownfield
type: document-review
status: complete
reviewed: ARCHITECTURE-SPINE.md
against:
  - .yoyo/learnings.md (write-path, frontmatter, embeddings, SCHEMA.md, format-split)
  - src/lib/lifecycle.ts
  - workers/task-consumer/index.ts
  - wrangler.jsonc
  - workers/task-consumer/wrangler.jsonc
  - package.json
  - src/lib/ingest.ts
  - src/lib/embeddings.ts
  - src/lib/mcp-http.ts
  - src/middleware.ts
created: 2026-08-12
reviewer: bmm-document-reviewer
verdict: not-ready-to-finalize
completeness: 71
---

# Architecture ↔ brownfield reconciliation — work-wiki

**Spine reviewed:** `_bmad-output/planning-artifacts/architecture/architecture-work-wiki-2026-08-12/ARCHITECTURE-SPINE.md` (`status: draft`, `updated: 2026-08-12`)

**Brownfield:** repo HEAD as of this review. Learnings: `.yoyo/learnings.md`. Kernel write path: `src/lib/lifecycle.ts`. Queue worker: `workers/task-consumer/index.ts` + `wrangler.jsonc`. Stack: `package.json`.

**This review does not edit the spine.** Patches belong in a later architecture pass.

---

## 1. Executive summary

The spine is a usable **target** substrate (two runtimes, `lifecycle.ts` as the Page mutation gate, `yopedia` identifiers, thin queue dispatcher, SCHEMA.md loaded at runtime). It is **not yet a faithful bind** to this fork’s code and recorded lessons.

Three classes of error will mislead implementers:

1. **Stated as present, actually absent or opposite.** Vector search is **on** in production when the `AI` binding exists (`embeddings.ts` auto-selects Workers AI). Ingest skip-hash is **FNV-1a**, not SHA-256. Web clips are Readability + **linkedom**, not Turndown. Graph is a **custom canvas + label propagation**, not sigma/Louvain. `dataVersion` does not exist.
2. **Private-by-default (AD-8 / AD-21) vs a live public commons.** Middleware leaves GET `/api/**` public. Ingest writes `visibility: "public"`. MCP HTTP reads run with a null principal. `syncCommonsForPage` is a **live** lifecycle side-effect, not a no-op. `/waitlist` still exists.
3. **Unmapped brownfield that will fork epics.** Kernel `query.ts` + `/api/query` is a Worker-side LLM loop (the current “chat”). The task-consumer is not only a queue dispatcher: it also cron-scans, and `AUTONOMOUS_MAINTENANCE` is `"on"`. Consumer `YOPEDIA_URL` points at upstream `https://yopedia.yolog.dev`.

**Readiness:** **Not ready to Finalize.** Keep AD-1–AD-3, AD-7, AD-10, AD-13 (dispatcher contract), AD-15. Patch AD-8/AD-12/AD-9 hash/AD-16 Turndown, inventory the commons/query/cron leftovers, and ratify remaining learnings before Finalize.

**Completeness (brownfield reconciliation):** **71%.** Identifiers, lifecycle gate, SCHEMA.md, stack pin, consumer ack/retry, and embedding **model tags** match. Auth default, embedding default, ingest hash, graph current, query-vs-Chat, consumer cron/URL, and several learnings do not.

---

## 2. What already aligns (do not reopen)

| Topic | Spine | Brownfield | Status |
| --- | --- | --- | --- |
| Runtime IDs stay `yopedia` | AD-7 | `DEFAULT_TENANT` / `BASE_AGENT_OWNER` / MCP `name: "yopedia"` / wrangler `name: "yopedia"` / `YOPEDIA_*` bindings / `AUTOMATION_ACTORS` includes `"yopedia"` | Aligned |
| Display name `work-wiki` | Conventions | `package.json` `"name": "work-wiki"` | Aligned |
| Page writes go through lifecycle | AD-3 | `writeWikiPageWithSideEffects` / `deleteWikiPage` wrap `runPageLifecycleOp`; ingest, query-save, MCP, CLI, lint-fix (most ops), merge, publish, patch-metadata, agents call it | Aligned (see M3 for remaining bypasses) |
| Delete is a lifecycle op | AD-3 + learnings | `runPageLifecycleOp` kinds `write` \| `delete` in `lifecycle.ts` header | Aligned — code already did the deep fix the learning asked for |
| SCHEMA.md loaded at runtime | AD-10 | `src/lib/schema.ts` `loadPageConventions()`; used by ingest, query, lint | Aligned |
| Frontmatter not all-strings | Conventions | `Frontmatter` is `string \| string[] \| number \| boolean`; `coerceScalar` + schema-aware quoted-number/bool fix | Aligned with the type-narrowing learning |
| Embedding vectors tagged with model | AD-12 (tag half) | `EmbeddingMeta.model` + `modelMatches()`; mismatch dropped, BM25 remains | Aligned with the stored-embeddings learning |
| Ingest succeeds without vectors | AD-12 (fallback half) | `hasEmbeddingSupport()` / null provider → no embed; query/search have BM25 | Aligned as capability; **default-on is not** (C1) |
| ANN is Vectorize, not LanceDB | AD-12 | `wrangler.jsonc` `YOPEDIA_VECTORIZE` + alias `VECTORIZE` → `yopedia-embeddings`; no LanceDB | Aligned |
| Storage port | AD-2 | `StorageProvider`; R2 in Workers, filesystem in `next dev` | Aligned |
| Task-consumer imports no `src/lib` | AD-13 | Header + implementation: `fetch` to `/api/tasks/run` only | Aligned |
| Ack map 2xx / 4xx poison / 5xx retry | AD-13 | `workers/task-consumer/index.ts` | Aligned |
| Queue names + `max_retries: 3` | AD-9, Stack | `yopedia-tasks` / `yopedia-tasks-dlq`; consumer wrangler `max_retries: 3` | Aligned |
| Dual Vectorize binding names | Conventions | Both `YOPEDIA_VECTORIZE` and `VECTORIZE` on the same index | Aligned — do not “clean up” the alias |
| Stack pin vs repo today | Stack, AD-15 | `next@15.5.18`, `@opennextjs/cloudflare@^1.19.10`, react 19.1.0, clerk ^7.4.2, ai ^6.0.146, wrangler ^4.92.0, vitest ^3, zod ^4.4.2, MCP SDK ^1.29.0, readability ^0.6.0 | Aligned |
| `compatibility_date` | Stack | `2025-01-01` in both wrangler files | Aligned |
| Ingest compile stays in TS kernel | AD-4 | `src/lib/ingest.ts`; sidecar/ does not exist | Aligned as direction; today’s pipeline is not two-step Analysis→Generation (H4) |
| MCP server name | AD-7 | `src/mcp.ts` `name: "yopedia"` | Aligned |
| No `child_process` in Worker | AD-1 | No matches in `src/` | Aligned |
| Kernel does not import `src/app` (prod) | Paradigm note | Only test files import route handlers | Aligned |
| `unpdf` still in the Worker | AD-16 (prevent) | `package.json` + `src/lib/fetch.ts` `pdfToText` | Correctly named as the thing to stop using as the v1 extract path |

---

## 3. Issue list

### CRITICAL

#### C1 — AD-12 “vector search is off by default” is false in this repo

**Where:** Spine AD-12; Consistency “Config”; `src/lib/embeddings.ts` `resolveEmbeddingProvider()` (~L93–94); `wrangler.jsonc` `"ai": { "binding": "AI" }`.

**Brownfield:** If no `EMBEDDING_PROVIDER` override is set, the resolver **auto-selects `workers-ai` whenever the `AI` binding is present**. Production wrangler binds `AI`. Ingest will embed. This is the opposite of “off by default.”

This is the same class of silent failure the embeddings learning warned about: the “optional” path is the one that actually runs in the typical deploy, and the BM25-only path is under-tested in production.

**Fix:** Rewrite AD-12 to two sentences: (1) **Today** Workers AI auto-enables when `AI` is bound; ingest embeds. (2) **v1 rule:** vector search is opt-in (Settings / explicit provider); unbind or ignore `AI` until the owner turns it on; ingest must still succeed with embeddings off. Do not leave “off by default” as if it were current behavior.

---

#### C2 — AD-8 / AD-21 private-by-default vs a live public-read wiki

**Where:** Spine AD-8, AD-21; `src/middleware.ts` L6–10, L30–36; `src/lib/ingest.ts` ~L1641 `visibility: "public"`; `src/lib/mcp-http.ts` L17–19; `src/app/api/mcp/route.ts` L27–28; `src/lib/lifecycle.ts` ~L404 `syncCommonsForPage`; `src/app/waitlist/[[...waitlist]]/page.tsx`.

**Brownfield:**

- Middleware: mutating `/api/**` needs a session; **GET/HEAD stay public** — comment still says “work-wiki is a public observer surface.”
- New pages default to `visibility: "public"`.
- HTTP MCP: **no token → reads still work** (public commons). Stdio MCP uses `null` principal for visibility.
- `syncCommonsForPage` is invoked on every lifecycle write (fail-soft), not a no-op.
- `/waitlist` is a live Clerk waitlist page whose comment says commons reading stays fully public.
- Share (`/share/...`), browse (`/api/wiki/browse`), profile (`/u/[handle]`), graph default scope = commons (`graph-build.ts`).

AD-8 correctly flags `mcp-http.ts` as leftover. It does **not** inventory the rest. An epic that only auths MCP will leave the public lab standing.

**Fix:** Add a brownfield cut-list under AD-8/AD-21: middleware public GET, ingest default visibility, MCP unauthenticated reads (HTTP **and** stdio), live `syncCommonsForPage`, `/waitlist`, `/share`, unscoped graph/browse. State the v1 defaults: Clerk (or owner token) on **reads**; new Pages `visibility: private` (or omit commons membership); `syncCommonsForPage` no-op **and** no remaining callers that assume a populated commons index.

---

### HIGH

#### H1 — Kernel `query.ts` is a Worker-side agent; spine never maps it

**Where:** Spine AD-1, AD-5, AD-6, capability map “Chat Agent → sidecar”; `src/lib/query.ts`; `src/app/api/query/route.ts`, `.../stream/route.ts`, `.../save/route.ts`; `src/app/query/page.tsx`.

**Brownfield:** Query is an isolate LLM loop (retrieve → `callLLM` / `streamText` → optional `writeWikiPageWithSideEffects`). That is the current chat/Q&A product. AD-1/AD-5 forbid a Chat Agent tool loop in the Cloudflare isolate, but they never say whether **query is replaced by sidecar Chat**, kept as kernel RAG, or both.

**Fix:** Ratify one line: v1 Chat Agent = sidecar only; kernel `query.ts` is **retired from the Workbench Chat path** (keep as library for Save-to-Wiki / tests only, or delete in a named epic). Do not leave two answer engines.

---

#### H2 — AD-13 omits cron, autonomous maintenance, and upstream `YOPEDIA_URL`

**Where:** Spine AD-13; `workers/task-consumer/index.ts` `scheduled()` (~L95–114); `workers/task-consumer/wrangler.jsonc` `crons: ["0 6 * * *"]`, `vars.YOPEDIA_URL: "https://yopedia.yolog.dev"`; main `wrangler.jsonc` `AUTONOMOUS_MAINTENANCE: "on"`, `NEXT_PUBLIC_OWNER_HANDLE: "yuanhao"`.

**Brownfield:** The consumer is a thin **queue** dispatcher **plus** a daily POST to `/api/tasks/scan`. With maintenance `"on"`, scan enqueues reconcile / lint-fix / reingest. `YOPEDIA_URL` still targets **upstream yopedia.yolog.dev**. Owner handle is still **yuanhao**.

**Fix:** Extend AD-13: consumer may cron-scan **only if** v1 wants autonomous maintenance; default it **off** for a private personal wiki. Ratify that this fork must set `YOPEDIA_URL` to the fork’s Worker origin (name stays `yopedia-*` per AD-7; **URL is not a resource name**). Call out `NEXT_PUBLIC_OWNER_HANDLE` as a display/runtime leftover to replace, not an identifier to preserve.

---

#### H3 — “SHA256 skip” is not what ingest does

**Where:** Spine Consistency “Ingest jobs \| SHA256 skip”; AD-9; `src/lib/embeddings.ts` `contentHash()` (FNV-1a, 16 hex chars); `src/lib/ingest.ts` uses that hash for dedup (`resolveContentHash`).

**Brownfield:** Skip/dedup is **FNV-1a**, not SHA-256. Nashsu-style SHA256 incremental cache is a **change**, not current behavior. Tests even use placeholder strings like `"sha256-abc"` as opaque keys.

**Fix:** Say: today FNV-1a `contentHash`; v1 ingest skip key is SHA-256 of source bytes (FR-39 / nashsu parity). Do not write “SHA256 skip” as if `lifecycle`/`ingest` already did it.

---

#### H4 — AD-4 “single-shot `ingest.ts`” underspecifies today’s LLM shape

**Where:** Spine AD-4, Structural Seed; `src/lib/ingest.ts` `synthesizeBody()` (~L1393–1448).

**Brownfield:** Short docs: **one** `callLLM`. Long docs: **map/reduce** (bounded parallel map + reduce) — already multiple LLM calls, but they are coverage-chunking, **not** Analysis then Generation. Reconcile/merge add more calls. There is no retained Analysis artifact.

**Fix:** Replace “single-shot” with: today’s compile is `synthesizeBody` (1-shot or map/reduce) + optional reconcile. v1 replaces that with **two sequential named steps** (Analysis artifact persisted, then Generation), still in `ingest.ts`, still through `lifecycle.ts`. Map/reduce may remain inside a step; it is not the two-step pipeline.

---

#### H5 — AD-14 describes a graph stack the repo does not have

**Where:** Spine AD-14, Stack table (sigma/graphology/\*); `src/lib/graph.ts` (label propagation); `src/lib/graph-render.ts` + `src/hooks/useGraphSimulation.ts` (custom canvas physics); `src/lib/graph-build.ts` (wikilink edges only); `package.json` (no sigma/graphology).

**Brownfield:** Kernel graph API is **link-count + undirected wikilinks**. Communities are **deterministic label propagation**, not Louvain. Viz is **custom canvas**, which AD-14 explicitly prevents. 4-signal Relevance is not implemented.

**Fix:** Mark AD-14 as **replace**, not **keep**: delete/stop extending `graph-render` / `useGraphSimulation` / `detectCommunities`; add sigma+graphology; move Louvain + 4-signal Relevance into the kernel graph API. Do not imply the kernel already owns Louvain.

---

#### H6 — AD-16 “Turndown already in the app” is false

**Where:** Spine AD-16; `package.json`; `src/lib/fetch.ts` `fetchUrlContent` (Readability + **linkedom**, regex fallback). **No `turndown` dependency.**

**Fix:** Web clips today: `@mozilla/readability` + `linkedom` → text. v1 either (a) add Turndown for markdown clips, or (b) keep linkedom text and drop Turndown from the spine. Do not claim the crate/package is present.

---

### MEDIUM

#### M1 — Hexagonal paradigm overclaims the kernel

**Where:** Spine “Design Paradigm”; mermaid “LLM port”; `src/lib/wiki.ts` (god module + re-exports); `src/lib/llm.ts` (`callLLM` concrete providers, no port interface).

**Brownfield:** Storage **is** a port (`StorageProvider`). LLM and embeddings are concrete modules. `src/lib` is a layered library, not two hexagons with explicit ports. The two-runtime split is still the right target.

**Fix:** One sentence: hexagonal is the **direction** (storage already, LLM/embeddings to follow); do not invent a port layer in the spine that code does not have.

---

#### M2 — AD-9 “serial per Wiki” is not a Wiki lock

**Where:** Spine AD-9; `workers/task-consumer/index.ts` sequential `for` over a batch (`max_batch_size: 5`); `src/lib/ingest-async.ts` `enqueueOrInline` (local **inline** ingest, no queue).

**Brownfield:** One consumer instance processes messages **one after another** (global, not per-Wiki). Local `next dev` runs ingest **inline and concurrently** across requests. There is no per-Wiki compile mutex.

**Fix:** Ratify: production seriality = single consumer loop (good enough for v1 one-wiki); local inline may overlap — either accept or add a Wiki lock. “Per Wiki” only matters if v1 ever has more than one Wiki.

---

#### M3 — Remaining write-path exceptions

**Where:** AD-3 “Do not add a second markdown writer”; `src/lib/lint-fix.ts` `fixStaleIndex` uses `updateIndex` + `appendToLog` outside `runPageLifecycleOp`; `lifecycle.ts` backlink strip calls `writeWikiPage` directly (internal); `writeWikiPage` remains a public export used heavily in tests.

**Fix:** Name allowed exceptions: (1) internal backlink rewrite inside the lifecycle op; (2) index-only stale-row cleanup. Keep `writeWikiPage` unexported from the public kernel API if the lesson is to be durable. Spine can keep the two wrappers as the **external** contract; mention `runPageLifecycleOp` as the actual unit (learnings: delete is the same pipeline).

---

#### M4 — Frontmatter “typed” still stores `sources` as a JSON string; `source_count` as string

**Where:** Spine Conventions “typed frontmatter (not all-strings)”; learnings “split by access pattern”; `src/lib/sources.ts`; `ingest.ts` `source_count: "1"`; `lifecycle.ts` comment “source_count is persisted as a string.”

**Brownfield:** Numbers/bools were fixed. `sources` is still a JSON blob in YAML (the format-split learning). Agent profiles already split: `agents/<id>.json` vs `wiki/<slug>.md`.

**Fix:** Ratify: keep JSON-in-YAML for `sources` in v1 **or** move sources to a sidecar index — pick one. Add `agents/*.json` to Structural Seed. Do not claim the frontmatter schema is fully typed.

---

#### M5 — AD-11 `dataVersion` is greenfield

**Where:** Spine AD-11; no `dataVersion` in `src/`.

**Fix:** Label as **new store signal** (KV/fs counter bumped in `runPageLifecycleOp`). Not an existing field.

---

#### M6 — Dual `/api/v1` has no current routes; existing `/api/*` tree is unmapped

**Where:** Spine AD-6, capability map; `src/app/api/**` (wiki, query, ingest, mcp, tasks, settings, agents, vaults, lint, admin, …). **Zero** `api/v1` files.

**Fix:** Add a one-row map: cloud façade **adapts** today’s `/api/wiki|ingest|mcp|…` to nashsu `/api/v1` shapes (or mounts both). Sidecar loopback implements the nashsu shapes natively. Do not imply `/api/v1` already exists on OpenNext.

---

#### M7 — Learnings not ratified (non-write-path)

| Learning | Gap |
| --- | --- |
| Default provider may not support embeddings | AD-12 fights this (C1). Anthropic-only still has **Workers AI auto-on** in prod, so the “fallback is the real path” lesson is inverted in Cloudflare. |
| Lazy stream APIs vs retry wrappers | `llm.ts` documents non-transfer of `retryWithBackoff` to `streamText`. Spine Chat SSE (sidecar) should say: retry at the stream consumer, not around stream setup. |
| Config store vs env readers | `embeddings.ts` now uses `loadConfigSync()`. Spine Config row should say: Settings JSON + env; every new reader must consult `loadConfigSync`, not raw `process.env` only. |
| Error classification by structure | `llm.ts` prefers `.status` then tight message patterns. Sidecar/kernel HTTP errors should follow that, not regex on LLM text. |
| Derive metadata from source, not LLM output | Ingest `extractSummary(content)` already uses raw source. Keep that when splitting Analysis/Generation — do not parse `## Summary` out of Generation. |
| Prompts load the doc | Already AD-10. Also load for **Chat** (sidecar must fetch conventions via kernel HTTP, not fork SCHEMA into Rust). |

---

#### M8 — ER / capability leftovers vs code names

**Where:** Spine erDiagram `Conversation`, `ReviewItem`, `TodoCandidate`; brownfield `query-history.json`, `talk.ts` discussions, **no todo module**.

**Fix:** Map Conversation → query-history (or sidecar Chat transcripts). ReviewItem → talk/discuss (AD-21 404s public talk; private Review is new). Todos are **new**. Do not implement a second discussion system beside `talk.ts` without saying talk is replaced.

---

#### M9 — `unpdf` + vision ingest still in the kernel (expected, but unscoped)

**Where:** AD-16; `ingestPdf` / `ingestImage` in `ingest.ts` + `/api/ingest/pdf|image`.

**Fix:** Explicit cut: Worker PDF/image extract routes become “accept pre-extracted text” or proxy-from-sidecar; vision description stays kernel **or** moves with extract — pick. Leaving both unpdf and sidecar pdf-extract will fork.

---

### LOW

#### L1 — `eslint-config-next` is still `15.5.18`

AD-15 bumps `next` + OpenNext only. Bump `eslint-config-next` in the same change.

#### L2 — `package.json` has no `engines`

Spine lists Node `>=20.9.0`. Optional to add; not a contradiction.

#### L3 — Test comment drift

`src/lib/__tests__/silo.test.ts` comment still says `DEFAULT_TENANT` is `"work-wiki"`; the assertion is `"yopedia"`. Do not “fix” AD-7 from that comment.

#### L4 — Commons “billing” in AD-21

No billing routes found under `src/`. Waitlist exists; billing may already be gone. Trim the cut-list to files that exist.

#### L5 — Structural Seed `sidecar/` absent

Correct as target. Fine.

---

## 4. Decision-by-decision scorecard

| AD | Bind quality | Note |
| --- | --- | --- |
| AD-1 Two-runtime | Partial | Sidecar absent (OK). Kernel query **is** an isolate agent (H1). |
| AD-2 SoR | Good | R2/KV/fs split matches. |
| AD-3 Lifecycle | Good | Deep learning already implemented; name `runPageLifecycleOp` (M3). |
| AD-4 Ingest compile in kernel | Partial | Right home; wrong description of today’s LLM shape (H4). |
| AD-5 Chat/extract at browser | Partial | Target OK; query + unpdf still in Worker (H1, M9). |
| AD-6 Dual `/api/v1` | Greenfield | No routes yet (M6). |
| AD-7 `yopedia` IDs | Good | Do not preserve `yuanhao` / `yolog.dev` URL (H2). |
| AD-8 Private auth | Poor vs code | MCP leftover named; middleware/ingest/waitlist/commons not (C2). |
| AD-9 Serial ingest | Partial | Queue sequential; hash is FNV not SHA256 (H3, M2). |
| AD-10 SCHEMA.md | Good | |
| AD-11 dataVersion | Greenfield | OK if labeled new (M5). |
| AD-12 Embeddings | Contradicts | Tags yes; default-off no (C1). |
| AD-13 Thin consumer | Partial | Dispatcher yes; cron/URL/maintenance omitted (H2). |
| AD-14 Graph viz | Replace | Custom canvas + label-prop live (H5). |
| AD-15 Next/OpenNext bump | Good | Matches package.json. |
| AD-16 Extract crates | Partial | unpdf correctly forbidden; Turndown false (H6). |
| AD-17 Device split | Greenfield | OK. |
| AD-18 Tavily | Greenfield | No DR code. |
| AD-19 MinerU off | Greenfield | OK. |
| AD-20 Todo TTL | Greenfield | No todo module. |
| AD-21 Commons 404 | Target vs live | Inventory incomplete (C2). |

---

## 5. Completeness

| Required element | Weight | Score |
| --- | --- | --- |
| Write-path / lifecycle vs learnings | 15 | 13 |
| Frontmatter typing + sources format | 8 | 5 |
| Embeddings optional + model tag + default | 12 | 6 |
| SCHEMA.md executable | 6 | 6 |
| Auth / commons vs private v1 | 12 | 5 |
| Task-consumer + queue + cron | 10 | 6 |
| Identifiers + wrangler bindings + stack | 10 | 9 |
| Ingest LLM shape (two-step vs today) | 8 | 5 |
| Chat/query split | 8 | 3 |
| Graph current vs AD-14 | 6 | 2 |
| Remaining learnings (stream retry, config readers, metadata-from-source, JSON/md split) | 5 | 2 |
| **Total** | **100** | **71** |

**71%** — enough to keep the paradigm; not enough to Finalize without the C/H patches.

---

## 6. Risk if implemented as written

| Risk | From | Impact |
| --- | --- | --- |
| Production ingest always hits Workers AI / Vectorize | C1 | Cost, latency, “embeddings off” Settings lie; mixed-model danger if someone later toggles providers |
| v1 ships a public commons | C2 | Contradicts FR-1 / private personal wiki; MCP and GET stay world-readable |
| Two Chat implementations | H1 | Sidecar Agent + kernel query drift (exactly the parallel-write lesson, for answers) |
| Fork consumer talks to upstream yopedia | H2 | Tasks execute on the wrong host; `yuanhao` owner gates |
| Autonomous reingest/lint while “private v1” | H2 | Unattended writes to the wiki |
| Dedup bugs / nashsu mismatch | H3 | SHA256 work duplicated or skipped |
| Graph epic extends custom canvas | H5 | Second renderer after sigma lands |
| Missing Turndown at clip time | H6 | Broken Capture/markdown clips |

**Mitigation:** Patch the spine ADs listed above before story breakdown. Do not start extract/Chat/graph/auth epics from the current draft text.

---

## 7. Recommended spine patches (do not apply in this review)

1. **AD-12:** Current = Workers AI auto-on when `AI` bound. v1 = opt-in; ingest must succeed with embeddings off; keep model tags.
2. **AD-8 + AD-21:** Full cut-list (middleware GET, ingest `visibility`, MCP HTTP+stdio, `syncCommonsForPage`, waitlist/share/browse/unscoped graph).
3. **AD-9 / Conventions:** FNV-1a today → SHA-256 skip as the change. Seriality = consumer loop; local inline overlap called out.
4. **AD-4:** `synthesizeBody` / map-reduce today → Analysis artifact then Generation.
5. **AD-5 / capability map:** Kernel `query.ts` retired from Chat; sidecar is the only Agent loop.
6. **AD-13:** Cron + `AUTONOMOUS_MAINTENANCE` default off; `YOPEDIA_URL` retarget; `NEXT_PUBLIC_OWNER_HANDLE` not an AD-7 sacred name.
7. **AD-14:** Replace custom canvas + label-prop; kernel does not yet own Louvain/4-signal.
8. **AD-16:** Readability + linkedom today; Turndown only if added.
9. **Learnings:** Chat loads SCHEMA via kernel HTTP; metadata from source not Generation; config readers use `loadConfigSync`; stream retry at consume time; `agents/*.json` in Structural Seed.

---

## 8. Verdict

**Not ready to Finalize.** Brownfield bind is strong on identifiers, lifecycle, SCHEMA.md, stack, and the thin dispatcher **fetch** path. It is weak or wrong on embedding defaults, private-read, ingest hash, query-vs-Chat, consumer cron/URL, graph current stack, and Turndown.

Re-review after the patches in §7; do not re-open PRD/UX locks to fix these — they are architecture-vs-code, not product-vs-UX.
