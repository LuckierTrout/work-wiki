---
title: 'DW-771: owner raw-source viewing and download'
type: 'bugfix'
created: '2026-09-09'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'd26dd53c502a63881145290bdd5108bd8cd4ba5d'
context:
  - /private/tmp/work-wiki-owner-raw-access/AGENTS.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The owner can view an agent-scoped raw source in the human page, but its Download API returns 404. The human page also exposes these bytes to callers the API refuses.

**Approach:** Apply one raw-source access policy to both surfaces. The deployment owner may view and download agent-scoped sources. Other callers retain the existing raw API permission boundary, which the human page must also enforce before exposing source content. The user explicitly chose “view and download” on 2026-09-09; this supersedes only the older DW-742 owner denial for these two raw-source surfaces.

## Boundaries & Constraints

**Always:** Resolve ownership through the existing server-side owner predicate, including stable-id and handle-fallback behavior. Keep the strict frontmatter/private-page gate before any owner exception to the additional Workbench visibility gate. Preserve ordinary-public access, both legacy and per-source raw shapes, canonical handles, authorized alias hints/redirects, traversal guards and immutable source bytes. Uncertainty must not expose content. Work in the isolated checkout with synthetic local fixtures and installed dependencies.

**Ask First:** Expanding non-owner access, changing identity or tenant-addressing contracts, adopting another architecture, real-data operations, merge or deployment.

**Never:** Edit existing frozen specs, deferred-work ledger, protected configuration, dependencies or identifiers. No changes to assets, Files, MCP, bearer-token admission, other write paths or source data. No invented findings, production proof or blanket permission bypass.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
| --- | --- | --- | --- |
| Owner | Agent-scoped source; stable-id owner with changed/missing username, or configured handle fallback | Human page content and API source bytes available | Existing missing-source behavior |
| Non-owner | Agent-scoped source; anonymous, unrelated session, or stale-handle impostor | Both surfaces deny before returning raw bytes | 404 without content disclosure |
| Existing admission | Ordinary public source; anonymous; private source with permitted owner | Existing view/download works | Private non-owner remains 404 |
| Source shape | Legacy blob and multiple captured snapshots | Initial source and selected snapshot download agree | Invalid source IDs/slugs remain refused |
| Gate failure | Frontmatter read fails, or non-owner visibility derivation fails | Neither surface discloses content | Private gate denies; API derivation failure remains sanitized 500; page fails closed |
| Navigation | Wrong handle, authorized alias, private alias target, archived raw-only slug | Canonical navigation and authorized archives remain available; private targets stay concealed | Existing redirect/hint/miss semantics |

</frozen-after-approval>

## Code Map

- `src/app/api/raw/[slug]/route.ts`: GET uses `getPrincipal`, strict `canReadSlug`, then listReadableWikiPages → buildKnowledgeTree → workbenchSlugGate → rawPathAllowed. Keep its inner derivation-error handling and existing alias hints. This is the behavior baseline for non-owners.
- `src/app/u/[handle]/raw/[slug]/page.tsx`: RawSourcePage only checks canReadSlug before source reads; apply the shared additional gate before prefetch, redirects exposing restricted targets, or returning RawSourceBrowser props. Existing alias/archive branches must survive.
- `src/lib/owner.ts`: isOwnerPrincipal is the existing identity authority; stable configured Clerk id defeats a stale-handle impostor. Both raw surfaces use Clerk/E2E getPrincipal from `src/lib/auth.ts`; neither admits bearer credentials. Do not alter that contract or use isAdmin as the owner exception.
- `src/lib/raw-source-access.ts` (new): focused shared additional raw-source gate, reusing the existing tree/path derivation for non-owners and owner predicate for the approved exception. Keep frontmatter authorization at both callers; avoid general authz/Files policy expansion.
- `src/lib/__tests__/raw-route.test.ts`: current API matrix with real tree/path derivation and mocked storage/authz. `edit-raw-alias-forwarding.test.ts` and `owner-page-route.test.ts`: real temporary-store, route invocation and navigation-signal fixtures; use their lifecycle seeding patterns.
- `src/lib/__tests__/raw-source-owner-access.test.tsx` (new, dom project): route→real authorization/tree/storage composition for both surfaces; mount the returned RawSourceBrowser to establish real content and selected Download URLs. `src/components/RawSourceBrowser.tsx`: existing selected-item API URL drives fetch and Download; no UI redesign needed. Add mounted selected-source link coverage only if existing coverage does not establish this contract.
- Read-only context: Phase 0 report F1, `spec-dw-726-738-742-page-scoped-read-gates.md:229` historical owner-denial rationale; architecture AD-2/3/7/8; `.yoyo/learnings.md` before fixture writes using lifecycle helpers. This new spec records the changed ruling without rewriting history.

## Tasks & Acceptance

**Execution:**
- [x] `src/lib/raw-source-access.ts` and both raw route files: implement the shared policy, remove superseded route commentary and retain existing failure/navigation contracts.
- [x] `src/lib/__tests__/raw-source-owner-access.test.tsx`, `raw-route.test.ts` and affected raw/navigation suites: cover every matrix row with meaningful execution; prove exact source content for owner and denial for others using real local storage at least once. Preserve strict-read and anonymous/private regressions.
- [x] This spec: record actual tests, independent review disposition, changed ruling and any remaining limitations; leave the ledger untouched.

**Acceptance Criteria:**
- Given a captured agent-scoped source, when the authenticated owner opens its raw view and requests the displayed snapshot URL, then both return that source's same stored content.
- Given a caller the previous raw API denied, when opening the human raw page after this change, then no raw content is serialized for that caller.
- Given the complete packet, when checking scope and tests, then only owner raw-source admission changed and existing storage, navigation and other resource policies remain intact.

