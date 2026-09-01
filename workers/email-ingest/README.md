# work-wiki inbound email Worker

This Worker receives Cloudflare Email Routing events, checks the owner-managed
allowlist in `YOPEDIA_CONFIG`, parses the MIME body, and submits trusted text and
supported document attachments to the main work-wiki Worker through a service binding.

Markdown, TXT, HTML, PDF, DOCX, PPTX, XLSX/XLS, CSV, ZIP, ODT/ODS/ODP, EPUB, MOBI,
Org, and RTF attachments are forwarded to the main Worker, where they split by
format:

- **PDF, DOCX, PPTX, XLSX/XLS, ODS, EPUB and MOBI** become **Sources of their
  own** under `raw/sources/`, each parked behind a sidecar extract job (Epic 7).
  They are no longer parsed on the Worker and no longer glued onto the message
  body, so one corrupt attachment fails on its own Activity row while the note
  still compiles. Their stored bytes survive a failed extract.
- **Everything else** (Markdown, TXT, HTML, CSV, ZIP, ODT, ODP, Org, RTF) is
  staged in R2 and extracted by the task queue as before, because no extract
  crate reads those formats.

The Worker carries at most ten supported documents
out of one message, each at most 10 MB decoded and 20 MB across the message, and
records the first twenty attachment names — forwarded or not — in activity
history; names past the twentieth are not recorded at all. The acknowledgement
reports the four losses separately, because each asks the sender for a different
fix: parts in an unsupported format, documents over the 10 MB per-document
ceiling, documents left behind once the 20 MB total attachment budget was spent,
and documents left behind because the message went over that ten-document
limit. A part a sending client marked `Content-Disposition: inline` — a
signature logo, an embedded preview — is treated as decoration rather than as a
file the sender attached: it is excluded from eligibility, so it is never
forwarded even when it is itself a supported format, consumes neither an
attachment slot nor budget bytes, and appears in no loss count and no recorded
name. The owner can route accepted mail to an owned vault and/or
agent in Settings. Original documents and supported embedded figures are
preserved in R2 after synthesis.

Those figures bound what the Worker will forward once a message arrives. What
arrives is bounded first by Cloudflare Email Routing, which **rejects any inbound
message larger than 25 MiB (26,214,400 bytes) before this Worker runs** —
"Inbound message size: 25 MiB. Messages larger than this are rejected."
(<https://developers.cloudflare.com/email-routing/limits/>, verified 2026-08-31).
That ceiling is a platform limit and is not configurable. The Worker's own
raw-message cap is clamped to it, so the over-size refusal quotes **25.0 MB** —
a size a sender can actually resend under, rather than a wider figure the
transport would refuse again on its own.

The consequence for the figures above, stated so the advertised limits are not
read as delivery promises. `message.rawSize` is counted on the ENCODED message,
so how much of the decoded budget fits under 25 MiB depends on the transfer
encoding the sending client picks:

- One 10 MB document arrives comfortably in base64 (~13.7 MB on the wire).
- The 20 MB total attachment budget is **not** reachable in base64: ten 2 MiB
  parts are ~28.7 MB encoded and are rejected by Email Routing. It is reachable
  only from a client that sends its parts unencoded (`7bit`/`8bit`).
- Under quoted-printable — what mail clients use for byte-dense `text/*`
  attachments and non-ASCII bodies, at ~3.12x — roughly 8 MB of decoded payload
  fits at all.

The inbound Worker sends an immediate accepted/rejected reply. The task-consumer
Worker sends the final success/failure receipt after conversion settles.

After deploying:

1. Add a domain to Cloudflare DNS and enable Email Routing.
2. Create the address entered under work-wiki **Settings → Email ingestion**.
3. Route that address to the `yopedia-email-ingest` Worker.
4. Set `YOPEDIA_SERVICE_TOKEN` to the same secret used by the other Workers.
5. Enable `workwiki.app` for Cloudflare Email Service sending so the
   task-consumer's `EMAIL` binding can deliver final receipts from
   `ingest@workwiki.app`.

Nothing in step 1-3 raises the 25 MiB inbound ceiling: Email Routing rejects an
oversized message upstream, so a sender reporting a silent bounce for a large
attachment is hitting the platform, not `YOPEDIA_CONFIG` or the Worker. The
figure lives in code as `EMAIL_ROUTING_MAX_INBOUND_BYTES` in
`workers/email-ingest/index.ts`, with the same source URL; re-verify it there if
Cloudflare changes the published limit.
