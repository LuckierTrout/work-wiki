---
title: 'DW-743: A merge-absorb relocates the absorbed page''s silo raw Sources to the survivor'
type: 'bugfix'
created: '2026-09-05'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred:
  - summary: >-
      After a merge-absorb relocates the absorbed page's silo raw Sources onto
      the survivor, a Source cascade-delete on the survivor no longer reaps the
      relocated silo copy, so it outlives its flat bytes and keeps listing in
      the survivor's Files tree.
    evidence: |-
      `deleteRawSourceBytes(rest, owner)` (src/lib/raw.ts:908-925) deletes flat
      `raw/sources/<rest>` and silo `tenants/<t>/raw/sources/<rest>` with `rest`
      derived from the frontmatter source entry by `linkedRawRests`
      (src/lib/source-cascade.ts:101-124) — i.e. `<from>/<hex>.md` or
      `<from>.md`, spelling the ABSORBED slug. Before DW-743 the silo arm
      matched the preserved-in-place copy at `tenants/<t>/raw/sources/<from>/`.
      After it, the copy is at `tenants/<t2>/raw/sources/<into>/<hex>.<ext>` —
      and for the two flat singletons under a `<sha256>` name no frontmatter
      entry references at all — so the silo arm matches nothing while the flat
      arm still deletes. The result is a silo Source whose flat original is
      gone, still walked by `listWorkbenchFilePaths` under the survivor. Caused
      by this change, not pre-existing. The fix is not local: making the
      Sources' recorded addresses follow them would mean rewriting the
      survivor's already-published merged frontmatter, which is the merge
      receipt's linearization point — a product decision of its own, like
      DW-707.
    location: >-
      src/lib/silo.ts:relocateSiloRawSourcesForMerge
    severity: low
baseline_revision: '2d8bf0af1adf3a56d88513a7d75278237d16da9a'
---

<intent-contract>

## Intent

**Problem:** DW-609 made a merge-absorb delete pass `preserveRawSources`, which leaves the
absorbed page's silo raw Sources sitting at the **absorbed slug's** silo addresses
(`tenants/<t1>/raw/sources/<from>.md`, `tenants/<t1>/raw/<from>.md`,
`tenants/<t1>/raw/sources/<from>/<hex>.<ext>`, `tenants/<t1>/raw/<from>/<hex>.<ext>`) with no silo
wiki md anchoring them. Two consequences the recorded "preserve in place" decision never named:
slugs are reusable, so a page later created at `<from>` inherits another page's provenance in
Files and the Sources pane; and under a cross-owner merge (`bypassOwnerCheck`, `src/mcp.ts:489`)
the bytes stay in the **absorbed** owner's tenant, where the survivor's owner cannot read them at
all because DW-40 resolves `raw/` strictly inside the owner's silo (DW-743).

**Approach:** Human decision of 2026-09-04 — **relocate to the survivor's silo**. Before each
merge-absorb delete, `mergePages` moves the absorbed page's silo raw Sources into the **survivor's**
silo addresses so they follow the content that now claims them. The move is fail-soft: a failure
logs and leaves the bytes exactly where they are today, which is why the delete keeps passing
`preserveRawSources` — the flag is now the safety belt that stops a failed relocation from
destroying provenance the survivor's frontmatter already claims. `listWorkbenchFilePaths` and
`rawPathAllowed` are untouched, per the same decision.

**Target addresses.** The survivor's *hashed* tree is the only durable host, so the relocation
is not a naive address-for-address copy:

- The two **flat singletons** (`raw/sources/<from>.md`, `raw/<from>.md`) cannot go to the
  survivor's matching singletons. `syncSiloForPage` owns
  `tenants/<t2>/raw/sources/<into>.md` with an unconditional `copyText` from flat, so writing
  foreign bytes there would destroy the survivor's own mirrored Source **and** be reverted by the
  next `reconcileSilos`. They move instead into the survivor's modern hashed tree at a
  content-addressed name, `tenants/<t2>/raw/sources/<into>/<sha256>.md` — the same address family
  `saveRawSourceBytes` mints, which `mirrorHashedTree` only ever adds to and never rewrites.
