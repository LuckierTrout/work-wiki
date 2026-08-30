---
title: 'Research registry: an owner-only quarantine-and-restart repair route for a wedged registry'
type: 'feature'
created: '2026-08-29'
status: 'in-review'
review_loop_iteration: 1
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      Quarantined registry copies accumulate without bound and no sanctioned
      cleanup path exists.
    evidence: |-
      Every repair writes a full copy of the registry to
      `tenants/<t>/research-projects.json.corrupt-<ms>` and pruning is
      explicitly forbidden (the copy is the tenant's only handle on the bytes).
      Nothing caps the count or the bytes, nothing lists them, and no route,
      CLI command or scheduled sweep removes one. A tenant that wedges
      repeatedly grows storage forever. `review-queue.ts`'s quarantine has the
      same shape and the same unbounded growth, so this predates the repair
      route, but the route makes quarantining a deliberate, repeatable action
      rather than an accident.
    location: >-
      src/lib/research-projects.ts (repairResearchRegistry), src/lib/review-queue.ts:397
    severity: medium
  - summary: >-
      The quarantined bytes are returned as a storage key nothing in the product
      can read, so the rescue is only reachable with filesystem or bucket access.
    evidence: |-
      The repair answers `{ quarantinedPath: "tenants/<t>/research-projects.json.corrupt-<ms>" }`,
      which is exactly what the recorded decision asks for. But no door in
      `src/app/api` serves an arbitrary tenant storage key, so the owner the
      intent calls "a tenant" cannot fetch, inspect or restore those bytes
      in-product — only an operator can. A download or restore-from-quarantine
      door would close the loop the repair opens.
    location: >-
      src/app/api/research/repair/route.ts
    severity: medium
  - summary: >-
      The repair is all-or-nothing, so one malformed row discards every readable
      project beside it.
    evidence: |-
      `parseRegistry` reports the INDEX of the first bad element, so the common
      corruption is one bad row among many, yet the recorded decision's remedy
      is "starts a fresh empty registry" — the other 99 rows are quarantined and
      the live registry becomes `[]`. A selective repair (drop only the failing
      elements, keep the rest) or a restore-from-quarantine flow would preserve
      them. Out of scope here because the decision names the empty-restart
      remedy explicitly; worth its own decision.
    location: >-
      src/lib/research-projects.ts (repairResearchRegistry)
    severity: medium
  - summary: >-
      The Research Panel renders "Repair it with POST /api/research/repair" to an
      owner with no control to press.
    evidence: |-
      `workbench-request.ts:66-72` surfaces the server's `error` sentence
      verbatim and `ResearchCanvas.tsx:95-98` puts it in the panel banner, so
      the remediation hint is user-facing copy instructing a non-technical owner
      to issue an HTTP POST by hand. The precedent the intent cites
      (`research-runtime.ts:896`) writes its remediation into
      `project.progress.message`, a field the panel is built to render. A panel
      affordance in the wedged-registry error state would put the recovery at
      the surface the intent's "in-product way out" framing points at.
    location: >-
      src/components/workbench/ResearchCanvas.tsx:95
    severity: medium
  - summary: >-
      The lease file's own refusal still names a repair that has no route behind
      it.
    evidence: |-
      `research-runtime.ts:896` tells the operator "Repair the lease state, then
      retry.", and `parseSlots` refuses an unreadable
      `tenants/<t>/research-leases.json` the same fail-closed way the registry
      does — but no door repairs a lease file. DW-477 closed that gap for the
      registry only; the sentence the ledger quoted as the good example is
      itself still unbacked.
    location: >-
      src/lib/research-concurrency.ts:89
    severity: low
  - summary: >-
      A lost CAS in the repair reports the shared "busy" sentence as a 500 after
      a single attempt, unlike the retry loop the sentence comes from.
    evidence: |-
      `applyResearchProjectMutation` retries `CAS_ATTEMPTS` times before
      throwing "Research projects were busy; retry the request."; the repair
      throws it after one lost CAS, and the door maps it to 500 rather than a
      retryable 409/503 with `Retry-After`. Kept as-is because every sibling
      door already surfaces that sentence as a 500 and a retry loop is wrong
      here (a concurrent repair makes the file readable, so the honest second
      answer is "nothing to repair", not a second wipe). Worth one pass over how
      contention is reported across this module's doors.
    location: >-
      src/app/api/research/repair/route.ts
    severity: low
baseline_revision: '249fc69455a9556f0c11d8ffc2477add23d7663c'
---

<intent-contract>

## Intent

**Problem:** DW-477. Since DW-297/DW-476 an unreadable research registry refuses at BOTH read sites (`parseRegistry`, `src/lib/research-projects.ts:264-275`), which is the intended fail-closed behaviour — but it wedges the tenant: every research door 500s, including the deletes that could shrink the file, and the refusal body carries no remediation, unlike the lease equivalent at `research-runtime.ts:896` ("Repair the lease state, then retry."). The owner has no in-product way out.

**Approach:** Add the missing half — an owner-only `POST /api/research/repair` that moves an UNREADABLE registry aside to a timestamped quarantine key (the shape `review-queue.ts`'s `quarantine` already uses), starts a fresh empty registry and returns the quarantined path. Name that route in the two refusal messages `parseRegistry` throws, and pin by test that a READABLE registry is never quarantined.

## Boundaries & Constraints

**Always:**
- A READABLE registry is NEVER quarantined and NEVER overwritten. The repair re-parses through the same shared `parseRegistry` and refuses to act when it succeeds — that is the whole safety property, and it must be pinned by test for a healthy registry, an empty-list registry and a tombstoned one.
- An ABSENT registry (ENOENT) is not a repair either: there is nothing wedged and nothing to quarantine. Answer the same "nothing to repair" refusal, never a fresh write.
- The quarantine copy is written FIRST and the fresh registry only after it lands. If the quarantine write throws, the stored registry stays byte-identical and the door answers 500 — losing the unreadable bytes is the one outcome this route must never produce.
- "Unreadable" is any throw out of `parseRegistry`, `JSON.parse`'s raw `SyntaxError` included — truncated bytes are exactly the case that needs this route. A storage read fault (anything but ENOENT) is NOT unreadable: rethrow it so the door answers 500 without touching anything.
- The registry replacement is a CAS (`writeFileIfMatch` against the etag from the same read) under `withFileLock(lockKey(owner))`, the shape `applyResearchProjectMutation` already uses. A lost CAS throws the existing busy sentence rather than blind-writing.
- The repair is a WRITE: it is gated read-only at the door with `READ_ONLY_REFUSAL.researchMutate` and in the kernel with `assertWritable(READ_ONLY_REFUSAL.researchMutate)` — the DW-385 pairing `createResearchProject`/`deleteResearchProject` already use. Reuse that constant, do not mint a new sentence: repairing is "change my research", the capability its docblock already groups.
- Owner-only means the door's own principal: `getPrincipal()` or 401, then `principal.handle` as the owner. The tenant path is derived from the handle, so no caller can name another tenant's registry.
- The two `parseRegistry` messages keep their existing leading sentence verbatim and gain the route hint as a SUFFIX — the current suites substring-match those sentences and must keep passing.
- The refusal stays a plain `Error` (500). A wrong-shaped stored file is still a server fault; naming a remediation route does not make it the caller's input.

**Block If:**
- The repair cannot be made to leave a readable registry untouched on every path (i.e. any ordering exists where a parse succeeds and bytes are still replaced). That is the intent's explicit pin and cannot be traded away unattended.

**Never:**
- Do not build UI. The intent's deliverable is the route plus the message that names it; a Research Panel affordance is a separate change.
- Do not loosen `parseRegistry`, skip bad rows, or make any read path fall back to empty. DW-297's "unreadable is not empty" ruling stands; this route is the recovery, not a retreat from it.
- Do not delete the quarantined copy, prune old ones, or reap them on a schedule. The copy is the tenant's only remaining handle on the bytes.
- Do not add a new `READ_ONLY_REFUSAL` key, and do not add a `ClientInputError`/403 branch to the new catch that nothing can throw (the door gates `isReadOnly()` ahead of the try, the same reason that branch was rejected for `/api/research/[id]`).
- Do not change `research-concurrency.ts`'s lease messages, `MAX_PROJECTS`, `serializeProjects`, or any existing door's status codes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Non-list registry | stored bytes `{"projects":[]}` | 200 `{ repaired: true, quarantinedPath }`; quarantine holds the original bytes verbatim; registry now `[]` and reads as no projects | No error expected |
| Bad-element registry | stored bytes `[{}]` | same as above | No error expected |
| Truncated bytes | stored bytes `[{"id":` (raw `SyntaxError`) | same as above — a `JSON.parse` fault is unreadable too | No error expected |
| Healthy registry | rows the app itself wrote | 409 "nothing to repair"; NO quarantine written, stored bytes byte-identical | Refusal, not an exception |
| Empty-list registry | stored bytes `[]` | 409, bytes byte-identical | Refusal, not an exception |
| Tombstoned registry | rows incl. `deleteRequested: true` | 409, bytes byte-identical — a hidden row is still readable | Refusal, not an exception |
| Absent registry | no file at the tenant path | 409, and no file is created | Refusal, not an exception |
| Quarantine write fails | unreadable bytes, quarantine write throws | 500; registry bytes byte-identical, no fresh registry written | storage `Error` → 500 |
| Lost CAS | unreadable bytes, `writeFileIfMatch` returns false | 500 carrying the existing busy sentence | plain `Error` → 500 |
| Read-only deployment | `YOPEDIA_READONLY` set | 403 `READ_ONLY_REFUSAL.researchMutate`, before any read or write | Gate, not an exception |
| Unauthenticated | no principal | 401 "Sign in required." | Gate, not an exception |
| Refusal names the route | any door reading a wedged registry | the 500 body carries the original sentence AND `POST /api/research/repair` | plain `Error` → 500 |

</intent-contract>

## Code Map

- `src/lib/research-projects.ts` -- the whole library change. `parseRegistry` (`:264-275`) throws the two sentences to extend; its long docblock (`:228-263`) currently states at `:255-258` "With no repair route (deliberately out of scope), that index is the operator's only handle" — that clause is now FALSE and must be rewritten to point at the route, not merely appended to. `projectPath` (`:128-132`) and `lockKey` (`:134-136`) are the path/lock helpers to reuse. `serializeProjects` (`:304-306`) is how `[]` must be written. `applyResearchProjectMutation` (`:339-364`) is the CAS shape to mirror (`readFileWithEtag` → `writeFileIfMatch`, `lastError` = `"Research projects were busy; retry the request."`). `deleteResearchProject` (`:651-656`) is the `assertWritable(READ_ONLY_REFUSAL.researchMutate)` precedent, gated BEFORE the lock.
- `src/lib/review-queue.ts:397-402` -- the quarantine shape to follow verbatim: `writeFile(\`${path}.corrupt-${Date.now()}\`, raw)`. Its own copies already land beside `tenants/{tenant}/review-queue.json` (`queuePath`, `:87-91`), so a sibling `research-projects.json.corrupt-*` in the same directory is established precedent. DIFFERENCE to carry: there quarantine is best-effort (`logger.warn` and continue) because it is a side effect of a read; here it is the operation itself, so a failed write must PROPAGATE.
- `src/lib/research-runtime.ts:896` -- the remediation-sentence precedent the intent names ("Research queue state could not be read. Repair the lease state, then retry.") — match that register: one short imperative sentence after the diagnosis.
- `src/app/api/research/route.ts:65-79` -- the door shape to copy: `getPrincipal()` → 401, then `if (isReadOnly())` → 403 with `READ_ONLY_REFUSAL.<key>` imported (never re-typed), then the try. Its catch (`:137-146`) is the classification comment to NOT duplicate here (nothing in the repair path throws `ClientInputError`).
- `src/app/api/research/[id]/route.ts` -- sibling door; `POST /api/research/repair` is a STATIC segment so Next.js routes it ahead of `[id]`, and `[id]` has no POST anyway. Read-only 403 shape at `:17-22`.
- `src/lib/storage/types.ts:76-81, 138-176, 268-311` -- `FileWithEtag.etag` is a non-null `string`; `writeFile` is atomic-from-the-caller's-view (a throw means the bytes never landed); `writeFileIfMatch(path, content, etag)` returns `boolean`.
- `src/lib/__tests__/research-projects.test.ts` -- store suite (node project) and the home for the repair rows. `registryPath` (`:21-23`), `seedRawRegistry` (`:27-32`), `seedRow` (`:34-48`), `seedProjects` (`:57-67`, `{ tombstoned }`). The `a registry that is not a list` block (`:301-385`) and `a registry whose elements are not research projects` block (`:387+`) are the table-driven patterns to extend; the `vi.spyOn(storage, "writeFile"/"writeFileIfMatch"/"writeFileIfAbsent")` "never wrote" proof at `:328-347` is the shape for the readable-registry rows.
- `src/lib/__tests__/research-route.test.ts:1-60, 110-170` -- the door-test recipe: `vi.mock("@/lib/auth")`, `vi.mock("@/lib/research-projects", importOriginal)`, handler imported directly, `READ_ONLY_REFUSAL` asserted by constant. Its `savedReadOnly`/`YOPEDIA_READONLY` save-restore (`:55-60`) is how the read-only row is driven.
- `src/lib/__tests__/read-only-copy-parity.test.ts:269-299` -- the "newly gated doors serve their own constant, not a literal" table; the new route file belongs in it as `["research/repair/route.ts", "researchMutate"]`.
- `src/lib/__tests__/middleware-write-gate.test.ts:33-73` -- read-only evidence: only the listed service-token routes are exempt from the Clerk write gate, so `/api/research/repair` needs no entry and must not gain one.
- `src/lib/research-concurrency.ts` -- THE FILE THE FIRST PASS MISSED, and the reason this spec was amended. Research slots live in a SEPARATE file, `tenants/<t>/research-leases.json` (`leasePath`, `:67-71`), which a registry repair does not touch. `acquireResearchSlot` (`:163-212`) refuses at `slots.length >= MAX_CONCURRENT_RESEARCH` (`:191`) counting EXPIRED claims too, because `parseSlots` deliberately retains them (`:89-105`, "Retain expired claims until the project reaper explicitly fails/releases them"). `releaseResearchSlot` (`:301-323`) and `releaseExpiredResearchSlot` (`:333-347`) are the only reapers and both take a `projectId`. `applyResearchLeaseMutation`/`lockedMutation` (`:115+`) is the CAS shape any new reaper must reuse. `research-projects.ts` already imports `hasResearchSlot` from here, so an added import is no new coupling.
- `src/lib/research-runtime.ts:556-800` -- read-only evidence proving the orphan is PERMANENT: every `releaseResearchSlot`/`releaseExpiredResearchSlot` call in the repo is inside `reconcileResearchProjects`' `for (const project of projects)` loop over REGISTRY ROWS. With the registry replaced by `[]` no code path can ever name the vanished project ids again, so the held slots are unreapable rather than merely stale.
- `src/lib/read-only.ts:212-227` -- `READ_ONLY_REFUSAL.researchMutate`'s docblock ENUMERATES its doors ("`POST /api/research/[id]/run`, `PATCH`/`DELETE /api/research/[id]`") and says "ONE sentence for all four". Reusing the constant is only honest if that enumeration names the repair door too; the module docblock's DW-385 list (`:75-90`) likewise enumerates the kernel-gated store writers.
- `src/lib/__tests__/read-only-store-gate.test.ts:400-469` -- the gate-BEFORE-lock ordering table every sibling store writer is pinned by (`createResearchProject` → `lockedMutation(owner`, `deleteResearchProject` → `withResearchProjectLifecycleFence(owner`, the three names-terms writers → `withFileLock(lockKey(owner)`). Its docblock states why a storage-spy test cannot substitute: a gate moved inside the lock callback refuses just as loudly and leaves a byte-identical tree.
- `src/lib/storage/types.ts:279` -- `writeFileIfAbsent(path, content): Promise<boolean>` is the create-only write that makes "a quarantine copy is never destroyed" enforceable rather than merely promised.
- `src/components/workbench/ResearchCanvas.tsx:95-98, 224` and `src/lib/workbench-request.ts:66-72` -- read-only evidence: the panel renders the server's `error` sentence VERBATIM in its banner, so whatever `parseRegistry` throws is user-facing copy, not just log text.

## Tasks & Acceptance

**Execution:**
- `src/lib/research-projects.ts` -- add a module-private repair-hint constant and suffix it onto BOTH `parseRegistry` throws, keeping each existing sentence verbatim as the prefix -- the existing suites substring-match those sentences, and the refusal is the only place an operator learns the route exists.
- `src/lib/research-projects.ts` -- export `repairResearchRegistry(owner)` returning a discriminated `{ quarantined: true; path: string } | { quarantined: false }`: `assertWritable(READ_ONLY_REFUSAL.researchMutate)` first, then under `withFileLock(lockKey(owner))` read with `readFileWithEtag` (ENOENT → `{ quarantined: false }`, any other read fault rethrown), try `parseRegistry` and return `{ quarantined: false }` when it SUCCEEDS, otherwise `writeFile` the raw bytes to `` `${path}.corrupt-${Date.now()}` `` and only then `writeFileIfMatch(path, serializeProjects([]), etag)`, throwing the existing busy sentence on a lost CAS -- quarantine-before-replace is what makes a failed copy leave the bytes intact, and returning a union rather than throwing lets the door answer 409 without message matching.
- `src/lib/research-projects.ts` -- rewrite the now-false clause in `parseRegistry`'s docblock ("With no repair route (deliberately out of scope)…") to name the route as the recovery and keep the index's role, and document on `repairResearchRegistry` why a readable registry is refused, why the quarantine is written first, and why the copy is never pruned.
- `src/app/api/research/repair/route.ts` -- new `POST` handler: 401 without a principal, 403 with `READ_ONLY_REFUSAL.researchMutate` (imported, never re-typed) when `isReadOnly()`, then `repairResearchRegistry(principal.handle)` → 200 `{ repaired: true, quarantinedPath }` or 409 `{ error: <nothing-to-repair sentence> }`, with a plain 500 `{ error: getErrorMessage(error) }` catch -- 409 because the request conflicts with the registry's actual state, the same code `/api/research/[id]` uses for "cannot be edited".
- `src/lib/__tests__/research-projects.test.ts` -- add a `repairResearchRegistry` describe covering every matrix row that is a library concern: quarantine-and-restart for a non-list, a bad-element and a truncated registry (quarantine file holds the original bytes, registry reads empty afterwards); refusal with byte-identical bytes and no write spy called for a healthy, an empty-list, a tombstoned and an absent registry; a failed quarantine write leaving the registry untouched; a lost CAS surfacing the busy sentence; and a row proving both `parseRegistry` messages name `POST /api/research/repair`.
- `src/lib/__tests__/research-repair-route.test.ts` -- new door suite following the `research-route.test.ts` recipe: 401 unauthenticated, 403 read-only asserted against `READ_ONLY_REFUSAL.researchMutate`, 200 with the quarantined path, 409 when the store reports nothing to repair, and 500 on a storage `Error`.
- `src/lib/research-concurrency.ts` -- export a reaper that releases every slot held for `owner` whose `projectId` is not in a supplied keep-set (or, simpler and sufficient here, every slot for the owner), built on the module's own `lockedMutation` CAS and never throwing, the fail-soft discipline `releaseResearchSlot` already documents -- without it the repair's wipe strands the tenant's leases forever, because every existing reaper is keyed by a registry row that no longer exists.
- `src/lib/research-projects.ts` -- call that reaper from `repairResearchRegistry` AFTER the CAS replace lands, never before, and record on both sides why: the registry and the lease file are two files with no shared transaction, so reaping first would free capacity for a registry that might still be wedged, while reaping after leaves at worst a stale-but-reapable lease. Document that a still-running Worker whose slot is reaped fails soft -- its later progress write finds no row and returns `null`, the path `applyResearchProjectMutation`'s callers already compensate for.
- `src/lib/research-projects.ts` -- give the `{ quarantined: false }` variant a `reason: "readable" | "absent"` discriminator so the door can tell a healthy registry from one that does not exist -- one sentence for both states tells an owner with no registry that a file which is not there "reads fine".
- `src/lib/research-projects.ts` -- write the quarantine copy with `writeFileIfAbsent`, bumping a numeric suffix on collision until it lands, instead of a bare `writeFile` at a `Date.now()` key -- two repairs in the same millisecond otherwise overwrite the first rescue, which is the exact loss the "never pruned" rule exists to prevent.
- `src/lib/research-projects.ts` -- log the parse failure that triggered a quarantine (owner, registry path, quarantine path, the swallowed parse message) with `logger.warn`, the shape `review-queue.ts`'s `quarantine` uses -- a bare `catch {}` discards the one diagnostic an operator needs next, and this operation destroys the live file.
- `src/lib/research-projects.ts` -- place `REPAIR_HINT` and any docblock of its own ABOVE `parseRegistry`'s docblock, never between that docblock and `function parseRegistry` -- an intervening declaration re-binds the long refusal docblock to the constant and leaves `parseRegistry` documented by the constant's note. In the same pass correct that docblock's now-false "Both read sites go through this one helper" clause: there are three call sites, and the third deliberately catches the throw.
- `src/lib/read-only.ts` -- add the repair door to `READ_ONLY_REFUSAL.researchMutate`'s door enumeration and to the module docblock's DW-385 kernel-gated-writer list -- reusing one sentence for a fifth door is only defensible if the sentence's own docblock says so.
- `src/lib/__tests__/read-only-copy-parity.test.ts` -- add `["research/repair/route.ts", "researchMutate"]` to the newly-gated-doors table -- the new door must serve the constant, not a re-typed sentence.
- `src/lib/__tests__/read-only-store-gate.test.ts` -- add a row for `repairResearchRegistry` to the gate-before-lock ordering table -- a storage-spy test passes just as well with the gate moved inside `withFileLock`, which is the ordering this door most needs, and the table is the only thing that catches it.
- `src/lib/__tests__/research-projects.test.ts` -- beyond the rows already listed, add: a lease row seeding `research-leases.json` at `MAX_CONCURRENT_RESEARCH` slots for project ids that exist only in the corrupt bytes, asserting a post-repair `acquireResearchSlot` for a fresh id is GRANTED; a second wedge-and-repair cycle asserting BOTH `.corrupt-*` copies survive with their own bytes; and an absent-registry row asserting the `reason` discriminator, not just the refusal.
- `src/lib/__tests__/research-run-route.test.ts` (or the door suite that already drives a real store refusal) -- add a row asserting an HTTP door's 500 BODY carries `POST /api/research/repair` -- the intent's stated object is the 500 body, and a library-level message assertion verifies it only transitively.

**Acceptance Criteria:**
- Given a tenant whose stored registry is unreadable, when the owner posts to the repair route and then reads the panel door, then the read succeeds with no projects and the original bytes are recoverable verbatim from the returned quarantined path.
- Given any registry the app itself wrote, when the repair route is posted for that owner, then nothing is quarantined, nothing is written, and the stored bytes are byte-identical.
- Given a tenant holding every research slot for projects that exist only in an unreadable registry, when the repair runs and a new research slot is then requested, then it is granted — the repair must not trade a wedged registry for a permanently wedged lease file.
- Given a tenant repaired twice, when both quarantine copies are listed, then both still exist and each holds the bytes it rescued.
- Given the full suite, when `pnpm test` runs, then it passes with no new failures relative to the baseline revision.

## Spec Change Log

### 2026-08-29 — Amendment after review pass 1 (bad_spec loopback)

**Triggering finding (high).** The repair replaces the registry with `[]`, but research slots live in a SEPARATE file (`tenants/<t>/research-leases.json`) that the repair does not touch, and every slot reaper in the repo — `releaseResearchSlot` / `releaseExpiredResearchSlot` — is called only from `reconcileResearchProjects`' loop over REGISTRY ROWS. `acquireResearchSlot` counts held slots including expired ones (`parseSlots` retains them on purpose). So a tenant repaired while holding `MAX_CONCURRENT_RESEARCH` slots ends with slots no code path can ever name again: the advertised recovery trades a wedged registry for a permanently wedged lease file, and the tenant can never start another research run. Verified by reading `research-concurrency.ts:89-105, 163-212` and every release call site in `research-runtime.ts`.

**Also amended (medium/low), all root-caused outside the intent-contract.**
- The `{ quarantined: false }` variant carried no reason, so the door told an owner with NO registry that the file "reads fine" — a `reason: "readable" | "absent"` discriminator and two sentences are now required.
- The spec's Always said "do not delete the quarantined copy" while its Tasks specified a bare `writeFile` at a `Date.now()` key, which silently overwrites a same-millisecond predecessor. `writeFileIfAbsent` with a suffix bump is now required, making the rule enforceable rather than merely stated.
- The intent's stated object is "the refusing 500 BODY names that route", but only a library-level message assertion was required; a door-level 500-body assertion is now a task.
- Nothing required updating `parseRegistry`'s "Both read sites go through this one helper" clause (three call sites now) or `READ_ONLY_REFUSAL.researchMutate`'s door enumeration, and nothing said where `REPAIR_HINT` must sit — it landed between `parseRegistry`'s docblock and the function, re-binding the docblock to the constant. All three are now explicit tasks.
- The gate-before-lock ordering table in `read-only-store-gate.test.ts` — the convention every sibling store writer is pinned by, and the only test that can catch a gate moved inside the lock — had no row for the new writer.
- The parse failure was swallowed by a bare `catch {}`, discarding the one diagnostic an operator needs after an operation that destroys the live file; `logger.warn` is now required, the `review-queue.ts` shape.

**Known-bad state avoided.** Shipping a recovery door, named in every refusal a wedged tenant sees, that leaves that tenant permanently unable to run research — a strictly worse failure than the wedge it fixes, and one no test in the first pass could see because no row touched the lease file.

**KEEP — these worked and must survive re-derivation.** The first pass is preserved verbatim at `patch-dw-477-research-registry-repair-route-iter1.patch` in this directory; consult it and carry forward: (1) the discriminated-union return instead of message matching, and the door's 409 rationale; (2) the quarantine-BEFORE-CAS ordering and the comment explaining why a failed copy must propagate; (3) treating ANY throw out of `parseRegistry` as unreadable via a `readable` flag, `SyntaxError` included; (4) `assertWritable` ahead of the lock and of any read; (5) the `REPAIR_HINT` suffix that keeps each existing refusal sentence verbatim as its prefix; (6) the rewritten "REFUSING IS NOT A DEAD END (DW-477)" paragraph replacing the now-false "no repair route" clause; (7) the route docblock's static-segment and owner-only reasoning; (8) the twelve store rows and seven door rows already written, and the `read-only-copy-parity` table row — extend them, do not start over.

## Review Triage Log

### 2026-08-29 — Review pass
- intent_gap: 0
- bad_spec: 7: (high 1, medium 3, low 3)
- patch: 0
- defer: 6: (high 0, medium 4, low 2)
- reject: 6: (high 0, medium 0, low 6)
- addressed_findings:
  - `[high]` `[bad_spec]` The registry wipe strands `research-leases.json` slots permanently — every reaper is keyed by a registry row — so the repair can leave a tenant unable to ever start a research run; spec amended to require a lease reaper called after the CAS, plus an acceptance criterion and a test row seeding the lease file.
  - `[medium]` `[bad_spec]` An absent registry answered the same "the file reads fine" sentence as a healthy one; spec now requires a `reason: "readable" | "absent"` discriminator and two door sentences.
  - `[medium]` `[bad_spec]` The spec's own "never delete a quarantine copy" rule was unenforceable against its own `writeFile`-at-`Date.now()` task; `writeFileIfAbsent` with a suffix bump is now required, with a two-repair test row.
  - `[medium]` `[bad_spec]` The intent's stated object is the 500 BODY, but only a library-level message assertion was required; a door-level 500-body assertion is now a task.
  - `[low]` `[bad_spec]` `REPAIR_HINT` landed between `parseRegistry`'s docblock and the function, re-binding the long refusal docblock to the constant; placement is now specified, along with the now-false "both read sites" clause.
  - `[low]` `[bad_spec]` `READ_ONLY_REFUSAL.researchMutate`'s door enumeration and the DW-385 kernel-writer list did not name the repair door, so the "reuse, do not mint" justification was not true of the docblock as written.
  - `[low]` `[bad_spec]` No row in `read-only-store-gate.test.ts`'s gate-before-lock table, the only test that catches a gate moved inside the lock; the storage-spy row passes either way.

## Design Notes

Why a discriminated union instead of a throw for "nothing to repair": the door has to tell a refusal apart from a fault, and the only alternatives are a new error class (the intent needs none) or message matching (the anti-pattern DW-296 deleted from this very module's doors).

Why quarantine BEFORE the CAS replace, stated as the ordering rule:

```ts
// The copy is the tenant's only remaining handle on these bytes, so it lands
// first and its failure propagates. Replacing first and copying after would
// turn one storage hiccup into permanent loss of the very file the owner came
// here to rescue. A quarantine copy orphaned by a lost CAS is harmless — it is
// a duplicate of bytes another repair already saved.
await storage.writeFile(quarantinePath, read.content);
const wrote = await storage.writeFileIfMatch(path, serializeProjects([]), read.etag);
```

Two files, no shared transaction. The registry and `research-leases.json` are separate objects with separate CAS loops, so the repair cannot make the wipe and the reap atomic. The ordering rule is therefore: quarantine → CAS the registry → reap the leases. Each step is safe to have happened without the next (a quarantine copy with no wipe is a harmless duplicate; a wiped registry with un-reaped leases is the state a retry fixes), and no step is safe to have happened before the one before it.

The read-only pairing is deliberate: a read-only deployment refuses the repair even though the registry is wedged. That is correct and not a dead end — read-only is an operator-chosen deployment state, and the fix is to leave it, not to carve an exception into the one gate DW-385 exists to make unconditional.

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/research-projects.test.ts src/lib/__tests__/research-repair-route.test.ts src/lib/__tests__/research-route.test.ts src/lib/__tests__/research-run-route.test.ts src/lib/__tests__/read-only-copy-parity.test.ts src/lib/__tests__/read-only-store-gate.test.ts src/lib/__tests__/research-concurrency.test.ts src/lib/__tests__/research-runtime.test.ts` -- expected: all rows pass, including the new ones
- `pnpm exec tsc --noEmit` -- expected: no errors
- `pnpm lint` -- expected: no new errors
- `pnpm test` -- expected: no new failures against `249fc69455a9556f0c11d8ffc2477add23d7663c` (the dom-project `localStorage` suites are a known pre-existing red on this branch)
