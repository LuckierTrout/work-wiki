/**
 * Which shell commands need the owner's say-so (Story 8.9).
 *
 * THE CLASSIFIER IS THE FEATURE. Running a command is the easy half; deciding
 * which ones may run unattended is the half that decides whether an owner can
 * leave the Agent alone. So the rule is a pure function the node suite executes,
 * not a branch inside a spawn helper — "did Deny actually not run it" has to be
 * something a test can answer.
 *
 * TWO QUESTIONS, EITHER ONE TRIGGERS THE MODAL:
 *
 *   - Is the working directory (or any path argument) OUTSIDE the Agent's
 *     workspace? Inside it, the Agent is playing in its own sandbox and a modal
 *     per `ls` would train the owner to click Approve without reading.
 *   - Is the EXECUTABLE one this conversation has not run before? A new binary
 *     is a new capability, and `curl` appearing for the first time inside a
 *     workspace-local command is exactly the case a cwd-only rule would wave
 *     through.
 *
 * NO ALLOW-ALL. There is deliberately no "approve everything in this session"
 * option anywhere in this module: approval is per command, and the memory it
 * does keep — the set of executables already approved — is narrow, explicit, and
 * scoped to one conversation.
 *
 * This is NOT `runSandbox` / Cloudflare Sandbox, and it is not the Studio
 * approval desk. It is a local process on the owner's machine.
 *
 * Imports nothing from `src/lib` (AD-6).
 */

import { spawn } from "node:child_process";
import path from "node:path";

/** A command may not run longer than this without being killed. */
export const SHELL_TIMEOUT_MS = 2 * 60 * 1000;
/** Captured output above this is truncated — the tail is what a caller reads. */
export const SHELL_MAX_OUTPUT_CHARS = 100_000;

export const SHELL_DENIED_COPY = "Denied. The command did not run.";
/** Resume was for a different reason; the command now leaves the workspace. */
export const SHELL_PATH_CHANGED_COPY =
  "Denied. The command now leaves the workspace.";

/**
 * The cwd a command actually runs in. Absent `cwd` is the workspace root,
 * never `process.cwd()`.
 *
 * @param {string | null | undefined} cwd
 * @param {{ root?: string } | undefined} workspace
 * @returns {string}
 */
export function effectiveShellCwd(cwd, workspace) {
  if (typeof cwd === "string" && cwd.trim().length > 0) return cwd;
  return workspace?.root ?? process.cwd();
}

/**
 * Why a command needs approval, or `null` when it does not.
 *
 * A REASON rather than a boolean, because the modal has to say which of the two
 * it is: "this runs outside the workspace" and "this runs a program the Agent has
 * not used before" are different risks, and an owner deciding between Approve and
 * Deny is entitled to know which one they are looking at.
 *
 * @param {{ command?: string, args?: string[], cwd?: string | null }} call
 * @param {{
 *   workspace?: import("./workspace.mjs").AgentWorkspace,
 *   approvedExecutables?: Set<string>,
 * }} [options]
 * @returns {"invalid" | "external_cwd" | "external_path" | "new_executable" | null}
 */
export function shellApprovalReason(
  { command, args = [], cwd = null },
  { workspace, approvedExecutables = new Set() } = {},
) {
  if (typeof command !== "string" || command.trim().length === 0) {
    return "invalid";
  }
  const effectiveCwd = effectiveShellCwd(cwd, workspace);
  if (workspace && !workspace.contains(effectiveCwd)) return "external_cwd";
  // Every argument that LOOKS like a path is checked, not just the first. A
  // command whose cwd is inside the workspace but whose target is `/etc/hosts`
  // is an external command by any reading an owner would recognise.
  for (const arg of args) {
    if (typeof arg !== "string") continue;
    const pathish = pathFromArg(arg);
    if (!pathish) continue;
    const resolved = path.resolve(effectiveCwd, pathish);
    if (workspace && !workspace.contains(resolved)) return "external_path";
  }
  if (!approvedExecutables.has(executableKey(command))) return "new_executable";
  return null;
}

/**
 * Every target the classifier currently treats as outside the workspace.
 *
 * The resume guard compares THIS SET, not the reason label. A pause approved
 * for `/etc/hosts` must not spawn after a second argument's parent raced to a
 * symlink — both would still be `external_path`.
 *
 * @param {{ command?: string, args?: string[], cwd?: string | null }} call
 * @param {{ workspace?: import("./workspace.mjs").AgentWorkspace }} [options]
 * @returns {{ externalCwd: boolean, externalPaths: string[] }}
 */