- The two **hashed trees** move address-shape-preservingly —
  `raw/sources/<from>/<hex>.<ext>` → `raw/sources/<into>/<hex>.<ext>` and
  `raw/<from>/<hex>.<ext>` → `raw/<into>/<hex>.<ext>` — keeping the mirror's own legacy/modern
  convention. Only **page-owned** names (`isRawSnapshotName`) move; a folder-import file sharing
  the directory stays put, exactly as `removeHashedTree` already spares it (DW-611).

## Boundaries & Constraints

**Always:**
- The relocation runs in `merge.ts`, at BOTH `deleteWikiPageWhileLocked` call sites (normal and
  resume), immediately BEFORE the delete. `lifecycle.ts` knows nothing of a survivor.
- Fail-soft: wrapped in `try`/`catch` with a `logger.warn`, never rethrown. A storage failure must
  not abort a merge whose survivor is already durable; the fallback is today's behaviour.
- Both `deleteWikiPageWhileLocked` call sites keep `preserveRawSources = true`. With the bytes
  already moved it is unobservable on the happy path; on a FAILED relocation it is what keeps the
  delete from dropping provenance the survivor claims.
- The move is per file: copy to the survivor first, delete from the absorbed address only when the
  copy succeeded. Content-addressed targets make a retry byte-identical, so the resume path may
  run it a second time.
- Tenants come from frontmatter owners — `tenantForOwner(from.frontmatter.owner)` for the source,
  the survivor's CURRENT owner for the target (`currentOwner` in the resume branch, already
  validated tenant-equal to the receipt's).
- Only page-owned (`isRawSnapshotName`) entries move out of a hashed directory, and the emptied
  directory is removed only when nothing foreign was left in it — `removeHashedTree`'s existing
  rule, factored out and shared so the two cannot drift.
- Binary-safe: hashed entries move through `copyAsset`, never a UTF-8 round trip — the same
  namespace holds PDFs/DOCX/JPEGs.

**Block If:**
- `removeHashedTree`'s page-owned/foreign partition no longer exists, which would mean the DW-611
  narrowness this relocation reuses is gone.

**Never:**
- Never touch `listWorkbenchFilePaths`, `rawPathSlug`/`rawPathAllowed`, `sourcesTreeFromFiles`,
  `isV1FileInScope`, the rescan validator, or any Workbench UI shaping — explicitly excluded by the
  human decision, and DW-707 remains open and out of scope.
- Never touch the FLAT `raw/` tree. It is immutable per the founding vision and belongs to
  `deleteRawSourceBytes` / cascade delete. The relocation is silo-only.
- Never write to the survivor's flat singleton silo addresses
  (`tenants/<t2>/raw/sources/<into>.md`, `tenants/<t2>/raw/<into>.md`): `syncSiloForPage` owns them.
- Never change `syncSiloForPage`, `reconcileSilos`' reverse-orphan discovery, or
  `removeHashedTree`'s observable behaviour.