## Spec Change Log

- 2026-09-09: Implemented the approved owner view/download ruling in a focused shared additional raw-source gate. Both callers retain strict frontmatter authorization first. The API keeps its sanitized derivation-error 500 and existing alias hints; the human page fails closed before raw reads/canonical navigation and checks alias targets before redirecting. The earlier DW-742 spec remains historical and unchanged. No change to assets, Files, MCP, bearer admission, identity/tenant contracts, storage writers, immutable source bytes or the deferred-work ledger.

## Verification

- Run focused node raw/access/navigation suites, and mounted source selection coverage where needed.
- Run `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm test` and `git diff --check`; record actual counts and existing skips separately.
- No real-provider or deployment test is needed to claim this local authorization composition; do not claim production acceptance.

### Execution evidence (2026-09-09)

- Focused run: `pnpm exec vitest run src/lib/__tests__/raw-source-owner-access.test.tsx src/lib/__tests__/raw-route.test.ts src/lib/__tests__/edit-raw-alias-forwarding.test.ts src/lib/__tests__/owner-page-route.test.ts src/lib/__tests__/assets-route.test.ts src/lib/__tests__/read-isolation.test.ts src/lib/__tests__/raw.test.ts src/lib/__tests__/authz.test.ts` — **8 files / 190 tests passed**, no skips. Log: `/private/tmp/raw-owner-focused.log`.
- The new mounted suite executes 24 cases against synthetic filesystem storage seeded only through lifecycle/raw helpers. Real authorization, owner matching, tree/path derivation, route entry points and RawSourceBrowser establish initial content, source selection and the selected Download URL's exact response bytes. It also covers owner handle drift/id fallback, configured handle fallback, anonymous/unrelated/stale-handle/admin denial, public/private admission, strict frontmatter storage faults, derivation errors, aliases/canonical handles, archives, invalid slugs/source ids and missing sources. Framework identity/navigation and the unrelated wikilink-map hook are mocked; faults are injected only in the failure rows.
- `pnpm exec tsc --noEmit` — exit 0. Log: `/private/tmp/raw-owner-tsc.log`.
- `pnpm lint` — exit 0, with the existing three `jsx-ast-utils` TSNonNullExpression notices. Log: `/private/tmp/raw-owner-lint.log`.
- `git diff --check` — clean.
- Initial sandboxed `pnpm test` was interrupted after unrelated sidecar loopback `EPERM` and tsx IPC startup failures; it has no terminal suite result and is not passing evidence. Log: `/private/tmp/raw-owner-full-test.log`. The approved rerun with loopback permissions completed with exit 0: **402 files passed; 10,040 tests passed / 1 existing skipped (10,041 collected)** in 123.90 seconds. The skipped case is not execution evidence. Log: `/private/tmp/raw-owner-full-test-unsandboxed.log`.
- Three context-free reviews completed against the same full six-file diff: blind hunter returned no findings, edge-case hunter returned an empty finding list, and verification-gap reviewer reported no gaps. No review patches or follow-up cycle were needed.
- Initial fixture-authoring run had invalid short raw ids; fixtures now use actual SHA-256 content hashes. An invalid-slug probe also reached existing authorized alias canonicalization, so the traversal-denial cases use slugs with no resolvable alias and leave established alias semantics intact.
- Limitations: local authorization composition only. No real-provider, browser-network, deployment or production proof is claimed.

### Integration verification after PR #15

The unpublished packet was rebased onto `b9a1d5ca7d4b021411be37a014078809b7c8190e` after canonical owner sessions merged. `git range-diff` confirmed the implementation patch was unchanged (`9c800f67` to `a01242ff` before this evidence-only update). The original baseline and frozen intent remain historical and unchanged.

- Focused raw/access/navigation compatibility: **8 files / 190 passed**, no skips, 5.29s (`/private/tmp/raw-owner-main-focused.log`).
- Full `pnpm test`: **404 files / 10,081 passed / 1 existing Tavily credential skip**, 124.05s (`/private/tmp/raw-owner-main-full.log`).
- `pnpm exec tsc --noEmit`, `pnpm lint` and `git diff --check`: exit 0. Lint retains the three existing jsx-ast-utils diagnostics (`/private/tmp/raw-owner-main-tsc.log`, `/private/tmp/raw-owner-main-lint.log`).
- Existing installed dependencies were copied locally without manifest or lockfile changes. Synthetic loopback tests used the required permission. No production data, configuration or deployment action was involved.
- Earlier independent reviews cover the unchanged implementation patch; the new compatibility run includes the merged owner identity behavior. GitHub CI on the published head remains separate evidence.

## Approval record

The user selected owner “view and download” after the concrete two-surface permission choice. This packet implements that approved choice without requesting it again. No epic story key applies; sprint synchronization is skipped.

## Suggested Review Order

**Owner permission**

- Share the owner exception without changing other resource policies.
  [raw-source-access.ts:18](../../src/lib/raw-source-access.ts#L18)

**Source surfaces**

- Deny page prefetch and restricted navigation before any raw bytes escape.
  [page.tsx:22](../../src/app/u/[handle]/raw/[slug]/page.tsx#L22)

- Keep strict authorization, source selection and API error semantics.
  [route.ts:37](../../src/app/api/raw/[slug]/route.ts#L37)

**Behavioral proof**

- Follow real stored snapshots through the mounted view and Download API.
  [raw-source-owner-access.test.tsx:112](../../src/lib/__tests__/raw-source-owner-access.test.tsx#L112)

- Retain the existing API permission and failure matrix.
  [raw-route.test.ts:98](../../src/lib/__tests__/raw-route.test.ts#L98)
