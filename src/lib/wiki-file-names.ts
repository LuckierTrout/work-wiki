/**
 * The ONE spelling of "which stored object carries this wiki slug".
 *
 * A pure leaf: no imports, no storage, no config. It exists as its own module
 * because BOTH `src/lib/wiki.ts` (the page key — read recovery and write
 * target) and `src/lib/workbench-files.ts` (the Files tab listing filter and
 * the read gate) need the rule, and `workbench-files.ts` already imports
 * `wiki.ts`, so it cannot live in either without a cycle.
 *
 * THREE CALLERS, ONE RULE (DW-202/203, DW-489, DW-490):
 *
 *   - `wikiLeafFilter` in `workbench-files.ts` — which `wiki/<name>` may be
 *     LISTED, elected over the depth-1 entries `resolveRoot` returned.
 *   - `resolveWorkbenchFile` in `workbench-files.ts` — which `wiki/<name>` may
 *     be READ, elected over the SAME entries, so the read gate answers exactly
 *     as the listing does rather than merely agreeing with it.
 *   - `readWikiPage` / `writeWikiPage` / `writeWikiPageIfContentMatches` in
 *     `wiki.ts` — which storage key a slug's bytes come from and land on, on
 *     the branch where the canonical `<slug>.md` already answered ENOENT.
 *
 * Change the election here and all three change with it. That is the point:
 * before DW-489/490 the listing elected a winner, the read gate served every
 * spelling, and a save targeted the canonical name unconditionally — three
 * answers to one question, so a deep link could preview one object and save
 * another.
 */

/**
 * Name → slug, or `null` when the name is not a wiki page file.
 *
 * Moved here verbatim from `workbench-files.ts` (which re-exports it, so every
 * existing importer is untouched). Its rule is unchanged and MUST stay
 * unchanged: it is the read gate's name→slug half (DW-41) and the preview
 * route's editable-Page derivation.
 *
 * Case-INSENSITIVE on the extension, exact on the slug: a filesystem need not
 * be case-sensitive, so `alpha.MD` is the same file as `alpha.md`, while the
 * slug itself is what the gate is about and is matched as written.
 */
export function wikiLeafSlug(name: string): string | null {
  if (!name.toLowerCase().endsWith(".md")) return null;
  const slug = name.slice(0, -".md".length);
  return slug.length > 0 ? slug : null;
}

/**
 * Every filename that could carry `slug`, canonical first.
 *
 * Exactly four, always, and that is what makes the write path's probe O(1)
 * rather than a directory listing: {@link wikiLeafSlug} lowercases the whole
 * name and tests a `.md` suffix taking the slug as written, so the only names
 * whose slug is `s` are `s` followed by one of `.md` / `.MD` / `.Md` / `.mD`.
 *
 * The canonical `<slug>.md` is first because it is the name a save lands on
 * when nothing else is present and the name the election prefers whenever it
 * exists; the remaining three are in lexicographic order so a caller that
 * probes them gets a deterministic sequence. (The canonical spelling is
 * lexicographically LAST of the four — `.MD` < `.Md` < `.mD` < `.md` — which is
 * exactly why the election cannot simply take the first name and has to prefer
 * the canonical explicitly.)
 */
export function wikiPageNames(slug: string): readonly string[] {
  return [`${slug}.md`, `${slug}.MD`, `${slug}.Md`, `${slug}.mD`];
}

/**
 * Elect ONE name per slug from a set of candidate filenames.
 *
 * TOTAL rather than conditional: the literal `<slug>.md` wins whenever it is
 * among the candidates, because that is the name a save lands on by default;
 * otherwise the lexicographically first name carrying the slug wins. An earlier
 * draft dropped a variant only when a literal `<slug>.md` sat beside it, which
 * left `cased.MD` + `cased.Md` — no canonical at all — as two winners for one
 * slug, the same defect in a worse form.
 *
 * The tiebreak is a total order on the names, so the winner never depends on
 * the order storage happened to return them in: the Files tab cannot reorder
 * itself between renders, and the read gate and the write target cannot
 * disagree because they saw the same names in a different sequence.
 *
 * A LONE VARIANT WINS ITS OWN SLUG, which is why the rule elects rather than
 * demanding the canonical name. A store's case sensitivity is not knowable from
 * a name: on a case-INSENSITIVE store `cased.MD` IS the Page — the listing
 * returns whatever casing was written, and `readFile("cased.md")` resolves that
 * same object — so an unconditional "only exactly `<slug>.md` counts" would
 * hide a real page the Knowledge tab edits.
 *
 * Names that carry no slug ({@link wikiLeafSlug} answers `null`) contribute
 * nothing: `notes.txt` and a bare `.md` are not candidates for any slug.
 */
export function electWikiLeafNames(names: Iterable<string>): Map<string, string> {
  const winners = new Map<string, string>();
  for (const name of names) {
    const slug = wikiLeafSlug(name);
    if (slug === null) continue;
    const canonical = `${slug}.md`;
    const standing = winners.get(slug);
    if (standing === canonical) continue;
    if (name === canonical || standing === undefined || name < standing) {
      winners.set(slug, name);
    }
  }
  return winners;
}
