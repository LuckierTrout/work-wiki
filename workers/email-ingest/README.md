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
limit. The owner can route accepted mail to an owned vault and/or
agent in Settings. Original documents and supported embedded figures are
preserved in R2 after synthesis.

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
