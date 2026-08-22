/**
 * Shared patch-metadata logic — used by both the REST PATCH handler and the
 * MCP update_metadata tool so the two write paths can't drift.
 */

import {
  readWikiPageWithFrontmatter,
  serializeFrontmatter,
  writeWikiPageWithSideEffects,
  type Frontmatter,
} from "./wiki";
import { extractSummary } from "./ingest";
import type { Principal } from "./auth";
import { assertWritable, READ_ONLY_REFUSAL } from "./read-only";

/** Frontmatter keys that PATCH is allowed to set. */
export const PATCHABLE_KEYS = new Set([
  "confidence",
  "disputed",
  "tags",
  "aliases",
  "expiry",
  "valid_from",
  "supersedes",
  "visibility",
]);

/** Lifecycle-managed keys that PATCH must reject. */
export const LIFECYCLE_KEYS = new Set(["created", "authors", "sources"]);

export interface PatchMetadataArgs {
  slug: string;
  metadata: Record<string, unknown>;
  author?: string;
  /** Full principal — required to gate setting `visibility: private` (paid + owner). */
  principal?: Principal | null;
}

export interface PatchMetadataResult {
  slug: string;
  title: string;
  updated: true;
}

/**
 * Validate and apply a frontmatter-only metadata patch to a wiki page.
 *
 * - Rejects lifecycle-managed keys (created, authors, sources) with an error.
 * - Silently ignores unknown keys.
 * - Bumps `updated` to today.
 * - Appends `author` to `contributors` (deduplicated) when provided.
 * - Does NOT modify the page body.
 *
 * Throws on a read-only deployment (DW-188), invalid input, lifecycle key
 * violation, or missing page.
 */
export async function patchMetadata(
  args: PatchMetadataArgs,
): Promise<PatchMetadataResult> {
  // Deployment read-only (DW-188), answered at the very top — before the
  // lifecycle-key rejection and before the ACL. `writeWikiPageWithSideEffects`
  // below would refuse this anyway; gating here is what makes the MESSAGE right
  // (metadata, not a page body) and keeps the refusal deployment-wide rather
  // than ordered behind a permission answer the caller does not actually lack.
  assertWritable(READ_ONLY_REFUSAL.pageMetadata);

  const { slug, metadata, author, principal = null } = args;

  // Reject lifecycle-managed keys.
  const rejected = Object.keys(metadata).filter((k) => LIFECYCLE_KEYS.has(k));
  if (rejected.length > 0) {
    const err = new Error(
      `cannot update lifecycle-managed fields via PATCH: ${rejected.join(", ")}`,
    );
    (err as NodeJS.ErrnoException).code = "LIFECYCLE_FIELD";
    throw err;
  }

  // Separate patchable keys into values to set and keys to clear (null).
  const patch: Frontmatter = {};
  const clearKeys: string[] = [];
  for (const key of Object.keys(metadata)) {
    if (PATCHABLE_KEYS.has(key)) {
      if (metadata[key] === null || metadata[key] === undefined) {
        clearKeys.push(key);
      } else {
        patch[key] = metadata[key] as Frontmatter[string];
      }
    }
  }

  // Read the existing page.
  const existing = await readWikiPageWithFrontmatter(slug);
  if (!existing) {
    const err = new Error(`page not found: ${slug}`);
    (err as NodeJS.ErrnoException).code = "NOT_FOUND";
    throw err;
  }

  // Realm-aware write ACL: a private page's metadata may only be patched by its
  // owner (or their agents / the service principal), and — since DW-121 — a
  // public knowledge page's metadata is service/admin-only, exactly like its
  // body and its deletion. Enforced here so REST and MCP share the same gate.
  // Denied → cloak: a private page the caller can't read is "not found" (no
  // existence oracle, matching reads); a readable-but-unwritable page is 403.
  const { canReadFrontmatter, canWriteFrontmatter } = await import("./authz");
  if (!canWriteFrontmatter(existing.frontmatter, principal)) {
    if (canReadFrontmatter(existing.frontmatter, principal)) {
      // Routed through the shared resolver like every other write denial. The
      // realm CAN now be what refuses a metadata patch, so this branch is
      // reachable and the sentence it answers is the REALM one: the cloak below
      // already took every unreadable page, and a READABLE private page is
      // writable by exactly the principals that could read it — so
      // readable-and-denied implies the realm. The resolver re-derives that
      // from this page rather than inheriting it from the argument, which is
      // why the call passes the frontmatter and the write kind instead of
      // reading `WRITE_DENIAL_REALM` directly.
      const { resolveWriteDenial } = await import("./write-denial");
      const err = new Error(
        resolveWriteDenial("edit", existing.frontmatter, "metadata"),
      );
      (err as NodeJS.ErrnoException).code = "NOT_OWNER";
      throw err;
    }
    const err = new Error(`page not found: ${slug}`);
    (err as NodeJS.ErrnoException).code = "NOT_FOUND";
    throw err;
  }

  // Making a page private is an owner-only action — enforced here, the single
  // shared write path for both REST and MCP. It is NOT a paid action: billing
  // retired with the commons, so there is no plan check.
  if ("visibility" in metadata && metadata.visibility === "private") {
    const { canReadPage } = await import("./authz");
    const owner =
      typeof existing.frontmatter.owner === "string"
        ? existing.frontmatter.owner
        : undefined;
    // canReadPage's private rule == "is the page owner (or the agent's human owner)".
    if (!canReadPage({ owner, visibility: "private" }, principal)) {
      const err = new Error("Only the page owner can make it private.");
      (err as NodeJS.ErrnoException).code = "NOT_OWNER";
      throw err;
    }
  }

  // Merge: existing frontmatter + patch + bump updated.
  // Keys sent as null are removed (allows clearing fields).
  const today = new Date().toISOString().slice(0, 10);
  const mergedFrontmatter: Frontmatter = {
    ...existing.frontmatter,
    ...patch,
    updated: today,
  };
  for (const key of clearKeys) {
    delete mergedFrontmatter[key];
  }

  // Append author to contributors (deduplicated).
  const authorStr =
    typeof author === "string" && author.trim().length > 0
      ? author.trim()
      : undefined;

  if (authorStr) {
    const existingContributors = Array.isArray(mergedFrontmatter.contributors)
      ? (mergedFrontmatter.contributors as string[])
      : [];
    if (!existingContributors.includes(authorStr)) {
      mergedFrontmatter.contributors = [...existingContributors, authorStr];
    }
  }

  // Re-serialize with the existing body (unchanged).
  const mergedContent = serializeFrontmatter(mergedFrontmatter, existing.body);

  await writeWikiPageWithSideEffects({
    slug,
    title: existing.title,
    content: mergedContent,
    summary: extractSummary(existing.body.replace(/^#\s+.+$/m, "").trim()),
    logOp: "edit",
    crossRefSource: null,
    author: authorStr,
    logDetails: () => `metadata updated via PATCH`,
  });

  // A `disputed: false → true` transition used to open a talk reconciliation
  // thread here (and on the ingest and merge paths). DW-230 removed all three:
  // the talk HTTP surfaces are retired, so nothing could read the thread the
  // write produced — a maintenance loop with no reader is storage churn that
  // reads like a working feature. `disputed` itself still rides in the
  // frontmatter and still surfaces on the page.

  return { slug, title: existing.title, updated: true };
}
