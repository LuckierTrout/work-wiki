# Epic 4 Context: Meeting Todos

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

After a Plaud-origin or operator-marked meeting compiles, the wiki proposes Todo Candidates so Christian can leave with actions he chose — not Plaud’s list and not a fading memory. He approves or rejects each Candidate, then works Open and Done with optional due dates and links back to the meeting Source or Page. This is the P0 job-aftermath list. It does not require Chat.

## Stories

- Story 4.1: Extract Todo Candidates from meeting Ingest
- Story 4.2: Approve or reject Candidates
- Story 4.3: Due dates, Open/Done, and owner delete
- Story 4.4: Links back to the meeting

## Requirements & Constraints

**Meeting-only extraction.** Candidates are created only when two-step Ingest succeeds and the Source is Plaud-origin or explicitly marked meeting. PPT, PDF, URL, and office default off — no classifier. Failed or skipped compiles produce no Candidates. Non-meeting Ingest must not spam the list.

**Propose, never promote.** A Candidate has a title, rationale, optional due date, and speaker/context if present. It is not a Todo until approve. Nothing auto-promotes. Bulk approve/reject is allowed. Store the decision, timestamp, and actor. Rejected Candidates never appear in Open.

**Always update the list.** A completed meeting Ingest always refreshes Candidates, including “none found.” Process Candidates in the same session before the next meeting. Precision of approve-worthy Candidates matters more than extracting everything.

**Working list.** Approved Todos have an optional due date, open/done status, and editable title/due without breaking Source or Page links. Sort and filter by due date and status. Completing keeps links. Rejected Candidates and completed Todos persist until the owner deletes them — no TTL.

**Links and cascade.** Every Candidate and Todo links to the originating Source and to the meeting Page when one exists. Following the link docks Preview on the Page if present, otherwise the Source transcript. Deleting a Source marks linked Todos source-missing; it does not silently delete them.

**Plaud notes are Sources, not the Todo list.** Prefer transcript and summary together. Extraction may read both and collapse duplicates into one Candidate. Do not copy Plaud action-item lists into Todos.

**Mark as meeting.** On a non-Plaud Source, Mark as meeting (Sources or Preview) puts the next or queued Ingest on the meeting path.

**Job-critical, private, inspectable.** Extraction failures are visible and retryable; Sources persist even when compile fails. Unauthenticated Todo APIs return 401. Meeting transcripts stay private; export is owner-initiated. Todo decisions are inspectable. English-only UI and generation. Keyboard can reach Approve and Reject. Does not require Chat or the sidecar Agent.

## Technical Decisions

**Kernel owns Todos.** Candidates and Todos persist in the kernel store, not sidecar disk or browser-only state. A Source may have many meeting-only Candidates. Review and Todos share kernel persist plus Workbench.

**Ingest still compiles in the kernel.** Two-step Analysis then Generation stays in the TypeScript kernel. Schema page conventions load into Ingest prompts and steer extraction. Candidates persist only after a successful meeting compile.

**Auth and identifiers.** Clerk for the Workbench. Display copy is work-wiki; runtime identifiers stay `yopedia`. ZIP export includes Todos with Pages, Sources, and chats.

**Out of this epic.** Plaud OAuth, office or email extract, Chat, Graph, Review, Deep Research, MCP, skill, and shell. Upload, Intake, and cascade delete are prior work.

## UX & Interaction Patterns

Todos is a rail icon (checklist) after Lint — extra versus nashsu. The badge shows pending Candidate count when non-zero (“N todo candidates”) and hides at zero. Mode change announces “Todos.”

Surface: Candidates | Open | Done. Cards match Review density. Candidate card: title, one-line rationale, optional due, speaker/context, links to Source and Page. Approve is the one primary; Reject is a destructive ghost (red label, no filled red bar). Both are in the tab order — not hover-only. Bulk actions live in the toolbar.

Empty Candidates: “No candidates. Meeting ingest will propose them.” Open may be empty while Candidates or Done still have items. Non-meeting Source: “This Source is not a meeting. Mark as meeting to extract Todos.”

Meeting link docks view-first Preview (Georgia body). Source-missing stays inspectable. Light theme, system sans chrome, one muted empty sentence — no illustration, emoji, or “you’re all caught up.”

Desktop-primary. Below ~900px the rail may become a sheet and Todos stay usable; Graph is not the job surface. Without the sidecar, Chat is unavailable — Todos do not need it.

## Cross-Story Dependencies

Extraction (4.1) runs on Epic 2’s successful two-step Ingest, Plaud-origin provenance, SHA256 skip (no Candidates on skip), and Mark as meeting. Approve/reject (4.2) consumes those Candidates. Open/Done and owner delete (4.3) apply only after approve. Links (4.4) need Epic 2 Source/Page writes and confirm-gated cascade delete.

Depends on Epic 1 rail, Schema, and owner-only Workbench. Does not wait on Epic 3 Chat. Do not implement Plaud OAuth or office extract here.
