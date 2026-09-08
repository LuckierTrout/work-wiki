import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  MAX_EMAIL_ATTACHMENTS_RECORDED,
  emailJobId,
  isEmailAddress,
  loadEmailIngestConfig,
  normalizeAllowedSenders,
  sanitizeAttachmentNames,
  sanitizeAttachmentNamesUnique,
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

/**
 * DW-690. `sanitizeAttachmentNamesUnique` is scrub -> de-duplicate -> cap, and
 * every step of that ORDER is load-bearing while none of it is observable from
 * the route: the route's fixtures post one or two attachments, so moving the
 * `.slice(0, MAX_EMAIL_ATTACHMENTS_RECORDED)` inside the `new Set(...)` — which
 * would cap the RAW list and then collapse whatever survived — leaves every
 * other suite in this repo green. This is the direct pin on the ordering.
 */
describe("sanitizeAttachmentNamesUnique", () => {
  // Fifteen distinct files, each recorded twice: once plainly and once with the
  // CR/LF a client that folded a long `Content-Disposition` header produces.
  // Thirty-two raw entries, fifteen distinct RECORDED names.
  //
  // Interleaved rather than grouped, and that is deliberate: capping the raw
  // list first would take the first twenty entries, which under this
  // interleaving covers only the first ten files, so the two orderings disagree
  // about a NAME rather than only about a count. Grouped input (all fifteen
  // plain names, then all fifteen folded ones) would let the broken ordering
  // return the right answer by accident.
  const distinctNames = Array.from({ length: 15 }, (_, index) => `file-${index + 1}.pdf`);
  const recorded = distinctNames.flatMap((name, index) => [
    name,
    `${name}\r\n`,
    // Two names that scrub away to nothing, dropped by `filter(Boolean)` rather
    // than recorded as an empty string. Placed inside the run being capped, so
    // they also spend raw slots the broken ordering would have to pay for.
    ...(index === 3 ? ["   "] : []),
    ...(index === 9 ? ["\r\n\t"] : []),
  ]);

  it("collapses names that are equal AS RECORDED, then caps what survives", () => {
    // The premise the case rests on, asserted rather than assumed: the raw list
    // really is over the cap while the distinct recorded names are not.
    // Without this the case would pass vacuously if the fixture ever shrank.
    expect(recorded.length).toBeGreaterThan(MAX_EMAIL_ATTACHMENTS_RECORDED);
    expect(distinctNames.length).toBeLessThanOrEqual(MAX_EMAIL_ATTACHMENTS_RECORDED);

    // Every distinct name survives, once, in the order it was first recorded.
    // Capping the raw list first answers the first ten files only, so this is
    // the assertion the wrong ordering fails.
    expect(sanitizeAttachmentNamesUnique(recorded)).toEqual(distinctNames);

    // And the two exports really do differ, which is why the de-duplicating one
    // is separate: the plain variant caps the raw list and keeps the duplicates,
    // because `oversizedAttachmentNames` derives `unnamedOversized` from its
    // length and a collapse there would invent a phantom unnamed file.
    const plain = sanitizeAttachmentNames(recorded);
    expect(plain).toHaveLength(MAX_EMAIL_ATTACHMENTS_RECORDED);
    expect(new Set(plain).size).toBeLessThan(plain.length);
  });

  it("caps at MAX_EMAIL_ATTACHMENTS_RECORDED once the names are distinct", () => {
    // The cap is not deleted by moving it last -- more distinct names than
    // slots is still a truncation, and the surplus is not recorded at all.
    const many = Array.from({ length: MAX_EMAIL_ATTACHMENTS_RECORDED + 5 }, (_, i) => `f-${i}.pdf`);
    expect(sanitizeAttachmentNamesUnique(many)).toEqual(
      many.slice(0, MAX_EMAIL_ATTACHMENTS_RECORDED),
    );
  });
});
