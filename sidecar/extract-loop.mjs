/**
 * The sidecar's extract claim loop (Stories 7.1–7.4).
 *
 * WHY A POLLER AND NOT A WEBHOOK: the kernel runs on Cloudflare Workers and
 * cannot dial `127.0.0.1`. Every arrow points outward from this machine, so
 * this process asks. The poll is also the only liveness evidence the kernel
 * has — the arrival door reads that heartbeat to decide between queueing a
 * document and failing it closed with the sidecar-down sentence — which is why
 * the loop keeps polling on an empty queue rather than backing off to nothing.
 *
 * ONE DOCUMENT AT A TIME, deliberately. Extract is CPU-bound and this is the
 * owner's laptop, which is also running the editor they are reading the wiki
 * in. A pool would finish a backlog sooner and make everything else stutter.
 *
 * NO SECOND VAULT. The bytes are fetched, written to a temp file, parsed, and
 * the temp file is deleted in a `finally` — the vault copy under
 * `raw/sources/` is the only durable one. The one thing that outlives an
 * invocation is the parse cache, and it is NOT this module's: the Rust binary
 * owns it (`sidecar/extract/src/main.rs` reads and writes
 * `<cache-dir>/<sha>.md`), and this loop only passes the directory down and
 * relays the `cacheHit` flag the binary reports. It holds Markdown keyed on the
 * SHA-256 of the bytes, never documents.
 *
 * This module imports nothing from `src/lib`.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MinerUError, runMinerU } from "./mineru.mjs";

export const EXTRACT_POLL_INTERVAL_MS = 5000;
export const EXTRACT_IDLE_INTERVAL_MS = 15_000;
/** A hundred-page scan on a busy laptop, and then some. */
export const EXTRACT_BINARY_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * What a record is failed with when the sidecar is running but the crate was
 * never built.
 *
 * NOT the sidecar-down sentence. That one tells the owner to start the
 * sidecar, which is already running — the fix here is a build, and sending
 * them after the wrong one is worse than saying nothing.
 */
export const EXTRACT_BINARY_MISSING_COPY =
  "Extract is unavailable — the extract binary is not built. Run `cargo build --release --manifest-path sidecar/extract/Cargo.toml`.";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * Where the kernel lives and what authorizes us to it.
 *
 * `WORKWIKI_URL` / `WORKWIKI_API_TOKEN` are the FROZEN operator-facing names
 * for the owner-automation credential — the same pair the sync tool and the
 * MCP client already use. `YOPEDIA_SERVICE_TOKEN` is the env name the kernel
 * itself reads, accepted here so a deployment configured from the kernel's
 * side works without a second variable. No third token family exists.
 */
export function resolveExtractConfig(env = process.env) {
  const base = (env.WORKWIKI_URL || env.YOPEDIA_URL || "").trim().replace(/\/+$/, "");
  const token = (
    env.WORKWIKI_API_TOKEN ||
    env.YOPEDIA_SERVICE_TOKEN ||
    ""
  ).trim();
  return {
    base,
    token,
    enabled: Boolean(base && token),
    cacheDir: env.WORKWIKI_EXTRACT_CACHE_DIR || path.join(ROOT, "sidecar", ".extract-cache"),
    binary:
      env.WORKWIKI_EXTRACT_BIN ||
      path.join(ROOT, "sidecar", "extract", "target", "release", "work-wiki-extract"),
    fallbackBinary: path.join(
      ROOT,
      "sidecar",
      "extract",
      "target",
      "debug",
      "work-wiki-extract",
    ),
  };
}

/** Which of the two built binaries exists. Release first; debug is a dev build. */
export async function resolveBinary(config) {
  for (const candidate of [config.binary, config.fallbackBinary]) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next one.
    }
  }
  return null;
}

function authHeaders(config) {
  return { authorization: `Bearer ${config.token}` };
}

