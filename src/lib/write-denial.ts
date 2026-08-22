/**
 * The write refusal — one owner per SERVER-SIDE sentence, mirroring
 * `src/lib/read-only.ts`.
 *
 * `canWritePage`'s realm branch (`src/lib/authz.ts`) denies EVERY write kind —
 * body rewrites, metadata patches and deletes — on a public knowledge page, the
 * class `belongsInCommons` names. That one deny reaches nine surfaces (two REST
 * wiki routes, the revert route, the re-ingest route, the bulk-delete route, two
 * `src/mcp.ts` handlers, the HTTP MCP `reingest` tool, and `patchMetadata`), and
 * before DW-120/122/123 every one of them answered the same generic "You don't
 * have permission to …" while the edit page explained the realm. Same refusal,
 * nine different stories.
 *
 * WHAT THIS MODULE OWNS. Every sentence a SERVER answers for a *write* denial
 * that is not the read-only refusal: the generic table {@link WRITE_DENIAL} and
 * the realm table {@link WRITE_DENIAL_REALM}, picked between by
 * {@link resolveWriteDenial}. It does NOT own the not-found cloaks — those are
 * per-route strings that deliberately mimic a missing page and must keep doing
 * so (see below).
 *
 * WHY THE SENTENCE IS RESOLVED, NOT HARDCODED. The realm sentence names the
 * page's realm out loud ("This page is public knowledge"). That claim is only
 * true where the realm predicate actually holds, so it may never be a route's
 * fixed string:
 *
 *   - EIGHT of the nine cloak by READ: they check `canReadFrontmatter` (or a
 *     readable-slug set) before the ACL's sentence, which makes the claim
 *     provable there — readable AND write-denied implies the realm branch,
 *     since a READABLE private page is writable by exactly the principals that
 *     could read it. Even so the resolver is used rather than a literal, so the
 *     claim is re-derived per page instead of inherited from an argument
 *     written in a comment.
 *   - The HTTP MCP `reingest` tool (`src/lib/mcp-http.ts`) cloaks DIFFERENTLY,
 *     and the distinction matters. It has no read check in front of its ACL;
 *     it merges "missing" and "denied" into one error AFTER the ACL, and then
 *     asks the realm predicate directly to decide whether it may say anything
 *     more specific. Only a page it actually read AND that is realm-restricted
 *     — public, non-agent-scoped, non-artifact — gets the resolver's sentence;
 *     everything else, private pages included, keeps the merged error. So it
 *     reaches the same guarantee by a different route, and the guarantee is
 *     what the eight above have: no site can emit a realm sentence for a page
 *     its caller could not read.
 *   - `DELETE /api/ingest/history` was the exception until DW-270, cloaked on
 *     only ONE of its two selection paths: `ingestIds` were preflighted against
 *     `listReadableWikiPages`, while `jobIds` passed only
 *     `job.owner !== principal.handle` — a check on the JOB, not on the page —
 *     so a caller who owned a job whose page they could not read reached the
 *     delete ACL holding it. The route now checks `readable.has(slug)` inside
 *     the ACL loop (after the "already gone" cleanup branch, so both selection
 *     paths are gated at once), and answers the same 404 selection sentence.
 *
 * WHAT `patchMetadata` CONTRIBUTES. It is one of the eight read-cloaking sites
 * (its `else` throws `NOT_FOUND`). It used to be set apart by its `writeKind: "metadata"`,
 * which the realm branch did not gate — so it kept the generic sentence by
 * construction. DW-121 made the realm kind-independent, so it is now an
 * ordinary member of the set: readable + denied there implies the realm too,
 * and its `NOT_OWNER` carries the realm sentence.
 *
 * WHERE THE GENERIC SENTENCE IS REACHABLE, AND WHERE IT IS NOT. At all nine
 * sites the two branches are now mutually exclusive: a page that reaches the
 * resolver at all is one the caller could read, and readable + denied implies
 * the realm — so those sites can only ever emit the REALM sentence, and
 * `WRITE_DENIAL` is unreachable through every one of them. That is why the
 * route suites pin only the realm wording (plus the cloak's silence) and the
 * generic half is pinned at the resolver instead, in
 * `src/lib/__tests__/write-denial.test.ts`.
 *
 * The generic sentence therefore survives as a property of the RESOLVER, not of
 * any current caller. Two inputs produce it: a page OUTSIDE the realm (private,
 * agent-scoped, or an artifact), and `fm === null`/`undefined` for "no page was
 * read, so no realm may be claimed". No site in the app passes `null` today —
 * the tool that merges missing into denied throws its own merged string instead
 * of asking for a sentence — so that branch is contract, kept because a future
 * door that denies without a page in hand must have a correct answer waiting
 * rather than inventing one. This is recorded so the absence of route-level
 * generic-sentence tests reads as a proof, not as an oversight.
 *
 * THE CLOAK COMES FIRST WHERE IT IS A READ CHECK. All eight read-cloaking sites
 * evaluate it before asking this module for a sentence; the ninth decides
 * whether it may speak at all before it asks. Either way an unreadable private
 * page must never learn that it exists, or what its realm is, from this copy.
 *
 * The sentences are plain data — no `process.env`, no storage — but the
 * resolver imports `./authz` (→ `./commons` → storage/lock/wiki), so this
 * module is SERVER-ONLY. Client-side copy stays beside its component, exactly
 * as `read-only.ts` documents for its own boundary.
 */

