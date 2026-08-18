/**
 * The write precondition: one content-derived version, one header, one refusal.
 *
 * Every editor-facing write in this app is a read-then-write across two
 * requests — the surface reads bytes, a person edits them for a while, and the
 * route writes what comes back. Nothing in that sequence noticed another actor
 * saving in between, so a draft that outlived someone else's save silently
 * clobbered it. Story 1.7's refresh makes the window WIDER on purpose: it
 * deliberately leaves an open editor alone, so a draft can knowingly be minutes
 * stale.
 *
 * This module owns the whole vocabulary of the guard so no part of it is spelled
 * twice: the version function, the header it travels in, the check the routes
 * run, and the two sentences a refusal shows. It is modelled on
 * `workbench-preview.ts` — pure, client-safe, zero-dependency, executed directly
 * by the node suite — because the version has to be computed identically on the
 * server, in the browser and in the Worker, and a rule living inside a route can
 * only ever be grepped for.
 *
 * WHY A DERIVED VERSION AND NOT A STORAGE ETAG. Every write this guards is
 * side-effecting: a page write runs revisions, the index, cross-refs and the
 * activity log; the artifact write runs the log and the `dataVersion` bump; the
 * settings write re-primes a cache. A raw compare-and-set write at the storage
 * layer would bypass all of it. A version DERIVED from the bytes gives the same
 * lost-update detection while leaving the one writer in place — and it is the
 * only option that works for `AppConfig`, which is compared as a parsed object
 * rather than as a byte string.
 *
 * WHAT THIS DOES NOT CLOSE. The check sits immediately before the write, not
 * inside a lock, so two requests in flight at the same instant can still
 * interleave. That residual is pre-existing and distinct; this closes the window
 * an OPEN EDITOR creates, which is the one measured in minutes.
 */

// ---------------------------------------------------------------------------
// The version
// ---------------------------------------------------------------------------

/**
 * The 32-bit FNV-1a prime, as `Math.imul` wants it.
 *
 * `Math.imul` rather than `*` because the product of two 32-bit values exceeds
 * `Number.MAX_SAFE_INTEGER` and plain multiplication silently loses the low
 * bits — which is a hash that stops distinguishing the inputs it exists to
 * distinguish.
 */
const FNV_PRIME = 0x01000193;

/**
 * The SECOND pass's multiplier, and the reason the two passes are worth running.
 *
 * Two FNV-1a passes that share a prime and differ only in their starting state
 * are not independent: the same multiply-chain acts on both, so the second pass
 * adds real but distinctly sub-32 additional bits rather than doubling them.
 * Giving the second pass its own odd multiplier — odd so the multiplication
 * stays invertible mod 2^32 — makes the two chains genuinely different
 * functions of the same bytes, at the same cost.
 */
const MIX_PRIME = 0x85ebca6b;

/**
 * Two DIFFERENT passes over the same bytes.
 *
 * One 32-bit pass collides at roughly one pair in four billion, which is more
 * than a change detector needs but not more than a long-lived editor deserves.
 * Two passes with different bases AND different multipliers, concatenated,
 * give a wide combined value at the cost of one extra loop over a string
 * already in memory. This is a change detector, not a digest, so the claim is
 * "wide enough that a real edit is never mistaken for no edit", not a bit count
 * anyone should rely on. The first basis is FNV-1a's published one; the second
 * is deliberately unrelated to it.
 */
const OFFSET_BASIS_A = 0x811c9dc5;
const OFFSET_BASIS_B = 0x1b873593;

/**
 * One FNV-1a pass over BOTH BYTES of every UTF-16 code unit.
 *
 * `charCodeAt` is what JavaScript can read without allocating; hashing only its
 * low byte would make `"a"` and `"ā"` (U+0101) the same version, which is a
 * lost-update detector that cannot see a diacritic being added. Feeding the low
 * byte and then the high byte separately keeps the mixing per-byte, as FNV
 * specifies, and needs no encoder — so this is byte-identical in node, in the
 * browser and in the Worker.
 *
 * Lone surrogates are hashed as themselves rather than being repaired. This
 * function is not an encoder: a string holding half a pair is a string the
 * storage layer will store, and the version has to describe what is actually
 * there.
 */