- Never make the relocation throwing, and never move it into `lifecycle.ts`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Same-tenant merge relocates | `alpha`→`beta`, both owned by `alice`; alpha's silo holds all four raw-Source addresses | The four objects are gone from alpha's addresses; beta's silo holds `raw/sources/beta/<sha256>.md` (×2 flat singletons), `raw/sources/beta/<hex>.md` and `raw/beta/<hex>.md`; alpha's discuss + assets still cleaned | — |
| Cross-owner merge follows the survivor | `bypassOwnerCheck` merge of `alpha` (owner `alice`) into `beta` (owner `bob`) | The bytes land under `tenants/bob/…`, readable by the survivor's owner; nothing is left under `tenants/alice/…` for alpha | — |
| Foreign file in a shared hashed dir | alpha's silo `raw/sources/alpha/` holds `<hex>.md` and `note.md` (folder-import) | `<hex>.md` moves; `note.md` and its directory stay under `tenants/<t1>/raw/sources/alpha/` | — |
| Relocation fails at the first arm | A storage `writeFile` rejects on the first flat singleton | The merge still completes, a `merge` warn names the failure, and all four addresses stay at the absorbed slug (today's behaviour) | Logged, never rethrown |
| Relocation fails PART-WAY | A storage `writeAsset` rejects on the last (legacy hashed) arm, after the earlier arms moved | The merge still completes and warns; the moved addresses are under the survivor and the un-moved one stays at the absorbed slug, kept there by `preserveRawSources` | Logged, never rethrown |
| Binary snapshot moves | The absorbed page's hashed tree holds a non-UTF-8 `<hex>.pdf` | It arrives at the survivor byte-for-byte (`copyAsset`, never a text round trip) | ENOENT swallowed |
| Files door after the move | The survivor's owner lists Workbench files | The relocated bytes appear under `raw/sources/<into>/…`; nothing for the absorbed slug appears in the absorbed owner's tree | — |
| Resume path relocates | The absorbed page's bytes are already removed but its silo raw Sources are still at the absorbed address when the `!currentFrom` branch runs | The resume branch relocates them to the survivor before its delete | As above |
| Nothing to move | The absorbed page has no silo raw Sources | No writes, no warn; the merge is unchanged | ENOENT swallowed |
| Structural survivor slug | Survivor slug is a `RAW_STRUCTURAL_DIRS` name (`assets`, `sources`, …) | The legacy-root arm targets the survivor's MODERN hashed tree instead of `tenants/<t2>/raw/<into>/`, so no shared structural root is written into | — |

</intent-contract>

## Code Map

- `src/lib/silo.ts:144-179` — `removeHashedTree`, the page-owned/foreign partition (DW-611). Factored
  into a shared `sweepHashedTree(prefix, take)` so the relocation reuses the exact same rule and the
  directory-reap condition. `removeHashedTree`'s behaviour stays byte-identical.
- `src/lib/silo.ts:299-350` — `removeSiloForPage` / `RemoveSiloForPageOptions`. Body unchanged; only
  the option's doc comment is updated to describe its new safety-belt role.
- `src/lib/silo.ts` (new export) — `relocateSiloRawSourcesForMerge(fromSlug, fromTenant, intoSlug,
  intoTenant)`, returning the number of objects moved.
- `src/lib/silo.ts:40-65` — `copyText`/`copyAsset`/`deleteSafe`/`listSafe`, the ENOENT-safe
  primitives the move is built from.
- `src/lib/source-sha256.ts:9` — `sourceSha256`, the 64-hex digest `RAW_ID_RE` accepts. Imports
  nothing, so `silo.ts → source-sha256.ts` adds no cycle.
- `src/lib/raw.ts:463,516` — `RAW_ID_RE` / `isRawSnapshotName`: `<64 hex>.md` is a valid snapshot
  name, which is what makes a content-addressed flat-singleton target legal.
- `src/lib/merge.ts:674-689` — the RESUME `deleteWikiPageWhileLocked` call site (`!currentFrom`
  branch), with `currentOwner` already in scope and tenant-validated against the receipt's owner.
- `src/lib/merge.ts:739-753` — the NORMAL `deleteWikiPageWhileLocked` call site.
- `src/lib/merge.ts:405-414` — `from` / `into` snapshots, in scope at both call sites and carrying
  the frontmatter owners the relocation needs.
- `src/lib/lifecycle.ts:188-198,1017,1262,1326` — the four `preserveRawSources` doc sites, which
  currently say the absorbed page's Sources "survive"/"stay in place". Reworded: the caller has
  already moved them, and the flag now covers a failed relocation.
- `src/lib/__tests__/merge.test.ts:502-…` — the resume test that seeds absorbed silo artifacts;
  `:1783-1836` — the "preserves the absorbed page's silo Sources" test. Both assert the bytes remain
  at the ABSORBED addresses and must be rewritten to assert relocation.
- `src/lib/__tests__/silo.test.ts:506-578` — the `removeSiloForPage on page delete` block and its
  temp-dir harness; the model for new direct relocation tests.
- `src/lib/silo.ts:413-448` — `reconcileSilos`' reverse-orphan pass. READ-ONLY; it discovers ghosts by
  scanning `tenants/<t>/wiki/*.md`, so it neither reaps nor rewrites the relocated bytes (the
  survivor HAS a wiki md).

## Tasks & Acceptance

**Execution:**
- `src/lib/silo.ts` — extract `sweepHashedTree(siloPrefix, take)` from `removeHashedTree` (same
  listing, same page-owned test, same "reap the directory only when nothing foreign was left"
  ending); reimplement `removeHashedTree` on top of it with identical behaviour.
- `src/lib/silo.ts` — add `relocateSiloRawSourcesForMerge`: move the two flat singletons into the
  survivor's modern hashed tree at `<sourceSha256(content)>.md`, and both hashed trees to the
  survivor's matching roots via `sweepHashedTree` + `copyAsset` + `deleteSafe`; skip the legacy
  root when the ABSORBED slug is structural (nothing was mirrored there) and retarget it to the
  modern tree when the SURVIVOR slug is structural; validate both tenants; return the move count.
- `src/lib/silo.ts` — update `RemoveSiloForPageOptions.preserveRawSources`' doc: the merge-absorb
  caller now relocates first (DW-743), and the flag is the belt for a failed relocation.
- `src/lib/merge.ts` — add a fail-soft `relocateAbsorbedRawSources` helper (`try`/`catch` +
  `logger.warn`, `logger.info` on a non-zero move) and call it immediately before BOTH
  `deleteWikiPageWhileLocked` calls, passing the absorbed owner from `from.frontmatter.owner` and
  the survivor's owner (`currentOwner` in the resume branch, `into.frontmatter.owner` in the normal
  one); update each call site's `preserveRawSources` comment to name the belt role.
