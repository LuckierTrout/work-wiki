# task-consumer Worker

The consumer for the **yopedia agent task queue** (Cloudflare Queues), as a
**standalone Worker** (so it gets a first-class Queues consumer without wrapping
the OpenNext entry).

It drains the **`yopedia-tasks`** queue and, for each message, POSTs the task to
the deployed main app's **`POST /api/tasks/run`** with the system token. It is a
**thin dispatcher** — the actual work runs in the main app, which has the full
`src/lib` and the OpenNext request context. The task kinds it carries are the
`Task` union in `src/lib/tasks.ts`: async `ingest`, `extract-actions`,
`extract-knowledge`, `compile-knowledge`, `run-agent`, `run-research`,
`monitor-source`, `deliver-monitor-digest`, `deliver-integration`,
`create-backup`, and `maintain` (with `op: "staleness"` or `op: "fix"`). This
worker imports **no `src/lib` code** (that would transitively pull Clerk/Next +
require the OpenNext context it can't provide).

**Producers** (who enqueues) live in the main app. The main entry points are the
ingest routes (`/api/ingest`, `/api/ingest/batch`,
`/api/ingest/document|image|pdf`, `/api/email/ingest`, `/api/agents/<id>/ingest`),
the Graphify job (`/api/knowledge/graphify`), research runs
(`/api/research/<id>/run`), backups (`/api/system/backups`), monitor digests
(`/api/monitor-digests`), the integration outbox and memory proposals
(`src/lib/integration-outbox.ts`, `src/lib/memory-proposals.ts`), the executor
itself (`/api/tasks/run` chains `extract-actions`, `extract-knowledge`,
`compile-knowledge`, and `after-ingest` agent runs), and this worker's **daily
cron** → `POST /api/tasks/scan` (autonomous maintenance, Q2). That list is the
main entry points, not a closed set — for the authoritative one, grep the callers
of both `enqueueTask()` and `enqueueTasks()` (`src/lib/tasks.ts`; Graphify uses
the batch form), which send to the `TASK_QUEUE` producer binding and no-op
gracefully off the Workers runtime.

This worker has two triggers: the **queue consumer** (drains `yopedia-tasks`) and
a **cron** (`scheduled()`, daily) that POSTs `/api/tasks/scan`.

For inbound-email jobs, the consumer also sends a final **Ready** or **Could not
import** receipt after the main app settles the job. The `EMAIL` binding is
restricted to `ingest@workwiki.app`; Cloudflare Email Service must have that
domain enabled for sending.

### Autonomous maintenance (Q2)

The daily cron scans the **commons** (public pages only) for upkeep no human
reports and enqueues `maintain` tasks in two ops (`src/lib/maintenance.ts`):

- **`staleness`** — a page past its **`expiry`** with a `source_url`, or a
  **low-confidence** page with a `source_url` → **re-ingest** from source;
- **`fix`** — a deterministic, no-LLM lint fix (`lintType`): `orphan-page`,
  `stale-index`, `unmigrated-page`, `supersedes-dangling`, `broken-link`,
  `empty-page`, `stale-page`, `missing-crossref`.

Guardrails **on that maintain scan**: commons-only (never a private vault page),
skip pages edited today, and a per-scan cap.

The same cron request also enqueues due `run-agent` (scheduled agents),
`monitor-source`, `deliver-monitor-digest`, `deliver-integration`, and
`create-backup` work. **These are not gated by `AUTONOMOUS_MAINTENANCE`** — in
`src/app/api/tasks/scan/route.ts` the `maintain` loop is gated on `dry`
(`?dry=1` **or** the flag being off), while these are gated on `?dry=1` alone. So
they run on every cron tick regardless of the flag, and the guardrails above
don't apply to them — each has its own due/schedule check.

#### It is OFF by default (the `maintain` tasks)

The cron runs daily regardless, but the **maintenance scan** portion **dry-runs**
— it logs/returns the `maintain` tasks it *would* enqueue and enqueues **nothing**
of that kind — until the flag is on. So shipping the cron is safe as far as
autonomous page edits go; you enable it deliberately, after inspecting a few
dry-runs. (The other task kinds listed above are unaffected by this switch —
suppress them with `?dry=1`.)

The switch is the **`AUTONOMOUS_MAINTENANCE`** env var on the **main** worker
(that's where the scan route runs — *not* this consumer). Any value other than
exactly `"on"` (including unset) = dry-run.

#### How to enable it

**1. Inspect what it would do** (dry-run, works regardless of the flag). Replace
the token with the same `YOPEDIA_SERVICE_TOKEN` the workers use:

```sh
curl -s -X POST "https://yopedia.yuanhao-li.workers.dev/api/tasks/scan?dry=1" \
  -H "Authorization: Bearer <YOPEDIA_SERVICE_TOKEN>" | jq
# → { enabled, dry: true, found, enqueued: 0, tasks: [ { op, slug, lintType?, targetSlug? } … ] }
```

Or watch the daily cron's own dry-runs in the logs:

```sh
pnpm exec wrangler tail --config workers/task-consumer/wrangler.jsonc
# look for:  task-consumer cron: scan → 200 { … dry:true found:N enqueued:0 … }
```

**2. Turn it on.** It's a non-sensitive flag, so the version-controlled way is
preferred — add it to the **main** `wrangler.jsonc` `vars` block and deploy:

```jsonc
// wrangler.jsonc  (repo root — the MAIN worker)
"vars": {
  "NEXT_PUBLIC_OWNER_HANDLE": "yuanhao",
  "AUTONOMOUS_MAINTENANCE": "on"
}
```

```sh
git add wrangler.jsonc && git commit -m "ops: enable autonomous maintenance" && git push
# (push to main auto-deploys via deploy-cloudflare.yml)
```

Quick toggle without a code change (not version-controlled — prefer the var):

```sh
pnpm exec wrangler secret put AUTONOMOUS_MAINTENANCE   # enter:  on
```

**3. Verify it's live:** re-run the scan without `?dry=1` (or wait for the cron)
and confirm `enabled: true`, `dry: false`, and `enqueued > 0` when there's work:

```sh
curl -s -X POST "https://yopedia.yuanhao-li.workers.dev/api/tasks/scan" \
  -H "Authorization: Bearer <YOPEDIA_SERVICE_TOKEN>" | jq
```

#### Tuning

- **Per-scan cap** (default 10) — pass `?cap=N` when invoking the scan, or change
  `DEFAULT_MAINTENANCE_CAP` in `src/lib/maintenance.ts`.
- **Cadence** — the cron schedule is `triggers.crons` in **this** worker's
  `wrangler.jsonc` (default `0 6 * * *`, daily 06:00 UTC).

#### How to disable

Remove `"AUTONOMOUS_MAINTENANCE"` from the main `wrangler.jsonc` `vars` (and
deploy), or `pnpm exec wrangler secret delete AUTONOMOUS_MAINTENANCE` if you set
it as a secret. The cron keeps running and its **`maintain`** enqueues revert to
dry-runs — but, as above, the scan's other kinds (`run-agent`, `monitor-source`,
digest/outbox delivery, backups) are not on this switch and keep firing. To
suppress everything, stop the cron (`triggers.crons` in this worker's
`wrangler.jsonc`) or invoke the scan with `?dry=1`.

**Ack/retry** maps onto Cloudflare Queues:
- `2xx` → ack (done).
- `400`, `404`, or `422` → poison (malformed / not-found) → ack + drop.
- Other `4xx`, `5xx`, or network failures → retry (then DLQ after max retries).

> **Same-zone fetch note:** the `/api/tasks/run` call targets the main yopedia
> Worker through the `YOPEDIA` service binding. The forwarded Request keeps the
> configured public origin because the app's middleware is host-aware. The
> **`global_fetch_strictly_public`** compatibility flag supports the public-URL
> fallback when the service binding is unavailable.

## One-time setup (operator)

```sh
# Create the queue + dead-letter queue:
pnpm exec wrangler queues create yopedia-tasks
pnpm exec wrangler queues create yopedia-tasks-dlq

# Secret (same value as the main Worker's):
pnpm exec wrangler secret put YOPEDIA_SERVICE_TOKEN --config workers/task-consumer/wrangler.jsonc

# The versioned config already includes the EMAIL send binding and sender.
# Confirm workwiki.app is enabled under Cloudflare Email Service before deploy.

# First deploy (afterwards it auto-deploys via deploy-cloudflare.yml on push to main):
pnpm exec wrangler deploy --config workers/task-consumer/wrangler.jsonc
```

The main app's `wrangler.jsonc` already declares the `TASK_QUEUE` producer
binding for the same `yopedia-tasks` queue.

## Test it

Ingest something on the deployed instance — on Workers that dispatches an
`ingest` task through the queue, so within a queue cycle the new page appears and
the ingest job's status flips to `done`. Easiest signed-in path: paste a URL or
text into the ingest box in the app. From the command line, `POST /api/ingest`
needs a principal — either a signed-in session cookie or the same
`Authorization: Bearer <YOPEDIA_SERVICE_TOKEN>` the workers use; without one it
returns `401 Sign in required.`

To exercise the cron path instead, POST `/api/tasks/scan?dry=1` and confirm the
`tasks` array. That route is **service-token only** (`401` without it):

```sh
curl -s -X POST "https://yopedia.yuanhao-li.workers.dev/api/tasks/scan?dry=1" \
  -H "Authorization: Bearer <YOPEDIA_SERVICE_TOKEN>" | jq '.tasks'
```

Logs:

```sh
pnpm exec wrangler tail --config workers/task-consumer/wrangler.jsonc
```

Health check: `GET https://yopedia-task-consumer.<subdomain>.workers.dev` → `ok`.
