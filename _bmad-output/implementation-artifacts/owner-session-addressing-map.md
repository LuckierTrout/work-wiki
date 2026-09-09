# Canonical owner-session addressing map

Baseline: `d26dd53c502a63881145290bdd5108bd8cd4ba5d`. New ruling: all session-derived owner storage uses the configured canonical owner tenant; preserve old-handle data untouched. This is implementation investigation for the new spec, not a rewrite of the historical DW-612/613 contract or ledger status.

## Classification rule

Keep the actual authenticated `Principal` unchanged for authorization and actor attribution. Apply `ownerTenantHandle(principal)` where a session-derived value selects storage, creates a persisted record's ownership namespace, selects owned content, or compares a record owner with the caller's storage namespace. Resolve once per handler when useful. The helper is a no-op for non-owners, absent canonical configuration and existing synthesized principals whose handle already matches the configured owner. Preserve explicitly named content/URL/frontmatter targets.

This is a broad connected conversion: do not stop at the old spec's registry/artifact function list. Before finalizing, rescan every non-test `.handle` use under `src/app`, `src/lib` and `src/components`, including aliases and inline `(await getPrincipal())?.handle`. Classify the remaining uses; neither a fixed file list nor text scanning alone proves runtime behavior.

## Server conversion families

| Family | Paths and critical uses |
| --- | --- |
| Owner authority | `src/lib/owner.ts`: add helper without altering isOwnerPrincipal/getOwnerUserId semantics or import-light boundary. `src/lib/owner-route.ts`: preserve identity returned from both owner authentication functions. Do not replace principal.handle globally. |
| V1 | `src/lib/v1-route.ts`: registry and requireAccessibleWikiId; `src/app/api/v1/projects/**`: registry paths, wiki access, files, search/retrieve, reviews and source-rescan owners. Preserve original principal for read ACL and decision actors. |
| Extract | `src/lib/extract-auth.ts`: canonical session owner and requested-owner comparison. A requested old handle is not aliased to canonical; mismatches still refuse. Service explicit/all-owner branch stays unchanged. |
| Registry/first paint | `src/app/page.tsx`, `src/app/api/wikis/**`: list/create/activate/rename/delete/templates must agree. `src/app/api/workspace-profile/route.ts`; canonical readActiveWikiSchema remains unchanged. |
| Workbench | `src/app/api/workbench/{files,media,preview,artifact,source,activity,intake}/**`; artifact revisions gate shared by read/restore; source/queue/job namespace and ownership checks; `src/app/api/lint/workbench-fix/route.ts`. |
| Chat | `src/app/api/chat/conversations/**`: all conversation storage and save/retract/persist operations; `src/lib/chat.ts:generateChatAnswer`: names/terms and workspace guidance reads. |
| Todos | `src/app/api/todos/**`, `src/app/api/action-items/**`: lists, mutations, candidate retry, counts and stored owner/ACL. Decision actor stays live handle. |
| Research/review | `src/app/api/research/**`, `review-queue/**`, `review/proposals/**`, `names-terms/**`: CRUD, wiki validation, repair, runs/queues, cancellation, prefills and namespace ownership. Preserve separate actor arguments. |
| Operations | `src/app/api/system/{backups,health,evaluations}/**`, `archive/**`, `sync/status`: session-owned manifests, scheduler payloads, export/import storage. No backup restore or data migration runs. |
| Agents | `src/app/api/agents/**`, `agent-workspaces/**`, `agent-skills/**`, `agent-interactions/**`, `agent-sandbox-approvals/**`: owner filtering, new agentIdFor ownership namespace, mutation comparator, run/list/approval storage. Do not rename existing agents or tokens. |
| Ingest | `src/app/api/ingest/**`: options.owner, queued job owners, history/status/retry/cancel owner comparisons, vault ownership. author/triggeredBy and destructive-operation actor arguments remain current session identity. |
| Knowledge/sources | `src/app/api/sources/{search,meeting}`, `knowledge/**`, `graph/{workbench,insights}`; `src/lib/document-lineage.ts`, `vault-explorer.ts`, `query.ts`, `search.ts:expandMineScope`: canonical owner-store reads and owner content-selection filters. Keep explicit source/page metadata intact. |
| Integrations | `src/app/api/integrations/**`, `monitors/**`, `monitor-digests/**`, `email/settings`: owner stores and destination owner checks. `email/ingest` is service-only and unchanged. |
| Legacy routes | `src/app/api/query/history/route.ts` has three inline principal handle expressions; query/save and query/stream session-derived branches; `src/app/api/vaults/**`, `src/app/vault/**`: session storage/ACL. URL vault IDs still identify the supplied vault. |
| Evidence/self checks | `src/app/u/[handle]/[slug]/page.tsx`: canonical caller storage comparison and getPageEvidence; do not rewrite pageTenant/URL/frontmatter. `api/admin/tenant/[handle]`: canonicalize only session-derived self comparison, never the named target. |

