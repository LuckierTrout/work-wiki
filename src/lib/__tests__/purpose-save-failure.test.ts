import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

vi.mock("@/lib/auth", () => ({
  getPrincipal: async () => ({ id: "user_alice", handle: "alice" }),
}));

import { PUT } from "@/app/api/workbench/artifact/route";
import { _resetStorage, getStorage } from "../storage";
import { _resetLocks } from "../lock";
import { logger } from "../logger";
import { readDataVersion } from "../data-version";
import { formatIfMatch, scopedContentVersion } from "../write-precondition";
import {
  ARTIFACT_SAVE_CONTEXT_COPY, ARTIFACT_SAVE_UNCONFIRMED_COPY, ARTIFACT_RECOVERY_FAILED_COPY,
  createWiki, readEffectiveWikiArtifact, wikiArtifactPath, wikiRegistryPath,
} from "../wikis";

const draft = "# Purpose\n\nThe owner's new purpose.\n";
const fault = () => new Error("EACCES: private diagnostic '/srv/private/tenants/alice/wikis.json'");
let directory: string;
let wikiId: string;
let artifact: string;
let registry: string;
let before: string;
let version: string;
let dataVersion: number;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "purpose-save-failure-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.stubEnv("NEXT_PUBLIC_OWNER_HANDLE", "alice");
  vi.stubEnv("YOPEDIA_OWNER_USER_ID", "user_alice");
  vi.stubEnv("YOPEDIA_READONLY", "");
  _resetStorage(); _resetLocks();
  vi.spyOn(logger, "error").mockImplementation(() => {});
  const wiki = await createWiki("alice", { name: "Decision room", scenario: "business" });
  wikiId = wiki.id;
  artifact = wikiArtifactPath("alice", wikiId, "purpose.md");
  registry = wikiRegistryPath("alice");
  const record = JSON.parse(await fs.readFile(path.join(directory, registry), "utf8"));
  delete record.wikis[0].artifactAuthority;
  await fs.writeFile(path.join(directory, registry), JSON.stringify(record));
  before = await fs.readFile(path.join(directory, artifact), "utf8");
  const effective = await readEffectiveWikiArtifact("alice", wikiId, "purpose.md");
  expect(effective).not.toBeNull();
  if (effective === null) throw new Error("Synthetic purpose fixture is missing");
  version = scopedContentVersion(wikiId, effective);
  dataVersion = await readDataVersion();
});

afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); _resetStorage(); _resetLocks();
  await fs.rm(directory, { recursive: true, force: true });
});

function save() {
  return PUT(new Request("http://localhost/api/workbench/artifact?path=purpose.md", {
    method: "PUT", headers: { "Content-Type": "application/json", "If-Match": formatIfMatch(version) },
    body: JSON.stringify({ content: draft }),
  }));
}
async function assertFailure(copy: string) {
  const response = await save();
  expect(response.status).toBe(500);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  const body = await response.json();
  expect(body).toEqual({ error: copy });
  expect(JSON.stringify(body)).not.toMatch(/EACCES|\/srv\/private|wikis\.json/);
  expect(await readDataVersion()).toBe(dataVersion);
  return vi.mocked(logger.error).mock.calls.at(-1)?.[2] as Error;
}

describe("purpose save route → real kernel → temporary storage failures", () => {
  it.each([1, 2])("protects registry read failure %s before writing the draft", async (nth) => {
    const storage = getStorage(); const read = storage.readFile.bind(storage);
    let reads = 0;
    vi.spyOn(storage, "readFile").mockImplementation(async (key) => {
      if (key === registry && ++reads === nth) throw fault();
      return read(key);
    });
    const error = await assertFailure(ARTIFACT_SAVE_CONTEXT_COPY);
    expect(error.name).toBe("ArtifactSaveContextError");
    expect((error.cause as Error).message).toContain("EACCES");
    expect(await fs.readFile(path.join(directory, artifact), "utf8")).toBe(before);
  });

  it.each([false, true])("reports marker rejection honestly when write landed=%s", async (landed) => {
    const storage = getStorage(); const write = storage.writeFile.bind(storage);
    vi.spyOn(storage, "writeFile").mockImplementation(async (key, bytes) => {
      if (key === registry) { if (landed) await write(key, bytes); throw fault(); }
      return write(key, bytes);
    });
    const error = await assertFailure(ARTIFACT_SAVE_UNCONFIRMED_COPY);
    expect(error.name).toBe("ArtifactSaveUnconfirmedError");
    expect((error.cause as Error).message).toContain("EACCES");
    expect(await fs.readFile(path.join(directory, artifact), "utf8")).toBe(before);
    const stored = JSON.parse(await fs.readFile(path.join(directory, registry), "utf8"));
    expect(stored.wikis[0].artifactAuthority).toBe(landed ? 1 : undefined);
    expect(ARTIFACT_SAVE_UNCONFIRMED_COPY).not.toContain("unchanged");
  });

  it("reports failed compensation separately and retains both diagnostic causes", async () => {
    const storage = getStorage(); const write = storage.writeFile.bind(storage);
    let artifactWrites = 0;
    vi.spyOn(storage, "writeFile").mockImplementation(async (key, bytes) => {
      if (key === registry || (key === artifact && ++artifactWrites === 2)) throw fault();
      return write(key, bytes);
    });
    const error = await assertFailure(ARTIFACT_RECOVERY_FAILED_COPY);
    expect(error.name).toBe("ArtifactRecoveryFailedError");
    expect((error.cause as AggregateError).errors).toHaveLength(2);
    expect(await fs.readFile(path.join(directory, artifact), "utf8")).toBe(draft);
  });

  it.each([false, true])("compensates an initially absent artifact; deletion fails=%s", async (deletionFails) => {
    await fs.unlink(path.join(directory, artifact));
    const effective = await readEffectiveWikiArtifact("alice", wikiId, "purpose.md");
    expect(effective).not.toBeNull();
    if (effective === null) throw new Error("Synthetic purpose fixture is missing");
    version = scopedContentVersion(wikiId, effective);
    const storage = getStorage(); const write = storage.writeFile.bind(storage);
    vi.spyOn(storage, "writeFile").mockImplementation(async (key, bytes) => {
      if (key === registry) throw fault();
      return write(key, bytes);
    });
    if (deletionFails) vi.spyOn(storage, "deleteFile").mockRejectedValue(fault());
    await assertFailure(deletionFails ? ARTIFACT_RECOVERY_FAILED_COPY : ARTIFACT_SAVE_UNCONFIRMED_COPY);
    if (deletionFails) expect(await fs.readFile(path.join(directory, artifact), "utf8")).toBe(draft);
    else await expect(fs.stat(path.join(directory, artifact))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a successful legacy-purpose save and authority publication working", async () => {
    expect((await save()).status).toBe(200);
    expect(await fs.readFile(path.join(directory, artifact), "utf8")).toBe(draft);
    const stored = JSON.parse(await fs.readFile(path.join(directory, registry), "utf8"));
    expect(stored.wikis[0].artifactAuthority).toBe(1);
    expect(await readDataVersion()).toBe(dataVersion + 1);
  });
});
