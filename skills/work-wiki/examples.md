# Worked examples

Every example assumes `TOKEN` holds the token from Settings → API + MCP and that
`/health` has already been checked.

```bash
BASE=http://127.0.0.1:19828
AUTH="Authorization: Bearer $TOKEN"
```

---

## 1. Is the wiki ready?

```bash
curl -s "$BASE/api/v1/health"
```

```json
{ "ok": true, "status": "running", "enabled": false, "authRequired": false,
  "authConfigured": false, "allowUnauthenticated": false, "tokenSource": "none",
  "version": "0.1.0" }
```

`enabled: false` — the API is off. The correct response is to tell the user:

> Your work-wiki API is switched off. Open Settings → API + MCP and turn on
> "Enable local API", then press Save.

Not to retry, and not to describe the wiki from memory.

---

## 2. "What does my wiki say about pricing?"

```bash
curl -s -X POST "$BASE/api/v1/projects/current/search" \
  -H "$AUTH" -H 'content-type: application/json' \
  -d '{"query":"pricing","topK":5}'
```

```json
{ "results": [
    { "path": "wiki/pricing.md", "title": "Pricing", "snippet": "Tiered per seat…",
      "score": 9.1, "titleMatch": true },
    { "path": "wiki/acme-negotiation.md", "title": "Acme negotiation",
      "snippet": "…agreed to hold pricing…", "score": 4.2, "titleMatch": false }
  ], "tokenHits": 2, "vectorHits": 0, "mode": "wiki" }
```

Then read the page you intend to quote:

```bash
curl -s -H "$AUTH" \
  "$BASE/api/v1/projects/current/files/content?path=wiki/pricing.md"
```

Answer from that text, citing `wiki/pricing.md`. Two hits is not "the wiki has
little on pricing" — read them before characterising the coverage.

---

## 3. An empty search

```json
{ "results": [], "tokenHits": 0, "vectorHits": 0, "mode": "wiki" }
```

> Your wiki has no coverage for "SOC 2". If you have sources about it, they may
> not be compiled yet — I can queue a rescan.

Do not answer the SOC 2 question from general knowledge and present it as what
the wiki says.

---

## 4. Reading a specific meeting

Sources live under `raw/`. Find them by listing rather than guessing:

```bash
curl -s -H "$AUTH" "$BASE/api/v1/projects/current/files?root=sources"
```

```json
{ "files": ["raw/sources/kickoff-2026-08-01/9ab3.md",
            "raw/sources/weekly-sync/c41d.md"], "truncated": false }
```

The hashed filename is a content snapshot id — source bytes are immutable, so a
changed source becomes a new file and the old one stays. Read the one you want:

```bash
curl -s -H "$AUTH" \
  "$BASE/api/v1/projects/current/files/content?path=raw/sources/weekly-sync/c41d.md"
```

---

## 5. A PDF

```bash
curl -s -H "$AUTH" \
  "$BASE/api/v1/projects/current/files/content?path=raw/sources/contract/aa01.pdf"
```

```json
{ "error": "unsupported_media_type" }
```

Expected. The API serves text. A PDF's extracted text is a separate file that
the extract step wrote — look for it in the `files` listing, or search for its
content:

```bash
curl -s -X POST "$BASE/api/v1/projects/current/search" \
  -H "$AUTH" -H 'content-type: application/json' -d '{"query":"contract term"}'
```

---

## 6. Working the Review queue

```bash
curl -s -H "$AUTH" "$BASE/api/v1/projects/current/reviews"
```

```json
{ "pendingCount": 2, "reviews": [
  { "id": "rv_7", "kind": "lightbulb", "title": "No page covers onboarding",
    "summary": "Three sources mention onboarding; no page compiles them.",
    "queries": ["onboarding checklist"], "resolved": false }
]}
```

Create the page it suggests:

```bash
curl -s -X PATCH "$BASE/api/v1/projects/current/reviews/rv_7" \
  -H "$AUTH" -H 'content-type: application/json' -d '{"action":"create_page"}'
```

```json
{ "review": { "id": "rv_7", "status": "created", "resolved": true },
  "slug": "onboarding", "pendingCount": 1 }
```

Or open research instead — note what comes back:

```bash
curl -s -X PATCH "$BASE/api/v1/projects/current/reviews/rv_7" \
  -H "$AUTH" -H 'content-type: application/json' -d '{"action":"deep_research"}'
```

```json
{ "review": { "id": "rv_7", "resolved": false },
  "research": { "id": "…", "status": "draft", "title": "No page covers onboarding" },
  "confirmRequired": true }
```

The project is a **draft** and the review is still open. Tell the user it is
waiting for them to confirm in the Deep Research panel — do not report that
research is running.

---

## 7. Re-compiling a source

```bash
curl -s -X POST "$BASE/api/v1/projects/current/sources/rescan" \
  -H "$AUTH" -H 'content-type: application/json' \
  -d '{"paths":["raw/sources/weekly-sync/c41d.md"]}'
```

```json
{ "requested": 1, "queued": 1, "remaining": 0,
  "results": [{ "path": "raw/sources/weekly-sync/c41d.md", "queued": true, "jobId": "…" }] }
```

Whole-tree rescan, one page at a time:

```bash
curl -s -X POST "$BASE/api/v1/projects/current/sources/rescan" \
  -H "$AUTH" -H 'content-type: application/json' -d '{}'
```

```json
{ "requested": 25, "queued": 25, "remaining": 12, "results": [ … ] }
```

`remaining: 12` — call again for the rest. Reporting "all sources rescanned"
after one call would be wrong.

---

## 8. Asking the Agent instead

```bash
curl -s -X POST "$BASE/api/v1/projects/current/chat" \
  -H "$AUTH" -H 'content-type: application/json' \
  -d '{"query":"What did we decide about pricing, and what is still open?","tools":true}'
```

```json
{ "content": "You settled on per-seat tiers [1]…",
  "citations": [{ "n": 1, "path": "wiki/pricing.md", "title": "Pricing", "type": "page" }],
  "coverage": true,
  "toolCalls": [{ "id": "t1", "tool": "wiki_search", "detail": "4 hits" },
                { "id": "t2", "tool": "wiki_read", "detail": "wiki/pricing.md" }] }
```

Use this when the question needs synthesis across pages. Use `search` +
`files/content` when you want the raw material to reason over yourself.

A `pending` field on the answer means the Agent stopped to ask its owner
something — a shell command to approve, or a form to fill. That question is for
the person at the keyboard in the app, not for you to answer.
