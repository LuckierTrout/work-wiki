# Success metrics — work-wiki

Job-critical personal tool. Qualitative gates plus a few operational counters. No vanity page-count.

## Primary

- **SM-1:** After a meeting Ingest, Christian processes Todo Candidates in the same session (approve/reject complete) before starting the next meeting. Validates CAP-9, FR-26, FR-27, UJ-1.
- **SM-2:** For a decision he remembers from a meeting in the last 30 days, Chat or Search reaches a cited Page without opening Plaud first, in the majority of tries. Validates CAP-7, CAP-10, FR-14, FR-18, FR-51–FR-55, UJ-2.
- **SM-3:** Zero silent Source loss: every queued Ingest ends in success, explicit failure after ≤3 auto-retries, or cancel — never disappeared. Validates CAP-5, FR-7–FR-9, FR-32, FR-39.

## Secondary

- **SM-4:** Weekly Lint is runnable; Graph Insights surface at least isolated Pages and sparse Communities when they exist. Validates CAP-11, CAP-12, FR-19–FR-21, FR-49, UJ-4.
- **SM-5:** ZIP export/import and deterministic `index.md` rebuild succeed on demand. Validates CAP-16, FR-37.
- **SM-6:** With vector search on vs off, Chat/Search recall on a fixed question set is higher when on. Nashsu published 58.2% → 71.4% overall recall with vector enabled — reference lift, re-measure on this Wiki. Not a contractual SLA until re-benchmarked.

## Counter-metrics (do not optimize)

- **SM-C1:** Pages created per Ingest — more Pages ≠ better; prefer merge quality (FR-3).
- **SM-C2:** Todo Candidate count — extracting everything is failure; precision of approve-worthy Candidates matters (CAP-9).
- **SM-C3:** Chat token spend per question — do not fix quality by stuffing the whole Wiki into the prompt (FR-54).
