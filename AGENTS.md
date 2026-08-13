<!-- bmad:context -->
<!-- Verified 2026-08-12 against 93ef3a1. Managed by bmad-project-context; edits inside this block are replaced on refresh. Keep anything you want preserved outside the markers. -->

## work-wiki

Agent-grown wiki app — "a shared second brain for humans and agents" — forked from upstream yologdev/yopedia and rebranded work-wiki. Next.js (App Router) + TypeScript on Cloudflare Workers via OpenNext (R2/KV/Vectorize/Queues), pnpm, Vitest. Vision: `work-wiki-concept.md`; wiki conventions: `SCHEMA.md`; planning artifacts: `_bmad-output/planning-artifacts/`.

## Policy

- `llm-wiki.md` is the immutable founding prompt — never edit it.
- Treat `.github/` and `.yoyo/yoyo.toml` as protected (declared in `.yoyo/yoyo.toml`); change only when explicitly asked.
- The rebrand is display-only: runtime identifiers stay `yopedia` — `DEFAULT_TENANT` (src/lib/links.ts), `BASE_AGENT_OWNER` (src/lib/agents.ts), `AUTOMATION_ACTORS`, the MCP server name, localStorage keys, `YOPEDIA_*` env/secret names, and every resource name in both wrangler.jsonc files. Renaming any of them orphans production data — new work uses work-wiki in copy, `yopedia` in identifiers.

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

## Learned User Preferences

- Keep UI and LLM generation English-only; do not add Chinese or i18n.
- v1 is a private personal job tool for a single user — do not prioritize multi-user or public commons.
- Reshape the existing Next.js web app toward nashsu/llm_wiki UX parity; do not start a desktop or Tauri rewrite.
- Match nashsu Workbench density and layout from the captured screenshots; do not invent a restyle of the shell. Type is locked: system sans (SF) for chrome and Chat; Georgia for Preview page body and headings.
- Prefer BMAD Fast path (draft with assumption tags) over Coaching when a working mode is offered.

## Learned Workspace Facts

- UX and functionality parity target is [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki): three-column Workbench (tree + chat + preview) plus icon sidebar. Chat is a rail icon (not a permanent center column); Preview docks when a tree pick or citation is active.
- Ingest is two sequential LLM calls (analysis, then generation), not a single read-and-write step.
- Sources auto-queue ingest on arrival (upload, folder import, email, Plaud/direct connect, API/MCP); the web contract is not OS folder-watch.
- Meeting transcripts (especially Plaud) should extract todos with approve/reject, due dates, and links back to the source page — only for Plaud-origin sources or a Source marked “meeting”.
- Final PRD: `_bmad-output/planning-artifacts/prds/prd-work-wiki-2026-08-12/`.
- Preview is view-first; markdown edit is a confirm-gated escape hatch (no WYSIWYG).
- Chat Agent, local API/MCP, and shell run on a local sidecar; the Workbench stays on the Next.js web app.
- Active UX run: `_bmad-output/planning-artifacts/ux-designs/ux-work-wiki-2026-08-12/` — `DESIGN.md` + `EXPERIENCE.md` are `status: final`. Nashsu screenshots in `imports/` are layout/density reference. Type: SF chrome, Georgia Preview. Color: nashsu light gray, black primary.
- Active architecture run: `_bmad-output/planning-artifacts/architecture/architecture-work-wiki-2026-08-12/` — `ARCHITECTURE-SPINE.md` is `status: final`. Wiki kernel (OpenNext + R2) is the system of record; local sidecar owns Chat/extract/shell/` :19828`.
- Final spec: `_bmad-output/specs/spec-work-wiki/` (`SPEC.md`, `glossary.md`, `success-metrics.md`); companions are the final PRD, UX, and architecture spine.
- Epic breakdown complete in `_bmad-output/planning-artifacts/epics.md` (8 epics, 68 stories; `stepsCompleted` through step-04). P0: Private Workbench, Sources compile, Ask the wiki, Meeting Todos; P1: See the wiki's shape, Deep Research, Any document in, Agents at the door. Office/email extract stays in Epic 7, not Epic 2. Next planning gate is sprint planning.
