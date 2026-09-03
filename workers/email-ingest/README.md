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
out of one message, each at most 10 MB decoded and 19 MB across the message, and
records the first twenty attachment names — forwarded or not — in activity
history; names past the twentieth are not recorded at all. The acknowledgement
reports the four losses separately, because each asks the sender for a different
fix: parts in an unsupported format, documents over the 10 MB per-document
ceiling, documents left behind once the 19 MB total attachment budget was spent,
and documents left behind because the message went over that ten-document
limit. The 19 MB is not a round number by accident: the Worker reserves room in
its own size derivation for a body at the full length it will accept, and pays
for that room out of the attachment budget rather than by asking the transport
for more. One consequence is worth knowing before it surprises anyone — two
attachments at the full 10 MB per-document ceiling no longer both fit in one
message, and the second is reported as left behind once the budget was spent.
A part a sending client marked `Content-Disposition: inline` — a
signature logo, an embedded preview — is treated as decoration rather than as a
file the sender attached: it is excluded from eligibility, so it is never
forwarded even when it is itself a supported format, consumes neither an
attachment slot nor budget bytes, and appears in no loss count and no recorded
name. The owner can route accepted mail to an owned vault and/or
agent in Settings. Original documents and supported embedded figures are
preserved in R2 after synthesis.

Those figures bound what the Worker will forward once a message arrives. What
arrives is bounded first by Cloudflare Email Routing, which rejects oversized
inbound mail before this Worker runs at all. **The size this repository assumes
that ceiling to be is 25 MiB (26,214,400 bytes)** — an unverified bound, not a
confirmed figure: recorded on 2026-08-31 as if checked against Cloudflare's
published limits, when it could not have been, and retained since because it is
conservative rather than because anyone confirmed it.
<https://developers.cloudflare.com/email-routing/limits/> is where an operator
confirms it, and either answer is actionable — a higher published limit means
work-wiki is narrowing itself and the constant can be raised, a lower one means
this ceiling is too generous and the refusal still over-promises. Whatever its
real value, the platform ceiling is not configurable.

Only the upstream half of that is uncertain. **This Worker refuses any message
over 26,214,400 bytes whatever Email Routing does** — that gate is enforced here
and is not in doubt; what is unconfirmed is only whether the transport would
have refused the message first. The Worker's own raw-message cap is clamped to
the recorded figure, so the over-size refusal quotes **25.0 MB** — a size this
Worker will certainly accept, and one the transport will too if the recorded
bound is right, rather than the far wider figure the derivation alone would have
named.

The consequence for the figures above, stated so the advertised limits are not
read as delivery promises. `message.rawSize` is counted on the ENCODED message,
so how much of the decoded budget fits under 25 MiB depends on the transfer
encoding the sending client picks. **Wire sizes below are MiB** (1,048,576
bytes), the same unit as the ceiling. The "10 MB" and "19 MB" above are the
figures the acknowledgement quotes, and both are binary megabytes — but only the
first is exact: the per-document ceiling is 10 MiB on the nose, while the total
budget is ~19.71 MiB rounded DOWN to 19, so a sender is never told the budget is
larger than it really is:

- One full-size (10 MB) document arrives comfortably in base64 — ~13.7 MiB on
  the wire, ~11.3 MiB clear of the ceiling.
- The 19 MB total attachment budget is **not** reachable in base64: ten
  ~1.97 MiB parts are ~27.0 MiB encoded, past the 25 MiB recorded above, so the
  Worker refuses them — and if that bound is right Email Routing refused them
  first. It is reachable only from a client that sends its parts unencoded
  (`7bit`/`8bit`).
- Under quoted-printable — what mail clients use for byte-dense `text/*`
  attachments and non-ASCII bodies, at ~3.12x — roughly 8.0 MiB of decoded
  payload fits under the recorded ceiling at all.

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

Nothing in steps 1–3 raises the inbound ceiling — 25 MiB as this repository
records it. Email Routing rejects an oversized message at SMTP time, before this
Worker runs, so the sender's own mail provider returns a delivery-failure notice
naming a size or quota — work-wiki sends nothing at all, and no Worker log
records the attempt. An operator hearing "my large attachment bounced and
work-wiki never replied" is looking at the platform limit, not at
`YOPEDIA_CONFIG` or the Worker. The figure lives in code as
`EMAIL_ROUTING_MAX_INBOUND_BYTES` in `workers/email-ingest/index.ts`, with the
same URL and the same caveat: it is an unverified conservative bound, so check
it against Cloudflare's published limit rather than assuming it was ever
confirmed.