- `src/lib/lifecycle.ts` — doc-comment only at the four `preserveRawSources` sites, so none of them
  claims the absorbed page's Sources are left at the absorbed slug's address.
- `src/lib/__tests__/silo.test.ts` — add a `relocateSiloRawSourcesForMerge` block covering the
  "Same-tenant merge relocates", "Cross-owner merge follows the survivor", "Foreign file in a shared
  hashed dir", "Nothing to move" and "Structural survivor slug" rows.
- `src/lib/__tests__/merge.test.ts` — rewrite the "preserves the absorbed page's silo Sources"
  test as a relocation test (bytes gone from alpha's addresses, present under beta's, discuss +
  assets still cleaned, survivor still claims alpha's sources); add a failed-relocation test that
  pins the fail-soft warn AND `preserveRawSources` (the merge completes, the bytes stay at alpha's
  address); extend the resume test so the absorbed silo raw Sources are present again when the
  resume branch runs, pinning the resume relocation call site.

**Acceptance Criteria:**
- Given a merge of `alpha` into `beta` where alpha's silo holds all four raw-Source addresses, when
  the merge completes, then none of those objects remains under alpha's silo addresses and every one
  of them is readable under beta's silo addresses.
- Given a cross-owner merge of `alpha` (owner `alice`) into `beta` (owner `bob`), when the merge
  completes, then the relocated Sources are under `tenants/bob/…` and nothing for `alpha` remains
  under `tenants/alice/raw/`.
- Given a storage failure during the relocation, when the merge runs, then the merge still completes,
  a `merge` warn is logged, and the absorbed page's silo raw Sources are still present at their
  original addresses.
- Given a hashed silo directory shared with a folder import, when the relocation runs, then only
  `isRawSnapshotName` entries move and the foreign file and its directory survive.
- Given the survivor's owner and `listWorkbenchFilePaths` after a merge, when the tree is listed, then the relocated Sources appear under the survivor's `raw/sources/<into>/` rows and the absorbed owner's tree lists none of them — asserted at that door, since "the moved bytes are visible under the survivor" is the reason the doors are left unchanged.
- Given a non-UTF-8 snapshot in the absorbed page's hashed tree, when the relocation runs, then the survivor's copy is byte-identical.
- Given `npx tsc --noEmit` and `pnpm lint`, when run after the change, then both exit clean.

## Spec Change Log

### 2026-09-05 — Human decision: relocate, do not preserve in place
Bundle `decision-dw-743`, run `20260904-130751-f452`: the human chose **option 1, relocate to the
survivor's silo**, for the question "a merge-absorb strands the absorbed page's raw Sources at the
absorbed slug's addresses; the recorded decision says preserve them in place, but the same spec
forbids touching the listing doors — which side gives?". The listing doors stay untouched; the bytes
move. `spec-dw-609-707-silo-mirror-lifecycle.md`'s "preserve in place" resolve decision is amended
in its own Spec Change Log to record this.

## Design Notes

**Why the flat singletons cannot go to the survivor's flat singletons.** `syncSiloForPage` copies
flat `raw/sources/<slug>.md` into `tenants/<t>/raw/sources/<slug>.md` with an unconditional
`copyText` on every write and every `reconcileSilos` pass. That address is therefore *owned by the
mirror*: foreign bytes written there destroy the survivor's own Source and are themselves destroyed
by the next reconcile. The hashed tree is the opposite — `mirrorHashedTree` only ever ADDS names it
does not already have, and never deletes — so a content-addressed name under
`tenants/<t2>/raw/sources/<into>/` is stable against reconcile in both directions. That is why the
relocation normalises both singletons into the hashed tree rather than preserving their address
shape.

**Why fail-soft and why the flag stays.** The relocation happens after the survivor is durable and
before the absorbed page's delete. Throwing there would abort a merge that has already published its
survivor, for a cleanup. Swallowing leaves exactly the DW-609 state — bytes at the absorbed address —
which `preserveRawSources` then protects from the delete. The two mechanisms are complementary, not
redundant: relocation is the fix, the flag is the floor.

Accepted residuals:
- **The slug-reuse harm is NOT eliminated; the phantom rows and the cross-owner reach are.** Flat
  `raw/` is immutable and out of scope, so the absorbed page's Sources are still at
  `raw/sources/<from>.md`, `raw/<from>.md` and both flat hashed trees. When a page is later created
  at `<from>`, `syncSiloForPage` re-mirrors exactly those bytes into the new page's silo, and the
  inheritance DW-743's headline names returns. What this change does fix outright: the ghost rows in
  the absorbed owner's Files tree between the merge and any such re-creation, and the cross-owner
  reach — a survivor's owner who previously could not read the provenance at all now has it in
  their own tenant. Reaping the flat bytes is `deleteRawSourceBytes`' cascade-delete decision, not
  this one.
- **Forward-only.** Merges that already happened left their bytes at the absorbed address; nothing
  in this change repairs them, for the same reason DW-609 was forward-only — the reverse-orphan pass
  discovers ghosts by scanning a wiki md the delete removed.
- **A partial relocation splits the Sources across both silos.** The four arms run in order and the
  first failure aborts the rest, so the survivor holds what moved and the absorbed slug keeps the
  remainder (which `preserveRawSources` protects). Pinned by a test; a re-run of the merge would
  finish the move. A crash between one arm's copy and its delete leaves that one object in BOTH
  silos — the survivor sees it, which is the desired end state, and the absorbed-address copy is the
  pre-existing DW-743 residual.
- **A relocation that succeeded followed by a delete that threw** leaves the absorbed page still
  present but stripped of its silo raw Sources, which now sit under the survivor. The survivor's
  frontmatter already claims them, and the merge resume path re-runs the delete, so the state is
  transient — but for that window the absorbed page shows no Sources of its own.
- **Cross-tenant disclosure is now possible, by design.** Under `bypassOwnerCheck` (set only by
  `handleMergePages` in `src/mcp.ts`, deployment-trusted stdio) the relocation writes one owner's
  raw Source bytes into another owner's silo — the first write that crosses the DW-40 boundary. That
  is what "the Sources follow the content" means when the survivor has a different owner, and it is
  what the recorded decision chose; the authorization gate is the merge's own, unchanged.
- **A concurrent `reconcileSilos` between the relocation and the delete** can re-mirror the absorbed
  page's flat bytes back into its silo, where `preserveRawSources` then leaves them — a re-created
  strand. Narrow (the absorbed page is under a lifecycle lock; the reconcile pass is not), and the
  next merge or delete of that slug clears it.
- **A Source cascade-delete on the survivor no longer reaps the relocated silo copy** — recorded in
  frontmatter `deferred`, since fixing it means rewriting the survivor's published merged
  frontmatter.

## Verification

**Commands:**
- `pnpm vitest run src/lib/__tests__/silo.test.ts src/lib/__tests__/merge.test.ts src/lib/__tests__/lifecycle.test.ts src/lib/__tests__/raw.test.ts` — expected: all tests pass.
- `npx tsc --noEmit` — expected: exit 0.
- `pnpm lint` — expected: clean.
- `pnpm test` — expected: no failures beyond confirmed pre-existing ones.
- Mutation checks — removing either `relocateAbsorbedRawSources` call must fail a merge test;
  flipping either `preserveRawSources` argument to `false` must fail the failed-relocation test;
  dropping the `isRawSnapshotName` gate must fail the foreign-file test.

## Review Triage Log

### 2026-09-05 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 12: (high 0, medium 2, low 10)
- defer: 1: (high 0, medium 0, low 1)
- reject: 4: (high 0, medium 0, low 4)
- addressed_findings:
  - `[medium]` `[patch]` The claim the whole design rests on — "`listWorkbenchFilePaths` walks the whole silo `raw/` root, so the moved bytes are visible under the survivor" — was asserted only in prose. Every new assertion read raw storage keys; nothing called the door, which is also the coverage gap the DW-743 ledger entry itself names ("no test covers the listing surface after a merge"). Added a `silo.test.ts` test that lists through `listWorkbenchFilePaths` as the SURVIVOR's owner before and after a cross-tenant relocation and asserts the absorbed owner's tree no longer lists them, plus a matching acceptance criterion and matrix row.
  - `[medium]` `[patch]` `moveHashedTree` uses `copyAsset` precisely so PDFs/DOCX/JPEGs are not mangled by a UTF-8 round trip, but every fixture was ASCII, so swapping it for `copyText` passed the whole suite — and the absorbed-address original is deleted right after the copy, making such corruption unrecoverable. Added a non-UTF-8 `writeAsset`/`readAsset` round-trip test. Mutation-checked: `copyAsset` → `copyText` now fails exactly that test.
  - `[low]` `[patch]` `relocateSiloRawSourcesForMerge` validated both tenants but neither slug, while `intoSlug` composes the write prefix and `tenantRawSourceRelPath`/`tenantRawRelPath` validate only the tenant. Every other writer into that namespace calls `validateSlug` first. Added `validateSlug` on both slugs with a comment saying why.
  - `[low]` `[patch]` The rewritten resume test re-seeded the same content-addressed `<hex>.md` with DIFFERENT bytes and depended on the second relocation's content winning — a state no writer can produce, and one that contradicts the spec's own "content-addressed targets make a retry byte-identical" bullet. Now only the flat singletons carry distinct bytes (their target name is derived from content, so it cannot collide); the hashed fixtures keep theirs.
  - `[low]` `[patch]` The resume call site's `preserveRawSources` was mutation-survivable: with its relocation succeeding, flipping it to `false` passed every test. Added a resume test whose resume-phase relocation fails, pinning both the resume relocation call (the warn) and the flag (the bytes stay). Mutation-checked: the flip now fails it.
  - `[low]` `[patch]` The "Relocation fails" matrix row claimed `writeFile`/`writeAsset`, but the only test failed the FIRST arm, so the relocation aborted before any asset write and all four addresses stayed put. The materially different part-way failure — Sources split across both silos — was untested and unnamed. Split the row in two, added a merge test that fails the last (legacy hashed, `writeAsset`) arm and asserts the split, and recorded the split state as a residual.
  - `[low]` `[patch]` The residual claimed the slug-reuse harm was "mitigated for the interval between the merge and any such re-creation" — during that interval no page exists at the slug, so nothing inherits anything. Reworded honestly: the flat layer re-supplies the bytes on re-creation, so what this change fixes outright is the ghost rows and the cross-owner reach, not the inheritance.
  - `[low]` `[patch]` The cross-owner arm writes one owner's raw Source bytes into another owner's silo — the first write crossing the DW-40 boundary — and the spec presented it only as a fix. Named it as a deliberate consequence, with its authorization gate (`bypassOwnerCheck`, `src/mcp.ts`), in the residuals.
  - `[low]` `[patch]` A relocation that succeeded followed by a delete that threw leaves the absorbed page present but stripped of its Sources. Not previously named; added as a residual (transient — the resume path re-runs the delete).
  - `[low]` `[patch]` A concurrent `reconcileSilos` between the relocation and the delete can re-mirror the absorbed page's flat bytes back into its silo, where `preserveRawSources` leaves them. Added as a residual with its narrowness stated.
  - `[low]` `[patch]` The DW-611 shared-directory rule was reasoned about only on the source side; the SURVIVOR's hashed directory can equally be shared with a folder import rooted at `<intoSlug>`. Documented on `relocateSiloRawSourcesForMerge` why writing a page-owned content-addressed name there needs no partition.
  - `[low]` `[patch]` Two spec surfaces went stale against the patches above: the acceptance criteria gained the Files-door and binary round-trip rows, and the I/O matrix gained the part-way-failure, binary and Files-door rows.

## Auto Run Result

Status: done
Blocking condition: none

### Implemented change

A merge-absorb now MOVES the absorbed page's silo raw Sources onto the survivor instead of leaving
them at the absorbed slug's address. `relocateSiloRawSourcesForMerge` (new export in
`src/lib/silo.ts`) runs from `mergePages` immediately before BOTH `deleteWikiPageWhileLocked` call
sites, fail-soft. The listing doors are byte-identical: `listWorkbenchFilePaths`, `rawPathAllowed`,
`sourcesTreeFromFiles`, `isV1FileInScope` and the rescan validator are untouched, and DW-707 stays
open, per the recorded decision.