## Mixed storage and actor values

- `api/wiki/route.ts`: authorStr currently supplies both frontmatter.owner and authors plus response.owner. Split canonical record owner from real author.
- `api/chat/conversations/[id]/save`: saveAnswerToWiki sixth argument owner versus seventh author; saved receipt/source/job/queue owners canonical, author/triggeredBy actual.
- `api/query/save`: artifact owner currently also supplies author. Separate when session-derived; the markdown branch with no session-derived owner remains its existing contract.
- `api/workbench/intake`: intakeFile/intakeUrl currently receive a single owner used downstream for both namespace and author/triggeredBy. Add an explicit actor parameter without changing external HTTP fields.
- `todos/route.ts:decideTodos(owner, ids, decision, actor)` and todo patch actor; review queue/proposal paired owner and actor arguments must remain distinct.
- `assertCanMutateAgent(id, actor)` names an actor but compares ownership: this argument must use canonical storage ownership. The same applies to vaultOwnedBy and ingest job.owner comparisons.
- When a kernel helper takes only one owner and uses it for both storage and authorship, add a backward-compatible optional actor parameter only where a real session-facing path requires the split; retain other callers' existing default.

## Client ownership and server composition

`ArticleView` already receives principal from the owner-page route: compute isOwnerPrincipal there and pass required isSiteOwner to ArticleActions/RevisionHistory. `RootLayout` renders AppProviders → SiteChrome → NavHeader: make the server layout resolve the same owner predicate, passing the required flag through synchronous providers. Preserve Next control-flow errors using existing unstable_rethrow semantics; no global auth cache or canonical principal mutation. Preserve the existing E2E identity/provider branch and document extra server auth resolution.

Keep existing loading/signed-in, read-only, realm and contributor conditions. Remove only persistent client re-derivation of site owner from the public handle. Graphify posts `/api/knowledge`, whose kernel reads the caller's own tenant and requires matching frontmatter ownership: it has no site-admin override. Use the canonical server viewer storage handle for that ownership comparison, while preserving contributor/author identity; never add a blanket site-owner Graphify grant.

Relevant tests: owner-handle, owner-gate-parity, owner-single-reader, wikis-routes, wiki-schema-edit, workbench-preview, wiki-artifact-revisions, workbench-epic2-routes; mounted article-actions-delete-gate, page-write-read-only, owner-scoped-anchors and app-shell. Existing scans deliberately pin old client imports/expressions; update the obsolete assertions to the new approved contract without weakening unrelated boundaries. Add stable-id drift/impostor/handle-fallback and server-composition cases, not merely manually supplied booleans.

## Preservation and proof

Seed canonical and old-handle synthetic stores with distinct sentinel bytes. Exercise new-owner create/list/update/read flows and show old-handle bytes remain identical. The app will use canonical data; retained old data is not automatically visible there. No discovery, copying, deletion, queue replay, migration or production-state claim belongs to this packet. Later reconciliation must inventory all affected stores, compare identity/collisions and obtain separate approval.

At least one complete route → kernel → filesystem journey must prove Wiki create/activate/artifact save/read and first-paint consistency. Cover other owner-store families through executing drifted-principal route assertions (existing tests where possible), ownership/actor boundary tests and a recorded complete call-site audit. Source scans are supplemental; use walkFiles for any census and name the wrong-tenant regression it prevents.

## Implemented addressing audit (2026-09-09)

The conversion covers all families above. `ownerTenantHandle` resolves storage only; neither `getPrincipal`, `requireOwnerPrincipal`, `requireOwnerOrServicePrincipal` nor any Principal object is rewritten. The V1 result still carries the original Principal. Extract session requests compare the literal requested owner to the canonical session owner; the explicit/all-owner service branch is unchanged. Optional-principal query paths preserve `undefined` for an absent principal and an existing empty handle for a present one.

