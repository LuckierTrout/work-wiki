# Epic 1 Context: Private Workbench

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Turn the existing public-commons wiki app into a private, single-operator Workbench. The owner signs in with Clerk, creates a named Wiki from one of five Scenario Templates, and works inside a single dense shell — icon rail, Knowledge/File trees, view-first Preview, drag-resizable and durable layout. Every public leftover (commons, browse, waitlist, billing, clone-to-private, talk) stops being reachable. LLM and embedding settings exist so later epics (Ingest, Chat) have keys and models to run against. This epic establishes the shell, the auth posture, and the state/refresh plumbing that all later epics build inside; it ships no Ingest, Chat, Graph, or Review functionality of its own.

## Stories

- Story 1.1: Sign in privately and retire commons
- Story 1.2: Create a Wiki from a Scenario Template
- Story 1.3: Nashsu icon rail and Workbench chrome
- Story 1.4: Knowledge Tree and File Tree
- Story 1.5: View-first Preview with GFM and wikilinks
- Story 1.6: Drag-resize and durable layout
- Story 1.7: dataVersion Workbench refresh
- Story 1.8: Edit Schema
- Story 1.9: Settings for models and embeddings

## Requirements & Constraints

- **Private by default.** Humans authenticate via Clerk; agents and the task consumer use a bearer owner/service token. Unauthenticated page requests redirect to sign-in; unauthenticated APIs and MCP/HTTP wiki reads return 401. There is no public read path.
- **Commons is retired, not refactored.** Public commons/browse/waitlist/billing/clone-to-private/talk routes must 404, and the commons sync side effect becomes a no-op. Dead module files may remain only if nothing reachable calls them.
- **Display name vs runtime name.** All user-visible copy says work-wiki; every runtime identifier (storage bindings, tenants, env vars, MCP server name, localStorage keys, deploy config, default tenant/owner constants) keeps its existing name so live data is not orphaned. This is not a rename refactor.
- **No blank Wiki.** Creating a Wiki requires choosing exactly one of Research, Reading, Personal Growth, Business, General. Each seeds a purpose file and a Schema whose contents genuinely differ per template. Applying a different template later is confirm-gated and overwrites purpose/Schema only — never Pages or Sources.
- **Durable state.** Last mode, tree selection and scroll, active Wiki/project selection, panel widths, and Settings survive reload. Settings (including provider keys and the separate Chat vs Ingest model choices) persist server-side in the kernel store, not in a browser-only or sidecar-local store. Panel widths may stay browser-local.
- **Dual models, vector off.** Chat model and Ingest model are configured independently across OpenAI, Anthropic, Google, Ollama, and Custom providers. Vector search defaults off and must not become a hard dependency. LLM timeout is configurable; optional Firecrawl key/base URL may be stored.
- **English only** for UI chrome and LLM generation. Light theme only. No locale picker, no dark tokens.
- **Device split.** Any Clerk-authenticated browser gets trees, Preview, and search. Chat, binary extract, loopback API, shell, and Skills require a sidecar on the same machine as the browser; without it those surfaces fail closed with an explicit message rather than degrading into a stub or an alternate information architecture.
- **Accessibility floor:** WCAG 2.2 AA on chrome as a target. Tab order rail → left column → canvas → Preview → Activity. Mode changes announce the surface name. Count badges carry count + noun in their accessible name. Inputs are labeled beyond placeholder. Visible focus ring. Respect reduced-motion.

## Technical Decisions

