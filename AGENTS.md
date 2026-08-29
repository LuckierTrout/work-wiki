<!-- bmad:context -->
<!-- Verified 2026-08-12 against 93ef3a1. Managed by bmad-project-context; edits inside this block are replaced on refresh. Keep anything you want preserved outside the markers. -->

## work-wiki

Agent-grown wiki app — "a shared second brain for humans and agents" — forked from upstream yologdev/yopedia and rebranded work-wiki. Next.js (App Router) + TypeScript on Cloudflare Workers via OpenNext (R2/KV/Vectorize/Queues), pnpm, Vitest. Vision: `work-wiki-concept.md`; wiki conventions: `SCHEMA.md`; planning artifacts: `_bmad-output/planning-artifacts/`.

## Policy

- `llm-wiki.md` is the immutable founding prompt — never edit it.
- Treat `.github/` and `.yoyo/yoyo.toml` as protected (declared in `.yoyo/yoyo.toml`); change only when explicitly asked.
- The rebrand is display-only: a fixed set of runtime identifiers is frozen and must never be renamed — see **Frozen identifiers** below the closing `bmad:context` marker for the list and its enforcing test.

## Where things are

- Wiki engine: `src/lib/` (ingest, query, lint, storage); API routes: `src/app/api/`; MCP servers: `src/mcp.ts` (stdio) and `src/lib/mcp-http.ts` (HTTP).
- The task-queue consumer is a separate Worker: `workers/task-consumer/`.
- Recorded lessons from 55+ agent sessions: `.yoyo/learnings.md` — read it before touching ingest/write-path or frontmatter-parsing code; it names the exact drift patterns that recur here.

## Running and verifying

- Fresh clone: `pnpm install` fails with ERR_PNPM_IGNORED_BUILDS until `pnpm approve-builds` is run once per machine (esbuild, sharp, onnxruntime-node, protobufjs).
- The yoyo agent workflows and GitHub deploy workflows under `.github/workflows/` are inert on this fork: jobs skip unless you opt in with a repo variable (`ENABLE_YOYO`, `ENABLE_CLOUDFLARE_DEPLOY`, `ENABLE_GITHUB_PAGES`) and the matching secrets. Production deploys are manual (`wrangler`). Do not expect a push to main to deploy anything.

## Known pitfalls

- `SCHEMA.md` is executable: its "Page conventions" section is loaded into LLM prompts at runtime on every ingest (`src/lib/schema.ts`) — editing it changes production behavior immediately, with no deploy.
- `github.com/yologdev/yopedia` links in docs and `.yoyo/journal.md` are upstream history — don't "fix" them to point at this fork.

<!-- /bmad:context -->

## Test environments

This section is deliberately outside the `bmad:context` markers, for the same
reason **Frozen identifiers** below is: that block is replaced on refresh, and
this convention has to survive it. It also has an enforcing half — the retired
claim is scanned for in `src/lib/__tests__/workbench-chrome.test.ts`, and that
scan reads this file too.

- `pnpm test` is one `vitest run` over TWO projects declared inline in
  `vitest.config.ts`. The file extension picks the project — there is no
  per-file opt-in:
  - `**/__tests__/**/*.test.tsx` ⇒ the `dom` project: `environment: "jsdom"`,
    setup files `./vitest.setup.ts` + `./vitest.setup.dom.ts`. Mount components
    here (React Testing Library).
  - `**/__tests__/**/*.test.ts` ⇒ the `node` project: `environment: "node"`,
    setup file `./vitest.setup.ts`. No DOM, no testing-library — pure functions,
    routes, and source scans.
- Run one project alone with `pnpm exec vitest run --project dom` (or
  `--project node`), optionally with a path. Note the asymmetry: run alone, a
  project whose include matches nothing exits 1, but the combined `pnpm test`
  that CI runs exits 0 — which is what the config-load guard below exists for.
- Symptom of getting it wrong: `document is not defined` (or `window is not
  defined`) at import time means a mounted suite was written as `.test.ts`.
  RENAME it to `.test.tsx`; do not add jsdom to the node project.
- The suite must live under a `__tests__` directory. `vitest.config.ts` throws at
  CONFIG LOAD when the dom include matches nothing, or when a `*.test.tsx` on
  disk falls outside it — an uncollected project does not fail a combined run, so
  a misplaced file would otherwise delete every mounted assertion while the
  report still reads "all passed".