Additional mixed values found while following calls:

- Wiki artifact edits and restores snapshot the actual actor through `writeWikiArtifact({ actor })`; retemplate passes an optional actor through `applyScenarioTemplate` to revision snapshots. Existing direct callers default to their owner, preserving their prior behavior.
- Source cascade takes optional `actor`, retaining canonical `owner` for the marker, raw bytes and Todo/Action-item updates while passing the real actor to page deletion and lifecycle edits.
- Extract-required session uploads persist optional `actor` on new extract records. Completion uses `job.actor ?? job.owner` for authorship/trigger and `job.owner` for storage. Retry preserves the record field; old records lacking it retain their original owner attribution. Workbench intake, document and PDF session doors pass the actor; service-only callers retain their defaults.
- `lint/workbench-fix` was inspected but deliberately stays on the actual handle: its final argument is `triggeredBy`, not an owner-store selector. The kernel's generated author remains `lint-fix`.
- `/agents` first paint and the Settings vector-backfill enqueue were included although not separately named in the original route table: both select the session's storage owner.

### Remaining handle-use classification

Re-scanned non-test `.handle` uses and destructuring under `src/app`, `src/lib`, and `src/components` after conversion; generated vendor Chart.js was excluded as unrelated third-party source. Remaining production handle uses fall into these inspected classes:

| Remaining uses | Why unchanged |
| --- | --- |
| `owner.ts` predicate and helper fallback | Original identity comparison and the required unchanged non-owner/no-canonical fallback. |
| `authz.ts` admin allowlist, direct page ACL and agent-human matching | Authorization identity predicates. Stable-id owners already pass the earlier admin predicate; this packet does not redefine non-owner/service authorization or explicit page targets. |
| `mcp-http.ts`; `api/mcp/route.ts` | Remote MCP resolves agent/service tokens, not a Clerk session. Existing explicit owners, token attribution, named vault targets and rate-limit identity remain intact. |
| `api/email/ingest/route.ts` | Service-only destination checks, attribution and queue contract. No session-derived namespace here. |
| `api/admin/{migrate,reset,rebuild-embeddings}`; admin tenant deletion log/actor | Actual request identity for logs and destructive-operation actors. Only the admin tenant route's session-derived `isSelf` comparison was canonicalized; the URL target stays literal. |
| `api/wiki/[slug]`, its revisions route, `api/ingest/reingest`, `api/lint/fix` | Explicit page targets and actual author/trigger actors; no session-owned store is selected by the remaining handles. |
| `api/wiki`, query artifact save, Chat save, ingest/image/PDF/document/batch/x-mention, Workbench activity/intake/source | Deliberately separated real author/trigger/actor values; their sibling owner fields use the canonical helper. |
| Todos and review/proposal decision arguments; V1 create-page-from-review | Actual decision or page author arguments. The corresponding first owner argument is canonical. |
| Artifact edit/retemplate/revert session handles | Actual revision actor, now explicit and separate from canonical storage. |
| `E2eViewerIdentity`, `viewer-handle`, NavHeader display username and ArticleActions contributor matching | Live viewer identity, loading and display; server-computed `isSiteOwner` controls site authority. Graphify compares server-provided canonical viewer storage ownership, without a site-owner override. |
| `contributor-index.ts`; URL-param destructuring | Stored author sorting and explicit content addressing, not session storage selection. |
| `write-denial.ts` remaining handle text | Explanatory comment only, no runtime storage read. |

No old-handle fallback reader, overlay, migration, copy, delete, replay, identifier rename, global request storage state or new old-data visibility filter was added. Existing global page visibility and explicit content-derived reads retain their prior behavior; preservation means no new merge/import of old tenant stores into canonical session state.

### Executed proof

`owner-session-composition.test.ts` runs Wiki create/list/activate, artifact save/preview/history and Home first paint through real local storage, with distinct canonical and old tenant data. It also executes V1 resolution, the helper fallback matrix, impostor/anonymous refusals and requested extract owner/service behavior. Its family table executes real local readers for Chat, Todos, Action items, Names & Terms, Review, Research, Backups, Evaluations, Agents, agent workspaces/skills/approvals, structured knowledge, integrations, monitors, graph insights, sync and vaults; call observers verify the canonical namespace without replacing those store reads.