- **Brownfield only.** Build inside the existing Next.js App Router + OpenNext-on-Cloudflare app. Do not scaffold a new application, and do not inherit shadcn component names or defaults — chrome is custom Tailwind matching the reference screenshots.
- **Two runtimes, HTTP boundary.** The Workbench UI and the wiki data plane run on the Worker; the Agent, extractors, shell, Skills, and the loopback API run on a local sidecar. The Worker cannot reach localhost. Epic 1 only needs the sidecar's health/status signal for the rail status dot and Chat's fail-closed state.
- **One write path.** All Page create/update/delete — including the confirm-gated Preview edit and the Schema edit — goes through the existing lifecycle write/delete functions so index, log, backlink, and embedding side effects always fire. Do not add a second markdown writer.
- **Single system of record.** Canonical bytes live behind the storage provider abstraction (object store + KV in production, filesystem for local dev). No parallel local vault.
- **dataVersion is the refresh signal.** Every successful kernel write or delete bumps a monotonic integer in the config store. The Workbench refetches trees and Preview when it changes, without a full page reload. Later epics rely on this, so it must be correct here even though Ingest does not exist yet.
- **Schema is executable, not documentation.** The Page-conventions section is loaded into ingest/chat/lint prompts at runtime, so editing it changes behavior without a deploy. Do not fork a second copy of those conventions into code.
- **Preview stays view-first.** Markdown editing is a confirm-gated escape hatch; there is no WYSIWYG. Mermaid and KaTeX rendering are out of scope for this epic.
- **Dependency floor.** Before the next production deploy, Next, the OpenNext Cloudflare adapter, and React must be bumped together to their pinned target versions; do not move to Next 16 in v1. Production deploys are manual — the fork's GitHub deploy workflows are inert.

## UX & Interaction Patterns

- **Icon rail, 48px, always present**, switching modes rather than stacking columns. Order: Wiki · Chat · Sources · Search · Graph · Lint · Todos · Review · Deep Research · Skills. Bottom: sidecar status dot, Settings, collapse chevron. Active icon is a filled rounded square in a foreground wash — not a hue change. Count badges on Review and Todos when non-zero. Switching modes must not destroy typed Chat input.
- **Modes not yet built still render** their own one-sentence empty state; they are never dead links.
- **Left column** carries Knowledge | Files tabs. Its header is the product title, the Wiki switcher, and New Wiki. There is no "Open project folder" — import/upload replaces it. Preview docks as a third column only when a tree pick (or later, a citation) is active; before that it shows "Select a file to preview."
- **Type system:** system sans at small size for all chrome, trees, Chat, Settings, and Preview header/frontmatter; Georgia for Preview body and headings only. The serif must not leak into chrome or Chat answers.
- **Color means state**, not brand: green status dot for a live sidecar, amber warnings, red destructive labels (never a red fill), black pill badges, black primary buttons — one primary per cluster. Categorical color is reserved for the Graph.
- **Empty states** are one muted sentence plus at most one primary action. No illustrations, no emoji, no encouragement copy. Microcopy is unsentimental and instructional, always naming the next step.
- **Modals never stack.** One overlay level for confirm dialogs (Preview edit, template switch, and later delete/research). Esc closes exactly one.
- **Settings** uses a second nav list plus a sticky save bar reading "Changes apply after saving"; unsaved edits do not apply and are discarded on leave.
- **Resize limits:** Chat ≥ 320px, tree and Preview ≥ 200px, widths persisted.
- **Responsive:** full Workbench at ≥1200px; 900–1199px honors min widths with the Activity dock collapsed by default; below 900px the rail becomes a sheet and Graph is not the job surface. Layout stacking never implies Chat works without a sidecar.

## Cross-Story Dependencies

- Story 1.2 (template-seeded Wiki) must land before 1.4, 1.5, and 1.8 have real content to show; the seeded purpose and Schema files are the first things the trees and Preview render.
- Story 1.3 (rail and chrome) is the container for 1.4, 1.5, and 1.6 and gates their layout work.
- Story 1.7 (dataVersion) is consumed by 1.4, 1.5, and 1.8 for in-place refresh after a write, and is the mechanism Epic 2's Ingest and Epic 5's Graph rely on for staying current — get the bump semantics right here.
- Story 1.8 (Schema editing) writes through the same path as 1.5's confirm-gated edit; share the implementation rather than duplicating it.
- Story 1.9 stores the models and keys that Epic 2's Ingest and Epic 3's Chat consume; vector-off default here is what keeps Epic 2's embedding step optional.
- Story 1.3's Chat empty state depends on a sidecar health signal that Epic 3 implements fully; this epic needs only the up/down status.
- Deep Research provider keys, MinerU settings, and the API + MCP category may appear in the Settings nav but are implemented in Epics 6, 7, and 8 respectively.
