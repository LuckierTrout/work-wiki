# Yopedia inbound email Worker

This Worker receives Cloudflare Email Routing events, checks the owner-managed
allowlist in `YOPEDIA_CONFIG`, parses the MIME body, and submits trusted text to
the main Yopedia Worker through a service binding.

Email attachment names are recorded for activity history, but attachment bytes
are intentionally not ingested in this phase.

After deploying:

1. Add a domain to Cloudflare DNS and enable Email Routing.
2. Create the address entered under Yopedia **Settings → Email ingestion**.
3. Route that address to the `yopedia-email-ingest` Worker.
4. Set `YOPEDIA_SERVICE_TOKEN` to the same secret used by the other Workers.
