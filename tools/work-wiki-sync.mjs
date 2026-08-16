#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";

const baseUrl = (process.env.WORKWIKI_URL || "https://workwiki.app").replace(/\/$/, "");
const token = process.env.WORKWIKI_API_TOKEN;
const syncClientId = (process.env.WORKWIKI_SYNC_CLIENT || hostname()).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 100);
const syncClientLabel = process.env.WORKWIKI_SYNC_LABEL || hostname();
const SOURCE_STATE_FILE = ".workwiki-source-sync.json";
const SOURCE_EXTENSIONS = new Set([
  ".csv", ".docx", ".epub", ".htm", ".html", ".md", ".mobi", ".odp", ".ods", ".odt",
  ".org", ".pdf", ".pptx", ".rtf", ".txt", ".xlsx", ".zip",
]);
const SOURCE_MAX_BYTES = Math.max(1, Number(process.env.WORKWIKI_SOURCE_MAX_MB || 50)) * 1024 * 1024;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function headers(contentType) {
  if (!token) throw new Error("Set WORKWIKI_API_TOKEN to the owner-scoped service token.");
  return { Authorization: `Bearer ${token}`, ...(contentType ? { "Content-Type": contentType } : {}) };
}

async function checked(response) {
  if (response.ok) return response;
  const body = await response.text();
  throw new Error(`work-wiki returned ${response.status}: ${body.slice(0, 500)}`);
}

