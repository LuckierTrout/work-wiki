/**
 * The two research constants BOTH sides name — the store's and the panel's.
 *
 * They live in their own leaf module because of where they are read from.
 * `research-projects.ts` is the store: it reaches `./storage`, which reaches
 * `storage/filesystem.ts` and `node:fs/promises`. `research-panel.ts` is
 * client-safe vocabulary imported by `GraphCanvas`, `ResearchCanvas`,
 * `ReviewCanvas` and `KnowledgeStudio`, so a VALUE import from the store put
 * the whole filesystem module into the browser graph — which Turbopack refuses
 * to chunk ("the chunking context does not support external modules"), taking
 * the entire Workbench down with it. A type-only import is erased and was never
 * the problem; these two were.
 *
 * So the shared half moved DOWN rather than either side moving up. This module
 * imports nothing, which is the property that keeps it importable from both.
 * `research-projects.ts` re-exports both names, so every existing import site
 * spells them exactly where it spelled them before.
 */

/**
 * The suffix every research-registry parse refusal carries (DW-477).
 *
 * A 500 that only says the file is unreadable leaves the owner with a tenant
 * whose every research door — the DELETEs that could shrink the file included
 * — refuses, and no named way out. The hint is a SUFFIX so each refusal keeps
 * its existing leading diagnosis verbatim: the element index and the parser's
 * byte offset are still the first thing read, and the `toThrow(substring)`
 * rows that pin those sentences are unaffected.
 *
 * It is also the MARKER the clients recognise (DW-688). Both surfaces that
 * render a research failure — the Studio's feedback banner and the Workbench's
 * `ResearchCanvas` — are handed only `{ error }` by `GET /api/research`, with
 * no type to switch on, so `researchRegistryRepairable` in `research-panel.ts`
 * derives its predicate from THIS constant rather than retyping the sentence.
 * One owner for the marker: a reworded hint moves the predicate with it instead
 * of silently withdrawing the **Repair** control the sentence promises.
 */
export const REPAIR_HINT = " Repair it with POST /api/research/repair, then retry.";

/**
 * The per-URL character cap `cleanUrls` applies.
 *
 * Read on both sides: the store counts against it, and `research-panel.ts`
 * names the number in the sentence it shows an owner ("shortened to 2,000
 * characters"). A re-typed literal in the panel would go on saying 2,000 after
 * this constant changed — the store telling the owner something false — which
 * is the same re-typing these named constants exist to prevent one scope down.
 */
export const URL_MAX_CHARS = 2_000;
