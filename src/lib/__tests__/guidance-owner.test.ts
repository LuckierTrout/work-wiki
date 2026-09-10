import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGuidanceOwner } from "../guidance-owner";
import { _resetStorage, getStorage } from "../storage";
import { proposeActionItems, listActionItems } from "../action-items";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "guidance-identity-"));
  vi.stubEnv("DATA_DIR", directory);
  _resetStorage();
});
afterEach(async () => {
  _resetStorage(); vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

it.each([".--yoyo", "/--yoyo", "--yoyo", "", " ", ".", "a/../b"])("rejects invalid principal %j before reading guidance", async (handle) => {
  const read = vi.spyOn(getStorage(), "readFile");
  await expect(resolveGuidanceOwner(handle)).rejects.toThrow("Invalid guidance principal");
  expect(read).not.toHaveBeenCalled();
});

it.each([
  { id: "wrong--yoyo", owner: "alice" },
  { id: "alice--yoyo", owner: "." },
  { id: "alice--yoyo", owner: "bob" },
  { id: "alice--yoyo" },
  null,
])("refuses contradictory or incomplete agent ownership without writing an action", async (record) => {
  await getStorage().writeFile("agents/alice--yoyo.json", JSON.stringify(record));
  await expect(proposeActionItems("alice--yoyo", [{ title: "Must not be saved" }])).rejects.toThrow();
  expect(await listActionItems("alice--yoyo")).toEqual([]);
});

it("does not retain a deleted or damaged registration across operations", async () => {
  const storage = getStorage();
  await storage.writeFile("agents/alice--yoyo.json", JSON.stringify({ id: "alice--yoyo", owner: "alice" }));
  expect(await resolveGuidanceOwner("alice--yoyo")).toBe("alice");
  await storage.deleteFile("agents/alice--yoyo.json");
  expect(await resolveGuidanceOwner("alice--yoyo")).toBe("alice--yoyo");
  await storage.writeFile("agents/alice--yoyo.json", "broken JSON");
  await expect(resolveGuidanceOwner("alice--yoyo")).rejects.toThrow();
});

it("preserves ordinary human punctuation and refuses a registry identity colliding with the configured human", async () => {
  expect(await resolveGuidanceOwner("alice.smith")).toBe("alice.smith");
  expect(await resolveGuidanceOwner("jean--luc")).toBe("jean--luc");
  vi.stubEnv("NEXT_PUBLIC_OWNER_HANDLE", "jean--luc");
  await getStorage().writeFile("agents/jean--luc.json", JSON.stringify({ id: "jean--luc", owner: "jean" }));
  await expect(resolveGuidanceOwner("jean--luc")).rejects.toThrow("Ambiguous guidance principal");
});