function fnv1a32(input: string, basis: number, prime: number): number {
  let hash = basis >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    const unit = input.charCodeAt(index);
    hash = Math.imul(hash ^ (unit & 0xff), prime);
    hash = Math.imul(hash ^ (unit >>> 8), prime);
  }
  return hash >>> 0;
}

/** Zero-padded so the two passes concatenate at a fixed width. */
function hex32(value: number): string {
  return value.toString(16).padStart(8, "0");
}

/**
 * The version of a string of bytes.
 *
 * A CHANGE DETECTOR, NOT A DIGEST. It is not a cryptographic hash, not an
 * identity, and not a secret: anyone who can read the bytes can compute it, and
 * anyone who wants a collision can construct one. The only question it answers
 * is "are these the same bytes the editor was seeded from", and the only
 * consequence of a wrong answer is a save that should have been refused, or a
 * refusal the owner recovers from by reloading. Nothing is authorized by it.
 *
 * The LENGTH is part of the string, not just of the hash state: it is free, it
 * is the single most discriminating cheap property of an edit, and it makes a
 * version legible in a log line.
 *
 * `w1:` names the scheme so a stored or in-flight version from a future scheme
 * can never be mistaken for a match.
 */
export function contentVersion(content: string): string {
  const length = content.length.toString(36);
  return `w1:${length}-${hex32(
    fnv1a32(content, OFFSET_BASIS_A, FNV_PRIME),
  )}${hex32(fnv1a32(content, OFFSET_BASIS_B, MIX_PRIME))}`;
}

/**
 * Serialize a value so two objects with the same VALUES hash the same however
 * their keys happen to be ordered.
 *
 * `JSON.stringify` preserves insertion order, and `.llm-wiki-config.json` is a
 * hand-editable file that the settings route re-serializes on every save — so a
 * config re-ordered by a text editor, or by one `{ ...existing }` spread landing
 * its keys differently, would read as a change nobody made and refuse a save
 * that conflicts with nothing.
 *
 * `undefined` members are dropped rather than rendered, exactly as
 * `JSON.stringify` drops them, so `{ a: 1 }` and `{ a: 1, b: undefined }` — the
 * two shapes a `delete updated.b` and a `b: undefined` produce — agree. Arrays
 * keep their order: an array's order IS its value.
 */
