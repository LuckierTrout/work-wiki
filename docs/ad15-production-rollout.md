# AD-15 production rollout

Status: local implementation, automated gates and three independent reviews passed;
publication, exact-head CI, merge, production deployment and owner acceptance
are pending. No production mutation
has been performed by this implementation. This record accompanies
`_bmad-output/implementation-artifacts/spec-ad-15-production-compatibility.md`.

## Artifact and compatibility

The root application pins Next.js and eslint-config-next to 15.5.23,
React and React DOM to 19.1.4, and `@opennextjs/cloudflare` to 1.20.2. The
root lockfile is regenerated with pnpm 9.15.9. The sandbox package and lockfile
are independent and unchanged. Local verification evidence is recorded in the
spec; it is not proof of CI or acceptance in Cloudflare's runtime.

OpenNext's documented build produces `.open-next`; its deploy command publishes
immediately. Local checks use the build and Wrangler `--dry-run` only. See
[OpenNext build/deploy documentation](https://opennext.js.org/cloudflare/howtos/dev-deploy)
and [CLI documentation](https://opennext.js.org/cloudflare/cli).

## Preconditions before any production change

1. Publish the reviewed change as a PR. Require terminal passing application
   and sandbox CI on the exact PR head, then merge under the existing release
   authorization. Record the PR, CI run, head and merged SHA separately.
2. Rebuild the merged artifact with verified production public settings,
   including Clerk's production publishable key, owner handle and sign-in
   redirects. Confirm `YOPEDIA_E2E` and `YOPEDIA_E2E_SECRET` are absent from the
   build environment and generated deployment configuration. Never deploy a
   Playwright dev-server artifact or assume local `.env.local` is production
   configuration. Hash and retain the built artifact for both stages.
3. Capture the currently deployed Worker version/deployment IDs, routes,
   bindings, non-secret vars, compatibility settings, cron triggers, queue
   consumer configuration, retry/DLQ state and rollback identity. Preserve
   runtime settings when publishing; capture secret names only, never values.
   Confirm the active domains are `workwiki.app` and `www.workwiki.app`.
4. Establish an available, reversible queue-delivery pause and its restore
   procedure using the live provider's supported controls. Record its actual
   state, pending/retrying message accounting and DLQ baseline. Do not delete
   or purge a queue, remove queued work, or allow retries to burn during the
   migration. Queue pause does not cancel already running deliveries.
5. Quiesce all other mutation producers and entry points, including the task
   consumer cron, email/intake integrations, owner browser writes, API/MCP,
   agents, scripts and administrative/restore doors. Record each pause and its
   restore procedure. `YOPEDIA_READONLY=1` is not a deployment-wide write lock:
   `DEPLOY.md`'s read-only section lists stores and admin doors still writable.
   `AUTONOMOUS_MAINTENANCE` off is also insufficient: the cron's scan enqueues
   other tasks and performs upkeep independently.
6. Establish authoritative accounting for every old-version request, queue
   delivery, scheduled execution and its outstanding background work, including
   already running work admitted before the pauses. Record the provider or
   operator evidence source, version/execution identity, admission cutoff and
   terminal completion coverage. Sampled logs cannot prove completeness. If
   the platform cannot provide complete accounting, stop for operator
   coordination before stage 1; do not invent a drain timeout.

The provider control names and live state must be verified at release time;
this document does not claim that a suitable pause or drain primitive has been
established. Missing drain evidence or unsafe queue state blocks production
changes while the current deployment remains unchanged.

## Two-stage durable-lock migration

1. With all prerequisites established, deploy the approved artifact with
   `WORKWIKI_DURABLE_LOCK_V2_READY` absent. Retain all other production settings.
   Capture the deployment/version identity and confirm reads remain available.
   The R2 mutation gate must remain closed during the transition. Keep producer
   and delivery pauses active.
2. Obtain authoritative evidence that every old-version execution and delivery
   has finished. Neither elapsed time, expired leases, an empty queue nor
   100% routing to the new version proves this. A readiness flag is an operator
   assertion, not a drain detector. Do not proceed without this evidence.
3. Deploy the same built artifact with
   `WORKWIKI_DURABLE_LOCK_V2_READY=1`, preserving every other runtime setting.
   Record its artifact hash, deployment/version identity, exact configuration
   delta and the drain evidence that authorized this stage.
4. Restore paused activity using the recorded inverse operations. Reconcile
   task outcomes, retry attempts, pending messages and DLQ against the captured
   baseline; check for unexpected terminal failures or email failure receipts.
   Verify signed-out access is refused on both domains, then verify
   owner-authenticated reads and a reversible isolated write through the real
   application. Record the isolated test object's identity and cleanup result.
   If no owner session is available, state that owner acceptance is unexecuted.

## Failure and rollback

Keep producers and deliveries paused if either stage fails. Use the captured
rollback identity and restored configuration only after verifying its lock
compatibility and execution accounting; rolling back to a pre-v2 Worker while
v2 callbacks remain active can recreate the original overlap. A failed gate
requires operator coordination, not destructive recovery. Never bulk-clear
legacy leases. A single orphan lease may be considered only in a separately
authorized recovery after proving all requests and deliveries for that lock
have stopped; expiry alone is insufficient.

## Code evidence

- `src/lib/lock.ts`, `withDurableLock`: R2-only migration gate; separate
  `locks/` bridge and `locks-v2/` CAS lease; positive legacy leases cannot be
  reclaimed merely after their advertised expiry. Local filesystem use normally
  bypasses the durable path. `README.md` documents this two-stage rollout.
- `src/lib/__tests__/lock.test.ts`: explicitly forces migration refusal and
  exercises CAS/renewal/recovery behavior. `storage-r2.test.ts` exercises raw
  R2 etags and conditional-write races. These are local regression evidence,
  not live R2 acceptance or evidence of old-worker drain.
- `src/app/api/tasks/run/route.ts`, catch handler: ingest retries at attempt
  three or greater return 422 on otherwise transient errors, including a
  migration refusal. `workers/task-consumer/index.ts`, `runTask`: 400, 404
  and 422 acknowledge; other operational failures retry. Therefore sending
  work into stage 1 can terminally fail/ACK it instead of retaining it safely.
- `workers/task-consumer/index.ts`, `scheduled`: independently POSTs the
  scanner; queue delivery pause alone leaves this producer active.
- `DEPLOY.md`, read-only boundaries: administrative reset/import/migrate and
  multiple other stores remain writable. Read-only is an additional refusal
  layer, not complete quiescence or proof of finished old work.
- `playwright.config.ts`: one worker, dedicated `e2e/.data`, a local `next dev`
  server and test identity flags. Production builds must run separately after
  the browser process exits, without those flags.

## Release evidence to complete

| Evidence | State |
| --- | --- |
| Local dependency/application/browser/build checks | Passed: frozen install, peers, TypeScript, lint, 399 test files (9,990 passed; 1 existing credential skip), 26 browser tests, both builds and Worker dry run; see spec |
| Independent local review | Three context-free reviewers returned zero findings: general, edge cases, verification gaps |
| Published PR and exact-head terminal CI | Pending |
| Merged revision and production artifact hash | Pending |
| Live config, queue/DLQ baseline and rollback identity | Not captured |
| Reversible delivery and producer pauses | Not established |
| Authoritative old-execution accounting | Not established; blocks stage 1 |
| Stage 1 deployment, gate absent | Not performed |
| Completed old-execution drain | Not established; blocks stage 2 |
| Stage 2 deployment, gate set to 1 | Not performed |
| Restored activity and retry/DLQ reconciliation | Not performed |
| Both domains and signed-out refusal | Not performed |
| Owner reads and isolated reversible write | Not performed |
