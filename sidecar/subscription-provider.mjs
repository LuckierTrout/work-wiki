/** Local, signed-in CLI generation. WorkWiki remains the only tool executor. */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_BYTES = 1_000_000;

export function subscriptionCommand(provider, model) {
  if (model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(model)) {
    throw new Error("Invalid subscription model name.");
  }
  if (provider === "anthropic") {
    return ["claude", ["--print", "--restricted", "--tools", "", "--strict-mcp-config",
      "--mcp-config", '{"mcpServers":{}}', "--settings", '{"disableAllHooks":true}',
      "--permission-mode", "dontAsk", "--no-session-persistence", "--output-format", "json",
      ...(model ? ["--model", model] : [])]];
  }
  if (provider === "openai") {
    return ["codex", ["exec", "--ignore-user-config", "--ignore-rules", "--ephemeral",
      "--skip-git-repo-check", "--sandbox", "read-only", "--json",
      "-c", 'forced_login_method="chatgpt"',
      "-c", "features.shell_tool=false", "-c", "features.unified_exec=false",
      "-c", "features.code_mode=false", "-c", "features.code_mode_host=false",
      "-c", "features.apps=false", "-c", "features.multi_agent=false",
      "-c", "features.view_image=false",
      "-c", "features.hooks=false", "-c", 'web_search="disabled"',
      "-c", "project_doc_max_bytes=0",
      ...(model ? ["--model", model] : []), "-"]];
  }
  throw new Error("Subscription Chat supports OpenAI or Anthropic. Choose one in Settings → LLM Models.");
}

// In particular, do not inherit API keys, endpoint overrides or exported OAuth
// tokens. The official clients keep and refresh their own saved sign-in.
/** @param {Record<string, string | undefined>} env */
export function subscriptionEnv(env = process.env) {
  return Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG",
    "LC_ALL", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"]
    .filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));
}

export function subscriptionText(provider, output) {
  if (provider === "anthropic") {
    const payload = JSON.parse(output);
    const result = Array.isArray(payload) ? payload.at(-1) : payload;
    if (result.type !== "result" || result.is_error || typeof result.result !== "string" || !result.result.trim()) {
      throw new Error("Claude Code did not return a successful answer. Check its sign-in and usage limits.");
    }
    return result.result;
  }
  const events = output.trim().split("\n").map((line) => JSON.parse(line));
  if (events.some((e) => e.type === "turn.failed" || e.type === "error") ||
      !events.some((e) => e.type === "turn.completed")) {
    throw new Error("Codex did not finish successfully. Check its sign-in and usage limits.");
  }
  const answers = events.filter((e) => e.type === "item.completed" && e.item?.type === "agent_message");
  const text = answers.at(-1)?.item?.text;
  if (typeof text !== "string" || !text.trim()) throw new Error("Codex returned no answer.");
  return text;
}

/** @param {{ provider: string, model?: string, system?: string, messages?: unknown[], signal?: AbortSignal }} input */
export async function generateSubscriptionChat({ provider, model, system, messages, signal }) {
  const [binary, args] = subscriptionCommand(provider, model);
  const input = JSON.stringify({
    instructions: "Answer the last user message using the system instructions and conversation below. Return only the requested response. Tools are executed by the calling application, not by this CLI.",
    system, messages,
  });
  if (Buffer.byteLength(input) > MAX_BYTES) throw new Error("Subscription Chat context is too large.");
  const bounded = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(120_000)]);
  bounded.throwIfAborted();
  const cwd = await mkdtemp(path.join(os.tmpdir(), "work-wiki-chat-"));
  try {
    const output = await new Promise((resolve, reject) => {
      let stdout = "";
      let bytes = 0;
      let failure;
      const child = spawn(binary, args, {
        cwd, env: subscriptionEnv(), shell: false, detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stop = (error) => {
        failure ??= error;
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      };
      const abort = () => stop(bounded.reason);
      bounded.addEventListener("abort", abort, { once: true });
      if (bounded.aborted) abort();
      child.on("error", () => { failure ??= new Error(`Could not start ${binary}. Install it and sign in first.`); });
      child.stdin.on("error", () => {}); // Early exit is reported by close.
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > MAX_BYTES) return stop(new Error("Subscription client output exceeded its limit."));
          if (stream === child.stdout) stdout += chunk;
        });
      }
      child.on("close", (code) => {
        bounded.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`${binary} failed. Check its sign-in, selected model and subscription usage limits.`));
        else resolve(stdout);
      });
      child.stdin.end(input);
    });
    return subscriptionText(provider, output);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
