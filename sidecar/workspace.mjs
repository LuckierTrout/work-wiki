/**
 * `agent-workspace/` — where the Agent's own files live (Story 8.8).
 *
 * ONE DIRECTORY, beside the sidecar, and it is NOT a second wiki. The wiki's
 * bytes go through the kernel write path so `dataVersion` still bumps and the
 * Workbench still notices; what lands here is the Agent's scratch output — a
 * drafted table, a diff, a script it wrote to answer a question. Blurring the
 * two would give the deployment two systems of record for pages, which is the
 * exact fork `.yoyo/learnings.md` records.
 *
 * EVERY PATH IS CONTAINED. `resolveWorkspacePath` is the only way in, and it
 * refuses absolute paths, traversal and symlinks that leave the directory —
 * because the caller composing these paths is a language model, and "the Agent
 * wrote to `../../.ssh/authorized_keys`" is not a bug anyone gets to have twice.
 *
 * Imports nothing from `src/lib` (AD-6).
 */

import { randomBytes } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

/** One Agent output the content route will serve as text. */
export const WORKSPACE_TEXT_EXTENSIONS = [
  "md",
  "markdown",
  "txt",
  "json",
  "yaml",
  "yml",
  "csv",
  "tsv",
  "log",
  "sh",
  "py",
  "js",
  "ts",
  "sql",
  "html",
  "xml",
];

/** A single output file, buffered. Above this, the chip links and nothing reads. */
export const WORKSPACE_MAX_FILE_BYTES = 1_048_576;

export const WORKSPACE_OUT_OF_SCOPE_ERROR = "out_of_scope";
export const WORKSPACE_NOT_FOUND_ERROR = "not_found";
export const WORKSPACE_TOO_LARGE_ERROR = "too_large";
export const WORKSPACE_BINARY_ERROR = "unsupported_media_type";

const OPEN = fsSync.constants;
const NOFOLLOW = OPEN.O_NOFOLLOW ?? 0;
const LEAF_WRITE_FLAGS =
  OPEN.O_CREAT | OPEN.O_EXCL | OPEN.O_WRONLY | NOFOLLOW;
const LEAF_READ_FLAGS = OPEN.O_RDONLY | NOFOLLOW;

/**
 * Resolve one relative path inside the workspace, or `null` to refuse.
 *
 * The check is on the RESOLVED path, not on the input string. A blocklist of
 * `".."` would be defeated by `%2e%2e`, by `a/../../b` normalising to something
 * outside, and by a symlink whose own name is innocent — so the question asked
 * is the only one that matters: after resolution, is this still under the root?
 */
export function resolveWorkspacePath(root, relative) {
  if (typeof relative !== "string" || relative.length === 0) return null;
  if (relative.includes("\0")) return null;
  if (path.isAbsolute(relative)) return null;
  const resolved = path.resolve(root, relative);
  const prefix = path.resolve(root) + path.sep;
  if (resolved !== path.resolve(root) && !resolved.startsWith(prefix)) return null;
  return resolved;
}

export function isWorkspaceTextPath(relative) {
  const dot = relative.lastIndexOf(".");
  if (dot <= 0) return false;
  return WORKSPACE_TEXT_EXTENSIONS.includes(relative.slice(dot + 1).toLowerCase());
}

/**
 * The Agent's workspace, as an object with a root and four operations.
 *
 * A FACTORY rather than module-level functions over `process.cwd()`, so the
 * suite can point one at a temp directory. There is exactly one of these per
 * process in production.
 *
 * @typedef {{
 *   root: string,
 *   write: (relative: string, contents: unknown) => Promise<{ path: string, name: string, bytes: number }>,
 *   read: (relative: string) => Promise<{ status: number, body: Record<string, unknown> }>,
 *   contains: (candidate: string) => boolean,
 *   canonicalize: (candidate: string) => string | null,
 * }} AgentWorkspace
 *
 * @param {{ root?: string }} [options]
 * @returns {AgentWorkspace}
 */