export function shellExternalTargets(
  { args = [], cwd = null },
  { workspace } = {},
) {
  const effectiveCwd = effectiveShellCwd(cwd, workspace);
  const externalCwd = Boolean(workspace && !workspace.contains(effectiveCwd));
  const externalPaths = [];
  const seen = new Set();
  for (const arg of args) {
    if (typeof arg !== "string") continue;
    const pathish = pathFromArg(arg);
    if (!pathish) continue;
    const resolved = path.resolve(effectiveCwd, pathish);
    if (workspace && !workspace.contains(resolved) && !seen.has(resolved)) {
      seen.add(resolved);
      externalPaths.push(resolved);
    }
  }
  return { externalCwd, externalPaths };
}

/**
 * True when resume would reach a cwd or path the pause never showed.
 *
 * @param {{ externalCwd?: boolean, externalPaths?: string[] }} stored
 * @param {{ externalCwd?: boolean, externalPaths?: string[] }} live
 */
export function shellExternalSetGrew(stored, live) {
  if (live.externalCwd && !stored.externalCwd) return true;
  const approved = new Set(
    (stored.externalPaths ?? []).map((entry) => path.resolve(String(entry))),
  );
  return (live.externalPaths ?? []).some(
    (entry) => !approved.has(path.resolve(String(entry))),
  );
}

/**
 * Does this argument name a filesystem path?
 *
 * Absolute paths and anything with a separator. A bare word is NOT treated as a
 * path even though it might be a relative filename: resolving every flag value
 * against the cwd would flag `--color=always` as an external path and put a
 * modal in front of every command, which is the failure mode that makes owners
 * stop reading them.
 */
function looksLikePath(arg) {
  if (arg.startsWith("-")) return false;
  return arg.startsWith("/") || arg.startsWith("~") || arg.includes("/") || arg.includes("\\") || arg.includes("..");
}

/**
 * A path hidden in `--flag=/etc/passwd` is still a path. `--color=always` is
 * not: `always` has no separator.
 */
function pathFromArg(arg) {
  if (typeof arg !== "string" || arg.length === 0) return null;
  if (arg.startsWith("-")) {
    const eq = arg.indexOf("=");
    if (eq <= 0) return null;
    return pathFromArg(arg.slice(eq + 1));
  }
  return looksLikePath(arg) ? arg : null;
}

/**
 * Canonical executable identity. A basename approval (`python3`) is not a
 * path approval (`/tmp/evil/python3`).
 */
export function executableKey(command) {
  const trimmed = command.trim();
  if (!trimmed) return "";
  if (
    path.isAbsolute(trimmed) ||
    trimmed.startsWith("~") ||
    trimmed.includes("/") ||
    trimmed.includes("\\")
  ) {
    const expanded = trimmed.startsWith("~")
      ? path.resolve(trimmed.replace(/^~(?=\/|$)/, process.env.HOME || ""))
      : path.resolve(trimmed);
    return `path:${expanded}`;
  }
  return `name:${path.basename(trimmed).toLowerCase()}`;
}

/**
 * Run one command that has already been cleared.
 *
 * NO SHELL. `spawn` with an argv array and `shell: false`, so a command the model
 * composed cannot smuggle `; rm -rf ~` through an argument — the classifier above
 * reasons about `command` and `args`, and a shell would make that reasoning a
 * fiction.
 *
 * The clearance is the CALLER's to establish. This function does not re-check,
 * on purpose: two places deciding "may this run" is how one of them ends up
 * being the lenient one.
 *
 * @param {{ command: string, args?: string[], cwd?: string }} call
 * @param {{ timeoutMs?: number, spawnImpl?: typeof spawn, workspace?: { root?: string } }} [options]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
export function runShellCommand(
  { command, args = [], cwd },
  { timeoutMs = SHELL_TIMEOUT_MS, spawnImpl = spawn, workspace } = {},
) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawnImpl(command, args, {
        cwd: effectiveShellCwd(cwd, workspace),
        shell: false,
      });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: String(error?.message ?? error) });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout = clamp(stdout + chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = clamp(stderr + chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: String(error?.message ?? error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Keep the TAIL: an error message arrives at the end of a long build log. */
function clamp(text) {
  const value = String(text);
  return value.length > SHELL_MAX_OUTPUT_CHARS
    ? value.slice(value.length - SHELL_MAX_OUTPUT_CHARS)
    : value;
}
