import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  emailJobId,
  isEmailAddress,
  loadEmailIngestConfig,
  normalizeAllowedSenders,
  saveEmailIngestConfig,
  senderIsAllowed,
} from "../email-ingest";
import { _resetStorage } from "../storage";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "email-ingest-test-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  _resetStorage();
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("email ingest settings", () => {
  it("defaults to disabled and round-trips a normalized allowlist", async () => {
    expect(await loadEmailIngestConfig()).toEqual({
      enabled: false,
      inboundAddress: "",
      allowedSenders: [],
      destinationVaultId: "",
      destinationAgentId: "",
      updatedAt: null,
    });

    const saved = await saveEmailIngestConfig({
      enabled: true,
      inboundAddress: " Ingest@Example.com ",
      allowedSenders: ["Me@Example.com", "me@example.com", " other@example.com "],
      destinationVaultId: "alice--projects",
      destinationAgentId: "alice--yoyo",
    });
    expect(saved).toMatchObject({
      enabled: true,
      inboundAddress: "ingest@example.com",
      allowedSenders: ["me@example.com", "other@example.com"],
      destinationVaultId: "alice--projects",
      destinationAgentId: "alice--yoyo",
    });
    expect((await loadEmailIngestConfig()).updatedAt).toBeTruthy();
  });

  it("validates and matches sender addresses case-insensitively", () => {
    expect(isEmailAddress("person@example.com")).toBe(true);
    expect(isEmailAddress("not-an-address")).toBe(false);
    expect(normalizeAllowedSenders(["B@x.com", "a@x.com", "b@x.com"])).toEqual([
      "a@x.com",
      "b@x.com",
    ]);
    expect(senderIsAllowed("A@X.COM", ["a@x.com"])).toBe(true);
    expect(senderIsAllowed("other@x.com", ["a@x.com"])).toBe(false);
  });

  it("derives a deterministic, path-safe job id from Message-ID", async () => {
    const first = await emailJobId("<abc@example.com>");
    const second = await emailJobId("<abc@example.com>");
    expect(first).toBe(second);
    expect(first).toMatch(/^email-[a-f0-9]{48}$/);
  });
});