export function createAgentWorkspace({
  root = path.join(process.cwd(), "agent-workspace"),
} = {}) {
  return {
    root,

    /**
     * Write one output and return the chip's `{ path, name }`.
     *
     * The parent directory is created, because an Agent that had to mkdir first
     * would spend a tool call on it and sometimes forget. Refusal is a THROWN
     * error rather than a `null`: a write that silently did not happen is the
     * one failure mode a tool loop cannot recover from, since the next turn
     * would cite a file that is not there.
     */
    async write(relative, contents) {
      const resolved = resolveWorkspacePath(root, relative);
      if (!resolved) throw new Error(WORKSPACE_OUT_OF_SCOPE_ERROR);
      await mkdirContained(root, path.dirname(resolved));
      const text = typeof contents === "string" ? contents : String(contents);
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > WORKSPACE_MAX_FILE_BYTES) {
        throw new Error(WORKSPACE_TOO_LARGE_ERROR);
      }
      const tmp = `${resolved}.${randomBytes(8).toString("hex")}.tmp`;
      let handle;
      try {
        handle = await fs.open(tmp, LEAF_WRITE_FLAGS);
        await handle.writeFile(text, "utf8");
      } catch (error) {
        await handle?.close().catch(() => {});
        await unlinkTmpOnly(tmp);
        throw error;
      }
      await handle.close().catch(() => {});
      try {
        await assertRealpathInside(root, tmp);
        try {
          const destStat = await fs.lstat(resolved);
          if (destStat.isSymbolicLink()) {
            throw new Error(WORKSPACE_OUT_OF_SCOPE_ERROR);
          }
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === WORKSPACE_OUT_OF_SCOPE_ERROR
          ) {
            throw error;
          }
          if (!error || error.code !== "ENOENT") throw error;
        }
        await fs.rename(tmp, resolved);
      } catch (error) {
        await unlinkTmpOnly(tmp);
        throw error;
      }
      // `bytes` rides along so the chip can be labelled without a second stat,
      // and it is the BYTE length rather than the character count — a chip that
      // said "4 kB" for 12 kB of CJK would be wrong in the one direction that
      // matters, since the read route refuses at a byte cap.
      return {
        path: relative,
        name: path.basename(relative),
        bytes,
      };
    },

    /**
     * Read one output for Preview.
     *
     * Returns `{ status, body }` rather than throwing, because the caller is an
     * HTTP handler and every refusal here has its own status: out of scope is
     * 403, missing is 404, oversize is 413, non-text is 415. Collapsing them
     * into one 400 would leave the owner unable to tell "the Agent never wrote
     * it" from "Preview cannot show a PDF".
     */
    async read(relative) {
      const resolved = resolveWorkspacePath(root, relative);
      if (!resolved) {
        return { status: 403, body: { error: WORKSPACE_OUT_OF_SCOPE_ERROR } };
      }
      if (!isWorkspaceTextPath(relative)) {
        return { status: 415, body: { error: WORKSPACE_BINARY_ERROR } };
      }
      try {
        await assertNoSymlinkAlong(root, resolved);
      } catch {
        return { status: 403, body: { error: WORKSPACE_OUT_OF_SCOPE_ERROR } };
      }
      let handle;
      try {
        handle = await fs.open(resolved, LEAF_READ_FLAGS);
      } catch (error) {
        return classifyWorkspaceReadError(error);
      }
      try {
        try {
          await assertRealpathInside(root, resolved);
        } catch {
          return { status: 403, body: { error: WORKSPACE_OUT_OF_SCOPE_ERROR } };
        }
        const stat = await handle.stat();
        if (!stat.isFile()) {
          return { status: 404, body: { error: WORKSPACE_NOT_FOUND_ERROR } };
        }
        if (stat.size > WORKSPACE_MAX_FILE_BYTES) {
          return { status: 413, body: { error: WORKSPACE_TOO_LARGE_ERROR } };
        }
        const content = await handle.readFile("utf8");
        return {
          status: 200,
          body: { path: relative, name: path.basename(relative), content },
        };
      } catch (error) {
        return classifyWorkspaceReadError(error);
      } finally {
        await handle.close().catch(() => {});
      }
    },

    /** Is this absolute path inside the workspace? The shell classifier's half. */
    contains(candidate) {
      if (typeof candidate !== "string" || candidate.length === 0) return false;
      const resolved = canonicalizePathSnapshot(candidate);
      const base = canonicalizePathSnapshot(root);
      if (!resolved || !base) return false;
      return resolved === base || resolved.startsWith(base + path.sep);
    },

    /** Immutable canonical spelling used by the shell approval snapshot. */
    canonicalize(candidate) {
      return canonicalizePathSnapshot(candidate);
    },
  };
}

/**
 * Canonicalize a path even when its leaf does not exist yet.
 *
 * `realpathSync(target)` alone is unsafe for shell classification: ENOENT used
 * to fall back to the lexical target, so `agent-workspace/escape/missing.txt`
 * looked contained when `escape` was a symlink to an outside directory. Walk
 * upward to the nearest existing ancestor, canonicalize that ancestor, then
 * append the unresolved suffix without following it. The returned string is a
 * point-in-time snapshot; callers must store and compare it literally rather
 * than realpathing it again after an approval modal.
 *
 * @param {string} target
 * @returns {string | null}
 */