async function kernelJson(config, pathname, init = {}) {
  const response = await fetch(`${config.base}${pathname}`, {
    ...init,
    headers: {
      ...authHeaders(config),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, body };
}

/**
 * Run the Rust binary over one temp file.
 *
 * The answer is JSON on stdout whether the parse worked or not, so a non-zero
 * exit is read for its payload rather than for its code — the error string is
 * what Activity shows the owner, and "exit 1" is not a sentence.
 */
export function runExtractBinary(binary, { file, format, sha256, cacheDir }) {
  return new Promise((resolve) => {
    const args = ["--format", format, "--sha256", sha256, "--cache-dir", cacheDir, file];
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, EXTRACT_BINARY_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `Extract could not start: ${error.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const parsed = parseBinaryOutput(stdout);
      if (parsed) {
        resolve(parsed);
        return;
      }
      if (signal === "SIGKILL") {
        resolve({ ok: false, error: "Extract timed out." });
        return;
      }
      resolve({
        ok: false,
        error: stderr.trim() || `Extract exited with code ${code}.`,
      });
    });
  });
}

/**
 * The binary prints one JSON object; anything before it is noise from a lib.
 *
 * SCANNED FORWARD from the first `{`, not backward from the last. Extracted
 * Markdown routinely contains braces — a code block, a LaTeX fragment, a
 * JSON sample in the document itself — and every one of them ends up inside
 * the `markdown` string of the very object being parsed. `lastIndexOf("{")`
 * therefore found a brace INSIDE the payload for any document containing one,
 * failed to parse from there, and reported "Extract exited with code 0" for a
 * parse that had in fact succeeded. Each candidate opening brace is tried in
 * order and the first one that yields a complete object wins.
 */
export function parseBinaryOutput(stdout) {
  const text = String(stdout ?? "");
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    const parsed = parseObjectAt(text, start);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * Parse the object that starts at `start`, ignoring everything after it.
 *
 * `JSON.parse` refuses trailing content, so the object's own extent has to be
 * found first: braces are counted, and braces inside a string (and characters
 * escaped inside one) are not counted at all.
 */
function parseObjectAt(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, index + 1));
          return parsed && typeof parsed === "object" ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Extract one claimed record end to end.
 *
 * Returns `{ markdown, cacheHit }` or throws with the sentence the owner sees.
 * The MinerU escalation is here rather than in the binary because the built-in
 * pass has to have run and come back empty FIRST — that ordering is an
 * acceptance criterion, and putting the decision in the Rust process would
 * make it a decision the kernel's settings could not reach.
 */
export async function extractOne(config, binary, job, settings, deps = {}) {
  // Checked here rather than by the caller skipping the drain: the poll that
  // reaches this point is also the kernel's heartbeat, so the loop has to keep
  // claiming and answer each record with the sentence that names the real
  // problem. Skipping the poll would make the kernel say "the sidecar is down"
  // about a sidecar that is running.
  if (!binary) throw new Error(EXTRACT_BINARY_MISSING_COPY);
  const fetchBytes = deps.fetchBytes ?? defaultFetchBytes;
  const runBinary = deps.runBinary ?? runExtractBinary;
  const mineru = deps.runMinerU ?? runMinerU;

  const bytes = await fetchBytes(config, job);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "work-wiki-extract-"));
  const file = path.join(dir, safeName(job.filename, job.format));
  try {
    await fs.writeFile(file, bytes);
    const result = await runBinary(binary, {
      file,
      format: job.format,
      sha256: job.bytesSha256,
      cacheDir: config.cacheDir,
    });
    // `ok` WITH NOTHING IN IT IS NOT A SUCCESS. A parser that reads a document
    // it does not understand — a PDF that is one scanned image, a DOCX whose
    // body is all drawing objects — exits cleanly with an empty string, and
    // returning that here completed the record and enqueued a compile of
    // nothing. Treated as a failed built-in pass, which is also what makes the
    // MinerU escalation below reachable for exactly the documents it exists for.
    const markdown = result.ok ? String(result.markdown ?? "").trim() : "";
    if (result.ok && markdown) {
      return { markdown, cacheHit: result.cacheHit === true };
    }

    const builtInError = result.ok
      ? "Extract found no text in this document."
      : result.error || "Extract failed.";
    const escalate =
      job.format === "pdf" && settings?.mineru?.mode && settings.mineru.mode !== "off";
    if (!escalate) throw new Error(builtInError);

    try {
      const markdown = await mineru({
        mode: settings.mineru.mode,
        bytes,
        filename: job.filename,
        localBaseUrl: settings.mineru.localBaseUrl,
        apiKey: settings.mineru.apiKey,
      });
      if (!markdown || !markdown.trim()) {
        throw new MinerUError("MinerU returned no text.");
      }
      return { markdown: markdown.trim(), cacheHit: false };
    } catch (error) {
      // BOTH halves reach the owner. Reporting only the MinerU failure would
      // hide that the built-in pass ran and found nothing, which is the fact
      // that explains why MinerU was consulted at all.
      throw new Error(`${builtInError} MinerU also failed: ${error.message}`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function defaultFetchBytes(config, job) {
  const response = await fetch(
    `${config.base}/api/extract/bytes?extractId=${encodeURIComponent(job.extractId)}`,
    { headers: authHeaders(config), signal: AbortSignal.timeout(120_000) },
  );
  if (!response.ok) {
    throw new Error(`The stored source could not be fetched (${response.status}).`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** A temp filename that keeps the extension and cannot escape the temp dir. */
export function safeName(filename, format) {
  const base = String(filename || "").split(/[\\/]/).pop() || "";
  const cleaned = base.replace(/[^\w.\-]/g, "_").slice(0, 120);
  // Require a NAME before the extension: a last segment like `.pdf` is all
  // extension and would land as a dotfile in the temp directory.
  const named = /^(.+)\.([a-z0-9]{1,8})$/i.exec(cleaned);
  if (named) return cleaned;
  return `${cleaned.replace(/^\.+/, "") || "document"}.${format}`;
}

async function loadSettings(config) {
  const { ok, body } = await kernelJson(config, "/api/extract/settings");
  if (!ok) return { mineru: { mode: "off" } };
  return body;
}

/**
 * One pass: poll, and drain whatever was offered.
 *
 * Returns how many records it acted on, so the caller can slow down when the
 * queue is empty without giving up the heartbeat entirely.
 */
export async function drainOnce(config, binary, log = () => {}) {
  const listed = await kernelJson(config, "/api/extract/jobs");
  if (!listed.ok) {
    log(`extract poll failed: ${listed.status}`);
    return 0;
  }
  const jobs = Array.isArray(listed.body?.jobs) ? listed.body.jobs : [];
  if (jobs.length === 0) return 0;

  const settings = await loadSettings(config);
  let handled = 0;
  for (const job of jobs) {
    const claimed = await kernelJson(config, "/api/extract/jobs", {
      method: "POST",
      body: JSON.stringify({
        action: "claim",
        extractId: job.extractId,
        ...(job.owner ? { owner: job.owner } : {}),
      }),
    });
    // 409 is another poller (or this one, twice) winning the race. Not an error.
    if (!claimed.ok) continue;

    handled += 1;
    try {
      const { markdown, cacheHit } = await extractOne(
        config,
        binary,
        claimed.body,
        settings,
      );
      // THE COMPLETION'S OWN STATUS IS READ. It was being fired and forgotten:
      // a 403, a 409 or a 500 left the record `claimed` with the text nowhere,
      // and a claimed record is not re-offered until its TTL expires — so the
      // owner watched a document that had already been parsed sit at `Extract`
      // for the rest of the hour. Throwing routes it into the `fail` arm below,
      // which is at least a row that says something.
      const completed = await kernelJson(config, "/api/extract/jobs", {
        method: "POST",
        body: JSON.stringify({
          action: "complete",
          extractId: job.extractId,
          ...(job.owner ? { owner: job.owner } : {}),
          text: markdown,
          cacheHit,
        }),
      });
      if (!completed.ok) {
        throw new Error(
          `The kernel refused the extracted text (${completed.status}${
            completed.body?.error ? `: ${completed.body.error}` : ""
          }).`,
        );
      }
      log(`extracted ${job.filename} (${markdown.length} chars${cacheHit ? ", cached" : ""})`);
    } catch (error) {
      const failed = await kernelJson(config, "/api/extract/jobs", {
        method: "POST",
        body: JSON.stringify({
          action: "fail",
          extractId: job.extractId,
          ...(job.owner ? { owner: job.owner } : {}),
          error: error.message,
        }),
      });
      // Logged, not thrown: the record stays claimed until its TTL expires and
      // is then re-offered, which is the recovery already built for a poller
      // that died mid-parse. Throwing here would abandon the rest of the batch.
      if (!failed.ok) {
        log(
          `extract failed for ${job.filename}, and the kernel refused the failure (${failed.status})`,
        );
      }
      log(`extract failed for ${job.filename}: ${error.message}`);
    }
  }
  return handled;
}

/**
 * Start polling. Returns a stop function.
 *
 * A missing binary does NOT stop the loop: the poll is the heartbeat, and a
 * kernel that stops hearing it starts failing arrivals closed with the
 * sidecar-down sentence — which would be the wrong sentence for "the crate was
 * never built". Records are failed with a sentence that names the real
 * problem instead.
 */
export function startExtractLoop({ env = process.env, log = () => {} } = {}) {
  const config = resolveExtractConfig(env);
  if (!config.enabled) {
    log(
      "extract loop idle: set WORKWIKI_URL and WORKWIKI_API_TOKEN to let the sidecar claim extract jobs",
    );
    return () => {};
  }
  let stopped = false;
  let timer;

  const tick = async () => {
    if (stopped) return;
    let handled = 0;
    try {
      const binary = await resolveBinary(config);
      if (!binary) {
        log(
          "extract loop: no extract binary — run `cargo build --release --manifest-path sidecar/extract/Cargo.toml`",
        );
      }
      // Drained either way. With no binary every claimed record is failed with
      // the sentence above, which is a worse outcome than a parse and a better
      // one than silence — and the poll still tells the kernel a sidecar exists.
      handled = await drainOnce(config, binary, log);
    } catch (error) {
      log(`extract loop error: ${error.message}`);
    }
    if (stopped) return;
    timer = setTimeout(
      tick,
      handled > 0 ? EXTRACT_POLL_INTERVAL_MS : EXTRACT_IDLE_INTERVAL_MS,
    );
    if (typeof timer.unref === "function") timer.unref();
  };

  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
