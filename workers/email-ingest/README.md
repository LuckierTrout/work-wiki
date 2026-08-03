# Yopedia inbound email Worker

This Worker receives Cloudflare Email Routing events, checks the owner-managed
allowlist in `YOPEDIA_CONFIG`, parses the MIME body, and submits trusted text and
supported document attachments to the main Yopedia Worker through a service binding.

DOCX, PPTX, XLSX, and CSV attachments are forwarded to the main Worker, staged
in R2, and extracted by the task queue. Unsupported attachment names remain in
activity history and are reported as skipped. The owner can route accepted mail
to an owned vault and/or agent in Settings. Original documents and supported
embedded figures are preserved in R2 after synthesis.

The inbound Worker sends an immediate accepted/rejected reply. The task-consumer
Worker sends the final success/failure receipt after conversion settles.

After deploying:

1. Add a domain to Cloudflare DNS and enable Email Routing.
2. Create the address entered under Yopedia **Settings → Email ingestion**.
3. Route that address to the `yopedia-email-ingest` Worker.
4. Set `YOPEDIA_SERVICE_TOKEN` to the same secret used by the other Workers.
5. Enable `workwiki.app` for Cloudflare Email Service sending so the
   task-consumer's `EMAIL` binding can deliver final receipts from
   `ingest@workwiki.app`.