import { isRealmRestrictedFrontmatterWrite } from "./authz";
import type { WriteKind } from "./authz";

/**
 * The write a caller was refused. One entry per surface verb, because the
 * refusal has to name what the caller was about to do — "forbidden" alone
 * leaves them hunting a permission they do not lack.
 */
export type WriteDenialAction =
  /** `PUT /api/wiki/[slug]`, `src/mcp.ts` `update_page`, `patchMetadata`. */
  | "edit"
  /** `DELETE /api/wiki/[slug]`, `src/mcp.ts` `delete_page`. */
  | "delete"
  /** `POST /api/wiki/[slug]/revisions {action:"revert"}`. */
  | "revert"
  /** `POST /api/ingest/reingest` and the HTTP MCP `reingest` tool. */
  | "reingest"
  /** `DELETE /api/ingest/history` — one refusal for a whole selection. */
  | "bulkDelete";

/**
 * The GENERIC refusal: the caller may not do this, and the reason is not the
 * realm (or the surface cannot prove that it is). Unchanged wording from before
 * DW-120/122/123 — a non-realm deny must keep reading exactly as it did.
 */
export const WRITE_DENIAL: Record<WriteDenialAction, string> = {
  edit: "You don't have permission to edit this page.",
  delete: "You don't have permission to delete this page.",
  revert: "You don't have permission to revert this page.",
  reingest: "You don't have permission to re-ingest this page.",
  bulkDelete:
    "You don't have permission to delete one or more selected pages.",
};

/**
 * The REALM refusal: the page is public knowledge, so its prose is agent- and
 * admin-maintained. Each sentence names the realm, what it blocks, and who can
 * still do it — the same three beats the edit page's screen has carried since
 * DW-7, which now sources its paragraph from here.
 *
 * THE SENTENCE ALWAYS COMES FROM {@link resolveWriteDenial}, never from a
 * direct read of this table: emitted where the realm predicate does not hold,
 * these would assert a realm the surface never evaluated.
 *
 * A CLOAK SITE MAY STILL ASK THE PREDICATE DIRECTLY — for a different question.
 * `mcp-http.ts`'s `reingest` merges "missing" and "denied" into one error on
 * purpose, so before it says anything at all it must decide WHETHER IT MAY
 * SPEAK: only a page that was read and is realm-restricted is public enough to
 * name. That is a cloak decision, not a copy decision, so it calls
 * `isRealmRestrictedFrontmatterWrite` itself and then takes the sentence from
 * the resolver like everyone else. The rule is therefore about who owns the
 * WORDS, not about who may consult the predicate.
 */
export const WRITE_DENIAL_REALM: Record<WriteDenialAction, string> = {
  /**
   * The edit screen and `PUT /api/wiki/[slug]`.
   *
   * "rewritten OR DELETED" is load-bearing, not padding. The realm refuses both
   * verbs on the same page, and since DW-120 hid the Delete control from a
   * non-admin page owner, this sentence is the ONLY place that owner is told
   * deletion is refused too — drop the clause and the refusal becomes silent.
   * Pinned in `write-denial.test.ts`.
   */
  edit:
    "This page is public knowledge, and public knowledge pages are agent-maintained — their prose is written and curated by agents, so it can’t be rewritten or deleted here. Only an agent or a site admin can revise this page’s text.",
  delete:
    "This page is public knowledge, and public knowledge pages are agent-maintained — their prose is written and curated by agents, so it can’t be deleted here. Only an agent or a site admin can remove this page.",
  revert:
    "This page is public knowledge, and public knowledge pages are agent-maintained — their prose is written and curated by agents, so it can’t be reverted here. Only an agent or a site admin can restore an earlier revision.",
  reingest:
    "This page is public knowledge, and public knowledge pages are agent-maintained — their prose is written and curated by agents, so it can’t be re-ingested here. Only an agent or a site admin can refresh it from its source.",
  bulkDelete:
    "One or more selected pages are public knowledge, and public knowledge pages are agent-maintained — their prose is written and curated by agents, so they can’t be deleted here. Only an agent or a site admin can remove them.",
};

/**
 * The sentence to answer for a denied write on `fm`.
 *
 * Returns the realm explanation when — and only when — the realm gate is what
 * this page/`writeKind` pair runs into ({@link isRealmRestrictedFrontmatterWrite},
 * the same expression `canWritePage`'s branch decides on); otherwise the
 * generic sentence.
 *
 * `fm` is the page's raw frontmatter, coerced the way `canWriteFrontmatter`
 * coerces it, so a call site passes the record it already read rather than
 * re-deriving the page's realm. Pass `null` for "no page was read" (the caller
 * could not even load it) — that can never be a realm deny, so it is generic.
 *
 * @param action    what the caller was refused
 * @param fm        the denied page's frontmatter, or `null` if none was read
 * @param writeKind the write kind the gate was asked about. Since DW-121 the
 *                  realm is kind-independent, so this no longer changes the
 *                  answer; it stays because the parameter is what keeps a
 *                  future kind-specific rule expressible, and because the call
 *                  sites document which write each door was actually attempting
 */
export function resolveWriteDenial(
  action: WriteDenialAction,
  fm: { visibility?: unknown; type?: unknown } | null | undefined,
  writeKind: WriteKind,
): string {
  if (fm && isRealmRestrictedFrontmatterWrite(fm, writeKind)) {
    return WRITE_DENIAL_REALM[action];
  }
  return WRITE_DENIAL[action];
}
