import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { validateEvidence, RESOURCE_FAMILIES, PRODUCERS } from "../../../tools/write-safety-lab/preflight.mjs";

const hash = "a".repeat(64);
function fixture() {
  return {
    kind: "synthetic-cutover-v1",
    source: { mechanism: "synthetic-transaction", snapshot: "snapshot-one", complete: true,
      changedDuringCapture: false, files: [{ path: "wiki/a.md", sha256: hash, size: 3 }],
      operationIds: ["job-one"], effectIds: ["email-one"] },
    destination: { files: [{ path: "wiki/a.md", sha256: hash, size: 3 }] },
    resources: Object.fromEntries(RESOURCE_FAMILIES.map((name: string) => [name, { old: `old-${name}`, new: `new-${name}`, legacyCanAccessNew: false }])),
    producers: Object.fromEntries(PRODUCERS.map((name: string) => [name, { paused: true, restoreProcedure: `restore-${name}` }])),
    operations: [{ id: "job-one", inputDigest: hash, disposition: "replay", evidence: "captured-input" }],
    effects: [{ id: "email-one", inputDigest: hash, disposition: "confirmed-not-sent", evidence: "synthetic-receipt" }],
    recovery: { direction: "forward", procedure: "reconcile-new-writes" },
  };
}

describe("offline cutover evidence checker", () => {
  it("accepts complete synthetic rehearsal evidence but never authorizes production", () => {
    expect(validateEvidence(fixture())).toMatchObject({ rehearsalReady: true, productionReady: false, blockers: [] });
    expect(validateEvidence({ ...fixture(), productionReady: true }).productionReady).toBe(false);
  });
  it("does not mistake a matching archive or repeated scan for a consistent complete source capture", () => {
    for (const mechanism of ["two-matching-scans", "archive-checksums", "quiet-logs", "timeout", "bucket-isolation"]) {
      const evidence = fixture(); evidence.source.mechanism = mechanism;
      expect(validateEvidence(evidence).blockers).toContain("source-capture-unproven");
    }
    const incomplete = fixture(); incomplete.source.complete = false;
    expect(validateEvidence(incomplete).rehearsalReady).toBe(false);
  });
  it("rejects a legacy source changed during capture and mismatched destination bytes", () => {
    const changing = fixture(); changing.source.changedDuringCapture = true;
    expect(validateEvidence(changing).blockers).toContain("source-changed-or-unknown");
    changing.source.changedDuringCapture = false;
    changing.destination.files[0].sha256 = "b".repeat(64);
    expect(validateEvidence(changing).blockers).toContain("capture-mismatch");
  });
  it("rejects incomplete resources, shared old/new capabilities, aliases and unpaused producers", () => {
    for (const family of RESOURCE_FAMILIES) {
      const evidence = fixture(); evidence.resources[family].new = evidence.resources[family].old;
      expect(validateEvidence(evidence).blockers).toContain("shared-resource");
      delete evidence.resources[family];
      expect(validateEvidence(evidence).blockers).toContain("resource-inventory-incomplete");
    }
    const aliased = fixture(); aliased.resources.r2.new = aliased.resources.kv.new;
    expect(validateEvidence(aliased).blockers).toContain("resource-alias");
    for (const name of PRODUCERS) {
      const evidence = fixture(); evidence.producers[name].paused = false;
      expect(validateEvidence(evidence).blockers).toContain("producer-pause-unproven");
    }
  });
  it("refuses lost jobs, duplicate dispositions, unknown external outcomes and reverse rollback", () => {
    const missing = fixture(); missing.operations = [];
    expect(validateEvidence(missing).blockers).toContain("reconciliation-incomplete");
    const duplicate = fixture(); duplicate.operations.push(duplicate.operations[0]);
    expect(validateEvidence(duplicate).blockers).toContain("invalid-disposition");
    for (const disposition of ["unknown", "replay", "quarantine"]) {
      const effect = fixture(); effect.effects[0].disposition = disposition;
      expect(validateEvidence(effect).blockers).toContain("unresolved-outcome");
    }
    const rollback = fixture(); rollback.recovery.direction = "legacy";
    expect(validateEvidence(rollback).blockers).toContain("recovery-unproven");
  });
  it("rejects malformed inventories, duplicate paths and unsupported evidence", () => {
    for (const path of ["../a", "/a", "a//b", "a\\b", "a/../b", ""]) {
      const evidence = fixture(); evidence.source.files[0].path = path;
      expect(validateEvidence(evidence).blockers).toContain("invalid-inventory");
    }
    const duplicate = fixture(); duplicate.source.files.push(duplicate.source.files[0]);
    expect(validateEvidence(duplicate).blockers).toContain("invalid-inventory");
    const badHash = fixture(); badHash.source.files[0].sha256 = "bad";
    expect(validateEvidence(badHash).blockers).toContain("invalid-inventory");
    for (const input of [null, [], {}, "text", { kind: "production" }]) {
      expect(validateEvidence(input)).toMatchObject({ rehearsalReady: false, productionReady: false });
    }
  });
  it("rejects a named pipe without waiting for a writer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cutover-fifo-"));
    const cli = fileURLToPath(new URL("../../../tools/write-safety-lab/preflight.mjs", import.meta.url));
    try {
      const path = join(directory, "evidence.fifo");
      expect(spawnSync("mkfifo", [path], { timeout: 2_000 }).status).toBe(0);
      const result = spawnSync(process.execPath, [cli, path], { encoding: "utf8", timeout: 2_000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ rehearsalReady: false, blockers: ["invalid-evidence-file"] });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("reads through short reads to EOF and refuses trailing data after a valid JSON prefix", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cutover-short-read-"));
    const cli = fileURLToPath(new URL("../../../tools/write-safety-lab/preflight.mjs", import.meta.url));
    try {
      const path = join(directory, "evidence.json");
      const preload = join(directory, "short-reads.mjs");
      const json = JSON.stringify(fixture());
      // Exercise the actual CLI and regular file, forcing legal short reads at
      // the OS boundary. The first read can end at an otherwise valid JSON prefix.
      await writeFile(preload, `
        import fs from "node:fs/promises";
        import { syncBuiltinESMExports } from "node:module";
        const open = fs.open;
        fs.open = async (...args) => {
          const handle = await open(...args);
          const read = handle.read.bind(handle);
          handle.read = (buffer, offset, length, position) =>
            read(buffer, offset, Math.min(length, Number(process.env.SHORT_READ_BYTES)), position);
          return handle;
        };
        syncBuiltinESMExports();
      `);
      const run = (chunkSize: number) => spawnSync(process.execPath, ["--import", preload, cli, path], {
        encoding: "utf8", timeout: 2_000,
        env: { ...process.env, SHORT_READ_BYTES: String(chunkSize) },
      });
      await writeFile(path, json);
      const valid = run(17);
      expect(valid.error).toBeUndefined();
      expect(valid.status).toBe(0);
      expect(JSON.parse(valid.stdout).rehearsalReady).toBe(true);
      await writeFile(path, json + "private-trailing-marker");
      const trailing = run(Buffer.byteLength(json));
      expect(trailing.error).toBeUndefined();
      expect(trailing.status).toBe(1);
      expect(JSON.parse(trailing.stdout).blockers).toEqual(["invalid-evidence-file"]);
      expect(trailing.stdout).not.toContain("private-trailing-marker");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("executes the local-file CLI, returning nonzero for blocked/invalid/oversized input without leaking file data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cutover-evidence-"));
    const cli = fileURLToPath(new URL("../../../tools/write-safety-lab/preflight.mjs", import.meta.url));
    try {
      const path = join(directory, "evidence.json");
      const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
      await writeFile(path, JSON.stringify(fixture()));
      expect(run(path).status).toBe(0);
      expect(JSON.parse(run(path).stdout).productionReady).toBe(false);
      const blocked = fixture(); blocked.source.changedDuringCapture = true;
      await writeFile(path, JSON.stringify(blocked));
      expect(run(path).status).toBe(1);
      await writeFile(path, "private-test-marker");
      expect(run(path).stdout).not.toContain("private-test-marker");
      expect(run(path).status).toBe(1);
      await writeFile(path, "x".repeat(1_000_001));
      expect(run(path).status).toBe(1);
      expect(run().status).toBe(1);
      expect(run(directory).status).toBe(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