async function reportHeartbeat({ mode, operation, state, itemCount, message }) {
  if (!token) return;
  try {
    await checked(await fetch(`${baseUrl}/api/sync/status`, {
      method: "POST",
      headers: headers("application/json"),
      body: JSON.stringify({
        clientId: syncClientId,
        label: syncClientLabel,
        mode,
        operation,
        state,
        ...(Number.isFinite(itemCount) ? { itemCount } : {}),
        ...(message ? { message: String(message).slice(0, 500) } : {}),
      }),
    }));
  } catch (error) {
    process.stderr.write(`work-wiki sync status could not be updated: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function archiveName() {
  return `workwiki-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
}

async function pull(target = join(process.cwd(), "workwiki-backups")) {
  const resolved = resolve(target);
  const asZip = resolved.toLowerCase().endsWith(".zip");
  const destination = asZip ? resolved : join(resolved, archiveName());
  await mkdir(asZip ? resolve(destination, "..") : resolved, { recursive: true });
  const response = await checked(await fetch(`${baseUrl}/api/archive/export`, { headers: headers() }));
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
  await reportHeartbeat({ mode: "archive", operation: "archive-pull", state: "ok", itemCount: 1 });
  process.stdout.write(`${destination}\n`);
  return destination;
}

async function preview(file, collision) {
  const bytes = await readFile(resolve(file));
  const response = await checked(await fetch(`${baseUrl}/api/archive/import?action=preview&collision=${collision}`, {
    method: "POST", headers: headers("application/zip"), body: bytes,
  }));
  return response.json();
}

async function push(file, collision, confirmed) {
  const result = await preview(file, collision);
  process.stdout.write(`${JSON.stringify(result.inspection, null, 2)}\n`);
  if (!confirmed) throw new Error("Preview completed. Re-run with --confirm to restore this archive.");
  const bytes = await readFile(resolve(file));
  const response = await checked(await fetch(`${baseUrl}/api/archive/import?action=import&collision=${collision}`, {
    method: "POST", headers: headers("application/zip"), body: bytes,
  }));
  process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`);
  await reportHeartbeat({ mode: "archive", operation: "archive-restore", state: "ok", itemCount: 1 });
}

async function prune(directory, keep) {
  const entries = (await readdir(directory)).filter((name) => /^workwiki-.*\.zip$/.test(name)).sort().reverse();
  for (const name of entries.slice(keep)) await unlink(join(directory, name));
}

async function watch(target) {
  const directory = resolve(target || join(process.cwd(), "workwiki-backups"));
  const minutes = Math.max(5, Number(process.env.WORKWIKI_SYNC_INTERVAL_MINUTES || 360));
  const keep = Math.max(1, Number(process.env.WORKWIKI_SYNC_KEEP || 30));
  const cycle = async () => { await pull(directory); await prune(directory, keep); };
  await cycle();
  await reportHeartbeat({ mode: "archive", operation: "archive-watch", state: "watching", message: `Every ${minutes} minutes` });
  process.stdout.write(`Watching ${directory}; next backup every ${minutes} minutes.\n`);
  setInterval(() => void cycle().catch((error) => fail(error.message)), minutes * 60_000);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function portablePath(root, file) {
  return relative(root, file).split(sep).join("/");
}

async function sourceFiles(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === SOURCE_STATE_FILE) continue;
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(root, absolute));
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.push(absolute);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

async function readSourceState(root) {
  try {
    const value = JSON.parse(await readFile(join(root, SOURCE_STATE_FILE), "utf8"));
    if (value?.version !== 1 || !value.entries || typeof value.entries !== "object") {
      throw new Error(`Invalid ${SOURCE_STATE_FILE}; move it aside and preview again.`);
    }
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, entries: {} };
    throw error;
  }
}

async function sourcePlan(target) {
  const root = resolve(target || ".");
  if (!(await stat(root)).isDirectory()) throw new Error("Source sync target must be a directory.");
  const state = await readSourceState(root);
  const entries = {};
  const oversized = [];
  for (const absolute of await sourceFiles(root)) {
    const info = await stat(absolute);
    const name = portablePath(root, absolute);
    if (info.size > SOURCE_MAX_BYTES) {
      oversized.push({ path: name, size: info.size });
      continue;
    }
    const bytes = await readFile(absolute);
    entries[name] = { path: name, absolute, size: info.size, modifiedMs: info.mtimeMs, sha256: sha256(bytes) };
  }
  const changed = Object.values(entries).filter((entry) => state.entries[entry.path]?.sha256 !== entry.sha256);
  const deleted = Object.keys(state.entries).filter((name) => !entries[name]);
  return { root, state, entries, changed, deleted, oversized };
}

function sourceSummary(plan) {
  return {
    root: plan.root,
    changed: plan.changed.map(({ path, size, sha256: digest }) => ({ path, size, sha256: digest })),
    deleted: plan.deleted,
    oversized: plan.oversized,
    note: "Deleted local files are reported only; work-wiki pages are never deleted by the companion.",
  };
}

function mediaType(name) {
  const extension = extname(name).toLowerCase();
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".csv") return "text/csv";
  if ([".md", ".org", ".txt", ".rtf"].includes(extension)) return "text/plain";
  if ([".html", ".htm"].includes(extension)) return "text/html";
  if (extension === ".zip") return "application/zip";
  return "application/octet-stream";
}

async function uploadSource(entry, options) {
  const bytes = await readFile(entry.absolute);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mediaType(entry.path) }), entry.path.split("/").at(-1));
  form.append("relativePath", entry.path);
  if (options.vaultId) form.append("vaultId", options.vaultId);
  if (options.tags) form.append("tags", options.tags);
  const response = await checked(await fetch(`${baseUrl}/api/ingest/document`, {
    method: "POST",
    headers: headers(),
    body: form,
  }));
  return response.json();
}

async function pushSources(target, options) {
  const plan = await sourcePlan(target);
  process.stdout.write(`${JSON.stringify(sourceSummary(plan), null, 2)}\n`);
  if (!options.confirmed) {
    if (plan.changed.length > 0) throw new Error("Preview completed. Re-run with --confirm to ingest changed files.");
    return plan;
  }
  const nextEntries = {};
  for (const entry of Object.values(plan.entries)) {
    const prior = plan.state.entries[entry.path];
    if (prior?.sha256 === entry.sha256) {
      nextEntries[entry.path] = prior;
      continue;
    }
    const receipt = await uploadSource(entry, options);
    nextEntries[entry.path] = {
      sha256: entry.sha256,
      size: entry.size,
      modifiedMs: entry.modifiedMs,
      syncedAt: new Date().toISOString(),
      jobId: typeof receipt?.jobId === "string" ? receipt.jobId : undefined,
    };
    process.stdout.write(`Queued ${entry.path}${nextEntries[entry.path].jobId ? ` (${nextEntries[entry.path].jobId})` : ""}\n`);
  }
  await writeFile(join(plan.root, SOURCE_STATE_FILE), JSON.stringify({
    version: 1,
    baseUrl,
    updatedAt: new Date().toISOString(),
    entries: nextEntries,
  }, null, 2));
  await reportHeartbeat({
    mode: "sources",
    operation: "source-push",
    state: "ok",
    itemCount: plan.changed.length,
    message: plan.oversized.length ? `${plan.oversized.length} oversized files skipped` : undefined,
  });
  return plan;
}

async function watchSources(target, options) {
  if (!options.confirmed) throw new Error("source-watch requires --confirm because it continuously ingests changed files.");
  const minutes = Math.max(1, Number(process.env.WORKWIKI_SOURCE_INTERVAL_MINUTES || 10));
  const cycle = async () => { await pushSources(target, options); };
  await cycle();
  await reportHeartbeat({ mode: "sources", operation: "source-watch", state: "watching", message: `Every ${minutes} minutes` });
  process.stdout.write(`Watching ${resolve(target)}; checking for source changes every ${minutes} minutes.\n`);
  setInterval(() => void cycle().catch((error) => fail(error.message)), minutes * 60_000);
}

const [command = "help", target, ...flags] = process.argv.slice(2);
const optionValue = (name) => flags.find((flag) => flag.startsWith(`${name}=`))?.slice(name.length + 1);
const sourceOptions = {
  confirmed: flags.includes("--confirm"),
  vaultId: optionValue("--vault"),
  tags: optionValue("--tags"),
};
try {
  if (command === "pull") await pull(target);
  else if (command === "push" && target) await push(target, flags.includes("--overwrite") ? "overwrite" : "skip", flags.includes("--confirm"));
  else if (command === "watch") await watch(target);
  else if (command === "source-preview" && target) process.stdout.write(`${JSON.stringify(sourceSummary(await sourcePlan(target)), null, 2)}\n`);
  else if (command === "source-push" && target) await pushSources(target, sourceOptions);
  else if (command === "source-watch" && target) await watchSources(target, sourceOptions);
  else {
    process.stdout.write(`work-wiki local sync companion\n\nUsage:\n  pnpm sync pull [archive.zip|directory]\n  pnpm sync push <archive.zip> [--overwrite] [--confirm]\n  pnpm sync watch [directory]\n  pnpm sync source-preview <directory>\n  pnpm sync source-push <directory> [--confirm] [--vault=ID] [--tags=a,b]\n  pnpm sync source-watch <directory> --confirm [--vault=ID] [--tags=a,b]\n\nEnvironment:\n  WORKWIKI_API_TOKEN                 required for network operations\n  WORKWIKI_URL                       default https://workwiki.app\n  WORKWIKI_SYNC_CLIENT               stable client id; default computer hostname\n  WORKWIKI_SYNC_LABEL                display name in Knowledge Studio\n  WORKWIKI_SYNC_INTERVAL_MINUTES     backup interval; default 360, minimum 5\n  WORKWIKI_SYNC_KEEP                 default 30 archives\n  WORKWIKI_SOURCE_INTERVAL_MINUTES   source-watch interval; default 10, minimum 1\n  WORKWIKI_SOURCE_MAX_MB             per-source local ceiling; default 50\n`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await reportHeartbeat({
    mode: command.startsWith("source-") ? "sources" : "archive",
    operation: command,
    state: "failed",
    message,
  });
  fail(message);
}