- The shim controls are reached through one aliased door, `@/test/dom-helpers`:
  `import { setElementRect } from "@/test/dom-helpers"` from any `*.test.tsx` in
  the `dom` project, whatever its depth. DOM PROJECT ONLY — the module loads
  `vitest.setup.dom.ts`, which touches `window` at import time, so a
  `node`-project `*.test.ts` importing it dies with `window is not defined`.
  That symptom means the OPPOSITE of what the bullet above says: do not rename
  the file to `.test.tsx`; a node suite has no business driving a shim, so take
  the import out instead. The module is a RE-EXPORT and implements nothing —
  every shim still lives only in `vitest.setup.dom.ts`, and both halves share
  one module instance, so the setup file's `afterEach` resets the same
  registries a suite writes through the door.
  Do not reach past it with a relative ladder: `@/` resolves
  to `src/` and the setup files sit at the repo root, so the ladder's length
  encodes each suite's own directory depth and silently resolves elsewhere the
  moment a file moves.
- Scanning a source tree? Use `walkFiles` from `src/lib/__tests__/source-scan.ts`
  — do not hand-roll a `walk()`. It owns the one exclusion set
  (`__tests__`, `node_modules`, `.git`, `.next`; extras per call via
  `skipDirs`), matches the BASENAME, and returns absolute paths. The seven
  suites' hand-rolled copies had drifted into covering different trees before
  DW-117 merged them; `source-scan.test.ts` pins its rules, and its header names
  the three walkers deliberately left alone. The exclusions apply to CHILD directories only — the root
  argument is never name-checked. Because every caller asserts "no offenders",
  a narrowed walk passes: give each new scan a member pin naming one real file
  per subtree plus a count floor, the `english-only.test.ts` idiom.
- Shared test helpers are NOT named `*.test.ts(x)` — either project would
  otherwise collect one as a suite with no assertions in it, and the
  config-load guard rejects a `*.test.tsx` outside the dom include. There are
  six. Five sit beside the suites that use them and are imported as `./name`:
  `src/lib/__tests__/source-scan.ts`, `src/lib/__tests__/discuss-fixtures.ts`
  (the only writer of `discuss/<slug>.json` in the tests),
  `src/lib/__tests__/email-ingest-wire.ts`,
  `src/lib/__tests__/internal-link-fixture.ts` and
  `src/components/workbench/__tests__/settings-harness.tsx`.
  `src/test/dom-helpers.ts` is the exception, living outside `__tests__`
  because it must be aliasable as `@/test/…`. Nothing the app ships may
  import from `@/test/` — it pulls
  `vitest` and `@testing-library/react` and mutates `HTMLElement.prototype` at
  load. `src/lib/__tests__/test-infra-conventions.test.ts` enforces all of this.
- Browser-level questions — real layout, real focus across platforms, real
  assistive technology — are Playwright's, `pnpm test:e2e`
  (`playwright.config.ts`, specs in `e2e/`). Not in CI; run it locally. Focus
  ORDER is executable in jsdom (`workbench-sheet.test.tsx` asserts
  `document.activeElement`); what a screen reader announces is not.
- jsdom computes no layout, so every box is all-zeros and no stylesheet applies.
  `vitest.setup.dom.ts` holds every shim and nothing in `src/` does — still
  literally true alongside `@/test/dom-helpers` above, which re-exports all
  seven controls and defines none of them (pinned by
  `test-infra-conventions.test.ts`). It
  unconditionally overrides `Element.prototype.getBoundingClientRect`,
  `HTMLElement.prototype.offsetWidth`, `offsetParent`, `getClientRects`,
  `scrollIntoView`, `window.matchMedia` and `document.visibilityState` — every
  box read in the dom project goes through a wrapper, which delegates to jsdom's
  own accessor unless a test has declared otherwise.
- That declaration is `setElementRect(selector, { width })`, which is how a
  width-derived decision becomes reachable at all (declare before `render()`, and
  per test — the `afterEach` empties the registry). A declared box is a stated
  fact, not a measurement: it pins how the component REACTS to a width and can
  never catch a CSS mistake.
- When a comment explains why a rule is a pure function rather than a branch in
  JSX, name the PROJECT the file's own suite runs in ("this file's suite is the
  `node` project, which mounts nothing"). Do not justify a design by a repo-wide
  absence of a DOM test environment, and do not describe the whole runner as a
  single environment — both are false now, and the scan above rejects them.

## Frozen identifiers

This section is deliberately outside the `bmad:context` markers: that block is
replaced on refresh, and this list must survive the refresh.

