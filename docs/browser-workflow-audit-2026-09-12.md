# Browser workflow audit — 2026-09-12

Verified locally in the signed-in owner's browser at `http://localhost:3001`, with the app and sidecar running from the same checkout. This is local workflow evidence, not production deployment or proof that every possible path is bug-free.

Branch: `codex/browser-workflow-fixes-20260912`. The audit used a separate wiki named **Browser QA 2026-09-12 — verified** and clearly named synthetic Orion fixtures. Pages and Sources are shared across wikis; those test artifacts remain available for inspection. Existing user content was not edited or deleted.

## Fixes

- Restored the published workbench feedback fixes: truthful Sources loading/unavailable states, Preview announcements, Chat empty state, Skills refusal messages, and source retrieval presentation.
- Prevented unsaved Preview edits from disappearing when changing modes, tree tabs, active wikis, opening New Wiki, or traversing browser history to another mode. The existing discard dialog now holds that navigation until the owner chooses.
- Added pending and success feedback for Chat's Save to Wiki. Saving is disabled during generation and while a save is pending.
- Saved Chat answers now carry the authenticated owner into storage. This fixes repeat saves conflicting with a copy written to the default tenant. Existing historical duplicates are not automatically removed.
- Included `wiki/queries/` answers in the Files tree and Preview authorization/election path. Kept readable-page checks in place.
- Preserved `queries/` in supported wikilinks and included saved answers in lint's disk inventory, removing false stale-index and broken-link findings.
- Enabled the specific saved-answer backlink to reopen its Chat conversation.
- Allowed the sidecar's exact extraction polling, settings, byte-download, and job-update routes through middleware to their existing service-token checks. Requests with missing or invalid credentials remain rejected.

The local Rust extractor was also built with `cargo build --release --manifest-path sidecar/extract/Cargo.toml`. Its generated binary is a local prerequisite, not a committed artifact.

## Browser evidence

| Surface | Actions and observed outcome |
| --- | --- |
| Authentication and pairing | Owner sign-in completed. App and sidecar used the same checkout, configuration, and data directory. |
| Wiki management | Created a QA wiki from the Business template, renamed it, and observed the persisted name. Inspected delete and template-change confirmations without executing them. |
| Sources | Uploaded Markdown, PDF, a Plaud transcript, an example.com URL, and a two-file folder. Sources stored and their jobs completed. PDF bytes survived the initial extraction failure; retry after the middleware fix and extractor build produced Markdown. Marked a synthetic source as a meeting. |
| Search | Searched the unique Orion marker and opened matching source and page results in Preview. |
| Preview | Edited and saved a synthetic page. Reproduced draft loss during navigation, then verified the discard prompt, Keep editing, and a successful save after the fix. |
| Purpose and history | Opened Purpose from Settings, edited it, inspected its prior version, and restored that version. The replaced version remained available in history. |
| Chat | Created a conversation; obtained a real subscription-provider answer with the correct fictional launch date and budget and working citations; navigated away and back with the result preserved; regenerated; renamed the conversation; stopped a subsequent turn and observed the original transcript retained and draft restored. |
| Save to Wiki | Reproduced repeat-save conflict, then verified successful resave, progress/success feedback, the saved answer in Files, Preview rendering, and its return link opening the original conversation. |
| Graph | Rendered the graph and insights; exercised Type/Community grouping, Zoom In, and Fit. |
| Lint | Reproduced false findings for a saved answer. After the namespace fixes, mechanical lint reported no issues for the QA data. |
| Todos and Review | Opened Candidates, Open, Done, and Review. Empty states were usable; no candidate or review item was available to process. |
| Deep Research | Submitted a topic/query. The missing Tavily credential produced an explicit failure and retry control. Successful research was not demonstrated. |
| Skills | Scanned local packs, disabled and re-enabled a pack, and selected and cleared a pack in Chat. |
| Settings | Inspected all nine categories. Changed Keep Extracted Markdown, saved, reloaded to verify persistence, and restored its original value. Category URL persistence also worked. |

Ingest jobs completing with the configured fallback does **not** prove successful AI page synthesis or Todo extraction. Chat used its working subscription provider; the ingest provider API key and Tavily key were absent.

## Validation

- Full Vitest run: **422 files passed; 10,340 tests passed; 1 skipped**.
- Extraction middleware/auth regression run: **82 tests passed**.
- TypeScript: `pnpm exec tsc --noEmit` passed.
- Lint: `pnpm lint` passed, with existing JSX analyzer warnings.
- `git diff --check` passed.
- Real browser verification above complements the automated tests. No claim is made that the entire Playwright suite was run in this audit.

## Remaining coverage limits

- Successful AI ingest, meeting candidate extraction/approval, semantic lint, vector retrieval, and Deep Research require configuration or data that was unavailable. The missing-credential behavior was observed; successful completion was not.
- No live inbound email, official Plaud account pull, shell approval/execution, Chat web search, or full document-format matrix was exercised.
- Destructive wiki/source/conversation deletion, template overwrite, API-token rotation, and pending-review decisions were not executed.
- Graph drag/discovery behavior, full responsive coverage, browser-close draft protection, and VoiceOver/NVDA announcements were not verified.
- This branch was prepared for Git publication and a matched local restart. A Git push alone does not deploy the Cloudflare application.
