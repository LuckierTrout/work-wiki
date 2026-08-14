import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  applyNamesTermsToGeneratedText,
  canonicalizeNamesTerm,
  createNamesTerm,
  deleteNamesTerm,
  expandQueryWithNamesTerms,
  listNamesTerms,
  NamesTermConflictError,
  renderNamesTermsGuidance,
  updateNamesTerm,
} from "../names-terms";
import { _resetLocks } from "../lock";
import { _resetStorage } from "../storage";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "names-terms-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetStorage();
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("owner names and terms dictionary", () => {
  it("stores entries per owner and canonicalizes exact aliases", async () => {
    const entry = await createNamesTerm("Alice", {
      kind: "person",
      canonical: "Christian Lee",
      aliases: ["Christian", "Chris Lee", " christian "],
      role: "Product owner",
      organization: "WorkWiki",
    });

    expect(entry.aliases).toEqual(["Christian", "Chris Lee"]);
    expect(await listNamesTerms("bob")).toEqual([]);
    expect(canonicalizeNamesTerm(await listNamesTerms("alice"), "chris lee", ["person"]))
      .toBe("Christian Lee");
  });

  it("rejects ambiguous canonical or alias labels", async () => {
    await createNamesTerm("alice", {
      kind: "organization",
      canonical: "Chevron",
      aliases: ["CVX"],
    });
    await expect(createNamesTerm("alice", {
      kind: "acronym",
      canonical: "CVX",
    })).rejects.toBeInstanceOf(NamesTermConflictError);
  });

  it("supports updates and deletion", async () => {
    const entry = await createNamesTerm("alice", {
      kind: "project",
      canonical: "WorkWiki",
    });
    const updated = await updateNamesTerm("alice", entry.id, {
      kind: "project",
      canonical: "WorkWiki",
      aliases: ["Yopedia"],
      guidance: "Call the product WorkWiki in customer-facing prose.",
    });
    expect(updated?.aliases).toEqual(["Yopedia"]);
    expect(await deleteNamesTerm("alice", entry.id)).toBe(true);
    expect(await listNamesTerms("alice")).toEqual([]);
  });

  it("expands retrieval only when a configured name or alias appears", async () => {
    await createNamesTerm("alice", {
      kind: "project",
      canonical: "Project Lighthouse",
      aliases: ["Lighthouse"],
    });
    expect(await expandQueryWithNamesTerms("alice", "What changed in Lighthouse?"))
      .toContain("Project Lighthouse, Lighthouse");
    expect(await expandQueryWithNamesTerms("alice", "What changed today?"))
      .toBe("What changed today?");
  });

  it("tells models to preserve evidence while preferring canonical labels", () => {
    const guidance = renderNamesTermsGuidance([{
      id: "one",
      kind: "person",
      canonical: "Christian Lee",
      aliases: ["Chris"],
      guidance: "Use the full name in formal summaries.",
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    }]);
    expect(guidance).toContain("Never alter direct quotations or source excerpts");
    expect(guidance).toContain("person: Christian Lee");
    expect(guidance).toContain("aliases: Chris");
  });

  it("canonicalizes aliases in generated digest prose without partial-word matches", () => {
    const entry = {
      id: "one",
      kind: "organization" as const,
      canonical: "Chevron",
      aliases: ["CVX"],
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    };
    expect(applyNamesTermsToGeneratedText([entry], "CVX published an update."))
      .toBe("Chevron published an update.");
    expect(applyNamesTermsToGeneratedText([entry], "ACVX code stayed unchanged."))
      .toBe("ACVX code stayed unchanged.");
  });
});
