import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  MAX_PROJECTS,
  createResearchProject,
  deleteResearchProject,
  listResearchProjects,
  updateResearchProject,
} from "../research-projects";
import { ClientInputError } from "../errors";
import { _resetLocks } from "../lock";
import { _resetStorage, getStorage } from "../storage";
import { tenantForOwner } from "../wiki";

/** Absolute path of a tenant's stored registry — the bytes the rows below pin. */
function registryPath(owner: string): string {
  return path.join(tmpDir, "tenants", tenantForOwner(owner), "research-projects.json");
}

/** Seed `count` stored projects directly, so a cap row does not need 100 creates. */
async function seedProjects(owner: string, count: number): Promise<void> {
  const projects = Array.from({ length: count }, (_, i) => ({
    id: `seed-${i}`,
    title: `Project ${i}`,
    question: "seeded",
    queries: [],
    sourceUrls: [],
    pageSlugs: [],
    status: "draft",
    createdAt: `2020-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
    updatedAt: `2020-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
  }));
  const target = registryPath(owner);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(projects, null, 2), "utf-8");
}

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "research-projects-"));
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

describe("research projects", () => {
  it("persists a source plan and synthesis per owner", async () => {
    const project = await createResearchProject("alice", {
      title: "Launch research",
      question: "What evidence supports the launch date?",
      queries: ["launch evidence", "launch evidence", "schedule risk"],
      sourceUrls: ["https://example.com/brief", "javascript:alert(1)"],
      vaultId: "alice--launch",
    });
    expect(project).toMatchObject({
      status: "draft",
      queries: ["launch evidence", "schedule risk"],
      sourceUrls: ["https://example.com/brief"],
    });
    expect(await listResearchProjects("bob")).toEqual([]);

    const updated = await updateResearchProject("alice", project.id, {
      status: "complete",
      synthesis: "The launch date is supported by the approved brief.",
    });
    expect(updated).toMatchObject({
      status: "complete",
      synthesis: "The launch date is supported by the approved brief.",
    });
  });

  it("deletes only from the owning workspace", async () => {
    const project = await createResearchProject("alice", {
      title: "Topic",
      question: "What changed?",
    });
    expect(await deleteResearchProject("bob", project.id)).toBe(false);
    expect(await deleteResearchProject("alice", project.id)).toBe(true);
    expect(await listResearchProjects("alice")).toEqual([]);
  });
  /**
   * DW-164. `writeProjects` persists only the last `MAX_PROJECTS` entries, so a
   * create that pushed past the cap used to report success while silently
   * evicting the tenant's OLDEST project. These two rows pin the create's whole
   * obligation to state that was already on disk: it either appends, or it
   * changes nothing at all.
   */
  describe("create discipline at the cap", () => {
    it("refuses at MAX_PROJECTS without evicting anything", async () => {
      await seedProjects("alice", MAX_PROJECTS);
      const before = await fs.readFile(registryPath("alice"), "utf-8");
      // Byte equality alone would NOT prove the refusal wrote nothing:
      // `seedProjects` writes the exact format and key order `writeProjects`
      // produces, so a read-reserialize-rewrite would land identical bytes and
      // pass. The spy is what pins "before any write".
      const storage = getStorage();
      const spy = vi.spyOn(storage, "writeFile");

      try {
        await expect(
          createResearchProject("alice", { title: "One too many", question: "Fits?" }),
        ).rejects.toBeInstanceOf(ClientInputError);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }

      expect(await fs.readFile(registryPath("alice"), "utf-8")).toBe(before);
      const after = await listResearchProjects("alice");
      expect(after).toHaveLength(MAX_PROJECTS);
      expect(after.map((p) => p.id)).toContain("seed-0");
    });

    it("still appends one below the cap", async () => {
      await seedProjects("alice", MAX_PROJECTS - 1);

      const project = await createResearchProject("alice", {
        title: "Room for one more",
        question: "Fits?",
      });

      expect(project.status).toBe("draft");
      const after = await listResearchProjects("alice");
      expect(after).toHaveLength(MAX_PROJECTS);
      expect(after.map((p) => p.id)).toContain(project.id);
      expect(after.map((p) => p.id)).toContain("seed-0");
    });

    it("leaves the stored registry untouched when the registry write fails", async () => {
      await seedProjects("alice", 3);
      const before = await fs.readFile(registryPath("alice"), "utf-8");
      const storage = getStorage();
      const fault = new Error("disk full");
      const spy = vi
        .spyOn(storage, "writeFile")
        .mockImplementation(async (target: string) => {
          if (target.endsWith("research-projects.json")) throw fault;
        });

      try {
        // The original storage error, not a wrapped one — the caller needs to
        // tell a storage fault from a cap refusal.
        await expect(
          createResearchProject("alice", { title: "Doomed", question: "Lands?" }),
        ).rejects.toBe(fault);
      } finally {
        spy.mockRestore();
      }

      // No undo runs and none is needed: the create writes exactly one file and
      // the pushed array is function-local.
      expect(await fs.readFile(registryPath("alice"), "utf-8")).toBe(before);
      expect((await listResearchProjects("alice")).map((p) => p.id)).toEqual([
        "seed-2",
        "seed-1",
        "seed-0",
      ]);
    });
  });
});