Address mapping: the two hashed trees move name-for-name and root-for-root
(`raw/sources/<from>/<hex>.<ext>` → `raw/sources/<into>/<hex>.<ext>`, `raw/<from>/…` →
`raw/<into>/…`); the two flat singletons normalise into the survivor's MODERN hashed tree at
`<sourceSha256(content)>.md`, because the survivor's own singleton address is owned by
`syncSiloForPage` — foreign bytes written there would destroy the survivor's mirrored Source and be
reverted by the next `reconcileSilos`. Only page-owned (`isRawSnapshotName`) entries move, through
the partition rule `removeHashedTree` already used, factored out as `sweepHashedTree` so the two
cannot drift; `removeHashedTree`'s behaviour is unchanged.

`preserveRawSources` is unchanged and both merge call sites still pass it. Its role is now the floor
under a relocation that could not finish: the move is fail-soft, so on failure the bytes stay where
DW-609 left them and the delete must not drop them.

### Files changed

- `src/lib/silo.ts` — `sweepHashedTree` extracted from `removeHashedTree` (behaviour identical);
  new `moveTextToHashedTree` / `moveHashedTree` helpers; new exported
  `relocateSiloRawSourcesForMerge`; `RemoveSiloForPageOptions.preserveRawSources` doc updated to
  its new floor role. `removeSiloForPage`'s body is unchanged.
