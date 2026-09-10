# Six decisions to unblock eight deferred items

Status: recommendations prepared for owner approval; **not adopted contracts**.
Source baseline: `3e786d97090347b012d30b0dee485c3b761c2c2d` (PR #17 including
merged PR #16). Prepared 2026-09-09. No historical frozen contract or ledger
entry is edited by this document. Approval means these rulings can govern new
local implementation packets; provisioning, deployment and destructive live
operations remain separately authorized.

## Recommended approval package

| Decision | Items | Recommended ruling | Main tradeoff |
| --- | --- | --- | --- |
| D1 Runtime egress | DW-443 | Adopt the later per-runtime ruling: Node connection pinning; separately enforced Workers egress. | Full Workers protection depends on a real deployment control. |
| D2 Case-variant ownership | DW-776, DW-783 | Treat proven equivalent owned spellings as one logical page; preserve conflicting variants for explicit resolution. | Ambiguous deletes can refuse instead of silently deleting differing content. |
| D3 Source deletion recovery | DW-774, DW-784 | Use a durable, resumable deletion intent that fences publication and accounts for relocated source copies. | Requires coordinated lifecycle/job changes, not a cancellation reorder. |
| D4 Navigation focus | DW-759 | Extend focus recovery to whichever Workbench region the transition actually withdraws. | Broader than the old canvas-only scope, while avoiding focus theft elsewhere. |
| D5 Canonical miss hints | DW-769 | Add safe hints to GET Wiki revisions, lineage and wiki-page Preview misses only. | Permission-hidden targets still receive an ordinary indistinguishable 404. |
| D6 Stored review error | DW-785 | Return HTTP 500 `stored_review_invalid` for invalid stored input used to start research. | Clients must repair/regenerate the review rather than retrying unchanged input. |

## D1 — runtime egress (F3)

**Ruling to approve:** The 2026-08-28 per-runtime decision supersedes the earlier
2026-08-26 synchronous-only proposal for this new packet. Preserve cheap URL
syntax/literal-address screening, then apply asynchronous runtime-specific
protection. In Node, resolve and classify all candidate addresses, bind the
selected public address to the actual connection, preserve the original host
for TLS/HTTP identity, and validate every redirect. A validation lookup followed
by an independent connection lookup is insufficient.

For Workers, specify an enforceable destination allowlist or egress proxy and
verify its connection-time boundary. An application-only hostname list does
not prove protection against a permitted hostname changing addresses. Do not
silently claim the Node guarantee applies to Workers. Missing deployment
enforcement remains a named limitation; activation of a hardened Workers path
must fail closed until its approved control exists. This decision does not
provision that control or disable existing production fetching immediately.

**Current evidence:** [url-safety.ts](../../src/lib/url-safety.ts) screens names
and literal addresses; its shared fetch callers still need per-runtime wiring.
The two dated decisions are retained in the ledger and Phase 0 evidence.
**Acceptance:** controlled DNS changes, mixed public/private answers, redirect
target changes, original-host TLS validation, and unreachable enforcement.
Use synthetic local endpoints, never real metadata/private-network probes.

## D2 — case variants (D2)

**Ruling to approve:** Reuse the existing logical-slug matching rules. Resolve
all physical spellings in the same authorized tenant/compatibility scope before
mutation. Identical, proven-owned copies belong to the logical delete together.
Differing bytes, contradictory ownership or an incomplete enumeration cause a
conflict with no destructive action until the owner resolves the ambiguity.
Never cross tenant boundaries or infer ownership merely from similar spelling.

For receipt-missing crash recovery, an existing case-variant object can satisfy
publication only if its exact bytes and operation identity match the accepted
request. Reuse it and complete the existing recovery path; do not create a second
canonical spelling. Any conflicting variant remains a real conflict. Partial
physical deletion must stay explicitly incomplete and resumable; never report
success while a known owned sibling can reappear.

**Current evidence:** [lifecycle.ts](../../src/lib/lifecycle.ts) elects one stored
spelling for deletion and reads the canonical spelling during pageAlreadyWritten
recovery; the old DW-740/741 scopes explicitly left broader reconciliation out.
**Acceptance:** case-sensitive synthetic storage, same/differing bytes, owner
mismatch, interrupted enumeration/delete, restart, and receipt deduplication.

## D3 — source deletion and cancellation (D3)

**Ruling to approve:** Keep an interrupted source deletion visible as a pending
or failed recoverable operation. Record durable intent and the source identity
before cancelling related jobs; every relevant publisher must honor that intent
before publishing. Snapshot the complete affected-address set from current source
references, retained merge evidence and relocation custody. Preserve original
receipts; do not rewrite published history to make cleanup easier.

Persist progress through cancellation, page/reference changes and raw-copy
removal. A failure reports the completed and remaining portions and retains the
inputs needed to retry. A retry resumes the same operation. Simply moving job
cancellation after deletion is rejected: a surviving job could publish during
the gap. No new commit authority is adopted by this decision. If existing runtime
primitives cannot fence every relevant concurrent publisher, keep that part
blocked and demonstrate the missing interleaving before proposing architecture.

**Current evidence:** [source-cascade.ts](../../src/lib/source-cascade.ts)
cancels before strict enumeration. [merge.ts](../../src/lib/merge.ts) and
[lifecycle.ts](../../src/lib/lifecycle.ts) retain relocation/recovery paths that
the cascade's current address derivation does not fully reconcile.
**Acceptance:** merge → relocate → delete, cancellation with enumeration failure,
partial writes/deletes, restart, and a delayed publisher released mid-cascade.

## D4 — navigation focus (U2)

**Ruling to approve:** Replace the historical canvas-only scope with a
transition-owned focus rule for Workbench navigation. Sample focus before the
transition. If its region will be hidden or removed (including SettingsNav),
restore a valid destination in the newly active surface without scrolling. Use
an existing remembered destination when valid, otherwise its established focus
container. Preserve focus in unaffected tree, rail or other visible controls;
deep links with no withdrawn focused region must not steal it. Dialog focus
management retains ownership while a dialog is active.

**Current evidence:** [Workbench.tsx](../../src/components/workbench/Workbench.tsx)
uses the canvas sample for Back/Forward; the Phase 0 mounted Settings navigation
probe reproduced focus falling to body outside that sample.
**Acceptance:** Settings Back/Forward, unmounted focused navigation, unaffected
control, hidden/inert destination, narrow dialog and real browser focus/scroll.
DW-522 is not automatically included: its separate reachable defect remains
unestablished.

## D5 — canonical miss hints (V3)

**Ruling to approve:** Extend the current raw/wiki miss contract to exactly:
GET `/api/wiki/[slug]/revisions`, GET `/api/wiki/[slug]/lineage`, and the
wiki-page branch of GET `/api/workbench/preview`. Keep HTTP 404; attach the
existing `canonicalSlug` field only after resolving an alias and verifying that
the caller may learn/read the destination under that door's normal policy.
Denied or inaccessible targets, unrelated raw/assets/artifacts, and absent
redirect evidence keep the existing indistinguishable missing response. Do not
change write verbs, auto-redirect requests, or bypass page-scoped grants.

**Current evidence:** [revisions](../../src/app/api/wiki/[slug]/revisions/route.ts),
[lineage](../../src/app/api/wiki/[slug]/lineage/route.ts), and
[Preview](../../src/app/api/workbench/preview/route.ts). The prior DW-233/704
contract deliberately covered narrower doors; update new contract documentation
with implementation rather than retroactively changing that frozen packet.
**Acceptance:** accessible alias, inaccessible/private destination, missing alias,
scoped-token mismatch, and each consumer's handling of a safe hint.

## D6 — invalid stored review input (V4)

**Ruling to approve:** In PATCH `/api/v1/projects/[wikiId]/reviews/[reviewId]`
with `action: deep_research`, classify validation failures originating from the
stored review's research fields as HTTP 500 with machine token
`stored_review_invalid`. Use safe guidance: “The stored review cannot be used
to start research. Repair or regenerate the review first.” Do not echo stored
content or raw diagnostics; do not automatically discard or rewrite it.

Keep caller-input errors as 400 `invalid_input`, missing/hidden reviews as 404,
capacity refusal as 400 `limit_reached`, and the existing busy-store 503. Scope
the new classification to stored-field validation, not every ClientInputError
in the handler. A repeated unchanged request is not a remedy for corrupt stored
input. This does not assert broader error privacy is already complete.

**Current evidence:** [review route](../../src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts)
passes stored title/summary/queries into createResearchProject. The earlier
DW-748 ruling intentionally changed capacity only.
**Acceptance:** valid request + invalid stored review, malformed caller request,
missing/hidden review, capacity/busy failures, and no new project after refusal.

## Implementation order after approval

D4, D5 and D6 can be specified independently. D2 precedes recovery-sensitive
lifecycle work; D3 must resolve publication fencing before activation. D1 can
prove the Node path locally while the Workers enforcement dependency stays open.
Ordinary DW-766/767/772 fixes need none of these new rulings.

Approval is still required for these six proposed contracts. It closes ambiguity,
not implementation, CI acceptance or the separate production migration gates.