`owner-session-actors.test.ts` executes intake/raw storage/queue ownership and actor separation, ingest job list/status ownership, real Todo approval and preserved old Todo records, plus extract actor persistence/retry/completion and old-record fallback. `workbench-epic2-routes.test.ts` additionally executes the Source-delete route owner/actor seam. Existing artifact and lifecycle suites continue exercising kernel writes, restores, error/read-only contracts and source cascade operations.

Mounted `ArticleView` and `RootLayout` tests compute owner flags from actual server Principal fixtures, covering changed handle, raw-id fallback, stale-handle impostor, loading, framework rethrow and ordinary-auth failure. Existing mounted suites retain contributor, realm, read-only and signed-out coverage. Graphify has an explicit case that hides Graphify on another owner's page, so site ownership alone cannot grant it.

### Reconciliation and release limit

All execution uses isolated synthetic local storage. Existing old-handle bytes are preserved, including distinct registry/artifact and source/Todo sentinels. Production old-handle inventory, collision analysis and any data reconciliation remain separate work requiring explicit authorization. Nothing was merged, deployed, or accepted as production proof. This packet does not claim live Clerk session/browser, Cloudflare/R2, provider or assistive-technology execution.


Initial implementation gates: focused **16 files / 610 passed**; full **403 files / 10,050 passed / 1 existing live-provider skip**; standalone post-build typecheck, lint, production build and whitespace check all exit 0. Exact logs and build environment are recorded in `spec-dw-612-613-canonical-owner-session.md`. Current review/remediation status is below; no production acceptance is inferred.

### Review preservation and recovery audit — 2026-09-09

The source path/raw-id summary lookup and fixed global overview writer were concrete cross-owner takeover paths exposed by canonical intake. Both now require a matching storage owner before reuse; collisions allocate distinct slugs without touching the old page's identity, indexed owner or flat/tenant bytes. Generated numbered overviews carry `type: overview` (the existing type field is an open string), remain reusable, and retain the existing bookkeeping exclusions in overview counts, source indexing/cascade and Workbench orphan lint. Explicit global overview reads such as Research prefill stay content-addressed; no old-page visibility revocation was added.

Review Page creation now persists `claimActor` with the operation claim and uses it for crash recovery and synchronous repair. Missing legacy actor defaults to owner; clearing/restoring an operation also clears/restores its actor. The owner-session actor suite executes actual route claim persistence, simulated primary-write/process-loss failure, expired-claim recovery and real revision metadata for the changed actor and old-claim fallback. It also exercises two canonical bookkeeping passes with old summary/overview byte and identity preservation. Post-remediation gate evidence is recorded in the spec; the subsequently approved final verification-review pass is recorded below.

Post-remediation local gates: focused **19 files / 760 passed**; full **403 files / 10,053 passed / 1 existing live-provider skip (10,054 total)**, 119.52s; production build, sequential post-build typecheck, lint and whitespace check all exit 0. Exact `/private/tmp/owner-review-*.log` evidence and the synthetic build environment are recorded in the spec. Both confirmed medium findings are addressed; the final verification-review pass and its finding are recorded below. These are local verification results; no remote action was performed.

### Final verification-review coverage

With explicit user approval to waive fresh context and reuse the edge-case reviewer, the final verification-gap pass identified one medium missing composition proof for Chat POST writers. Added real route → store coverage for drifted-owner conversation creation, supplied-turn persistence and collection/detail reload. Both canonical stored messages and a distinct old conversation's unchanged bytes are asserted. Individually reverting either POST writer to the live handle makes the new case fail (expected 404), and the original production files were restored. This is a test-only finding fix, with no provider calls or additional production behavior. Final gate results and the completed local review disposition are recorded in the spec.

Final post-verification-review gates: focused **4 files / 49 passed** plus the standalone **23/23** composition suite; full **403 files / 10,054 passed / 1 existing Tavily skip (10,055 total)**, 119.53s. Build (13.7s compilation), sequential post-build typecheck, lint and whitespace checks all exit 0. Exact evidence is in `/private/tmp/owner-chat-*.log` and the spec. The Chat coverage finding is addressed. All three review passes are complete under the user-approved reviewer-reuse waiver; no unresolved finding remains. The spec records completed local workflow acceptance, with publishing and real-data reconciliation still separate.
