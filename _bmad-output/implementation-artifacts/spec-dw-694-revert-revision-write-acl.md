---
title: 'DW-694: Enforce write ACL on MCP revision revert'
type: 'bugfix'
created: '2026-09-01'
status: 'done'
review_loop_iteration: 0
baseline_commit: '6288b854c707bd6c2498f86bc7b769b5b9bb1255'
context:
  - '{project-root}/.yoyo/learnings.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `handleRevertRevision` authenticates the HTTP MCP caller only at the tool boundary, then loses that identity and restores prior Page content without the write ACL enforced by `update_page` and the REST revert route. Any authenticated principal can therefore rewrite a Page they cannot edit, including another owner's private Page.

**Approach:** Thread the server-resolved `Principal` into the handler, enforce the existing realm-aware body-write ACL immediately after the fresh current-Page read, and preserve the trusted stdio fallback for callers that omit `principal`.

## Boundaries & Constraints

**Always:** Inject `principal` from the HTTP dispatcher, never from MCP arguments. Distinguish omitted `principal` from explicit `null`; only omission receives the existing `service:mcp` fallback. Authorize the current Page before reading the requested revision, use `canWriteFrontmatter(..., "body")`, and preserve the REST twin's readable-denial versus not-found cloak. A denied call must leave Page and revision bytes unchanged.

**Ask First:** Any solution requiring changes to the shared ACL model, REST response contract, lifecycle authorization, or revision storage format.

**Never:** Do not expose `principal` in an MCP schema; change `author` attribution; weaken the fresh+strict read or CAS merge base; move authorization into lifecycle; add revision-read authorization; alter the REST/UI surfaces; or edit `deferred-work.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Authorized HTTP revert | Caller owns a private Page and supplies a stored revision | Revision is restored through the existing lifecycle path | Existing success result and author attribution |
| Public knowledge denial | Authenticated non-service principal targets a readable public knowledge Page | No write occurs | Shared `WRITE_DENIAL_REALM.revert` message |
| Private non-owner denial | Caller targets another owner's private Page | No write occurs and Page existence is not disclosed | Same lowercase `page not found: <slug>` cloak as a missing Page; no realm wording |
| Unauthorized missing revision | Denied caller supplies an absent timestamp on an existing Page | Page ACL wins before revision lookup | Realm denial or private cloak, never `revision not found` |
| Trusted stdio compatibility | Direct/stdio caller omits `principal` | Existing revert behavior remains allowed via `service:mcp` | Existing validation and storage errors remain unchanged |

</frozen-after-approval>

## Code Map

- `src/mcp.ts:311-464,1441-1515` -- `handleUpdatePage` and `handleDeletePage` provide the exact omitted-principal fallback and ACL/cloak pattern; apply it to `handleRevertRevision` after its fresh+strict null branch and before `readRevision`. The stdio registration remains a no-principal trusted caller.
- `src/lib/mcp-http.ts:472-509,772-787,1210-1251` -- sibling write tools pass `principal: p`; `revert_revision` currently passes only `author`. `write: true` authenticates but does not enforce per-Page authorization.
- `src/lib/authz.ts:231-310` -- authoritative service/admin, commons-realm, and private owner-equivalence rules. Read-only for this change.
- `src/app/api/wiki/[slug]/revisions/route.ts:138-165` -- REST revert twin and required ACL ordering/cloak behavior. Read-only parity reference.
- `src/lib/write-denial.ts:1-113` -- shared refusal documentation currently counts nine resolver-backed surfaces; adding the MCP revert handler makes ten and makes `revert` cover REST plus MCP.
- `src/lib/__tests__/mcp.test.ts:4648-4892,4990-5167` -- preserve direct no-principal success and add handler-level public/private denial coverage with byte-preservation assertions.
- `src/lib/__tests__/mcp-http.test.ts:1525-1585` -- make the happy fixture owner-authorized; add dispatcher regressions that fail if `principal: p` or the handler ACL is removed.
- `src/lib/__tests__/write-denial.test.ts:10-19` -- keep the resolver surface-count explanation synchronized; no policy behavior changes.

## Tasks & Acceptance

**Execution:**
- [x] `src/mcp.ts` -- accept `principal?: Principal | null`, resolve the trusted omission fallback, and apply the REST-parity ACL/cloak before revision lookup.
- [x] `src/lib/mcp-http.ts` -- pass the authenticated principal to `handleRevertRevision` without changing the wire schema.
- [x] `src/lib/__tests__/mcp.test.ts` -- pin handler denial ordering, realm copy, private cloak, no mutation, and stdio compatibility.
- [x] `src/lib/__tests__/mcp-http.test.ts` -- make principal forwarding load-bearing for public and private denies, and retain an authorized owner success control.
- [x] `src/lib/write-denial.ts`, `src/lib/__tests__/write-denial.test.ts` -- update only the resolver-caller accounting and revert surface documentation.

**Acceptance Criteria:**
- Given a principal that `handleUpdatePage` would refuse, when HTTP MCP calls `revert_revision`, then it cannot restore any revision and the stored Page remains byte-identical.
- Given a denied caller and an absent revision timestamp, when `revert_revision` runs, then the Page ACL's realm-or-cloak response is returned before revision existence is evaluated.
- Given the MCP tool manifest and input schema, when inspected after the change, then no caller-controlled `principal` field exists.
- Given direct and stdio callers that omit `principal`, when they revert an otherwise valid Page, then the trusted service fallback preserves current behavior.

## Spec Change Log

## Design Notes

Use `args.principal !== undefined` rather than nullish coalescing: explicit `null` is an unauthenticated principal and must fail closed, while omission is the compatibility signal for deployment-trusted stdio. Keep the ACL after the existing fresh+strict Page read so it evaluates authoritative frontmatter, but before `readRevision` so revision timestamps do not become an oracle.

## Verification

**Commands:**
- `pnpm exec vitest run src/lib/__tests__/mcp.test.ts src/lib/__tests__/mcp-http.test.ts src/lib/__tests__/write-denial.test.ts src/lib/__tests__/wiki-routes.test.ts` -- expected: focused handler, HTTP, shared-copy, and REST-parity suites pass.
- `pnpm test` -- expected: both configured Vitest projects pass with no new failures.
- `pnpm lint` -- expected: clean for all touched files.

## Suggested Review Order

**Authorization boundary**

- Authorize the fresh current Page before revision lookup or lifecycle mutation.
  [`mcp.ts:1480`](../../src/mcp.ts#L1480)

- Inject authenticated HTTP identity after caller arguments, preventing principal spoofing.
  [`mcp-http.ts:784`](../../src/lib/mcp-http.ts#L784)

- Preserve trusted stdio omission while making explicit null fail closed.
  [`mcp.ts:1441`](../../src/mcp.ts#L1441)

**Denial contract**

- Register MCP revert as the tenth shared, realm-aware denial surface.
  [`write-denial.ts:7`](../../src/lib/write-denial.ts#L7)

**Verification**

- Prove transport injection, schema isolation, owner success, denial, and history immutability.
  [`mcp-http.test.ts:1536`](../../src/lib/__tests__/mcp-http.test.ts#L1536)

- Pin ACL ordering, private cloaking, explicit-null behavior, and stdio compatibility.
  [`mcp.test.ts:4678`](../../src/lib/__tests__/mcp.test.ts#L4678)

- Keep shared denial-surface accounting synchronized with the new MCP caller.
  [`write-denial.test.ts:14`](../../src/lib/__tests__/write-denial.test.ts#L14)
