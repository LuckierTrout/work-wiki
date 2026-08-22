# work-wiki inbound email Worker

This Worker receives Cloudflare Email Routing events, checks the owner-managed
allowlist in `YOPEDIA_CONFIG`, parses the MIME body, and submits trusted text and
supported document attachments to the main work-wiki Worker through a service binding.

Markdown, TXT, HTML, PDF, DOCX, PPTX, XLSX, CSV, ZIP, ODT/ODS/ODP, EPUB, MOBI,
Org, and RTF attachments are forwarded to the main Worker, staged in R2, and
extracted by the task queue. The Worker carries at most ten supported documents
out of one message, and records the first twenty attachment names — forwarded or
not — in activity history; names past the twentieth are not recorded at all. The
acknowledgement reports the two losses separately: parts in an unsupported
format, and supported documents left behind because the message went over that
ten-document limit. The owner can route accepted mail to an owned vault and/or
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