export function canonicalizePathSnapshot(target) {
  if (typeof target !== "string" || target.length === 0) return null;
  if (target.includes("\0") || target.length > 32_768) return null;

  // `realpath` cannot resolve a dangling symlink, but treating its spelling as
  // an ordinary missing component is unsafe: `workspace/link/new.txt`, where
  // `link -> /outside/not-created`, belongs to the OUTSIDE target even though
  // neither the target directory nor the leaf exists. Walk components with
  // `lstat` so the link itself remains observable, then restart at its target.
  let unresolved = path.resolve(target);
  let hops = 0;
  let componentsVisited = 0;
  const seen = new Set();
  while (true) {
    if (unresolved.length > 32_768) return null;
    const parsed = path.parse(unresolved);
    const components = unresolved
      .slice(parsed.root.length)
      .split(path.sep)
      .filter(Boolean);
    if (components.length > 1_024) return null;

    let current = parsed.root;
    let restarted = false;
    for (let index = 0; index < components.length; index += 1) {
      componentsVisited += 1;
      if (componentsVisited > 4_096) return null;
      const candidate = path.join(current, components[index]);
      let stat;
      try {
        stat = fsSync.lstatSync(candidate);
      } catch (error) {
        if (error?.code !== "ENOENT") return null;
        // Once one component is absent, every later component is an immutable
        // unresolved suffix. Ask the filesystem for the existing parent's one
        // spelling before appending it: case-insensitive filesystems otherwise
        // let `/Users/ME` and `/Users/me` become two approval identities.
        let canonicalParent;
        try {
          canonicalParent = fsSync.realpathSync.native(current);
        } catch {
          return null;
        }
        return path.resolve(canonicalParent, ...components.slice(index));
      }
      if (stat.isSymbolicLink()) {
        hops += 1;
        if (hops > 40) return null;
        let link;
        try {
          link = fsSync.readlinkSync(candidate);
        } catch {
          return null;
        }
        const rest = components.slice(index + 1);
        const linkTarget = path.isAbsolute(link)
          ? path.resolve(link)
          : path.resolve(current, link);
        const next = path.resolve(linkTarget, ...rest);
        const state = `${candidate}\0${next}`;
        if (seen.has(state)) return null;
        seen.add(state);
        unresolved = next;
        restarted = true;
        break;
      }
      if (index < components.length - 1 && !stat.isDirectory()) return null;
      current = candidate;
    }
    if (!restarted) {
      try {
        return fsSync.realpathSync.native(current);
      } catch {
        return null;
      }
    }
  }
}

function classifyWorkspaceReadError(error) {
  const code = error && error.code;
  if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
    return { status: 404, body: { error: WORKSPACE_NOT_FOUND_ERROR } };
  }
  if (code === "ELOOP" || code === "EPERM" || code === "EMLINK") {
    return { status: 403, body: { error: WORKSPACE_OUT_OF_SCOPE_ERROR } };
  }
  return { status: 500, body: { error: "read_failed" } };
}

/** Unlink the tmp we created. Never the destination, never an outside victim. */
async function unlinkTmpOnly(tmp) {
  await fs.unlink(tmp).catch(() => {});
}

/**
 * Create each parent as a real directory and refuse the first symlink.
 * `mkdir(..., { recursive: true })` would follow a parent that raced to a
 * symlink between the walk and the write.
 */
async function mkdirContained(root, dir) {
  const absRoot = path.resolve(root);
  const absDir = path.resolve(dir);
  await fs.mkdir(absRoot, { recursive: true });
  const rootStat = await fs.lstat(absRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(WORKSPACE_OUT_OF_SCOPE_ERROR);
  }
  const rel = path.relative(absRoot, absDir);
  if (rel === "") return;
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(WORKSPACE_OUT_OF_SCOPE_ERROR);
  }
  let current = absRoot;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      await fs.mkdir(current);
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
    }
    const st = await fs.lstat(current);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(WORKSPACE_OUT_OF_SCOPE_ERROR);
    }
  }
}

async function assertRealpathInside(root, target) {
  let realRoot;
  let realTarget;
  try {
    realRoot = await fs.realpath(root);
    realTarget = await fs.realpath(target);
  } catch {
    throw new Error(WORKSPACE_OUT_OF_SCOPE_ERROR);
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    throw new Error(WORKSPACE_OUT_OF_SCOPE_ERROR);
  }
}

/**
 * Walk every existing prefix with `lstat` and refuse the first symlink.
 * Must run BEFORE mkdir/write so a parent `escape → /tmp/evil` never receives
 * bytes, and so cleanup never unlinks the outside target.
 */
async function assertNoSymlinkAlong(root, target) {
  const absRoot = path.resolve(root);
  const absTarget = path.resolve(target);
  const rel = path.relative(absRoot, absTarget);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(WORKSPACE_OUT_OF_SCOPE_ERROR);
  }
  try {
    if ((await fs.lstat(absRoot)).isSymbolicLink()) {
      throw new Error(WORKSPACE_OUT_OF_SCOPE_ERROR);
    }
  } catch (error) {
    if (error instanceof Error && error.message === WORKSPACE_OUT_OF_SCOPE_ERROR) {
      throw error;
    }
  }
  let current = absRoot;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let st;
    try {
      st = await fs.lstat(current);
    } catch (error) {
      if (error && error.code === "ENOENT") return;
      throw error;
    }
    if (st.isSymbolicLink()) throw new Error(WORKSPACE_OUT_OF_SCOPE_ERROR);
  }
}