- `src/lib/merge.ts` — new fail-soft `relocateAbsorbedRawSources` helper, called at both
  `deleteWikiPageWhileLocked` call sites (resume and normal) with the absorbed page's frontmatter
  owner and the survivor's current owner; both `preserveRawSources` comments updated.
- `src/lib/lifecycle.ts` — doc comments only, at the four `preserveRawSources` sites, so none of
  them still claims the absorbed page's Sources rest at the absorbed slug's address.
- `src/lib/__tests__/silo.test.ts` — new `relocateSiloRawSourcesForMerge` block (+6 tests): all four
  addresses relocated, cross-tenant, foreign file and its shared directory spared with the moved
  snapshot removed file-by-file, structural survivor slug retargeted to the modern tree, nothing to
  move, and a reconcile that does not undo the move.
- `src/lib/__tests__/merge.test.ts` — the DW-609 "preserves the absorbed page's silo Sources" test
  rewritten as three relocation tests (relocation onto the survivor; a failed relocation that still
  completes the merge, warns, and keeps the bytes via `preserveRawSources`; a cross-owner merge that
  carries the bytes into the survivor's tenant); the resume test re-seeds the absorbed silo Sources
  so the RESUME call site's own relocation is pinned.
- `_bmad-output/implementation-artifacts/spec-dw-609-707-silo-mirror-lifecycle.md` — Spec Change Log
  entry amending resolve #2's "preserve in place" half, and its Design Notes residual struck through
  with a pointer to this spec.

### Review findings breakdown

- **Patches applied: 12** (medium 2, low 10) — see the Review Triage Log above.
- **Items deferred: 1** (low) — the Source cascade-delete no longer reaping the relocated silo copy; recorded in frontmatter `deferred`. It is caused by this change, but the fix is not local: making the recorded Source addresses follow the bytes means rewriting the survivor's already-published merged frontmatter, which is the merge receipt's linearization point — its own decision, like DW-707.
- **Items rejected: 4** — the structural-survivor case where the legacy and modern arms could land one `<hex>` at a single target (content-addressed, so the same id is the same bytes — the argument `mirrorHashedTree` already rests on); the move count reporting 2 for two identical-content flat singletons (it counts source objects relocated, which is what it says); the merge-absorb clearing the absorbed page's silo ASSETS while the folded body may still reference `assets/<from>/…` (real, but pre-existing DW-609 behaviour, byte-identical in this diff and outside this intent's authority); and DW-743's ledger entry still reading `status: open` with a duplicated `decision:` line (the ledger is orchestrator-owned and this session was instructed not to edit it).
- **Follow-up review recommendation: `false`** — patched findings this pass were high 0, medium 2, low 10. Only a `high`-severity patched finding recommends another pass; score = 0 high.