- The rebrand is display-only: runtime identifiers stay `yopedia`. Renaming any of them orphans production data — new work uses work-wiki in copy, `yopedia` in identifiers.
- The frozen spellings, with the call site each was read from — one worked example per waiver, except the wire headers, which are a closed enumeration and so are spelled out member by member. Eleven of the twelve waivers are here; the twelfth, the lowercase-hyphen family, is enumerated in the bullet after this one:
  - `YOPEDIA_API_TOKEN` — the all-caps env, secret and Worker-binding family (`YOPEDIA_*`), including the `YOPEDIA_E2E` names playwright.config.ts sets and the `YOPEDIA_WEBHOOK_SIGNING_SECRET` line .env.example documents. All-caps is never display copy, which is why this waiver can be a shape.
  - `X-Yopedia-Queue-Attempt` — the retry-accounting header the producer and the consumer spell independently (workers/task-consumer/index.ts, src/app/api/tasks/run/route.ts). This is the one entry in this list a test checks on both sides.
  - `X-Yopedia-Payload-Bytes` — the declared payload size src/lib/sandbox-service.ts sends and workers/sandbox-runner/src/index.ts checks.
  - `X-Yopedia-Signature` — the integration outbox's HMAC header (src/lib/integration-outbox.ts).
  - `X-Yopedia-*` — the family itself, as src/lib/brand.ts and workers/task-consumer/index.ts write it in their comments. The wire-header family is a CLOSED enumeration, not every header spelled with that prefix: a new one must be added to it or the brand scan reads it as display prose.
  - `"yopedia"` — the string literal behind `DEFAULT_TENANT` (src/lib/links.ts), `BASE_AGENT_OWNER` (src/lib/agents.ts), `AUTOMATION_ACTORS`, and the MCP `serverInfo.name`.
  - `yopedia` — the same identifier named as itself inside a doc comment or a sentence like this one. It is waived only in its backticked form, which is why this section can discuss it at all without failing the brand scan, and why writing the bare word as display prose is still a slip.
  - `/u/yopedia` — that same tenant inlined into a URL path inside the Workers, which do not import src/lib and so cannot derive it.
  - `yopedia--research-agent` — agent ids minted from `BASE_AGENT_OWNER`; the double hyphen is the separator, not part of a name.
  - `yopedia_recent_pages` — the lowercase-underscore localStorage keys, persisted in owners' browsers.
  - `yopedia email-ingest ok` — the Workers' plaintext health-check bodies, which external uptime checks match on.
  - `yopedia.yolog.dev` — the upstream origin cited in comments.
  - `yopedia.yuanhao-li.workers.dev` — this deployment's own origin, generated from the frozen Cloudflare project name and published as the MCP endpoint in skills/. Spelled in full rather than as a host shape, so a lookalike host a future doc invents is still a slip.
  - `yologdev/yopedia` — the upstream repo link; leave it as it is.
- The lowercase-hyphen family is a CLOSED enumeration (`YOPEDIA_HYPHEN_IDENTIFIERS`, same file), not "every resource name in both wrangler.jsonc files" — it was an open lowercase-hyphen wildcard until DW-352, which waived ordinary display prose as if it were a Cloudflare resource whenever the sentence happened to hyphenate after the brand word. It covers, and covers only:
  - In both wrangler.jsonc files: `yopedia-tasks` and `yopedia-tasks-dlq` (the queue and its DLQ); `yopedia-task-consumer`, `yopedia-email-ingest` and `yopedia-sandbox-runner` (the three Worker scripts); `yopedia-raw` (R2 bucket) and `yopedia-embeddings-bge-m3` (Vectorize index).
  - Outside them: `yopedia-r2`, `yopedia-vec` and `yopedia-pages` (the three `/tmp/*.log` basenames scripts/setup-cloudflare.sh derives from those create commands — `yopedia-r2` names no resource, the bucket it logs is `yopedia-raw`); `yopedia-sandbox.internal` (the sandbox host, src/lib/sandbox-service.ts); `yopedia-monitor` (the source-monitor User-Agent, src/lib/source-monitors.ts); and `yopedia-test-` (the tmpdir prefix vitest.setup.ts mints `DATA_DIR` under — the trailing hyphen is part of the name).
  - A NEW resource in that family must be added to the enumeration or the brand scan fails it as display prose; a RETIRED one must be removed, which a minimality test enforces — a name no scanned file spells any more is a standing licence to write that word as copy. That test deliberately ignores THIS file when looking for evidence: the parity test forces the names above to be written here, so counting them would let the enumeration certify itself. The suite's own slip cases show which near-misses the word boundaries reject.
