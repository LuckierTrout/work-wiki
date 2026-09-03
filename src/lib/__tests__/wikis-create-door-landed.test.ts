/**
 * `POST /api/wikis` over a provider that stores `wikis.json` and THEN rejects
 * (DW-708).
 *
 * The door, end to end, against the real kernel and a real temp-`DATA_DIR`
 * filesystem provider — `wikis-routes.test.ts` mocks `createWiki`, so the status
 * it pins there is whatever the mock was told to be. What this file pins is the
 * thing the ledger entry is actually about: which status the OWNER meets when
 * the create landed and the storage layer reported failure anyway. It answered
 * 500 over a Wiki the switcher, the workbench heading and every artifact read
 * already resolved against, and the owner's retry minted a second one against
 * `MAX_WIKIS`.
 *
 * `@/lib/auth` is the only mock: identity has no filesystem to come from here.
 * Ownership is configured through the environment rather than stubbed, so the
 * real `isOwnerPrincipal` runs — the 403 gate sits in front of everything below
 * and a stub of it would hide a regression that closes this door for good.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));

import { POST } from "@/app/api/wikis/route";
import { getPrincipal } from "@/lib/auth";
import { _resetLocks } from "../lock";
import { logger } from "../logger";
import { _resetStorage, getStorage } from "../storage";
import { getWikiRegistry, readWikiArtifact } from "../wikis";
import { getWorkspaceProfile } from "../workspace-profile";

const OWNER = "alice";
const FAULT = "the object store lost its acknowledgement";

let tmpDir: string;
const saved: Record<string, string | undefined> = {};

function createRequest(body: unknown): Request {
  return new Request("http://localhost/api/wikis", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wikis-door-"));
  for (const key of [
    "DATA_DIR",
    "NEXT_PUBLIC_OWNER_HANDLE",
    "YOPEDIA_OWNER_USER_ID",
    "YOPEDIA_READONLY",
  ]) {
    saved[key] = process.env[key];
  }
  process.env.DATA_DIR = tmpDir;
  process.env.NEXT_PUBLIC_OWNER_HANDLE = OWNER;
  // Cleared rather than inherited: either one exported in a developer's shell
  // turns every case below into a 403 that looks like a passing gate test.
  delete process.env.YOPEDIA_OWNER_USER_ID;
  delete process.env.YOPEDIA_READONLY;
  _resetLocks();
  _resetStorage();
  vi.mocked(getPrincipal).mockResolvedValue({ id: "user-1", handle: OWNER });
  // The landed create logs the relocated storage fault; the suite is about the
  // status, not the log line, and `wikis.test.ts` pins the sentence itself.
  vi.spyOn(logger, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("POST /api/wikis when the registry write lands and then reports failure", () => {
  it("answers 201 with the Wiki the registry actually holds", async () => {
    // Writes every path THROUGH and then rejects on `wikis.json` — the
    // landed-then-threw provider, the same spy shape `wikis.test.ts` uses.
    const storage = getStorage();
    const write = storage.writeFile.bind(storage);
    vi.spyOn(storage, "writeFile").mockImplementation(
      async (target: string, content: string) => {
        await write(target, content);
        if (target.endsWith("wikis.json")) throw new Error(FAULT);
      },
    );

    const response = await POST(
      createRequest({ name: "Landed", scenario: "reading" }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { wiki?: { id: string; name: string } };
    expect(body.wiki?.name).toBe("Landed");

    // …and the record it answered with is the one on disk, read back through
    // the registry rather than compared against the response to itself.
    const registry = await getWikiRegistry(OWNER);
    expect(registry.wikis.map((wiki) => wiki.id)).toEqual([body.wiki?.id]);
    expect(registry.currentId).toBe(body.wiki?.id);
    // ALL THREE seeded artifacts every subsequent read resolves through are
    // there, which is what makes 201 the honest answer rather than a convenient
    // one. The profile is the third — it is written by the same seeder inside
    // the same compensation, so a row that checked only the two markdown files
    // would claim a premise one file short of what it is asserting.
    for (const file of ["purpose.md", "schema.md"] as const) {
      expect(await readWikiArtifact(OWNER, body.wiki!.id, file)).not.toBeNull();
    }
    expect((await getWorkspaceProfile(OWNER, body.wiki!.id)).scenario).toBe("reading");
    // The storage fault reached nobody who would retry on it.
    expect(JSON.stringify(body)).not.toContain(FAULT);
  });

  it("still answers 500 when the registry write did NOT land", async () => {
    // The negative control the row above needs: without it, a route that
    // answered 201 for EVERY create failure would pass. Here the spy rejects
    // WITHOUT calling through, so nothing is stored, the compensation discards
    // the directory, and the owner's retry is the correct advice.
    const storage = getStorage();
    const write = storage.writeFile.bind(storage);
    vi.spyOn(storage, "writeFile").mockImplementation(
      async (target: string, content: string) => {
        if (target.endsWith("wikis.json")) throw new Error(FAULT);
        return write(target, content);
      },
    );

    const response = await POST(
      createRequest({ name: "Doomed", scenario: "reading" }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: FAULT });
    expect((await getWikiRegistry(OWNER)).wikis).toEqual([]);
  });
});