### Verification performed

- `npx tsc --noEmit` — exit 0.
- `pnpm lint` — exit 0 (the three `jsx-ast-utils` `TSNonNullExpression` notices are pre-existing
  library warnings, not errors).
- `pnpm vitest run src/lib/__tests__/{silo,merge,lifecycle,raw}.test.ts` — 4 files, 254/254 pass.
- `pnpm test` — 398 files, **9973 passed, 1 skipped, 0 failures**, re-run after the patches. (An
  earlier pre-patch run saw one failure, `workbench-epic2-routes.test.ts > hands BOTH inline retries
  the REMAINDER of the answer budget`, `expected 16941 to be less than or equal to 16940` — a
  wall-clock budget assertion overshooting by 1ms under full-suite load. It passed 4/4 in isolation
  then and did not recur in the post-patch full run. No file this diff touches is on that path.)
- **Matrix test audit** — all seven I/O rows covered by named tests that ran and passed:
  "Same-tenant merge relocates" and "Cross-owner merge follows the survivor" by both the direct
  `silo.test.ts` tests and the `merge.test.ts` end-to-end ones; "Foreign file in a shared hashed
  dir", "Nothing to move" and "Structural survivor slug" by `silo.test.ts`; "Relocation fails" and
  "Resume path relocates" by `merge.test.ts`.