function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    // `undefined`, functions and symbols stringify to `undefined`; they are not
    // JSON, and rendering them as `null` keeps this total.
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, member]) => `${JSON.stringify(key)}:${stableSerialize(member)}`)
    .join(",")}}`;
}

/**
 * The version of a parsed object — key-order independent, nested and all.
 *
 * The settings surfaces compare a PARSED `AppConfig` rather than the file's
 * bytes, because the file is what the route rewrites and the object is what the
 * route merges. See {@link stableSerialize}.
 */
export function objectVersion(value: unknown): string {
  return contentVersion(stableSerialize(value));
}

// ---------------------------------------------------------------------------
// The header
// ---------------------------------------------------------------------------

/**
 * The precondition travels in the standard header, spelled once.
 *
 * `If-Match` rather than a body field: a precondition is about the request, not
 * about the content, so it does not have to survive every body shape a route
 * accepts — a `PATCH`-style partial patch, a whole-object `PUT` and a
 * `{ content }` envelope all carry it the same way, and no route has to reserve
 * a key name inside a payload it also validates.
 *
 * It is NOT checked before the body is parsed. Each route checks at its own
 * merge base — after the read whose bytes it compares against, and after the
 * refusals that must not leak whether a target exists (the page route's ACL
 * cloak). One visible consequence: a stale save that ALSO carries an invalid
 * field is answered 400 for the field, not 412 for the conflict, and meets the
 * conflict only once the field is fixed. That ordering is deliberate — a
 * request that would be refused anyway should not learn a version — but it does
 * mean the refusals are not strictly prioritized by this header.
 */
export const IF_MATCH_HEADER = "If-Match";

/** Wrap a version as the strong validator `If-Match` is defined to carry. */
export function formatIfMatch(version: string): string {
  return `"${version}"`;
}

/**
 * Read a version out of an `If-Match` header, or `null` when there is none.
 *
 * ANYTHING THAT IS NOT ONE QUOTED VALUE IS ABSENT. `*` is the wildcard that
 * means "any current representation", which is precisely the unconditional write
 * this guard exists to stop — accepting it would let a caller opt out of the
 * precondition by sending one character. An unquoted value, an empty string, a
 * list, and a weak validator are all refused for the same reason: a guard a
 * caller can skip by malforming a header is not a guard, and every client in
 * this repo sends exactly what {@link formatIfMatch} produces.
 */
export function parseIfMatch(header: string | null | undefined): string | null {
  if (typeof header !== "string") return null;
  const trimmed = header.trim();
  const matched = /^"([^"]+)"$/.exec(trimmed);
  return matched ? matched[1] : null;
}

// ---------------------------------------------------------------------------
// Copy — ONE wording for the conflict, owned here
// ---------------------------------------------------------------------------

/**
 * What a refused-because-stale save says, on every surface.
 *
 * RECOVERABLE, and it says so: the draft is still on screen, nothing was
 * destroyed, and the way out is a reload. It never names a file, a person or a
 * time — the route knows none of them, and a sentence that guessed would be
 * wrong on the Settings surface where "another actor" is usually the owner's own
 * second tab.
 *
 * One string, in one module, relayed as the routes' existing `{ error }` — the
 * contract all four clients already show verbatim. No surface types a conflict
 * sentence at its render site.
 */
export const WRITE_CONFLICT_COPY =
  "This was changed somewhere else while you were editing, so your save was not applied. Your text is still here — copy it, reload, and apply it to the current version.";

/**
 * What a save with no usable precondition says.
 *
 * Its own sentence rather than the conflict one, because it is a different
 * fact: nothing is known to have changed, the request simply could not be
 * checked. Reaching it means a client sent a `PUT` without the version it was
 * seeded with, which is a bug rather than a race.
 *
 * The RECOVERY half is word-for-word the conflict's, deliberately: reloading
 * destroys the draft identically in both cases, so "copy it" is exactly as
 * load-bearing here. Only the first clause — what happened — differs.
 */
export const WRITE_PRECONDITION_REQUIRED_COPY =
  "This save could not be checked against the stored version, so it was not applied. Your text is still here — copy it, reload, and apply it to the current version.";

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/** No `If-Match` at all, or one nothing could be read out of. */
export const WRITE_PRECONDITION_REQUIRED_STATUS = 428;

/** An `If-Match` that does not describe the bytes the route is holding. */
export const WRITE_CONFLICT_STATUS = 412;

export type PreconditionOutcome =
  | { ok: true }
  | {
      ok: false;
      status: typeof WRITE_PRECONDITION_REQUIRED_STATUS;
      error: typeof WRITE_PRECONDITION_REQUIRED_COPY;
    }
  | {
      ok: false;
      status: typeof WRITE_CONFLICT_STATUS;
      error: typeof WRITE_CONFLICT_COPY;
    };

/**
 * May this write proceed?
 *
 * `current` is the version of the bytes the route ALREADY READ for its own merge
 * — never a second read taken for this check, which would be a different moment
 * and a different answer. `null` means the target is GONE, and a missing target
 * matches no version: a save into a hole is exactly the lost update this
 * refuses, and answering 412 keeps the draft.
 *
 * Three outcomes and no fourth. There is deliberately no "skip the check when
 * the header is absent" branch: that is the unconditional write, and a guard a
 * caller opts out of by omitting a header is not a guard.
 */
export function checkWritePrecondition(
  header: string | null | undefined,
  current: string | null,
): PreconditionOutcome {
  const supplied = parseIfMatch(header);
  if (supplied === null) {
    return {
      ok: false,
      status: WRITE_PRECONDITION_REQUIRED_STATUS,
      error: WRITE_PRECONDITION_REQUIRED_COPY,
    };
  }
  if (current === null || supplied !== current) {
    return {
      ok: false,
      status: WRITE_CONFLICT_STATUS,
      error: WRITE_CONFLICT_COPY,
    };
  }
  return { ok: true };
}
