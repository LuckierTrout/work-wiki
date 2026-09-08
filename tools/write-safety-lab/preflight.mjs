// Offline synthetic evidence checker, NOT a production release authorization.
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RESOURCE_FAMILIES = ["r2", "kv", "vectorize", "queue", "dlq", "authority"];
export const PRODUCERS = ["browser", "api-mcp", "sidecar", "queue", "cron", "email", "agents", "admin-restore"];
const id = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const path = (value) => typeof value === "string" && value.length <= 200 && /^[a-zA-Z0-9_-]+(?:[./][a-zA-Z0-9_-]+)*$/.test(value);
const array = (value) => Array.isArray(value) && value.length <= 10_000;

export function validateEvidence(input) {
  const blockers = [];
  const block = (reason) => { if (!blockers.includes(reason)) blockers.push(reason); };
  if (!object(input) || input.kind !== "synthetic-cutover-v1") block("synthetic-evidence-required");
  const source = object(input?.source) ? input.source : {};
  if (source.mechanism !== "synthetic-transaction" || !id(source.snapshot) || source.complete !== true) block("source-capture-unproven");
  function inventory(value) {
    if (!array(value)) { block("invalid-inventory"); return null; }
    const seen = new Set();
    const rows = [];
    for (const row of value) {
      if (!object(row) || !path(row.path) || !digest(row.sha256) ||
          !Number.isSafeInteger(row.size) || row.size < 0 || seen.has(row.path)) {
        block("invalid-inventory"); continue;
      }
      seen.add(row.path);
      rows.push([row.path, row.sha256, row.size]);
    }
    return JSON.stringify(rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
  const sourceFiles = inventory(source.files);
  if (sourceFiles !== inventory(input?.destination?.files)) block("capture-mismatch");
  if (source.changedDuringCapture !== false) block("source-changed-or-unknown");
  if (!object(input?.resources) || Object.keys(input.resources).length !== RESOURCE_FAMILIES.length) block("resource-inventory-incomplete");
  const oldIds = new Set(), newIds = new Set();
  for (const family of RESOURCE_FAMILIES) {
    const resource = input?.resources?.[family];
    if (!object(resource) || !id(resource.old) || !id(resource.new) || resource.legacyCanAccessNew !== false) {
      block("resource-isolation-unproven"); continue;
    }
    if (oldIds.has(resource.old) || newIds.has(resource.new)) block("resource-alias");
    oldIds.add(resource.old); newIds.add(resource.new);
  }
  if ([...oldIds].some((key) => newIds.has(key))) block("shared-resource");
  for (const name of PRODUCERS) {
    const producer = input?.producers?.[name];
    if (!object(producer) || producer.paused !== true || !id(producer.restoreProcedure)) block("producer-pause-unproven");
  }
  function reconcile(expected, actual, effect) {
    if (!array(expected) || !array(actual)) { block("reconciliation-incomplete"); return; }
    const wanted = new Set(expected);
    if (wanted.size !== expected.length || !expected.every(id)) block("invalid-operation-inventory");
    const seen = new Set();
    for (const row of actual) {
      if (!object(row) || !id(row.id) || seen.has(row.id) || !wanted.has(row.id) || !digest(row.inputDigest)) {
        block("invalid-disposition"); continue;
      }
      seen.add(row.id);
      const allowed = effect ? ["confirmed-complete", "confirmed-not-sent"] : ["complete", "replay", "quarantine"];
      if (!allowed.includes(row.disposition) || !id(row.evidence)) block("unresolved-outcome");
    }
    if (seen.size !== wanted.size) block("reconciliation-incomplete");
  }
  reconcile(source.operationIds, input?.operations, false);
  reconcile(source.effectIds, input?.effects, true);
  if (input?.recovery?.direction !== "forward" || !id(input?.recovery?.procedure)) block("recovery-unproven");
  return { productionReady: false, rehearsalReady: blockers.length === 0,
    blockers, limitation: "Synthetic evidence only; live capture, capability isolation and operator approval remain unproven." };
}

export async function runCli(args) {
  if (args.length !== 1) return { productionReady: false, rehearsalReady: false, blockers: ["one-local-evidence-file-required"] };
  let handle;
  try {
    // Do not wait for a FIFO writer before validating the opened descriptor.
    handle = await open(resolve(args[0]), constants.O_RDONLY | constants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 1_000_000) throw new Error("invalid-size");
    // Bounded even if the file grows after stat; no network or production SDK.
    const bytes = Buffer.alloc(1_000_001);
    let count = 0;
    for (;;) {
      const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count);
      count += bytesRead;
      if (count > 1_000_000) throw new Error("invalid-size");
      if (bytesRead === 0) break;
    }
    return validateEvidence(JSON.parse(bytes.subarray(0, count).toString("utf8")));
  } catch {
    return { productionReady: false, rehearsalReady: false, blockers: ["invalid-evidence-file"] };
  } finally { await handle?.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.rehearsalReady ? 0 : 1;
}