- `IDENTIFIER_ALLOWLIST` in `src/lib/__tests__/brand-copy.test.ts` is the enforcing half of the three bullets above; the prose above is the explaining half. Prose alone does not stop a rename — any spelling frozen here must also be waived there, and anything not waived there fails the brand scan. The reverse is tested too: a pattern added to the allowlist with no backticked example in this section fails the parity test, so the waiver list cannot be widened without saying here what the widening is for.
- The same freeze covers the operator-facing `WORKWIKI_*` family: the env/secret names (`WORKWIKI_URL`, `WORKWIKI_API_TOKEN`, `WORKWIKI_SYNC_*`, `WORKWIKI_SOURCE_*`), the `workwiki.app` origin, the `.workwiki-source-sync.json` state file, the `workwiki-backups` directory, the `workwiki-*.zip` archive prefix together with the prune regex that matches it, and the `workwiki-portable-archive` manifest `format` string (src/lib/portable-archive.ts), which is written into every exported archive and validated on import — renaming it breaks re-import of archives already on operators' disks.
- The same family also covers these, each verified at its call site:
  - `workwiki-actions.ics` — the `Content-Disposition` filename of the iCalendar action feed (src/app/api/integrations/calendar/route.ts). Subscribed calendar clients hold that name.
  - the `workwiki-*.zip` export filename minted by the archive export route (src/app/api/archive/export/route.ts) — a second producer of the one archive-prefix contract, alongside the archive namer and the prune regex that matches it in tools/work-wiki-sync.mjs. Renaming either producer alone splits the prefix.
  - `~/.workwiki/skills` — the user-scope Skill root the sidecar scans (`sidecar/skills.mjs`). Owners drop `SKILL.md` packs there by hand, so a rename makes their Skills silently invisible with no error to read.
  - `workwikiDefaultTags`, the browser clipper's `chrome.storage.local` key, and `save-to-workwiki`, its context-menu id (integrations/browser-clipper/) — both persist inside already-installed extensions, so a rename silently drops saved state.
  - the `www.workwiki.app` custom-domain route (wrangler.jsonc) — a separate route entry from the apex `workwiki.app` beside it, and just as live.
- One more spelling is waived without being frozen: the webhook placeholder `https://hooks.example.com/workwiki` rendered by IntegrationDesk (src/components/IntegrationDesk.tsx). It is example copy, not a production identifier — it is listed here only so a reader diffing this prose against the allowlist does not read the extra waiver as drift.
- `WORKWIKI_IDENTIFIER_ALLOWLIST` in `src/lib/__tests__/brand-copy.test.ts` is the enforcing half of the three operator-identifier bullets above; the prose above is the explaining half. Prose alone does not stop a rename — any spelling frozen here must also be waived there, and anything not waived there fails the brand scan.
- A sweep that "fixes" any of these breaks existing operator setups and strands local backups.

## Learned User Preferences

- Keep UI and LLM generation English-only; do not add Chinese or i18n.
- v1 is a private personal job tool for a single user — do not prioritize multi-user or public commons.
- Reshape the existing Next.js web app toward nashsu/llm_wiki UX parity; do not start a desktop or Tauri rewrite.
- Match nashsu Workbench density and layout from the captured screenshots; do not invent a restyle of the shell. Type is locked: system sans (SF) for chrome and Chat; Georgia for Preview page body and headings.
- Prefer BMAD Fast path (draft with assumption tags) over Coaching when a working mode is offered.
- Prefer Claude Opus 5 at high effort for bmad-loop adapter (dev and triage). Independent review is off during deferred-work culls; do not re-arm a finished bundle just because the ledger was dirty. When review is on, use Codex (`gpt-5.6-terra`), one cycle, and enforce the session budget (2.5M weighted tokens, 60-minute timeout). ChatGPT-auth Codex cannot use `gpt-5-codex`.
- Prefer bmad-loop sweep commit/finalize to proceed automatically so remaining deferred-work items can be culled.
- Sweep triage must put every open `severity: low` deferred-work entry in `skip` (project excludes low-priority residue until after Epic 8). Do not put low items in bundles, even when they share a file with a medium item. Leave low entries open; do not close them as resolved.
- Do not use Cursor IDE chat as a bmad-loop adapter; there is no shipped cursor profile.
- When implementing a story range, the implementable spec in `_bmad-output/implementation-artifacts/spec-*.md` is the sole source of truth; do not edit `<intent-contract>` in those specs, and do not treat `epics.md` planning text as the implementation contract.

## Learned Workspace Facts