- **Mutation checks, all run in this session and all biting** (each reverted afterwards, tree
  re-verified): removing the normal-path relocation call fails 3 merge tests; removing the
  resume-path call fails the resume test; flipping both `preserveRawSources` arguments to `false`
  fails the failed-relocation test; dropping `sweepHashedTree`'s `isRawSnapshotName` gate fails 4
  tests including the relocation's foreign-file test; not deleting the flat singleton after copying
  fails 4 tests; not deleting a moved hashed snapshot fails the foreign-file test (an assertion
  added for exactly this mutation — the directory reap hid it otherwise); targeting the survivor's
  flat singleton instead of its hashed tree fails 6 tests; dropping the structural-target retarget
  fails the structural test.

### Residual risks

See Design Notes → Accepted residuals for the full list, which the review pass expanded. In short:

- **The FLAT layer still holds the absorbed page's Sources** (accepted in Design Notes). Flat `raw/`
  is immutable and out of scope, so a page later created at the absorbed slug will have those flat
  bytes re-mirrored into its silo by `syncSiloForPage`. The slug-reuse inheritance DW-743 names is
  therefore mitigated, not eliminated: the silo strand is gone and the interval before any
  re-creation is clean, but reaping the flat bytes is `deleteRawSourceBytes`' cascade-delete
  decision. The cross-owner reach — a survivor's owner who could not read the bytes at all — is
  fixed outright.
- **Forward-only.** Merges that already happened left their bytes at the absorbed address; nothing
  here repairs them, for the same reason DW-609 was forward-only.
- **A partial relocation** splits the Sources across both silos, and a crash between one arm's copy
  and its delete leaves that object in both. The survivor sees it (the desired end state); the
  absorbed-address copy is the pre-existing DW-743 residual, no worse than today.
- **A Source cascade-delete on the survivor no longer reaps the relocated silo copy** — the one
  deferred item, in frontmatter `deferred`.
- **Cross-tenant disclosure under `bypassOwnerCheck`**, by design: that is what "the Sources follow
  the content" means when the survivor has a different owner.
- DW-707 remains open and untouched.