- UX and functionality parity target is [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki): three-column Workbench (tree + chat + preview) plus icon sidebar. Chat is a rail icon (not a permanent center column); Preview docks when a tree pick or citation is active.
- Ingest is two sequential LLM calls (analysis, then generation), not a single read-and-write step.
- Sources auto-queue ingest on arrival (upload, folder import, URL/clip, bookmarklet, share, `/save`, email, Plaud/direct connect, API/MCP) into `raw/sources/` via Intake, not the vault `/api/ingest` queue. Raw snapshots are immutable: a changed body mints a content-hashed snapshot and leaves old bytes (`saveRawSource` is first-write-only). The web contract is not OS folder-watch.
- Meeting transcripts (especially Plaud) extract todo Candidates after successful two-step ingest — only for Plaud-origin sources or a Source marked “meeting”. Kernel store is `tenants/{t}/todos.json`; a Candidate is not a Todo until approve. The Workbench Todos rail is the HITL surface (Candidates | Open | Done). Rejected items never appear in Open; source delete marks `sourceMissing` and does not drop items.
- Final PRD: `_bmad-output/planning-artifacts/prds/prd-work-wiki-2026-08-12/`.
- Preview is view-first; markdown edit is a confirm-gated escape hatch (no WYSIWYG).
- Chat Agent, local API/MCP, and shell run on a local sidecar at `127.0.0.1:19828` (the sidecar never imports `src/lib`). Provider/Chat transport lives in `sidecar/chat-provider.mjs` and `sidecar/chat-transport.mjs`; `server.mjs` is the HTTP shell. The Workbench stays on the Next.js web app and fails closed when the sidecar is down (cloud Chat 503 `sidecar_required`). SSE events are exactly `meta`, `agent`, `done`, `cancelled`, `error`. `/api/query` is not v1 Chat. Chat and Search share one retrieval pipeline (vector off by default). Workbench Chat/Search call `send(url, init)` as a parsed-body helper (do not call `.json()` on the result). The sidecar never invents a fake `[1]`. Read-only blocks New Chat, delete, rename, send, regenerate, and settings writes. Save-to-wiki goes under `wiki/queries/`; thinking is stored but never cited or saved.
- Active UX run: `_bmad-output/planning-artifacts/ux-designs/ux-work-wiki-2026-08-12/` — `DESIGN.md` + `EXPERIENCE.md` are `status: final`. Nashsu screenshots in `imports/` are layout/density reference. Type: SF chrome, Georgia Preview. Color: nashsu light gray, black primary.
- Active architecture run: `_bmad-output/planning-artifacts/architecture/architecture-work-wiki-2026-08-12/` — `ARCHITECTURE-SPINE.md` is `status: final`. Wiki kernel (OpenNext + R2) is the system of record; local sidecar owns Chat/extract/shell/` :19828`.
- Final spec: `_bmad-output/specs/spec-work-wiki/` (`SPEC.md`, `glossary.md`, `success-metrics.md`); companions are the final PRD, UX, and architecture spine.
- Epic breakdown complete in `_bmad-output/planning-artifacts/epics.md` (8 epics, 68 stories; `stepsCompleted` through step-04). P0: Private Workbench, Sources compile, Ask the wiki, Meeting Todos; P1: See the wiki's shape, Deep Research, Any document in, Agents at the door. Office/email extract stays in Epic 7, not Epic 2. Epics 1–8 are `done` in `sprint-status.yaml` except Story 7.6 (`deferred`: Plaud publishes no consumer OAuth list/pull HTTP; do not rewrite 7.6 to email or unofficial `api.plaud.ai` — a later official-MCP pull is a new story). Story `done` is implementation complete, not retrospective acceptance. Epic 4's retrospective is optional by waiver in the Epic 5 spec. Epic 5's retro (`epic-5-retro-2026-08-23.md`) is `verdict: rejected` until remediations get a fresh exact-head review. Epic 6's retro (`epic-6-retro-2026-08-24.md`) is `verdict: accepted` at product SHA `a7dcaa78`. Epic 7's retro stays `optional`. Epic 8's retro (`epic-8-retro-2026-08-25.md`) is `verdict: accepted` at product SHA `89cfa649`; `epic-8-retro-architecture-follow-on` stays open for the ChatCanvas pending-turn/session and Settings API/MCP extracts and is not an acceptance blocker. Implementable specs are `spec-{slug}.md` in `_bmad-output/implementation-artifacts/` (`spec-dw-…` for deferred-work); compiled epic context is `epic-<N>-context.md`; planning story text stays in `epics.md`.
- `.bmad-loop/policy.toml` is gitignored and machine-local; adapter and sweep settings apply on the next local `bmad-loop` start, not via git push. Review finalize must not HALT blocked on orchestrator-owned dirty `deferred-work.md`; the orchestrator squashes that ledger into the story commit.
